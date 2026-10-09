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

/** Concatenated text of the user turns (bounded) for retrieval + guessing. */
function latestUserText(messages) {
  const texts = [];
  for (const m of messages) {
    if (m.role !== 'user') continue;
    if (typeof m.content === 'string') texts.push(m.content);
    else if (Array.isArray(m.content)) {
      for (const c of m.content) if (c && c.type === 'text' && c.text) texts.push(c.text);
    }
  }
  return asciiFold(texts.join(' ').slice(0, 1000).trim());
}

function progressCustomerText(progress) {
  if (!progress) return '';
  return asciiFold(`${progress.priorUserText || ''} ${progress.latestUserText || ''}`).trim();
}

function conversationEvidenceText(progress, queryText, intent) {
  return [
    progressCustomerText(progress),
    queryText || '',
    ((intent && intent.reportedSymptoms) || []).join(' '),
  ].join(' ').trim();
}

function makeAlreadyKnown(intent) {
  return Boolean(intent && String(intent.make || '').trim());
}

function modelAlreadyKnown(intent) {
  return Boolean(intent && String(intent.model || '').trim());
}

/**
 * Family unknown is not identity insufficient.
 * A useful product identity (known model, or Jev-sufficient identity with make)
 * can proceed without asking the customer to name the appliance family.
 * Does not invent a family from the model string.
 */
function productIdentitySufficient(intent) {
  if (!intent) return false;
  if (modelAlreadyKnown(intent)) return true;
  if (intent._identitySufficiency === 'sufficient' && makeAlreadyKnown(intent)) return true;
  return false;
}

/** nextBestCheck that is actually a customer-facing check, not identification control. */
function customerFacingNextCheck(intent) {
  if (!intent) return null;
  if (intent._nextAction === 'identification' && intent.nextCheckCustomerSafe !== true) {
    return null;
  }
  const next = intent.nextBestCheck;
  if (typeof next !== 'string' || !next.trim()) return null;
  return next;
}

function messageText(m) {
  if (!m) return '';
  if (typeof m.content === 'string') return m.content;
  if (Array.isArray(m.content)) {
    return m.content.filter((c) => c && c.type === 'text' && c.text).map((c) => c.text).join(' ');
  }
  return '';
}

function latestUserMessage(messages) {
  if (!Array.isArray(messages) || !messages.length) return null;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i] && messages[i].role === 'user') return messages[i];
  }
  return null;
}

function messageHasImage(m) {
  if (!m) return false;
  if (m.image || (Array.isArray(m.images) && m.images.length)) return true;
  const c = m.content;
  if (Array.isArray(c)) {
    return c.some((p) => p && (p.type === 'image_url' || p.type === 'image' || p.image_url));
  }
  return false;
}

function customerProposedDrainPathPart(intent, queryText) {
  const theories = (intent && Array.isArray(intent.customerTheories)) ? intent.customerTheories.join(' ') : '';
  const comps = (intent && Array.isArray(intent.candidateComponents)) ? intent.candidateComponents.join(' ') : '';
  const blob = `${theories} ${comps} ${queryText || ''}`.replace(/[\u2019\u02bc]/g, "'");
  if (!/\b(drain pump|impeller|\bpump\b)/i.test(blob)) return false;
  if ((intent.customerTheories || []).some((x) => /\b(pump|impeller)\b/i.test(String(x)))) return true;
  return /\b(buy|buying|order|ordering|get|getting|replace|need a|need the|a pump|pump\?|pump gone|pump dead|pump failed)\b/i.test(blob);
}

module.exports = {
  asciiFold, latestUserText, progressCustomerText, conversationEvidenceText, makeAlreadyKnown, modelAlreadyKnown,
  productIdentitySufficient, customerFacingNextCheck, messageText, latestUserMessage, messageHasImage,
  customerProposedDrainPathPart,
};
