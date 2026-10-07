'use strict';

/**
 * Minimal DynamoDB JSON-protocol client (SigV4).
 *
 * Lambda nodejs20 does not bundle the AWS SDK. The rest of whichpart-api already
 * requires SDK clients that may or may not resolve at runtime; transcript writes
 * must not depend on that. This module signs DynamoDB requests with the execution
 * role credentials from the environment and has no extra package dependency.
 *
 * Never logs credentials, item payloads, or customer text.
 */

const crypto = require('crypto');

const DEFAULT_REGION = process.env.AWS_REGION || 'eu-west-1';

function hmac(key, data) {
  return crypto.createHmac('sha256', key).update(data, 'utf8').digest();
}
function sha256Hex(data) {
  return crypto.createHash('sha256').update(data, 'utf8').digest('hex');
}

function amzDate(date) {
  const iso = date.toISOString().replace(/[:-]|\.\d{3}/g, '');
  return { amzDate: iso.slice(0, 15) + 'Z', dateStamp: iso.slice(0, 8) };
}

function credentials() {
  const accessKeyId = process.env.AWS_ACCESS_KEY_ID || '';
  const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY || '';
  const sessionToken = process.env.AWS_SESSION_TOKEN || '';
  if (!accessKeyId || !secretAccessKey) {
    throw new Error('DynamoDB credentials are not available in the environment');
  }
  return { accessKeyId, secretAccessKey, sessionToken };
}

function canonicalQuery(_qs) { return ''; }

function signHeaders(action, body, opts) {
  const region = (opts && opts.region) || DEFAULT_REGION;
  const now = (opts && opts.now) || new Date();
  const creds = (opts && opts.credentials) || credentials();
  const { amzDate: amz, dateStamp } = amzDate(now);
  const host = 'dynamodb.' + region + '.amazonaws.com';
  const payloadHash = sha256Hex(body);
  const headers = {
    'content-type': 'application/x-amz-json-1.0',
    host: host,
    'x-amz-date': amz,
    'x-amz-target': 'DynamoDB_20120810.' + action,
  };
  if (creds.sessionToken) headers['x-amz-security-token'] = creds.sessionToken;
  const signedHeaderNames = Object.keys(headers).map((k) => k.toLowerCase()).sort();
  const canonicalHeaders = signedHeaderNames.map((k) => k + ':' + headers[k].trim() + '\n').join('');
  const signedHeaders = signedHeaderNames.join(';');
  const canonicalRequest = [
    'POST', '/', canonicalQuery(), canonicalHeaders, signedHeaders, payloadHash,
  ].join('\n');
  const scope = dateStamp + '/' + region + '/dynamodb/aws4_request';
  const stringToSign = [
    'AWS4-HMAC-SHA256', amz, scope, sha256Hex(canonicalRequest),
  ].join('\n');
  const kDate = hmac('AWS4' + creds.secretAccessKey, dateStamp);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, 'dynamodb');
  const kSigning = hmac(kService, 'aws4_request');
  const signature = crypto.createHmac('sha256', kSigning).update(stringToSign, 'utf8').digest('hex');
  headers.authorization = 'AWS4-HMAC-SHA256 Credential=' + creds.accessKeyId + '/' + scope
    + ', SignedHeaders=' + signedHeaders + ', Signature=' + signature;
  return { url: 'https://' + host + '/', headers };
}

async function dynamodb(action, payload, opts) {
  const body = JSON.stringify(payload || {});
  const signed = signHeaders(action, body, opts);
  const fetchFn = (opts && opts.fetch) || globalThis.fetch;
  const res = await fetchFn(signed.url, {
    method: 'POST',
    headers: signed.headers,
    body,
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text }; }
  if (!res.ok) {
    const msg = (json && (json.message || json.Message || json.__type)) || ('http ' + res.status);
    const err = new Error('DynamoDB ' + action + ' failed: ' + msg);
    err.status = res.status;
    err.body = json;
    throw err;
  }
  return json;
}

function S(v) { return v == null || v === '' ? undefined : { S: String(v) }; }
function N(v) { return v == null || v === '' ? undefined : { N: String(v) }; }
function BOOL(v) { return { BOOL: Boolean(v) }; }

function fromAttr(a) {
  if (!a || typeof a !== 'object') return null;
  if (Object.prototype.hasOwnProperty.call(a, 'S')) return a.S;
  if (Object.prototype.hasOwnProperty.call(a, 'N')) return Number(a.N);
  if (Object.prototype.hasOwnProperty.call(a, 'BOOL')) return a.BOOL;
  if (Object.prototype.hasOwnProperty.call(a, 'NULL')) return null;
  return null;
}

function unmarshall(item) {
  const out = {};
  if (!item) return out;
  for (const [k, v] of Object.entries(item)) out[k] = fromAttr(v);
  return out;
}

function compact(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) out[k] = v;
  }
  return out;
}

module.exports = {
  dynamodb,
  signHeaders,
  S, N, BOOL,
  unmarshall,
  compact,
};
