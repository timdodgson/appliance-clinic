'use strict';
/**
 * Oven journey 3 — grill not working (rules OG1–OG22). PURE, deterministic.
 * Design: docs/diagnostics/final-migration-evidence.md §OV3. The grill is a separate element / circuit from the fan oven:
 * a grill failure never implies the fan element. Main oven heats? → clock / auto mode → grill function / door position →
 * grill element (part only with a model AND grill cold + main oven fine + setting right) · else grill control / selector
 * (engineer). Both grill and oven cold → handled as not heating (ov-family).
 */
const engine = require('./evidence-engine.js');
const kit = require('./policy-kit.js');
const JP = require('./journey-pipeline.js');
const F = require('./ov-family.js');
const ck = require('./compose-kit.js');
const { SS, S, A, SA } = engine;

const KEY = 'oven-grill-not-working';
const FAMILY = { CM: 'clock-or-auto-mode', PG: 'grill-setting-or-door-position', GE: 'grill-element', GC: 'grill-control-or-selector' };
const SIGNALS = {
  CM: { clockFix: SS, restoredAfterClockFix: SS, failsAfterClockFix: SA, clockOk: SA },
  PG: { progFixed: SS, restoredAfterProgFix: SS, failsAfterProgFix: SA, progOk: SA },
  GE: { grillSign: SS, codeElement: S, grillDead: S, ovenOk: S, restoredAfterClockFix: SA, restoredAfterProgFix: SA },
  GC: { grillDead: S, ovenOk: S, progOk: S, clockOk: S, restoredAfterClockFix: SA, restoredAfterProgFix: SA },
};
const FACT_LABEL = { grillDead: 'grill does not heat', ovenOk: 'main oven heats', clockFix: 'clock / auto mode set', clockOk: 'clock set, manual mode', progFixed: 'grill function / door position wrong (changed)',
  progOk: 'grill set correctly', grillSign: 'grill cold with the main oven fine and the setting right', codeElement: 'element error code' };
const SPEC = {
  schema: 'ov3-diag/1', FAMILY, PRIOR: ['CM', 'PG', 'GE', 'GC'], SIGNALS, FACT_LABEL,
  obs: { grillDead: ['grillWorks', false], ovenOk: ['mainOvenWorks', true] },
  checks: { 'oven-clock-mode': { clear: 'clockOk', found: 'clockFix' }, 'programme-setting': { clear: 'progOk', found: 'progFixed' } },
  FIX_CHECK: { CM: ['oven-clock-mode', 'Clock'], PG: ['programme-setting', 'Prog'] },
  DECISIVE_PART: { GE: { grillSign: 'grill-element' } },
  extra(s, ctx, on) {
    on('grillSign', engine.obsVal(s, 'grillWorks') !== true && engine.obsVal(s, 'mainOvenWorks') === true && engine.checkResult(s, 'programme-setting') === 'clear');
    on('codeElement', ctx.codeFault === 'element');
    const p = kit.problemOf(s); if (p && p.scope && p.scope.value === 'grill_only' && engine.obsVal(s, 'grillWorks') == null) on('grillDead', true);
  },
};
function diagnose(state, ctx = {}) {
  const codeFault = ctx.codeFault !== undefined ? ctx.codeFault : F.ovCodeFault(state, ctx.errorCodes || null);
  return engine.diagnoseSpec(SPEC, state, { ...ctx, codeFault });
}
const P = kit.makeStepPolicy({
  JOURNEY: KEY, P: 'OG', appliance: 'oven-cooker', journeys: [], ...F.owns(KEY), declineUnsafe: F.UNSAFE,
  CHECKS: ['oven-clock-mode', 'programme-setting'],
  OBS_TARGETS: { mainOvenWorks: ['mainOvenWorks'] },
  REQUIRES: { mainOvenWorks: ['oven_hot_surfaces'], 'oven-clock-mode': [], 'programme-setting': [], retest: ['oven_hot_surfaces'] },
  FIX_CHECKS: ['oven-clock-mode', 'programme-setting'],
  steps: [
    { n: 10, target: 'mainOvenWorks', reason: 'grill-only-or-both', when: (h) => h.obs('mainOvenWorks') == null },
    { n: 11, target: 'oven-clock-mode', reason: 'clock-auto-mode', when: () => true },
    { n: 12, target: 'programme-setting', reason: 'grill-function-door-position', when: () => true },
  ],
  PART_FAMILIES: new Set(['GE']),
  HANDOFF: { CM: 'none', PG: 'none', GE: 'engineer', GC: 'engineer' },
});
const pipeline = JP.makeModelPartPipeline({
  D: { diagnose }, P, schema: 'ov3/1', codeFaultFor: F.ovCodeFault,
  PART_MATCH: { 'grill-element': { re: /grill\s+element|element.*\bgrill\b|top\s+grill/i, not: /fan|circular|base|lower|thermostat|stat\b|hob|washing|dryer/i } },
  MEDIA_BY_KEY: {},
});

