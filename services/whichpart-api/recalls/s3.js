'use strict';

/**
 * Minimal S3 PutObject (SigV4). Used to publish Recall Centre HTML + sitemap.
 * Hosts are fixed to the ApplianceClinic web bucket — not caller-controlled.
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
  if (!accessKeyId || !secretAccessKey) throw new Error('s3-credentials');
  return { accessKeyId, secretAccessKey, sessionToken };
}

function isSafeKey(key) {
  if (typeof key !== 'string' || !key) return false;
  if (key[0] === '/' || key.indexOf('..') !== -1) return false;
  // The ingest owns only the recall child sitemap and pages under /recalls/.
  // The /sitemap.xml index and sitemap-core.xml are static-deploy owned.
  return key === 'sitemap-recalls.xml'
    || key.indexOf('recalls/') === 0;
}

async function putObject(opts) {
  const bucket = opts.bucket;
  const key = opts.key;
  const body = Buffer.from(opts.body || '', 'utf8');
  const contentType = opts.contentType || 'text/html; charset=utf-8';
  const cache = opts.cacheControl || 'max-age=60, must-revalidate';
  if (!bucket || !/^[a-z0-9.-]{3,63}$/.test(bucket)) throw new Error('s3-bucket');
  if (!isSafeKey(key)) throw new Error('s3-key');
  const region = opts.region || DEFAULT_REGION;
  const creds = opts.credentials || credentials();
  const now = opts.now || new Date();
  const { amzDate: amz, dateStamp } = amzDate(now);
  const host = bucket + '.s3.' + region + '.amazonaws.com';
  const payloadHash = sha256Hex(body);
  const headers = {
    'content-type': contentType,
    host: host,
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': amz,
    'cache-control': cache,
  };
  if (creds.sessionToken) headers['x-amz-security-token'] = creds.sessionToken;
  const signedNames = Object.keys(headers).map((k) => k.toLowerCase()).sort();
  const canonicalHeaders = signedNames.map((k) => k + ':' + headers[k].trim() + '\n').join('');
  const signedHeaders = signedNames.join(';');
  const canonicalRequest = [
    'PUT', '/' + key, '', canonicalHeaders, signedHeaders, payloadHash,
  ].join('\n');
  const scope = dateStamp + '/' + region + '/s3/aws4_request';
  const stringToSign = ['AWS4-HMAC-SHA256', amz, scope, sha256Hex(canonicalRequest)].join('\n');
  const kDate = hmac('AWS4' + creds.secretAccessKey, dateStamp);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, 's3');
  const kSigning = hmac(kService, 'aws4_request');
  const signature = crypto.createHmac('sha256', kSigning).update(stringToSign, 'utf8').digest('hex');
  headers.authorization = 'AWS4-HMAC-SHA256 Credential=' + creds.accessKeyId + '/' + scope
    + ', SignedHeaders=' + signedHeaders + ', Signature=' + signature;
  const fetchFn = opts.fetch || globalThis.fetch;
  const res = await fetchFn('https://' + host + '/' + key, { method: 'PUT', headers, body });
  if (!res.ok) {
    const text = await res.text();
    const err = new Error('s3-put-' + res.status);
    err.body = text.slice(0, 300);
    throw err;
  }
}

module.exports = { putObject, isSafeKey };
