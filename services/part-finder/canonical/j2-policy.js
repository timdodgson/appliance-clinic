'use strict';
/**
 * Journey 2 policy — washing machine · motion · not spinning. PURE, deterministic.
 * Design: docs/diagnostics/wm-not-spinning-evidence.md §7 (rules S1–S20) and §8 (part gate Q1–Q7).
 *
 *   entry(state, diag)                -> {candidate, applies, ...}
 *   policy(state, diag, {partLookup}) -> NextAction (same contract as Journey 1)
 *   partGate(state, diag, partLookup) -> {eligible, component, failed[]}
 *
 * Reads ONLY cs/1, the structured Journey 2 diagnostics and the typed part lookup. No prose.
 * Request semantics are the shared G2 predicates (policy-kit). Drain-first: retained water is Journey 1's.
 */

const rq = require('./requests.js');
const kit = require('./policy-kit.js');

const JOURNEY = 'wm-not-spinning';
const J2_JOURNEYS = new Set(['not-spinning', 'drum-not-turning']);
const CHECKS = ['load-check', 'empty-spin-test', 'spin-command', 'programme-setting', 'drum-by-hand', 'door-closed-latched'];
const OBS_TARGETS = ['waterRemaining', 'drumTurns', 'motorAudible'];

const REQUIRES = {
  'load-check': ['pause_wait_door_unlock'],
  'empty-spin-test': ['pause_wait_door_unlock', 'stop_if_violent_shaking'],
  'spin-command': ['stop_if_violent_shaking'],
  'programme-setting': [],
  'drum-by-hand': ['isolate_mains', 'wait_drum_stopped_door_unlocked', 'turn_by_hand_only', 'no_panel_removal'],
  'door-closed-latched': ['never_bypass_interlock', 'do_not_force_door'],
  motorAudible: ['do_not_open_or_reach_in_while_running'],
};
const EXPECTS = {
  'load-check': ['checks.load-check'], 'empty-spin-test': ['observations.spinsEmpty'], 'spin-command': ['observations.commandedSpin'],
  'programme-setting': ['checks.programme-setting'], 'drum-by-hand': ['checks.drum-by-hand', 'observations.drumTurnsByHand', 'observations.drumUnusuallyFree'],
  'door-closed-latched': ['observations.doorLocks'], waterRemaining: ['observations.waterRemaining'], drumTurns: ['observations.drumTurns'],
  motorAudible: ['observations.motorAudible'], appliance: ['identity.appliance'], model: ['identity.model', 'identity.modelStatus'],
  resolution: ['reply.outcome'],
};
const NO_PART_FAMILIES = new Set(['LB', 'PG', 'SU', 'PL', 'ME']);
const HANDOFF = { LB: 'none', PG: 'none' };

function fixTurn(s) {
  let t = null;
  for (const c of ['load-check', 'programme-setting']) {
    const k = kit.chk(s, c);
    if (k && k.status === 'done' && (k.result === 'found_and_cleared' || k.result === 'found_not_cleared') && (t == null || k.turn > t)) t = k.turn;
  }
  return t;
}
const K = kit.makeKit({ checks: CHECKS, observations: OBS_TARGETS,
  outcomeObs: { 'empty-spin-test': 'spinsEmpty', 'spin-command': 'commandedSpin' }, resetAfter: { 'spin-command': fixTurn } });
const { obs, obsTurn, chk, blocked, askable, settled, modelKnown, modelAskable, problemOf, counted } = K;

function spinStale(s) { const f = fixTurn(s); const t = obsTurn(s, 'commandedSpin'); return t == null || (f != null && t < f); }
function retestDue(s) {
  const f = fixTurn(s);
  return f != null && spinStale(s) && !rq.requestsFor(s, 'spin-command').some((r) => r.askedTurn >= f) && !blocked(s, 'spin-command');
}

function entry(s, diag) {
  const P = problemOf(s);
  const appliance = s.identity.appliance && s.identity.appliance.value;
  const journey = P && P.journey ? P.journey.value : null;
  const E1 = appliance === 'washing-machine' && ['working', 'established'].includes(s.identity.applianceEstablishment);
  const codeArea = diag && diag.codeFault;
  const isJ2 = J2_JOURNEYS.has(journey)
    || (journey === 'error-code-only' && ['unbalanced-load', 'tacho', 'hall-sensor', 'motor-triac', 'motor-current', 'motor-drum'].includes(codeArea));
  // Drain first: retained water belongs to Journey 1 (its entry claims not-spinning + waterRemaining=true).
  const drainOwned = obs(s, 'waterRemaining') === true;
  const E2 = isJ2 && !drainOwned;
  const E3 = Boolean(P && (P.status === 'active' || P.status === 'resolved'));
  if (!(E1 && E2 && E3) && E1 && !drainOwned && kit.effectiveSafety(s).stop
      && (s.problems || []).some((p) => p.status === 'active' && p.journey && J2_JOURNEYS.has(p.journey.value))) {
    return { E1, E2: true, E3: true, candidate: true, applies: true, journey, appliance, safetyCarry: true, drainOwned };
  }
  const candidate = (appliance === 'washing-machine' || appliance == null) && isJ2;
  return { E1, E2, E3, candidate, applies: E1 && E2 && E3, journey, appliance: appliance || null, drainOwned };
}

