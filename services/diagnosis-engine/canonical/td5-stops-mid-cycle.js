'use strict';
/**
 * Tumble dryer journey 5 — stops mid-cycle / cuts out (rules DS1–DS22). PURE, deterministic.
 * Design: docs/diagnostics/ff-td-batch-evidence.md §TD5. A container-full / empty-tank warning → td-water-container-drain
 * (once). Restarts after cooling + restricted airflow is strong thermal / airflow evidence — never a jump to the motor:
 *   restarts after cooling? → lint filter → condenser (condenser / heat pump) or vent hose (vented) → load → sensor strips →
 *   thermal protection / thermostat (restarts, airflow clear; engineer) · control / power (never restarts; engineer).
 * A trip of the house electrics or a burning smell is a sticky safety stop.
 */
const engine = require('./evidence-engine.js');
const kit = require('./policy-kit.js');
const JP = require('./journey-pipeline.js');
const F = require('./td-family.js');
const ck = require('./compose-kit.js');
const { SS, S, A, SA } = engine;

const KEY = 'td-stops-mid-cycle';
const FAMILY = { AF: 'airflow-overheating', LD: 'load-size', SN: 'sensor-ends-early', TH: 'thermal-protection-or-thermostat', CT: 'control-or-power' };
const SIGNALS = {
  AF: { filterFixed: SS, condFixed: SS, ventFixed: SS, restoredAfterFilterFix: SS, restoredAfterCondFix: SS, restoredAfterVentFix: SS, restarts: S, overheats: S, codeOverheat: S,
    failsAfterFilterFix: A, failsAfterCondFix: A, failsAfterVentFix: A },
  LD: { loadFixed: SS, restoredAfterLoadFix: SS, failsAfterLoadFix: SA, loadOk: SA },
  SN: { sensorFixed: SS, restoredAfterSensorFix: SS, failsAfterSensorFix: SA, sensorOk: SA, noRestart: S },
  TH: { restarts: S, overheats: S, codeOverheat: S, filterOk: S, condOk: S, ventOk: S, noRestart: SA, restoredAfterFilterFix: SA, restoredAfterCondFix: SA, restoredAfterVentFix: SA, restoredAfterLoadFix: SA, restoredAfterSensorFix: SA },
  CT: { noRestart: S, filterOk: S, sensorOk: S, loadOk: S, restarts: SA, restoredAfterFilterFix: SA, restoredAfterCondFix: SA, restoredAfterVentFix: SA, restoredAfterLoadFix: SA, restoredAfterSensorFix: SA },
};
const FACT_LABEL = { restarts: 'restarts after cooling', noRestart: 'doesn\'t restart after cooling', overheats: 'gets very hot then stops', codeOverheat: 'overheating error code',
  filterFixed: 'lint filter blocked (cleaned)', filterOk: 'lint filter clean', condFixed: 'condenser clogged (cleaned)', condOk: 'condenser clean', ventFixed: 'vent hose blocked (cleared)',
  ventOk: 'vent hose clear', loadFixed: 'load too small / too big (changed)', loadOk: 'normal load', sensorFixed: 'sensor strips coated (cleaned)', sensorOk: 'sensor strips clean',
  vented: 'vented dryer', condenser: 'condenser dryer', heatPump: 'heat-pump dryer' };
