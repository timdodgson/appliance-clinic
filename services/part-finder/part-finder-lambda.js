/**
 * Diagnosis engine Lambda (spares4repairs-part-finder): the streaming handler and the canonical-runtime wiring.
 * The engine's parts live in engine/; `_internal` re-exports them for tests.
 */
const { resolveProviders, InferenceError } = require('./inference.js');
const { loadAdminInference } = require('./admin-config.js');
const { publicObservability } = require('./jev-understand.js');
const partFinderHealth = require('./health.js');
const { ensureKnowledgeOverlay, getKnowledgeOverlayCache } = require('./retrieval');
const {
  retrieve, getSafetyInformation, getMediaInformation, ensureMediaOverlay, getNormalBehaviourRecords,
  getLikelyComponents, getKnowledgeRecord, describeLoadedIndex, describeMediaBaseline, getMediaOverlayCache,
  getEffectiveMediaJoin, countJoinIdentities, MEDIA_OVERLAY_TTL_MS,
} = require('./retrieval');
const { outputTripwire, REFUSAL_TEXT } = require('./security');
const {
  identityNamedFamilies, resolveConversationIdentity, constrainReplyToIdentity, constrainIntentToFamily,
  hasOperationalFamily, customerOnlyText, looksLikeModelToken,
} = require('./identity.js');
const {
  LM_TEMPERATURE, LM_TIMEOUT_MS, LM_REPEAT_PENALTY, getProviders, _setProvidersForTest, MAX_MESSAGES,
  MAX_BODY_BYTES,
} = require('./engine/config.js');
const {
  latestUserText, progressCustomerText, modelAlreadyKnown, productIdentitySufficient, customerFacingNextCheck,
  customerProposedDrainPathPart,
} = require('./engine/conversation.js');
const {
  CATALOGUE, collectFaultIds, applianceKey, brandFamily, uniqueBrandCodeHit, resolveFault,
  authoritativeCodeComponents, rankPartsByFault, selectLinkedParts, partsStillInPlay, preferCheckFirstPart,
  matchesComponent, phraseRefersToComponent, partMatchesFault, looksLikeCode, buildQueryCandidates,
} = require('./engine/catalogue.js');
const {
  USER_INTENTS, FINDING_KINDS, COMPONENT_MENTION, REMOTE_ACTION, INTENT_SCHEMA,
} = require('./engine/intent-vocabulary.js');
const {
  guessMake, guessErrorCode, upgradeErrorCodeFromText, customerErrorCodes, retainCustomerErrorCode,
} = require('./engine/error-codes.js');
const {
  neutralizeConditionLimitedFacts, collectEvidence, adjustDifferential, computeEvidence, factConflict,
  chooseCompatibleFault, askedDiscriminatorFact, discriminatorAlreadyAsked, allAskedDiscriminatorFacts,
  dropUnstatedComponentHum, mergeDerivedFacts, scoreNodeEvidence, commitFromEvidence, evidenceDecisive,
  DISCRIMINATOR_QUESTION, discriminatorQuestionText, invertedStemsAgainst, collectPositiveObservations,
  localisingQuestionAfterObservation, constrainByPositiveObservations, deriveDeclinedFacts, materialAmbiguity,
  customerDeclinedDiscriminator, progressAfterDeclinedDiscriminator,
} = require('./engine/evidence.js');
const {
  EVIDENCE_KIND, isStatusIndicationFlash, extractDisplayedStatusToken, displayedIndicationNeedsIdentity,
  applyDisplayedIndicationIdentity, isElectricalFlashEvent, proposedPhysicalAccess, detectSafetyStop,
  classifySafetyStop, stripOutOfScopeElectricalTests, stripOwnerInternalElectricalInspection,
  ownerCheckPrecaution, ensureOwnerCheckSafety, stripMicrowaveHvDiy, detectUnsafeIntent,
  isMicrowaveHvProcedureRequest, hasFailureSymptom, expressesConcern, isBenignSmellOnly, isResidualWaterOnly,
  isWetPlasticsOnly, matchNormalBehaviour,
} = require('./engine/safety.js');
const {
  classifyCustomerClaim, refineCustomerTheories, hazardProvenance, assertedHazardIsObserved,
  applianceSafetyFamily, classifyRemoteActionClass, remoteActionBoundary, evidenceJustifiesComponent,
  namedOrCatalogueComponents, effectiveFindingKind, applyPartReadinessProgression, remainingActionBlocksPurchase,
  computePresentationGrain, presentableCandidateComponents, catalogueFitIsModelConfirmed,
  constrainReplacementLanguage, replacementLanguageOverclaimsFit, calibrateLikelyFitProse, CHECK_DONE_LABEL,
  formatTrustedCustomerEvidence,
} = require('./engine/presentation.js');
const {
  EXCLUSIVE_OBSERVATION_GROUPS, setIdentificationNext, ensureAdviceThenIdentityAsk, stripInstructionEcho,
  familyKnownIdentificationAsk, resolveEstablishedFamily, lockApplianceType, allowedFamilyForReply,
  conversationProgress, followUpUnderstandNote, composeFollowUpNote, correctFollowUpIntent,
  completedAccessibleCheck, pendingDiagnosticQuestion, latestTurnLooksLikeIdentity, applyFollowUpNextAction,
  identificationIsNextAction, preferAdviceThenIdentity, preferArchitectureDependentAdvice, isAcousticOnlyQuery,
  NOISE_RECORD_BY_FAMILY, hasFunctionFailureSymptom, isUnlocatedFunctionOutcome,
  preferFamilyBeforeSpecificDiagnosis, preferConditionDiscriminator, preferNotRepeatIntervention,
  preferRelatedFunctionDiscriminator, diagnoseStopIsProfessionalHv, preferSingleVagueClarify,
  replyDeliversSafetyStop, microwaveHeatingHvBoundaryApplies, replyIsAcknowledgementOnly,
  stripModelAskOnProfessionalBoundary, naturalList, ownerSafeAdvice, renderDeterministicTerminal,
  ensureCommittedConclusion, avoidVerbatimRepeat, ensureNonTerminalProgression, currentActionMediaFaultId,
  captureQuestionedCause, drainFunctionEstablished, latestTurnEstablishesDrainEvent, accessibleImpellerInspected,
  latestTurnReportsRecovery, demotePrematurePartRequest, demoteUnconfirmedTheoryFinding,
  latestTurnSaysChecksNotDone, checksNotDoneTurnCount, preferAccessibleFirstAction, previouslyShownMedia,
  previouslyShownSafety, sameSafetyAlreadyShown, customerAskedToRepeatMedia,
} = require('./engine/progression.js');
const { deriveMediaConcepts } = require('./engine/media-concepts.js');
const { getPartsForModel, searchCatalogue } = require('./engine/parts-client.js');
const { logFeedback, logLearningTrace, log, rand } = require('./engine/learning-log.js');
const {
  retrievedFamilyNote, lmSafeMessages, understand, degradedIntent, normaliseIntent, reviveInjectedIntent,
} = require('./engine/understand.js');
const { buildComposeSystem, buildComposeContext, composeStream } = require('./engine/compose.js');

/**
 * Two-pass flow (all within ONE Lambda invocation):
 *
 *   Pass 1  UNDERSTAND  → TypeSafe Jev returns bounded semantic decisions
 *                          (intent, family, token meaning, safety, follow-up).
 *                          An adapter maps those into the existing intent contract.
 *   RETRIEVE            → RAG still runs from the customer's words + identity.
 *   Pass 2  COMPOSE     → LLM writes the reply, grounded in catalogue / knowledge.
 *
 * Semantic meaning is Jev. Mechanical consequence (catalogue, evidence, safety
 * enforcement, routing) stays deterministic. There is no generative UNDERSTAND
 * fallback — an infrastructure failure is an error, not a degraded guess.
 */
