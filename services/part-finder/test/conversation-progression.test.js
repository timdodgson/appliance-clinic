'use strict';
/**
 * Multi-turn diagnostic progression — generic contracts.
 *
 * Guards: conversation structure (not keywords) distinguishes a follow-up from a
 * new problem; COMPOSE on a follow-up must not restart/restate the first-turn
 * diagnosis; new evidence and reported checks reach COMPOSE as trusted state.
 *
 * Pure functions, no LLM, no network, no journey IDs.
 * Run: node services/part-finder/test/conversation-progression.test.js
 */
globalThis.awslambda = globalThis.awslambda || { streamifyResponse: (fn) => fn, HttpResponseStream: { from: (s) => s } };
const fs = require('fs');
const path = require('path');
  const {
  conversationProgress, looksLikeNewProblem, correctFollowUpIntent,
  buildComposeSystem, buildComposeContext, formatTrustedCustomerEvidence, normaliseIntent,
  INTENT_SCHEMA, USER_INTENTS, followUpUnderstandNote, applyFollowUpNextAction,
  previouslyShownMedia, identificationIsNextAction, preferAccessibleFirstAction, preferAdviceThenIdentity,
  isAcousticOnlyQuery, isUnlocatedFunctionOutcome, hasFunctionFailureSymptom, currentActionMediaFaultId,
  captureQuestionedCause, demoteUnconfirmedTheoryFinding,
  retrievedFamilyNote, lmSafeMessages,
  preferFamilyBeforeSpecificDiagnosis,
  localisingQuestionAfterObservation, materialAmbiguity,
  computePresentationGrain, remainingActionBlocksPurchase, COMPONENT_MENTION,
  customerProposedDrainPathPart, demotePrematurePartRequest,
  latestTurnReportsRecovery,
  ensureAdviceThenIdentityAsk, stripInstructionEcho, collectEvidence,
  composeFollowUpNote, ensureNonTerminalProgression, preferArchitectureDependentAdvice,
} = require('../part-finder-lambda.js')._internal;
const CAT = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'faults-catalogue.json'), 'utf8'));

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) pass++;
  else { fail++; console.log('  FAIL:', name, detail !== undefined ? `:: ${JSON.stringify(detail)}` : ''); }
}

const drainNode = CAT.faults['washing-machine']['not-draining'];
const followUpMessages = [
  { role: 'user', content: 'Finished with water in the drum, spin just hums, do I need a pump?' },
  { role: 'assistant', content: 'Water left in the drum usually stops the spin. That points first to drainage. Check the pump filter before buying a pump.' },
  { role: 'user', content: 'the filter is clear' },
];

// ---------------------------------------------------------------------------
// A. Conversation structure
// ---------------------------------------------------------------------------
{
  const p = conversationProgress(followUpMessages);
  check('A1 follow-up when prior advisor + second user turn', p.isFollowUp === true);
  check('A2 latest turn is only the new evidence', p.latestUserText === 'the filter is clear');
  check('A3 prior advisor text is carried', /drainage/i.test(p.priorAdvisorText));
  check('A4 opening turn is not a follow-up', conversationProgress([followUpMessages[0]]).isFollowUp === false);
}

// A5/A6 removed: looksLikeNewProblem (prose appliance-switch detection) is deleted. correctFollowUpIntent
// now trusts Jev's typed userIntent on a follow-up (Jev is told the conversation structure), so a genuine
// new problem / appliance switch is Jev's NEW_PROBLEM classification, not a customer-prose family compare.
{
  // A7: correctFollowUpIntent now trusts Jev's typed userIntent on a follow-up (no prose family
  // compare). A bare OTHER becomes EVIDENCE_UPDATE; a Jev NEW_PROBLEM is respected as Jev's call.
  const intent = { userIntent: 'OTHER' };
  correctFollowUpIntent(intent, conversationProgress(followUpMessages));
  check('A7 a bare OTHER follow-up becomes EVIDENCE_UPDATE', intent.userIntent === 'EVIDENCE_UPDATE');
  const fresh = { userIntent: 'NEW_PROBLEM' };
  correctFollowUpIntent(fresh, conversationProgress([followUpMessages[0]]));
  check('A8 opening turn keeps NEW_PROBLEM', fresh.userIntent === 'NEW_PROBLEM');
}

check('A9 EVIDENCE_UPDATE is a closed userIntent', USER_INTENTS.includes('EVIDENCE_UPDATE'));
check('A10 schema requires newEvidenceThisTurn', (INTENT_SCHEMA.required || []).includes('newEvidenceThisTurn'));
check('A11 schema requires checksReported', (INTENT_SCHEMA.required || []).includes('checksReported'));

// ---------------------------------------------------------------------------
// B. Structured evidence reaches COMPOSE
// ---------------------------------------------------------------------------
{
  const intent = normaliseIntent({
    applianceType: 'washing-machine',
    userIntent: 'EVIDENCE_UPDATE',
    facts: [{ name: 'waterRemaining', value: 'TRUE' }, { name: 'filterCleaned', value: 'TRUE' }],
    checksReported: ['accessible pump filter (clear)'],
    newEvidenceThisTurn: 'The accessible filter has been checked and is clear.',
    alreadyReplaced: ['heating element'],
    reportedSymptoms: ['water left in drum', 'spin hums'],
    primaryFinding: 'drainage path still likely after the accessible filter was cleared',
    primaryFindingKind: 'subsystem',
    nextBestCheck: 'ask for make and model so the next check can be specific',
  });
  const block = formatTrustedCustomerEvidence(intent);
  check('B1 new evidence is in the trusted block', /New evidence this turn/i.test(block));
  check('B2 reported checks are in the trusted block', /Checks already reported/i.test(block) && /pump filter/i.test(block));
  check('B3 prior replacement still carried', /Already replaced/i.test(block) && /heating element/i.test(block));
}

// ---------------------------------------------------------------------------
// C. COMPOSE follow-up must progress, not restart
// ---------------------------------------------------------------------------
{
  const intent = {
    applianceType: 'washing-machine',
    userIntent: 'EVIDENCE_UPDATE',
    facts: [{ name: 'waterRemaining', value: 'TRUE' }, { name: 'filterCleaned', value: 'TRUE' }],
    checksReported: ['accessible pump filter (clear)'],
    newEvidenceThisTurn: 'The accessible filter has been checked and is clear.',
    reportedSymptoms: ['water left in drum'],
    primaryFinding: 'drainage path still likely',
    primaryFindingKind: 'subsystem',
    candidateComponents: ['drain pump'],
    nextBestCheck: 'ask for the make and model',
    confidence: 0.7,
  };
  const fault = { faultId: 'not-draining', node: drainNode, via: 'classified' };
  const progress = conversationProgress(followUpMessages);
  const prompt = buildComposeSystem([], null, intent, fault, [], null, false, false, null, true, { mention: 'none', purchaseAppropriate: false }, progress);
  check('C1 follow-up prompt forbids restarting the diagnosis', /do NOT restart/i.test(prompt) || /NOT a new diagnosis/i.test(prompt));
  check('C2 follow-up prompt forbids restating an unchanged finding', /do not open by restating/i.test(prompt));
  check('C3 follow-up prompt carries prior advisor reply', /PRIOR ADVISOR REPLY/i.test(prompt));
  check('C4 follow-up does not use first-turn OPEN-with-finding instruction', !/OPEN the reply by stating this finding/i.test(prompt));
  check('C5 follow-up does not use first-turn COMMITTED DIAGNOSIS restatement', !/State this as the most likely diagnosis/i.test(prompt));
  check('C6 identification after a completed generic check is allowed, not mandated as turn-2', /Identification timing is contextual/i.test(prompt));
  check('C7 invasive tests are forbidden on an ordinary follow-up', /invasive teardown/i.test(prompt) || /winding tests/i.test(prompt));
  check('C9 follow-up without identity has an identification gap, not a forced handoff', /IDENTIFICATION GAP/i.test(prompt) && /IDENTIFICATION BEFORE HANDOFF/i.test(prompt));
  check('C10 follow-up forbids inventing unreported checks', /Do not assert that they have already done a check they did not report/i.test(prompt));
  check('C13 prior advisor text is not treated as completed work', /NOT a record of checks the customer has performed/i.test(prompt));
  check('C14 identification-before-handoff forbids instructing the out-of-scope check', /Do NOT instruct that out-of-scope physical check/i.test(prompt));
}

{
  const intent = {
    applianceType: 'fridge-freezer',
    userIntent: 'CONFIRMATION',
    nextBestCheck: 'check whether vents are blocked',
    nextCheckCustomerSafe: true,
    primaryFinding: 'airflow to the fridge is restricted',
    primaryFindingKind: 'subsystem',
    confidence: 0.7,
  };
  const prompt = buildComposeSystem([], null, intent, null, [], null, false, false, null, true, { mention: 'none', purchaseAppropriate: false }, conversationProgress([
    { role: 'user', content: 'fridge is warm, freezer seems ok' },
    { role: 'assistant', content: 'Is the freezer still freezing normally?' },
    { role: 'user', content: 'Yes, definitely freezing normally.' },
  ]));
  check('C15 customer-safe follow-up check is not replaced by a forced identification ask', !/IDENTIFICATION GAP/i.test(prompt) && !/IDENTIFICATION BEFORE HANDOFF/i.test(prompt));
}

{
  const intent = {
    applianceType: 'washing-machine',
    make: 'Bosch',
    model: 'WAN28281GB',
    userIntent: 'ADDING_DETAIL',
    primaryFinding: 'drainage path still likely',
    primaryFindingKind: 'subsystem',
    confidence: 0.7,
  };
  const fault = { faultId: 'not-draining', node: drainNode, via: 'classified' };
  const identified = buildComposeSystem([], null, intent, fault, [], null, false, false, null, true, { mention: 'none', purchaseAppropriate: false }, conversationProgress(followUpMessages));
  check('C11 identified follow-up does not force another identification ask', !/IDENTIFICATION GAP/i.test(identified) && !/IDENTIFICATION BEFORE HANDOFF/i.test(identified));
}

{
  const intent = {
    applianceType: 'washing-machine',
    primaryFinding: 'likely a blocked pump filter',
    primaryFindingKind: 'check',
    confidence: 0.7,
  };
  const fault = { faultId: 'not-draining', node: drainNode, via: 'classified' };
  const opening = buildComposeSystem([], null, intent, fault, [], null, false, false, null, true, { mention: 'none', purchaseAppropriate: false }, conversationProgress([followUpMessages[0]]));
  check('C8 opening uncommitted finding is a working hypothesis, not a confirmed headline',
    /LEADING WORKING HYPOTHESIS/i.test(opening) && !/OPEN the reply by stating this finding/i.test(opening));
  check('C12 opening turn does not force identification before a generic check', !/IDENTIFICATION GAP/i.test(opening) && !/IDENTIFICATION BEFORE HANDOFF/i.test(opening));
}

// ---------------------------------------------------------------------------
// D. Other families — same progression machinery
// ---------------------------------------------------------------------------
{
  const ovenFollow = conversationProgress([
    { role: 'user', content: 'oven fan is running but there is no heat' },
    { role: 'assistant', content: 'That often points at the fan element. Have you changed anything already?' },
    { role: 'user', content: 'I replaced the element and it is still exactly the same' },
  ]);
  // correctFollowUpIntent now trusts Jev's typed userIntent on a follow-up (Jev is given the
  // conversation structure). A bare OTHER is still safely a continued evidence update; a NEW_PROBLEM
  // Jev returns on a follow-up is respected (genuine new problem / appliance switch — Jev's call).
  const other = { userIntent: 'OTHER' };
  correctFollowUpIntent(other, ovenFollow);
  check('D1 a bare OTHER follow-up becomes EVIDENCE_UPDATE', other.userIntent === 'EVIDENCE_UPDATE');
  const newProb = { userIntent: 'NEW_PROBLEM' };
  correctFollowUpIntent(newProb, ovenFollow);
  check('D2 Jev NEW_PROBLEM on a follow-up is trusted (not overridden by prose)', newProb.userIntent === 'NEW_PROBLEM');
}

