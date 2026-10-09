/**
 * MATERIAL DIAGNOSTIC DISCRIMINATION — ask the highest-value discriminator BEFORE committing to a
 * component, when a materially-different alternative (different component family, or a free no-part
 * fix vs a replacement) is still plausible and separable by a currently-UNKNOWN observable fact.
 *
 * Reusable + evidence-driven: materialAmbiguity() reuses the SAME node signals[] as
 * scoreNodeEvidence/factConflict — it is NOT a "grinding->bearings" phrase rule and NOT a journey map.
 * Probe: DW-015 (dishwasher noisy during wash — hum=wash/circulation pump [a part] vs grinding=foreign
 * object [a free fix], separated by sound quality).
 *
 * Run: node services/part-finder/test/material-diagnostic-discrimination.test.js
 */
globalThis.awslambda = globalThis.awslambda || { streamifyResponse: (fn) => fn, HttpResponseStream: { from: (s) => s } };
const fs = require('fs');
const path = require('path');
const {
  materialAmbiguity, scoreNodeEvidence, factConflict, commitFromEvidence, applianceKey,
} = require('../part-finder-lambda.js')._internal;
const CAT = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'faults-catalogue.json'), 'utf8'));

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; } else { fail++; console.log('  FAIL:', name, detail !== undefined ? `:: ${JSON.stringify(detail)}` : ''); }
}
const node = (fam, id) => CAT.faults[fam][id];
const facts = (obj) => Object.entries(obj).map(([name, value]) => ({ name, value }));
const amb = (fam, leaderId, obj) => materialAmbiguity(leaderId, node(fam, leaderId), facts(obj), fam);
const commit = (obj, fam) => commitFromEvidence({ facts: facts(obj) }, fam);

// ============================================================================
// B. DW-015 PRIMARY — material ambiguity BEFORE commit
// ============================================================================
// B1 "noisy during wash", sound quality UNKNOWN -> circulation-pump leader vs foreign-object,
// pivotal discriminator = grindingNoise (a PART vs a free no-part fix).
{
  const a = amb('dishwasher', 'circulation-pump', { noiseOnWash: 'TRUE' });
  check('B1 material ambiguity fires (circulation-pump vs foreign-object)', a && a.altId === 'foreign-object', a && a.altId);
  check('B1b pivotal discriminator is the sound quality (grindingNoise)', a && a.fact === 'grindingNoise', a && a.fact);
}
// B1c an ADVICE_ONLY (free-fix) leader is not delayed to discriminate a replacement part.
// The circulation-pump LEADER still asks (B1); a foreign-object leader progresses with the check.
{
  const a = amb('dishwasher', 'foreign-object', { noiseOnWash: 'TRUE' });
  check('B1c ADVICE_ONLY foreign-object leader does not delay the free-fix to ask vs the pump', a === null, a);
}
// B2 once the sound quality is KNOWN, do NOT ask again (no loop) — hum answer.
check('B2 hum answered -> no material ambiguity (foreign-object contradicted)',
  amb('dishwasher', 'circulation-pump', { noiseOnWash: 'TRUE', humNoise: 'TRUE' }) === null);
// B3 hum answered -> circulation-pump commits (a part).
{
  const c = commit({ noiseOnWash: 'TRUE', humNoise: 'TRUE' }, 'dishwasher');
  check('B3 hum -> commits circulation-pump', c && c.faultId === 'circulation-pump', c && c.faultId);
}
// B4 grinding answered -> foreign-object commits (a FREE no-part fix), circulation-pump excluded.
{
  const c = commit({ noiseOnWash: 'TRUE', grindingNoise: 'TRUE' }, 'dishwasher');
  check('B4 grinding -> commits foreign-object', c && c.faultId === 'foreign-object', c && c.faultId);
  check('B4b foreign-object is ADVICE_ONLY (no-part)', c && c.node.outcome === 'ADVICE_ONLY');
  check('B4c grinding CONTRADICTS the wash pump', factConflict(node('dishwasher', 'circulation-pump'), facts({ grindingNoise: 'TRUE' })).contradicted === true);
}
// B5 grinding known -> no re-ask (already answered).
check('B5 grinding answered -> no material ambiguity re-ask',
  amb('dishwasher', 'circulation-pump', { noiseOnWash: 'TRUE', grindingNoise: 'TRUE' }) === null);

