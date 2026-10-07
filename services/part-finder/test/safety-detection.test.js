'use strict';
/**
 * Deterministic regression tests for the RAG's family-independent safety detectors
 * (part-finder-lambda.js): detectSafetyStop (gas / shock / burning) and detectUnsafeIntent.
 *
 * These guard the CUSTOMER-JOURNEY V1 safety findings:
 *   A. GAS      — a smell of gas / gas leak must be detected as an emergency ('gas').
 *   C. BURNING  — an electrical burning / hot-plastic / overheating smell must stop use
 *                 ('burning'), even for a family with no bespoke safety card (e.g. vacuum),
 *                 while ordinary cooking smells and the new-oven "burning-in" smell must NOT.
 *   B. UNSAFE-INTENT — a request to PERFORM a dangerous action (bypass a safety device, test
 *                 live, keep resetting the trip, discharge a capacitor, re-gas a sealed system,
 *                 hunt a gas leak with a flame) must be flagged so an active warning is attached.
 *
 * Pure functions, no LLM, no network — fully deterministic.
 * Run: node services/part-finder/test/safety-detection.test.js
 */
const assert = require('assert');
// The Lambda module references the `awslambda` runtime global at load time; shim it for local tests.
globalThis.awslambda = globalThis.awslambda || {
  streamifyResponse: (fn) => fn,
  HttpResponseStream: { from: (s) => s },
};
const { detectSafetyStop, classifySafetyStop, detectUnsafeIntent, isMicrowaveHvProcedureRequest, normaliseIntent, isStatusIndicationFlash, isElectricalFlashEvent, proposedPhysicalAccess, hazardProvenance } = require('../part-finder-lambda.js')._internal;
const reasonOf = (text) => { const r = classifySafetyStop(text); return r ? r.reason : null; };

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) pass++;
  else { fail++; console.log('  FAIL:', name, detail !== undefined ? `:: ${JSON.stringify(detail)}` : ''); }
}
const eq = (name, got, want) => check(name, got === want, { got, want });

// ---------------------------------------------------------------------------
// A. GAS ESCAPE  → 'gas'
// ---------------------------------------------------------------------------
eq('gas: smell of gas from hob', detectSafetyStop('I can smell gas coming from my hob'), 'gas');
eq('gas: "smells of gas"', detectSafetyStop('the oven smells of gas'), 'gas');
eq('gas: explicit gas leak', detectSafetyStop('I think there is a gas leak'), 'gas');
eq('gas: gas + odour spelling', detectSafetyStop('a gas odour near the cooker'), 'gas');
// Gas NON-triggers (must NOT be an emergency): a gas appliance fault with no smell/leak.
eq('gas non-trigger: gas oven won\'t heat', detectSafetyStop('my gas oven won\'t heat up'), null);
eq('gas non-trigger: gas hob ignition', detectSafetyStop('the gas hob clicks but won\'t light'), null);

// ---------------------------------------------------------------------------
// Electric shock  → 'shock'
// ---------------------------------------------------------------------------
eq('shock: gives me a shock', detectSafetyStop('the washing machine gives me a shock when I touch it'), 'shock');
eq('shock: electric shock phrase', detectSafetyStop('I got an electric shock off the door'), 'shock');

// ---------------------------------------------------------------------------
// A2. GAS ESCAPE by AUDIBLE cue (hissing / escaping) — ACQ-100-V1 finding HB-003.
// "gas" + an escape cue (hiss/escap) is an emergency even with no smell word yet.
// ---------------------------------------------------------------------------
eq('gas escape: HB-003 gas hissing', detectSafetyStop('my gas hob one burner won\'t light and I can hear gas hissing'), 'gas');
eq('gas escape: escaping gas', detectSafetyStop('I think there is gas escaping from the cooker'), 'gas');
eq('gas escape: gas hiss short', detectSafetyStop('there is a hissing gas sound behind the oven'), 'gas');
// Gas NON-triggers still hold (no escape cue): a gas appliance fault is NOT an emergency.
eq('gas non-trigger: gas hob won\'t light (no hiss)', detectSafetyStop('the gas hob clicks and won\'t light'), null);
eq('gas non-trigger: gas oven fan noisy', detectSafetyStop('the fan in my gas oven is noisy'), null);
// MUTATION PROOF: "hissing" WITHOUT the word gas must NOT trip the gas rule (broadening guard).
eq('gas boundary: washing machine hissing (no gas word)', detectSafetyStop('my washing machine makes a hissing noise on fill'), null);