{
  const fridgeFollow = conversationProgress([
    { role: 'user', content: 'fridge is warm, freezer seems ok' },
    { role: 'assistant', content: 'Is the freezer still freezing normally?' },
    { role: 'user', content: 'Yes, definitely freezing normally.' },
  ]);
  const intent = { userIntent: 'CONFIRMATION' };
  correctFollowUpIntent(intent, fridgeFollow);
  check('D3 confirmed discriminator stays CONFIRMATION (not rewritten to NEW_PROBLEM)', intent.userIntent === 'CONFIRMATION');
}

{
  const SRC = fs.readFileSync(path.join(__dirname, '..', 'part-finder-lambda.js'), 'utf8');
  const codeOnly = SRC.split('\n').filter((l) => !l.trim().startsWith('*') && !l.trim().startsWith('//')).join('\n');
  check('D4 no benchmark / journey ids in product code', !/\bRJ-|H-001|CG-002|RO-001/i.test(codeOnly));
  check('D5 no special-case of this opening wording', !/spin just hums/i.test(codeOnly));
  check('D11 no special-case of the unresolved-family opening', !/impeller by hand sometimes works/i.test(codeOnly));
  check('D12 no special-case of a locked-door-with-water opening', !/washing trapped/i.test(codeOnly));
}

{
  check('D6 opening understand note is empty', followUpUnderstandNote(conversationProgress([followUpMessages[0]])) === '');
  const note = followUpUnderstandNote(conversationProgress(followUpMessages));
  check('D7 follow-up understand note distinguishes latest evidence', /LAST user message is NEW evidence/i.test(note));
  check('D8 follow-up understand note carries prior advisor text', /pump filter/i.test(note));
  check('D9 follow-up understand note does not default to engineer after a clear check', /Do not set nextBestCheck to calling an engineer/i.test(note));
  check('D10 prior advisor advice is not treated as performed work', /NOT proof they performed/i.test(note));
  check('D11 established checks survive a later confirmation turn', /checksReported is every check/i.test(note));
  check('D13 a programme result is not the same as a completed physical inspection', /programme or command result/i.test(note) && /not yet confirmed/i.test(note));
}

{
  const progress = conversationProgress(followUpMessages);
  const unsafe = {
    applianceType: 'washing-machine',
    nextBestCheck: 'remove a cover and inspect the mechanism',
    nextCheckCustomerSafe: false,
  };
  applyFollowUpNextAction(unsafe, progress, {});
  check('E1 non-customer-safe follow-up next action becomes identification',
    unsafe._nextAction === 'identification'
    && /make and model/i.test(unsafe.clarifyingQuestion || '')
    && unsafe.nextBestCheck == null);
  const safe = {
    nextBestCheck: 'look for frost on the back wall',
    nextCheckCustomerSafe: true,
  };
  applyFollowUpNextAction(safe, progress, {});
  check('E2 customer-safe follow-up next action is left alone', safe.nextBestCheck === 'look for frost on the back wall');
  const opening = { nextBestCheck: 'inspect the accessible filter', nextCheckCustomerSafe: false };
  applyFollowUpNextAction(opening, conversationProgress([followUpMessages[0]]), {});
  check('E3 opening turn is not rewritten to identification', opening.nextBestCheck === 'inspect the accessible filter');
  const known = { make: 'Bosch', model: 'HBA1234', nextBestCheck: 'remove a cover', nextCheckCustomerSafe: false };
  applyFollowUpNextAction(known, progress, {});
  check('E4 identified follow-up keeps the next physical check', known.nextBestCheck === 'remove a cover');
  const afterCheck = {
    nextBestCheck: 'look at the next accessible fitting along the same path',
    nextCheckCustomerSafe: true,
    checksReported: ['accessible trap (clear)'],
  };
  applyFollowUpNextAction(afterCheck, progress, {});
  check('E6 completed accessible check prefers identification over another generic look',
    afterCheck._nextAction === 'identification'
    && /make and model|model number/i.test(afterCheck.clarifyingQuestion || '')
    && afterCheck.nextBestCheck == null);
  check('E6b marks next action as identification for media', afterCheck._nextAction === 'identification');
  const stillMaterial = {
    nextBestCheck: 'look for frost on the back wall',
    nextCheckCustomerSafe: true,
    furtherGenericCheckJustified: true,
    checksReported: ['confirmed the other compartment is still cold'],
  };
  applyFollowUpNextAction(stillMaterial, progress, {});
  check('E7 a different discriminator may remain after a reported check', stillMaterial.nextBestCheck === 'look for frost on the back wall');
  const unnamedAfterCommand = conversationProgress([
    { role: 'user', content: 'It finished with water still inside and the door will not open.' },
    { role: 'assistant', content: 'If the controls respond, try a drain or cancel then drain. Do not force the door.' },
    { role: 'user', content: 'I ran drain and it just hums. The water is still in there.' },
  ]);
  // E14 removed: customerNamedApplianceFamily (prose family classification) is deleted; whether a
  // command-result follow-up named a family is Jev's typed applianceFamily/provenance now.
  const afterProgramme = {
    userIntent: 'EVIDENCE_UPDATE',
    nextBestCheck: 'inspect the accessible filter or trap, releasing any standing water slowly',
    nextCheckCustomerSafe: true,
    furtherGenericCheckJustified: true,
    checksReported: ['drain or empty programme (hummed, water remained)'],
  };
  applyFollowUpNextAction(afterProgramme, unnamedAfterCommand, {});
  check('E15 a different customer-safe check may remain after a programme result even if family is unconfirmed',
    afterProgramme.nextBestCheck === 'inspect the accessible filter or trap, releasing any standing water slowly'
    && afterProgramme._nextAction !== 'identification');
  const composeAfterProgramme = buildComposeSystem(
    [], null, afterProgramme, null, [], null, false, false, null, false,
    { mention: 'none', purchaseAppropriate: false }, unnamedAfterCommand,
  );
  check('E15b compose after a programme result is not forced to identification',
    !/Customer-facing next action: identification/i.test(composeAfterProgramme));
  check('E17 compose distinguishes standing water from a lock fault, and recovered threads from identification',
    /have not yet reported trying a drain/i.test(composeAfterProgramme)
    && /MUST include spill\/flood control/i.test(composeAfterProgramme)
    && /do not jump to a failed latch/i.test(composeAfterProgramme)
    && /original problem is now resolved/i.test(composeAfterProgramme)
    && /already planned, started, or completed a check/i.test(composeAfterProgramme));
  const resolved = {
    userIntent: 'EVIDENCE_UPDATE',
    nextBestCheck: null,
    nextCheckCustomerSafe: false,
    furtherGenericCheckJustified: false,
    needMoreInfo: false,
    checksReported: ['accessible trap, obstruction removed, water emptied'],
    newEvidenceThisTurn: 'Removing the obstruction restored drainage and the door opened.',
  };
  applyFollowUpNextAction(resolved, unnamedAfterCommand, {});
  check('E16 a resolved fault is not rewritten to identification',
    resolved._nextAction !== 'identification'
    && !/model/i.test(resolved.clarifyingQuestion || '')
    && identificationIsNextAction(resolved, unnamedAfterCommand) === false);
  const resolvedWithStaleAsk = {
    userIntent: 'EVIDENCE_UPDATE',
    nextBestCheck: 'Ask which kind of appliance this is, and the model number',
    nextCheckCustomerSafe: false,
    furtherGenericCheckJustified: false,
    needMoreInfo: false,
    checksReported: ['accessible trap, obstruction removed'],
  };
  applyFollowUpNextAction(resolvedWithStaleAsk, unnamedAfterCommand, {});
  check('E16b a closed thread is not forced to identification even if a stale ask remains',
    resolvedWithStaleAsk._nextAction !== 'identification'
    && identificationIsNextAction(resolvedWithStaleAsk, unnamedAfterCommand) === false);
  const mentionedFilter = conversationProgress([
    { role: 'user', content: 'It finished with water still inside and the door will not open.' },
    { role: 'assistant', content: 'Try a drain programme first. If that fails, the pump filter is usually behind a small flap at the bottom front.' },
    { role: 'user', content: 'I ran drain and it just hums. The water is still in there.' },
  ]);
  const afterHumWithPriorFilter = {
    userIntent: 'EVIDENCE_UPDATE',
    nextBestCheck: 'the pump filter is usually behind a small flap at the bottom front — open slowly over a tray',
    nextCheckCustomerSafe: true,
    furtherGenericCheckJustified: true,
    checksReported: ['drain or empty programme (hummed)'],
  };
  applyFollowUpNextAction(afterHumWithPriorFilter, mentionedFilter, {});
  check('E18 a fallback mention of a check does not force identification when a further discriminator remains',
    /pump filter/i.test(afterHumWithPriorFilter.nextBestCheck || '')
    && afterHumWithPriorFilter._nextAction !== 'identification');
  const omittedChecks = {
    userIntent: 'EVIDENCE_UPDATE',
    nextBestCheck: 'look along the same path for another accessible fitting',
    nextCheckCustomerSafe: true,
  };
  applyFollowUpNextAction(omittedChecks, progress, {});
  check('E9 evidence-update without checksReported still prefers identification',
    omittedChecks._nextAction === 'identification'
    && /make and model|model number/i.test(omittedChecks.clarifyingQuestion || '')
    && omittedChecks.nextBestCheck == null);
  const fridgeConfirm = {
    userIntent: 'CONFIRMATION',
    nextBestCheck: 'look for frost on the back wall',
    nextCheckCustomerSafe: true,
    newEvidenceThisTurn: 'the other compartment is still cold',
  };
  applyFollowUpNextAction(fridgeConfirm, progress, {});
  check('E10 confirmation of a discriminator is not treated as a completed generic check', fridgeConfirm.nextBestCheck === 'look for frost on the back wall');
  const unsafeFollow = {
    applianceType: 'washing-machine',
    userIntent: 'EVIDENCE_UPDATE',
    nextBestCheck: 'remove a cover and inspect the mechanism',
    nextCheckCustomerSafe: false,
    primaryFinding: 'drainage path still likely',
    primaryFindingKind: 'subsystem',
    confidence: 0.7,
  };
  applyFollowUpNextAction(unsafeFollow, progress, {});
  const idPrompt = buildComposeSystem([], null, unsafeFollow, { faultId: 'not-draining', node: drainNode, via: 'classified' }, [], null, false, false, null, true, { mention: 'none', purchaseAppropriate: false }, progress);
  check('E11 identification is the remote-action next step, not an engineer handoff', /Customer-facing next action: identification/i.test(idPrompt));
  check('E11b identification boundary does not treat engineer handoff as the next action', !/that is a successful outcome:[\s\S]{0,120}recommend a qualified appliance engineer/i.test(idPrompt));
  const idCtx = buildComposeContext(unsafeFollow, { faultId: 'not-draining', node: drainNode, via: 'classified' }, null, false, { mention: 'none', purchaseAppropriate: false }, progress);
  check('E12 compose context asks for identification rather than stopping at the remote-action boundary', /make and model/i.test(idCtx[0].content) && !/remote-action boundary/i.test(idCtx[0].content));
  check('E13 identificationIsNextAction is false while a customer-safe check remains', identificationIsNextAction(safe, progress) === false);
}

