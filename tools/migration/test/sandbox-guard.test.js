import { describe, expect, it } from 'vitest';
import {
  arnResourceName, arnServiceForType, buildLists, checkCaller, checkDocument, checkFunctionEnv, checkSandboxChangeSet, checkTarget, loadSandboxLists,
} from '../src/sandbox/guard.js';

// The real lists from docs/migration: the guard must hold against them, not only against fixtures.
const lists = loadSandboxLists();
const rules = (failures) => failures.map((f) => f.rule);
const A = '800960611664';

const URLS = { orchestrator: 'orchsbxhost000000000000000000000', engine: 'pfsbxhost0000000000000000000000a', mcp: 'mcpsbxhost000000000000000000000a' };
const withGenerated = buildLists({
  allowlist: lists.allowlist,
  acDenylist: lists.acDenylist,
  s4rDenylist: lists.s4rDenylist,
  generated: [
    { type: 'AWS::Lambda::Url', id: `${URLS.orchestrator}.lambda-url.eu-west-1.on.aws`, parent: 'spares4repairs-diag-orchestrator-sbx' },
    { type: 'AWS::Lambda::Url', id: `${URLS.engine}.lambda-url.eu-west-1.on.aws`, parent: 'spares4repairs-part-finder-sbx' },
    { type: 'AWS::Lambda::Url', id: `${URLS.mcp}.lambda-url.eu-west-1.on.aws`, parent: 'spares4repairs-error-code-mcp-sbx' },
    { type: 'AWS::ApiGatewayV2::ApiId', id: 'sbxapi0001', parent: 'spares4repairs-sbx' },
    { type: 'AWS::Cognito::UserPoolId', id: 'eu-west-1_SbxPool01', parent: 'SparesSite-sbx-UserPool' },
    { type: 'AWS::Cognito::UserPoolClientId', id: 'sbxclient0000000000000000a', parent: 'SparesSite-sbx-AdminClient' },
  ],
});

describe('the lists themselves', () => {
  it('no allowlisted name is on either denylist', () => {
    for (const [name, types] of lists.names) for (const type of types) expect(checkTarget(lists, { type, id: name }), name).toEqual([]);
  });
  it('every production AC function is denylisted', () => {
    for (const f of ['whichpart-api', 'spares4repairs-part-finder', 'spares4repairs-diag-orchestrator', 'spares4repairs-error-code-mcp']) {
      expect(rules(checkTarget(lists, { type: 'AWS::Lambda::Function', id: f }))).toContain('denylisted');
    }
  });
});

describe('caller', () => {
  const op = `arn:aws:sts::${A}:assumed-role/ac-operator-sbx/session`;
  it('accepts the sandbox operator in the right account and region', () => {
    expect(checkCaller({ account: A, region: 'eu-west-1', arn: op })).toEqual([]);
  });
  it('accepts an acsbx toolkit role', () => {
    expect(checkCaller({ account: A, region: 'eu-west-1', arn: `arn:aws:sts::${A}:assumed-role/cdk-acsbx-cfn-exec-role-${A}-eu-west-1/x` })).toEqual([]);
  });
  it('refuses another account, another region, and any other caller', () => {
    expect(rules(checkCaller({ account: '111111111111', region: 'eu-west-1', arn: op }))).toContain('wrong-account');
    expect(rules(checkCaller({ account: A, region: 'us-east-1', arn: op }))).toContain('wrong-region');
    expect(rules(checkCaller({ account: A, region: 'eu-west-1', arn: `arn:aws:iam::${A}:user/someone` }))).toContain('not-a-sandbox-caller');
    expect(rules(checkCaller({ account: A, region: 'eu-west-1', arn: `arn:aws:sts::${A}:assumed-role/cdk-hnb659fds-cfn-exec-role-${A}-eu-west-1/x` }))).toContain('not-a-sandbox-caller');
  });
  it('lets the bootstrap step run as the operator user, but never in another account', () => {
    expect(checkCaller({ account: A, region: 'eu-west-1', arn: `arn:aws:iam::${A}:user/someone` }, { bootstrap: true })).toEqual([]);
    expect(rules(checkCaller({ account: '111111111111', region: 'eu-west-1', arn: op }, { bootstrap: true }))).toContain('wrong-account');
  });
});