// ---------------------------------------------------------------------------
// A3. ELECTRICITY + WATER credible contact/proximity  → 'shock' — ACQ-100-V1 finding DW-013.
// Requires ALL THREE: a water token + an electrical-supply token + a contact/proximity cue.
// ---------------------------------------------------------------------------
eq('elec+water: DW-013 water near plug socket', detectSafetyStop('my dishwasher is leaking and the water is getting near the plug socket'), 'shock');
eq('elec+water: wet plug', detectSafetyStop('the plug is wet'), 'shock');
eq('elec+water: water dripping onto the socket', detectSafetyStop('water is dripping onto the socket behind the washing machine'), 'shock');
eq('elec+water: leak running into the fuse box', detectSafetyStop('there is a leak and water is running into the fuse box'), 'shock');
eq('elec+water: damp reaching the mains', detectSafetyStop('it is damp and moisture is reaching the mains connection'), 'shock');
// Electricity+water NON-triggers (near-neighbours must stay diagnostic, NOT stop):
eq('elec+water non-trigger: water left in drum', detectSafetyStop('there is water left in the washing machine drum'), null);
eq('elec+water non-trigger: water in the sump', detectSafetyStop('the dishwasher has water sitting in the sump'), null);
eq('elec+water non-trigger: condensation inside', detectSafetyStop('there is condensation and water inside the door'), null);
eq('elec+water non-trigger: not filling', detectSafetyStop('my washing machine is not filling with water'), null);
eq('elec+water non-trigger: leaking underneath (no electrics)', detectSafetyStop('the washing machine is leaking water underneath'), null);
eq('elec+water non-trigger: won\'t drain', detectSafetyStop('the dishwasher won\'t drain and holds water'), null);
// MUTATION PROOFS of the three-token AND boundary (dropping any single token must NOT trip):
eq('elec+water boundary: water+contact but NO electrics', detectSafetyStop('water is getting near the door seal'), null);
eq('elec+water boundary: electrics+contact but NO water', detectSafetyStop('the plug is right next to the control board'), null);
eq('elec+water boundary: water+electrics but NO proximity cue', detectSafetyStop('there is a leak somewhere and it is plugged into the mains'), null);

// ---------------------------------------------------------------------------
// C. BURNING / OVERHEATING ELECTRICAL SMELL  → 'burning'
// ---------------------------------------------------------------------------
eq('burning: vacuum burning smell (card-less family)', detectSafetyStop('my vacuum has a burning smell'), 'burning');
eq('burning: hot plastic smell', detectSafetyStop('there is a hot plastic smell from the dryer'), 'burning');
eq('burning: smells electrical', detectSafetyStop('it smells electrical when running'), 'burning');
eq('burning: burning wire', detectSafetyStop('I can see a burning wire at the back'), 'burning');
eq('burning: acrid smell', detectSafetyStop('an acrid smell and some smoke from the motor'), 'burning');
// Burning NON-triggers: ordinary cooking smells and first-use burn-in are NOT electrical faults.
eq('burning non-trigger: burnt toast', detectSafetyStop('there is a smell of burnt toast'), null);
eq('burning non-trigger: burnt food', detectSafetyStop('a burning smell of food in the oven'), null);
eq('burning non-trigger: new oven burning-in', detectSafetyStop('my brand new oven has a slight burning smell the first time'), null);
// Control-state FLASHING (clock/programmer/display/LED) is not an electrical flash/spark.
eq('flashing non-trigger: clock after power cut', detectSafetyStop('The oven will not heat since the power cut last night. The clock is flashing.'), null);
eq('flashing non-trigger: programmer display', detectSafetyStop('the programmer display is flashing'), null);
eq('flashing non-trigger: dishwasher beeping', detectSafetyStop('my dishwasher stops mid cycle flashing and beeping'), null);
eq('flashing non-trigger: blue light', detectSafetyStop('the blue light is flashing'), null);
eq('flash as fire: flash from the plug still stops', detectSafetyStop('there was a flash from the plug'), 'burning');
eq('flash as fire: flashing from the socket still stops', detectSafetyStop('flashing from the socket'), 'burning');
eq('status flash: displayed token after flashes is not a fire', detectSafetyStop('the machine still flashes E15'), null);
eq('status flash: flashing F08 is not a fire', detectSafetyStop('it keeps flashing F08 on the panel'), null);
eq('status flash: replacement plus unchanged indication is not a fire', detectSafetyStop('Already replaced the door lock, still flashes DOOR.'), null);
eq('status flash: clock flashing is not observed burning provenance', hazardProvenance({ queryText: 'the clock is flashing', safetyStop: 'burning' }), 'inferred');
check('physical access proposed: isolate, not already-done', proposedPhysicalAccess("I'm going to take the door lock out and check the plug."));
check('physical access already-done: not a proposed action', !proposedPhysicalAccess('Already replaced the door lock, still flashes DOOR.'));
check('status indication helper: short displayed token', isStatusIndicationFlash('still flashes E24'));
check('electrical flash event: from the plug', isElectricalFlashEvent('there was a flash from the plug'));

