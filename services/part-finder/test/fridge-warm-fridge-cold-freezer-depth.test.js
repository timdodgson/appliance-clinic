/**
 * FRIDGE-FREEZER WARM-FRIDGE / COLD-FREEZER DIAGNOSTIC DEPTH.
 *
 * "Fridge warm, freezer still cold" must not commit prematurely between materially different causes:
 * evaporator-fan (fan silent, coils clear), defrost-system (heavy ice on the rear evaporator panel),
 * air-damper, blocked-vents/overpacking (no part), vs a whole-appliance cooling fault (both warm ->
 * compressor/not-cooling). This adds compartment / ice / fan / vent OBSERVATION facts + signals and
 * reuses the material-ambiguity gate to ask the highest-value SAFE discriminator (heavy ice on the
 * back panel) before committing. Observations are never components; "I think the fan has gone" is a
 * hypothesis. Light/normal frost is not heavyIce. FF error-code authority (22E/22C) is untouched.
 *
 * Run: node services/part-finder/test/fridge-warm-fridge-cold-freezer-depth.test.js
 */
globalThis.awslambda = globalThis.awslambda || { streamifyResponse: (fn) => fn, HttpResponseStream: { from: (s) => s } };
const fs = require('fs');
const path = require('path');
const {
  commitFromEvidence, materialAmbiguity, factConflict, scoreNodeEvidence,
  classifySafetyStop, resolveFault, buildComposeSystem,
} = require('../part-finder-lambda.js')._internal;
const CAT = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'faults-catalogue.json'), 'utf8'));

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; } else { fail++; console.log('  FAIL:', name, detail !== undefined ? `:: ${JSON.stringify(detail)}` : ''); }
}
const node = (id) => CAT.faults['fridge-freezer'][id];
const facts = (obj) => Object.entries(obj).map(([name, value]) => ({ name, value }));
const commit = (obj) => { const r = commitFromEvidence({ facts: facts(obj) }, 'fridge-freezer'); return r ? r.faultId : null; };
const amb = (id, obj) => materialAmbiguity(id, node(id), facts(obj), 'fridge-freezer');
const ss = (t) => { const r = classifySafetyStop(t, 'fridge-freezer'); return r ? r.category : null; };

// ============================================================================
// C. EVIDENCE COMMIT — observations route to materially-different nodes
// ============================================================================
check('C1 warm/cold ALONE -> no commit (materially ambiguous, must ask)', commit({ fridgeOnlyWarm: 'TRUE' }) === null);
check('C2 warm/cold + heavy ice -> defrost-system', commit({ fridgeOnlyWarm: 'TRUE', heavyIce: 'TRUE' }) === 'defrost-system');
check('C3 warm/cold + fan silent -> evaporator-fan', commit({ fridgeOnlyWarm: 'TRUE', fanNotAudible: 'TRUE' }) === 'evaporator-fan');
check('C4 warm/cold + vents blocked -> fridge-airflow (no-part)', commit({ fridgeOnlyWarm: 'TRUE', ventsBlocked: 'TRUE' }) === 'fridge-airflow');
check('C5 both compartments warm -> not-cooling (whole appliance)', commit({ bothCompartmentsWarm: 'TRUE' }) === 'not-cooling');
check('C6 fridge-airflow is ADVICE_ONLY (no part)', node('fridge-airflow').outcome === 'ADVICE_ONLY');
check('C7 heavy ice contradicts the evaporator-fan node', factConflict(node('evaporator-fan'), facts({ heavyIce: 'TRUE' })).contradicted);
check('C8 fridgeOnlyWarm contradicts the whole-appliance not-cooling node', factConflict(node('not-cooling'), facts({ fridgeOnlyWarm: 'TRUE' })).contradicted);
check('C9 bothCompartmentsWarm contradicts the fan node', factConflict(node('evaporator-fan'), facts({ bothCompartmentsWarm: 'TRUE' })).contradicted);

// ============================================================================
// D. MATERIAL DISCRIMINATOR — warm/cold asks; answered obs not re-asked
// ============================================================================
check('D1 evaporator-fan leader + warm/cold -> asks the heavy-ice discriminator', (amb('evaporator-fan', { fridgeOnlyWarm: 'TRUE' }) || {}).fact === 'heavyIce');
check('D2 defrost-system leader + warm/cold -> asks the heavy-ice discriminator', (amb('defrost-system', { fridgeOnlyWarm: 'TRUE' }) || {}).fact === 'heavyIce');
check('D3 answered heavy ice -> no re-ask on evaporator-fan', amb('evaporator-fan', { fridgeOnlyWarm: 'TRUE', heavyIce: 'TRUE' }) === null);
check('D4 answered fan-silent -> commit fan, no re-ask', amb('evaporator-fan', { fridgeOnlyWarm: 'TRUE', fanNotAudible: 'TRUE' }) === null);
check('D5 both-warm on not-cooling -> no fridge-only discriminator (whole appliance)', amb('not-cooling', { bothCompartmentsWarm: 'TRUE' }) === null);

