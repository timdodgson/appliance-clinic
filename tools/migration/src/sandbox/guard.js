/**
 * Phase 4 sandbox guard (#34, runbook phase-4-sandbox-rehearsal.md).
 *
 * The sandbox lives in the production account, so every sandbox action must pass all of:
 *   - caller:   account 800960611664, region eu-west-1, the sandbox operator or an acsbx toolkit role
 *   - target:   on the sandbox allowlist, or an AWS-generated child of an allowlisted resource
 *   - denylist: not a production AC identifier (ac-production-denylist.json), not an S4R identifier
 *               (s4r-denylist.json)
 * Documents (templates, change sets, Lambda environments) are scanned for production AC identifiers by
 * token boundary, for S4R identifiers by substring, and for account ARNs that are not sandbox resources.
 *
 * Pure functions, no AWS calls. Every check returns a list of failures; an empty list means pass.
 */
import { join } from 'node:path';
import { findExactHits, scanDocument } from '../denylist/match.js';
import { readJson, REPO_ROOT } from '../util/files.js';

export const SANDBOX_ACCOUNT = '800960611664';
export const SANDBOX_REGION = 'eu-west-1';
export const SANDBOX_STAGE = 'sbx';
export const OPERATOR_ROLE = 'ac-operator-sbx';
const TOOLKIT_ROLE = /^cdk-acsbx-[a-z-]+-role-800960611664-eu-west-1$/;
const INVALID_HOST = 'example.invalid';

/** AWS-generated identifiers accepted only as children of an allowlisted parent of the given type. */
export const GENERATED_PARENT_TYPES = {
  'AWS::Lambda::Url': ['AWS::Lambda::Function'],
  'AWS::Lambda::Permission': ['AWS::Lambda::Function'],
  'AWS::ApiGatewayV2::ApiId': ['AWS::ApiGatewayV2::Api'],
  'AWS::Cognito::UserPoolId': ['AWS::Cognito::UserPool'],
  'AWS::Cognito::UserPoolClientId': ['AWS::Cognito::UserPoolClient'],
  'AWS::SecretsManager::SecretArn': ['AWS::SecretsManager::Secret'],
  'AWS::DynamoDB::Backup': ['AWS::DynamoDB::Table'],
  'AWS::ECR::Image': ['AWS::ECR::Repository'],
  'AWS::S3::Object': ['AWS::S3::Bucket'],
};

/** The CloudFormation resource type each kind of generated identifier is the physical ID of. */
const GENERATED_CFN_TYPES = {
  'AWS::Lambda::Url': 'AWS::Lambda::Url',
  'AWS::Lambda::Permission': 'AWS::Lambda::Permission',
  'AWS::ApiGatewayV2::ApiId': 'AWS::ApiGatewayV2::Api',
  'AWS::Cognito::UserPoolId': 'AWS::Cognito::UserPool',
  'AWS::Cognito::UserPoolClientId': 'AWS::Cognito::UserPoolClient',
  'AWS::SecretsManager::SecretArn': 'AWS::SecretsManager::Secret',
};

/**
 * Environment variables each sandbox function must set. The runtime code falls back to production
 * defaults when they are unset (runbook section 4). `kind` says what a valid sandbox value is.
 */
export const REQUIRED_OVERRIDES = {
  'whichpart-api-sbx': {
    STAGE: 'stage', ORCHESTRATOR_URL: 'url', ENGINE_URL: 'url', LEARNING_BUCKET: 'bucket', WHICHPART_WEB_BUCKET: 'bucket',
    RECALL_TABLE: 'table', TRANSCRIPT_TABLE: 'table', S4R_PRODUCT_BASE_URL: 'url', COGNITO_USER_POOL_ID: 'generated',
    COGNITO_CLIENT_ID: 'generated', CANONICAL_TOKEN_SECRET_ID: 'secret', BENCHMARK_SERVICE_SECRET_ID: 'secret',
    OPENAI_BASE_URL: 'url', LM_STUDIO_URL: 'url',
  },
  'spares4repairs-part-finder-sbx': {
    STAGE: 'stage', SEARCH_API: 'url', PARTS_FOR_MODEL_API: 'url', LEARNING_BUCKET: 'bucket', MCP_URL: 'url',
    LM_STUDIO_URL: 'url', EMBED_URL: 'url', OPENAI_BASE_URL: 'url',
  },
  'spares4repairs-diag-orchestrator-sbx': { STAGE: 'stage', MCP_URL: 'url', RAG_URL: 'url' },
  'spares4repairs-error-code-mcp-sbx': { STAGE: 'stage', LEARNING_BUCKET: 'bucket' },
};

