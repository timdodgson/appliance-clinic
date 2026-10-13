'use strict';
/**
 * The customer turn at the BFF: load the conversation's record (ac3/1), send the turn to the diagnosis engine
 * (signed, `mode: 'turn'`), persist the new record, and turn the engine's structured response into the customer view.
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

/** Bounded audit for transcripts and the admin: timings, safety, part decision, the record's customer facts and this
 * turn's tags (Jev labels with confidence, stage, what the reply did, media, enrichment used). */
function auditOf(out, extra = {}) {
  const a = out && out.audit ? out.audit : {};
  const st = out && out.state ? out.state : null;
  const c = st && st.customer ? st.customer : null;
  return {
    schemaVersion: 'ac2-transcript-audit/1',
    path: 'ac2',
    turn: a.turn || null,
    provider: a.provider || null,
    timings: a.timings || null,
    usage: a.usage || null,
    toolCalls: [],
    safety: a.safety || null,
    claimsRejected: [],
    claimsChecked: 0,
    regenerated: false,
    partGate: a.partGate || null,
    escalation: a.escalation || null,
    status: st ? (st.outcome || `stage_${st.stage}`) : null,
    candidates: [],
    scope: a.scope || null,
    tags: a.tags || null,
    plan: a.plan || null,
    ledger: c ? {
      appliance: c.appliance, brand: c.brand, model: c.model, codes: c.codes,
      facts: (c.checks || []).map((k, i) => ({ id: `c${i + 1}`, field: 'check', value: `${k.check}: ${k.result || 'done'}`, source: 'customer', status: 'stated', turn: k.turn, quote: null })),
      asked: (st.asked || []).map((q) => ({ key: null, text: q.question, turn: q.turn, resolution: q.answer || null })), hazards: st.hazards || [],
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