// ---- COMPOSE (wording only) ----
const FAMILY_LABEL = { 'clock-or-auto-mode': 'the clock / auto mode', 'grill-setting-or-door-position': 'the grill setting or door position', 'grill-element': 'the grill element',
  'grill-control-or-selector': 'the grill control or selector' };
const COMPONENT_LABEL = { 'grill-element': 'grill element' };
const TASK = {
  'ask_observation:mainOvenWorks': { say: 'The grill and the main oven usually have separate elements and circuits.', ask: 'Does the main oven heat normally on its own?' },
  'ask_check:oven-clock-mode': { say: 'Some cookers won\'t heat until the clock is set or manual mode is selected after a power cut.', ask: 'Was the clock flashing or an auto mode set (and have you set it to manual), or was it already in manual mode?' },
  'ask_check:programme-setting': { say: 'Check the grill function is selected and the grill control turned up, and the door position is right — many grills need the door open, some (in an oven) closed; the manual says which.', ask: 'Was the setting or door position wrong (and have you changed it), or was it all set correctly?' },
  'ask_check:retest': { say: 'Try the grill on full for a few minutes.', ask: 'Is the grill glowing / heating now, or still not?' },
  'ask_identity:model': F.OVEN_MODEL_ASK, 'ask_identity:appliance': F.OVEN_APPLIANCE_ASK,
};
const CONCLUSION = {
  'OG7:clock-or-auto-mode': 'That was the clock / auto mode, so no part is needed.',
  'OG7:grill-setting-or-door-position': 'That was the setting / door position, so no part is needed.',
  'grill-element': 'With the main oven working and the grill set correctly but staying cold, the grill element is the usual cause — the grill has its own element, separate from the fan oven. An appliance engineer can confirm it safely; I\'m not recommending a part from this.',
  'grill-control-or-selector': 'The grill control or selector is the likely area. That needs an appliance engineer to test safely — I\'m not recommending a part from this.',
};
const compose = ck.createCompose({
  ASK_GUARD: true, TASK, CONFIRM_ASK: 'Is the grill working now?',
  OBS_COPY: { grillWorks: ['grill heats', 'grill cold'], mainOvenWorks: ['main oven heats', 'main oven cold'], faultPersists: ['grill still cold', 'grill working'] },
  CHECK_RESULT_COPY: { 'oven-clock-mode': { clear: 'clock set, manual mode', found_and_cleared: 'clock / auto mode sorted' }, 'programme-setting': { clear: 'grill set correctly', found_and_cleared: 'setting changed' } },
  statusChecks: [['retest', 'retest']],
  conclusionCopy: ck.makeConclusionCopy({ FAMILY_LABEL, COMPONENT_LABEL, CONCLUSION, fitNote: 'Switch the oven off at the isolator and let it cool before fitting it; if you\'d rather not, an appliance engineer can fit it.' }),
  PURCHASE_RE: /\b(buy|order|purchase|price|£\s?\d)|\b(new|replacement|replace the)\s+(element|grill element|thermostat|selector|switch|energy regulator|pcb|control board)\b/i,
});
module.exports = { SPEC, FAMILY, diagnose, P, ...pipeline, FAMILY_LABEL, COMPONENT_LABEL, TASK, REQUIREMENT: ck.REQUIREMENT, SAFETY_COPY: ck.SAFETY_COPY, ...compose };
