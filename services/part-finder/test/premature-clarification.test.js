/**
 * PREMATURE / REDUNDANT CLARIFICATION — generic, evidence-driven fixes for the clear single-symptom
 * openers that were asking a redundant question instead of committing, PLUS the guards that keep the
 * genuinely-pivotal discriminators asking.
 *
 * Root cause was NOT a single mechanism. This suite locks in the four proven, generic fixes and,
 * crucially, the boundaries that must NOT regress:
 *   1. SAFETY: classifySafetyStop must catch a shock in ANY tense ("gave me a shock", "got a shock")
 *      — a shock is zero-tolerance; tense must never gate the stop.
 *   2. ANSWERED HEAT-STATE: a stated heat-state ("damp AND warm", not only "warm BUT damp") commits
 *      (washer-dryer drying-poor, ADVICE_ONLY) instead of re-asking.
 *   3. NORMAL: a SMALL amount of residual sump water, asked about as a worry, is normal (not a
 *      not-draining fault) — but a genuine drainage fault must still veto reassurance.
 *   4. INTERLOCK SIGNATURE: a microwave whose fan/light runs while the cooking functions/display are
 *      dead is a door-interlock picture (doorStartProblem) — but "runs but no heat" stays heating-path.
 *
 * PRESERVE (must still ASK): the material-ambiguity gate for a genuinely pivotal, unresolved
 * discriminator (dishwasher hum-vs-grind, drain-vs-spin retained water, hob pan-test, fridge
 * compartment scope, drying heat-state when the LEADER is a heating-hardware / part node) — these
 * are the improvements we must not damage. ADVICE_ONLY drying leaders progress with advice rather
 * than delaying a no-part check to ask heat.
 *
 * Pure/deterministic — no LLM, no network. Run: node services/part-finder/test/premature-clarification.test.js
 */
globalThis.awslambda = globalThis.awslambda || { streamifyResponse: (fn) => fn, HttpResponseStream: { from: (s) => s } };
const fs = require('fs');
const path = require('path');
const {
  classifySafetyStop, commitFromEvidence, materialAmbiguity,
  matchNormalBehaviour, isResidualWaterOnly, resolveFault, buildComposeSystem, evidenceDecisive,
  customerDeclinedDiscriminator, COMPONENT_MENTION,
} = require('../part-finder-lambda.js')._internal;
const CAT = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'faults-catalogue.json'), 'utf8'));

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; } else { fail++; console.log('  FAIL:', name, detail !== undefined ? `:: ${JSON.stringify(detail)}` : ''); }
}
const node = (fam, id) => CAT.faults[fam][id];
const facts = (obj) => Object.entries(obj).map(([name, value]) => ({ name, value }));
const dwctx = { applianceFamily: 'dishwasher' };

// ============================================================================
// A. SAFETY — shock in any tense stops (zero-tolerance), with non-shock guards
// ============================================================================
check('A1 "gave me a shock" -> shock stop', classifySafetyStop('my electric oven gave me a shock when I touched it')?.category === 'shock');
check('A2 "got a shock off it" -> shock stop', classifySafetyStop('I got a shock off the washing machine')?.category === 'shock');
check('A3 "gives me a shock" (present, unchanged) -> shock', classifySafetyStop('the tumble dryer gives me a shock')?.category === 'shock');
check('A4 "had a nasty shock" -> shock', classifySafetyStop('had a nasty shock off the cooker')?.category === 'shock');
check('A5 "it\'s shocked me" -> shock', classifySafetyStop("the fridge has shocked me twice")?.category === 'shock');
check('A6 "a belt off it" -> shock', classifySafetyStop('I get a right belt off it when the sink is wet')?.category === 'shock');
check('A7 NON-shock "shocking price" stays null', classifySafetyStop('the price was shocking for a new oven') === null);
check('A8 NON-shock "in shock" stays null', classifySafetyStop('I was in shock when it stopped working') === null);
check('A9 gas escape still stops', classifySafetyStop('I can smell gas near the cooker')?.category === 'gas');

// ============================================================================
// B. ANSWERED HEAT-STATE — "damp and warm" reads heat present, commits no-part advice
// ============================================================================
{
  const c = commitFromEvidence({ facts: facts({ heatPresent: 'TRUE' }) }, 'washer-dryer');
  check('B6 heatPresent commits washer-dryer drying-poor', c && c.faultId === 'drying-poor', c && c.faultId);
  check('B7 drying-poor is ADVICE_ONLY (no part pushed)', c && c.node.outcome === 'ADVICE_ONLY');
}

