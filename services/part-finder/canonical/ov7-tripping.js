'use strict';
/**
 * Oven journey 7 — trips the electrics (rules OP1–OP22). PURE, deterministic. SAFETY-SENSITIVE.
 * Design: docs/diagnostics/final-migration-evidence.md §OV7. The turn the trip is reported: stop — don't keep resetting,
 * leave it off at the cooker switch — with ONE safe question (straight away vs after heating / one function). The journey
 * then carries on WITHOUT use: recent cleaning / moisture? → a cause family for the engineer. No live testing, no retry
 * instruction, no specific electrical part (engineer outcome is the expected end).
 */
const engine = require('./evidence-engine.js');
const kit = require('./policy-kit.js');
const JP = require('./journey-pipeline.js');
const F = require('./ov-family.js');
const ck = require('./compose-kit.js');
const { SS, S, A } = engine;

const KEY = 'oven-tripping';
const FAMILY = { MO: 'moisture-after-cleaning', EL: 'element-insulation', WR: 'wiring-terminal-or-control' };
const SIGNALS = {
  MO: { cleaned: SS, later: S },
  EL: { later: S, notCleaned: S, immediately: A },
  WR: { immediately: S, notCleaned: S, later: A },
};
const FACT_LABEL = { immediately: 'trips straight away', later: 'trips after heating / on one function', cleaned: 'recently cleaned / got wet', notCleaned: 'not recently cleaned' };
const SPEC = {
  schema: 'ov7-diag/1', FAMILY, PRIOR: ['MO', 'EL', 'WR'], SIGNALS, FACT_LABEL,
  obs: { immediately: ['tripsImmediately', true], later: ['tripsImmediately', false], cleaned: ['recentCleaning', true], notCleaned: ['recentCleaning', false] },
  checks: {}, DECISIVE_PART: {},
};
function diagnose(state, ctx = {}) {
  const codeFault = ctx.codeFault !== undefined ? ctx.codeFault : F.ovCodeFault(state, ctx.errorCodes || null);
  return engine.diagnoseSpec(SPEC, state, { ...ctx, codeFault });
}
const P = kit.makeStepPolicy({
  JOURNEY: KEY, P: 'OP', appliance: 'oven-cooker', journeys: ['trips-electrics'], ...F.owns(KEY), declineUnsafe: F.UNSAFE,
  continueAfterHazard: { supply_trip: { stop: 'oven-trip', pending: 'tripsImmediately', partOk: false } },
  CHECKS: [],
  OBS_TARGETS: { tripsImmediately: ['tripsImmediately'], recentCleaning: ['recentCleaning'] },
  REQUIRES: { tripsImmediately: ['oven_isolate_cool'], recentCleaning: ['oven_isolate_cool'] },
  steps: [
    { n: 10, target: 'tripsImmediately', reason: 'when-it-trips', when: (h) => h.obs('tripsImmediately') == null },
    { n: 11, target: 'recentCleaning', reason: 'moisture-after-cleaning', when: (h) => h.obs('recentCleaning') == null },
  ],
  PART_FAMILIES: new Set(),
  HANDOFF: { MO: 'engineer', EL: 'engineer', WR: 'engineer' },
});
const pipeline = JP.makeModelPartPipeline({ D: { diagnose }, P, schema: 'ov7/1', codeFaultFor: F.ovCodeFault, PART_MATCH: {}, MEDIA_BY_KEY: {} });

// ---- COMPOSE (wording only) ----
const OFF = 'Keep it switched off at the cooker switch until then and don\'t keep resetting the trip.';
const FAMILY_LABEL = { 'moisture-after-cleaning': 'moisture in an element after cleaning', 'element-insulation': 'an element\'s insulation breaking down', 'wiring-terminal-or-control': 'the wiring, terminal block or control' };
const TASK = {
  'ask_observation:tripsImmediately': { say: 'One detail helps the engineer.', ask: 'Does it trip as soon as it\'s switched on, or only after it has been heating for a while (or only on one function, like the grill)?' },
  'ask_observation:recentCleaning': { say: 'Moisture is a common trigger.', ask: 'Has the oven been cleaned recently with oven cleaner, steam or a lot of water, or got wet in any way?' },
  'ask_identity:appliance': F.OVEN_APPLIANCE_ASK,
};
const CONCLUSION = {
  'moisture-after-cleaning': `Tripping after cleaning is often moisture that has got into an element, but it can also be an element breaking down — only an insulation test tells them apart, and that needs an appliance engineer. ${OFF} I'm not recommending a part from this.`,
  'element-insulation': `Tripping once it has been heating (or on one function) usually points to an element whose insulation is breaking down. An appliance engineer needs to test it safely — ${OFF} I'm not recommending a part from this.`,
  'wiring-terminal-or-control': `Tripping straight away points to the wiring, the terminal block or the control. That needs an appliance engineer or electrician to find safely — ${OFF} I'm not recommending a part from this.`,
};
const compose = ck.createCompose({
  ASK_GUARD: true, TASK, CONFIRM_ASK: 'Is that clear?',
  OBS_COPY: { tripsImmediately: ['trips straight away', 'trips after heating / on one function'], recentCleaning: ['recently cleaned / wet', 'not recently cleaned'] },
  CHECK_RESULT_COPY: {},
  conclusionCopy: ck.makeConclusionCopy({ FAMILY_LABEL, COMPONENT_LABEL: {}, CONCLUSION }),
  PURCHASE_RE: /\b(buy|order|purchase|price|£\s?\d)|\b(new|replacement|replace the)\s+(element|terminal block|fan motor|wiring|pcb|control board|thermostat)\b/i,
});
module.exports = { SPEC, FAMILY, diagnose, P, ...pipeline, FAMILY_LABEL, COMPONENT_LABEL: {}, TASK, REQUIREMENT: ck.REQUIREMENT, SAFETY_COPY: ck.SAFETY_COPY, ...compose };
