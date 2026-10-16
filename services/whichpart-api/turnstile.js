'use strict';
/**
 * Bot check (change 21.38): Cloudflare Turnstile on the first message of a conversation. The diagnosis now runs on a
 * paid model, so a conversation can only start once the browser has passed Turnstile; every later message carries the
 * conversation's signed state token (state-token.js), which only this API can issue, so the check runs once per
 * conversation and customers never see it again.
 *
 * Modes (TURNSTILE_MODE): `off` (default, no work), `observe` (verify and log, never refuse), `enforce` (refuse a new
 * conversation without a valid token, 403 bot_check_failed). The secret key comes from Secrets Manager
 * (TURNSTILE_SECRET_ID, JSON {siteKey, secretKey}), cached; it is never logged. If Cloudflare cannot be reached, the
 * turn is allowed (the rate limits still apply): an outage at Cloudflare must not take the service down.
 */
const VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
const CACHE_MS = 5 * 60 * 1000;

function mode(env = process.env) {
  const m = String(env.TURNSTILE_MODE || 'off').toLowerCase();
  return m === 'observe' || m === 'enforce' ? m : 'off';
}

let _cache = null;
let _cacheAt = 0;
async function defaultFetchSecret(secretId) {
  // eslint-disable-next-line global-require
  const { SecretsManagerClient, GetSecretValueCommand } = require('@aws-sdk/client-secrets-manager');
  const sm = new SecretsManagerClient({ region: process.env.AWS_REGION || 'eu-west-1' });
  const r = await sm.send(new GetSecretValueCommand({ SecretId: secretId }));
  return r.SecretString || null;
}
async function secretKey({ env = process.env, fetchSecret = defaultFetchSecret, nowMs = Date.now() } = {}) {
  if (_cache && nowMs - _cacheAt < CACHE_MS) return _cache;
  const id = env.TURNSTILE_SECRET_ID;
  if (!id) return null;
  try {
    const parsed = JSON.parse((await fetchSecret(id)) || '{}');
    _cache = typeof parsed.secretKey === 'string' && parsed.secretKey ? parsed.secretKey : null;
  } catch {
    _cache = null;
  }
  _cacheAt = nowMs;
  return _cache;
}

/**
 * Verify a Turnstile token with Cloudflare. Returns {ok, reason, codes}: ok false with reason 'missing' (no token),
 * 'rejected' (Cloudflare said no; codes are its error codes), 'no_secret' or 'unreachable' (the check could not run).
 */
async function verify(token, { ip = null, env = process.env, fetchFn = fetch, fetchSecret, timeoutMs = 5000 } = {}) {
  if (!token || typeof token !== 'string' || token.length > 2048) return { ok: false, reason: 'missing' };
  const secret = await secretKey({ env, fetchSecret });
  if (!secret) return { ok: false, reason: 'no_secret' };
  const form = new URLSearchParams({ secret, response: token });
  if (ip && ip !== 'unknown') form.set('remoteip', ip);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetchFn(VERIFY_URL, { method: 'POST', body: form, signal: ctrl.signal });
    const body = await res.json();
    if (body && body.success === true) return { ok: true, reason: 'passed', hostname: body.hostname || null };
    return { ok: false, reason: 'rejected', codes: (body && body['error-codes']) || [] };
  } catch {
    return { ok: false, reason: 'unreachable' };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The decision for one customer turn. `newConversation`: no valid state token was presented. Returns null to carry on,
 * or a 403 response in enforce mode when a new conversation has no passing token.
 */
async function guard({ token, newConversation, ip, log, env = process.env, deps = {} }) {
  const m = mode(env);
  if (m === 'off' || !newConversation) return null;
  const r = await verify(token, { ip, env, ...deps });
  if (log) log({ evt: 'turnstile', mode: m, ok: r.ok, reason: r.reason, codes: r.codes || undefined });
  // Fail open when the check itself could not run (no secret configured, Cloudflare unreachable).
  if (r.ok || m !== 'enforce' || r.reason === 'no_secret' || r.reason === 'unreachable') return null;
  return { statusCode: 403, headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ error: 'Please confirm you are not a robot and try again.', code: 'bot_check_failed' }) };
}

function _resetCacheForTest() { _cache = null; _cacheAt = 0; }

module.exports = { mode, verify, guard, VERIFY_URL, _resetCacheForTest };
