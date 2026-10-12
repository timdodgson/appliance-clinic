'use strict';
/**
 * mc/1 — the canonical per-message classification: its fixed shape, controlled vocabularies and validator. PURE.
 *
 * A classification says what the LATEST customer message itself states (identity, problem, safety, observations,
 * checks, reply to the pending request). It is produced by the message-only Jev question set
 * (mc1-questions.js buildMc1Request / adaptMc1Answers, called by ../jev-mc1.js) and consumed ONLY by the cs/1 merge
 * (merge.js). Nothing downstream of mc/1 reads customer prose.
 * Design: services/whichpart-api/docs/canonical-architecture.md (§3 mc/1).
 */

const SCHEMA_VERSION = 'mc/1';

// ---- controlled values (canonical §8) ----------------------------------------------------------
const SCOPES = ['appliance', 'unrelated', 'prompt_attack', 'unclear'];
// Canonical message value for the hob family is `hob` (canonical §8.1; Q5 open — catalogue key `hobs`).
const APPLIANCES = ['washing-machine', 'washer-dryer', 'tumble-dryer', 'dishwasher', 'fridge-freezer',
  'oven-cooker', 'hob', 'microwave', 'vacuum'];
const BASES = ['stated', 'inferred', 'read_from_image'];
const MODEL_STATUSES = ['unavailable', 'will_look'];
const FUELS = ['gas', 'electric', 'dual'];
const INTENTS = ['report_fault', 'is_it_normal', 'interpret_code', 'buy_part', 'price_or_availability',
  'fitting_help', 'other_appliance_question'];
const FAULT_DOMAINS = ['water', 'heat', 'cooling', 'drying', 'motion', 'airflow', 'power', 'controls',
  'door', 'noise', 'results', 'ignition'];
const JOURNEYS = ['not-draining', 'not-filling', 'leaking', 'not-spinning', 'drum-not-turning', 'no-heat',
  'overheating', 'not-drying', 'not-cooling', 'over-cooling', 'ice-build-up', 'wont-start', 'cuts-out',
  'pulsing', 'lost-suction', 'brush-bar-not-spinning', 'trips-electrics', 'noisy', 'door-problem',
  'controls-unresponsive', 'cycle-not-completing', 'poor-results', 'odour', 'wont-light',
  'turntable-not-turning', 'sparking', 'error-code-only',
  // batch 2 (washing machine): overfilling (keeps taking water / too high) and excessive vibration while it spins.
  'overfilling', 'vibration',
  // final pass: a cordless vacuum battery / charging problem
  'battery-problem'];
// A vacuum model-range token (Dyson V6 / V8 / V11 / SV10 / DC35) is never an error code: vacuums here have no fault-code
// tables, so the token is identity (a model range) and must not route the conversation to error-code-only.
const VACUUM_MODEL_TOKEN = /^(V\d{1,2}|SV\d{1,2}|DC\d{2})$/i;
const SYMPTOM_SCOPES = ['dry_only', 'wash_only', 'fan_oven_only', 'grill_only', 'top_oven_only', 'one_zone',
  'fridge_only', 'freezer_only', 'one_programme'];
const RELATIONS = ['same', 'additional', 'different'];
const HAZARDS = ['gas_escape', 'gas_smell', 'electric_shock', 'electrical_water', 'supply_trip', 'burning',
  'smoke', 'microwave_arcing', 'sparks_at_supply', 'exposed_live_wiring'];
const UNSAFE_ACTIONS = ['bypass_safety_device', 'live_electrical_test', 'repeated_reset_after_trip',
  'hv_microwave_work', 'refrigerant_work', 'gas_work', 'open_while_powered'];