const SPEC = {
  schema: 'td5-diag/1', FAMILY, PRIOR: ['AF', 'LD', 'SN', 'TH', 'CT'], SIGNALS, FACT_LABEL,
  obs: { restarts: ['restartsAfterCooling', true], noRestart: ['restartsAfterCooling', false], overheats: ['overheatsThenCuts', true] },
  checks: { 'lint-filter': { clear: 'filterOk', found: 'filterFixed' }, condenser: { clear: 'condOk', found: 'condFixed' }, 'vent-duct': { clear: 'ventOk', found: 'ventFixed' },
    'load-check': { clear: 'loadOk', found: 'loadFixed' }, 'sensor-bars': { clear: 'sensorOk', found: 'sensorFixed' } },
  FIX_CHECK: { AF: ['lint-filter', 'Filter'], AFc: ['condenser', 'Cond'], AFv: ['vent-duct', 'Vent'], LD: ['load-check', 'Load'], SN: ['sensor-bars', 'Sensor'] },
  DECISIVE_PART: {},
  architecture: (s, ctx) => F.tdArchitecture(s, ctx),
  extra(s, ctx, on) { F.archFacts(on, ctx.architecture); on('codeOverheat', ctx.codeFault === 'overheating'); },
};
function diagnose(state, ctx = {}) {
  const codeFault = ctx.codeFault !== undefined ? ctx.codeFault : F.tdCodeFault(state, ctx.errorCodes || null);
  return engine.diagnoseSpec(SPEC, state, { ...ctx, codeFault });
}
const archKnown = (h) => h.has('vented') || h.has('condenser') || h.has('heatPump');
const P = kit.makeStepPolicy({
  JOURNEY: KEY, P: 'DS', appliance: 'tumble-dryer', journeys: ['cuts-out', 'cycle-not-completing', 'overheating'], ...F.owns(KEY), declineUnsafe: F.UNSAFE,
  CHECKS: ['lint-filter', 'condenser', 'vent-duct', 'load-check', 'sensor-bars'],
  OBS_TARGETS: { restartsAfterCooling: ['restartsAfterCooling'], dryerType: ['dryerVented', 'dryerCondenser', 'dryerHeatPump'] },
  REQUIRES: { restartsAfterCooling: ['stop_if_trips_or_burning'], dryerType: [], 'lint-filter': ['td_unplug_cool'], condenser: ['td_unplug_cool'], 'vent-duct': ['td_unplug_cool'],
    'load-check': [], 'sensor-bars': ['td_unplug_cool'], retest: ['stop_if_trips_or_burning'] },
  FIX_CHECKS: ['lint-filter', 'condenser', 'vent-duct', 'load-check', 'sensor-bars'],
  steps: [
    { n: 10, target: 'restartsAfterCooling', reason: 'thermal-pattern', when: (h) => !h.has('restarts') && !h.has('noRestart') },
    { n: 11, target: 'dryerType', reason: 'technology-decides-airflow', when: (h) => !archKnown(h) },
    { n: 12, target: 'lint-filter', reason: 'lint-filter-airflow', when: () => true },
    { n: 13, target: 'condenser', reason: 'condenser-airflow', when: (h) => h.has('condenser') || h.has('heatPump') },
    { n: 14, target: 'vent-duct', reason: 'vent-airflow', when: (h) => h.has('vented') },
    { n: 15, target: 'load-check', reason: 'load-size', when: () => true },
    { n: 16, target: 'sensor-bars', reason: 'sensor-ends-early', when: (h) => !h.has('restarts') && !h.has('overheats') },
  ],
  PART_FAMILIES: new Set(),
  HANDOFF: { AF: 'none', LD: 'none', SN: 'none', TH: 'engineer', CT: 'engineer' },
});
const pipeline = JP.makeModelPartPipeline({
  D: { diagnose }, P, schema: 'td5/1', codeFaultFor: F.tdCodeFault, PART_MATCH: {},
  MEDIA_BY_KEY: { 'lint-filter': { knowledgeId: 'tumble-dryer:filter-blocked', ids: ['td-lint-filter'], concepts: [] },
    condenser: { knowledgeId: 'tumble-dryer:not-emptying-condensate', ids: ['td-condenser'], concepts: [] } },
});

// ---- COMPOSE (wording only) ----
const FAMILY_LABEL = { 'airflow-overheating': 'blocked airflow making it overheat and cut out', 'load-size': 'the load size', 'sensor-ends-early': 'the moisture sensor ending the programme early',
  'thermal-protection-or-thermostat': 'the overheat protection or thermostat', 'control-or-power': 'the control or power side' };
