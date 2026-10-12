'use strict';
/**
 * Hob journey 3 — overheating / control (rules HO1–HO22). PURE, deterministic. Safety first; no parts.
 * Design: docs/diagnostics/final-migration-evidence.md §HOB3. A zone stuck on full / won't turn down or off → switch off
 * at the isolator now and stop use (early, engineer). Switches off when hot / overheat code → ventilation under the hob
 * (induction cooling) or the sensor / control (engineer). No part guessing.
 */
const engine = require('./evidence-engine.js');
const kit = require('./policy-kit.js');
const JP = require('./journey-pipeline.js');
const F = require('./hob-family.js');
const ck = require('./compose-kit.js');
const { SS, S, A } = engine;

const KEY = 'hob-overheating-control';
const FAMILY = { CV: 'cooling-or-ventilation', TS: 'temperature-sensor-or-control' };
const SIGNALS = {
  CV: { induction: S, cutsHot: S, codeOverheat: S, radiant: A },
  TS: { cutsHot: S, codeOverheat: S, radiant: S },
};
const FACT_LABEL = { induction: 'induction hob', radiant: 'ceramic / solid-plate hob', cutsHot: 'switches off when hot', codeOverheat: 'overheating error code' };
const SPEC = {
  schema: 'hb3-diag/1', FAMILY, PRIOR: ['CV', 'TS'], SIGNALS, FACT_LABEL,
  obs: { induction: ['inductionHob', true], cutsHot: ['overheatsThenCuts', true] },
  checks: {}, DECISIVE_PART: {},
  extra(s, ctx, on) {
    on('codeOverheat', ctx.codeFault === 'overheating');
    on('radiant', engine.obsVal(s, 'ceramicHob') === true || engine.obsVal(s, 'solidPlateHob') === true);
    if (engine.obsVal(s, 'cutsOut') === true) on('cutsHot', true);
  },
};
function diagnose(state, ctx = {}) {
  const codeFault = ctx.codeFault !== undefined ? ctx.codeFault : F.hobCodeFault(state, ctx.errorCodes || null);
  return engine.diagnoseSpec(SPEC, state, { ...ctx, codeFault });
}
const P = kit.makeStepPolicy({
  JOURNEY: KEY, P: 'HO', appliance: 'hob', journeys: ['overheating', 'cuts-out'], ...F.owns(KEY), declineUnsafe: F.UNSAFE,
  CHECKS: [],
  OBS_TARGETS: { hobType: ['inductionHob', 'ceramicHob', 'gasHob', 'solidPlateHob'] },
  REQUIRES: { hobType: [] },
  early(h) { return h.obs('stuckOnHigh') === true ? { target: 'zone-stuck-on', reason: 'will-not-turn-down', rule: 'HO5', handoff: 'engineer' } : null; },
  steps: [{ n: 10, target: 'hobType', reason: 'hob-technology', when: (h) => !h.has('induction') && !h.has('radiant') }],
  PART_FAMILIES: new Set(),
  HANDOFF: { CV: 'engineer', TS: 'engineer' },
});
const pipeline = JP.makeModelPartPipeline({ D: { diagnose }, P, schema: 'hb3/1', codeFaultFor: F.hobCodeFault, PART_MATCH: {}, MEDIA_BY_KEY: {} });

// ---- COMPOSE (wording only) ----
const FAMILY_LABEL = { 'cooling-or-ventilation': 'the hob\'s cooling / ventilation', 'temperature-sensor-or-control': 'the temperature sensor or control', 'zone-stuck-on': 'a zone stuck on' };
const TASK = {
  'ask_observation:hobType': { say: 'The type of hob changes the likely cause.', ask: 'Is it an induction hob, a ceramic hob (smooth glass that glows red), a solid-plate hob, or gas?' },
  'ask_identity:appliance': F.HOB_APPLIANCE_ASK,
};
const CONCLUSION = {
  'zone-stuck-on': 'A zone that stays on full or won\'t turn off is a control fault and a fire risk. Switch the hob off at its isolator switch or the fuse box now, keep the area clear and don\'t use it until an appliance engineer has checked it. I\'m not recommending a part from this.',
  'cooling-or-ventilation': 'An induction hob switching itself off when hot is usually its overheat protection: check nothing is blocking the gap under the hob (a drawer packed tight, or no ventilation gap above an oven). If it keeps happening, the cooling fan or a sensor needs an appliance engineer — I\'m not recommending a part from this.',
  'temperature-sensor-or-control': 'Switching off when hot points to the zone\'s temperature sensor or the control. That needs an appliance engineer to test safely — I\'m not recommending a part from this.',
};
const compose = ck.createCompose({
  ASK_GUARD: true, TASK, CONFIRM_ASK: 'Is that clear?',
  OBS_COPY: { inductionHob: ['induction', null], ceramicHob: ['ceramic', null], solidPlateHob: ['solid plate', null], stuckOnHigh: ['stuck on full', null], overheatsThenCuts: ['switches off when hot', null] },
  CHECK_RESULT_COPY: {},
  conclusionCopy: ck.makeConclusionCopy({ FAMILY_LABEL, COMPONENT_LABEL: {}, CONCLUSION }),
  PURCHASE_RE: /\b(buy|order|purchase|price|£\s?\d)|\b(new|replacement|replace the)\s+(fan|cooling fan|sensor|module|power board|board|pcb|control)\b/i,
});
module.exports = { SPEC, FAMILY, diagnose, P, ...pipeline, FAMILY_LABEL, COMPONENT_LABEL: {}, TASK, REQUIREMENT: ck.REQUIREMENT, SAFETY_COPY: ck.SAFETY_COPY, ...compose };
