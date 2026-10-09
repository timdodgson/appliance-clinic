/**
 * UNDERSTAND: Jev classification of the latest message, the degraded fallback, intent normalisation, and revival of
 * an injected (orchestrator-supplied) intent.
 */
const { loadAdminInference } = require('../admin-config.js');
const { understandWithJev, JevError } = require('../jev-understand.js');
const { resolveConversationIdentity } = require('../identity.js');
const { USER_INTENTS, FINDING_KINDS } = require('./intent-vocabulary.js');
const { refineCustomerTheories } = require('./presentation.js');
const { conversationProgress, pendingDiagnosticQuestion } = require('./progression.js');

// ---------------------------------------------------------------------------
// PASS 1: UNDERSTAND
// ---------------------------------------------------------------------------

function retrievedFamilyNote(docs, familyKnown) {
  if (familyKnown) return '';
  const fams = [...new Set((docs || []).map((d) => d.applianceFamily).filter(Boolean))];
  if (!fams.length) return '';
  return `\n\nRETRIEVAL NOTE: the customer's words have not established the appliance family. These documents may still belong to one or more families (${fams.join(', ')}). That is candidate knowledge only — do NOT set applianceType from it. Leave applianceType null. Give a generic check if it still applies across the remaining plausible families.`;
}

/** Drop leading assistant turns so the UNDERSTAND LM never sees system+assistant. */
function lmSafeMessages(messages) {
  const list = Array.isArray(messages)
    ? messages.filter((m) => m && (m.role === 'user' || m.role === 'assistant'))
    : [];
  let i = 0;
  while (i < list.length && list[i].role !== 'user') i += 1;
  return list.slice(i);
}

