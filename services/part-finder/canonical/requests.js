'use strict';
/**
 * G2 request history — pure helpers over cs/1 `requests[]` + `pendingRequest`.
 *
 *   recordOutcome(state, classification, turn)  — M20 (called by merge)
 *   issueRequest(state, request, turn)          — M21 (called only by the journey step for the policy NextAction)
 *   asked / lastOutcome / wasReoffered / requestsFor — readers for later policy
 *
 * Invariants: append-only; each request's outcome is written exactly once (pending -> X); at most one
 * request is pending; no assistant prose is stored or parsed (a request is a structured target only).
 * All functions return NEW state; inputs are never mutated.
 */

const { REQUESTS_CAP } = require('./cs1.js');

const SLOTS = ['CHECK', 'OBSERVATION', 'IDENTITY'];
const PURPOSES = ['DIAGNOSIS', 'PART_FIT', 'CONFIRM'];
const KINDS = ['ask', 'reoffer', 'retest'];
const OUTCOMES = ['pending', 'answered', 'partial', 'not_done', 'cannot_answer', 'declined', 'unable', 'ignored', 'superseded'];
const REOFFERABLE = new Set(['not_done', 'partial', 'ignored']);
const IDENTITY_TARGETS = new Set(['appliance', 'make', 'model', 'fuel']);
// Functional checks whose outcome is recorded as an observation (journey doc §17 G3).
const CHECK_OUTCOME_OBSERVATION = {
  'drain-command': 'commandedDrain',
  // Journey 2 functional checks (same G3 convention)
  'empty-spin-test': 'spinsEmpty', 'spin-command': 'commandedSpin', 'door-closed-latched': 'doorLocks',
  'leak-retest': 'leakRecurs',
  // batch 2 functional tests
  'power-off-fill-test': 'fillsWhenOff', 'door-release-wait': 'doorOpens', 'empty-vibration-test': 'shakesWhenEmpty',
  'drum-play': 'drumPlay', 'hot-wash-test': 'noHeat', retest: 'faultPersists',
  // dishwasher family
  'door-start-test': 'doorRecognised',
  // oven door (the only journey that asks it): cool fully + power-cycle → does the door unlock?
  'reset-power-cycle': 'doorOpens',
};
// Observation GROUP targets: one request for a categorical dimension spread over several boolean keys.
const OBSERVATION_GROUPS = {
  leakLocation: ['leakAtDoor', 'leakAtDrawer', 'leakAtRear', 'leakUnderneath', 'leakAtFilter'],
  leakTiming: ['leaksOnFill', 'leaksOnWash', 'leaksOnDrain', 'leaksWhenOff'],
  // batch 2
  fillState: ['waterEntering', 'fillsSlowly'],
  doorSymptom: ['doorOpens', 'doorLocks', 'doorCloses', 'handleBroken', 'lockClicking'],
  noiseTiming: ['noiseOnFill', 'noiseOnWash', 'noiseOnDrain', 'noiseOnSpin', 'noiseThroughout'],
  noiseType: ['grindingNoise', 'humNoise', 'scrapingNoise', 'knockingNoise', 'rattlingNoise', 'squealNoise', 'clickingNoise', 'gurglingNoise'],
  // dishwasher family
  cleanArea: ['poorUpperRack', 'poorLowerRack', 'poorAllRacks'],
  heatState: ['noHeat', 'heatPresent'],
  dwLeakLocation: ['leakAtDoor', 'leakAtRear', 'leakUnderneath'],
  // fridge / freezer and tumble dryer families
  ffCompartment: ['bothCompartmentsWarm', 'fridgeOnlyWarm'],
  ffLeakLocation: ['waterInsideFridge', 'leakUnderneath', 'leakFromSupplyLine'],
  ffIceWhere: ['frostOnBackWall', 'frostNearDoor', 'iceInBase'],
  ffCompressorState: ['compressorRuns', 'clicksNoStart'],
  dryerType: ['dryerVented', 'dryerCondenser', 'dryerHeatPump'],
  tdTankState: ['tankStaysEmpty', 'tankWarning'],
  // final pass
  ovenFunctions: ['grillWorks', 'mainOvenWorks'], ovenHeat: ['heatsSlowly', 'tooHot'], ignitionState: ['sparkClicks', 'flameGoesOut'],
  hobType: ['inductionHob', 'ceramicHob', 'gasHob', 'solidPlateHob'], mwSparkCause: ['metalInside', 'waveguideCoverDamaged', 'cavityBurnt'],
  vacType: ['vacuumCordless', 'vacuumCorded', 'vacuumRobot'], vacBattery: ['shortRuntime', 'wontCharge'],
  panTest: ['failsKnownGoodPan', 'worksWithKnownGoodPan'],
};

const clone = (x) => JSON.parse(JSON.stringify(x));

