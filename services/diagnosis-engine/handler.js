'use strict';
/**
 * Appliance Clinic diagnosis engine (Lambda `applianceclinic-diagnosis-engine`).
 *
 * Every request comes from whichpart-api and carries the AC engine signature (ADR 0017) over an AWS_IAM-authenticated
 * Function URL. There is no anonymous or unsigned request path (ADR 0019).
 *
 *   GET  /health                              read-only runtime health
 *   POST {feedback}                           a customer's rating of an earlier reply
 *   POST {mode:'turn', messages, ac2, image?} one customer turn: the LLM-led reasoner inside the deterministic
 *                                             guardrail kernel (ac2/turn.js, ADR 0020). There is no other diagnose path.
 *
 * Responses are JSON (AC-internal): {type:'ac2', response, state, audit} for a turn. Any other request is refused (400).
 */

const { loadAdminInference } = require('./admin-config.js');
const health = require('./health.js');
const { ensureMediaOverlay, getMediaOverlayCache, getEffectiveMediaJoin, describeMediaBaseline, countJoinIdentities,
  MEDIA_OVERLAY_TTL_MS } = require('./media.js');
const { gateInternalFields } = require('./engine-auth.js');
const { _setProvidersForTest, MAX_MESSAGES, MAX_BODY_BYTES } = require('./engine/config.js');
const { logFeedback, log, rand } = require('./engine/learning-log.js');
const ac2 = require('./ac2/runtime.js');

const json = (statusCode, obj) => ({ statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(obj) });

exports.handler = async (event) => {
  const started = Date.now();
  const requestId = (event && event.requestContext && event.requestContext.requestId) || rand();

  const healthHit = await health.handle(event, {
    describeMediaBaseline, ensureMediaOverlay, getMediaOverlayCache, getEffectiveMediaJoin, countJoinIdentities,
    overlayTtlMs: MEDIA_OVERLAY_TTL_MS, loadAdminInference,
  });
  if (healthHit) return json(healthHit.status, healthHit.body);

  const rawBody = (event && event.body) || '{}';
  if (Buffer.byteLength(rawBody) > MAX_BODY_BYTES) return json(413, { error: 'Request too large.' });
  let body;
  try { body = JSON.parse(rawBody); } catch { return json(400, { error: 'Invalid JSON' }); }
  if (!body || typeof body !== 'object') return json(400, { error: 'Invalid request' });

  // ADR 0017 / 0019: every request carries the AC engine signature over its exact body.
  const gate = gateInternalFields(body, event, rawBody);
  if (gate.record.signature !== 'valid') {
    log({ evt: 'engine-auth', requestId, signature: gate.record.signature, fields: gate.record.present, rejected: true });
    return json(401, { error: 'This request needs a valid engine signature.', errorCode: 'engine_signature_required' });
  }

  if (body.feedback) {
    await logFeedback(body.feedback);
    return json(200, { ok: true });
  }

  // ac2 (ADR 0020) is the only diagnose path: a request that is not feedback or health must be a turn.
  if (body.mode !== 'turn') return json(400, { error: 'Unsupported request.', errorCode: 'unsupported_request' });
  let messages = body.messages;
  if (!Array.isArray(messages) || messages.length === 0) return json(400, { error: 'messages array required' });
  if (messages.length > MAX_MESSAGES) messages = messages.slice(-MAX_MESSAGES);
  const metric = { evt: 'diagnosis-engine', requestId, msgCount: messages.length, mode: 'turn' };

  try {
    // LLM-led diagnosis inside the deterministic guardrail kernel (ac2/turn.js).
    const control = body.ac2 && body.ac2.control === 'qwen-plain' ? 'qwen-plain' : null;
    const out = control ? await ac2.plain({ messages, state: body.ac2 && body.ac2.state }) : await ac2.turn({ messages, state: body.ac2 && body.ac2.state, tools: body.ac2 && body.ac2.tools, image: body.image || null });
    metric.ac2 = out.audit;
    metric.totalMs = Date.now() - started; metric.ok = true; log(metric);
    return json(200, { type: 'ac2', response: out.response, state: out.state, audit: out.audit });
  } catch (err) {
    metric.ok = false;
    metric.totalMs = Date.now() - started;
    if (err && err.name === 'ProviderUnavailableError') {
      metric.error = `provider_unavailable:${err.category}`; metric.providerStatus = err.status; metric.providerDetail = err.detail;
      log(metric);
      return json(503, { error: 'Diagnosis is temporarily unavailable.', errorCode: 'reasoner_unavailable' });
    }
    metric.error = String((err && err.message) || err).slice(0, 200);
    log(metric);
    return json(503, { error: 'Diagnosis service unavailable.', errorCode: 'engine_unavailable' });
  }
};

// Test seam: inject the resolved inference providers.
exports._internal = { _setProvidersForTest };