exports.handler = awslambda.streamifyResponse(async (event, responseStream) => {
  const started = Date.now();
  const requestId = event?.requestContext?.requestId || rand();

  // Pre-stream error: send a normal JSON body with a proper status code.
  const failJson = (status, obj) => {
    const s = awslambda.HttpResponseStream.from(responseStream, {
      statusCode: status,
      headers: { 'Content-Type': 'application/json' },
    });
    s.write(JSON.stringify(obj));
    s.end();
  };

  // Additive read-only health. Must run before diagnosis parsing so GET /health
  // never enters UNDERSTAND / RAG retrieve / COMPOSE.
  const healthHit = await partFinderHealth.handle(event, {
    describeIndex: describeLoadedIndex,
    describeMediaBaseline,
    ensureMediaOverlay,
    getMediaOverlayCache,
    getEffectiveMediaJoin,
    countJoinIdentities,
    overlayTtlMs: MEDIA_OVERLAY_TTL_MS,
    loadAdminInference,
    ensureKnowledgeOverlay,
    getKnowledgeOverlayCache,
  });
  if (healthHit) return failJson(healthHit.status, healthHit.body);
  // Published Admin knowledge (knowledge-admin/published.json) merged over the shipped index before any
  // retrieval / identity lookup in this request. TTL-cached; failure keeps the last good state.
  try { await ensureKnowledgeOverlay(); } catch { /* recorded on the overlay cache */ }

  // Guard against oversized payloads before parsing
  const rawBody = event.body || '{}';
  if (Buffer.byteLength(rawBody) > MAX_BODY_BYTES) {
    return failJson(413, { error: 'Message too large. Try a smaller image.' });
  }

  let body;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return failJson(400, { error: 'Invalid JSON' });
  }

  // Feedback signal: a lightweight {feedback:{traceId,rating,note}} POST (no
  // diagnosis). Records the customer's 👍/👎 on a prior reply so the learning
  // corpus gets right/wrong labels. Handled and returned before the messages path.
  if (body.feedback) {
    await logFeedback(body.feedback);
    return failJson(200, { ok: true });
  }

  let messages = body.messages;
  if (!messages || !Array.isArray(messages) || messages.length === 0) {
    return failJson(400, { error: 'messages array required' });
  }
  // Optional deterministic seed — TEST-ONLY. The regression harness sends a fixed
  // seed so runs are reproducible; production requests never send one, so prod
  // stays randomly seeded (a bad answer gets a fresh roll next time).
  const seed = Number.isInteger(body.seed) ? body.seed : undefined;
  if (messages.length > MAX_MESSAGES) {
    messages = messages.slice(-MAX_MESSAGES);
  }

  const lastUserMsg = [...messages].reverse().find((m) => m.role === 'user');
  const latestHasImage =
    Array.isArray(lastUserMsg?.content) &&
    lastUserMsg.content.some((c) => c.type === 'image_url');

  // Metrics accumulator — one structured line emitted at the end.
  const metric = {
    evt: 'part-finder',
    requestId,
    hasImage: latestHasImage,
    msgCount: messages.length,
  };

  let out = null; // NDJSON output stream, opened once compose begins

  try {
    // -------- KNOWLEDGE RETRIEVAL (before reasoning) --------
    // Lightweight pre-extraction (no LLM) picks the appliance family for the
    // metadata filter; the query is the customer's own words. The LLM still
    // corrects appliance/make in the reasoning pass, so a rough guess is fine.
    const queryText = latestUserText(messages);

    // -------- PROMPT-INJECTION / OFF-TOPIC SCOPE (typed Jev decision) --------
    // The input scope/security decision is now Jev's single typed classification
    // (intent._requestClass: appliance_request | prompt_attack | unrelated_request |
    // ambiguous), interpreted in the ONE UNDERSTAND pass — not a pre-LLM regex gate.
    // Jev decides MEANING; the deterministic consequence (refuse-and-redirect vs
    // continue) is applied once the typed intent is available, before COMPOSE runs.
    // Output containment (outputTripwire) remains the deterministic last line.

    // -------- UNDERSTAND-ONLY MODE (Story 3: single Jev call, before routing) --------
    // The orchestrator calls this ONCE per turn to get Jev's typed semantic decisions BEFORE it
    // routes (MCP vs RAG). It runs ONLY the Jev UNDERSTAND pass (no retrieval, no COMPOSE) and
    // returns the raw typed intent. The orchestrator then forwards this EXACT intent back into the
    // diagnose call (body.understand), so part-finder does NOT run Jev a second time. This keeps
    // ONE Jev invocation and ONE semantic interpretation per customer turn. A Jev failure returns
    // the explicit degraded intent (never a prose/regex guess).
    if (body.mode === 'understand') {
      const tu = Date.now();
      // CANONICAL: when the BFF sent a cs/1 block, the message-only mc/1 classification (its own Jev evaluation)
      // starts IN PARALLEL with the legacy UNDERSTAND call; it is awaited after it (canonical-runtime.js).
      const canonicalStarted = canonicalRuntime().beginUnderstand(body, messages, requestId);
      let uIntent;
      try {
        uIntent = await understand(messages, [], undefined, body.established);
        metric.jevInvoked = 1;
      } catch (e) {
        uIntent = degradedIntent();
        metric.jevInvoked = 0;
        metric.jevError = String((e && e.category) || (e && e.message) || e);
      }
      metric.understandMs = Date.now() - tu;
      metric.mode = 'understand';
      metric.jev = publicObservability(uIntent);
      // CANONICAL: merge(prior, mc/1) once, route to the owning journey, decide the NextAction; the result goes back
      // to the orchestrator (event field `canonical`) and the BFF persists it.
      const canonicalTransport = await canonicalRuntime().finishUnderstand(canonicalStarted);
      if (canonicalTransport) metric.canonicalTransport = canonicalRuntimeMod.transportMetric(canonicalTransport);
      out = awslambda.HttpResponseStream.from(responseStream, {
        statusCode: 200,
        headers: { 'Content-Type': 'application/x-ndjson' },
      });
      out.write(JSON.stringify({ type: 'understand', understand: uIntent, jev: metric.jev, ...(canonicalTransport ? { canonical: canonicalTransport } : {}) }) + '\n');
      out.end();
      metric.totalMs = Date.now() - started;
      metric.ok = true;
      log(metric);
      return;
    }

    // Retrieval scoping family is Jev's typed family (from the forwarded understand), never a prose
    // guess. When Jev already ran (orchestrator path) body.understand carries applianceType +
    // provenance + fuel; we feed those to the resolver so the retrieval index filter is scoped by
    // Jev. If Jev has not run yet (direct engine path) the family is simply unknown here and
    // retrieval falls back to a unique make+code hit — no customer-prose family guess.
    const injectedForRetrieval = (body.understand && typeof body.understand === 'object')
      ? body.understand : null;
    // STAGE A: the persisted cross-turn established identity threaded by the orchestrator. Shape on
    // the wire is {applianceFamily, familyState}; normalise to the resolver's {family, familyState}.
    // A genuinely ESTABLISHED family is preserved against a weak/null current turn and replaced only
    // by an explicit customer correction (resolveConversationIdentity applies the precedence).
    const priorIdentity = (body.established && typeof body.established === 'object'
      && body.established.applianceFamily)
      ? { family: body.established.applianceFamily, familyState: body.established.familyState || null }
      : null;
    const conversationIdentity = resolveConversationIdentity({
      messages,
      queryText,
      jevFamily: injectedForRetrieval ? applianceKey(injectedForRetrieval.applianceType) : null,
      jevFamilyProvenance: injectedForRetrieval ? injectedForRetrieval._applianceFamilyProvenance : null,
      jevFuel: injectedForRetrieval ? injectedForRetrieval._fuel : null,
      priorIdentity,
    });
    const retCtx = {
      applianceFamily: hasOperationalFamily(conversationIdentity) ? conversationIdentity.family : null,
      familyState: hasOperationalFamily(conversationIdentity) ? conversationIdentity.familyState : undefined,
      familyEstablished: conversationIdentity.familyEstablished,
    };
    if (!retCtx.applianceFamily) {
      const unique = uniqueBrandCodeHit(guessMake(queryText), guessErrorCode(queryText));
      if (unique) retCtx.applianceFamily = unique.resolvedAppliance;
    }
    let retrieval = { docs: [], mode: 'skip', latencyMs: 0, indexVersion: 'none' };
    // Ungrounded noise-only questions must not load a family's bearing/belt docs as if they
    // were customer facts. Unique make+code retrieval still runs (retCtx.applianceFamily set).
    // The "unlocated function outcome" half of this guard is a customer-MEANING judgement, so it
    // consumes Jev's typed decision (the forwarded understand carries applianceType + symptomFamily)
    // rather than re-scanning the customer's prose. isAcousticOnlyQuery remains a structural
    // recogniser of noise-shaped wording. Retrieval scoping only; the index filter is subordinate to
    // Jev's family.
    const injectedUnderstand = (body.understand && typeof body.understand === 'object')
      ? body.understand : null;
    const skipFamilyRetrieval = !retCtx.applianceFamily && (
      isAcousticOnlyQuery(queryText)
      || (injectedUnderstand && isUnlocatedFunctionOutcome(injectedUnderstand))
    );
    try {
      retrieval = skipFamilyRetrieval
        ? { docs: [], mode: 'skip', latencyMs: 0, indexVersion: retrieval.indexVersion }
        : await retrieve(retCtx, queryText, 3);
    } catch (e) {
      console.error('[part-finder] retrieval error:', e.message);
    }
    metric.retrieval = {
      indexVersion: retrieval.indexVersion,
      mode: retrieval.mode,
      latencyMs: retrieval.latencyMs,
      knowledgeIds: retrieval.docs.map((d) => d.knowledgeId),
      scores: retrieval.docs.map((d) => d.score),
      applianceFilter: retCtx.applianceFamily || null,
    };

    const progress = conversationProgress(messages);
    metric.followUp = progress.isFollowUp;
    metric.turnIndex = progress.turnIndex;

    // -------- PASS 1: UNDERSTAND (Jev bounded semantic decisions) --------
    // Story 3: when the orchestrator has ALREADY run the single Jev UNDERSTAND (mode:'understand')
    // it forwards that exact typed intent here as body.understand. We consume it verbatim and do
    // NOT call Jev again — one Jev invocation and one semantic interpretation per customer turn.
    // Only when no pre-computed understanding is supplied (e.g. the harness / a direct engine call)
    // do we run Jev inline, exactly as before.
    const t1 = Date.now();
    let intent;
    if (body.understand && typeof body.understand === 'object') {
      intent = reviveInjectedIntent(body.understand);
      metric.jevReused = true;
      metric.jevInvoked = 0;
    } else {
      intent = await understand(messages, retrieval.docs, seed, body.established);
      metric.jevInvoked = 1;
    }
    const beforeIntent = intent.userIntent;
    correctFollowUpIntent(intent, progress);
    if (intent.userIntent !== beforeIntent) metric.followUpIntentCorrected = intent.userIntent;
    // TYPED SYMPTOM SCOPE (Jev customer-evidence): the functional restriction the customer
    // established (dry-only, fridge-only, one zone, grill vs fan oven, one programme …). Carried onto
    // the intent so COMPOSE reasons within that scope and does not re-ask about / diagnose the
    // working side. Null unless Jev grounded a restriction (never forced).
    intent._symptomScope = (intent._jevEvidence && intent._jevEvidence.scope) || null;
    if (intent._symptomScope) metric.symptomScope = intent._symptomScope.value;
    metric.understandMs = Date.now() - t1;
    metric.jev = publicObservability(intent);

    // -------- INPUT SCOPE / SECURITY CONSEQUENCE (deterministic, from Jev's typed decision) --------
    // Jev decided what the input MEANS (intent._requestClass). Code decides what to do:
    //   prompt_attack / unrelated_request -> return the fixed in-scope refusal (no diagnosis,
    //     no parts, no COMPOSE — the model is never asked to answer an attack/off-topic task).
    //   appliance_request / ambiguous     -> continue the normal WhichPart flow. 'ambiguous' is
    //     deliberately let through (a Jev wobble must never hard-block a real, messy customer;
    //     e.g. "Dyson V6"), and the output tripwire remains the deterministic last line.
    // A Jev failure yields no _requestClass (degradedIntent) -> fail-open to normal handling.
    const scopeRefusal = (intent._requestClass === 'prompt_attack' || intent._requestClass === 'unrelated_request')
      ? intent._requestClass
      : null;
    if (scopeRefusal) {
      metric.injectionBlocked = scopeRefusal; // typed class, for monitoring parity
      out = awslambda.HttpResponseStream.from(responseStream, {
        statusCode: 200,
        headers: { 'Content-Type': 'application/x-ndjson' },
      });
      out.write(JSON.stringify({ type: 'delta', text: REFUSAL_TEXT }) + '\n');
      out.write(JSON.stringify({ type: 'done', traceId: requestId, parts: [], understood: { onTopic: false, grounded: false, fault: null } }) + '\n');
      out.end();
      metric.totalMs = Date.now() - started;
      metric.ok = true;
      log(metric);
      await logLearningTrace(messages, REFUSAL_TEXT, queryText, { onTopic: false }, null, { docs: [], mode: 'skip' }, metric, 0);
      return;
    }
    // CANONICAL CONTROL: the typed NextAction (decided in understand mode from cs/1 + diagnostics + policy) owns this
    // turn. COMPOSE only words it; none of the legacy prompt / progression logic below runs.
    if (canonicalRuntime().controls(body.canonical)) {
      const r = await canonicalRuntime().respond({ canonical: body.canonical, messages, requestId, seed });
      metric.canonicalControl = r.metric;
      out = awslambda.HttpResponseStream.from(responseStream, { statusCode: 200, headers: { 'Content-Type': 'application/x-ndjson' } });
      out.write(JSON.stringify({ type: 'delta', text: r.reply }) + '\n');
      out.write(JSON.stringify(r.done) + '\n');
      out.end();
      metric.totalMs = Date.now() - started;
      metric.ok = true;
      log(metric);
      return;
    }
    // Jev's TYPED appliance family, captured BEFORE the deterministic backstops/applyEstablishedAppliance
    // can null it. This is the customer-MEANING family decision; it is fed to the identity resolver as
    // authoritative WORKING evidence so Jev's classification is CONSUMED rather than silently discarded
    // when the regex cues happen not to re-match. Explicit customer naming/correction still wins.
    const jevTypedFamily = applianceKey(intent.applianceType) || null;
    const jevFamilyProvenance = intent._applianceFamilyProvenance || null;
    const jevFuel = intent._fuel || null;
    // Catalogue brand lookup is exact matching, not semantic classification.
    if (!intent.make) {
      // Brand lookup is an exact catalogue lookup, not semantic classification.
      // Retain a customer-established make across follow-up turns instead of
      // looking only at the latest "filter looks terrible" / purchase message.
      const customerConversationText = [progress.priorUserText, progress.latestUserText]
        .filter(Boolean).join(' ');
      const mk = guessMake(customerConversationText || queryText);
      if (mk) { intent.make = mk; metric.backstopMake = mk; }
    }
    // FAMILY + FUEL + ESTABLISHMENT are Jev's TYPED decisions (applianceType, applianceFamilyProvenance,
    // fuel), forwarded to the identity resolver. There is NO prose family/fuel backstop and no
    // applyEstablishedAppliance prose override: when Jev leaves the family unknown we ask for it, we do
    // not backfill a guess from the customer's words.
    {
      const established = resolveEstablishedFamily({
        messages, queryText, jevFamily: jevTypedFamily, jevFamilyProvenance, jevFuel, priorIdentity,
      });
      lockApplianceType(intent, established, retrieval.docs);
      const conversationIdentity = established.identity
        || resolveConversationIdentity({
          messages, queryText, jevFamily: jevTypedFamily, jevFamilyProvenance, jevFuel, priorIdentity,
        });
      // WORKING or ESTABLISHED family both count as "known" for downstream gates; UNKNOWN does not.
      intent._applianceUnconfirmed = !hasOperationalFamily(conversationIdentity);
      const allowedFamily = allowedFamilyForReply(queryText, conversationIdentity);
      if (allowedFamily) constrainIntentToFamily(intent, allowedFamily);
    }
    // Token meaning is Jev's. Only upgrade/retain a code when Jev classified it
    // as an error code. Do not reclassify a model token as a code.
    if (intent._tokenMeaning === 'error_code' && intent.errorCode) {
      const upgraded = upgradeErrorCodeFromText(queryText, intent.errorCode);
      if (upgraded && upgraded.toUpperCase() !== String(intent.errorCode).toUpperCase()) {
        metric.upgradedCompoundCode = `${intent.errorCode}->${upgraded}`;
        intent.errorCode = upgraded;
      }
      retainCustomerErrorCode(intent, queryText, metric);
    } else if (intent._tokenMeaning === 'model' && intent.errorCode && intent.model) {
      intent.errorCode = null;
    } else if (!intent._tokenMeaning || intent._tokenMeaning === 'none') {
      // No candidate token — do not invent a code from English.
      if (intent.errorCode && !customerErrorCodes(queryText).length) intent.errorCode = null;
    }
    // A query with a known appliance plus a brand or an error code is
    // unambiguously an appliance-repair query — correct the model if it
    // mis-flagged a terse input (e.g. "Samsung 4E") as off-topic, which would
    // otherwise suppress fault resolution entirely.
    if (intent.onTopic === false && intent.applianceType && (intent.errorCode || intent.make)) {
      intent.onTopic = true;
      metric.onTopicCorrected = true;
    }
    metric.intent = {
      make: intent.make || null,
      model: intent.model || null,
      applianceType: intent.applianceType || null,
      fault: intent.fault || null,
      errorCode: intent.errorCode || null,
      onTopic: intent.onTopic,
      needMoreInfo: intent.needMoreInfo,
      modelUnavailable: intent.modelUnavailable,
      partReadiness: intent._partReadiness || null,
      hasQuery: !!intent.catalogueQuery,
      confidence: intent.confidence,
      alternatives: intent.alternatives,
      candidateComponents: intent.candidateComponents,
      nextBestCheck: intent.nextBestCheck || null,
      askedClarifying: !!intent.clarifyingQuestion,
      facts: intent.facts,
    };

    // ANSWERED-DISCRIMINATOR EVIDENCE (deterministic): the LLM is unreliable at extracting the
    // QUALITY of a noise (a grinding/rumbling sound) and its timing, yet that is the discriminator
    // that separates e.g. a bearing grind (motor-drum) from a bang/vibration or a drain noise. Derive
    // those standard facts from the customer's OWN words and merge them WITHOUT overriding anything
    // explicitly stated, so the evidence machinery (computeEvidence/factConflict/commit) can act on a
    // clearly-answered discriminator. General/reusable; asserts only what the customer said.
    if (intent.onTopic !== false) {
      // JEV IS AUTHORITATIVE for customer diagnostic OBSERVATIONS (Story 2). The typed
      // evidence Jev established over the WHOLE conversation — retention and correction
      // already applied by the single Jev call (see jev-understand.js CUSTOMER_EVIDENCE_SPEC)
      // — becomes the engine's observation facts. Deterministic code no longer re-reads the
      // customer's prose with regex/keywords to rediscover these observations: customer
      // language → Jev typed evidence → facts. Uncertain/absent stays UNKNOWN (never guessed);
      // a Jev failure leaves facts empty rather than silently rebuilding meaning from prose.
      const derived = ((intent._jevEvidence && Array.isArray(intent._jevEvidence.facts))
        ? intent._jevEvidence.facts : [])
        .filter((f) => f && f.name && (f.value === 'TRUE' || f.value === 'FALSE'))
        .map((f) => ({ name: f.name, value: f.value }));
      if (derived.length) {
        intent.facts = mergeDerivedFacts(intent.facts, derived);
        metric.derivedFacts = derived.map((f) => f.name);
      }
      // OBSERVATION AUTHORITY: the UNDERSTAND LLM is documented-unreliable at customer OBSERVATIONS —
      // the QUALITY of a noise (grinding/hum) and, for hobs, the technology / affected-zone scope /
      // pan-test result. Make the customer's OWN words authoritative for these dimensions: if the
      // customer did not actually state one, strip an LLM-guessed TRUE back to UNKNOWN. This stops
      // the engine COMMITTING to an observation-dependent fault (a quality-specific fault, the wrong
      // hob technology, a single/all-zone scope, or a cookware-vs-hardware call) on a hallucinated
      // observation, and lets the material-ambiguity gate ask the discriminator. Reuses the same
      // deterministic extractors; never asserts anything the customer did not say.
      const OBSERVATION_FACTS = new Set([
        'grindingNoise', 'humNoise',
        'inductionHob', 'gasHob', 'ceramicHob',
        'singleZoneAffected', 'allZonesAffected',
        'worksWithKnownGoodPan', 'failsKnownGoodPan',
        'heatPresent', 'noHeat', 'overheatsThenCuts', 'heatsAtAll',
        'drumTurns', 'waterEntering', 'waterRemaining',
        'noPower', 'cutsOut', 'weakSuction',
        'leakAtDoor', 'leakAtDrawer', 'leakUnderneath', 'leakAtRear', 'leaksOnFill', 'leaksOnDrain', 'excessiveFoam',
        'fridgeOnlyWarm', 'bothCompartmentsWarm', 'heavyIce', 'fanNotAudible', 'fanAudible', 'ventsBlocked',
        'runsNormally', 'doorStartProblem',
        'loadDependent',
        'commandedDrain',
      ]);
      const stated = new Set(derived.map((f) => f.name));
      const derivedByName = new Map(derived.map((d) => [d.name, d]));
      if (Array.isArray(intent.facts) && intent.facts.length) {
        intent.facts = intent.facts.map((f) => {
          if (derivedByName.has(f.name)) return derivedByName.get(f.name);
          return (OBSERVATION_FACTS.has(f.name) && (f.value === 'TRUE' || f.value === 'FALSE') && !stated.has(f.name))
            ? { name: f.name, value: 'UNKNOWN' } : f;
        });
      }
      // MUTUAL EXCLUSIVITY (customer-authoritative): hob technology, affected-zone scope and the
      // pan-test are exclusive dimensions. When the customer's OWN words establish one member, its
      // siblings are FALSE — so a resolved dimension is KNOWN (never re-asked as a discriminator), and
      // an LLM guess to the contrary cannot survive (e.g. "gas hob" => not induction, so the gate
      // never asks "is it induction?" for a gas hob). Deterministic; driven only by what was stated.
      if (!Array.isArray(intent.facts)) intent.facts = [];
      const _idx = new Map(intent.facts.map((f, i) => [f.name, i]));
      for (const group of EXCLUSIVE_OBSERVATION_GROUPS) {
        const on = group.find((g) => derived.some((d) => d.name === g && d.value === 'TRUE'));
        if (!on) continue;
        for (const g of group) {
          if (g === on) continue;
          if (_idx.has(g)) intent.facts[_idx.get(g)] = { name: g, value: 'FALSE' };
          else { intent.facts.push({ name: g, value: 'FALSE' }); _idx.set(g, intent.facts.length - 1); }
        }
      }
      dropUnstatedComponentHum(intent, queryText, derived);
      // Commanded/conditional success is not a universal works-fact. Do not let UNDERSTAND
      // promote it to drainsNormally (that is what COMPOSE over-reads as a healthy drain path).
      if (derived.some((d) => d && d.name === 'commandedDrain' && d.value === 'TRUE')
          && Array.isArray(intent.facts)) {
        const generallyDrains = /\bdrains? (?:ok|okay|fine|normally|properly|well)\b/i.test(queryText);
        if (!generallyDrains) {
          intent.facts = intent.facts.map((f) => (
            f && f.name === 'drainsNormally' && f.value === 'TRUE'
              ? { name: 'drainsNormally', value: 'UNKNOWN' } : f
          ));
        }
      }
      // TYPED cannot-answer -> retire the SPECIFIC discriminator, not a generic marker. Jev typed
      // that the customer could not (or would not) answer the pending question; askedDiscriminatorFact
      // recovers WHICH typed discriminator the prior advisor turn asked (structural identity from the
      // conversation, not customer prose). Naming that fact in declinedFacts lets materialAmbiguity
      // suppress it (and its question-siblings) so the same thing is never re-asked — it is replaced by
      // a materially-different alternative discriminator if one exists, else a grounded conclusion.
      // No raw assistant-text repetition detector; no "I'm not sure" phrase matching.
      const declinedFromText = intent._cannotAnswer ? deriveDeclinedFacts(queryText) : [];
      // Retire EVERY discriminator asked so far this thread, not just the one from the last turn.
      // Part-finder recomputes per turn from the message history (no durable discriminator state), so
      // without this a discriminator asked two turns ago resurfaces after a later cannot-answer and
      // the customer gets the same question again. askedDiscriminatorFact names the most-recent one;
      // allAskedDiscriminatorFacts names them all.
      const declinedAskedFacts = (intent._cannotAnswer && progress && progress.isFollowUp)
        ? allAskedDiscriminatorFacts(messages) : [];
      const declinedPendingFact = (intent._cannotAnswer && progress && progress.isFollowUp)
        ? askedDiscriminatorFact(progress) : null;
      if (declinedFromText.length || declinedAskedFacts.length || declinedPendingFact || intent._cannotAnswer) {
        intent.declinedFacts = [...new Set([
          ...(intent.declinedFacts || []),
          ...declinedFromText,
          ...declinedAskedFacts,
          ...(declinedPendingFact ? [declinedPendingFact] : []),
        ])];
        if (declinedPendingFact) intent._declinedPendingFact = declinedPendingFact;
        metric.declinedFacts = intent.declinedFacts;
        metric.cannotAnswer = Boolean(intent._cannotAnswer);
      }
      // COMPLETED-CHECK EVIDENCE -> checksReported (progression). Jev already types which accessible
      // checks the customer has completed and found clear (_jevEvidence -> intent.facts above:
      // filterChecked / hoseChecked / impellerClear / airflowChecked = TRUE). Surface those typed
      // facts as checksReported so the "do not recommend these again" COMPOSE instruction and the
      // accessible-check selector CONSUME them. CHECK_DONE_LABEL maps a Jev FACT NAME to a short
      // label — it is not customer-prose keyword matching; the meaning came from Jev's typed answer.
      const completedChecks = (intent.facts || [])
        .filter((f) => f && f.value === 'TRUE' && CHECK_DONE_LABEL[f.name])
        .map((f) => CHECK_DONE_LABEL[f.name]);
      if (completedChecks.length) {
        intent.checksReported = Array.from(new Set([...(intent.checksReported || []), ...completedChecks]));
        metric.completedChecks = intent.checksReported;
      }
    }

    // Resolve the fault against the catalogue (error code beats symptom). `let` because a grounded
    // first-class NORMAL-BEHAVIOUR match (below) may override a fuzzy symptom-only fault guess.
    let fault = intent.onTopic !== false ? resolveFault(intent) : null;
    const originalProvenGood = [...(intent.provenGood || [])];
    const originalFacts = (intent.facts || []).map((f) => (f ? { name: f.name, value: f.value } : f));
    const refreshEvidence = (currentFault) => {
      intent.provenGood = originalProvenGood;
      intent.facts = originalFacts.map((f) => (f ? { name: f.name, value: f.value } : f));
      const adj = collectEvidence(intent, `${progressCustomerText(progress)} ${queryText}`, currentFault);
      intent.provenGood = adj.provenGood;
      intent.conditionLimited = adj.conditionLimited;
      intent.alreadyReplaced = adj.alreadyReplaced;
      // Intervention outcome is a customer OBSERVATION now owned by Jev (Story 2): the
      // typed evIntervention answer (temporary / attempted) replaces the prose parser.
      intent._interventionResults = (intent._jevEvidence && intent._jevEvidence.intervention
        && intent._jevEvidence.intervention.outcome)
        ? [{ outcome: intent._jevEvidence.intervention.outcome, kind: 'INTERVENTION_RESULT' }]
        : [];
      neutralizeConditionLimitedFacts(intent, currentFault && currentFault.node, adj.conditionLimited);
      return adj;
    };

    // EVIDENCE-AWARE DIFFERENTIAL (Fix #3 pruning + #4 already-replaced): remove suspects the
    // customer's own evidence proves are working, and demote (never drop) parts they've already
    // replaced, so both the COMPOSE prose (reads intent.candidateComponents) and the structured
    // suggestedChecks (post-backfill list below) reflect it. General; no per-fault table.
    // Same-function "works under some conditions" evidence is conditionLimited, not provenGood.
    let evidenceAdj = refreshEvidence(fault);
    intent.candidateComponents = adjustDifferential(intent.candidateComponents, evidenceAdj);
    if (evidenceAdj.provenGood.length || evidenceAdj.alreadyReplaced.length || evidenceAdj.conditionLimited.length) {
      metric.evidenceAdj = {
        provenGood: evidenceAdj.provenGood,
        alreadyReplaced: evidenceAdj.alreadyReplaced,
        conditionLimited: evidenceAdj.conditionLimited,
      };
    }

    if (fault) {
      metric.fault = { id: fault.faultId, via: fault.via };
    } else if (intent.errorCode) {
      // A code we couldn't resolve = catalogue gap (gold for improvement).
      metric.unresolvedErrorCode = `${intent.make || '?'}:${intent.errorCode}`;
    }

    // AUTHORITATIVE ERROR-CODE → COMPONENT propagation.
    // When a fault is resolved from a manufacturer error-code table (via 'errorCode'), the code is
    // an AUTHORITATIVE signal for the diagnostic area — a stronger signal than the UNDERSTAND
    // model's free-text guess about what the code means. The local model frequently MIS-guesses
    // brand codes (observed: Samsung fridge 22E read as a "comms/PCB" fault), and that guess was
    // ranked ABOVE the catalogue's curated components and led COMPOSE. Here we make the catalogue
    // node's components the leading differential and drop a contradictory model primaryFinding, so
    // COMPOSE explains what the code AUTHORITATIVELY indicates (calibrated by the node discriminator
    // as an AREA/likely-cause, not a proven failed part). Scoped to via==='errorCode' ONLY, so
    // symptom-grounded faults keep their evidence-based candidateComponents reordering.
    if (fault && fault.via === 'errorCode' && Array.isArray(fault.node.components) && fault.node.components.length) {
      evidenceAdj = refreshEvidence(fault);
      intent.candidateComponents = adjustDifferential(
        authoritativeCodeComponents(fault, intent.candidateComponents), evidenceAdj);
      intent.primaryFinding = null; // don't let the model's guess about the code lead COMPOSE
      metric.errorCodeAuthoritative = fault.faultId;
    }
    // Code given + brand known but NOT resolved via the brand's table = likely a
    // misread code or wrong brand (cross-brand confusion). Track it.
    if (intent.errorCode && brandFamily(intent.make) && (!fault || fault.via !== 'errorCode')) {
      metric.codeBrandMismatch = `${intent.make}:${intent.errorCode}`;
    }

    // FACT FIDELITY GATE (deterministic; symptom/classified faults only — NEVER error-code authority).
    // A candidate the customer's OWN stated facts strongly CONTRADICT must not lead. If the UNDERSTAND
    // pass offered an alternative the same facts support and don't contradict, re-ground to it; else
    // demote the contradicted fault to a hedged, check-first posture (don't push its part) so COMPOSE
    // leads with what the evidence actually supports. General (uses node signals[]); no per-journey logic.
    if (fault && fault.via !== 'errorCode') {
      const conflict = factConflict(fault.node, intent.facts, evidenceAdj.conditionLimited);
      if (conflict.contradicted) {
        const alt = chooseCompatibleFault(intent, fault, applianceKey(intent.applianceType));
        if (alt) {
          metric.factRerouted = `${fault.faultId}->${alt.faultId}`;
          fault = alt;
          intent.faultId = alt.faultId;
          evidenceAdj = refreshEvidence(fault);
          // Re-rank the differential around the newly-grounded node; the curated backfill later
          // (getLikelyComponents) completes it. Re-apply evidence pruning so it stays consistent.
          intent.candidateComponents = adjustDifferential(
            [...new Set([...(alt.node.components || []), ...(intent.candidateComponents || [])])],
            evidenceAdj,
          );
          intent.primaryFinding = null; // the model's finding was written for the contradicted fault
        } else {
          // No LLM-offered alternative fits, but the customer's OWN facts may now decisively support a
          // DIFFERENT node (e.g. a grinding answer that contradicts the wash pump now points to a
          // foreign object). Re-commit deterministically from the evidence before demoting to a hedge.
          const reCommit = commitFromEvidence(intent, applianceKey(intent.applianceType));
          if (reCommit && reCommit.faultId !== fault.faultId) {
            metric.factReCommitted = `${fault.faultId}->${reCommit.faultId}`;
            fault = reCommit;
            intent.faultId = reCommit.faultId;
            evidenceAdj = refreshEvidence(fault);
            intent.candidateComponents = adjustDifferential(
              [...new Set([...(reCommit.node.components || []), ...(intent.candidateComponents || [])])],
              evidenceAdj,
            );
            intent.primaryFinding = null;
          } else {
            metric.factConflict = `${fault.faultId}:${conflict.reasons.join('|')}`;
            intent._factConflict = { label: fault.node.label, reasons: conflict.reasons };
            intent.primaryFinding = null; // don't let a contradicted finding lead the reply
          }
        }
      }
    }

    // COMMIT ON ANSWERED DISCRIMINATOR (evidence-grounded progression). If the UNDERSTAND pass left
    // the fault UNGROUNDED (faultId null — observed on "loud grinding on the spin") but the customer's
    // OWN facts now decisively point to a single compatible node, ground to it rather than asking
    // another open question. Purely evidence-driven (commitFromEvidence reuses node signals[] +
    // factConflict); never fires for an error-code turn (that authority is owned upstream), and never
    // fabricates a diagnosis when the evidence is weak or ambiguous (returns null -> caller still asks).
    if (!fault && intent.onTopic !== false && !intent.errorCode) {
      const committed = commitFromEvidence(intent, applianceKey(intent.applianceType));
      if (committed) {
        fault = committed;
        intent.faultId = committed.faultId;
        evidenceAdj = refreshEvidence(fault);
        intent.candidateComponents = adjustDifferential(
          [...new Set([...(committed.node.components || []), ...(intent.candidateComponents || [])])],
          evidenceAdj,
        );
        metric.evidenceCommit = `${committed.faultId}:${committed.score}`;
      }
    }

    // Node outcome type — deterministic, application-level guardrail (not left
    // to prompt compliance). ADVICE_ONLY (maintenance/technique) and SAFETY_STOP
    // must NEVER trigger commercial parts retrieval; PART_ROUTING (default) may.
    // Safety classification is Jev's semantic decision. Enforcement (stop
    // diagnosis, suppress parts, safety-first reply) stays deterministic here.
    const safetyClassRaw = intent.onTopic !== false
      ? (intent._safetyClassification || null)
      : null;
    // STOP-USE-but-DIAGNOSABLE tier (microwave cavity arcing): the customer is told to stop using the
    // appliance, but we STILL deliver the grounded diagnosis + safe visual checks (waveguide cover /
    // metal / food deposits) — a calibrated safety response, not a blanket "stop all diagnosis". Kept
    // strictly separate from the HARD stops so `safetyStop` retains its exact hard-stop meaning
    // everywhere below (outcome=SAFETY_STOP, prose = safety action only, no safetyInformation/media).
    const unsafeIntent = intent.onTopic !== false ? detectUnsafeIntent(queryText) : false;
    const hvHalt = unsafeIntent && isMicrowaveHvProcedureRequest(queryText);
    const hvBoundary = !hvHalt && microwaveHeatingHvBoundaryApplies(
      intent,
      `${progressCustomerText(progress)} ${queryText}`,
    );
    const diagnoseStop = safetyClassRaw && safetyClassRaw.tier === 'STOP_USE_DIAGNOSE'
      ? safetyClassRaw.category
      : (hvHalt ? 'hv-service' : (hvBoundary ? 'hv-boundary' : null));
    let safetyClass = safetyClassRaw && safetyClassRaw.tier !== 'STOP_USE_DIAGNOSE' ? safetyClassRaw : null;
    // GAS CORROBORATION GUARD. A genuine gas emergency is ALWAYS reported with an escape cue — a
    // smell, a leak, hissing or escaping gas — which the deterministic classifySafetyStop gas gate
    // requires. Jev can over-lean on the bare word "gas" (a customer merely saying "it's gas" / "gas
    // hob") and probability-mass escalation then fires a full gas emergency, derailing an ordinary
    // gas-appliance fault. So a gas STOP must be corroborated by that cue in the conversation text;
    // without it we drop the gas stop (an ordinary gas-appliance fault, Gas-Safe boundary still
    // applies downstream). Zero-tolerance detection is preserved: any real smell/leak/hiss still trips.
    if (safetyClass && safetyClass.category === 'gas') {
      const gasBlob = `${progressCustomerText(progress)} ${queryText}`;
      const corroborated = classifySafetyStop(gasBlob);
      if (!corroborated || corroborated.category !== 'gas') {
        metric.gasStopUncorroborated = true;
        safetyClass = null;
      }
    }
    // Also remember whether ANY gas-escape cue is corroborated this conversation, independent of
    // whether Jev raised a gas stop — so an EMERGENCY_ACTION gas safety-information card (conditional
    // "if you smell gas…" advice attached to a routine gas-appliance fault) is only allowed to force
    // a gas emergency when a real escape cue is present. Without this, a gas hob that simply won't
    // light (HOB-04) was escalated to a full National-Gas-Emergency evacuation via the card alone.
    const gasEscapeCorroborated = (() => {
      const c = classifySafetyStop(`${progressCustomerText(progress)} ${queryText}`);
      return Boolean(c && c.category === 'gas');
    })();
    // ELECTRICAL SUPPLY-TRIP CORROBORATION GUARD. A genuine live-supply earth/overload STOP is one
    // where THE APPLIANCE trips the household electrics when used — always reported with trip/RCD/
    // breaker/fuse-box language, which the deterministic classifySafetyStop supply-trip gate
    // requires. Jev can over-lean on the bare phrase "power cut" / "since the power went" (a PAST
    // outage that has since been restored) and escalate to a full electrical stop, turning an
    // ordinary post-power-cut fault (clock not reset, a one-off trip) into a dead-end "call an
    // electrician" reply. So an electrical supply-trip STOP must be corroborated by that cue in the
    // conversation; without it we drop the stop and let normal diagnosis proceed. A real
    // appliance-trips-the-electrics report (any tense) still trips, since classifySafetyStop matches it.
    if (safetyClass && safetyClass.category === 'electrical' && safetyClass.reason === 'supply-trip') {
      const elecBlob = `${progressCustomerText(progress)} ${queryText}`;
      const corroborated = classifySafetyStop(elecBlob);
      if (!corroborated || corroborated.category !== 'electrical') {
        metric.electricalStopUncorroborated = true;
        safetyClass = null;
      }
    }
    const safetyStop = safetyClass ? safetyClass.category : null;
    // Customer asking to PERFORM a dangerous action (additive; attaches an active warning downstream,
    // never provides the action — except microwave HV internals, which halt diagnosis entirely).
    const isolationAdvisory = intent.onTopic !== false && !safetyStop && !diagnoseStopIsProfessionalHv(diagnoseStop)
      && proposedPhysicalAccess(queryText);
    intent._isolationAdvisory = isolationAdvisory;
    // NORMAL / EXPECTED behaviour recognition — now FIRST-CLASS and knowledge-grounded.
    // matchNormalBehaviour() resolves the raw text (+ appliance family/make) against the authored
    // normal-behaviour knowledge (features, indicators, symbols and operating conditions), applying
    // the shared failure-symptom veto and each record's own fault-like `notIf` calibration.
    // A grounded normal-behaviour record is STRONGER evidence than a fuzzy symptom-only fault guess,
    // so it OVERRIDES such a fault (fixes the "confident mis-diagnosis of a normal feature" cases);
    // but a RESOLVED brand error code, a genuine failure symptom, or a safety-stop always wins.
    // The model's own normalBehaviour flag stays as a softer signal that, on its own, does NOT
    // override a grounded fault or an error code (conservative — unchanged from before).
    const nbMatch = intent.onTopic !== false
      ? matchNormalBehaviour(
          { applianceFamily: applianceKey(intent.applianceType), make: intent.make },
          queryText,
        )
      : null;
    const resolvedErrorCode = Boolean(fault && fault.via === 'errorCode');
    const normalByKnowledge = Boolean(nbMatch) && !safetyStop && !resolvedErrorCode;
    const normalByModelFlag = intent.normalBehaviour === true
      && !fault && !intent.errorCode && !safetyStop && !hasFailureSymptom(queryText);
    const normalBehaviour = intent.onTopic !== false && (normalByKnowledge || normalByModelFlag);
    if (normalByKnowledge) metric.normalBehaviourFlag = 'knowledge';
    else if (normalByModelFlag) metric.normalBehaviourFlag = 'model';
    if (nbMatch) metric.normalBehaviourId = nbMatch.id;
    // When a normal-behaviour record grounds, it OWNS the outcome: drop any fuzzy symptom fault so
    // COMPOSE takes the reassurance path (no diagnosis guidance, no part push), and seed the
    // specific, provenance-backed explanation (primaryFinding) + the calibrated "what WOULD indicate
    // a fault" conditions so the reassurance stays calibrated, never dismissive.
    if (normalByKnowledge) {
      if (fault) metric.normalOverrodeFault = fault.faultId;
      fault = null;
      intent.faultId = null;
      intent.primaryFinding = nbMatch.reassurance || intent.primaryFinding;
      // Calibration for COMPOSE: what WOULD make this the same-looking FAULT (so reassurance stays
      // honest, never dismissive). Carried on intent (like primaryFinding) — no compose signature churn.
      intent.normalFaultLikeIf = Array.isArray(nbMatch.faultLikeIf) ? nbMatch.faultLikeIf : null;
    }

    // POSITIVE-OBSERVATION CONSTRAINT (deterministic evidence fidelity). An explicit customer
    // report that a function DID happen must not become the opposite diagnosis ("it locks" must
    // not headline "won't lock"). Downrank a simple/complete failure of that function, keep
    // conditionally compatible causes, and ask the discriminator that localises what remains.
    // Never for an authoritative error code, a safety-stop, or normal-behaviour reassurance.
    if (intent.onTopic !== false && !safetyStop && !normalBehaviour && !diagnoseStopIsProfessionalHv(diagnoseStop)) {
      fault = constrainByPositiveObservations(intent, fault, queryText, retrieval.docs, metric, progress);
    }

    // MATERIAL DIAGNOSTIC AMBIGUITY GATE (ask the highest-value discriminator BEFORE component commit).
    // We grounded a symptom/classified fault, but if a materially-different alternative (different
    // component family, or a free no-part fix vs a replacement) is still plausible AND separable by a
    // currently-UNKNOWN observable discriminator, ASK that discriminator this turn instead of
    // committing to a component. Evidence-driven (materialAmbiguity reuses node signals[]); never for
    // an authoritative error code, a deterministic evidence-commit, a safety-stop or normal behaviour.
    // The next turn's answer re-ranks/commits via the existing evidence machinery (Jev typed
    // evidence + commitFromEvidence + fact-fidelity), so this only decides WHEN a discriminator is required first.
    // A cannot-answer no longer SKIPS this gate: the discriminator the customer could not answer is
    // already in declinedFacts, so materialAmbiguity suppresses it and (if a materially-different one
    // remains) returns an ALTERNATIVE, lower-burden discriminator instead. The asked question is never
    // re-emitted (declinedFacts suppression + discriminatorAlreadyAsked). When no alternative remains,
    // the gate yields nothing and progressAfterDeclinedDiscriminator grounds to the best evidence.
    if (fault && !safetyStop && !normalBehaviour && !diagnoseStopIsProfessionalHv(diagnoseStop) && !intent.errorCode
        && !intent._observationAmbiguity
        && !intent._discriminatorJustAnswered
        && (fault.via === 'classified' || fault.via === 'classified-fault-field' || fault.via === 'symptom')) {
      const amb = materialAmbiguity(
        fault.faultId,
        fault.node,
        intent.facts,
        applianceKey(intent.applianceType),
        intent.declinedFacts,
      );
      const ambQuestion = amb ? (DISCRIMINATOR_QUESTION[amb.fact]
        || 'Can you describe the problem a bit more — when it happens and what it sounds or looks like?') : '';
      if (amb && !discriminatorAlreadyAsked(progress, ambQuestion)) {
        metric.materialAmbiguity = `${fault.faultId}|${amb.altId}|${amb.fact}`;
        intent._materialAmbiguity = {
          leaderLabel: fault.node.label,
          altLabel: amb.altNode.label,
          fact: amb.fact,
          question: ambQuestion,
        };
        intent.clarifyingQuestion = intent._materialAmbiguity.question;
        intent.needMoreInfo = true;
        // Ask before committing: ungrounded THIS turn so the boundary/orchestrator asks a
        // SYMPTOM_DISCRIMINATOR rather than presenting a (possibly wrong-family) committed diagnosis.
        // Clear the free-text label + differential too, so the reply is a clean discriminator question
        // and does not pre-empt one candidate (e.g. listing the foreign-object checks) before the answer.
        fault = null;
        intent.faultId = null;
        intent.fault = null;
        intent.primaryFinding = null;
        intent.candidateComponents = [];
      }
    }

    // Error-code AREA discriminator: the code names a diagnostic area, not a proven part.
    // If a high-value observable would still separate that area from a materially different
    // cause, ASK it — but KEEP the code meaning grounded (do not unground like the symptom gate).
    if (fault && fault.via === 'errorCode' && !safetyStop && !normalBehaviour && !diagnoseStopIsProfessionalHv(diagnoseStop)) {
      const appForAmb = applianceKey(intent.applianceType) || fault.resolvedAppliance;
      const amb = materialAmbiguity(
        fault.faultId,
        fault.node,
        intent.facts,
        appForAmb,
        intent.declinedFacts,
      );
      if (amb) {
        const question = DISCRIMINATOR_QUESTION[amb.fact]
          || 'Can you describe the problem a bit more — when it happens and what it sounds or looks like?';
        if (!discriminatorAlreadyAsked(progress, question)) {
          intent._areaDiscriminator = {
            leaderLabel: fault.node.label,
            altLabel: amb.altNode.label,
            fact: amb.fact,
            question,
          };
          intent.clarifyingQuestion = question;
          intent.nextBestCheck = question;
          intent.nextCheckCustomerSafe = true;
          intent.furtherGenericCheckJustified = true;
          intent.needMoreInfo = true;
          metric.errorCodeAreaDiscriminator = `${fault.faultId}|${amb.altId}|${amb.fact}`;
        }
      }
    }

    // Declined discriminator: the customer cannot answer. Do not re-ask. Ground from existing
    // evidence (kept leader, faultId, commitFromEvidence, retrieval doc) and clear the ask flags.
    // First-turn hedges never enter this path (customerDeclinedDiscriminator is false).
    // Only ground the declined discriminator when the gate did NOT already choose a materially-
    // different ALTERNATIVE this turn. If a fresh, lower-burden alternative discriminator was picked
    // (the question the customer could not answer is now in declinedFacts), let that stand instead of
    // committing — the customer gets a different, easier question rather than a premature conclusion.
    const freshDiscriminatorChosen = Boolean(intent._materialAmbiguity || intent._areaDiscriminator);
    if (!freshDiscriminatorChosen
        && !safetyStop && !normalBehaviour && !diagnoseStopIsProfessionalHv(diagnoseStop) && !intent.errorCode) {
      const cannotAnswerNow = Boolean(intent._cannotAnswer) && progress && progress.isFollowUp;
      const progressed = progressAfterDeclinedDiscriminator(intent, fault, retrieval.docs, queryText, cannotAnswerNow);
      fault = progressed.fault;
      if (progressed.progressed) {
        metric.discriminatorDeclined = fault ? `${fault.faultId}:${fault.via}` : 'cleared';
      }
    }

    applyFollowUpNextAction(intent, progress, { safetyStop, normalBehaviour, messages });
    if (!safetyStop && !normalBehaviour && !diagnoseStopIsProfessionalHv(diagnoseStop) && displayedIndicationNeedsIdentity(intent, queryText)) {
      applyDisplayedIndicationIdentity(intent, queryText, metric);
      fault = null;
    }
    if (!safetyStop && !normalBehaviour && !diagnoseStopIsProfessionalHv(diagnoseStop)) {
      captureQuestionedCause(intent, queryText);
      demotePrematurePartRequest(intent, queryText);
      preferAccessibleFirstAction(intent, queryText, progress);
      {
        const familyGate = { fault };
        preferFamilyBeforeSpecificDiagnosis(intent, queryText, progress, familyGate);
        fault = familyGate.fault;
      }
      preferConditionDiscriminator(intent);
      preferNotRepeatIntervention(intent);
      preferRelatedFunctionDiscriminator(intent, queryText, progress);
      fault = preferArchitectureDependentAdvice(intent, fault, queryText, progress);
      if (fault && fault.faultId) intent.faultId = fault.faultId;
      preferAdviceThenIdentity(intent, progress, { fault, safetyStop, normalBehaviour, queryText });
      demoteUnconfirmedTheoryFinding(intent);
      // A later customer turn can legitimately move the journey from diagnosis
      // to replacement/purchase. Let Jev's typed semantic decision supersede a
      // stale check/discriminator, but only once product identity and fault are grounded.
      applyPartReadinessProgression(intent, fault);
    }
    if (diagnoseStop === 'hv-boundary') {
      intent.candidateComponents = [];
      if (intent.primaryFindingKind === 'component') intent.primaryFindingKind = 'subsystem';
      intent.nextBestCheck = 'A qualified microwave engineer is required once the next step would be high-voltage heating-system access or testing. Do not open, discharge, or meter those internals.';
      intent.nextCheckCustomerSafe = false;
      intent.furtherGenericCheckJustified = false;
      intent.needMoreInfo = false;
      intent.clarifyingQuestion = null;
      intent._materialAmbiguity = null;
      intent._observationAmbiguity = null;
      intent._areaDiscriminator = null;
      intent._nextAction = 'advice';
      if (!intent.primaryFinding) {
        intent.primaryFinding = 'The microwave is running but not heating, which points to the heating system. Testing high-voltage internals is professional-only.';
      }
    }
    if (diagnoseStop === 'hv-service') {
      fault = null;
      intent.faultId = null;
      intent.fault = null;
      intent.primaryFinding = null;
      intent.candidateComponents = [];
      intent.nextBestCheck = null;
      intent.clarifyingQuestion = null;
      intent._materialAmbiguity = null;
      intent._observationAmbiguity = null;
      intent._areaDiscriminator = null;
      intent._nextAction = 'safety_stop';
    }
    if (intent._nextAction !== 'check' && intent._nextAction !== 'safety_stop'
        && intent._nextAction !== 'advice' && intent._nextAction !== 'identification'
        && intent._nextAction !== 'advice_then_identity'
        && (intent._materialAmbiguity || intent._observationAmbiguity || intent._areaDiscriminator)) {
      intent._nextAction = 'discriminator';
    } else if (identificationIsNextAction(intent, progress) && !intent._nextAction) {
      intent._nextAction = 'identification';
    }
    // VAGUE OPENER → ONE PRIMARY CLARIFICATION. When the customer has not established WHAT is wrong
    // (no grounded fault, no candidate, no symptom, no concrete next action) ask exactly one open
    // question instead of letting COMPOSE enumerate a menu of possibilities + the model in one turn.
    preferSingleVagueClarify(intent, fault, { safetyStop, normalBehaviour, diagnoseStop });
    if (!safetyStop && !diagnoseStopIsProfessionalHv(diagnoseStop)
        && latestTurnSaysChecksNotDone(progress) && (intent.nextBestCheck || intent.nextCheckCustomerSafe)) {
      // The customer has not done the recommended check yet. Keeping the accessible check as the
      // next action is correct the FIRST time they say so. But if this exact check was ALREADY put
      // to them, re-asserting it with furtherGenericCheckJustified=true bypasses the anti-repeat
      // guard and produces the verbatim repeat we must avoid. On that repeat, do NOT force it
      // through: flag it so COMPOSE guides ONCE on HOW / offers a lower-burden alternative and then
      // moves to the best grounded next step, instead of restating the same instruction.
      // A second not-done turn means the same instruction is no longer progress. Detect the repeat
      // structurally (turn count) as well as by text — COMPOSE rewords nextBestCheck between turns,
      // so the text needle alone misses it.
      const notDoneCount = checksNotDoneTurnCount(messages);
      const alreadyRecommended = notDoneCount >= 2
        || discriminatorAlreadyAsked(progress, intent.nextBestCheck)
        || discriminatorAlreadyAsked(progress, intent.clarifyingQuestion);
      if (!alreadyRecommended) {
        // First not-done turn: keep the accessible check as the next action (a legitimate nudge).
        intent._nextAction = 'check';
        intent.nextCheckCustomerSafe = true;
        intent.needMoreInfo = true;
        intent.furtherGenericCheckJustified = true;
      } else {
        // Second not-done turn: re-asserting the same instruction is no longer progress. Move the
        // conversation forward with a DIFFERENT, lower-burden action. If product identity is not yet
        // known, pivot to identification (make/model) — model-specific guidance or the right part is
        // the next useful step when the customer cannot do the accessible check. If identity is
        // already known, ground to the most-likely cause and offer the check as an OPTION / the
        // engineer path (framed by the _checkNotDoneRepeat compose note). Either way, stop repeating
        // the same check instruction.
        intent.furtherGenericCheckJustified = false;
        if (!productIdentitySufficient(intent)) {
          // Pivot cleanly to identification. Do NOT re-mention the check at all — re-describing it is
          // what reads as a repeat. Acknowledge briefly (compose note) and ask for the make/model.
          intent._checkDeferredToIdentity = true;
          const q = applianceKey(intent.applianceType)
            ? familyKnownIdentificationAsk(intent).clarifyingQuestion
            : 'What is the make and model number (on the rating plate)?';
          intent.nextBestCheck = null;
          intent.clarifyingQuestion = null;
          setIdentificationNext(intent, q);
        } else {
          // Identity already known: ground to the most-likely cause and offer the check as an OPTION
          // / the engineer path (framed by the _checkNotDoneRepeat compose note).
          intent._checkNotDoneRepeat = true;
          intent._deferredCheck = intent.nextBestCheck || intent.clarifyingQuestion || null;
          intent.needMoreInfo = false;
          intent.nextBestCheck = null;
          intent.clarifyingQuestion = null;
          if (intent._nextAction === 'check' || !intent._nextAction) intent._nextAction = 'advice';
          if (!fault || !fault.node) {
            const committed = commitFromEvidence(intent, applianceKey(intent.applianceType));
            if (committed) { intent.faultId = committed.faultId; fault = committed; }
          }
        }
      }
    }
    // Typed REFUSAL / cannot-do of a pending physical CHECK. Jev now types a refusal as cannot_answer;
    // unlike "haven't done it yet" (handled above, where one nudge is reasonable), re-instructing a
    // check the customer will not / cannot do is no progress. Pivot once to the lower-burden path —
    // identification, else a grounded conclusion — reusing the same pivot the checks path uses. Scoped
    // to a pending customer-safe check with no live discriminator/ambiguity so it never pre-empts the
    // discriminator-decline path. Driven by the typed signal, not customer prose.
    if (!safetyStop && !normalBehaviour && !diagnoseStopIsProfessionalHv(diagnoseStop)
        && intent._cannotAnswer && progress && progress.isFollowUp
        && !latestTurnSaysChecksNotDone(progress)
        && !intent._materialAmbiguity && !intent._areaDiscriminator && !intent._observationAmbiguity
        && !intent._checkDeferredToIdentity && !intent._checkNotDoneRepeat
        && (intent.nextBestCheck || intent.nextCheckCustomerSafe === true)) {
      intent.furtherGenericCheckJustified = false;
      if (!productIdentitySufficient(intent)) {
        intent._checkDeferredToIdentity = true;
        const q = applianceKey(intent.applianceType)
          ? familyKnownIdentificationAsk(intent).clarifyingQuestion
          : 'What is the make and model number (on the rating plate)?';
        intent.nextBestCheck = null;
        intent.clarifyingQuestion = null;
        setIdentificationNext(intent, q);
      } else {
        intent._checkNotDoneRepeat = true;
        intent._deferredCheck = intent.nextBestCheck || intent.clarifyingQuestion || null;
        intent.needMoreInfo = false;
        intent.nextBestCheck = null;
        intent.clarifyingQuestion = null;
        if (intent._nextAction === 'check' || !intent._nextAction) intent._nextAction = 'advice';
        if (!fault || !fault.node) {
          const committed = commitFromEvidence(intent, applianceKey(intent.applianceType));
          if (committed) { intent.faultId = committed.faultId; fault = committed; }
        }
      }
    }

    const nodeOutcome = (fault && fault.node && fault.node.outcome) || 'PART_ROUTING';
    const outcome = safetyStop ? 'SAFETY_STOP' : (normalBehaviour ? 'ADVICE_ONLY' : nodeOutcome);
    const committedFinding = Boolean(
      fault && !safetyStop && !normalBehaviour && !intent._areaDiscriminator
        && !intent._observationAmbiguity
        && !factConflict(fault.node, intent.facts).contradicted
        && (
          fault.via === 'errorCode'
          || fault.via === 'evidence-commit'
          || intent._discriminatorDeclined === true
          || (typeof intent.confidence === 'number' && intent.confidence >= 0.55)
          || evidenceDecisive(fault.node, intent.facts)
        ),
    );
    const remoteAction = classifyRemoteActionClass({
      safetyStop, diagnoseStop, applianceType: intent.applianceType, queryText,
    });
    const presentation = computePresentationGrain({
      intent, fault, committedFinding, safetyStop, diagnoseStop, remoteAction, outcome, queryText,
    });
    // Purchase grain may be justified from the node's catalogue components even when
    // UNDERSTAND left candidateComponents empty (subsystem findings). Backfill so
    // retrieval ranking and COMPOSE see the same structured list.
    if (presentation.purchaseAppropriate && !(intent.candidateComponents || []).length) {
      const fromNode = namedOrCatalogueComponents(intent, fault);
      if (fromNode.length) intent.candidateComponents = fromNode.slice();
    }
    metric.componentMention = presentation.mention;
    metric.purchaseAppropriate = presentation.purchaseAppropriate;
    metric.remoteActionClass = remoteAction;
    metric.hazardProvenance = safetyStop
      ? (intent._safetyClassification ? 'observed' : 'inferred')
      : 'none';
    // Parts are suppressed on advice-only / hard safety-stop / stop-use-diagnosable arcing
    // AND unless purchase grain has been reached. Retrieved catalogue rows must not become
    // shopping cards before the diagnostic outcome supports a purchase.
    const suppressParts = outcome === 'ADVICE_ONLY' || outcome === 'SAFETY_STOP' || !!diagnoseStop
      || !presentation.purchaseAppropriate;
    if (safetyStop) { metric.safetyStop = safetyStop; metric.safetyStopReason = safetyClass.reason; }
    if (diagnoseStop) { metric.diagnoseStop = diagnoseStop; metric.diagnoseStopReason = (safetyClassRaw && safetyClassRaw.reason) || diagnoseStop; }
    if (unsafeIntent) metric.unsafeIntent = true;
    if (normalBehaviour) metric.normalBehaviour = true;
    if (suppressParts) metric.outcomeSuppressedParts = outcome;

    // -------- RETRIEVE --------
    let parts = [];
    let modelInfo = null;
    let retrievalPath = 'none';
    let modelResolved = null;

    if (intent.onTopic !== false && !suppressParts) {
      if (intent.model) {
        retrievalPath = 'model';
        const md = await getPartsForModel(intent.model);
        modelResolved = md.parts.length > 0;
        if (md.parts.length > 0) {
          parts = md.parts;
          modelInfo = md.model;
        }
      }
      // Best-effort search ONLY when we have a model to work from (even if it
      // didn't resolve) OR the customer can't give the model BUT we at least
      // know the MAKE to scope a brand search to. We NEVER run a brand-less
      // generic search: with no make and no model we hold parts back and just
      // diagnose + ask for the make/model first (the `Boolean(intent.make)`
      // guard below structurally requires a make before any brand fallback).
      // Whether the customer "can't give the model" is Jev's TYPED decision
      // (intent.modelUnavailable) — Jev is the sole semantic authority, so we
      // no longer re-read the customer's prose here with a second phrase parser.
      const canFallbackSearch =
        Boolean(intent.model) || (intent.modelUnavailable && Boolean(intent.make));
      if (parts.length === 0 && canFallbackSearch) {
        retrievalPath = retrievalPath === 'model' ? 'model+search' : 'search';
        // Gather across ALL the fault's components (brand-scoped), not just the
        // first that returns results — otherwise we'd find e.g. drain hoses,
        // stop, and never see the drain pump (making the AI wrongly say "we
        // don't stock the pump"). Deduped, per-query and total caps keep it sane.
        const candidates = buildQueryCandidates(intent, fault);
        const seen = new Set();
        const gathered = [];
        const usedQ = [];
        for (const q of candidates) {
          if (gathered.length >= 15) break;
          const res = await searchCatalogue(q, intent.make);
          if (res.length) usedQ.push(`${q}(${res.length})`);
          let added = 0;
          for (const p of res) {
            if (gathered.length >= 15 || added >= 6) break;
            if (!seen.has(p.partId)) {
              seen.add(p.partId);
              // No model resolved here — these are brand-scoped matches, NOT
              // confirmed for the customer's exact model. Flag verify-fit so the
              // UI never claims "confirmed fit for your model" without a model.
              p._brandOnly = true;
              gathered.push(p);
              added++;
            }
          }
        }
        parts = gathered;
        if (usedQ.length) metric.searchQuery = usedQ.join(', ');
      } else if (
        modelResolved === true &&
        fault &&
        intent.make &&
        !parts.some((p) => partMatchesFault(p, fault.node))
      ) {
        // The model resolved and has parts, but NONE match the fault's likely
        // components (the model's linked-part list doesn't include the culprit
        // category). Rather than wrongly imply "we don't stock it", surface the
        // brand's matching parts too — flagged verify-fit since they're not
        // confirmed against this exact model. Model parts stay first.
        retrievalPath = 'model+search';
        metric.modelFaultPartSearched = `${intent.model}:${fault.faultId}`;
        const candidates = buildQueryCandidates(intent, fault);
        const seen = new Set(parts.map((p) => p.partId));
        const usedQ = [];
        for (const q of candidates) {
          if (parts.length >= 15) break;
          const res = await searchCatalogue(q, intent.make);
          if (res.length) usedQ.push(`${q}(${res.length})`);
          let added = 0;
          for (const p of res) {
            if (parts.length >= 15 || added >= 6) break;
            if (!seen.has(p.partId)) {
              seen.add(p.partId);
              p._brandOnly = true; // not confirmed for this exact model
              parts.push(p);
              added++;
            }
          }
        }
        if (usedQ.length) metric.searchQuery = usedQ.join(', ');
      }
    }

    // Rank by the fault so the LLM sees the most-likely component first, but do
    // NOT filter — the LLM is the selector and can pick a part whose title
    // doesn't literally match a component word (e.g. "Door Lock Mechanism" for a
    // door fault). Passing the full ranked list avoids hiding relevant parts.
    if (fault) {
      // Rank by the evidence-based candidate components first, then the fault's
      // static component order, so ordering can respond to the conversation.
      const ordered = [...(intent.candidateComponents || []), ...(fault.node.components || [])];
      parts = rankPartsByFault(parts, { components: [...new Set(ordered)] });
    }

    metric.retrievalPath = retrievalPath;
    metric.modelResolved = modelResolved;
    metric.partsRetrieved = parts.length;
    metric.zeroResults = retrievalPath !== 'none' && parts.length === 0;
    // Model numbers users give that DON'T resolve = catalogue gaps (gold for improvement).
    if (intent.model && modelResolved === false) {
      metric.unresolvedModel = intent.model;
    }

    {
      const conversationIdentity = resolveConversationIdentity({
        messages, queryText,
        jevFamily: applianceKey(intent.applianceType),
        jevFamilyProvenance: intent._applianceFamilyProvenance,
        jevFuel: intent._fuel,
      });
      const allowedFamily = allowedFamilyForReply(queryText, conversationIdentity);
      if (allowedFamily) constrainIntentToFamily(intent, allowedFamily);
    }

    // -------- PASS 2: COMPOSE (streamed to the client) --------
    // Open the NDJSON stream now; forward each token as it arrives so the user
    // sees the reply build live instead of waiting for the whole thing.
    const t2 = Date.now();
    out = awslambda.HttpResponseStream.from(responseStream, {
      statusCode: 200,
      headers: { 'Content-Type': 'application/x-ndjson' },
    });
    // Accumulate the FULL compose reply before writing anything to the client.
    // The only consumer (the whichpart-api boundary) buffers the stream anyway,
    // so this costs no user-facing latency and lets the deterministic OUTPUT
    // TRIPWIRE inspect the whole reply before a single byte reaches the client.
    let reply = '';
    // COMMIT DECISION: a grounded finding should stop the "ask another question" gate.
    // Component purchase still requires presentation.purchaseAppropriate separately.
    const committedDiagnosis = committedFinding;
    if (committedDiagnosis) metric.committedDiagnosis = fault.faultId;
    if (presentation.mention === COMPONENT_MENTION.NONE) {
      intent.candidateComponents = [];
    } else if (presentation.mention === COMPONENT_MENTION.DISCUSS) {
      intent.candidateComponents = (intent.candidateComponents || []).slice(0, 2);
    }
    await composeStream(messages, parts, modelInfo, intent, fault, retrieval.docs, safetyStop, unsafeIntent, normalBehaviour, diagnoseStop, seed, (delta) => {
      reply += delta;
    }, committedDiagnosis, presentation);
    metric.composeMs = Date.now() - t2;

    // OUTPUT TRIPWIRE (deterministic containment). If the composed reply shows
    // evidence of policy disclosure or an off-topic task (a novel injection that
    // slipped the input gate and talked the model into complying), discard it and
    // return the fixed refusal. The unsafe content never reaches the client.
    const tripped = outputTripwire(reply);
    if (tripped) {
      metric.tripwireBlocked = tripped;
      reply = REFUSAL_TEXT;
    }
    // EMPTY-REPLY GUARD: never emit a blank bubble. If compose produced nothing
    // usable, fall back to a safe prompt so the customer always gets a response.
    if (!reply || !reply.trim()) {
      metric.emptyReply = true;
      reply = (intent && (customerFacingNextCheck(intent) || intent.clarifyingQuestion))
        || "Sorry, I didn't quite catch that — could you tell me the appliance make and model, and what it's doing?";
    }

    // Cards shown = the parts the model recommended, detected by their inline
    // [Title](/partNo) link in the reply. The boundary strips those links to
    // clean prose, so the customer sees a tidy sentence ABOVE and the matching
    // buyable cards BELOW — no duplicated price list.
    const shownParts = partsStillInPlay(
      preferCheckFirstPart(selectLinkedParts(reply, parts), parts, fault, intent),
      fault,
      intent,
    );
    // POST-COMPOSE ENFORCEMENT (Story 4): structural / security / safety / parts-policy / format
    // ONLY. The semantic calibrators that used to re-parse the generated reply to rediscover
    // established identity, heat/wash/drying meaning, recovery/intervention outcome, condition-limited
    // parts and error-code provenance have been REMOVED — that meaning is now supplied to COMPOSE as
    // authoritative structured state (AUTHORITATIVE STATE + CUSTOMER EVIDENCE blocks) before it writes.
    reply = constrainReplacementLanguage(reply, shownParts);      // parts-fit policy (structured _brandOnly)
    reply = calibrateLikelyFitProse(reply, shownParts, presentation); // parts-fit policy (structured)
    reply = stripOutOfScopeElectricalTests(reply);                // safety: DIY live-electrical/megger
    reply = stripOwnerInternalElectricalInspection(reply);        // safety: owner internal-electrical inspect/test
    reply = stripMicrowaveHvDiy(reply);                           // safety: microwave HV DIY
    // DETERMINISTIC TERMINAL (decision/result out of COMPOSE). On a cannot-answer / model-unavailable
    // turn with a grounded fault area, state the conclusion + ranked model-independent differential +
    // safe step from TYPED state + the authored record, overriding COMPOSE (which degenerates here).
    {
      const _fam = applianceKey(intent.applianceType);
      const _noiseBlob = `${progressCustomerText(progress)} ${queryText}`;
      // Unlocalised mechanical noise + no function-failure symptom -> render the family's noise /
      // vibration record (balance/transit-bolts/bearings), not a function fault Jev guessed for it.
      const _useNoise = isAcousticOnlyQuery(_noiseBlob)
        && !hasFunctionFailureSymptom(intent)
        && NOISE_RECORD_BY_FAMILY[_fam];
      const _faultForRecord = _useNoise ? NOISE_RECORD_BY_FAMILY[_fam] : intent.faultId;
      const _rec = getKnowledgeRecord(_fam, _faultForRecord);
      const _recovered = (intent.facts || []).some((f) => f && f.name === 'functionRecovered' && f.value === 'TRUE')
        || latestTurnReportsRecovery(progress);
      // Established power type for a cordless/corded split (vacuums): typed from the conversation.
      const _blobLc = _noiseBlob.toLowerCase();
      const _cordless = /\b(cordless|battery|batteries|charg\w*|dock)\b/.test(_blobLc) ? true
        : (/\b(corded|mains lead|plug fuse|power (?:cable|cord)|wall socket)\b/.test(_blobLc) ? false : null);
      const _term = renderDeterministicTerminal(intent, _rec, { safetyStop, diagnoseStop, normalBehaviour, recovered: _recovered, cordless: _cordless });
      if (_term) { metric.deterministicTerminal = true; reply = _term; }
      else {
        // Not a terminal: if a component is committed (model known) but COMPOSE didn't name it,
        // surface the typed conclusion (OC-05 fan element, TD-06 heater, etc.).
        reply = ensureCommittedConclusion(reply, intent, { safetyStop, diagnoseStop, normalBehaviour, recovered: _recovered, metric });
      }
    }
    reply = stripInstructionEcho(reply);                          // internal-instruction leak containment
    // DEGENERATE-REMAINDER GUARD (runs BEFORE the owner-safety note is prepended, so the note cannot
    // mask a degenerate reply). If stripping a scaffolding leak (or a COMPOSE that produced only
    // filler) leaves nothing but a bare acknowledgement ("Understood.", "Thanks.", "I understand."),
    // that is not a usable reply — fall back to the deterministic next check / clarifying question so
    // the turn still progresses instead of stalling on an empty acknowledgement.
    {
      const bare = String(reply || '').trim();
      const isBareAck = /^(?:\s*(?:ok(?:ay)?|sure|thanks(?: for (?:that|letting me know))?|thank you|understood|i understand|got it|no (?:worries|problem))[\s.,!]*)+$/i.test(bare);
      // RE-DESCRIBE LOOP: COMPOSE asks the customer to describe the symptom/problem again even though
      // we ALREADY hold a grounded conclusion — a loop the customer can't usefully answer (they
      // already told us). Only degenerate when a conclusion exists (otherwise it's a legitimate
      // first-turn clarify).
      const conclusion = (intent && intent.primaryFinding && String(intent.primaryFinding).trim().length >= 12)
        ? String(intent.primaryFinding).trim() : null;
      const reDescribeLoop = Boolean(conclusion)
        && /\b(?:describe|tell me|what(?:'s| is| are)?|could you (?:describe|tell|let me know))\b[^.?!]{0,50}\b(?:current )?(?:symptom|problem|issue|fault|observation|what (?:it|the appliance) is doing)\b/i.test(bare);
      if (isBareAck || reDescribeLoop) {
        // Deliver a real conclusion + next step instead of filler: the understand pass's plain-English
        // most-likely cause (primaryFinding) plus the deterministic safe next check. Makes the floor
        // reliable regardless of COMPOSE non-determinism on sparse / cannot-answer turns.
        const nextStep = (intent && customerFacingNextCheck(intent)) || null;
        let replacement;
        if (reDescribeLoop) {
          replacement = nextStep ? `${conclusion} ${nextStep}` : conclusion;
        } else {
          replacement = nextStep || conclusion || (intent && intent.clarifyingQuestion) || null;
          if (replacement) replacement = `${bare.replace(/[\s.,!]*$/, '')}. ${replacement}`;
        }
        if (replacement && replacement.trim()) {
          metric.degenerateAckReplaced = true;
          reply = replacement.trim();
        }
      }
    }
    const _recoveredForSafety = (intent.facts || []).some((f) => f && f.name === 'functionRecovered' && f.value === 'TRUE')
      || latestTurnReportsRecovery(progress);
    reply = ensureOwnerCheckSafety(reply, intent, { safetyStop, diagnoseStop, normalBehaviour, recovered: _recoveredForSafety }); // safety: deterministic owner-check precaution
    reply = ensureAdviceThenIdentityAsk(reply, intent);           // state-driven append (_nextAction)
    if (intent && intent._exclusiveClarify && intent.clarifyingQuestion) {
      reply = intent.clarifyingQuestion;                          // vague opener: guarantee a single question
    }
    // Identity-scope integrity guard — ONLY for ordinary diagnostic prose. A reply that delivers an
    // active deterministic STOP-USE (hard safetyStop OR any diagnose-stop boundary, incl. the
    // microwave-arcing 'arcing' lead) must never be rewritten or replaced here: the family-scope
    // heuristic misreads legitimate microwave-cavity vocabulary as a foreign-family instruction and
    // was silently clamping a sparking-microwave stop-use down to a bland "which appliance?" ask.
    if (!replyDeliversSafetyStop(safetyStop, diagnoseStop)) {
      const conversationIdentity = resolveConversationIdentity({
        messages, queryText,
        jevFamily: applianceKey(intent.applianceType),
        jevFamilyProvenance: intent._applianceFamilyProvenance,
        jevFuel: intent._fuel,
      });
      const clamped = constrainReplyToIdentity(reply, conversationIdentity, {   // family/fuel integrity
        allowedFamily: allowedFamilyForReply(queryText, conversationIdentity),
      });
      if (clamped.changed) {
        metric.identityReplyClamped = clamped.reason;
        reply = clamped.text;
      }
    }
    // Recovery is Jev's typed signal (functionRecovered fact), with the existing explicit-restore
    // helper as a backstop; a recovered or normal-behaviour turn is terminal (no appended probe).
    const recovered = (intent.facts || []).some((f) => f && f.name === 'functionRecovered' && f.value === 'TRUE')
      || latestTurnReportsRecovery(progress);
    reply = ensureNonTerminalProgression(reply, intent, { safetyStop, diagnoseStop, normalBehaviour, recovered }); // structured next-action / HV boundary
    if (!reply || !reply.trim()) {
      metric.emptyReply = true;
      reply = (intent && (customerFacingNextCheck(intent) || intent.clarifyingQuestion))
        || "Sorry, I didn't quite catch that — could you tell me the appliance make and model, and what it's doing?";
    }
    reply = avoidVerbatimRepeat(reply, progress, { safetyStop, diagnoseStop, normalBehaviour, recovered, metric, intent }); // never send the same message twice (grounded-fault only)
    out.write(JSON.stringify({ type: 'delta', text: reply }) + '\n');
    metric.partsFound = shownParts.length;
    if (modelResolved && parts.length > 0 && shownParts.length === 0) {
      metric.modelHasNoFaultPart = `${intent.model}:${fault ? fault.faultId : '?'}`;
    }

    let candidateComponents = presentableCandidateComponents(
      intent.candidateComponents,
      fault ? getLikelyComponents(applianceKey(intent.applianceType) || fault.resolvedAppliance, fault.faultId) : [],
      presentation,
    );
    // Re-apply the evidence adjustment AFTER any curated backfill (purchase grain only), so a
    // ruled-out / already-replaced suspect the backfill re-introduced cannot leak back.
    candidateComponents = adjustDifferential(candidateComponents, evidenceAdj);
    // Surface what we understood so the UI can show progress "pills"
    // (make / appliance / model / fault / code) in the staged flow.
    // Deterministic presentation concepts from the established diagnosis (see deriveMediaConcepts):
    // additive, media-only, never affects diagnosis/parts/safety.
    const establishedFamilyForMedia = applianceKey(intent.applianceType)
      || (hasOperationalFamily(resolveConversationIdentity({ messages, queryText, jevFamily: applianceKey(intent.applianceType), jevFamilyProvenance: intent._applianceFamilyProvenance, jevFuel: intent._fuel }))
        ? resolveConversationIdentity({ messages, queryText, jevFamily: applianceKey(intent.applianceType), jevFamilyProvenance: intent._applianceFamilyProvenance, jevFuel: intent._fuel }).family
        : null);
    const actionMediaFaultId = currentActionMediaFaultId(intent, establishedFamilyForMedia);
    const currentActionTurn = intent._nextAction === 'check'
      || intent._nextAction === 'identification'
      || intent._nextAction === 'discriminator'
      || intent._nextAction === 'advice_then_identity';
    const mediaFaultId = actionMediaFaultId
      || (currentActionTurn ? null : (fault && fault.faultId));
    const mediaConcepts = deriveMediaConcepts(
      applianceKey(intent.applianceType) || establishedFamilyForMedia,
      fault || (mediaFaultId ? { faultId: mediaFaultId } : null),
      intent.facts,
    );
    const understood = {
      make: intent.make || null,
      appliance: intent.applianceType || null,
      model: intent.model || null,
      fault: (presentation && presentation.committedComponent)
        ? ((fault && ((fault.node && fault.node.label) || intent.fault)) || null)
        : null,
      faultId: (presentation && presentation.committedComponent && fault && fault.faultId) || null,
      primaryFinding: (fault && intent.primaryFinding) || null,
      grounded: Boolean(fault) || diagnoseStopIsProfessionalHv(diagnoseStop) || Boolean(
        mediaFaultId && intent.nextCheckCustomerSafe && intent._nextAction === 'check'
      ) || Boolean(
        intent._applianceUnconfirmed && intent.onTopic !== false
        && (intent.primaryFinding || intent.nextBestCheck)
      ),
      confidence: intent.confidence,
      facts: intent.facts || [],
      evidence: (fault && computeEvidence(fault.node, intent.facts)) || null,
      mediaConcepts,
      code: intent.errorCode || null,
      // RAG-era reasoning outputs (additive; existing consumers ignore what they don't use)
      alternatives: intent.alternatives || [],
      candidateComponents,
      componentMention: presentation.mention,
      purchaseAppropriate: presentation.purchaseAppropriate,
      primaryFindingKind: intent.primaryFindingKind || 'unknown',
      customerTheories: intent.customerTheories || [],
      nextBestCheck: intent.nextBestCheck || null,
      clarifyingQuestion: intent.clarifyingQuestion || null,
      // provenance comes from the server (what we injected), not the LLM's output
      knowledgeIds: retrieval.docs.map((d) => d.knowledgeId),
      // Story 1: additive typed customer-evidence contract (observability only; NOT
      // consumed by the engine this story). Surfaced so the deployed boundary can be
      // verified against natural-language journeys. Does not affect reply/parts.
      customerEvidence: (metric.jev && metric.jev.customerEvidence) || null,
    };
    // On a tripwire trip we've replaced the reply with a refusal — also present a
    // neutral understood shape and no parts, so nothing about the discarded
    // diagnosis reaches the client.
    const finalUnderstood = metric.tripwireBlocked
      ? { onTopic: false, grounded: false, fault: null }
      : understood;
    const finalParts = metric.tripwireBlocked ? [] : shownParts.slice(0, 10);

    // -------- CUSTOMER SAFETY INFORMATION (additive, deterministic) --------
    // Pre-written, evidence-backed safety text attached to a GROUNDED node by node identity
    // (applianceFamily:faultId) — NOT generated, rewritten or summarised by the LLM, and NOT
    // derived from retrieval similarity. Separate from `reply`, `parts`, `understood` and the
    // deterministic safety-stop. Suppressed when: no grounded fault; the output tripwire fired; or
    // the deterministic SAFETY-STOP is active (that reply already leads with the authoritative
    // action, so showing the info block too would duplicate it). This does NOT alter routing,
    // diagnosis, confidence, parts or the safety-stop.
    let safetyInformation = (!safetyStop && diagnoseStop !== 'hv-service' && diagnoseStop !== 'hv-boundary' && !metric.tripwireBlocked && fault)
      ? getSafetyInformation(applianceKey(intent.applianceType), fault.faultId)
      : null;
    // GAS EMERGENCY CARD CORROBORATION. An EMERGENCY_ACTION gas card is conditional "if you smell
    // gas…" advice; downstream it is promoted to a forced gas-escape stop. Only allow it when a real
    // escape cue is present — otherwise an ordinary gas-appliance fault (hob won't light) is wrongly
    // escalated to an evacuation emergency. The gas-safe professional boundary still comes from the
    // fuel-gas COMPOSE framing and the record's own text.
    if (safetyInformation && safetyInformation.classification === 'EMERGENCY_ACTION' && !gasEscapeCorroborated) {
      metric.gasEmergencyCardSuppressed = true;
      safetyInformation = null;
    }
    if (diagnoseStop === 'hv-service' || diagnoseStop === 'hv-boundary') {
      safetyInformation = {
        classification: 'PROFESSIONAL_ONLY',
        reasons: ['Microwave high-voltage components remain dangerous even with the appliance unplugged.'],
        requiredAction: 'Do not test, discharge, or dismantle high-voltage microwave parts. A qualified microwave engineer is required.',
        text: 'Do not test, discharge, or dismantle high-voltage microwave parts. A qualified microwave engineer is required.',
      };
    }
    if (safetyInformation && sameSafetyAlreadyShown(messages, safetyInformation)) {
      metric.safetyInformationDeduped = safetyInformation.classification;
      safetyInformation = null;
    }
    if (safetyInformation) metric.safetyInformationShown = safetyInformation.classification;

    // -------- CUSTOMER INSTRUCTIONAL MEDIA (additive, deterministic) --------
    // Media SUPPORTS a customer-safe check on the grounded node. Attached by node identity only —
    // never generated by the LLM, never from retrieval, never in embeddings. Suppressed on a
    // deterministic SAFETY-STOP or a tripwire (no DIY media when we've told the customer to stop).
    // Applicability is honestly gated (MODEL_SPECIFIC withheld until the model is resolved). Only
    // customer-safe presentation fields reach the client (no provenance/relatedCheck/asset paths
    // beyond the public URL).
    let media = [];
    if (!safetyStop && diagnoseStop !== 'hv-service' && diagnoseStop !== 'hv-boundary' && !metric.tripwireBlocked
        && (fault || mediaFaultId)) {
      // Media is keyed by family:fault. Only attach it when the customer has established
      // the appliance family — never from an inferred/retrieved family guess.
      const establishedFamily = establishedFamilyForMedia;
      if (establishedFamily && mediaFaultId) {
        await ensureMediaOverlay();
        const raw = getMediaInformation(establishedFamily, mediaFaultId,
          { make: intent.make, model: intent.model, errorCode: intent.errorCode,
            concepts: mediaConcepts, components: candidateComponents,
            alreadyShown: previouslyShownMedia(messages),
            nextAction: intent._nextAction || null,
            repeatRequested: customerAskedToRepeatMedia(progress.latestUserText) });
        media = raw.map((m) => {
          // Customer-safe projection ONLY — provenance/relatedCheck/applicability never leave the
          // server. `intent` (SAFE_CHECK | ABOUT) IS projected so the UI can frame ABOUT media as
          // identification/explanation (never as a DIY repair instruction). `id` is echoed on
          // later turns so we do not re-show the same asset after the conversation has moved on.
          const intentTag = (m.intent === 'ABOUT') ? 'ABOUT' : 'SAFE_CHECK';
          if (m.type === 'VIDEO') {
            return { id: m.id || null, type: 'VIDEO', title: m.title, caption: m.caption || m.description || '',
              provider: m.provider || null, videoId: m.videoId || null, embedUrl: m.embedUrl || null,
              sourcePageUrl: m.sourcePageUrl || null, attribution: m.attribution || null, intent: intentTag };
          }
          return { id: m.id || null, type: m.type, title: m.title, description: m.description, url: m.asset, alt: m.alt, intent: intentTag };
        });
      }
    }
    if (media.length) metric.mediaShown = media.length;

    // Passive diagnostic evidence envelope. This is consumed only by the authenticated
    // orchestrator/BFF path and is never included in the public WhichPart response.
    // It contains bounded structured outputs, never prompts, credentials, image bytes, or hidden reasoning.
    const diagnosticTrace = {
      schemaVersion: '1.0',
      capturedAt: new Date().toISOString(),
      stages: [
        {
          id: 'jev-understand', label: 'Jev UNDERSTAND', evidence: metric.jev ? 'OBSERVED' : 'NOT_CAPTURED',
          summary: metric.jev ? 'Structured meaning decisions captured' : 'Jev evidence was not captured',
          detail: metric.jev || null,
        },
        {
          id: 'rag-retrieval', label: 'Knowledge retrieval', evidence: 'OBSERVED',
          summary: retrieval.docs.length ? (retrieval.docs.length + ' knowledge records retrieved') : 'No knowledge records retrieved',
          detail: metric.retrieval || { mode: retrieval.mode || 'unknown' },
        },
        {
          id: 'diagnostic-state', label: 'Diagnostic state', evidence: 'OBSERVED',
          summary: finalUnderstood.grounded ? 'A diagnostic area was grounded' : 'No diagnostic area grounded',
          detail: {
            grounded: Boolean(finalUnderstood.grounded), applianceFamily: finalUnderstood.applianceType || null,
            make: finalUnderstood.make || null, model: finalUnderstood.model || null,
            faultId: finalUnderstood.faultId || null, fault: finalUnderstood.fault || null,
            confidence: finalUnderstood.confidence == null ? null : finalUnderstood.confidence,
            facts: Array.isArray(finalUnderstood.facts) ? finalUnderstood.facts : [],
            checksReported: Array.isArray(finalUnderstood.checksReported) ? finalUnderstood.checksReported : [],
            nextAction: intent._nextAction || null, cannotAnswer: Boolean(intent._cannotAnswer),
            partReadiness: intent._partReadiness || null,
          },
        },
        {
          id: 'safety', label: 'Safety', evidence: 'OBSERVED',
          summary: safetyStop ? ('Stop-use enforcement: ' + safetyStop) : (safetyInformation ? 'Safety information attached' : 'No stop-use enforcement'),
          detail: { stopReason: safetyStop || null, diagnoseStop: diagnoseStop || null,
            classification: safetyInformation && safetyInformation.classification || null,
            isolationAdvisory: Boolean(isolationAdvisory), unsafeIntent: Boolean(unsafeIntent) },
        },
        {
          id: 'parts-media', label: 'Parts and media', evidence: 'OBSERVED',
          summary: finalParts.length + ' parts and ' + media.length + ' media items selected',
          detail: {
            parts: finalParts.map((p) => ({ partNo: p.partNo || null, title: p.title || null })).slice(0, 10),
            media: media.map((m) => ({ id: m.id || null, type: m.type || null, title: m.title || null })).slice(0, 10),
            componentMention: metric.tripwireBlocked ? COMPONENT_MENTION.NONE : presentation.mention,
            purchaseAppropriate: metric.tripwireBlocked ? false : presentation.purchaseAppropriate,
          },
        },
        {
          id: 'compose', label: 'COMPOSE', evidence: 'OBSERVED',
          summary: metric.tripwireBlocked ? 'COMPOSE output blocked by output tripwire' : 'Customer response composed',
          detail: { latencyMs: metric.composeMs == null ? null : metric.composeMs,
            outputChars: String(reply || '').length, tripwireBlocked: Boolean(metric.tripwireBlocked) },
        },
      ],
    };

    // safetyStop: the DETERMINISTIC gas/shock stop decision ('gas'|'shock'|null), exposed so the
    // orchestrator can gate its safety-stop on the authoritative signal instead of guessing from
    // reply wording. Additive; does not change diagnosis/routing/parts.
    out.write(JSON.stringify({
      type: 'done',
      traceId: requestId,
      parts: finalParts,
      understood: finalUnderstood,
      safetyInformation: safetyInformation || null,
      safetyStop: safetyStop || null,
      isolationAdvisory: isolationAdvisory || false,
      unsafeIntent: unsafeIntent || false,
      normalBehaviour: (normalBehaviour && !metric.tripwireBlocked) || false,
      media,
      componentMention: metric.tripwireBlocked ? COMPONENT_MENTION.NONE : presentation.mention,
      purchaseAppropriate: metric.tripwireBlocked ? false : presentation.purchaseAppropriate,
      remoteActionClass: metric.tripwireBlocked ? null : remoteAction,
      diagnosticTrace,
    }) + '\n');
    out.end();

    metric.totalMs = Date.now() - started;
    metric.ok = true;
    log(metric);
    // Redacted learning trace (full transcript + reply + outcome) -> S3 for
    // later mining. The response has already streamed+ended, so this adds no
    // user-facing latency (only a little billed Lambda time).
    await logLearningTrace(messages, reply, queryText, intent, fault, retrieval, metric, shownParts.length);
  } catch (err) {
    metric.ok = false;
    metric.error = err && err.name === 'JevError'
      ? `jev:${err.category}`
      : (err && err.message ? err.message : 'error');
    if (err && err.name === 'JevError') {
      metric.jev = { invoked: true, ok: false, category: err.category, status: err.status || null };
    }
    metric.totalMs = Date.now() - started;
    log(metric);

    const msg = (err && (err.category === 'TIMEOUT' || (err.message && err.message.includes('timeout'))))
      ? 'The AI took too long. Try a smaller image or describe your appliance in text.'
      : 'AI service unavailable. Please try again in a moment.';
    if (out) {
      // Already streaming — can't change status, so emit an error event.
      try {
        out.write(JSON.stringify({ type: 'error', error: msg }) + '\n');
        out.end();
      } catch {
        /* stream already closed */
      }
    } else {
      failJson(503, { error: msg });
    }
  }
});

// ---------------------------------------------------------------------------
// CANONICAL RUNTIME (canonical-runtime.js): message-only mc/1 → cs/1 merge → journey routing → diagnostics → policy
// → part gate → NextAction in understand mode; COMPOSE wording of a controlled NextAction in diagnose mode. The
// Lambda only injects its I/O and legacy-COMPOSE helpers here. Gates: BFF control allow-list + per-journey kill switch.
// ---------------------------------------------------------------------------
const canonicalRuntimeMod = require('./canonical-runtime.js');

let _canonicalRuntime = null;

function canonicalRuntime() {
  if (!_canonicalRuntime) {
    _canonicalRuntime = canonicalRuntimeMod.createCanonicalRuntime({
      errorCodes: () => CATALOGUE.errorCodes,
      getPartsForModel: (model) => getPartsForModel(model),
      matchesComponent,
      conversationProgress,
      loadAdminInference,
      COMPONENT_MENTION,
      compose: {
        getProvider: async () => (await getProviders()).compose,
        lm: { temperature: LM_TEMPERATURE, repeatPenalty: LM_REPEAT_PENALTY, timeoutMs: LM_TIMEOUT_MS },
        filters: [stripOutOfScopeElectricalTests, stripOwnerInternalElectricalInspection, stripInstructionEcho],
        constrainReplacementLanguage, outputTripwire,
      },
      media: {
        ensureMediaOverlay, getEffectiveMediaJoin, previouslyShownMedia,
        // eslint-disable-next-line global-require
        selectMedia: (...a) => require('./retrieval').selectMedia(...a),
      },
    });
  }
  return _canonicalRuntime;
}

// Test-only exports (additive; does not affect the Lambda handler/streaming path).
// Lets deterministic unit tests exercise pure helpers without invoking the LLM.
// canonical: the runtime as wired with this Lambda's catalogue / matcher / COMPOSE helpers (tests drive the real wiring)
const canonicalTestApi = {
  canonicalJourneys: (t, block, opts) => canonicalRuntime().runJourneys(t, block, opts),
  canonicalJourney: (t, block, key, opts) => canonicalRuntime().runJourney(t, block, key, opts),
  canonicalControls: (c) => canonicalRuntime().controls(c),
  canonicalRespond: (args, opts) => canonicalRuntime().respond(args, opts),
  canonicalModelParts: (model, lookupFn) => canonicalRuntime().modelParts(model, lookupFn),
  canonicalFinishUnderstand: (started) => canonicalRuntime().finishUnderstand(started),
  CANONICAL_JOURNEY_PACKS: canonicalRuntimeMod.PACKS,
  canonicalTransportMerge: canonicalRuntimeMod.transportMerge,
  canonicalTransportMetric: canonicalRuntimeMod.transportMetric,
  isCanonicalTransportBlock: canonicalRuntimeMod.isTransportBlock,
  isCanonicalTransportResult: canonicalRuntimeMod.isTransportResult,
};

exports._internal = { ...canonicalTestApi, resolveFault, uniqueBrandCodeHit, applianceKey, brandFamily, authoritativeCodeComponents, guessErrorCode, upgradeErrorCodeFromText, customerErrorCodes, retainCustomerErrorCode, looksLikeCode, normaliseIntent, collectFaultIds, adjustDifferential, collectEvidence, neutralizeConditionLimitedFacts, phraseRefersToComponent, deriveMediaConcepts, computeEvidence, factConflict, chooseCompatibleFault, mergeDerivedFacts, dropUnstatedComponentHum, invertedStemsAgainst, collectPositiveObservations, constrainByPositiveObservations, localisingQuestionAfterObservation, askedDiscriminatorFact, discriminatorAlreadyAsked, allAskedDiscriminatorFacts, scoreNodeEvidence, commitFromEvidence, evidenceDecisive, materialAmbiguity, deriveDeclinedFacts, customerDeclinedDiscriminator, progressAfterDeclinedDiscriminator, detectSafetyStop, classifySafetyStop, detectUnsafeIntent, isMicrowaveHvProcedureRequest, isStatusIndicationFlash, isElectricalFlashEvent, proposedPhysicalAccess, extractDisplayedStatusToken, displayedIndicationNeedsIdentity, applyDisplayedIndicationIdentity, EVIDENCE_KIND, stripOutOfScopeElectricalTests, stripOwnerInternalElectricalInspection, ownerCheckPrecaution, ensureOwnerCheckSafety, preferSingleVagueClarify, buildComposeSystem, buildComposeContext, formatTrustedCustomerEvidence, matchNormalBehaviour, hasFailureSymptom, isBenignSmellOnly, isResidualWaterOnly, isWetPlasticsOnly, expressesConcern, getNormalBehaviourRecords, INTENT_SCHEMA, getProviders, _setProvidersForTest, resolveProviders, InferenceError, classifyCustomerClaim, refineCustomerTheories, hazardProvenance, assertedHazardIsObserved, applianceSafetyFamily, classifyRemoteActionClass, remoteActionBoundary, computePresentationGrain, applyPartReadinessProgression, remainingActionBlocksPurchase, presentableCandidateComponents, namedOrCatalogueComponents, calibrateLikelyFitProse, constrainReplacementLanguage, replacementLanguageOverclaimsFit, catalogueFitIsModelConfirmed, effectiveFindingKind, evidenceJustifiesComponent, FINDING_KINDS, COMPONENT_MENTION, REMOTE_ACTION, matchesComponent, rankPartsByFault, preferCheckFirstPart, partsStillInPlay, selectLinkedParts, conversationProgress, correctFollowUpIntent, followUpUnderstandNote, applyFollowUpNextAction, latestTurnSaysChecksNotDone, checksNotDoneTurnCount, previouslyShownMedia, previouslyShownSafety, sameSafetyAlreadyShown, pendingDiagnosticQuestion, latestTurnLooksLikeIdentity, completedAccessibleCheck, identificationIsNextAction, preferAdviceThenIdentity, preferAccessibleFirstAction, isAcousticOnlyQuery, isUnlocatedFunctionOutcome, hasFunctionFailureSymptom, preferFamilyBeforeSpecificDiagnosis, currentActionMediaFaultId, captureQuestionedCause, demoteUnconfirmedTheoryFinding, resolveEstablishedFamily, lockApplianceType, allowedFamilyForReply, identityNamedFamilies, constrainReplyToIdentity, customerOnlyText, looksLikeModelToken, discriminatorQuestionText, retrievedFamilyNote, lmSafeMessages, USER_INTENTS, customerProposedDrainPathPart, demotePrematurePartRequest, drainFunctionEstablished, accessibleImpellerInspected, latestTurnEstablishesDrainEvent, latestTurnReportsRecovery, ensureAdviceThenIdentityAsk, stripInstructionEcho, composeFollowUpNote, preferArchitectureDependentAdvice, preferNotRepeatIntervention, preferRelatedFunctionDiscriminator, preferConditionDiscriminator, microwaveHeatingHvBoundaryApplies, diagnoseStopIsProfessionalHv, replyDeliversSafetyStop, stripMicrowaveHvDiy, stripModelAskOnProfessionalBoundary, ensureNonTerminalProgression, replyIsAcknowledgementOnly, productIdentitySufficient, customerFacingNextCheck, setIdentificationNext, modelAlreadyKnown, renderDeterministicTerminal, naturalList, ownerSafeAdvice, avoidVerbatimRepeat, ensureCommittedConclusion };
