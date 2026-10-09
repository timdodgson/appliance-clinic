'use strict';
/**
 * Journey 1 policy — washing machine · not draining. PURE, deterministic.
 *
 *   policy(state, diag, {partLookup}) -> NextAction        (journey doc §6–§7, §15 contract)
 *   entry(state, diag)                -> {candidate, applies, ...}  (§2 E1–E3)
 *   partGate(state, diag, partLookup) -> {eligible, component, failed[]}  (§14 P1–P7 + evidence doc §10)
 *
 * Reads ONLY cs/1 state, the structured diagnostics output (j1-diagnostics.diagnose) and the typed part
 * lookup. No prose, transcript, Jev output or regex. Exactly one NextAction; the first matching rule wins.
 */

const rq = require('./requests.js');
const kit = require('./policy-kit.js');

const JOURNEY = 'wm-not-draining';
const { STICKY, SAFETY_REQUIRES, effectiveSafety } = kit;
const CHECKS = ['drain-filter', 'drain-command', 'pump-impeller', 'drain-hose'];
const OBS_TARGETS = ['waterRemaining', 'pumpHumming', 'waterReturnsAfterDrain'];

// §9 typed safety requirements carried on NextAction.requires (COMPOSE may not drop any).
const REQUIRES = {
  'drain-filter': ['isolate_mains', 'let_hot_water_cool', 'contain_water', 'open_slowly', 'do_not_force'],
  'drain-command': ['keep_clear_of_socket_if_water_near', 'door_stays_locked_until_empty'],
  'pump-impeller': ['isolate_mains', 'filter_already_removed', 'no_tools_beyond_housing', 'no_panel_removal'],
  'drain-hose': ['isolate_mains', 'machine_heavy_may_hold_water', 'contain_water', 'do_not_disconnect_under_load'],
};
const EXPECTS = {
  'drain-filter': ['checks.drain-filter', 'checks.pump-impeller'],
  'drain-command': ['observations.commandedDrain', 'observations.pumpHumming'],
  'pump-impeller': ['checks.pump-impeller'],
  'drain-hose': ['checks.drain-hose'],
  pumpHumming: ['observations.pumpHumming'],
  waterRemaining: ['observations.waterRemaining'],
  appliance: ['identity.appliance'],
  model: ['identity.model', 'identity.modelStatus'],
  resolution: ['reply.outcome'],
};
const CLEARED_CAUSE = { 'drain-filter': 'filter-blockage', 'pump-impeller': 'impeller-obstruction', 'drain-hose': 'hose-or-waste-restriction' };

function cleared(s) {
  let t = null;
  for (const c of ['drain-filter', 'pump-impeller', 'drain-hose']) {
    const k = kit.chk(s, c);
    if (k && k.status === 'done' && k.result === 'found_and_cleared' && (t == null || k.turn > t)) t = k.turn;
  }
  return t;
}
// Shared G2 request predicates; a new clearance resets drain-command (§6.5 retest).
const K = kit.makeKit({ checks: CHECKS, observations: OBS_TARGETS, outcomeObs: { 'drain-command': 'commandedDrain' },
  resetAfter: { 'drain-command': cleared } });
const { obs, obsTurn, chk, res, done, counted, blocked, askable, settled, modelKnown, modelAskable, problemOf } = K;

function cmdStale(s) { const c = cleared(s); const ct = obsTurn(s, 'commandedDrain'); return ct == null || (c != null && ct < c); }
function retestDue(s) {
  const c = cleared(s);
  return cmdStale(s) && c != null && !rq.requestsFor(s, 'drain-command').some((r) => r.askedTurn >= c);
}
const filterOpen = (s) => done(s, 'drain-filter');
const componentSeen = (s) => res(s, 'drain-filter') === 'fault_seen' || res(s, 'pump-impeller') === 'fault_seen';
function pathExhausted(s) {
  const hum = obs(s, 'pumpHumming');
  return settled(s, 'drain-filter')
    && (!filterOpen(s) || settled(s, 'pump-impeller'))
    && (hum === false || obs(s, 'commandedDrain') === true || settled(s, 'drain-hose'))
    && (!cmdStale(s) || settled(s, 'drain-command'));
}

