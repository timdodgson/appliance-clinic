'use strict';
/**
 * Oven journey 4 — fan not working / noisy fan (rules OF1–OF22). PURE, deterministic.
 * Design: docs/diagnostics/final-migration-evidence.md §OV4. "Fan" is typed: the CIRCULATION fan (inside, at the back of
 * the oven) vs the COOLING fan (blows out above the door / behind the controls and may run on after switching off — normal).
 *   cooling fan running on after use → normal (early, no part)
 *   circulation fan not turning (grill works, so power is there) → fan motor (part only with a model AND that evidence)
 *   circulation fan turns but grinds / squeals → fan motor bearings (part only with a model AND that evidence)
 *   rattle / scrape → something loose at the fan cover (engineer) · fan turns but no heat → oven-not-heating (ov-family).
 */
const engine = require('./evidence-engine.js');
const kit = require('./policy-kit.js');
const JP = require('./journey-pipeline.js');
const F = require('./ov-family.js');
const ck = require('./compose-kit.js');
const { SS, S, A, SA } = engine;

const KEY = 'oven-fan-not-working';
const FAMILY = { FM: 'fan-motor', LB: 'loose-fan-blade-or-cover', CF: 'cooling-fan' };
const SIGNALS = {
  FM: { fanMotorSign: SS, fanNoisySign: SS, fanStill: S, grillOk: S, grind: S, squeal: S, rattle: A },
  LB: { rattle: S, scrape: S, fanTurns: S, grind: A },
  CF: { coolingNoise: SS, hum: S, fanStill: A },
};
const FACT_LABEL = { fanStill: 'oven fan does not turn', fanTurns: 'oven fan turns', grillOk: 'grill heats', grind: 'grinding', squeal: 'squealing', rattle: 'rattling', scrape: 'scraping',
  hum: 'humming', fanMotorSign: 'fan still with power present', fanNoisySign: 'fan turns but grinds / squeals', coolingNoise: 'noise from the cooling fan above the door' };
const SPEC = {
  schema: 'ov4-diag/1', FAMILY, PRIOR: ['FM', 'LB', 'CF'], SIGNALS, FACT_LABEL,
  obs: { fanStill: ['ovenFanTurns', false], fanTurns: ['ovenFanTurns', true], grillOk: ['grillWorks', true], grind: ['grindingNoise', true], squeal: ['squealNoise', true],
    rattle: ['rattlingNoise', true], scrape: ['scrapingNoise', true], hum: ['humNoise', true] },
  checks: {},
  DECISIVE_PART: { FM: { fanMotorSign: 'oven-fan-motor', fanNoisySign: 'oven-fan-motor' } },
  extra(s, ctx, on) {
    const v = (k) => engine.obsVal(s, k);
    on('fanMotorSign', v('ovenFanTurns') === false && (v('grillWorks') === true || v('mainOvenWorks') === true || v('heatsSlowly') === true));
    on('fanNoisySign', v('ovenFanTurns') === true && (v('grindingNoise') === true || v('squealNoise') === true));
  },
  eligible: (k, has) => (k === 'CF' ? has('coolingNoise') || has('hum') : true),
};
function diagnose(state, ctx = {}) {
  const codeFault = ctx.codeFault !== undefined ? ctx.codeFault : F.ovCodeFault(state, ctx.errorCodes || null);
  return engine.diagnoseSpec(SPEC, state, { ...ctx, codeFault });
}
const NOISE = ['grindingNoise', 'squealNoise', 'rattlingNoise', 'scrapingNoise', 'humNoise', 'knockingNoise', 'clickingNoise'];
const P = kit.makeStepPolicy({
  JOURNEY: KEY, P: 'OF', appliance: 'oven-cooker', journeys: ['noisy'], ...F.owns(KEY), declineUnsafe: F.UNSAFE,
  CHECKS: [],
  OBS_TARGETS: { ovenFanTurns: ['ovenFanTurns'], grillWorks: ['grillWorks'], noiseType: NOISE },
  REQUIRES: { ovenFanTurns: ['oven_hot_surfaces'], grillWorks: ['oven_hot_surfaces'], noiseType: [], retest: [] },
  // the cooling fan running on after the oven is switched off is designed behaviour
  early(h) { return h.obs('fanRunsAfterOff') === true && !NOISE.slice(0, 4).some((k) => h.obs(k) === true) ? { target: 'cooling-fan-run-on', reason: 'normal-cooling-fan', rule: 'OF5', handoff: 'none' } : null; },
  steps: [
    { n: 10, target: 'ovenFanTurns', reason: 'circulation-fan-turns', when: (h) => h.obs('ovenFanTurns') == null },
    { n: 11, target: 'grillWorks', reason: 'power-reaches-the-oven', when: (h) => h.has('fanStill') && h.obs('grillWorks') == null },
    { n: 12, target: 'noiseType', reason: 'type-the-noise', when: (h) => h.has('fanTurns') && !NOISE.some((k) => h.obs(k) === true) },
  ],
  PART_FAMILIES: new Set(['FM']),
  HANDOFF: { FM: 'engineer', LB: 'engineer', CF: 'engineer' },
});
const pipeline = JP.makeModelPartPipeline({
  D: { diagnose }, P, schema: 'ov4/1', codeFaultFor: F.ovCodeFault,
  PART_MATCH: { 'oven-fan-motor': { re: /\bfan\s+motor\b|circulation.*\bmotor\b|cooker and oven motor/i, not: /cooling|insulation|stat\b|thermostat|hood|fridge|dryer|washing/i } },
  MEDIA_BY_KEY: {},
});

