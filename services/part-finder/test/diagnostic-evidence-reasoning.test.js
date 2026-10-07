'use strict';
/**
 * Diagnostic evidence reasoning — generic, research-grounded contracts.
 *
 * Guards the coherent improvement: evidence already supplied survives into COMPOSE;
 * ADVICE_ONLY leaders are not delayed by a part-discriminating question; declined
 * discriminators are not re-asked; overheat is heat-present; ignition sparking is
 * not rewritten as a burning smell.
 *
 * Pure functions, no LLM, no network.
 * Run: node services/part-finder/test/diagnostic-evidence-reasoning.test.js
 */
globalThis.awslambda = globalThis.awslambda || { streamifyResponse: (fn) => fn, HttpResponseStream: { from: (s) => s } };
const fs = require('fs');
const path = require('path');
const {
  classifySafetyStop, materialAmbiguity,
  commitFromEvidence, deriveDeclinedFacts, buildComposeSystem, formatTrustedCustomerEvidence,
  normaliseIntent, INTENT_SCHEMA, collectEvidence, adjustDifferential, factConflict, resolveFault,
  neutralizeConditionLimitedFacts, retainCustomerErrorCode,
} = require('../part-finder-lambda.js')._internal;
const CAT = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'faults-catalogue.json'), 'utf8'));

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) pass++;
  else { fail++; console.log('  FAIL:', name, detail !== undefined ? `:: ${JSON.stringify(detail)}` : ''); }
}
const node = (fam, id) => CAT.faults[fam][id];
const facts = (obj) => Object.entries(obj).map(([name, value]) => ({ name, value }));
const amb = (fam, leaderId, obj, declined) => materialAmbiguity(leaderId, node(fam, leaderId), facts(obj), fam, declined);

// ---------------------------------------------------------------------------
// A. Schema: declinedFacts is first-class and carried through normaliseIntent
// ---------------------------------------------------------------------------
check('A1 declinedFacts is a required schema field', (INTENT_SCHEMA.required || []).includes('declinedFacts'));
check('A2 declinedFacts is a declared property', Object.keys(INTENT_SCHEMA.properties || {}).includes('declinedFacts'));
check('A3 normaliseIntent defaults declinedFacts to []', Array.isArray(normaliseIntent({}).declinedFacts) && normaliseIntent({}).declinedFacts.length === 0);
  check('A4 normaliseIntent carries customerTheories', normaliseIntent({ customerTheories: ['I think it is the heater'] }).customerTheories.includes('I think it is the heater'));
check('A5 primaryFindingKind defaults to unknown', normaliseIntent({}).primaryFindingKind === 'unknown');

// ---------------------------------------------------------------------------
// B. Safety: ignition sparking ≠ burning; real fire cues still stop
// ---------------------------------------------------------------------------
check('B1 uncommanded gas-hob sparking is not a burning stop', classifySafetyStop('gas hob sparking on its own like when you turn the knob') === null);
check('B2 socket sparks still stop', (classifySafetyStop('sparks from the plug socket') || {}).category === 'burning');
check('B3 microwave cavity sparking is arcing, not burning', (classifySafetyStop('microwave sparking inside') || {}).category === 'arcing');
check('B4 vacuum sparks still stop (no ignition context)', (classifySafetyStop('the vacuum is sparking') || {}).category === 'burning');
check('B5 hob sparking plus burning smell still stops', (classifySafetyStop('the hob is sparking and smells of burning plastic') || {}).category === 'burning');

// ---------------------------------------------------------------------------
// C. Overheat is positive heat evidence; ADVICE_ONLY leaders are not delayed
// ---------------------------------------------------------------------------
check('C3 ADVICE_ONLY dishwasher poor-drying does not ask heat', amb('dishwasher', 'poor-drying', {}) === null);
check('C4 heating-hardware leader still asks heat', Boolean(amb('dishwasher', 'heating', {})));
check('C5 declined heatPresent is treated as known — heating leader does not re-ask', amb('dishwasher', 'heating', {}, ['heatPresent']) === null);

// ---------------------------------------------------------------------------
// D. Declined discriminator plumbing (conversation already contains our question)
// ---------------------------------------------------------------------------
{
  const convo = [
    'Customer: the dishes stay wet',
    'Advisor asked: At the end of the cycle, is everything warm or hot to the touch but still wet, or does it come out stone cold?',
    "Customer: I don't know",
  ].join('\n');
  const declined = deriveDeclinedFacts(convo);
  check('D1 decline bound to the heat discriminator we asked', declined.includes('heatPresent') || declined.includes('noHeat'), declined);
  check('D2 a decline without our question derives nothing', deriveDeclinedFacts("I don't know").length === 0);
}

