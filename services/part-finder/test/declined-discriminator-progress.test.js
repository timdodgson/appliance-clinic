/**
 * DECLINED-DISCRIMINATOR PROGRESSION — general, not journey-specific.
 *
 * When a discriminator has already been asked and the customer cannot answer
 * ("I'm not sure" / "don't know"), stop asking and ground from existing evidence.
 * Covers the hole where UNDERSTAND never set `fault` so the old skip never ran.
 *
 * Must NOT treat a first-turn hedge ("I'm not sure what's wrong with my washer")
 * as a declined discriminator. Must still ASK a genuine first discriminator.
 *
 *   node services/part-finder/test/declined-discriminator-progress.test.js
 */
globalThis.awslambda = globalThis.awslambda || { streamifyResponse: (fn) => fn, HttpResponseStream: { from: (s) => s } };
const fs = require('fs');
const path = require('path');
const {
  customerDeclinedDiscriminator, progressAfterDeclinedDiscriminator, materialAmbiguity,
  commitFromEvidence, buildComposeSystem,
} = require('../part-finder-lambda.js')._internal;
const CAT = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'faults-catalogue.json'), 'utf8'));

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; } else { fail++; console.log('  FAIL:', name, detail !== undefined ? ` :: ${JSON.stringify(detail)}` : ''); }
}
const node = (fam, id) => CAT.faults[fam][id];
const facts = (obj) => Object.entries(obj).map(([name, value]) => ({ name, value }));

function intentBase(over) {
  return Object.assign({
    applianceType: 'fridge-freezer',
    needMoreInfo: true,
    clarifyingQuestion: 'Is it just the fridge that is warm while the freezer is still cold, or are both warm?',
    facts: [],
    _materialAmbiguity: { fact: 'fridgeOnlyWarm', question: 'x' },
  }, over);
}

const DECLINED = 'the fridge is warm. I\'m not sure';
const FIRST_HEDGE = 'I\'m not sure what\'s wrong with my washing machine';
const FIRST_SYMPTOM = 'the fridge is warm';

// ============================================================================
// A. Detector: declined vs first-turn hedge vs useful first symptom
// ============================================================================
check('A1 prior symptom + I\'m not sure is declined', customerDeclinedDiscriminator(DECLINED) === true);
check('A2 don\'t know after a symptom is declined',
  customerDeclinedDiscriminator('my dishwasher is not drying the dishes. I don\'t know') === true);
check('A3 first-turn hedge is NOT declined', customerDeclinedDiscriminator(FIRST_HEDGE) === false);
check('A4 first-turn symptom alone is NOT declined', customerDeclinedDiscriminator(FIRST_SYMPTOM) === false);
check('A5 empty is not declined', customerDeclinedDiscriminator('') === false);

// ============================================================================
// B. Already-asked + declined + existing leader → keep it, clear the ask
// ============================================================================
{
  const intent = intentBase();
  const fault = { faultId: 'fridge-airflow', node: node('fridge-freezer', 'fridge-airflow'), via: 'classified' };
  const r = progressAfterDeclinedDiscriminator(intent, fault, [], DECLINED);
  check('B1 progressed', r.progressed === true);
  check('B2 keeps the existing leader', r.fault && r.fault.faultId === 'fridge-airflow', r.fault && r.fault.faultId);
  check('B3 clears clarifyingQuestion', intent.clarifyingQuestion === null);
  check('B4 clears needMoreInfo', intent.needMoreInfo === false);
  check('B5 clears material-ambiguity ask', intent._materialAmbiguity === undefined);
  check('B6 marks declined so COMPOSE states a calibrated most-likely', intent._discriminatorDeclined === true);
}