function partGate(s, diag, partLookup) {
  const d = diag || {};
  const failed = [];
  const pe = d.partEvidence || { sufficient: false };
  const comp = pe.component || null;
  const arch = d.architecture || { drive: 'unknown', motor: 'unknown' };
  if (!modelKnown(s)) failed.push('Q1-model-not-known');
  if (s.resolution === 'resolved' || d.likelyResolved) failed.push('Q2-resolved-or-likely');
  if (!pathExhausted(s, d)) failed.push('Q3-accessible-path-not-settled');
  const lookupOk = Boolean(partLookup && partLookup.available === true && (!partLookup.component || partLookup.component === comp));
  if (comp === 'drive-belt' && !(arch.drive !== 'direct' && (arch.drive === 'belt' || lookupOk))) failed.push('Q4-architecture-no-belt');
  if (comp === 'carbon-brushes' && arch.motor !== 'brushed') failed.push('Q4-architecture-not-brushed');
  if (!pe.sufficient) failed.push('Q5-evidence-insufficient');
  if (!lookupOk) failed.push('Q6-no-compatible-part');
  if (kit.effectiveSafety(s).stop) failed.push('Q7-active-safety');
  return { eligible: failed.length === 0, component: comp, failed };
}

function action(kind, target, reason, rule, extra = {}) {
  return { kind, target, reason, requires: [], expects: [], pending: null, conclusion: null, journey: JOURNEY, rule, requestKind: null, ...extra };
}
const kindFor = (s, t, retest) => (retest ? 'retest' : (counted(s, t).length ? 'reoffer' : 'ask'));
function askCheck(s, t, reason, rule, retest = false) {
  return action('ask_check', t, reason, rule, { requires: REQUIRES[t].slice(), expects: EXPECTS[t].slice(), requestKind: kindFor(s, t, retest),
    pending: { slot: 'CHECK', target: t, purpose: 'DIAGNOSIS' } });
}
function askObs(s, t, reason, rule) {
  return action('ask_observation', t, reason, rule, { requires: (REQUIRES[t] || []).slice(), expects: EXPECTS[t].slice(), requestKind: kindFor(s, t),
    pending: { slot: 'OBSERVATION', target: t, purpose: 'DIAGNOSIS' } });
}
function askIdentity(s, t, reason, rule) {
  return action('ask_identity', t, reason, rule, { expects: EXPECTS[t].slice(), requestKind: kindFor(s, t),
    pending: { slot: 'IDENTITY', target: t, purpose: t === 'model' ? 'PART_FIT' : 'DIAGNOSIS' } });
}
function alternativesOf(d) {
  const r = d.rank || [];
  if (!r.length || (d.leader && d.leader.committed)) return [];
  return r.slice(1).filter((x) => r[0].score - x.score < 2 && x.score >= 0).map((x) => x.family);
}
function conclude(s, d, cause, level, confidence, handoff, reason, rule, extra = {}) {
  return action('conclude', cause, reason, rule, {
    conclusion: { cause, level, confidence, handoff, alternatives: [], architecture: d.architecture || null, ...(extra.conclusion || {}) },
    ...(extra.rest || {}) });
}
const confirmPending = (s) => (askable(s, 'resolution') ? { slot: 'OBSERVATION', target: 'resolution', purpose: 'CONFIRM' } : null);

/** The next owner step for the branch, or null when the accessible path is exhausted. */
function nextStep(s, d) {
  const has = (f) => (d.facts || []).includes(f);
  // A door that will not lock stops the machine starting: drive / hand checks add nothing once DL is committed.
  if (d.leader && d.leader.key === 'DL' && d.leader.committed) return null;
  const turns = has('drumTurnsWash') || (!has('drumStill') && settled(s, 'drumTurns'));
  if (!turns && !has('drumStill')) return null; // caller asks drumTurns first
  if (turns) {
    const loadSignals = has('redistributes') || has('vibration') || obs(s, 'loadDependent') === true;
    if (loadSignals && askable(s, 'load-check')) return () => askCheck(s, 'load-check', 'load-balance-suspected', 'S11');
    if (!has('emptySpinOk') && !has('emptySpinFails') && !has('spinOnCommand') && askable(s, 'empty-spin-test')) {
      return () => askCheck(s, 'empty-spin-test', 'empty-spin-separates-load-from-machine', 'S12');
    }
    if (has('emptySpinOk') || has('spinOnCommand')) {
      if (askable(s, 'load-check')) return () => askCheck(s, 'load-check', 'machine-spins-so-check-load', 'S13');
      if (askable(s, 'programme-setting')) return () => askCheck(s, 'programme-setting', 'machine-spins-so-check-setting', 'S13');
      return null;
    }
    if (askable(s, 'drum-by-hand')) return () => askCheck(s, 'drum-by-hand', 'hand-rotation-separates-drive-from-mechanics', 'S14');
    return null;
  }
  if (askable(s, 'drum-by-hand')) return () => askCheck(s, 'drum-by-hand', 'hand-rotation-separates-belt-motor-mechanics', 'S15');
  if (!has('handResist') && obs(s, 'motorAudible') == null && askable(s, 'motorAudible')) {
    return () => askObs(s, 'motorAudible', 'motor-sound-separates-belt-from-motor', 'S16');
  }
  return null;
}
function pathExhausted(s, d) {
  const has = (f) => (d.facts || []).includes(f);
  if (!has('drumTurnsWash') && !has('drumStill') && askable(s, 'drumTurns')) return false;
  return nextStep(s, d) === null;
}

