/**
 * Conversation progression: the deterministic next-action rules applied after UNDERSTAND and evidence (identity
 * asks, follow-ups, discriminators, terminal rendering, accessible-first actions, repeat avoidance).
 */
const { canonicalComponent } = require('../retrieval');
const {
  FAMILY_STATE, resolveConversationIdentity, lockIdentityOnIntent, hasOperationalFamily,
  familySpecificCatalogueTermsIn,
} = require('../identity.js');
const {
  asciiFold, progressCustomerText, conversationEvidenceText, makeAlreadyKnown, productIdentitySufficient,
  customerFacingNextCheck, messageText, latestUserMessage, messageHasImage, customerProposedDrainPathPart,
} = require('./conversation.js');
const { CATALOGUE, applianceKey, matchesComponent } = require('./catalogue.js');
const {
  computeEvidence, askedDiscriminatorFact, discriminatorAlreadyAsked, DISCRIMINATOR_QUESTION, factKnownOnIntent,
  askedObservationDiscriminatorAnswered,
} = require('./evidence.js');

/** Mutually exclusive observation dimensions. Latest customer assertion owns the group. */
const EXCLUSIVE_OBSERVATION_GROUPS = [
  ['inductionHob', 'gasHob', 'ceramicHob'],
  ['singleZoneAffected', 'allZonesAffected'],
  ['worksWithKnownGoodPan', 'failsKnownGoodPan'],
  ['heatPresent', 'noHeat'],
  ['noHeat', 'heatsAtAll'],
  ['noPower', 'cutsOut', 'weakSuction'],
  ['leakAtDoor', 'leakAtDrawer', 'leakUnderneath', 'leakAtRear'],
  ['fridgeOnlyWarm', 'bothCompartmentsWarm'],
  ['fanAudible', 'fanNotAudible'],
  ['runsNormally', 'doorStartProblem'],
];

/**
 * Identification is a next-action. The customer-facing ask lives on
 * clarifyingQuestion. Orchestration stays in _nextAction, not nextBestCheck.
 */
function setIdentificationNext(intent, question) {
  if (!intent) return intent;
  intent.needMoreInfo = true;
  intent.nextCheckCustomerSafe = false;
  intent.furtherGenericCheckJustified = false;
  intent._nextAction = 'identification';
  intent.nextBestCheck = null;
  if (question && !intent.clarifyingQuestion) intent.clarifyingQuestion = question;
  return intent;
}

/**
 * Useful generic advice is not a completed journey. If remaining diagnosis needs
 * identity, the customer-facing reply must still ask for it.
 */
function ensureAdviceThenIdentityAsk(reply, intent) {
  if (!intent || intent._nextAction !== 'advice_then_identity') return reply;
  if (!reply || typeof reply !== 'string') return reply;
  if (/\b(make and model|model number|rating plate)\b/i.test(reply)) return reply;
  const ask = intent.clarifyingQuestion || 'What is the make and model number (on the rating plate)?';
  return `${reply.replace(/\s+$/, '')} ${ask}`;
}

/**
 * COMPOSE must not recite internal instruction labels or acknowledge prompt
 * constraints. Drop those sentences; keep any remaining customer-facing advice.
 */