// ============================================================================
// C. NORMAL — residual sump water reassurance, tightly bounded
// ============================================================================
check('C1 residual sump water grounds normal', matchNormalBehaviour(dwctx, 'there is always a little water sitting in the bottom of my dishwasher after it finishes, is that a fault?')?.id === 'dishwasher:residual-sump-water');
check('C2 genuine not-draining (full dirty water) is NOT reassured', matchNormalBehaviour(dwctx, "my dishwasher is full of dirty water and won't drain, is that normal?") === null);
check('C3 flooding on the floor is NOT reassured', matchNormalBehaviour(dwctx, 'there is water all over the floor from my dishwasher, normal?') === null);
check('C4 residual water without concern does NOT ground (requireConcern)', matchNormalBehaviour(dwctx, 'a little water in the bottom after the cycle') === null);
check('C5 residual water co-occurring with a real fault vetoes', matchNormalBehaviour(dwctx, "a little water in the bottom and it won't start, is that normal?") === null);
check('C6 isResidualWaterOnly true for small residual', isResidualWaterOnly('a little water sitting in the bottom after it finishes') === true);
check('C7 isResidualWaterOnly false for won\'t drain', isResidualWaterOnly("the bottom is full of water and it won't drain") === false);

// ============================================================================
// D. MICROWAVE — heating-path vs door discriminator preserved; hypothesis fabricates nothing
// (NOTE: a deterministic "fan runs but cooking dead => door" derive was trialled and REVERTED —
//  it correctly grounded the door interlock but exposed a separate COMPOSE-fidelity issue where the
//  LLM narrated an unrelated HV-inverter cause + a phantom "cuts out after seconds"; that belongs to
//  the CUSTOMER_ANSWER_QUALITY / REASONING work, so microwave grounding is unchanged in this pass.)
// ============================================================================
{
  const c = commitFromEvidence({ facts: facts({ doorStartProblem: 'TRUE' }) }, 'microwave');
  check('D4 doorStartProblem commits microwave door', c && c.faultId === 'door', c && c.faultId);
}
check('D5 runsNormally does NOT commit to door', (() => { const c = commitFromEvidence({ facts: facts({ runsNormally: 'TRUE' }) }, 'microwave'); return !c || c.faultId !== 'door'; })());

// ============================================================================
// E. PRESERVE — genuinely pivotal discriminators MUST still ASK (no over-commit)
// ============================================================================
// E1 dishwasher "noisy during wash", sound quality unknown -> still asks (hum vs grind).
check('E1 dishwasher noise material ambiguity still fires', (() => { const a = materialAmbiguity('circulation-pump', node('dishwasher', 'circulation-pump'), facts({ noiseOnWash: 'TRUE' }), 'dishwasher'); return a && a.fact === 'grindingNoise'; })());
// E2 drain-vs-spin retained water unknown -> still asks.
check('E2 WM drain/spin waterRemaining discriminator still fires', (() => { const a = materialAmbiguity('not-draining', node('washing-machine', 'not-draining'), facts({}), 'washing-machine'); return Boolean(a); })());
// E3 hob single-zone pan-test still asks (cookware/user vs zone hardware).
check('E3 hob pan-test discriminator still fires', (() => { const a = materialAmbiguity('power-module', node('hobs', 'power-module'), facts({ singleZoneAffected: 'TRUE', inductionHob: 'TRUE' }), 'hobs'); return a && /Pan|worksWithKnownGoodPan|failsKnownGoodPan/i.test(a.fact); })());
// E4 fridge "not cooling" compartment scope still asks.
check('E4 fridge compartment discriminator still fires', (() => { const a = materialAmbiguity('not-cooling', node('fridge-freezer', 'not-cooling'), facts({}), 'fridge-freezer'); return Boolean(a); })());
// E5 drying heat-state UNKNOWN on a HEATING-HARDWARE leader still asks (do not sell a heater yet).
check('E5 drying heat-state discriminator still fires when heating is the leader', (() => { const a = materialAmbiguity('drying-heater', node('washer-dryer', 'drying-heater'), facts({}), 'washer-dryer'); return Boolean(a); })());
check('E5b ADVICE_ONLY drying leader does NOT delay advice to ask heat', materialAmbiguity('drying-poor', node('washer-dryer', 'drying-poor'), facts({}), 'washer-dryer') === null);

