'use strict';
/**
 * Identification vs diagnosis vs fit-confidence — structural contracts.
 *
 * Identity (model / OCR / rating-plate) must not erase an unanswered diagnostic
 * discriminator, must not over-claim a hypothesis as a confirmed finding, and
 * customer-facing fit language must match structured catalogue evidence.
 *
 * Pure functions, no LLM, no network, no journey IDs, no appliance-specific wording.
 * Run: node services/part-finder/test/identification-fit-confidence.test.js
 */
globalThis.awslambda = globalThis.awslambda || { streamifyResponse: (fn) => fn, HttpResponseStream: { from: (s) => s } };
const fs = require('fs');
const path = require('path');
const {
  conversationProgress, applyFollowUpNextAction, buildComposeSystem, computePresentationGrain,
  previouslyShownSafety, sameSafetyAlreadyShown, pendingDiagnosticQuestion, latestTurnLooksLikeIdentity,
  COMPONENT_MENTION, followUpUnderstandNote, evidenceJustifiesComponent,
  namedOrCatalogueComponents, formatTrustedCustomerEvidence, buildComposeContext,
  calibrateLikelyFitProse, constrainReplacementLanguage,
  replacementLanguageOverclaimsFit,
} = require('../part-finder-lambda.js')._internal;

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) pass++;
  else { fail++; console.log('  FAIL:', name, detail !== undefined ? `:: ${JSON.stringify(detail)}` : ''); }
}

const src = require('./engine-source.cjs')();
const banned = ['WMB' + 'F', 'Journey #' + '15', 'washing ' + 'trapped'];
check('source has no frozen journey identifiers', banned.every((s) => !src.includes(s)));

const pendingProgress = conversationProgress([
  { role: 'user', content: 'It cuts out part way through a cycle.' },
  { role: 'assistant', content: 'That points toward an electrical fault. Does it happen as soon as it starts, or only after it has been running for a few minutes? What is the make and model?' },
  { role: 'user', content: 'Yes, ABC123 is correct.' },
]);
const pending = pendingDiagnosticQuestion(pendingProgress);
check('A1 pending diagnostic question survives alongside an identity ask',
  pending && /as soon as it starts/i.test(pending) && !/make and model/i.test(pending), pending);

const identityIntent = {
  model: 'ABC123',
  userIntent: 'CONFIRMATION',
  primaryFinding: 'likely insulation leak on a heating load',
  primaryFindingKind: 'component',
  candidateComponents: ['heater element'],
  confidence: 0.7,
  nextBestCheck: 'look up the replacement',
  nextCheckCustomerSafe: false,
};
applyFollowUpNextAction(identityIntent, pendingProgress, {});
check('A2 identity-only follow-up restores the unanswered discriminator',
  /as soon as it starts/i.test(identityIntent.clarifyingQuestion || '')
  && identityIntent._nextAction === 'discriminator'
  && identityIntent._pendingDiscriminator, identityIntent.clarifyingQuestion);
check('A3 restored discriminator is not treated as a completed check',
  identityIntent.furtherGenericCheckJustified === true && identityIntent.needMoreInfo === true);

const grain = computePresentationGrain({
  intent: identityIntent,
  fault: { node: { outcome: 'PART_ROUTING', components: ['heater element'] } },
  committedFinding: true,
  outcome: 'PART_ROUTING',
});
check('A4 pending discriminator is discuss, not purchase',
  grain.mention === COMPONENT_MENTION.DISCUSS && grain.purchaseAppropriate === false && grain.committedComponent === false);

const composePending = buildComposeSystem(
  [{ title: 'Heater Element', partNo: 'H1', _brandOnly: true }],
  { modelNumber: 'ABC123' },
  identityIntent,
  { faultId: 'electrical', node: { label: 'Electrical trip', components: ['heater element'] }, via: 'classified' },
  [], null, false, false, null, true, grain, pendingProgress,
);
check('A5 compose labels a hypothesis, not an engineering finding',
  /LEADING WORKING HYPOTHESIS/i.test(composePending) && !/PRIMARY ENGINEERING FINDING \(LEAD WITH THIS\)/.test(composePending));
check('A6 compose must re-ask the unresolved discriminator',
  /UNRESOLVED DIAGNOSTIC QUESTION/i.test(composePending) && /as soon as it starts/i.test(composePending));
check('A7 compose must not offer a permission-to-link turn',
  /would you like me to find\/show\/link/i.test(composePending)
  && /No justified purchase candidate is attached/i.test(composePending));

