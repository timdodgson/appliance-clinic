/**
 * Phase 8: the engine split. The engine modules form an acyclic graph below the handler, and the handler's `_internal`
 * test surface keeps every name it had before the split.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ENGINE = join(ROOT, 'engine');
const modules = readdirSync(ENGINE).filter((f) => f.endsWith('.js')).sort();
const requires = Object.fromEntries(modules.map((f) => {
  const src = readFileSync(join(ENGINE, f), 'utf8');
  return [f, [...src.matchAll(/require\('(\.{1,2}\/[^']+)'\)/g)].map((m) => m[1])];
}));

// The `_internal` names before the split (Phase 8). Tests across both services destructure them.
const INTERNAL = [
  'CANONICAL_JOURNEY_PACKS', 'COMPONENT_MENTION', 'EVIDENCE_KIND', 'FINDING_KINDS', 'INTENT_SCHEMA',
  'InferenceError', 'REMOTE_ACTION', 'USER_INTENTS', '_setProvidersForTest', 'accessibleImpellerInspected',
  'adjustDifferential', 'allAskedDiscriminatorFacts', 'allowedFamilyForReply', 'applianceKey',
  'applianceSafetyFamily', 'applyDisplayedIndicationIdentity', 'applyFollowUpNextAction',
  'applyPartReadinessProgression', 'askedDiscriminatorFact', 'assertedHazardIsObserved',
  'authoritativeCodeComponents', 'avoidVerbatimRepeat', 'brandFamily', 'buildComposeContext', 'buildComposeSystem',
  'calibrateLikelyFitProse', 'canonicalControls', 'canonicalFinishUnderstand', 'canonicalJourney',
  'canonicalJourneys', 'canonicalModelParts', 'canonicalRespond', 'canonicalTransportMerge',
  'canonicalTransportMetric', 'captureQuestionedCause', 'catalogueFitIsModelConfirmed', 'checksNotDoneTurnCount',
  'chooseCompatibleFault', 'classifyCustomerClaim', 'classifyRemoteActionClass', 'classifySafetyStop',
  'collectEvidence', 'collectFaultIds', 'collectPositiveObservations', 'commitFromEvidence',
  'completedAccessibleCheck', 'composeFollowUpNote', 'computeEvidence', 'computePresentationGrain',
  'constrainByPositiveObservations', 'constrainReplacementLanguage', 'constrainReplyToIdentity',
  'conversationProgress', 'correctFollowUpIntent', 'currentActionMediaFaultId', 'customerDeclinedDiscriminator',
  'customerErrorCodes', 'customerFacingNextCheck', 'customerOnlyText', 'customerProposedDrainPathPart',
  'demotePrematurePartRequest', 'demoteUnconfirmedTheoryFinding', 'deriveDeclinedFacts', 'deriveMediaConcepts',
  'detectSafetyStop', 'detectUnsafeIntent', 'diagnoseStopIsProfessionalHv', 'discriminatorAlreadyAsked',
  'discriminatorQuestionText', 'displayedIndicationNeedsIdentity', 'drainFunctionEstablished',
  'dropUnstatedComponentHum', 'effectiveFindingKind', 'ensureAdviceThenIdentityAsk', 'ensureCommittedConclusion',
  'ensureNonTerminalProgression', 'ensureOwnerCheckSafety', 'evidenceDecisive', 'evidenceJustifiesComponent',
  'expressesConcern', 'extractDisplayedStatusToken', 'factConflict', 'followUpUnderstandNote',
  'formatTrustedCustomerEvidence', 'getNormalBehaviourRecords', 'getProviders', 'guessErrorCode',
  'hasFailureSymptom', 'hasFunctionFailureSymptom', 'hazardProvenance', 'identificationIsNextAction',
  'identityNamedFamilies', 'invertedStemsAgainst', 'isAcousticOnlyQuery', 'isBenignSmellOnly',
  'isCanonicalTransportBlock', 'isCanonicalTransportResult', 'isElectricalFlashEvent',
  'isMicrowaveHvProcedureRequest', 'isResidualWaterOnly', 'isStatusIndicationFlash', 'isUnlocatedFunctionOutcome',
  'isWetPlasticsOnly', 'latestTurnEstablishesDrainEvent', 'latestTurnLooksLikeIdentity', 'latestTurnReportsRecovery',
  'latestTurnSaysChecksNotDone', 'lmSafeMessages', 'localisingQuestionAfterObservation', 'lockApplianceType',
  'looksLikeCode', 'looksLikeModelToken', 'matchNormalBehaviour', 'matchesComponent', 'materialAmbiguity',
  'mergeDerivedFacts', 'microwaveHeatingHvBoundaryApplies', 'modelAlreadyKnown', 'namedOrCatalogueComponents',
  'naturalList', 'neutralizeConditionLimitedFacts', 'normaliseIntent', 'ownerCheckPrecaution', 'ownerSafeAdvice',
  'partsStillInPlay', 'pendingDiagnosticQuestion', 'phraseRefersToComponent', 'preferAccessibleFirstAction',
  'preferAdviceThenIdentity', 'preferArchitectureDependentAdvice', 'preferCheckFirstPart',
  'preferConditionDiscriminator', 'preferFamilyBeforeSpecificDiagnosis', 'preferNotRepeatIntervention',
  'preferRelatedFunctionDiscriminator', 'preferSingleVagueClarify', 'presentableCandidateComponents',
  'previouslyShownMedia', 'previouslyShownSafety', 'productIdentitySufficient', 'progressAfterDeclinedDiscriminator',
  'proposedPhysicalAccess', 'rankPartsByFault', 'refineCustomerTheories', 'remainingActionBlocksPurchase',
  'remoteActionBoundary', 'renderDeterministicTerminal', 'replacementLanguageOverclaimsFit',
  'replyDeliversSafetyStop', 'replyIsAcknowledgementOnly', 'resolveEstablishedFamily', 'resolveFault',
  'resolveProviders', 'retainCustomerErrorCode', 'retrievedFamilyNote', 'sameSafetyAlreadyShown',
  'scoreNodeEvidence', 'selectLinkedParts', 'setIdentificationNext', 'stripInstructionEcho', 'stripMicrowaveHvDiy',
  'stripModelAskOnProfessionalBoundary', 'stripOutOfScopeElectricalTests', 'stripOwnerInternalElectricalInspection',
  'uniqueBrandCodeHit', 'upgradeErrorCodeFromText',
];

describe('engine modules', () => {
  it('never require the handler', () => {
    for (const [f, deps] of Object.entries(requires)) expect(deps.filter((d) => d.includes('part-finder-lambda')), f).toEqual([]);
  });

  it('form an acyclic graph', () => {
    const state = {};
    const visit = (f, path) => {
      if (state[f] === 'done') return;
      expect(state[f], `cycle: ${[...path, f].join(' -> ')}`).not.toBe('active');
      state[f] = 'active';
      for (const d of requires[f]) if (d.startsWith('./')) visit(d.slice(2), [...path, f]);
      state[f] = 'done';
    };
    for (const f of modules) visit(f, []);
  });

  it('each load on their own', () => {
    for (const f of modules) expect(() => require(join(ENGINE, f)), f).not.toThrow();
  });
});

describe('handler _internal', () => {
  it('keeps every name it had before the split', () => {
    globalThis.awslambda ||= { streamifyResponse: (f) => f, HttpResponseStream: { from: (s) => s } };
    const internal = require('../part-finder-lambda.js')._internal;
    expect(Object.keys(internal).sort()).toEqual([...INTERNAL].sort());
    for (const k of INTERNAL) expect(internal[k], k).not.toBeUndefined();
  });
});
