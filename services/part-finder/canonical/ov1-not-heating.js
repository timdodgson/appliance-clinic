'use strict';
/**
 * Oven journey 1 — not heating / heating slowly (rules OH1–OH22). PURE, deterministic.
 * Design: docs/diagnostics/final-migration-evidence.md §OV1. Electric oven (a gas oven → cooker-ignition-gas; fan not
 * turning → oven-fan-not-working; grill-only → oven-grill-not-working, all via ov-family).
 *   clock / auto mode after a power cut (no-part setup fix) → which parts heat (grill / main oven) → the fan turns? →
 *   function / temperature setting → fan runs + grill works + main oven cold → fan-oven element (part only with a model
 *   AND that evidence) · nothing heats with the clock working → selector / control (engineer) · heats slowly with the fan
 *   and grill fine → element or thermostat / sensor (engineer). No live electrical testing.
 */
const engine = require('./evidence-engine.js');
const kit = require('./policy-kit.js');
const JP = require('./journey-pipeline.js');
const F = require('./ov-family.js');
const ck = require('./compose-kit.js');
const { SS, S, A, SA } = engine;

const KEY = 'oven-not-heating';
const FAMILY = { CM: 'clock-or-auto-mode', PG: 'function-or-setting', FE: 'fan-oven-element', TS: 'thermostat-or-sensor', SC: 'selector-or-control' };
const SIGNALS = {
  CM: { clockFix: SS, restoredAfterClockFix: SS, failsAfterClockFix: SA, clockFlash: S, clockOk: SA },
  PG: { progFixed: SS, restoredAfterProgFix: SS, failsAfterProgFix: SA, progOk: SA },
  FE: { fanElementSign: SS, codeElement: SS, fanTurns: S, grillOk: S, ovenDead: S, slow: S, grillDead: A, fanStill: SA, restoredAfterClockFix: SA, restoredAfterProgFix: SA },
  TS: { codeProbe: SS, slow: S, fanTurns: S, grillOk: S, clockOk: S, ovenDead: A, restoredAfterClockFix: SA, restoredAfterProgFix: SA },
  SC: { grillDead: S, ovenDead: S, clockOk: S, progOk: S, grillOk: SA, restoredAfterClockFix: SA, restoredAfterProgFix: SA },
};
const FACT_LABEL = {
  clockFix: 'clock / auto mode was stopping it (set)', clockOk: 'clock set, manual mode', clockFlash: 'clock flashing', progFixed: 'wrong function / setting (changed)', progOk: 'fan function and temperature set normally',
  fanTurns: 'fan turns', fanStill: 'fan does not turn', grillOk: 'grill heats', grillDead: 'grill does not heat', ovenDead: 'main oven stays cold', slow: 'heats slowly / only a little',
  fanElementSign: 'fan runs, grill works, main oven cold', codeElement: 'element error code', codeProbe: 'temperature-sensor error code',
};
const SPEC = {
  schema: 'ov1-diag/1', FAMILY, PRIOR: ['CM', 'PG', 'FE', 'TS', 'SC'], SIGNALS, FACT_LABEL,
  obs: { clockFlash: ['clockFlashing', true], fanTurns: ['ovenFanTurns', true], fanStill: ['ovenFanTurns', false], grillOk: ['grillWorks', true], grillDead: ['grillWorks', false],
    ovenDead: ['mainOvenWorks', false], slow: ['heatsSlowly', true] },
  checks: { 'oven-clock-mode': { clear: 'clockOk', found: 'clockFix' }, 'programme-setting': { clear: 'progOk', found: 'progFixed' } },
  FIX_CHECK: { CM: ['oven-clock-mode', 'Clock'], PG: ['programme-setting', 'Prog'] },
  DECISIVE_PART: { FE: { fanElementSign: 'fan-oven-element' } },
  extra(s, ctx, on) {
    const v = (k) => engine.obsVal(s, k);
    on('fanElementSign', v('ovenFanTurns') === true && v('grillWorks') === true && (v('mainOvenWorks') === false || v('heatsSlowly') === true));
    on('codeElement', ctx.codeFault === 'element'); on('codeProbe', ctx.codeFault === 'temperature-probe' || ctx.codeFault === 'thermostat');
  },
};
function diagnose(state, ctx = {}) {
  const codeFault = ctx.codeFault !== undefined ? ctx.codeFault : F.ovCodeFault(state, ctx.errorCodes || null);
  return engine.diagnoseSpec(SPEC, state, { ...ctx, codeFault });
}
const P = kit.makeStepPolicy({
  JOURNEY: KEY, P: 'OH', appliance: 'oven-cooker', journeys: ['no-heat'], ...F.owns(KEY), declineUnsafe: F.UNSAFE,
  CHECKS: ['oven-clock-mode', 'programme-setting'],
  // ovenFunctions is settled by the GRILL answer (the opener's "isn't heating" already tells us the main oven)
  OBS_TARGETS: { ovenFunctions: ['grillWorks'], ovenFanTurns: ['ovenFanTurns'] },
  REQUIRES: { 'oven-clock-mode': [], ovenFunctions: ['oven_hot_surfaces'], ovenFanTurns: ['oven_hot_surfaces'], 'programme-setting': [], retest: ['oven_hot_surfaces'] },
  FIX_CHECKS: ['oven-clock-mode', 'programme-setting'],
  steps: [
    { n: 10, target: 'oven-clock-mode', reason: 'clock-auto-mode-after-power-cut', when: () => true },
    { n: 11, target: 'ovenFunctions', reason: 'which-parts-heat', when: (h) => h.obs('grillWorks') == null || (h.obs('mainOvenWorks') == null && !h.has('slow')) },
    { n: 12, target: 'ovenFanTurns', reason: 'fan-turns-decides-element-vs-fan', when: () => true },
    { n: 13, target: 'programme-setting', reason: 'function-and-temperature', when: () => true },
  ],
  PART_FAMILIES: new Set(['FE']),
  HANDOFF: { CM: 'none', PG: 'none', FE: 'engineer', TS: 'engineer', SC: 'engineer' },
});
const pipeline = JP.makeModelPartPipeline({
  D: { diagnose }, P, schema: 'ov1/1', codeFaultFor: F.ovCodeFault,
  PART_MATCH: { 'fan-oven-element': { re: /(fan|circular|ring|main oven)\s+(oven\s+)?element|element.*\b(fan|circular)\b/i, not: /grill|base|top|lower|hob|thermostat|stat\b|cut.?out|washing|dryer/i } },
  MEDIA_BY_KEY: { 'thermostat-or-sensor': { knowledgeId: 'oven-cooker:uneven-heating', ids: ['oven-uneven-about'], concepts: [] } },
});

