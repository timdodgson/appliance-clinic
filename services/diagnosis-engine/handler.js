'use strict';
/**
 * Appliance Clinic diagnosis engine (Lambda `applianceclinic-diagnosis-engine`).
 *
 * Every request comes from an Appliance Clinic service (the orchestrator, or whichpart-api for feedback and health) and
 * carries the AC engine signature (ADR 0017) over an AWS_IAM-authenticated Function URL. There is no anonymous or
 * unsigned request path (ADR 0019).
 *
 *   GET  /health                              read-only runtime health
 *   POST {feedback}                           a customer's rating of an earlier reply
 *   POST {mode:'understand', messages, canonical?, established?}
 *        -> Jev typed understanding + the token decision; with a cs/1 block: mc/1 -> merge -> journey routing ->
 *           deterministic diagnostics / safety / policy / part gate -> the typed NextAction (canonical-runtime.js)
 *   POST {messages, canonical}                COMPOSE words the NextAction of the journey that controls the turn
 *
 * Responses are JSON lines (AC-internal): {type:'understand'} for understand mode; {type:'delta'} then {type:'done'}
 * for a canonical reply. A turn no journey controls is refused (409); the orchestrator never sends one.
 */

const { loadAdminInference } = require('./admin-config.js');
const { publicObservability } = require('./jev-understand.js');
const health = require('./health.js');
const { ensureMediaOverlay, getMediaOverlayCache, getEffectiveMediaJoin, describeMediaBaseline, countJoinIdentities,
  selectMedia, MEDIA_OVERLAY_TTL_MS } = require('./media.js');
const { outputTripwire } = require('./security.js');
const { gateInternalFields } = require('./engine-auth.js');
const { LM_TEMPERATURE, LM_TIMEOUT_MS, LM_REPEAT_PENALTY, getProviders, _setProvidersForTest, MAX_MESSAGES,
  MAX_BODY_BYTES } = require('./engine/config.js');
const { CATALOGUE, matchesComponent, COMPONENT_MENTION } = require('./engine/catalogue.js');
const { stripInstructionEcho, stripOutOfScopeElectricalTests, stripOwnerInternalElectricalInspection,
  constrainReplacementLanguage } = require('./engine/reply-filters.js');
const { conversationProgress, previouslyShownMedia } = require('./engine/conversation.js');
const { getPartsForModel } = require('./engine/parts-client.js');
const { logFeedback, log, rand } = require('./engine/learning-log.js');
const { understand, degradedIntent } = require('./engine/understand.js');
const tokenGate = require('./canonical/token-gate.js');
const canonicalRuntimeMod = require('./canonical-runtime.js');
const ac2 = require('./ac2/runtime.js');

const json = (statusCode, obj) => ({ statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(obj) });
const lines = (events) => ({ statusCode: 200, headers: { 'Content-Type': 'application/x-ndjson' },
  body: events.map((e) => JSON.stringify(e)).join('\n') + '\n' });

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
      media: { ensureMediaOverlay, getEffectiveMediaJoin, previouslyShownMedia, selectMedia },
    });
  }
  return _canonicalRuntime;
}