const OBSERVATION_KEYS = [
  'waterEntering', 'waterRemaining', 'commandedDrain', 'drainsNormally', 'pumpHumming', 'excessiveFoam',
  'waterReturnsAfterDrain',
  'leakAtDoor', 'leakAtDrawer', 'leakAtRear', 'leakUnderneath', 'leaksOnFill', 'leaksOnDrain',
  'drumTurns', 'drumTurnsByHand', 'loadDependent', 'spinsSlowly',
  // Journey 2 (washing machine · not spinning)
  'spinsEmpty', 'commandedSpin', 'intermittentSpin', 'jerkyAcceleration', 'repeatedRedistribution',
  'excessiveVibration', 'doorLocks', 'motorAudible', 'drumUnusuallyFree',
  // Journey 3 (washing machine · leaking)
  'leakAtFilter', 'leaksOnWash', 'leaksWhenOff', 'majorLeak', 'drawerOverflowing', 'recentFilterAccess',
  'recentInstallation', 'leakRecurs',
  // batch 2 (washing machine): fill, overfill, door, vibration, noise, heating; faultPersists = the shared retest outcome
  'fillsSlowly', 'supplyOk', 'fillsWhenOff', 'waterLevelHigh', 'waterIsDirty',
  'doorOpens', 'doorCloses', 'handleBroken', 'lockClicking',
  'shakesWhenEmpty', 'drumPlay',
  'scrapingNoise', 'knockingNoise', 'rattlingNoise', 'squealNoise', 'clickingNoise', 'noiseOnFill',
  'longCycle', 'hotProgrammeUsed', 'faultPersists',
  // dishwasher family: anti-flood / base tray, continuous pumping, wrong detergent, rack location, tablet, drying, door start
  'waterInBase', 'pumpRunsContinuously', 'wrongDetergent', 'poorUpperRack', 'poorLowerRack', 'poorAllRacks', 'tabletUndissolved',
  'dishesWet', 'onlyPlasticsWet', 'doorRecognised', 'startsWhenPushed',
  'noHeat', 'heatPresent', 'overheatsThenCuts', 'slowToHeat', 'fanSpinning',
  'grindingNoise', 'humNoise', 'noiseOnSpin', 'noiseOnWash', 'noiseOnDrain', 'noiseThroughout',
  'noPower', 'cutsOut', 'cutsOutAfterSeconds', 'cutsOutAfterMinutes', 'weakSuction', 'brushNotSpinning',
  'bothCompartmentsWarm', 'heavyIce', 'fanAudible', 'ventsBlocked', 'doorNotSeating',
  'inductionHob', 'ceramicHob', 'gasHob', 'failsKnownGoodPan', 'worksWithKnownGoodPan',
  'runsNormally', 'doorStartProblem', 'clockFlashing',
  // fridge / freezer family: noise source and door effect, compressor state, leak location, door left open, frost location / recurrence, room
  'noiseStopsWhenDoorOpen', 'noiseFromInside', 'gurglingNoise', 'runsConstantly', 'clicksNoStart', 'compressorRuns',
  'waterInsideFridge', 'leakFromSupplyLine', 'doorLeftOpen', 'iceReturns', 'frostOnBackWall', 'frostNearDoor', 'iceInBase', 'inColdOrHotLocation',
  // tumble dryer family: technology, restarts after cooling, water container state, drain kit
  'dryerVented', 'dryerCondenser', 'dryerHeatPump', 'restartsAfterCooling', 'tankStaysEmpty', 'tankWarning', 'drainKitFitted',
  // oven / cooker
  'ovenFanTurns', 'grillWorks', 'mainOvenWorks', 'heatsSlowly', 'tooHot', 'tripsImmediately', 'recentCleaning', 'doorGlassCracked', 'fanRunsAfterOff',
  // gas ignition (cooker / hob)
  'sparkClicks', 'flameGoesOut', 'oneBurnerOnly',
  // hob
  'solidPlateHob', 'panSymbolFlashing', 'stuckOnHigh',
  // microwave
  'startsWhenDoorCloses', 'turntableTurns', 'metalInside', 'waveguideCoverDamaged', 'cavityBurnt',
  // vacuum
  'vacuumCordless', 'vacuumCorded', 'vacuumRobot', 'shortRuntime', 'wontCharge', 'whistleNoise',
  // washer-dryer: the problem is on the drying side (true) / the washing side (false)
  'wdDrySide',
];
const CHECK_KEYS = ['drain-filter', 'drain-hose', 'pump-impeller', 'inlet-hose-tap', 'lint-filter', 'condenser',
  'vent-duct', 'water-container', 'vacuum-bin-filters', 'vacuum-blockage', 'brush-bar-clear',
  'door-closed-latched', 'power-supply', 'reset-power-cycle', 'programme-setting', 'child-lock',
  'drain-command', 'defrost', 'spray-arms', 'dishwasher-filter', 'pan-test', 'drum-by-hand',
  // Journey 2: load-check / empty-spin-test / spin-command are owner checks; drive-belt and carbon-brushes are
  // only ever REPORTED (never asked: they need a panel off).
  'load-check', 'empty-spin-test', 'spin-command', 'drive-belt', 'carbon-brushes',
  // Journey 3: owner leak checks (machine off / isolated) and the leak retest.
  'door-seal', 'detergent-drawer', 'detergent-dose', 'filter-seal', 'inlet-connection', 'drain-connection', 'leak-retest',
  // batch 2 (washing machine) owner checks / functional tests; shock-absorbers is only ever REPORTED; retest is shared.
  'inlet-filter', 'power-off-fill-test', 'drain-hose-height', 'door-release-wait', 'door-catch', 'transit-bolts', 'levelling',
  'empty-vibration-test', 'drum-play', 'shock-absorbers', 'drum-foreign-object', 'hot-wash-test', 'retest',
  // dishwasher family owner checks / tests (shared generic keys are reused with their existing semantics)
  'waste-spigot', 'loading-clearance', 'dw-dispenser', 'rinse-aid', 'door-start-test',
  // fridge / freezer owner checks; tumble dryer moisture-sensor strips
  'temp-setting', 'vents-clear', 'condenser-coil-clear', 'defrost-drain', 'ff-door-fit', 'ff-clearance', 'drip-tray', 'sensor-bars',
  // final pass: oven, gas burner, microwave, vacuum, washer-dryer owner checks
  'oven-clock-mode', 'oven-door-fit', 'burner-parts-clean', 'mw-door-check', 'turntable-parts', 'mw-cavity-check',
  'vacuum-charger-check', 'wd-dry-capacity'];
