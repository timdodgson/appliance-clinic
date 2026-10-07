'use strict';
/**
 * Milestone #50 contracts — general evidence, identity, safety and progression.
 * No journey IDs, no opener matching, no appliance-specific behavioural hacks.
 *
 * Run: node services/part-finder/test/diagnostic-milestone-contracts.test.js
 */
globalThis.awslambda = globalThis.awslambda || {
  streamifyResponse: (fn) => fn,
  HttpResponseStream: { from: (s) => s },
};
const {
  EVIDENCE_KIND, COMPONENT_MENTION,
  lockApplianceType, resolveEstablishedFamily: _resolveEstablishedFamily,
  captureQuestionedCause, demotePrematurePartRequest,
  preferNotRepeatIntervention, preferConditionDiscriminator,
  preferRelatedFunctionDiscriminator, microwaveHeatingHvBoundaryApplies, stripMicrowaveHvDiy, ensureNonTerminalProgression,
  replyIsAcknowledgementOnly, formatTrustedCustomerEvidence, buildComposeSystem,
  classifySafetyStop, classifyRemoteActionClass, computePresentationGrain,
  conversationProgress,
  collectEvidence, guessErrorCode, preferFamilyBeforeSpecificDiagnosis, stripModelAskOnProfessionalBoundary,
  buildComposeContext,
  stripInstructionEcho, productIdentitySufficient, customerFacingNextCheck,
  identificationIsNextAction, applyFollowUpNextAction,
} = require('../part-finder-lambda.js')._internal;
const { extractModelTokenFromText, constrainReplyToIdentity, resolveConversationIdentity: _resolveConversationIdentity, familySpecificCatalogueTermsIn } = require('../identity.js');
const { withJevSim } = require('./_jev-sim.js');
const resolveEstablishedFamily = withJevSim(_resolveEstablishedFamily);
const resolveConversationIdentity = withJevSim(_resolveConversationIdentity);

let pass = 0;
let fail = 0;
function check(name, cond, detail) {
  if (cond) pass += 1;
  else {
    fail += 1;
    console.log('  FAIL:', name, detail !== undefined ? `:: ${JSON.stringify(detail)}` : '');
  }
}

check('K1 hypothesis and intervention kinds exist',
  EVIDENCE_KIND.HYPOTHESIS === 'HYPOTHESIS'
  && EVIDENCE_KIND.INTERVENTION_RESULT === 'INTERVENTION_RESULT');

{
  const messages = [
    { role: 'user', content: 'Fridge warm, freezer fine.' },
    { role: 'assistant', content: 'Can you hear a fan running at the back of the fridge?' },
    { role: 'user', content: 'Yes, I can hear the fan running.' },
  ];
  const latest = 'Yes, I can hear the fan running.';
  const intent = { applianceType: 'washing-machine', _applianceUnconfirmed: false };
  // I1 removed: applyEstablishedAppliance (prose family strip/override) is deleted — a short follow-up
  // not re-establishing a family is now Jev's typed provenance. The conversation lock (I2/I3) still
  // restores the established family from the typed identity.
  lockApplianceType(intent, resolveEstablishedFamily({ messages, queryText: latest }), []);
  check('I2 conversation lock restores fridge-freezer', intent.applianceType === 'fridge-freezer');
  check('I3 lock clears unconfirmed flag', intent._applianceUnconfirmed === false);
}

{
  const compose = buildComposeSystem(
    [],
    null,
    {
      applianceType: 'fridge-freezer',
      primaryFinding: 'internal evaporator fan fault',
      primaryFindingKind: 'subsystem',
      candidateComponents: ['evaporator fan'],
    },
    { faultId: 'evaporator-fan', node: { label: 'INTERNAL (EVAPORATOR) FAN FAULT', components: ['evaporator fan'] }, via: 'classified' },
    [], null, false, false, null, false,
    { mention: COMPONENT_MENTION.NONE, purchaseAppropriate: false, committedComponent: false },
  );
  check('H1 uncommitted finding is a working hypothesis, not a confirmed headline',
    /LEADING WORKING HYPOTHESIS/i.test(compose)
    && !/PRIMARY ENGINEERING FINDING \(LEAD WITH THIS\)/.test(compose));
  check('H2 retrieved node title is framed as hypothesis not customer fact',
    /HYPOTHESIS|retrieved working/i.test(compose));
}

