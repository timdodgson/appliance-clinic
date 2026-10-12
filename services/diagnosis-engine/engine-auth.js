'use strict';
/**
 * ADR 0017 / 0019: every engine request comes from an Appliance Clinic service holding the AC engine signing key (the
 * orchestrator; whichpart-api for feedback and health) and is signed over its exact body. The handler refuses any
 * request without a valid signature (401).
 *
 * Header: x-ac-engine-signature: t=<unix seconds>,v1=<hex HMAC-SHA256(key, `${t}.${rawBody}`)>
 * The HMAC covers the exact request body; the timestamp bounds replay of a captured request.
 */
const crypto = require('node:crypto');

const INTERNAL_FIELDS = Object.freeze(['mode', 'understand', 'canonical', 'established', 'seed', 'feedback', 'ac2', 'image']);
const SIGNATURE_HEADER = 'x-ac-engine-signature';
const MAX_SKEW_S = 300;

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
 * Decide whether the engine may serve this request. Returns the body and a record for the request metric (field names
 * and the signature result only; never values or the key). `rejected`: internal fields without a valid signature (a
 * missing key fails closed); the caller refuses the request.
 */
function gateInternalFields(body, event, rawBody, opts = {}) {
  const env = opts.env || process.env;
  const present = INTERNAL_FIELDS.filter((f) => body && body[f] !== undefined);
  const signature = verify(event, rawBody, opts.key !== undefined ? opts.key : signingKey(env), opts.nowS);
  return { body, record: { signature, present, rejected: present.length > 0 && signature !== 'valid' } };
}

/** The host of an Origin header, for the auth log (never the full header or any body content). */
function headerHost(origin) {
  try { return origin ? new URL(String(origin)).host : null; } catch { return 'unparseable'; }
}

module.exports = { headerHost, INTERNAL_FIELDS, SIGNATURE_HEADER, MAX_SKEW_S, signingKey, sign, verify, gateInternalFields };