async function understandTurn(body, messages, requestId, metric) {
  const t = Date.now();
  // mc/1 (its own Jev evaluation) starts in parallel with the Jev understanding pass and is awaited after it.
  const canonicalStarted = canonicalRuntime().beginUnderstand(body, messages, requestId);
  let uIntent;
  try {
    uIntent = await understand(messages, body.established);
    metric.jevInvoked = 1;
  } catch (e) {
    // An understanding failure is reported as such (the orchestrator turns it into an explicit error, ADR 0016).
    uIntent = degradedIntent();
    metric.jevInvoked = 0;
    metric.jevError = String((e && e.category) || (e && e.message) || e);
  }
  metric.understandMs = Date.now() - t;
  metric.mode = 'understand';
  metric.jev = publicObservability(uIntent);
  // The token commit decision (canonical/token-gate.js, the only implementation) gates the cs/1 merge, and the
  // orchestrator routes on it (uIntent.tokenDecision) instead of recomputing the thresholds.
  const tokenSignal = tokenGate.jevTokenSignal(uIntent, metric.jev);
  const canonicalTransport = await canonicalRuntime().finishUnderstand(canonicalStarted, tokenSignal);
  const held = canonicalTransport && canonicalTransport.tokenDecision === 'held' && canonicalTransport.classification
    && canonicalTransport.classification.identity ? canonicalTransport.classification.identity.unconfirmedToken : null;
  uIntent.tokenDecision = tokenGate.tokenDecision(tokenSignal, held);
  if (canonicalTransport) metric.canonicalTransport = canonicalRuntimeMod.transportMetric(canonicalTransport);
  return lines([{ type: 'understand', understand: uIntent, jev: metric.jev, ...(canonicalTransport ? { canonical: canonicalTransport } : {}) }]);
}

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

  let messages = body.messages;
  if (!Array.isArray(messages) || messages.length === 0) return json(400, { error: 'messages array required' });
  if (messages.length > MAX_MESSAGES) messages = messages.slice(-MAX_MESSAGES);
  const seed = Number.isInteger(body.seed) ? body.seed : undefined;
  const metric = { evt: 'diagnosis-engine', requestId, msgCount: messages.length };

  try {
    if (body.mode === 'turn') {
      // ac2: LLM-led diagnosis inside the deterministic guardrail kernel (ac2/turn.js).
      try {
        const out = await ac2.turn({ messages, state: body.ac2 && body.ac2.state, tools: body.ac2 && body.ac2.tools, image: body.image || null });
        metric.mode = 'turn';
        metric.ac2 = out.audit;
        metric.totalMs = Date.now() - started; metric.ok = true; log(metric);
        return json(200, { type: 'ac2', response: out.response, state: out.state, audit: out.audit });
      } catch (e) {
        if (e && e.name === 'ProviderUnavailableError') {
          metric.ok = false; metric.mode = 'turn'; metric.error = `provider_unavailable:${e.category}`; metric.providerStatus = e.status; metric.providerDetail = e.detail;
          metric.totalMs = Date.now() - started; log(metric);
          return json(503, { error: 'Diagnosis is temporarily unavailable.', errorCode: 'reasoner_unavailable' });
        }
        throw e;
      }
    }
    if (body.mode === 'understand') {
      const res = await understandTurn(body, messages, requestId, metric);
      metric.totalMs = Date.now() - started; metric.ok = true; log(metric);
      return res;
    }
    // ADR 0018: a diagnose call is answered only by the canonical journey that controls it.
    if (!canonicalRuntime().controls(body.canonical)) {
      log({ evt: 'engine-auth', requestId, signature: 'valid', rejected: true, reason: 'canonical_not_controlled' });
      return json(409, { error: 'No canonical journey controls this turn.', errorCode: 'canonical_not_controlled' });
    }
    const r = await canonicalRuntime().respond({ canonical: body.canonical, messages, requestId, seed });
    metric.canonicalControl = r.metric;
    metric.totalMs = Date.now() - started; metric.ok = true; log(metric);
    return lines([{ type: 'delta', text: r.reply }, r.done]);
  } catch (err) {
    metric.ok = false;
    metric.error = String((err && err.message) || err).slice(0, 200);
    if (err && err.name === 'JevError') metric.jev = { invoked: true, ok: false, category: err.category, status: err.status || null };
    metric.totalMs = Date.now() - started;
    log(metric);
    return json(503, { error: 'Diagnosis service unavailable.', errorCode: 'engine_unavailable' });
  }
};

// The runtime as wired here (catalogue, matcher, COMPOSE helpers), for tests that drive the real wiring.
exports._internal = {
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
  _setProvidersForTest,
};
