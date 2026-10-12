'use strict';
/**
 * Microwave journey 1 — not heating (rules MH1–MH22). PURE, deterministic. No parts.
 * Design: docs/diagnostics/final-migration-evidence.md §MW1. Power level / defrost / combi mode (owner) → runs normally
 * (light, turntable, sound) with no heat → the high-voltage heating system (magnetron / diode / capacitor / transformer /
 * inverter) → ENGINEER, never a magnetron from "not heating" · stops part way → overheat cut-out / control (engineer).
 * Sparking → mw-noisy-sparking; door issues → mw-door (mw-family).
 */
const engine = require('./evidence-engine.js');
const kit = require('./policy-kit.js');
const JP = require('./journey-pipeline.js');
const F = require('./mw-family.js');
const ck = require('./compose-kit.js');
const { SS, S, A, SA } = engine;

const KEY = 'mw-not-heating';
const FAMILY = { PG: 'power-level-or-mode', HV: 'high-voltage-heating-system', CT: 'overheat-cut-out-or-control' };
const SIGNALS = {
  PG: { progFixed: SS, restoredAfterProgFix: SS, failsAfterProgFix: SA, progOk: SA },
  HV: { runs: S, progOk: S, codeHeat: SS, stopsEarly: A, restoredAfterProgFix: SA },
  CT: { stopsEarly: SS, progOk: S, restoredAfterProgFix: SA },
};
const FACT_LABEL = { progFixed: 'low power / defrost / combi mode set (changed)', progOk: 'full power, normal mode', runs: 'runs normally (light, turntable) but no heat', stopsEarly: 'stops part way', codeHeat: 'heating error code' };
const SPEC = {
  schema: 'mw1-diag/1', FAMILY, PRIOR: ['PG', 'HV', 'CT'], SIGNALS, FACT_LABEL,
  obs: { runs: ['runsNormally', true], stopsEarly: ['cutsOut', true] },
  checks: { 'programme-setting': { clear: 'progOk', found: 'progFixed' } },
  FIX_CHECK: { PG: ['programme-setting', 'Prog'] },
  DECISIVE_PART: {},
  extra(s, ctx, on) { on('codeHeat', ctx.codeFault === 'not-heating'); },
};
function diagnose(state, ctx = {}) {
  const codeFault = ctx.codeFault !== undefined ? ctx.codeFault : F.mwCodeFault(state, ctx.errorCodes || null);
  return engine.diagnoseSpec(SPEC, state, { ...ctx, codeFault });
}
const P = kit.makeStepPolicy({
  JOURNEY: KEY, P: 'MH', appliance: 'microwave', journeys: ['no-heat', 'cuts-out'], ...F.owns(KEY), declineUnsafe: F.UNSAFE,
  CHECKS: ['programme-setting'],
  OBS_TARGETS: { runsNormally: ['runsNormally'] },
  REQUIRES: { 'programme-setting': [], runsNormally: [], retest: [] },
  FIX_CHECKS: ['programme-setting'],
  steps: [
    { n: 10, target: 'programme-setting', reason: 'power-level-defrost-combi', when: () => true },
    { n: 11, target: 'runsNormally', reason: 'runs-normally-no-heat', when: (h) => !h.has('runs') && !h.has('stopsEarly') },
  ],
  PART_FAMILIES: new Set(),
  HANDOFF: { PG: 'none', HV: 'engineer', CT: 'engineer' },
});
const pipeline = JP.makeModelPartPipeline({ D: { diagnose }, P, schema: 'mw1/1', codeFaultFor: F.mwCodeFault, PART_MATCH: {}, MEDIA_BY_KEY: {} });

// ---- COMPOSE (wording only) ----
const FAMILY_LABEL = { 'power-level-or-mode': 'the power level or mode', 'high-voltage-heating-system': 'the high-voltage heating system', 'overheat-cut-out-or-control': 'the overheat cut-out or control' };
const TASK = {
  'ask_check:programme-setting': { say: 'Check it isn\'t on a low power level, defrost, or a grill / combination mode, and that a timed cook was started (not just the clock set).', ask: 'Was it on a low power or another mode (and have you changed it), or was it on full power as normal?' },
  'ask_observation:runsNormally': { say: 'Try heating a cup of water for a minute on full power.', ask: 'Does the light come on and the turntable turn as normal, even though the water stays cold?' },
  'ask_check:retest': { say: 'Heat a cup of water for a minute on full power.', ask: 'Is the water hot now, or still cold?' },
  'ask_identity:appliance': F.MW_APPLIANCE_ASK,
};
const CONCLUSION = {
  'MH7:power-level-or-mode': 'That was the power level / mode, so no part is needed.',
  'high-voltage-heating-system': `Running normally with no heat means a fault in the high-voltage heating system (the magnetron, diode, capacitor or its power supply) — I can't tell which from the outside, and I'm not recommending a part. ${F.HV} An appliance engineer is the next step (for a low-cost microwave, replacing it is often more economical).`,
  'overheat-cut-out-or-control': `Stopping part way usually means its overheat cut-out or the control is cutting in — check the vents on the sides / back aren't blocked. ${F.HV} If it keeps happening, an appliance engineer should check it; I'm not recommending a part from this.`,
};
const compose = ck.createCompose({
  ASK_GUARD: true, TASK, CONFIRM_ASK: 'Is it heating properly now?',
  OBS_COPY: { runsNormally: ['runs normally, no heat', null], cutsOut: ['stops part way', null], faultPersists: ['still not heating', 'heating now'] },
  CHECK_RESULT_COPY: { 'programme-setting': { clear: 'full power, normal mode', found_and_cleared: 'power / mode changed' } },
  statusChecks: [['retest', 'retest']],
  conclusionCopy: ck.makeConclusionCopy({ FAMILY_LABEL, COMPONENT_LABEL: {}, CONCLUSION }),
  PURCHASE_RE: /\b(buy|order|purchase|price|£\s?\d)|\b(new|replacement|replace the)\s+(magnetron|diode|capacitor|transformer|inverter|fuse|thermal|cut.?out|pcb|control board)\b/i,
});
module.exports = { SPEC, FAMILY, diagnose, P, ...pipeline, FAMILY_LABEL, COMPONENT_LABEL: {}, TASK, REQUIREMENT: ck.REQUIREMENT, SAFETY_COPY: ck.SAFETY_COPY, ...compose };
