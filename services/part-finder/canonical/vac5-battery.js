'use strict';
/**
 * Vacuum journey 5 — cordless battery / runtime / charging (rules VR1–VR22). PURE, deterministic.
 * Design: docs/diagnostics/final-migration-evidence.md §VAC5. A battery is recommended ONLY with runtime evidence and the
 * cheap causes ruled out by the owner:
 *   runtime vs won't-charge → charger, socket, light and contacts → (short runtime) boost / max mode → filters (a choked
 *   motor draws more) → short runtime from a full charge with the charger, mode and filters all fine = a worn battery
 *   (battery part with a confirmed model) · won't charge with the charging light never on → battery or charger (no part
 *   until a known-good charger tells them apart).
 */
const engine = require('./evidence-engine.js');
const kit = require('./policy-kit.js');
const JP = require('./journey-pipeline.js');
const F = require('./vac-family.js');
const ck = require('./compose-kit.js');
const { SS, S, SA } = engine;

const KEY = 'vacuum-battery-runtime';
const FAMILY = { CH: 'charger-socket-or-contacts', MX: 'boost-or-max-mode', AF: 'filters-choking-motor', CF: 'battery-or-charger-not-charging', BA: 'battery-worn' };
const RESTORED = { restoredAfterChFix: SA, restoredAfterProgFix: SA, restoredAfterFilterFix: SA };
const SIGNALS = {
  CH: { chFixed: SS, restoredAfterChFix: SS, failsAfterChFix: SA, chOk: SA, noCharge: S },
  MX: { progFixed: SS, restoredAfterProgFix: SS, failsAfterProgFix: SA, progOk: SA },
  AF: { filterFixed: SS, restoredAfterFilterFix: SS, failsAfterFilterFix: SA, filterOk: SA },
  CF: { chFault: SS, noCharge: S, chOk: SA, ...RESTORED },
  BA: { batteryFade: SS, shortRun: S, chOk: S, progOk: S, filterOk: S, corded: SA, runtimeNormal: SA, chFault: SA, ...RESTORED },
};
const FACT_LABEL = {
  shortRun: 'runs only a short time on a full charge', noCharge: 'will not charge', runtimeNormal: 'charges and runs its normal time',
  chFixed: 'charger / socket / contacts were the problem (sorted)', chFault: 'charging light never comes on', chOk: 'charger fine, light comes on',
  progFixed: 'was on boost / max mode (changed)', progOk: 'normal power mode', filterFixed: 'filters clogged (cleaned)', filterOk: 'filters clean and dry',
  batteryFade: 'short runtime with charger, mode and filters all fine', cordless: 'cordless', corded: 'corded', robot: 'robot',
};
const SPEC = {
  schema: 'vac5-diag/1', FAMILY, PRIOR: ['CH', 'MX', 'AF', 'CF', 'BA'], SIGNALS, FACT_LABEL,
  obs: { shortRun: ['shortRuntime', true], noCharge: ['wontCharge', true], runtimeNormal: ['shortRuntime', false] },
  checks: { 'vacuum-charger-check': { clear: 'chOk', found: 'chFixed', fault: 'chFault' }, 'programme-setting': { clear: 'progOk', found: 'progFixed' },
    'vacuum-bin-filters': { clear: 'filterOk', found: 'filterFixed' } },
  FIX_CHECK: { CH: ['vacuum-charger-check', 'Ch'], MX: ['programme-setting', 'Prog'], AF: ['vacuum-bin-filters', 'Filter'] },
  DECISIVE_PART: { BA: { batteryFade: 'vacuum-battery' } },
  extra(s, ctx, on) {
    const vt = F.vacType(s); F.typeFacts(on, vt);
    const v = (k) => engine.obsVal(s, k); const r = (c) => engine.checkResult(s, c);
    // owner-settled: a short runtime from a full charge with the charger, power mode and filters all fine
    on('batteryFade', vt.type !== 'corded' && v('shortRuntime') === true && r('vacuum-charger-check') === 'clear' && r('programme-setting') === 'clear' && r('vacuum-bin-filters') === 'clear');
  },
  eligible: (k, has) => (has('corded') ? !['CF', 'BA'].includes(k) : true),
};
function diagnose(state, ctx = {}) { return engine.diagnoseSpec(SPEC, state, { ...ctx, codeFault: null }); }
const P = kit.makeStepPolicy({
  JOURNEY: KEY, P: 'VR', appliance: 'vacuum', journeys: ['battery-problem'], ...F.owns(KEY), declineUnsafe: F.UNSAFE,
  CHECKS: ['vacuum-charger-check', 'programme-setting', 'vacuum-bin-filters'],
  OBS_TARGETS: { vacBattery: ['shortRuntime', 'wontCharge'] },
  REQUIRES: { vacBattery: [], 'vacuum-charger-check': [], 'programme-setting': [], 'vacuum-bin-filters': ['vac_power_off', 'vac_filter_dry'], retest: [] },
  FIX_CHECKS: ['vacuum-charger-check', 'programme-setting', 'vacuum-bin-filters'],
  steps: [
    { n: 10, target: 'vacBattery', reason: 'runtime-or-charging', when: (h) => h.obs('shortRuntime') == null && h.obs('wontCharge') == null },
    { n: 11, target: 'vacuum-charger-check', reason: 'charger-socket-contacts', when: () => true },
    { n: 12, target: 'programme-setting', reason: 'boost-mode-drains-battery', when: (h) => h.has('shortRun') && !h.has('chFault') },
    { n: 13, target: 'vacuum-bin-filters', reason: 'choked-filters-draw-more', when: (h) => h.has('shortRun') && !h.has('chFault') },
  ],
  PART_FAMILIES: new Set(['BA']),
  HANDOFF: { CH: 'none', MX: 'none', AF: 'none', CF: 'engineer', BA: 'none' },
});
const pipeline = JP.makeModelPartPipeline({ D: { diagnose }, P, schema: 'vac5/1', codeFaultFor: F.vacCodeFault, PART_MATCH: F.PART_MATCH, MEDIA_BY_KEY: {} });

