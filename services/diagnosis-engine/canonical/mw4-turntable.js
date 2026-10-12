'use strict';
/**
 * Microwave journey 4 — turntable not turning (rules MT1–MT22). PURE, deterministic.
 * Design: docs/diagnostics/final-migration-evidence.md §MW4. External, safe path only: the tray on its coupler, the roller
 * ring clean, nothing catching (owner) → a broken coupler / roller ring (owner-seen) → that part with a model · all fine but
 * still not turning → the turntable motor (inside the casing: engineer, no part).
 */
const engine = require('./evidence-engine.js');
const kit = require('./policy-kit.js');
const JP = require('./journey-pipeline.js');
const F = require('./mw-family.js');
const ck = require('./compose-kit.js');
const { SS, S, SA } = engine;

const KEY = 'mw-turntable';
const FAMILY = { OB: 'tray-seating-or-obstruction', BR: 'coupler-or-roller-ring', TM: 'turntable-motor' };
const SIGNALS = {
  OB: { partsFixed: SS, restoredAfterPartsFix: SS, failsAfterPartsFix: SA, partsOk: SA },
  BR: { partBroken: SS, partsOk: SA },
  TM: { still: S, partsOk: S, failsAfterPartsFix: S, partBroken: SA, restoredAfterPartsFix: SA },
};
const FACT_LABEL = { still: 'turntable not turning', partsFixed: 'tray off the coupler / roller dirty / catching (sorted)', partBroken: 'coupler / roller ring broken', partsOk: 'tray, coupler and roller ring fine' };
const SPEC = {
  schema: 'mw4-diag/1', FAMILY, PRIOR: ['OB', 'BR', 'TM'], SIGNALS, FACT_LABEL,
  obs: { still: ['turntableTurns', false] },
  checks: { 'turntable-parts': { clear: 'partsOk', found: 'partsFixed', fault: 'partBroken' } },
  FIX_CHECK: { OB: ['turntable-parts', 'Parts'] },
  DECISIVE_PART: { BR: { partBroken: 'turntable-coupler-or-ring' } },
};
function diagnose(state, ctx = {}) {
  const codeFault = ctx.codeFault !== undefined ? ctx.codeFault : F.mwCodeFault(state, ctx.errorCodes || null);
  return engine.diagnoseSpec(SPEC, state, { ...ctx, codeFault });
}
const P = kit.makeStepPolicy({
  JOURNEY: KEY, P: 'MT', appliance: 'microwave', journeys: ['turntable-not-turning'], ...F.owns(KEY), declineUnsafe: F.UNSAFE,
  CHECKS: ['turntable-parts'],
  OBS_TARGETS: {},
  REQUIRES: { 'turntable-parts': ['mw_no_casing'], retest: [] },
  FIX_CHECKS: ['turntable-parts'],
  steps: [{ n: 10, target: 'turntable-parts', reason: 'tray-coupler-roller', when: () => true }],
  PART_FAMILIES: new Set(['BR']),
  HANDOFF: { OB: 'none', BR: 'engineer', TM: 'engineer' },
});
const pipeline = JP.makeModelPartPipeline({
  D: { diagnose }, P, schema: 'mw4/1', codeFaultFor: F.mwCodeFault,
  PART_MATCH: { 'turntable-coupler-or-ring': { re: /turntable\s+(coupler|coupling|roller|roller ring)|roller\s+ring|\bcoupler\b|\bcoupling\b/i, not: /motor|glass|plate|tray|diameter/i } },
  MEDIA_BY_KEY: {},
});

// ---- COMPOSE (wording only) ----
const FAMILY_LABEL = { 'tray-seating-or-obstruction': 'the tray not sitting on its drive or something catching', 'coupler-or-roller-ring': 'a broken coupler or roller ring', 'turntable-motor': 'the turntable motor' };
const COMPONENT_LABEL = { 'turntable-coupler-or-ring': 'turntable coupler / roller ring' };
const TASK = {
  'ask_check:turntable-parts': { say: 'Lift the glass tray out. Check the small three-pronged coupler in the middle isn\'t cracked, clean the roller ring and the floor under it, then refit the tray so its grooves sit on the coupler — and make sure a large dish isn\'t catching the sides.', ask: 'Was the tray off the coupler, dirty or catching (and is it sorted), is the coupler or roller ring broken, or did it all look fine?' },
  'ask_check:retest': { say: 'Try it with a cup of water for a minute.', ask: 'Is the turntable turning now, or still not?' },
  'ask_identity:model': F.MW_MODEL_ASK, 'ask_identity:appliance': F.MW_APPLIANCE_ASK,
};
const CONCLUSION = {
  'MT7:tray-seating-or-obstruction': 'That was the tray seating / something catching, so no part is needed.',
  'turntable-motor': `With the tray, coupler and roller ring fine but the turntable still not turning, the turntable motor underneath is the likely cause. ${F.HV} An appliance engineer is the next step — I'm not recommending a part from this.`,
};
const compose = ck.createCompose({
  ASK_GUARD: true, TASK, CONFIRM_ASK: 'Is the turntable turning now?',
  OBS_COPY: { turntableTurns: ['turntable turns', 'turntable still'], faultPersists: ['still not turning', 'turning now'] },
  CHECK_RESULT_COPY: { 'turntable-parts': { clear: 'tray, coupler, ring fine', found_and_cleared: 'tray / ring sorted', fault_seen: 'coupler / ring broken' } },
  statusChecks: [['retest', 'retest']],
  conclusionCopy: ck.makeConclusionCopy({ FAMILY_LABEL, COMPONENT_LABEL, CONCLUSION, fitNote: 'It simply sits under the glass tray — no tools or casing removal needed.' }),
  PURCHASE_RE: /\b(buy|order|purchase|price|£\s?\d)|\b(new|replacement|replace the)\s+(motor|turntable motor|coupler|roller|ring|tray|glass)\b/i,
});
module.exports = { SPEC, FAMILY, diagnose, P, ...pipeline, FAMILY_LABEL, COMPONENT_LABEL, TASK, REQUIREMENT: ck.REQUIREMENT, SAFETY_COPY: ck.SAFETY_COPY, ...compose };
