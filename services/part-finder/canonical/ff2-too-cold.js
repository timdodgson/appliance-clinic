'use strict';
/**
 * Fridge / freezer journey 2 — too cold / food freezing in the fridge (rules FX1–FX22). PURE, deterministic.
 * Design: docs/diagnostics/ff-td-batch-evidence.md §FF2. Settings / fast-freeze or super-cool left on → food against the
 * back wall / air outlet (normal near the cold plate) → a very cold room (combi thermostat) → thermostat / sensor / damper
 * (engineer). Never a part from a generic "too cold" (no part family at all).
 */
const engine = require('./evidence-engine.js');
const kit = require('./policy-kit.js');
const JP = require('./journey-pipeline.js');
const F = require('./ff-family.js');
const ck = require('./compose-kit.js');
const { SS, S, A, SA } = engine;

const KEY = 'ff-too-cold-freezing';
const FAMILY = { TS: 'temperature-setting', BW: 'food-against-back-wall', LO: 'room-temperature-location', TC: 'thermostat-sensor-or-damper' };
const SIGNALS = {
  TS: { setFixed: SS, restoredAfterSetFix: SS, failsAfterSetFix: SA, setOk: SA },
  BW: { ventsFixed: SS, restoredAfterVentsFix: SS, failsAfterVentsFix: SA, ventsOk: SA, scopeFridge: S },
  LO: { location: SS, scopeFridge: S },
  TC: { setOk: S, ventsOk: S, both: S, scopeFreezer: S, location: A, restoredAfterSetFix: SA, restoredAfterVentsFix: SA },
};
const FACT_LABEL = { setFixed: 'setting / fast-freeze or super-cool was on (corrected)', setOk: 'settings normal', ventsFixed: 'food against the back wall / vent (moved)', ventsOk: 'nothing against the back wall',
  location: 'in a very cold spot', scopeFridge: 'fridge too cold', scopeFreezer: 'freezer too cold', both: 'both too cold' };
const SPEC = {
  schema: 'ff2-diag/1', FAMILY, PRIOR: ['TS', 'BW', 'LO', 'TC'], SIGNALS, FACT_LABEL,
  obs: { location: ['inColdOrHotLocation', true], both: ['bothCompartmentsWarm', true] },
  checks: { 'temp-setting': { clear: 'setOk', found: 'setFixed' }, 'vents-clear': { clear: 'ventsOk', found: 'ventsFixed' } },
  FIX_CHECK: { TS: ['temp-setting', 'Set'], BW: ['vents-clear', 'Vents'] },
  DECISIVE_PART: {},
  extra(s, ctx, on) {
    const p = kit.problemOf(s); const scope = p && p.scope ? p.scope.value : null;
    on('scopeFridge', scope === 'fridge_only'); on('scopeFreezer', scope === 'freezer_only');
  },
  eligible: (k, has) => (k === 'LO' ? has('location') : true),
};
function diagnose(state, ctx = {}) {
  const codeFault = ctx.codeFault !== undefined ? ctx.codeFault : F.ffCodeFault(state, ctx.errorCodes || null);
  return engine.diagnoseSpec(SPEC, state, { ...ctx, codeFault });
}
const P = kit.makeStepPolicy({
  JOURNEY: KEY, P: 'FX', appliance: 'fridge-freezer', journeys: ['over-cooling'], ...F.owns(KEY), declineUnsafe: F.UNSAFE,
  CHECKS: ['temp-setting', 'vents-clear'],
  OBS_TARGETS: { inColdOrHotLocation: ['inColdOrHotLocation'] },
  REQUIRES: { 'temp-setting': [], 'vents-clear': [], inColdOrHotLocation: [], retest: [] },
  FIX_CHECKS: ['temp-setting', 'vents-clear'],
  steps: [
    { n: 10, target: 'temp-setting', reason: 'settings-fast-freeze-super-cool', when: () => true },
    { n: 11, target: 'vents-clear', reason: 'food-against-cold-outlet', when: (h) => !h.has('scopeFreezer') },
    { n: 12, target: 'inColdOrHotLocation', reason: 'cold-room-combi-thermostat', when: () => true },
  ],
  PART_FAMILIES: new Set(),
  HANDOFF: { TS: 'none', BW: 'none', LO: 'install', TC: 'engineer' },
});
const pipeline = JP.makeModelPartPipeline({ D: { diagnose }, P, schema: 'ff2/1', codeFaultFor: F.ffCodeFault, PART_MATCH: {}, MEDIA_BY_KEY: {} });

