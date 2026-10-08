'use strict';
/**
 * Signed canonical-session token (services/whichpart-api/docs/canonical-architecture.md §11–§13).
 *
 * The BFF mints the canonical session id (`csid`) and hands the browser an opaque, HMAC-signed token
 * that binds to it. The browser only echoes the token; it can neither choose nor alter the csid, and the
 * token carries no canonical state.
 *
 *   token = "cst1." + csid + "." + exp + "." + base64url(HMAC-SHA256(secret, "cst1." + csid + "." + exp))
 *
 *   csid   "cs_" + 32 base64url chars (24 random bytes) — server-generated only
 *   exp    unix seconds; sliding expiry (re-issued with a fresh exp on every successful turn)
 *   secret current signing secret; verification also accepts the previous secret (rotation)
 *
 * Secrets: env CANONICAL_TOKEN_SECRET (+ optional CANONICAL_TOKEN_SECRET_PREVIOUS), else the Secrets
 * Manager secret CANONICAL_TOKEN_SECRET_ID (default spares4repairs/<STAGE>/applianceclinic-canonical-state-token,
 * JSON {"current": "...", "previous": "..."}), covered by the BFF's existing applianceclinic-* policy.
 * Optional CANONICAL_TOKEN_PREVIOUS_SECRET_ID: a secret the signing secret moved from; its values verify, never sign.
 * No secret available → canonical shadow is disabled (never an unsigned fallback).
 */

const crypto = require('crypto');

const PREFIX = 'cst1';
const CSID_RE = /^cs_[A-Za-z0-9_-]{32}$/;
const TOKEN_RE = /^cst1\.cs_[A-Za-z0-9_-]{32}\.\d{9,11}\.[A-Za-z0-9_-]{43}$/;
const DEFAULT_TTL_SECONDS = 30 * 24 * 3600;
const MIN_SECRET_LENGTH = 32;

const b64url = (buf) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

function newCanonicalSessionId(randomBytes = crypto.randomBytes) {
  return 'cs_' + b64url(randomBytes(24));
}

function sign(secret, csid, exp) {
  return b64url(crypto.createHmac('sha256', secret).update(`${PREFIX}.${csid}.${exp}`).digest());
}

/** Issue a token for csid. `nowSec` injectable for tests. */
function issueToken(csid, secrets, { nowSec = Math.floor(Date.now() / 1000), ttlSeconds = DEFAULT_TTL_SECONDS } = {}) {
  if (!CSID_RE.test(String(csid || ''))) throw new Error('issueToken: invalid csid');
  const current = secrets && secrets.current;
  if (!current || current.length < MIN_SECRET_LENGTH) throw new Error('issueToken: signing secret unavailable');
  const exp = nowSec + ttlSeconds;
  return `${PREFIX}.${csid}.${exp}.${sign(current, csid, exp)}`;
}

/**
 * Verify a token. Returns {ok:true, csid, exp, rotated} or {ok:false, reason}.
 * reasons: missing | malformed | bad_signature | expired | no_secret
 */
function verifyToken(token, secrets, { nowSec = Math.floor(Date.now() / 1000) } = {}) {
  if (token == null || token === '') return { ok: false, reason: 'missing' };
  if (typeof token !== 'string' || token.length > 200 || !TOKEN_RE.test(token)) return { ok: false, reason: 'malformed' };
  const candidates = [secrets && secrets.current, secrets && secrets.previous, ...((secrets && Array.isArray(secrets.older)) ? secrets.older : [])]
    .filter((s) => typeof s === 'string' && s.length >= MIN_SECRET_LENGTH);
  if (!candidates.length) return { ok: false, reason: 'no_secret' };
  const [prefix, csid, expStr, sig] = token.split('.');
  if (prefix !== PREFIX) return { ok: false, reason: 'malformed' };
  const exp = Number(expStr);
  const given = Buffer.from(sig);
  let matched = -1;
  candidates.forEach((secret, i) => {
    const want = Buffer.from(sign(secret, csid, exp));
    if (matched < 0 && want.length === given.length && crypto.timingSafeEqual(want, given)) matched = i;
  });
  if (matched < 0) return { ok: false, reason: 'bad_signature' };
  if (!(exp > nowSec)) return { ok: false, reason: 'expired' };
  return { ok: true, csid, exp, rotated: matched > 0 };
}

