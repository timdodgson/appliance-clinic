'use strict';
/**
 * Fridge / freezer journey 5 — ice / frost build-up (rules FI1–FI22). PURE, deterministic.
 * Design: docs/diagnostics/ff-td-batch-evidence.md §FF5. This journey also owns a warm (not-cooling), noisy (ice hitting the
 * fan) or leaking report WITH heavy ice (ff-family precedence), so frost is diagnosed once.
 *   ONE-OFF frost after a door was left open / heavy loading → full manual defrost, keep shut (no part, early)
 *   frost round the DOOR → door seal (gasket only if the owner saw it torn + model)
 *   ice in the BASE → defrost drain hole
 *   frost on the BACK WALL that RETURNS after a full defrost (or a defrost code) → defrost system (engineer, no part)
 * Never: chipping ice with sharp tools, taking the evaporator cover / panels off.
 */
const engine = require('./evidence-engine.js');
const kit = require('./policy-kit.js');
const JP = require('./journey-pipeline.js');
const F = require('./ff-family.js');
const ck = require('./compose-kit.js');
const { SS, S, A, SA } = engine;

const KEY = 'ff-ice-frost-build-up';
const FAMILY = { OO: 'one-off-door-or-loading', DS: 'door-seal-air-leak', DR: 'blocked-defrost-drain', DF: 'defrost-system' };
const SIGNALS = {
  OO: { doorLeft: S, restoredAfterDefrostFix: SS, failsAfterDefrostFix: SA, returns: SA },
  DS: { sealTorn: SS, sealFixed: SS, restoredAfterSealFix: SS, failsAfterSealFix: SA, nearDoor: S, sealOk: SA, backWall: A },
  DR: { drainFixed: SS, drainStuck: SS, restoredAfterDrainFix: SS, failsAfterDrainFix: SA, base: S, drainOk: SA },
  DF: { returns: SS, failsAfterDefrostFix: SS, codeDefrost: SS, backWall: S, heavy: S, sealOk: S, doorNotLeft: S, doorLeft: A, nearDoor: A, restoredAfterDefrostFix: SA },
};
const FACT_LABEL = {
  heavy: 'heavy ice / frost', backWall: 'frost on the back wall inside', nearDoor: 'frost round the door', base: 'ice in the base', doorLeft: 'door left open / heavy loading',
  doorNotLeft: 'door kept shut', returns: 'comes back after defrosting', restoredAfterDefrostFix: 'not back since a full defrost', failsAfterDefrostFix: 'back again after a full defrost',
  sealTorn: 'door seal torn / come away', sealFixed: 'seal dirty / folded (sorted)', sealOk: 'door seal fine', drainFixed: 'defrost drain blocked (cleared)', drainStuck: 'defrost drain blocked / frozen',
  drainOk: 'defrost drain clear', codeDefrost: 'defrost error code',
};
/** Turn of a reported full defrost (found_and_cleared, or done with no stated result). */
function defrostTurn(s) {
  const k = s.evidence && s.evidence.checks && s.evidence.checks.defrost;
  return k && k.status === 'done' && (k.result === 'found_and_cleared' || k.result == null) ? k.turn : null;
}
const SPEC = {
  schema: 'ff5-diag/1', FAMILY, PRIOR: ['OO', 'DS', 'DR', 'DF'], SIGNALS, FACT_LABEL,
  obs: { heavy: ['heavyIce', true], backWall: ['frostOnBackWall', true], nearDoor: ['frostNearDoor', true], base: ['iceInBase', true], doorLeft: ['doorLeftOpen', true],
    doorNotLeft: ['doorLeftOpen', false], returns: ['iceReturns', true] },
  checks: { 'door-seal': { clear: 'sealOk', found: 'sealFixed', fault: 'sealTorn' }, 'defrost-drain': { clear: 'drainOk', cleared: 'drainFixed', notCleared: 'drainStuck' },
    defrost: { cleared: 'defrosted' } },
  // the defrost fix is projected in extra(): a reported full defrost counts even when no result was stated
  FIX_CHECK: { DS: ['door-seal', 'Seal'], DR: ['defrost-drain', 'Drain'] },
  DECISIVE_PART: { DS: { sealTorn: 'door-seal' } },
  extra(s, ctx, on) {
    on('codeDefrost', ctx.codeFault === 'defrost-system');
    // "has it come back since the defrost?" may be answered as iceReturns as well as the shared retest outcome
    const ft = defrostTurn(s);
    if (ft == null) return;
    on('defrosted', true);
    for (const k of ['faultPersists', 'iceReturns']) {
      const v = engine.obsVal(s, k); const t = engine.obsTurnOf(s, k);
      if (v != null && t >= ft) { on('restoredAfterDefrostFix', v === false); on('failsAfterDefrostFix', v === true); }
    }
    if (s.resolution === 'resolved') on('restoredAfterDefrostFix', true);
  },
  eligible: (k, has) => (k === 'DR' ? has('base') || has('drainFixed') || has('drainStuck') : true),
};
function diagnose(state, ctx = {}) {
  const codeFault = ctx.codeFault !== undefined ? ctx.codeFault : F.ffCodeFault(state, ctx.errorCodes || null);
  return engine.diagnoseSpec(SPEC, state, { ...ctx, codeFault });
}
const WHERE = ['backWall', 'nearDoor', 'base'];
const recurring = (h) => h.has('returns') || h.has('failsAfterDefrostFix');
const P = kit.makeStepPolicy({
  JOURNEY: KEY, P: 'FI', appliance: 'fridge-freezer', journeys: ['ice-build-up'], ...F.owns(KEY), declineUnsafe: F.UNSAFE,
  CHECKS: ['door-seal', 'defrost-drain', 'defrost'],
  OBS_TARGETS: { ffIceWhere: ['frostOnBackWall', 'frostNearDoor', 'iceInBase'], doorLeftOpen: ['doorLeftOpen'] },
  REQUIRES: {
    ffIceWhere: [], doorLeftOpen: [], 'door-seal': ['look_and_feel_only'], 'defrost-drain': ['no_sharp_tools_on_ice'],
    defrost: ['unplug_fridge', 'ff_defrost_towels', 'no_sharp_tools_on_ice', 'no_panel_removal'], retest: [],
  },
  FIX_CHECKS: ['defrost', 'door-seal', 'defrost-drain'],
  fixResults: { defrost: ['found_and_cleared', null], 'defrost-drain': ['found_and_cleared'] },
  // a one-off after the door was left open / heavy loading: a full defrost and keeping it shut is the fix (no part)
  early(h) {
    return h.has('doorLeft') && !recurring(h) && !h.done('defrost') && !h.has('sealTorn')
      ? { target: 'one-off-door-or-loading', reason: 'one-off-after-door-open', rule: 'FI5', handoff: 'none' } : null;
  },
  steps: [
    { n: 10, target: 'ffIceWhere', reason: 'where-is-the-ice', when: (h) => !WHERE.some(h.has) },
    { n: 11, target: 'doorLeftOpen', reason: 'one-off-or-recurring', when: (h) => h.obs('doorLeftOpen') == null },
    { n: 12, target: 'door-seal', reason: 'warm-air-past-the-seal', when: (h) => h.has('nearDoor') || recurring(h) },
    { n: 13, target: 'defrost-drain', reason: 'ice-in-base-drain', when: (h) => h.has('base') },
    { n: 14, target: 'defrost', reason: 'full-manual-defrost-then-watch', when: (h) => !recurring(h) && !h.has('sealTorn') && !h.has('drainStuck') },
  ],
  PART_FAMILIES: new Set(['DS']),
  HANDOFF: { OO: 'none', DS: 'engineer', DR: 'engineer', DF: 'engineer' },
});
const pipeline = JP.makeModelPartPipeline({
  D: { diagnose }, P, schema: 'ff5/1', codeFaultFor: F.ffCodeFault,
  PART_MATCH: { 'door-seal': { re: /door\s+(seal|gasket)|\bgasket\b/i, not: /hinge|handle|shelf|drawer|tumble|dryer|washing|dishwasher|oven/i } },
  MEDIA_BY_KEY: {},
});

