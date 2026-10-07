'use strict';
/**
 * Dishwasher journey 5 — not heating / not drying (rules T1–T22). PURE, deterministic.
 * Design: docs/diagnostics/dw-batch-1-evidence.md §5. Heating and drying are related but separate paths:
 *   DRYING (dishes wet, water / dishes hot): only plastics → normal condensation drying; rinse aid; programme; else the
 *   drying system (engineer). Wet dishes never imply a failed heater.
 *   HEATING (water / dishes cold on a programme that should heat, or a supervised intensive test): heater only with a
 *   heater-specific code + model; sensor / control → engineer. A trip / burning is a sticky-kit safety stop.
 */
const engine = require('./evidence-engine.js');
const rq = require('./requests.js');
const kit = require('./policy-kit.js');
const JP = require('./journey-pipeline.js');
const F = require('./dw-family.js');
const ck = require('./compose-kit.js');
const { SS, S, A, SA } = engine;

const FAMILY = { NP: 'normal-condensation-drying', RA: 'rinse-aid', PG: 'programme-choice', DS: 'drying-system', HE: 'heater', TS: 'temperature-sensor', CT: 'heating-control' };
const SIGNALS = {
  NP: { plastics: SS, hot: S, wet: S, cold: SA, everythingWet: SA },
  RA: { raFixed: SS, restoredAfterRaFix: SS, failsAfterRaFix: SA, wet: S, hot: S, everythingWet: S, raOk: SA, cold: A },
  PG: { lowProg: SS, wet: S, hot: S, coldOnHot: SA, hotProg: A },
  DS: { wet: S, hot: S, everythingWet: S, raOk: S, hotProg: S, plastics: SA, cold: SA, lowProg: A },
  HE: { codeHeater: SS, coldOnHot: S, cold: S, long: S, hot: SA, plastics: A, codeNtc: A },
  TS: { codeNtc: SS, cold: S, long: S, hot: A, codeHeater: A },
  CT: { codeControl: SS, coldOnHot: S, cold: S, long: S, hot: SA, codeHeater: A },
};
const FACT_LABEL = {
  cold: 'water / dishes stay cold', hot: 'dishes / water get hot', wet: 'dishes wet at the end', plastics: 'only plastics wet', everythingWet: 'glass / china wet too',
  hotProg: 'a hot / normal programme used', lowProg: 'an eco / quick / low-temperature programme used', long: 'programme takes much longer than usual',
  coldOnHot: 'cold on a programme that should heat', raFixed: 'rinse aid empty / set low (sorted)', raOk: 'rinse aid full and set normally',
  codeHeater: 'heating error code', codeNtc: 'temperature-sensor error code', codeControl: 'control error code',
};
const askTurn = (s, t) => { const r = rq.requestsFor(s, t); return r.length ? r[0].askedTurn : null; };
const SPEC = {
  schema: 'dw5-diag/1', FAMILY, PRIOR: ['NP', 'RA', 'PG', 'DS', 'HE', 'TS', 'CT'], SIGNALS, FACT_LABEL,
  obs: { cold: ['noHeat', true], hot: ['heatPresent', true], wet: ['dishesWet', true], plastics: ['onlyPlasticsWet', true], everythingWet: ['onlyPlasticsWet', false],
    hotProg: ['hotProgrammeUsed', true], lowProg: ['hotProgrammeUsed', false], long: ['longCycle', true] },
  checks: { 'rinse-aid': { clear: 'raOk', found: 'raFixed' } },
  FIX_CHECK: { RA: ['rinse-aid', 'Ra'] },
  DECISIVE_PART: { HE: { codeHeater: 'heater' } },
  extra(s, ctx, on) {
    const v = (k) => engine.obsVal(s, k);
    on('hot', v('noHeat') === false);
    on('wet', v('onlyPlasticsWet') != null);
    const t = askTurn(s, 'hot-wash-test');
    const coldTest = t != null && v('noHeat') === true && (engine.obsTurnOf(s, 'noHeat') || 0) > t;
    on('coldOnHot', v('noHeat') === true && (v('hotProgrammeUsed') === true || coldTest));
    on('codeHeater', ctx.codeFault === 'heating'); on('codeNtc', ctx.codeFault === 'temperature-sensor'); on('codeControl', ctx.codeFault === 'main-pcb');
  },
  eligible: (k, has) => (['NP', 'RA', 'DS'].includes(k) ? has('wet') || has('raFixed') : true),
};
function diagnose(state, ctx = {}) {
  const codeFault = ctx.codeFault !== undefined ? ctx.codeFault : F.dwCodeFault(state, ctx.errorCodes || null);
  return engine.diagnoseSpec(SPEC, state, { ...ctx, codeFault });
}
const P = kit.makeStepPolicy({
  JOURNEY: 'dw-not-heating-drying', P: 'T', appliance: 'dishwasher', journeys: ['no-heat', 'not-drying'], codeFaults: ['heating', 'temperature-sensor'],
  claims: (h, journey) => journey === 'poor-results' && F.heatIssue(h) && !F.fillIssue(h) && !F.flood(h),
  ownedElsewhere: (h) => F.flood(h),
  CHECKS: ['rinse-aid', 'hot-wash-test'],
  OBS_TARGETS: { heatState: ['noHeat', 'heatPresent'], onlyPlasticsWet: ['onlyPlasticsWet'], hotProgrammeUsed: ['hotProgrammeUsed'], longCycle: ['longCycle'] },
  outcomeObs: { 'hot-wash-test': 'noHeat' },
  REQUIRES: { 'rinse-aid': [], 'hot-wash-test': ['stop_if_trips_or_burning', 'dw_hot_steam'], retest: [] },
  FIX_CHECKS: ['rinse-aid'],
  steps: [
    { n: 10, target: 'heatState', reason: 'hot-vs-cold-splits-paths', when: (h) => !h.has('cold') && !h.has('hot') },
    { n: 11, target: 'onlyPlasticsWet', reason: 'plastics-normal', when: (h) => h.has('hot') && !h.has('plastics') && !h.has('everythingWet') },
    { n: 12, target: 'rinse-aid', reason: 'rinse-aid-for-drying', when: (h) => h.has('hot') && !h.has('plastics') },
    { n: 13, target: 'hotProgrammeUsed', reason: 'programme-decides-heat-and-dry', when: (h) => !h.has('plastics') && !h.has('coldOnHot') },
    { n: 14, target: 'hot-wash-test', reason: 'supervised-intensive-test', when: (h) => h.has('cold') && !h.has('coldOnHot') },
    { n: 15, target: 'longCycle', reason: 'long-cycle-supports-heating-fault', when: (h) => h.has('coldOnHot') },
  ],
  PART_FAMILIES: new Set(['HE']),
  HANDOFF: { NP: 'none', RA: 'none', PG: 'none', DS: 'engineer', HE: 'engineer', TS: 'engineer', CT: 'engineer' },
});

