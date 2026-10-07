'use strict';
/**
 * Tumble dryer journey 6 — water container / condensate drain / water leaking (rules DW1–DW22). PURE, deterministic.
 * Design: docs/diagnostics/ff-td-batch-evidence.md §TD6. Also owns a stops / won't-start report with a container-full or
 * empty-tank warning (td-family). The dryer technology gates the journey: a VENTED dryer has no water container — that is
 * said once, with no part (water from a vented dryer is condensation in the vent hose).
 *   container full / not pushed home (owner fix) · cracked container (owner seen + model → container) · drain kit fitted
 *   (an empty container is then normal) · clogged condenser · container stays empty with the condenser clean and no drain
 *   kit → condensate pump / float (a pump part only with a pump code + that evidence + model) · leak with all fine → engineer.
 */
const engine = require('./evidence-engine.js');
const kit = require('./policy-kit.js');
const JP = require('./journey-pipeline.js');
const F = require('./td-family.js');
const ck = require('./compose-kit.js');
const { SS, S, A, SA } = engine;

const KEY = 'td-water-container-drain';
const FAMILY = { TK: 'container-full-or-not-seated', CR: 'container-damaged', DK: 'drain-kit-fitted', CN: 'condenser-blocked', PU: 'condensate-pump-or-float', LK: 'internal-hose-or-seal-leak' };
const SIGNALS = {
  TK: { tankFixed: SS, restoredAfterTankFix: SS, failsAfterTankFix: SA, tankOk: SA, tankWarning: S },
  CR: { tankCracked: SS, leakUnder: S },
  DK: { drainKit: SS, tankEmpty: S, tankWarning: A },
  CN: { condFixed: SS, restoredAfterCondFix: SS, failsAfterCondFix: SA, condOk: SA, leakUnder: S, tankEmpty: S },
  PU: { pumpEvidence: SS, codePump: S, tankEmpty: S, tankWarning: S, condOk: S, tankOk: S, drainKit: SA, tankFills: A, restoredAfterTankFix: SA, restoredAfterCondFix: SA },
  LK: { leakUnder: S, tankOk: S, condOk: S, tankEmpty: A, restoredAfterTankFix: SA, restoredAfterCondFix: SA },
};
const FACT_LABEL = { tankWarning: 'container / tank warning on', tankEmpty: 'container stays empty', tankFills: 'container fills normally', leakUnder: 'water under the dryer',
  drainKit: 'drain kit fitted', tankFixed: 'container full / not pushed home (sorted)', tankOk: 'container seated and undamaged', tankCracked: 'container cracked',
  condFixed: 'condenser clogged (cleaned)', condOk: 'condenser clean', codePump: 'pump / condensate error code', pumpEvidence: 'pump code, container empty, condenser clean',
  vented: 'vented dryer', condenser: 'condenser dryer', heatPump: 'heat-pump dryer' };
