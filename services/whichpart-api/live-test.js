'use strict';
/**
 * Admin Live Test over the REAL customer diagnose path (POST /api).
 *
 * The Admin workbench sends exactly what the customer browser sends — `messages` (the same
 * ACChatSession window) and the opaque canonical `stateToken` it was last given — plus one extra
 * `liveTest` object. That object only:
 *   - requires an authenticated ADMIN session (fail-closed 401, before any orchestrator call);
 *   - carries the per-conversation keys the customer client sends inside `observability`
 *     (`sessionId` → orchestrator ConversationState key, `clientTurnId` → canonical idempotency),
 *     WITHOUT the observability object, so no customer transcript is ever written for a test;
 *   - asks the BFF to attach a bounded continuity status to the response.
 *
 * The status never contains the token, the csid or the canonical state body. It reports whether a
 * token came in, whether one went out, and what the BFF's own token verification and canonical
 * persistence did with it (the same `prepareTurn` path every customer turn uses).
 */
const transcripts = require('./transcripts.js');
const conversationState = require('./conversation-state.js');

// Admin Live Test conversation ids are distinguishable from customer browser ids in orchestrator logs.
const LIVE_SESSION_RE = /^lt-[A-Za-z0-9._-]{8,76}$/;

/**
 * Strip and validate `body.liveTest`. Returns null when absent (a normal customer request).
 * { ok:false, error } for a malformed object; { ok:true, sessionId, clientTurnId } otherwise.
 */
function takeLiveTest(body) {
  if (!body || typeof body !== 'object' || !Object.prototype.hasOwnProperty.call(body, 'liveTest')) return null;
  const raw = body.liveTest;
  delete body.liveTest;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, error: 'liveTest must be an object' };
  // A live test never writes customer transcripts: refuse a mixed request rather than guess.
  if (Object.prototype.hasOwnProperty.call(body, 'observability')) return { ok: false, error: 'liveTest requests must not send observability' };
  const sessionId = typeof raw.sessionId === 'string' ? raw.sessionId : '';
  if (!LIVE_SESSION_RE.test(sessionId) || !transcripts.isValidSessionId(sessionId)) return { ok: false, error: 'liveTest.sessionId invalid' };
  const clientTurnId = raw.clientTurnId == null ? null : raw.clientTurnId;
  if (clientTurnId !== null && !transcripts.isValidTurnId(clientTurnId)) return { ok: false, error: 'liveTest.clientTurnId invalid' };
  return { ok: true, sessionId, clientTurnId };
}

/** Did the request carry a prior state token (any non-empty string — validity is the BFF's call)? */
function stateInOf(body) {
  return body && typeof body.stateToken === 'string' && body.stateToken.length ? 'present' : 'absent';
}

/**
 * Continuity status for one Live Test turn.
 *   stateIn:    present | absent
 *   stateOut:   refreshed (same session re-issued) | issued (new session) | none
 *   continuity: new | continued | replayed | restarted | degraded | unavailable | off
 *   reason:     the BFF's token / state reason when not a clean continue (never the token)
 */
/**
 * Bounded projection of the MERGED canonical state after this turn (what the conversation now
 * knows), for proving retention. Values the customer supplied, never the state body itself.
 */
function retainedFrom(state) {
  if (!state || typeof state !== 'object') return null;
  const id = state.identity || {};
  const fact = (f) => (f && typeof f === 'object' && f.value != null ? f.value : null);
  const problems = Array.isArray(state.problems) ? state.problems : [];
  const live = problems.filter((p) => p && p.status !== 'resolved');
  const active = live.length ? live[live.length - 1] : null;
  const ev = state.evidence || {};
  return {
    appliance: fact(id.appliance),
    make: fact(id.make),
    model: fact(id.model) != null,
    modelStatus: id.modelStatus || null,
    problem: active ? { journey: (active.journey && typeof active.journey === 'object' ? active.journey.value : active.journey) || null, status: active.status || null } : null,
    problemCount: problems.length,
    observations: Object.keys(ev.observations || {}).slice(0, 12),
    checks: Object.keys(ev.checks || {}).slice(0, 12),
    turns: Number.isFinite(state.version) ? state.version : null,
  };
}

function status({ stateIn, ctx, summary, tokenOut, path, mergedState }) {
  const mode = (ctx && ctx.mode) || 'off';
  const degraded = (summary && summary.degraded) || (ctx && ctx.degraded) || null;
  const tokenRejected = typeof (ctx && ctx.degraded) === 'string' && ctx.degraded.indexOf('token_') === 0;
  let stateOut = 'none';
  if (tokenOut) stateOut = stateIn === 'present' && !tokenRejected ? 'refreshed' : 'issued';
  let continuity;
  let reason = null;
  if (mode === 'off') continuity = 'off';
  else if (tokenRejected) { continuity = 'restarted'; reason = ctx.degraded.slice('token_'.length); }
  else if (!tokenOut) { continuity = 'unavailable'; reason = degraded || 'no_token_issued'; }
  else if (ctx && ctx.duplicate) continuity = 'replayed';
  else if (degraded) { continuity = 'degraded'; reason = degraded; }
  else continuity = stateIn === 'present' ? 'continued' : 'new';
  const journey = summary && summary.journey ? {
    key: summary.journey.key || null,
    applies: summary.journey.applies,
    control: summary.journey.control,
    nextAction: summary.journey.nextAction ? {
      kind: summary.journey.nextAction.kind || null,
      rule: summary.journey.nextAction.rule || null,
      target: summary.journey.nextAction.target || null,
    } : null,
  } : null;
  return {
    schema: 'live-test/1',
    stateIn,
    stateOut,
    continuity,
    reason,
    path: path || 'orchestrator',
    canonical: mode === 'off' ? { mode: 'off' } : {
      mode,
      // Safe correlation id (sha256 of the server-side csid, 12 hex) — lineage, not a credential.
      ref: ctx && ctx.csid ? conversationState.sessionRef(ctx.csid) : null,
      priorVersion: summary ? summary.priorVersion : (ctx && ctx.block ? ctx.version : null),
      resultVersion: summary ? summary.resultVersion : null,
      stateWritten: Boolean(summary && summary.persistence && summary.persistence.stateWritten),
      recovered: Boolean(ctx && ctx.recovered),
      journey,
      understood: summary && summary.mc1 ? {
        appliance: summary.mc1.appliance, make: summary.mc1.make, model: summary.mc1.model, journey: summary.mc1.journey,
        observations: summary.mc1.observations, checks: summary.mc1.checks,
      } : null,
      retained: retainedFrom(mergedState),
      degraded,
    },
  };
}

module.exports = { LIVE_SESSION_RE, takeLiveTest, stateInOf, status, retainedFrom };
