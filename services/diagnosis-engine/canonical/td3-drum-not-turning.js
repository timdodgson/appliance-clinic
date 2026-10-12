'use strict';
/**
 * Tumble dryer journey 3 — drum not turning (rules DT1–DT22). PURE, deterministic.
 * Design: docs/diagnostics/ff-td-batch-evidence.md §TD3. A door that is not recognised → td-door-not-starting (once).
 *   motor heard? → overload / bulky item → drum by hand (unplugged):
 *     motor runs + drum unusually free (or the owner sees the belt off / snapped) → drive belt (part ONLY with a confirmed
 *       dryer model whose part list has the belt; never a washing-machine belt)
 *     drum stiff / seized → rollers / bearing / jammed item (engineer)
 *     motor silent, drum normal by hand → motor / control (engineer; never a motor part)
 */
const engine = require('./evidence-engine.js');
const kit = require('./policy-kit.js');
const JP = require('./journey-pipeline.js');
const F = require('./td-family.js');
const ck = require('./compose-kit.js');
const { SS, S, A, SA } = engine;

const KEY = 'td-drum-not-turning';
const FAMILY = { OL: 'overload-or-bulky-item', BT: 'drive-belt', MS: 'drum-seized-rollers-or-bearing', MT: 'motor-or-control' };
const SIGNALS = {
  OL: { loadFixed: SS, restoredAfterLoadFix: SS, failsAfterLoadFix: SA, loadOk: SA },
  BT: { beltSeen: SS, beltSign: SS, motor: S, free: S, silent: SA, stiff: SA },
  MS: { stiff: SS, motor: S, free: SA, byHandOk: SA },
  MT: { silent: S, byHandOk: S, loadOk: S, motor: SA, free: A, beltSeen: SA },
};
const FACT_LABEL = { motor: 'motor heard running', silent: 'no motor sound', free: 'drum spins very freely by hand', stiff: 'drum stiff / seized by hand', byHandOk: 'drum turns normally by hand',
  beltSeen: 'belt seen off / snapped', beltSign: 'motor runs and the drum is free', loadFixed: 'overloaded / bulky item (changed)', loadOk: 'normal load' };
const SPEC = {
  schema: 'td3-diag/1', FAMILY, PRIOR: ['OL', 'BT', 'MS', 'MT'], SIGNALS, FACT_LABEL,
  obs: { motor: ['motorAudible', true], silent: ['motorAudible', false], free: ['drumUnusuallyFree', true] },
  checks: { 'load-check': { clear: 'loadOk', found: 'loadFixed' }, 'drum-by-hand': { clear: 'byHandOk' }, 'drive-belt': { fault: 'beltSeen' } },
  FIX_CHECK: { OL: ['load-check', 'Load'] },
  DECISIVE_PART: { BT: { beltSeen: 'drive-belt', beltSign: 'drive-belt' } },
  architecture: (s, ctx) => F.tdArchitecture(s, ctx),
  extra(s, ctx, on) {
    const free = engine.obsVal(s, 'drumUnusuallyFree') === true;
    on('beltSign', engine.obsVal(s, 'motorAudible') === true && free);
    // an explicit "spins very easily" outranks a by-hand result recorded as a fault in the same report
    const hand = engine.checkResult(s, 'drum-by-hand');
    on('stiff', hand === 'fault_seen' && !free); on('byHandOk', hand === 'fault_seen' && free);
  },
};
function diagnose(state, ctx = {}) {
  const codeFault = ctx.codeFault !== undefined ? ctx.codeFault : F.tdCodeFault(state, ctx.errorCodes || null);
  return engine.diagnoseSpec(SPEC, state, { ...ctx, codeFault });
}
const P = kit.makeStepPolicy({
  JOURNEY: KEY, P: 'DT', appliance: 'tumble-dryer', journeys: ['drum-not-turning'], ...F.owns(KEY), declineUnsafe: F.UNSAFE,
  CHECKS: ['load-check', 'drum-by-hand'],
  OBS_TARGETS: { motorAudible: ['motorAudible'], drumUnusuallyFree: ['drumUnusuallyFree'] },
  REQUIRES: { motorAudible: ['do_not_open_or_reach_in_while_running'], 'load-check': [], 'drum-by-hand': ['td_unplug_cool', 'turn_by_hand_only'], drumUnusuallyFree: [], retest: [] },
  FIX_CHECKS: ['load-check'],
  steps: [
    { n: 10, target: 'motorAudible', reason: 'motor-heard-or-silent', when: (h) => !h.has('motor') && !h.has('silent') && !h.has('beltSeen') },
    { n: 11, target: 'load-check', reason: 'overload-bulky-item', when: (h) => !h.has('beltSeen') },
    { n: 12, target: 'drum-by-hand', reason: 'drum-by-hand-free-stiff', when: (h) => !h.has('beltSeen') && !h.has('free') },
    { n: 13, target: 'drumUnusuallyFree', reason: 'free-drum-means-belt', when: (h) => h.has('motor') && h.has('byHandOk') && h.obs('drumUnusuallyFree') == null },
  ],
  PART_FAMILIES: new Set(['BT']),
  HANDOFF: { OL: 'none', BT: 'engineer', MS: 'engineer', MT: 'engineer' },
});
const pipeline = JP.makeModelPartPipeline({
  D: { diagnose }, P, schema: 'td3/1', codeFaultFor: F.tdCodeFault,
  PART_MATCH: { 'drive-belt': { re: /\bbelt\b|\b\d{3,4}\s*\d*\s*rib\b|poly\s*-?\s*v\b/i, not: /washing|washer|agitator|motor|pulley|tensioner|jockey|idler|wheel/i } },
  MEDIA_BY_KEY: {},
});