const SPEC = {
  schema: 'td6-diag/1', FAMILY, PRIOR: ['TK', 'CR', 'DK', 'CN', 'PU', 'LK'], SIGNALS, FACT_LABEL,
  obs: { tankWarning: ['tankWarning', true], tankEmpty: ['tankStaysEmpty', true], tankFills: ['tankStaysEmpty', false], leakUnder: ['leakUnderneath', true], drainKit: ['drainKitFitted', true] },
  checks: { 'water-container': { clear: 'tankOk', found: 'tankFixed', fault: 'tankCracked' }, condenser: { clear: 'condOk', found: 'condFixed' } },
  FIX_CHECK: { TK: ['water-container', 'Tank'], CN: ['condenser', 'Cond'] },
  DECISIVE_PART: { CR: { tankCracked: 'water-container' }, PU: { pumpEvidence: 'condensate-pump' } },
  architecture: (s, ctx) => F.tdArchitecture(s, ctx),
  extra(s, ctx, on) {
    F.archFacts(on, ctx.architecture);
    on('codePump', ctx.codeFault === 'not-emptying-condensate');
    on('pumpEvidence', ctx.codeFault === 'not-emptying-condensate' && engine.obsVal(s, 'tankStaysEmpty') === true && engine.checkResult(s, 'condenser') === 'clear'
      && engine.obsVal(s, 'drainKitFitted') !== true);
  },
  eligible: (k, has) => (k === 'DK' ? has('drainKit') : k === 'CR' ? has('tankCracked') : true),
};
function diagnose(state, ctx = {}) {
  const codeFault = ctx.codeFault !== undefined ? ctx.codeFault : F.tdCodeFault(state, ctx.errorCodes || null);
  return engine.diagnoseSpec(SPEC, state, { ...ctx, codeFault });
}
const archKnown = (h) => h.has('vented') || h.has('condenser') || h.has('heatPump');
const tankKnown = (h) => h.has('tankWarning') || h.has('tankEmpty') || h.has('tankFills');
const P = kit.makeStepPolicy({
  JOURNEY: KEY, P: 'DW', appliance: 'tumble-dryer', journeys: ['leaking'], ...F.owns(KEY), declineUnsafe: F.UNSAFE,
  CHECKS: ['water-container', 'condenser'],
  OBS_TARGETS: { dryerType: ['dryerVented', 'dryerCondenser', 'dryerHeatPump'], tdTankState: ['tankStaysEmpty', 'tankWarning'], drainKitFitted: ['drainKitFitted'] },
  REQUIRES: { dryerType: [], tdTankState: [], 'water-container': [], drainKitFitted: [], condenser: ['td_unplug_cool'], retest: [] },
  FIX_CHECKS: ['water-container', 'condenser'],
  // a vented dryer has no water container: architecture gates the journey (said once, no part)
  early(h) { return h.has('vented') ? { target: 'vented-no-container', reason: 'vented-has-no-container', rule: 'DW5', handoff: 'none' } : null; },
  steps: [
    { n: 10, target: 'dryerType', reason: 'technology-gates-container', when: (h) => !archKnown(h) },
    { n: 11, target: 'tdTankState', reason: 'empty-warning-or-fills', when: (h) => !tankKnown(h) && !h.has('leakUnder') },
    { n: 12, target: 'water-container', reason: 'container-seated-full-cracked', when: () => true },
    { n: 13, target: 'drainKitFitted', reason: 'drain-kit-makes-empty-normal', when: (h) => h.has('tankEmpty') && h.obs('drainKitFitted') == null },
    { n: 14, target: 'condenser', reason: 'clogged-condenser', when: (h) => !h.has('drainKit') && !h.has('tankCracked') },
  ],
  PART_FAMILIES: new Set(['CR', 'PU']),
  HANDOFF: { TK: 'none', CR: 'engineer', DK: 'none', CN: 'none', PU: 'engineer', LK: 'engineer' },
});
const pipeline = JP.makeModelPartPipeline({
  D: { diagnose }, P, schema: 'td6/1', codeFaultFor: F.tdCodeFault,
  PART_MATCH: {
    'water-container': { re: /water\s+(tank|container)|condenser\s+(water\s+)?tank|container\s+assembly/i, not: /pipe|hose|float|washing|dishwasher|fridge/i },
    'condensate-pump': { re: /(condenser|condensate|water|drain)\s+pump|\bpump\s+(assembly|motor|complete)\b/i, not: /pipe|hose|washing|dishwasher|filter/i },
  },
  MEDIA_BY_KEY: { condenser: { knowledgeId: 'tumble-dryer:not-emptying-condensate', ids: ['td-condenser'], concepts: [] } },
});

// ---- COMPOSE (wording only) ----
const FAMILY_LABEL = { 'container-full-or-not-seated': 'the water container being full or not pushed fully home', 'container-damaged': 'a damaged water container',
  'drain-kit-fitted': 'a drain kit taking the water away', 'condenser-blocked': 'a clogged condenser', 'condensate-pump-or-float': 'the condensate pump or float',
  'internal-hose-or-seal-leak': 'an internal hose or seal', 'vented-no-container': 'a vented dryer (no container)' };