export function loadSandboxLists(root = REPO_ROOT) {
  const dir = join(root, 'docs', 'migration');
  return buildLists({
    allowlist: readJson(join(dir, 'sandbox-allowlist.json')),
    acDenylist: readJson(join(dir, 'ac-production-denylist.json')).entries,
    s4rDenylist: readJson(join(dir, 's4r-denylist.json')).entries,
  });
}

/** @param {{allowlist: object, acDenylist: Array, s4rDenylist: Array, generated?: Array}} input */
export function buildLists({ allowlist, acDenylist, s4rDenylist, generated = [] }) {
  const names = new Map();
  for (const [type, list] of Object.entries(allowlist.names || {})) {
    const t = type.replace(/\(.*\)$/, '');
    for (const n of list) names.set(n, new Set([...(names.get(n) || []), t]));
  }
  const lists = { allowlist, names, acDenylist, s4rDenylist, generated: [] };
  for (const g of generated) {
    const failures = checkGenerated(lists, g);
    if (failures.length) throw new Error(`Generated identifier ${g.id} rejected: ${failures.map((f) => f.rule).join(', ')}`);
    lists.generated.push(g);
  }
  return lists;
}

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const tokenRe = (value) => new RegExp(`(?<![A-Za-z0-9_-])${escape(value)}(?![A-Za-z0-9_-])`);

/** Exact match against the production AC denylist. `whichpart-api` does not match `whichpart-api-sbx`. */
export function acProductionHits(acDenylist, value) {
  if (typeof value !== 'string' || !value) return [];
  return acDenylist.filter((e) => {
    if (e.kind === 'rolePolicy') return value === e.value;
    return findExactHits([e], value).length > 0;
  });
}

/** Token-boundary scan of a whole document for production AC identifiers. */
export function acProductionScan(acDenylist, document) {
  const text = typeof document === 'string' ? document : JSON.stringify(document);
  return acDenylist.filter((e) => (e.kind === 'arnPrefix' ? text.includes(e.value) : tokenRe(e.value).test(text)));
}

const deniedBy = (lists, value) => [
  ...acProductionHits(lists.acDenylist, value).map((e) => ({ list: 'ac-production', value: e.value })),
  ...findExactHits(lists.s4rDenylist, value).map((e) => ({ list: 's4r', value: e.value })),
];

export function checkCaller({ account, region, arn }, { bootstrap = false } = {}) {
  const failures = [];
  if (account !== SANDBOX_ACCOUNT) failures.push({ rule: 'wrong-account', account });
  if (region !== SANDBOX_REGION) failures.push({ rule: 'wrong-region', region });
  const role = /:assumed-role\/([^/]+)\//.exec(arn || '')?.[1] || /:role\/([^/]+)$/.exec(arn || '')?.[1] || null;
  const sandboxCaller = role === OPERATOR_ROLE || TOOLKIT_ROLE.test(role || '');
  if (!sandboxCaller && !bootstrap) failures.push({ rule: 'not-a-sandbox-caller', arn });
  return failures;
}

function checkGenerated(lists, { type, id, parent }) {
  const failures = [];
  const parentTypes = GENERATED_PARENT_TYPES[type];
  if (!parentTypes) return [{ rule: 'not-a-generated-type', type, id }];
  if (!parent || !parentTypes.some((t) => hasType(lists, parent, t))) failures.push({ rule: 'parent-not-allowlisted', type, id, parent: parent || null });
  for (const d of deniedBy(lists, id)) failures.push({ rule: 'denylisted', type, id, ...d });
  for (const e of acProductionScan(lists.acDenylist, id)) failures.push({ rule: 'denylisted', type, id, list: 'ac-production', value: e.value });
  return failures;
}

/**
 * A resource the sandbox may mutate. Declared names must be allowlisted under their exact type
 * (inline policies as `<role>/<policy>`); generated identifiers must name an allowlisted parent.
 */