// ---- COMPOSE (wording only) ----
const FAMILY_LABEL = { 'overload-or-bulky-item': 'an overloaded drum or a bulky item', 'drive-belt': 'the drive belt', 'drum-seized-rollers-or-bearing': 'the drum rollers, bearing or something jammed',
  'motor-or-control': 'the motor or its control' };
const COMPONENT_LABEL = { 'drive-belt': 'dryer drive belt' };
const TASK = {
  'ask_observation:motorAudible': { say: 'Start a programme and listen for a few seconds.', ask: 'Can you hear the motor humming or running even though the drum doesn\'t turn, or is it silent?' },
  'ask_check:load-check': { say: 'An overloaded drum or one big heavy item (a duvet or rug) can stop the drum turning.', ask: 'Was it overloaded or a single bulky item (and have you taken some out), or was it a normal load?' },
  'ask_check:drum-by-hand': { say: 'With the dryer unplugged and empty, turn the drum slowly by hand.', ask: 'Does it turn normally, does it feel stiff or stuck, or does it spin round very easily with no resistance at all?' },
  'ask_observation:drumUnusuallyFree': { say: 'One detail matters here.', ask: 'Does the drum spin round much more easily than you\'d expect — almost no resistance at all?' },
  'ask_check:retest': { say: 'Run a short programme with a normal load.', ask: 'Is the drum turning now, or still not?' },
  'ask_identity:model': { say: 'To match the right belt for your dryer I need its exact model.', ask: 'Could you send me the model number? It\'s on the rating plate inside the door rim or on the back — a photo is fine.' },
  'ask_identity:appliance': { say: '', ask: 'Is it a tumble dryer or a washer-dryer?' },
};
const CONCLUSION = {
  'DT7:overload-or-bulky-item': 'That was the load, so no part is needed. Keep loads to about two-thirds of the drum.',
  'drum-seized-rollers-or-bearing': 'A drum that feels stiff or stuck by hand points to the rollers, the bearing or something jammed behind the drum. Please don\'t force it; an appliance engineer is the next step — I\'m not recommending a part from this.',
  'motor-or-control': 'With no motor sound and the drum turning normally by hand, the motor or its control is the likely area. That needs an appliance engineer to test safely — I\'m not recommending a part from this.',
  'drive-belt': 'A motor that runs with a drum that spins freely usually means the drive belt has snapped or come off. An appliance engineer can confirm it — I\'m not recommending a part from this.',
};
const compose = ck.createCompose({
  TASK, CONFIRM_ASK: 'Is the drum turning normally now?',
  OBS_COPY: { motorAudible: ['motor heard', 'no motor sound'], drumUnusuallyFree: ['drum spins very freely', null], faultPersists: ['still not turning', 'turning now'] },
  CHECK_RESULT_COPY: { 'load-check': { clear: 'normal load', found_and_cleared: 'load reduced' }, 'drum-by-hand': { clear: 'drum turns normally by hand', fault_seen: 'drum stiff / stuck' },
    'drive-belt': { fault_seen: 'belt off / snapped' } },
  statusChecks: [['retest', 'retest']],
  conclusionCopy: ck.makeConclusionCopy({ FAMILY_LABEL, COMPONENT_LABEL, CONCLUSION, fitNote: 'Unplug the dryer before fitting it — the belt sits behind a panel and is tight to fit, so if you\'d rather not, an appliance engineer can fit it.' }),
  PURCHASE_RE: /\b(buy|order|purchase|price|£\s?\d)|\b(new|replacement|replace the)\s+(belt|drive belt|motor|roller|bearing|pcb|control board|capacitor)\b/i,
});
module.exports = { SPEC, FAMILY, diagnose, P, ...pipeline, FAMILY_LABEL, COMPONENT_LABEL, TASK, REQUIREMENT: ck.REQUIREMENT, SAFETY_COPY: ck.SAFETY_COPY, ...compose };
