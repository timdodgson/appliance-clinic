'use strict';
/**
 * AcRuntimeStack-sbx (#34): Phase 5 steps 5.5 to 5.10 rehearsed on -sbx copies. L1 resources only, Retain everywhere.
 *
 * Mirrors production (Phase 0 inventory): three AC roles with their inline policies as separate RolePolicy resources
 * (T2, T4), AWSLambdaBasicExecutionRole declared (T7), four functions, their URLs and permissions, and two rules
 * created DISABLED. The diagnosis copy runs under the stand-in S4R role, which is referenced, never managed (5.10).
 *
 * Values that only exist at run time (stand-in IDs, image digests, code keys, the checked environment) come from
 * the JSON file named by the `runtime` context value, written by infra/sandbox/steps/50-runtime.sh.
 */
const fs = require('node:fs');
const cdk = require('aws-cdk-lib');
const { aws_iam: iam, aws_lambda: lambda, aws_events: events } = cdk;
const { A, R, TAGS, BOUNDARY, retain, shellHandle } = require('./common');

const BASIC = 'arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole';
const LEARN = `arn:aws:s3:::whichpart-learning-sbx-${A}`;
const WEB = `arn:aws:s3:::whichpart-web-sbx-${A}`;
const table = (n) => `arn:aws:dynamodb:${R}:${A}:table/${n}`;
const s3Prefix = (prefix, actions, list) => [
  { Effect: 'Allow', Action: actions, Resource: `${LEARN}/${prefix}/*` },
  { Effect: 'Allow', Action: ['s3:ListBucket'], Resource: LEARN, Condition: { StringLike: { 's3:prefix': list } } },
];
const doc = (Statement) => ({ Version: '2012-10-17', Statement });

/** The production inline policies, with every production ARN mapped to its sandbox copy. */
function inlinePolicies(poolId) {
  return {
    'whichpart-api-role-sbx': {
      'whichpart-acq-benchmark-s3-sbx': doc(s3Prefix('acq', ['s3:GetObject', 's3:PutObject'], ['acq/*'])),
      'whichpart-ai-config-secrets-sbx': doc([{ Effect: 'Allow', Action: ['secretsmanager:GetSecretValue', 'secretsmanager:PutSecretValue', 'secretsmanager:CreateSecret', 'secretsmanager:UpdateSecret'], Resource: `arn:aws:secretsmanager:${R}:${A}:secret:applianceclinic-sbx/*` }]),
      'whichpart-cognito-auth-sbx': doc([{ Effect: 'Allow', Action: ['cognito-idp:AdminInitiateAuth', 'cognito-idp:AdminGetUser'], Resource: `arn:aws:cognito-idp:${R}:${A}:userpool/${poolId}` }]),
      'whichpart-knowledge-admin-s3-sbx': doc(s3Prefix('knowledge-admin', ['s3:GetObject', 's3:PutObject', 's3:DeleteObject'], ['knowledge-admin', 'knowledge-admin/*'])),
      'whichpart-media-admin-s3-sbx': doc([...s3Prefix('media-admin', ['s3:GetObject', 's3:PutObject'], ['media-admin/*']), { Effect: 'Allow', Action: ['s3:PutObject'], Resource: `${WEB}/media/*` }]),
      'whichpart-recalls-dynamodb-sbx': doc([{ Effect: 'Allow', Action: ['dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:DeleteItem', 'dynamodb:Query'], Resource: [table('whichpart-recalls-sbx'), `${table('whichpart-recalls-sbx')}/index/gsi_activity`] }]),
      'whichpart-recalls-s3-sbx': doc([{ Effect: 'Allow', Action: ['s3:PutObject'], Resource: [`${WEB}/recalls/*`, `${WEB}/sitemap-recalls.xml`] }]),
      'whichpart-transcripts-dynamodb-sbx': doc([{ Effect: 'Allow', Action: ['dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:Query'], Resource: [table('whichpart-transcripts-sbx'), `${table('whichpart-transcripts-sbx')}/index/gsi_activity`] }]),
    },
    'error-code-mcp-role-sbx': {
      'error-code-admin-overlay-s3-sbx': doc(s3Prefix('error-code-admin', ['s3:GetObject', 's3:PutObject'], ['error-code-admin', 'error-code-admin/*'])),
    },
    'diag-orchestrator-role-sbx': {},
  };
}

const TRUST = doc([{ Effect: 'Allow', Principal: { Service: 'lambda.amazonaws.com' }, Action: 'sts:AssumeRole' }]);
const STAND_IN_ROLE = `arn:aws:iam::${A}:role/SparesSite-sbx-ServerFunctionRole`;