{
  const intent = { userIntent: 'PART_REQUEST', customerTheories: [], candidateComponents: [] };
  captureQuestionedCause(intent, 'Leaking from the bottom of the door, is it the seal?');
  check('P1 seal question is captured as a theory',
    (intent.customerTheories || []).some((t) => /seal/i.test(t)));
  demotePrematurePartRequest(intent, 'Leaking from the bottom of the door, is it the seal?');
  check('P2 proposed seal does not stay a parts-desk purchase without family/model',
    intent.userIntent !== 'PART_REQUEST');
}

{
  const intent = {
    primaryFindingKind: 'component',
    candidateComponents: ['drain pump', 'thermal cut-out'],
    conditionLimited: ['drain pump'],
    _nextAction: 'advice',
  };
  preferConditionDiscriminator(intent);
  check('C1 condition-limited evidence does not keep a component finding',
    intent.primaryFindingKind !== 'component' && intent.candidateComponents.length === 0);
}

{
  const trip = classifySafetyStop('Cleared the drain, then it tripped the house electrics.');
  check('S1 drain-then-trip remains an electrical stop', (trip || {}).category === 'electrical');
  const grain = computePresentationGrain({
    intent: { primaryFindingKind: 'component', candidateComponents: ['drain pump'] },
    fault: { via: 'classified', node: { label: 'Not draining', components: ['drain pump'] } },
    committedFinding: true,
    safetyStop: 'electrical',
    outcome: 'SAFETY_STOP',
    queryText: 'Cleared the drain, then it tripped the house electrics.',
  });
  check('S2 safety stop withholds component mention', grain.mention === COMPONENT_MENTION.NONE);
}

{
  // Story 2: the runs-but-cold observation is now supplied authoritatively by Jev's typed
  // evidence (runsNormally + noHeat), not re-parsed from prose here. These assert the CONSUMER.
  const mwIntent = {
    applianceType: 'microwave',
    facts: [{ name: 'runsNormally', value: 'TRUE' }, { name: 'noHeat', value: 'TRUE' }],
  };
  check('M1 runs-but-cold (Jev facts) is an HV professional boundary',
    microwaveHeatingHvBoundaryApplies(mwIntent, 'Microwave runs, food stays cold.') === true);
  check('M5 HV boundary reads the Jev heat-state facts, not customer prose',
    microwaveHeatingHvBoundaryApplies({ applianceType: 'microwave', facts: [] }, 'Microwave runs, food stays cold.') === false
    && microwaveHeatingHvBoundaryApplies(
      { applianceType: 'microwave', facts: [{ name: 'runsNormally', value: 'TRUE' }, { name: 'noHeat', value: 'TRUE' }] }, '') === true);
  const doorIntent = {
    applianceType: 'microwave',
    facts: [{ name: 'doorStartProblem', value: 'TRUE' }],
  };
  check('M2 door-start path is not the HV internals boundary',
    microwaveHeatingHvBoundaryApplies(doorIntent, 'It only starts when I jiggle the door') === false);
  const stripped = stripMicrowaveHvDiy(
    'Unplug it, take the cover off and discharge the capacitor so you can test the magnetron.',
  );
  check('M3 DIY HV test/access language is stripped',
    !/discharge the capacitor/i.test(stripped) && !/test the magnetron/i.test(stripped));
  check('M4 HV boundary is competent-person, not a DIY path',
    classifyRemoteActionClass({ diagnoseStop: 'hv-boundary', applianceType: 'microwave' }) === 'COMPETENT_PERSON');
  check('M9 runs-normally + no-heat Jev facts are HV',
    microwaveHeatingHvBoundaryApplies(
      { applianceType: 'microwave', facts: [{ name: 'runsNormally', value: 'TRUE' }, { name: 'noHeat', value: 'TRUE' }] },
      'Our microwave operates as usual, yet nothing comes out hot.',
    ) === true);
  check('M10 running with no heat (Jev facts) is HV',
    microwaveHeatingHvBoundaryApplies(
      { applianceType: 'microwave', facts: [{ name: 'runsNormally', value: 'TRUE' }, { name: 'noHeat', value: 'TRUE' }] },
      'It is running but nothing I heat comes out warm.',
    ) === true);
  // M11: the microwave HV boundary follows Jev's TYPED family. When the customer names a microwave,
  // Jev types applianceType 'microwave' (there is no separate prose-inferred family to conflict with).
  check('M11 Jev-typed microwave family drives the HV boundary',
    microwaveHeatingHvBoundaryApplies(
      { applianceType: 'microwave', facts: [{ name: 'runsNormally', value: 'TRUE' }, { name: 'noHeat', value: 'TRUE' }] },
      'Our microwave operates as usual, yet nothing comes out hot.',
    ) === true);
  check('M12 operate-without-heat is not the same as a rattling-but-heating microwave',
    microwaveHeatingHvBoundaryApplies(
      { applianceType: 'microwave', facts: [{ name: 'runsNormally', value: 'TRUE' }] },
      'The microwave runs normally but rattles a bit.',
    ) === false);
  check('M13 door-start still is not the HV internals boundary',
    microwaveHeatingHvBoundaryApplies(
      { applianceType: 'microwave', facts: [] },
      'It only starts when I jiggle the door — nothing comes out hot until then.',
    ) === false);
  const hvCompose = buildComposeSystem(
    [], null,
    {
      applianceType: 'microwave',
      _materialAmbiguity: { leaderLabel: 'heating', altLabel: 'door', question: 'Describe the problem a bit more?' },
    },
    null, [], null, false, false, 'hv-boundary',
  );
  check('M14 HV compose does not ask a material discriminator',
    /PROFESSIONAL-ONLY BOUNDARY/i.test(hvCompose) && !/ASK ONE DISCRIMINATING QUESTION FIRST/i.test(hvCompose));
}