// ---- entry (§2) ------------------------------------------------------------------------------------------
function entry(s, diag) {
  const P = problemOf(s);
  const appliance = s.identity.appliance && s.identity.appliance.value;
  const journey = P && P.journey ? P.journey.value : null;
  const domain = P && P.faultDomain ? P.faultDomain.value : null;
  const wr = obs(s, 'waterRemaining');
  const codeArea = diag && diag.codeArea;
  const E1 = appliance === 'washing-machine' && ['working', 'established'].includes(s.identity.applianceEstablishment);
  const E2 = journey === 'not-draining'
    // batch 2: a door stuck locked / a noisy drain with water left in the drum is a drain problem first (handoff).
    || (['not-spinning', 'cycle-not-completing', 'door-problem', 'noisy'].includes(journey) && wr === true)
    || (journey === 'error-code-only' && (codeArea === 'not-draining' || codeArea === 'drain-pump'));
  const E3 = Boolean(P && (P.status === 'active' || P.status === 'resolved'));
  // Safety continuity: a hazard reported mid-journey can arrive typed as an ADDITIONAL problem (e.g. water
  // reaching the socket typed as `leaking`). If Journey 1 is still an active problem of this washing machine
  // and the (sticky) safety stop applies, Journey 1 keeps the turn so R1 owns it.
  if (!(E1 && E2 && E3) && E1 && effectiveSafety(s).stop
      && (s.problems || []).some((p) => p.status === 'active' && p.journey && p.journey.value === 'not-draining')) {
    return { E1, E2: true, E3: true, candidate: true, applies: true, journey: 'not-draining', appliance, safetyCarry: true };
  }
  const preEntry = ['not-spinning', 'cycle-not-completing', null].includes(journey) && ['water', null].includes(domain) && wr == null;
  const candidate = (appliance === 'washing-machine' || appliance == null) && (E2 || preEntry);
  return { E1, E2, E3, candidate, applies: E1 && E2 && E3, journey, appliance: appliance || null };
}

// ---- part gate (§14) -------------------------------------------------------------------------------------------
function partGate(s, diag, partLookup) {
  const failed = [];
  const pe = (diag && diag.partEvidence) || { sufficient: false };
  const hum = obs(s, 'pumpHumming');
  if (!modelKnown(s)) failed.push('P1-model-not-known');
  if (s.resolution === 'resolved' || (diag && diag.likelyResolved)) failed.push('P2-resolved-or-likely');
  const p3 = settled(s, 'drain-filter') && (!filterOpen(s) || settled(s, 'pump-impeller')) && (hum === false || settled(s, 'drain-hose'));
  if (!p3) failed.push('P3-accessible-path-not-settled');
  if (!(obs(s, 'commandedDrain') === false || componentSeen(s) || res(s, 'drain-hose') === 'fault_seen')) failed.push('P4-no-commanded-fail-or-seen-damage');
  if (!pe.sufficient) failed.push('P5-evidence-insufficient');
  const comp = pe.component || null;
  if (!(partLookup && partLookup.available === true && (!partLookup.component || partLookup.component === comp))) failed.push('P6-no-compatible-part');
  if (effectiveSafety(s).stop) failed.push('P7-active-safety');
  return { eligible: failed.length === 0, component: comp, failed };
}