// ============================================================================
// E. BOTH-WARM does NOT get forced into fridge-airflow / fan path
// ============================================================================
check('E1 both warm -> not-cooling, not evaporator-fan/defrost', commit({ bothCompartmentsWarm: 'TRUE' }) === 'not-cooling');
check('E2 both warm contradicts defrost-system', factConflict(node('defrost-system'), facts({ bothCompartmentsWarm: 'TRUE' })).contradicted);
check('E3 both warm contradicts fridge-airflow', factConflict(node('fridge-airflow'), facts({ bothCompartmentsWarm: 'TRUE' })).contradicted);

// ============================================================================
// F. SAFETY + ERROR-CODE AUTHORITY
// ============================================================================
check('F1 "fridge warm and a burning smell" -> burning safety', ss('my fridge is warm and there is a burning smell') === 'burning');
check('F2 "sparking from the fridge" -> safety', ss('my fridge is sparking at the back') === 'burning');
check('F3 plain warm/cold is NOT a safety stop', ss('my fridge is warm but the freezer is cold') === null);
check('F4 Samsung 22E still resolves evaporator-fan (error-code authority)', (resolveFault({ applianceType: 'fridge-freezer', make: 'Samsung', errorCode: '22E' }) || {}).faultId === 'evaporator-fan');
check('F5 Samsung 22C still resolves evaporator-fan', (resolveFault({ applianceType: 'fridge-freezer', make: 'Samsung', errorCode: '22C' }) || {}).faultId === 'evaporator-fan');
check('F6 Samsung 24E still resolves defrost-system', (resolveFault({ applianceType: 'fridge-freezer', make: 'Samsung', errorCode: '24E' }) || {}).faultId === 'defrost-system');

// ============================================================================
// G. UNKNOWN neutrality + no-part restraint
// ============================================================================
check('G1 UNKNOWN heavyIce is neutral in scoring', scoreNodeEvidence(node('evaporator-fan'), facts({ heavyIce: 'UNKNOWN' })).score === 0);
check('G2 fridge-airflow leads with a free no-part action', /clear|move|vent|overpack/i.test((node('fridge-airflow').components || [])[0] || ''));
check('G3 defrost-system does not fabricate a single sub-component (heater/thermostat/sensor all listed)', ['defrost heater', 'defrost thermostat', 'defrost sensor'].every((c) => (node('defrost-system').components || []).includes(c)));

// ============================================================================
// H. COMPOSE OBSERVATION AUTHORITY
// ============================================================================
{
  const p = buildComposeSystem([], null,
    { make: null, applianceType: 'fridge-freezer', errorCode: null, onTopic: true, candidateComponents: [], facts: [] },
    { faultId: 'defrost-system', node: node('defrost-system'), via: 'symptom' }, [], null, false, false, null, true);
  check('H1 compose carries OBSERVATION AUTHORITY contract', /OBSERVATION AUTHORITY/.test(p));
  check('H2 label framed as retrieved hypothesis, not reported issue', /HYPOTHESIS|retrieved working area/i.test(p) && !/reported issue:/.test(p));
}

// ============================================================================
// I. SOURCE GUARDS
// ============================================================================
const SRC = require('./engine-source.cjs')();
const codeOnly = SRC.split('\n').filter((l) => !l.trim().startsWith('*') && !l.trim().startsWith('//')).join('\n');
check('I1 no FF journey/benchmark id in code', !/ff-009|ff-010|ff-014/i.test(codeOnly));
check('I2 no "warm fridge -> fan" hard-code', !/fridgeOnlyWarm[\s\S]{0,40}(faultId|return)\s*[:=]\s*['"]?(evaporator|fan)/i.test(codeOnly));
check('I3 no "ice -> heater" hard-code', !/heavyIce[\s\S]{0,40}(faultId|return)\s*[:=]\s*['"]?(defrost|heater)/i.test(codeOnly));
check('I5 no fridge-freezer branch inside materialAmbiguity', !/materialAmbiguity[\s\S]{0,400}===\s*['"]fridge-freezer['"]/i.test(codeOnly));

console.log(`\nFridge warm-fridge/cold-freezer depth: ${pass} passed / ${fail} failed  (total ${pass + fail})`);
process.exit(fail ? 1 : 0);
