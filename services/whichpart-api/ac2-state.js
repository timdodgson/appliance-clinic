'use strict';
/**
 * BFF-owned durable state for the ac2 engine: the evidence ledger (ac2/1), one item per conversation in the existing
 * `whichpart-transcripts` table, written with a version condition so two concurrent turns cannot both advance it.
 *
 *   AC2STATE#<csid>   { stateJson (the ledger), stateVersion (= ledger.turn), stateDigest, expiresAt }
 *
 * The browser holds only the opaque signed session token (state-token.js, unchanged); the ledger never leaves the
 * server. The item carries no `gsiPk`, so it never enters the admin activity index.
 */
const crypto = require('crypto');
const ddb = require('./ddb');
const stateToken = require('./state-token');

const PREFIX = 'AC2STATE#';
const SCHEMA = 'ac2/1';
const MAX_STATE_BYTES = 96 * 1024;
const digest = (s) => crypto.createHash('sha256').update(s).digest('hex');

function retentionDays(env = process.env) {
  const n = Number(env.TRANSCRIPT_RETENTION_DAYS);
  return Number.isFinite(n) && n > 0 ? n : 90;
}

function createStore(opts = {}) {
  const table = opts.table || process.env.TRANSCRIPT_TABLE || 'whichpart-transcripts';
  const call = opts.call || ((action, payload) => ddb.dynamodb(action, payload, opts.clientOpts || {}));
  const env = opts.env || process.env;
  return {
    /** -> { status: 'missing'|'ok'|'malformed'|'error', state, version } */
    async load(csid) {
      let res;
      try {
        res = await call('GetItem', { TableName: table, Key: { pk: ddb.S(PREFIX + csid) }, ConsistentRead: true });
      } catch (e) {
        return { status: 'error', error: String((e && e.message) || e).slice(0, 160) };
      }
      if (!res || !res.Item) return { status: 'missing', state: null, version: 0 };
      const it = ddb.unmarshall(res.Item);
      if (it.schemaVersion !== SCHEMA || typeof it.stateJson !== 'string' || it.stateDigest !== digest(it.stateJson)) return { status: 'malformed' };
      let state;
      try { state = JSON.parse(it.stateJson); } catch { return { status: 'malformed' }; }
      if (!state || state.schema !== SCHEMA || state.turn !== it.stateVersion) return { status: 'malformed' };
      return { status: 'ok', state, version: it.stateVersion };
    },
    /** Conditional write: expectedVersion 0 creates; N replaces only the version-N item. */
    async save(csid, state, expectedVersion, nowMs = Date.now()) {
      const json = JSON.stringify(state);
      if (Buffer.byteLength(json) > MAX_STATE_BYTES) return { ok: false, reason: 'overflow' };
      const item = {
        pk: ddb.S(PREFIX + csid),
        schemaVersion: ddb.S(SCHEMA),
        stateVersion: ddb.N(state.turn),
        stateJson: ddb.S(json),
        stateDigest: ddb.S(digest(json)),
        updatedAt: ddb.S(new Date(nowMs).toISOString()),
        expiresAt: ddb.N(Math.floor(nowMs / 1000) + retentionDays(env) * 86400),
      };
      const cond = expectedVersion === 0
        ? { ConditionExpression: 'attribute_not_exists(pk)' }
        : { ConditionExpression: 'stateVersion = :v', ExpressionAttributeValues: { ':v': ddb.N(expectedVersion) } };
      try {
        await call('PutItem', { TableName: table, Item: item, ...cond });
        return { ok: true };
      } catch (e) {
        const t = e && e.body && (e.body.__type || e.body.code);
        return { ok: false, reason: t && String(t).includes('ConditionalCheckFailed') ? 'conflict' : 'error' };
      }
    },
  };
}

/**
 * Resolve this turn's session: verify the presented token (any valid AC session token), or start a new session.
 * -> { csid, token, fresh }  or  { error }
 */
function session(body, secrets, { nowSec } = {}) {
  if (!secrets || !secrets.current) return { error: 'state_secret_unavailable' };
  const presented = typeof body.stateToken === 'string' ? body.stateToken : null;
  if (presented) {
    const v = stateToken.verifyToken(presented, secrets, nowSec ? { nowSec } : undefined);
    if (v && v.ok) return { csid: v.csid, token: v.rotated ? stateToken.issueToken(v.csid, secrets) : presented, fresh: false };
    // An invalid or expired token starts a new conversation state rather than failing the customer's turn.
  }
  const csid = stateToken.newCanonicalSessionId();
  return { csid, token: stateToken.issueToken(csid, secrets), fresh: true };
}

module.exports = { createStore, session, SCHEMA, PREFIX };
