'use strict';

/**
 * Bounded, typed STATE-PROGRESSION evidence for the semantic reviewer.
 *
 * This is NOT a semantic judgement and NOT prose parsing. It is a compact, structural projection of
 * the per-turn `diagnosticTrace.stateProgression` that the persistence layer already computes from
 * the orchestrator's structured state snapshots (transcripts.stateProgression). Each entry is a
 * typed change label (NEW / UPDATED / REMOVED_OR_CONTRADICTED / RETAINED) on a known state path —
 * never a phrase match against customer or assistant text.
 *
 * The reviewer (Jev) consumes this so it can SEE where the conversation retained, added, changed or
 * lost an established fact across turns, and decide — semantically — whether a drop was a legitimate
 * customer correction or the assistant forgetting. The deterministic code here only surfaces the
 * typed signals; it does not decide quality.
 */

// Known orchestrator-state paths we surface, mapped to short field names. Anything else in the
// trace (resolved.*, inferred.*, latencies, …) is deliberately omitted to keep the evidence small
// and focused on what the customer established.
const PATH_FIELD = {
  'customer.make': { field: 'make', group: 'identity' },
  'customer.appliance': { field: 'appliance', group: 'identity' },
  'customer.displayedCode': { field: 'displayedCode', group: 'identity' },
  'customer.observed': { field: 'identifiers', group: 'identity' },
  'customer.fault': { field: 'fault', group: 'problem' },
  'customer.symptomsText': { field: 'symptom', group: 'problem' },
  'customer.reportedSymptoms': { field: 'reportedSymptoms', group: 'problem' },
  'customer.checksReported': { field: 'checksReported', group: 'evidence' },
  'customer.facts': { field: 'facts', group: 'evidence' },
  'customer.declinedFacts': { field: 'declinedFacts', group: 'evidence' },
};
const MEANINGFUL = new Set(['NEW', 'UPDATED', 'REMOVED_OR_CONTRADICTED']);
const MAX_TIMELINE_TURNS = 24;
const MAX_CHANGES_PER_TURN = 10;
const MAX_DROPS = 16;
const MAX_ROUTE_CHANGES = 16;

function clip(s, n) {
  if (s == null) return '';
  const t = String(s);
  return t.length > n ? t.slice(0, n) : t;
}

// A single turn's structural changes on the known paths. Returns only meaningful changes
// (NEW/UPDATED/REMOVED_OR_CONTRADICTED); RETAINED is implied and omitted to stay compact.
function turnChanges(trace) {
  if (!trace || !Array.isArray(trace.stateProgression)) return [];
  const out = [];
  for (const entry of trace.stateProgression) {
    if (!entry || typeof entry !== 'object') continue;
    const map = PATH_FIELD[entry.path];
    if (!map) continue;
    if (!MEANINGFUL.has(entry.change)) continue;
    out.push({ field: map.field, group: map.group, change: entry.change });
    if (out.length >= MAX_CHANGES_PER_TURN) break;
  }
  return out;
}

/**
 * Build the bounded typed state-progression evidence for a transcript record.
 * Deterministic and structural — safe to hand to the reviewer as context.
 */
function buildStateEvidence(rec) {
  const turns = Array.isArray(rec && rec.turns) ? rec.turns : [];
  const timeline = [];
  const drops = [];
  const routeOutcomeChanges = [];
  let prevRoute = null;
  let prevOutcome = null;
  const groupsWithDrop = new Set();

  const windowed = turns.slice(-MAX_TIMELINE_TURNS);
  for (const t of windowed) {
    if (!t) continue;
    const changes = turnChanges(t.diagnosticTrace);
    if (changes.length) {
      timeline.push({ seq: t.seq || 0, changes });
      for (const c of changes) {
        if (c.change === 'REMOVED_OR_CONTRADICTED') {
          groupsWithDrop.add(c.group);
          if (drops.length < MAX_DROPS) drops.push({ seq: t.seq || 0, field: c.field, group: c.group });
        }
      }
    }
    // Route / outcome transitions come from the per-turn structured metadata, not prose.
    const md = (t.metadata && typeof t.metadata === 'object') ? t.metadata : {};
    const route = md.route || null;
    const outcome = md.outcome || null;
    if ((route && route !== prevRoute) || (outcome && outcome !== prevOutcome)) {
      if (routeOutcomeChanges.length < MAX_ROUTE_CHANGES) {
        routeOutcomeChanges.push({
          seq: t.seq || 0,
          route: route || prevRoute || null,
          outcome: outcome || prevOutcome || null,
        });
      }
      if (route) prevRoute = route;
      if (outcome) prevOutcome = outcome;
    } else {
      if (route) prevRoute = route;
      if (outcome) prevOutcome = outcome;
    }
  }

  return {
    note: 'Structural state-progression signals from the diagnostic trace (typed change labels, not'
      + ' text analysis). A REMOVED_OR_CONTRADICTED on an established fact may be a legitimate'
      + ' customer correction OR the assistant forgetting — judge which from the conversation.',
    turnCount: rec && rec.turnCount ? rec.turnCount : turns.length,
    finalState: {
      family: (rec && rec.family) || null,
      make: (rec && rec.make) || null,
      model: (rec && rec.model) || null,
      errorCode: (rec && rec.errorCode) || null,
      route: (rec && rec.route) || null,
      outcome: (rec && rec.outcome) || null,
      safetyClass: (rec && rec.safetyClass) || null,
      safetyStop: Boolean(rec && rec.safetyStop),
    },
    timeline: timeline,
    drops: drops,
    routeOutcomeChanges: routeOutcomeChanges,
    // Structural facts only — whether a drop was seen on each group. NOT a judgement of fault.
    droppedGroups: {
      identity: groupsWithDrop.has('identity'),
      problem: groupsWithDrop.has('problem'),
      evidence: groupsWithDrop.has('evidence'),
    },
  };
}

// Compact one-line-per-turn rendering for the reviewer state (keeps the JSON small).
function compactStateEvidence(ev) {
  if (!ev) return null;
  return {
    note: clip(ev.note, 400),
    turnCount: ev.turnCount,
    finalState: ev.finalState,
    timeline: (ev.timeline || []).map((t) => ({
      seq: t.seq,
      changes: (t.changes || []).map((c) => `${c.field}:${c.change}`),
    })),
    drops: ev.drops,
    routeOutcomeChanges: ev.routeOutcomeChanges,
    droppedGroups: ev.droppedGroups,
  };
}

module.exports = {
  buildStateEvidence,
  compactStateEvidence,
  PATH_FIELD,
};
