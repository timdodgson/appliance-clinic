'use strict';
/**
 * The ac2 customer turn at the BFF: load the conversation's evidence ledger, send the turn to the diagnosis engine
 * (signed, `mode: 'turn'`), persist the new ledger, and turn the engine's structured response into the customer view.
 *
 * The engine's turn pipeline is the orchestration (ac2/turn.js): there is no separate orchestrator hop on this path.
 * A turn the engine could not answer (reasoner unavailable, timeout) is an explicit error: the state is not
 * advanced and the customer sees the "temporarily unavailable" reply with a retry. Nothing else answers it.
 */
const ac2State = require('./ac2-state');

const ENGINE_TIMEOUT_MS = Number(process.env.AC2_ENGINE_TIMEOUT_MS || 28000);

/** The engine's structured response, in the shape toWhichPartView projects for the browser. */
function orchShape(r) {
  return {
    route: 'AC2',
    outcome: r.outcome === 'SAFETY_STOP' ? 'SAFETY_STOP' : 'ANSWER',
    message: r.message || '',
    codeResult: r.codeResult || null,
    diagnosis: r.diagnosis || null,
    suggestedChecks: [],
    componentMention: r.parts && r.parts.length ? 'purchase' : 'none',
    parts: r.parts || null,
    resolvedModel: r.resolvedModel || null,
    modelRequired: Boolean(r.modelRequired),
    safety: r.safety || null,
    safetyInformation: r.safetyInformation || null,
    media: r.media || null,
    traceId: null,
  };
}

/** Bounded, chain-of-thought-free audit for transcripts and the admin (no ledger quotes beyond what the customer typed). */
function auditOf(out, extra = {}) {
  const a = out && out.audit ? out.audit : {};
  const st = out && out.state ? out.state : null;
  return {
    schemaVersion: 'ac2-transcript-audit/1',
    path: 'ac2',
    turn: a.turn || null,
    provider: a.provider || null,
    timings: a.timings || null,
    usage: a.usage || null,
    toolCalls: a.toolCalls || [],
    safety: a.safety || null,
    claimsRejected: (a.claims && a.claims.rejected) || [],
    claimsChecked: (a.claims && a.claims.checked) || 0,
    regenerated: Boolean(a.regenerated),
    partGate: a.partGate || null,
    escalation: a.escalation || null,
    status: a.status || null,
    candidates: a.candidates || [],
    scope: a.scope || null,
    ledger: st ? {
      appliance: st.appliance, brand: st.brand, model: st.model, codes: st.codes,
      facts: (st.facts || []).map((f) => ({ id: f.id, field: f.field, value: f.value, source: f.source, status: f.status, turn: f.turn, quote: f.quote || null })),
      asked: st.asked, hazards: st.hazards || [],
    } : null,
    ...extra,
  };
}

/**
 * deps: { callEngine(rawBody, timeoutMs) -> {status, json}, secretsLoader, store, recallLookup? }
 * -> { orch, token, audit, response, ms, session }  or  { error, token?, ms?, session? }
 * `session`: { fresh, rejected } — whether this turn started a new conversation state, and why a presented token was
 * not accepted (for the admin Live Test continuity status; never the token or the csid).
 */
async function handle({ body, messages, image }, deps) {
  const secrets = await deps.secretsLoader().catch(() => null);
  const sess = ac2State.session(body, secrets);
  if (sess.error) return { error: sess.error };
  const session = { fresh: sess.fresh, rejected: sess.rejected || null };
  const store = deps.store;
  const loaded = sess.fresh ? { status: 'missing', state: null, version: 0 } : await store.load(sess.csid);
  if (loaded.status === 'error') return { error: 'state_load_failed', token: sess.token, session };
  const prior = loaded.status === 'ok' ? loaded.state : null;
  const priorVersion = prior ? prior.turn : 0;

  let recalls = [];
  try { recalls = deps.recallLookup ? await deps.recallLookup(messages) : []; } catch { recalls = []; }
  const raw = JSON.stringify({ mode: 'turn', messages, ac2: { state: prior, tools: { recalls } }, ...(image ? { image } : {}) });
  const t0 = Date.now();
  let res;
  try {
    res = await deps.callEngine(raw, ENGINE_TIMEOUT_MS);
  } catch (e) {
    return { error: 'engine_unreachable', token: sess.token, ms: Date.now() - t0, session };
  }
  if (!res || res.status !== 200 || !res.json || res.json.type !== 'ac2') {
    return { error: res && res.json && res.json.errorCode ? res.json.errorCode : `engine_http_${res ? res.status : 0}`, token: sess.token, ms: Date.now() - t0, session };
  }
  const out = res.json;
  const saved = await store.save(sess.csid, out.state, priorVersion);
  if (!saved.ok) return { error: `state_save_${saved.reason}`, token: sess.token, ms: Date.now() - t0, session };
  const orch = orchShape(out.response || {});
  return { orch, token: sess.token, audit: auditOf(out, { ms: Date.now() - t0 }), response: out.response, ms: Date.now() - t0, session };
}

module.exports = { handle, orchShape, auditOf };
