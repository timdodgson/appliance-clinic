/**
 * WASHING-MACHINE LEAK-SOURCE DIAGNOSTIC DEPTH.
 *
 * A vague "washing machine is leaking" cannot name a useful part. The material dimensions are WHERE
 * the water first appears (door/front vs detergent drawer vs underneath vs rear) and WHEN in the
 * cycle (fill vs drain/spin), plus excessive foam. This decomposes the single bundled leak-flood node
 * into materially-distinct leak-source nodes with structured signals, and reuses the material-ambiguity
 * gate to ask the safe where/when discriminator before committing. Location/timing are OBSERVATIONS, never
 * components; "I think the door seal has gone" is a hypothesis, not an observation. leak-flood stays
 * the anti-flood/oily/leak-with-won't-spin node (no location signals) so WM-013 still commits.
 *
 * Run: node services/part-finder/test/washing-machine-leak-source-depth.test.js
 */
globalThis.awslambda = globalThis.awslambda || { streamifyResponse: (fn) => fn, HttpResponseStream: { from: (s) => s } };
const fs = require('fs');
const path = require('path');
const {
  commitFromEvidence, materialAmbiguity, factConflict, scoreNodeEvidence,
  classifySafetyStop, buildComposeSystem,
} = require('../part-finder-lambda.js')._internal;
const CAT = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'faults-catalogue.json'), 'utf8'));

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; } else { fail++; console.log('  FAIL:', name, detail !== undefined ? `:: ${JSON.stringify(detail)}` : ''); }
}
const node = (id) => CAT.faults['washing-machine'][id];
const facts = (obj) => Object.entries(obj).map(([name, value]) => ({ name, value }));
const commit = (obj) => { const r = commitFromEvidence({ facts: facts(obj) }, 'washing-machine'); return r ? r.faultId : null; };
const amb = (id, obj) => materialAmbiguity(id, node(id), facts(obj), 'washing-machine');
const ss = (t) => { const r = classifySafetyStop(t, 'washing-machine'); return r ? r.category : null; };

// ============================================================================
// C. NODE DECOMPOSITION — materially-distinct leak-source nodes exist
// ============================================================================
check('C1 leak-source nodes exist', ['leak-door', 'leak-dispenser', 'leak-drain', 'leak-fill', 'leak-flood'].every((id) => node(id)));
check('C2 leak-flood label no longer asserts "triggered"', !/triggered/i.test(node('leak-flood').label));
check('C3 leak-flood has NO location signals (protects WM-013 commit)', !(node('leak-flood').signals || []).some((s) => /^leak(At|Underneath)/.test(s.fact)));
check('C4 leak-door primary component leads with a free check, not a part push', /check|debris/i.test((node('leak-door').components || [])[0] || ''));
check('C5 leak-drain leads with the filter-cap seating check', /check|filter cap|seated/i.test((node('leak-drain').components || [])[0] || ''));

// ============================================================================
// D. EVIDENCE COMMIT — each location/timing observation routes to its source
// ============================================================================
check('D1 leakAtDoor -> leak-door', commit({ leakAtDoor: 'TRUE' }) === 'leak-door');
check('D2 leakAtDrawer -> leak-dispenser', commit({ leakAtDrawer: 'TRUE' }) === 'leak-dispenser');
check('D3 leakUnderneath -> leak-drain', commit({ leakUnderneath: 'TRUE' }) === 'leak-drain');
check('D4 leaksOnDrain -> leak-drain', commit({ leaksOnDrain: 'TRUE' }) === 'leak-drain');
check('D5 leakAtRear + leaksOnFill -> leak-fill', commit({ leakAtRear: 'TRUE', leaksOnFill: 'TRUE' }) === 'leak-fill');
check('D6 excessiveFoam -> foam-suds (no-part detergent advice)', commit({ excessiveFoam: 'TRUE' }) === 'foam-suds');
check('D7 leakAtDoor contradicts the underneath/drain node', factConflict(node('leak-drain'), facts({ leakAtDoor: 'TRUE' })).contradicted);
check('D8 leakUnderneath contradicts the door node', factConflict(node('leak-door'), facts({ leakUnderneath: 'TRUE' })).contradicted);