// ---- COMPOSE (wording only) ----
const FAMILY_LABEL = { 'fan-motor': 'the oven fan motor', 'loose-fan-blade-or-cover': 'a loose fan blade or back cover', 'cooling-fan': 'the cooling fan', 'cooling-fan-run-on': 'the cooling fan running on (normal)' };
const COMPONENT_LABEL = { 'oven-fan-motor': 'oven fan motor' };
const TASK = {
  'ask_observation:ovenFanTurns': { say: 'Ovens have two fans: the one that matters here is behind the round cover on the back wall inside. Put it on the fan setting and look through the door.', ask: 'Can you see or hear that fan turning?' },
  'ask_observation:grillWorks': { say: 'This checks power is reaching the oven.', ask: 'Does the grill heat if you try it on its own for a few minutes?' },
  'ask_observation:noiseType': { say: 'The sound helps tell a worn motor from something loose.', ask: 'Is it a grinding or squealing noise, a rattle or scrape, or a hum?' },
  'ask_identity:model': F.OVEN_MODEL_ASK, 'ask_identity:appliance': F.OVEN_APPLIANCE_ASK,
};
const CONCLUSION = {
  'cooling-fan-run-on': 'That\'s the cooling fan, and it\'s designed to keep running for a while after you switch off to cool the controls and door — it\'s normal and no part is needed.',
  'fan-motor': 'The oven fan motor is the likely cause. An appliance engineer can confirm it safely — I\'m not recommending a part from this.',
  'loose-fan-blade-or-cover': 'A rattle or scrape with the fan turning usually means the fan blade or the back cover has worked loose. Please don\'t run it like that; an appliance engineer can sort it safely — I\'m not recommending a part from this.',
  'cooling-fan': 'The noise is most likely the cooling fan above the door. If it\'s loud or grinding, an appliance engineer should check it — I\'m not recommending a part from this.',
};
const compose = ck.createCompose({
  ASK_GUARD: true, TASK, CONFIRM_ASK: 'Is the fan working normally now?',
  OBS_COPY: { ovenFanTurns: ['fan turns', 'fan not turning'], grillWorks: ['grill heats', 'grill cold'], grindingNoise: ['grinding', null], squealNoise: ['squealing', null], rattlingNoise: ['rattling', null],
    scrapingNoise: ['scraping', null], humNoise: ['humming', null], fanRunsAfterOff: ['fan runs on after switching off', null] },
  CHECK_RESULT_COPY: {},
  conclusionCopy: ck.makeConclusionCopy({ FAMILY_LABEL, COMPONENT_LABEL, CONCLUSION, fitNote: 'Switch the oven off at the isolator and let it cool before fitting it; the motor sits behind the back panel — if you\'d rather not, an appliance engineer can fit it.' }),
  PURCHASE_RE: /\b(buy|order|purchase|price|£\s?\d)|\b(new|replacement|replace the)\s+(fan|fan motor|motor|blade|element|pcb|control board)\b/i,
});
module.exports = { SPEC, FAMILY, diagnose, P, ...pipeline, FAMILY_LABEL, COMPONENT_LABEL, TASK, REQUIREMENT: ck.REQUIREMENT, SAFETY_COPY: ck.SAFETY_COPY, ...compose };
