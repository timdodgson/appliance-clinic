'use strict';
/**
 * Hob journey 1 — a zone / ring not heating (rules HZ1–HZ22). PURE, deterministic. No parts.
 * Design: docs/diagnostics/final-migration-evidence.md §HOB1. Hob type first (gas → hob-ignition-gas).
 *   INDUCTION: flashing pan symbol / known-good pan works → pan compatibility (no fault) · known-good pan also fails on one
 *     zone → that zone's coil / power board (engineer; never an induction module from a generic failure)
 *   CERAMIC / SOLID PLATE: one zone → element or its control switch (engineer)
 *   ALL zones dead with lights on → key / child lock → control / power side (engineer). No live electrical testing.
 */
const engine = require('./evidence-engine.js');
const kit = require('./policy-kit.js');
const JP = require('./journey-pipeline.js');
const F = require('./hob-family.js');
const ck = require('./compose-kit.js');
const { SS, S, A, SA } = engine;

const KEY = 'hob-zone-not-heating';
const FAMILY = { PC: 'pan-compatibility', LK: 'key-or-child-lock', IZ: 'induction-zone-or-power-board', EZ: 'element-or-zone-control', CT: 'control-or-power-side' };
const SIGNALS = {
  PC: { goodPanWorks: SS, panFlash: S, induction: S, goodPanFails: SA },
  LK: { lockOff: SS, restoredAfterLockFix: SS, failsAfterLockFix: SA, lockOk: SA, oneZone: A },
  IZ: { goodPanFails: SS, induction: S, oneZone: S, lockOk: S, goodPanWorks: SA, restoredAfterLockFix: SA },
  EZ: { radiant: S, oneZone: SS, lockOk: S, induction: SA, restoredAfterLockFix: SA },
  CT: { lockOk: S, allZones: S, oneZone: A, restoredAfterLockFix: SA },
};
const FACT_LABEL = { induction: 'induction hob', radiant: 'ceramic / solid-plate hob', panFlash: 'pan symbol flashing', goodPanWorks: 'a known-good pan works', goodPanFails: 'a known-good pan also fails',
  oneZone: 'one zone only', allZones: 'all zones', lockOff: 'key / child lock was on (off now)', lockOk: 'no lock on' };
const SPEC = {
  schema: 'hb1-diag/1', FAMILY, PRIOR: ['PC', 'LK', 'IZ', 'EZ', 'CT'], SIGNALS, FACT_LABEL,
  obs: { induction: ['inductionHob', true], panFlash: ['panSymbolFlashing', true], goodPanWorks: ['worksWithKnownGoodPan', true], goodPanFails: ['failsKnownGoodPan', true] },
  checks: { 'child-lock': { clear: 'lockOk', found: 'lockOff' } },
  FIX_CHECK: { LK: ['child-lock', 'Lock'] },
  DECISIVE_PART: {},
  extra(s, ctx, on) {
    const p = kit.problemOf(s); const one = p && p.scope && p.scope.value === 'one_zone';
    on('oneZone', one); on('allZones', !one && engine.obsVal(s, 'noPower') === false);
    on('radiant', engine.obsVal(s, 'ceramicHob') === true || engine.obsVal(s, 'solidPlateHob') === true);
  },
  eligible: (k, has) => (k === 'PC' || k === 'IZ' ? !has('radiant') : k === 'EZ' ? !has('induction') : true),
};
function diagnose(state, ctx = {}) {
  const codeFault = ctx.codeFault !== undefined ? ctx.codeFault : F.hobCodeFault(state, ctx.errorCodes || null);
  return engine.diagnoseSpec(SPEC, state, { ...ctx, codeFault });
}
const typeKnown = (h) => h.has('induction') || h.has('radiant') || h.obs('gasHob') === true;
const P = kit.makeStepPolicy({
  JOURNEY: KEY, P: 'HZ', appliance: 'hob', journeys: ['no-heat'], ...F.owns(KEY), declineUnsafe: F.UNSAFE,
  CHECKS: ['child-lock'],
  OBS_TARGETS: { hobType: ['inductionHob', 'ceramicHob', 'gasHob', 'solidPlateHob'], panTest: ['failsKnownGoodPan', 'worksWithKnownGoodPan'] },
  REQUIRES: { hobType: [], 'child-lock': [], panTest: [], retest: [] },
  FIX_CHECKS: ['child-lock'],
  steps: [
    { n: 10, target: 'hobType', reason: 'hob-technology', when: (h) => !typeKnown(h) },
    { n: 11, target: 'child-lock', reason: 'key-lock-blocks-zones', when: (h) => !h.has('oneZone') && !h.has('panFlash') },
    { n: 12, target: 'panTest', reason: 'known-good-pan', when: (h) => h.has('induction') && !h.has('goodPanWorks') && !h.has('goodPanFails') },
  ],
  PART_FAMILIES: new Set(),
  HANDOFF: { PC: 'none', LK: 'none', IZ: 'engineer', EZ: 'engineer', CT: 'engineer' },
});
const pipeline = JP.makeModelPartPipeline({ D: { diagnose }, P, schema: 'hb1/1', codeFaultFor: F.hobCodeFault, PART_MATCH: {},
  MEDIA_BY_KEY: { 'element-or-zone-control': { knowledgeId: 'hobs:element', ids: ['hob-element-about'], concepts: [] } } });

