'use strict';

/** S3 access to the learning bucket shared by the admin stores (media and error-code overlays, recall ingest). */
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
/** The learning bucket's JSON documents: a missing key reads as null. */
const learningS3 = {
  async getObject(key) {
    const { GetObjectCommand } = require('@aws-sdk/client-s3');
    try { const r = await s3client().send(new GetObjectCommand({ Bucket: LEARNING_BUCKET, Key: key })); return await _streamToString(r.Body); }
    catch (e) { if (e && (e.name === 'NoSuchKey' || (e.$metadata && e.$metadata.httpStatusCode === 404))) return null; throw e; }
  },
};

module.exports = { s3client, _streamToString, learningS3 };