// ============================================================================
// C. MATERIALITY BOUNDARIES
// ============================================================================
// C1 different-component alternative + unresolved strong discriminator -> ask (B1 already proves).
// C2 contradicted runner-up -> no ask (hum contradicts foreign-object -> B2 proves).
// C3 timing already answered (drain) -> circulation-pump is itself contradicted; a drain leader has
//    no materially-different, close, separable alternative -> no spurious ask.
check('C3 drain-only noise -> no material ambiguity for drain-pump leader',
  amb('dishwasher', 'drain-pump', { noiseOnDrain: 'TRUE' }) === null);
// C4 UNKNOWN is neutral in evidence but CAN be the pivotal discriminator (B1). Prove neutral here:
check('C4 UNKNOWN sound quality does not itself score', scoreNodeEvidence(node('dishwasher', 'circulation-pump'), facts({ grindingNoise: 'UNKNOWN' })).score === 0);

// ============================================================================
// D. WASHING-MACHINE REGRESSION — the gate must NOT re-question a clean bearings commit (WM-008)
// ============================================================================
// D1 "grinding on spin" -> motor-drum is a clean leader; drain-pump is far, excessive-vibration is
// contradicted -> NO material ambiguity (do not regress WM-008 into endless questions).
check('D1 WM grinding-on-spin -> no material ambiguity',
  amb('washing-machine', 'motor-drum', { grindingNoise: 'TRUE', noiseOnSpin: 'TRUE' }) === null);
// D2 WM motor-drum still commits on the grinding evidence (unchanged).
check('D2 WM grinding-on-spin still commits motor-drum',
  (() => { const c = commit({ grindingNoise: 'TRUE', noiseOnSpin: 'TRUE' }, 'washing-machine'); return c && c.faultId === 'motor-drum'; })());
// D3 excessive-vibration is contradicted by a grind (a bang is not a grind) -> never a live alternative.
check('D3 grind contradicts excessive-vibration',
  factConflict(node('washing-machine', 'excessive-vibration'), facts({ grindingNoise: 'TRUE' })).contradicted === true);

// ============================================================================
// E. GENERALITY — the gate is fact-agnostic (reads signals[], not a noise phrase table)
// ============================================================================
// E1 a node with no signals[] can't be a leader (nothing to reason over) -> null.
check('E1 signal-less leader -> no ambiguity', materialAmbiguity('not-draining', node('dishwasher', 'not-draining'), facts({ noiseOnWash: 'TRUE' }), 'dishwasher') === null);
// E2 with NO facts yet, a CONTRADICTABLE leader still surfaces its material discriminator (this is
// the generalisation that lets a bare symptom ask the pivotal question before any fact is known).
check('E2 no facts + contradictable leader -> surfaces a material discriminator',
  amb('dishwasher', 'circulation-pump', {}) !== null);

// ============================================================================
// F. SOURCE GUARDS
// ============================================================================
const SRC = require('./engine-source.cjs')();
const codeOnly = SRC.split('\n').filter((l) => !l.trim().startsWith('*') && !l.trim().startsWith('//')).join('\n');
check('F1 no journey/benchmark id in code', !/dw-015|wm-008|ov-003/i.test(codeOnly));
check('F2 no "grinding -> foreign-object/bearings" fault string rule',
  !/grind[\s\S]{0,40}(faultId|return)\s*[:=]\s*['"]?(foreign|bearing|pump)/i.test(codeOnly));
check('F3 materialAmbiguity reuses signals[] evidence (scoreNodeEvidence + factConflict)',
  /materialAmbiguity/.test(SRC) && /scoreNodeEvidence\(altNode, facts\)/.test(SRC) && /factConflict\(altNode, facts\)/.test(SRC));
check('F4 no dishwasher/appliance special-case branch in the gate',
  !/applianceType[\s\S]{0,30}===\s*['"]dishwasher['"]/i.test(codeOnly));

console.log(`\nMaterial diagnostic discrimination: ${pass} passed / ${fail} failed  (total ${pass + fail})`);
process.exit(fail ? 1 : 0);
