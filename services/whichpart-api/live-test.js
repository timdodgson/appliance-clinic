'use strict';
/**
 * Admin Live Test over the REAL customer diagnose path (POST /api): every turn is an ac2 turn (ADR 0020).
 *
 * The Admin workbench sends exactly what the customer browser sends — `messages` (the same
 * ACChatSession window) and the opaque `stateToken` it was last given — plus one extra
 * `liveTest` object. That object only:
 *   - requires an authenticated ADMIN session (fail-closed 401, before the engine is called);
 *   - carries the test conversation's id (`lt-…`, distinguishable from customer ids in the logs), WITHOUT the
 *     observability object, so no customer transcript is ever written for a test;
 *   - asks the BFF to attach a bounded continuity status and the turn's ac2 audit to the response.
 *
 * The status never contains the token or the server-side session id. It reports whether a token came in, whether one
 * went out, and what the BFF's own token verification did with it (the same ac2-state session every customer turn
 * uses).
 */
const transcripts = require('./transcripts.js');

// Admin Live Test conversation ids are distinguishable from customer browser ids in the logs.
const LIVE_SESSION_RE = /^lt-[A-Za-z0-9._-]{8,76}$/;

/**
 * Strip and validate `body.liveTest`. Returns null when absent (a normal customer request).
 * { ok:false, error } for a malformed object; { ok:true, sessionId } otherwise.
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
  return { ok: true, sessionId };
}

/** Did the request carry a prior state token (any non-empty string — validity is the BFF's call)? */
function stateInOf(body) {
  return body && typeof body.stateToken === 'string' && body.stateToken.length ? 'present' : 'absent';
}

/**
 * Continuity status for one Live Test turn, from the ac2 turn result (ac2-turn.handle).
 *   stateIn:    present | absent
 *   stateOut:   refreshed (same session) | issued (new session) | none
 *   continuity: new | continued | restarted (a presented token was not accepted) | failed (the turn was not answered;
 *               the state was not advanced) | unavailable (no token could be issued)
 *   reason:     the token rejection reason or the turn's error code (never the token)
 */
function status({ stateIn, result }) {
  const r = result || {};
  const session = r.session || null;
  const tokenOut = Boolean(r.token);
  const stateOut = !tokenOut ? 'none' : (session && !session.fresh ? 'refreshed' : 'issued');
  let continuity;
  let reason = null;
  if (session && session.rejected) { continuity = 'restarted'; reason = session.rejected; }
  else if (!tokenOut) { continuity = 'unavailable'; reason = r.error || 'no_token_issued'; }
  else if (r.error) { continuity = 'failed'; reason = r.error; }
  else continuity = session && !session.fresh ? 'continued' : 'new';
  return {
    schema: 'live-test/2',
    engine: 'ac2',
    ok: !r.error,
    stateIn,
    stateOut,
    continuity,
    reason,
    audit: r.audit || null,
  };
}

module.exports = { LIVE_SESSION_RE, takeLiveTest, stateInOf, status };