// ============================================================================
// C. Ungrounded leader (UNDERSTAND never set fault) — ground from existing sources
// ============================================================================
{
  const intent = intentBase({ applianceType: 'fridge-freezer', faultId: 'not-cooling' });
  const r = progressAfterDeclinedDiscriminator(intent, null, [], DECLINED);
  check('C1 faultId resolves when fault object is null', r.fault && r.fault.faultId === 'not-cooling', r.fault && r.fault.faultId);
  check('C2 via classified', r.fault && r.fault.via === 'classified');
  check('C3 ask flags cleared', intent.needMoreInfo === false && intent.clarifyingQuestion === null);
}
{
  const intent = intentBase({
    applianceType: 'washing-machine',
    faultId: null,
    facts: facts({ grindingNoise: 'TRUE', noiseOnSpin: 'TRUE' }),
    clarifyingQuestion: 'Is it a grind or a hum?',
  });
  const r = progressAfterDeclinedDiscriminator(intent, null, [], 'a loud grinding noise on the spin. I\'m not sure');
  check('C4 commitFromEvidence grounds when UNDERSTAND left fault null',
    r.fault && r.fault.faultId === 'motor-drum', r.fault && r.fault.faultId);
  check('C5 evidence-commit via', r.fault && r.fault.via === 'evidence-commit');
}
{
  const intent = intentBase({ applianceType: 'fridge-freezer', faultId: null, facts: [] });
  const docs = [
    { knowledgeId: 'fridge-freezer:fridge-airflow', faultId: 'fridge-airflow' },
    { knowledgeId: 'fridge-freezer:defrost-system', faultId: 'defrost-system' },
  ];
  const r = progressAfterDeclinedDiscriminator(intent, null, docs, DECLINED);
  check('C6 retrieval rank-1 is the family leader when nothing else grounded',
    r.fault && r.fault.faultId === 'fridge-airflow', r.fault && r.fault.faultId);
  check('C7 does not skip to a later doc', r.fault && r.fault.faultId !== 'defrost-system');
}
{
  const intent = intentBase({ applianceType: 'fridge-freezer', faultId: null, facts: [] });
  const docs = [{ knowledgeId: 'washing-machine:not-draining', faultId: 'not-draining' }];
  const r = progressAfterDeclinedDiscriminator(intent, null, docs, DECLINED);
  check('C8 other-family retrieval docs are not used', r.fault === null);
  check('C9 still progressed (ask flags cleared, no fabricated node)', r.progressed === true && intent.clarifyingQuestion === null);
}

// ============================================================================
// D. First-turn generic uncertainty still behaves normally (does NOT progress)
// ============================================================================
{
  const intent = intentBase({ applianceType: 'washing-machine', clarifyingQuestion: 'What is it doing?' });
  const r = progressAfterDeclinedDiscriminator(intent, null, [], FIRST_HEDGE);
  check('D1 first-turn hedge does not progress', r.progressed === false);
  check('D2 clarifyingQuestion left in place', intent.clarifyingQuestion === 'What is it doing?');
  check('D3 needMoreInfo left in place', intent.needMoreInfo === true);
  check('D4 _discriminatorDeclined not set', intent._discriminatorDeclined !== true);
}

// ============================================================================
// E. Genuine first discriminator still asks (no regression)
// ============================================================================
{
  const amb = materialAmbiguity(
    'evaporator-fan',
    node('fridge-freezer', 'evaporator-fan'),
    facts({ fridgeOnlyWarm: 'TRUE' }),
    'fridge-freezer',
  );
  check('E1 fridge-only still asks heavy-ice (first discriminator still useful)',
    amb && amb.fact === 'heavyIce', amb && amb.fact);
  const intent = intentBase({ clarifyingQuestion: 'keep me' });
  const fault = { faultId: 'evaporator-fan', node: node('fridge-freezer', 'evaporator-fan'), via: 'classified' };
  const r = progressAfterDeclinedDiscriminator(intent, fault, [], FIRST_SYMPTOM);
  check('E2 first-turn symptom does not consume the leader via declined-progress',
    r.progressed === false && r.fault && r.fault.faultId === 'evaporator-fan');
  check('E3 first-turn symptom leaves the ask in place', intent.clarifyingQuestion === 'keep me');
}
{
  const amb = materialAmbiguity('not-heating', node('microwave', 'not-heating'), [], 'microwave');
  check('E4 microwave not-heating with unknown door-state still asks (useful clarification)',
    Boolean(amb), amb && amb.fact);
}

// ============================================================================
// F. COMPOSE: declined path is calibrated most-likely, not a re-ask, no fake certainty block
// ============================================================================
{
  const intent = intentBase({
    applianceType: 'fridge-freezer',
    confidence: 0.4,
    facts: [],
    candidateComponents: [],
    alternatives: [],
    _discriminatorDeclined: true,
  });
  const fault = { faultId: 'fridge-airflow', node: node('fridge-freezer', 'fridge-airflow'), via: 'classified' };
  const prompt = buildComposeSystem([], null, intent, fault, [], null, false, false, null, true);
  check('F1 committed finding (calibrated most-likely / subsystem grain)',
    /COMMITTED (DIAGNOSIS|FINDING)/i.test(prompt) || /CALIBRATED COMPONENT DIRECTIONS/i.test(prompt));
  check('F2 LOW CONFIDENCE re-ask is suppressed', !/LOW CONFIDENCE/i.test(prompt));
}

console.log(`Declined-discriminator progress: ${pass} passed / ${fail} failed  (total ${pass + fail})`);
process.exit(fail ? 1 : 0);
