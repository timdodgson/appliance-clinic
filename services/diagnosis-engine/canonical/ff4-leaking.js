'use strict';
/**
 * Fridge / freezer journey 4 — leaking water (rules FL1–FL22). PURE, deterministic.
 * Design: docs/diagnostics/ff-td-batch-evidence.md §FF4. WHERE the water is decides the path:
 *   INSIDE the fridge (floor of the fridge, under the salad drawers, down the back wall) → defrost drain hole → door left
 *     open / warm food (condensation);
 *   UNDER / in front of it → drip (evaporation) tray / drain tube at the back (part only if the owner saw it cracked + model);
 *   SUPPLY LINE (plumbed water / ice dispenser) → the supply connection (tap off, hand-tight; a damaged line is plumbing).
 * Heavy ice with the water → ff-ice-frost-build-up owns it (once); a large supply leak → stop the water first.
 */
const engine = require('./evidence-engine.js');
const kit = require('./policy-kit.js');
const JP = require('./journey-pipeline.js');
const F = require('./ff-family.js');
const ck = require('./compose-kit.js');
const { SS, S, A, SA } = engine;

const KEY = 'ff-leaking-water';
const FAMILY = { DD: 'blocked-defrost-drain', CO: 'condensation-door-or-warm-food', DT: 'drip-tray-or-drain-tube', SL: 'water-supply-line', IN: 'internal-leak' };
const SIGNALS = {
  DD: { drainFixed: SS, drainStuck: SS, restoredAfterDrainFix: SS, failsAfterDrainFix: SA, inside: S, drainOk: SA, under: A, supply: SA },
  CO: { doorLeft: SS, inside: S, drainOk: S, supply: SA, under: A },
  DT: { trayFixed: SS, trayCracked: SS, restoredAfterTrayFix: SS, failsAfterTrayFix: SA, under: S, trayOk: SA, inside: A, supply: A },
  SL: { lineFixed: SS, lineDamaged: SS, restoredAfterLineFix: SS, failsAfterLineFix: SA, supply: S, rear: S, lineOk: SA },
  IN: { under: S, trayOk: S, lineOk: S, drainOk: S, inside: A, restoredAfterDrainFix: SA, restoredAfterTrayFix: SA, restoredAfterLineFix: SA },
};
const FACT_LABEL = {
  inside: 'water inside the fridge', under: 'water under / in front of it', supply: 'from the water supply line', rear: 'water at the back', doorLeft: 'door left open / warm food went in',
  drainFixed: 'defrost drain blocked (cleared)', drainStuck: 'defrost drain blocked (could not clear)', drainOk: 'defrost drain clear', trayFixed: 'drip tray / tube out of place (refitted)',
  trayCracked: 'drip tray cracked / tube split', trayOk: 'drip tray fine', lineFixed: 'supply connection loose (tightened)', lineDamaged: 'supply line damaged', lineOk: 'supply connection dry',
};
const SPEC = {
  schema: 'ff4-diag/1', FAMILY, PRIOR: ['DD', 'CO', 'DT', 'SL', 'IN'], SIGNALS, FACT_LABEL,
  obs: { inside: ['waterInsideFridge', true], under: ['leakUnderneath', true], supply: ['leakFromSupplyLine', true], rear: ['leakAtRear', true], doorLeft: ['doorLeftOpen', true] },
  checks: { 'defrost-drain': { clear: 'drainOk', cleared: 'drainFixed', notCleared: 'drainStuck' }, 'drip-tray': { clear: 'trayOk', found: 'trayFixed', fault: 'trayCracked' },
    'inlet-connection': { clear: 'lineOk', found: 'lineFixed', fault: 'lineDamaged' } },
  FIX_CHECK: { DD: ['defrost-drain', 'Drain'], DT: ['drip-tray', 'Tray'], SL: ['inlet-connection', 'Line'] },
  DECISIVE_PART: { DT: { trayCracked: 'drip-tray' } },
  eligible: (k, has) => (k === 'SL' ? has('supply') || has('rear') || has('lineFixed') || has('lineDamaged') : k === 'CO' ? has('inside') || has('doorLeft') : true),
};
function diagnose(state, ctx = {}) {
  const codeFault = ctx.codeFault !== undefined ? ctx.codeFault : F.ffCodeFault(state, ctx.errorCodes || null);
  return engine.diagnoseSpec(SPEC, state, { ...ctx, codeFault });
}
function containment(s) {
  const o = s.evidence && s.evidence.observations; const ml = o && o.majorLeak;
  return ml && ml.value === true && ml.turn === s.version && o.leakFromSupplyLine && o.leakFromSupplyLine.value === true
    ? { target: 'major-leak', reason: 'uncontrolled-supply-leak', requires: ['water_off_at_tap', 'power_off_only_if_dry', 'keep_clear_of_socket_if_water_near'], pending: null } : null;
}
const LOC = ['inside', 'under', 'supply', 'rear'];
const P = kit.makeStepPolicy({
  JOURNEY: KEY, P: 'FL', appliance: 'fridge-freezer', journeys: ['leaking'], ...F.owns(KEY), declineUnsafe: F.UNSAFE, containment,
  CHECKS: ['defrost-drain', 'drip-tray', 'inlet-connection'],
  OBS_TARGETS: { ffLeakLocation: ['waterInsideFridge', 'leakUnderneath', 'leakFromSupplyLine'], doorLeftOpen: ['doorLeftOpen'] },
  REQUIRES: {
    ffLeakLocation: ['keep_clear_of_socket_if_water_near'], doorLeftOpen: [], 'defrost-drain': ['unplug_fridge', 'no_sharp_tools_on_ice'],
    'drip-tray': ['unplug_fridge', 'ff_hot_compressor', 'no_refrigerant_work'], 'inlet-connection': ['water_off_at_tap', 'hand_tight_only'], retest: ['stop_if_water_near_socket'],
  },
  FIX_CHECKS: ['defrost-drain', 'drip-tray', 'inlet-connection'],
  fixResults: { 'defrost-drain': ['found_and_cleared'] },
  steps: [
    { n: 10, target: 'ffLeakLocation', reason: 'inside-under-or-supply', when: (h) => !LOC.some(h.has) },
    { n: 11, target: 'defrost-drain', reason: 'defrost-drain-hole', when: (h) => h.has('inside') },
    { n: 12, target: 'doorLeftOpen', reason: 'condensation-door-warm-food', when: (h) => h.has('inside') && !h.has('drainFixed') && !h.has('drainStuck') && h.obs('doorLeftOpen') == null },
    { n: 13, target: 'inlet-connection', reason: 'supply-line-connection', when: (h) => h.has('supply') || (h.has('rear') && !h.has('inside')) },
    { n: 14, target: 'drip-tray', reason: 'drip-tray-drain-tube', when: (h) => h.has('under') && !h.has('supply') },
  ],
  PART_FAMILIES: new Set(['DT']),
  HANDOFF: { DD: 'engineer', CO: 'none', DT: 'engineer', SL: 'plumbing', IN: 'engineer' },
});
const pipeline = JP.makeModelPartPipeline({
  D: { diagnose }, P, schema: 'ff4/1', codeFaultFor: F.ffCodeFault,
  PART_MATCH: { 'drip-tray': { re: /drip\s+tray|evaporat(ion|ing)\s+tray|defrost\s+(water\s+)?tray|water\s+tray|drain\s+(tube|pipe|trough|channel)/i, not: /cover|plate|element|heater|shelf|drawer|dishwasher|washing|tumble/i } },
  MEDIA_BY_KEY: {},
});