// ---------------------------------------------------------------------------
// E. COMPOSE receives structured customer evidence (no raw injection)
// ---------------------------------------------------------------------------
{
  const intent = {
    applianceType: 'oven-cooker',
    make: 'Bosch',
    confidence: 0.6,
    reportedSymptoms: ['grill works', 'fan oven cold'],
    provenGood: ['grill element'],
    alreadyReplaced: ['selector switch'],
    facts: facts({ heatPresent: 'TRUE' }),
    declinedFacts: [],
    candidateComponents: ['fan oven element'],
    nextBestCheck: 'inspect the fan oven element terminals',
    primaryFinding: 'points more towards the fan-oven heating path than a shared supply fault',
  };
  const block = formatTrustedCustomerEvidence(intent);
  check('E1 evidence block includes still-working', /Still working/.test(block) && /grill element/.test(block));
  check('E2 evidence block includes prior replacement without ruling it impossible', /Already replaced/.test(block) && /do not treat as impossible/.test(block));
  check('E3 evidence block includes observed problems', /grill works/.test(block) && /fan oven cold/.test(block));
  const prompt = buildComposeSystem([], null, intent, { faultId: 'element', node: node('oven-cooker', 'element'), via: 'classified' }, [], null, false, false, null, false);
  check('E4 compose prompt includes CUSTOMER EVIDENCE', /CUSTOMER EVIDENCE/.test(prompt));
  check('E5 compose style is calibrated, not stock-culprit', /points more towards|calibrated language|Do NOT manufacture certainty/i.test(prompt));
  check('E6 compose does not require linking a part merely because catalogue data exists', /ONLY when/.test(prompt) && /purchase is appropriate/i.test(prompt));
  check('E7 compose forbids inventing hazards', /never invent smoke/i.test(prompt));
}

// ---------------------------------------------------------------------------
// G. Source guards — no journey ids, no opener phrases
// ---------------------------------------------------------------------------
const SRC = fs.readFileSync(path.join(__dirname, '..', 'part-finder-lambda.js'), 'utf8');
const codeOnly = SRC.split('\n').filter((l) => !l.trim().startsWith('*') && !l.trim().startsWith('//')).join('\n');
check('G1 no RJ / WD-F / DW-G journey ids in product code', !/\bRJ-|WD-F-003|DW-G-002|FF-F-001|OV-F-002|OV-P-001/i.test(codeOnly));
check('G2 no Hoover / Nextra / HNWL opener literals', !/nextra|hnwl7146|coat hanger/i.test(codeOnly));
check('G3 tumble-dryer poor-drying is ADVICE_ONLY (check-first, not a part sale)', node('tumble-dryer', 'poor-drying').outcome === 'ADVICE_ONLY');
check('G4 no brand/code journey literals in product code', !/\bzanussi\b|\bE21\b|on demand/i.test(codeOnly));
check('G5 no fill-then-stop opener literals in product code', !/fills then stops|\bWP-42\b/i.test(codeOnly));