// C2. TUMBLE-DRYER OVERHEATING = MAINTENANCE_SAFETY (owned by the tumble-dryer:overheating node),
//     NOT a deterministic hard stop. The detector must NOT escalate a plain hot/lint/airflow dryer
//     smell — but a GENUINE fire cue (smoke/spark/scorch/melt/electrical) must still stop, even for
//     a dryer. (Regression guard: burning-smell remediation must not break td-overheat.)
eq('td-overheat maintenance: dryer hot + burning smell -> NOT a hard stop', detectSafetyStop('my tumble dryer gets really hot and smells like burning'), null);
eq('td-overheat maintenance: lint/airflow overheating -> NOT a hard stop', detectSafetyStop('my tumble dryer is overheating, i think the lint filter and vent are blocked'), null);
eq('td-overheat maintenance: dryer smells of burning (airflow) -> NOT a hard stop', detectSafetyStop('the dryer smells of burning when it gets hot'), null);
eq('td ambiguous: dryer gets very hot (no smell) -> not a burning stop', detectSafetyStop('my tumble dryer gets very hot'), null);
// Genuine fire cues STILL stop, dryer or not:
eq('td genuine fire: dryer smoking -> stop', detectSafetyStop('my tumble dryer is smoking'), 'burning');
eq('td genuine fire: dryer scorch marks -> stop', detectSafetyStop('there are scorch marks on my tumble dryer'), 'burning');
eq('td genuine fire: dryer electrical burning -> stop', detectSafetyStop('my tumble dryer has an electrical burning smell'), 'burning');
eq('td genuine fire: dryer burning + smoke -> stop', detectSafetyStop('burning smell and smoke coming from the tumble dryer'), 'burning');
// Other families keep the burning stop (no overheating-maintenance node): a WM burning smell = electrical.
eq('melted belt is mechanical not a fire stop', detectSafetyStop('the drive belt looks melted'), null);
eq('melting wiring still stops', detectSafetyStop('the wiring is melting by the plug'), 'burning');

// Nothing safety-relevant.
eq('no safety: plain drain fault', detectSafetyStop('the dishwasher won\'t drain'), null);
eq('no safety: empty', detectSafetyStop(''), null);

// ---------------------------------------------------------------------------
// A4. FINE-GRAINED REASON (metric.safetyStopReason) — category stays in the proven
// escalating set, reason records the specific hazard for observability.
// ---------------------------------------------------------------------------
eq('reason: gas smell -> gas-smell', reasonOf('I can smell gas from the hob'), 'gas-smell');
eq('reason: gas hissing -> gas-escape', reasonOf('I can hear gas hissing behind the cooker'), 'gas-escape');
eq('reason: electric shock -> electric-shock', reasonOf('it gives me a shock'), 'electric-shock');
eq('reason: water near socket -> electrical-water', reasonOf('water is getting near the plug socket'), 'electrical-water');
eq('reason: burning smell -> burning', reasonOf('my vacuum has a burning smell'), 'burning');
eq('reason: nothing -> null', reasonOf('the dishwasher won\'t drain'), null);

// ---------------------------------------------------------------------------
// B. UNSAFE INTENT  → true
// ---------------------------------------------------------------------------
check('unsafe: bypass the door interlock', detectUnsafeIntent('how do I bypass the door interlock so it spins with the door open'));
check('unsafe: test element while live', detectUnsafeIntent('can I test the element while it is live with my multimeter'));
check('unsafe: keep resetting the RCD', detectUnsafeIntent('should I just keep resetting the rcd every time it trips'));
check('unsafe: discharge the capacitor', detectUnsafeIntent('how do I discharge the capacitor in the microwave'));
check('unsafe: re-gas the fridge', detectUnsafeIntent('can I regas the fridge myself at home'));
check('unsafe: find gas leak with a lighter', detectUnsafeIntent('should I find the gas leak with a lighter'));
check('unsafe: megger / insulation test', detectUnsafeIntent('how do I megger the grill element for an earth leak'));
check('unsafe: insulation-resistance test', detectUnsafeIntent('can I do an insulation resistance test on the oven element'));

// UNSAFE-INTENT NON-triggers: REPORTING a hazard / a normal fault is NOT a request to do something unsafe.
check('unsafe non-trigger: interlock broken (reporting)', !detectUnsafeIntent('my door interlock is broken and the machine won\'t start'));
check('unsafe non-trigger: RCD trips (reporting)', !detectUnsafeIntent('the rcd trips as soon as I switch the washer on'));
check('unsafe non-trigger: element not heating', !detectUnsafeIntent('the heating element isn\'t getting hot'));
check('unsafe non-trigger: fridge not cold', !detectUnsafeIntent('my fridge is not getting cold anymore'));

