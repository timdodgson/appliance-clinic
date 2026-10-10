'use strict';
/**
 * Vacuum journey 2 — pulsing / surging / cutting out (rules VP1–VP22). PURE, deterministic.
 * Design: docs/diagnostics/final-migration-evidence.md §VAC2. A Dyson (and most cyclone vacuums) pulses on and off when the
 * airflow is restricted — the motor protects itself. So airflow comes FIRST:
 *   filters (washed and FULLY dry) → hose / wand / head blockage → brush bar jammed → only then, for a cordless with
 *   short-runtime / won't-charge evidence, the battery (no battery part here — that is vacuum-battery-runtime's gate) →
 *   all clear and no battery evidence → internal (repairer). A model token such as "V6" is identity, never an error code.
 */
const engine = require('./evidence-engine.js');
const kit = require('./policy-kit.js');
const JP = require('./journey-pipeline.js');
const F = require('./vac-family.js');
const ck = require('./compose-kit.js');
const { SS, S, SA } = engine;

const KEY = 'vacuum-pulsing-cutting-out';
const FAMILY = { BF: 'bin-or-filters', BL: 'airflow-blockage', BB: 'brush-bar-jammed', BT: 'battery-or-charging', MA: 'internal-motor-or-electronics' };
const RESTORED = { restoredAfterFilterFix: SA, restoredAfterBlockFix: SA, restoredAfterBrushFix: SA };
const SIGNALS = {
  BF: { filterFixed: SS, filterTorn: SS, restoredAfterFilterFix: SS, failsAfterFilterFix: SA, filterOk: SA, pulsing: S },
  BL: { blockFixed: SS, blockStuck: SS, hoseSplit: SS, whistle: S, pulsing: S, restoredAfterBlockFix: SS, failsAfterBlockFix: SA, blockOk: SA },
  BB: { brushFixed: SS, brushBroken: SS, restoredAfterBrushFix: SS, failsAfterBrushFix: SA, brushOk: SA },
  BT: { shortRun: S, noCharge: S, filterOk: S, blockOk: S, corded: SA, runtimeNormal: SA, filterTorn: SA, hoseSplit: SA, blockStuck: SA, ...RESTORED },
  MA: { filterOk: S, blockOk: S, brushOk: S, runtimeNormal: S, failsAfterFilterFix: S, failsAfterBlockFix: S, shortRun: SA, noCharge: SA,
    filterTorn: SA, hoseSplit: SA, blockStuck: SA, brushBroken: SA, ...RESTORED },
};
const FACT_LABEL = {
  pulsing: 'pulsing / surging', filterFixed: 'filter clogged / damp (sorted)', filterTorn: 'filter damaged (torn or broken)', filterOk: 'filters clean and fully dry',
  blockFixed: 'blockage found (cleared)', blockStuck: 'blockage that will not clear', hoseSplit: 'hose split', blockOk: 'no blockage', whistle: 'whistling',
  brushFixed: 'brush bar jammed (cleared)', brushBroken: 'brush bar broken', brushOk: 'brush bar turns freely',
  shortRun: 'runs only a short time', noCharge: 'will not charge', runtimeNormal: 'charges and runs its normal time', cordless: 'cordless', corded: 'corded', robot: 'robot',
};
const SPEC = {
  schema: 'vac2-diag/1', FAMILY, PRIOR: ['BF', 'BL', 'BB', 'BT', 'MA'], SIGNALS, FACT_LABEL,
  obs: { whistle: ['whistleNoise', true], shortRun: ['shortRuntime', true], noCharge: ['wontCharge', true], runtimeNormal: ['shortRuntime', false] },
  checks: { 'vacuum-bin-filters': { clear: 'filterOk', found: 'filterFixed', fault: 'filterTorn' },
    'vacuum-blockage': { clear: 'blockOk', cleared: 'blockFixed', notCleared: 'blockStuck', fault: 'hoseSplit' },
    'brush-bar-clear': { clear: 'brushOk', found: 'brushFixed', fault: 'brushBroken' } },
  FIX_CHECK: { BF: ['vacuum-bin-filters', 'Filter'], BL: ['vacuum-blockage', 'Block'], BB: ['brush-bar-clear', 'Brush'] },
  DECISIVE_PART: { BF: { filterTorn: 'vacuum-filter' }, BL: { hoseSplit: 'vacuum-hose' }, BB: { brushBroken: 'vacuum-brush-bar' } },
  extra(s, ctx, on) {
    F.typeFacts(on, F.vacType(s));
    const p = (s.problems || []).find((x) => x.status === 'active');
    on('pulsing', Boolean(p && p.journey && p.journey.value === 'pulsing'));
  },
  eligible: (k, has) => (k === 'BT' ? !has('corded') : true),
};
function diagnose(state, ctx = {}) { return engine.diagnoseSpec(SPEC, state, { ...ctx, codeFault: null }); }
const damaged = (h) => h.has('filterTorn') || h.has('hoseSplit') || h.has('brushBroken') || h.has('blockStuck');
const airflowClear = (h) => (h.has('filterOk') || h.has('failsAfterFilterFix')) && (h.has('blockOk') || h.has('failsAfterBlockFix'));
const P = kit.makeStepPolicy({
  JOURNEY: KEY, P: 'VP', appliance: 'vacuum', journeys: ['pulsing'], ...F.owns(KEY), declineUnsafe: F.UNSAFE,
  CHECKS: ['vacuum-bin-filters', 'vacuum-blockage', 'brush-bar-clear'],
  OBS_TARGETS: { vacType: ['vacuumCordless', 'vacuumCorded', 'vacuumRobot'], vacBattery: ['shortRuntime', 'wontCharge'] },
  REQUIRES: { 'vacuum-bin-filters': ['vac_power_off', 'vac_filter_dry'], 'vacuum-blockage': ['vac_power_off'], 'brush-bar-clear': ['vac_power_off'], vacType: [], vacBattery: [], retest: [] },
  FIX_CHECKS: ['vacuum-bin-filters', 'vacuum-blockage', 'brush-bar-clear'],
  fixResults: { 'vacuum-blockage': ['found_and_cleared'] },
  steps: [
    { n: 10, target: 'vacuum-bin-filters', reason: 'restricted-airflow-first', when: () => true },
    { n: 11, target: 'vacuum-blockage', reason: 'hose-wand-head-blockage', when: (h) => !damaged(h) },
    { n: 12, target: 'brush-bar-clear', reason: 'jammed-brush-bar', when: (h) => !damaged(h) },
    { n: 13, target: 'vacType', reason: 'battery-only-if-cordless', when: (h) => !damaged(h) && airflowClear(h) && F.vacType(h.s).type === 'unknown' },
    { n: 14, target: 'vacBattery', reason: 'runtime-or-charging-evidence', when: (h) => !damaged(h) && airflowClear(h) && F.vacType(h.s).type === 'cordless' },
  ],
  PART_FAMILIES: new Set(['BF', 'BL', 'BB']),
  HANDOFF: { BF: 'none', BL: 'none', BB: 'none', BT: 'none', MA: 'engineer' },
});
const pipeline = JP.makeModelPartPipeline({ D: { diagnose }, P, schema: 'vac2/1', codeFaultFor: F.vacCodeFault, PART_MATCH: F.PART_MATCH,
  MEDIA_BY_KEY: { 'vacuum-bin-filters': { knowledgeId: 'vacuum:lost-suction', ids: ['vac-lost-suction'], concepts: [] } } });

