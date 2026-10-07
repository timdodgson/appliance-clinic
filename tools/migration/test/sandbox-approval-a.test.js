import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkChangeSet } from '../src/changeset/check.js';
import {
  BUDGET_NAME, MANAGED_POLICY_MAX, POLICY, budget, budgetNotifications, denyPolicy, executionPolicy, iamGlobMatch,
  operatorPolicy, operatorTrustPolicy, patchBootstrapTemplate, policySize,
} from '../src/sandbox/approval-a.js';
import { loadSandboxLists, resolveTemplateValue, templateContext } from '../src/sandbox/guard.js';
import { readJson, REPO_ROOT } from '../src/util/files.js';

const A = '800960611664';
const R = 'eu-west-1';
const DIR = join(REPO_ROOT, 'docs', 'migration', 'sandbox', 'approval-a');
const committed = (name) => JSON.parse(readFileSync(join(DIR, name), 'utf8'));
const stock = committed('bootstrap-stock-v32.json');
const lists = loadSandboxLists();
const acDeny = readJson(join(REPO_ROOT, 'docs', 'migration', 'ac-production-denylist.json')).entries;
const s4rDeny = readJson(join(REPO_ROOT, 'docs', 'migration', 's4r-denylist.json')).entries;

// --- a minimal IAM evaluator: enough to prove which statements can apply to an action on an ARN ---
const list = (v) => (v === undefined ? [] : [].concat(v));
const actionMatches = (s, action) => (s.Action ? list(s.Action).some((p) => iamGlobMatch(p, action)) : !list(s.NotAction).some((p) => iamGlobMatch(p, action)));
const resourceMatches = (s, arn) => (s.Resource ? list(s.Resource).some((p) => iamGlobMatch(p, arn)) : !list(s.NotResource).some((p) => iamGlobMatch(p, arn)));
const applies = (s, action, arn) => actionMatches(s, action) && resourceMatches(s, arn);
/** Denied by an unconditional Deny (conditions are ignored only where a statement has none). */
const denied = (policy, action, arn) => policy.Statement.some((s) => s.Effect === 'Deny' && !s.Condition && applies(s, action, arn));
/** Allowed by any Allow, treating every condition as satisfied: the conservative reading for "never allowed". */
const allowedIgnoringConditions = (policy, action, arn) => policy.Statement.some((s) => s.Effect === 'Allow' && applies(s, action, arn));
const allowedUnconditionally = (policy, action, arn) => policy.Statement.some((s) => s.Effect === 'Allow' && !s.Condition && applies(s, action, arn));

/** A representative ARN and a mutating action for an identifier of a CloudFormation type. */
function target(type, name) {
  switch (type) {
    case 'AWS::Lambda::Function': return [`arn:aws:lambda:${R}:${A}:function:${name}`, 'lambda:UpdateFunctionCode'];
    case 'AWS::Logs::LogGroup': return [`arn:aws:logs:${R}:${A}:log-group:${name}`, 'logs:DeleteLogGroup'];
    case 'AWS::IAM::Role': return [`arn:aws:iam::${A}:role/${name}`, 'iam:PutRolePolicy'];
    case 'AWS::IAM::RolePolicy': case 'AWS::IAM::Policy': return [`arn:aws:iam::${A}:role/${name.split('/')[0]}`, 'iam:PutRolePolicy'];
    case 'AWS::IAM::ManagedPolicy': return [`arn:aws:iam::${A}:policy/${name}`, 'iam:CreatePolicyVersion'];
    case 'AWS::DynamoDB::Table': return [`arn:aws:dynamodb:${R}:${A}:table/${name}`, 'dynamodb:DeleteTable'];
    case 'AWS::S3::Bucket': case 'AWS::S3::BucketPolicy': return [`arn:aws:s3:::${name}`, 's3:PutBucketPolicy'];
    case 'AWS::ECR::Repository': return [`arn:aws:ecr:${R}:${A}:repository/${name}`, 'ecr:DeleteRepository'];
    case 'AWS::SecretsManager::Secret': return [`arn:aws:secretsmanager:${R}:${A}:secret:${name}-AbCdEf`, 'secretsmanager:GetSecretValue'];
    case 'AWS::Events::Rule': return [`arn:aws:events:${R}:${A}:rule/${name}`, 'events:PutRule'];
    case 'AWS::CloudFormation::Stack': return [`arn:aws:cloudformation:${R}:${A}:stack/${name}/00000000-0000-0000-0000-000000000000`, 'cloudformation:DeleteStack'];
    case 'AWS::SSM::Parameter': return [`arn:aws:ssm:${R}:${A}:parameter${name}`, 'ssm:PutParameter'];
    case 'AWS::Cognito::UserPool': return [`arn:aws:cognito-idp:${R}:${A}:userpool/${name}`, 'cognito-idp:DeleteUserPool'];
    case 'AWS::ApiGatewayV2::Api': return [`arn:aws:apigateway:${R}::/apis/${name}`, 'apigateway:DELETE'];
    case 'AWS::CloudFront::Distribution': return [`arn:aws:cloudfront::${A}:distribution/${name}`, 'cloudfront:UpdateDistribution'];
    case 'AWS::CloudFront::Function': return [name.startsWith('arn:') ? name : `arn:aws:cloudfront::${A}:function/${name}`, 'cloudfront:UpdateFunction'];
    case 'AWS::CertificateManager::Certificate': return [name, 'acm:DeleteCertificate'];
    case 'AWS::Budgets::Budget': return [`arn:aws:budgets::${A}:budget/${name}`, 'budgets:ModifyBudget'];
    default: return null;
  }
}