/** The four functions: production configuration, sandbox names. */
const FUNCTIONS = {
  'whichpart-api-sbx': { role: 'whichpart-api-role-sbx', zip: true, handler: 'index.handler', memory: 512, timeout: 900, arch: 'x86_64', url: { invokeMode: 'BUFFERED' }, urlSid: 'FunctionURLAllowPublicAccess' },
  'spares4repairs-part-finder-sbx': { roleArn: STAND_IN_ROLE, zip: true, handler: 'part-finder-lambda.handler', memory: 256, timeout: 300, arch: 'x86_64', url: { invokeMode: 'RESPONSE_STREAM', cors: { allowHeaders: ['content-type'], allowMethods: ['POST'], allowOrigins: ['*'], maxAge: 86400 } }, urlSid: 'FnUrlPublic' },
  'spares4repairs-diag-orchestrator-sbx': { role: 'diag-orchestrator-role-sbx', image: 'spares4repairs-diag-orchestrator-sbx', memory: 512, timeout: 120, arch: 'arm64', url: { invokeMode: 'BUFFERED', cors: { allowHeaders: ['content-type', 'authorization'], allowMethods: ['POST', 'GET'], allowOrigins: ['*'], maxAge: 300 } }, urlSid: 'FunctionURLAllowPublicAccess' },
  'spares4repairs-error-code-mcp-sbx': { role: 'error-code-mcp-role-sbx', image: 'spares4repairs-error-code-mcp-sbx', memory: 512, timeout: 30, arch: 'arm64', url: { invokeMode: 'BUFFERED', cors: { allowHeaders: ['content-type', 'authorization', 'mcp-session-id', 'mcp-protocol-version', 'accept'], allowMethods: ['POST', 'GET'], allowOrigins: ['*'], maxAge: 300 } }, urlSid: 'FunctionURLAllowPublicAccess' },
};
const RULES = {
  'whichpart-recall-ingest-daily-sbx': { schedule: 'cron(0 6 * * ? *)', targetId: 'whichpart-api-sbx', sid: 'RecallIngestDaily' },
  'whichpart-transcript-review-sbx': { schedule: 'rate(15 minutes)', targetId: 'whichpart-api-review-sbx', input: '{"transcriptReview": true}', sid: 'TranscriptReviewPeriodic' },
};

const logical = (name) => name.replace(/[^A-Za-z0-9]/g, '');
const fnArn = (name) => `arn:aws:lambda:${R}:${A}:function:${name}`;

class RuntimeStack extends cdk.Stack {
  constructor(scope, id, props) {
    super(scope, id, props);
    shellHandle(this);
    const rt = JSON.parse(fs.readFileSync(props.stage, 'utf8'));
    const include = new Set(rt.include || ['roles', 'policies', 'functions', 'urls', 'permissions', 'rules']);

    if (include.has('roles')) {
      for (const role of Object.keys(inlinePolicies(rt.poolId))) {
        retain(new iam.CfnRole(this, logical(role), {
          roleName: role, assumeRolePolicyDocument: TRUST, managedPolicyArns: [BASIC], permissionsBoundary: BOUNDARY, tags: TAGS,
        }));
      }
    }
    if (include.has('policies')) {
      for (const [role, policies] of Object.entries(inlinePolicies(rt.poolId))) {
        for (const [policyName, policyDocument] of Object.entries(policies)) {
          retain(new iam.CfnRolePolicy(this, logical(`${role}-${policyName}`), { roleName: role, policyName, policyDocument }));
        }
      }
    }
    for (const [name, f] of Object.entries(FUNCTIONS)) {
      if (include.has('functions')) {
        const code = f.zip
          ? { s3Bucket: `cdk-acsbx-assets-${A}-${R}`, s3Key: rt.zips[name] }
          : { imageUri: `${A}.dkr.ecr.${R}.amazonaws.com/${f.image}@${rt.images[name]}` };
        retain(new lambda.CfnFunction(this, logical(name), {
          functionName: name,
          role: f.roleArn || `arn:aws:iam::${A}:role/${f.role}`,
          code,
          ...(f.zip ? { runtime: 'nodejs20.x', handler: f.handler, packageType: 'Zip' } : { packageType: 'Image' }),
          architectures: [f.arch],
          memorySize: f.memory,
          timeout: f.timeout,
          ephemeralStorage: { size: 512 },
          tracingConfig: { mode: 'PassThrough' },
          environment: { variables: rt.environment[name] },
          tags: TAGS,
        }));
      }
      const urlOmitted = (rt.omitUrls || []).includes(name);
      if (include.has('urls') && !urlOmitted) {
        retain(new lambda.CfnUrl(this, `${logical(name)}Url`, {
          targetFunctionArn: fnArn(name), authType: 'NONE', invokeMode: f.url.invokeMode, ...(f.url.cors ? { cors: f.url.cors } : {}),
        }));
      }
      if (include.has('permissions')) {
        retain(new lambda.CfnPermission(this, `${logical(name)}${f.urlSid}`, {
          functionName: name, action: 'lambda:InvokeFunctionUrl', principal: '*', functionUrlAuthType: 'NONE',
        }));
        retain(new lambda.CfnPermission(this, `${logical(name)}PublicInvoke`, { functionName: name, action: 'lambda:InvokeFunction', principal: '*' }));
      }
    }
    for (const [name, r] of Object.entries(RULES)) {
      if (include.has('permissions')) {
        retain(new lambda.CfnPermission(this, `whichpartapisbx${r.sid}`, {
          functionName: 'whichpart-api-sbx', action: 'lambda:InvokeFunction', principal: 'events.amazonaws.com', sourceArn: `arn:aws:events:${R}:${A}:rule/${name}`,
        }));
      }
      if (include.has('rules')) {
        retain(new events.CfnRule(this, logical(name), {
          name, scheduleExpression: r.schedule, state: 'DISABLED',
          targets: [{ id: r.targetId, arn: fnArn('whichpart-api-sbx'), ...(r.input ? { input: r.input } : {}) }],
        }));
      }
    }
    this.templateOptions.description = 'AcRuntimeStack-sbx: Phase 4 runtime imports (#34). Sandbox only.';
  }
}

module.exports = { RuntimeStack, FUNCTIONS, RULES, inlinePolicies, STAND_IN_ROLE };
