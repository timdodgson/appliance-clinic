/**
 * Evidence "works-fact" strength contract (deterministic, no LLM/network).
 *
 * A positive "works" fact (heatsAtAll / drainsNormally / drumTurnsByHand) proves a subsystem
 * genuinely good ONLY when it describes a DIFFERENT function from the grounded complaint. When it
 * describes the SAME function the complaint is about, it is merely condition-limited ("works under
 * some conditions") and must NOT be promoted to provenGood (which COMPOSE reads as "that part is
 * fine" and adjustDifferential uses to drop the part).
 *
 * The grounded fault node encodes this: a works-fact the node lists as arguing AGAINST it — at
 * EITHER strength (AGAINST or STRONG_AGAINST) — belongs to the fault's OWN function (condition-
 * limited); a works-fact listed as SUPPORT is a confirmed DIFFERENT function (proven-good). The
 * strength only encodes how hard it argues, never which function it belongs to.
 *
 * Regression anchor: oven-cooker/element lists `heatsAtAll -> AGAINST` (a working grill or top oven
 * only weakly rules out a dead fan-oven element — that is why topOvenHeats is the separate
 * STRONG_AGAINST). Previously only STRONG_AGAINST counted, so "it heats at all" was misread as a
 * different function and wrongly promoted the failing fan-oven heating path to provenGood (the H7
 * failure). This locks the general rule, not the single case.
 *
 * Run: node services/part-finder/test/evidence-works-strength.test.js
 */
const fs = require('fs');
const path = require('path');
globalThis.awslambda = globalThis.awslambda || { streamifyResponse: (fn) => fn, HttpResponseStream: { from: (s) => s } };
const { collectEvidence, adjustDifferential, resolveFault } = require('../part-finder-lambda.js')._internal;

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) pass++;
  else { fail++; console.log('  FAIL:', name, detail !== undefined ? `:: ${JSON.stringify(detail)}` : ''); }
}
const facts = (obj) => Object.entries(obj).map(([name, value]) => ({ name, value }));
const has = (arr, re) => (arr || []).some((p) => re.test(String(p)));

// ---------------------------------------------------------------------------
// A. SAME-function works-fact listed as weak AGAINST -> condition-limited, NOT proven-good.
//    oven-cooker/element: grill works (heatsAtAll TRUE), fan oven cold. The failing heating path
//    must not be proven good; the stated grill mode stays genuinely good.
// ---------------------------------------------------------------------------
const oven = resolveFault({ applianceType: 'oven-cooker', faultId: 'element' });
const ovenAdj = collectEvidence({
  provenGood: ['grill element'],
  facts: facts({ heatsAtAll: 'TRUE' }),
  candidateComponents: ['fan oven element'],
}, 'grill works, fan oven cold', oven);

check('A1 the failing heating path is condition-limited, not proven-good',
  has(ovenAdj.conditionLimited, /heater|heating element/i)
  && !has(ovenAdj.provenGood, /^heater$|heating element/i), ovenAdj);
check('A2 the separately-working mode (grill element) remains genuinely proven-good',
  has(ovenAdj.provenGood, /grill element/i), ovenAdj);

// Acceptance: a works-fact that only shows one mode heats must NOT falsely eliminate the leading
// suspect (the fan-oven element) from the differential.
const ovenDiff = adjustDifferential(['fan oven element', 'grill element'], ovenAdj);
check('A3 the leading suspect (fan oven element) is NOT eliminated',
  ovenDiff.includes('fan oven element'), ovenDiff);
check('A4 the proven-good different mode (grill element) IS removed',
  !ovenDiff.includes('grill element'), ovenDiff);

// ---------------------------------------------------------------------------
// B. SAME-function works-fact listed as STRONG_AGAINST -> condition-limited (unchanged behaviour).
//    washing-machine/not-draining: drainsNormally STRONG_AGAINST.
// ---------------------------------------------------------------------------
const drain = resolveFault({ applianceType: 'washing-machine', faultId: 'not-draining' });
const drainAdj = collectEvidence({
  provenGood: ['drain pump', 'pump filter'],
  facts: facts({ drainsNormally: 'TRUE' }),
  candidateComponents: ['drain pump', 'pump filter', 'drain hose'],
}, 'it stops mid cycle', drain);
check('B1 same-function drain success is condition-limited',
  has(drainAdj.conditionLimited, /pump/i) && !has(drainAdj.provenGood, /pump/i), drainAdj);
check('B2 condition-limited drain parts stay on the differential',
  adjustDifferential(['drain pump', 'main pcb'], drainAdj).includes('drain pump'));

// ---------------------------------------------------------------------------
// C. CONTROL — DIFFERENT-function works-fact listed as SUPPORT -> genuinely proven-good.
//    washing-machine/motor-drum (spin complaint): drainsNormally SUPPORT. Draining is a different
//    function; it stays proven-good and the drain parts are removed. The fix must NOT regress this.
// ---------------------------------------------------------------------------
const spin = resolveFault({ applianceType: 'washing-machine', faultId: 'motor-drum' });
const spinAdj = collectEvidence({
  provenGood: ['drain pump', 'pump filter'],
  facts: facts({ drainsNormally: 'TRUE' }),
  candidateComponents: ['drive motor', 'drive belt'],
}, 'it drains but will not spin', spin);
check('C1 different-function drain success stays proven-good (not condition-limited)',
  has(spinAdj.provenGood, /pump/i) && !has(spinAdj.conditionLimited, /pump/i), spinAdj);
const spinDiff = adjustDifferential(['drive motor', 'drain pump', 'drive belt'], spinAdj);
check('C2 proven-good drain parts are removed from the spin differential',
  !spinDiff.includes('drain pump') && spinDiff.includes('drive motor'), spinDiff);

console.log(`\nevidence-works-strength: ${pass} passed / ${fail} failed`);
if (fail > 0) process.exit(1);
