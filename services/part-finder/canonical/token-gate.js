'use strict';
/**
 * One commit rule for an identifier token whose meaning is code-or-model (ADR 0015: one owner per decision; the
 * conversation state is that owner). Jev's UNDERSTAND gives the token's meaning with a probability distribution; mc/1
 * gives the typed identity. A token is committed as the MODEL only when Jev's model reading is confident (>= 0.70)
 * and decisively ahead of the runner-up (>= 0.55). Otherwise the token is held as identity.unconfirmedToken, never lost
 * and never committed, until the customer says which it is; that answer commits it to the right field.
 *
 * This is the only implementation of the rule (Phase 12). tokenDecision() exposes it on the understand intent, and the
 * orchestrator routes on that decision (commit, or ask code-or-model) instead of recomputing it.
 *
 * Runs in understand mode on the mc/1 classification before the merge, so the merge, the persisted turn record and
 * a replay all see the same classification. Reads typed fields only.
 */
const MIN_CONF = 0.70;
const MIN_MARGIN = 0.55;
const norm = (t) => String(t || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

function modelReadingIsStrong(probabilities) {
  const ordered = Object.entries(probabilities || {}).filter(([, v]) => typeof v === 'number').sort((a, b) => b[1] - a[1]);
  if (!ordered.length) return true; // an older Jev without a distribution commits, as before
  const [top, p] = ordered[0];
  const runnerUp = ordered[1] ? ordered[1][1] : 0;
  return top === 'model' && p >= MIN_CONF && (p - runnerUp) >= MIN_MARGIN;
}

/**
 * The commit decision for this turn's identifier token, for the orchestrator: 'uncertain' when Jev reads it as the model
 * but not strongly enough to commit (the customer is asked which it is), otherwise 'commit' (a strong model reading, a
 * code reading, no token, or no distribution from an older Jev).
 */
function tokenDecision(signal) {
  const s = signal || {};
  if (s.meaning !== 'model' || !s.probabilities || !Object.keys(s.probabilities).length) {
    return { meaning: s.meaning || null, decision: 'commit', reason: 'not_gated' };
  }
  return modelReadingIsStrong(s.probabilities)
    ? { meaning: 'model', decision: 'commit', reason: 'strong' }
    : { meaning: 'model', decision: 'uncertain', reason: 'weak_or_near_tie' };
}

/** The token signal of this turn's Jev UNDERSTAND (intent + public observability). */
function jevTokenSignal(intent, jev) {
  const d = (jev && jev.decisions) || {};
  return {
    meaning: (intent && intent._tokenMeaning) || d.candidateTokenMeaning || null,
    probabilities: (jev && jev.probabilities && jev.probabilities.candidateTokenMeaning) || null,
    model: (intent && intent.model) || null,
    errorCode: (intent && intent.errorCode) || null,
    symptomFamily: d.symptomFamily || null,
  };
}

const activeToken = (state) => {
  const f = state && state.identity && state.identity.unconfirmedToken;
  return f && f.status !== 'superseded' && f.value ? f.value : null;
};

/**
 * Returns { classification, decision } — a new classification (the input is untouched) and what was decided:
 *   'held'           a weak model reading: not committed as model or code; held as identity.unconfirmedToken
 *   'answered_code'  a held token, and this turn reads as a code: committed as the displayed code
 *   'answered_model' a held token, and this turn reads strongly as the model: committed as the model
 *   null             nothing to decide
 */
function gateClassification(classification, signal, prior) {
  if (!classification || typeof classification !== 'object' || !classification.identity) return { classification, decision: null };
  const c = JSON.parse(JSON.stringify(classification));
  const id = c.identity;
  const s = signal || {};
  const weakModel = s.meaning === 'model' && !modelReadingIsStrong(s.probabilities);
  const token = s.model || (id.model && id.model.value) || null;
  if (weakModel && token) {
    if (id.model && norm(id.model.value) === norm(token)) id.model = { value: null, basis: null };
    if (id.displayedCode && norm(id.displayedCode) === norm(token)) id.displayedCode = null;
    id.unconfirmedToken = token;
    return { classification: c, decision: 'held' };
  }
  const held = activeToken(prior);
  if (!held) return { classification: c, decision: null };
  const readsCode = s.meaning === 'error_code' || Boolean(s.errorCode) || s.symptomFamily === 'error_display'
    || (id.displayedCode && norm(id.displayedCode) === norm(held));
  const readsModel = s.meaning === 'model' && modelReadingIsStrong(s.probabilities) && (!s.model || norm(s.model) === norm(held));
  if (readsCode && !readsModel) {
    if (!id.displayedCode) id.displayedCode = held;
    if (id.model && norm(id.model.value) === norm(held)) id.model = { value: null, basis: null };
    id.unconfirmedToken = null;
    return { classification: c, decision: 'answered_code' };
  }
  if (readsModel) {
    id.model = { value: (id.model && id.model.value) || held, basis: 'stated' };
    id.unconfirmedToken = null;
    return { classification: c, decision: 'answered_model' };
  }
  return { classification: c, decision: null };
}

module.exports = { MIN_CONF, MIN_MARGIN, modelReadingIsStrong, tokenDecision, jevTokenSignal, gateClassification };
