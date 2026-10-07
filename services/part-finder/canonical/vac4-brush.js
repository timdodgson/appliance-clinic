'use strict';
/**
 * Vacuum journey 4 — brush bar / roller not turning (rules VB1–VB22). PURE, deterministic.
 * Design: docs/diagnostics/final-migration-evidence.md §VAC4.
 *   tangled / jammed (owner clears it) → broken brush bar or end cap (owner-seen → brush-bar part with a model) →
 *   corded belt-driven upright: snapped / worn belt (owner-seen → belt part with a model) → clean, turns freely, belt fine
 *   (or a motorised cordless head) → the floorhead's own drive / motor (repairer; no part from this alone).
 */
const engine = require('./evidence-engine.js');
const kit = require('./policy-kit.js');
const JP = require('./journey-pipeline.js');
const F = require('./vac-family.js');
const ck = require('./compose-kit.js');
const { SS, S, SA } = engine;

const KEY = 'vacuum-brush-not-turning';
const FAMILY = { TG: 'brush-bar-tangled-or-jammed', BR: 'brush-bar-damaged', BE: 'drive-belt', FH: 'floorhead-drive' };
const SIGNALS = {
  TG: { brushFixed: SS, restoredAfterBrushFix: SS, failsAfterBrushFix: SA, brushOk: SA, brushBroken: SA, brushStill: S },
  BR: { brushBroken: SS, brushOk: SA },
  BE: { beltBroken: SS, beltOk: SA, cordless: SA, robot: SA, corded: S, brushOk: S, failsAfterBrushFix: S, restoredAfterBrushFix: SA },
  FH: { brushOk: S, failsAfterBrushFix: S, beltOk: S, cordless: S, restoredAfterBrushFix: SA, brushBroken: SA, beltBroken: SA },
};
const FACT_LABEL = { brushStill: 'brush bar not spinning', brushFixed: 'hair / thread tangled (cleared)', brushBroken: 'brush bar or end cap broken', brushOk: 'clean and turns freely by hand',
  beltBroken: 'drive belt snapped / worn', beltOk: 'belt fine', cordless: 'cordless', corded: 'corded', robot: 'robot' };
const SPEC = {
  schema: 'vac4-diag/1', FAMILY, PRIOR: ['TG', 'BR', 'BE', 'FH'], SIGNALS, FACT_LABEL,
  obs: { brushStill: ['brushNotSpinning', true] },
  checks: { 'brush-bar-clear': { clear: 'brushOk', found: 'brushFixed', fault: 'brushBroken' }, 'drive-belt': { clear: 'beltOk', fault: 'beltBroken' } },
  FIX_CHECK: { TG: ['brush-bar-clear', 'Brush'] },
  DECISIVE_PART: { BR: { brushBroken: 'vacuum-brush-bar' }, BE: { beltBroken: 'vacuum-belt' } },
  extra(s, ctx, on) { F.typeFacts(on, F.vacType(s)); },
  eligible: (k, has) => (k === 'BE' ? !has('cordless') && !has('robot') : true),
};
function diagnose(state, ctx = {}) { return engine.diagnoseSpec(SPEC, state, { ...ctx, codeFault: null }); }
const brushSettled = (h) => h.has('brushOk') || h.has('failsAfterBrushFix');
const P = kit.makeStepPolicy({
  JOURNEY: KEY, P: 'VB', appliance: 'vacuum', journeys: ['brush-bar-not-spinning'], ...F.owns(KEY), declineUnsafe: F.UNSAFE,
  CHECKS: ['brush-bar-clear', 'drive-belt'],
  OBS_TARGETS: { vacType: ['vacuumCordless', 'vacuumCorded', 'vacuumRobot'] },
  REQUIRES: { 'brush-bar-clear': ['vac_power_off'], vacType: [], 'drive-belt': ['vac_power_off'], retest: [] },
  FIX_CHECKS: ['brush-bar-clear'],
  steps: [
    { n: 10, target: 'brush-bar-clear', reason: 'tangles-or-jam', when: () => true },
    { n: 11, target: 'vacType', reason: 'belt-only-on-corded', when: (h) => brushSettled(h) && F.vacType(h.s).type === 'unknown' },
    { n: 12, target: 'drive-belt', reason: 'belt-driven-brush', when: (h) => brushSettled(h) && F.vacType(h.s).type === 'corded' },
  ],
  PART_FAMILIES: new Set(['BR', 'BE']),
  HANDOFF: { TG: 'none', BR: 'none', BE: 'none', FH: 'engineer' },
});
const pipeline = JP.makeModelPartPipeline({ D: { diagnose }, P, schema: 'vac4/1', codeFaultFor: F.vacCodeFault, PART_MATCH: F.PART_MATCH, MEDIA_BY_KEY: {} });