const TASK = {
  'ask_observation:restartsAfterCooling': { say: 'When it stops, the pattern helps.', ask: 'If you leave it to cool down for a while, will it start again and carry on, or not at all?' },
  'ask_observation:dryerType': { say: 'The type of dryer changes what to check.', ask: 'Is it a vented dryer (a hose out of the back), a condenser dryer with a water container, or a heat-pump dryer?' },
  'ask_check:lint-filter': { say: 'A blocked filter makes the dryer overheat, and it then cuts out to protect itself. Clean the fluff filter in the door opening (heat-pump models often have a second filter at the bottom).', ask: 'Was it full of fluff (and is it clean now), or was it already clean?' },
  'ask_check:condenser': { say: 'Behind the flap at the bottom front there\'s a condenser unit (or a second filter on heat-pump models). Take it out and rinse the fluff off under the tap, then let it drip-dry and refit it.', ask: 'Was it clogged with fluff (and is it clean now), or was it already clean?' },
  'ask_check:vent-duct': { say: 'Check the vent hose out of the back: it should be short, without kinks or squashed sections, and clear of fluff all the way to the outside vent.', ask: 'Was it kinked, squashed or blocked (and is it sorted), or was it already clear?' },
  'ask_check:load-check': { say: 'A very small load (or one item) can make a sensor dryer finish early, and an overloaded drum can make it overheat.', ask: 'Was the load very small or overloaded (and have you changed it), or was it a normal load?' },
  'ask_check:sensor-bars': { say: 'Sensor dryers stop when two metal strips inside the drum (near the filter) feel the laundry is dry. Fabric conditioner can coat them — wipe them with a damp cloth and a little vinegar.', ask: 'Were they coated or dirty (and are they clean now), or were they already clean?' },
  'ask_check:retest': { say: 'Run a normal drying programme and stay nearby.', ask: 'Does it run right through now, or still stop part way?' },
  'ask_identity:appliance': { say: '', ask: 'Is it a tumble dryer or a washer-dryer?' },
};
const CONCLUSION = {
  'DS7:airflow-overheating': 'Clearing the airflow very likely fixed it — fluff makes it overheat and cut out to protect itself. No part is needed; clean the filter after every load.',
  'DS7:load-size': 'That was the load, so no part is needed.',
  'DS7:sensor-ends-early': 'Cleaning the sensor strips very likely fixed it, so no part is needed.',
  'airflow-overheating': 'Overheating from restricted airflow is the likely cause. Keep the filters and hose clear; if it still cuts out, an appliance engineer should check the overheat protection — I\'m not recommending a part from this.',
  'thermal-protection-or-thermostat': 'It restarts after cooling with the airflow clear, so its overheat protection or thermostat is cutting in — the motor isn\'t indicated by this. That needs an appliance engineer to test safely — I\'m not recommending a part from this.',
  'control-or-power': 'With the airflow, load and sensors fine and it not restarting, the control or power side is the likely area. That needs an appliance engineer — I\'m not recommending a part from this.',
};
const compose = ck.createCompose({
  TASK, CONFIRM_ASK: 'Is it running right through now?',
  OBS_COPY: { restartsAfterCooling: ['restarts after cooling', 'doesn\'t restart'], overheatsThenCuts: ['gets very hot then stops', null], dryerVented: ['a vented-type dryer', null], dryerCondenser: ['a condenser-type dryer', null],
    dryerHeatPump: ['a heat-pump-type dryer', null], faultPersists: ['still stops', 'runs right through'] },
  CHECK_RESULT_COPY: { 'lint-filter': { clear: 'lint filter clean', found_and_cleared: 'lint filter cleaned' }, condenser: { clear: 'condenser clean', found_and_cleared: 'condenser cleaned' },
    'vent-duct': { clear: 'vent hose clear', found_and_cleared: 'vent hose cleared' }, 'load-check': { clear: 'normal load', found_and_cleared: 'load changed' },
    'sensor-bars': { clear: 'sensor strips clean', found_and_cleared: 'sensor strips cleaned' } },
  statusChecks: [['retest', 'retest']],
  conclusionCopy: ck.makeConclusionCopy({ FAMILY_LABEL, COMPONENT_LABEL: {}, CONCLUSION }),
  PURCHASE_RE: /\b(buy|order|purchase|price|£\s?\d)|\b(new|replacement|replace the)\s+(thermostat|cut-out|toc|thermal fuse|sensor|motor|capacitor|pcb|control board|heater|element)\b/i,
});
module.exports = { SPEC, FAMILY, diagnose, P, ...pipeline, FAMILY_LABEL, COMPONENT_LABEL: {}, TASK, REQUIREMENT: ck.REQUIREMENT, SAFETY_COPY: ck.SAFETY_COPY, ...compose };
