/**
 * Compare two inventory captures. Fields that change on their own (timestamps, revision IDs,
 * item counts, last-used data) are ignored, so what remains is configuration drift.
 */
import { redactedValue } from '../redact.js';

export const VOLATILE_KEYS = new Set([
  'capturedAt', 'LastModified', 'lastModified', 'RevisionId', 'LastUpdateStatus', 'LastUpdateStatusReason',
  'LastUpdateStatusReasonCode', 'State', 'StateReason', 'StateReasonCode', 'roleLastUsed', 'itemCount',
  'tableSizeBytes', 'lastChangedDate', 'LastAccessedDate', 'lastAccessedDate', 'etag', 'ETag', 'savedAs',
  'onDemandBackups', 'pushedAt', 'callerArn', 'options', 'LastModifiedTime', 'downloaded',
  // PITR's restore window moves on its own every few minutes.
  'LatestRestorableDateTime', 'EarliestRestorableDateTime',
]);

// Arrays of records are matched by identity, not position, so adding one record (a new stack, function or
// role) does not show every later record as changed. The first of these keys a record carries names it.
const IDENTITY_KEYS = ['stackName', 'functionName', 'FunctionName', 'roleName', 'tableName', 'bucket', 'repositoryName', 'name', 'Name', 'logicalId', 'id', 'Id', 'Sid', 'key'];
const identityOf = (v) => {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const k = IDENTITY_KEYS.find((key) => typeof v[key] === 'string');
  return k ? `${k}=${v[k]}` : null;
};
function keyedRecords(list) {
  const ids = list.map(identityOf);
  if (ids.some((x) => x === null) || new Set(ids).size !== ids.length) return null;
  return new Map(ids.map((x, i) => [x, list[i]]));
}

const isObject = (v) => v && typeof v === 'object' && !Array.isArray(v);

export function diffValues(before, after, path = '', out = [], volatile = VOLATILE_KEYS) {
  if (isObject(before) && isObject(after)) {
    for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
      if (volatile.has(key)) continue;
      diffValues(before[key], after[key], path ? `${path}.${key}` : key, out, volatile);
    }
    return out;
  }
  if (Array.isArray(before) && Array.isArray(after)) {
    const b = keyedRecords(before);
    const a = keyedRecords(after);
    if (b && a) {
      for (const k of new Set([...b.keys(), ...a.keys()])) diffValues(b.get(k), a.get(k), `${path}[${k}]`, out, volatile);
      return out;
    }
    const len = Math.max(before.length, after.length);
    for (let i = 0; i < len; i += 1) diffValues(before[i], after[i], `${path}[${i}]`, out, volatile);
    return out;
  }
  if (JSON.stringify(before) !== JSON.stringify(after)) out.push({ path, before: before ?? null, after: after ?? null });
  return out;
}

/** Tags added by CloudFormation on import or update are reported separately, not as drift. */
export function splitCloudFormationTags(differences) {
  const cfn = [];
  const rest = [];
  for (const d of differences) {
    const text = JSON.stringify([d.before, d.after]);
    // Only the tag keys CloudFormation adds. A stack ARN (arn:aws:cloudformation:...) is not a tag and must not
    // hide a difference.
    if (/"aws:cloudformation:(stack-name|stack-id|logical-id)"/.test(text)) cfn.push(d);
    else rest.push(d);
  }
  return { drift: rest, cloudformationTags: cfn };
}

// Lambda environment values may be plaintext secrets or customer identifiers. A diff that touches
// them keeps the variable name and whether it was added, removed or changed, never the value.
const ENVIRONMENT_PATH = /(^|\.)Environment(\.Variables)?(\.|$)/;

const isRedacted = (v) => isObject(v) && v.redacted === true && typeof v.sha256 === 'string';

function redactEnvironmentValue(value) {
  if (value === null || value === undefined) return null;
  if (isRedacted(value)) return value;
  if (isObject(value)) {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = redactEnvironmentValue(v);
    return out;
  }
  if (Array.isArray(value)) return value.map(redactEnvironmentValue);
  return redactedValue(typeof value === 'string' ? value : JSON.stringify(value));
}

// A difference higher up the tree (a whole function or configuration added or removed) can carry an
// Environment object inside its value, so nested Environment keys are redacted too.
function redactNestedEnvironment(value) {
  if (Array.isArray(value)) return value.map(redactNestedEnvironment);
  if (!isObject(value) || isRedacted(value)) return value;
  const out = {};
  for (const [k, v] of Object.entries(value)) out[k] = k === 'Environment' ? redactEnvironmentValue(v) : redactNestedEnvironment(v);
  return out;
}

/** Replace every Lambda environment value in a list of differences by its digest and length. */
export function redactEnvironmentDifferences(differences) {
  return differences.map((d) => (ENVIRONMENT_PATH.test(d.path)
    ? { ...d, before: redactEnvironmentValue(d.before), after: redactEnvironmentValue(d.after) }
    : { ...d, before: redactNestedEnvironment(d.before), after: redactNestedEnvironment(d.after) }));
}