async function understand(messages, knowledgeDocs = [], seed, established = null) {
  // Knowledge docs remain retrieved for COMPOSE / evidence. Jev does not
  // generate a diagnosis from them — that stays in resolveFault / evidence.
  void knowledgeDocs;
  void seed;
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

/** When pass 1 fails, assume on-topic and let compose ask for details. */
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

function normaliseIntent(o) {
  const str = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);
  // Length-cap LLM-generated free-text identifiers. Real values are short (a
  // brand, a model number, an error code), so caps are lossless for genuine
  // input but stop an attacker stuffing a paragraph of instructions into a
  // field that later reaches a prompt. Simple bound, no regex filtering.
  const cap = (v, n) => { const s = str(v); return s ? s.slice(0, n) : null; };
  // Customer-facing free text (clarifyingQuestion, nextBestCheck): still bounded (anti prompt-stuff)
  // but trim to a sentence/word boundary so we never show a reply cut off mid-word ("...underneath, o").
  const capText = (v, n) => {
    const s = str(v);
    if (!s) return null;
    if (s.length <= n) return s;
    const t = s.slice(0, n);
    const end = Math.max(t.lastIndexOf('. '), t.lastIndexOf('? '), t.lastIndexOf('! '));
    if (end >= n * 0.5) return t.slice(0, end + 1).trim();
    const sp = t.lastIndexOf(' ');
    return (sp > 0 ? t.slice(0, sp) : t).trim();
  };
  const out = {
    onTopic: o.onTopic !== false,
    needMoreInfo: o.needMoreInfo === true,
    userIntent: USER_INTENTS.includes(o.userIntent) ? o.userIntent : 'OTHER',
    make: cap(o.make, 40),
    model: cap(o.model, 40),
    applianceType: cap(o.applianceType, 40),
    fault: cap(o.fault, 80),
    faultId: cap(o.faultId, 40),
    primaryFinding: capText(o.primaryFinding, 220),
    errorCode: cap(o.errorCode, 16),
    modelUnavailable: o.modelUnavailable === true,
    catalogueQuery: cap(o.catalogueQuery, 80),
    confidence:
      typeof o.confidence === 'number' && Number.isFinite(o.confidence)
        ? Math.max(0, Math.min(1, o.confidence))
        : null,
    alternatives: Array.isArray(o.alternatives)
      ? o.alternatives.filter((a) => typeof a === 'string' && a.trim()).slice(0, 3)
      : [],
    reportedSymptoms: Array.isArray(o.reportedSymptoms)
      ? o.reportedSymptoms.filter((s) => typeof s === 'string' && s.trim()).map((s) => cap(s, 60)).slice(0, 4)
      : [],
    candidateComponents: Array.isArray(o.candidateComponents)
      ? o.candidateComponents.filter((c) => typeof c === 'string' && c.trim()).map((c) => c.trim()).slice(0, 8)
      : [],
    provenGood: Array.isArray(o.provenGood)
      ? o.provenGood.filter((c) => typeof c === 'string' && c.trim()).map((c) => cap(c, 40)).slice(0, 6)
      : [],
    alreadyReplaced: Array.isArray(o.alreadyReplaced)
      ? o.alreadyReplaced.filter((c) => typeof c === 'string' && c.trim()).map((c) => cap(c, 40)).slice(0, 6)
      : [],
    nextBestCheck: capText(o.nextBestCheck, 320),
    nextCheckCustomerSafe: o.nextCheckCustomerSafe === true,
    furtherGenericCheckJustified: o.furtherGenericCheckJustified === true,
    normalBehaviour: o.normalBehaviour === true,
    clarifyingQuestion: capText(o.clarifyingQuestion, 320),
    primaryFindingKind: FINDING_KINDS.includes(o.primaryFindingKind) ? o.primaryFindingKind : 'unknown',
    customerTheories: Array.isArray(o.customerTheories)
      ? o.customerTheories.filter((c) => typeof c === 'string' && c.trim()).map((c) => cap(c, 80)).slice(0, 6)
      : [],
    declinedFacts: Array.isArray(o.declinedFacts)
      ? o.declinedFacts.filter((n) => typeof n === 'string' && n.trim()).map((n) => cap(n, 40)).slice(0, 12)
      : [],
    newEvidenceThisTurn: capText(o.newEvidenceThisTurn, 220),
    checksReported: Array.isArray(o.checksReported)
      ? o.checksReported.filter((c) => typeof c === 'string' && c.trim()).map((c) => cap(c, 80)).slice(0, 8)
      : [],
    facts: Array.isArray(o.facts)
      ? o.facts
          .filter(
            (f) =>
              f &&
              typeof f.name === 'string' &&
              f.name.trim() &&
              ['TRUE', 'FALSE', 'UNKNOWN'].includes(f.value),
          )
          .map((f) => ({ name: f.name.trim(), value: f.value }))
          .slice(0, 20)
      : [],
  };
  return refineCustomerTheories(out);
}

/**
 * Story 3: revive the pre-computed Jev intent forwarded by the orchestrator (body.understand).
 * It is part-finder's OWN understand() output, JSON round-tripped. Normalise the public fields
 * (same bounds/caps as a fresh understand) and PRESERVE the Jev adapter's private typed fields
 * (_jev / _jevEvidence / _tokenMeaning / _partReadiness / _identitySufficiency / _cannotAnswer /
 * _answeredPrevious / _safetyClassification / _onTopicUncertain) that downstream consumers and the
 * Story-1/2 evidence contract rely on. No Jev call — this is the SAME interpretation, reused.
 */
function reviveInjectedIntent(o) {
  const src = (o && typeof o === 'object') ? o : {};
  const revived = normaliseIntent(src);
  for (const k of Object.keys(src)) {
    if (k.startsWith('_') && !(k in revived)) revived[k] = src[k];
  }
  if (!revived._jevEvidence || typeof revived._jevEvidence !== 'object') {
    revived._jevEvidence = { source: 'jev', facts: [], intervention: null };
  } else if (!Array.isArray(revived._jevEvidence.facts)) {
    revived._jevEvidence.facts = [];
  }
  return revived;
}

module.exports = {
  retrievedFamilyNote, lmSafeMessages, understand, degradedIntent, normaliseIntent, reviveInjectedIntent,
};
