'use strict';
/**
 * Service-authenticated benchmark request contract for the customer diagnose path (POST /api).
 *
 * Batch/test runners need what the customer browser sends through `observability` — a stable
 * per-conversation session id (orchestrator conversation identity) and a per-turn clientTurnId
 * (canonical idempotency) — WITHOUT writing a customer transcript and without an interactive Admin
 * session (`liveTest` is admin-cookie only). This module is the smallest scoped mechanism for that:
 *
 *   body.benchmark = { sessionId: "bm-…", clientTurnId: "bt-…" }
 *   header x-benchmark-signature: "v1.<unixSeconds>.<base64url HMAC-SHA256>"
 *     HMAC key  = the benchmark service secret (Secrets Manager
 *                 spares4repairs/<stage>/applianceclinic-benchmark-service, JSON {current, previous};
 *                 env BENCHMARK_SERVICE_SECRET[_PREVIOUS] overrides, as state-token.js does)
 *     HMAC data = "acq-bench/v1." + unixSeconds + "." + sha256hex(exact raw request body)
 *
 * The secret never travels: only a signature bound to the exact body and a ±5 minute timestamp.
 * Verification is constant-time and fails CLOSED (no secret configured → every benchmark request is
 * rejected). A `benchmark` object without a valid signature is rejected (401), never ignored. The
 * signature grants nothing else: it is not an Admin session and cannot be combined with `liveTest`
 * or `observability`. The `x-acq-benchmark` marker header remains untrusted and unused for auth.
 */

const crypto = require('crypto');
const transcripts = require('./transcripts');

const HEADER = 'x-benchmark-signature';
const SIG_VERSION = 'v1';
const MAX_SKEW_SECONDS = 300;
const MIN_SECRET_LENGTH = 32;
const CACHE_MS = 5 * 60 * 1000;
const NEGATIVE_CACHE_MS = 60 * 1000;
const SESSION_RE = /^bm-[A-Za-z0-9._-]{8,76}$/;
const TURN_RE = /^bt-[A-Za-z0-9._-]{4,76}$/;
const SIG_RE = /^v1\.(\d{9,11})\.([A-Za-z0-9_-]{43})$/;

function sha256hex(s) { return crypto.createHash('sha256').update(String(s == null ? '' : s), 'utf8').digest('hex'); }
function mac(secret, ts, rawBody) {
  return crypto.createHmac('sha256', secret).update('acq-bench/v1.' + ts + '.' + sha256hex(rawBody)).digest('base64url');
}

/** Runner side: the header value for this exact body. */
function signRequest(secret, rawBody, { nowSec = Math.floor(Date.now() / 1000) } = {}) {
  if (typeof secret !== 'string' || secret.length < MIN_SECRET_LENGTH) throw new Error('benchmark service secret unavailable');
  return SIG_VERSION + '.' + nowSec + '.' + mac(secret, nowSec, rawBody);
}

/**
 * BFF side. Returns { ok:true } or { ok:false, reason } where reason is one of
 * missing | malformed | stale | bad_signature | no_secret. Never throws, never echoes the secret.
 */
function verifyRequest(header, rawBody, secrets, { nowSec = Math.floor(Date.now() / 1000) } = {}) {
  if (!secrets || typeof secrets.current !== 'string' || secrets.current.length < MIN_SECRET_LENGTH) return { ok: false, reason: 'no_secret' };
  if (typeof header !== 'string' || !header) return { ok: false, reason: 'missing' };
  const m = SIG_RE.exec(header);
  if (!m) return { ok: false, reason: 'malformed' };
  const ts = Number(m[1]);
  if (!Number.isFinite(ts) || Math.abs(nowSec - ts) > MAX_SKEW_SECONDS) return { ok: false, reason: 'stale' };
  const given = Buffer.from(m[2]);
  const candidates = [secrets.current, secrets.previous].filter((s) => typeof s === 'string' && s.length >= MIN_SECRET_LENGTH);
  let matched = false;
  for (const s of candidates) {
    const want = Buffer.from(mac(s, m[1], rawBody));
    if (want.length === given.length && crypto.timingSafeEqual(want, given)) matched = true; // no early exit
  }
  return matched ? { ok: true } : { ok: false, reason: 'bad_signature' };
}

/**
 * Strip and shape-check `body.benchmark`. null when absent (a normal customer request).
 * { ok:false, error } for a malformed object or a mixed request; { ok:true, sessionId, clientTurnId }.
 * Shape errors are only reported AFTER authentication succeeded (the caller checks auth first).
 */
