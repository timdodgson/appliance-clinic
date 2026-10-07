'use strict';
/**
 * Journey 3 policy — washing machine · water · leaking. PURE, deterministic.
 * Design: docs/diagnostics/wm-leaking-evidence.md §6 (rules L1–L16) and §7 (part gate K1–K7).
 *
 *   entry(state, diag) / policy(state, diag, {partLookup}) -> NextAction / partGate(state, diag, partLookup)
 * Reads ONLY cs/1, the Journey 3 diagnostics and the typed part lookup. Shared G2 request predicates (policy-kit).
 */
const rq = require('./requests.js');
const kit = require('./policy-kit.js');

const JOURNEY = 'wm-leaking';
const CHECKS = ['door-seal', 'detergent-drawer', 'detergent-dose', 'filter-seal', 'inlet-connection', 'drain-connection', 'leak-retest'];
const OBS_TARGETS = ['leakLocation', 'leakTiming'];
const { OBSERVATION_GROUPS } = rq;

const REQUIRES = {
  'door-seal': ['isolate_mains', 'wait_drum_stopped_door_unlocked', 'look_and_feel_only'],
  'detergent-drawer': ['isolate_mains'],
  'detergent-dose': [],
  'filter-seal': ['isolate_mains', 'contain_water', 'open_slowly', 'do_not_force'],
  'inlet-connection': ['isolate_mains', 'water_off_at_tap', 'hand_tight_only', 'machine_heavy_may_hold_water'],
  'drain-connection': ['isolate_mains', 'machine_heavy_may_hold_water', 'do_not_disconnect_under_load'],
  'leak-retest': ['watch_from_outside_only', 'stop_if_water_near_socket'],
  leakLocation: [], leakTiming: [],
};
const EXPECTS = {
  'door-seal': ['checks.door-seal'], 'detergent-drawer': ['checks.detergent-drawer'], 'detergent-dose': ['checks.detergent-dose'],
  'filter-seal': ['checks.filter-seal'], 'inlet-connection': ['checks.inlet-connection'], 'drain-connection': ['checks.drain-connection'],
  'leak-retest': ['observations.leakRecurs'], leakLocation: OBSERVATION_GROUPS.leakLocation.map((k) => `observations.${k}`),
  leakTiming: OBSERVATION_GROUPS.leakTiming.map((k) => `observations.${k}`),
  appliance: ['identity.appliance'], model: ['identity.model', 'identity.modelStatus'], resolution: ['reply.outcome'],
};
const PART_FAMILIES = new Set(['DS', 'IC', 'DC', 'FS', 'DR']);
const HANDOFF = { DS: 'engineer', DR: 'none', OS: 'none', FS: 'engineer', IC: 'plumbing', DC: 'plumbing', HB: 'plumbing',
  IV: 'engineer', PB: 'engineer', SH: 'engineer', TB: 'engineer' };
const FIX_CHECKS = ['door-seal', 'detergent-drawer', 'detergent-dose', 'filter-seal', 'inlet-connection', 'drain-connection'];

function fixTurn(s) {
  let t = null;
  for (const c of FIX_CHECKS) {
    const k = kit.chk(s, c);
    if (k && k.status === 'done' && (k.result === 'found_and_cleared' || k.result === 'found_not_cleared') && (t == null || k.turn > t)) t = k.turn;
  }
  return t;
}
const K = kit.makeKit({ checks: CHECKS, observations: [], outcomeObs: { 'leak-retest': 'leakRecurs' }, resetAfter: { 'leak-retest': fixTurn } });
const groupKnown = (s, g) => OBSERVATION_GROUPS[g].some((k) => kit.obs(s, k) === true);
const done = (s, t) => (OBS_TARGETS.includes(t) ? groupKnown(s, t) : K.done(s, t));
function askable(s, t) {
  if (OBS_TARGETS.includes(t)) {
    if (groupKnown(s, t) || K.blocked(s, t)) return false;
    const n = K.counted(s, t).length;
    return n === 0 || (n === 1 && kit.REOFFERABLE.has(rq.lastOutcome(s, t)));
  }
  return K.askable(s, t);
}
const settled = (s, t) => done(s, t) || K.blocked(s, t) || !askable(s, t);
const { obs, obsTurn, modelKnown, modelAskable, problemOf, counted } = K;

function retestDue(s) {
  const f = fixTurn(s); const t = obsTurn(s, 'leakRecurs');
  return f != null && (t == null || t < f) && !rq.requestsFor(s, 'leak-retest').some((r) => r.askedTurn >= f) && !K.blocked(s, 'leak-retest');
}
// A major leak FIRST reported in this message (first-assertion turn, not a restatement): contain it once before
// anything else (water off, power off only if safe); diagnosis continues on the next turn.
const majorLeakNow = (s) => {
  const f = s.evidence && s.evidence.observations && s.evidence.observations.majorLeak;
  return Boolean(f && f.value === true && f.turn === s.version);
};

