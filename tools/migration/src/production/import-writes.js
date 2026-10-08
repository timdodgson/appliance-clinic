/**
 * Phase 5 import semantics: an import is not read-only. After IMPORT_COMPLETE, CloudFormation runs each imported
 * resource's update handler ("Apply stack-level tags to imported resource if applicable"), with the execution role's
 * permissions (Phase 5 finding, step 5.1). This module holds:
 *
 *   - the expected-write manifest, docs/migration/phase-5-import-writes.json: per CloudFormation type, the write actions
 *     that post-import update makes when the template matches live exactly, the properties that must be declared, and
 *     the actions that must never appear
 *   - the probe role policy for the sandbox rehearsal (infra/sandbox/probe): read-only on sandbox resources, plus only
 *     the write actions under test
 *   - the production execution policy for one step: read-only on AC resources plus only the manifest's writes, on only
 *     that step's resources
 *   - the comparison of CloudTrail write events against the manifest
 *
 * Pure: no AWS calls.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from '../util/files.js';

const A = '800960611664';
const R = 'eu-west-1';
export const MANIFEST_PATH = join(REPO_ROOT, 'docs', 'migration', 'phase-5-import-writes.json');
export const loadManifest = () => JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'));
/** Production name to sandbox name, shared with the CDK app's sandbox profile. */
export const SANDBOX_NAMES = JSON.parse(readFileSync(join(REPO_ROOT, 'infra', 'cdk', 'lib', 'sandbox-names.json'), 'utf8'));


/** Reads with no resource-level authorisation. */
const ACCOUNT_READS = [
  'lambda:ListFunctions', 'lambda:GetAccountSettings', 'dynamodb:ListTables', 's3:ListAllMyBuckets', 'secretsmanager:ListSecrets',
  'ecr:DescribeRegistry', 'events:ListRules', 'iam:ListRoles', 'tag:GetResources',
];

/** Sandbox resource patterns by IAM service prefix, the same scope as the Phase 4 sandbox controls. */
export const SANDBOX_SCOPE = {
  lambda: [`arn:aws:lambda:${R}:${A}:function:*-sbx`, `arn:aws:lambda:${R}:${A}:function:*-sbx:*`],
  iam: [`arn:aws:iam::${A}:role/*-sbx`, `arn:aws:iam::${A}:role/SparesSite-sbx-*`],
  dynamodb: [`arn:aws:dynamodb:${R}:${A}:table/whichpart-*-sbx`, `arn:aws:dynamodb:${R}:${A}:table/whichpart-*-sbx/*`],
  s3: [`arn:aws:s3:::*-sbx-${A}`],
  secretsmanager: [`arn:aws:secretsmanager:${R}:${A}:secret:applianceclinic-sbx/*`],
  ecr: [`arn:aws:ecr:${R}:${A}:repository/*-sbx`],
  events: [`arn:aws:events:${R}:${A}:rule/*-sbx`],
};

/** The read actions a resource read handler needs, per service. Never object reads, never secret values. */
export const READS = {
  lambda: ['lambda:Get*', 'lambda:List*'],
  iam: ['iam:Get*', 'iam:List*'],
  dynamodb: ['dynamodb:Describe*', 'dynamodb:List*', 'dynamodb:GetResourcePolicy'],
  s3: ['s3:GetBucket*', 's3:GetEncryptionConfiguration', 's3:GetLifecycleConfiguration', 's3:GetReplicationConfiguration', 's3:GetAccelerateConfiguration',
    's3:GetAnalyticsConfiguration', 's3:GetIntelligentTieringConfiguration', 's3:GetInventoryConfiguration', 's3:GetMetricsConfiguration'],
  secretsmanager: ['secretsmanager:DescribeSecret', 'secretsmanager:GetResourcePolicy', 'secretsmanager:ListSecretVersionIds'],
  ecr: ['ecr:DescribeRepositories', 'ecr:DescribeImages', 'ecr:GetLifecyclePolicy', 'ecr:GetRepositoryPolicy', 'ecr:ListTagsForResource', 'ecr:DescribeImageScanFindings', 'ecr:BatchGetImage', 'ecr:GetDownloadUrlForLayer'],
  events: ['events:DescribeRule', 'events:ListTargetsByRule', 'events:ListTagsForResource'],
};

