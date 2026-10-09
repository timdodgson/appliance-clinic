/**
 * HOB SINGLE-ZONE DIAGNOSTIC DEPTH — technology + affected-zone scope + induction pan-test as
 * MATERIAL discriminators, so a single dead induction zone does not commit an expensive power/
 * generator module before ruling out cookware/user (a free no-part fix), and an unknown-technology
 * zone fault does not commit the wrong technology's component.
 *
 * Reuses the material-ambiguity gate + evidence engine (signals[]/scoreNodeEvidence/factConflict).
 * NOT an HB-001/HB-007 special-case, NOT a "one zone -> module" or "pan -> module" rule, no new LLM.
 *
 * Run: node services/part-finder/test/hob-single-zone-diagnostic-depth.test.js
 */
globalThis.awslambda = globalThis.awslambda || { streamifyResponse: (fn) => fn, HttpResponseStream: { from: (s) => s } };
const fs = require('fs');
const path = require('path');
const {
  materialAmbiguity, commitFromEvidence, factConflict, scoreNodeEvidence,
} = require('../part-finder-lambda.js')._internal;
const CAT = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'faults-catalogue.json'), 'utf8'));

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; } else { fail++; console.log('  FAIL:', name, detail !== undefined ? `:: ${JSON.stringify(detail)}` : ''); }
}
const node = (id) => CAT.faults.hobs[id];
const facts = (obj) => Object.entries(obj).map(([name, value]) => ({ name, value }));
const amb = (leaderId, obj) => materialAmbiguity(leaderId, node(leaderId), facts(obj), 'hobs');
const commit = (obj) => commitFromEvidence({ facts: facts(obj) }, 'hobs');

// ============================================================================
// B. HB-001 PRIMARY — induction one zone: cookware (no-part) vs power module (part)
// ============================================================================
// B1 induction one-zone, pan behaviour UNKNOWN -> material ambiguity (whichever node leads).
{
  const a = amb('power-module', { inductionHob: 'TRUE', singleZoneAffected: 'TRUE' });
  check('B1 power-module leader -> ambiguous vs cookware-user', a && a.altId === 'cookware-user', a && a.altId);
  const a2 = amb('cookware-user', { inductionHob: 'TRUE', singleZoneAffected: 'TRUE' });
  check('B1b ADVICE_ONLY cookware leader does not delay pan-test advice to sell a module', a2 === null, a2);
}
// B1c-flow: with the in-flow technology exclusivity applied (induction stated => gas/ceramic FALSE,
// all-zones FALSE), the leader is NOT inflated past the cookware alternative — the gate still fires.
// (This mirrors the deployed fact set; without it a raw-score margin can hide the material ambiguity.)
{
  const f = { inductionHob: 'TRUE', gasHob: 'FALSE', ceramicHob: 'FALSE', singleZoneAffected: 'TRUE', allZonesAffected: 'FALSE' };
  check('B1c-flow power-module leader (post-exclusivity) still ambiguous vs cookware',
    (amb('power-module', f) || {}).altId === 'cookware-user', amb('power-module', f));
}
// B2 pan that works elsewhere ALSO fails on the affected zone -> commit hardware (power module).
{
  const c = commit({ inductionHob: 'TRUE', singleZoneAffected: 'TRUE', failsKnownGoodPan: 'TRUE' });
  check('B2 known-good pan fails -> power-module', c && c.faultId === 'power-module', c && c.faultId);
  check('B2b cookware contradicted by failsKnownGoodPan', factConflict(node('cookware-user'), facts({ failsKnownGoodPan: 'TRUE' })).contradicted === true);
}
// B3 a known-good pan WORKS on the affected zone -> commit cookware/user (a FREE no-part fix).
{
  const c = commit({ inductionHob: 'TRUE', singleZoneAffected: 'TRUE', worksWithKnownGoodPan: 'TRUE' });
  check('B3 known-good pan works -> cookware-user', c && c.faultId === 'cookware-user', c && c.faultId);
  check('B3b cookware-user is ADVICE_ONLY (no part)', c && c.node.outcome === 'ADVICE_ONLY');
  check('B3c power-module contradicted by worksWithKnownGoodPan', factConflict(node('power-module'), facts({ worksWithKnownGoodPan: 'TRUE' })).contradicted === true);
}
// B4 once the pan-test is answered, no re-ask (no loop).
check('B4 pan answered -> no material ambiguity', amb('power-module', { inductionHob: 'TRUE', singleZoneAffected: 'TRUE', failsKnownGoodPan: 'TRUE' }) === null);