/** Every production AC and S4R identifier as [label, arn, action], or null where it has no ARN of its own. */
function productionTargets() {
  const out = [];
  for (const e of acDeny) {
    if (e.kind === 'arn') out.push([e.value, e.value, target(e.resourceType, 'x')?.[1] || 'iam:PutRolePolicy']);
    else if (e.kind === 'arnPrefix') out.push([e.value, `${e.value}x`, target(e.resourceType, 'x')[1]]);
    else if (e.kind === 'stack') out.push([e.value, ...target('AWS::CloudFormation::Stack', e.value)]);
    else if (e.kind === 'rolePolicy') out.push([e.value, ...target('AWS::IAM::RolePolicy', e.value)]);
    else if (e.resourceType === 'AWS::Lambda::Url') continue; // a URL is reached only through its function, covered above
    else { const t = target(e.resourceType, e.value); if (t) out.push([e.value, ...t]); else throw new Error(`no ARN for ${e.resourceType}`); }
  }
  for (const e of s4rDeny) {
    const type = e.resourceType || (e.kind === 'stack' ? 'AWS::CloudFormation::Stack' : null);
    if (e.kind === 'arn') { out.push([e.value, e.value, 'secretsmanager:GetSecretValue']); continue; }
    if (type === 'AWS::IAM::Policy') continue; // inline policies on S4R roles: covered by the role entries
    if (/^AWS::EC2::/.test(type || '')) { out.push([e.value, `arn:aws:ec2:${R}:${A}:x/${e.value}`, 'ec2:DeleteRoute']); continue; }
    if (/^(Custom::|AWS::CDK::Metadata)/.test(type || '')) continue; // not addressable by IAM
    if (type === 'AWS::CloudFront::OriginAccessControl') { out.push([e.value, `arn:aws:cloudfront::${A}:origin-access-control/${e.value}`, 'cloudfront:DeleteOriginAccessControl']); continue; }
    if (type === 'AWS::Cognito::UserPoolClient') continue; // reached only through its pool, covered by the pool entry
    if (!type) { out.push([e.value, '*', /cloudfront/.test(e.value) ? 'cloudfront:UpdateDistribution' : 'rds:ModifyDBInstance']); continue; } // hosts
    const t = target(type, e.value);
    if (!t) throw new Error(`no ARN for ${type} ${e.value}`);
    out.push([e.value, ...t]);
  }
  return out;
}

/** Every allowlisted sandbox name as [label, type, arn, action]. */
function sandboxTargets() {
  const out = [];
  for (const [rawType, names] of Object.entries(lists.allowlist.names)) {
    const type = rawType.replace(/\(.*\)$/, '');
    for (const n of names) { const t = target(type, n); if (t) out.push([n, type, ...t]); }
  }
  return out;
}