// ---- COMPOSE (wording only) ----
const DEFROST = 'Do a full manual defrost: switch it off at the socket, move the food into cool bags, put towels down and leave the doors open until all the ice has melted (let it melt — no knives or sharp tools), then dry it and switch back on.';
const FAMILY_LABEL = { 'one-off-door-or-loading': 'the door being left open or a heavy load of food', 'door-seal-air-leak': 'warm air getting past the door seal',
  'blocked-defrost-drain': 'a blocked defrost drain', 'defrost-system': 'the automatic defrost system' };
const COMPONENT_LABEL = { 'door-seal': 'door seal (gasket)' };
const TASK = {
  'ask_observation:ffIceWhere': { say: 'Where the ice forms tells us why.', ask: 'Is the ice or frost mostly on the back wall inside, around the door and seal, or a sheet of ice in the bottom?' },
  'ask_observation:doorLeftOpen': { say: 'Frost builds up fast if warm, damp air gets in.', ask: 'Was a door left open or not shut properly recently, or did a lot of food go in at once?' },
  'ask_check:door-seal': { say: 'Run your fingers round the rubber seal on the door and look for splits, gaps or a section that has come away, especially where the frost is.', ask: 'Is the seal torn or come away, was it dirty or folded (and is that sorted), or does it look fine?' },
  'ask_check:defrost-drain': { say: 'Ice in the bottom often means the defrost water can\'t drain away. At the bottom of the back wall there\'s a small drain hole — once the ice has melted, clear it gently with warm water or a soft pipe cleaner.', ask: 'Was the drain hole blocked (and is it clear now), is it still blocked or frozen, or was it already clear?' },
  'ask_check:defrost': { say: 'The first step is a full manual defrost: switch it off at the socket, move the food into cool bags, put towels down and leave the doors open until every bit of ice has melted, then dry it and switch it back on.', ask: 'Have you been able to do a full defrost, or is there no ice to clear?' },
  'ask_check:retest': { say: 'Run it as normal with the doors shut for a few days.', ask: 'Has the frost started to build up again, or is it staying clear?' },
  'ask_identity:model': { say: 'To match the right part for your fridge freezer I need its exact model.', ask: 'Could you send me the model number? It\'s on the rating label inside the fridge, usually on a side wall near the salad drawer — a photo is fine.' },
  'ask_identity:appliance': { say: '', ask: 'Is it a fridge freezer, a fridge or a freezer?' },
};
const CONCLUSION = {
  'one-off-door-or-loading': `A one-off build-up after a door was left open (or a lot of food went in) is normal, not a fault. ${DEFROST} Keep the doors shut and if the frost comes back within a few days, let me know — no part is needed.`,
  'FI7:one-off-door-or-loading': 'The frost hasn\'t come back since the defrost, so it was a one-off — no part is needed.',
  'FI7:door-seal-air-leak': 'Sorting the seal very likely fixed it, so no part is needed.',
  'FI7:blocked-defrost-drain': 'Clearing the defrost drain very likely fixed it, so no part is needed.',
  'blocked-defrost-drain': 'The defrost drain is blocked or frozen and won\'t clear from the front. Please don\'t chip at it or take panels off; an appliance engineer can clear it and check the defrost safely — I\'m not recommending a part from this.',
  'defrost-system': 'Frost that keeps building up on the back wall after a full defrost, with the door shut and the seal fine, points to the automatic defrost system (its heater, timer or sensor). Please don\'t take the back panel off inside; an appliance engineer is the next step — I\'m not recommending a part from this.',
};
const compose = ck.createCompose({
  TASK, CONFIRM_ASK: 'Is it staying clear of frost now?',
  OBS_COPY: { heavyIce: ['heavy ice / frost', null], frostOnBackWall: ['frost on the back wall', null], frostNearDoor: ['frost round the door', null], iceInBase: ['ice in the base', null],
    doorLeftOpen: ['door left open / heavy loading', 'doors kept shut'], iceReturns: ['comes back after defrosting', 'not back since defrosting'], faultPersists: ['frost back again', 'staying clear'] },
  CHECK_RESULT_COPY: {
    'door-seal': { clear: 'door seal fine', found_and_cleared: 'seal sorted', fault_seen: 'door seal torn / come away' },
    'defrost-drain': { clear: 'defrost drain clear', found_and_cleared: 'defrost drain cleared', found_not_cleared: 'defrost drain still blocked' },
    defrost: { found_and_cleared: 'full defrost done', clear: 'no ice to clear' },
  },
  statusChecks: [['retest', 'retest']],
  conclusionCopy: ck.makeConclusionCopy({ FAMILY_LABEL, COMPONENT_LABEL, CONCLUSION, fitNote: 'Switch the fridge freezer off at the socket before fitting it; if you\'d rather not, an appliance engineer can fit it.' }),
  PURCHASE_RE: /\b(buy|order|purchase|price|£\s?\d)|\b(new|replacement|replace the)\s+(door seal|seal|gasket|defrost heater|heater|timer|sensor|thermostat|pcb|control board|fan)\b/i,
});
module.exports = { SPEC, FAMILY, diagnose, P, ...pipeline, FAMILY_LABEL, COMPONENT_LABEL, TASK, REQUIREMENT: ck.REQUIREMENT, SAFETY_COPY: ck.SAFETY_COPY, ...compose };