/** Replace every production name in a JSON document by its sandbox name: one pass, whole names only. */
export function toSandbox(value, names = SANDBOX_NAMES) {
  const escape = (x) => x.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
  const alternatives = Object.keys(names).sort((a, b) => b.length - a.length).map(escape).join('|');
  const re = new RegExp(`(?<![A-Za-z0-9-])(${alternatives})(?![A-Za-z0-9-])`, 'g');
  // A secret ARN ends in "-" and six random characters: map the name before them.
  const secret = new RegExp(`(:secret:)(${alternatives})(-[A-Za-z0-9]{6})(?![A-Za-z0-9-])`, 'g');
  const text = JSON.stringify(value).replace(secret, (_, p, n, s) => `${p}${names[n]}${s}`);
  return JSON.parse(text.replace(re, (m) => names[m]));
}

const service = (action) => action.split(':')[0];
const doc = (Statement) => ({ Version: '2012-10-17', Statement });
const sid = (s) => s.replace(/[^A-Za-z0-9]/g, '');

/** Policy statements: reads per service on a scope, plus the given write actions on the same scope. */
function statements(scope, writes) {
  const out = [{ Sid: 'AccountReads', Effect: 'Allow', Action: ACCOUNT_READS, Resource: '*' }];
  for (const [svc, actions] of Object.entries(READS)) {
    if (scope[svc]?.length) out.push({ Sid: `Read${sid(svc)}`, Effect: 'Allow', Action: actions, Resource: scope[svc] });
  }
  const bySvc = {};
  for (const w of writes) (bySvc[service(w)] ||= []).push(w);
  for (const [svc, actions] of Object.entries(bySvc)) {
    if (!scope[svc]?.length) throw new Error(`no scope for writes on ${svc}`);
    out.push({ Sid: `Write${sid(svc)}`, Effect: 'Allow', Action: [...new Set(actions)].sort(), Resource: scope[svc] });
  }
  return out;
}

/** The sandbox probe role's inline policy: read-only, plus exactly `writes` (bounded by ac-cfn-execution-sbx). */
export function probePolicy(writes = []) {
  for (const w of writes) if (!/^[a-z0-9-]+:[A-Za-z]+$/.test(w)) throw new Error(`write action ${w} must be one exact action`);
  return doc(statements(SANDBOX_SCOPE, writes));
}

/** Production resources and their CloudFormation types, by step (PLAN.md order). */
export const PRODUCTION_STEPS = {
  '5.1': { 'AWS::ECR::Repository': ['spares4repairs-error-code-mcp'] },
  '5.2': { 'AWS::ECR::Repository': ['spares4repairs-diag-orchestrator'], 'AWS::SecretsManager::Secret': 'secrets' },
  '5.3a': { 'AWS::DynamoDB::Table': ['whichpart-recalls'] },
  '5.3b': { 'AWS::DynamoDB::Table': ['whichpart-transcripts'] },
  '5.4': { 'AWS::S3::Bucket': [`whichpart-web-${A}`, `whichpart-learning-${A}`], 'AWS::S3::BucketPolicy': [`whichpart-web-${A}`] },
};

/** The IAM action that authorises a CloudTrail action (s3:TagResource is authorised by s3:PutBucketTagging). */
const iamAction = (manifest, types, action) => {
  for (const t of types) { const alias = manifest.types[t]?.cloudTrailActions?.[action]; if (alias) return alias; }
  return action;
};

/**
 * CloudTrail write events (infra/sandbox/probe/cloudtrail.sh: {action, resource, errorCode, request}) against the
 * manifest's types. Every write must be an expected action of one of the types; a forbidden action, a forbidden request
 * parameter (a secret value in UpdateSecret), or a denied call is a failure.
 */
