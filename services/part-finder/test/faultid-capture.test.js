'use strict';
/**
 * Deterministic regression test for the TD condenser faultId-capture defect.
 *
 * Root cause: Pass-1 sometimes emits the correct faultId in the free-text
 * `fault` field while leaving `faultId` null (observed: condenser tumble-dryer,
 * fault="not-emptying-condensate", faultId=null, confidence ~0.9, correct doc
 * rank 1). resolveFault() only read `faultId`, so a valid, model-produced id was
 * dropped -> grounded=false. Fix: field-slip recovery in resolveFault (step 2b).
 *
 * This test exercises resolveFault directly (no LLM) so it is fully deterministic.
 * Run: node services/part-finder/test/faultid-capture.test.js
 */
const assert = require('assert');
// The Lambda module references the `awslambda` runtime global at load time.
// Provide a no-op shim BEFORE require so the module imports locally. In AWS the
// real global is present; this shim is only used off-Lambda (tests).
globalThis.awslambda = globalThis.awslambda || {
  streamifyResponse: (fn) => fn,
  HttpResponseStream: { from: (s) => s },
};
const { resolveFault } = require('../part-finder-lambda.js')._internal;

let pass = 0, fail = 0;
function check(name, cond) { if (cond) pass++; else { fail++; console.log('  FAIL:', name); } }

// 1) Field-slip recovery: id emitted in `fault`, faultId null -> must resolve.
const slip = resolveFault({ applianceType: 'tumble-dryer', fault: 'not-emptying-condensate', faultId: null });
check('field-slip recovers faultId from fault field', slip && slip.faultId === 'not-emptying-condensate');
check('field-slip marked via classified-fault-field', slip && slip.via === 'classified-fault-field');

// 2) Normal path still works: id in faultId.
const normal = resolveFault({ applianceType: 'tumble-dryer', faultId: 'not-emptying-condensate', fault: 'Condensate not emptying' });
check('normal faultId path still resolves', normal && normal.faultId === 'not-emptying-condensate' && normal.via === 'classified');

// 3) Hyphenated appliance key resolves (applianceKey fallback).
const wm = resolveFault({ applianceType: 'washing-machine', faultId: 'motor-drum', fault: null });
check('washing-machine faultId resolves', wm && wm.faultId === 'motor-drum');

// 4) Safety: free-text that is NOT a valid id must NOT be force-resolved by 2b.
const noise = resolveFault({ applianceType: 'tumble-dryer', fault: 'the machine is a bit noisy sometimes', faultId: null });
check('non-id free text is not mis-resolved by field-slip recovery', !(noise && noise.via === 'classified-fault-field'));

// 5) Field-slip recovery is scoped per-appliance (id must be valid for THIS appliance).
const wrongAppliance = resolveFault({ applianceType: 'dishwasher', fault: 'not-emptying-condensate', faultId: null });
check('field-slip does not leak an id across appliance types', !(wrongAppliance && wrongAppliance.via === 'classified-fault-field'));

console.log(`\nfaultId-capture: ${pass} passed / ${fail} failed`);
process.exit(fail ? 1 : 0);