const PROTECTED = new Set(['ac-operator-sbx', ...Object.values(POLICY), BUDGET_NAME]);
const policies = { operator: operatorPolicy(), execution: executionPolicy(), deny: denyPolicy() };

describe('approval point A documents', () => {
  it('are committed exactly as generated', () => {
    expect(committed('ac-operator-policy-sbx.json')).toEqual(policies.operator);
    expect(committed('ac-cfn-execution-sbx.json')).toEqual(policies.execution);
    expect(committed('ac-deny-production-sbx.json')).toEqual(policies.deny);
    expect(committed('ac-operator-sbx-trust.json')).toEqual(operatorTrustPolicy());
    expect(committed('ac-budget-sbx.json')).toEqual(budget());
    expect(committed('ac-budget-sbx-notifications.json')).toEqual(budgetNotifications());
    expect(committed('bootstrap-acsbx.json')).toEqual(patchBootstrapTemplate(stock));
  });

  it('fit the IAM managed-policy size limit', () => {
    for (const [name, p] of Object.entries(policies)) expect(policySize(p), name).toBeLessThanOrEqual(MANAGED_POLICY_MAX);
  });

  it('commit no email address or user ID: both are substituted at execution', () => {
    const text = readFileSync(join(DIR, 'ac-budget-sbx-notifications.json'), 'utf8') + readFileSync(join(DIR, 'ac-operator-sbx-trust.json'), 'utf8');
    expect(text).not.toMatch(/@/);
    expect(text).not.toMatch(/AIDA[0-9A-Z]{10,}/);
    expect(text).toContain('${OWNER_EMAIL}');
    expect(text).toContain('${OPERATOR_USER_ID}');
  });
});

describe('ac-deny-production-sbx', () => {
  const targets = productionTargets();
  it('covers a representative set of production AC and S4R identifiers', () => {
    expect(targets.length).toBeGreaterThan(120);
  });
  it('denies a write to every production AC and S4R identifier', () => {
    const missed = targets.filter(([, arn, action]) => !denied(policies.deny, action, arn)).map(([label]) => label);
    expect(missed).toEqual([]);
  });
  it('does not deny writes to sandbox resources, except the controls themselves', () => {
    const blocked = sandboxTargets().filter(([n, , arn, action]) => !PROTECTED.has(n) && denied(policies.deny, action, arn)).map(([n]) => n);
    expect(blocked).toEqual([]);
  });
  it('protects the controls from change but leaves them readable', () => {
    for (const name of Object.values(POLICY)) {
      expect(denied(policies.deny, 'iam:CreatePolicyVersion', `arn:aws:iam::${A}:policy/${name}`)).toBe(true);
      expect(denied(policies.deny, 'iam:GetPolicy', `arn:aws:iam::${A}:policy/${name}`)).toBe(false);
    }
    expect(denied(policies.deny, 'iam:PutRolePolicy', `arn:aws:iam::${A}:role/ac-operator-sbx`)).toBe(true);
    expect(denied(policies.deny, 'iam:AttachRolePolicy', `arn:aws:iam::${A}:role/ac-operator-sbx`)).toBe(true);
    expect(denied(policies.deny, 'budgets:ModifyBudget', `arn:aws:budgets::${A}:budget/${BUDGET_NAME}`)).toBe(true);
    expect(denied(policies.deny, 'iam:DeleteRolePermissionsBoundary', `arn:aws:iam::${A}:role/whichpart-api-role-sbx`)).toBe(true);
  });
  it('never denies KMS use, which Lambda and S3 need for AWS-managed keys', () => {
    expect(denied(policies.deny, 'kms:GenerateDataKey', '*')).toBe(false);
    expect(denied(policies.deny, 'kms:Decrypt', '*')).toBe(false);
    expect(denied(policies.deny, 'kms:ScheduleKeyDeletion', '*')).toBe(true);
  });
  it('denies requests outside eu-west-1, except global services', () => {
    const s = policies.deny.Statement.find((x) => x.Sid === 'DenyOtherRegions');
    expect(s.Condition).toEqual({ StringNotEquals: { 'aws:RequestedRegion': R } });
    expect(s.NotAction).toEqual(['iam:*', 'sts:*', 'budgets:*', 'ce:*', 'tag:*']);
  });
  it('never ends a production name in a bare wildcard that could reach its sandbox name', () => {
    for (const r of policies.deny.Statement.find((x) => x.Sid === 'DenyProductionAndS4R').Resource) {
      for (const [n, , arn] of sandboxTargets()) expect(iamGlobMatch(r, arn), `${r} must not match ${n}`).toBe(false);
    }
  });
});

