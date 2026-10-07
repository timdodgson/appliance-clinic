import { describe, expect, it } from 'vitest';
import { checkChangeSet } from '../src/changeset/check.js';
import { sha256Hex } from '../src/redact.js';
import { loadSandboxLists } from '../src/sandbox/guard.js';

const denylist = [
  { kind: 'stack', value: 'SparesSite-dev', reason: 'S4R', source: 'manual' },
  { kind: 'physicalId', value: 'eu-west-1_TESTPOOL1', reason: 'S4R pool', source: 'manual' },
  { kind: 'physicalId', value: 'spares4repairs-orders-dev', reason: 'S4R table', source: 'manual' },
];
const importChange = (physicalId, type = 'AWS::ECR::Repository', extra = {}) => ({ Type: 'Resource', ResourceChange: { Action: 'Import', LogicalResourceId: `L${physicalId.replace(/\W/g, '')}`, PhysicalResourceId: physicalId, ResourceType: type, ...extra } });
const retained = (type) => ({ Type: type, DeletionPolicy: 'Retain', UpdateReplacePolicy: 'Retain', Properties: {} });

describe('import mode', () => {
  it('passes a clean import of an allowlisted resource', () => {
    const r = checkChangeSet({ changeSet: { StackName: 'AcDataStack', Changes: [importChange('spares4repairs-error-code-mcp')] }, denylist, mode: 'import', allowedPhysicalIds: ['spares4repairs-error-code-mcp'] });
    expect(r.ok).toBe(true);
  });

  it('fails anything that is not an Import', () => {
    const add = { Type: 'Resource', ResourceChange: { Action: 'Add', LogicalResourceId: 'New', ResourceType: 'AWS::SSM::Parameter' } };
    const r = checkChangeSet({ changeSet: { StackName: 'AcDataStack', Changes: [add] }, denylist, mode: 'import' });
    expect(r.failures.map((f) => f.rule)).toContain('non-import-action');
  });

  it('fails a physical ID that is not on the step allowlist', () => {
    const r = checkChangeSet({ changeSet: { StackName: 'AcDataStack', Changes: [importChange('whichpart-transcripts', 'AWS::DynamoDB::Table')] }, denylist, mode: 'import', allowedPhysicalIds: ['whichpart-recalls'] });
    expect(r.failures.map((f) => f.rule)).toContain('physical-id-not-allowlisted');
  });

  it('fails an S4R resource even if someone allowlisted it', () => {
    const r = checkChangeSet({ changeSet: { StackName: 'AcDataStack', Changes: [importChange('spares4repairs-orders-dev', 'AWS::DynamoDB::Table')] }, denylist, mode: 'import', allowedPhysicalIds: ['spares4repairs-orders-dev'] });
    expect(r.ok).toBe(false);
    expect(r.failures.map((f) => f.rule)).toContain('physical-id-denylisted');
  });

  it('fails any change set against an S4R stack', () => {
    const r = checkChangeSet({ changeSet: { StackName: 'SparesSite-dev', Changes: [] }, denylist, mode: 'import' });
    expect(r.failures.map((f) => f.rule)).toContain('stack-denylisted');
  });

  it('fails a template without Retain or with CDK metadata', () => {
    const template = { Resources: { Repo: { Type: 'AWS::ECR::Repository', Properties: {} }, CDKMetadata: { Type: 'AWS::CDK::Metadata' } } };
    const r = checkChangeSet({ changeSet: { StackName: 'AcDataStack', Changes: [importChange('repo')] }, denylist, mode: 'import', allowedPhysicalIds: ['repo'], template });
    const rules = r.failures.map((f) => f.rule);
    expect(rules).toContain('missing-retain-deletion-policy');
    expect(rules).toContain('missing-retain-update-replace-policy');
    expect(rules).toContain('cdk-metadata-in-import');
  });

  it('allows the inert placeholder resource without Retain', () => {
    const template = { Resources: { Placeholder: { Type: 'AWS::CloudFormation::WaitConditionHandle' }, Repo: retained('AWS::ECR::Repository') } };
    const r = checkChangeSet({ changeSet: { StackName: 'AcDataStack', Changes: [importChange('repo')] }, denylist, mode: 'import', allowedPhysicalIds: ['repo'], template });
    expect(r.ok).toBe(true);
  });

  it('detects a literal secret in the template by digest and by shape', () => {
    const secret = 'a3f1c2e4b5d6a7f8c9e0b1d2a3f4c5e6';
    const template = { Resources: { Fn: { ...retained('AWS::Lambda::Function'), Properties: { Environment: { Variables: { ORCH_BEARER_TOKEN: secret, OTHER: 'sk-abcdefghijklmnopqrstuv' } } } } } };
    const r = checkChangeSet({ changeSet: { StackName: 'AcRuntimeStack', Changes: [importChange('fn', 'AWS::Lambda::Function')] }, denylist, mode: 'import', allowedPhysicalIds: ['fn'], template, secretDigests: [sha256Hex(secret)] });
    const rules = r.failures.map((f) => f.rule);
    expect(rules).toContain('literal-secret-in-template');
    expect(rules).toContain('secret-shaped-literal-in-template');
    expect(JSON.stringify(r)).not.toContain(secret);
  });

  it('accepts a dynamic reference instead of a literal secret', () => {
    const template = { Resources: { Fn: { ...retained('AWS::Lambda::Function'), Properties: { Environment: { Variables: { ORCH_BEARER_TOKEN: '{{resolve:secretsmanager:spares4repairs/diag-orchestrator/bearer-token}}' } } } } } };
    const r = checkChangeSet({ changeSet: { StackName: 'AcRuntimeStack', Changes: [importChange('fn', 'AWS::Lambda::Function')] }, denylist, mode: 'import', allowedPhysicalIds: ['fn'], template });
    expect(r.ok).toBe(true);
  });
});