// ---- COMPOSE (wording only) ----
const FAMILY_LABEL = { 'clock-or-auto-mode': 'the clock / timer being in auto mode', 'function-or-setting': 'the function or temperature setting', 'fan-oven-element': 'the fan-oven element',
  'thermostat-or-sensor': 'the thermostat or temperature sensor', 'selector-or-control': 'the function selector or control' };
const COMPONENT_LABEL = { 'fan-oven-element': 'fan-oven (circular) element' };
const TASK = {
  'ask_check:oven-clock-mode': { say: 'Many ovens won\'t heat at all after a power cut (or with an end time set) until the clock is set or manual mode is selected — often a hand symbol, or holding two buttons together; the manual shows how.', ask: 'Was the clock flashing or set to an auto / timer mode, or was it already showing the time in manual mode?' },
  'ask_observation:ovenFunctions': { say: 'This tells us which part has failed.', ask: 'If you try the grill on its own for a few minutes, does it heat — and does the main oven heat at all?' },
  'ask_observation:ovenFanTurns': { say: 'With the oven on the fan setting, look through the door at the fan cover at the back.', ask: 'Can you see or hear the fan turning?' },
  'ask_check:programme-setting': { say: 'One quick check, because the defrost setting runs the fan with no heat: make sure the function knob is on a fan-oven heating symbol (a fan with a ring around it) rather than defrost, light-only or eco, and that the temperature knob is turned up so the temperature light comes on.', ask: 'Was it on one of those other settings, or was it already on a heating function with the temperature up?' },
  'ask_check:retest': { say: 'Set it to 180°C on the fan function for 15 minutes.', ask: 'Is it heating up properly now, or still not?' },
  'ask_identity:model': F.OVEN_MODEL_ASK, 'ask_identity:appliance': F.OVEN_APPLIANCE_ASK,
};
const CONCLUSION = {
  'OH7:clock-or-auto-mode': 'That was the clock / auto mode, so no part is needed. If you lose power again, set the clock first.',
  'OH7:function-or-setting': 'That was the setting, so no part is needed.',
  'fan-oven-element': 'With the fan running and the grill working but the main oven cold, the fan-oven (circular) element behind the back panel is the usual cause. An appliance engineer can confirm it safely — I\'m not recommending a part from this.',
  'thermostat-or-sensor': 'Heating only slowly with the fan and grill working points to the thermostat / temperature sensor (or a weak element). That needs an appliance engineer to test safely — I\'m not recommending a part from this.',
  'selector-or-control': 'With the clock working but nothing heating, the function selector or the control is the likely area. That needs an appliance engineer — please don\'t take any panels off. I\'m not recommending a part from this.',
};
// Why the evidence points at a component (used when no part can be matched): the grill has its own element.
const ovObs = (s, k) => { const o = s.evidence && s.evidence.observations && s.evidence.observations[k]; return o ? o.value : null; };
const REASON = {
  'fan-oven-element': (s) => (ovObs(s, 'ovenFanTurns') === true && ovObs(s, 'grillWorks') === true
    ? 'With the fan turning and the grill heating, power and the controls are reaching the oven — but the grill has its own element, so it working doesn\'t clear the fan-oven element behind the back panel.'
    : null),
};
const compose = ck.createCompose({
  ASK_GUARD: true, TASK, CONFIRM_ASK: 'Is it heating properly now?',
  OBS_COPY: { grillWorks: ['grill heats', 'grill cold'], mainOvenWorks: ['main oven heats', 'main oven cold'], ovenFanTurns: ['fan turns', 'fan not turning'], heatsSlowly: ['heats slowly', null],
    clockFlashing: ['clock flashing', null], faultPersists: ['still not heating', 'heating now'] },
  CHECK_RESULT_COPY: { 'oven-clock-mode': { clear: 'clock set, manual mode', found_and_cleared: 'clock / auto mode sorted' }, 'programme-setting': { clear: 'setting correct', found_and_cleared: 'setting changed' } },
  statusChecks: [['retest', 'retest']],
  conclusionCopy: ck.makeConclusionCopy({ FAMILY_LABEL, COMPONENT_LABEL, CONCLUSION, REASON, fitNote: 'Switch the oven off at the isolator and let it cool before fitting it; the element sits behind the back panel inside — if you\'d rather not, an appliance engineer can fit it.' }),
  PURCHASE_RE: /\b(buy|order|purchase|price|£\s?\d)|\b(new|replacement|replace the)\s+(element|fan element|thermostat|sensor|probe|selector|switch|pcb|control board|fan motor)\b/i,
});
module.exports = { SPEC, FAMILY, diagnose, P, ...pipeline, FAMILY_LABEL, COMPONENT_LABEL, TASK, REQUIREMENT: ck.REQUIREMENT, SAFETY_COPY: ck.SAFETY_COPY, ...compose };