// ---------------------------------------------------------------------------
// H. Same-function "works under some conditions" is not proven-good
// ---------------------------------------------------------------------------
{
  const drain = resolveFault({ applianceType: 'washing-machine', faultId: 'not-draining' });
  const spin = resolveFault({ applianceType: 'washing-machine', faultId: 'motor-drum' });
  const oven = resolveFault({ applianceType: 'oven-cooker', faultId: 'element' });

  const drainAdj = collectEvidence({
    provenGood: ['drain pump', 'pump filter'],
    facts: facts({ drainsNormally: 'TRUE', filterCleaned: 'TRUE' }),
    candidateComponents: ['drain pump', 'pump filter', 'drain hose'],
  }, 'it still stops', drain);
  check('H1 drain-function success does not prove drain parts good',
    !drainAdj.provenGood.some((p) => /pump|filter|hose/i.test(p)), drainAdj);
  check('H2 drain-function success is condition-limited',
    drainAdj.conditionLimited.some((p) => /pump/i.test(p)), drainAdj);
  const drainDiff = adjustDifferential(['drain pump', 'pump filter', 'main pcb'], drainAdj);
  check('H3 condition-limited drain parts stay on the differential',
    drainDiff.includes('drain pump') && drainDiff.includes('pump filter'), drainDiff);

  const spinAdj = collectEvidence({
    provenGood: ['drain pump', 'pump filter'],
    facts: facts({ drainsNormally: 'TRUE' }),
    candidateComponents: ['drive motor', 'drive belt'],
  }, 'it drains but will not spin', spin);
  check('H4 drains-fine on a spin complaint still proves drain parts good',
    spinAdj.provenGood.some((p) => /pump/i.test(p)) && !spinAdj.conditionLimited.some((p) => /pump/i.test(p)), spinAdj);
  const spinDiff = adjustDifferential(['drive motor', 'drain pump', 'drive belt'], spinAdj);
  check('H5 drain parts are removed from a spin differential when they truly drain',
    !spinDiff.includes('drain pump') && spinDiff.includes('drive motor'), spinDiff);

  const ovenAdj = collectEvidence({
    provenGood: ['grill element'],
    facts: facts({ heatsAtAll: 'TRUE' }),
    candidateComponents: ['fan oven element'],
  }, 'grill works, fan oven cold', oven);
  check('H6 a different working mode remains provenGood',
    ovenAdj.provenGood.includes('grill element'), ovenAdj);
  check('H7 heatsAtAll does not prove the failing heating path good',
    ovenAdj.conditionLimited.some((p) => /heater|heating element/i.test(p))
      && !ovenAdj.provenGood.some((p) => /^heater$|heating element/i.test(p)), ovenAdj);
  const ovenDiff = adjustDifferential(['fan oven element', 'grill element'], ovenAdj);
  check('H8 grill is dropped, fan-oven element stays',
    !ovenDiff.includes('grill element') && ovenDiff.includes('fan oven element'), ovenDiff);

  const ungrounded = collectEvidence({
    provenGood: ['drain pump'],
    facts: facts({ drainsNormally: 'TRUE' }),
    candidateComponents: [],
  }, 'it still stops', null);
  check('H9 without a grounded different function, drain success is condition-limited',
    ungrounded.conditionLimited.some((p) => /pump/i.test(p)) && ungrounded.provenGood.length === 0, ungrounded);

  check('H10 drainsNormally still contradicts not-draining when not scoped',
    factConflict(drain.node, facts({ drainsNormally: 'TRUE' })).contradicted === true);
  check('H11 the same fact does not contradict not-draining once condition-limited',
    factConflict(drain.node, facts({ drainsNormally: 'TRUE' }), drainAdj.conditionLimited).contradicted === false);

  const block = formatTrustedCustomerEvidence({
    reportedSymptoms: ['stops mid cycle'],
    provenGood: [],
    conditionLimited: ['drain pump'],
    facts: facts({ drainsNormally: 'TRUE' }),
    checksReported: ['cleaned the filter', 'cleaned the hose'],
  });
  check('H12 condition-limited evidence is not phrased as confirmed healthy',
    /does NOT confirm healthy/.test(block) && /drain pump/.test(block) && !/argues against these as the shared cause: drain pump/.test(block), block);
  check('H13 complete/permanent failure is downranked, intermittent remains',
    /complete\/permanent failure/.test(block) && /intermittent or condition-dependent/.test(block), block);

  const unique = resolveFault({ make: 'Samsung', errorCode: '22E' });
  check('H14 unique make+code resolves without a named family',
    unique && unique.via === 'errorCode' && unique.faultId === 'evaporator-fan', unique);
  const ambiguous = resolveFault({ make: 'Electrolux', errorCode: 'E20' });
  check('H15 a code shared by more than one family does not unique-resolve',
    !(ambiguous && ambiguous.via === 'errorCode'), ambiguous);
  check('H16 an explicit unknown family still does not unique-resolve',
    !resolveFault({ applianceType: 'toaster', make: 'Samsung', errorCode: '22E' }));

  const drainIntent = {
    provenGood: ['drain pump'],
    facts: facts({ drainsNormally: 'TRUE', waterRemaining: 'FALSE' }),
    candidateComponents: ['drain pump'],
  };
  const drainAdj2 = collectEvidence(drainIntent, 'it still stops', drain);
  neutralizeConditionLimitedFacts(drainIntent, drain.node, drainAdj2.conditionLimited);
  check('H17 condition-limited works-fact is not left TRUE',
    drainIntent.facts.find((f) => f.name === 'drainsNormally').value === 'UNKNOWN', drainIntent.facts);
  check('H18 paired empty-vessel FALSE is not left established',
    drainIntent.facts.find((f) => f.name === 'waterRemaining').value === 'UNKNOWN', drainIntent.facts);
  const block2 = formatTrustedCustomerEvidence({
    ...drainIntent,
    provenGood: drainAdj2.provenGood,
    conditionLimited: drainAdj2.conditionLimited,
    reportedSymptoms: ['still stops'],
  });
  check('H19 compose evidence does not say it drains normally as established fact',
    !/Established as true:.*it drains normally/i.test(block2) && /does NOT confirm healthy/.test(block2), block2);

  const spinIntent = {
    provenGood: ['drain pump'],
    facts: facts({ drainsNormally: 'TRUE', waterRemaining: 'FALSE' }),
    candidateComponents: ['drive motor'],
  };
  const spinAdj2 = collectEvidence(spinIntent, 'it drains but will not spin', spin);
  neutralizeConditionLimitedFacts(spinIntent, spin.node, spinAdj2.conditionLimited);
  check('H20 different-function drains-fine stays TRUE on a spin complaint',
    spinIntent.facts.find((f) => f.name === 'drainsNormally').value === 'TRUE', spinIntent.facts);

  const commanded = collectEvidence({
    provenGood: [],
    facts: facts({ commandedDrain: 'TRUE', waterEntering: 'TRUE' }),
    candidateComponents: [],
  }, 'it still stops after filling', null);
  check('H21 commanded drain success is condition-limited, not proven-good',
    commanded.conditionLimited.some((p) => /pump/i.test(p)) && commanded.provenGood.length === 0, commanded);
  check('H22 fill-happened is not treated as a drain proven-good',
    !commanded.provenGood.some((p) => /inlet|valve|pump/i.test(p)), commanded);

  const uniqueNd = resolveFault({ make: 'Zanussi', errorCode: 'E21' });
  const ambNd = uniqueNd && materialAmbiguity(
    uniqueNd.faultId, uniqueNd.node, facts({}), uniqueNd.resolvedAppliance, [],
  );
  check('H21 unique drain code still has a water-remaining discriminator',
    Boolean(ambNd && ambNd.fact === 'waterRemaining'), ambNd);
  const promptAd = buildComposeSystem([], null, {
    applianceType: null, make: 'Samsung', errorCode: '22E', facts: [],
    _areaDiscriminator: {
      leaderLabel: 'Not draining / won\'t empty',
      altLabel: 'Motor / drum',
      fact: 'waterRemaining',
      question: 'Is there water left standing in the bottom, or does it drain away fully?',
    },
    conditionLimited: ['drain pump'],
    reportedSymptoms: ['still stops'],
  }, uniqueNd, [], null, false, false, null, false);
  check('H22 area-discriminator compose keeps the code area and one question',
    /ERROR-CODE AREA, THEN ONE DISCRIMINATOR/.test(promptAd)
    && /Do NOT pivot to a different function/.test(promptAd)
    && /water left standing/.test(promptAd), promptAd.slice(0, 200));
}

