/**
 * CANNOT-ANSWER PROGRESSION — general, not journey-specific.
 *
 * When WhichPart asks a discriminator and the customer cannot (or will not) answer it, it must
 * NEVER re-ask the same thing. The policy is driven by Jev's TYPED cannot-answer signal plus the
 * STRUCTURAL identity of the discriminator the prior advisor turn asked (askedDiscriminatorFact) —
 * NOT by phrase/regex matching of "I'm not sure" and NOT by comparing raw assistant-text strings.
 *
 * This exercises the pure, exported building blocks of that policy:
 *   1. askedDiscriminatorFact recovers WHICH typed discriminator was asked (structural identity).
 *   2. materialAmbiguity suppresses a declined discriminator fact (and never re-offers it).
 *   3. progressAfterDeclinedDiscriminator grounds on the TYPED cannot-answer flag even when the
 *      legacy prose regex misses the sparse reply, and stays a no-op when nothing was declined.
 *
 *   node services/part-finder/test/cannot-answer-progression.test.js
 */
globalThis.awslambda = globalThis.awslambda || { streamifyResponse: (fn) => fn, HttpResponseStream: { from: (s) => s } };
const fs = require('fs');
const path = require('path');
const {
  askedDiscriminatorFact, materialAmbiguity, progressAfterDeclinedDiscriminator,
  customerDeclinedDiscriminator, discriminatorQuestionText, commitFromEvidence,
  allAskedDiscriminatorFacts,
} = require('../part-finder-lambda.js')._internal;
const CAT = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'faults-catalogue.json'), 'utf8'));

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; } else { fail++; console.log('  FAIL:', name, detail !== undefined ? ` :: ${JSON.stringify(detail)}` : ''); }
}
const node = (fam, id) => CAT.faults[fam][id];
const facts = (obj) => Object.entries(obj).map(([name, value]) => ({ name, value }));

// ============================================================================
// A. Structural identity: which typed discriminator did the prior advisor turn ask?
// ============================================================================
{
  const q = discriminatorQuestionText('grindingNoise');
  check('A0 grindingNoise discriminator question exists', typeof q === 'string' && q.length > 10, q);
  // The prior advisor reply carried the typed discriminator; recover its fact id from STRUCTURE.
  const prior = `Thanks. ${q} Let me know which it sounds like.`;
  check('A1 askedDiscriminatorFact recovers the typed fact from the prior advisor turn',
    askedDiscriminatorFact({ priorAdvisorText: prior }) === 'grindingNoise',
    askedDiscriminatorFact({ priorAdvisorText: prior }));
  check('A2 no prior advisor text -> no pending discriminator',
    askedDiscriminatorFact({ priorAdvisorText: '' }) === null);
}

// ============================================================================
// B. Suppression: a declined discriminator fact is never re-offered
// ============================================================================
// DW-015: circulation-pump leader vs foreign-object, separated by grindingNoise. Normally fires.
{
  const asked = materialAmbiguity('circulation-pump', node('dishwasher', 'circulation-pump'),
    facts({ noiseOnWash: 'TRUE' }), 'dishwasher', []);
  check('B1 the discriminator fires when nothing is declined (control)',
    asked && asked.fact === 'grindingNoise', asked && asked.fact);
  // The SAME turn, with that discriminator fact now in declinedFacts, must NOT be re-offered.
  const suppressed = materialAmbiguity('circulation-pump', node('dishwasher', 'circulation-pump'),
    facts({ noiseOnWash: 'TRUE' }), 'dishwasher', ['grindingNoise']);
  check('B2 the declined discriminator is suppressed (no re-ask of the same fact)',
    suppressed === null || (suppressed && suppressed.fact !== 'grindingNoise'),
    suppressed && suppressed.fact);
}

// ============================================================================
// B'. Cross-turn memory: a discriminator asked two turns ago is not forgotten
// ============================================================================
{
  // Advisor asked grindingNoise (turn 1) then the timing discriminator (turn 2). On a later
  // cannot-answer, BOTH must be retired so neither resurfaces (the B T3 loop we observed live).
  const q1 = discriminatorQuestionText('grindingNoise');
  const q2 = discriminatorQuestionText('noiseOnDrain');
  const messages = [
    { role: 'user', content: 'my dishwasher is noisy during the wash' },
    { role: 'assistant', content: `Thanks. ${q1}` },
    { role: 'user', content: "I'm not sure" },
    { role: 'assistant', content: `To help narrow this down, ${q2}` },
    { role: 'user', content: "I still can't say" },
  ];
  const asked = allAskedDiscriminatorFacts(messages);
  check("B'1 recovers the discriminator asked two turns ago (grindingNoise)", asked.includes('grindingNoise'), asked);
  check("B'2 recovers the discriminator asked last turn (noiseOnDrain/noiseOnWash)",
    asked.includes('noiseOnDrain') || asked.includes('noiseOnWash'), asked);
  // With BOTH retired, materialAmbiguity has no further alternative for the DW-015 pair -> grounds.
  const suppressed = materialAmbiguity('circulation-pump', node('dishwasher', 'circulation-pump'),
    facts({ noiseOnWash: 'TRUE' }), 'dishwasher', asked);
  check("B'3 both-retired -> no further discriminator (grounds to most-likely)",
    suppressed === null || (suppressed && suppressed.fact !== 'grindingNoise'), suppressed && suppressed.fact);
}
{
  // No assistant turns yet -> nothing asked.
  check("B'4 opening thread has no asked discriminators",
    allAskedDiscriminatorFacts([{ role: 'user', content: 'my dishwasher is noisy' }]).length === 0);
}

