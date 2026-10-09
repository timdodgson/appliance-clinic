'use strict';
/**
 * Tumble dryer journey 2 — not drying (heat present) (rules DD1–DD22). PURE, deterministic.
 * Design: docs/diagnostics/ff-td-batch-evidence.md §TD2. "Hot but not drying" is an AIRFLOW / load / sensing problem, not the
 * heater (there is no heater family here; no heat at all → td-not-heating owns it). Technology decides the airflow checks:
 *   lint filter → load (overloaded / not spun) → condenser (condenser / heat pump) or vent hose (vented) → moisture-sensor
 *   strips → programme / dryness level → drying system / fan (engineer). A torn lint filter (owner seen) + model → filter part.
 */
const engine = require('./evidence-engine.js');
const kit = require('./policy-kit.js');
const JP = require('./journey-pipeline.js');
const F = require('./td-family.js');
const ck = require('./compose-kit.js');
const { SS, S, A, SA } = engine;

const KEY = 'td-not-drying';
const FAMILY = { FL: 'lint-filter', LD: 'load-size-or-spin', CN: 'condenser-blocked', VD: 'vent-hose-restricted', SB: 'moisture-sensor-strips', PG: 'programme-or-dryness-level', DS: 'drying-airflow-system' };
const SIGNALS = {
  FL: { filterFixed: SS, filterTorn: SS, restoredAfterFilterFix: SS, failsAfterFilterFix: SA, filterOk: SA },
  LD: { loadFixed: SS, restoredAfterLoadFix: SS, failsAfterLoadFix: SA, loadOk: SA },
  CN: { condFixed: SS, restoredAfterCondFix: SS, failsAfterCondFix: SA, condOk: SA, tankEmpty: S, long: S },
  VD: { ventFixed: SS, restoredAfterVentFix: SS, failsAfterVentFix: SA, ventOk: SA, long: S },
  SB: { sensorFixed: SS, restoredAfterSensorFix: SS, failsAfterSensorFix: SA, sensorOk: SA },
  PG: { progFixed: SS, restoredAfterProgFix: SS, failsAfterProgFix: SA, progOk: SA },
  DS: { warm: S, filterOk: S, loadOk: S, condOk: S, ventOk: S, sensorOk: S, progOk: S, long: S, filterTorn: SA, restoredAfterFilterFix: SA, restoredAfterLoadFix: SA, restoredAfterCondFix: SA, restoredAfterVentFix: SA, restoredAfterSensorFix: SA, restoredAfterProgFix: SA },
};
const FACT_LABEL = {
  warm: 'gets warm / hot', long: 'takes much longer than it used to', tankEmpty: 'water container stays empty', filterFixed: 'lint filter blocked (cleaned)', filterTorn: 'lint filter torn',
  filterOk: 'lint filter clean', loadFixed: 'overloaded / not spun enough (changed)', loadOk: 'normal load, well spun', condFixed: 'condenser clogged (cleaned)', condOk: 'condenser clean',
  ventFixed: 'vent hose kinked / blocked (cleared)', ventOk: 'vent hose clear', sensorFixed: 'sensor strips coated (cleaned)', sensorOk: 'sensor strips clean',
  progFixed: 'programme / dryness level too low (changed)', progOk: 'normal drying programme', vented: 'vented dryer', condenser: 'condenser dryer', heatPump: 'heat-pump dryer',
};
const SPEC = {
  schema: 'td2-diag/1', FAMILY, PRIOR: ['FL', 'LD', 'CN', 'VD', 'SB', 'PG', 'DS'], SIGNALS, FACT_LABEL,
  obs: { long: ['longCycle', true], tankEmpty: ['tankStaysEmpty', true] },
  checks: { 'lint-filter': { clear: 'filterOk', found: 'filterFixed', fault: 'filterTorn' }, 'load-check': { clear: 'loadOk', found: 'loadFixed' },
    condenser: { clear: 'condOk', found: 'condFixed' }, 'vent-duct': { clear: 'ventOk', found: 'ventFixed' }, 'sensor-bars': { clear: 'sensorOk', found: 'sensorFixed' },
    'programme-setting': { clear: 'progOk', found: 'progFixed' } },
  FIX_CHECK: { FL: ['lint-filter', 'Filter'], LD: ['load-check', 'Load'], CN: ['condenser', 'Cond'], VD: ['vent-duct', 'Vent'], SB: ['sensor-bars', 'Sensor'], PG: ['programme-setting', 'Prog'] },
  DECISIVE_PART: { FL: { filterTorn: 'lint-filter' } },
  architecture: (s, ctx) => F.tdArchitecture(s, ctx),
  extra(s, ctx, on) {
    F.archFacts(on, ctx.architecture);
    on('warm', F.heatState(s) === 'warm');
  },
  eligible: (k, has) => (k === 'CN' ? !has('vented') : k === 'VD' ? !has('condenser') && !has('heatPump') : true),
};
function diagnose(state, ctx = {}) {
  const codeFault = ctx.codeFault !== undefined ? ctx.codeFault : F.tdCodeFault(state, ctx.errorCodes || null);
  return engine.diagnoseSpec(SPEC, state, { ...ctx, codeFault });
}
const archKnown = (h) => h.has('vented') || h.has('condenser') || h.has('heatPump');
const P = kit.makeStepPolicy({
  JOURNEY: KEY, P: 'DD', appliance: 'tumble-dryer', journeys: ['not-drying'], ...F.owns(KEY), declineUnsafe: F.UNSAFE,
  CHECKS: ['lint-filter', 'load-check', 'condenser', 'vent-duct', 'sensor-bars', 'programme-setting'],
  OBS_TARGETS: { heatState: ['noHeat', 'heatPresent'], dryerType: ['dryerVented', 'dryerCondenser', 'dryerHeatPump'] },
  REQUIRES: { heatState: [], dryerType: [], 'lint-filter': ['td_unplug_cool'], 'load-check': [], condenser: ['td_unplug_cool'], 'vent-duct': ['td_unplug_cool'],
    'sensor-bars': ['td_unplug_cool'], 'programme-setting': [], retest: [] },
  FIX_CHECKS: ['lint-filter', 'load-check', 'condenser', 'vent-duct', 'sensor-bars', 'programme-setting'],
  steps: [
    // the fluff filter first: free, safe, on every dryer type, and a blocked one also trips the heat off
    { n: 12, target: 'lint-filter', reason: 'lint-filter-airflow', when: () => true },
    { n: 11, target: 'dryerType', reason: 'technology-decides-airflow', when: (h) => !archKnown(h) },
    { n: 10, target: 'heatState', reason: 'heat-or-no-heat', when: (h) => !h.has('warm') && F.heatState(h.s) == null },
    { n: 13, target: 'load-check', reason: 'overloaded-or-not-spun', when: (h) => !h.has('filterTorn') },
    { n: 14, target: 'condenser', reason: 'condenser-airflow', when: (h) => (h.has('condenser') || h.has('heatPump')) && !h.has('filterTorn') },
    { n: 15, target: 'vent-duct', reason: 'vent-airflow', when: (h) => h.has('vented') && !h.has('filterTorn') },
    { n: 16, target: 'sensor-bars', reason: 'moisture-sensing', when: (h) => !h.has('filterTorn') },
    { n: 17, target: 'programme-setting', reason: 'programme-dryness-level', when: (h) => !h.has('filterTorn') },
  ],
  PART_FAMILIES: new Set(['FL']),
  HANDOFF: { FL: 'none', LD: 'none', CN: 'none', VD: 'none', SB: 'none', PG: 'none', DS: 'engineer' },
});
const pipeline = JP.makeModelPartPipeline({
  D: { diagnose }, P, schema: 'td2/1', codeFaultFor: F.tdCodeFault,
  PART_MATCH: { 'lint-filter': { re: /(fluff|lint)\s+filter|front\s+door\s+filter|door\s+filter/i, not: /pump|washing|dishwasher|hood|cooker|water/i } },
  MEDIA_BY_KEY: { 'lint-filter': { knowledgeId: 'tumble-dryer:filter-blocked', ids: ['td-lint-filter'], concepts: [] },
    condenser: { knowledgeId: 'tumble-dryer:not-emptying-condensate', ids: ['td-condenser'], concepts: [] } },
});

