'use strict';
/**
 * whichpart-api's calls to the diagnosis engine (every ac2 turn, the feedback pass-through and the admin health probes).
 *   - ADR 0017: a POST body carries the AC engine signature (HMAC, keyed by the engine signing secret). Header format
 *     matches services/diagnosis-engine/engine-auth.js.
 *   - ADR 0019: the engine's Function URL is AWS_IAM, so every call is also SigV4-signed (service `lambda`) with this
 *     function's role credentials, which may invoke only that URL. Without credentials (local tests) no SigV4 is added.
 */
const crypto = require('node:crypto');

const ENGINE_SIGNATURE_HEADER = 'x-ac-engine-signature';

function engineSignature(rawBody, key = process.env.ENGINE_SIGNING_TOKEN, nowS = Math.floor(Date.now() / 1000)) {
  if (typeof key !== 'string' || !key) return null;
  const mac = crypto.createHmac('sha256', key).update(`${nowS}.`).update(rawBody).digest('hex');
  return `t=${nowS},v1=${mac}`;
}

const sha256hex = (v) => crypto.createHash('sha256').update(v).digest('hex');
const hmac = (k, v) => crypto.createHmac('sha256', k).update(v).digest();

/**
 * AWS Signature Version 4 headers for one request (service `lambda`), from the standard credential variables.
 * Returns the given headers with host, x-amz-date, x-amz-content-sha256, x-amz-security-token and authorization added.
 */
function sigv4Headers(method, url, body, headers = {}, env = process.env, now = new Date()) {
  const keyId = env.AWS_ACCESS_KEY_ID; const secret = env.AWS_SECRET_ACCESS_KEY;
  if (!keyId || !secret) return headers;
  const region = env.AWS_REGION || env.AWS_DEFAULT_REGION || 'eu-west-1';
  const u = new URL(url);
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const day = amzDate.slice(0, 8);
  const payloadHash = sha256hex(body || '');
  const all = { ...headers, host: u.host, 'x-amz-date': amzDate, 'x-amz-content-sha256': payloadHash };
  if (env.AWS_SESSION_TOKEN) all['x-amz-security-token'] = env.AWS_SESSION_TOKEN;
  const names = Object.keys(all).map((k) => k.toLowerCase()).sort();
  const lower = Object.fromEntries(Object.entries(all).map(([k, v]) => [k.toLowerCase(), String(v).trim()]));
  const query = [...u.searchParams.entries()].map(([k, v]) => [encodeURIComponent(k), encodeURIComponent(v)])
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, v]) => `${k}=${v}`).join('&');
  const canonical = [method, u.pathname || '/', query, names.map((n) => `${n}:${lower[n]}\n`).join(''), names.join(';'), payloadHash].join('\n');
  const scope = `${day}/${region}/lambda/aws4_request`;
  const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256hex(canonical)].join('\n');
  const kSigning = hmac(hmac(hmac(hmac(`AWS4${secret}`, day), region), 'lambda'), 'aws4_request');
  const signature = crypto.createHmac('sha256', kSigning).update(toSign).digest('hex');
  all.authorization = `AWS4-HMAC-SHA256 Credential=${keyId}/${scope}, SignedHeaders=${names.join(';')}, Signature=${signature}`;
  delete all.host;  // fetch sets it; it is signed with the same value
  return all;
}

/** Headers for a signed JSON POST of exactly `rawBody` to the engine at `url`. */
function signedJsonHeaders(rawBody, url) {
  const headers = { 'content-type': 'application/json' };
  const sig = engineSignature(rawBody);
  if (sig) headers[ENGINE_SIGNATURE_HEADER] = sig;
  return url ? sigv4Headers('POST', url, rawBody, headers) : headers;
}

/** Headers for a GET to the engine at `url` (the health probes). */
function engineGetHeaders(url) {
  return sigv4Headers('GET', url, '', {});
}

module.exports = { ENGINE_SIGNATURE_HEADER, engineSignature, signedJsonHeaders, engineGetHeaders, sigv4Headers };