// ============================================================================
// C. TECHNOLOGY DISCRIMINATION — unknown technology, one zone
// ============================================================================
// C1 unknown tech, element (radiant) leader -> ambiguous vs induction power-module on inductionHob.
{
  const a = amb('element', { singleZoneAffected: 'TRUE' });
  check('C1 unknown-tech one-zone -> material ambiguity asks TECHNOLOGY (inductionHob)', a && a.fact === 'inductionHob', a && { fact: a.fact, altId: a.altId });
}
// C2 induction stated -> element (radiant) is contradicted (not the wrong-technology component).
check('C2 induction contradicts the radiant element node', factConflict(node('element'), facts({ inductionHob: 'TRUE' })).contradicted === true);
// C3 gas stated -> element and induction nodes contradicted.
check('C3 gas contradicts radiant element', factConflict(node('element'), facts({ gasHob: 'TRUE' })).contradicted === true);
check('C3b gas contradicts induction power-module', factConflict(node('power-module'), facts({ gasHob: 'TRUE' })).contradicted === true);
check('C3c gas contradicts induction cookware-user', factConflict(node('cookware-user'), facts({ gasHob: 'TRUE' })).contradicted === true);

// ============================================================================
// D. SCOPE — one zone vs all zones
// ============================================================================
// D1 all zones -> overheating (system-wide) leads; single-zone hardware contradicted.
{
  const c = commit({ allZonesAffected: 'TRUE' });
  check('D1 all-zones -> overheating', c && c.faultId === 'overheating', c && c.faultId);
  check('D1b all-zones contradicts single-zone power-module', factConflict(node('power-module'), facts({ allZonesAffected: 'TRUE' })).contradicted === true);
}
// D2 all-zones overheating leader -> NO material ambiguity / NO pan question (HB-009 protection).
check('D2 all-zones overheating -> no pan discriminator', amb('overheating', { allZonesAffected: 'TRUE' }) === null);
// D3 single-zone contradicts system-wide overheating.
check('D3 single-zone contradicts overheating', factConflict(node('overheating'), facts({ singleZoneAffected: 'TRUE' })).contradicted === true);

// ============================================================================
// E. GAS — never an induction pan question
// ============================================================================
// E1 gas one-burner -> ignition leader, no live induction alternative -> no pan discriminator.
// (In-flow, technology exclusivity sets inductionHob/ceramicHob FALSE once "gas" is stated; the gate
// therefore never treats "is it induction?" as an unresolved discriminator for a gas hob.)
check('E1 gas one-burner -> no induction pan/technology question',
  amb('ignition', { gasHob: 'TRUE', inductionHob: 'FALSE', ceramicHob: 'FALSE', singleZoneAffected: 'TRUE' }) === null);

// ============================================================================
// F. MATERIALITY BOUNDARIES + UNKNOWN semantics
// ============================================================================
check('F1 UNKNOWN pan fact is neutral in scoring', scoreNodeEvidence(node('power-module'), facts({ worksWithKnownGoodPan: 'UNKNOWN' })).score === 0);
// With NO facts yet, a CONTRADICTABLE induction leader still surfaces the pan discriminator (the gate
// can ask the pivotal question before any observation is known).
check('F2 no facts + contradictable leader -> surfaces the pan discriminator',
  (amb('power-module', {}) || {}).altId === 'cookware-user');

// ============================================================================
// G. SOURCE GUARDS
// ============================================================================
const SRC = require('./engine-source.cjs')();
const codeOnly = SRC.split('\n').filter((l) => !l.trim().startsWith('*') && !l.trim().startsWith('//')).join('\n');
check('G1 no journey/benchmark id in code', !/hb-001|hb-007|hb-009/i.test(codeOnly));
check('G2 no "one zone -> module" or "pan -> module" fault rule',
  !/(one ?zone|singlezone|pan)[\s\S]{0,40}(faultId|return)\s*[:=]\s*['"]?(power|module)/i.test(codeOnly));
check('G3 no hob appliance special-case branch in the material gate',
  !/materialAmbiguity[\s\S]{0,400}applianceType[\s\S]{0,20}===\s*['"]hob/i.test(codeOnly));

console.log(`\nHob single-zone diagnostic depth: ${pass} passed / ${fail} failed  (total ${pass + fail})`);
process.exit(fail ? 1 : 0);
