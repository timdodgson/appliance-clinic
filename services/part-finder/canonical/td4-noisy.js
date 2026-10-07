'use strict';
/**
 * Tumble dryer journey 4 — noisy (rules DN1–DN22). PURE, deterministic.
 * Design: docs/diagnostics/ff-td-batch-evidence.md §TD4. The noise is typed first; a generic "noisy" never yields a motor or
 * bearing conclusion:
 *   knock / rattle / scrape → coins, buttons, zips (drum, filter housing, pockets) — owner fix
 *   squeal / rumble / grind → drum by hand (unplugged): rough / squeaky by hand → drum rollers / idler (jockey) wheel
 *     (part only with a confirmed model AND that owner-felt evidence) · smooth by hand → belt / drive area (engineer)
 *   hum / buzz on a condenser or heat-pump dryer → normal pump / compressor sound (no part)
 */
const engine = require('./evidence-engine.js');
const kit = require('./policy-kit.js');
const JP = require('./journey-pipeline.js');
const F = require('./td-family.js');
const ck = require('./compose-kit.js');
const { SS, S, A, SA } = engine;

const KEY = 'td-noisy';
const FAMILY = { FO: 'foreign-object', OS: 'object-out-of-reach', RS: 'drum-rollers-or-idler', DA: 'drive-area', NN: 'normal-pump-or-compressor-hum' };
const SIGNALS = {
  FO: { objFound: SS, restoredAfterObjFix: SS, failsAfterObjFix: SA, objOk: SA, objStuck: SA, knock: S, rattle: S, scrape: S, squeal: A },
  OS: { objStuck: SS },
  RS: { rollerSign: SS, byHandRough: S, squeal: S, grind: S, objOk: S, byHandOk: SA, knock: A },
  DA: { squeal: S, grind: S, byHandOk: S, objOk: S, byHandRough: A, hum: A },
  NN: { hum: S, condenserLike: S, squeal: SA, grind: SA, knock: SA, rattle: SA, scrape: SA },
};
const FACT_LABEL = { knock: 'knocking / banging', rattle: 'rattling', scrape: 'scraping', squeal: 'squealing / squeaking', grind: 'rumbling / grinding', hum: 'humming / buzzing',
  objFound: 'coin / button / item found (removed)', objStuck: 'item stuck out of reach', objOk: 'nothing loose found', byHandRough: 'rough / squeaky by hand', byHandOk: 'smooth by hand',
  rollerSign: 'squeal or rumble that is rough by hand', condenserLike: 'condenser / heat-pump dryer' };
const SPEC = {
  schema: 'td4-diag/1', FAMILY, PRIOR: ['FO', 'OS', 'RS', 'DA', 'NN'], SIGNALS, FACT_LABEL,
  obs: { knock: ['knockingNoise', true], rattle: ['rattlingNoise', true], scrape: ['scrapingNoise', true], squeal: ['squealNoise', true], grind: ['grindingNoise', true], hum: ['humNoise', true] },
  checks: { 'drum-foreign-object': { clear: 'objOk', cleared: 'objFound', notCleared: 'objStuck' }, 'drum-by-hand': { clear: 'byHandOk', fault: 'byHandRough' } },
  FIX_CHECK: { FO: ['drum-foreign-object', 'Obj'] },
  DECISIVE_PART: { RS: { rollerSign: 'drum-roller' } },
  architecture: (s, ctx) => F.tdArchitecture(s, ctx),
  extra(s, ctx, on) {
    F.archFacts(on, ctx.architecture);
    const a = ctx.architecture.type; on('condenserLike', a === 'condenser' || a === 'heat-pump');
    const rough = engine.checkResult(s, 'drum-by-hand') === 'fault_seen';
    on('rollerSign', rough && ['squealNoise', 'grindingNoise'].some((k) => engine.obsVal(s, k) === true));
  },
  eligible: (k, has) => (k === 'NN' ? has('hum') : k === 'OS' ? has('objStuck') : true),
};
function diagnose(state, ctx = {}) {
  const codeFault = ctx.codeFault !== undefined ? ctx.codeFault : F.tdCodeFault(state, ctx.errorCodes || null);
  return engine.diagnoseSpec(SPEC, state, { ...ctx, codeFault });
}
const TYPES = ['knock', 'rattle', 'scrape', 'squeal', 'grind', 'hum'];
const P = kit.makeStepPolicy({
  JOURNEY: KEY, P: 'DN', appliance: 'tumble-dryer', journeys: ['noisy'], ...F.owns(KEY), declineUnsafe: F.UNSAFE,
  CHECKS: ['drum-foreign-object', 'drum-by-hand'],
  OBS_TARGETS: { noiseType: ['grindingNoise', 'humNoise', 'scrapingNoise', 'knockingNoise', 'rattlingNoise', 'squealNoise', 'clickingNoise'],
    dryerType: ['dryerVented', 'dryerCondenser', 'dryerHeatPump'] },
  REQUIRES: { noiseType: [], dryerType: [], 'drum-foreign-object': ['td_unplug_cool', 'torch_and_fingers_only'], 'drum-by-hand': ['td_unplug_cool', 'turn_by_hand_only'], retest: [] },
  FIX_CHECKS: ['drum-foreign-object'],
  fixResults: { 'drum-foreign-object': ['found_and_cleared'] },
  steps: [
    { n: 10, target: 'noiseType', reason: 'type-by-sound', when: (h) => !TYPES.some(h.has) && h.obs('clickingNoise') !== true },
    { n: 11, target: 'drum-foreign-object', reason: 'loose-item', when: (h) => h.has('knock') || h.has('rattle') || h.has('scrape') || h.obs('clickingNoise') === true },
    { n: 12, target: 'drum-by-hand', reason: 'rollers-or-drive', when: (h) => !h.has('objStuck') && (h.has('squeal') || h.has('grind') || (h.has('objOk') && !h.has('hum'))) },
    { n: 13, target: 'dryerType', reason: 'hum-normal-on-condenser-heat-pump', when: (h) => h.has('hum') && !h.has('condenserLike') && !h.has('vented') },
  ],
  PART_FAMILIES: new Set(['RS']),
  HANDOFF: { FO: 'none', OS: 'engineer', RS: 'engineer', DA: 'engineer', NN: 'none' },
});
const pipeline = JP.makeModelPartPipeline({
  D: { diagnose }, P, schema: 'td4/1', codeFaultFor: F.tdCodeFault,
  PART_MATCH: { 'drum-roller': { re: /\broller\b|jockey\s+wheel|idler|drum\s+(support\s+)?wheel/i, not: /washing|washer|dishwasher|belt|bearing|motor|door/i } },
  MEDIA_BY_KEY: {},
});