// ---- COMPOSE (wording only) ----
const FAMILY_LABEL = { 'brush-bar-tangled-or-jammed': 'hair or thread jamming the brush bar', 'brush-bar-damaged': 'a broken brush bar', 'drive-belt': 'the drive belt', 'floorhead-drive': 'the floorhead\'s own drive or motor' };
const COMPONENT_LABEL = { 'vacuum-brush-bar': 'brush bar', 'vacuum-belt': 'drive belt' };
const TASK = {
  'ask_check:brush-bar-clear': { say: 'With it switched off (battery out or unplugged), turn the floorhead over. Cut away hair and thread wrapped round the brush bar (roller) and at the end caps — many bars slide out with a coin-slot catch — then check it turns freely by hand.', ask: 'Was it tangled or jammed (and is it clear now), is the bar or an end cap broken, or was it clean and turning freely?' },
  'ask_observation:vacType': { say: 'The type decides what drives the brush.', ask: 'Is it a corded vacuum, a cordless (battery) one, or a robot?' },
  'ask_check:drive-belt': { say: 'On a corded upright the brush is driven by a rubber belt under the base plate (unplug it first; the plate usually unclips or has a few screws).', ask: 'Is the belt snapped, stretched or off its pulley, or is it in place and tight?' },
  'ask_check:retest': { say: 'Switch it on with the head tilted so you can see the bar.', ask: 'Is the brush bar spinning now, or still not?' },
  'ask_identity:model': F.VAC_MODEL_ASK, 'ask_identity:appliance': F.VAC_APPLIANCE_ASK,
};
const CONCLUSION = {
  'VB7:brush-bar-tangled-or-jammed': 'Clearing it very likely fixed it, so no part is needed. A quick cut-through of tangles every few weeks keeps it turning.',
  'floorhead-drive': 'The bar is clean and turns freely, so the floorhead\'s own drive (its motor or connection to the wand) is the likely area. A repairer or the manufacturer can confirm it — I\'m not recommending a part from this alone.',
};
const compose = ck.createCompose({
  ASK_GUARD: true, TASK, CONFIRM_ASK: 'Is the brush bar spinning now?',
  OBS_COPY: { brushNotSpinning: ['brush bar not spinning', 'brush spinning'], vacuumCordless: ['cordless', null], vacuumCorded: ['corded', null], vacuumRobot: ['robot', null], faultPersists: ['still not spinning', 'spinning now'] },
  CHECK_RESULT_COPY: { 'brush-bar-clear': { clear: 'brush bar clean', found_and_cleared: 'brush bar cleared', fault_seen: 'brush bar broken' }, 'drive-belt': { clear: 'belt fine', fault_seen: 'belt snapped / worn' } },
  statusChecks: [['retest', 'retest']],
  conclusionCopy: ck.makeConclusionCopy({ FAMILY_LABEL, COMPONENT_LABEL, CONCLUSION, fitNote: 'With it switched off, it fits in the floorhead — the manual shows how.' }),
  PURCHASE_RE: /\b(buy|order|purchase|price|£\s?\d)|\b(new|replacement|replace the)\s+(motor|brush\s*bar|belt|head|floorhead|cleaner head)\b/i,
});
module.exports = { SPEC, FAMILY, diagnose, P, ...pipeline, FAMILY_LABEL, COMPONENT_LABEL, TASK, REQUIREMENT: ck.REQUIREMENT, SAFETY_COPY: ck.SAFETY_COPY, ...compose };