{
  check('N1 acknowledgement-only replies are detected',
    replyIsAcknowledgementOnly('Thanks for confirming that the grill is working while the fan oven isn’t heating;') === true);
  const progressed = ensureNonTerminalProgression(
    'Thanks for confirming that the grill is working while the fan oven isn’t heating;',
    { nextBestCheck: 'Does the fan oven stay cold on a fan-only programme, or is there any warmth at the back?' },
    {},
  );
  check('N2 acknowledgement-only follow-up gains a next action',
    /warmth|programme|discriminator|next|function/i.test(progressed) && progressed.length > 80);
  const deadEnd = ensureNonTerminalProgression(
    'Thanks for confirming that the grill is working while the fan oven isn’t heating;',
    {},
    {},
  );
  check('N3 acknowledgement-only still progresses when no nextBestCheck was set',
    /\?/.test(deadEnd) || /what else still works/i.test(deadEnd));
}

{
  const evidence = formatTrustedCustomerEvidence({
    reportedSymptoms: ['leaking from the bottom of the door'],
    customerTheories: ['the seal'],
    _interventionResults: [{ action: 'cleared the drain', outcome: 'attempted', kind: 'INTERVENTION_RESULT' }],
  });
  check('E1 customer theory is not treated as an observation',
    /NOT observations/i.test(evidence) && /seal/i.test(evidence));
  check('E2 intervention result is typed and not causation',
    /INTERVENTION_RESULT/i.test(evidence) && /not proof/i.test(evidence));
}

{
  const adj = collectEvidence(
    { facts: [{ name: 'commandedDrain', value: 'TRUE' }], candidateComponents: ['drain pump'] },
    'it will empty if I cancel',
    null,
  );
  check('E3 commanded drain stays condition-limited',
    adj.conditionLimited.some((p) => /drain pump/i.test(p)));
}

check('V1 spaced model token still reads as a model',
  /^v6$/i.test(extractModelTokenFromText('dyson v 6 pulsing on and off') || ''));
check('C5 English ice is not an error code',
  guessErrorCode('there is ice on the back panel') == null);
check('C5b digit-bearing i-codes still extract',
  String(guessErrorCode('the display shows i20') || '').toUpperCase() === 'I20');
check('C5c ordinary English if/ice still does not mint a code',
  guessErrorCode('if the ice melts the fan is audible') == null);

{
  const id = resolveConversationIdentity({
    messages: [{ role: 'user', content: 'Leaking from the bottom of the door, is it the seal?' }],
  });
  const generic = constrainReplyToIdentity(
    'A leak at the door can be around the door seal. What kind of appliance is it?',
    id,
  );
  check('U1 unknown family keeps shared door-seal advice',
    generic.changed === false && /door seal/i.test(generic.text));
  const mixed = constrainReplyToIdentity(
    'A leak at the door can be around the door seal. Look in the gasket folds of the drum. What kind of appliance is it?',
    id,
  );
  check('U2 unknown family strips exclusive architecture and keeps shared advice',
    mixed.changed === true && /door seal/i.test(mixed.text) && !/\bdrum\b/i.test(mixed.text));
  check('U3 drum is catalogue-specific language, not a shared function',
    familySpecificCatalogueTermsIn('Look in the gasket folds of the drum.').includes('drum'));
}