function policy(s, diag, ctx = {}) {
  const d = diag || {};
  const has = (f) => (d.facts || []).includes(f);
  const en = entry(s, d);
  const appliance = en.appliance;

  const saf = kit.effectiveSafety(s);
  if (saf.stop) return action('safety_stop', saf.hazard, 'active-hazard', 'S1', { requires: (kit.SAFETY_REQUIRES[saf.hazard] || ['stop_use']).slice() });
  if (s.resolution === 'resolved') {
    const cause = has('loadCorrected') ? 'load-imbalance' : (has('programmeCorrected') ? 'programme-setting' : null);
    return action('close_resolved', cause, 'resolved', 'S2', { conclusion: { cause, level: 'cause_family', confidence: 'likely', handoff: 'none', alternatives: [] } });
  }
  if (en.drainOwned) return action('exit_journey', 'wm-not-draining', 'drain-first', 'S3');
  if ((appliance && appliance !== 'washing-machine') || !en.candidate || d.noViableCause) {
    return action('exit_journey', appliance === 'washer-dryer' ? 'washer-dryer' : 'router', 'wrong-journey', 'S3');
  }
  if (!appliance) return askIdentity(s, 'appliance', 'appliance-unknown', 'S4');
  if (!has('drainsOk') && obs(s, 'waterRemaining') == null && askable(s, 'waterRemaining')) {
    return askObs(s, 'waterRemaining', 'drain-state-decides-path', 'S5');
  }
  const L = d.leader;
  if (L && L.key === 'ME' && L.committed) {
    return conclude(s, d, 'mechanical-resistance', 'cause_family', 'likely', 'engineer', 'mechanical-resistance-found', 'S6');
  }
  if (obs(s, 'doorLocks') === false && askable(s, 'door-closed-latched')) {
    return askCheck(s, 'door-closed-latched', 'door-lock-not-confirming', 'S7');
  }
  if (retestDue(s)) return askCheck(s, 'spin-command', 'retest-after-fix', 'S8', true);
  if (d.likelyResolved && L) {
    return conclude(s, d, L.family, 'cause_family', 'likely', 'none', 'fix-restored-spin', 'S9',
      { rest: { pending: confirmPending(s), expects: EXPECTS.resolution.slice() } });
  }
  if (!has('drumTurnsWash') && !has('drumStill') && askable(s, 'drumTurns')) {
    return askObs(s, 'drumTurns', 'drum-movement-decides-branch', 'S10');
  }
  const step = nextStep(s, d);
  if (step) return step();

  const faultRemains = s.resolution !== 'resolved' && !d.likelyResolved;
  const arch = d.architecture || { drive: 'unknown', motor: 'unknown' };
  const alts = alternativesOf(d);
  const modelUseful = L && (['DL', 'BT', 'MB'].includes(L.key)
    || (L.key === 'MD' && (arch.drive === 'unknown' || arch.motor === 'unknown') && alts.some((a) => a === 'drive-belt' || a === 'motor-brushes')));
  if (faultRemains && modelUseful && modelAskable(s)) return askIdentity(s, 'model', 'model-decides-architecture-and-fit', 'S17');
  const gate = partGate(s, d, ctx.partLookup || null);
  if (gate.eligible) {
    return action('recommend_part', gate.component, 'part-gate-met', 'S18', {
      conclusion: { cause: L.family, level: 'component', confidence: 'likely', handoff: 'none', component: gate.component, alternatives: [], architecture: arch } });
  }
  if (!L) return action('exit_journey', 'router', 'wrong-journey', 'S3');
  const noPart = NO_PART_FAMILIES.has(L.key);
  return conclude(s, d, L.family, L.level, L.committed ? 'likely' : 'possible', HANDOFF[L.key] || 'engineer',
    'best-supported-conclusion', 'S19', { conclusion: { component: L.level === 'component' ? L.component : null, alternatives: alts, noPart } });
}

module.exports = { JOURNEY, REQUIRES, CHECKS, policy, entry, partGate, _helpers: { askable, blocked, settled, pathExhausted, retestDue, fixTurn, nextStep } };