function stripInstructionEcho(reply) {
  const raw = String(reply || '').trim();
  if (!raw) return reply;
  const parts = raw.split(/(?<=[.!?])\s+/);
  const kept = parts.filter((s) => {
    if (!s || !s.trim()) return false;
    if (/\bI understand the (?:specific )?constraints\b/i.test(s)) return false;
    if (/\bI am ready to (?:assist|help|proceed)\b/i.test(s)) return false;
    if (/\bPlease (?:provide|describe) (?:the )?(?:customer(?:'s)?|your|the) ?(?:initial )?(?:query|issue|problem|fault)\b/i.test(s)) return false;
    if (/\bplease describe (?:the |your )?(?:issue|problem|fault|appliance)\b/i.test(s)) return false;
    // Third-person SCAFFOLDING LEAK: the assistant speaks TO the customer, never ABOUT "the
    // customer". A sentence that refers to the customer in the third person, or asks for "the
    // customer's message/evidence/input" so it can "proceed with the next step", is leaked COMPOSE
    // scaffolding — never customer-facing. (The FF-04 "Please provide the customer's latest message
    // or evidence so I can proceed with the next step." loop.)
    if (/\bthe customer'?s?\b/i.test(s)) return false;
    if (/\b(?:provide|share|send|give|supply)\b[^.?!]*\b(?:latest )?(?:message|evidence|input|response|reply|turn)\b[^.?!]*\bso (?:I|we) can (?:proceed|continue|respond|help)\b/i.test(s)) return false;
    if (/\bso (?:I|we) can proceed with (?:the )?(?:next step|diagnosis|response)\b/i.test(s)) return false;
    if (/\bStage\s*\d+\b/i.test(s) && /\b(diagnos|constraint|instruction)\b/i.test(s)) return false;
    if (/\bnever mention these constraints\b/i.test(s)) return false;
    if (/\bFAMILY-COMPATIBLE ACTIONS\b/i.test(s)) return false;
    if (/\bREMOTE ACTION BOUNDARY\b/i.test(s)) return false;
    if (/\bCOMPONENT PRESENTATION\b/i.test(s)) return false;
    // Composer-imperative control ("Ask X before Y") is not a customer question.
    if (/^\s*Ask\b/i.test(s) && !/[?]\s*$/.test(s.trim())) return false;
    return true;
  });
  const out = kept.join(' ').replace(/\s+/g, ' ').trim();
  return out;
}

/** Identification ask once family is known: do not re-ask make when the customer already named it. */
function familyKnownIdentificationAsk(intent, extra) {
  const extraBit = extra ? ` ${extra}` : '';
  if (makeAlreadyKnown(intent)) {
    return {
      nextBestCheck: `Ask for the model number or a photo of the rating plate.${extraBit} Do not re-ask the make, and do not ask which appliance it is.`,
      clarifyingQuestion: 'What is the model number on the rating plate?',
    };
  }
  return {
    nextBestCheck: `Ask for the make and model, or a photo of the rating plate.${extraBit}`,
    clarifyingQuestion: 'What is the make and model number (on the rating plate)?',
  };
}

/**
 * Conversation identity as established family + source, for retrieval/COMPOSE locks.
 * WORKING identity is operational but is never customer-established.
 */
function resolveEstablishedFamily(opts) {
  const identity = resolveConversationIdentity(opts || {});
  return {
    family: identity.family || null,
    source: identity.familySource,
    correction: identity.familySource === 'correction',
    familyState: identity.familyState,
    familyEstablished: identity.familyEstablished,
    identity,
  };
}

/**
 * Intent may only carry a family that conversation identity already supports.
 * Retrieval documents cannot mint or override family.
 */
function lockApplianceType(intent, established, retrievalDocs) {
  if (!intent) return intent;
  const identity = established && established.identity && established.identity.familyState
    ? established.identity
    : {
        family: established && established.family,
        familySource: (established && established.source) || 'unresolved',
        familyState: established && established.family
          ? ((established.source === 'customer' || established.source === 'correction'
              || established.source === 'established')
            ? FAMILY_STATE.ESTABLISHED
            : FAMILY_STATE.WORKING)
          : FAMILY_STATE.UNKNOWN,
        familyEstablished: Boolean(established && established.family
          && (established.source === 'customer' || established.source === 'correction'
            || established.source === 'established')),
        fuel: established && established.fuel,
        fuelState: established && established.fuelState,
        fuelConflict: Boolean(established && established.fuelConflict),
      };
  return lockIdentityOnIntent(intent, identity, retrievalDocs);
}

// The family that may be ECHOED to the customer as established identity: Jev's typed family once the
// identity resolver has it as WORKING/ESTABLISHED. No customer-prose family recognition here.
function allowedFamilyForReply(_customerText, identity) {
  return hasOperationalFamily(identity) ? identity.family : null;
}

/**
 * Split a client-carried transcript into established vs latest evidence.
 * Used so UNDERSTAND/COMPOSE can treat a follow-up as progression, not a fresh diagnosis.
 * No keyword/fault special cases — structure of the conversation only.
 */
function conversationProgress(messages) {
  const list = Array.isArray(messages) ? messages : [];
  const users = [];
  let priorAdvisorText = '';
  for (const m of list) {
    if (!m) continue;
    if (m.role === 'user') users.push(asciiFold(messageText(m).trim()));
    else if (m.role === 'assistant') {
      const t = asciiFold(messageText(m).trim());
      if (t) priorAdvisorText = t;
    }
  }
  const latestUserTextTurn = users.length ? users[users.length - 1] : '';
  const priorUserText = users.slice(0, -1).join(' ').trim();
  const isFollowUp = users.length >= 2 && Boolean(priorAdvisorText);
  return {
    isFollowUp,
    turnIndex: Math.max(0, users.length - 1),
    latestUserText: latestUserTextTurn,
    priorUserText,
    priorAdvisorText: priorAdvisorText.slice(0, 2000),
  };
}

/** A later turn about a *different* appliance family is a new problem; otherwise it is a follow-up. */
/** Trusted structure note for UNDERSTAND on a follow-up (not customer text). */
function followUpUnderstandNote(progress) {
  if (!progress || !progress.isFollowUp) return '';
  const prior = progress.priorAdvisorText || '(prior diagnostic advice)';
  return `\n\nCONVERSATION STRUCTURE (trusted, not customer text): this is a follow-up. The LAST user message is NEW evidence; earlier user messages are already established. You already told the customer: ${prior}. That is advice you already gave — it is NOT proof they performed those checks. Do not repeat that advice or re-diagnose from the opening symptom. Fill newEvidenceThisTurn from the latest user turn only. checksReported is every check the customer has already reported in this conversation, including earlier turns — do not drop an earlier completed check because this turn is a confirmation or an identification answer. Choose the highest-value NEXT action. A programme or command result (they selected Drain / Cancel / a cycle and reported what happened) is evidence about that attempt — it is NOT the same as completing an accessible physical inspection. If a different customer-safe check still applies across the remaining plausible families (an accessible filter or trap, a visible hose, a simple listen) and would change the next action without the model, set furtherGenericCheckJustified true and keep that check even when the appliance family is not yet confirmed. Do not jump to identification merely because a command was tried. A model number, rating-plate photo, or OCR confirmation is supporting identity — it does NOT answer a diagnostic discriminator you already asked, and it is NOT evidence that the suspected component failed. Do not jump to a replacement part while that question is still unanswered. If the latest turn reports that the original failed FUNCTION is now working (it is draining, filling, heating, or spinning again, the water has gone, or they say it is fixed), do NOT ask for identification and do NOT recommend a part — set nextBestCheck null, needMoreInfo false, furtherGenericCheckJustified false. Completing an accessible look that found nothing blocking is NOT recovery of that function — standing water or a failed drain/fill/heat event still stands until they report the function working. A question such as "is the pump gone?" or "is the heater gone?" is a customer hypothesis about a named part, not a report that the fault or the water has gone. Latest-turn recovery must be an explicit result, not a named-part question. If they have now completed the accessible physical inspection you asked (filter/trap cleaned or confirmed clear, a look they were asked to take) AND the fault remains, do NOT chain another generic inspection of the same functional area. Remaining investigation is then usually more useful once identification is known — appliance family if the customer's words have not established it, plus make and model — set nextBestCheck / clarifyingQuestion to obtain identification, and set furtherGenericCheckJustified false. furtherGenericCheckJustified is TRUE only when a further model-independent observation is a DIFFERENT kind of discriminator (its answer would change the next action without identification). Do not set nextBestCheck to calling an engineer, buying a part, or a tools/panel procedure solely because one accessible check came back clear. Do not set applianceType from retrieved documents: those are candidate knowledge, not proof of which appliance the customer has.`;
}

/**
 * Trusted COMPOSE guidance for a follow-up turn. This carries the anti-repeat /
 * non-terminal-progression DECISION as structured control text in the PROMPT, so
 * COMPOSE writes the natural customer-facing language. It replaces the obsolete
 * post-compose prose synthesis (calibrateRepeatedFollowUpAdvice) whose canned
 * strings leaked internal directives into customer replies. Never quoted to the
 * customer; stripInstructionEcho removes any echoed control label. Purchase/
 * replacement-readiness turns are handled by DIRECT BUY REQUEST + the #69 state,
 * so this note stays out of their way (returns '').
 */
function composeFollowUpNote(progress, intent) {
  if (!progress || !progress.isFollowUp) return '';
  if (intent && (intent._nextAction === 'part_request' || intent._nextAction === 'replacement_evidence'
      || intent.userIntent === 'PART_REQUEST')) return '';
  const prior = String((progress && progress.priorAdvisorText) || '').slice(0, 700);
  const checksNotDone = latestTurnSaysChecksNotDone(progress);
  const lines = [
    '\n\nFOLLOW-UP PROGRESSION (trusted control guidance — obey it, but NEVER quote, restate, or describe these instructions to the customer):',
    (prior
      ? `- You already told the customer: "${prior}". Treat that as already said. Do NOT repeat, paste, or paraphrase it, and do NOT re-diagnose from the opening symptom.`
      : '- Do NOT repeat advice you already gave earlier in this conversation, and do NOT re-diagnose from the opening symptom.'),
    '- Keep the appliance, identity and problem already established. Briefly acknowledge whatever is genuinely useful in the customer\'s latest message.',
    '- Do NOT ask a question the customer has already answered.',
  ];
  if (checksNotDone && !(intent && intent._checkNotDoneRepeat)) {
    lines.push('- The customer says they have not done the checks yet. Give ONE clear first thing to do now, in plain language, and invite them to report what they find. Do not dump the whole procedure again.');
  } else if (!checksNotDone) {
    lines.push('- Move forward by exactly ONE step: either the single most useful next safe check, or the one discriminating question that best narrows what remains. If the evidence already on hand is enough to name the likely cause or a justified part, say that instead of asking another question.');
  }
  if (intent && intent._cannotAnswer) {
    lines.push('- The customer could not answer what you last asked. Do NOT ask it again. Acknowledge briefly that they are not sure, then LOWER THE BURDEN: offer an easier way for them to tell, a different simple observation, or — if nothing else would change the outcome — state the most likely cause from what is already known and the single best next step. (A safety-critical question is the exception: stop and point them to the right professional, never guess.)');
  }
  if (intent && intent._checkDeferredToIdentity) {
    lines.push('- The customer still has not done the check you suggested. Do NOT repeat or re-describe that check. Acknowledge in one short clause that they have not managed it yet, then ask for the make and model (or a rating-plate photo) so you can help further. Keep it to that single identity question.');
  }
  if (intent && intent._checkNotDoneRepeat) {
    const deferred = String(intent._deferredCheck || '').trim();
    lines.push(`- You have ALREADY recommended this check more than once and they still have not done it. Do NOT paste that instruction again. LEAD with the most likely cause given what is known, then give them a real choice in one short sentence each: they can still do the accessible check when they are ready${deferred ? ` (the check was: ${deferred})` : ''}, OR, if they would rather not handle it, a qualified engineer can inspect and confirm it. Move the conversation forward — do not ask them again to go and do the check now.`);
  }
  lines.push('- If the customer is vague or unsure, do not stall, loop, or lecture: point them to the single most useful thing to look at next and ask for one specific observation.');
  return lines.join('\n');
}

/**
 * UNDERSTAND sometimes labels a short evidence update as NEW_PROBLEM because the
 * original symptom is still in the transcript. Reclassify from conversation STRUCTURE.
 */
function correctFollowUpIntent(intent, progress) {
  if (!intent || !progress || !progress.isFollowUp) return intent;
  // Trust Jev's typed userIntent on a follow-up — Jev is given the conversation structure
  // (followUpUnderstandNote), so a NEW_PROBLEM it returns on a follow-up is a genuine new problem or
  // appliance switch, not the opening symptom bleeding through. Only a bare OTHER on a follow-up is
  // safely a continued evidence update. No customer-prose appliance-switch detection here.
  if (intent.userIntent === 'OTHER') {
    intent.userIntent = 'EVIDENCE_UPDATE';
  }
  return intent;
}

/**
 * On a same-thread follow-up with unknown identity, do not let a tools/panel
 * nextBestCheck reach COMPOSE. Identification is still in-scope. Leave a
 * customer-safe observation alone so this is not a universal "ask for model" rule.
 */
function completedAccessibleCheck(intent) {
  if (!intent) return false;
  // Confirming a discriminator ("yes, that compartment is still cold") is not a completed check.
  if (intent.userIntent === 'CONFIRMATION') return false;
  if (Array.isArray(intent.checksReported) && intent.checksReported.length) return true;
  if (Array.isArray(intent.alreadyReplaced) && intent.alreadyReplaced.length) return true;
  // Short follow-up results are often EVIDENCE_UPDATE even when checksReported is omitted.
  return intent.userIntent === 'EVIDENCE_UPDATE';
}

function isIdentityQuestion(text) {
  const t = String(text || '').toLowerCase();
  return /model number|rating plate|make and model|which appliance|is that correct|read the model|what model|what make|from the photo/.test(t);
}

function pendingDiagnosticQuestion(progress) {
  const prior = String((progress && progress.priorAdvisorText) || '').trim();
  if (!prior) return null;
  const questions = prior.match(/[^.!?\n]*\?/g) || [];
  const diagnostic = questions
    .map((q) => q.replace(/^[\s\-•*]+/, '').trim())
    .filter((q) => q.length > 12 && !isIdentityQuestion(q));
  if (diagnostic.length) return diagnostic[diagnostic.length - 1];
  // Advisors often pose the next discriminator as an instruction, not a '?'.
  const chunks = prior.split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter(Boolean);
  const instructional = chunks.filter((s) => {
    if (isIdentityQuestion(s)) return false;
    const t = s.toLowerCase();
    if (t.length < 28 || t.length > 420) return false;
    if (/\b(make and model|rating plate|model number)\b/.test(t)) return false;
    return /\b(next (?:check|thing|step)|note (?:exactly )?(?:which|when|whether)|tell me (?:when|whether|if|which)|which stage|when (?:in|it|the)|whether (?:it|the)|see if (?:it|the)|or (?:only |once |after |when ))\b/.test(t);
  });
  return instructional.length ? instructional[instructional.length - 1] : null;
}

/**
 * True when the latest customer turn is primarily confirming identity (photo / OCR / short
 * model yes). Diagnostic confirmations and evidence updates are not identity turns — even
 * when a model is already known from earlier in the thread.
 */
function latestTurnLooksLikeIdentity(progress, intent, messages) {
  const latest = String((progress && progress.latestUserText) || '').replace(/\s+/g, ' ').trim();
  const latestLower = latest.toLowerCase();
  if (messageHasImage(latestUserMessage(messages))) {
    if (latestLower.length > 120 && !isIdentityQuestion(latestLower)) return false;
    return true;
  }
  if (latestLower.length > 120) return false;
  const model = String((intent && intent.model) || '').trim();
  const priorAskedIdentity = isIdentityQuestion((progress && progress.priorAdvisorText) || '');
  const identityYes = /^(yes|yeah|yep|yup|correct|that's right|thats right|it is|confirmed)\b/i.test(latestLower);
  if (model) {
    const modelLower = model.toLowerCase();
    if (latestLower === modelLower) return true;
    if (latestLower.includes(modelLower)
        && (identityYes || /is correct|that's right|thats right/.test(latestLower))) {
      return true;
    }
  }
  if (priorAskedIdentity && identityYes) {
    const rest = latestLower.replace(/^(yes|yeah|yep|yup|correct|that's right|thats right|it is|confirmed)[,.\s]*/i, '');
    if (rest.length < 8) return true;
    if (model && rest.includes(model.toLowerCase()) && rest.length < 40) return true;
  }
  return false;
}

function applyFollowUpNextAction(intent, progress, extras) {
  if (!intent || !progress || !progress.isFollowUp) return intent;
  const safetyStop = extras && extras.safetyStop;
  const normalBehaviour = extras && extras.normalBehaviour;
  if (safetyStop || normalBehaviour || intent._materialAmbiguity) return intent;
  if (intent._observationAmbiguity) {
    const asked = askedDiscriminatorFact(progress);
    if (asked && askedObservationDiscriminatorAnswered(intent, asked)) {
      intent._observationAmbiguity = null;
      intent._discriminatorJustAnswered = asked;
      if (discriminatorAlreadyAsked(progress, intent.clarifyingQuestion)) intent.clarifyingQuestion = null;
    } else {
      return intent;
    }
  }
  // Never re-ask a discriminator we already put to the customer. A short answer like
  // "nothing happens" is progress on that question, not a reason to ask it again.
  if (intent.furtherGenericCheckJustified !== true
      && (discriminatorAlreadyAsked(progress, intent.clarifyingQuestion)
          || discriminatorAlreadyAsked(progress, intent.nextBestCheck))) {
    intent.nextCheckCustomerSafe = false;
    intent.nextBestCheck = null;
    intent.clarifyingQuestion = null;
  }
  // Identification is supporting information. A model/OCR/photo turn must not erase an
  // unanswered diagnostic discriminator — restore it and keep diagnosis open.
  const pending = pendingDiagnosticQuestion(progress);
  const messages = extras && extras.messages;
  const identityTurn = latestTurnLooksLikeIdentity(progress, intent, messages);
  const imageTurn = messageHasImage(latestUserMessage(messages));
  if (imageTurn) {
    intent._unconfirmedIdentity = true;
    if (extras) extras.unconfirmedIdentity = true;
  }
  if (pending && identityTurn) {
    intent.clarifyingQuestion = pending;
    intent.nextBestCheck = pending;
    intent.nextCheckCustomerSafe = true;
    intent.furtherGenericCheckJustified = true;
    intent.needMoreInfo = true;
    intent._nextAction = 'discriminator';
    intent._pendingDiscriminator = pending;
    if (extras) extras.pendingDiscriminator = pending;
    return intent;
  }
  if (imageTurn) {
    // A rating-plate photo is unconfirmed identity, not evidence the suspected component failed.
    intent.needMoreInfo = true;
    if (!intent._nextAction) intent._nextAction = 'identification';
    return intent;
  }
  // Useful product identity can proceed specifically. Family unknown is not by
  // itself identity insufficient. A known MAKE alone is not enough.
  if (productIdentitySufficient(intent)) return intent;
  const applianceKnown = Boolean(applianceKey(intent.applianceType));
  const completed = completedAccessibleCheck(intent);
  // A further customer-safe observation may remain when UNDERSTAND says it is a different
  // discriminator. That check can still be valid across remaining families — do not require
  // the family to be named first. Identification is next when the further check is not
  // justified or is not customer-safe (remaining work is then family/model-specific).
  const keepGeneric = intent.nextCheckCustomerSafe === true
    && Boolean(intent.nextBestCheck)
    && (!completed || intent.furtherGenericCheckJustified === true);
  if (keepGeneric) return intent;
  // UNDERSTAND already closed the thread (fault resolved, or no further action).
  // Do not invent an identification ask after the customer has recovered.
  if (intent.needMoreInfo === false && intent.furtherGenericCheckJustified !== true) return intent;
  // Model declared unavailable + family known: nothing left to identify. Do NOT fall through to a
  // model/identity ask again — that is the loop after the customer said they can't find the model.
  // Keep progressing with whatever model-independent action already stands.
  if (intent.modelUnavailable === true && applianceKey(intent.applianceType)) return intent;
  const question = !applianceKnown
    ? (intent.make
      ? `Which kind of ${intent.make} appliance is this, and what is the model number on the rating plate?`
      : 'Which appliance is this, and what is the model number on the rating plate?')
    : familyKnownIdentificationAsk(intent).clarifyingQuestion;
  return setIdentificationNext(intent, question);
}

const APPLIANCE_IDENTITY_QUESTION = 'Which appliance is this, and what is the make and model on the rating plate?';

function identificationAskContent(opts) {
  const exclusive = !opts || opts.exclusive !== false;
  const extras = 'Do not add examples, types, or parentheses. Do not name a family or a part.';
  if (exclusive) {
    return `Ask exactly this question and nothing else: "${APPLIANCE_IDENTITY_QUESTION}" ${extras}`;
  }
  return (
    `Include this identity question in the same reply: "${APPLIANCE_IDENTITY_QUESTION}" ${extras} `
    + 'Do not make that identity question the entire reply.'
  );
}

function identificationIsNextAction(intent, progress) {
  if (!intent || productIdentitySufficient(intent)) return false;
  // Customer cannot provide the model (Jev-typed, latched by the orchestrator). Once the appliance
  // family is operationally known there is nothing left to identify, so identification is NOT the
  // next action — the engine must progress on the best model-independent route instead of re-asking
  // for a model the customer already said they can't give (the model re-ask loop).
  if (intent.modelUnavailable === true && applianceKey(intent.applianceType)) return false;
  if (intent._nextAction === 'advice_then_identity') return false;
  if (intent._nextAction === 'advice' && intent.needMoreInfo === false) return false;
  if (intent.needMoreInfo === false && intent.furtherGenericCheckJustified !== true) return false;
  if (intent._nextAction === 'identification') return true;
  return Boolean(progress && progress.isFollowUp && intent.nextCheckCustomerSafe !== true);
}

/**
 * Useful generic advice is not a completed journey.
 * When ADVICE_ONLY help can be given without identity, give it. If remaining diagnosis
 * depends on appliance/model architecture, request identity in the SAME reply.
 * Do not collapse to identity-only. Do not ask identity after genuine recovery,
 * when a physical check is already next, or when a discriminator is still pending.
 */
function preferAdviceThenIdentity(intent, progress, extras) {
  if (!intent) return intent;
  const fault = extras && extras.fault;
  if (extras && (extras.safetyStop || extras.normalBehaviour)) return intent;
  if (!fault || !fault.node || fault.node.outcome !== 'ADVICE_ONLY') return intent;
  if (fault.node.furtherDiagnosisNeedsIdentity !== true) return intent;
  if (productIdentitySufficient(intent)) return intent;
  if (latestTurnReportsRecovery(progress)) return intent;
  if (intent._nextAction === 'check' || intent._nextAction === 'discriminator'
      || intent._nextAction === 'safety_stop') {
    return intent;
  }
  if (intent._materialAmbiguity || intent._observationAmbiguity
      || intent._areaDiscriminator || intent._pendingDiscriminator) {
    return intent;
  }
  const blob = `${progressCustomerText(progress)} ${(extras && extras.queryText) || ''}`.trim();
  const familyKnown = Boolean(applianceKey(intent.applianceType));
  const ask = familyKnown
    ? familyKnownIdentificationAsk(intent)
    : {
        nextBestCheck: 'Ask which kind of appliance this is, and the make and model on the rating plate (a photo is fine), so remaining diagnosis can be architecture-specific.',
        clarifyingQuestion: APPLIANCE_IDENTITY_QUESTION,
      };
  intent.needMoreInfo = true;
  intent.nextCheckCustomerSafe = false;
  intent.furtherGenericCheckJustified = false;
  intent._nextAction = 'advice_then_identity';
  intent.nextBestCheck = null;
  intent.clarifyingQuestion = ask.clarifyingQuestion;
  return intent;
}

/**
 * Heat-at-load drying complaints must not stay on a generic wash-quality advice node
 * (or an unresolved fault) when the family has an architecture-dependent drying node
 * the facts support. Conversation evidence counts: a later identity or check-result
 * turn must not drop the drying complaint the customer already stated.
 */
function preferArchitectureDependentAdvice(intent, fault, queryText, progress) {
  if (!intent) return fault;
  if (fault && fault.via === 'errorCode') return fault;
  if (fault && fault.node && fault.node.furtherDiagnosisNeedsIdentity === true) return fault;
  const facts = Array.isArray(intent.facts) ? intent.facts.slice() : [];
  const evidenceText = conversationEvidenceText(progress, queryText, intent);
  // Jev-authoritative (Story 2): heatPresent comes from the facts, not a prose re-parse.
  const heatPresent = facts.some((f) => f && f.name === 'heatPresent' && String(f.value).toUpperCase() === 'TRUE');
  if (!heatPresent) return fault;
  const t = String(evidenceText || '').replace(/[\u2019\u02bc']/g, "'").toLowerCase();
  if (!/\b(wet|damp|soaking|moist|not dry|don'?t dry|doesn'?t dry|not drying|aren'?t drying)\b/i.test(t)) return fault;
  const fam = applianceKey(intent.applianceType) || (fault && fault.resolvedAppliance);
  const nodes = (fam && CATALOGUE.faults[fam]) || {};
  for (const [id, node] of Object.entries(nodes)) {
    if (!node || node.outcome !== 'ADVICE_ONLY' || node.furtherDiagnosisNeedsIdentity !== true) continue;
    const ev = computeEvidence(node, facts);
    if (!ev || (ev.against && ev.against.length) || !(ev.supports && ev.supports.length)) continue;
    return { faultId: id, node, via: 'evidence-commit', resolvedAppliance: fam };
  }
  return fault;
}

function clearPendingDiscriminators(intent) {
  if (!intent) return intent;
  intent.clarifyingQuestion = null;
  intent._materialAmbiguity = null;
  intent._observationAmbiguity = null;
  intent._areaDiscriminator = null;
  return intent;
}

/**
 * Prefer a customer-safe accessible check over identity or a part when the customer's own
 * evidence already justifies one. Family-independent: standing water after an emptying
 * attempt → filter/trap; dryer no-heat / heat-then-stops → airflow/lint first.
 */
/** A mechanical noise (scrape/grind/rattle/rumble/bang/knock/thud/clunk) without a stronger hazard or
 * a named functional failure. A banging/knocking noise is as much an unlocalised acoustic report as a
 * rattle — generalising the existing recogniser's vocabulary, not a scenario-specific rule. */
function isAcousticOnlyQuery(text) {
  const t = String(text || '').replace(/[\u2019\u02bc]/g, "'").toLowerCase();
  if (!/\b(scrap\w*|grind\w*|rattl\w*|rumbl\w*|bang\w*|knock\w*|thud\w*|thump\w*|clunk\w*|clang\w*)\b/.test(t)) return false;
  if (/\b(burn\w*|smoke|trips?|tripping|shock|gas|flame|spark\w*|leak\w*|error|code)\b/.test(t)) return false;
  if (/\b[efhc]\s*\d{1,3}\b/.test(t)) return false;
  return true;
}

// Family -> the authored NOISE / vibration knowledge record. An unlocalised mechanical noise should
// surface that record's advice (transit bolts, level, balance, rotate the drum by hand, bearings),
// not a function-fault's parts (e.g. a drain pump) that Jev may have guessed for an un-localised
// noise. Knowledge mapping, not a scenario oracle.
const NOISE_RECORD_BY_FAMILY = {
  'washing-machine': 'excessive-vibration',
  'washer-dryer': 'excessive-vibration',
  'tumble-dryer': 'noisy',
  'dishwasher': 'noisy',
};

// A cross-family FUNCTION failure (drain / fill / spin / heat / cool / suction / pulsing). These
// are the Jev typed symptomFamily values that describe a function that did not happen, and their
// 1:1 fault phrases (SYMPTOM_TO_FAULT in jev-understand.js). We match on the TYPED decision, never
// on customer prose.
const _FUNCTION_FAILURE_SYMPTOMS = new Set([
  'not_draining', 'not_filling', 'not_spinning', 'not_heating',
  'not_cooling', 'no_suction', 'pulsing',
]);

const _FUNCTION_FAILURE_FAULTS = new Set([
  'not draining', 'not filling', 'not spinning', 'not heating',
  'not cooling', 'no suction', 'pulsing',
]);

/**
 * Did Jev TYPE the customer's problem as a cross-family function failure? Read from the typed
 * decision (symptomFamily, mirrored 1:1 onto intent.fault) — never from the customer's prose.
 * Accepts either the revived intent or the raw forwarded understand object.
 */
function hasFunctionFailureSymptom(intent) {
  if (!intent || typeof intent !== 'object') return false;
  const sf = intent._jev && intent._jev.decisions && intent._jev.decisions.symptomFamily;
  if (sf && _FUNCTION_FAILURE_SYMPTOMS.has(sf)) return true;
  return _FUNCTION_FAILURE_FAULTS.has(String(intent.fault || '').toLowerCase());
}

/**
 * "A cross-family FUNCTION has failed but the customer has NOT established an appliance family."
 * This is a statement about what the customer MEANT, so it is read from Jev's TYPED decisions —
 * NOT re-derived from the customer's words. Jev owns the symptom (hasFunctionFailureSymptom) and the
 * family (intent.applianceType, left null when Jev's applianceFamily is unknown/uncertain). The old
 * prose timeline regexes (fills/heats/drains-then-stops, commanded drain-on-cancel,
 * replaced-element-still-cold) were a SECOND interpretation of the customer's language; they are
 * deleted. Used to withhold family-specific parts and to stop COMPOSE assuming a family.
 */
function isUnlocatedFunctionOutcome(intent) {
  if (!intent || typeof intent !== 'object') return false;
  if (intent.applianceType) return false;                 // family established -> located
  return hasFunctionFailureSymptom(intent);
}

/**
 * Family-specific diagnosis is not the next action while family is unknown, unless a
 * family-independent customer-safe check is already justified (standing water → trap).
 * Authoritative error codes keep their resolution.
 */
function preferFamilyBeforeSpecificDiagnosis(intent, queryText, progress, extras) {
  if (!intent) return intent;
  const fault = extras && extras.fault;
  if (fault && fault.via === 'errorCode') return intent;
  if (intent._nextAction === 'safety_stop' || intent._nextAction === 'discriminator') return intent;
  if (intent._nextAction === 'advice_then_identity') return intent;
  const blob = `${progressCustomerText(progress)} ${queryText || ''}`;
  if (intent.applianceType && !intent._applianceUnconfirmed) {
    return intent;
  }
  if (productIdentitySufficient(intent)) {
    return intent;
  }
  const checkText = `${intent.nextBestCheck || ''} ${intent.clarifyingQuestion || ''}`;
  const checkIsFamilySpecific = familySpecificCatalogueTermsIn(checkText).length > 0;
  const genericSafeCheck = intent._nextAction === 'check'
    && intent.nextCheckCustomerSafe === true
    && !checkIsFamilySpecific;
  const unlocated = isUnlocatedFunctionOutcome(intent);
  const familySpecific = Boolean(intent.faultId)
    || (Array.isArray(intent.candidateComponents) && intent.candidateComponents.length > 0)
    || intent.primaryFindingKind === 'component'
    || checkIsFamilySpecific;
  if (genericSafeCheck) {
    intent.faultId = null;
    intent.fault = null;
    intent.candidateComponents = [];
    if (intent.primaryFindingKind === 'component') intent.primaryFindingKind = 'unknown';
    if (extras) extras.fault = null;
    return intent;
  }
  if (!unlocated && !familySpecific) return intent;
  intent.faultId = null;
  intent.fault = null;
  intent.candidateComponents = [];
  intent.primaryFinding = null;
  intent.primaryFindingKind = 'unknown';
  setIdentificationNext(intent, 'What kind of appliance is it?');
  if (extras) extras.fault = null;
  return intent;
}

/**
 * Condition-limited evidence (works when hot/cold/cancelled/manual) is not a
 * confirmed healthy path and is not enough to name a failed component.
 */
function preferConditionDiscriminator(intent) {
  if (!intent) return intent;
  const limited = Array.isArray(intent.conditionLimited) ? intent.conditionLimited.filter(Boolean) : [];
  if (!limited.length) return intent;
  if (intent._nextAction === 'safety_stop' || intent._nextAction === 'identification') return intent;
  if (intent.primaryFindingKind === 'component') intent.primaryFindingKind = 'condition';
  if (Array.isArray(intent.candidateComponents) && intent.candidateComponents.length) {
    intent.candidateComponents = [];
  }
  if (!intent._nextAction || intent._nextAction === 'advice') intent._nextAction = 'discriminator';
  return intent;
}

function preferNotRepeatIntervention(intent) {
  if (!intent) return intent;
  const irs = Array.isArray(intent._interventionResults) ? intent._interventionResults : [];
  // Jev supplies the outcome (temporary/attempted), not a prose action token, so match on
  // outcome. Without an action token the per-action loop below no-ops and the generic
  // "temporary recovery" redirect (the !touched branch) fires.
  const temp = irs.filter((x) => x && x.outcome === 'temporary');
  if (!temp.length) return intent;
  if (intent.primaryFindingKind === 'component') intent.primaryFindingKind = 'condition';
  if (Array.isArray(intent.candidateComponents) && intent.candidateComponents.length) {
    intent.candidateComponents = [];
  }
  const next = String(intent.nextBestCheck || '').toLowerCase();
  const finding = String(intent.primaryFinding || '').toLowerCase();
  let touched = false;
  for (const ir of temp) {
    const token = String(ir.action || '').toLowerCase().split(/[^a-z]+/).find((w) => w.length > 3) || '';
    if (!token) continue;
    if (next.includes(token) || finding.includes(token) || !intent.nextBestCheck) {
      touched = true;
      intent.nextBestCheck = 'That already produced only temporary recovery, so repeating it is not the next diagnostic step. Treat the recurrence as evidence that the underlying cause remains, and choose a different discriminator or identification.';
      intent.nextCheckCustomerSafe = true;
      if (intent._nextAction === 'check') intent._nextAction = 'discriminator';
      if (/defrost|de-?ice|ice|frost/.test(token) && /defrost|de-?ice/.test(finding)) {
        intent.primaryFinding = 'Manual defrost gave only temporary recovery, so the icing cause is still present.';
        intent.primaryFindingKind = 'condition';
      }
    }
  }
  if (!touched) {
    intent.nextBestCheck = 'That already produced only temporary recovery, so repeating it is not the next diagnostic step. Treat the recurrence as evidence that the underlying cause remains, and choose a different discriminator or identification.';
    intent.nextCheckCustomerSafe = true;
    if (intent._nextAction === 'check' || intent._nextAction === 'advice') intent._nextAction = 'discriminator';
  }
  return intent;
}

/**
 * A failed function with no evidence about sibling functions is not yet a component.
 * Ask what else still works before naming a part.
 */
function preferRelatedFunctionDiscriminator(intent, queryText, progress) {
  if (!intent) return intent;
  if (intent._nextAction === 'safety_stop' || intent._nextAction === 'identification') return intent;
  const facts = Array.isArray(intent.facts) ? intent.facts : [];
  const blob = `${progressCustomerText(progress)} ${queryText || ''}`;
  if (microwaveHeatingHvBoundaryApplies(intent, blob)) return intent;
  const failedHeat = facts.some((f) => f && f.name === 'noHeat' && f.value === 'TRUE')
    && !facts.some((f) => f && (f.name === 'heatPresent' || f.name === 'heatsAtAll') && f.value === 'TRUE');
  const otherHeatDescribed = /\b(grill|hob|top heat|bottom heat|conventional|fan oven|other (?:mode|function|programme|program|heat(?:ing)?))\b/i.test(blob)
    && /\b(works?|working|fine|ok|okay|heats?|heating|hot|cold|doesn'?t|won'?t|no heat|does not heat)\b/i.test(blob);
  if (failedHeat && !otherHeatDescribed) {
    if (intent.primaryFindingKind === 'component') intent.primaryFindingKind = 'subsystem';
    intent.candidateComponents = [];
    intent.nextBestCheck = 'Does any other heating function still work, or is every heat function cold?';
    intent.clarifyingQuestion = intent.nextBestCheck;
    intent.nextCheckCustomerSafe = true;
    intent.needMoreInfo = true;
    intent._nextAction = 'discriminator';
  }
  return intent;
}

function diagnoseStopIsProfessionalHv(diagnoseStop) {
  return diagnoseStop === 'hv-service' || diagnoseStop === 'hv-boundary';
}

// VAGUE OPENER single-primary-ask. When the customer has not established WHAT is actually wrong —
// no grounded fault, no candidate component, no symptom, no concrete next action — set a single
// canonical open clarification and mark it exclusive, so COMPOSE asks exactly that one thing rather
// than bundling a menu of possibilities (+ the model) into one turn. Structured, family-general; no
// scenario-specific phrasing. Does nothing once any real symptom/fault/next-action exists.
function preferSingleVagueClarify(intent, fault, extras) {
  if (!intent) return intent;
  const { safetyStop, normalBehaviour, diagnoseStop } = extras || {};
  if (safetyStop || normalBehaviour || diagnoseStop) return intent;
  if (intent.needMoreInfo !== true) return intent;
  // AUTHORITATIVE vague signal: Jev typed the symptom family as 'uncertain' ("not working",
  // "playing up"). This is the typed trigger — NOT the reportedSymptoms list, which the orchestrator
  // seeds with the raw vague opener text (so it is non-empty even when nothing is actually
  // established). Only fire when nothing concrete is grounded.
  const symptomFamily = intent._jev && intent._jev.decisions && intent._jev.decisions.symptomFamily;
  if (symptomFamily !== 'uncertain') return intent;
  const noSymptom = !fault && !intent.errorCode
    && !(Array.isArray(intent.candidateComponents) && intent.candidateComponents.length)
    && !intent.primaryFinding;
  if (!noSymptom) return intent;
  const concrete = intent._materialAmbiguity || intent._observationAmbiguity || intent._areaDiscriminator
    || intent._pendingDiscriminator
    || ['check', 'discriminator', 'safety_stop', 'advice', 'advice_then_identity', 'part_request', 'replacement_evidence']
      .includes(intent._nextAction);
  if (concrete) return intent;
  const fam = applianceKey(intent.applianceType);
  const famWord = fam ? fam.replace(/-/g, ' ') : 'appliance';
  intent.clarifyingQuestion = `What is the main thing the ${famWord} is doing wrong?`;
  intent.nextBestCheck = null;
  intent.candidateComponents = [];
  intent._exclusiveClarify = true;
  intent._nextAction = 'clarify';
  return intent;
}

// Does the composed reply DELIVER an active deterministic STOP-USE safety instruction? True for a
// hard safetyStop (gas / shock / burning / supply-trip) AND for ANY diagnose-stop boundary — the
// microwave-arcing STOP_USE_DIAGNOSE lead ('arcing') as well as the professional-HV boundaries
// ('hv-service' / 'hv-boundary'). Every truthy diagnoseStop is, by construction (see where it is
// derived from safetyClassRaw.tier === 'STOP_USE_DIAGNOSE' / the HV halt), a stop-use/professional
// boundary. A reply that carries one of these is the mandated safety action and MUST always reach
// the customer: the downstream identity-scope output guard may rewrite ordinary diagnostic prose,
// but it must NEVER replace a stop-use reply with a generic "which appliance / tell me more"
// clarification (that silently drops the stop-use). The arcing lead legitimately uses microwave
// cavity vocabulary (metal/foil, dishes with metallic trim, grill rack, mica waveguide cover) that
// the family-scope heuristic can misread as a "foreign family" instruction — so arcing stop-use
// replies were being clamped away. Hazard-stop replies are already family-correct by construction
// (classifySafetyStop only fires on the stated appliance) and the dedicated microwave/electrical
// safety strippers still run before this, so exempting them is both safe and necessary.
function replyDeliversSafetyStop(safetyStop, diagnoseStop) {
  return Boolean(safetyStop) || Boolean(diagnoseStop);
}

function microwaveHeatingHvBoundaryApplies(intent, queryText) {
  const family = applianceKey(intent && intent.applianceType);
  if (family !== 'microwave') return false;
  // Jev-authoritative (Story 2): the microwave runs-but-no-heat observation comes from Jev's
  // typed evidence (runsNormally / doorStartProblem / noHeat), not a prose re-parse here.
  const facts = (intent && Array.isArray(intent.facts)) ? intent.facts : [];
  if (facts.some((f) => f && f.name === 'doorStartProblem' && f.value === 'TRUE')) return false;
  const runs = facts.some((f) => f && f.name === 'runsNormally' && f.value === 'TRUE');
  const noHeat = facts.some((f) => f && f.name === 'noHeat' && f.value === 'TRUE');
  return runs && noHeat;
}

function replyIsAcknowledgementOnly(reply) {
  const t = String(reply || '').trim();
  if (!t) return true;
  if (/\?/.test(t)) return false;
  if (t.length > 220) return false;
  if (!/^(thanks|thank you|ok|okay|got it|noted|understood|cheers)\b/i.test(t)) return false;
  return !/\b(next|check|look|try|could you|can you|what|which|does it|is the|please)\b/i.test(t);
}

function stripModelAskOnProfessionalBoundary(reply) {
  const src = String(reply || '');
  if (!src.trim()) return src;
  const cleaned = src
    .replace(/[^.!?\n]*\b(?:what(?:'?s| is) (?:the )?(?:exact )?(?:make and )?model|model number|rating[- ]plate)\b[^.!?\n]*[.!?]?/gi, ' ')
    .replace(/[^.!?\n]*\b(?:could you|can you|please) .{0,48}\b(?:model(?: number)?|rating[- ]plate)\b[^.!?\n]*[.!?]?/gi, ' ')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/[ \t]*\n[ \t]*/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return cleaned || src;
}

function replyHasUsefulNextAction(text) {
  const t = String(text || '').trim();
  if (!t) return false;
  if (/\?/.test(t)) return true;
  return /\b(?:check|look at|look for|inspect|try|unplug|stop using|call|contact|ask|tell me|listen|open the|isolate|switch off|leave (?:the )?(?:property|house)|ventilate)\b/i.test(t);
}

// Natural-language join: ["a","b","c"] -> "a, b or c".
function naturalList(items, conj) {
  const xs = (items || []).map((s) => String(s || '').trim()).filter(Boolean);
  if (!xs.length) return '';
  if (xs.length === 1) return xs[0];
  return `${xs.slice(0, -1).join(', ')} ${conj || 'or'} ${xs[xs.length - 1]}`;
}

// A customer-safe advice line from the record's adviceBeforeReplacement: owner-doable observations
// only (no replace/fit/engineer/tools/panel-off language), lightly cleaned to a sentence.
function ownerSafeAdvice(record, max) {
  if (!record || !Array.isArray(record.adviceBeforeReplacement)) return [];
  const unsafe = /(replace|renew|fit a|fitting|refit|engineer|technician|multimeter|continuity|wiring|terminal|dismantle|strip down|remove the (?:back|panel|cover|casing)|take the (?:back|panel|cover) off|screws?)/i;
  return record.adviceBeforeReplacement
    .map((s) => String(s || '').trim())
    .filter((s) => s && !unsafe.test(s))
    .slice(0, max || 2);
}

// DETERMINISTIC TERMINAL DIAGNOSIS. On a cannot-answer / model-unavailable turn where a fault AREA
// is grounded, the customer-facing RESULT (the most-likely cause, the ranked model-independent
// differential, the safe thing to check, and the honest "need the model to match the exact part"
// close) is DECIDED by the typed understand state + the authored knowledge record — not improvised
// by the COMPOSE LLM, which on these sparse turns intermittently degenerates to "Understood." or
// loops. Returns a complete reply string, or null when there isn't enough typed state to render one
// (then the normal pipeline/fallbacks stand). No prose parsing; reads typed fields + the record.
function renderDeterministicTerminal(intent, record, extras) {
  if (!intent) return null;
  if (extras && (extras.safetyStop || extras.diagnoseStop || extras.normalBehaviour || extras.recovered)) return null;
  const cannotAnswer = Boolean(intent._cannotAnswer) || intent.modelUnavailable === true;
  if (!cannotAnswer) return null;
  if (intent.model) return null;                     // model known -> commit path, not this terminal
  const finding = String(intent.primaryFinding || '').trim();
  if (!record && finding.length < 12) return null;   // nothing typed to render from

  const ruledOut = new Set([
    ...((intent.provenGood || []).map((s) => canonicalComponent(s))),
    ...((intent.alreadyReplaced || []).map((s) => canonicalComponent(s))),
  ].filter(Boolean));
  // Corded/cordless split: when the power type is established, drop the irrelevant tagged causes and
  // strip the "(corded)"/"(cordless)" tag from the display (e.g. a cordless vacuum should not be told
  // to check the mains cable / plug fuse).
  const cordless = extras && extras.cordless;
  const comps = ((record && record.likelyComponents) || [])
    .map((s) => String(s || '').trim())
    .filter((s) => s && !ruledOut.has(canonicalComponent(s)))
    .filter((s) => {
      if (cordless === true) return !/\(corded\)/i.test(s);
      if (cordless === false) return !/\(cordless\)/i.test(s);
      return true;
    })
    .map((s) => s.replace(/\s*\((?:corded|cordless)\)/ig, '').trim())
    .slice(0, 3);
  const advice = ownerSafeAdvice(record, 2);

  const parts = [];
  // 1) the conclusion — only when the understand pass gave a clean plain-English finding. Otherwise
  // lead straight with the differential (the awkward "a problem in the <label>" phrasing is avoided).
  if (finding.length >= 12) {
    parts.push(finding.replace(/\s+$/, '').replace(/\.?$/, '.'));
  }
  // 2) the ranked model-independent differential (safe checks first, else the usual culprits). Advice
  // items are complete clauses, so present them as their own sentences (never "and Confirm ...").
  if (advice.length) {
    const steps = advice.map((a) => {
      const t = a.replace(/\s+$/, '').replace(/\.?$/, '');
      return t.charAt(0).toUpperCase() + t.slice(1) + '.';
    }).join(' ');
    parts.push(`Without the model I can't match the exact part yet, but a couple of safe things to check first: ${steps}`);
  } else if (comps.length) {
    parts.push(`Without the model I can't match the exact part yet \u2014 the usual causes are ${naturalList(comps, 'or')}.`);
  } else {
    parts.push("Without the model number I can't match the exact part for your machine yet.");
  }
  // 3) honest, non-looping close (does not re-ask the model; invites it when found)
  parts.push("When you can read the model off the rating plate, come back and I'll confirm the exact replacement part.");
  const out = parts.join(' ').replace(/\s{2,}/g, ' ').trim();
  return out.length >= 40 ? out : null;
}

// COMMITTED-CONCLUSION BACKSTOP (decision out of COMPOSE). When the deterministic understand pass has
// COMMITTED to a component (primaryFindingKind 'component' with a candidate) and the model is known —
// the point at which the leading suspect should be stated — but the composed reply does NOT name that
// component (COMPOSE hedged, looped, or was stripped to a bare engineer referral), prepend the typed
// conclusion so the committed decision reaches the customer. Augments (keeps COMPOSE's prose + any
// part links); never fires on a safety stop, recovery or reassurance. The provenGood sibling note is
// the typed "a working sibling is a separate part" fact (e.g. the grill element vs the fan-oven
// element), so a working sub-function is not mistaken for clearing the suspect.
function ensureCommittedConclusion(reply, intent, extras) {
  if (!reply || !intent) return reply;
  if (extras && (extras.safetyStop || extras.diagnoseStop || extras.normalBehaviour || extras.recovered)) return reply;
  if (!intent.model || intent.primaryFindingKind !== 'component') return reply;
  const ruledOut = new Set([
    ...((intent.provenGood || []).map((s) => canonicalComponent(s))),
    ...((intent.alreadyReplaced || []).map((s) => canonicalComponent(s))),
  ].filter(Boolean));
  const comps = (intent.candidateComponents || [])
    .map((s) => String(s || '').trim())
    .filter((s) => s && !ruledOut.has(canonicalComponent(s)));
  if (!comps.length) return reply;
  const top = comps[0];
  if (matchesComponent(reply, top)) return reply;      // COMPOSE already named it — leave it
  const pg = (intent.provenGood || []).map((s) => String(s || '').trim()).filter(Boolean);
  let note = (intent.primaryFinding && String(intent.primaryFinding).trim().length >= 12)
    ? String(intent.primaryFinding).trim().replace(/\.?$/, '.')
    : `Based on what you've described, the most likely cause is the ${top}.`;
  if (pg.length && !matchesComponent(note, pg[0])) {
    note += ` The ${pg[0]} is a separate part, so it still working doesn't rule this out.`;
  }
  if (extras && extras.metric) extras.metric.committedConclusionAdded = canonicalComponent(top);
  let tail = String(reply).trim();
  if (/^[a-z]/.test(tail)) tail = tail.charAt(0).toUpperCase() + tail.slice(1); // avoid ". so this is"
  return `${note} ${tail}`;
}

// NO VERBATIM REPEAT. Never send the customer the same message twice. COMPOSE is instructed not to
// repeat prior advice, but being an LLM it sometimes emits a near-identical reply to two consecutive
// cannot-answer / deflection turns — which the benchmark judge (correctly) flags as "repeats the
// same unanswerable question". When this turn's reply is near-identical to the immediately-prior
// assistant turn, replace it with a DISTINCT terminal close that acknowledges we've reached the
// limit without the model, states the forward step ONCE, and invites anything else — without
// re-stating the diagnosis (which is what caused the repeat). Deliberately does NOT fire on a
// safety stop / recovery / normal-behaviour turn (those own their wording and rarely recur verbatim).
function avoidVerbatimRepeat(reply, progress, extras) {
  if (!reply || !progress) return reply;
  if (extras && (extras.safetyStop || extras.diagnoseStop || extras.recovered || extras.normalBehaviour)) return reply;
  // Only emit the "nothing new without the model" close when a fault AREA is actually grounded and
  // the model is the blocker. On an UNGROUNDED clarify loop (a vague "playing up" / "it's just not
  // right"), the right move is to keep clarifying, NOT to give up and ask for the model — so leave
  // the reply for the clarify path rather than replacing it with a model-close.
  const intent = extras && extras.intent;
  const grounded = Boolean(intent && (intent.faultId || (intent.primaryFinding && String(intent.primaryFinding).trim().length >= 12)));
  if (!grounded) return reply;
  const prior = (progress.priorAdvisorText || '').trim();
  if (!prior) return reply;
  const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const a = norm(reply);
  const b = norm(prior);
  if (!a || !b || a.length < 40) return reply;
  // Near-identical = exact, or the prior message wholly contains this reply's body (the common case
  // once a deterministic safety-note prefix differs between turns), or vice-versa.
  const identical = a === b;
  const contained = (b.includes(a) || a.includes(b));
  if (!identical && !contained) return reply;
  if (extras && extras.metric) extras.metric.verbatimRepeatAvoided = true;
  return "I don't have anything new to add on the cause without the model number \u2014 the likely cause and the safe step are the ones I've already given. When you can read the model off the rating plate, come back and I'll match the exact replacement part. Is there anything else I can help with in the meantime?";
}

function ensureNonTerminalProgression(reply, intent, extras) {
  if (!intent) return reply;
  if (extras && (extras.safetyStop || extras.diagnoseStop === 'hv-service')) return reply;
  // Recovery / normal-behaviour turns are legitimately TERMINAL: the original problem is solved or
  // there is no fault. Appending a next-action here is the "keeps going after it's fixed" defect, so
  // let the closure reply stand. State-driven (Jev recovery/normalBehaviour), no prose parsing.
  if (extras && (extras.recovered || extras.normalBehaviour)) return reply;
  // Once part-readiness has progressed to a purchase/replacement recommendation
  // (applyPartReadinessProgression only sets these once a catalogue component is
  // named and purchase-ready), the turn answers that request — it is a legitimate
  // terminal turn, not a dead-end. Do not force-append a generic discriminator.
  // State-driven, mirrors applyPartReadinessProgression (no phrases/regex).
  if (intent._nextAction === 'part_request' || intent._nextAction === 'replacement_evidence'
      || intent.userIntent === 'PART_REQUEST') return reply;
  // After a cannot-answer, the declined discriminator is already retired. Re-posing ANY question
  // reads as a loop, so never append one — the compose was instructed to lower the burden and state
  // the most likely cause / best next step, and that conclusion must stand on its own.
  if (intent._cannotAnswer) return reply;
  if (extras && extras.diagnoseStop === 'hv-boundary') {
    reply = stripModelAskOnProfessionalBoundary(reply);
    const hvText = String(reply || '');
    if (!/\b(?:professional|engineer|qualified|high[- ]voltage|\bhv\b)\b/i.test(hvText)) {
      const hvNext = intent.nextBestCheck
        || 'A qualified microwave engineer is required once the next step would be high-voltage heating-system access or testing.';
      const lead = hvText.trim() ? hvText.trim().replace(/[;:\s]+$/, '.') : '';
      reply = (lead ? `${lead} ` : '') + hvNext;
    }
    return reply;
  }
  const text = String(reply || '').trim();
  // Prefer a GENUINE next action we actually hold — a real safe check or a discriminating question.
  // customerFacingNextCheck excludes identification/orchestration control (e.g. "Ask for the model…").
  const realNext = customerFacingNextCheck(intent) || intent.clarifyingQuestion || null;
  if (realNext) {
    if (replyHasUsefulNextAction(text) && !replyIsAcknowledgementOnly(text) && text.length >= 48) return reply;
    if (text && text.toLowerCase().includes(String(realNext).slice(0, 24).toLowerCase())) return reply;
    const lead = text ? text.replace(/[;:\s]+$/, '.') : '';
    return (lead ? `${lead} ` : '') + realNext;
  }
  // No real next action to add. A reply that ALREADY says something substantive (a likely cause, a
  // conclusion, an engineer hand-off) is NOT a dead-end — stating the finding IS progression, so it
  // stands as-is. The generic cross-function probe is used ONLY to rescue a genuinely contentless
  // reply (a bare acknowledgement or a near-empty line); appending it to a real conclusion is the
  // questionnaire behaviour we are removing.
  if (!replyIsAcknowledgementOnly(text) && text.length >= 48) return reply;
  const lead = text ? text.replace(/[;:\s]+$/, '.') : '';
  return (lead ? `${lead} ` : '')
    + 'What else still works, and what happens if you try a different programme or function?';
}

/** Current-action media node when a customer-safe check is next, even if the fault is not yet committed. */
function currentActionMediaFaultId(intent, family) {
  if (!intent || intent._nextAction !== 'check' || !family) return null;
  const blob = `${intent.nextBestCheck || ''} ${intent.primaryFinding || ''}`.toLowerCase();
  if ((family === 'washing-machine' || family === 'washer-dryer') && /filter|trap/.test(blob)) {
    const reported = `${(intent.checksReported || []).join(' ')}`.toLowerCase();
    const filterDone = /\bfilter\b/.test(reported) && /\b(clear|cleaned|done|ok|okay|already)\b/.test(reported);
    if (!filterDone) return 'not-draining';
    return null;
  }
  if (family === 'tumble-dryer' && /fluff|lint|airflow|vent/.test(blob)) return 'not-heating';
  if (family === 'vacuum' && /filter|blockage|bin|hose|wand/.test(blob)) return 'lost-suction';
  return null;
}

function captureQuestionedCause(intent, queryText) {
  if (!intent) return intent;
  const t = String(queryText || '').replace(/[\u2019\u02bc]/g, "'");
  const theories = Array.isArray(intent.customerTheories) ? intent.customerTheories.slice() : [];
  const pushTheory = (phrase) => {
    const clean = String(phrase || '').trim().replace(/\s+/g, ' ');
    if (clean.length < 3) return;
    if (/^(what|why|how|who|where|when|help|thanks|please|hello)\b/i.test(clean)) return;
    if (theories.some((x) => String(x).toLowerCase() === clean.toLowerCase())) return;
    theories.push(clean);
  };
  const re = /\b(?:is (?:it|that)(?: (?:likely|probably)(?: to be)?)?|could it be)\s+(?:the |a |my )?([^?!.]{2,40})\??/gi;
  let m;
  while ((m = re.exec(t)) && theories.length < 6) pushTheory(m[1]);
  const purchaseRe = /\b(?:(?:before i |should i |shall i |worth )?(?:buy(?:ing)?|order(?:ing)?|get(?:ting)?))\s+(?:a |an |the |a new |my )?([^?!.]{2,40}?)(?:\s*\?|[.!']|$)/gi;
  while ((m = purchaseRe.exec(t)) && theories.length < 6) pushTheory(m[1]);
  const needRe = /\bdo i need(?: a| an| the| a new)?\s+([^?!.]{2,40}?)(?:\s*\?|[.!']|$)/gi;
  while ((m = needRe.exec(t)) && theories.length < 6) pushTheory(m[1]);
  const goneRe = /\bis (?:the |my |a )?([^?!.]{2,32}?) (?:gone|dead|failed|kaput|duff|on its way out)\b/gi;
  while ((m = goneRe.exec(t)) && theories.length < 6) pushTheory(m[1]);
  const last = t.trim().split(/[.!]\s+/).pop() || '';
  const fragment = last.split(/[,;]\s*/).pop() || last;
  const bare = /^(?:the |a |my )?([^?]{2,40})\?\s*$/i.exec(fragment.trim());
  if (bare) pushTheory(bare[1]);
  intent.customerTheories = theories;
  return intent;
}

function drainFunctionEstablished(intent, queryText) {
  const facts = (intent && Array.isArray(intent.facts)) ? intent.facts : [];
  if (facts.some((f) => f && (f.name === 'waterRemaining' || f.name === 'noiseOnDrain') && f.value === 'TRUE')) {
    return true;
  }
  const t = String(queryText || '').replace(/[\u2019\u02bc]/g, "'");
  return /\b(won'?t drain|will not drain|not drain|won'?t empty|wont empty|not emptying|water left|standing water)\b/i.test(t);
}

/** Latest customer turn already answered the drain-event discriminator. */
function latestTurnEstablishesDrainEvent(progress, intent) {
  if (drainFunctionEstablished(intent, (progress && progress.latestUserText) || '')) return true;
  // Jev-authoritative (Story 2): the drain-event observation surfaces as a known fact.
  return factKnownOnIntent(intent, 'waterRemaining') || factKnownOnIntent(intent, 'noiseOnDrain');
}

function accessibleImpellerInspected(text) {
  const t = String(text || '').replace(/[\u2019\u02bc]/g, "'").toLowerCase();
  if (/\b(pump and filter are clear|pump.{0,32}clear|housing.{0,32}clear)\b/i.test(t)) return true;
  if (!/\bimpeller\b/.test(t)) return false;
  // "turn it by hand sometimes" is condition-limited, not a completed clear look.
  if (/\b(sometimes|by hand|flick)\b/.test(t)
      && !/\b(nothing blocking|can'?t see|cannot see|not jammed|no (?:visible )?(?:block|obstruction)|turns freely|spins freely)\b/.test(t)) {
    return false;
  }
  return /\b(turns|turning|free|freely|spins?|spinning|nothing blocking|can'?t see|cannot see|not jammed|no (?:visible )?(?:block|obstruction)|isn'?t blocked|not blocked)\b/.test(t);
}

function priorAdvisorAskedImpellerLook(progress) {
  const prior = String((progress && progress.priorAdvisorText) || '').toLowerCase();
  return /\bimpeller\b/.test(prior) || /\bpump (?:area|housing|inlet|cover|grille)\b/.test(prior);
}

/** A named-part question ("is the pump gone?") is a hypothesis, not recovery. */
function namedPartGoneHypothesis(text) {
  const t = String(text || '').replace(/[\u2019\u02bc]/g, "'");
  return /\b(?:is|has)\s+(?:the\s+|my\s+|a\s+|it(?:\s+the)?\s+)?[a-z][\w-]{1,24}\s+gone\b/i.test(t)
    || /\bgone\s*\?/i.test(t);
}

/** Explicit report that the failed function now works — not a check-result, not a part guess. */
function explicitFunctionRestored(text) {
  const t = String(text || '').replace(/[\u2019\u02bc]/g, "'").toLowerCase();
  if (namedPartGoneHypothesis(t) && !/\b(water|standing water|draining|filling|heating|spinning|emptying)\b/.test(t)) {
    return false;
  }
  return /\b((?:it'?s|it is|now) (?:draining|filling|heating|spinning|emptying|working|fixed|sorted)(?:\s+now|\s+again)?|(?:the )?(?:standing )?water (?:has |have |is )?(?:gone|cleared|drained|empty)|no (?:more )?water (?:left|in (?:the )?(?:bottom|drum|tub|machine))|emptied (?:fine|ok|okay|now|properly)|working again|fixed now|problem (?:is |has )?(?:gone|cleared|fixed|resolved)|it'?s (?:all )?(?:fine|ok|okay|sorted) now)\b/i.test(t);
}

function latestTurnReportsRecovery(progress) {
  const latest = String((progress && progress.latestUserText) || '').replace(/[\u2019\u02bc]/g, "'");
  if (!latest) return false;
  if (explicitFunctionRestored(latest)) return true;
  if (namedPartGoneHypothesis(latest)) return false;
  if (accessibleImpellerInspected(latest)) return false;
  return false;
}

function laundryFilterIsImpellerAccess(intent, queryText) {
  const family = applianceKey(intent && intent.applianceType);
  return family === 'washing-machine' || family === 'washer-dryer';
}

function demotePrematurePartRequest(intent, queryText) {
  if (!intent || intent.userIntent !== 'PART_REQUEST') return intent;
  if (customerProposedDrainPathPart(intent, queryText) && !drainFunctionEstablished(intent, queryText)) {
    intent.userIntent = 'NEW_PROBLEM';
    return intent;
  }
  // A named-part question ("is it the seal?") is a hypothesis, not a parts-desk purchase,
  // until family is operational and a matching failure observation exists.
  const theories = (intent.customerTheories || []).join(' ');
  const asking = /\b(?:is it|is that|could it be|do i need)\b/i.test(String(queryText || ''))
    || /\?\s*$/.test(String(queryText || '').trim());
  const familyKnown = Boolean(intent.applianceType && !intent._applianceUnconfirmed);
  if (asking && theories && (!familyKnown || !intent.model)) {
    intent.userIntent = 'NEW_PROBLEM';
    if (intent.primaryFindingKind === 'component') intent.primaryFindingKind = 'subsystem';
    intent.candidateComponents = [];
  }
  return intent;
}

function demoteUnconfirmedTheoryFinding(intent) {
  if (!intent) return intent;
  const theories = (intent.customerTheories || []).map((x) => String(x).toLowerCase());
  const finding = String(intent.primaryFinding || '').toLowerCase();
  if (!theories.length || !finding) return intent;
  const facts = Array.isArray(intent.facts) ? intent.facts : [];
  const byHandKnown = facts.some((f) => f && f.name === 'drumTurnsByHand' && (f.value === 'TRUE' || f.value === 'FALSE'));
  const drumStuck = facts.some((f) => f && f.name === 'drumTurns' && f.value === 'FALSE');
  const theoryHitsFinding = theories.some((t) => {
    const words = t.split(/[^a-z0-9]+/).filter((w) => w.length > 3);
    return words.some((w) => finding.includes(w));
  });
  if (!theoryHitsFinding) return intent;
  if (byHandKnown) return intent;
  intent.primaryFindingKind = 'subsystem';
  intent.candidateComponents = [];
  if (drumStuck) {
    intent.primaryFinding = 'The drive is not turning the drum. Isolate, then check whether the drum turns freely by hand before naming a part.';
  }
  return intent;
}

const _CHECKS_NOT_DONE_RE = /\b(have not|haven'?t|havent|not (yet )?checked|not checked anything|haven'?t done (it|that|anything))\b/i;

function latestTurnSaysChecksNotDone(progress) {
  const latest = String((progress && progress.latestUserText) || '').replace(/[\u2019\u02bc]/g, "'");
  return _CHECKS_NOT_DONE_RE.test(latest);
}

// How many customer turns across the thread have said the recommended check is not done. Used to
// BOUND the "re-assert the same check" path: the first time is a legitimate nudge, but a second
// not-done turn means repeating the same instruction is no longer progress — guide/offer the
// grounded fallback instead. Structural (counts turns), not a raw assistant-text repetition detector.
function checksNotDoneTurnCount(messages) {
  let n = 0;
  for (const m of Array.isArray(messages) ? messages : []) {
    if (!m || m.role !== 'user') continue;
    const latest = String(messageText(m) || '').replace(/[\u2019\u02bc]/g, "'");
    if (_CHECKS_NOT_DONE_RE.test(latest)) n += 1;
  }
  return n;
}

function preferAccessibleFirstAction(intent, queryText, progress) {
  if (!intent) return intent;
  const t = String(queryText || '').replace(/[\u2019\u02bc]/g, "'").toLowerCase();
  // Advisor wording and LLM-filled checksReported are not proof the customer did the check.
  // "I have not checked yet" must keep the current accessible action, not skip ahead.
  // Completed checks and standing water often live on earlier turns; the latest
  // queryText may be only the new evidence (impeller result, model, a yes/no).
  const conversationBlob = `${progressCustomerText(progress)} ${t}`.toLowerCase();
  const reported = latestTurnSaysChecksNotDone(progress)
    ? t
    : `${(intent.checksReported || []).join(' ')} ${conversationBlob}`;
  const facts = Array.isArray(intent.facts) ? intent.facts : [];
  // Jev's TYPED completed-check evidence is authoritative for whether an accessible check is done —
  // more reliable than the prose regex, and it survives sparse follow-up turns. A check Jev typed as
  // completed-and-clear must never be re-recommended as the next action.
  const factDone = (name) => facts.some((f) => f && f.name === name && f.value === 'TRUE');
  const filterDone = factDone('filterChecked') || (/\bfilter\b/.test(reported) &&
    /\b(clear|cleaned|done|ok|okay|already)\b/.test(reported));
  const hoseDone = factDone('hoseChecked');
  const latestTurnForWater = String((progress && progress.latestUserText) || '').replace(/[\u2019\u02bc]/g, "'").toLowerCase();
  const waterLeft = facts.some((f) => f && f.name === 'waterRemaining' && f.value === 'TRUE')
    || /\b(water (?:left|still|remaining )(?:in (?:the )?(?:drum|tub|machine|bottom))?|water still in|standing water|finished with water|ended with .{0,32}water|won'?t drain|wont drain|won'?t empty|wont empty|not emptying|tub full of water|wash finished.{0,80}water)\b/.test(conversationBlob)
    || /\b(water (?:left|still|remaining )(?:in (?:the )?(?:drum|tub|machine|bottom))?|water still in|standing water)\b/.test(latestTurnForWater);
  if (waterLeft && !filterDone) {
    intent.nextBestCheck = 'Check the accessible pump filter or trap. Open it slowly with towels or a shallow tray ready — standing water can spill.';
    intent.nextCheckCustomerSafe = true;
    intent.furtherGenericCheckJustified = true;
    intent.needMoreInfo = true;
    intent._nextAction = 'check';
    return clearPendingDiscriminators(intent);
  }
  // Accessible filter already cleaned, and a dedicated drain/empty attempt worked, but the
  // complaint remains: do not sell the cleaned filter or the pump that just emptied. The
  // next useful observation is standing water vs slow/empty drain, then the pressure/level path.
  const drainAttemptWorked = /\b(drain works|drains? (?:ok|okay|fine|normally|if i|when i)|select(?:ed)? drain|empties? (?:ok|okay|fine|when))\b/.test(t);
  const complaintRemains = /\b(still (?:showing|there|happening|doing it)|error|won'?t (?:wash|complete|spin|finish|start)|stops? mid|fault)\b/.test(t)
    || /\be[\s-]?\d{1,3}\b/.test(t);
  if (filterDone && drainAttemptWorked && complaintRemains) {
    intent.nextBestCheck = 'Check whether water is left standing after it stops, then inspect the small pressure/level hose and air trap. Do not replace the filter already cleaned.';
    intent.nextCheckCustomerSafe = true;
    intent.furtherGenericCheckJustified = true;
    intent.needMoreInfo = true;
    intent._nextAction = 'check';
    return clearPendingDiscriminators(intent);
  }
  const latestTurn = String((progress && progress.latestUserText) || '').replace(/[\u2019\u02bc]/g, "'");
  const pumpPathClearLatest = /\b(pump and filter are clear|pump.{0,32}clear|housing.{0,32}clear)\b/i.test(latestTurn);
  const impellerInspectedLatest = pumpPathClearLatest || accessibleImpellerInspected(latestTurn);
  // An earlier "sometimes / by hand / flick" report is superseded once this turn
  // says the accessible impeller is free or unobstructed.
  const impellerConditionLimited = /\bimpeller\b/.test(t) && /\b(sometimes|by hand|flick)\b/.test(t)
    && !impellerInspectedLatest;
  const impellerInspected = impellerInspectedLatest || accessibleImpellerInspected(t) || factDone('impellerClear');
  const laundryTrapIsImpeller = laundryFilterIsImpellerAccess(intent, t);
  const modelKnown = Boolean(intent.model)
    || facts.some((f) => f && f.name === 'model' && f.value && f.value !== 'UNKNOWN')
    || /\be-?nr\b/i.test(latestTurn)
    || /\bmodel(?:\s+number)?\s+is\b/i.test(latestTurn);
  // They just answered the impeller/housing look we asked. Do not repeat it,
  // even if UNDERSTAND still has that check as nextBestCheck.
  if (impellerInspectedLatest && priorAdvisorAskedImpellerLook(progress)
      && !latestTurnSaysChecksNotDone(progress)) {
    if (modelKnown) {
      intent.primaryFindingKind = 'subsystem';
      intent.nextBestCheck = 'A weak or failed drain-path component is a reasonable hypothesis together with any remaining downstream restriction. Do not treat a free impeller or an earlier hum as proof the pump has failed, and do not instruct buying or replacing it as the next step. Give advice before any replacement.';
      intent.nextCheckCustomerSafe = true;
      intent.furtherGenericCheckJustified = true;
      intent.needMoreInfo = true;
      intent._nextAction = 'advice';
      return clearPendingDiscriminators(intent);
    }
    intent.nextBestCheck = familyKnownIdentificationAsk(intent, 'Do not repeat the accessible impeller or filter check, and do not treat the earlier hum as proof the pump has failed.').nextBestCheck;
    intent.nextCheckCustomerSafe = false;
    intent.furtherGenericCheckJustified = false;
    intent.needMoreInfo = true;
    intent._nextAction = 'identification';
    intent.primaryFindingKind = 'subsystem';
    return clearPendingDiscriminators(intent);
  }
  if (filterDone && waterLeft && impellerInspected && !impellerConditionLimited && !laundryTrapIsImpeller) {
    if (modelKnown) {
      intent.primaryFindingKind = 'subsystem';
      intent.nextBestCheck = 'A weak or failed drain-path component is a reasonable hypothesis together with any remaining downstream restriction. Do not treat a free impeller or an earlier hum as proof the pump has failed, and do not instruct buying or replacing it as the next step. Give advice before any replacement.';
      intent.nextCheckCustomerSafe = true;
      intent.furtherGenericCheckJustified = true;
      intent.needMoreInfo = true;
      intent._nextAction = 'advice';
      return clearPendingDiscriminators(intent);
    }
    intent.nextBestCheck = familyKnownIdentificationAsk(intent, 'Do not repeat the accessible impeller or filter check, and do not treat the earlier hum as proof the pump has failed.').nextBestCheck;
    intent.nextCheckCustomerSafe = false;
    intent.furtherGenericCheckJustified = false;
    intent.needMoreInfo = true;
    intent._nextAction = 'identification';
    intent.primaryFindingKind = 'subsystem';
    return clearPendingDiscriminators(intent);
  }
  if (filterDone && waterLeft && !impellerInspected && !impellerConditionLimited && !laundryTrapIsImpeller) {
    intent.nextBestCheck = 'With the appliance isolated from the mains, look in the user-accessible pump or impeller area for a blockage or a jammed impeller. Do not repeat the filter check already done, and do not confirm the pump has failed.';
    intent.nextCheckCustomerSafe = true;
    intent.furtherGenericCheckJustified = true;
    intent.needMoreInfo = true;
    intent._nextAction = 'check';
    return clearPendingDiscriminators(intent);
  }
  if (filterDone && waterLeft && !hoseDone && !(impellerConditionLimited && pumpPathClearLatest)) {
    intent.nextBestCheck = 'Check the drain hose for a kink or blockage. Do not confirm the pump or a jammed impeller; the accessible filter being clear does not prove that.';
    intent.nextCheckCustomerSafe = true;
    intent.furtherGenericCheckJustified = true;
    intent.needMoreInfo = true;
    intent._nextAction = 'check';
    return clearPendingDiscriminators(intent);
  }
  // Filter, impeller AND drain hose all reported clear but water still remains: the accessible
  // drain path is exhausted — do not loop back to any of those checks. Advance to a model-specific
  // hypothesis (if identity is known) or ask for identity, mirroring the impeller-exhausted branch.
  if (filterDone && waterLeft && hoseDone) {
    if (modelKnown) {
      intent.primaryFindingKind = 'subsystem';
      intent.nextBestCheck = 'The accessible filter, pump/impeller area and drain hose have all been checked and are clear, yet water remains. A weak or failed drain pump, or a blockage in the sump/pressure path, is the reasonable next hypothesis. Do not re-recommend the filter, impeller or hose checks already completed, and give advice before any replacement.';
      intent.nextCheckCustomerSafe = true;
      intent.furtherGenericCheckJustified = true;
      intent.needMoreInfo = true;
      intent._nextAction = 'advice';
      return clearPendingDiscriminators(intent);
    }
    intent.nextBestCheck = familyKnownIdentificationAsk(intent, 'Do not repeat the filter, impeller or drain-hose checks already completed and reported clear.').nextBestCheck;
    intent.nextCheckCustomerSafe = false;
    intent.furtherGenericCheckJustified = false;
    intent.needMoreInfo = true;
    intent._nextAction = 'identification';
    intent.primaryFindingKind = 'subsystem';
    return clearPendingDiscriminators(intent);
  }
  const dryer = /\b(tumble[\s-]?dry|\bdryer\b)/.test(t)
    || applianceKey(intent.applianceType) === 'tumble-dryer';
  const noHeat = /\b(no heat|not heat|still cold|isn'?t heating|not heating|won'?t heat|not getting hot)\b/.test(t);
  const heatThenStops = /\b(hot|heat\w*|heats).{0,48}(then |and )?(cuts? out|dies|stops)\b/.test(t)
    || /\bcuts? out.{0,40}(cool|cold)\b/.test(t);
  if (dryer && !filterDone && (noHeat || heatThenStops)) {
    intent.nextBestCheck = 'Clean the fluff/lint filter and check the vent/airflow path before considering heat parts.';
    intent.nextCheckCustomerSafe = true;
    intent.furtherGenericCheckJustified = true;
    intent.needMoreInfo = true;
    intent._nextAction = 'check';
    return clearPendingDiscriminators(intent);
  }
  const vacuum = /vacuum|\bhoover\b|\bhenry\b|\bdyson\b|brush bar/i.test(t)
    || applianceKey(intent.applianceType) === 'vacuum';
  const pulsing = /\b(puls(?:e|ing|ating)|surg(?:e|ing)|cuts? out then starts)\b/.test(t);
  if (vacuum && pulsing && !filterDone) {
    intent.nextBestCheck = 'Empty the bin, clean the filters, and clear any hose/wand/floor-head blockage before considering power, battery or motor.';
    intent.nextCheckCustomerSafe = true;
    intent.furtherGenericCheckJustified = true;
    intent.needMoreInfo = true;
    intent._nextAction = 'check';
    return clearPendingDiscriminators(intent);
  }
  const drumNotTurning = facts.some((f) => f && f.name === 'drumTurns' && f.value === 'FALSE');
  const byHandKnown = facts.some((f) => f && f.name === 'drumTurnsByHand' && (f.value === 'TRUE' || f.value === 'FALSE'));
  const motorHeard = /\b(hear(?:ing)? (?:the )?motor|motor (?:runs|running|is running)|can hear (?:the )?motor)\b/.test(t);
  if ((motorHeard && drumNotTurning && !byHandKnown)
      || (drumNotTurning && !byHandKnown && /\b(belt|motor)\b/.test(t) && /\b(fills?|filling|water)\b/.test(t))) {
    intent.nextBestCheck = 'Unplug the appliance, then try turning the drum by hand. If it turns freely the drive is not coupled to the drum; if it is stiff, something is seized. That observation comes before naming a belt, bearing or motor.';
    intent.nextCheckCustomerSafe = true;
    intent.furtherGenericCheckJustified = true;
    intent.needMoreInfo = true;
    intent._nextAction = 'check';
    return clearPendingDiscriminators(intent);
  }
  const doorLocked = /\block/.test(t) && !/\b(won'?t lock|will not lock|doesn'?t lock|does not lock|not lock)\b/.test(t);
  const hums = /\bhumm?/.test(t);
  const waterStateUnknown = !waterLeft
    && !facts.some((f) => f && (f.name === 'waterEntering' || f.name === 'waterRemaining') && f.value && f.value !== 'UNKNOWN');
  if (doorLocked && hums && waterStateUnknown && !drumNotTurning) {
    const q = DISCRIMINATOR_QUESTION.waterEntering
      || 'Does any water start coming into the machine, or does it just sit there without filling?';
    if (!discriminatorAlreadyAsked(progress, q) && !factKnownOnIntent(intent, 'waterEntering')) {
      intent.nextBestCheck = q;
      intent.clarifyingQuestion = q;
      intent.nextCheckCustomerSafe = true;
      intent.furtherGenericCheckJustified = true;
      intent.needMoreInfo = true;
      intent._nextAction = 'discriminator';
      intent._observationAmbiguity = { fact: 'waterEntering', question: q };
      intent.faultId = null;
      intent.primaryFinding = null;
      intent.candidateComponents = [];
      return intent;
    }
  }
  if (!doorLocked && hums && waterStateUnknown && !drumNotTurning
      && (filterDone || customerProposedDrainPathPart(intent, t))) {
    const q = DISCRIMINATOR_QUESTION.drainEvent
      || 'When it hums, is there water left in the bottom, and is that happening when the machine should be draining?';
    const drainAnswered = latestTurnEstablishesDrainEvent(progress, intent)
      || drainFunctionEstablished(intent, `${t} ${latestTurnForWater}`)
      || factKnownOnIntent(intent, 'waterRemaining')
      || factKnownOnIntent(intent, 'noiseOnDrain');
    if (!discriminatorAlreadyAsked(progress, q) && !drainAnswered) {
      intent.nextBestCheck = q;
      intent.clarifyingQuestion = q;
      intent.nextCheckCustomerSafe = true;
      intent.furtherGenericCheckJustified = true;
      intent.needMoreInfo = true;
      intent._nextAction = 'discriminator';
      intent._observationAmbiguity = { fact: 'drainEvent', question: q };
      intent.faultId = null;
      intent.primaryFinding = null;
      intent.candidateComponents = [];
      return intent;
    }
  }
  const replacedBlob = `${(intent.alreadyReplaced || []).join(' ')} ${t}`;
  const replacedHeater = /\b(element|heater|heating element)\b/.test(replacedBlob);
  const familyKnown = Boolean(applianceKey(intent.applianceType));
  if (replacedHeater && (noHeat || heatThenStops) && !familyKnown) {
    intent.nextBestCheck = 'Ask which appliance this is. Do not list example families. A replaced heater with the same no-heat remaining is not solved by fitting another, and a power-cycle is not the next diagnosis. Remaining heat-path stays open as hypotheses only: airflow or restriction, a thermostat or cut-out, wiring or command.';
    intent.nextCheckCustomerSafe = false;
    intent.furtherGenericCheckJustified = false;
    intent.needMoreInfo = true;
    intent._nextAction = 'identification';
    intent._identificationDirection = 'Remaining heat-path stays open as hypotheses only: airflow or restriction, a thermostat or cut-out, wiring or command. Do not recommend another identical heater or element, and do not treat those remaining causes as established facts.';
    return clearPendingDiscriminators(intent);
  }
  const latest = String((progress && progress.latestUserText) || t).replace(/[\u2019\u02bc]/g, "'");
  if (/\bimpeller\b/.test(t) && /\b(sometimes|by hand|flick)\b/.test(t)) {
    if (/\b(pump and filter are clear|pump.{0,32}clear|housing.{0,32}clear)\b/i.test(latest)) {
      intent.nextBestCheck = familyKnownIdentificationAsk(intent, 'Do not repeat the housing look, and do not invent a lodged object.').nextBestCheck;
      intent.nextCheckCustomerSafe = false;
      intent.furtherGenericCheckJustified = false;
      intent.needMoreInfo = true;
      intent._nextAction = 'identification';
      intent.primaryFindingKind = 'subsystem';
      intent.candidateComponents = [];
      return clearPendingDiscriminators(intent);
    }
    intent.nextBestCheck = 'The impeller working only sometimes or by hand is condition-limited. Give one accessible housing look as a check. Do not confirm the pump and do not ask for the model on this turn.';
    intent.nextCheckCustomerSafe = true;
    intent.furtherGenericCheckJustified = true;
    intent.needMoreInfo = true;
    intent._nextAction = 'check';
    intent.primaryFindingKind = 'subsystem';
    intent.candidateComponents = [];
    return clearPendingDiscriminators(intent);
  }
  const dryerFamily = dryer || applianceKey(intent.applianceType) === 'tumble-dryer'
    || /\b(tumble[\s-]?dry|\bdryer\b)/.test(t);
  const silentNotDrying = /\bsilent/.test(t) && /\b(not drying|isn'?t drying|aren'?t drying)\b/.test(t);
  const drumTurnsTrue = facts.some((f) => f && f.name === 'drumTurns' && String(f.value).toUpperCase() === 'TRUE');
  if (silentNotDrying && dryerFamily && !drumTurnsTrue) {
    intent.nextBestCheck = 'Does the drum still turn, and is there useful heat? Silent is not proof it is dead, and not drying is not proof the drum has stopped.';
    intent.clarifyingQuestion = 'Does the drum still turn when you start a cycle, and can you tell if there is useful heat?';
    intent.nextCheckCustomerSafe = true;
    intent.needMoreInfo = true;
    intent._nextAction = 'discriminator';
    intent.faultId = null;
    intent.primaryFinding = null;
    intent.candidateComponents = [];
    return intent;
  }
  if (silentNotDrying && drumTurnsTrue) {
    intent.nextBestCheck = 'The drum turning is established. Ask whether there is useful heat. Do not name any component.';
    intent.clarifyingQuestion = 'When it runs, is there useful heat, or does it stay cold?';
    intent.nextCheckCustomerSafe = true;
    intent.needMoreInfo = true;
    intent._nextAction = 'discriminator';
    intent.faultId = null;
    intent.primaryFinding = null;
    intent.candidateComponents = [];
    return intent;
  }
  const protectiveDevice = /\b(thermal fuse|thermal cut-?out|overheat(?:er)? (?:fuse|cut-?out)|\btco\b)\b/.test(replacedBlob);
  const recurrence = /\b(twice|again|keeps?|keep(?:s|ing)?|another|popping|blowing|blows|fails? again)\b/.test(t);
  if (protectiveDevice && recurrence) {
    intent.nextBestCheck = 'A protective fuse or cut-out that fails again is downstream protection. Check for restricted airflow, lint or a blocked vent before considering another of the same device. If you have not said which appliance this is, tell me that as well.';
    intent.nextCheckCustomerSafe = true;
    intent.furtherGenericCheckJustified = true;
    intent.needMoreInfo = true;
    intent._nextAction = 'check';
    if (intent.primaryFindingKind === 'component' || !intent.primaryFinding) {
      intent.primaryFindingKind = 'condition';
      intent.primaryFinding = 'Repeated thermal-protection failure points to an underlying heat or airflow cause, not a weak replacement.';
    }
    return clearPendingDiscriminators(intent);
  }
  return intent;
}

function previouslyShownMedia(messages) {
  const out = [];
  for (const m of messages || []) {
    if (!m || m.role !== 'assistant' || !Array.isArray(m.media)) continue;
    for (const item of m.media) {
      if (item && typeof item === 'object') out.push(item);
    }
  }
  return out;
}

function previouslyShownSafety(messages) {
  const out = [];
  for (const m of messages || []) {
    if (!m || m.role !== 'assistant' || m.safetyInformation == null) continue;
    const shown = m.safetyInformation;
    const text = typeof shown === 'string' ? shown : shown.text;
    if (text) out.push(String(text).trim());
  }
  return out;
}

function sameSafetyAlreadyShown(messages, safety) {
  const text = String((safety && safety.text) || '').trim();
  if (!text) return false;
  return previouslyShownSafety(messages).includes(text);
}

function customerAskedToRepeatMedia(text) {
  const t = ` ${String(text || '').toLowerCase()} `;
  if (!/\b(picture|image|diagram|video|photo|clip)\b/.test(t)) return false;
  return /\b(again|once more|show me|see it|see that|watch it|the same)\b/.test(t);
}

module.exports = {
  EXCLUSIVE_OBSERVATION_GROUPS, setIdentificationNext, ensureAdviceThenIdentityAsk, stripInstructionEcho,
  familyKnownIdentificationAsk, resolveEstablishedFamily, lockApplianceType, allowedFamilyForReply,
  conversationProgress, followUpUnderstandNote, composeFollowUpNote, correctFollowUpIntent,
  completedAccessibleCheck, pendingDiagnosticQuestion, latestTurnLooksLikeIdentity, applyFollowUpNextAction,
  identificationAskContent, identificationIsNextAction, preferAdviceThenIdentity,
  preferArchitectureDependentAdvice, isAcousticOnlyQuery, NOISE_RECORD_BY_FAMILY, hasFunctionFailureSymptom,
  isUnlocatedFunctionOutcome, preferFamilyBeforeSpecificDiagnosis, preferConditionDiscriminator,
  preferNotRepeatIntervention, preferRelatedFunctionDiscriminator, diagnoseStopIsProfessionalHv,
  preferSingleVagueClarify, replyDeliversSafetyStop, microwaveHeatingHvBoundaryApplies,
  replyIsAcknowledgementOnly, stripModelAskOnProfessionalBoundary, naturalList, ownerSafeAdvice,
  renderDeterministicTerminal, ensureCommittedConclusion, avoidVerbatimRepeat, ensureNonTerminalProgression,
  currentActionMediaFaultId, captureQuestionedCause, drainFunctionEstablished, latestTurnEstablishesDrainEvent,
  accessibleImpellerInspected, priorAdvisorAskedImpellerLook, latestTurnReportsRecovery,
  laundryFilterIsImpellerAccess, demotePrematurePartRequest, demoteUnconfirmedTheoryFinding,
  latestTurnSaysChecksNotDone, checksNotDoneTurnCount, preferAccessibleFirstAction, previouslyShownMedia,
  previouslyShownSafety, sameSafetyAlreadyShown, customerAskedToRepeatMedia,
};