// ---- NextAction builders -------------------------------------------------------------------------------------------
function action(kind, target, reason, rule, extra = {}) {
  return {
    kind, target, reason, requires: [], expects: [], pending: null, conclusion: null,
    journey: JOURNEY, rule, requestKind: null, ...extra,
  };
}
function requestKindFor(s, t, retest) {
  if (retest) return 'retest';
  return counted(s, t).length ? 'reoffer' : 'ask';
}
function askCheck(s, t, reason, rule, retest = false) {
  return action('ask_check', t, reason, rule, {
    requires: REQUIRES[t].slice(), expects: EXPECTS[t].slice(), requestKind: requestKindFor(s, t, retest),
    pending: { slot: 'CHECK', target: t, purpose: 'DIAGNOSIS' },
  });
}
function askObservation(s, t, reason, rule) {
  return action('ask_observation', t, reason, rule, {
    expects: EXPECTS[t].slice(), requestKind: requestKindFor(s, t), pending: { slot: 'OBSERVATION', target: t, purpose: 'DIAGNOSIS' },
  });
}
function askIdentity(s, t, reason, rule) {
  return action('ask_identity', t, reason, rule, {
    expects: EXPECTS[t].slice(), requestKind: requestKindFor(s, t),
    pending: { slot: 'IDENTITY', target: t, purpose: t === 'model' ? 'PART_FIT' : 'DIAGNOSIS' },
  });
}
function handoffFor(family) {
  if (family === 'household-waste-backflow') return 'plumbing';
  if (family === 'excess-suds') return 'none';
  return 'engineer';
}
function alternativesOf(diag) {
  const r = (diag && diag.rank) || [];
  if (!r.length || (diag.leader && diag.leader.committed)) return [];
  const alts = r.slice(1).filter((x) => r[0].score - x.score < 2).map((x) => x.family);
  if ((diag.facts || []).includes('drainPathClearPumpSilent') && r.some((x) => x.family === 'control') && !alts.includes('control')) alts.push('control');
  return alts;
}
function conclude(cause, level, confidence, handoff, reason, rule, extra = {}) {
  return action('conclude', cause, reason, rule, { conclusion: { cause, level, confidence, handoff, alternatives: [], ...(extra.conclusion || {}) }, ...(extra.rest || {}) });
}
function confirmPending(s) {
  return askable(s, 'resolution') ? { slot: 'OBSERVATION', target: 'resolution', purpose: 'CONFIRM' } : null;
}