function pending(state) {
  const id = state && state.pendingRequest;
  if (!id) return null;
  return (state.requests || []).find((r) => r.id === id) || null;
}

/** Did this classification fill the request's target? (structured fields only) */
function targetFilled(req, c) {
  if (!req || !c) return false;
  const t = req.target;
  if (req.slot === 'IDENTITY' || IDENTITY_TARGETS.has(t)) {
    if (t === 'fuel') return Boolean(c.identity && c.identity.fuel);
    const f = c.identity && c.identity[t];
    return Boolean(f && f.value);
  }
  if (req.slot === 'CHECK') {
    if ((c.checks || []).some((k) => k.check === t && k.status === 'done')) return true;
    // Journey §17 G3 convention: a functional check's outcome is an observation, not a check result.
    const obsKey = CHECK_OUTCOME_OBSERVATION[t];
    return Boolean(obsKey && (c.observations || []).some((o) => o.key === obsKey));
  }
  if (OBSERVATION_GROUPS[t]) return (c.observations || []).some((o) => OBSERVATION_GROUPS[t].includes(o.key));
  return (c.observations || []).some((o) => o.key === t);
}

/**
 * M20. Write exactly one outcome onto the pending request, set resolvedTurn, clear pendingRequest.
 * M0 turns (prompt_attack / unrelated) must NOT call this (merge returns before it) — the request stays pending.
 */
function recordOutcome(state, c, turn) {
  const req = pending(state);
  if (!req || req.outcome !== 'pending') return { state, outcome: null };
  let outcome = null;
  const chk = (c.checks || []).find((k) => k.check === req.target);
  if (chk && ['not_done', 'declined', 'unable'].includes(chk.status)) outcome = chk.status;
  else if (c.reply && ['answered', 'partial', 'cannot_answer', 'declined'].includes(c.reply.toPending)) outcome = c.reply.toPending;
  else if (targetFilled(req, c)) outcome = 'answered';
  else outcome = 'ignored';
  const next = clone(state);
  const r = next.requests.find((x) => x.id === req.id);
  r.outcome = outcome;
  r.resolvedTurn = turn;
  next.pendingRequest = null;
  return { state: next, outcome, request: r };
}

/**
 * M21. Append a request issued by policy. Any still-pending request is first closed as `superseded`.
 * `request` = {slot, target, purpose, kind, journey, rule}. `kind` defaults per M21 if omitted.
 */
function issueRequest(state, request, turn) {
  const rq = request || {};
  if (!SLOTS.includes(rq.slot)) throw new Error(`issueRequest: invalid slot ${rq.slot}`);
  if (!rq.target || typeof rq.target !== 'string') throw new Error('issueRequest: target required');
  if (!PURPOSES.includes(rq.purpose)) throw new Error(`issueRequest: invalid purpose ${rq.purpose}`);
  const next = clone(state);
  const open = pending(next);
  if (open && open.outcome === 'pending') {
    open.outcome = 'superseded';
    open.resolvedTurn = turn;
  }
  if (next.requests.length >= REQUESTS_CAP) {
    next.pendingRequest = null;
    return { state: next, request: null, overflow: true };
  }
  let kind = rq.kind;
  if (kind == null) kind = REOFFERABLE.has(lastOutcome(next, rq.target)) ? 'reoffer' : 'ask';
  if (!KINDS.includes(kind)) throw new Error(`issueRequest: invalid kind ${kind}`);
  const entry = {
    id: `q${next.requests.length + 1}`,
    slot: rq.slot, target: rq.target, purpose: rq.purpose, kind,
    askedTurn: turn, journey: rq.journey || null, rule: rq.rule || null,
    outcome: 'pending', resolvedTurn: null,
  };
  next.requests.push(entry);
  next.pendingRequest = entry.id;
  return { state: next, request: entry, overflow: false };
}

// ---- readers (for later policy) ------------------------------------------------------------------
function requestsFor(state, target) {
  return ((state && state.requests) || []).filter((r) => r.target === target);
}
/** asked(target): number of ask + reoffer requests (retests are separate). */
function asked(state, target) {
  return requestsFor(state, target).filter((r) => r.kind === 'ask' || r.kind === 'reoffer').length;
}
function lastOutcome(state, target) {
  const rs = requestsFor(state, target);
  return rs.length ? rs[rs.length - 1].outcome : null;
}
function wasReoffered(state, target) {
  return requestsFor(state, target).some((r) => r.kind === 'reoffer');
}
function pendingCount(state) {
  return ((state && state.requests) || []).filter((r) => r.outcome === 'pending').length;
}

module.exports = {
  CHECK_OUTCOME_OBSERVATION, OBSERVATION_GROUPS,
  SLOTS, PURPOSES, KINDS, OUTCOMES,
  pending, recordOutcome, issueRequest, requestsFor, asked, lastOutcome, wasReoffered, pendingCount,
};