// ---- COMPOSE (wording only) ----
const FAMILY_LABEL = { 'foreign-object': 'something loose in the drum or filter housing', 'object-out-of-reach': 'an item stuck out of reach', 'drum-rollers-or-idler': 'the drum support rollers or idler (jockey) wheel',
  'drive-area': 'the belt / drive area', 'normal-pump-or-compressor-hum': 'the normal pump or compressor hum' };
const COMPONENT_LABEL = { 'drum-roller': 'drum support roller / idler wheel' };
const TASK = {
  'ask_observation:noiseType': { say: 'The type of noise tells us a lot.', ask: 'What does it sound like — knocking or rattling, scraping, squealing or squeaking, a rumble or grind, or a hum?' },
  'ask_check:drum-foreign-object': { say: 'Coins, buttons, zips and hair grips are the usual cause. With the dryer unplugged, check the drum and its lifters, the lint filter and the slot it sits in, and turn the drum slowly while you listen.', ask: 'Did you find something (and have you removed it), can you see something stuck that won\'t come out, or is it all clear?' },
  'ask_check:drum-by-hand': { say: 'With the dryer unplugged and empty, turn the drum slowly by hand.', ask: 'Does it turn smoothly and quietly, or does it feel rough, rumble or squeak as you turn it?' },
  'ask_observation:dryerType': { say: 'Some dryers hum by design.', ask: 'Is it a vented dryer (a hose out of the back), a condenser dryer with a water container, or a heat-pump dryer?' },
  'ask_check:retest': { say: 'Run a short programme.', ask: 'Has the noise gone, or is it still there?' },
  'ask_identity:model': { say: 'To match the right part for your dryer I need its exact model.', ask: 'Could you send me the model number? It\'s on the rating plate inside the door rim or on the back — a photo is fine.' },
  'ask_identity:appliance': { say: '', ask: 'Is it a tumble dryer or a washer-dryer?' },
};
const CONCLUSION = {
  'DN7:foreign-object': 'That was the loose item, so no part is needed. Checking pockets before drying helps.',
  'object-out-of-reach': 'Something is stuck where you can\'t reach it. Please don\'t take the dryer apart; an appliance engineer can remove it — I\'m not recommending a part from this.',
  'drum-rollers-or-idler': 'A squeal or rumble that you can also feel as roughness by hand points to the drum support rollers or the idler (jockey) wheel. An appliance engineer can confirm it — I\'m not recommending a part from this.',
  'drive-area': 'With nothing loose and the drum smooth by hand, the noise is from the belt / drive area. That needs an appliance engineer to check — I\'m not recommending a part from this.',
  'normal-pump-or-compressor-hum': 'A steady hum on a condenser or heat-pump dryer is normally the water pump or the heat-pump compressor working — that\'s expected and no part is needed. If it turns into a grind or squeal, let me know.',
};
const compose = ck.createCompose({
  TASK, CONFIRM_ASK: 'Has the noise gone now?',
  OBS_COPY: { knockingNoise: ['knocking', null], rattlingNoise: ['rattling', null], scrapingNoise: ['scraping', null], squealNoise: ['squealing', null], grindingNoise: ['rumbling / grinding', null],
    humNoise: ['humming', null], clickingNoise: ['clicking', null], dryerVented: ['vented', null], dryerCondenser: ['condenser', null], dryerHeatPump: ['heat pump', null], faultPersists: ['still noisy', 'noise gone'] },
  CHECK_RESULT_COPY: { 'drum-foreign-object': { clear: 'nothing loose found', found_and_cleared: 'item found and removed', found_not_cleared: 'item stuck out of reach' },
    'drum-by-hand': { clear: 'smooth by hand', fault_seen: 'rough / squeaky by hand' } },
  statusChecks: [['retest', 'retest']],
  conclusionCopy: ck.makeConclusionCopy({ FAMILY_LABEL, COMPONENT_LABEL, CONCLUSION, fitNote: 'Unplug the dryer before fitting it — the rollers sit behind panels, so if you\'d rather not, an appliance engineer can fit it.' }),
  PURCHASE_RE: /\b(buy|order|purchase|price|£\s?\d)|\b(new|replacement|replace the)\s+(roller|rollers|idler|jockey wheel|belt|bearing|motor|pump|compressor)\b/i,
});
module.exports = { SPEC, FAMILY, diagnose, P, ...pipeline, FAMILY_LABEL, COMPONENT_LABEL, TASK, REQUIREMENT: ck.REQUIREMENT, SAFETY_COPY: ck.SAFETY_COPY, ...compose };