function entry(s, diag) {
  const P = problemOf(s);
  const appliance = s.identity.appliance && s.identity.appliance.value;
  const journey = P && P.journey ? P.journey.value : null;
  const E1 = appliance === 'washing-machine' && ['working', 'established'].includes(s.identity.applianceEstablishment);
  const E2 = journey === 'leaking' || (journey === 'error-code-only' && diag && diag.codeFault === 'leak-flood');
  const E3 = Boolean(P && (P.status === 'active' || P.status === 'resolved'));
  if (!(E1 && E2 && E3) && E1 && kit.effectiveSafety(s).stop
      && (s.problems || []).some((p) => p.status === 'active' && p.journey && p.journey.value === 'leaking')) {
    return { E1, E2: true, E3: true, candidate: true, applies: true, journey, appliance, safetyCarry: true };
  }
  return { E1, E2, E3, candidate: (appliance === 'washing-machine' || appliance == null) && E2, applies: E1 && E2 && E3, journey, appliance: appliance || null };
}

/** Next accessible owner step, in research order (cheap, common, free fixes first), or null when exhausted. */
function nextStep(s, d) {
  const has = (f) => (d.facts || []).includes(f);
  const steps = [
    [has('atDoor') || (has('underneath') && has('onWash')), 'door-seal', 'front-leak-check-seal-first', 'L8'],
    [has('atDrawer') || has('drawerOverflow') || (has('atDoor') && has('sealOk')), 'detergent-drawer', 'drawer-overflow-clean-first', 'L9'],
    [has('foam') || (has('drawerCleaned') && has('drawerOverflow')) || has('drawerOk'), 'detergent-dose', 'foam-check-dose', 'L10'],
    [has('atFilter') || has('recentFilter') || (has('underneath') && has('onDrain')), 'filter-seal', 'filter-cap-seating-before-pump', 'L11'],
    [(has('atRear') && !has('onDrain')) || has('whenOff') || has('onFill') || has('recentInstall'), 'inlet-connection', 'supply-connection-check', 'L12'],
    [((has('atRear') || has('underneath')) && has('onDrain')) || (has('recentInstall') && !has('onFill')), 'drain-connection', 'drain-connection-check', 'L13'],
  ];
  for (const [cond, t, reason, rule] of steps) if (cond && askable(s, t)) return { t, reason, rule };
  return null;
}
function pathExhausted(s, d) {
  const has = (f) => (d.facts || []).includes(f);
  const whereKnown = groupKnown(s, 'leakLocation') || has('drawerOverflow') || has('backflow');
  if (!whereKnown && askable(s, 'leakLocation')) return false;
  if ((has('underneath') || has('atRear') || !whereKnown) && !groupKnown(s, 'leakTiming') && askable(s, 'leakTiming')) return false;
  return nextStep(s, d) === null && !retestDue(s);
}

function partGate(s, diag, partLookup) {
  const d = diag || {}; const pe = d.partEvidence || { sufficient: false }; const comp = pe.component || null;
  const failed = [];
  if (!modelKnown(s)) failed.push('K1-model-not-known');
  if (s.resolution === 'resolved' || d.likelyResolved) failed.push('K2-resolved-or-likely');
  if (!pathExhausted(s, d)) failed.push('K3-accessible-path-not-settled');
  if (!pe.sufficient) failed.push('K4-evidence-insufficient');
  if (!(partLookup && partLookup.available === true && (!partLookup.component || partLookup.component === comp))) failed.push('K5-no-compatible-part');
  if (kit.effectiveSafety(s).stop || majorLeakNow(s)) failed.push('K6-active-safety');
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
  return action('ask_observation', t, reason, rule, { expects: EXPECTS[t].slice(), requestKind: kindFor(s, t),
    pending: { slot: 'OBSERVATION', target: t, purpose: 'DIAGNOSIS' } });
}
function alternativesOf(d) {
  const r = d.rank || [];
  if (!r.length || (d.leader && d.leader.committed)) return [];
  return r.slice(1).filter((x) => r[0].score - x.score < 2 && x.score > 0).map((x) => x.family);
}
const confirmPending = (s) => (askable(s, 'resolution') ? { slot: 'OBSERVATION', target: 'resolution', purpose: 'CONFIRM' } : null);