export function checkTarget(lists, { type, id, parent }) {
  if (GENERATED_PARENT_TYPES[type]) {
    const failures = checkGenerated(lists, { type, id, parent });
    if (!failures.length && !lists.generated.some((g) => g.type === type && g.id === id)) failures.push({ rule: 'generated-id-not-recorded', type, id });
    return failures;
  }
  const failures = deniedBy(lists, id).map((d) => ({ rule: 'denylisted', type, id, ...d }));
  if (!hasType(lists, id, type)) failures.push({ rule: 'not-allowlisted', type, id });
  return failures;
}

const hasType = (lists, name, type) => Boolean(lists.names.get(name)?.has(type));
const isGeneratedFor = (lists, id, cfnType) => lists.generated.some((g) => g.id === id && GENERATED_CFN_TYPES[g.type] === cfnType);

/**
 * Whether a change-set target is a sandbox resource of exactly this CloudFormation type: allowlisted
 * under that type (by name, or by the name inside its ARN), or a recorded generated child of that type.
 * A sandbox name presented under another type is refused, as in checkTarget().
 */
export function isSandboxTargetOfType(lists, cfnType, target) {
  if (!cfnType || !target) return false;
  if (String(target).startsWith('arn:')) {
    // An ARN must be of the type's own service, in the sandbox account and region, before the name
    // inside it is checked. A name allowlisted under two types (a Lambda and an ECR repository) must
    // not let a Lambda ARN pass as a repository.
    const r = arnResourceName(target);
    if (!r || r.awsManaged || !r.name) return false;
    if (r.service !== arnServiceForType(cfnType)) return false;
    if (r.account && r.account !== SANDBOX_ACCOUNT) return false;
    if (r.region && r.region !== SANDBOX_REGION) return false;
    return hasType(lists, r.name, cfnType) || isGeneratedFor(lists, r.name, cfnType);
  }
  return hasType(lists, target, cfnType) || isGeneratedFor(lists, target, cfnType);
}

// ARN service namespaces that are not simply the lower-cased CloudFormation namespace.
const ARN_SERVICE_OF_NAMESPACE = { ApiGatewayV2: 'apigateway', Cognito: 'cognito-idp' };

/** The ARN service of a CloudFormation resource type, e.g. AWS::ECR::Repository -> ecr. */
export function arnServiceForType(cfnType) {
  const ns = /^AWS::([A-Za-z0-9]+)::/.exec(cfnType || '')?.[1];
  return ns ? (ARN_SERVICE_OF_NAMESPACE[ns] || ns.toLowerCase()) : null;
}
const isGeneratedId = (lists, value) => lists.generated.some((g) => g.id === value);
const isAllowlistedName = (lists, value) => lists.names.has(value);

