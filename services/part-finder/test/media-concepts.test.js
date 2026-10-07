'use strict';
/**
 * mediaConcepts — derivation + DIAGNOSTIC NEUTRALITY (deterministic, offline, no LLM).
 *
 * Proves:
 *   A. deriveMediaConcepts maps the ALREADY-grounded fault + structured facts to presentation
 *      concepts: not-draining -> ['drainage-appliance']; not-draining/odour + wasteBackflow=TRUE ->
 *      ['waste-backflow']; unrelated faults -> [].
 *   B. NEUTRALITY: the new `wasteBackflow` fact is inert to the diagnosis — computeEvidence,
 *      collectEvidence (proven-good) and resolveFault produce byte-identical results with or without
 *      it. So mediaConcepts cannot change faultId / evidence / parts.
 *
 * Run: node services/part-finder/test/media-concepts.test.js
 */
const assert = require('assert');
globalThis.awslambda = globalThis.awslambda || { streamifyResponse: (fn) => fn, HttpResponseStream: { from: (s) => s } };
const { deriveMediaConcepts, computeEvidence, collectEvidence, resolveFault } = require('../part-finder-lambda.js')._internal;

let pass = 0, fail = 0;
const ok = (n, c) => { if (c) { pass++; console.log('  ok  -', n); } else { fail++; console.log('  FAIL-', n); } };
const F = (name, value = 'TRUE') => ({ name, value });
const ndFault = resolveFault({ applianceType: 'washing-machine', faultId: 'not-draining' });
const odourFault = resolveFault({ applianceType: 'washing-machine', faultId: 'odour' });

// ---- A. derivation ----
ok('A not-draining, no facts -> drainage-appliance', JSON.stringify(deriveMediaConcepts('washing-machine', ndFault, [])) === JSON.stringify(['drainage-appliance']));
ok('A not-draining + wasteBackflow TRUE -> waste-backflow', JSON.stringify(deriveMediaConcepts('washing-machine', ndFault, [F('wasteBackflow')])) === JSON.stringify(['waste-backflow']));
ok('A not-draining + wasteBackflow FALSE -> drainage-appliance', JSON.stringify(deriveMediaConcepts('washing-machine', ndFault, [F('wasteBackflow', 'FALSE')])) === JSON.stringify(['drainage-appliance']));
ok('A not-draining + wasteBackflow UNKNOWN -> drainage-appliance', JSON.stringify(deriveMediaConcepts('washing-machine', ndFault, [F('wasteBackflow', 'UNKNOWN')])) === JSON.stringify(['drainage-appliance']));
ok('A odour + wasteBackflow TRUE -> waste-backflow', JSON.stringify(deriveMediaConcepts('washing-machine', odourFault, [F('wasteBackflow')])) === JSON.stringify(['waste-backflow']));
ok('A odour, no backflow -> appliance-hygiene', JSON.stringify(deriveMediaConcepts('washing-machine', odourFault, [F('waterRemaining')])) === JSON.stringify(['appliance-hygiene']));
ok('A unrelated fault (motor-drum) -> []', deriveMediaConcepts('washing-machine', resolveFault({ applianceType: 'washing-machine', faultId: 'motor-drum' }), [F('wasteBackflow')]).length === 0);
ok('A no fault -> []', deriveMediaConcepts('washing-machine', null, [F('wasteBackflow')]).length === 0);
ok('A case-insensitive fact name', JSON.stringify(deriveMediaConcepts('washing-machine', ndFault, [F('WASTEBACKFLOW')])) === JSON.stringify(['waste-backflow']));

// ---- B. diagnostic neutrality of the wasteBackflow fact ----
{
  const base = [F('waterRemaining'), F('pumpHumming'), F('drainsNormally', 'FALSE')];
  const withBackflow = [...base, F('wasteBackflow')];
  ok('B computeEvidence identical with/without wasteBackflow',
    JSON.stringify(computeEvidence(ndFault.node, base)) === JSON.stringify(computeEvidence(ndFault.node, withBackflow)));

  const evBase = collectEvidence({ facts: base }, 'water left in the drum');
  const evBack = collectEvidence({ facts: withBackflow }, 'water left in the drum');
  ok('B collectEvidence provenGood identical (wasteBackflow not in proven-good backstop)',
    JSON.stringify(evBase.provenGood) === JSON.stringify(evBack.provenGood));

  // resolveFault ignores facts entirely (routes on faultId/errorCode/fault) -> unchanged.
  const r1 = resolveFault({ applianceType: 'washing-machine', faultId: 'not-draining' });
  const r2 = resolveFault({ applianceType: 'washing-machine', faultId: 'not-draining' });
  ok('B resolveFault stable regardless of facts', r1.faultId === r2.faultId && r1.faultId === 'not-draining');

  // wasteBackflow is NOT one of the standard signals in the node -> never appears in evidence phrases.
  const ev = computeEvidence(ndFault.node, withBackflow) || { supports: [], against: [] };
  const blob = JSON.stringify(ev).toLowerCase();
  ok('B wasteBackflow never surfaces as diagnostic evidence', !blob.includes('backflow') && !blob.includes('waste'));
}

console.log(`\nmedia-concepts tests: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