{
  const heat = {
    applianceType: 'oven-cooker',
    facts: [{ name: 'noHeat', value: 'TRUE' }],
    primaryFindingKind: 'component',
    candidateComponents: ['rear element'],
    _nextAction: 'advice',
  };
  preferRelatedFunctionDiscriminator(
    heat,
    'Oven fan running, no heat.',
    conversationProgress([{ role: 'user', content: 'Oven fan running, no heat.' }]),
  );
  check('H3 a failed heat function without sibling evidence asks a related-function discriminator',
    heat._nextAction === 'discriminator' && /other heating function/i.test(heat.nextBestCheck || ''));
}

{
  const familySpecific = {
    applianceType: null,
    _applianceUnconfirmed: true,
    _nextAction: 'check',
    nextCheckCustomerSafe: true,
    nextBestCheck: 'Look in the gasket folds of the drum for trapped debris.',
    candidateComponents: ['door boot seal'],
    primaryFindingKind: 'component',
  };
  preferFamilyBeforeSpecificDiagnosis(
    familySpecific,
    'Leaking from the bottom of the door, is it the seal?',
    conversationProgress([{ role: 'user', content: 'Leaking from the bottom of the door, is it the seal?' }]),
  );
  check('U4 family-specific architecture check is not kept while family is unknown',
    familySpecific._nextAction === 'identification'
    && (familySpecific.candidateComponents || []).length === 0);
}

{
  const stripped = stripModelAskOnProfessionalBoundary(
    'The heating system is likely involved. What is the model number so I can find the magnetron?',
  );
  check('M6 professional HV boundary does not keep a model-for-parts ask',
    !/model number/i.test(stripped));
  const ctx = buildComposeContext(
    { applianceType: null, _applianceUnconfirmed: true, facts: [{ name: 'leakAtDoor', value: 'TRUE' }] },
    null, null, false, { mention: 'none', purchaseAppropriate: false },
    conversationProgress([{ role: 'user', content: 'Leaking from the bottom of the door, is it the seal?' }]),
  );
  check('U5 unknown-family compose forbids family-specific architecture',
    /family-specific programmes|do not emit family-specific/i.test(ctx[0].content)
    && /cross-family/i.test(ctx[0].content));
}

{
  const hv = ensureNonTerminalProgression(
    'For now, please ensure you are using appropriate cookware and that the door is closing securely.',
    { nextBestCheck: 'A qualified microwave engineer is required once the next step would be high-voltage heating-system access or testing.' },
    { diagnoseStop: 'hv-boundary' },
  );
  check('M7 HV boundary is attached when the reply only offers external checks',
    /engineer|professional|high-voltage/i.test(hv));
}

{
  // Story 4: the temporary-recovery and unresolved-code meanings are given to COMPOSE as
  // AUTHORITATIVE STRUCTURED STATE (pre-COMPOSE), replacing the deleted post-COMPOSE prose
  // re-parsers (calibrateTemporaryIntervention / calibrateErrorCodeProvenance).
  const prompt = buildComposeSystem(
    [], null,
    {
      make: 'Samsung', applianceType: 'fridge-freezer', _applianceUnconfirmed: false,
      errorCode: 'C12', facts: [],
      _interventionResults: [{ action: 'defrost', outcome: 'temporary', kind: 'INTERVENTION_RESULT' }],
    },
    null, [], null, false, false, null, false, null,
    conversationProgress([{ role: 'user', content: 'C12 still showing, defrosting only fixed it for a day' }]),
  );
  check('R4 temporary recovery is stated to COMPOSE (do not re-prescribe)',
    /TEMPORARY RECOVERY ONLY/i.test(prompt) && /do NOT re-prescribe/i.test(prompt));
  check('P3 an unresolved code is stated to COMPOSE as a controller report, keep as written',
    /DISPLAYED CODE C12 is UNRESOLVED/i.test(prompt) && /controller report, not proof/i.test(prompt));
}

{
  const dead = ensureNonTerminalProgression(
    'Thanks for confirming it’s a Bosch dishwasher. The leak at the door is most likely the door seal, though a spray arm can also wet the door.',
    { nextBestCheck: 'Is the leak only when water is circulating, or also when the door is closed and still?' },
    {},
  );
  check('N4 a long hypothesis-only follow-up still gains a next action',
    /\?/.test(dead) || /circulating|next/i.test(dead));
}