// ---- secret loading -------------------------------------------------------------------------------
let _cache = null;
let _cacheAt = null; // ms of the last fetch attempt (null = never)
const CACHE_MS = 5 * 60 * 1000;
const NEGATIVE_CACHE_MS = 60 * 1000;

function secretsFromEnv(env = process.env) {
  if (env.CANONICAL_TOKEN_SECRET) {
    return { current: env.CANONICAL_TOKEN_SECRET, previous: env.CANONICAL_TOKEN_SECRET_PREVIOUS || null, source: 'env' };
  }
  return null;
}

/** Load signing secrets (env first, then Secrets Manager). Returns null when unavailable. */
async function loadSecrets({ env = process.env, fetchSecret = defaultFetchSecret, nowMs = Date.now() } = {}) {
  const fromEnv = secretsFromEnv(env);
  if (fromEnv) return fromEnv;
  if (_cacheAt !== null && nowMs - _cacheAt < (_cache ? CACHE_MS : NEGATIVE_CACHE_MS)) return _cache;
  const stage = env.STAGE || 'dev';
  const id = env.CANONICAL_TOKEN_SECRET_ID || `spares4repairs/${stage}/applianceclinic-canonical-state-token`;
  try {
    const raw = await fetchSecret(id);
    const parsed = raw ? JSON.parse(raw) : null;
    if (!parsed || typeof parsed.current !== 'string' || parsed.current.length < MIN_SECRET_LENGTH) {
      _cache = null; _cacheAt = nowMs; // negative cache: don't pay a Secrets Manager call every turn
      return null;
    }
    _cache = { current: parsed.current, previous: typeof parsed.previous === 'string' ? parsed.previous : null, source: 'secretsmanager' };
    // Phase 7 (moving the signing secret to a new secret): tokens signed with the old secret stay valid until they
    // expire. CANONICAL_TOKEN_PREVIOUS_SECRET_ID names the old secret; its values are accepted for verification only.
    if (env.CANONICAL_TOKEN_PREVIOUS_SECRET_ID && env.CANONICAL_TOKEN_PREVIOUS_SECRET_ID !== id) {
      try {
        const old = JSON.parse((await fetchSecret(env.CANONICAL_TOKEN_PREVIOUS_SECRET_ID)) || 'null');
        const olds = old ? [old.current, old.previous].filter((v) => typeof v === 'string' && v.length >= MIN_SECRET_LENGTH && v !== parsed.current) : [];
        if (!_cache.previous && olds.length) _cache.previous = olds.shift();
        if (olds.length) _cache.older = olds.filter((v) => v !== _cache.previous);
      } catch { /* the old secret is optional: new tokens still verify */ }
    }
    _cacheAt = nowMs;
    return _cache;
  } catch {
    _cache = null; _cacheAt = nowMs;
    return null;
  }
}

async function defaultFetchSecret(secretId) {
  // eslint-disable-next-line global-require
  const { SecretsManagerClient, GetSecretValueCommand } = require('@aws-sdk/client-secrets-manager');
  const client = new SecretsManagerClient({ region: process.env.AWS_REGION || 'eu-west-1' });
  const res = await client.send(new GetSecretValueCommand({ SecretId: secretId }));
  return res.SecretString || null;
}

function _resetCacheForTest() { _cache = null; _cacheAt = null; }

module.exports = {
  PREFIX, CSID_RE, DEFAULT_TTL_SECONDS, MIN_SECRET_LENGTH,
  newCanonicalSessionId, issueToken, verifyToken, loadSecrets, secretsFromEnv, _resetCacheForTest,
};
