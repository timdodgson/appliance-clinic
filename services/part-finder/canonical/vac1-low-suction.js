'use strict';
/**
 * Vacuum journey 1 — weak / lost suction (rules VS1–VS22). PURE, deterministic.
 * Design: docs/diagnostics/final-migration-evidence.md §VAC1. Airflow first, owner checks only:
 *   bin / bag + filters (washed AND fully dry) → hose / wand / floorhead neck blockage → brush bar tangled →
 *   all clear but still weak → an internal seal / motor area (engineer — never a motor from weak suction alone).
 * Parts only from an owner-seen fault + a confirmed model: torn filter → filter; split hose → hose; broken brush bar → brush bar.
 */
const engine = require('./evidence-engine.js');
const kit = require('./policy-kit.js');
const JP = require('./journey-pipeline.js');
const F = require('./vac-family.js');
const ck = require('./compose-kit.js');
const { SS, S, SA } = engine;

const KEY = 'vacuum-low-suction';
const FAMILY = { BF: 'bin-or-filters', BL: 'airflow-blockage', BB: 'brush-bar-tangled', MA: 'internal-seal-or-motor-area' };
const SIGNALS = {
  BF: { filterFixed: SS, filterTorn: SS, restoredAfterFilterFix: SS, failsAfterFilterFix: SA, filterOk: SA },
  BL: { blockFixed: SS, blockStuck: SS, hoseSplit: SS, whistle: S, restoredAfterBlockFix: SS, failsAfterBlockFix: SA, blockOk: SA },
  BB: { brushFixed: SS, brushBroken: SS, restoredAfterBrushFix: SS, failsAfterBrushFix: SA, brushOk: SA },
  MA: { filterOk: S, blockOk: S, brushOk: S, failsAfterFilterFix: S, failsAfterBlockFix: S, failsAfterBrushFix: S,
    filterTorn: SA, hoseSplit: SA, blockStuck: SA, brushBroken: SA, restoredAfterFilterFix: SA, restoredAfterBlockFix: SA, restoredAfterBrushFix: SA },
};
const FACT_LABEL = {
  filterFixed: 'bin full / filter clogged (sorted)', filterTorn: 'filter damaged (torn or broken)', filterOk: 'bin empty, filters clean and dry',
  blockFixed: 'blockage found (cleared)', blockStuck: 'blockage that will not clear', hoseSplit: 'hose split', blockOk: 'hose, wand and head clear', whistle: 'high-pitched whistle',
  brushFixed: 'brush bar tangled (cleared)', brushBroken: 'brush bar broken', brushOk: 'brush bar clean, turns freely',
  cordless: 'cordless', corded: 'corded', robot: 'robot',
};
const SPEC = {
  schema: 'vac1-diag/1', FAMILY, PRIOR: ['BF', 'BL', 'BB', 'MA'], SIGNALS, FACT_LABEL,
  obs: { whistle: ['whistleNoise', true] },
  checks: { 'vacuum-bin-filters': { clear: 'filterOk', found: 'filterFixed', fault: 'filterTorn' },
    'vacuum-blockage': { clear: 'blockOk', cleared: 'blockFixed', notCleared: 'blockStuck', fault: 'hoseSplit' },
    'brush-bar-clear': { clear: 'brushOk', found: 'brushFixed', fault: 'brushBroken' } },
  FIX_CHECK: { BF: ['vacuum-bin-filters', 'Filter'], BL: ['vacuum-blockage', 'Block'], BB: ['brush-bar-clear', 'Brush'] },
  DECISIVE_PART: { BF: { filterTorn: 'vacuum-filter' }, BL: { hoseSplit: 'vacuum-hose' }, BB: { brushBroken: 'vacuum-brush-bar' } },
  extra(s, ctx, on) { F.typeFacts(on, F.vacType(s)); },
};
function diagnose(state, ctx = {}) { return engine.diagnoseSpec(SPEC, state, { ...ctx, codeFault: null }); }
const damaged = (h) => h.has('filterTorn') || h.has('hoseSplit') || h.has('brushBroken');
const P = kit.makeStepPolicy({
  JOURNEY: KEY, P: 'VS', appliance: 'vacuum', journeys: ['lost-suction'], ...F.owns(KEY), declineUnsafe: F.UNSAFE,
  CHECKS: ['vacuum-bin-filters', 'vacuum-blockage', 'brush-bar-clear'],
  OBS_TARGETS: {},
  REQUIRES: { 'vacuum-bin-filters': ['vac_power_off', 'vac_filter_dry'], 'vacuum-blockage': ['vac_power_off'], 'brush-bar-clear': ['vac_power_off'], retest: [] },
  FIX_CHECKS: ['vacuum-bin-filters', 'vacuum-blockage', 'brush-bar-clear'],
  fixResults: { 'vacuum-blockage': ['found_and_cleared'] },
  steps: [
    { n: 10, target: 'vacuum-bin-filters', reason: 'bin-and-filters-airflow', when: () => true },
    { n: 11, target: 'vacuum-blockage', reason: 'hose-wand-head-blockage', when: (h) => !damaged(h) },
    { n: 12, target: 'brush-bar-clear', reason: 'brush-bar-pickup', when: (h) => !damaged(h) && !h.has('blockStuck') },
  ],
  PART_FAMILIES: new Set(['BF', 'BL', 'BB']),
  HANDOFF: { BF: 'none', BL: 'none', BB: 'none', MA: 'engineer' },
});
const pipeline = JP.makeModelPartPipeline({ D: { diagnose }, P, schema: 'vac1/1', codeFaultFor: F.vacCodeFault, PART_MATCH: F.PART_MATCH,
  MEDIA_BY_KEY: { 'vacuum-bin-filters': { knowledgeId: 'vacuum:lost-suction', ids: ['vac-lost-suction'], concepts: [] } } });

