'use strict';
/**
 * Vacuum journey 6 — noisy (rules VY1–VY22). PURE, deterministic.
 * Design: docs/diagnostics/final-migration-evidence.md §VAC6.
 *   the kind of noise → a whistle / change in pitch = a blockage or an unseated filter · a rattle / click = something caught
 *   in the brush bar or head · checks: blockage → brush bar → bin / filters seated → all clear with a grinding / screech from
 *   the main body → motor bearing or fan (repairer; never a motor part from a noise).
 */
const engine = require('./evidence-engine.js');
const kit = require('./policy-kit.js');
const JP = require('./journey-pipeline.js');
const F = require('./vac-family.js');
const ck = require('./compose-kit.js');
const { SS, S, SA } = engine;

const KEY = 'vacuum-noisy';
const NOISE = ['grindingNoise', 'squealNoise', 'rattlingNoise', 'clickingNoise', 'humNoise', 'scrapingNoise', 'knockingNoise', 'gurglingNoise'];
const FAMILY = { BL: 'airflow-blockage', BB: 'brush-bar-or-head', BF: 'bin-or-filter-seating', MB: 'motor-bearing-or-fan' };
const RESTORED = { restoredAfterFilterFix: SA, restoredAfterBlockFix: SA, restoredAfterBrushFix: SA };
const SIGNALS = {
  BL: { blockFixed: SS, blockStuck: SS, hoseSplit: SS, whistle: S, restoredAfterBlockFix: SS, failsAfterBlockFix: SA, blockOk: SA },
  BB: { brushFixed: SS, brushBroken: SS, rattle: S, click: S, restoredAfterBrushFix: SS, failsAfterBrushFix: SA, brushOk: SA },
  BF: { filterFixed: SS, filterTorn: SS, whistle: S, restoredAfterFilterFix: SS, failsAfterFilterFix: SA, filterOk: SA },
  MB: { grinding: S, squeal: S, blockOk: S, brushOk: S, filterOk: S, failsAfterBlockFix: S, failsAfterBrushFix: S, failsAfterFilterFix: S,
    hoseSplit: SA, brushBroken: SA, filterTorn: SA, blockStuck: SA, ...RESTORED },
};
const FACT_LABEL = {
  whistle: 'whistle / high pitch', rattle: 'rattling', click: 'clicking', grinding: 'grinding', squeal: 'screeching / squealing',
  blockFixed: 'blockage found (cleared)', blockStuck: 'blockage that will not clear', hoseSplit: 'hose split', blockOk: 'no blockage',
  brushFixed: 'something caught in the brush bar (cleared)', brushBroken: 'brush bar broken', brushOk: 'brush bar clean, turns freely',
  filterFixed: 'filter / bin not seated or clogged (sorted)', filterTorn: 'filter damaged (torn or broken)', filterOk: 'filters seated and clean',
};
const SPEC = {
  schema: 'vac6-diag/1', FAMILY, PRIOR: ['BL', 'BB', 'BF', 'MB'], SIGNALS, FACT_LABEL,
  obs: { whistle: ['whistleNoise', true], rattle: ['rattlingNoise', true], click: ['clickingNoise', true], grinding: ['grindingNoise', true], squeal: ['squealNoise', true] },
  checks: { 'vacuum-blockage': { clear: 'blockOk', cleared: 'blockFixed', notCleared: 'blockStuck', fault: 'hoseSplit' },
    'brush-bar-clear': { clear: 'brushOk', found: 'brushFixed', fault: 'brushBroken' }, 'vacuum-bin-filters': { clear: 'filterOk', found: 'filterFixed', fault: 'filterTorn' } },
  FIX_CHECK: { BL: ['vacuum-blockage', 'Block'], BB: ['brush-bar-clear', 'Brush'], BF: ['vacuum-bin-filters', 'Filter'] },
  DECISIVE_PART: { BL: { hoseSplit: 'vacuum-hose' }, BB: { brushBroken: 'vacuum-brush-bar' }, BF: { filterTorn: 'vacuum-filter' } },
  extra(s, ctx, on) { F.typeFacts(on, F.vacType(s)); },
};
function diagnose(state, ctx = {}) { return engine.diagnoseSpec(SPEC, state, { ...ctx, codeFault: null }); }
const damaged = (h) => h.has('filterTorn') || h.has('hoseSplit') || h.has('brushBroken') || h.has('blockStuck');
const P = kit.makeStepPolicy({
  JOURNEY: KEY, P: 'VY', appliance: 'vacuum', journeys: ['noisy'], ...F.owns(KEY), declineUnsafe: F.UNSAFE,
  CHECKS: ['vacuum-blockage', 'brush-bar-clear', 'vacuum-bin-filters'],
  OBS_TARGETS: { noiseType: NOISE },
  REQUIRES: { noiseType: [], 'vacuum-blockage': ['vac_power_off'], 'brush-bar-clear': ['vac_power_off'], 'vacuum-bin-filters': ['vac_power_off', 'vac_filter_dry'], retest: [] },
  FIX_CHECKS: ['vacuum-blockage', 'brush-bar-clear', 'vacuum-bin-filters'],
  fixResults: { 'vacuum-blockage': ['found_and_cleared'] },
  steps: [
    { n: 10, target: 'noiseType', reason: 'kind-of-noise', when: (h) => h.obs('whistleNoise') !== true && !NOISE.some((k) => h.obs(k) === true) },
    { n: 11, target: 'vacuum-blockage', reason: 'whistle-or-pitch-change', when: (h) => !damaged(h) },
    { n: 12, target: 'brush-bar-clear', reason: 'caught-in-brush-or-head', when: (h) => !damaged(h) },
    { n: 13, target: 'vacuum-bin-filters', reason: 'filter-seating', when: (h) => !damaged(h) },
  ],
  PART_FAMILIES: new Set(['BL', 'BB', 'BF']),
  HANDOFF: { BL: 'none', BB: 'none', BF: 'none', MB: 'engineer' },
});
const pipeline = JP.makeModelPartPipeline({ D: { diagnose }, P, schema: 'vac6/1', codeFaultFor: F.vacCodeFault, PART_MATCH: F.PART_MATCH, MEDIA_BY_KEY: {} });

