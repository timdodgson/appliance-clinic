'use strict';

/**
 * Recall notice lifecycle (PURE). One record per official OPSS notice (GOV.UK content id).
 *
 * Two owners, kept apart:
 *   SOURCE  — every field parsed from the official GOV.UK notice (title, hazard, corrective action,
 *             products, models, dates, risk). Never edited by Admin. A changed source notice is a new
 *             SOURCE REVISION (the previous source snapshot is kept in sourceRevisions).
 *   ADMIN   — ApplianceClinic's listing decision only: whether the notice is listed in the Recall Centre
 *             and under which appliance family. Draft → Publish → immutable versions → rollback.
 *
 * Effective state (what customers get), in order:
 *   withdrawn — the source withdrew the notice (never listed as current; kept as evidence)
 *   archived  — an Admin decision withdrew it from the Recall Centre (kept, restorable)
 *   published — listed (classifier decision, or an Admin publish decision with a valid family)
 *   review    — held: ambiguous family match, or a source record that failed validation
 *   excluded  — out of scope (not an ApplianceClinic appliance)
 * "Published" is the ONLY state the public API, Recall Centre pages and WebMCP checkRecall can see.
 */

const { familyOf, FAMILIES } = require('./families');

const STATE_LABELS = {
  published: 'Listed',
  review: 'Held for review',
  excluded: 'Out of scope',
  archived: 'Archived',
  withdrawn: 'Withdrawn by OPSS',
};
const SOURCE_TYPES = ['recall', 'safety_report', 'safety_alert'];
const SOURCE_URL_PREFIX = 'https://www.gov.uk/product-safety-alerts-reports-recalls/';
const CONTENT_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}/;
const SOURCE_FIELDS = [
  'title', 'description', 'sourceType', 'riskLevel', 'measureTypes', 'alertDate', 'firstPublishedAt', 'publicUpdatedAt',
  'psdNumber', 'productType', 'productName', 'brand', 'models', 'modelText', 'batchText', 'serialText', 'identifiers',
  'countryOfOrigin', 'productDescription', 'hazard', 'correctiveAction', 'manufacturerUrl', 'withdrawn', 'bodyHash', 'sourceUrl',
];
const SOURCE_REVISION_CAP = 10;

/** Structural validation of an ingested source record. Server-side and authoritative. */
function validateRecord(rec) {
  const errs = [];
  if (!rec || typeof rec !== 'object') return ['record'];
  if (!CONTENT_ID_RE.test(String(rec.contentId || ''))) errs.push('contentId');
  if (!String(rec.title || '').trim()) errs.push('title');
  if (!String(rec.slug || '').trim()) errs.push('slug');
  if (String(rec.sourceUrl || '').indexOf(SOURCE_URL_PREFIX) !== 0) errs.push('sourceUrl');
  if (!DATE_RE.test(String(rec.alertDate || ''))) errs.push('alertDate');
  if (SOURCE_TYPES.indexOf(rec.sourceType) === -1) errs.push('sourceType');
  if (rec.models != null && !Array.isArray(rec.models)) errs.push('models');
  if (!String(rec.bodyHash || '').trim()) errs.push('bodyHash');
  return errs;
}

function classifierFamily(rec) {
  const c = rec.classification || {};
  if (Object.prototype.hasOwnProperty.call(c, 'family')) return c.family || null;
  // Records ingested before classification.family was stored: rec.family WAS the classifier family
  // (unless an Admin decision already moved it — not possible before this module existed).
  return rec.family || null;
}
function classifierState(rec) {
  const c = rec.classification || {};
  if (c.state === 'published' || c.publish === true) return 'published';
  if (c.state === 'review' || c.state === 'excluded') return c.state;
  return rec.state === 'published' ? 'published' : (rec.state || 'excluded');
}

/** The live Admin decision currently in force (null = the classifier decides). */
function liveDecision(rec) {
  return (rec && rec.admin && rec.admin.live) || null;
}

/** Effective {state, family, by} for a record given its source + classifier + Admin decision. */
function effective(rec) {
  const d = liveDecision(rec);
  const family = (d && d.family) || classifierFamily(rec);
  if (rec && rec.withdrawn) return { state: 'withdrawn', family, by: 'source' };
  if (d && d.status === 'archived') return { state: 'archived', family, by: 'admin' };
  if (d && d.status === 'published' && familyOf(family)) return { state: 'published', family, by: 'admin' };
  if (rec && rec.validation && rec.validation.ok === false) return { state: 'review', family, by: 'validation' };
  return { state: classifierState(rec), family, by: 'classifier' };
}

/** Apply effective state/family onto the stored record fields the public API + GSI read. */
function applyEffective(rec) {
  const e = effective(rec);
  rec.state = e.state;
  rec.family = e.family;
  return rec;
}

function sourceSnapshot(rec) {
  const out = {};
  SOURCE_FIELDS.forEach((k) => { if (rec[k] !== undefined) out[k] = rec[k]; });
  return JSON.parse(JSON.stringify(out));
}

function decisionChanged(a, b) {
  const x = a || {};
  const y = b || {};
  const out = [];
  if ((x.status || null) !== (y.status || null)) out.push('status');
  if ((x.family || null) !== (y.family || null)) out.push('family');
  if ((x.note || null) !== (y.note || null)) out.push('note');
  return out;
}

function versionList(rec) {
  const a = (rec && rec.admin) || {};
  const out = [{ version: 0, label: 'As ingested', action: 'ingest', decision: null, note: 'Classifier decision on the official notice' }];
  (a.versions || []).forEach((v) => out.push({
    version: v.version, label: 'v' + v.version, action: v.action, at: v.at, by: v.by || null, note: v.note || null,
    decision: v.decision || null, sourceHash: v.sourceHash || null, rolledBackFrom: v.rolledBackFrom == null ? null : v.rolledBackFrom,
    changed: v.changed || [], previousRevision: v.previousRevision == null ? null : v.previousRevision,
    newRevision: v.newRevision == null ? null : v.newRevision, effectiveState: v.effectiveState || null,
  }));
  return out;
}

module.exports = {
  STATE_LABELS, SOURCE_TYPES, SOURCE_URL_PREFIX, SOURCE_FIELDS, SOURCE_REVISION_CAP, FAMILIES,
  validateRecord, classifierFamily, classifierState, liveDecision, effective, applyEffective,
  sourceSnapshot, decisionChanged, versionList,
};
