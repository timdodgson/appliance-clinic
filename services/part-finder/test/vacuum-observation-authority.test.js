/**
 * VACUUM OBSERVATION AUTHORITY + node decomposition.
 *
 * VC-006 ("Dyson won't turn on") produced a reply that asserted a "burning smell" the customer never
 * mentioned, because the single vacuum:motor node bundled won't-run + cuts-out + overheating + burning
 * smell + no-power into ONE label, and COMPOSE injected that label verbatim as the customer's
 * "reported issue". The fix: (1) decompose the bundled node into materially-distinct nodes
 * (won't switch on / cuts out / motor fault), (2) a GENERIC COMPOSE observation-authority contract so
 * a knowledge label/synonym can never be restated as customer history, (3) deterministic vacuum
 * observation facts (noPower/cutsOut/weakSuction) so the evidence engine + material gate can commit
 * or ask the safe "won't switch on vs weak suction" discriminator. Safety (explicit burning smell)
 * stays authoritative. No new engine, no VC-006 special-case.
 *
 * Run: node services/part-finder/test/vacuum-observation-authority.test.js
 */
globalThis.awslambda = globalThis.awslambda || { streamifyResponse: (fn) => fn, HttpResponseStream: { from: (s) => s } };
const fs = require('fs');
const path = require('path');
const {
  commitFromEvidence, materialAmbiguity, factConflict, scoreNodeEvidence,
  classifySafetyStop, detectSafetyStop, buildComposeSystem,
} = require('../part-finder-lambda.js')._internal;
const CAT = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'faults-catalogue.json'), 'utf8'));

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; } else { fail++; console.log('  FAIL:', name, detail !== undefined ? `:: ${JSON.stringify(detail)}` : ''); }
}
const node = (id) => CAT.faults.vacuum[id];
const facts = (obj) => Object.entries(obj).map(([name, value]) => ({ name, value }));
const commit = (obj) => { const r = commitFromEvidence({ facts: facts(obj) }, 'vacuum'); return r ? r.faultId : null; };
const amb = (leaderId, obj) => materialAmbiguity(leaderId, node(leaderId), facts(obj), 'vacuum');
const ss = (t) => { const r = classifySafetyStop(t, 'vacuum'); return r ? r.category : null; };
// Build the COMPOSE system prompt for a grounded vacuum fault with given customer facts.
const composeFor = (faultId, obj, extraIntent = {}) => buildComposeSystem(
  [], null,
  Object.assign({ make: 'Dyson', applianceType: 'vacuum', errorCode: null, onTopic: true, candidateComponents: [], facts: facts(obj) }, extraIntent),
  { faultId, node: node(faultId), via: 'classified' },
  [], null, false, false, null, true,
);