describe('S4R references', () => {
  const policy = { ...retained('AWS::IAM::RolePolicy'), Properties: { PolicyName: 'whichpart-cognito-auth', PolicyDocument: { Statement: [{ Resource: 'arn:aws:cognito-idp:eu-west-1:000000000000:userpool/eu-west-1_TESTPOOL1' }] } } };
  const changeSet = { StackName: 'AcRuntimeStack', Changes: [importChange('whichpart-cognito-auth|whichpart-api-role', 'AWS::IAM::RolePolicy')] };

  it('fails an unacknowledged S4R reference', () => {
    const r = checkChangeSet({ changeSet, denylist, mode: 'import', allowedPhysicalIds: ['whichpart-cognito-auth|whichpart-api-role'], template: { Resources: { P: policy } } });
    expect(r.failures.map((f) => f.rule)).toContain('denylisted-identifier-in-template');
  });

  it('passes an acknowledged reference with a reason, and reports it', () => {
    const r = checkChangeSet({ changeSet, denylist, mode: 'import', allowedPhysicalIds: ['whichpart-cognito-auth|whichpart-api-role'], template: { Resources: { P: policy } }, acknowledgedReferences: [{ value: 'eu-west-1_TESTPOOL1', reason: 'AC sign-in policy names the S4R pool until Phase 7.' }] });
    expect(r.ok).toBe(true);
    expect(r.warnings.map((w) => w.rule)).toContain('acknowledged-s4r-reference');
  });

  it('never lets an acknowledgement waive an S4R resource as the target', () => {
    const r = checkChangeSet({ changeSet: { StackName: 'AcDataStack', Changes: [importChange('eu-west-1_TESTPOOL1', 'AWS::Cognito::UserPool')] }, denylist, mode: 'import', allowedPhysicalIds: ['eu-west-1_TESTPOOL1'], acknowledgedReferences: [{ value: 'eu-west-1_TESTPOOL1', reason: 'attempted waiver' }] });
    expect(r.failures.map((f) => f.rule)).toContain('physical-id-denylisted');
  });
});