// ---- policy (§7) ---------------------------------------------------------------------------------------------------------
function policy(s, diag, ctx = {}) {
  const d = diag || {};
  const en = entry(s, d);
  const appliance = en.appliance;
  const cmd = obs(s, 'commandedDrain');
  const hum = obs(s, 'pumpHumming');

  // R1 safety_stop (after journey stickiness)
  const saf = effectiveSafety(s);
  if (saf.stop) {
    return action('safety_stop', saf.hazard, 'active-hazard', 'R1', { requires: (SAFETY_REQUIRES[saf.hazard] || ['stop_use']).slice() });
  }
  // R2 close_resolved
  if (s.resolution === 'resolved') {
    let cause = null; let turn = -1;
    for (const c of ['drain-filter', 'pump-impeller', 'drain-hose']) {
      const k = chk(s, c);
      if (k && k.status === 'done' && k.result === 'found_and_cleared' && k.turn > turn) { cause = CLEARED_CAUSE[c]; turn = k.turn; }
    }
    if (!cause && obs(s, 'excessiveFoam') === true) cause = 'excess-suds';
    return action('close_resolved', cause, 'resolved', 'R2', { conclusion: { cause, level: 'cause_family', confidence: 'likely', handoff: 'none', alternatives: [] } });
  }
  // R3 exit_journey
  if ((appliance && appliance !== 'washing-machine') || !en.candidate || d.noViableCause) {
    const target = appliance === 'washer-dryer' ? 'washer-dryer' : (appliance === 'dishwasher' ? 'dishwasher-not-draining' : 'router');
    return action('exit_journey', target, 'wrong-journey', 'R3');
  }
  // R4 appliance unknown
  if (!appliance) return askIdentity(s, 'appliance', 'appliance-unknown', 'R4');
  // R5 water state decides the journey
  if (!en.E2 && obs(s, 'waterRemaining') == null && askable(s, 'waterRemaining')) {
    return askObservation(s, 'waterRemaining', 'water-state-decides-journey', 'R5');
  }
  // R6 found but not cleared
  if (res(s, 'drain-filter') === 'found_not_cleared' || res(s, 'pump-impeller') === 'found_not_cleared') {
    return conclude('obstruction-beyond-reach', 'cause_family', 'likely', 'engineer', 'cleared-cause-beyond-reach', 'R6');
  }
  if (res(s, 'drain-hose') === 'found_not_cleared') {
    return conclude('hose-or-waste-restriction', 'cause_family', 'likely', 'plumbing', 'cleared-cause-beyond-reach', 'R6');
  }
  // R6a household waste / backflow
  if (obs(s, 'waterReturnsAfterDrain') === true && d.leader && d.leader.family === 'household-waste-backflow') {
    return conclude('household-waste-backflow', 'cause_family', 'likely', 'plumbing', 'best-supported-conclusion', 'R6a');
  }
  // R7 filter first (L1)
  if (askable(s, 'drain-filter') && !filterOpen(s)) {
    return askCheck(s, 'drain-filter', 'first-safe-high-value-check', 'R7');
  }
  // R7b a noise while it tries to drain points at the pump / filter area: the filter stays the next step (not the
  // downstream hose) while it is not done or declined, offered at most three times.
  if (obs(s, 'noiseOnDrain') === true && !filterOpen(s) && !done(s, 'drain-filter') && !blocked(s, 'drain-filter')
    && counted(s, 'drain-filter').length < 3) {
    return askCheck(s, 'drain-filter', 'drain-noise-points-to-pump-area', 'R7b');
  }
  // R8 drain command (ask / reoffer / retest), always after the filter is settled
  if (settled(s, 'drain-filter') && !d.likelyResolved) {
    if (retestDue(s) && !blocked(s, 'drain-command')) return askCheck(s, 'drain-command', 'retest-after-clearance', 'R8', true);
    if (cmd == null && askable(s, 'drain-command')) {
      return askCheck(s, 'drain-command', cleared(s) != null ? 'retest-after-clearance' : 'commanded-drain-informs-pump-and-path', 'R8');
    }
  }
  // R9 likely fixed (L7) — not resolved until the customer confirms
  if (d.likelyResolved && d.leader) {
    return conclude(d.leader.family, 'cause_family', 'likely', 'none', 'clearance-restored-drain', 'R9', { rest: { pending: confirmPending(s), expects: EXPECTS.resolution.slice() } });
  }
  // R9a excess foam cleared by a rinse/spin (L4)
  if (obs(s, 'excessiveFoam') === true && d.leader && d.leader.family === 'excess-suds' && cmd === true) {
    return conclude('excess-suds', 'cause_family', 'likely', 'none', 'best-supported-conclusion', 'R9a', { rest: { pending: confirmPending(s), expects: EXPECTS.resolution.slice() } });
  }
  // R10 pump sound
  if (cmd === false && hum == null && askable(s, 'pumpHumming')) return askObservation(s, 'pumpHumming', 'pump-sound-decides-path', 'R10');
  // R11 impeller through the open filter housing
  if (cmd !== true && filterOpen(s) && askable(s, 'pump-impeller') && !componentSeen(s)) {
    return askCheck(s, 'pump-impeller', 'impeller-via-open-filter', 'R11');
  }
  // R12 drain hose (humming or unknown)
  if (cmd !== true && hum !== false && askable(s, 'drain-hose')) return askCheck(s, 'drain-hose', 'downstream-restriction-with-hum', 'R12');

  const reachedEnd = pathExhausted(s) || componentSeen(s) || cmd === true;
  const faultRemains = s.resolution !== 'resolved' && !d.likelyResolved;
  // R13 model required now
  if (reachedEnd && faultRemains && modelAskable(s)) return askIdentity(s, 'model', 'model-required-for-remaining-causes', 'R13');
  // R14 part gate
  const gate = partGate(s, d, ctx.partLookup || null);
  if (gate.eligible) {
    return action('recommend_part', gate.component, 'part-gate-met', 'R14', {
      conclusion: { cause: d.leader.family, level: 'component', confidence: 'likely', handoff: 'none', component: gate.component, alternatives: [] },
    });
  }
  const leader = d.leader;
  if (!leader) return action('exit_journey', 'router', 'wrong-journey', 'R3');
  // R15 best-supported conclusion
  if (reachedEnd && (modelKnown(s) || !modelAskable(s))) {
    return conclude(leader.family, leader.level, leader.committed ? 'likely' : 'possible', handoffFor(leader.family),
      'best-supported-conclusion', 'R15', { conclusion: { component: leader.level === 'component' ? leader.component : null, alternatives: alternativesOf(d) } });
  }
  // R16 fallback: nothing askable, path not provably exhausted
  return conclude(leader.family, 'cause_family', 'possible', 'engineer', 'nothing-askable', 'R16', { conclusion: { alternatives: alternativesOf(d) } });
}

module.exports = {
  JOURNEY, REQUIRES, STICKY, policy, entry, partGate, effectiveSafety,
  _helpers: { askable, blocked, settled, pathExhausted, retestDue, cmdStale, cleared, modelKnown, modelAskable, counted },
};
