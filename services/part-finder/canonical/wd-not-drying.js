'use strict';
/**
 * Washer-dryer — not drying / no heat when drying (rules WY1–WY22). PURE, deterministic. NATIVE drying model (not the
 * tumble-dryer architecture): a washer-dryer dries in the drum, condensing the moisture with a trickle of cold water
 * and pumping it away through the drain pump, so the cheap causes are different from a dryer's.
 * Design: docs/diagnostics/final-migration-evidence.md §WD-DRY.
 *   heat or no heat → the drying load vs the DRY capacity (usually about half the wash load — the most common
 *   no-part cause) → a drying programme / dryness level actually selected → (warm) the cold-water tap on (water-cooled
 *   condenser) → (warm) the pump filter (fluff collects there and the condensed water must drain) → cold air on a drying
 *   programme → drying heater / its thermostat (engineer; a part only with a drying-heater code AND no heat) · warm
 *   but damp with all checks fine → drying fan / air duct (engineer, no part).
 * A leak ONLY while drying is the condensed-water path (wd-family routes it here): the pump filter (fluff stops the
 *   condensed water draining, so it backs up) → the drain hose / standpipe → the condenser's water path inside (engineer).
 */
const engine = require('./evidence-engine.js');
const kit = require('./policy-kit.js');
const JP = require('./journey-pipeline.js');
const ck = require('./compose-kit.js');
const { codeFaultFor } = require('./j2-diagnostics.js');
const W = require('./wd-family.js');
const { SS, S, SA } = engine;

const KEY = 'wd-not-drying';
const wdCodeFault = (state, errorCodes) => codeFaultFor(state, errorCodes, 'washer-dryer');
const FAMILY = { CAP: 'drying-load-over-capacity', PG: 'drying-programme-not-set', WT: 'condenser-water-supply', LF: 'pump-filter-fluff', DH: 'drying-heater-or-thermostat',
  SN: 'drying-sensor', AF: 'drying-fan-or-air-duct', DR: 'drain-hose-or-standpipe', CL: 'condenser-water-path' };