// ---------------------------------------------------------------------------
// D. NORMAL-BEHAVIOUR flag wiring — normaliseIntent MUST carry `normalBehaviour` through.
// (Regression: the field was added to the schema + prompt but dropped by normaliseIntent, so the
//  deterministic part-suppression never fired. Same class of bug as the faultId field-slip.)
// ---------------------------------------------------------------------------
check('normaliseIntent carries normalBehaviour=true', normaliseIntent({ normalBehaviour: true }).normalBehaviour === true);
check('normaliseIntent defaults normalBehaviour=false', normaliseIntent({}).normalBehaviour === false);
check('normaliseIntent coerces non-true to false', normaliseIntent({ normalBehaviour: 'yes' }).normalBehaviour === false);

// ---------------------------------------------------------------------------
// E. IGNITION "no spark" is NOT a fire hazard (spark fire-cue false-positive fix).
// A gas appliance that WON'T spark / has NO spark is an IGNITION FAULT (spark electrode / module /
// FSD), not a fire. The burning/arcing stop must NOT fire on absence-of-ignition wording — but an
// OBSERVED spark/arc ("sparking", "keeps sparking", "sparked") must STILL stop (fire hazard).
// ---------------------------------------------------------------------------
eq('ignition: gas hob "wont spark" -> no stop', classifySafetyStop('my gas hob wont spark'), null);
eq('ignition: gas oven "no spark" -> no stop', classifySafetyStop('my gas oven has no spark'), null);
eq('ignition: "not sparking" -> no stop', classifySafetyStop('the gas hob is not sparking'), null);
eq('ignition: "needs a spark" -> no stop', classifySafetyStop('the ignition needs a spark but nothing happens'), null);
eq('ignition: "no longer sparks" -> no stop', classifySafetyStop('it no longer sparks when I turn the knob'), null);
eq('ignition: "wont light" unaffected -> no stop', classifySafetyStop('gas oven wont light'), null);
eq('ignition: "flame failure" unaffected -> no stop', classifySafetyStop('gas oven flame failure'), null);
eq('spark observed: microwave sparking -> arcing tier', (classifySafetyStop('my microwave is sparking inside') || {}).category, 'arcing');
eq('spark observed: sparks inside microwave -> arcing', (classifySafetyStop('there are sparks coming from inside the microwave') || {}).category, 'arcing');
eq('spark observed: oven sparked + burnt -> burning', (classifySafetyStop('the oven sparked and now smells burnt') || {}).category, 'burning');
eq('spark observed: sparks at the socket -> burning', (classifySafetyStop('sparks flying out of the plug socket') || {}).category, 'burning');
eq('spark observed: "wont stop sparking" (no ignition context) -> burning', (classifySafetyStop('it wont stop sparking') || {}).category, 'burning');
eq('ignition sparking: gas hob uncommanded sparking is NOT a burning stop', classifySafetyStop('my gas hob has started sparking on its own on the front left'), null);
eq('ignition sparking: hob keeps sparking (no fire cue) is NOT a burning stop', classifySafetyStop('the hob keeps sparking and arcing'), null);
eq('ignition sparking: gas hob sparking + burning smell STILL stops', (classifySafetyStop('the hob is sparking and smells of burning plastic') || {}).category, 'burning');
eq('burning smell still stops', (classifySafetyStop('I can smell burning plastic from the oven') || {}).category, 'burning');

eq('electrical trip: electrics trip during wash', (classifySafetyStop('The electrics trip part way through the wash.') || {}).category, 'electrical');
eq('electrical trip: RCD trips halfway', (classifySafetyStop('RCD trips halfway through the wash cycle') || {}).category, 'electrical');
eq('electrical trip: knocks the electrics out', (classifySafetyStop('it knocks the electrics out part way through a wash') || {}).category, 'electrical');
eq('electrical trip: thermal fuse is not a household trip', classifySafetyStop('thermal fuse replaced twice, keeps blowing'), null);
eq('electrical trip: scraping is not a trip', classifySafetyStop('there is a scraping noise from the back'), null);
eq('electrical trip: shock plus RCD still shock', (classifySafetyStop('it trips the RCD and I had a shock from the door') || {}).category, 'shock');
check('hv procedure: magnetron test is unsafe intent', detectUnsafeIntent('Talk me through testing the magnetron') === true);
check('hv procedure: HV capacitor test is flagged', isMicrowaveHvProcedureRequest('microwave not heating, how do I test the HV capacitor') === true);
check('hv procedure: magnetron without microwave word still halts', isMicrowaveHvProcedureRequest('Talk me through testing the magnetron') === true);
check('hv procedure: plain not-heating is not an HV halt', isMicrowaveHvProcedureRequest('my microwave runs but doesnt heat') === false);

console.log(`\nsafety-detection: ${pass} passed / ${fail} failed`);
process.exit(fail ? 1 : 0);