describe('targets', () => {
  it('accepts a sandbox name under its own type', () => {
    expect(checkTarget(lists, { type: 'AWS::Lambda::Function', id: 'whichpart-api-sbx' })).toEqual([]);
    expect(checkTarget(lists, { type: 'AWS::IAM::RolePolicy', id: 'SparesSite-sbx-ServerFunctionRole/t1-unmanaged-sbx' })).toEqual([]);
  });
  it('does not confuse a production name with its sandbox name, in either direction', () => {
    expect(rules(checkTarget(lists, { type: 'AWS::Lambda::Function', id: 'whichpart-api' }))).toEqual(['denylisted', 'not-allowlisted']);
    expect(rules(checkTarget(lists, { type: 'AWS::Lambda::Function', id: 'whichpart-api-sbx2' }))).toEqual(['not-allowlisted']);
  });
  it('refuses a sandbox name used under another type', () => {
    expect(rules(checkTarget(lists, { type: 'AWS::DynamoDB::Table', id: 'whichpart-api-sbx' }))).toEqual(['not-allowlisted']);
  });
  it('refuses production AC resources of every kind', () => {
    for (const [type, id] of [
      ['AWS::DynamoDB::Table', 'whichpart-transcripts'], ['AWS::S3::Bucket', `whichpart-learning-${A}`], ['AWS::IAM::Role', 'whichpart-api-role'],
      ['AWS::IAM::RolePolicy', 'whichpart-api-role/whichpart-cognito-auth'], ['AWS::SecretsManager::Secret', 'spares4repairs/diag-orchestrator/bearer-token'],
      ['AWS::ECR::Repository', 'spares4repairs-error-code-mcp'], ['AWS::Events::Rule', 'whichpart-transcript-review'],
      ['AWS::CloudFormation::Stack', 'ApplianceClinicToolkit'], ['AWS::CloudFormation::Stack', 'AcDataStack'],
    ]) expect(rules(checkTarget(lists, { type, id })), id).toContain('denylisted');
  });
  it('refuses S4R resources', () => {
    for (const [type, id] of [['AWS::CloudFormation::Stack', 'SparesSite-dev'], ['AWS::CloudFormation::Stack', 'CDKToolkit'], ['AWS::Lambda::Function', 'spares4repairs-server-dev'], ['AWS::Cognito::UserPool', 'eu-west-1_mUWucohuX']]) {
      expect(rules(checkTarget(lists, { type, id })), id).toContain('denylisted');
    }
    expect(rules(checkTarget(lists, { type: 'AWS::IAM::RolePolicy', id: 'SparesSite-dev-ServerFunctionRoleC337EDB9-7aUzUc2qUHib/WhichpartLearningPut' }))).toContain('denylisted');
  });
  it('accepts a generated identifier only when recorded under an allowlisted parent', () => {
    expect(checkTarget(withGenerated, { type: 'AWS::ApiGatewayV2::ApiId', id: 'sbxapi0001', parent: 'spares4repairs-sbx' })).toEqual([]);
    expect(rules(checkTarget(lists, { type: 'AWS::ApiGatewayV2::ApiId', id: 'sbxapi0001', parent: 'spares4repairs-sbx' }))).toEqual(['generated-id-not-recorded']);
    expect(rules(checkTarget(lists, { type: 'AWS::ApiGatewayV2::ApiId', id: 'x', parent: 'spares4repairs-dev' }))).toContain('parent-not-allowlisted');
  });
  it('refuses to record the S4R API or a production Function URL as a sandbox child', () => {
    expect(() => buildLists({ ...lists, allowlist: lists.allowlist, generated: [{ type: 'AWS::ApiGatewayV2::ApiId', id: '65vnizdmk4', parent: 'spares4repairs-sbx' }] })).toThrow(/denylisted/);
    expect(() => buildLists({ ...lists, allowlist: lists.allowlist, generated: [{ type: 'AWS::Lambda::Url', id: '3asx4cw2qs5ajsjkytdwffhhvy0ptnoz.lambda-url.eu-west-1.on.aws', parent: 'spares4repairs-part-finder-sbx' }] })).toThrow(/denylisted/);
  });
});