const RESTORED = { restoredAfterCapFix: SA, restoredAfterProgFix: SA, restoredAfterTapFix: SA, restoredAfterFilterFix: SA };
const SIGNALS = {
  CAP: { capFixed: SS, restoredAfterCapFix: SS, failsAfterCapFix: SA, capOk: SA },
  PG: { progFixed: SS, restoredAfterProgFix: SS, failsAfterProgFix: SA, progOk: SA },
  WT: { tapFixed: SS, restoredAfterTapFix: SS, failsAfterTapFix: SA, tapOk: SA, warm: S, cold: SA },
  LF: { filterFixed: SS, restoredAfterFilterFix: SS, failsAfterFilterFix: SA, filterOk: SA, warm: S, cold: SA, leakDry: S },
  DR: { hoseFixed: SS, restoredAfterHoseFix: SS, failsAfterHoseFix: SA, hoseOk: SA, leakDry: S, filterOk: S, failsAfterFilterFix: S },
  CL: { leakDry: S, filterOk: S, failsAfterFilterFix: S, hoseOk: S, failsAfterHoseFix: S, restoredAfterFilterFix: SA, restoredAfterHoseFix: SA },
  DH: { codeDryHeater: SS, cold: S, progOk: S, warm: SA, ...RESTORED },
  SN: { codeDrySensor: SS, warm: S, ...RESTORED },
  AF: { warm: S, capOk: S, progOk: S, tapOk: S, filterOk: S, failsAfterCapFix: S, failsAfterTapFix: S, failsAfterFilterFix: S, cold: SA, ...RESTORED },
};
const FACT_LABEL = {
  warm: 'warm during drying', cold: 'no heat during drying', capFixed: 'drying load too big for the dry capacity (reduced)', capOk: 'drying load within the dry capacity',
  progFixed: 'no drying / too short a drying programme (changed)', progOk: 'a full drying programme selected', tapFixed: 'cold tap off / hose kinked (sorted)', tapOk: 'cold water supply on',
  filterFixed: 'pump filter full of fluff (cleaned)', filterOk: 'pump filter clean', leakDry: 'leaks only while drying',
  hoseFixed: 'drain hose kinked / standpipe blocked (sorted)', hoseOk: 'drain hose and standpipe clear', codeDryHeater: 'drying-heater error code', codeDrySensor: 'drying-sensor error code',
};
const SPEC = {
  schema: 'wdy-diag/1', FAMILY, PRIOR: ['CAP', 'PG', 'WT', 'LF', 'DR', 'DH', 'SN', 'AF', 'CL'], SIGNALS, FACT_LABEL,
  obs: {},
  checks: { 'wd-dry-capacity': { clear: 'capOk', found: 'capFixed' }, 'programme-setting': { clear: 'progOk', found: 'progFixed' },
    'inlet-hose-tap': { clear: 'tapOk', found: 'tapFixed' }, 'drain-filter': { clear: 'filterOk', found: 'filterFixed' }, 'drain-hose': { clear: 'hoseOk', found: 'hoseFixed' },
    // washer-dryers that have a separate fluff (lint) filter: the same airflow / fluff evidence as the pump filter
    'lint-filter': { clear: 'filterOk', found: 'filterFixed' } },
  FIX_CHECK: { CAP: ['wd-dry-capacity', 'Cap'], PG: ['programme-setting', 'Prog'], WT: ['inlet-hose-tap', 'Tap'], LF: ['drain-filter', 'Filter'], DR: ['drain-hose', 'Hose'] },
  DECISIVE_PART: { DH: { codeDryHeater: 'drying-heater' } },
  extra(s, ctx, on) {
    const hs = heatState(s);
    on('warm', hs === 'warm'); on('cold', hs === 'cold');
    on('codeDryHeater', ctx.codeFault === 'drying-heater'); on('codeDrySensor', ctx.codeFault === 'drying-sensor');
    on('leakDry', dryLeak(s));
  },
  // a drying-only leak is the condensed-water path; the not-drying families do not apply to it (and vice versa)
  eligible: (k, has) => (['LF', 'DR', 'CL'].includes(k) ? (k === 'LF' || has('leakDry')) : !has('leakDry')),
  // a drying-heater part needs the code AND the customer's own "no heat when drying"
  partBlockers: (has, { component }) => (component === 'drying-heater' && !has('cold') ? ['needs-no-heat-when-drying'] : []),
};
/** The active problem is a leak (routed here only when it happens while drying). */
function dryLeak(state) {
  const p = (state.problems || []).find((x) => x.status === 'active');
  return Boolean(p && p.journey && p.journey.value === 'leaking');
}
/** Heat during DRYING by the latest statement: 'cold' | 'warm' | null. */
function heatState(state) {
  const nh = engine.obsVal(state, 'noHeat'); const hp = engine.obsVal(state, 'heatPresent');
  const tn = nh != null ? engine.obsTurnOf(state, 'noHeat') : -1; const th = hp != null ? engine.obsTurnOf(state, 'heatPresent') : -1;
  if (nh === true && (hp !== true || tn >= th)) return 'cold';
  if (hp === true || nh === false) return 'warm';
  return null;
}
function diagnose(state, ctx = {}) {
  const codeFault = ctx.codeFault !== undefined ? ctx.codeFault : wdCodeFault(state, ctx.errorCodes || null);
  return engine.diagnoseSpec(SPEC, state, { ...ctx, codeFault });
}
const owner = (h) => W.wdOwner(h.s);
const P = kit.makeStepPolicy({
  JOURNEY: KEY, P: 'WY', appliance: 'washer-dryer', journeys: ['not-drying'], declineUnsafe: W.UNSAFE,
  claims: (h, journey) => journey !== 'not-drying' && owner(h) === KEY,
  ownedElsewhere: (h, journey) => journey !== 'not-drying' && owner(h) !== KEY,
  CHECKS: ['wd-dry-capacity', 'programme-setting', 'inlet-hose-tap', 'drain-filter', 'drain-hose'],
  OBS_TARGETS: { heatState: ['noHeat', 'heatPresent'] },
  REQUIRES: { heatState: [], 'wd-dry-capacity': [], 'programme-setting': [], 'inlet-hose-tap': ['tap_hose_from_outside'], 'drain-filter': ['isolate_mains', 'contain_water', 'open_slowly'],
    'drain-hose': ['isolate_mains', 'contain_water'], retest: [] },
  FIX_CHECKS: ['wd-dry-capacity', 'programme-setting', 'inlet-hose-tap', 'drain-filter', 'drain-hose'],
  // a drying-only leak with the water container reported full (or its warning on): emptying it is the first fix
  early(h) {
    const full = h.obs('tankWarning') === true;
    return h.has('leakDry') && full && !h.done('drain-filter') ? { target: 'water-container-full', reason: 'container-full-overflows-when-drying', rule: 'WY5', handoff: 'none' } : null;
  },
  steps: [
    // drying-only leak: the condensed water must drain through the pump filter and drain hose
    { n: 15, target: 'drain-filter', reason: 'condensed-water-backs-up-at-pump-filter', when: (h) => h.has('leakDry') },
    { n: 16, target: 'drain-hose', reason: 'condensed-water-drain-hose-standpipe', when: (h) => h.has('leakDry') && (h.has('filterOk') || h.has('failsAfterFilterFix')) },
    // the safe fluff check first: drying fluff collects in the pump filter (free, safe, whatever the heat state)
    { n: 14, target: 'drain-filter', reason: 'fluff-in-pump-filter', when: (h) => !h.has('leakDry') },
    { n: 11, target: 'wd-dry-capacity', reason: 'dry-capacity-half-wash-load', when: (h) => !h.has('leakDry') && !h.has('cold') },
    { n: 10, target: 'heatState', reason: 'drying-air-heat-or-not', when: (h) => !h.has('leakDry') && heatState(h.s) == null },
    { n: 12, target: 'programme-setting', reason: 'drying-programme-selected', when: (h) => !h.has('leakDry') },
    { n: 13, target: 'inlet-hose-tap', reason: 'water-cooled-condenser', when: (h) => !h.has('leakDry') && h.has('warm') },
  ],
  PART_FAMILIES: new Set(['DH']),
  HANDOFF: { CAP: 'none', PG: 'none', WT: 'none', LF: 'none', DH: 'engineer', SN: 'engineer', AF: 'engineer', DR: 'plumbing', CL: 'engineer' },
});
const pipeline = JP.makeModelPartPipeline({
  D: { diagnose }, P, schema: 'wdy/1', codeFaultFor: wdCodeFault,
  PART_MATCH: { 'drying-heater': { re: /dry(ing|er)\s+(heater|heating\s+element|element)|drying\s+element/i, not: /wash|tub|sump|thermostat|fuse|sensor/i } },
  MEDIA_BY_KEY: { 'drain-filter': { knowledgeId: 'washing-machine:not-draining', ids: ['wm-pump-filter'], concepts: ['drainage-appliance'] } },
});

