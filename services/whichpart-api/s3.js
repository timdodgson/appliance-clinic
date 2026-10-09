'use strict';

/** S3 access to the learning bucket shared by the admin stores and the test area. */
// ---- ApplianceClinic AI provider configuration (admin control plane) --------
// Persists routing/model config + the write-only OpenAI credential to Secrets
// Manager (the SAME ids the part-finder RAG engine reads at runtime). The key
// is never returned to the browser. All handlers are admin-guarded.
const crypto = require('crypto');
const { AUTH_REGION, LEARNING_BUCKET } = require('./config.js');

let _s3 = null;
function s3client() {
  if (_s3) return _s3;
  const { S3Client } = require('@aws-sdk/client-s3');
  _s3 = new S3Client({ region: AUTH_REGION });
  return _s3;
}
async function _streamToString(stream) {
  if (!stream) return null;
  const chunks = [];
  for await (const c of stream) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
  return Buffer.concat(chunks).toString('utf8');
}
// Test hook: route the Test-area S3 document store (runs, library, reviews) to a fake.
let _acqS3Override = null;
function setAcqS3ForTests(fake) { _acqS3Override = fake || null; }
const acqS3 = {
  async getObject(key) {
    if (_acqS3Override) return _acqS3Override.getObject(key);
    const { GetObjectCommand } = require('@aws-sdk/client-s3');
    try { const r = await s3client().send(new GetObjectCommand({ Bucket: LEARNING_BUCKET, Key: key })); return await _streamToString(r.Body); }
    catch (e) { if (e && (e.name === 'NoSuchKey' || (e.$metadata && e.$metadata.httpStatusCode === 404))) return null; throw e; }
  },
  async putObject(key, body) { if (_acqS3Override) return _acqS3Override.putObject(key, body); const { PutObjectCommand } = require('@aws-sdk/client-s3'); await s3client().send(new PutObjectCommand({ Bucket: LEARNING_BUCKET, Key: key, Body: body, ContentType: 'application/json' })); },
  async list(prefix) {
    if (_acqS3Override) return _acqS3Override.list(prefix);
    const { ListObjectsV2Command } = require('@aws-sdk/client-s3');
    const out = []; let token;
    do { const r = await s3client().send(new ListObjectsV2Command({ Bucket: LEARNING_BUCKET, Prefix: prefix, ContinuationToken: token })); for (const o of (r.Contents || [])) out.push(o.Key); token = r.IsTruncated ? r.NextContinuationToken : undefined; } while (token);
    return out;
  },
  // ETag read + conditional write (S3 If-Match / If-None-Match): the routing-override lease.
  async getWithEtag(key) {
    if (_acqS3Override) {
      if (_acqS3Override.getWithEtag) return _acqS3Override.getWithEtag(key);
      const body = await _acqS3Override.getObject(key);
      return body == null ? null : { body, etag: '"' + crypto.createHash('md5').update(String(body)).digest('hex') + '"' };
    }
    const { GetObjectCommand } = require('@aws-sdk/client-s3');
    try { const r = await s3client().send(new GetObjectCommand({ Bucket: LEARNING_BUCKET, Key: key })); return { body: await _streamToString(r.Body), etag: r.ETag || null }; }
    catch (e) { if (e && (e.name === 'NoSuchKey' || (e.$metadata && e.$metadata.httpStatusCode === 404))) return null; throw e; }
  },
  async putConditional(key, body, opts) {
    const pre = () => { const pe = new Error('precondition failed'); pe.code = 'precondition'; return pe; };
    if (_acqS3Override) {
      if (_acqS3Override.putConditional) return _acqS3Override.putConditional(key, body, opts);
      const cur = await acqS3.getWithEtag(key);
      if (opts && opts.ifNoneMatch && cur) throw pre();
      if (opts && opts.ifMatch && (!cur || cur.etag !== opts.ifMatch)) throw pre();
      return _acqS3Override.putObject(key, body);
    }
    const { PutObjectCommand } = require('@aws-sdk/client-s3');
    const params = { Bucket: LEARNING_BUCKET, Key: key, Body: body, ContentType: 'application/json' };
    if (opts && opts.ifMatch) params.IfMatch = opts.ifMatch;
    if (opts && opts.ifNoneMatch) params.IfNoneMatch = opts.ifNoneMatch;
    try { await s3client().send(new PutObjectCommand(params)); }
    catch (e) {
      const st = e && e.$metadata && e.$metadata.httpStatusCode;
      if (st === 412 || st === 409 || (e && (e.name === 'PreconditionFailed' || e.name === 'ConditionalRequestConflict'))) throw pre();
      throw e;
    }
  },
};

module.exports = { s3client, _streamToString, setAcqS3ForTests, acqS3 };