// ---- COMPOSE (wording only) ----
const FAMILY_LABEL = { 'pan-compatibility': 'the pan not suiting induction', 'key-or-child-lock': 'the key / child lock', 'induction-zone-or-power-board': 'that zone\'s induction coil or power board',
  'element-or-zone-control': 'that zone\'s element or its control', 'control-or-power-side': 'the hob control or power side' };
const TASK = {
  'ask_observation:hobType': { say: 'The type of hob changes what to check.', ask: 'Is it an induction hob (only works with magnetic pans), a ceramic hob (smooth glass that glows red), a solid-plate hob, or gas?' },
  'ask_check:child-lock': { say: 'Many hobs have a key / child lock (often a key or padlock symbol) that stops the zones coming on — the manual shows which button to hold.', ask: 'Was the lock on (and is it off now), or was there no lock on?' },
  'ask_observation:panTest': { say: 'Induction only works with magnetic pans — a fridge magnet should stick firmly to the base. Try a pan you know works on the other zones, centred on this zone.', ask: 'Does a known-good pan heat on this zone, or does it fail too?' },
  'ask_check:retest': { say: 'Try the zone again.', ask: 'Is it heating now, or still not?' },
  'ask_identity:appliance': F.HOB_APPLIANCE_ASK,
};
const CONCLUSION = {
  'HZ7:key-or-child-lock': 'That was the lock, so no part is needed.',
  'pan-compatibility': 'The zone works with a suitable pan, so it\'s the pan: induction needs a flat, magnetic base big enough for the zone (a fridge magnet should stick firmly). No part is needed.',
  'induction-zone-or-power-board': 'A known-good pan failing on that zone points to its induction coil or power board. Please don\'t take the hob out or test it live — an appliance engineer is the next step. I\'m not recommending a part from this.',
  'element-or-zone-control': 'One zone not heating on a ceramic or solid-plate hob is usually that zone\'s element or its control switch. That needs an appliance engineer to test safely — I\'m not recommending a part from this.',
  'control-or-power-side': 'With nothing locked but the zones not heating, the hob control or its power side is the likely area. That needs an appliance engineer — I\'m not recommending a part from this.',
};
const compose = ck.createCompose({
  ASK_GUARD: true, TASK, CONFIRM_ASK: 'Is the zone heating now?',
  OBS_COPY: { inductionHob: ['induction', null], ceramicHob: ['ceramic', null], solidPlateHob: ['solid plate', null], gasHob: ['gas', null], panSymbolFlashing: ['pan symbol flashing', null],
    worksWithKnownGoodPan: ['known-good pan works', null], failsKnownGoodPan: ['known-good pan fails too', null], faultPersists: ['still not heating', 'heating now'] },
  CHECK_RESULT_COPY: { 'child-lock': { clear: 'no lock', found_and_cleared: 'lock off now' } },
  statusChecks: [['retest', 'retest']],
  conclusionCopy: ck.makeConclusionCopy({ FAMILY_LABEL, COMPONENT_LABEL: {}, CONCLUSION }),
  PURCHASE_RE: /\b(buy|order|purchase|price|£\s?\d)|\b(new|replacement|replace the)\s+(element|coil|module|power board|board|energy regulator|switch|pcb|control|hob)\b/i,
});
module.exports = { SPEC, FAMILY, diagnose, P, ...pipeline, FAMILY_LABEL, COMPONENT_LABEL: {}, TASK, REQUIREMENT: ck.REQUIREMENT, SAFETY_COPY: ck.SAFETY_COPY, ...compose };