// ---- COMPOSE (wording only) ----
const FAMILY_LABEL = { 'drying-load-over-capacity': 'a drying load bigger than the dry capacity', 'drying-programme-not-set': 'the drying programme or dryness setting',
  'condenser-water-supply': 'the cold water supply the condenser needs', 'pump-filter-fluff': 'fluff in the pump filter', 'drying-heater-or-thermostat': 'the drying heater or its thermostat',
  'drying-sensor': 'the drying sensor', 'drying-fan-or-air-duct': 'the drying fan or air duct', 'drain-hose-or-standpipe': 'the drain hose or standpipe',
  'condenser-water-path': 'the condenser\'s water path inside the machine', 'water-container-full': 'a full water container' };
const COMPONENT_LABEL = { 'drying-heater': 'drying heater' };
const TASK = {
  'ask_observation:heatState': { say: 'First, just what you can feel — whether the drying side is getting warm at all.', ask: 'Partway through drying, are the laundry and the door glass warm, or completely cold?' },
  'ask_check:wd-dry-capacity': { say: 'A washer-dryer can only dry about half the load it washes — for example 8 kg wash / 5 kg dry. Drying a full wash load leaves it damp, and that\'s the most common cause. Check the dry capacity on the front or in the manual.', ask: 'Was the load more than the dry capacity (and have you split it), or was it within the dry capacity?' },
  'ask_check:programme-setting': { say: 'Check a drying programme is actually selected after the wash (or a wash-and-dry option), and that it isn\'t a short timed dry or a low dryness level.', ask: 'Was drying not selected or set too short (and have you changed it), or was a full drying programme set?' },
  'ask_check:inlet-hose-tap': { say: 'Most washer-dryers use a trickle of cold water to condense the moisture while drying, so the cold tap must stay on and the hose mustn\'t be kinked.', ask: 'Was the tap off or the hose kinked (and is it sorted), or is the water supply on and fine?' },
  'ask_check:drain-hose': { say: 'The condensed water from drying leaves through the drain hose. Check the hose behind the machine isn\'t kinked or squashed, and that the standpipe or sink waste it goes into isn\'t blocked.', ask: 'Was the hose kinked or the waste blocked (and is it sorted), or was it all clear?' },
  // a leak only while drying: the same pump-filter check, said for the condensed-water path
  'ask_check:drain-filter:leak': { say: 'As it only leaks while drying, the water is coming from the drying side, not the wash: a washer-dryer condenses the moisture with a trickle of cold water and pumps it away through the pump filter and drain hose (most washer-dryers have no water container to empty). Fluff from drying collects in the pump filter at the bottom front and can make that water back up and leak. Unplug the machine first, put towels down with a shallow tray ready, and unscrew the filter slowly.', ask: 'Was the filter full of fluff or debris (and is it clean now), or was it already clean?' },
  'ask_check:drain-filter': { say: 'Drying sends fluff and the condensed water out through the pump, so a clogged pump filter (bottom front) stops it drying and can make the condensed water back up and leak. Unplug it first and have towels and a shallow tray ready, then unscrew the filter slowly.', ask: 'Was the filter full of fluff or debris (and is it clean now), or was it already clean?' },
  'ask_check:retest': { say: 'Run a drying programme with a load within the dry capacity, and keep an eye on it.', ask: 'Is it working properly now, or is the problem still there?' },
  'ask_identity:model': W.WD_MODEL_ASK, 'ask_identity:appliance': { say: '', ask: 'Is it a washer-dryer, or a separate tumble dryer?' },
};
const CONCLUSION = {
  'WY7:drying-load-over-capacity': 'That was the load size, so no part is needed. Dry about half of a full wash load at a time.',
  'WY7:drying-programme-not-set': 'That was the programme, so no part is needed.',
  'WY7:condenser-water-supply': 'That was the water supply the condenser needs, so no part is needed.',
  'WY7:pump-filter-fluff': 'Cleaning the pump filter very likely fixed it, so no part is needed. Clean it every month or so if you dry often.',
  // leak only while drying, nothing confirmed yet: say why it is the drying side and what comes next (no part claim)
  'pump-filter-fluff': (state) => (dryLeak(state)
    ? 'As it only leaks while drying, the water is coming from the drying side\'s condensed-water path, not the wash side. The most likely place is the pump filter (fluff from drying collects there and the condensed water backs up), then the drain hose, then the condenser\'s water path inside. Most washer-dryers have no water container — the water is pumped away — but if yours has one, empty it and refit it firmly. If the filter and hose are clear and it still leaks when drying, stop using the drying programmes and an appliance engineer is the next step; I\'m not recommending a part until the cause is confirmed.'
    : 'From the checks so far, the most likely cause is fluff in the pump filter. The check for it is simple; if it doesn\'t sort it, let me know what you find.'),
  'drying-heater-or-thermostat': 'With the washing side fine but no heat at all on a drying programme, the drying heater or its thermostat / cut-out is the likely cause — it\'s a separate heater from the wash one. That needs an appliance engineer to test safely; I\'m not recommending a part from this.',
  'water-container-full': 'You mentioned the water container is full. If your washer-dryer has one, a full container can\'t take any more condensed water, so it overflows while drying. Empty it, check its lid and float are clean, and push it fully home, then run a drying programme and keep an eye on it. If it fills right up again in one cycle or it still leaks, the drain path is next: the pump filter at the bottom front and the drain hose. No part is needed for this step.',
  'WY7:drain-hose-or-standpipe': 'That was the drain hose or waste, so no part is needed.',
  'condenser-water-path': 'With the pump filter and drain hose clear and it leaking only while drying, the water is most likely escaping from the condenser\'s water path inside the machine (the cold-water trickle or a condenser hose / seal). Please don\'t run drying programmes until it\'s checked and keep water away from the plug and socket; that needs an appliance engineer. I\'m not recommending a part from this.',
  'drying-sensor': 'The code points to the drying sensor or its wiring. That needs an appliance engineer to test safely — I\'m not recommending a part from this.',
  'drying-fan-or-air-duct': 'It heats and the load, programme, water supply and filter are all fine, so the drying fan or the air duct (often clogged with fluff inside) is the likely cause. That needs an appliance engineer — I\'m not recommending a part from this.',
};
const compose = ck.createCompose({
  ASK_GUARD: true, TASK, CONFIRM_ASK: 'Is it drying properly now?',
  retestKey: (a) => (a.kind === 'ask_check' && a.target === 'drain-filter' && a.reason === 'condensed-water-backs-up-at-pump-filter' ? 'ask_check:drain-filter:leak' : null),
  OBS_COPY: { noHeat: ['no heat when drying', 'warm when drying'], heatPresent: ['warm when drying', null], wdDrySide: ['problem during drying', 'problem during washing'], faultPersists: ['still damp', 'dry now'],
    tankStaysEmpty: ['water container stays empty', 'water container fills normally'], tankWarning: ['water container full / warning on', null] },
  CHECK_RESULT_COPY: { 'wd-dry-capacity': { clear: 'within dry capacity', found_and_cleared: 'load reduced' }, 'programme-setting': { clear: 'full drying programme', found_and_cleared: 'programme changed' },
    'inlet-hose-tap': { clear: 'water supply fine', found_and_cleared: 'tap / hose sorted' }, 'drain-filter': { clear: 'pump filter clean', found_and_cleared: 'pump filter cleaned' },
    'drain-hose': { clear: 'drain hose and waste clear', found_and_cleared: 'drain hose / waste sorted' },
    'lint-filter': { clear: 'fluff filter clean', found_and_cleared: 'fluff filter cleaned' } },
  statusChecks: [['retest', 'retest']],
  conclusionCopy: ck.makeConclusionCopy({ FAMILY_LABEL, COMPONENT_LABEL, CONCLUSION, fitNote: 'Unplug the machine before fitting it — the heater sits inside, so if you\'d rather not, an appliance engineer can fit and test it.' }),
  PURCHASE_RE: /\b(buy|order|purchase|price|£\s?\d)|\b(new|replacement|replace the)\s+(heater|heating element|element|thermostat|sensor|fan|motor|pcb|control board)\b/i,
});
module.exports = { SPEC, FAMILY, diagnose, P, ...pipeline, FAMILY_LABEL, COMPONENT_LABEL, TASK, REQUIREMENT: ck.REQUIREMENT, SAFETY_COPY: ck.SAFETY_COPY, heatState, ...compose };