// ---- COMPOSE (wording only) ----
const FAMILY_LABEL = { 'bin-or-filters': 'a full bin or clogged filters', 'airflow-blockage': 'a blockage in the hose, wand or floorhead', 'brush-bar-tangled': 'a tangled brush bar',
  'internal-seal-or-motor-area': 'an internal seal or the motor area' };
const COMPONENT_LABEL = { 'vacuum-filter': 'filter', 'vacuum-hose': 'hose', 'vacuum-brush-bar': 'brush bar' };
const TASK = {
  'ask_check:vacuum-bin-filters': { say: 'Weak suction is nearly always airflow. With it switched off (battery out or unplugged), empty the bin or change the bag, then wash the filters in cold water only and leave them to dry fully — at least 24 hours. A damp filter chokes the airflow too.', ask: 'Was the bin full or a filter clogged (and is it sorted), is a filter torn or damaged, or was it all clean already?' },
  'ask_check:vacuum-blockage': { say: 'Detach the hose and wand and look through each one — a coin dropped through should fall straight out. Check the neck of the floorhead and the bin inlet too.', ask: 'Did you find a blockage and clear it, is there one you can\'t shift, is the hose split, or was it all clear?' },
  'ask_check:brush-bar-clear': { say: 'Turn the floorhead over and cut away any hair or thread wrapped round the brush bar (roller), then check it turns freely by hand.', ask: 'Was it tangled (and is it clear now), is the brush bar broken, or was it already clean?' },
  'ask_check:retest': { say: 'Try it on a hard floor with the filters fully dry.', ask: 'Is the suction back to normal now, or still weak?' },
  'ask_identity:model': F.VAC_MODEL_ASK, 'ask_identity:appliance': F.VAC_APPLIANCE_ASK,
};
const CONCLUSION = {
  'VS7:bin-or-filters': 'That was the bin / filters, so no part is needed. Wash the filters about once a month and always let them dry fully.',
  'VS7:airflow-blockage': 'Clearing the blockage very likely fixed it, so no part is needed.',
  'VS7:brush-bar-tangled': 'Clearing the brush bar very likely fixed it, so no part is needed.',
  'airflow-blockage': 'There\'s a blockage that won\'t shift. Don\'t poke anything sharp into the hose — a blunt flexible rod can help; if it\'s stuck inside the main body, a repairer can clear it. I\'m not recommending a part from this.',
  'internal-seal-or-motor-area': 'With the bin, filters, hose and brush bar all clear but the suction still weak, the problem is inside — usually a leaking seal or the motor area. That needs a repairer to look at — I\'m not recommending a motor or any part from weak suction alone.',
};
const compose = ck.createCompose({
  ASK_GUARD: true, TASK, CONFIRM_ASK: 'Is the suction back to normal now?',
  OBS_COPY: { weakSuction: ['weak suction', null], whistleNoise: ['whistling', null], vacuumCordless: ['cordless', null], vacuumCorded: ['corded', null], vacuumRobot: ['robot', null], faultPersists: ['still weak', 'suction back'] },
  CHECK_RESULT_COPY: { 'vacuum-bin-filters': { clear: 'bin and filters clean', found_and_cleared: 'bin / filters sorted', fault_seen: 'filter damaged (torn or broken)' },
    'vacuum-blockage': { clear: 'no blockage', found_and_cleared: 'blockage cleared', found_not_cleared: 'blockage stuck', fault_seen: 'hose split' },
    'brush-bar-clear': { clear: 'brush bar clean', found_and_cleared: 'brush bar cleared', fault_seen: 'brush bar broken' } },
  statusChecks: [['retest', 'retest']],
  conclusionCopy: ck.makeConclusionCopy({ FAMILY_LABEL, COMPONENT_LABEL, CONCLUSION, fitNote: 'It fits by hand with the vacuum switched off — no tools needed.' }),
  PURCHASE_RE: /\b(buy|order|purchase|price|£\s?\d)|\b(new|replacement|replace the)\s+(motor|filter|hose|brush\s*bar|battery|charger|head|floorhead)\b/i,
});
module.exports = { SPEC, FAMILY, diagnose, P, ...pipeline, FAMILY_LABEL, COMPONENT_LABEL, TASK, REQUIREMENT: ck.REQUIREMENT, SAFETY_COPY: ck.SAFETY_COPY, ...compose };
