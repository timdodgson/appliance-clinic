'use strict';
/**
 * Oven journey 2 — overheating / cuts out when hot (rules OT1–OT22). PURE, deterministic.
 * Design: docs/diagnostics/final-migration-evidence.md §OV2. Keeps heating when turned down or OFF → stop use now (switch
 * off at the isolator) and an engineer — a stuck control / relay (early, no questions). Otherwise: setting / function /
 * grill left on → the circulation fan turns? (no fan → hot spots) → thermostat / sensor / control (engineer). Cutting out
 * when hot → cooling fan / overheat protection (engineer). Never live temperature-control testing; no parts.
 */
const engine = require('./evidence-engine.js');
const kit = require('./policy-kit.js');
const JP = require('./journey-pipeline.js');
const F = require('./ov-family.js');
const ck = require('./compose-kit.js');
const { SS, S, A, SA } = engine;

const KEY = 'oven-overheating';
const FAMILY = { PG: 'setting-or-function', CF: 'circulation-fan', CL: 'cooling-fan-or-overheat-cut-out', TH: 'thermostat-sensor-or-control' };
const SIGNALS = {
  PG: { progFixed: SS, restoredAfterProgFix: SS, failsAfterProgFix: SA, progOk: SA },
  CF: { fanStill: SS, tooHot: S, fanTurns: SA, restoredAfterProgFix: SA },
  CL: { cutsOut: SS, overheatCut: S, fanTurns: S, restoredAfterProgFix: SA },
  TH: { codeProbe: SS, tooHot: S, progOk: S, fanTurns: S, cutsOut: A, restoredAfterProgFix: SA },
};
const FACT_LABEL = { tooHot: 'far too hot / burns food', progFixed: 'setting / function wrong (changed)', progOk: 'setting and function normal', fanTurns: 'fan turns', fanStill: 'fan does not turn',
  cutsOut: 'cuts out when hot', overheatCut: 'overheats then cuts out', codeProbe: 'temperature-sensor / thermostat error code' };
const SPEC = {
  schema: 'ov2-diag/1', FAMILY, PRIOR: ['PG', 'CF', 'CL', 'TH'], SIGNALS, FACT_LABEL,
  obs: { tooHot: ['tooHot', true], fanTurns: ['ovenFanTurns', true], fanStill: ['ovenFanTurns', false], cutsOut: ['cutsOut', true], overheatCut: ['overheatsThenCuts', true] },
  checks: { 'programme-setting': { clear: 'progOk', found: 'progFixed' } },
  FIX_CHECK: { PG: ['programme-setting', 'Prog'] },
  DECISIVE_PART: {},
  extra(s, ctx, on) { on('codeProbe', ['temperature-probe', 'thermostat'].includes(ctx.codeFault)); },
};
function diagnose(state, ctx = {}) {
  const codeFault = ctx.codeFault !== undefined ? ctx.codeFault : F.ovCodeFault(state, ctx.errorCodes || null);
  return engine.diagnoseSpec(SPEC, state, { ...ctx, codeFault });
}
const P = kit.makeStepPolicy({
  JOURNEY: KEY, P: 'OT', appliance: 'oven-cooker', journeys: ['overheating', 'cuts-out'], ...F.owns(KEY), declineUnsafe: F.UNSAFE,
  CHECKS: ['programme-setting'],
  OBS_TARGETS: { ovenFanTurns: ['ovenFanTurns'] },
  REQUIRES: { 'programme-setting': [], ovenFanTurns: ['oven_hot_surfaces'], retest: ['oven_hot_surfaces'] },
  FIX_CHECKS: ['programme-setting'],
  // still heating when turned down / off: a stuck control — stop use now, no diagnosis by use
  early(h) { return h.obs('stuckOnHigh') === true ? { target: 'control-stuck-on', reason: 'heats-when-off', rule: 'OT5', handoff: 'engineer' } : null; },
  steps: [
    { n: 10, target: 'programme-setting', reason: 'setting-function-grill-left-on', when: () => true },
    { n: 11, target: 'ovenFanTurns', reason: 'circulation-fan', when: (h) => !h.has('cutsOut') },
  ],
  PART_FAMILIES: new Set(),
  HANDOFF: { PG: 'none', CF: 'engineer', CL: 'engineer', TH: 'engineer' },
});
const pipeline = JP.makeModelPartPipeline({ D: { diagnose }, P, schema: 'ov2/1', codeFaultFor: F.ovCodeFault, PART_MATCH: {}, MEDIA_BY_KEY: {} });