// ---- COMPOSE (wording only) ----
const FAMILY_LABEL = { 'airflow-blockage': 'a blockage in the hose, wand or head', 'brush-bar-or-head': 'something caught in the brush bar or floorhead', 'bin-or-filter-seating': 'a bin or filter not seated properly',
  'motor-bearing-or-fan': 'the motor bearing or fan' };
const COMPONENT_LABEL = { 'vacuum-filter': 'filter', 'vacuum-hose': 'hose', 'vacuum-brush-bar': 'brush bar' };
const TASK = {
  'ask_observation:noiseType': { say: 'The kind of noise points to where it comes from.', ask: 'Is it a high-pitched whistle, a rattle or click, a grinding or screeching from the main body, or something else?' },
  'ask_check:vacuum-blockage': { say: 'A whistle or a change in pitch usually means a part-blocked airway. With it switched off, look through the hose, wand and floorhead neck and check the bin inlet.', ask: 'Did you find a blockage and clear it, is there one you can\'t shift, is the hose split, or was it all clear?' },
  'ask_check:brush-bar-clear': { say: 'A rattle or click is often something caught in the floorhead. Turn it over and remove anything stuck, cut away tangles and check the brush bar (roller) turns freely.', ask: 'Was something caught (and is it clear now), is the bar broken, or was it clean and turning freely?' },
  'ask_check:vacuum-bin-filters': { say: 'Check the bin clicks fully home and each filter is seated properly (and dry) — a gap makes it whistle.', ask: 'Was the bin or a filter not seated or clogged (and is it sorted), is a filter torn or damaged, or was everything seated and clean?' },
  'ask_check:retest': { say: 'Switch it on and listen.', ask: 'Has the noise gone, or is it still there?' },
  'ask_identity:model': F.VAC_MODEL_ASK, 'ask_identity:appliance': F.VAC_APPLIANCE_ASK,
};
const CONCLUSION = {
  'VY7:airflow-blockage': 'Clearing the blockage very likely fixed it, so no part is needed.',
  'VY7:brush-bar-or-head': 'Clearing the floorhead very likely fixed it, so no part is needed.',
  'VY7:bin-or-filter-seating': 'That was the bin / filter seating, so no part is needed.',
  'airflow-blockage': 'There\'s a blockage that won\'t shift. Don\'t poke anything sharp into it — a repairer can clear it. I\'m not recommending a part from this.',
  'motor-bearing-or-fan': 'With the airways, brush bar and filters all clear, a grinding or screech from the main body points to the motor bearing or fan. Please stop using it if it\'s getting worse or smells hot; a repairer is the next step — I\'m not recommending a part from a noise.',
};
const compose = ck.createCompose({
  ASK_GUARD: true, TASK, CONFIRM_ASK: 'Has the noise gone?',
  OBS_COPY: { whistleNoise: ['whistling', null], rattlingNoise: ['rattling', null], clickingNoise: ['clicking', null], grindingNoise: ['grinding', null], squealNoise: ['screeching', null], humNoise: ['humming', null],
    faultPersists: ['still noisy', 'noise gone'] },
  CHECK_RESULT_COPY: { 'vacuum-blockage': { clear: 'no blockage', found_and_cleared: 'blockage cleared', found_not_cleared: 'blockage stuck', fault_seen: 'hose split' },
    'brush-bar-clear': { clear: 'brush bar clean', found_and_cleared: 'floorhead cleared', fault_seen: 'brush bar broken' },
    'vacuum-bin-filters': { clear: 'filters seated', found_and_cleared: 'bin / filters reseated', fault_seen: 'filter damaged (torn or broken)' } },
  statusChecks: [['retest', 'retest']],
  conclusionCopy: ck.makeConclusionCopy({ FAMILY_LABEL, COMPONENT_LABEL, CONCLUSION, fitNote: 'It fits by hand with the vacuum switched off — no tools needed.' }),
  PURCHASE_RE: /\b(buy|order|purchase|price|£\s?\d)|\b(new|replacement|replace the)\s+(motor|bearing|fan|filter|hose|brush\s*bar)\b/i,
});
module.exports = { SPEC, FAMILY, diagnose, P, ...pipeline, FAMILY_LABEL, COMPONENT_LABEL, TASK, REQUIREMENT: ck.REQUIREMENT, SAFETY_COPY: ck.SAFETY_COPY, ...compose };
