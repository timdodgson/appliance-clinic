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
]);

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
    if (/aws:cloudformation:/.test(text)) cfn.push(d);
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