describe('documents', () => {
  it('passes a document that names only sandbox resources', () => {
    const doc = { Role: `arn:aws:iam::${A}:role/whichpart-api-role-sbx`, Table: `arn:aws:dynamodb:eu-west-1:${A}:table/whichpart-recalls-sbx/index/gsi_activity`, Bucket: `arn:aws:s3:::whichpart-learning-sbx-${A}/learning/*`, Managed: 'arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole', Secret: `arn:aws:secretsmanager:eu-west-1:${A}:secret:applianceclinic-sbx/openai-AbC123` };
    expect(checkDocument(lists, doc)).toEqual([]);
  });
  it('finds a production AC identifier anywhere, but not inside its sandbox name', () => {
    expect(rules(checkDocument(lists, { env: { RECALL_TABLE: 'whichpart-recalls' } }))).toContain('production-ac-identifier');
    expect(checkDocument(lists, { env: { RECALL_TABLE: 'whichpart-recalls-sbx' } })).toEqual([]);
    expect(rules(checkDocument(lists, 'https://3asx4cw2qs5ajsjkytdwffhhvy0ptnoz.lambda-url.eu-west-1.on.aws/'))).toContain('production-ac-identifier');
  });
  it('finds S4R identifiers', () => {
    expect(rules(checkDocument(lists, { SEARCH_API: 'https://65vnizdmk4.execute-api.eu-west-1.amazonaws.com/api/search' }))).toContain('s4r-identifier');
  });
  it('refuses any account ARN or S3 ARN that is not a sandbox resource', () => {
    expect(rules(checkDocument(lists, { r: `arn:aws:dynamodb:eu-west-1:${A}:table/spares4repairs-orders-dev` }))).toContain('arn-not-sandbox');
    expect(rules(checkDocument(lists, { r: 'arn:aws:s3:::someone-elses-bucket/*' }))).toContain('arn-not-sandbox');
    expect(rules(checkDocument(lists, { r: 'arn:aws:iam::123456789012:role/x' }))).toContain('foreign-account-arn');
    expect(rules(checkDocument(lists, { r: `arn:aws:secretsmanager:eu-west-1:${A}:secret:spares4repairs/sbx/applianceclinic-openai-AbC123` }))).toContain('arn-not-sandbox');
  });
  it('checks each ARN of a comma-separated list on its own', () => {
    expect(checkDocument(lists, { p: `arn:aws:iam::${A}:policy/ac-cfn-execution-sbx,arn:aws:iam::${A}:policy/ac-deny-production-sbx` })).toEqual([]);
    expect(rules(checkDocument(lists, { p: `arn:aws:iam::${A}:policy/ac-cfn-execution-sbx,arn:aws:iam::${A}:role/whichpart-api-role` }))).toContain('arn-not-sandbox');
  });
  it('accepts a sandbox-prefixed wildcard ARN and refuses any other wildcard', () => {
    expect(checkDocument(lists, { r: `arn:aws:secretsmanager:eu-west-1:${A}:secret:applianceclinic-sbx/*` })).toEqual([]);
    expect(rules(checkDocument(lists, { r: `arn:aws:secretsmanager:eu-west-1:${A}:secret:spares4repairs/dev/applianceclinic-*` }))).toContain('arn-not-sandbox');
    expect(rules(checkDocument(lists, { r: `arn:aws:lambda:eu-west-1:${A}:function:*` }))).toContain('arn-not-sandbox');
    expect(rules(checkDocument(lists, { r: `arn:aws:dynamodb:eu-west-1:${A}:table/*` }))).toContain('arn-not-sandbox');
  });
  it('parses the resource name of common ARNs', () => {
    expect(arnResourceName(`arn:aws:lambda:eu-west-1:${A}:function:whichpart-api-sbx:$LATEST`).name).toBe('whichpart-api-sbx');
    expect(arnResourceName(`arn:aws:logs:eu-west-1:${A}:log-group:/aws/lambda/whichpart-api-sbx:*`).name).toBe('/aws/lambda/whichpart-api-sbx');
    expect(arnResourceName(`arn:aws:ssm:eu-west-1:${A}:parameter/cdk-bootstrap/acsbx/version`).name).toBe('/cdk-bootstrap/acsbx/version');
  });
});

