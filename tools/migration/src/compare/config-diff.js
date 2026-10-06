/**
 * Compare two inventory captures. Fields that change on their own (timestamps, revision IDs,
 * item counts, last-used data) are ignored, so what remains is configuration drift.
 */
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