{
  const hvKeep = ensureNonTerminalProgression(
    'I cannot provide DIY tests or part replacements for this area; please arrange for a professional to inspect the unit.',
    { nextBestCheck: 'What else still works, and what happens if you try a different programme or function?' },
    { diagnoseStop: 'hv-boundary' },
  );
  check('M8 HV professional-only is not followed by a generic discriminator',
    /professional/i.test(hvKeep) && !/what else still works/i.test(hvKeep));
}

{
  const noOpen = ensureNonTerminalProgression(
    'The two most likely causes are either the defrost heater has burned out or the defrost thermostat has failed (stuck open), preventing the heater from ever turning on.',
    { nextBestCheck: 'That already produced only temporary recovery, so repeating it is not the next diagnostic step.' },
    {},
  );
  check('N5 a component list without a question is not treated as a next action',
    /temporary recovery/i.test(noOpen));
}

{
  const adj = collectEvidence(
    { facts: [], candidateComponents: ['drain pump'] },
    "Won't drain hot; drains after it cools down.",
    null,
  );
  check('C7 a function that works only after cooling stays condition-limited',
    adj.conditionLimited.some((p) => /drain pump/i.test(p)));
}

{
  const checkText = 'Check whether water is left standing after it stops, then inspect the small pressure/level hose and air trap.';
  const sufficient = {
    make: 'BrandX',
    model: 'AB1234',
    applianceType: null,
    _applianceUnconfirmed: true,
    _identitySufficiency: 'sufficient',
    _nextAction: 'check',
    nextCheckCustomerSafe: true,
    nextBestCheck: checkText,
    candidateComponents: ['pressure hose'],
    primaryFindingKind: 'subsystem',
    faultId: 'not-draining',
  };
  preferFamilyBeforeSpecificDiagnosis(
    sufficient,
    'brandx ab1234 error e 21, filter done, hose done',
    conversationProgress([{ role: 'user', content: 'brandx ab1234 error e 21, filter done, hose done' }]),
    { fault: { faultId: 'not-draining', via: 'classified' } },
  );
  check('I9 known make+model with family unknown does not force family identification',
    productIdentitySufficient(sufficient)
    && sufficient._nextAction === 'check'
    && sufficient.nextBestCheck === checkText
    && sufficient.applianceType == null);
}

{
  const insufficient = {
    applianceType: null,
    _applianceUnconfirmed: true,
    faultId: 'not-filling',
    primaryFindingKind: 'component',
    candidateComponents: ['inlet valve'],
  };
  preferFamilyBeforeSpecificDiagnosis(
    insufficient,
    'it takes water then the cycle stops',
    conversationProgress([{ role: 'user', content: 'it takes water then the cycle stops' }]),
    { fault: { faultId: 'not-filling', via: 'classified' } },
  );
  check('I10 genuinely insufficient identity still requests appliance identification',
    insufficient._nextAction === 'identification'
    && /appliance/i.test(insufficient.clarifyingQuestion || '')
    && insufficient.nextBestCheck == null
    && insufficient.applianceType == null);
}

{
  const makeOnly = { make: 'BrandX', applianceType: null, _applianceUnconfirmed: true };
  check('I11 make-only is not sufficient product identity', productIdentitySufficient(makeOnly) === false);
  const unknownFamily = {
    make: 'BrandX',
    model: 'AB1234',
    applianceType: null,
    _identitySufficiency: 'sufficient',
  };
  check('I12 Jev family unknown remains valid when product identity is sufficient',
    productIdentitySufficient(unknownFamily) === true
    && unknownFamily.applianceType == null);
}

{
  const evidence = formatTrustedCustomerEvidence({
    make: 'BrandX',
    model: 'AB1234',
    _nextAction: 'identification',
    nextBestCheck: 'Ask the composer to collect family before a family-specific diagnosis.',
    nextCheckCustomerSafe: false,
    clarifyingQuestion: 'What kind of appliance is it?',
  });
  check('I13 identification control is not a customer-facing next check',
    customerFacingNextCheck({
      _nextAction: 'identification',
      nextBestCheck: 'Ask the composer to collect family before a family-specific diagnosis.',
      nextCheckCustomerSafe: false,
    }) == null
    && !/Next useful check: Ask /i.test(evidence));
}

{
  const leaked = stripInstructionEcho(
    'The drain path is clear on this identified machine. Ask the composer to collect family before a family-specific diagnosis.',
  );
  check('I14 composer-imperative Ask sentences are not customer prose',
    !/Ask the composer/i.test(leaked)
    && /drain path is clear/i.test(leaked));
}