function takeBenchmark(body) {
  if (!body || typeof body !== 'object' || !Object.prototype.hasOwnProperty.call(body, 'benchmark')) return null;
  const raw = body.benchmark;
  delete body.benchmark;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, error: 'benchmark must be an object' };
  const extra = Object.keys(raw).filter((k) => k !== 'sessionId' && k !== 'clientTurnId');
  if (extra.length) return { ok: false, error: 'benchmark accepts only sessionId and clientTurnId' };
  if (Object.prototype.hasOwnProperty.call(body, 'observability')) return { ok: false, error: 'benchmark requests must not send observability' };
  if (Object.prototype.hasOwnProperty.call(body, 'liveTest')) return { ok: false, error: 'benchmark requests must not send liveTest' };
  const sessionId = typeof raw.sessionId === 'string' ? raw.sessionId : '';
  if (!SESSION_RE.test(sessionId) || !transcripts.isValidSessionId(sessionId)) return { ok: false, error: 'benchmark.sessionId invalid' };
  const clientTurnId = raw.clientTurnId == null ? null : raw.clientTurnId;
  if (clientTurnId !== null && (typeof clientTurnId !== 'string' || !TURN_RE.test(clientTurnId) || !transcripts.isValidTurnId(clientTurnId))) return { ok: false, error: 'benchmark.clientTurnId invalid' };
  return { ok: true, sessionId, clientTurnId };
}

/** Safe log/response reference for a benchmark session id (never the id itself). */
function sessionRef(sessionId) {
  return sessionId ? crypto.createHash('sha256').update('bm-ref:' + sessionId).digest('hex').slice(0, 12) : null;
}

function headerOf(event, name) {
  const h = (event && event.headers) || {};
  const k = Object.keys(h).find((x) => x.toLowerCase() === name);
  return k ? h[k] : null;
}
/** The exact raw request body the signature was computed over. */
function rawBodyOf(event) {
  const b = (event && event.body) || '';
  return event && event.isBase64Encoded ? Buffer.from(b, 'base64').toString('utf8') : b;
}

// ---- secret loading (same shape/pattern as state-token.loadSecrets) --------------------------------
let _cache = null; let _cacheAt = null;
function secretsFromEnv(env = process.env) {
  if (env.BENCHMARK_SERVICE_SECRET) return { current: env.BENCHMARK_SERVICE_SECRET, previous: env.BENCHMARK_SERVICE_SECRET_PREVIOUS || null, source: 'env' };
  return null;
}
function secretId(env = process.env) {
  return env.BENCHMARK_SERVICE_SECRET_ID || `spares4repairs/${env.STAGE || 'dev'}/applianceclinic-benchmark-service`;
}
async function defaultFetchSecret(id) {
  // eslint-disable-next-line global-require
  const { SecretsManagerClient, GetSecretValueCommand } = require('@aws-sdk/client-secrets-manager');
  const client = new SecretsManagerClient({ region: process.env.AWS_REGION || 'eu-west-1' });
  const res = await client.send(new GetSecretValueCommand({ SecretId: id }));
  return res.SecretString || null;
}
/** Env first, then Secrets Manager. Returns null when unavailable (callers fail closed). */
async function loadSecrets({ env = process.env, fetchSecret = defaultFetchSecret, nowMs = Date.now() } = {}) {
  const fromEnv = secretsFromEnv(env);
  if (fromEnv) return fromEnv;
  if (_cacheAt !== null && nowMs - _cacheAt < (_cache ? CACHE_MS : NEGATIVE_CACHE_MS)) return _cache;
  try {
    const raw = await fetchSecret(secretId(env));
    const parsed = raw ? JSON.parse(raw) : null;
    if (!parsed || typeof parsed.current !== 'string' || parsed.current.length < MIN_SECRET_LENGTH) { _cache = null; _cacheAt = nowMs; return null; }
    _cache = { current: parsed.current, previous: typeof parsed.previous === 'string' ? parsed.previous : null, source: 'secretsmanager' };
    _cacheAt = nowMs;
    return _cache;
  } catch {
    _cache = null; _cacheAt = nowMs;
    return null;
  }
}
function _resetCacheForTest() { _cache = null; _cacheAt = null; }

module.exports = {
  HEADER, MAX_SKEW_SECONDS, MIN_SECRET_LENGTH, SESSION_RE, TURN_RE,
  signRequest, verifyRequest, takeBenchmark, sessionRef, headerOf, rawBodyOf,
  loadSecrets, secretsFromEnv, secretId, _resetCacheForTest,
};
