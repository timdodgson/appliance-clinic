'use strict';
/**
 * ADR 0017: the orchestrator-only engine fields are honoured only from a caller that holds the AC engine signing
 * key (the orchestrator, and whichpart-api for feedback). The public Function URL also serves S4R's /part-finder
 * page, which sends only {messages}; without a valid signature the internal fields are dropped and the request is
 * handled as that plain request.
 *
 * Header: x-ac-engine-signature: t=<unix seconds>,v1=<hex HMAC-SHA256(key, `${t}.${rawBody}`)>
 * The HMAC covers the exact request body; the timestamp bounds replay of a captured request.
 */
const crypto = require('node:crypto');

const INTERNAL_FIELDS = Object.freeze(['mode', 'understand', 'canonical', 'established', 'seed', 'feedback']);
const SIGNATURE_HEADER = 'x-ac-engine-signature';
const MAX_SKEW_S = 300;

/** 'enforce' drops unsigned internal fields; 'log' (the staged default) honours them and records the result. */
function signingMode(env = process.env) {
  return String(env.ENGINE_SIGNING_MODE || '').trim().toLowerCase() === 'enforce' ? 'enforce' : 'log';
}

function signingKey(env = process.env) {
  const k = env.ENGINE_SIGNING_TOKEN;
  return typeof k === 'string' && k.length >= 32 ? k : null;
}

function sign(key, rawBody, nowS = Math.floor(Date.now() / 1000)) {
  const mac = crypto.createHmac('sha256', key).update(`${nowS}.`).update(rawBody).digest('hex');
  return `t=${nowS},v1=${mac}`;
}

function headerOf(event, name) {
  const h = (event && event.headers) || {};
  for (const [k, v] of Object.entries(h)) if (k.toLowerCase() === name) return typeof v === 'string' ? v : null;
  return null;
}

/** 'valid' | 'missing' | 'malformed' | 'stale' | 'invalid' | 'no_key'. Constant-time comparison. */
function verify(event, rawBody, key, nowS = Math.floor(Date.now() / 1000)) {
  const header = headerOf(event, SIGNATURE_HEADER);
  if (!header) return 'missing';
  if (!key) return 'no_key';
  const parts = Object.fromEntries(header.split(',').map((p) => p.trim().split('=')).filter((p) => p.length === 2));
  const t = Number(parts.t);
  if (!Number.isInteger(t) || !/^[0-9a-f]{64}$/.test(parts.v1 || '')) return 'malformed';
  if (Math.abs(nowS - t) > MAX_SKEW_S) return 'stale';
  const expected = crypto.createHmac('sha256', key).update(`${t}.`).update(rawBody).digest();
  const given = Buffer.from(parts.v1, 'hex');
  return given.length === expected.length && crypto.timingSafeEqual(given, expected) ? 'valid' : 'invalid';
}

/**
 * Decide what the engine may read from this request. Returns the body to use and a record for the request metric
 * (field names and the signature result only; never values or the key).
 */
function gateInternalFields(body, event, rawBody, opts = {}) {
  const env = opts.env || process.env;
  const mode = opts.mode || signingMode(env);
  const present = INTERNAL_FIELDS.filter((f) => body && body[f] !== undefined);
  const signature = verify(event, rawBody, opts.key !== undefined ? opts.key : signingKey(env), opts.nowS);
  const record = { mode, signature, present };
  if (!present.length || signature === 'valid') return { body, record: { ...record, dropped: false } };
  if (mode !== 'enforce') return { body, record: { ...record, dropped: false } };
  const plain = { ...body };
  for (const f of present) delete plain[f];
  return { body: plain, record: { ...record, dropped: true } };
}

/** The host of an Origin header, for the auth log (never the full header or any body content). */
function headerHost(origin) {
  try { return origin ? new URL(String(origin)).host : null; } catch { return 'unparseable'; }
}

module.exports = { headerHost, INTERNAL_FIELDS, SIGNATURE_HEADER, MAX_SKEW_S, signingMode, signingKey, sign, verify, gateInternalFields };
