'use strict';
/**
 * Rate limiting for whichpart-api (Phase 7). Fixed-window counters in a dedicated DynamoDB table
 * (RATE_LIMIT_TABLE, key `pk`, TTL `expiresAt`), one atomic UpdateItem ADD per counted dimension.
 *
 * Counted, by request kind (CloudWatch evidence: customer traffic peaks at 6 turns in any 10 minutes):
 *   login     per email (hashed): sign-in guessing against one account; and globally (the AC pool has a handful of
 *             users, so sign-in is rare); per client IP as an extra signal only (see below)
 *   diagnose  per network source, per conversation (the validated client session id), and globally: a cost guard,
 *             since a customer turn calls the orchestrator and paid models; per client IP as an extra signal only
 * Not counted: OPTIONS, health, admin routes (already authenticated), EventBridge invocations, and benchmark
 * turns whose HMAC signature has been verified (service-authenticated, bounded by their own runner).
 *
 * Modes (RATE_LIMIT_MODE): `off` (default, no work at all), `observe` (count and log, never refuse), `enforce` (refuse
 * over the limit with 429). Any counter-store failure fails open: a customer turn is never refused because the store is
 * unavailable. Identifiers are stored and logged only as truncated SHA-256 hashes, never raw IPs or emails. Decisions are
 * counts against fixed limits; no request content is inspected.
 *
 * Client IP. Phase 7 probes through the AC CloudFront distribution showed that the Function URL receives a viewer's own
 * X-Forwarded-For unchanged (CloudFront does not append to it here), and a single CloudFront-set entry when the viewer
 * sends none. The right-most entry is therefore the viewer's address only for viewers that do not forge the header, and
 * per-IP counts are an extra signal, never the protection: every limit that matters is keyed on something a client
 * cannot choose (the email being guessed, the network source, or nothing at all, globally). A trustworthy viewer address
 * needs CloudFront to send CloudFront-Viewer-Address, a change to the CloudFront distribution, which is out of scope.
 */
const crypto = require('crypto');

const LIMITS = {
  // Advisory: counted and logged, never refusing. The client address can be forged (see above), so enforcing it would
  // let anyone lock a chosen address out.
  loginIp: { limit: 10, windowSec: 900, advisory: true },
  loginEmail: { limit: 5, windowSec: 900 },
  loginGlobal: { limit: 60, windowSec: 900 },
  diagnoseIp: { limit: 60, windowSec: 600, advisory: true },
  diagnoseSession: { limit: 40, windowSec: 600 },
  diagnoseEdge: { limit: 600, windowSec: 600 },
  diagnoseGlobal: { limit: 1200, windowSec: 600 },
};

function mode(env = process.env) {
  const m = String(env.RATE_LIMIT_MODE || 'off').toLowerCase();
  return m === 'observe' || m === 'enforce' ? m : 'off';
}

function hashId(kind, value) {
  return crypto.createHash('sha256').update(`${kind}:${String(value).trim().toLowerCase()}`).digest('hex').slice(0, 32);
}

function header(event, name) {
  const h = (event && event.headers) || {};
  const k = Object.keys(h).find((x) => x.toLowerCase() === name);
  return k ? String(h[k]) : '';
}

/** {ip, source, xffDepth}: the client address as described above. */
function clientIp(event) {
  const source = String((event && event.requestContext && event.requestContext.http && event.requestContext.http.sourceIp) || '');
  const xff = header(event, 'x-forwarded-for').split(',').map((s) => s.trim()).filter(Boolean);
  const ip = xff.length ? xff[xff.length - 1] : source;
  // The header's shape, never an address: what the observe-mode log records to confirm the derivation.
  const shape = { xffDepth: xff.length, lastIsSource: xff.length > 0 && xff[xff.length - 1] === source };
  return { ip: ip || 'unknown', source: source || 'unknown', ...shape };
}

/** The counted dimensions of a request kind: [{name, key, limit, windowSec}]. */
function dimensions(kind, { ip, source, email, session }) {
  const d = [];
  if (kind === 'login') {
    d.push({ name: 'loginIp', id: hashId('ip', ip) });
    if (email) d.push({ name: 'loginEmail', id: hashId('email', email) });
    d.push({ name: 'loginGlobal', id: hashId('global', 'login') });
  } else if (kind === 'diagnose') {
    d.push({ name: 'diagnoseIp', id: hashId('ip', ip) });
    if (session) d.push({ name: 'diagnoseSession', id: hashId('session', session) });
    d.push({ name: 'diagnoseEdge', id: hashId('edge', source) });
    d.push({ name: 'diagnoseGlobal', id: hashId('global', 'diagnose') });
  }
  return d.map((x) => ({ ...x, ...LIMITS[x.name] }));
}

/**
 * Count one request against each dimension. `store.increment(pk, expiresAt)` returns the new count. Returns
 * {mode, limited, retryAfter, counts:[{name, count, limit}], error?}. Never throws.
 */
async function check(kind, ctx, { store, now = Date.now(), env = process.env } = {}) {
  const m = mode(env);
  if (m === 'off') return { mode: m, limited: false, counts: [] };
  const counts = [];
  let limited = false;
  let retryAfter = 0;
  try {
    for (const d of dimensions(kind, ctx)) {
      const windowStart = Math.floor(now / 1000 / d.windowSec) * d.windowSec;
      const pk = `${d.name}#${d.id}#${windowStart}`;
      const count = await store.increment(pk, windowStart + d.windowSec + 60);
      counts.push({ name: d.name, count, limit: d.limit, ...(d.advisory ? { advisory: true } : {}) });
      if (count > d.limit && !d.advisory) {
        limited = true;
        retryAfter = Math.max(retryAfter, windowStart + d.windowSec - Math.floor(now / 1000));
      }
    }
  } catch (e) {
    return { mode: m, limited: false, counts, error: String((e && e.message) || e).slice(0, 160) };
  }
  return { mode: m, limited: m === 'enforce' && limited, overLimit: limited, retryAfter, counts };
}

/** The DynamoDB store: one UpdateItem ADD per call (ddb.js signs with the function's role). */
function dynamoStore(dynamodb, table) {
  return {
    async increment(pk, expiresAt) {
      const r = await dynamodb('UpdateItem', {
        TableName: table,
        Key: { pk: { S: pk } },
        UpdateExpression: 'ADD n :one SET expiresAt = if_not_exists(expiresAt, :exp)',
        ExpressionAttributeValues: { ':one': { N: '1' }, ':exp': { N: String(expiresAt) } },
        ReturnValues: 'UPDATED_NEW',
      });
      return Number(r && r.Attributes && r.Attributes.n && r.Attributes.n.N) || 0;
    },
  };
}

module.exports = { LIMITS, mode, hashId, clientIp, dimensions, check, dynamoStore };