// ---- COMPOSE (wording only) ----
const FAMILY_LABEL = { 'charger-socket-or-contacts': 'the charger, socket or charging contacts', 'boost-or-max-mode': 'boost / max mode', 'filters-choking-motor': 'clogged filters',
  'battery-or-charger-not-charging': 'the battery or the charger', 'battery-worn': 'a worn battery' };
const COMPONENT_LABEL = { 'vacuum-battery': 'battery' };
const TASK = {
  'ask_observation:vacBattery': { say: 'First, what the battery is doing.', ask: 'On a full charge, does it run only a short time before stopping, or will it not charge at all?' },
  'ask_check:vacuum-charger-check': { say: 'Check the charger is in a working socket and pushed fully into the vacuum (or dock), and wipe the charging contacts clean and dry. The charging light should come on.', ask: 'Was the charger, socket or contacts the problem (and is it sorted), does the charging light never come on, or is the charger fine with the light on?' },
  'ask_check:programme-setting': { say: 'Boost or max mode drains a cordless battery in a few minutes — that\'s normal.', ask: 'Was it on boost / max mode (and have you switched to normal), or was it already on the normal mode?' },
  'ask_check:vacuum-bin-filters': { say: 'Clogged filters make the motor work harder and run the battery down faster. Wash them in cold water and let them dry fully (24 hours).', ask: 'Were the filters clogged (and are they clean now), or were they clean already?' },
  'ask_check:retest': { say: 'Charge it fully and use it on the normal mode.', ask: 'Is it running for its normal time now, or still short?' },
  'ask_identity:model': F.VAC_MODEL_ASK, 'ask_identity:appliance': F.VAC_APPLIANCE_ASK,
};
const CONCLUSION = {
  'VR7:charger-socket-or-contacts': 'That was the charging connection, so no part is needed.',
  'VR7:boost-or-max-mode': 'That was boost mode — it\'s designed to use the battery fast, so no part is needed. Save it for stubborn patches.',
  'VR7:filters-choking-motor': 'Cleaning the filters very likely fixed it, so no part is needed.',
  'battery-or-charger-not-charging': 'From what you\'ve described, it\'s most likely the battery or the charger. Trying a known-good charger tells them apart — I\'m not recommending a part until that\'s clear.',
  'battery-worn': 'It runs only briefly from a full charge with the charger, power mode and filters all fine, so the battery has very likely worn out.',
};
const compose = ck.createCompose({
  ASK_GUARD: true, TASK, CONFIRM_ASK: 'Is it running for its normal time now?',
  OBS_COPY: { shortRuntime: ['runs only a short time', 'runs its normal time'], wontCharge: ['won\'t charge', null], vacuumCordless: ['cordless', null], vacuumCorded: ['corded', null], vacuumRobot: ['robot', null],
    faultPersists: ['still short', 'normal runtime'] },
  CHECK_RESULT_COPY: { 'vacuum-charger-check': { clear: 'charger fine', found_and_cleared: 'charging sorted', fault_seen: 'charging light never on' },
    'programme-setting': { clear: 'normal mode', found_and_cleared: 'boost mode off' }, 'vacuum-bin-filters': { clear: 'filters clean', found_and_cleared: 'filters cleaned' } },
  statusChecks: [['retest', 'retest']],
  conclusionCopy: ck.makeConclusionCopy({ FAMILY_LABEL, COMPONENT_LABEL, CONCLUSION, fitNote: 'Most cordless batteries clip or screw on with the vacuum switched off — use only a battery listed for your model.' }),
  PURCHASE_RE: /\b(buy|order|purchase|price|£\s?\d)|\b(new|replacement|replace the)\s+(motor|battery|charger|filter)\b/i,
});
module.exports = { SPEC, FAMILY, diagnose, P, ...pipeline, FAMILY_LABEL, COMPONENT_LABEL, TASK, REQUIREMENT: ck.REQUIREMENT, SAFETY_COPY: ck.SAFETY_COPY, ...compose };
