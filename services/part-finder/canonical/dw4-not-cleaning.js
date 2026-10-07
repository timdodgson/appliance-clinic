'use strict';
/**
 * Dishwasher journey 4 — not cleaning (rules C1–C22). PURE, deterministic.
 * Design: docs/diagnostics/dw-batch-1-evidence.md §4. Rack location (top / bottom / all) → filter → spray arms / jets →
 * loading clearance → tablet / dispenser → water gets hot? → fill adequate? → programme. Cold water hands the problem to
 * dw-not-heating-drying, a poor fill to dw-not-filling (typed ownership, once). Poor cleaning alone never yields a
 * circulation pump: with everything accessible clear it is a circulation / distribution AREA for an engineer.
 */
const engine = require('./evidence-engine.js');
const kit = require('./policy-kit.js');
const JP = require('./journey-pipeline.js');
const F = require('./dw-family.js');
const ck = require('./compose-kit.js');
const { SS, S, A, SA } = engine;

const FAMILY = { FL: 'dirty-filter', SA: 'spray-arm-jets', LO: 'loading', DT: 'detergent-or-dispenser', PG: 'programme-choice', AB: 'spray-arm-damaged', CP: 'circulation-or-distribution' };
const SIGNALS = {
  FL: { filterDirty: SS, restoredAfterFilterFix: SS, failsAfterFilterFix: SA, all: S, filterClean: SA },
  SA: { armsCleared: SS, restoredAfterArmsFix: SS, failsAfterArmsFix: SA, upper: S, lower: S, armsOk: SA, armBroken: A },
  LO: { loadingFixed: SS, restoredAfterLoadingFix: SS, failsAfterLoadingFix: SA, upper: S, lower: S, loadingOk: SA },
  DT: { tablet: SS, dispFixed: SS, dispBroken: SS, restoredAfterDispFix: SS, failsAfterDispFix: SA, all: S, tabletOk: SA, dispOk: SA },
  PG: { progFixed: SS, restoredAfterProgFix: SS, failsAfterProgFix: SA, all: S, progOk: SA },
  AB: { armBroken: SS, upper: S, lower: S, armsOk: SA },
  CP: { all: S, upper: S, filterClean: S, armsOk: S, loadingOk: S, tabletOk: S, heatOk: S, fillOk: S, progOk: S, codeCirc: SS,
    filterDirty: A, armsCleared: A, loadingFixed: A, tablet: A, armBroken: A, progFixed: A, dispFixed: A,
    restoredAfterFilterFix: SA, restoredAfterArmsFix: SA, restoredAfterLoadingFix: SA, restoredAfterDispFix: SA, restoredAfterProgFix: SA },
};
const FACT_LABEL = {
  upper: 'top rack only', lower: 'bottom rack only', all: 'everything', filterDirty: 'filter dirty (cleaned)', filterClean: 'filter clean', armsCleared: 'arm stuck / jets blocked (cleared)',
  armsOk: 'arms turn, jets clear', armBroken: 'spray arm cracked / broken', loadingFixed: 'item blocking an arm (moved)', loadingOk: 'nothing blocking the arms',
  tablet: 'tablet left undissolved', tabletOk: 'tablet dissolves', dispFixed: 'dispenser blocked / sticking (fixed)', dispBroken: 'dispenser flap broken', dispOk: 'dispenser opens',
  progFixed: 'programme / setting changed', progOk: 'suitable programme', heatOk: 'water gets hot', fillOk: 'fills normally', codeCirc: 'circulation-pump error code',
};
const SPEC = {
  schema: 'dw4-diag/1', FAMILY, PRIOR: ['FL', 'SA', 'LO', 'DT', 'PG', 'AB', 'CP'], SIGNALS, FACT_LABEL,
  obs: { upper: ['poorUpperRack', true], lower: ['poorLowerRack', true], all: ['poorAllRacks', true], tablet: ['tabletUndissolved', true], tabletOk: ['tabletUndissolved', false],
    heatOk: ['heatPresent', true], fillOk: ['waterEntering', true] },
  checks: { 'dishwasher-filter': { clear: 'filterClean', found: 'filterDirty' }, 'spray-arms': { clear: 'armsOk', found: 'armsCleared', fault: 'armBroken' },
    'loading-clearance': { clear: 'loadingOk', found: 'loadingFixed' }, 'dw-dispenser': { clear: 'dispOk', found: 'dispFixed', fault: 'dispBroken' },
    'programme-setting': { clear: 'progOk', found: 'progFixed' } },
  FIX_CHECK: { FL: ['dishwasher-filter', 'Filter'], SA: ['spray-arms', 'Arms'], LO: ['loading-clearance', 'Loading'], DT: ['dw-dispenser', 'Disp'], PG: ['programme-setting', 'Prog'] },
  DECISIVE_PART: { AB: { armBroken: 'spray-arm' }, DT: { dispBroken: 'dispenser' } },
  extra(s, ctx, on) { on('heatOk', engine.obsVal(s, 'noHeat') === false); on('codeCirc', ctx.codeFault === 'circulation-pump'); },
  eligible: (k, has) => (k === 'AB' ? has('armBroken') : true),
};
function diagnose(state, ctx = {}) {
  const codeFault = ctx.codeFault !== undefined ? ctx.codeFault : F.dwCodeFault(state, ctx.errorCodes || null);
  return engine.diagnoseSpec(SPEC, state, { ...ctx, codeFault });
}
const AREA = ['upper', 'lower', 'all'];
const P = kit.makeStepPolicy({
  JOURNEY: 'dw-not-cleaning', P: 'C', appliance: 'dishwasher', journeys: ['poor-results'], codeFaults: [],
  ownedElsewhere: (h) => F.flood(h) || F.fillIssue(h) || F.heatIssue(h),
  CHECKS: ['dishwasher-filter', 'spray-arms', 'loading-clearance', 'dw-dispenser', 'programme-setting'],
  OBS_TARGETS: { cleanArea: ['poorUpperRack', 'poorLowerRack', 'poorAllRacks'], tabletUndissolved: ['tabletUndissolved'], heatState: ['noHeat', 'heatPresent'],
    fillState: ['waterEntering', 'fillsSlowly'] },
  REQUIRES: { 'dishwasher-filter': ['isolate_mains', 'gloves_for_glass'], 'spray-arms': ['isolate_mains'], 'loading-clearance': [], 'dw-dispenser': [], 'programme-setting': [], retest: [] },
  FIX_CHECKS: ['dishwasher-filter', 'spray-arms', 'loading-clearance', 'dw-dispenser', 'programme-setting'],
  steps: [
    { n: 10, target: 'cleanArea', reason: 'rack-location-decides', when: (h) => !AREA.some(h.has) && !h.has('tablet') },
    { n: 11, target: 'dishwasher-filter', reason: 'filter-first', when: () => true },
    { n: 12, target: 'spray-arms', reason: 'spray-arms-and-jets', when: () => true },
    { n: 13, target: 'loading-clearance', reason: 'loading-blocks-arms', when: (h) => !h.has('armBroken') },
    { n: 14, target: 'tabletUndissolved', reason: 'tablet-dispenser', when: (h) => !h.has('armBroken') },
    { n: 15, target: 'dw-dispenser', reason: 'dispenser-flap', when: (h) => h.has('tablet') },
    { n: 16, target: 'heatState', reason: 'hot-water-needed-to-clean', when: (h) => !h.has('armBroken') && !h.has('dispBroken') },
    { n: 17, target: 'fillState', reason: 'enough-water', when: (h) => (h.has('all') || h.has('upper')) && !h.has('armBroken') && !h.has('dispBroken') },
    { n: 18, target: 'programme-setting', reason: 'programme-for-load', when: (h) => !h.has('armBroken') && !h.has('dispBroken') },
  ],
  PART_FAMILIES: new Set(['AB', 'DT']),
  HANDOFF: { FL: 'none', SA: 'none', LO: 'none', DT: 'none', PG: 'none', AB: 'engineer', CP: 'engineer' },
});