// ============================================================================
// C. Typed cannot-answer grounds even when the prose regex misses the sparse reply
// ============================================================================
// A sparse reply the legacy regex does NOT classify as a decline.
const SPARSE = 'hmm, hard to say really';
check('C0 the sparse reply is NOT caught by the prose regex (so the typed signal must drive it)',
  customerDeclinedDiscriminator(SPARSE) === false);

{
  // Typed cannot-answer = true -> ground to the kept leader and clear the ask flags.
  const intent = {
    applianceType: 'dishwasher', needMoreInfo: true,
    clarifyingQuestion: discriminatorQuestionText('grindingNoise'),
    _materialAmbiguity: { fact: 'grindingNoise', question: 'x' }, facts: [],
  };
  const fault = { faultId: 'circulation-pump', node: node('dishwasher', 'circulation-pump'), via: 'classified' };
  const r = progressAfterDeclinedDiscriminator(intent, fault, [], SPARSE, true);
  check('C1 typed cannot-answer progresses even though the regex missed', r.progressed === true);
  check('C2 keeps the existing leader', r.fault && r.fault.faultId === 'circulation-pump', r.fault && r.fault.faultId);
  check('C3 clears the clarifying question (no re-ask)', intent.clarifyingQuestion === null);
  check('C4 clears needMoreInfo', intent.needMoreInfo === false);
  check('C5 clears the material-ambiguity ask', intent._materialAmbiguity === undefined);
  check('C6 marks declined so COMPOSE states the most-likely cause', intent._discriminatorDeclined === true);
}

{
  // No typed cannot-answer AND the prose regex misses -> stay a no-op, keep asking.
  const intent = {
    applianceType: 'dishwasher', needMoreInfo: true,
    clarifyingQuestion: discriminatorQuestionText('grindingNoise'), facts: [],
  };
  const r = progressAfterDeclinedDiscriminator(intent, null, [], SPARSE, false);
  check('C7 no decline (typed false + regex miss) -> no-op', r.progressed === false);
  check('C8 the pending question is left in place', intent.clarifyingQuestion !== null);
}

// ============================================================================
// D. First-turn hedge is never a decline (no pending discriminator to retire)
// ============================================================================
check('D1 first-turn hedge is not a prose decline',
  customerDeclinedDiscriminator("I'm not sure what's wrong with my dishwasher") === false);
check('D2 a first turn has no recoverable pending discriminator',
  askedDiscriminatorFact({ priorAdvisorText: '' }) === null);

// ============================================================================
// E. Checks-not-done turn count bounds the "re-assert the same check" path
// ============================================================================
{
  const { checksNotDoneTurnCount } = require('../part-finder-lambda.js')._internal;
  const oneNotDone = [
    { role: 'user', content: "my washing machine won't drain" },
    { role: 'assistant', content: 'Open the pump filter...' },
    { role: 'user', content: "I haven't checked the filter yet" },
  ];
  check('E1 a single not-done turn counts once (first nudge is allowed)', checksNotDoneTurnCount(oneNotDone) === 1);
  const twoNotDone = oneNotDone.concat([
    { role: 'assistant', content: 'Please open the filter...' },
    { role: 'user', content: "I still haven't managed to look at it" },
  ]);
  check('E2 a second not-done turn trips the repeat bound (>=2 -> advance, do not re-assert)',
    checksNotDoneTurnCount(twoNotDone) >= 2, checksNotDoneTurnCount(twoNotDone));
  check('E3 answers that are not "not done" do not count',
    checksNotDoneTurnCount([{ role: 'user', content: 'the filter was clear' }]) === 0);
}

console.log(`cannot-answer progression: ${pass} passed / ${fail} failed  (total ${pass + fail})`);
if (fail > 0) process.exit(1);