describe('sandbox function environment', () => {
  const host = (h) => `https://${h}.lambda-url.eu-west-1.on.aws/`;
  const goodApi = {
    STAGE: 'sbx', ORCHESTRATOR_URL: host(URLS.orchestrator), ENGINE_URL: host(URLS.engine), LEARNING_BUCKET: `whichpart-learning-sbx-${A}`,
    WHICHPART_WEB_BUCKET: `whichpart-web-sbx-${A}`, RECALL_TABLE: 'whichpart-recalls-sbx', TRANSCRIPT_TABLE: 'whichpart-transcripts-sbx',
    S4R_PRODUCT_BASE_URL: 'https://example.invalid', COGNITO_USER_POOL_ID: 'eu-west-1_SbxPool01', COGNITO_CLIENT_ID: 'sbxclient0000000000000000a',
    CANONICAL_TOKEN_SECRET_ID: 'applianceclinic-sbx/canonical-state-token', BENCHMARK_SERVICE_SECRET_ID: 'applianceclinic-sbx/benchmark-service',
    OPENAI_BASE_URL: 'https://example.invalid', LM_STUDIO_URL: 'https://example.invalid', CANONICAL_MODE: 'live',
  };
  it('passes a fully overridden environment', () => {
    expect(checkFunctionEnv(withGenerated, 'whichpart-api-sbx', goodApi)).toEqual([]);
  });
  it('fails when an override is missing, so the code would fall back to production', () => {
    const env = { ...goodApi };
    delete env.ENGINE_URL;
    expect(rules(checkFunctionEnv(withGenerated, 'whichpart-api-sbx', env))).toEqual(['override-missing']);
  });
  it('fails production values, S4R endpoints and the wrong stage', () => {
    expect(rules(checkFunctionEnv(withGenerated, 'whichpart-api-sbx', { ...goodApi, RECALL_TABLE: 'whichpart-recalls' }))).toEqual(expect.arrayContaining(['production-ac-identifier', 'override-not-sandbox']));
    expect(rules(checkFunctionEnv(withGenerated, 'whichpart-api-sbx', { ...goodApi, STAGE: 'dev' }))).toEqual(['override-not-sandbox']);
    expect(rules(checkFunctionEnv(withGenerated, 'whichpart-api-sbx', { ...goodApi, OPENAI_BASE_URL: 'https://api.openai.com/v1' }))).toEqual(['override-not-sandbox']);
    expect(rules(checkFunctionEnv(withGenerated, 'whichpart-api-sbx', { ...goodApi, CANONICAL_TOKEN_SECRET_ID: 'spares4repairs/sbx/applianceclinic-canonical-state-token' }))).toEqual(['override-not-sandbox']);
    const pf = { STAGE: 'sbx', SEARCH_API: 'https://65vnizdmk4.execute-api.eu-west-1.amazonaws.com/api/search', PARTS_FOR_MODEL_API: 'https://sbxapi0001.execute-api.eu-west-1.amazonaws.com/api/parts-for-model', LEARNING_BUCKET: `whichpart-learning-sbx-${A}`, MCP_URL: host(URLS.mcp), LM_STUDIO_URL: 'https://example.invalid', EMBED_URL: 'https://example.invalid', OPENAI_BASE_URL: 'https://example.invalid' };
    expect(rules(checkFunctionEnv(withGenerated, 'spares4repairs-part-finder-sbx', pf))).toEqual(expect.arrayContaining(['s4r-identifier', 'override-not-sandbox']));
  });
  it('refuses to check a function that is not a sandbox function', () => {
    expect(rules(checkFunctionEnv(withGenerated, 'whichpart-api', goodApi))).toEqual(['not-a-sandbox-function']);
  });
});