const diagnosticConfirm = conversationProgress([
  { role: 'user', content: 'One compartment is warm.' },
  { role: 'assistant', content: 'Is the other compartment still properly cold?' },
  { role: 'user', content: 'yes, that compartment is still cold' },
]);
const fridgeIntent = {
  model: 'KGN36',
  userIntent: 'CONFIRMATION',
  nextBestCheck: 'look for frost on the back wall',
  nextCheckCustomerSafe: true,
};
check('B1 a discriminator confirmation is not classified as identity',
  latestTurnLooksLikeIdentity(diagnosticConfirm, fridgeIntent, diagnosticConfirm && []) === false);
applyFollowUpNextAction(fridgeIntent, diagnosticConfirm, {});
check('B2 diagnostic confirmation keeps the remaining check, even with a known model',
  fridgeIntent.nextBestCheck === 'look for frost on the back wall' && fridgeIntent._nextAction !== 'discriminator');

const imageProgress = conversationProgress([
  { role: 'user', content: 'It cuts out part way through a cycle.' },
  { role: 'assistant', content: 'When in the cycle does it cut out?' },
  { role: 'user', content: 'Please read the rating plate.' },
]);
const imageIntent = { model: 'ABC123', userIntent: 'EVIDENCE_UPDATE', nextBestCheck: 'sell a part' };
const imageMsgs = [
  { role: 'user', content: 'It cuts out part way through a cycle.' },
  { role: 'assistant', content: 'When in the cycle does it cut out?' },
  { role: 'user', content: [{ type: 'text', text: 'Please read the rating plate.' }, { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,xx' } }] },
];
applyFollowUpNextAction(imageIntent, imageProgress, { messages: imageMsgs });
check('B3 a rating-plate image restores the unanswered diagnostic question',
  /when in the cycle/i.test(imageIntent.clarifyingQuestion || ''), imageIntent.clarifyingQuestion);

const note = followUpUnderstandNote(pendingProgress);
check('B4 understand note: identity does not answer a diagnostic discriminator',
  /does NOT answer a diagnostic discriminator/i.test(note));

{
  const instructional = conversationProgress([
    { role: 'user', content: 'It cuts out part way through a cycle.' },
    { role: 'assistant', content: 'This points toward an electrical fault. The next check is to note which stage of the cycle it happens. Send the make and model if you have them.' },
    { role: 'user', content: 'Please read the rating plate.' },
  ]);
  check('B5 instructional discriminator without a question mark is still pending',
    /which stage of the cycle/i.test(pendingDiagnosticQuestion(instructional) || ''), pendingDiagnosticQuestion(instructional));
  const imgIntent = { model: 'ABC123', userIntent: 'EVIDENCE_UPDATE', nextBestCheck: 'sell a part', confidence: 0.8 };
  applyFollowUpNextAction(imgIntent, instructional, { messages: [
    { role: 'user', content: 'It cuts out part way through a cycle.' },
    { role: 'assistant', content: 'This points toward an electrical fault. The next check is to note which stage of the cycle it happens. Send the make and model if you have them.' },
    { role: 'user', content: [{ type: 'text', text: 'Please read the rating plate.' }, { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,xx' } }] },
  ] });
  check('B6 rating-plate turn restores an instructional discriminator',
    /which stage of the cycle/i.test(imgIntent.clarifyingQuestion || '') && imgIntent._unconfirmedIdentity === true, imgIntent.clarifyingQuestion);
  const imgGrain = computePresentationGrain({
    intent: imgIntent,
    fault: { node: { outcome: 'PART_ROUTING', components: ['heater element'] } },
    committedFinding: true,
    outcome: 'PART_ROUTING',
  });
  check('B7 unconfirmed identity cannot purchase',
    imgGrain.purchaseAppropriate === false && imgGrain.committedComponent === false);
  const imgCompose = buildComposeSystem([], { modelNumber: 'ABC123' }, imgIntent, {
    faultId: 'electrical', node: { label: 'Electrical trip', components: ['heater element'] }, via: 'classified',
  }, [], null, false, false, null, true, imgGrain, instructional);
  check('B8 unconfirmed identity compose must not thank them for confirming or sell a part',
    /UNCONFIRMED IDENTITY/i.test(imgCompose) && /Do NOT thank them for confirming/i.test(imgCompose));
  check('B9 unconfirmed identity compose must not treat the OCR string as established',
    /must not present the extracted string as established identity/i.test(imgCompose)
    || /Do NOT present the extracted string as established identity/i.test(imgCompose));
}

const discussCompose = buildComposeSystem(
  [],
  { modelNumber: 'ABC123' },
  {
    model: 'ABC123',
    primaryFinding: 'likely failed circulating component',
    primaryFindingKind: 'component',
    candidateComponents: ['pump'],
  },
  { faultId: 'circulation', node: { label: 'Circulation', components: ['pump'] }, via: 'classified' },
  [], null, false, false, null, true,
  { mention: COMPONENT_MENTION.DISCUSS, purchaseAppropriate: false, committedComponent: false },
);
check('C1 discuss grain forbids engineering-finding language',
  /LEADING WORKING HYPOTHESIS/i.test(discussCompose) && !/PRIMARY ENGINEERING FINDING \(LEAD WITH THIS\)/.test(discussCompose));

const likelyFit = buildComposeSystem(
  [{ title: 'Pump', partNo: 'P1', price: 20, _brandOnly: true }],
  { modelNumber: 'ABC123' },
  {
    model: 'ABC123',
    primaryFinding: 'the circulating pump has failed',
    primaryFindingKind: 'component',
    candidateComponents: ['pump'],
  },
  { faultId: 'circulation', node: { label: 'Circulation', components: ['pump'] }, via: 'classified' },
  [], null, false, false, null, true,
  { mention: COMPONENT_MENTION.PURCHASE, purchaseAppropriate: true, committedComponent: true },
);
check('C2 brand-only catalogue rows force likely-fit language',
  /Catalogue fit is LIKELY \/ PLEASE VERIFY/i.test(likelyFit)
  && /NEVER say correct replacement/i.test(likelyFit));
check('C3 purchase grain still forbids a permission turn',
  /never ask permission|Never add a permission turn|never "would you like me to find\/show\/link/i.test(likelyFit));

const confirmedFit = buildComposeSystem(
  [{ title: 'Pump', partNo: 'P1', price: 20, _brandOnly: false }],
  { modelNumber: 'ABC123' },
  {
    model: 'ABC123',
    primaryFinding: 'the circulating pump has failed',
    primaryFindingKind: 'component',
    candidateComponents: ['pump'],
  },
  { faultId: 'circulation', node: { label: 'Circulation', components: ['pump'] }, via: 'classified' },
  [], null, false, false, null, true,
  { mention: COMPONENT_MENTION.PURCHASE, purchaseAppropriate: true, committedComponent: true },
);
check('C4 model-specific rows may claim a model match, not a proven cause',
  /model-specific match/i.test(confirmedFit) && /does not prove this component caused the fault/i.test(confirmedFit));
check('C5 confirmed-fit compose still uses finding language when the component is committed',
  /PRIMARY ENGINEERING FINDING \(LEAD WITH THIS\)/.test(confirmedFit));

const insufficient = buildComposeSystem(
  [{ title: 'Pump', partNo: 'P1', _brandOnly: false }],
  { modelNumber: 'ABC123' },
  {
    model: 'ABC123',
    primaryFinding: 'still two realistic causes',
    primaryFindingKind: 'subsystem',
    candidateComponents: ['pump'],
    _pendingDiscriminator: 'Does it fail immediately, or after it has been running?',
  },
  { faultId: 'circulation', node: { label: 'Circulation', components: ['pump'] }, via: 'classified' },
  [], null, false, false, null, false,
  { mention: COMPONENT_MENTION.DISCUSS, purchaseAppropriate: false, committedComponent: false },
);
check('C6 strong model identity with unresolved diagnosis still withholds the part',
  /No justified purchase candidate is attached/i.test(insufficient)
  && /UNRESOLVED DIAGNOSTIC QUESTION/i.test(insufficient));

const safety = { text: 'Stop using the appliance until it has been checked.', classification: 'STOP_USE' };
const shown = [
  { role: 'user', content: 'it keeps cutting out' },
  { role: 'assistant', content: 'When does it cut out?', safetyInformation: safety },
];
check('D1 previously shown safety is taken from assistant turns',
  previouslyShownSafety(shown).length === 1 && previouslyShownSafety(shown)[0] === safety.text);
check('D2 identical safety is recognised as already shown', sameSafetyAlreadyShown(shown, safety) === true);
check('D3 a different safety text is not suppressed',
  sameSafetyAlreadyShown(shown, { text: 'A different new risk now applies.' }) === false);

check('F1 evidence block does not relabel a hypothesis as an engineering finding',
  !/Engineering finding:/i.test(formatTrustedCustomerEvidence({
    primaryFinding: 'likely insulation leak', primaryFindingKind: 'subsystem',
  })));

{
  const ctx = buildComposeContext(
    { _unconfirmedIdentity: true, _pendingDiscriminator: 'When in the cycle does it happen?' },
    null, null, false,
    { mention: COMPONENT_MENTION.DISCUSS, purchaseAppropriate: false, committedComponent: false },
    conversationProgress([
      { role: 'user', content: 'It cuts out part way through a cycle.' },
      { role: 'assistant', content: 'When in the cycle does it cut out?' },
      { role: 'user', content: 'Please read the rating plate.' },
    ]),
  );
  check('F2 unconfirmed identity compose context forbids thanking them for confirming',
    /do NOT thank them/i.test(ctx[0].content) && /UNCONFIRMED/i.test(ctx[0].content));
}

// G1-G3 removed: customerNamedApplianceFamily (customer-prose family classification) is deleted.
// Family is now Jev's typed applianceFamily + provenance; these classifications are Jev's job and
// are covered by identity-integrity's typed-contract tests.

{
  const purchase = { mention: COMPONENT_MENTION.PURCHASE, purchaseAppropriate: true, committedComponent: false };
  const likelyRow = [{ partNo: 'H1', title: 'Element', _brandOnly: true }];
  check('H1 brand-only shown parts get a likely-fit trailer',
    /please verify it before ordering/i.test(calibrateLikelyFitProse(
      'The element is the part to replace.', likelyRow, purchase,
    )));
  check('H2 confirmed-fit rows are not down-labelled as likely',
    calibrateLikelyFitProse('This matches the model.', [{ partNo: 'H1', _brandOnly: false }], purchase)
      === 'This matches the model.');
  check('H3 discuss grain does not append a fit trailer',
    calibrateLikelyFitProse('Check the timing next.', likelyRow, {
      mention: COMPONENT_MENTION.DISCUSS, purchaseAppropriate: false,
    }) === 'Check the timing next.');
  check('H4 existing likely-fit wording is not duplicated',
    !/please verify it before ordering.*please verify it before ordering/i.test(calibrateLikelyFitProse(
      'This is a likely match — please verify it before ordering.', likelyRow, purchase,
    )));
}

{
  const none = [];
  const likelyRow = [{ partNo: 'H1', title: 'Element', _brandOnly: true }];
  const confirmedRow = [{ partNo: 'H1', title: 'Element', _brandOnly: false }];
  check('I1 no catalogue rows strip "correct replacement part"',
    /suitable replacement/i.test(constrainReplacementLanguage(
      'Once I have the model I can identify the correct replacement part for your specific machine.', none,
    )) && !replacementLanguageOverclaimsFit(constrainReplacementLanguage(
      'Once I have the model I can identify the correct replacement part for your specific machine.', none,
    ), none));
  check('I2 no catalogue rows strip "exact part"',
    !/\bexact part\b/i.test(constrainReplacementLanguage(
      'Tell me the model and I will match the exact part.', none,
    )));
  check('I3 no catalogue rows strip "compatible part"',
    !/\bcompatible part\b/i.test(constrainReplacementLanguage(
      'This is a compatible part for the machine.', none,
    )));
  check('I4 no catalogue rows strip "confirmed fit"',
    /likely fit/i.test(constrainReplacementLanguage('This is a confirmed fit.', none))
    && !/\bconfirmed fit\b/i.test(constrainReplacementLanguage('This is a confirmed fit.', none)));
  check('I5 no catalogue rows strip "correct part for your machine"',
    !/correct part for your machine/i.test(constrainReplacementLanguage(
      'This is the correct part for your machine.', none,
    )));
  check('I6 model-confirmed rows may keep model-match language',
    constrainReplacementLanguage('This matches this model.', confirmedRow) === 'This matches this model.');
  check('I7 brand-only rows still strip replacement overclaims',
    !/correct replacement/i.test(constrainReplacementLanguage(
      'This is the correct replacement part.', likelyRow,
    )));
  check('I8 diagnostic "correct" is not rewritten as a fit claim',
    constrainReplacementLanguage('That is the correct next check.', none) === 'That is the correct next check.');
  check('I9 committed-diagnosis compose no longer teaches exact-part fit',
    !/FOR EXACT-PART FIT/i.test(src) && /no catalogue-fit evidence yet/i.test(src));
  check('I10 replacement language is constrained from shown catalogue rows before write',
    /constrainReplacementLanguage\(reply, shownParts\)/.test(src)
    && src.indexOf('constrainReplacementLanguage(reply, shownParts)')
      < src.indexOf('calibrateLikelyFitProse(reply, shownParts'));
}

console.log(`\nidentification-fit-confidence: ${pass} passed / ${fail} failed`);
process.exit(fail ? 1 : 0);
