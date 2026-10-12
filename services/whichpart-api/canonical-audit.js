'use strict';
/**
 * Legacy reader for canonical-audit/1: the per-turn snapshot of journey-controller decisions that transcripts stored
 * before the journey controller was retired (ADR 0020). Nothing writes this block any more; stored transcripts keep
 * it until they expire (TRANSCRIPT_RETENTION_DAYS, 90), and the admin transcript views display and summarise it
 * read-only (transcripts.js canonicalSummary, apps/web/public/admin.js). New turns carry ac2-transcript-audit/1.
 */

const SCHEMA_VERSION = 'canonical-audit/1';

/** Drop null / undefined / empty-array / empty-object keys (the UI never shows dozens of nulls). */
function prune(o) {
  if (Array.isArray(o)) return o.map(prune);
  if (!o || typeof o !== 'object') return o;
  const out = {};
  for (const [k, v] of Object.entries(o)) {
    const p = prune(v);
    if (p == null) continue;
    if (Array.isArray(p) && !p.length) continue;
    if (typeof p === 'object' && !Array.isArray(p) && !Object.keys(p).length) continue;
    out[k] = p;
  }
  return out;
}

/** Summary-only form (older transcript turns are slimmed to this so a long session stays far under 400 KB). */
function slim(audit) {
  if (!audit || audit.slim) return audit;
  const a = audit;
  return prune({
    schemaVersion: a.schemaVersion, slim: true, truncated: a.truncated || null, path: a.path, mode: a.mode, controlled: a.controlled, owner: a.owner,
    ref: a.ref, appliance: a.appliance, version: a.version,
    policy: a.policy ? { rule: a.policy.rule, kind: a.policy.kind, target: a.policy.target, outcome: a.policy.outcome, safetyStop: a.policy.safetyStop } : null,
    nextAction: a.nextAction ? { kind: a.nextAction.kind, target: a.nextAction.target, rule: a.nextAction.rule } : null,
    pendingRequest: a.pendingRequest ? { change: a.pendingRequest.change, after: a.pendingRequest.after } : null,
    partGate: a.partGate ? { eligible: a.partGate.eligible, blockers: (a.partGate.blockers || []).slice(0, 4) } : null,
    compose: a.compose ? { mode: a.compose.mode, valid: a.compose.valid } : null,
    persistence: a.persistence,
  });
}

module.exports = { SCHEMA_VERSION, slim };