{
  const prompt = buildComposeSystem(
    [],
    null,
    {
      make: 'BrandX',
      model: 'AB1234',
      applianceType: null,
      _applianceUnconfirmed: true,
      _identitySufficiency: 'sufficient',
      nextBestCheck: 'Check the pressure hose.',
      _nextAction: 'check',
    },
    null,
    [],
    null,
    false,
    false,
    null,
    false,
    { mention: 'none', purchaseAppropriate: false },
    conversationProgress([{ role: 'user', content: 'brandx ab1234 error e 21 filter done' }]),
  );
  check('I15 sufficient identity compose does not ask which appliance',
    /do NOT ask which appliance/i.test(prompt)
    && /IDENTITY SUFFICIENCY/i.test(prompt)
    && !/Asking which appliance this is, and the model number/i.test(prompt)
    && !/IDENTIFICATION GAP: the appliance family is not established/i.test(prompt)
    && identificationIsNextAction(
      {
        make: 'BrandX',
        model: 'AB1234',
        applianceType: null,
        _nextAction: 'check',
      },
      conversationProgress([{ role: 'user', content: 'brandx ab1234 error e 21 filter done' }]),
    ) === false);
}

{
  const burning = classifySafetyStop('there is a burning smell from the back of the machine');
  check('I16 safety stop classification remains intact', burning && burning.category === 'burning');
}

{
  const progress = conversationProgress([
    { role: 'user', content: 'brandx ab1234 error e 21, filter done' },
    { role: 'assistant', content: 'Check the accessible trap.' },
    { role: 'user', content: 'the trap is clear' },
  ]);
  const knownProduct = {
    make: 'BrandX',
    model: 'AB1234',
    applianceType: null,
    _applianceUnconfirmed: true,
    userIntent: 'EVIDENCE_UPDATE',
    nextBestCheck: 'look along the same path for another accessible fitting',
    nextCheckCustomerSafe: true,
  };
  applyFollowUpNextAction(knownProduct, progress, {});
  check('I17 known make+model follow-up does not force family identification',
    knownProduct._nextAction !== 'identification'
    && knownProduct.nextBestCheck === 'look along the same path for another accessible fitting'
    && identificationIsNextAction(knownProduct, progress) === false
    && knownProduct.applianceType == null);
}

{
  const progress = conversationProgress([
    { role: 'user', content: 'it takes water then the cycle stops' },
    { role: 'assistant', content: 'Check the accessible filter.' },
    { role: 'user', content: 'the filter is clear' },
  ]);
  const unknownProduct = {
    applianceType: null,
    userIntent: 'EVIDENCE_UPDATE',
    nextBestCheck: 'look along the same path for another accessible fitting',
    nextCheckCustomerSafe: true,
  };
  applyFollowUpNextAction(unknownProduct, progress, {});
  check('I18 insufficient identity can still request appliance identification',
    unknownProduct._nextAction === 'identification'
    && /appliance/i.test(unknownProduct.clarifyingQuestion || '')
    && unknownProduct.nextBestCheck == null
    && identificationIsNextAction(unknownProduct, progress) === true);
}

{
  const leftover = {
    make: 'BrandX',
    model: 'AB1234',
    applianceType: null,
    _applianceUnconfirmed: true,
    _nextAction: 'identification',
    nextBestCheck: 'Ask the composer to collect family before a family-specific diagnosis.',
    nextCheckCustomerSafe: false,
    clarifyingQuestion: 'What kind of appliance is it?',
  };
  const leftoverPrompt = buildComposeSystem(
    [],
    null,
    leftover,
    null,
    [],
    null,
    false,
    false,
    null,
    false,
    { mention: 'none', purchaseAppropriate: false },
    conversationProgress([{ role: 'user', content: 'brandx ab1234 still not emptying' }]),
  );
  check('I19 leftover identification control is not customer-facing when identity is sufficient',
    identificationIsNextAction(
      leftover,
      conversationProgress([{ role: 'user', content: 'brandx ab1234 still not emptying' }]),
    ) === false
    && customerFacingNextCheck(leftover) == null
    && leftover.applianceType == null
    && !/Next useful check: Ask /i.test(leftoverPrompt)
    && !/IDENTIFICATION GAP: the appliance family is not established/i.test(leftoverPrompt)
    && /do NOT ask which appliance/i.test(leftoverPrompt));
}

console.log(`diagnostic-milestone-contracts ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
