'use strict';
/**
 * The canonical mc/1 classifier call: ONE Jev evaluation per customer message, separate from the legacy UNDERSTAND
 * call so it carries its own latest-message-scoped `state` (latest message, prior assistant message, the structured
 * pending request, a compact read-only cs/1 summary, candidate tokens). Its classification is the only input to the
 * cs/1 merge (canonical-runtime.js). Kill switch: CANONICAL_MC1_QUESTIONS=0 → no classification → every turn legacy.
 */
const { evaluateJevWithRetries, JevError } = require('./jev-client');
const { buildCandidates } = require('./canonical/candidates.js');
const { buildMc1Request, adaptMc1Answers, degradedClassification } = require('./canonical/mc1-questions.js');

let _evaluateForTest = null;
function _setMc1EvaluateForTest(fn) { _evaluateForTest = fn; }

/**
 * Classify the latest customer message into mc/1. Never throws: a Jev failure returns the degraded
 * classification (scope unclear, all else null) with meta.degraded=true, which is never merged.
 */
async function classifyLatestMessage({ latestMessage, priorAssistantMessage = null, state = null, credentials, messageId = null,
  timeoutMs, attempts = 2, evaluate } = {}) {
  const started = Date.now();
  let req;
  try {
    const candidates = buildCandidates(latestMessage);
    req = buildMc1Request({ latestMessage, priorAssistantMessage, state, candidates });
    if (!credentials || !credentials.accountId || !credentials.apiToken) {
      throw new JevError('Jev credentials are not configured', { category: 'CONFIG' });
    }
    const run = _evaluateForTest || evaluate || evaluateJevWithRetries;
    const res = await run({
      accountId: credentials.accountId, apiToken: credentials.apiToken, gatewayId: credentials.gatewayId,
      state: req.state, questions: req.questions, timeoutMs, attempts,
    });
    const out = adaptMc1Answers(res && res.answers, req.plan, { messageId });
    out.meta.jev = { ok: true, model: res && res.model, latencyMs: res && res.latencyMs, usage: (res && res.usage) || null };
    out.meta.candidateCounts = { identifiers: candidates.identifiers.length, brands: candidates.brands.length, components: candidates.components.length };
    out.meta.ms = Date.now() - started;
    return out;
  } catch (e) {
    const d = degradedClassification(messageId, String((e && e.category) || 'ERROR'));
    d.meta.jev = { ok: false, error: String((e && e.category) || (e && e.message) || e).slice(0, 80) };
    d.meta.questionCount = req ? req.plan.questionKeys.length : 0;
    d.meta.ms = Date.now() - started;
    return d;
  }
}

module.exports = { classifyLatestMessage, _setMc1EvaluateForTest };