check('E5 schema includes nextCheckCustomerSafe', Object.prototype.hasOwnProperty.call(INTENT_SCHEMA.properties, 'nextCheckCustomerSafe'));
check('E8 schema includes furtherGenericCheckJustified', Object.prototype.hasOwnProperty.call(INTENT_SCHEMA.properties, 'furtherGenericCheckJustified'));

{
  const shown = previouslyShownMedia([
    { role: 'user', content: 'hello' },
    { role: 'assistant', content: 'check this', media: [{ id: 'wm-pump-filter', type: 'DIAGRAM', title: 'Where it is' }] },
  ]);
  check('F1 previously shown media is taken from assistant turns', shown.length === 1 && shown[0].id === 'wm-pump-filter');
}

{
  const unnamed = 'BrandX will not empty. The accessible trap is already cleaned. The impeller sometimes turns by hand.';
  // G1-G3 removed: customerNamedApplianceFamily + applyEstablishedAppliance (customer-prose family
  // classification / establishment override) are deleted — family + provenance are Jev's typed
  // decisions now (covered by identity-integrity's typed-contract tests).
  // retrievedFamilyNote now takes a typed `familyKnown` boolean (from Jev's family), not prose.
  const mixedNote = retrievedFamilyNote(
    [{ applianceFamily: 'dishwasher' }, { applianceFamily: 'washing-machine' }],
    false,
  );
  check('G4 mixed retrieval is not treated as family proof', /do NOT set applianceType from it/i.test(mixedNote));
  check('G4b known family retrieval does not add that warning', retrievedFamilyNote([{ applianceFamily: 'dishwasher' }], true) === '');
  const ambiguousProgress = conversationProgress([
    { role: 'user', content: unnamed },
    { role: 'assistant', content: 'That still points at drainage. If the trap is already clear, listen for the pump.' },
    { role: 'user', content: 'the pump and the trap are both clear' },
  ]);
  const makeOnly = {
    make: 'BrandX',
    userIntent: 'EVIDENCE_UPDATE',
    nextBestCheck: 'check the internal sump housing on that family of machine',
    nextCheckCustomerSafe: true,
  };
  applyFollowUpNextAction(makeOnly, ambiguousProgress, {});
  check('G5 make-only follow-up after a completed generic check asks which appliance',
    /which kind of/i.test(makeOnly.clarifyingQuestion || '')
    && /appliance/i.test(makeOnly.clarifyingQuestion || ''));
  check('G5b collects model in the same identification ask', /model number/i.test(makeOnly.clarifyingQuestion));
  check('G5c does not treat make as sufficient identity', makeOnly._nextAction === 'identification');
  const idPrompt = buildComposeSystem([], null, makeOnly, null, [], null, false, false, null, false, { mention: 'none', purchaseAppropriate: false }, ambiguousProgress);
  check('G6 compose must not treat an unconfirmed family as known', /appliance family is not established/i.test(idPrompt));
  check('G6b compose forbids naming a family to continue', /Do NOT pick a family to continue/i.test(idPrompt) || /Do NOT name a specific family/i.test(idPrompt));
  const openingUnnamed = { nextBestCheck: 'listen for the pump humming', nextCheckCustomerSafe: true, make: 'BrandX' };
  applyFollowUpNextAction(openingUnnamed, conversationProgress([{ role: 'user', content: unnamed }]), {});
  check('G7 opening turn with unconfirmed family is not forced to identification', openingUnnamed.nextBestCheck === 'listen for the pump humming');
}

{
  // G8/G8b/G8c removed: customerStatedFamilyPhrase (customer-prose family-noun extraction) is deleted;
  // the reply family phrase is now derived from Jev's typed family when provenance is customer_named.
  const washerProgress = conversationProgress([
    { role: 'user', content: 'siemens washer wont empty, filter already done, impeller only works sometimes if i flick it' },
    { role: 'assistant', content: 'Look in the pump housing for debris.' },
    { role: 'user', content: 'the pump and filter are clear' },
  ]);
  const washerIntent = {
    applianceType: 'washing-machine',
    _applianceFamilyProvenance: 'customer_named',
    make: 'Siemens',
    userIntent: 'EVIDENCE_UPDATE',
    nextBestCheck: 'Ask for the model',
    _nextAction: 'identification',
    needMoreInfo: true,
    furtherGenericCheckJustified: false,
    nextCheckCustomerSafe: false,
  };
  const washerPrompt = buildComposeSystem([], null, washerIntent, null, [], null, false, false, null, false, { mention: 'none', purchaseAppropriate: false }, washerProgress);
  check('G9 compose uses the customer-stated (Jev customer_named) family identity',
    /ESTABLISHED IDENTITY/i.test(washerPrompt) && /washing machine/i.test(washerPrompt));
  check('G9b known make does not re-ask make or which appliance',
    /do NOT re-ask the make/i.test(washerPrompt) && /Do NOT ask which appliance it is/i.test(washerPrompt));
  const inferredPrompt = buildComposeSystem([], null, {
    applianceType: 'washing-machine',
    _applianceFamilyProvenance: 'inferred',
    userIntent: 'EVIDENCE_UPDATE',
    nextBestCheck: 'ask for make and model',
    _nextAction: 'identification',
    needMoreInfo: true,
    nextCheckCustomerSafe: false,
    furtherGenericCheckJustified: false,
  }, { faultId: 'not-draining', node: drainNode, via: 'classified' }, [], null, false, false, null, true, { mention: 'none', purchaseAppropriate: false }, conversationProgress(followUpMessages));
  check('G9c inferred spin/drum identity is not announced as a named family',
    !/ESTABLISHED IDENTITY/i.test(inferredPrompt) && /did not name one/i.test(inferredPrompt));
  const siemensFollow = {
    applianceType: 'washing-machine',
    make: 'Siemens',
    userIntent: 'EVIDENCE_UPDATE',
    nextCheckCustomerSafe: false,
    furtherGenericCheckJustified: false,
  };
  applyFollowUpNextAction(siemensFollow, washerProgress, {});
  check('G10 known make asks for model only',
    /model/i.test(siemensFollow.clarifyingQuestion || '')
    && !/make and model/i.test(siemensFollow.clarifyingQuestion || '')
    && siemensFollow.nextBestCheck == null);
  const impellerCtx = buildComposeContext(
    { applianceType: 'washing-machine', _applianceFamilyProvenance: 'customer_named', make: 'Siemens', facts: [] },
    null, null, false, { mention: 'none', purchaseAppropriate: false },
    conversationProgress([{ role: 'user', content: 'siemens washer wont empty, filter already done, impeller only works sometimes if i flick it' }]),
  );
  check('G11 impeller compose refers to the Jev customer_named family',
    /named this as a washing machine/i.test(impellerCtx[0].content) && !/announce an appliance family they did not name/i.test(impellerCtx[0].content));
}

{
  const openerGone = "My Bosch dishwasher just hums. Filter's clear — is the pump gone?";
  const drainQ = 'When it hums, is there water left in the bottom, and is that happening when the machine should be draining?';
  const t2Drain = "Yes, there's water left in the bottom and I can hear it humming when it should be draining.";
  const t2DrainProgress = conversationProgress([
    { role: 'user', content: openerGone },
    { role: 'assistant', content: `Thanks. ${drainQ}` },
    { role: 'user', content: t2Drain },
  ]);
  const staleDrain = {
    applianceType: 'dishwasher',
    make: 'Bosch',
    facts: [{ name: 'humNoise', value: 'TRUE' }],
    checksReported: ['filter clear'],
    customerTheories: ['pump'],
    _observationAmbiguity: { fact: 'drainEvent', question: drainQ },
    clarifyingQuestion: drainQ,
  };
  preferAccessibleFirstAction(staleDrain, openerGone, t2DrainProgress);
  check('G12 answered drain-event is not re-asked when the latest turn established water left',
    staleDrain._nextAction === 'check'
    && !staleDrain._observationAmbiguity
    && /impeller/i.test(staleDrain.nextBestCheck));
  const staleCompose = {
    applianceType: 'dishwasher',
    make: 'Bosch',
    // Story 2: the answered drain-event surfaces as an authoritative Jev fact (waterRemaining).
    facts: [{ name: 'humNoise', value: 'TRUE' }, { name: 'waterRemaining', value: 'TRUE' }],
    checksReported: ['filter clear'],
    customerTheories: ['pump'],
    _observationAmbiguity: { fact: 'drainEvent', question: drainQ },
  };
  const answeredCtx = buildComposeContext(
    staleCompose, null, null, false, { mention: 'none', purchaseAppropriate: false }, t2DrainProgress,
  );
  check('G12b compose does not re-ask an answered drain-event discriminator',
    /impeller/i.test(answeredCtx[0].content) && !/Ask exactly this one question/i.test(answeredCtx[0].content));
  applyFollowUpNextAction(staleCompose, t2DrainProgress, {});
  check('G12c follow-up clears a drain-event ask once the customer answers it',
    !staleCompose._observationAmbiguity && staleCompose._discriminatorJustAnswered === 'drainEvent');
  const t1Only = conversationProgress([{ role: 'user', content: openerGone }]);
  const t1Intent = {
    applianceType: 'dishwasher',
    facts: [{ name: 'humNoise', value: 'TRUE' }],
    checksReported: ['filter clear'],
    customerTheories: ['pump'],
    _observationAmbiguity: {
      fact: 'drainEvent',
      question: drainQ,
    },
  };
  const t1Ctx = buildComposeContext(
    t1Intent, null, null, false, { mention: 'none', purchaseAppropriate: false }, t1Only,
  );
  check('G12d opening drain-event question is still asked',
    /Ask exactly this one question/i.test(t1Ctx[0].content) && /should be draining/i.test(t1Ctx[0].content));
  // Anti-repeat/progression is now a STRUCTURED control note fed to COMPOSE (composeFollowUpNote),
  // not post-compose prose synthesis. It must carry the decision without becoming customer text.
  const drainFollowNote = composeFollowUpNote(t2DrainProgress, { make: 'Bosch' });
  check('G12e follow-up progression is emitted as trusted control guidance, not customer prose',
    drainFollowNote.length > 0
    && /FOLLOW-UP PROGRESSION/.test(drainFollowNote)
    && /NEVER quote/i.test(drainFollowNote)
    && /already said/i.test(drainFollowNote)
    && /exactly ONE step/i.test(drainFollowNote));
  check('G12e2 purchase/replacement-readiness turns are left to #69 (no progression note)',
    composeFollowUpNote(t2DrainProgress, { make: 'Bosch', _nextAction: 'part_request' }) === ''
    && composeFollowUpNote(t2DrainProgress, { userIntent: 'PART_REQUEST' }) === '');
  const impellerClearT3 = {
    applianceType: 'dishwasher',
    customerTheories: ['pump'],
    alreadyReplaced: [],
    checksReported: ['filter'],
    facts: [
      { name: 'make', value: 'Bosch' },
      { name: 'model', value: 'SMS50C12GB' },
      { name: 'hums', value: 'TRUE' },
      { name: 'waterRemaining', value: 'TRUE' },
    ],
  };
  const impellerClearT3Progress = conversationProgress([
    { role: 'user', content: 'Bosch dishwasher hums, filter clear, check before I buy a pump?' },
    { role: 'assistant', content: 'When it hums, is there water left in the bottom and is it happening when the dishwasher should be draining?' },
    { role: 'user', content: "Yes, there's water left in the bottom and I can hear it humming when it should be draining." },
    { role: 'assistant', content: 'With the machine isolated from the mains, look at the pump housing / impeller area for anything restricting it, and check whether the impeller is jammed. You do not need to dismantle the machine for this.' },
    { role: 'user', content: 'The impeller turns and I can\'t see anything blocking it. E-Nr is SMS50C12GB.' },
  ]);
  preferAccessibleFirstAction(
    impellerClearT3,
    'The impeller turns and I can\'t see anything blocking it. E-Nr is SMS50C12GB.',
    impellerClearT3Progress,
  );
  const impellerClearT3Ctx = buildComposeContext(
    impellerClearT3, null, null, false, { mention: 'none', purchaseAppropriate: false }, impellerClearT3Progress,
  );
  check('G13 completed impeller look plus model is pump hypothesis not another housing look',
    impellerClearT3._nextAction === 'advice',
    { nextAction: impellerClearT3._nextAction, nextBest: impellerClearT3.nextBestCheck });
  check('G13b compose does not repeat the housing look',
    /weak|failed drain pump|downstream/i.test(impellerClearT3Ctx[0].content)
    && !/look at the pump housing/i.test(impellerClearT3Ctx[0].content)
    && !/user-accessible pump or impeller area/i.test(impellerClearT3Ctx[0].content));
  const vGoneT3 = {
    applianceType: 'dishwasher',
    customerTheories: ['pump'],
    alreadyReplaced: [],
    checksReported: ['filter'],
    facts: [{ name: 'make', value: 'Bosch' }, { name: 'hums', value: 'TRUE' }],
  };
  const vGoneProgress = conversationProgress([
    { role: 'user', content: "My Bosch dishwasher just hums. Filter's clear — is the pump gone?" },
    { role: 'assistant', content: 'When it hums, is there water left in the bottom, and is that happening when the machine should be draining?' },
    { role: 'user', content: "Yes, there's water left in the bottom and I can hear it humming when it should be draining." },
    { role: 'assistant', content: 'Thanks for confirming that the water remains and the pump is humming—that tells us the drain system is trying to work but isn\'t moving the water. Since you\'ve already cleared the filter, please unplug the dishwasher first for safety. Then, look inside the bottom of the tub at the pump area (usually behind a small plastic cover or grille) and check if anything is jamming the impeller or blocking the outlet.' },
    { role: 'user', content: 'The impeller turns and I can\'t see anything blocking it. E-Nr is SMS50C12GB.' },
  ]);
  preferAccessibleFirstAction(
    vGoneT3,
    'The impeller turns and I can\'t see anything blocking it. E-Nr is SMS50C12GB.',
    vGoneProgress,
  );
  const vGoneCtx = buildComposeContext(
    vGoneT3, null, null, false, { mention: 'none', purchaseAppropriate: false }, vGoneProgress,
  );
  check('G13c answering the asked impeller look is not another housing look',
    vGoneT3._nextAction === 'advice'
    && /weak|failed drain pump|downstream/i.test(vGoneCtx[0].content)
    && !/look inside the bottom of the tub/i.test(vGoneCtx[0].content)
    && !/jamming the impeller/i.test(vGoneCtx[0].content));
  const byHandOpener = {
    applianceType: 'washing-machine',
    alreadyReplaced: [],
    checksReported: ['filter already done'],
    customerTheories: ['pump'],
    facts: [{ name: 'make', value: 'Siemens' }],
  };
  preferAccessibleFirstAction(
    byHandOpener,
    'siemens washer wont empty, filter already done, impeller only works sometimes if i flick it',
  );
  check('G13d condition-limited impeller is not treated as a completed housing look',
    byHandOpener._nextAction !== 'advice' && byHandOpener._nextAction !== 'identification');
  check('G13g "is the pump gone?" is a hypothesis, not a recovery report',
    latestTurnReportsRecovery(conversationProgress([
      { role: 'user', content: openerGone },
    ])) === false);
  check('G13h an explicit drain recovery report is still recognised',
    latestTurnReportsRecovery(conversationProgress([
      { role: 'user', content: openerGone },
      { role: 'assistant', content: drainQ },
      { role: 'user', content: 'The water has gone, it is draining now.' },
    ])) === true);
  check('G13i follow-up understand note does not treat an obstruction look as recovery',
    /NOT recovery of that function/i.test(followUpUnderstandNote(vGoneProgress))
    && /named-part question/i.test(followUpUnderstandNote(vGoneProgress)));
}