const CHECK_STATUSES = ['done', 'not_done', 'declined', 'unable'];
// found_unspecified rides on a not_done check: they looked and found something, but have not cleared it yet
const CHECK_RESULTS = ['clear', 'found_and_cleared', 'found_not_cleared', 'fault_seen', 'found_unspecified'];
const TO_PENDING = ['answered', 'partial', 'cannot_answer', 'declined', 'ignored'];
const OUTCOMES = ['resolved', 'temporary', 'unresolved'];

// ---- shape -------------------------------------------------------------------------------------
function emptyClassification(messageId) {
  return {
    schemaVersion: SCHEMA_VERSION,
    messageId: messageId == null ? null : String(messageId),
    scope: 'unclear',
    identity: {
      appliance: { value: null, basis: null },
      make: { value: null, basis: null },
      model: { value: null, basis: null },
      modelStatus: null,
      fuel: null,
      displayedCode: null,
    },
    intent: null,
    problem: { faultDomain: null, journey: null, scope: null, relation: null },
    safety: { hazard: null, unsafeAction: null },
    observations: [],
    checks: [],
    reply: { toPending: null, correction: [], outcome: null },
    mentions: { replacedParts: [], customerTheories: [] },
  };
}

const inSet = (v, list) => (typeof v === 'string' && list.includes(v) ? v : null);
const nonEmptyString = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);

/** Enforce the fixed mc/1 shape and controlled values. Any invalid leaf becomes null/empty. */
function validateClassification(c) {
  const src = c && typeof c === 'object' ? c : {};
  const out = emptyClassification(src.messageId);
  out.scope = inSet(src.scope, SCOPES) || 'unclear';
  const id = src.identity || {};
  const pair = (p, values, bases) => {
    const value = values ? inSet(p && p.value, values) : nonEmptyString(p && p.value);
    return { value, basis: value ? inSet(p && p.basis, bases) : null };
  };
  out.identity.appliance = pair(id.appliance, APPLIANCES, ['stated', 'inferred']);
  out.identity.make = pair(id.make, null, ['stated', 'inferred']);
  out.identity.model = pair(id.model, null, ['stated', 'read_from_image']);
  out.identity.modelStatus = inSet(id.modelStatus, MODEL_STATUSES);
  out.identity.fuel = inSet(id.fuel, FUELS);
  out.identity.displayedCode = nonEmptyString(id.displayedCode);
  out.intent = inSet(src.intent, INTENTS);
  const pr = src.problem || {};
  out.problem = {
    faultDomain: inSet(pr.faultDomain, FAULT_DOMAINS),
    journey: inSet(pr.journey, JOURNEYS),
    scope: inSet(pr.scope, SYMPTOM_SCOPES),
    relation: inSet(pr.relation, RELATIONS),
  };
  const sf = src.safety || {};
  out.safety = { hazard: inSet(sf.hazard, HAZARDS), unsafeAction: inSet(sf.unsafeAction, UNSAFE_ACTIONS) };
  const seen = new Set();
  out.observations = (Array.isArray(src.observations) ? src.observations : [])
    .filter((o) => o && OBSERVATION_KEYS.includes(o.key) && typeof o.value === 'boolean')
    .filter((o) => (seen.has(o.key) ? false : (seen.add(o.key), true)))
    .map((o) => ({ key: o.key, value: o.value }));
  out.checks = (Array.isArray(src.checks) ? src.checks : [])
    .filter((k) => k && CHECK_KEYS.includes(k.check) && CHECK_STATUSES.includes(k.status))
    .map((k) => ({ check: k.check, status: k.status, result: inSet(k.result, CHECK_RESULTS) }));
  const rp = src.reply || {};
  out.reply = {
    toPending: inSet(rp.toPending, TO_PENDING),
    correction: (Array.isArray(rp.correction) ? rp.correction : []).filter((x) => nonEmptyString(x)),
    outcome: inSet(rp.outcome, OUTCOMES),
  };
  const mn = src.mentions || {};
  out.mentions = {
    replacedParts: (Array.isArray(mn.replacedParts) ? mn.replacedParts : []).filter((x) => nonEmptyString(x)),
    customerTheories: (Array.isArray(mn.customerTheories) ? mn.customerTheories : []).filter((x) => nonEmptyString(x)),
  };
  return out;
}

module.exports = {
  VACUUM_MODEL_TOKEN,
  SCHEMA_VERSION,
  APPLIANCES, JOURNEYS, HAZARDS, OBSERVATION_KEYS, CHECK_KEYS, INTENTS,
  emptyClassification,
  validateClassification,
};
