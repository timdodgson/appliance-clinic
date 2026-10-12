'use strict';
/**
 * UNDERSTAND: Jev's typed understanding of the latest turn (jev-understand.js), anchored to the conversation's
 * established identity, and the explicit degraded intent returned when Jev cannot run.
 */
const { loadAdminInference } = require('../admin-config.js');
const { understandWithJev, JevError } = require('../jev-understand.js');
const { resolveConversationIdentity } = require('../identity.js');
const { conversationProgress, pendingDiagnosticQuestion } = require('./conversation.js');

// Test seam (in-process only, never reachable from a request): a stand-in for the Jev pass, so handler tests run
// without Jev credentials.
let _understandForTest = null;
function _setUnderstandForTest(fn) { _understandForTest = typeof fn === 'function' ? fn : null; }

async function understand(messages, established = null) {
  if (_understandForTest) return _understandForTest(messages, established);
  const progress = conversationProgress(messages);
  const admin = await loadAdminInference();
  if (!admin.jevConfigured || !admin.jev) {
    throw new JevError('Jev credentials are not configured', { category: 'CONFIG' });
  }
  const queryForNote = `${progress.priorUserText || ''} ${progress.latestUserText || ''}`.trim();
  // STAGE A: cross-turn established identity threaded by the orchestrator ({applianceFamily,
  // familyState} on the wire). It is CONTEXT for Jev's interpretation of the new turn — never an
  // instruction to blindly repeat the family; an explicit customer correction still wins because
  // Jev re-reads the whole conversation and types the corrected family as customer_named.
  const priorIdentity = (established && typeof established === 'object' && established.applianceFamily)
    ? { family: established.applianceFamily, familyState: established.familyState || null }
    : null;
  const identity = resolveConversationIdentity({ messages, queryText: queryForNote, priorIdentity });
  const establishedForJev = priorIdentity
    ? { make: null, applianceFamily: priorIdentity.family, familyState: priorIdentity.familyState }
    : {
      make: null,
      applianceFamily: (identity && identity.family) || null,
      familyState: (identity && identity.familyState) || null,
    };
  return understandWithJev(messages, progress, {
    credentials: admin.jev,
    pendingQuestion: pendingDiagnosticQuestion(progress),
    established: establishedForJev,
  });
}

/** Jev could not run: an explicit degraded intent (_degraded), which the orchestrator turns into an error (ADR 0016). */
function degradedIntent() {
  return {
    onTopic: true,
    needMoreInfo: true,
    userIntent: 'OTHER',
    make: null,
    model: null,
    applianceType: null,
    fault: null,
    faultId: null,
    primaryFinding: null,
    errorCode: null,
    modelUnavailable: false,
    catalogueQuery: null,
    confidence: null,
    alternatives: [],
    candidateComponents: [],
    nextBestCheck: null,
    nextCheckCustomerSafe: false,
    furtherGenericCheckJustified: false,
    normalBehaviour: false,
    clarifyingQuestion: null,
    primaryFindingKind: 'unknown',
    customerTheories: [],
    declinedFacts: [],
    newEvidenceThisTurn: null,
    checksReported: [],
    facts: [],
    _degraded: true,
  };
}

module.exports = { understand, degradedIntent, _setUnderstandForTest };
