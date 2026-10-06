/**
 * CloudFormation change-set safety checker. Works offline on the JSON from
 * `aws cloudformation describe-change-set` (and, optionally, the synthesized template).
 *
 * Modes:
 *   import  every change is an Import of an allowlisted physical ID (Phase 5)
 *   update  no replacement, no unapproved removal, IAM changes surfaced (Phase 6 onwards)
 *
 * Status: skeleton. Rules are exercised against fixtures here and finalised in the Phase 4
 * sandbox rehearsal against real change sets.
 */
import { findExactHits, scanDocument } from '../denylist/match.js';
import { sha256Hex } from '../redact.js';

const IAM_TYPES = /^AWS::IAM::/;
const S4R_CONSUMED_TYPES = /^AWS::Lambda::/;
const KNOWN_SECRET_PREFIXES = [/^sk-[A-Za-z0-9_-]{16,}/, /^AKIA[0-9A-Z]{16}$/, /^ASIA[0-9A-Z]{16}$/, /^ghp_[A-Za-z0-9]{30,}/, /^xox[baprs]-/];

function resourceChanges(changeSet) {
  return (changeSet.Changes || []).filter((c) => c.Type === 'Resource').map((c) => c.ResourceChange);
}

function stringsIn(value, into = []) {
  if (typeof value === 'string') into.push(value);
  else if (Array.isArray(value)) value.forEach((v) => stringsIn(v, into));
  else if (value && typeof value === 'object') Object.values(value).forEach((v) => stringsIn(v, into));
  return into;
}

/**
 * @param {object} input
 * @param {object} input.changeSet           describe-change-set output
 * @param {Array}  input.denylist            entries from s4r-denylist.json
 * @param {'import'|'update'} input.mode
 * @param {string[]} [input.allowedPhysicalIds] physical IDs this step may touch
 * @param {string[]} [input.approvedRemovals]  logical IDs whose removal is approved (update mode)
 * @param {string[]} [input.s4rConsumedPhysicalIds] e.g. the diagnosis Lambda: changes need sign-off
 * @param {object} [input.template]           synthesized template JSON
 * @param {string[]} [input.secretDigests]    SHA-256 digests of known secret values (from inventory)
 * @param {Array<{value: string, reason: string}>} [input.acknowledgedReferences]
 *        S4R identifiers that may appear inside property values because an AC resource refers to
 *        them (for example AC's sign-in policy naming the S4R pool ARN). They only waive the
 *        document scan; an S4R resource as the target of a change always fails.
 */
export function checkChangeSet({ changeSet, denylist, mode, allowedPhysicalIds = [], approvedRemovals = [], s4rConsumedPhysicalIds = [], template = null, secretDigests = [], acknowledgedReferences = [] }) {
  const failures = [];
  const warnings = [];
  const fail = (rule, detail) => failures.push({ rule, ...detail });
  const warn = (rule, detail) => warnings.push({ rule, ...detail });

  if (!['import', 'update'].includes(mode)) throw new Error(`Unknown mode "${mode}"`);

  const stackHits = findExactHits(denylist, changeSet.StackName || '').concat(findExactHits(denylist, changeSet.StackId || ''));
  if (stackHits.length) fail('stack-denylisted', { stack: changeSet.StackName, entries: stackHits.map((e) => e.value) });

  const acknowledged = new Map(acknowledgedReferences.map((r) => [r.value, r.reason]));
  for (const r of acknowledgedReferences) {
    if (!r.reason) fail('acknowledged-reference-without-reason', { value: r.value });
  }
  const referenceScan = (doc, rule) => {
    for (const hit of scanDocument(denylist, doc)) {
      if (acknowledged.has(hit.value)) warn('acknowledged-s4r-reference', { value: hit.value, reason: acknowledged.get(hit.value) });
      else fail(rule, { value: hit.value, source: hit.source });
    }
  };
  referenceScan(changeSet, 'denylisted-identifier-present');

  const changes = resourceChanges(changeSet);
  if (changes.length === 0) warn('empty-change-set', {});

  for (const rc of changes) {
    const id = { logicalId: rc.LogicalResourceId, physicalId: rc.PhysicalResourceId || null, type: rc.ResourceType, action: rc.Action };
    if (rc.PhysicalResourceId && findExactHits(denylist, rc.PhysicalResourceId).length) fail('physical-id-denylisted', id);

    if (mode === 'import') {
      if (rc.Action !== 'Import') fail('non-import-action', id);
      else if (!allowedPhysicalIds.includes(rc.PhysicalResourceId)) fail('physical-id-not-allowlisted', id);
    } else {
      if (rc.Action === 'Remove' && !approvedRemovals.includes(rc.LogicalResourceId)) fail('unapproved-removal', id);
      if (rc.Replacement === 'True' || rc.Replacement === 'Conditional') fail('replacement', { ...id, replacement: rc.Replacement });
      if (rc.Action === 'Dynamic') fail('dynamic-change-needs-review', id);
      if (rc.Action === 'Import') fail('import-in-update', id);
      if (rc.PhysicalResourceId && allowedPhysicalIds.length && !allowedPhysicalIds.includes(rc.PhysicalResourceId) && rc.Action !== 'Add') fail('physical-id-not-allowlisted', id);
      if (IAM_TYPES.test(rc.ResourceType || '')) warn('iam-change', id);
    }
    if (rc.PhysicalResourceId && s4rConsumedPhysicalIds.includes(rc.PhysicalResourceId) && S4R_CONSUMED_TYPES.test(rc.ResourceType || '')) {
      warn('potentially-impacts-s4r', { ...id, note: 'Requires explicit sign-off and the /part-finder contract test before and after.' });
    }
  }

  if (template) checkTemplate({ template, mode, secretDigests, fail });
  if (template) referenceScan(template, 'denylisted-identifier-in-template');

  return { ok: failures.length === 0, mode, stack: changeSet.StackName || null, changes: changes.length, failures, warnings };
}

function checkTemplate({ template, mode, secretDigests, fail }) {
  const resources = template.Resources || {};
  for (const [logicalId, r] of Object.entries(resources)) {
    if (mode === 'import' && r.Type === 'AWS::CDK::Metadata') fail('cdk-metadata-in-import', { logicalId });
    if (r.Type === 'AWS::CloudFormation::WaitConditionHandle' || r.Type === 'AWS::CDK::Metadata') continue;
    if (r.DeletionPolicy !== 'Retain') fail('missing-retain-deletion-policy', { logicalId, type: r.Type });
    if (r.UpdateReplacePolicy !== 'Retain') fail('missing-retain-update-replace-policy', { logicalId, type: r.Type });
  }
  const digests = new Set(secretDigests);
  for (const s of stringsIn(template)) {
    if (digests.has(sha256Hex(s))) fail('literal-secret-in-template', { sha256: sha256Hex(s) });
    if (KNOWN_SECRET_PREFIXES.some((re) => re.test(s))) fail('secret-shaped-literal-in-template', { prefix: s.slice(0, 4) });
  }
}