// ---- COMPOSE (wording only) ----
const FAMILY_LABEL = { 'lint-filter': 'the lint filter', 'load-size-or-spin': 'the load size or how well it was spun', 'condenser-blocked': 'a clogged condenser',
  'vent-hose-restricted': 'a restricted vent hose', 'moisture-sensor-strips': 'coated moisture-sensor strips', 'programme-or-dryness-level': 'the programme or dryness level',
  'drying-airflow-system': 'the dryer\'s internal airflow (fan or ducting)' };
const COMPONENT_LABEL = { 'lint-filter': 'lint (fluff) filter' };
const TASK = {
  'ask_observation:heatState': { say: 'First, whether it\'s heating.', ask: 'Partway through a drying programme, is the air and the laundry warm, or completely cold?' },
  'ask_observation:dryerType': { say: 'The type of dryer changes what to check.', ask: 'Is it a vented dryer (a hose out of the back), a condenser dryer with a water container, or a heat-pump dryer?' },
  'ask_check:lint-filter': { say: 'Damp laundry is most often an airflow problem, and the first free check is the fluff filter in the door opening — heat-pump models often have a second filter at the bottom too.', ask: 'Was it full of fluff (and is it clean now), is the mesh torn, or was it already clean?' },
  'ask_check:load-check': { say: 'Overloading, or putting clothes in that weren\'t spun well in the washer, makes drying much slower. The drum should be no more than about two-thirds full.', ask: 'Was it overloaded or were the clothes very wet going in (and have you changed that), or was it a normal, well-spun load?' },
  'ask_check:condenser': { say: 'Behind the flap at the bottom front there\'s a condenser unit (or a second filter on heat-pump models). Take it out and rinse the fluff off under the tap, then let it drip-dry and refit it.', ask: 'Was it clogged with fluff (and is it clean now), or was it already clean?' },
  'ask_check:vent-duct': { say: 'Check the vent hose out of the back: it should be short, without kinks or squashed sections, and clear of fluff all the way to the outside vent.', ask: 'Was it kinked, squashed or blocked (and is it sorted), or was it already clear?' },
  'ask_check:sensor-bars': { say: 'Sensor dryers stop when two metal strips inside the drum (near the filter) feel the laundry is dry. Fabric conditioner can coat them so it stops too early — wipe them with a damp cloth and a little vinegar.', ask: 'Were they coated or dirty (and are they clean now), or were they already clean?' },
  'ask_check:programme-setting': { say: 'A short timed programme, "iron dry" or a low dryness level can leave laundry damp.', ask: 'Was a short or low-dryness programme set (and have you changed it), or was it a normal full drying programme?' },
  'ask_check:retest': { say: 'Run a normal drying programme with a normal load.', ask: 'Is the laundry coming out dry now, or still damp?' },
  'ask_identity:model': { say: 'To match the right part for your dryer I need its exact model.', ask: 'Could you send me the model number? It\'s on the rating plate inside the door rim or on the back — a photo is fine.' },
  'ask_identity:appliance': { say: '', ask: 'Is it a tumble dryer or a washer-dryer?' },
};
const CONCLUSION = {
  'DD7:lint-filter': 'Cleaning the filter very likely fixed it, so no part is needed — clean it after every load.',
  'DD7:load-size-or-spin': 'That was the load, so no part is needed. Keep loads to about two-thirds of the drum and spin them well first.',
  'DD7:condenser-blocked': 'Cleaning the condenser very likely fixed it, so no part is needed. Rinse it every month or so.',
  'DD7:vent-hose-restricted': 'Clearing the vent hose very likely fixed it, so no part is needed.',
  'DD7:moisture-sensor-strips': 'Cleaning the sensor strips very likely fixed it, so no part is needed.',
  'DD7:programme-or-dryness-level': 'That was the programme, so no part is needed.',
  'drying-airflow-system': 'It heats and the filters, load and settings are all fine, so the problem is the dryer\'s internal airflow (the fan or ducting) — not the heater. That needs an appliance engineer — I\'m not recommending a part from this.',
};
const compose = ck.createCompose({
  TASK, CONFIRM_ASK: 'Is it drying properly now?',
  OBS_COPY: { heatPresent: ['gets warm / hot', null], noHeat: ['no heat', 'gets warm'], longCycle: ['takes much longer', null], tankStaysEmpty: ['container stays empty', 'container fills'],
    dryerVented: ['vented', null], dryerCondenser: ['condenser', null], dryerHeatPump: ['heat pump', null], faultPersists: ['still damp', 'dry now'] },
  CHECK_RESULT_COPY: {
    'lint-filter': { clear: 'lint filter clean', found_and_cleared: 'lint filter cleaned', fault_seen: 'lint filter torn' }, 'load-check': { clear: 'normal load', found_and_cleared: 'load changed' },
    condenser: { clear: 'condenser clean', found_and_cleared: 'condenser cleaned' }, 'vent-duct': { clear: 'vent hose clear', found_and_cleared: 'vent hose cleared' },
    'sensor-bars': { clear: 'sensor strips clean', found_and_cleared: 'sensor strips cleaned' }, 'programme-setting': { clear: 'normal programme', found_and_cleared: 'programme changed' },
  },
  statusChecks: [['retest', 'retest']],
  conclusionCopy: ck.makeConclusionCopy({ FAMILY_LABEL, COMPONENT_LABEL, CONCLUSION, fitNote: 'It simply clips into the door opening — check it seats fully.' }),
  PURCHASE_RE: /\b(buy|order|purchase|price|£\s?\d)|\b(new|replacement|replace the)\s+(heater|heating element|element|filter|fan|sensor|thermostat|pcb|control board|motor|condenser)\b/i,
});
module.exports = { SPEC, FAMILY, diagnose, P, ...pipeline, FAMILY_LABEL, COMPONENT_LABEL, TASK, REQUIREMENT: ck.REQUIREMENT, SAFETY_COPY: ck.SAFETY_COPY, ...compose };