{
  const inferred = { errorCode: 'E20' };
  retainCustomerErrorCode(inferred, 'cleaned filter, E21 still showing, drain works on demand', {});
  check('I1 a retrieved sibling alias does not replace the customer code',
    inferred.errorCode === 'E21', inferred.errorCode);
  const keep = { errorCode: 'E21' };
  retainCustomerErrorCode(keep, 'E21 still stops after the filter was cleaned', {});
  check('I2 the customer code is left alone when UNDERSTAND already has it', keep.errorCode === 'E21');
  const corrected = { errorCode: 'E20' };
  retainCustomerErrorCode(corrected, 'it was E21, actually it is E15 now', {});
  check('I3 an inferred code not in the customer text restores the latest customer code',
    corrected.errorCode === 'E15', corrected.errorCode);
  const compound = { errorCode: 'E36' };
  retainCustomerErrorCode(compound, 'Bosch E36/E10, won\'t spin', {});
  check('I4 compound upgrade from the same customer text is still allowed',
    compound.errorCode === 'E36/E10', compound.errorCode);
  const suffix = { errorCode: 'E10' };
  retainCustomerErrorCode(suffix, 'mums bosch, code e36 or e10 flashing, wont spin', {});
  check('I4b a suffix fragment of the same spoken compound is restored to the whole code',
    suffix.errorCode === 'E36/E10', suffix.errorCode);
  // I5 removed: applyEstablishedAppliance (prose family strip) is deleted — "a code plus mechanical
  // words does not establish a family" is now Jev's typed applianceFamily judgement.
}