{
  const assistantFirst = [
    { role: 'assistant', content: 'Based on what you described, check the filter.' },
    { role: 'user', content: 'the filter is clear' },
    { role: 'assistant', content: 'Please confirm the model.' },
    { role: 'user', content: 'yes the model is correct' },
  ];
  const safe = lmSafeMessages(assistantFirst);
  check('H1 UNDERSTAND window drops a leading assistant turn', safe[0] && safe[0].role === 'user');
  check('H2 UNDERSTAND window keeps the latest confirmation', safe[safe.length - 1].content.includes('model is correct'));
  check('H3 already user-first history is unchanged', lmSafeMessages(followUpMessages)[0].role === 'user');
}

{
  const waterIntent = { applianceType: null, alreadyReplaced: [], checksReported: [] };
  preferAccessibleFirstAction(waterIntent, 'Finished with water in the drum, spin just hums, do I need a pump?');
  check('I1 standing water after emptying attempt is an accessible filter check', /filter|trap/i.test(waterIntent.nextBestCheck));
  check('I1b next action is a check not identity', waterIntent._nextAction === 'check');
  check('I1c standing-water check is customer-safe', waterIntent.nextCheckCustomerSafe === true);
  const dryerIntent = { applianceType: 'tumble dryer', alreadyReplaced: [], checksReported: [] };
  preferAccessibleFirstAction(dryerIntent, 'tumble dryer drum turns, no heat');
  check('I2 dryer no-heat prefers airflow before heat parts', /fluff|lint|airflow|vent/i.test(dryerIntent.nextBestCheck));
  const vacIntent = { applianceType: null, alreadyReplaced: [], checksReported: [] };
  preferAccessibleFirstAction(vacIntent, 'dyson v6 pulsing');
  check('I2b vacuum pulsing prefers filter/blockage not battery', /filter|blockage|bin/i.test(vacIntent.nextBestCheck));
  check('I2c vacuum pulsing is a current-action check', vacIntent._nextAction === 'check');
  const vacCtx = buildComposeContext(
    { applianceType: 'vacuum', facts: [], nextBestCheck: vacIntent.nextBestCheck, _nextAction: 'check' },
    null, null, false, { mention: 'none', purchaseAppropriate: false },
    conversationProgress([{ role: 'user', content: 'dyson v6 pulsing' }]),
  );
  check('I2d vacuum pulsing compose does not mention battery',
    /filter|blockage|bin/i.test(vacCtx[0].content) && !/battery|charger/i.test(vacCtx[0].content));
  const skippedVac = {
    applianceType: 'vacuum',
    alreadyReplaced: [],
    checksReported: ['cleaned the filters'],
    nextBestCheck: 'Check the battery next',
    nextCheckCustomerSafe: false,
  };
  preferAccessibleFirstAction(
    skippedVac,
    'dyson v6 pulsing I have not checked anything yet, what should I do first?',
    conversationProgress([
      { role: 'user', content: 'dyson v6 pulsing' },
      { role: 'assistant', content: 'Empty the bin and clean the filters.' },
      { role: 'user', content: 'I have not checked anything yet, what should I do first?' },
    ]),
  );
  check('I2e not-yet-checked does not treat advisor filter advice as done',
    /filter|blockage|bin/i.test(skippedVac.nextBestCheck || '') && skippedVac.nextCheckCustomerSafe === true);
  const notYetCtx = buildComposeContext(
    { applianceType: 'vacuum', facts: [], nextBestCheck: skippedVac.nextBestCheck, _nextAction: 'check' },
    null, null, false, { mention: 'none', purchaseAppropriate: false },
    conversationProgress([
      { role: 'user', content: 'dyson v6 pulsing' },
      { role: 'assistant', content: 'Empty the bin and clean the filters.' },
      { role: 'user', content: 'I have not checked anything yet, what should I do first?' },
    ]),
  );
  check('I2f not-yet-checked compose repeats the current check',
    /NOT performed the check/i.test(notYetCtx[0].content));
  const dryingOutcome = { applianceType: null, alreadyReplaced: [], checksReported: [] };
  preferAccessibleFirstAction(dryingOutcome, 'used to squeal, now silent and not drying');
  check('I3 not-drying is not rewritten as no-heat airflow', dryingOutcome._nextAction !== 'check');
  const replaced = { applianceType: 'tumble dryer', alreadyReplaced: ['heating element'], checksReported: [] };
  preferAccessibleFirstAction(replaced, 'changed the element, still no heat');
  check('I4 known dryer with replaced element still gets airflow not another element', /fluff|lint|airflow|vent/i.test(replaced.nextBestCheck || ''));
  const driveIntent = { applianceType: null, facts: [{ name: 'drumTurns', value: 'FALSE' }], alreadyReplaced: [], checksReported: [] };
  preferAccessibleFirstAction(driveIntent, 'hear the motor, drum not turning, belt?');
  check('I8 motor-runs drum-not-turning prefers isolate then drum-by-hand', /drum by hand|turns freely/i.test(driveIntent.nextBestCheck || ''));
  check('I8b drive discriminator is a check not a confirmed part', driveIntent._nextAction === 'check');
  const fuseIntent = { applianceType: null, alreadyReplaced: ['thermal fuse'], checksReported: [] };
  preferAccessibleFirstAction(fuseIntent, 'changed the thermal fuse twice already and it keeps popping. is the fuse just weak?');
  check('I9 repeated thermal-protection failure looks for the cause not another fuse', /airflow|vent|lint/i.test(fuseIntent.nextBestCheck || ''));
  check('I9b repeated protective failure stays in-scope', fuseIntent.nextCheckCustomerSafe === true && fuseIntent._nextAction === 'check');
  const washFinished = { applianceType: null, alreadyReplaced: [], checksReported: [] };
  preferAccessibleFirstAction(washFinished, 'Wash finished, water still in the drum, spin just hums. Is it the pump?');
  check('I1d finished-cycle standing water still routes to the filter', /filter|trap/i.test(washFinished.nextBestCheck || '') && washFinished._nextAction === 'check');
  const lockHum = { applianceType: 'washing-machine', alreadyReplaced: [], checksReported: [], facts: [{ name: 'humNoise', value: 'TRUE' }] };
  preferAccessibleFirstAction(lockHum, 'My Hotpoint turns on and locks the door but then just sits there humming and doesn\'t start the wash.');
  check('I18 lock+hum asks whether water enters rather than assuming standing water',
    lockHum._nextAction === 'discriminator' && /water start coming/i.test(lockHum.clarifyingQuestion || '')
    && !/standing water/i.test(lockHum.nextBestCheck || ''));
  const unnamedHeater = { applianceType: null, alreadyReplaced: ['element'], checksReported: [] };
  preferAccessibleFirstAction(unnamedHeater, 'new element fitted and still not heating');
  check('I4b replaced heater without a family is identification not a reset', unnamedHeater._nextAction === 'identification');
  const unnamedHeaterCtx = buildComposeContext(
    { applianceType: null, alreadyReplaced: ['element'] },
    null, null, false, { mention: 'none', purchaseAppropriate: false },
    conversationProgress([{ role: 'user', content: 'replaced the heater but it\'s still cold' }]),
  );
  check('I4c unnamed heater identity compose lists no families',
    /which appliance/i.test(unnamedHeaterCtx[0].content)
    && !/washing machine|tumble dryer|\boven\b|microwave/i.test(unnamedHeaterCtx[0].content));
  check('I4d unnamed heater compose keeps remaining heat-path with identity',
    /airflow|thermostat|cut-out|wiring/i.test(unnamedHeaterCtx[0].content)
    && /which appliance/i.test(unnamedHeaterCtx[0].content)
    && !/nothing else/i.test(unnamedHeaterCtx[0].content));
  check('I4e unnamed heater next action names remaining heat-path',
    /airflow|thermostat|cut-out|wiring/i.test(unnamedHeater.nextBestCheck || '')
    && unnamedHeater._identificationDirection
    && /airflow|thermostat/i.test(unnamedHeater._identificationDirection));
  const heatThenCutsCtx = buildComposeContext(
    { applianceType: null, facts: [] },
    null, null, false, { mention: 'none', purchaseAppropriate: false },
    conversationProgress([{ role: 'user', content: 'it heats up then dies after about 10 mins, fine once it\'s cooled' }]),
  );
  check('I31 unlocated heat-then-cuts asks identity without listing types',
    /Which appliance is this/i.test(heatThenCutsCtx[0].content)
    && !/\bdryer\b|\boven\b|\bcooker\b|e\.g\./i.test(heatThenCutsCtx[0].content));
  // Story 2: "drum doesn't move" is an authoritative Jev observation (drumTurns=FALSE).
  const drumMove = { applianceType: null, alreadyReplaced: [], checksReported: [], facts: [{ name: 'drumTurns', value: 'FALSE' }] };
  preferAccessibleFirstAction(drumMove, 'it fills up but the drum doesn\'t move at all. belt looks alright from the back. motor gone?');
  check('I8c drum-does-not-move is the same drive discriminator', /drum by hand/i.test(drumMove.nextBestCheck || '') && drumMove._nextAction === 'check');
}