describe('update mode', () => {
  const modify = (extra) => ({ Type: 'Resource', ResourceChange: { Action: 'Modify', LogicalResourceId: 'Repo', PhysicalResourceId: 'repo', ResourceType: 'AWS::ECR::Repository', Replacement: 'False', ...extra } });

  it('passes an in-place modification', () => {
    expect(checkChangeSet({ changeSet: { StackName: 'AcDataStack', Changes: [modify()] }, denylist, mode: 'update', allowedPhysicalIds: ['repo'] }).ok).toBe(true);
  });

  it.each(['True', 'Conditional'])('fails Replacement=%s', (replacement) => {
    const r = checkChangeSet({ changeSet: { StackName: 'AcDataStack', Changes: [modify({ Replacement: replacement })] }, denylist, mode: 'update' });
    expect(r.failures.map((f) => f.rule)).toContain('replacement');
  });

  it('fails an unapproved removal and passes an approved one', () => {
    const remove = { Type: 'Resource', ResourceChange: { Action: 'Remove', LogicalResourceId: 'Old', PhysicalResourceId: 'old', ResourceType: 'AWS::SSM::Parameter' } };
    expect(checkChangeSet({ changeSet: { StackName: 'AcDataStack', Changes: [remove] }, denylist, mode: 'update' }).failures.map((f) => f.rule)).toContain('unapproved-removal');
    expect(checkChangeSet({ changeSet: { StackName: 'AcDataStack', Changes: [remove] }, denylist, mode: 'update', approvedRemovals: ['Old'] }).ok).toBe(true);
  });

  it('flags IAM changes and anything touching the S4R-consumed diagnosis Lambda', () => {
    const iam = { Type: 'Resource', ResourceChange: { Action: 'Modify', LogicalResourceId: 'P', PhysicalResourceId: 'p', ResourceType: 'AWS::IAM::RolePolicy', Replacement: 'False' } };
    const fn = { Type: 'Resource', ResourceChange: { Action: 'Modify', LogicalResourceId: 'Diag', PhysicalResourceId: 'spares4repairs-part-finder', ResourceType: 'AWS::Lambda::Function', Replacement: 'False' } };
    const r = checkChangeSet({ changeSet: { StackName: 'AcRuntimeStack', Changes: [iam, fn] }, denylist, mode: 'update', s4rConsumedPhysicalIds: ['spares4repairs-part-finder'] });
    const rules = r.warnings.map((w) => w.rule);
    expect(rules).toContain('iam-change');
    expect(rules).toContain('potentially-impacts-s4r');
  });
});

describe('sandbox mode', () => {
  const sandboxLists = loadSandboxLists();
  const sbx = (changeSet, template) => checkChangeSet({ changeSet, template, denylist: sandboxLists.s4rDenylist, mode: 'sandbox', sandboxLists });

  it('passes an import of a sandbox resource with Retain', () => {
    const r = sbx({ StackName: 'AcDataStack-sbx', Changes: [importChange('whichpart-recalls-sbx', 'AWS::DynamoDB::Table')] }, { Resources: { Lwhichpartrecallssbx: retained('AWS::DynamoDB::Table') } });
    expect(r.failures).toEqual([]);
  });

  it('fails a production resource in a sandbox change set', () => {
    const r = sbx({ StackName: 'AcDataStack-sbx', Changes: [importChange('whichpart-recalls', 'AWS::DynamoDB::Table')] });
    expect(r.failures.map((f) => f.rule)).toEqual(expect.arrayContaining(['change-target-not-sandbox', 'change-target-denylisted']));
  });

  it('keeps the template rules', () => {
    const r = sbx({ StackName: 'AcDataStack-sbx', Changes: [] }, { Resources: { T: { Type: 'AWS::DynamoDB::Table', Properties: { TableName: 'whichpart-recalls-sbx' } } } });
    expect(r.failures.map((f) => f.rule)).toContain('missing-retain-deletion-policy');
  });

  it('refuses sandbox mode without the sandbox lists', () => {
    expect(() => checkChangeSet({ changeSet: { Changes: [] }, denylist: [], mode: 'sandbox' })).toThrow(/sandboxLists/);
  });
});

describe('IAM rules from the Phase 4 experiments', () => {
  const role = (props) => ({ Type: 'AWS::IAM::Role', DeletionPolicy: 'Retain', UpdateReplacePolicy: 'Retain', Properties: { RoleName: 'whichpart-api-role', ...props } });
  const run = (mode, props) => checkChangeSet({
    changeSet: { StackName: 'AcRuntimeStack', Changes: [importChange('whichpart-api-role', 'AWS::IAM::Role')] },
    denylist, mode, allowedPhysicalIds: ['whichpart-api-role'], template: { Resources: { Lwhichpartapirole: role(props) } },
  });
  it('T2: fails a role that declares Policies in Phase 5 modes', () => {
    const r = run('import', { ManagedPolicyArns: ['arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole'], Policies: [] });
    expect(r.failures.map((f) => f.rule)).toContain('role-declares-policies');
  });
  it('T7: fails a role that leaves out ManagedPolicyArns in Phase 5 modes', () => {
    expect(run('update', {}).failures.map((f) => f.rule)).toContain('role-without-managed-policy-arns');
    expect(run('import', { ManagedPolicyArns: ['arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole'] }).failures).toEqual([]);
  });
});
