'use strict';
/**
 * Microwave journey 6 — starts by itself when the door closes (rules MC1–MC22). PURE, deterministic. SAFETY-CRITICAL.
 * Design: docs/diagnostics/final-migration-evidence.md §MW6 (accepted behaviour). Abnormal, unsafe operation: the door
 * interlock / control path — NOT magnetron-first. Stop normal use: unplug it and leave it unplugged; engineer. No questions,
 * no parts, no "try it again".
 */
const engine = require('./evidence-engine.js');
const kit = require('./policy-kit.js');
const JP = require('./journey-pipeline.js');
const F = require('./mw-family.js');
const ck = require('./compose-kit.js');
const { SS } = engine;

const KEY = 'mw-starts-when-door-closes';
const FAMILY = { IL: 'door-interlock-or-control' };
const SPEC = { schema: 'mw6-diag/1', FAMILY, PRIOR: ['IL'], SIGNALS: { IL: { startsAlone: SS } }, FACT_LABEL: { startsAlone: 'starts by itself when the door closes' },
  obs: { startsAlone: ['startsWhenDoorCloses', true] }, checks: {}, DECISIVE_PART: {} };
function diagnose(state, ctx = {}) {
  const codeFault = ctx.codeFault !== undefined ? ctx.codeFault : F.mwCodeFault(state, ctx.errorCodes || null);
  return engine.diagnoseSpec(SPEC, state, { ...ctx, codeFault });
}
const P = kit.makeStepPolicy({
  JOURNEY: KEY, P: 'MC', appliance: 'microwave', journeys: [], ...F.owns(KEY), declineUnsafe: F.UNSAFE,
  CHECKS: [], OBS_TARGETS: {}, REQUIRES: {},
  early: () => ({ target: 'door-interlock-or-control', reason: 'abnormal-start-stop-use', rule: 'MC5', handoff: 'engineer' }),
  steps: [], PART_FAMILIES: new Set(), HANDOFF: { IL: 'engineer' },
});
const pipeline = JP.makeModelPartPipeline({ D: { diagnose }, P, schema: 'mw6/1', codeFaultFor: F.mwCodeFault, PART_MATCH: {}, MEDIA_BY_KEY: {} });
const FAMILY_LABEL = { 'door-interlock-or-control': 'the door interlock or control' };
const TASK = { 'ask_identity:appliance': F.MW_APPLIANCE_ASK };
const CONCLUSION = {
  'door-interlock-or-control': `A microwave that starts by itself when the door closes has a fault in its door interlock or control — that's unsafe, because it could run when it shouldn't. Please unplug it now and leave it unplugged; don't use it again until an appliance engineer has checked it. ${F.HV} I'm not recommending a part from this.`,
};
const compose = ck.createCompose({
  ASK_GUARD: true, TASK, CONFIRM_ASK: 'Is that clear?', OBS_COPY: { startsWhenDoorCloses: ['starts by itself when the door closes', null] }, CHECK_RESULT_COPY: {},
  conclusionCopy: ck.makeConclusionCopy({ FAMILY_LABEL, COMPONENT_LABEL: {}, CONCLUSION }),
  PURCHASE_RE: /\b(buy|order|purchase|price|£\s?\d)|\b(new|replacement|replace the)\s+(door switch|interlock|relay|pcb|control board|magnetron)\b/i,
});
module.exports = { SPEC, FAMILY, diagnose, P, ...pipeline, FAMILY_LABEL, COMPONENT_LABEL: {}, TASK, REQUIREMENT: ck.REQUIREMENT, SAFETY_COPY: ck.SAFETY_COPY, ...compose };