// ---- COMPOSE (wording only) ----
const FAMILY_LABEL = { 'blocked-defrost-drain': 'a blocked defrost drain hole', 'condensation-door-or-warm-food': 'condensation from the door being open or warm food',
  'drip-tray-or-drain-tube': 'the drip tray or drain tube at the back', 'water-supply-line': 'the water supply line', 'internal-leak': 'an internal water line or ice maker' };
const COMPONENT_LABEL = { 'drip-tray': 'drip (evaporation) tray' };
const TASK = {
  'ask_observation:ffLeakLocation': { say: 'Where the water is tells us where it\'s coming from.', ask: 'Is the water inside the fridge (on the bottom, under the salad drawers or running down the back wall), on the floor under or in front of it, or coming from the water supply pipe to a water / ice dispenser?' },
  'ask_check:defrost-drain': { say: 'At the bottom of the back wall inside the fridge there\'s a small drain hole or channel that carries defrost water away. If it blocks, water collects inside. Clear it gently with warm water (a turkey baster or a squeezy bottle works) or a soft pipe cleaner.', ask: 'Was the drain hole blocked (and is it clear now), is it blocked or frozen and you couldn\'t clear it, or was it already clear?' },
  'ask_observation:doorLeftOpen': { say: 'Water inside can also be condensation.', ask: 'Has a door been left open or not shut properly, or has warm or uncovered food gone in recently?' },
  'ask_check:inlet-connection': { say: 'Check the water supply pipe from the isolation tap to the back of the fridge, and the connection at each end, for drips or a loose fitting.', ask: 'Was a connection loose (and is it tight now), is the pipe itself damaged, or is it all dry?' },
  'ask_check:drip-tray': { say: 'At the back near the bottom there\'s a shallow tray (usually on top of the motor) that catches defrost water so it can evaporate, with a small tube running into it. Check the tube sits in the tray and the tray isn\'t cracked or out of place.', ask: 'Was the tray or tube out of place (and have you refitted it), is the tray cracked or the tube split, or does it all look fine?' },
  'ask_check:retest': { say: 'Mop up and keep an eye on it for a day.', ask: 'Has it stayed dry, or is water still appearing?' },
  'ask_identity:model': { say: 'To match the right part for your fridge freezer I need its exact model.', ask: 'Could you send me the model number? It\'s on the rating label inside the fridge, usually on a side wall near the salad drawer — a photo is fine.' },
  'ask_identity:appliance': { say: '', ask: 'Is it a fridge freezer, a fridge or a freezer?' },
};
const CONCLUSION = {
  'FL7:blocked-defrost-drain': 'Clearing the defrost drain very likely fixed it, so no part is needed. It can be worth flushing it with a little warm water every few months.',
  'blocked-defrost-drain': 'The defrost drain is blocked or frozen and it won\'t clear from the front. Please don\'t poke anything sharp into it; an appliance engineer can clear it (and check the defrost) safely — I\'m not recommending a part from this.',
  'condensation-door-or-warm-food': 'With the drain clear, the water is most likely condensation from the door being open or warm / uncovered food. Keep the door shut, let food cool and cover it, and it should dry up — no part is needed.',
  'FL7:drip-tray-or-drain-tube': 'Refitting the tray / tube very likely fixed it, so no part is needed.',
  'FL7:water-supply-line': 'The loose supply connection was very likely the cause, so no part is needed.',
  'water-supply-line': 'The water supply line itself looks damaged. Leave the isolation tap off; a plumber (or an appliance engineer) should fit a new supply pipe — no fridge part is needed.',
  'internal-leak': 'With the drain, tray and supply all fine, the water is most likely from an internal water line or the ice maker. An appliance engineer should find it safely — I\'m not recommending a part from this.',
};
const compose = ck.createCompose({
  TASK, CONFIRM_ASK: 'Is it staying dry now?',
  OBS_COPY: { waterInsideFridge: ['water inside the fridge', null], leakUnderneath: ['water under / in front', null], leakFromSupplyLine: ['from the supply line', null],
    doorLeftOpen: ['door left open / warm food', 'doors kept shut'], majorLeak: ['a large amount of water', null], faultPersists: ['still leaking', 'stayed dry'] },
  CHECK_RESULT_COPY: {
    'defrost-drain': { clear: 'defrost drain clear', found_and_cleared: 'defrost drain cleared', found_not_cleared: 'defrost drain blocked (could not clear)' },
    'drip-tray': { clear: 'drip tray fine', found_and_cleared: 'tray / tube refitted', fault_seen: 'tray cracked / tube split' },
    'inlet-connection': { clear: 'supply connection dry', found_and_cleared: 'supply connection tightened', fault_seen: 'supply line damaged' },
  },
  statusChecks: [['retest', 'retest']],
  conclusionCopy: ck.makeConclusionCopy({ FAMILY_LABEL, COMPONENT_LABEL, CONCLUSION, fitNote: 'Unplug the fridge freezer and let the back cool before fitting it; if you\'d rather not, an appliance engineer can fit it.' }),
  PURCHASE_RE: /\b(buy|order|purchase|price|£\s?\d)|\b(new|replacement|replace the)\s+(drip tray|tray|tube|valve|ice maker|pipe|hose|line)\b/i,
});
module.exports = { SPEC, FAMILY, diagnose, P, ...pipeline, FAMILY_LABEL, COMPONENT_LABEL, TASK, REQUIREMENT: ck.REQUIREMENT, SAFETY_COPY: ck.SAFETY_COPY, ...compose };