describe('sandbox change sets', () => {
  const change = (Action, PhysicalResourceId, ResourceType, extra = {}) => ({ Type: 'Resource', ResourceChange: { Action, LogicalResourceId: 'R', PhysicalResourceId, ResourceType, ...extra } });
  it('passes an import of a sandbox resource into a sandbox stack', () => {
    expect(checkSandboxChangeSet(lists, { changeSet: { StackName: 'AcDataStack-sbx', Changes: [change('Import', 'whichpart-recalls-sbx', 'AWS::DynamoDB::Table')] } })).toEqual([]);
  });
  it('refuses a valid sandbox name presented under the wrong resource type', () => {
    // whichpart-recalls-sbx is allowlisted, but only as AWS::DynamoDB::Table.
    for (const action of ['Import', 'Modify', 'Remove']) {
      const r = rules(checkSandboxChangeSet(lists, { changeSet: { StackName: 'AcDataStack-sbx', Changes: [change(action, 'whichpart-recalls-sbx', 'AWS::S3::Bucket')] } }));
      expect(r, action).toEqual(['change-target-not-sandbox']);
    }
    // A name that is allowlisted under two types is accepted under each, and under no third.
    expect(checkSandboxChangeSet(lists, { changeSet: { StackName: 'AcRuntimeStack-sbx', Changes: [change('Import', 'spares4repairs-diag-orchestrator-sbx', 'AWS::ECR::Repository')] } })).toEqual([]);
    expect(checkSandboxChangeSet(lists, { changeSet: { StackName: 'AcRuntimeStack-sbx', Changes: [change('Import', 'spares4repairs-diag-orchestrator-sbx', 'AWS::Lambda::Function')] } })).toEqual([]);
    expect(rules(checkSandboxChangeSet(lists, { changeSet: { StackName: 'AcRuntimeStack-sbx', Changes: [change('Import', 'spares4repairs-diag-orchestrator-sbx', 'AWS::IAM::Role')] } }))).toEqual(['change-target-not-sandbox']);
  });

  it('accepts a generated child only under the resource type it was recorded for', () => {
    const host = `${URLS.orchestrator}.lambda-url.eu-west-1.on.aws`;
    expect(checkSandboxChangeSet(withGenerated, { changeSet: { StackName: 'AcRuntimeStack-sbx', Changes: [change('Import', 'sbxapi0001', 'AWS::ApiGatewayV2::Api')] } })).toEqual([]);
    expect(rules(checkSandboxChangeSet(withGenerated, { changeSet: { StackName: 'AcRuntimeStack-sbx', Changes: [change('Import', 'sbxapi0001', 'AWS::Lambda::Function')] } }))).toEqual(['change-target-not-sandbox']);
    // The recorded Function URL host passes as the type it was recorded for, and fails as another.
    expect(checkSandboxChangeSet(withGenerated, { changeSet: { StackName: 'AcRuntimeStack-sbx', Changes: [change('Import', host, 'AWS::Lambda::Url')] } })).toEqual([]);
    expect(rules(checkSandboxChangeSet(withGenerated, { changeSet: { StackName: 'AcRuntimeStack-sbx', Changes: [change('Import', host, 'AWS::Lambda::Permission')] } }))).toEqual(['change-target-not-sandbox']);
  });

  it('checks a removed Lambda URL as the function its physical ID names (5.8)', () => {
    const cs = (id) => rules(checkSandboxChangeSet(lists, { changeSet: { StackName: 'AcRuntimeStack-sbx', Changes: [change('Remove', id, 'AWS::Lambda::Url')] } }));
    expect(cs(`arn:aws:lambda:eu-west-1:${A}:function:spares4repairs-part-finder-sbx`)).toEqual([]);
    expect(cs(`arn:aws:lambda:eu-west-1:${A}:function:spares4repairs-part-finder`)).toContain('change-target-not-sandbox');
    expect(cs(`arn:aws:lambda:eu-west-1:${A}:function:whichpart-api`)).toContain('change-target-not-sandbox');
    expect(cs('arn:aws:lambda:eu-west-1:111111111111:function:spares4repairs-part-finder-sbx')).toContain('change-target-not-sandbox');
  });

  it('checks the name inside an ARN against the exact type', () => {
    const arn = `arn:aws:secretsmanager:eu-west-1:${A}:secret:applianceclinic-sbx/openai-AbC123`;
    expect(checkSandboxChangeSet(lists, { changeSet: { StackName: 'AcDataStack-sbx', Changes: [change('Import', arn, 'AWS::SecretsManager::Secret')] } })).toEqual([]);
    expect(rules(checkSandboxChangeSet(lists, { changeSet: { StackName: 'AcDataStack-sbx', Changes: [change('Import', arn, 'AWS::SSM::Parameter')] } }))).toEqual(['change-target-not-sandbox']);
  });

  it('checks an ARN target by service, account and region, not by its name alone', () => {
    // spares4repairs-error-code-mcp-sbx is allowlisted as both a Lambda and an ECR repository.
    const fnArn = `arn:aws:lambda:eu-west-1:${A}:function:spares4repairs-error-code-mcp-sbx`;
    const repoArn = `arn:aws:ecr:eu-west-1:${A}:repository/spares4repairs-error-code-mcp-sbx`;
    const cs = (target, type) => checkSandboxChangeSet(lists, { changeSet: { StackName: 'AcRuntimeStack-sbx', Changes: [change('Import', target, type)] } });
    expect(cs(fnArn, 'AWS::Lambda::Function')).toEqual([]);
    expect(cs(repoArn, 'AWS::ECR::Repository')).toEqual([]);
    expect(rules(cs(fnArn, 'AWS::ECR::Repository'))).toEqual(['change-target-not-sandbox']);
    expect(rules(cs(repoArn, 'AWS::Lambda::Function'))).toEqual(['change-target-not-sandbox']);
    // Same name, wrong region: never a sandbox target.
    expect(rules(cs(`arn:aws:lambda:us-east-1:${A}:function:spares4repairs-error-code-mcp-sbx`, 'AWS::Lambda::Function'))).toContain('change-target-not-sandbox');
    // Same name, another account: never a sandbox target (and flagged as a foreign ARN).
    expect(rules(cs('arn:aws:lambda:eu-west-1:111111111111:function:spares4repairs-error-code-mcp-sbx', 'AWS::Lambda::Function'))).toEqual(expect.arrayContaining(['change-target-not-sandbox', 'foreign-account-arn']));
    // Global and account-less ARNs still work for their own types.
    expect(cs(`arn:aws:iam::${A}:role/whichpart-api-role-sbx`, 'AWS::IAM::Role')).toEqual([]);
    expect(cs(`arn:aws:s3:::whichpart-learning-sbx-${A}`, 'AWS::S3::Bucket')).toEqual([]);
  });

  it('maps CloudFormation types to ARN services', () => {
    expect(arnServiceForType('AWS::ECR::Repository')).toBe('ecr');
    expect(arnServiceForType('AWS::ApiGatewayV2::Api')).toBe('apigateway');
    expect(arnServiceForType('AWS::Cognito::UserPool')).toBe('cognito-idp');
    expect(arnServiceForType('AWS::SecretsManager::Secret')).toBe('secretsmanager');
    expect(arnServiceForType('nonsense')).toBeNull();
  });

  it('fails a non-sandbox stack', () => {
    expect(rules(checkSandboxChangeSet(lists, { changeSet: { StackName: 'AcDataStack', Changes: [] } }))).toContain('stack-not-sandbox');
    expect(rules(checkSandboxChangeSet(lists, { changeSet: { StackName: 'SparesSite-dev', Changes: [] } }))).toContain('stack-not-sandbox');
  });
  it('fails any action, including Remove and replacement, on a production resource', () => {
    for (const action of ['Import', 'Modify', 'Remove']) {
      const r = rules(checkSandboxChangeSet(lists, { changeSet: { StackName: 'AcDataStack-sbx', Changes: [change(action, 'whichpart-recalls', 'AWS::DynamoDB::Table', { Replacement: 'True' })] } }));
      expect(r, action).toEqual(expect.arrayContaining(['change-target-not-sandbox', 'change-target-denylisted']));
    }
  });
  it('checks an Add by the name declared in the template', () => {
    const template = { Resources: { R: { Type: 'AWS::Lambda::Function', Properties: { FunctionName: 'whichpart-api' } } } };
    const r = rules(checkSandboxChangeSet(lists, { changeSet: { StackName: 'AcRuntimeStack-sbx', Changes: [change('Add', undefined, 'AWS::Lambda::Function')] }, template }));
    expect(r).toEqual(expect.arrayContaining(['change-target-not-sandbox', 'change-target-denylisted', 'production-ac-identifier']));
  });
  it('fails an Add whose target cannot be determined', () => {
    expect(rules(checkSandboxChangeSet(lists, { changeSet: { StackName: 'AcRuntimeStack-sbx', Changes: [change('Add', undefined, 'AWS::Lambda::Function')] } }))).toEqual(['change-target-unknown']);
  });
});