describe('ac-operator-policy-sbx and ac-cfn-execution-sbx', () => {
  for (const name of ['operator', 'execution']) {
    const p = policies[name];
    it(`${name}: allows nothing on a production AC or S4R identifier without a sandbox condition`, () => {
      const reached = productionTargets().filter(([, arn, action]) => arn !== '*' && allowedUnconditionally(p, action, arn)).map(([l]) => l);
      expect(reached).toEqual([]);
    });
    it(`${name}: every conditional allow that could reach production is also covered by the deny`, () => {
      // Tag-conditioned API Gateway and Cognito statements: the S4R API and pool are denied outright.
      const reached = productionTargets().filter(([, arn, action]) => arn !== '*' && allowedIgnoringConditions(p, action, arn) && !allowedUnconditionally(p, action, arn));
      for (const [l, arn, action] of reached) expect(denied(policies.deny, action, arn), l).toBe(true);
    });
    it(`${name}: every resource pattern carries a sandbox marker, and "*" only for reads or conditioned creates`, () => {
      for (const s of p.Statement) {
        for (const r of list(s.Resource)) {
          if (r === '*') {
            const reads = list(s.Action).every((a) => /^[a-z0-9-]+:(Get|List|Describe|Validate)/.test(a) || a === 'sts:GetCallerIdentity');
            expect(reads || Boolean(s.Condition), `${s.Sid}: "*" needs read-only actions or a condition`).toBe(true);
          } else if (!/budget\/ac-budget-sbx$|::\/apis(\/\*)?$|userpool\/\*$/.test(r)) {
            expect(r, s.Sid).toMatch(/-sbx|acsbx|applianceclinic-sbx\/|ApplianceClinicSandboxToolkit/);
          }
        }
      }
    });
  }
  it('lets the execution role manage every sandbox resource type it will deploy', () => {
    const unmanaged = sandboxTargets()
      .filter(([n, type]) => !PROTECTED.has(n) && !/^cdk-acsbx-/.test(n) && type !== 'AWS::Budgets::Budget')
      .filter(([, , arn, action]) => !allowedIgnoringConditions(policies.execution, action, arn))
      .map(([n]) => n);
    expect(unmanaged).toEqual([]);
  });
  it('requires the boundary on every role the sandbox creates or changes the policies of', () => {
    const s = policies.execution.Statement.find((x) => x.Sid === 'SandboxRolesWithBoundary');
    expect(s.Condition).toEqual({ StringEquals: { 'iam:PermissionsBoundary': `arn:aws:iam::${A}:policy/${POLICY.execution}` } });
    expect(s.Action).toEqual(expect.arrayContaining(['iam:CreateRole', 'iam:PutRolePolicy']));
    const attach = policies.execution.Statement.find((x) => x.Sid === 'SandboxRolesAttachBasicOnly');
    expect(attach.Condition.StringEquals).toEqual({ 'iam:PermissionsBoundary': `arn:aws:iam::${A}:policy/${POLICY.execution}`, 'iam:PolicyARN': 'arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole' });
    // No other statement lets a sandbox role gain a managed policy.
    const others = policies.execution.Statement.filter((x) => x.Effect === 'Allow' && x !== attach && list(x.Action).some((a) => iamGlobMatch(a, 'iam:AttachRolePolicy')));
    expect(others).toEqual([]);
  });
  it('lets the operator write toolkit roles only through CloudFormation', () => {
    const s = policies.operator.Statement.find((x) => x.Sid === 'ToolkitRolesViaCloudFormation');
    expect(s.Resource).toEqual([`arn:aws:iam::${A}:role/cdk-acsbx-*`]);
    expect(s.Condition).toEqual({ 'ForAnyValue:StringEquals': { 'aws:CalledVia': ['cloudformation.amazonaws.com'] } });
  });
});

