'use strict';

/** Rate limiting of sign-in and diagnosis (rate-limit.js), with its DynamoDB store. */
// ---- rate limiting (Phase 7; rate-limit.js). RATE_LIMIT_MODE off|observe|enforce, counters in RATE_LIMIT_TABLE.
const rateLimit = require('./rate-limit.js');
const { log } = require('./log.js');
const { CORS } = require('./http-io.js');

let _rateStore = null;
function rateStore() {
  if (!_rateStore) _rateStore = rateLimit.dynamoStore(require('./ddb.js').dynamodb, process.env.RATE_LIMIT_TABLE || 'applianceclinic-rate-limits');
  return _rateStore;
}
function setRateLimitStoreForTests(store) { _rateStore = store; }
/** Count one request; returns a 429 response to send, or null to carry on. Logs counts and hashes only. */
async function rateLimited(kind, event, extra) {
  if (rateLimit.mode() === 'off') return null;
  const net = rateLimit.clientIp(event);
  const r = await rateLimit.check(kind, { ip: net.ip, source: net.source, ...(extra || {}) }, { store: rateStore() });
  // Observe mode logs every counted request (counts and header shape only); enforce mode only what is over or failing.
  if (r.mode === 'observe' || r.overLimit || r.error) {
    log({ evt: 'rate-limit', kind, mode: r.mode, limited: r.limited, overLimit: Boolean(r.overLimit), xffDepth: net.xffDepth,
      lastIsSource: net.lastIsSource, counts: r.counts, ...(r.error ? { error: r.error } : {}) });
  }
  if (!r.limited) return null;
  return { statusCode: 429, headers: { ...CORS, 'retry-after': String(r.retryAfter || 60), 'cache-control': 'no-store' },
    body: JSON.stringify({ error: 'Too many requests. Please wait a moment and try again.', code: 'rate_limited' }) };
}

module.exports = { setRateLimitStoreForTests, rateLimited };