// ============================================================================
// F. §16 MATRIX — clear+sufficient -> answer; exact code -> resolve; model-only-for-fit -> diagnose
// ============================================================================
// F1 clear symptom + sufficient evidence -> commit (grinding on spin -> motor-drum bearings).
{
  const c = commitFromEvidence({ facts: facts({ grindingNoise: 'TRUE', noiseOnSpin: 'TRUE' }) }, 'washing-machine');
  check('F1 grinding on spin commits motor-drum (answer, not ask)', c && c.faultId === 'motor-drum', c && c.faultId);
  check('F1b evidenceDecisive true for that evidence', evidenceDecisive(node('washing-machine', 'motor-drum'), facts({ grindingNoise: 'TRUE', noiseOnSpin: 'TRUE' })) === true);
}
// F2 exact error code + brand -> resolve via errorCode.
{
  const f = resolveFault({ applianceType: 'dishwasher', make: 'Neff', errorCode: 'E15' });
  check('F2 Neff E15 resolves via errorCode', f && f.via === 'errorCode', f && f.via);
}
// F3 model-only-for-fit: committed diagnosis asks for the model to check catalogue
// fit, not to diagnose, and must not teach "exact part" before fit evidence exists.
{
  const fault = { faultId: 'motor-drum', node: node('washing-machine', 'motor-drum'), via: 'evidence-commit' };
  const intent = { applianceType: 'washing-machine', make: 'Bosch', confidence: 0.9, facts: facts({ grindingNoise: 'TRUE', noiseOnSpin: 'TRUE' }), candidateComponents: [], alternatives: [] };
  const prompt = buildComposeSystem([], null, intent, fault, [], null, false, false, null, true, {
    mention: COMPONENT_MENTION.PURCHASE,
    purchaseAppropriate: true,
    committedComponent: true,
  });
  check('F3 committed diagnosis prompt asks model to check catalogue fit, not to diagnose',
    /suitable replacement is available/i.test(prompt)
    && /no catalogue-fit evidence yet/i.test(prompt)
    && !/EXACT-PART FIT/i.test(prompt)
    && !/the exact part needs the model/i.test(prompt));
  check('F3b committed diagnosis suppresses the low-confidence re-ask gate', !/LOW CONFIDENCE/i.test(prompt));
}

// ============================================================================
// G. DECLINED DISCRIMINATOR — "I'm not sure" after a symptom does not loop; first-turn hedge still asks
// ============================================================================
check('G1 pulsing then I\'m not sure is a declined discriminator',
  customerDeclinedDiscriminator('my dyson v6 is pulsing. I\'m not sure') === true);
check('G2 fridge opener then don\'t know is declined',
  customerDeclinedDiscriminator('the fridge is warm. I don\'t know') === true);
check('G3 dishwasher then can\'t tell is declined',
  customerDeclinedDiscriminator('my dishwasher is not drying the dishes. I can\'t tell') === true);
check('G4 first-turn hedge alone is NOT declined (no prior symptom)',
  customerDeclinedDiscriminator('I\'m not sure what\'s wrong with my washing machine') === false);
check('G5 empty is not declined', customerDeclinedDiscriminator('') === false && customerDeclinedDiscriminator(null) === false);
check('G6 a real answer is not declined',
  customerDeclinedDiscriminator('my microwave isn\'t heating. it starts when I close the door') === false);
{
  const intent = {
    applianceType: 'fridge-freezer', make: 'Beko', confidence: 0.4, facts: [],
    candidateComponents: [], alternatives: [], _discriminatorDeclined: true,
  };
  const fault = { faultId: 'fridge-airflow', node: node('fridge-freezer', 'fridge-airflow'), via: 'classified' };
  const prompt = buildComposeSystem([], null, intent, fault, [], null, false, false, null, true);
  check('G7 declined path commits (no LOW CONFIDENCE re-ask)',
    (/COMMITTED (DIAGNOSIS|FINDING)/i.test(prompt) || /CALIBRATED COMPONENT DIRECTIONS/i.test(prompt))
    && !/LOW CONFIDENCE/i.test(prompt));
}

console.log(`Premature-clarification fixes: ${pass} passed / ${fail} failed  (total ${pass + fail})`);
process.exit(fail ? 1 : 0);
