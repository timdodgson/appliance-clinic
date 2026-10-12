/**
 * Learning trace, feedback and request logging, with PII redaction.
 */
/** Single-line JSON metric for CloudWatch Logs Insights. */
// ---------------------------------------------------------------------------
// PII redaction for the learning trace. People paste card numbers, emails and
// phone numbers into free-text symptom boxes. Redact AGGRESSIVELY before any
// query text is ever written to a log/store — we keep the appliance-symptom
// phrasing (the learning signal), NOT the personal data. Over-redaction is a
// deliberate, acceptable trade-off here.
function redactPII(input, maxLen = 500) {
  let s = String(input || '');
  if (!s) return '';
  // Emails
  s = s.replace(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi, '[email]');
  // Card-length digit runs (13-19 digits, allowing spaces/hyphens) — do this
  // BEFORE phone so a 16-digit card isn't taken as a phone number.
  s = s.replace(/\b\d(?:[ -]?\d){12,18}\b/g, '[card]');
  // UK sort codes 12-34-56
  s = s.replace(/\b\d{2}-\d{2}-\d{2}\b/g, '[sortcode]');
  // Phone numbers (+44 / 0-led, 10-11 digits, spaces/brackets/hyphens allowed)
  s = s.replace(/(?:\+?44\s?|\b0)(?:\d[\d ()-]{7,}\d)/g, '[phone]');
  // Any remaining long bare digit run (8+) — e.g. account numbers
  s = s.replace(/\b\d{8,}\b/g, '[number]');
  // UK postcodes
  s = s.replace(/\b[A-Z]{1,2}\d[A-Z\d]?\s?\d[A-Z]{2}\b/gi, '[postcode]');
  // Collapse whitespace and cap length (symptom phrasing doesn't need to be huge)
  return s.replace(/\s+/g, ' ').trim().slice(0, maxLen);
}

// Learning trace: a redacted, structured record of how a REAL person phrased a
// REAL problem plus what the engine did with it. This is the corpus we mine to
// grow the knowledge/fixtures and to judge whether we're getting better. We now
// keep the FULL redacted transcript (every turn) + the AI's reply, all PII-
// scrubbed. NO card data, NO personal data — just appliance-symptom language.
//
// Storage: written straight to S3 (LEARNING_BUCKET), date-partitioned, NOT to
// CloudWatch — CloudWatch Logs ingestion (~$0.50/GB) is the expensive path;
// S3 storage (~$0.023/GB/mo) is far cheaper for a growing corpus and queryable
// with Athena. Keys are partitioned by date so a later Firehose/compaction swap
// (to avoid many tiny objects at scale) is painless. If LEARNING_BUCKET is
// unset, this is a silent no-op (safe default for local/dev).
const LEARNING_BUCKET = process.env.LEARNING_BUCKET || '';

let _s3Client = null;

function s3Client() {
  if (_s3Client) return _s3Client;
  const { S3Client } = require('@aws-sdk/client-s3');
  _s3Client = new S3Client({ region: process.env.AWS_REGION || 'eu-west-1' });
  return _s3Client;
}

// Feedback record: a customer's 👍/👎 on a reply, linked to its trace by
// traceId. Written under learning/feedback/ (covered by the same learning/* IAM
// grant). The miner joins these to traces to surface CONFIRMED misses.
async function logFeedback(feedback) {
  if (!LEARNING_BUCKET) return;
  try {
    const rating = String((feedback && feedback.rating) || '').toLowerCase();
    const rec = {
      evt: 'wp-feedback',
      ts: new Date().toISOString(),
      traceId: (feedback && feedback.traceId) || null,
      rating: rating === 'up' || rating === 'down' ? rating : null,
      note: redactPII(feedback && feedback.note, 300),
    };
    const now = new Date();
    const dt = now.toISOString().slice(0, 10);
    const key = `learning/feedback/dt=${dt}/${now.getTime()}-${Math.random().toString(36).slice(2, 10)}.json`;
    const { PutObjectCommand } = require('@aws-sdk/client-s3');
    await s3Client().send(new PutObjectCommand({
      Bucket: LEARNING_BUCKET, Key: key, Body: JSON.stringify(rec), ContentType: 'application/json',
    }));
  } catch (e) {
    console.error('[diagnosis-engine] feedback write failed:', e.message);
  }
}

function log(metric) {
  try {
    console.log(JSON.stringify(metric));
  } catch {
    console.log('[diagnosis-engine] metric log failed');
  }
}

function rand() {
  return Math.random().toString(36).slice(2, 10);
}

module.exports = {
  logFeedback,
  log,
  rand,
};