// ---------------------------------------------------------------------------
// J. Explicit positive observations constrain diagnosis (do not invert them)
// ---------------------------------------------------------------------------
{
  const {
    invertedStemsAgainst, constrainByPositiveObservations, dropUnstatedComponentHum,
  } = require('../part-finder-lambda.js')._internal;

  check('J1 a positive lock is not the negated lock claim',
    invertedStemsAgainst('it locks and hums', ["door won't lock"]).includes('lock'));
  check('J2 a matching negated report is not an inversion',
    invertedStemsAgainst("won't start the cycle", ["won't start"]).length === 0);
  check('J3 mixed: lock is inverted, start is aligned', (() => {
    const stems = invertedStemsAgainst("locks and hums, won't start", ["door won't lock", "won't start"]);
    return stems.includes('lock') && !stems.includes('start');
  })());
  check('J4 fan running inverts a not-running claim',
    invertedStemsAgainst('the fan runs', ['fan not running']).includes('run'));
  check('J5 heater getting hot inverts a not-heating claim',
    invertedStemsAgainst('the heater gets hot', ['not heating', "isn't heating"]).includes('heat'));
  check('J6 pump running inverts a not-running claim',
    invertedStemsAgainst('the pump runs', ['pump not running']).includes('run'));

  const door = resolveFault({ applianceType: 'washing-machine', faultId: 'door-lock' });
  const intent = {
    applianceType: 'washing-machine',
    fault: "door won't lock",
    facts: [{ name: 'humNoise', value: 'TRUE' }],
    alternatives: ['inlet-valve'],
    candidateComponents: ['door interlock'],
    nextBestCheck: 'press the door firmly',
    primaryFinding: 'the door is failing to lock',
  };
  const metric = {};
  const out = constrainByPositiveObservations(
    intent, door, "it locks and hums, won't start the wash",
    [{ label: door.node.label, symptoms: door.node.synonyms }], metric,
  );
  check('J7 inverted complete-failure is ungrounded', out === null, out);
  check('J8 inverted free-text fault is cleared', intent.fault == null, intent.fault);
  check('J9 lock is preserved as a positive observation',
    Array.isArray(intent._positiveObservations) && intent._positiveObservations.includes('lock'), intent._positiveObservations);
  check('J10 the ungrounded node stays as a conditional alternative',
    intent.alternatives.includes('door-lock'), intent.alternatives);
  check('J11 next discriminator localises what happens after the observed function',
    /water start coming into the machine/i.test(intent.clarifyingQuestion), intent.clarifyingQuestion);
  check('J12 no door-pressure check survives as nextBestCheck', intent.nextBestCheck == null);
  check('J13 compose is told not to invert and to ask the discriminator', (() => {
    const prompt = buildComposeSystem([], null, intent, null, [], null, false, false, null, false);
    return /POSITIVE OBSERVATION — ASK WHAT HAPPENS NEXT/.test(prompt)
      && /NEVER invert an established positive observation/.test(prompt)
      && /water start coming into the machine/i.test(prompt)
      && /do NOT rewrite as the opposite failure/.test(prompt);
  })());
  check('J13b compose context asks only the localising question', (() => {
    const { buildComposeContext } = require('../part-finder-lambda.js')._internal;
    const ctx = buildComposeContext(intent, null, null, false, { mention: 'none', purchaseAppropriate: false });
    const text = ctx && ctx[0] && ctx[0].content;
    return /POSITIVE OBSERVATION/.test(text)
      && /water start coming into the machine/i.test(text)
      && !/subsystem \/ test-plan/.test(text);
  })());

  const humIntent = { facts: [{ name: 'drainPumpHumming', value: 'TRUE' }, { name: 'humNoise', value: 'TRUE' }] };
  dropUnstatedComponentHum(intent, 'it locks and hums', [{ name: 'humNoise', value: 'TRUE' }]);
  dropUnstatedComponentHum(humIntent, 'it locks and hums', [{ name: 'humNoise', value: 'TRUE' }]);
  check('J14 unlocalised hum is not rewritten as a named-component hum',
    humIntent.facts.find((f) => f.name === 'drainPumpHumming').value === 'UNKNOWN', humIntent.facts);
  const pumpNamed = { facts: [{ name: 'pumpHumming', value: 'TRUE' }] };
  dropUnstatedComponentHum(pumpNamed, 'the pump just hums', [{ name: 'humNoise', value: 'TRUE' }]);
  check('J15 a customer-named pump hum is kept',
    pumpNamed.facts.find((f) => f.name === 'pumpHumming').value === 'TRUE');

  // J16 removed: customerNamedApplianceFamily (prose family classification) is deleted — establishing
  // the laundry family from wash-cycle wording is now Jev's typed applianceFamily.

  const {
    askedDiscriminatorFact, conversationProgress,
    applyFollowUpNextAction, buildComposeContext,
  } = require('../part-finder-lambda.js')._internal;
  const fillQ = 'Does any water start coming into the machine, or does it just sit there without filling?';
  const t2progress = conversationProgress([
    { role: 'user', content: "Hotpoint locks and hums, won't start the wash." },
    { role: 'assistant', content: fillQ },
    { role: 'user', content: 'nothing happens' },
  ]);
  check('J20 the asked discriminator is recovered from the prior advisor turn',
    askedDiscriminatorFact(t2progress) === 'waterEntering');

  const t2intent = {
    applianceType: 'washing-machine',
    userIntent: 'EVIDENCE_UPDATE',
    fault: "door won't lock",
    facts: [{ name: 'humNoise', value: 'TRUE' }, { name: 'waterEntering', value: 'FALSE' }],
    alternatives: ['inlet-valve'],
    candidateComponents: ['door interlock'],
    clarifyingQuestion: fillQ,
    nextBestCheck: fillQ,
    nextCheckCustomerSafe: true,
    primaryFinding: 'the door is failing to lock',
  };
  const t2metric = {};
  const t2out = constrainByPositiveObservations(
    t2intent, door, "Hotpoint locks and hums, won't start the wash. nothing happens",
    [{ label: door.node.label, symptoms: door.node.synonyms }], t2metric, t2progress,
  );
  check('J22 T2 still ungrounds inverted lock failure', t2out === null, t2out);
  check('J23 T2 does not re-ask the fill discriminator',
    !t2intent._observationAmbiguity
    && !/water start coming into the machine/i.test(t2intent.clarifyingQuestion || ''),
    t2intent.clarifyingQuestion);
  check('J24 T2 records the answered discriminator',
    t2intent._discriminatorJustAnswered === 'waterEntering', t2intent._discriminatorJustAnswered);
  check('J25 lock remains a positive observation after the answer',
    Array.isArray(t2intent._positiveObservations) && t2intent._positiveObservations.includes('lock'));
  applyFollowUpNextAction(t2intent, t2progress, {});
  check('J26 after the fill answer, next action is not the same question',
    !/water start coming into the machine/i.test(t2intent.clarifyingQuestion || '')
    && !/water start coming into the machine/i.test(t2intent.nextBestCheck || ''));
  check('J26b remaining work goes to identification, not a part',
    t2intent._nextAction === 'identification'
    && /model/i.test(t2intent.clarifyingQuestion || t2intent.nextBestCheck || ''),
    { next: t2intent.nextBestCheck, q: t2intent.clarifyingQuestion, action: t2intent._nextAction });
  check('J27 compose progresses instead of re-asking', (() => {
    const prompt = buildComposeSystem([], null, t2intent, null, [], null, false, false, null, false, { mention: 'none', purchaseAppropriate: false }, t2progress);
    const ctx = buildComposeContext(t2intent, null, null, false, { mention: 'none', purchaseAppropriate: false }, t2progress);
    const text = ctx && ctx[0] && ctx[0].content;
    return /DISCRIMINATOR ANSWERED/.test(prompt)
      && /did not happen/i.test(prompt)
      && /do not recommend, name, or link a part/i.test(prompt)
      && !/POSITIVE OBSERVATION — ASK WHAT HAPPENS NEXT/.test(prompt)
      && /DISCRIMINATOR ANSWERED/.test(text)
      && !/water start coming into the machine/i.test(text);
  })());
}

console.log(`\ndiagnostic-evidence-reasoning: ${pass} passed / ${fail} failed`);
process.exit(fail ? 1 : 0);