describe('the acsbx bootstrap template', () => {
  const t = patchBootstrapTemplate(stock);
  it('differs from the stock CDK v32 template only in the reviewed places', () => {
    const strip = (x) => {
      const c = JSON.parse(JSON.stringify(x));
      delete c.Description;
      for (const p of ['Qualifier', 'CloudFormationExecutionPolicies', 'FileAssetsBucketKmsKeyId', 'TrustedAccounts', 'TrustedAccountsForLookup', 'UseExamplePermissionsBoundary']) {
        delete c.Parameters[p].Default; delete c.Parameters[p].AllowedValues;
      }
      for (const r of Object.values(c.Resources)) { delete r.DeletionPolicy; delete r.UpdateReplacePolicy; }
      delete c.Resources.DeploymentActionRole.Properties.Policies[0].PolicyDocument.Statement;
      for (const n of ['DeploymentActionRole', 'FilePublishingRole', 'ImagePublishingRole', 'LookupRole']) delete c.Resources[n].Properties.ManagedPolicyArns;
      return c;
    };
    expect(strip(t)).toEqual(strip(stock));
    expect(stock.Resources.CdkBootstrapVersion.Properties.Value).toBe('32');
  });
  it('gives the deploy role CloudFormation rights on sandbox stacks only, and no cross-account or refactor rights', () => {
    const st = t.Resources.DeploymentActionRole.Properties.Policies[0].PolicyDocument.Statement;
    expect(st.map((s) => s.Sid)).not.toEqual(expect.arrayContaining(['PipelineCrossAccountArtifactsBucket']));
    expect(st.find((s) => s.Sid === 'Refactor')).toBeUndefined();
    expect(st.find((s) => s.Sid === 'PipelineCrossAccountArtifactsKey')).toBeUndefined();
    for (const s of st) {
      if (list(s.Action).some((a) => a.startsWith('cloudformation:'))) {
        expect(JSON.stringify(s.Resource)).toContain('stack/*-sbx/*');
        expect(s.Resource).not.toBe('*');
      }
      if (s.Resource === '*') expect(list(s.Action)).toEqual(['sts:GetCallerIdentity']);
    }
  });
  it('attaches the deny policy to every toolkit role', () => {
    for (const n of ['DeploymentActionRole', 'FilePublishingRole', 'ImagePublishingRole', 'LookupRole']) {
      expect(JSON.stringify(t.Resources[n].Properties.ManagedPolicyArns), n).toContain(`policy/${POLICY.deny}`);
    }
    expect(t.Parameters.CloudFormationExecutionPolicies.Default).toBe(`arn:aws:iam::${A}:policy/${POLICY.execution},arn:aws:iam::${A}:policy/${POLICY.deny}`);
  });
  it('fixes the qualifier, the AWS-managed key and no example boundary', () => {
    expect(t.Parameters.Qualifier.AllowedValues).toEqual(['acsbx']);
    expect(t.Parameters.FileAssetsBucketKmsKeyId.AllowedValues).toEqual(['AWS_MANAGED_KEY']);
    expect(t.Parameters.UseExamplePermissionsBoundary.AllowedValues).toEqual(['false']);
  });

  // The change set CloudFormation would produce: an Add for every resource whose condition holds.
  const created = ['StagingBucket', 'StagingBucketPolicy', 'ContainerAssetsRepository', 'FilePublishingRole', 'ImagePublishingRole', 'LookupRole', 'FilePublishingRoleDefaultPolicy', 'ImagePublishingRoleDefaultPolicy', 'DeploymentActionRole', 'CloudFormationExecutionRole', 'CdkBootstrapVersion'];
  const changeSet = (parameters = []) => ({
    StackName: 'ApplianceClinicSandboxToolkit', Parameters: parameters,
    Changes: created.map((id) => ({ Type: 'Resource', ResourceChange: { Action: 'Add', LogicalResourceId: id, ResourceType: t.Resources[id].Type } })),
  });

  it('creates exactly the eleven expected resources, with these names', () => {
    const conditional = Object.entries(t.Resources).filter(([, r]) => r.Condition).map(([id]) => id).sort();
    expect(conditional).toEqual(['CdkBoostrapPermissionsBoundaryPolicy', 'FileAssetsBucketEncryptionKey', 'FileAssetsBucketEncryptionKeyAlias']);
    expect(Object.keys(t.Resources).filter((id) => !t.Resources[id].Condition).sort()).toEqual([...created].sort());
    const ctx = templateContext(t, changeSet());
    const names = Object.fromEntries(created.map((id) => {
      const p = t.Resources[id].Properties;
      const v = p.RoleName ?? p.BucketName ?? p.RepositoryName ?? p.Name ?? p.PolicyName ?? p.Bucket;
      return [id, resolveTemplateValue(v, ctx)];
    }));
    expect(names).toEqual({
      StagingBucket: `cdk-acsbx-assets-${A}-${R}`, StagingBucketPolicy: `cdk-acsbx-assets-${A}-${R}`,
      ContainerAssetsRepository: `cdk-acsbx-container-assets-${A}-${R}`,
      FilePublishingRole: `cdk-acsbx-file-publishing-role-${A}-${R}`, ImagePublishingRole: `cdk-acsbx-image-publishing-role-${A}-${R}`,
      LookupRole: `cdk-acsbx-lookup-role-${A}-${R}`, DeploymentActionRole: `cdk-acsbx-deploy-role-${A}-${R}`,
      CloudFormationExecutionRole: `cdk-acsbx-cfn-exec-role-${A}-${R}`,
      FilePublishingRoleDefaultPolicy: `cdk-acsbx-file-publishing-role-default-policy-${A}-${R}`,
      ImagePublishingRoleDefaultPolicy: `cdk-acsbx-image-publishing-role-default-policy-${A}-${R}`,
      CdkBootstrapVersion: '/cdk-bootstrap/acsbx/version',
    });
  });
  it('passes the sandbox change-set checker as a whole', () => {
    const r = checkChangeSet({ changeSet: changeSet(), template: t, mode: 'sandbox', sandboxLists: lists, denylist: s4rDeny });
    expect(r.failures).toEqual([]);
    expect(r.ok).toBe(true);
  });
  it('fails the checker if deployed with the default S4R qualifier', () => {
    const r = checkChangeSet({ changeSet: changeSet([{ ParameterKey: 'Qualifier', ParameterValue: 'hnb659fds' }]), template: t, mode: 'sandbox', sandboxLists: lists, denylist: s4rDeny });
    expect(r.ok).toBe(false);
    expect(r.failures.map((f) => f.rule)).toEqual(expect.arrayContaining(['change-target-not-sandbox', 'change-target-denylisted']));
  });
  it('fails the checker for the stock template, which has no Retain policies', () => {
    const r = checkChangeSet({ changeSet: changeSet([{ ParameterKey: 'Qualifier', ParameterValue: 'acsbx' }]), template: stock, mode: 'sandbox', sandboxLists: lists, denylist: s4rDeny });
    expect(r.failures.map((f) => f.rule)).toEqual(expect.arrayContaining(['missing-retain-deletion-policy']));
  });
});

describe('trust and budget', () => {
  it('lets only the approving IAM user assume the operator role', () => {
    expect(operatorTrustPolicy('AIDAEXAMPLE0000000000').Statement).toEqual([{
      Effect: 'Allow', Principal: { AWS: `arn:aws:iam::${A}:root` }, Action: 'sts:AssumeRole',
      Condition: { StringEquals: { 'aws:userid': 'AIDAEXAMPLE0000000000' } },
    }]);
  });
  it('is a daily account-wide cost budget of $15 with alerts at 80% and 100% of actual spend', () => {
    expect(budget()).toMatchObject({ BudgetName: 'ac-budget-sbx', BudgetType: 'COST', TimeUnit: 'DAILY', BudgetLimit: { Amount: '15', Unit: 'USD' } });
    expect(budgetNotifications('x').map((n) => n.Notification.Threshold)).toEqual([80, 100]);
  });
});