const pipeline = JP.makeModelPartPipeline({
  D: { diagnose }, P, schema: 'dw5/1', codeFaultFor: F.dwCodeFault,
  PART_MATCH: { heater: { re: /\bheater\b|heating\s+element|\bheat\s*-?\s*pump\b|heater\s+pump/i, not: /dryer|tumble|sensor|ntc|thermostat|fuse/i } },
  MEDIA_BY_KEY: {},
});

// ---- COMPOSE (wording only) ----
const FAMILY_LABEL = {
  'normal-condensation-drying': 'normal condensation drying (plastics stay wet)', 'rinse-aid': 'the rinse aid', 'programme-choice': 'the programme choice', 'drying-system': 'the drying system',
  heater: 'the heater', 'temperature-sensor': 'the temperature sensor', 'heating-control': 'the heating control or wiring',
};
const COMPONENT_LABEL = { heater: 'heater (heater pump / element)' };
const TASK = {
  'ask_observation:heatState': { say: 'This splits a drying problem from a heating one.', ask: 'At the end of a normal programme, are the dishes and the inside of the door hot (with some steam), or cold?' },
  'ask_observation:onlyPlasticsWet': { say: 'Most dishwashers dry by condensation: hot china and glass dry off, but plastic holds little heat.', ask: 'Is it only the plastic items that stay wet, or are glasses and plates wet too?' },
  'ask_check:rinse-aid': { say: 'Rinse aid is what makes water run off so the dishes dry — check the rinse-aid indicator or cap next to the detergent flap, top it up if it\'s low, and check the setting isn\'t on the lowest level.', ask: 'Was the rinse aid empty or set low (and have you sorted it), or was it already full and set normally?' },
  'ask_observation:hotProgrammeUsed': { say: 'Eco and quick programmes run cooler (and dry less) to save energy.', ask: 'Which programme do you normally use — eco or quick, or a normal / intensive one?' },
  'ask_check:hot-wash-test': { say: 'To check the heating, run an intensive or 65°C programme with a normal load.', ask: 'At the end, are the dishes hot and steamy, or still cold?' },
  'ask_observation:longCycle': { say: 'One more thing that helps.', ask: 'Does the programme take much longer than usual, or seem to get stuck part way through?' },
  'ask_check:retest': { say: 'Now run a normal programme again.', ask: 'Are the dishes coming out dry now, or still wet?' },
  'ask_identity:model': { say: 'To match the right part for your dishwasher I need its exact model.', ask: 'Could you send me the model number? It\'s on the rating plate along the edge of the door or the side of the tub — a photo of the label is fine.' },
  'ask_identity:appliance': { say: '', ask: 'Is it a dishwasher, a washing machine or a washer-dryer?' },
};
const CONCLUSION = {
  'normal-condensation-drying': 'That\'s normal for condensation drying: plastic holds too little heat to dry off. Leaving the door ajar for a few minutes at the end, using rinse aid and putting plastics on the top rack all help — no part is needed.',
  'T7:rinse-aid': 'The rinse aid was very likely the reason, so no part is needed. Keep it topped up (all-in-one tablets often aren\'t enough on their own).',
  'programme-choice': 'Eco and quick programmes run cooler and dry less to save energy, so wetter dishes (and cooler water) are normal on those. Try a normal or intensive programme with rinse aid — no part is needed.',
  'drying-system': 'With hot dishes, rinse aid in use and a normal programme but everything still wet, the drying system (the fan or vent on models that have one) is the likely area. That needs an appliance engineer — I\'m not recommending a part from this.',
  heater: 'Cold water on a programme that should heat points to the heating side — most often the heater, but the temperature sensor or control can do the same. That needs an appliance engineer to test safely; I\'m not recommending a part from this.',
  'temperature-sensor': 'This points to the temperature sensor or its wiring. That needs an appliance engineer to test safely — I\'m not recommending a part from this.',
  'heating-control': 'The heating control or wiring is the most likely area. That needs an appliance engineer to test safely — I\'m not recommending a part from this.',
};
const compose = ck.createCompose({
  TASK, CONFIRM_ASK: 'Is it heating and drying normally now?',
  OBS_COPY: { noHeat: ['stays cold', 'gets hot'], heatPresent: ['gets hot', null], dishesWet: ['dishes wet', null], onlyPlasticsWet: ['only plastics wet', 'glass / china wet too'],
    hotProgrammeUsed: ['normal / intensive programme', 'eco / quick programme'], longCycle: ['takes much longer', null], faultPersists: ['still the same', 'fixed'] },
  CHECK_RESULT_COPY: { 'rinse-aid': { clear: 'rinse aid full, normal setting', found_and_cleared: 'rinse aid empty / low (sorted)' } },
  statusChecks: [['hot-wash-test', 'intensive test'], ['retest', 'retest']],
  conclusionCopy: ck.makeConclusionCopy({ FAMILY_LABEL, COMPONENT_LABEL, CONCLUSION, fitNote: 'Switch the dishwasher off at the socket before fitting it — the heater sits inside, so if you\'re not confident an appliance engineer can fit and test it.' }),
  PURCHASE_RE: /\b(buy|order|purchase|price|£\s?\d)|\b(new|replacement|replace the)\s+(heater|heating element|element|heat pump|thermistor|ntc|temperature sensor|fan|pcb|control board|relay)\b/i,
});
module.exports = { SPEC, FAMILY, diagnose, P, ...pipeline, FAMILY_LABEL, COMPONENT_LABEL, TASK, REQUIREMENT: ck.REQUIREMENT, SAFETY_COPY: ck.SAFETY_COPY, ...compose };