function policy(s, diag, ctx = {}) {
  const d = diag || {};
  const has = (f) => (d.facts || []).includes(f);
  const en = entry(s, d);
  const appliance = en.appliance;
  const L = d.leader;

  const saf = kit.effectiveSafety(s);
  if (saf.stop) return action('safety_stop', saf.hazard, 'active-hazard', 'L1', { requires: (kit.SAFETY_REQUIRES[saf.hazard] || ['stop_use']).slice() });
  if (majorLeakNow(s)) return action('safety_stop', 'major-leak', 'uncontrolled-leak', 'L1', { requires: ['water_off_at_tap', 'power_off_only_if_dry', 'keep_clear_of_socket_if_water_near'] });
  if (s.resolution === 'resolved') {
    return action('close_resolved', L && L.committed ? L.family : null, 'resolved', 'L2', { conclusion: { cause: L && L.committed ? L.family : null, level: 'cause_family', confidence: 'likely', handoff: 'none', alternatives: [] } });
  }
  const locationKnown = groupKnown(s, 'leakLocation') || groupKnown(s, 'leakTiming') || has('backflow') || has('drawerOverflow');
  if ((appliance && appliance !== 'washing-machine') || !en.candidate || (d.noViableCause && locationKnown)) {
    return action('exit_journey', appliance === 'washer-dryer' ? 'washer-dryer' : 'router', 'wrong-journey', 'L3');
  }
  if (!appliance) return action('ask_identity', 'appliance', 'appliance-unknown', 'L4', { expects: EXPECTS.appliance.slice(), requestKind: kindFor(s, 'appliance'), pending: { slot: 'IDENTITY', target: 'appliance', purpose: 'DIAGNOSIS' } });
  // Household waste backs up: the plumbing, not the machine (no machine part).
  if (L && L.key === 'HB' && L.committed) {
    return action('conclude', 'household-backflow', 'household-waste-backflow', 'L5', { conclusion: { cause: 'household-backflow', level: 'cause_family', confidence: 'likely', handoff: 'plumbing', alternatives: [], noPart: true } });
  }
  // An owner fix is retested before narrowing further (the fix may have stopped it).
  if (retestDue(s)) return askCheck(s, 'leak-retest', 'retest-after-owner-fix', 'L14', true);
  const whereKnown = groupKnown(s, 'leakLocation') || has('drawerOverflow') || has('backflow');
  if (!whereKnown && askable(s, 'leakLocation')) return askObs(s, 'leakLocation', 'location-decides-source', 'L6');
  if ((has('underneath') || has('atRear') || !whereKnown) && !groupKnown(s, 'leakTiming') && askable(s, 'leakTiming')) {
    return askObs(s, 'leakTiming', 'timing-separates-supply-wash-drain', 'L7');
  }
  if (d.likelyResolved && L) {
    return action('conclude', L.family, 'owner-fix-stopped-leak', 'L15', { conclusion: { cause: L.family, level: 'cause_family', confidence: 'likely', handoff: 'none', alternatives: [], noPart: true },
      pending: confirmPending(s), expects: EXPECTS.resolution.slice() });
  }
  const step = nextStep(s, d);
  if (step) return askCheck(s, step.t, step.reason, step.rule);

  const faultRemains = s.resolution !== 'resolved' && !d.likelyResolved;
  if (faultRemains && L && L.committed && L.level === 'component' && PART_FAMILIES.has(L.key) && modelAskable(s)) {
    return action('ask_identity', 'model', 'model-required-for-part-fit', 'L16', { expects: EXPECTS.model.slice(), requestKind: kindFor(s, 'model'),
      pending: { slot: 'IDENTITY', target: 'model', purpose: 'PART_FIT' } });
  }
  const gate = partGate(s, d, ctx.partLookup || null);
  if (gate.eligible) {
    return action('recommend_part', gate.component, 'part-gate-met', 'L17', { conclusion: { cause: L.family, level: 'component', confidence: 'likely', handoff: 'none', component: gate.component, alternatives: [] } });
  }
  if (!L) return action('conclude', 'leak-source-unconfirmed', 'nothing-askable', 'L18', { conclusion: { cause: 'leak-source-unconfirmed', level: 'cause_family', confidence: 'possible', handoff: 'engineer', alternatives: [], noPart: true } });
  return action('conclude', L.family, 'best-supported-conclusion', 'L18', { conclusion: { cause: L.family, level: L.level, confidence: L.committed ? 'likely' : 'possible',
    handoff: HANDOFF[L.key] || 'engineer', component: L.level === 'component' ? L.component : null, alternatives: alternativesOf(d), noPart: !PART_FAMILIES.has(L.key) || L.level !== 'component' } });
}

module.exports = { JOURNEY, REQUIRES, CHECKS, policy, entry, partGate, _helpers: { askable, settled, pathExhausted, retestDue, fixTurn, nextStep, majorLeakNow } };
