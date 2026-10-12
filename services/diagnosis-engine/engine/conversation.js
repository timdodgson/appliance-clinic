'use strict';
/**
 * Transcript helpers for the canonical path: message text, the conversation's progress (latest vs earlier customer
 * evidence), the diagnostic question the advisor last asked, and the media already shown.
 */

/**
 * Conversation text helpers shared across the engine: message text, the customer's latest words, and whether the
 * product identity is already known.
 */
/** Fold curly quotes so speech variants match the same observation patterns. */
function asciiFold(text) {
  return String(text || '')
    .replace(/[\u2018\u2019\u201b\u2032\u02bc]/g, "'")
    .replace(/[\u201c\u201d\u2033]/g, '"');
}

function messageText(m) {
  if (!m) return '';
  if (typeof m.content === 'string') return m.content;
  if (Array.isArray(m.content)) {
    return m.content.filter((c) => c && c.type === 'text' && c.text).map((c) => c.text).join(' ');
  }
  return '';
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

module.exports = { asciiFold, messageText, conversationProgress, pendingDiagnosticQuestion, previouslyShownMedia };