export function checkWrites(events, manifest, types) {
  const allowed = new Set(types.flatMap((t) => manifest.types[t]?.expectedWrites || []));
  const forbidden = new Set(types.flatMap((t) => manifest.types[t]?.forbiddenWrites || []));
  const failures = [];
  for (const e of events) {
    const action = iamAction(manifest, types, e.action);
    const where = { action: e.action, resource: e.resource || null };
    if (forbidden.has(action)) failures.push({ rule: 'forbidden-write', ...where });
    else if (!allowed.has(action)) failures.push({ rule: 'unexpected-write', ...where });
    if (e.errorCode) failures.push({ rule: 'write-refused', ...where, errorCode: e.errorCode });
    for (const t of types) {
      for (const param of manifest.types[t]?.forbiddenParams?.[action] || []) {
        if ((e.request || []).includes(param)) failures.push({ rule: 'forbidden-parameter', ...where, param });
      }
    }
  }
  return failures;
}

/** The ARN a step file's import entry names, for scoping that type's writes. */
export function importArn(entry) {
  const id = entry.ResourceIdentifier;
  switch (entry.ResourceType) {
    case 'AWS::ECR::Repository': return `arn:aws:ecr:${R}:${A}:repository/${id.RepositoryName}`;
    case 'AWS::SecretsManager::Secret': return id.Id;
    case 'AWS::DynamoDB::Table': return `arn:aws:dynamodb:${R}:${A}:table/${id.TableName}`;
    case 'AWS::S3::Bucket': return `arn:aws:s3:::${id.BucketName}`;
    case 'AWS::S3::BucketPolicy': return `arn:aws:s3:::${id.Bucket}`;
    case 'AWS::IAM::Role': return `arn:aws:iam::${A}:role/${id.RoleName}`;
    case 'AWS::IAM::RolePolicy': return `arn:aws:iam::${A}:role/${id.RoleName}`;
    case 'AWS::Lambda::Function': return `arn:aws:lambda:${R}:${A}:function:${id.FunctionName}`;
    case 'AWS::Lambda::Url': return id.FunctionArn;
    case 'AWS::Lambda::Permission': return id.FunctionName.startsWith('arn:') ? id.FunctionName : `arn:aws:lambda:${R}:${A}:function:${id.FunctionName}`;
    case 'AWS::Events::Rule': return id.Arn;
    default: throw new Error(`no ARN for ${entry.ResourceType}`);
  }
}

/** The write statements for one step: each type's expected writes, on exactly that step's resources of the type. */
export function stepWriteStatements(stepDoc, manifest) {
  const byAction = {};
  for (const entry of stepDoc.import) {
    const writes = manifest.types[entry.ResourceType]?.expectedWrites;
    if (!writes) throw new Error(`no manifest entry for ${entry.ResourceType}`);
    for (const w of writes) (byAction[w] ||= new Set()).add(importArn(entry));
  }
  const byResources = {};
  for (const [action, arns] of Object.entries(byAction)) (byResources[[...arns].sort().join(' ')] ||= []).push(action);
  return Object.entries(byResources).map(([arns, actions], i) => ({
    Sid: `Step${stepDoc.step.replace(/[^A-Za-z0-9]/g, '')}Writes${i + 1}`, Effect: 'Allow', Action: actions.sort(), Resource: arns.split(' '),
  }));
}

/** The Phase 6 proof's write statement: the manifest's grant, on exactly its one resource. */
export function proofWriteStatements(proof) {
  if (!proof?.resource?.arn || !Array.isArray(proof.grant) || !proof.grant.length) throw new Error('proof manifest needs resource.arn and grant');
  return [{ Sid: 'Phase6ProofWrites', Effect: 'Allow', Action: [...proof.grant].sort(), Resource: [proof.resource.arn] }];
}