// ============================================================================
// E. MATERIAL DISCRIMINATOR — vague leak asks WHERE; answered location does not re-ask
// ============================================================================
check('E1 vague leak (leak-drain leader, no facts) -> asks a location discriminator', ['leakAtDoor', 'leakAtDrawer', 'leakUnderneath', 'leakAtRear'].includes((amb('leak-drain', {}) || {}).fact));
check('E2 answered leakUnderneath -> no re-ask on leak-drain', amb('leak-drain', { leakUnderneath: 'TRUE' }) === null);
check('E3 answered leakAtDoor -> no re-ask on leak-door', amb('leak-door', { leakAtDoor: 'TRUE' }) === null);
check('E4 leak-flood leader (no signals) -> no location question (WM-013 commits)', amb('leak-flood', {}) === null);
check('E5 a door-leak leader with location unknown also offers a materially-different alternative', (amb('leak-door', {}) || {}).altId && (amb('leak-door', {}) || {}).altId !== 'leak-door');

// ============================================================================
// F. SAFETY PRECEDENCE — leak + electrical hazard wins immediately
// ============================================================================
check('F1 "water reaching the plug socket" -> shock safety', ss('water is leaking and getting near the plug socket') === 'shock');
check('F2 "leak and a burning smell" -> burning safety', ss('my washing machine is leaking and there is a burning smell') === 'burning');
check('F3 "leaking and sparking" -> safety', ss('the washing machine is leaking and sparking') === 'burning');
check('F4 a plain leak is NOT a safety stop', ss('my washing machine is leaking from the front') === null);

// ============================================================================
// G. UNKNOWN neutrality + no-part vs part
// ============================================================================
check('G1 UNKNOWN leak location is neutral in scoring', scoreNodeEvidence(node('leak-door'), facts({ leakAtDoor: 'UNKNOWN' })).score === 0);
check('G2 foam-suds is advice-first (free fix leads)', /reduce|dose|detergent/i.test((node('foam-suds').components || [])[0] || ''));
check('G3 leak-dispenser is advice-first (clean/less detergent leads)', /clean|reduce|detergent/i.test((node('leak-dispenser').components || [])[0] || ''));

// ============================================================================
// H. COMPOSE OBSERVATION AUTHORITY — leak node label cannot become asserted history
// ============================================================================
{
  const p = buildComposeSystem([], null,
    { make: null, applianceType: 'washing-machine', errorCode: null, onTopic: true, candidateComponents: [], facts: [] },
    { faultId: 'leak-flood', node: node('leak-flood'), via: 'symptom' }, [], null, false, false, null, true);
  check('H1 compose carries the OBSERVATION AUTHORITY contract', /OBSERVATION AUTHORITY/.test(p));
  check('H2 label framed as retrieved hypothesis, not reported issue', /HYPOTHESIS|retrieved working area/i.test(p) && !/reported issue:/.test(p));
}

// ============================================================================
// I. SOURCE GUARDS
// ============================================================================
const SRC = fs.readFileSync(path.join(__dirname, '..', 'part-finder-lambda.js'), 'utf8');
const codeOnly = SRC.split('\n').filter((l) => !l.trim().startsWith('*') && !l.trim().startsWith('//')).join('\n');
check('I1 no WM journey/benchmark id in code', !/wm-0\d\d/i.test(codeOnly));
check('I2 no "underneath -> pump" location->part hard-code', !/leakUnderneath[\s\S]{0,40}(faultId|return)\s*[:=]\s*['"]?(leak-drain|drain-pump|pump)/i.test(codeOnly));
check('I3 no "front -> door seal" location->part hard-code', !/leakAtDoor[\s\S]{0,40}(faultId|return)\s*[:=]\s*['"]?(door|seal)/i.test(codeOnly));
check('I5 no washing-machine branch inside materialAmbiguity', !/materialAmbiguity[\s\S]{0,400}===\s*['"]washing-machine['"]/i.test(codeOnly));

console.log(`\nWashing-machine leak-source depth: ${pass} passed / ${fail} failed  (total ${pass + fail})`);
process.exit(fail ? 1 : 0);