const COMPONENT_LABEL = { 'water-container': 'water container', 'condensate-pump': 'condensate pump' };
const TASK = {
  'ask_observation:dryerType': { say: 'First, the type of dryer.', ask: 'Is it a vented dryer (a hose out of the back), a condenser dryer with a water container, or a heat-pump dryer?' },
  'ask_observation:tdTankState': { say: 'Now the water container.', ask: 'Does the container stay empty (hardly any water), is the "empty container" warning on, or does it fill normally?' },
  'ask_check:water-container': { say: 'Slide the water container out, empty it, check it isn\'t cracked and that the lid / float is clean, then push it firmly all the way home until it clicks.', ask: 'Was it full or not pushed fully in (and is it sorted), is it cracked, or was it already empty, seated and fine?' },
  'ask_observation:drainKitFitted': { say: 'Some dryers have their water piped away through a small hose at the back to a sink or waste pipe.', ask: 'Does your dryer have a drain hose fitted like that, instead of using the container?' },
  'ask_check:condenser': { say: 'Behind the flap at the bottom front there\'s a condenser unit (or a second filter on heat-pump models). Take it out and rinse the fluff off under the tap, then let it drip-dry and refit it.', ask: 'Was it clogged with fluff (and is it clean now), or was it already clean?' },
  'ask_check:retest': { say: 'Run a normal drying programme.', ask: 'Is it collecting the water (and staying dry underneath) now, or still not?' },
  'ask_identity:model': { say: 'To match the right part for your dryer I need its exact model.', ask: 'Could you send me the model number? It\'s on the rating plate inside the door rim or on the back — a photo is fine.' },
  'ask_identity:appliance': { say: '', ask: 'Is it a tumble dryer or a washer-dryer?' },
};
const CONCLUSION = {
  'vented-no-container': 'A vented dryer doesn\'t collect water — the damp air goes out through the vent hose, so there\'s no container to empty or fail. Water from a vented dryer is usually condensation in the hose: keep the hose short, straight and running down to the outside vent. No part is needed.',
  'DW7:container-full-or-not-seated': 'That was the container, so no part is needed — empty it after every load (the warning is just doing its job).',
  'DW7:condenser-blocked': 'Cleaning the condenser very likely fixed it, so no part is needed. Rinse it every month or so.',
  'drain-kit-fitted': 'With a drain hose fitted, the water goes straight to the waste, so an empty container is normal — no part is needed.',
  'condensate-pump-or-float': 'The water isn\'t reaching the container even with the condenser clean, which points to the condensate pump, its hose or the float. That needs an appliance engineer — I\'m not recommending a part from this.',
  'internal-hose-or-seal-leak': 'With the container and condenser fine, the leak is most likely from an internal hose or seal. Please don\'t use it on a wet floor; an appliance engineer is the next step — I\'m not recommending a part from this.',
};
const compose = ck.createCompose({
  TASK, CONFIRM_ASK: 'Is it collecting the water normally now?',
  OBS_COPY: { dryerVented: ['vented', null], dryerCondenser: ['condenser', null], dryerHeatPump: ['heat pump', null], tankStaysEmpty: ['container stays empty', 'container fills'],
    tankWarning: ['container warning on', null], leakUnderneath: ['water under the dryer', null], drainKitFitted: ['drain kit fitted', 'no drain kit'], faultPersists: ['still the same', 'working now'] },
  CHECK_RESULT_COPY: { 'water-container': { clear: 'container fine', found_and_cleared: 'container emptied / reseated', fault_seen: 'container cracked' },
    condenser: { clear: 'condenser clean', found_and_cleared: 'condenser cleaned' } },
  statusChecks: [['retest', 'retest']],
  conclusionCopy: ck.makeConclusionCopy({ FAMILY_LABEL, COMPONENT_LABEL, CONCLUSION, fitNote: 'Unplug the dryer before fitting anything inside it; the container simply slides in. If you\'d rather not, an appliance engineer can fit it.' }),
  PURCHASE_RE: /\b(buy|order|purchase|price|£\s?\d)|\b(new|replacement|replace the)\s+(pump|condensate pump|float|container|tank|water tank|hose|seal|condenser|pcb|control board)\b/i,
});
module.exports = { SPEC, FAMILY, diagnose, P, ...pipeline, FAMILY_LABEL, COMPONENT_LABEL, TASK, REQUIREMENT: ck.REQUIREMENT, SAFETY_COPY: ck.SAFETY_COPY, ...compose };
