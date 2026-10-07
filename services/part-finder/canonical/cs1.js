'use strict';
/**
 * cs/1 — canonical cumulative ConversationState (services/whichpart-api/docs/canonical-architecture.md §4). Persisted by the BFF (§11).
 *
 * Shape detail: canonical-semantic-state.md §11 (state shape, Fact<T>), §12 (merge rules),
 *         G1 (waterReturnsAfterDrain), G2 (requests[] / pendingRequest).
 *
 * Plain data + small pure helpers. No I/O, no clock, no prose.
 */

const SCHEMA_VERSION = 'cs/1';
const FACT_HISTORY_CAP = 5;      // per-Fact history entries kept in state (full history: the BFF turn records)
const REQUESTS_CAP = 100;        // request history cap (implementation plan §5)

// Safety precedence — same order as orchestration/model.py SAFETY_ORDER (strongest last).
const SAFETY_ORDER = ['NORMAL_DIAGNOSTIC', 'STATUS_ONLY', 'SERVICE_REQUIRED', 'ISOLATE_IF_SAFE', 'STOP_USE', 'EMERGENCY_ACTION'];
// Hazard -> safety class. Mirrors the orchestrator's existing cause mapping (rag_safety_from_done:
// gas -> EMERGENCY_ACTION; shock / burning / electrical -> STOP_USE). microwave_arcing is the
// diagnosable stop-use tier (STOP_USE). Whether a hazard stays operationally active after a correction
// is POLICY (stickiness), not state.
const HAZARD_LEVEL = {
  gas_escape: 'EMERGENCY_ACTION', gas_smell: 'EMERGENCY_ACTION',
  electric_shock: 'STOP_USE', electrical_water: 'STOP_USE', supply_trip: 'STOP_USE',
  burning: 'STOP_USE', smoke: 'STOP_USE', sparks_at_supply: 'STOP_USE', microwave_arcing: 'STOP_USE', exposed_live_wiring: 'STOP_USE',
};

function strongestLevel(levels) {
  let best = 0;
  for (const l of levels) {
    const i = SAFETY_ORDER.indexOf(l);
    if (i > best) best = i;
  }
  return SAFETY_ORDER[best];
}

/** A Fact<T> with no value. */
function emptyFact(extra) {
  return { value: null, basis: null, turn: null, status: 'active', history: [], ...(extra || {}) };
}

/** A new active Fact<T>. */
function newFact(value, basis, turn, extra) {
  return { value, basis, turn, status: 'active', history: [], ...(extra || {}) };
}

/** Supersede `old` with a new value; the old value moves to history (bounded). */
function supersedeFact(old, value, basis, turn, supersededBy) {
  const prev = old && old.value !== null && old.value !== undefined
    ? [...(old.history || []), { value: old.value, basis: old.basis, turn: old.turn, supersededBy }]
    : [...((old && old.history) || [])];
  const keep = { ...(old || {}) };
  delete keep.history;
  return { ...keep, value, basis, turn, status: 'active', history: prev.slice(-FACT_HISTORY_CAP) };
}

function emptyState(sessionId) {
  return {
    schemaVersion: SCHEMA_VERSION,
    sessionId: sessionId == null ? null : String(sessionId),
    version: 0,
    scope: { lastRequestClass: null, refusals: 0 },
    identity: {
      appliance: emptyFact(),
      applianceEstablishment: 'unknown',          // M19 (derived each merge)
      make: emptyFact(),
      model: emptyFact({ confirmed: false }),
      modelStatus: null,                           // known | unavailable | pending_lookup | null
      fuel: emptyFact({ conflict: false }),
      displayedCodes: [],                          // [Fact<string>] latest active last
    },
    intent: { active: null, history: [] },
    problems: [],                                  // [{id, status, origin, journey, faultDomain, scope, openedTurn, resolvedTurn, recurrences, archive}]
    evidence: {
      observations: {},                            // key -> Fact<boolean>
      checks: {},                                  // key -> {status, result, turn, history}
      replacedParts: [],
      customerTheories: [],
    },
    declined: [],                                  // [{target, kind, turn, resolvedTurn}]
    safety: {
      hazards: [],                                 // [{hazard, turn, status, correctedTurn}] append-only
      activeLevel: 'NORMAL_DIAGNOSTIC',
      peakLevel: 'NORMAL_DIAGNOSTIC',
      unsafeActions: [],                           // [{action, turn}] append-only
    },
    resolution: null,                              // unresolved | resolved | temporary | null
    requests: [],                                  // G2 append-only request history
    pendingRequest: null,                          // id of the ONE pending request, or null
    inferred: {},                                  // diagnostics tier — never written by merge
  };
}

function activeProblem(state) {
  const ps = (state && state.problems) || [];
  for (let i = ps.length - 1; i >= 0; i -= 1) if (ps[i].status === 'active') return ps[i];
  return null;
}

function serialisedBytes(state) {
  return Buffer.byteLength(JSON.stringify(state || null), 'utf8');
}

module.exports = {
  SCHEMA_VERSION, FACT_HISTORY_CAP, REQUESTS_CAP, SAFETY_ORDER, HAZARD_LEVEL,
  strongestLevel, emptyFact, newFact, supersedeFact, emptyState, activeProblem, serialisedBytes,
};