/** The resource name an ARN refers to, for checking against the allowlist. */
export function arnResourceName(arn) {
  const m = /^arn:aws:([a-z0-9-]+):([a-z0-9-]*):(\d{12}|aws|):(.*)$/.exec(arn);
  if (!m) return null;
  const [, service, region, account, resource] = m;
  if (account === 'aws') return { service, region, account, name: null, awsManaged: true };
  let name;
  if (service === 's3') name = resource.split('/')[0];
  else if (service === 'logs') name = resource.replace(/^log-group:/, '').replace(/:.*$/, '');
  else if (service === 'lambda') name = resource.replace(/^function:/, '').split(':')[0];
  else if (service === 'secretsmanager') name = resource.replace(/^secret:/, '').replace(/-[A-Za-z0-9]{6}$/, '');
  else if (service === 'ssm') name = resource.replace(/^parameter/, '');
  else if (service === 'cloudformation') name = resource.replace(/^stack\//, '').split('/')[0];
  else if (service === 'execute-api') name = resource.split('/')[0];
  else if (service === 'cognito-idp') name = resource.replace(/^userpool\//, '');
  else name = resource.replace(/^[a-z-]+[/:]/, '').split('/')[0];
  return { service, region, account, name, awsManaged: false };
}

const ARN_RE = /arn:aws:[a-z0-9-]+:[a-z0-9-]*:(?:\d{12}|aws)?:[A-Za-z0-9_./:@+=,*-]+/g;

/**
 * Scan any document (template, change set, environment) for:
 *   - production AC identifiers (token boundary)
 *   - S4R identifiers (substring, as the existing checker does)
 *   - ARNs in this account, or S3 ARNs, that do not name a sandbox resource
 */
export function checkDocument(lists, document) {
  const failures = [];
  const text = typeof document === 'string' ? document : JSON.stringify(document);
  for (const e of acProductionScan(lists.acDenylist, text)) failures.push({ rule: 'production-ac-identifier', value: e.value });
  for (const e of scanDocument(lists.s4rDenylist, text)) failures.push({ rule: 's4r-identifier', value: e.value });
  // Commas are valid inside IAM names, so a comma-separated list of ARNs matches as one string: split it.
  const arns = new Set((text.match(ARN_RE) || []).flatMap((m) => m.split(/,(?=arn:)/)));
  for (const arn of arns) {
    const r = arnResourceName(arn);
    if (!r || r.awsManaged) continue;
    if (r.account && r.account !== SANDBOX_ACCOUNT) { failures.push({ rule: 'foreign-account-arn', arn }); continue; }
    if (!(isAllowlistedName(lists, r.name) || isGeneratedId(lists, r.name))) failures.push({ rule: 'arn-not-sandbox', arn, name: r.name });
  }
  return failures;
}

/**
 * The environment of a sandbox function, checked before its first invocation: every required override
 * is set to a sandbox value, and nothing names a production AC or S4R resource.
 */
export function checkFunctionEnv(lists, functionName, env = {}) {
  const required = REQUIRED_OVERRIDES[functionName];
  if (!required) return [{ rule: 'not-a-sandbox-function', functionName }];
  const failures = checkDocument(lists, env).map((f) => ({ ...f, functionName }));
  const generatedHosts = new Set(lists.generated.filter((g) => g.type === 'AWS::Lambda::Url' || g.type === 'AWS::ApiGatewayV2::ApiId').map((g) => g.id));
  for (const [key, kind] of Object.entries(required)) {
    const value = env[key];
    const bad = (why) => failures.push({ rule: 'override-not-sandbox', functionName, key, why });
    if (value === undefined || value === '') { failures.push({ rule: 'override-missing', functionName, key }); continue; }
    if (kind === 'stage' && value !== SANDBOX_STAGE) bad(`STAGE must be ${SANDBOX_STAGE}`);
    if (kind === 'bucket' && !hasType(lists, value, 'AWS::S3::Bucket')) bad('not an allowlisted bucket');
    if (kind === 'table' && !hasType(lists, value, 'AWS::DynamoDB::Table')) bad('not an allowlisted table');
    if (kind === 'secret' && !hasType(lists, value, 'AWS::SecretsManager::Secret')) bad('not an allowlisted secret');
    if (kind === 'generated' && !isGeneratedId(lists, value)) bad('not a recorded sandbox identifier');
    if (kind === 'url') {
      let host = null;
      try { host = new URL(value).hostname; } catch { bad('not a URL'); continue; }
      const sandboxHost = host === INVALID_HOST || [...generatedHosts].some((h) => host === h || host.startsWith(`${h}.`));
      if (!sandboxHost) bad(`host ${host} is not a sandbox host`);
    }
  }
  return failures;
}

/** Physical names declared in template resource properties. */
const NAME_PROPERTIES = ['FunctionName', 'RoleName', 'TableName', 'BucketName', 'RepositoryName', 'Name', 'PolicyName', 'ManagedPolicyName', 'LogGroupName', 'UserPoolName', 'ClientName'];
/** Types whose physical ID is another resource's name (a bucket policy's ID is its bucket). */
const TARGET_PROPERTY = { 'AWS::S3::BucketPolicy': 'Bucket' };

/**
 * Resolve a template value to a string, offline: literals, Ref (parameters, pseudo parameters, and other
 * resources' declared names), Fn::Sub, Fn::Join and Fn::If with the template's conditions. Anything else, or
 * any unresolved reference, gives null, and the change fails as change-target-unknown.
 */
export function resolveTemplateValue(value, ctx, depth = 0) {
  if (depth > 20) return null;
  const next = (v) => resolveTemplateValue(v, ctx, depth + 1);
  if (typeof value === 'string') return value;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  if ('Ref' in value) return ref(value.Ref, ctx, depth);
  if ('Fn::Sub' in value) {
    const [text, vars = {}] = Array.isArray(value['Fn::Sub']) ? value['Fn::Sub'] : [value['Fn::Sub']];
    if (typeof text !== 'string') return null;
    let ok = true;
    const out = text.replace(/\$\{([^}!]+)\}/g, (_, name) => {
      const v = name in vars ? next(vars[name]) : ref(name, ctx, depth);
      if (v === null) ok = false;
      return v ?? '';
    });
    return ok ? out : null;
  }
  if ('Fn::Join' in value) {
    const [sep, parts] = value['Fn::Join'];
    const resolved = (parts || []).map(next);
    return resolved.some((p) => p === null) ? null : resolved.join(sep);
  }
  if ('Fn::If' in value) {
    const [cond, a, b] = value['Fn::If'];
    const c = condition(cond, ctx, depth);
    return c === null ? null : next(c ? a : b);
  }
  return null;
}

function ref(name, ctx, depth) {
  const pseudo = { 'AWS::AccountId': SANDBOX_ACCOUNT, 'AWS::Region': SANDBOX_REGION, 'AWS::Partition': 'aws', 'AWS::URLSuffix': 'amazonaws.com', 'AWS::StackName': ctx.stackName };
  if (name in pseudo) return pseudo[name] ?? null;
  if (name in ctx.parameters) return ctx.parameters[name];
  const r = ctx.resources[name];
  return r ? declaredName(r, ctx, depth + 1) : null;
}

function condition(name, ctx, depth) {
  const def = ctx.conditions[name];
  return def === undefined ? null : evalCondition(def, ctx, depth + 1);
}

function evalCondition(c, ctx, depth) {
  if (depth > 20 || !c || typeof c !== 'object') return null;
  if ('Condition' in c) return condition(c.Condition, ctx, depth);
  if ('Fn::Equals' in c) {
    const [a, b] = c['Fn::Equals'].map((v) => resolveTemplateValue(v, ctx, depth + 1));
    return a === null || b === null ? null : a === b;
  }
  if ('Fn::Not' in c) { const v = evalCondition(c['Fn::Not'][0], ctx, depth + 1); return v === null ? null : !v; }
  if ('Fn::And' in c || 'Fn::Or' in c) {
    const vals = (c['Fn::And'] || c['Fn::Or']).map((x) => evalCondition(x, ctx, depth + 1));
    if (vals.some((v) => v === null)) return null;
    return 'Fn::And' in c ? vals.every(Boolean) : vals.some(Boolean);
  }
  return null;
}

function declaredName(resource, ctx, depth = 0) {
  const props = resource?.Properties || {};
  // An inline policy is allowlisted as <role>/<policy>.
  if (resource?.Type === 'AWS::IAM::RolePolicy') {
    const role = resolveTemplateValue(props.RoleName, ctx, depth);
    const policy = resolveTemplateValue(props.PolicyName, ctx, depth);
    return role && policy ? `${role}/${policy}` : null;
  }
  const key = TARGET_PROPERTY[resource?.Type] || NAME_PROPERTIES.find((p) => props[p] !== undefined);
  return key ? resolveTemplateValue(props[key], ctx, depth) : null;
}

/**
 * A physical ID in the allowlist's form. CloudFormation identifies an AWS::IAM::RolePolicy as "policy|role"
 * (seen when one is removed, T5); the allowlist names it "role/policy".
 */
export function normalisePhysicalId(type, id) {
  if (!id) return id;
  if (type === 'AWS::IAM::RolePolicy' && /^[^|/]+\|[^|/]+$/.test(id)) { const [policy, role] = id.split('|'); return `${role}/${policy}`; }
  return id;
}

/** Types whose physical ID is generated by CloudFormation, so the declared name identifies them. */
const IDENTIFIED_BY_DECLARED_NAME = new Set(['AWS::IAM::Policy', 'AWS::IAM::RolePolicy']);

/** Child types, the property naming their parent, and the parent's type. */
export const CHILD_PARENT = {
  'AWS::ApiGatewayV2::Integration': ['ApiId', 'AWS::ApiGatewayV2::Api'],
  'AWS::ApiGatewayV2::Route': ['ApiId', 'AWS::ApiGatewayV2::Api'],
  'AWS::ApiGatewayV2::Stage': ['ApiId', 'AWS::ApiGatewayV2::Api'],
  'AWS::Lambda::Permission': ['FunctionName', 'AWS::Lambda::Function'],
  'AWS::Lambda::Url': ['TargetFunctionArn', 'AWS::Lambda::Function'],
};

/**
 * The parent a child resource belongs to: a Ref or Fn::GetAtt to a resource in the same template (whose
 * declared name and type are used), or a literal name or Lambda ARN.
 */
function parentOf(resource, ctx) {
  const [prop, parentType] = CHILD_PARENT[resource.Type];
  const v = resource.Properties?.[prop];
  const logicalId = v && typeof v === 'object' ? (v.Ref ?? (Array.isArray(v['Fn::GetAtt']) ? v['Fn::GetAtt'][0] : null)) : null;
  if (logicalId) {
    const r = ctx.resources[logicalId];
    return r ? { name: declaredName(r, ctx), type: r.Type } : { name: null, type: parentType };
  }
  const literal = resolveTemplateValue(v, ctx);
  if (!literal) return { name: null, type: parentType };
  return { name: literal.startsWith('arn:') ? arnResourceName(literal)?.name || null : literal, type: parentType };
}

/** Context for resolving a template's declared names: change-set parameters over template defaults. */
export function templateContext(template, changeSet = {}) {
  const parameters = {};
  for (const [k, p] of Object.entries(template?.Parameters || {})) if (p.Default !== undefined) parameters[k] = String(p.Default);
  for (const p of changeSet.Parameters || []) parameters[p.ParameterKey] = p.ParameterValue;
  return { parameters, resources: template?.Resources || {}, conditions: template?.Conditions || {}, stackName: changeSet.StackName || null };
}

/**
 * Sandbox mode of the change-set checker. Every change, whatever its action, must target a sandbox
 * resource; Remove and replacement are allowed only on allowlisted resources.
 */
export function checkSandboxChangeSet(lists, { changeSet, template = null }) {
  const failures = [];
  if (!hasType(lists, changeSet.StackName, 'AWS::CloudFormation::Stack')) {
    failures.push({ rule: 'stack-not-sandbox', stack: changeSet.StackName || null });
  }
  // A change set's own IDs name the operation, not a resource (its stack is checked by StackName above), and
  // their ARNs (changeSet/<name>/<uuid>) carry no resource name. Every other ARN in it is still checked.
  const { ChangeSetId, ParentChangeSetId, RootChangeSetId, ...scanned } = changeSet; // eslint-disable-line no-unused-vars
  for (const f of checkDocument(lists, scanned)) failures.push(f);
  const changes = (changeSet.Changes || []).filter((c) => c.Type === 'Resource').map((c) => c.ResourceChange);
  const resources = template?.Resources || {};
  const ctx = templateContext(template, changeSet);
  for (const rc of changes) {
    const id = { logicalId: rc.LogicalResourceId, physicalId: rc.PhysicalResourceId || null, type: rc.ResourceType, action: rc.Action };
    const resource = resources[rc.LogicalResourceId];
    // A child resource (route, integration, stage, Lambda permission or URL) has no name of its own and an
    // AWS-generated physical ID: it is checked as its parent, declared in the same template.
    const parent = CHILD_PARENT[rc.ResourceType] && resource ? parentOf(resource, ctx) : null;
    if (parent) {
      // An existing child's physical ID must still not be a denylisted identifier (for example 65vnizdmk4's routes).
      for (const d of rc.PhysicalResourceId ? deniedBy(lists, rc.PhysicalResourceId) : []) failures.push({ rule: 'change-target-denylisted', ...id, target: rc.PhysicalResourceId, ...d });
      if (!parent.name || !isSandboxTargetOfType(lists, parent.type, parent.name)) failures.push({ rule: 'change-target-not-sandbox', ...id, target: parent.name, parentType: parent.type });
      for (const d of parent.name ? deniedBy(lists, parent.name) : []) failures.push({ rule: 'change-target-denylisted', ...id, target: parent.name, ...d });
      continue;
    }
    const declared = resource ? declaredName(resource, ctx) : null;
    // AWS::IAM::Policy gets a generated physical ID (for example Appli-FileP-XBMrIGiXiQ03): use its declared name.
    const target = (IDENTIFIED_BY_DECLARED_NAME.has(rc.ResourceType) && declared) || normalisePhysicalId(rc.ResourceType, rc.PhysicalResourceId) || declared;
    if (!target) { failures.push({ rule: 'change-target-unknown', ...id }); continue; }
    if (!isSandboxTargetOfType(lists, rc.ResourceType, target)) failures.push({ rule: 'change-target-not-sandbox', ...id, target });
    for (const d of deniedBy(lists, target)) failures.push({ rule: 'change-target-denylisted', ...id, target, ...d });
  }
  if (template) for (const f of checkDocument(lists, template)) failures.push({ ...f, in: 'template' });
  return failures;
}