{
  check('I10 scraping without hazard is acoustic-only', isAcousticOnlyQuery('Scraping noise, is it safe to keep using?'));
  check('I10b burning with scraping is not acoustic-only', !isAcousticOnlyQuery('scraping and a burning smell'));
  check('I10c household trip is not acoustic-only', !isAcousticOnlyQuery('it scrapes and trips the RCD'));
  const theoryIntent = { customerTheories: [], facts: [{ name: 'drumTurns', value: 'FALSE' }], primaryFinding: 'broken or slipped drive belt', primaryFindingKind: 'component', candidateComponents: ['drive belt'] };
  captureQuestionedCause(theoryIntent, 'My tumble dryer is running but the drum isn\'t turning. I can hear the motor. Is that likely to be the belt?');
  check('I11 questioned cause is captured as a theory', (theoryIntent.customerTheories || []).some((t) => /belt/i.test(t)));
  demoteUnconfirmedTheoryFinding(theoryIntent);
  check('I11b unconfirmed theory is not a committed component', theoryIntent.primaryFindingKind === 'subsystem');
  check('I11c belt is not left as the confirmed finding', !/broken or slipped drive belt/i.test(theoryIntent.primaryFinding || ''));
  const noiseCtx = buildComposeContext(
    { applianceType: null, _applianceUnconfirmed: true, facts: [] },
    null, null, false, { mention: 'none', purchaseAppropriate: false },
    conversationProgress([{ role: 'user', content: 'Scraping noise, is it safe to keep using?' }]),
  );
  check('I12 noise-only compose stays precaution', /PRECAUTION/i.test(noiseCtx[0].content) && /not itself a STOP_USE/i.test(noiseCtx[0].content));
  check('I12b noise-only compose does not authorise continued use or command stop-use',
    /not say it is safe/i.test(noiseCtx[0].content)
    && /Do not tell them to stop using/i.test(noiseCtx[0].content));
  check('I12d noise-only compose forbids naming or assuming a family',
    /Do NOT name, assume, or continue as if a specific appliance family were already known/i.test(noiseCtx[0].content));
  const noiseFollow = buildComposeContext(
    { applianceType: 'tumble-dryer', facts: [] },
    null, null, false, { mention: 'none', purchaseAppropriate: false },
    conversationProgress([
      { role: 'user', content: 'Scraping noise, is it safe to keep using?' },
      { role: 'assistant', content: 'Which appliance is making the noise?' },
      { role: 'user', content: "It's a tumble dryer" },
    ]),
  );
  check('I12c after family is named, localise and do not invent a completed check',
    /Localise when and where/i.test(noiseFollow[0].content)
    && /Do not invent that they already checked/i.test(noiseFollow[0].content)
    && /not say it is safe to keep using/i.test(noiseFollow[0].content)
    && /do not tell them to stop using/i.test(noiseFollow[0].content));
  const inScopePrompt = buildComposeSystem(
    [], null,
    { applianceType: null, nextBestCheck: 'Unplug then turn the drum by hand', nextCheckCustomerSafe: true, _nextAction: 'check' },
    null, [], null, false, false, null, false, { mention: 'none', purchaseAppropriate: false },
  );
  check('I13 in-scope check does not halt remote diagnosis', /IN SCOPE/i.test(inScopePrompt) && !/remote\/customer diagnosis should stop/i.test(inScopePrompt));
  const driveCtx = buildComposeContext(
    { customerTheories: ['belt'], facts: [{ name: 'drumTurns', value: 'FALSE' }] },
    null, null, false, { mention: 'none', purchaseAppropriate: false },
    conversationProgress([{ role: 'user', content: 'hear the motor, drum not turning, belt?' }]),
  );
  check('I14 drive compose opens with unplug then drum-by-hand',
    /First, unplug/i.test(driveCtx[0].content) && /drum by hand/i.test(driveCtx[0].content)
    && /hypothesis/i.test(driveCtx[0].content) && !/two main possibilities/i.test(driveCtx[0].content));
  const namedAsk = { customerTheories: [], facts: [] };
  captureQuestionedCause(namedAsk, 'Zanussi E21 still showing after I cleaned the filter and hose. Drain works if I select it. Pressure sensor?');
  check('I15 trailing named cause is a theory not a purchase cue',
    (namedAsk.customerTheories || []).some((t) => /pressure sensor/i.test(t)));
  const afterClean = { applianceType: null, alreadyReplaced: [], checksReported: [] };
  preferAccessibleFirstAction(
    afterClean,
    'Zanussi E21 still showing after I cleaned the filter and hose. Drain works if I select it. Pressure sensor?',
  );
  check('I16 cleaned filter plus working drain stays a check not a part sale',
    afterClean._nextAction === 'check' && afterClean.nextCheckCustomerSafe === true
    && /pressure|standing water/i.test(afterClean.nextBestCheck || ''));
  const drainOnDemandCtx = buildComposeContext(
    afterClean,
    null, null, false, { mention: 'none', purchaseAppropriate: false },
    conversationProgress([{ role: 'user', content: 'Zanussi E21 still showing after I cleaned the filter and hose. Drain works if I select it. Pressure sensor?' }]),
  );
  check('I16b compose does not lead with control board after drain-on-demand',
    /dedicated drain or empty command working is not proof/i.test(drainOnDemandCtx[0].content)
    && /Do not tell the customer the machine is not draining/i.test(drainOnDemandCtx[0].content)
    && /pressure\/level/i.test(drainOnDemandCtx[0].content)
    && /Do not lead with the control board/i.test(drainOnDemandCtx[0].content));
  const echoed = stripInstructionEcho(
    'I understand the specific constraints regarding the "no-heat" diagnosis for your tumble dryer. I am ready to assist you with this fault. Please provide the model number so I can check part compatibility once we confirm the likely cause.',
  );
  check('I16c instruction-echo sentences are stripped from the customer reply',
    !/I understand the (?:specific )?constraints/i.test(echoed)
    && !/I am ready to assist you with this fault/i.test(echoed)
    && /model number/i.test(echoed));
  const stageEcho = stripInstructionEcho(
    'I am ready to proceed with Stage 1: diagnosing the likely cause. Please provide the customer\'s initial query or evidence so I can respond accordingly.',
  );
  check('I16c2 readiness and stage-label echoes are stripped',
    !/I am ready to proceed/i.test(stageEcho)
    && !/Stage 1/i.test(stageEcho)
    && !/customer(?:'s)? initial query/i.test(stageEcho));
  const dryerPrompt = buildComposeSystem(
    [], null, { applianceType: 'tumble-dryer' }, null, [], null, false, false, null, false,
    { mention: 'none', purchaseAppropriate: false },
  );
  check('I16d grounded-family compose has no labelled constraint header',
    !/FAMILY-COMPATIBLE ACTIONS/i.test(dryerPrompt)
    && /do not import another family's procedures/i.test(dryerPrompt)
    && /never mention these constraints/i.test(dryerPrompt));
  const premature = computePresentationGrain({
    intent: {
      userIntent: 'PART_REQUEST',
      candidateComponents: ['drain pump', 'filter'],
      primaryFindingKind: 'component',
      _nextAction: 'check',
      nextCheckCustomerSafe: true,
      furtherGenericCheckJustified: true,
      facts: [],
    },
    fault: { faultId: 'not-draining', node: drainNode, via: 'errorCode' },
    committedFinding: true,
    outcome: 'PART_ROUTING',
  });
  check('I17 outstanding check blocks purchase even on a named-part question',
    premature.purchaseAppropriate === false && premature.mention === COMPONENT_MENTION.DISCUSS);
}

{
  const hvIso = buildComposeSystem(
    [], null, { _isolationAdvisory: true }, null, [], null, false, false, 'hv-service', false,
    { mention: 'none', purchaseAppropriate: false },
  );
  check('I6b HV refuse does not add mains-isolation DIY continuation',
    /PROFESSIONAL-ONLY/i.test(hvIso) && !/isolate the appliance from the mains before any further checks/i.test(hvIso)
    && !/OPEN by telling them to isolate/i.test(hvIso));
}

{
  const facts = [{ name: 'drumTurns', value: 'FALSE' }];
  const amb = materialAmbiguity('motor-drum', CAT.faults['washing-machine']['motor-drum'], facts, 'washing-machine');
  check('I5 drum-not-turning does not ask whether water is standing', !amb || amb.fact !== 'waterRemaining');
}

{
  const hvCtx = buildComposeContext({}, null, null, false, { mention: 'none', purchaseAppropriate: false }, null, 'hv-service');
  check('I6 HV procedure compose refuses diagnosis', /PROFESSIONAL-ONLY|refuse the procedure/i.test(hvCtx[0].content));
}

{
  // isUnlocatedFunctionOutcome now consumes Jev's TYPED decision (family + symptomFamily), not the
  // customer's prose. "Unlocated" = Jev left the family unknown (intent.applianceType null) AND typed
  // a cross-family function-failure symptom (via _jev.decisions.symptomFamily or the 1:1 intent.fault).
  const typed = (symptomFamily, applianceType = null, fault = null) => ({
    applianceType,
    fault,
    _jev: { decisions: { symptomFamily } },
  });
  check('I20 a symptom Jev did not type as a function failure is not unlocated',
    isUnlocatedFunctionOutcome(typed('noisy')) === false);
  check('I21 family-unknown function failure (symptomFamily) is unlocated',
    isUnlocatedFunctionOutcome(typed('not_draining')) === true);
  check('I21b family-unknown not_heating is unlocated',
    isUnlocatedFunctionOutcome(typed('not_heating')) === true);
  check('I21c a NAMED family is not unlocated even with a function failure',
    isUnlocatedFunctionOutcome(typed('not_draining', 'tumble-dryer')) === false);
  check('I21d family-unknown not_filling is unlocated',
    isUnlocatedFunctionOutcome(typed('not_filling')) === true);
  check('I21e fault phrase alone (no _jev) still resolves the typed function failure',
    isUnlocatedFunctionOutcome({ applianceType: null, fault: 'not draining' }) === true);
  check('I21f a non-function symptom family (error_display) is not unlocated',
    isUnlocatedFunctionOutcome(typed('error_display')) === false);
  check('I21g a named washer is not unlocated',
    isUnlocatedFunctionOutcome(typed('not_filling', 'washing-machine')) === false);
  check('I21h hasFunctionFailureSymptom is family-independent (true even when family known)',
    hasFunctionFailureSymptom(typed('not_draining', 'washing-machine')) === true
    && hasFunctionFailureSymptom(typed('noisy')) === false);
  const loc = localisingQuestionAfterObservation(
    { facts: [{ name: 'humNoise', value: 'TRUE' }, { name: 'waterRemaining', value: 'TRUE' }] },
    'washing-machine',
    null,
  );
  check('I23 standing water does not localise to a fill question', loc == null);
  const lockCtx = buildComposeContext(
    { applianceType: 'washing-machine', facts: [{ name: 'humNoise', value: 'TRUE' }] },
    null, null, false, { mention: 'none', purchaseAppropriate: false },
    conversationProgress([{ role: 'user', content: 'Hotpoint locks and hums, won\'t start the wash.' }]),
  );
  check('I24 lock+hum compose does not mention standing water',
    /water starts coming|after the lock/i.test(lockCtx[0].content) && !/standing water/i.test(lockCtx[0].content));
  const impellerCtx = buildComposeContext(
    { applianceType: 'washing-machine', conditionLimited: ['drain pump'], checksReported: ['filter'] },
    null, null, false, { mention: 'none', purchaseAppropriate: false },
    conversationProgress([{ role: 'user', content: 'Siemens won\'t drain, cleaned filter, impeller by hand sometimes works.' }]),
  );
  check('I25 condition-limited impeller is not condemned',
    /condition-limited/i.test(impellerCtx[0].content)
    && /do not recommend a purchase/i.test(impellerCtx[0].content)
    && /do not ask for the model/i.test(impellerCtx[0].content));
  const impellerClearCtx = buildComposeContext(
    { applianceType: 'washing-machine', conditionLimited: ['drain pump'], checksReported: ['filter', 'pump'] },
    null, null, false, { mention: 'none', purchaseAppropriate: false },
    conversationProgress([
      { role: 'user', content: 'Siemens won\'t drain, cleaned filter, impeller by hand sometimes works.' },
      { role: 'assistant', content: 'Look at the housing if it is still accessible.' },
      { role: 'user', content: 'the pump and filter are clear' },
    ]),
  );
  check('I25b pump-and-filter-clear does not repeat the housing look',
    /pump and filter path clear/i.test(impellerClearCtx[0].content)
    && /make and model/i.test(impellerClearCtx[0].content));
  check('I26 current-action filter media uses the drain node',
    currentActionMediaFaultId({ _nextAction: 'check', nextBestCheck: 'Check the accessible pump filter or trap.' }, 'washing-machine') === 'not-draining');
  check('I26b discriminator is not a current-action media node',
    currentActionMediaFaultId({ _nextAction: 'discriminator', nextBestCheck: 'Does any water start coming in?' }, 'washing-machine') == null);
  check('I26c filter already done does not attach filter media',
    currentActionMediaFaultId({
      _nextAction: 'check',
      nextBestCheck: 'Check the drain hose for a kink or blockage.',
      checksReported: ['filter already done'],
    }, 'washing-machine') == null);
  check('I26d identification is not a drain-node media fallback',
    currentActionMediaFaultId({ _nextAction: 'identification', nextBestCheck: 'Ask for the model' }, 'washing-machine') == null);
  const heatUnknownCtx = buildComposeContext(
    { applianceType: 'tumble-dryer', facts: [{ name: 'drumTurns', value: 'TRUE' }] },
    null, null, false, { mention: 'none', purchaseAppropriate: false },
    conversationProgress([
      { role: 'user', content: 'Used to squeal, now silent and not drying.' },
      { role: 'assistant', content: 'Does the drum still turn, and is there useful heat?' },
      { role: 'user', content: 'The drum still turns. I am not sure about the heat.' },
    ]),
  );
  check('I28 unanswered heat is not treated as confirmed heat',
    /does not know whether there is heat/i.test(heatUnknownCtx[0].content)
    && /do not ask whether the drum turns again/i.test(heatUnknownCtx[0].content));
  const heatUnknownStale = buildComposeContext(
    { applianceType: 'tumble-dryer', facts: [{ name: 'drumTurns', value: 'FALSE' }] },
    null, null, false, { mention: 'none', purchaseAppropriate: false },
    conversationProgress([
      { role: 'user', content: 'Used to squeal, now silent and not drying.' },
      { role: 'assistant', content: 'Does the drum still turn, and is there useful heat?' },
      { role: 'user', content: 'The drum still turns. I am not sure about the heat.' },
    ]),
  );
  check('I28b latest heat-unknown outranks a stale drum fact',
    /does not know whether there is heat/i.test(heatUnknownStale[0].content));
  const silentFamilyCtx = buildComposeContext(
    { applianceType: 'tumble-dryer', facts: [] },
    null, null, false, { mention: 'none', purchaseAppropriate: false },
    conversationProgress([
      { role: 'user', content: 'it squealed for ages, now it\'s gone silent and isn\'t drying' },
      { role: 'assistant', content: 'Which appliance is this?' },
      { role: 'user', content: "It's a Beko tumble dryer" },
    ]),
  );
  check('I29 timeline after family asks which function changed',
    /timeline, not a mechanism|drum still turns/i.test(silentFamilyCtx[0].content)
    && !/\bbelt\b|\bbearing\b|\bmotor\b|\bpulley\b/i.test(silentFamilyCtx[0].content));
  const silentCurlyCtx = buildComposeContext(
    { applianceType: 'tumble-dryer', facts: [] },
    null, null, false, { mention: 'none', purchaseAppropriate: false },
    conversationProgress([
      { role: 'user', content: 'it squealed for ages, now it\u2019s gone silent and isn\u2019t drying' },
      { role: 'assistant', content: 'Which appliance is this?' },
      { role: 'user', content: "It's a Beko tumble dryer" },
    ]),
  );
  check('I29b curly-apostrophe timeline still asks drum and heat, not a named part',
    /timeline, not a mechanism|drum still turns/i.test(silentCurlyCtx[0].content)
    && !/\bbelt\b|\bbearing\b|\bmotor\b|\bpulley\b/i.test(silentCurlyCtx[0].content));

  const proposedPump = { customerTheories: [], facts: [{ name: 'humNoise', value: 'TRUE' }], checksReported: [] };
  captureQuestionedCause(proposedPump, 'dishwasher hums, filter clear, check before I buy a pump?');
  check('I38 buy-a-pump phrasing is a customer theory',
    (proposedPump.customerTheories || []).some((t) => /\bpump\b/i.test(t)));
  proposedPump.userIntent = 'PART_REQUEST';
  demotePrematurePartRequest(proposedPump, 'dishwasher hums, filter clear, check before I buy a pump?');
  check('I38b proposed pump is not a part request before drain is established',
    proposedPump.userIntent !== 'PART_REQUEST');
  check('I38c proposed drain-path part is detected',
    customerProposedDrainPathPart(proposedPump, 'dishwasher hums, filter clear, check before I buy a pump?'));
  const locPump = localisingQuestionAfterObservation(
    { facts: [{ name: 'humNoise', value: 'TRUE' }], customerTheories: ['pump'], checksReported: ['filter clear'] },
    'dishwasher',
    conversationProgress([{ role: 'user', content: 'dishwasher hums, filter clear, check before I buy a pump?' }]),
  );
  check('I38d unlocalised hum with a proposed pump asks the drain event, not fill',
    locPump && locPump.fact === 'drainEvent' && /should be draining/i.test(locPump.question)
    && !/without filling/i.test(locPump.question));
  const locBareHum = localisingQuestionAfterObservation(
    { facts: [{ name: 'humNoise', value: 'TRUE' }], customerTheories: [], checksReported: [] },
    'dishwasher',
    conversationProgress([{ role: 'user', content: 'dishwasher just hums' }]),
  );
  check('I38e unlocalised hum without drain-path evidence does not default to fill',
    !locBareHum || locBareHum.fact !== 'waterEntering');
  const pumpFirst = {
    applianceType: 'dishwasher',
    alreadyReplaced: [],
    checksReported: ['filter clear'],
    facts: [{ name: 'humNoise', value: 'TRUE' }],
    customerTheories: ['pump'],
  };
  preferAccessibleFirstAction(pumpFirst, 'dishwasher hums, filter clear, check before I buy a pump?');
  check('I38f first action is drain-event discriminator not fill and not a purchase',
    pumpFirst._nextAction === 'discriminator'
    && /should be draining/i.test(pumpFirst.clarifyingQuestion || '')
    && !/without filling/i.test(pumpFirst.nextBestCheck || ''));
  const afterDrain = {
    applianceType: 'dishwasher',
    alreadyReplaced: [],
    checksReported: ['filter clear'],
    facts: [{ name: 'humNoise', value: 'TRUE' }, { name: 'waterRemaining', value: 'TRUE' }, { name: 'noiseOnDrain', value: 'TRUE' }],
    customerTheories: ['pump'],
  };
  preferAccessibleFirstAction(
    afterDrain,
    'dishwasher hums, filter clear, check before I buy a pump? Yes, there is water left in the bottom and I can hear it humming when it should be draining.',
  );
  check('I38h after drain is established, next is accessible impeller not another filter or fill',
    afterDrain._nextAction === 'check'
    && /impeller|pump/i.test(afterDrain.nextBestCheck || '')
    && !/clean the filter again|without filling/i.test(afterDrain.nextBestCheck || ''));
  const impellerClear = {
    applianceType: 'dishwasher',
    model: 'SMS50C12GB',
    alreadyReplaced: [],
    checksReported: ['filter clear'],
    facts: [{ name: 'waterRemaining', value: 'TRUE' }, { name: 'noiseOnDrain', value: 'TRUE' }],
    customerTheories: ['pump'],
  };
  preferAccessibleFirstAction(
    impellerClear,
    'The impeller turns and I cannot see anything blocking it. E-Nr is SMS50C12GB.',
  );
  check('I38i impeller clear with model stays advice, not purchase',
    impellerClear._nextAction === 'advice'
    && impellerClear.primaryFindingKind === 'subsystem'
    && remainingActionBlocksPurchase(impellerClear) === true);
  const impellerGrain = computePresentationGrain({
    intent: impellerClear,
    fault: { node: drainNode, via: 'classified' },
    committedFinding: true,
    outcome: 'PART_ROUTING',
  });
  check('I38i2 impeller clear with model does not sell the pump',
    impellerGrain.purchaseAppropriate === false
    && impellerGrain.mention === COMPONENT_MENTION.DISCUSS);
  const afterImpellerCtx = buildComposeContext(
    impellerClear,
    { node: drainNode, via: 'classified' },
    null, false,
    { mention: COMPONENT_MENTION.DISCUSS, purchaseAppropriate: false },
    conversationProgress([
      { role: 'user', content: 'Bosch dishwasher hums, filter clear, check before I buy a pump?' },
      { role: 'assistant', content: 'When it hums, is there water left when it should be draining?' },
      { role: 'user', content: 'Yes, water left in the bottom when it should be draining.' },
      { role: 'assistant', content: 'Unplug, then look at the accessible impeller.' },
      { role: 'user', content: 'The impeller turns and I cannot see anything blocking it. E-Nr is SMS50C12GB.' },
    ]),
  );
  check('I38k compose after impeller+model does not instruct replacement as the next step',
    /hypothesis/i.test(afterImpellerCtx[0].content)
    && /downstream restriction/i.test(afterImpellerCtx[0].content)
    && !/it may be offered with advice before replacement/i.test(afterImpellerCtx[0].content)
    && /do NOT say the next step is to replace/i.test(afterImpellerCtx[0].content));
  const noHeatDryerCtx = buildComposeContext(
    {
      applianceType: 'tumble-dryer',
      facts: [{ name: 'noHeat', value: 'TRUE' }, { name: 'drumTurns', value: 'TRUE' }],
      customerTheories: ['heater'],
    },
    null, null, false, { mention: 'none', purchaseAppropriate: false },
    conversationProgress([{ role: 'user', content: 'tumble dryer going round but clothes stay cold, is it the heater' }]),
  );
  check('I30 no-heat dryer compose does not invent intermittent heat',
    /not heat produced sometimes/i.test(noHeatDryerCtx[0].content)
    && !/heat-then-cut timeline is established/i.test(noHeatDryerCtx[0].content));
  const pumpAskCtx = buildComposeContext(
    {
      applianceType: 'dishwasher',
      facts: [{ name: 'humNoise', value: 'TRUE' }],
      customerTheories: ['pump'],
      checksReported: ['filter clear'],
      _observationAmbiguity: {
        fact: 'drainEvent',
        question: 'When it hums, is there water left in the bottom, and is that happening when the machine should be draining?',
      },
    },
    null, null, false, { mention: 'none', purchaseAppropriate: false },
    conversationProgress([{ role: 'user', content: 'dishwasher hums, filter clear, check before I buy a pump?' }]),
  );
  check('I38j compose does not agree the pump or ask about filling',
    /hypothesis/i.test(pumpAskCtx[0].content)
    && /should be draining/i.test(pumpAskCtx[0].content)
    && !/water start coming into the machine/i.test(pumpAskCtx[0].content));
}

// ---------------------------------------------------------------------------
// J. Useful ADVICE_ONLY help is not a completed journey
// ---------------------------------------------------------------------------
{
  const dryingNode = CAT.faults.dishwasher['poor-drying'];
  const dirtyGlass = CAT.faults['oven-cooker']['door-glass-dirty'];
  const opening = conversationProgress([{ role: 'user', content: 'Dishes hot but not dry.' }]);
  const dryingIntent = {
    applianceType: 'dishwasher',
    needMoreInfo: false,
    facts: [{ name: 'heatPresent', value: 'TRUE' }],
    primaryFinding: 'drying performance rather than a complete heating failure',
    primaryFindingKind: 'condition',
  };
  preferAdviceThenIdentity(dryingIntent, opening, {
    fault: { faultId: 'poor-drying', node: dryingNode, via: 'classified' },
    queryText: 'Dishes hot but not dry.',
  });
  check('J1 ADVICE_ONLY drying without model continues with advice then identity',
    dryingIntent._nextAction === 'advice_then_identity' && dryingIntent.needMoreInfo === true);
  check('J1b identity is not the exclusive next action',
    identificationIsNextAction(dryingIntent, opening) === false);
  check('J1c remaining action still blocks a part sale',
    remainingActionBlocksPurchase(dryingIntent) === true);
  check('J1d identity ask does not re-ask which appliance when dishes established the family',
    /make and model/i.test(dryingIntent.clarifyingQuestion)
    && !/which appliance/i.test(dryingIntent.clarifyingQuestion));

  const checkFirst = {
    applianceType: 'washing-machine',
    needMoreInfo: true,
    _nextAction: 'check',
    nextBestCheck: 'Check the accessible pump filter or trap.',
    nextCheckCustomerSafe: true,
    facts: [{ name: 'waterRemaining', value: 'TRUE' }],
  };
  preferAccessibleFirstAction(checkFirst, 'Finished with water in the drum, spin just hums', conversationProgress([
    { role: 'user', content: 'Finished with water in the drum, spin just hums, do I need a pump?' },
  ]));
  preferAdviceThenIdentity(checkFirst, conversationProgress([
    { role: 'user', content: 'Finished with water in the drum, spin just hums, do I need a pump?' },
  ]), {
    fault: { faultId: 'poor-drying', node: dryingNode, via: 'classified' },
    queryText: 'Finished with water in the drum, spin just hums, do I need a pump?',
  });
  check('J2 physical check stays preferred over advice-then-identity',
    checkFirst._nextAction === 'check');

  const recovered = {
    applianceType: 'dishwasher',
    needMoreInfo: false,
  };
  preferAdviceThenIdentity(recovered, conversationProgress([
    { role: 'user', content: 'Dishes hot but not dry.' },
    { role: 'assistant', content: 'Top up rinse aid and tell me the make and model.' },
    { role: 'user', content: 'It\'s all sorted now.' },
  ]), {
    fault: { faultId: 'poor-drying', node: dryingNode, via: 'classified' },
    queryText: 'It\'s all sorted now.',
  });
  check('J3 recovered function does not ask identity',
    recovered._nextAction !== 'advice_then_identity');

  const knownModel = {
    applianceType: 'dishwasher',
    model: 'SMS50C12GB',
    make: 'Bosch',
    needMoreInfo: false,
  };
  preferAdviceThenIdentity(knownModel, conversationProgress([
    { role: 'user', content: 'Dishes hot but not dry.' },
    { role: 'assistant', content: 'Top up rinse aid. What make and model is it?' },
    { role: 'user', content: 'Rinse aid is full and I\'m using the normal programme. It\'s a Bosch SMS50C12GB.' },
  ]), {
    fault: { faultId: 'poor-drying', node: dryingNode, via: 'classified' },
    queryText: 'Rinse aid is full and I\'m using the normal programme. It\'s a Bosch SMS50C12GB.',
  });
  check('J4 known model does not re-ask identity',
    knownModel._nextAction !== 'advice_then_identity');

  const glassIntent = { applianceType: 'oven-cooker', needMoreInfo: false };
  preferAdviceThenIdentity(glassIntent, conversationProgress([
    { role: 'user', content: 'filthy between the oven door panes' },
  ]), {
    fault: { faultId: 'door-glass-dirty', node: dirtyGlass, via: 'classified' },
    queryText: 'filthy between the oven door panes',
  });
  check('J5 complete advice-only resolution does not invent an identity ask',
    glassIntent._nextAction !== 'advice_then_identity');

  const composeAdvice = buildComposeContext(
    { applianceType: 'dishwasher', _nextAction: 'advice_then_identity', needMoreInfo: true },
    { faultId: 'poor-drying', node: dryingNode, via: 'classified' },
    null, false, { mention: 'none', purchaseAppropriate: false },
    opening,
  );
  check('J6 compose leads with advice and still asks identity',
    /ADVICE FIRST, THEN IDENTITY/i.test(composeAdvice[0].content)
    && /make and model/i.test(composeAdvice[0].content)
    && /do not close/i.test(composeAdvice[0].content)
    && /standing water or a drain/i.test(composeAdvice[0].content)
    && !/Ask exactly this question and nothing else/i.test(composeAdvice[0].content));

  const followUpAfterAdvice = conversationProgress([
    { role: 'user', content: 'Dishes hot but not dry.' },
    { role: 'assistant', content: 'Heat is reaching the load, so this is drying rather than a complete heating failure. Top up rinse aid and avoid Eco/Quick. What make and model is on the rating plate?' },
    { role: 'user', content: 'Rinse aid is full and I\'m using the normal programme. It\'s a Bosch SMS50C12GB.' },
  ]);
  const composeT2 = buildComposeContext(
    {
      applianceType: 'dishwasher',
      make: 'Bosch',
      model: 'SMS50C12GB',
      facts: [{ name: 'heatPresent', value: 'TRUE' }],
      checksReported: ['rinse aid full', 'normal programme'],
    },
    { faultId: 'poor-drying', node: dryingNode, via: 'classified' },
    null, false, { mention: 'none', purchaseAppropriate: false },
    followUpAfterAdvice,
  );
  check('J7 follow-up compose does not repeat answered settings advice',
    /FOLLOW-UP/i.test(composeT2[0].content)
    && /do not repeat/i.test(composeT2[0].content)
    && /identified machine/i.test(composeT2[0].content));
  check('J7b follow-up compose keeps drying path after heat reached the load',
    /drying path/i.test(composeT2[0].content)
    && /wash-coverage/i.test(composeT2[0].content));

  const sys = buildComposeSystem(
    [], null,
    { applianceType: 'dishwasher', _nextAction: 'advice_then_identity', needMoreInfo: true, confidence: 0.9 },
    { faultId: 'poor-drying', node: dryingNode, via: 'classified' },
    [], null, false, false, null, true, { mention: 'none', purchaseAppropriate: false },
    opening,
  );
  check('J8 compose system keeps advice and identity together',
    /ADVICE FIRST, THEN IDENTITY/i.test(sys) && !/Do NOT push for the model number to sell a part/.test(sys));
  // J9/J9b/J9c removed: guessApplianceFamily (customer-prose family classification) is deleted;
  // dishwasher-vs-washer-dryer disambiguation is Jev's typed applianceFamily now.
  check('J9d heat-at-load compose does not prove the heater healthy',
    /downranks a complete heating failure/i.test(composeAdvice[0].content)
    && /not say the heater or element is proven healthy/i.test(composeAdvice[0].content));
  const missingAsk = ensureAdviceThenIdentityAsk(
    'Top up rinse aid and avoid Eco programmes.',
    { _nextAction: 'advice_then_identity', clarifyingQuestion: 'What is the make and model number (on the rating plate)?' },
  );
  check('J11 advice-then-identity reply still asks for identity',
    /make and model/i.test(missingAsk));
  const ev = collectEvidence(
    { facts: [{ name: 'heatPresent', value: 'TRUE' }], provenGood: ['heater element'] },
    'Dishes hot but not dry.',
    { faultId: 'poor-drying', node: dryingNode },
  );
  check('J12 heatPresent does not put the heater in provenGood',
    !ev.provenGood.some((p) => /heater|element/i.test(p))
    && ev.conditionLimited.some((p) => /heater|element/i.test(p)));
  const priorAdvice = 'Since the dishes are hot but wet, this points to a drying issue rather than a heating fault. The most effective fix is usually topping up the rinse aid, which helps water sheet off dishes instead of forming droplets; you should also ensure you aren\'t using Eco or Quick programmes (which often skip the heated dry phase) and allow a few minutes for condensation drying before opening the door, bearing in mind that plastics naturally retain more moisture than glass or ceramic. To help me narrow down the specific drying mechanism for your machine (such as condensation, fan-assisted, or auto-open door), could you please provide the make and model number, or a photo of the rating plate?';
  const copyProgress = conversationProgress([
    { role: 'user', content: 'Dishes hot but not dry.' },
    { role: 'assistant', content: priorAdvice },
    { role: 'user', content: 'Rinse aid is full and I\'m using the normal programme. It\'s a Bosch SMS50C12GB.' },
  ]);
  // Structured control guidance carries the "don't repeat, progress one step" decision to
  // COMPOSE. It references the prior advice as context and instructs progression, but is
  // trusted control text (never quoted), so no internal directive can become customer prose.
  const dwNote = composeFollowUpNote(copyProgress, { model: 'SMS50C12GB', make: 'Bosch' });
  check('J13 follow-up note tells COMPOSE not to repeat prior advice and to move one step',
    dwNote.length > 0
    && /Do NOT repeat, paste, or paraphrase it/i.test(dwNote)
    && /exactly ONE step/i.test(dwNote)
    && /NEVER quote/i.test(dwNote));
  check('J13b follow-up note carries the prior advice as trusted context, not as a customer line',
    dwNote.indexOf('topping up the rinse aid') !== -1
    && /trusted control guidance/i.test(dwNote));
  const vacAdvice = 'Pulsing on a Dyson V6 usually means a blockage in the hose, wand, or filter. Please empty the bin, clean the filters thoroughly, and clear any blockages before trying again.';
  const vacNotChecked = conversationProgress([
    { role: 'user', content: 'dyson v6 pulsing' },
    { role: 'assistant', content: vacAdvice },
    { role: 'user', content: 'I have not checked anything yet, what should I do first?' },
  ]);
  const vacNotCheckedNote = composeFollowUpNote(vacNotChecked, { model: 'V6' });
  check('J13c unchecked first-line: note asks for ONE clear first step, not the whole procedure',
    /ONE clear first thing to do now/i.test(vacNotCheckedNote)
    && !/exactly ONE step/i.test(vacNotCheckedNote));
  check('J13d follow-up note is empty on a non-follow-up (single-turn) conversation',
    composeFollowUpNote(conversationProgress([{ role: 'user', content: 'dyson v6 pulsing' }]), { model: 'V6' }) === '');
  // ensureNonTerminalProgression must only ever append genuine customer-facing prose — never an
  // identification/orchestration control directive (that is what leaked before).
  const idDirective = ensureNonTerminalProgression('Thanks, noted.', {
    _nextAction: 'identification',
    nextBestCheck: 'Ask for the make and model, or a photo of the rating plate. Do not re-ask the make.',
    clarifyingQuestion: 'What is the make and model number (on the rating plate)?',
  }, {});
  check('J13e non-terminal progression never appends an internal "Ask for…" directive as the reply',
    !/^\s*Ask for the make and model/i.test(idDirective.replace(/^Thanks, noted\.\s*/i, ''))
    && !/Do not re-ask the make/i.test(idDirective));
  const washQuality = CAT.faults.dishwasher['poor-clean-results'];
  const switched = preferArchitectureDependentAdvice(
    { applianceType: 'dishwasher', facts: [{ name: 'heatPresent', value: 'TRUE' }] },
    { faultId: 'poor-clean-results', node: washQuality, via: 'classified' },
    'Dishwasher gets them hot but they don\'t dry.',
  );
  check('J15 hot-but-not-dry does not stay on wash-quality advice',
    switched && switched.faultId === 'poor-drying');
  // Story 2: heat-reached-the-load is an authoritative Jev observation (heatPresent=TRUE).
  const switchedFromText = preferArchitectureDependentAdvice(
    { applianceType: 'dishwasher', facts: [{ name: 'heatPresent', value: 'TRUE' }] },
    { faultId: 'poor-clean-results', node: washQuality, via: 'classified' },
    "Dishwasher gets them hot but they don't dry.",
  );
  check('J17 heat-at-load (Jev fact) still leaves wash-quality for drying',
    switchedFromText && switchedFromText.faultId === 'poor-drying');
  const switchedFromNull = preferArchitectureDependentAdvice(
    { applianceType: 'dishwasher', facts: [{ name: 'heatPresent', value: 'TRUE' }] },
    null,
    "Dishwasher gets them hot but they don't dry.",
  );
  check('J18 unresolved heat-at-load still grounds the drying advice node',
    switchedFromNull && switchedFromNull.faultId === 'poor-drying');
  const dryingFromNull = { applianceType: 'dishwasher', needMoreInfo: false, facts: [{ name: 'heatPresent', value: 'TRUE' }] };
  preferAdviceThenIdentity(dryingFromNull, conversationProgress([
    { role: 'user', content: "Dishwasher gets them hot but they don't dry." },
  ]), {
    fault: switchedFromNull,
    queryText: "Dishwasher gets them hot but they don't dry.",
  });
  check('J18b grounded drying node continues with advice then identity',
    dryingFromNull._nextAction === 'advice_then_identity');
  const followUpIdentityProgress = conversationProgress([
    { role: 'user', content: 'Dishes hot but not dry.' },
    { role: 'assistant', content: 'Heat is reaching the load. Top up rinse aid and avoid Eco/Quick. What make and model is on the rating plate?' },
    { role: 'user', content: 'Rinse aid is full and I am using the normal programme. It is a Bosch SMS50C12GB.' },
  ]);
  const switchedOnIdentityTurn = preferArchitectureDependentAdvice(
    { applianceType: 'dishwasher', facts: [{ name: 'heatPresent', value: 'TRUE' }] },
    { faultId: 'poor-clean-results', node: washQuality, via: 'classified' },
    'Rinse aid is full and I am using the normal programme. It is a Bosch SMS50C12GB.',
    followUpIdentityProgress,
  );
  check('J20 identity follow-up still leaves wash-quality for drying',
    switchedOnIdentityTurn && switchedOnIdentityTurn.faultId === 'poor-drying');
}

{
  const fillDrainCtx = buildComposeContext(
    // Jev typed a cross-family function failure (symptomFamily) but left the family unknown.
    { applianceType: null, _applianceUnconfirmed: true, fault: 'not draining', _jev: { decisions: { symptomFamily: 'not_draining' } }, facts: [{ name: 'waterEntering', value: 'TRUE' }, { name: 'commandedDrain', value: 'TRUE' }] },
    null, null, false, { mention: 'none', purchaseAppropriate: false },
    conversationProgress([{ role: 'user', content: 'it takes water then the cycle stops. emptying works if I cancel.' }]),
  );
  check('K3 unlocated function-outcome compose asks identity and preserves observed functions',
    /Which appliance is this/i.test(fillDrainCtx[0].content)
    && /Acknowledge observed functions only/i.test(fillDrainCtx[0].content)
    && /condition-limited/i.test(fillDrainCtx[0].content)
    && /do not infer one from shared functions/i.test(fillDrainCtx[0].content)
    && !/\bdryer\b|\boven\b|\bcooker\b|e\.g\./i.test(fillDrainCtx[0].content));
  const afterFamily = buildComposeContext(
    { applianceType: 'washing-machine', fault: 'not draining', _jev: { decisions: { symptomFamily: 'not_draining' } }, facts: [{ name: 'waterEntering', value: 'TRUE' }, { name: 'commandedDrain', value: 'TRUE' }] },
    null, null, false, { mention: 'none', purchaseAppropriate: false },
    conversationProgress([
      { role: 'user', content: 'it takes water then the cycle stops. emptying works if I cancel.' },
      { role: 'assistant', content: 'What kind of appliance is it?' },
      { role: 'user', content: "It's a washing machine" },
    ]),
  );
  check('K4 after family is named, continue from observed functions and do not re-ask identity',
    /family is now known/i.test(afterFamily[0].content)
    && /Continue from the functions already observed/i.test(afterFamily[0].content)
    && /Do not re-ask what type of appliance/i.test(afterFamily[0].content)
    && /condition-limited/i.test(afterFamily[0].content));
  const standing = { applianceType: null, _applianceUnconfirmed: true, alreadyReplaced: [], checksReported: [], candidateComponents: ['inlet valve'] };
  preferAccessibleFirstAction(standing, 'there is standing water left in the bottom');
  preferFamilyBeforeSpecificDiagnosis(
    standing,
    'there is standing water left in the bottom',
    conversationProgress([{ role: 'user', content: 'there is standing water left in the bottom' }]),
  );
  check('K5 standing water keeps a generic check even with unknown family',
    standing._nextAction === 'check' && standing.nextCheckCustomerSafe === true);
  const invented = {
    applianceType: null,
    _applianceUnconfirmed: true,
    faultId: 'not-filling',
    primaryFindingKind: 'component',
    primaryFinding: 'inlet path',
    candidateComponents: ['inlet valve', 'pressure switch'],
    alreadyReplaced: [],
    checksReported: [],
  };
  const opener = 'it takes water then the cycle stops. emptying works if I cancel.';
  preferFamilyBeforeSpecificDiagnosis(
    invented, opener, conversationProgress([{ role: 'user', content: opener }]), { fault: { faultId: 'not-filling', via: 'classified' } },
  );
  check('K6 unlocated unknown-family diagnosis is identification, not a named part',
    invented._nextAction === 'identification'
    && invented.faultId == null
    && (invented.candidateComponents || []).length === 0
    && /appliance/i.test(invented.clarifyingQuestion || '')
    && invented.nextBestCheck == null);
}

// ---------------------------------------------------------------------------
// L. COMPLETED-CHECK PROGRESSION — Jev's TYPED completed-check facts stop a cleared
// accessible check being recommended again, and advance the diagnosis. No prose/keyword
// dependence; driven by the typed facts (hoseChecked/filterChecked/impellerClear = TRUE).
// ---------------------------------------------------------------------------
{
  // filter + drain hose both typed-clear, water still left, impeller NOT yet inspected ->
  // advance to the impeller (a distinct check), NOT re-recommend the drain hose.
  const filterHoseClear = {
    applianceType: 'washing-machine', alreadyReplaced: [], checksReported: [],
    facts: [
      { name: 'waterRemaining', value: 'TRUE' },
      { name: 'filterChecked', value: 'TRUE' },
      { name: 'hoseChecked', value: 'TRUE' },
    ],
  };
  preferAccessibleFirstAction(
    filterHoseClear,
    "I checked the drain hose too and that's clear",
    conversationProgress([
      { role: 'user', content: "washing machine won't drain, water left" },
      { role: 'assistant', content: 'Check the pump filter at the bottom front.' },
      { role: 'user', content: 'the filter is clear' },
      { role: 'assistant', content: 'Check the drain hose for a kink or blockage.' },
      { role: 'user', content: "I checked the drain hose too and that's clear" },
    ]),
  );
  check('L1 cleared drain hose (typed fact) is not re-recommended',
    !/drain hose/i.test(filterHoseClear.nextBestCheck || ''), filterHoseClear.nextBestCheck);
  check('L1b advances to the accessible pump/impeller area instead',
    /impeller|pump/i.test(filterHoseClear.nextBestCheck || ''), filterHoseClear.nextBestCheck);

  // filter + hose + impeller all typed-clear, water still left, model known -> exhausted accessible
  // path: advise the next hypothesis, do not loop any completed check.
  const allClearKnownModel = {
    applianceType: 'washing-machine', model: 'WAE28167GB', alreadyReplaced: [], checksReported: [],
    facts: [
      { name: 'waterRemaining', value: 'TRUE' },
      { name: 'filterChecked', value: 'TRUE' },
      { name: 'hoseChecked', value: 'TRUE' },
      { name: 'impellerClear', value: 'TRUE' },
    ],
  };
  preferAccessibleFirstAction(
    allClearKnownModel,
    'the pump impeller is clear and spins freely too',
    conversationProgress([
      { role: 'user', content: "washing machine won't drain, water left, model WAE28167GB" },
      { role: 'assistant', content: 'Check the filter.' },
      { role: 'user', content: 'filter clear, hose clear, impeller clear' },
    ]),
  );
  check('L2 all accessible checks clear -> does not re-recommend filter/hose/impeller',
    !/\b(check the (drain hose|pump filter|accessible filter)|look in the user-accessible pump)\b/i.test(allClearKnownModel.nextBestCheck || ''),
    allClearKnownModel.nextBestCheck);
  check('L2b advances to a drain-path hypothesis / advice',
    allClearKnownModel._nextAction === 'advice' || /pump|sump|pressure/i.test(allClearKnownModel.nextBestCheck || ''),
    `${allClearKnownModel._nextAction} :: ${allClearKnownModel.nextBestCheck}`);

  // Filter clear but hose NOT yet checked -> recommending the drain hose is still correct progression.
  const filterOnlyClear = {
    applianceType: 'washing-machine', alreadyReplaced: [], checksReported: [],
    facts: [
      { name: 'waterRemaining', value: 'TRUE' },
      { name: 'filterChecked', value: 'TRUE' },
    ],
  };
  preferAccessibleFirstAction(
    filterOnlyClear, 'the filter is clear',
    conversationProgress([
      { role: 'user', content: "washing machine won't drain, water left" },
      { role: 'assistant', content: 'Check the filter.' },
      { role: 'user', content: 'the filter is clear' },
    ]),
  );
  check('L3 hose still recommended when it has NOT yet been checked (not over-suppressed)',
    /drain hose|impeller|pump/i.test(filterOnlyClear.nextBestCheck || ''), filterOnlyClear.nextBestCheck);
}

console.log(`\nconversation-progression: ${pass} passed / ${fail} failed`);
process.exit(fail ? 1 : 0);
