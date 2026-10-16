'use strict';
/**
 * The customer turn at the BFF: load the conversation's record (ac3/1), send the turn to the diagnosis engine
 * (signed, `mode: 'turn'`), persist the new record, and turn the engine's structured response into the customer view.
 *
 * The engine's turn (ac2/turn.js) is the whole decision path: there is no other hop. A turn the engine could not
 * answer (advisor unavailable, timeout) is an explicit error: the state is not advanced and the customer sees the
 * "temporarily unavailable" reply with a retry. Nothing else answers it.
 */
const ac2State = require('./ac2-state');

const ENGINE_TIMEOUT_MS = Number(process.env.AC2_ENGINE_TIMEOUT_MS || 45000);

/** The engine's structured response, in the shape toWhichPartView projects for the browser. */
function orchShape(r) {
  return {
    route: 'AC2',
    outcome: r.outcome === 'SAFETY_STOP' ? 'SAFETY_STOP' : 'ANSWER',
    message: r.message || '',
    parts: r.parts || null,
    resolvedModel: r.resolvedModel || null,
    safety: r.safety || null,
    safetyInformation: r.safetyInformation || null,
    media: r.media || null,
  };
}

const AUDIT_SCHEMA = 'ac2-transcript-audit/2';

/**
 * Bounded audit for transcripts and the admin: the turn, provider, timings, token usage, the tools the advisor
 * called, safety (hazards and the gates that fired), the part decision, escalation, the advisor's outcome and
 * tags, and what the record now knows about the customer's appliance. No customer text, no model reasoning.
 */
function auditOf(out, extra = {}) {
  const a = out && out.audit ? out.audit : {};
  const st = out && out.state ? out.state : null;
  const c = (st && st.customer) || {};
  return {
    schemaVersion: AUDIT_SCHEMA,
    path: 'ac2',
    turn: a.turn || null,
    provider: a.provider || null,
    timings: a.timings || null,
    usage: a.usage || null,
    toolCalls: Array.isArray(a.toolCalls) ? a.toolCalls.map(String).slice(0, 12) : [],
    safety: a.safety || null,
    partGate: a.partGate || null,
    escalation: a.escalation || null,
    outcome: (st && st.outcome) || (a.tags && a.tags.outcome) || null,
    customer: { appliance: c.appliance || null, brand: c.brand || null, model: c.model || null },
    hazards: Array.isArray(st && st.hazards) ? st.hazards.filter((h) => h && !h.cleared).map((h) => h.type) : [],
    tags: a.tags || null,
    ...extra,
  };
}

/**
 * deps: { callEngine(rawBody, timeoutMs) -> {status, json}, secretsLoader, store, recallLookup? }
 * -> { orch, token, audit, response, ms, session }  or  { error, token?, ms?, session? }
 * `session`: { fresh, rejected } — whether this turn started a new conversation state, and why a presented token was
 * not accepted (for the admin Live Test continuity status; never the token or the csid).
 */
async function handle({ body, messages }, deps) {
  const secrets = await deps.secretsLoader().catch(() => null);
  const sess = ac2State.session(body, secrets);
  if (sess.error) return { error: sess.error };
  const session = { fresh: sess.fresh, rejected: sess.rejected || null };
  const store = deps.store;
  const loaded = sess.fresh ? { status: 'missing', state: null, version: 0 } : await store.load(sess.csid);
  if (loaded.status === 'error') return { error: 'state_load_failed', token: sess.token, session };
  const prior = loaded.status === 'ok' ? loaded.state : null;
  // A stale record (an earlier engine version) is replaced: the next write is conditioned on its version.
  const priorVersion = prior ? prior.turn : (loaded.status === 'stale' ? loaded.version : 0);

  let recalls = [];
  try { recalls = deps.recallLookup ? await deps.recallLookup(messages) : []; } catch { recalls = []; }
  const raw = JSON.stringify({ mode: 'turn', messages, ac2: { state: prior, tools: { recalls } } });
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

module.exports = { handle, orchShape, auditOf, AUDIT_SCHEMA };