// ---- COMPOSE (wording only) ----
const FAMILY_LABEL = { 'bin-or-filters': 'clogged or damp filters', 'airflow-blockage': 'a blockage in the hose, wand or floorhead', 'brush-bar-jammed': 'a jammed brush bar',
  'battery-or-charging': 'the battery or charging', 'internal-motor-or-electronics': 'the motor or electronics inside' };
const COMPONENT_LABEL = { 'vacuum-filter': 'filter', 'vacuum-hose': 'hose', 'vacuum-brush-bar': 'brush bar' };
const TASK = {
  'ask_check:vacuum-bin-filters': { say: 'Pulsing on and off is usually the vacuum protecting itself because the airflow is restricted. With it switched off (battery out or unplugged), empty the bin, then wash the filters in cold water and let them dry fully for at least 24 hours — a filter that is even slightly damp causes pulsing.', ask: 'Was a filter clogged or damp (and is it sorted), is a filter torn or damaged, or were they clean and dry already?' },
  'ask_check:vacuum-blockage': { say: 'Detach the wand and floorhead and look through each part, and check the bin inlet — a coin dropped through the wand should fall straight out.', ask: 'Did you find a blockage and clear it, is there one you can\'t shift, is a hose split, or was it all clear?' },
  'ask_check:brush-bar-clear': { say: 'A jammed brush bar can also make it cut in and out. Turn the floorhead over, clear any hair or thread from the brush bar (roller) and check it turns freely by hand.', ask: 'Was it jammed or tangled (and is it clear now), is it broken, or did it turn freely?' },
  'ask_observation:vacType': { say: 'With the airflow clear, the type matters next.', ask: 'Is it a cordless (battery) vacuum, a corded one, or a robot?' },
  'ask_observation:vacBattery': { say: 'Only now is the battery worth looking at.', ask: 'On a full charge, does it run only a short time before stopping, will it not charge at all, or does it charge and run for its normal time?' },
  'ask_check:retest': { say: 'Try it again with the filters fully dry.', ask: 'Is it running steadily now, or still pulsing / cutting out?' },
  'ask_identity:model': F.VAC_MODEL_ASK, 'ask_identity:appliance': F.VAC_APPLIANCE_ASK,
};
const CONCLUSION = {
  'VP7:bin-or-filters': 'That was the filters, so no part is needed. Always let them dry fully before refitting — a damp filter is the most common cause of pulsing.',
  'VP7:airflow-blockage': 'Clearing the blockage very likely fixed it, so no part is needed.',
  'VP7:brush-bar-jammed': 'Clearing the brush bar very likely fixed it, so no part is needed.',
  'airflow-blockage': 'There\'s a blockage that won\'t shift. Don\'t poke anything sharp into it — a blunt flexible rod can help; if it\'s inside the main body, a repairer can clear it. I\'m not recommending a part from this.',
  'battery-or-charging': 'With the filters and airflow clear and it running only briefly (or not charging), the battery or charger is the next suspect. It\'s only worth changing the battery once the runtime has been checked from a full charge — I\'m not recommending a part from the pulsing alone.',
  'internal-motor-or-electronics': 'The filters, airflow and brush bar are clear and there\'s no sign of a battery problem, so the cause is inside — the motor or its electronics. That needs a repairer (or the manufacturer if it\'s under guarantee) — please don\'t open it up. I\'m not recommending a part from this.',
};
const compose = ck.createCompose({
  ASK_GUARD: true, TASK, CONFIRM_ASK: 'Is it running steadily now?',
  OBS_COPY: { whistleNoise: ['whistling', null], shortRuntime: ['runs only a short time', 'runs its normal time'], wontCharge: ['won\'t charge', null],
    vacuumCordless: ['cordless', null], vacuumCorded: ['corded', null], vacuumRobot: ['robot', null], cutsOut: ['cuts out', null], faultPersists: ['still pulsing', 'running steadily'] },
  CHECK_RESULT_COPY: { 'vacuum-bin-filters': { clear: 'filters clean and dry', found_and_cleared: 'filters sorted', fault_seen: 'filter damaged (torn or broken)' },
    'vacuum-blockage': { clear: 'no blockage', found_and_cleared: 'blockage cleared', found_not_cleared: 'blockage stuck', fault_seen: 'hose split' },
    'brush-bar-clear': { clear: 'brush bar turns freely', found_and_cleared: 'brush bar cleared', fault_seen: 'brush bar broken' } },
  statusChecks: [['retest', 'retest']],
  conclusionCopy: ck.makeConclusionCopy({ FAMILY_LABEL, COMPONENT_LABEL, CONCLUSION, fitNote: 'It fits by hand with the vacuum switched off — no tools needed.' }),
  PURCHASE_RE: /\b(buy|order|purchase|price|£\s?\d)|\b(new|replacement|replace the)\s+(motor|filter|hose|brush\s*bar|battery|charger|head|floorhead)\b/i,
});
module.exports = { SPEC, FAMILY, diagnose, P, ...pipeline, FAMILY_LABEL, COMPONENT_LABEL, TASK, REQUIREMENT: ck.REQUIREMENT, SAFETY_COPY: ck.SAFETY_COPY, ...compose };