const pipeline = JP.makeModelPartPipeline({
  D: { diagnose }, P, schema: 'dw4/1', codeFaultFor: F.dwCodeFault,
  PART_MATCH: {
    'spray-arm': { re: /spray\s+arm/i, not: /feed|pipe|tube|bearing|holder|nut/i },
    dispenser: { re: /(detergent|soap)\s+dispenser|\bdispenser\b/i, not: /rinse|softener|salt/i },
  },
  MEDIA_BY_KEY: {
    'dishwasher-filter': { knowledgeId: 'dishwasher:poor-clean-results', ids: ['dishwasher-filter'], concepts: [] },
    'spray-arms': { knowledgeId: 'dishwasher:poor-clean-results', ids: ['dishwasher-spray-arm'], concepts: [] },
  },
});

// ---- COMPOSE (wording only) ----
const FAMILY_LABEL = {
  'dirty-filter': 'a dirty filter', 'spray-arm-jets': 'blocked spray-arm jets or a stuck arm', loading: 'the loading blocking the spray', 'detergent-or-dispenser': 'the detergent or its dispenser',
  'programme-choice': 'the programme choice', 'spray-arm-damaged': 'a damaged spray arm', 'circulation-or-distribution': 'the wash circulation / water distribution inside the machine',
};
const COMPONENT_LABEL = { 'spray-arm': 'spray arm', dispenser: 'detergent dispenser' };
const TASK = {
  'ask_observation:cleanArea': { say: 'Where the dirt is left tells us a lot.', ask: 'Is it only the top rack, only the bottom rack, or everything that comes out dirty?' },
  'ask_check:dishwasher-filter': { say: 'Take out the lower rack, twist and lift out the filter in the bottom of the tub, and rinse it under a tap — a clogged filter starves the spray arms of water.', ask: 'Was the filter dirty or clogged (and is it clean now), or was it already clean?' },
  'ask_check:spray-arms': { say: 'Turn each spray arm by hand — it should spin freely — and look at the little jet holes. Most arms unclip so you can rinse them and clear the holes with a cocktail stick.', ask: 'Was an arm stuck or were the jets blocked (and are they clear now), is an arm cracked or broken, or were they all fine?' },
  'ask_check:loading-clearance': { say: 'With a normal load in, turn each spray arm by hand again — tall pans, trays or a hanging utensil can stop an arm or block the spray.', ask: 'Was anything stopping an arm (and have you moved it), or did they all turn freely?' },
  'ask_observation:tabletUndissolved': { say: 'Next, the detergent.', ask: 'At the end of the programme, is the tablet still sitting in the dispenser (or half-dissolved), or has it gone?' },
  'ask_check:dw-dispenser': { say: 'Check the detergent flap opens freely when you press its catch, and that nothing tall in the front of the racks blocks it from opening during the wash.', ask: 'Was something blocking it or was it sticking (and is it sorted), is the flap or catch broken, or does it open fine?' },
  'ask_observation:heatState': { say: 'Dishwashers need hot water to clean properly.', ask: 'At the end of a normal programme, are the dishes and the inside of the door hot (with some steam), or still cold?' },
  'ask_observation:fillState': { say: 'It also needs enough water.', ask: 'Does it seem to take in water normally, or only a little (or none)?' },
  'ask_check:programme-setting': { say: 'Quick, eco and glass programmes are gentler — they often won\'t shift dried-on food on a full load.', ask: 'Have you been using a quick or eco programme (and will you try a normal or intensive one), or already using a normal / intensive programme?' },
  'ask_check:retest': { say: 'Now run a normal programme with a typical load.', ask: 'Are the dishes coming out clean now, or still dirty?' },
  'ask_identity:model': { say: 'To match the right part for your dishwasher I need its exact model.', ask: 'Could you send me the model number? It\'s on the rating plate along the edge of the door or the side of the tub — a photo of the label is fine.' },
  'ask_identity:appliance': { say: '', ask: 'Is it a dishwasher, a washing machine or a washer-dryer?' },
};
const CONCLUSION = {
  'C7:dirty-filter': 'The clogged filter was very likely the cause, so no part is needed. Rinsing it every week or two keeps the cleaning up.',
  'C7:spray-arm-jets': 'Clearing the spray arms very likely fixed it, so no part is needed.',
  'C7:loading': 'That was the loading blocking the spray, so no part is needed.',
  'C7:detergent-or-dispenser': 'Sorting the dispenser very likely fixed it, so no part is needed.',
  'C7:programme-choice': 'The programme was the reason, so no part is needed — use normal or intensive for heavily soiled loads.',
  'circulation-or-distribution': 'With the filter, spray arms, loading, detergent, heat and fill all fine, the wash circulation or water distribution inside the machine (the wash pump or the valve that feeds the top arm) is the likely area. That needs an appliance engineer to confirm — I\'m not recommending a part from this.',
};
const compose = ck.createCompose({
  TASK, CONFIRM_ASK: 'Are the dishes coming out clean now?',
  OBS_COPY: { poorUpperRack: ['top rack only', null], poorLowerRack: ['bottom rack only', null], poorAllRacks: ['everything dirty', null],
    tabletUndissolved: ['tablet left in the dispenser', 'tablet dissolves'], heatPresent: ['dishes get hot', null], noHeat: ['stays cold', 'gets hot'],
    waterEntering: ['fills normally', 'no water'], fillsSlowly: ['only a little water', null], faultPersists: ['still dirty after the fix', 'clean after the fix'] },
  CHECK_RESULT_COPY: {
    'dishwasher-filter': { clear: 'filter clean', found_and_cleared: 'filter dirty (cleaned)' },
    'spray-arms': { clear: 'arms turn, jets clear', found_and_cleared: 'arm stuck / jets blocked (cleared)', fault_seen: 'spray arm damaged' },
    'loading-clearance': { clear: 'nothing blocking the arms', found_and_cleared: 'item blocking an arm (moved)' },
    'dw-dispenser': { clear: 'dispenser opens', found_and_cleared: 'dispenser blocked / sticking (sorted)', fault_seen: 'dispenser flap broken' },
    'programme-setting': { clear: 'normal / intensive programme', found_and_cleared: 'programme changed' },
  },
  statusChecks: [['retest', 'retest']],
  conclusionCopy: ck.makeConclusionCopy({ FAMILY_LABEL, COMPONENT_LABEL, CONCLUSION, fitNote: 'Switch the dishwasher off at the socket before fitting it; if you\'d rather not, an appliance engineer can fit it.' }),
  PURCHASE_RE: /\b(buy|order|purchase|price|£\s?\d)|\b(new|replacement|replace the)\s+(circulation pump|wash pump|pump|motor|heater|spray arm|dispenser|diverter|pcb|control board)\b/i,
});
module.exports = { SPEC, FAMILY, diagnose, P, ...pipeline, FAMILY_LABEL, COMPONENT_LABEL, TASK, REQUIREMENT: ck.REQUIREMENT, SAFETY_COPY: ck.SAFETY_COPY, ...compose };