// ---- COMPOSE (wording only) ----
const FAMILY_LABEL = { 'temperature-setting': 'the temperature setting or a fast-freeze / super-cool mode', 'food-against-back-wall': 'food touching the cold back wall or air outlet',
  'room-temperature-location': 'the room it is in', 'thermostat-sensor-or-damper': 'the thermostat, temperature sensor or air damper' };
const TASK = {
  'ask_check:temp-setting': { say: 'First the settings: the fridge should be about 3–5°C and the freezer -18°C. Check the dial isn\'t on its coldest setting and that fast-freeze or super-cool hasn\'t been left on.', ask: 'Was a setting too cold or a fast-freeze / super-cool mode on (and have you changed it), or was it all set normally?' },
  'ask_check:vents-clear': { say: 'Food pressed against the back wall or right in front of the cold air outlet can freeze even when the fridge is at the right temperature.', ask: 'Was the frozen food touching the back wall or a vent (and have you moved it), or was it clear?' },
  'ask_observation:inColdOrHotLocation': { say: 'Room temperature can affect how it regulates.', ask: 'Is it in a garage, outbuilding or very cold room?' },
  'ask_check:retest': { say: 'Give it a day with the doors shut to settle at the new setting.', ask: 'Is the food still freezing in the fridge, or is it normal now?' },
  'ask_identity:appliance': { say: '', ask: 'Is it a fridge freezer, a fridge or a freezer?' },
};
const CONCLUSION = {
  'FX7:temperature-setting': 'That was the setting, so no part is needed. Give it a day to settle.',
  'FX7:food-against-back-wall': 'Food touching the cold back wall is the usual reason for odd items freezing, so no part is needed — keep things a little away from it.',
  'room-temperature-location': 'In a very cold room a fridge freezer can\'t regulate properly (the climate class on its rating label gives the room range it was designed for). Moving it to a normal room is the fix — no part is needed.',
  'thermostat-sensor-or-damper': 'With the settings normal and nothing touching the back wall, the thermostat, temperature sensor or air damper is the likely area. That needs an appliance engineer to test — I\'m not recommending a part from this.',
};
const compose = ck.createCompose({
  TASK, CONFIRM_ASK: 'Is it at a normal temperature now?',
  OBS_COPY: { inColdOrHotLocation: ['in a very cold spot', null], faultPersists: ['still too cold', 'normal now'] },
  CHECK_RESULT_COPY: { 'temp-setting': { clear: 'settings normal', found_and_cleared: 'setting / mode corrected' }, 'vents-clear': { clear: 'nothing against the back wall', found_and_cleared: 'food moved off the back wall' } },
  statusChecks: [['retest', 'retest']],
  conclusionCopy: ck.makeConclusionCopy({ FAMILY_LABEL, COMPONENT_LABEL: {}, CONCLUSION }),
  PURCHASE_RE: /\b(buy|order|purchase|price|£\s?\d)|\b(new|replacement|replace the)\s+(thermostat|sensor|thermistor|damper|pcb|control board)\b/i,
});
module.exports = { SPEC, FAMILY, diagnose, P, ...pipeline, FAMILY_LABEL, COMPONENT_LABEL: {}, TASK, REQUIREMENT: ck.REQUIREMENT, SAFETY_COPY: ck.SAFETY_COPY, ...compose };