// ---- COMPOSE (wording only) ----
const FAMILY_LABEL = { 'setting-or-function': 'the setting or function', 'circulation-fan': 'the oven fan not circulating the heat', 'cooling-fan-or-overheat-cut-out': 'the cooling fan / overheat cut-out',
  'thermostat-sensor-or-control': 'the thermostat, temperature sensor or control', 'control-stuck-on': 'a control stuck on' };
const TASK = {
  'ask_check:programme-setting': { say: 'First the simple things: check the temperature knob or display matches what you want, the function isn\'t on grill or a "fast heat / booster" mode, and that recipes for a fan oven are usually 10–20°C lower than conventional.', ask: 'Was a setting or function wrong (and have you changed it), or was it all set normally?' },
  'ask_observation:ovenFanTurns': { say: 'On the fan setting, look through the door at the fan cover at the back.', ask: 'Can you see or hear the fan turning?' },
  'ask_check:retest': { say: 'Try a normal bake at the right temperature and keep an eye on it.', ask: 'Is it cooking at a normal temperature now, or still too hot?' },
  'ask_identity:appliance': F.OVEN_APPLIANCE_ASK,
};
const CONCLUSION = {
  'control-stuck-on': 'An oven that keeps heating when it is turned down or off has a control or relay stuck on. Switch it off at the wall or its cooker switch (isolator) now and leave it off — don\'t use it until an appliance engineer has checked it. I\'m not recommending a part from this.',
  'OT7:setting-or-function': 'That was the setting, so no part is needed.',
  'circulation-fan': 'With the fan not turning, the heat isn\'t being spread round, so parts of the oven run very hot. That needs an appliance engineer — I\'m not recommending a part from this.',
  'cooling-fan-or-overheat-cut-out': 'Cutting out when it gets hot usually means the cooling fan or the overheat cut-out is acting. Let it cool and don\'t keep restarting it; an appliance engineer should check it — I\'m not recommending a part from this.',
  // wording follows the evidence: only what the customer confirmed is stated as confirmed
  'thermostat-sensor-or-control': (state) => {
    const setOk = engine.checkResult(state, 'programme-setting') === 'clear';
    const fanOk = engine.obsVal(state, 'ovenFanTurns') === true;
    const lead = setOk && fanOk ? 'With the settings right and the fan turning' : fanOk ? 'With the fan turning' : setOk ? 'With the settings right' : 'From what we have';
    return `${lead}, food burning or cooking unevenly points to the thermostat, temperature sensor or control — and when one side burns, an element or a door seal letting heat out unevenly can also do it. Please don't try to test anything while it's on — an appliance engineer is the next step, and I'm not recommending a part from this.`;
  },
};
const compose = ck.createCompose({
  ASK_GUARD: true, TASK, CONFIRM_ASK: 'Is it cooking at a normal temperature now?',
  OBS_COPY: { tooHot: ['far too hot', null], ovenFanTurns: ['fan turns', 'fan not turning'], cutsOut: ['cuts out when hot', null], stuckOnHigh: ['keeps heating when off', null], faultPersists: ['still too hot', 'normal now'] },
  CHECK_RESULT_COPY: { 'programme-setting': { clear: 'setting normal', found_and_cleared: 'setting changed' } },
  statusChecks: [['retest', 'retest']],
  conclusionCopy: ck.makeConclusionCopy({ FAMILY_LABEL, COMPONENT_LABEL: {}, CONCLUSION }),
  PURCHASE_RE: /\b(buy|order|purchase|price|£\s?\d)|\b(new|replacement|replace the)\s+(thermostat|sensor|probe|relay|pcb|control board|fan|fan motor|cut.?out)\b/i,
});
module.exports = { SPEC, FAMILY, diagnose, P, ...pipeline, FAMILY_LABEL, COMPONENT_LABEL: {}, TASK, REQUIREMENT: ck.REQUIREMENT, SAFETY_COPY: ck.SAFETY_COPY, ...compose };