// ============================================================================
// B. NODE DECOMPOSITION — the bundled node is gone; labels carry no phantom smell
// ============================================================================
check('B1 vacuum has decomposed nodes (wont-run + cuts-out + motor)', ['wont-run', 'cuts-out', 'motor', 'lost-suction', 'brush-bar'].every((id) => node(id)));
check('B2 NO vacuum node label mentions "burning smell"', Object.values(CAT.faults.vacuum).every((n) => !/burning smell/i.test(n.label || '')));
check('B3 NO vacuum node label bundles won\'t-run AND cuts-out', Object.values(CAT.faults.vacuum).every((n) => !(/won'?t (?:run|turn|switch)/i.test(n.label || '') && /cut(?:s|ting) out/i.test(n.label || ''))));
check('B4 motor node label is a clean motor-fault (no won\'t-run/cuts-out/smell)', /motor fault/i.test(node('motor').label) && !/burning|cut|won'?t/i.test(node('motor').label));
check('B5 "burning smell" is not a synonym on any vacuum node', Object.values(CAT.faults.vacuum).every((n) => !(n.synonyms || []).some((s) => /burning smell/i.test(s))));

// ============================================================================
// C. EVIDENCE COMMIT — each observation routes to its materially-different node
// ============================================================================
check('C1 noPower -> wont-run', commit({ noPower: 'TRUE' }) === 'wont-run');
check('C2 cutsOut -> cuts-out', commit({ cutsOut: 'TRUE' }) === 'cuts-out');
check('C3 weakSuction -> lost-suction', commit({ weakSuction: 'TRUE' }) === 'lost-suction');
check('C4 noPower contradicts cuts-out and lost-suction', factConflict(node('cuts-out'), facts({ noPower: 'TRUE' })).contradicted && factConflict(node('lost-suction'), facts({ noPower: 'TRUE' })).contradicted);
check('C5 weakSuction contradicts wont-run', factConflict(node('wont-run'), facts({ weakSuction: 'TRUE' })).contradicted);

// ============================================================================
// D. MATERIAL DISCRIMINATOR — ambiguous "lost power" asks; explicit states do NOT
// ============================================================================
check('D1 ambiguous lost-power (leader wont-run, no facts) -> asks won\'t-switch-on-vs-weak-suction', (amb('wont-run', {}) || {}).altId === 'lost-suction');
check('D1b the pivotal discriminator fact is a power/suction observation', ['weakSuction', 'noPower', 'cutsOut'].includes((amb('wont-run', {}) || {}).fact));
check('D2 explicit noPower KNOWN -> no re-ask', amb('wont-run', { noPower: 'TRUE' }) === null);
check('D3 explicit weakSuction KNOWN -> no re-ask', amb('lost-suction', { weakSuction: 'TRUE' }) === null);
check('D4 explicit cutsOut KNOWN -> no won\'t-switch-vs-suction re-ask on cuts-out', amb('cuts-out', { cutsOut: 'TRUE' }) === null);
check('D6 pulsing-derived cutsOut does not re-ask switch-on vs suction',
  amb('cuts-out', { cutsOut: 'TRUE', noPower: 'FALSE', weakSuction: 'FALSE' }) === null);

// ============================================================================
// E. COMPOSE OBSERVATION AUTHORITY — labels cannot become asserted history
// ============================================================================
{
  const p = composeFor('wont-run', { noPower: 'TRUE' });
  check('E1 compose prompt carries the OBSERVATION AUTHORITY contract', /OBSERVATION AUTHORITY/.test(p));
  check('E2 compose forbids asserting unstated burning smell', /NEVER assert[\s\S]{0,120}burning/i.test(p));
  check('E3 label is framed as retrieved hypothesis, not "reported issue"', /HYPOTHESIS|retrieved working area/i.test(p) && !/reported issue:/.test(p));
  check('E4 the injected working-area label is the clean wont-run label (no burning smell)',
    /retrieved working area[\s\S]{0,160}Won.?t switch on \/ no power/i.test(p));
}
{
  // Even if a node's label mentioned several symptoms, the authority contract is present and the
  // label is framed as our diagnosis — proven here on the cuts-out node.
  const p = composeFor('cuts-out', { cutsOut: 'TRUE' });
  check('E5 cuts-out compose still carries authority contract + hypothesis framing', /OBSERVATION AUTHORITY/.test(p) && /HYPOTHESIS|retrieved working area/i.test(p));
}

// ============================================================================
// F. SAFETY PRECEDENCE — explicit burning/smoke/spark still stop use
// ============================================================================
check('F1 explicit "vacuum burning smell" -> safety burning', ss('my vacuum has a burning smell') === 'burning');
check('F2 explicit "smoke from the vacuum" -> safety burning', ss('there is smoke coming from my vacuum') === 'burning');
check('F3 explicit "sparks from the vacuum" -> safety burning', ss('the vacuum is sparking') === 'burning');
check('F4 detectSafetyStop wraps it (used by hasFailureSymptom)', detectSafetyStop('my vacuum smells of burning') === 'burning');
check('F5 plain "won\'t turn on" is NOT a safety stop', ss('my vacuum won\u2019t turn on') === null);

// ============================================================================
// G. UNKNOWN semantics
// ============================================================================
check('G1 UNKNOWN noPower is neutral in scoring', scoreNodeEvidence(node('wont-run'), facts({ noPower: 'UNKNOWN' })).score === 0);

// ============================================================================
// H. SOURCE GUARDS
// ============================================================================
const SRC = fs.readFileSync(path.join(__dirname, '..', 'part-finder-lambda.js'), 'utf8');
const codeOnly = SRC.split('\n').filter((l) => !l.trim().startsWith('*') && !l.trim().startsWith('//')).join('\n');
check('H1 no VC journey/benchmark id in code', !/vc-006|vc-00\d/i.test(codeOnly));
check('H2 no "won\'t turn on -> remove burning" style rule', !/won'?t turn on[\s\S]{0,40}(burning|smell)/i.test(codeOnly));
check('H4 no vacuum-specific branch inside materialAmbiguity', !/materialAmbiguity[\s\S]{0,400}===\s*['"]vacuum['"]/i.test(codeOnly));
check('H5 observation-authority contract is generic (not keyed to vacuum/VC-006)', /OBSERVATION AUTHORITY/.test(codeOnly) && !/OBSERVATION AUTHORITY[\s\S]{0,200}(vacuum|vc-006)/i.test(codeOnly));

console.log(`\nVacuum observation authority: ${pass} passed / ${fail} failed  (total ${pass + fail})`);
process.exit(fail ? 1 : 0);
