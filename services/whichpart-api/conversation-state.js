'use strict';
/**
 * BFF-owned durable canonical ConversationState (canonical-architecture.md §11 durable state, §12 idempotency).
 *
 * Storage: the existing `whichpart-transcripts` table (TRANSCRIPT_TABLE), separate item types:
 *   STATE#<csid>                 current cs/1 state (one item, conditional writes)
 *   STATETURN#<csid>#<version>   immutable per-turn record (write-ahead log for one-step recovery)
 *   STATECLIENT#<csid>#<ctid>    idempotency marker for a browser clientTurnId (+ the cached view)
 * Neither item carries `gsiPk`, so neither enters the `gsi_activity` admin index.
 *
 * VERSION SEMANTICS (one counter): ConversationState.version == the number of customer messages
 * merged into this session's canonical state. The STATE item mirrors it as `stateVersion` (used by the
 * DynamoDB condition) and must always equal state.version. STATETURN#<csid>#<v> is the turn that
 * produced version v from v-1. Message index / turnIndex are metadata only.
 *
 * Every failure degrades the canonical turn (reported in the summary) and that turn falls back to the
 * legacy path; the legacy response path never depends on this module. Canonical state is never
 * reconstructed from transcript prose. Mode / allow-list: resolveMode (canonical-architecture.md §14).
 */

const crypto = require('crypto');
const ddb = require('./ddb');
const stateToken = require('./state-token');

const STATE_PREFIX = 'STATE#';
const TURN_PREFIX = 'STATETURN#';
const CLIENT_PREFIX = 'STATECLIENT#';
const MAX_CACHED_VIEW_BYTES = 96 * 1024;   // a larger view is not cached (the duplicate then gets a legacy reply)
const CLIENT_TURN_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{3,79}$/;
const SCHEMA = 'cs/1';
const MAX_STATE_BYTES = 64 * 1024;          // soft ceiling (plan §5); DynamoDB item limit is 400 KB
const MAX_CLASSIFICATION_BYTES = 16 * 1024; // turn-record bound
const MODES = ['off', 'shadow', 'control'];

function loadCore() {
  // Deployed bundle: ./canonical/* (copied by deploy.sh). Repo: services/part-finder/canonical/*.
  /* eslint-disable global-require */
  try {
    return { merge: require('./canonical/merge.js'), cs1: require('./canonical/cs1.js'), requests: require('./canonical/requests.js'),
      registry: require('./canonical/journey-registry.js') };
  } catch {
    return { merge: require('../part-finder/canonical/merge.js'), cs1: require('../part-finder/canonical/cs1.js'),
      requests: require('../part-finder/canonical/requests.js'), registry: require('../part-finder/canonical/journey-registry.js') };
  }
  /* eslint-enable global-require */
}
/** The only journeys canonical CONTROL may own: the shared registry (services/part-finder/canonical/journeys.json). */
const CONTROL_JOURNEYS = loadCore().registry.KEYS;

const stateKey = (csid) => STATE_PREFIX + csid;
const turnKey = (csid, version) => `${TURN_PREFIX}${csid}#${version}`;
const clientKey = (csid, ctid) => `${CLIENT_PREFIX}${csid}#${ctid}`;
const validClientTurnId = (x) => typeof x === 'string' && CLIENT_TURN_ID_RE.test(x);
const digest = (obj) => crypto.createHash('sha256').update(JSON.stringify(obj)).digest('hex');
const bytes = (obj) => Buffer.byteLength(JSON.stringify(obj), 'utf8');

function retentionDays(env = process.env) {
  const n = Number(env.TRANSCRIPT_RETENTION_DAYS);
  return Number.isFinite(n) && n > 0 ? n : 90;
}
function ttlEpoch(nowMs, env) { return Math.floor(nowMs / 1000) + retentionDays(env) * 86400; }

function isConditionalFailure(err) {
  const t = err && err.body && (err.body.__type || err.body.code);
  return Boolean(t && String(t).includes('ConditionalCheckFailed'));
}

/**
 * Resolve the BFF canonical mode. `control` needs a NARROW journey gate (CANONICAL_CONTROL_JOURNEYS,
 * '+' / ',' list of registry keys). Unknown keys are never enabled and are returned in `unknown` so the
 * caller logs them; with no valid key control is demoted to shadow. Rollback = CANONICAL_MODE=shadow
 * (every turn legacy) or remove one key from the gate (that journey legacy).
 */
function resolveMode(env = process.env) {
  const m = String(env.CANONICAL_MODE || 'off').trim().toLowerCase();
  if (!MODES.includes(m)) return { mode: 'off', demoted: false, invalid: true, journeys: [], unknown: [] };
  if (m === 'control') {
    const { journeys, unknown } = loadCore().registry.parseAllowList(env.CANONICAL_CONTROL_JOURNEYS);
    if (!journeys.length) return { mode: 'shadow', demoted: true, invalid: false, journeys: [], unknown };
    return { mode: 'control', demoted: false, invalid: false, journeys, unknown };
  }
  return { mode: m, demoted: false, invalid: false, journeys: [], unknown: [] };
}

// ---- store -------------------------------------------------------------------------------------------
function createStateStore(opts = {}) {
  const table = opts.table || process.env.TRANSCRIPT_TABLE || 'whichpart-transcripts';
  const call = opts.call || ((action, payload) => ddb.dynamodb(action, payload, opts.clientOpts || {}));
  const env = opts.env || process.env;
  const { cs1 } = loadCore();

  return {
    table,
    /** -> {status:'missing'|'ok'|'malformed'|'schema_mismatch'|'error', version, state, error} */
    async loadState(csid) {
      let res;
      try {
        res = await call('GetItem', { TableName: table, Key: { pk: ddb.S(stateKey(csid)) }, ConsistentRead: true });
      } catch (e) {
        return { status: 'error', error: String((e && e.message) || e) };
      }
      if (!res || !res.Item) return { status: 'missing', version: 0, state: null };
      const it = ddb.unmarshall(res.Item);
      if (it.schemaVersion !== SCHEMA) return { status: 'schema_mismatch', found: it.schemaVersion || null };
      let state;
      try { state = JSON.parse(it.stateJson); } catch { return { status: 'malformed', reason: 'state_json' }; }
      if (!state || state.schemaVersion !== cs1.SCHEMA_VERSION || !Number.isInteger(state.version)
          || state.version !== it.stateVersion || state.sessionId !== csid) {
        return { status: 'malformed', reason: 'state_shape' };
      }
      if (it.stateDigest && it.stateDigest !== digest(state)) return { status: 'malformed', reason: 'digest' };
      return { status: 'ok', version: state.version, state };
    },

    /** Conditional write: expectedVersion 0 → create only; N → only if stored stateVersion == N. */
    async putState(csid, state, expectedVersion, nowMs = Date.now()) {
      const size = bytes(state);
      if (size > MAX_STATE_BYTES) return { ok: false, reason: 'overflow', size };
      const item = ddb.compact({
        pk: ddb.S(stateKey(csid)),
        schemaVersion: ddb.S(SCHEMA),
        sessionId: ddb.S(csid),
        stateVersion: ddb.N(state.version),
        stateJson: ddb.S(JSON.stringify(state)),
        stateDigest: ddb.S(digest(state)),
        stateBytes: ddb.N(size),
        updatedAt: ddb.S(new Date(nowMs).toISOString()),
        expiresAt: ddb.N(ttlEpoch(nowMs, env)),
      });
      const cond = expectedVersion === 0
        ? { ConditionExpression: 'attribute_not_exists(pk)' }
        : { ConditionExpression: 'stateVersion = :v', ExpressionAttributeValues: { ':v': ddb.N(expectedVersion) } };
      try {
        await call('PutItem', { TableName: table, Item: item, ...cond });
        return { ok: true, size };
      } catch (e) {
        return { ok: false, reason: isConditionalFailure(e) ? 'conflict' : 'error', error: String((e && e.message) || e) };
      }
    },

    async getTurnRecord(csid, version) {
      let res;
      try {
        res = await call('GetItem', { TableName: table, Key: { pk: ddb.S(turnKey(csid, version)) }, ConsistentRead: true });
      } catch (e) {
        return { status: 'error', error: String((e && e.message) || e) };
      }
      if (!res || !res.Item) return { status: 'missing' };
      const it = ddb.unmarshall(res.Item);
      let classification = null;
      try { classification = JSON.parse(it.classificationJson); } catch { return { status: 'malformed' }; }
      if (it.schemaVersion !== SCHEMA || it.sessionId !== csid || it.version !== version
          || it.priorVersion !== version - 1 || !classification || !it.priorDigest || !it.stateDigest) {
        return { status: 'malformed' };
      }
      let issuedRequest = null;
      if (it.issuedRequestJson) {
        try { issuedRequest = JSON.parse(it.issuedRequestJson); } catch { return { status: 'malformed' }; }
      }
      return { status: 'ok', record: { ...it, classification, issuedRequest } };
    },

    /** Immutable: create-only. A second write of the same version reports 'exists'. */
    async putTurnRecord(rec, nowMs = Date.now()) {
      const classificationJson = JSON.stringify(rec.classification);
      if (Buffer.byteLength(classificationJson, 'utf8') > MAX_CLASSIFICATION_BYTES) return { ok: false, reason: 'overflow' };
      const item = ddb.compact({
        pk: ddb.S(turnKey(rec.sessionId, rec.version)),
        schemaVersion: ddb.S(SCHEMA),
        sessionId: ddb.S(rec.sessionId),
        priorVersion: ddb.N(rec.priorVersion),
        version: ddb.N(rec.version),
        messageId: ddb.S(rec.messageId),
        mode: ddb.S(rec.mode),
        classificationJson: ddb.S(classificationJson),
        priorDigest: ddb.S(rec.priorDigest),
        stateDigest: ddb.S(rec.stateDigest),
        rulesFired: ddb.S(JSON.stringify(rec.rulesFired || [])),
        clientTurnId: rec.clientTurnId ? ddb.S(rec.clientTurnId) : undefined,
        issuedRequestJson: rec.issuedRequest ? ddb.S(JSON.stringify(rec.issuedRequest)) : undefined,
        createdAt: ddb.S(new Date(nowMs).toISOString()),
        expiresAt: ddb.N(ttlEpoch(nowMs, env)),
      });
      try {
        await call('PutItem', { TableName: table, Item: item, ConditionExpression: 'attribute_not_exists(pk)' });
        return { ok: true };
      } catch (e) {
        return { ok: false, reason: isConditionalFailure(e) ? 'exists' : 'error', error: String((e && e.message) || e) };
      }
    },

    /** -> {status:'missing'|'ok'|'error', marker:{version, view|null}} */
    async getClientTurn(csid, ctid) {
      let res;
      try {
        res = await call('GetItem', { TableName: table, Key: { pk: ddb.S(clientKey(csid, ctid)) }, ConsistentRead: true });
      } catch (e) {
        return { status: 'error', error: String((e && e.message) || e) };
      }
      if (!res || !res.Item) return { status: 'missing' };
      const it = ddb.unmarshall(res.Item);
      let view = null;
      if (it.viewJson) { try { view = JSON.parse(it.viewJson); } catch { view = null; } }
      return { status: 'ok', marker: { version: it.version, mode: it.mode || null, view } };
    },

    /** Create-only idempotency marker. A concurrent duplicate that loses reports 'exists'. */
    async putClientTurn(csid, ctid, { version, mode, view }, nowMs = Date.now()) {
      const viewJson = view ? JSON.stringify(view) : null;
      const item = ddb.compact({
        pk: ddb.S(clientKey(csid, ctid)),
        schemaVersion: ddb.S(SCHEMA),
        sessionId: ddb.S(csid),
        clientTurnId: ddb.S(ctid),
        version: ddb.N(version),
        mode: mode ? ddb.S(mode) : undefined,
        viewJson: viewJson && Buffer.byteLength(viewJson, 'utf8') <= MAX_CACHED_VIEW_BYTES ? ddb.S(viewJson) : undefined,
        createdAt: ddb.S(new Date(nowMs).toISOString()),
        expiresAt: ddb.N(ttlEpoch(nowMs, env)),
      });
      try {
        await call('PutItem', { TableName: table, Item: item, ConditionExpression: 'attribute_not_exists(pk)' });
        return { ok: true };
      } catch (e) {
        return { ok: false, reason: isConditionalFailure(e) ? 'exists' : 'error', error: String((e && e.message) || e) };
      }
    },
  };
}

// ---- per-turn protocol ---------------------------------------------------------------------------------
/**
 * Before the orchestrator call. Never throws. Returns a context:
 *   { mode, block|null, token|null, csid|null, version, priorState, degraded|null, recovered }
 * `block` is sent to the orchestrator only when canonical shadow can run safely this turn.
 */
async function prepareTurn({ body, store, secrets, env = process.env, nowMs = Date.now(), newId, clientTurnId } = {}) {
  const { mode, demoted, journeys } = resolveMode(env);
  const ctx = { mode, demoted, journeys, block: null, token: null, csid: null, version: 0, priorState: null, degraded: null, recovered: false,
    clientTurnId: validClientTurnId(clientTurnId) ? clientTurnId : null, duplicate: null };
  if (mode === 'off') return ctx;
  try {
    const { merge: mergeMod, cs1 } = loadCore();
    if (!secrets) { ctx.degraded = 'no_signing_secret'; return ctx; }
    const nowSec = Math.floor(nowMs / 1000);
    const raw = body && typeof body.stateToken === 'string' ? body.stateToken : null;
    const v = stateToken.verifyToken(raw, secrets, { nowSec });
    if (!v.ok && v.reason !== 'missing') {
      // Invalid/expired/forged: never read state for it. Start a fresh canonical session next turn.
      ctx.degraded = 'token_' + v.reason;
      ctx.csid = stateToken.newCanonicalSessionId(newId);
      ctx.token = stateToken.issueToken(ctx.csid, secrets, { nowSec });
      return ctx;
    }
    if (!v.ok) {
      // No token: a new canonical session (server-minted id). Nothing to load.
      ctx.csid = stateToken.newCanonicalSessionId(newId);
      ctx.token = stateToken.issueToken(ctx.csid, secrets, { nowSec });
      ctx.version = 0;
      ctx.priorState = null;
      ctx.block = makeBlock(ctx);
      return ctx;
    }
    ctx.csid = v.csid;
    ctx.token = stateToken.issueToken(ctx.csid, secrets, { nowSec }); // sliding expiry
    const loaded = await store.loadState(ctx.csid);
    if (loaded.status === 'error') { ctx.degraded = 'read_failed'; return ctx; }
    if (loaded.status !== 'ok' && loaded.status !== 'missing') { ctx.degraded = 'state_' + loaded.status; return ctx; }
    ctx.version = loaded.version;
    ctx.priorState = loaded.state;

    // One-step recovery of a missed state write (typed data only).
    const rec = await store.getTurnRecord(ctx.csid, ctx.version + 1);
    if (rec.status === 'error') { ctx.degraded = 'read_failed'; return ctx; }
    if (rec.status === 'malformed') { ctx.degraded = 'replay_record_malformed'; return ctx; }
    if (rec.status === 'ok') {
      const r = recoverOneStep({ csid: ctx.csid, version: ctx.version, state: ctx.priorState, record: rec.record, mergeMod, cs1, requestsMod: loadCore().requests });
      if (!r.ok) { ctx.degraded = r.reason; return ctx; }
      const w = await store.putState(ctx.csid, r.state, ctx.version, nowMs);
      if (!w.ok) { ctx.degraded = w.reason === 'conflict' ? 'replay_conflict' : 'replay_write_failed'; return ctx; }
      ctx.version = r.state.version;
      ctx.priorState = r.state;
      ctx.recovered = true;
      const next = await store.getTurnRecord(ctx.csid, ctx.version + 1);
      if (next.status !== 'missing') { ctx.degraded = 'replay_gap'; return ctx; }
    }
    // IDEMPOTENCY: a clientTurnId already merged for THIS canonical session is never merged again
    // (no version bump). Detected by the marker (written after a successful persist, with the cached
    // view) or by the latest turn record carrying the same id (state persisted, marker not yet written).
    if (ctx.clientTurnId) {
      const dup = await findDuplicate(store, ctx);
      if (dup === 'error') { ctx.degraded = 'read_failed'; return ctx; }
      if (dup) { ctx.duplicate = dup; return ctx; } // no block: nothing is merged or persisted this turn
    }
    ctx.block = makeBlock(ctx);
    return ctx;
  } catch (e) {
    ctx.block = null;
    ctx.degraded = 'prepare_failed';
    ctx.error = String((e && e.message) || e).slice(0, 160);
    return ctx;
  }
}

async function findDuplicate(store, ctx) {
  const m = await store.getClientTurn(ctx.csid, ctx.clientTurnId);
  if (m.status === 'error') return 'error';
  if (m.status === 'ok') return { source: 'marker', version: m.marker.version, mode: m.marker.mode, view: m.marker.view || null };
  if (ctx.version > 0) {
    const r = await store.getTurnRecord(ctx.csid, ctx.version);
    if (r.status === 'error') return 'error';
    if (r.status === 'ok' && r.record.clientTurnId === ctx.clientTurnId) {
      return { source: 'turn_record', version: ctx.version, mode: r.record.mode || null, view: null };
    }
  }
  return null;
}

function makeBlock(ctx) {
  const block = { schema: SCHEMA, mode: ctx.mode === 'control' ? 'control' : 'shadow', sessionId: ctx.csid, version: ctx.version, state: ctx.priorState, degraded: null };
  if (block.mode === 'control') block.control = { journeys: ctx.journeys.slice() };
  if (ctx.clientTurnId) block.clientTurnId = ctx.clientTurnId;
  return block;
}

/**
 * Recovery rule (exactly one step): STATE is at version N (or missing = 0), STATETURN#csid#(N+1)
 * exists with priorVersion N and priorDigest == digest(current state | empty state). Then
 * merge(current, record.classification, {turn: N+1}) must reproduce record.stateDigest exactly.
 * Any mismatch → no write, degrade. Never reconstructs from transcript prose.
 */
function recoverOneStep({ csid, version, state, record, mergeMod, cs1, requestsMod }) {
  const prior = state || cs1.emptyState(csid);
  if (record.priorVersion !== version || record.version !== version + 1) return { ok: false, reason: 'replay_version_mismatch' };
  if (record.priorDigest !== digest(prior)) return { ok: false, reason: 'replay_prior_mismatch' };
  let { state: next } = mergeMod.merge(prior, record.classification, { turn: version + 1 });
  // Canonical CONTROL turns also issued one policy request after the merge; replay applies it verbatim
  // (diagnostics/policy are never re-run here).
  if (record.issuedRequest) {
    const rqm = requestsMod || loadCore().requests;
    const { overflow, ...req } = record.issuedRequest;
    next = rqm.issueRequest(next, req, version + 1).state;
  }
  if (digest(next) !== record.stateDigest) return { ok: false, reason: 'replay_result_mismatch' };
  return { ok: true, state: next };
}

/** Validate the orchestrator's `_canonical` output against the prepared context. */
function validateOutput(ctx, out) {
  if (!out || typeof out !== 'object') return 'missing_output';
  if (out.degraded) return 'upstream_' + String(out.degraded).slice(0, 40);
  if (out.schema !== SCHEMA || out.sessionId !== ctx.csid) return 'output_session_mismatch';
  if (out.priorVersion !== ctx.version || out.version !== ctx.version + 1) return 'output_version_mismatch';
  const s = out.state;
  if (!s || s.schemaVersion !== SCHEMA || s.version !== out.version || s.sessionId !== ctx.csid) return 'output_state_invalid';
  if (!out.classification || typeof out.classification !== 'object') return 'output_classification_missing';
  return null;
}

/**
 * After the orchestrator call. Never throws. Ordering: turn record FIRST (write-ahead), then the
 * conditional state write. If the state write is missed, the next turn recovers it from the record.
 */
async function finishTurn(ctx, out, { store, messageId, nowMs = Date.now() } = {}) {
  const result = { written: false, recordWritten: false, degraded: ctx ? ctx.degraded : null };
  if (!ctx || !ctx.block) return result;
  try {
    const bad = validateOutput(ctx, out);
    if (bad) { result.degraded = bad; return result; }
    const { cs1 } = loadCore();
    if (bytes(out.state) > MAX_STATE_BYTES) { result.degraded = 'overflow'; return result; }
    const prior = ctx.priorState || cs1.emptyState(ctx.csid);
    const rec = await store.putTurnRecord({
      sessionId: ctx.csid, priorVersion: ctx.version, version: out.version, messageId: messageId || null,
      mode: ctx.mode === 'control' ? 'control' : 'shadow', classification: out.classification, priorDigest: digest(prior), stateDigest: digest(out.state),
      rulesFired: out.rulesFired || [], clientTurnId: ctx.clientTurnId || null,
      issuedRequest: out.issuedRequest && typeof out.issuedRequest === 'object' ? out.issuedRequest : null,
    }, nowMs);
    if (!rec.ok && rec.reason === 'exists') { result.degraded = 'conflict'; return result; } // a concurrent turn owns this version
    result.recordWritten = rec.ok;
    if (!rec.ok) result.degraded = 'turn_record_' + rec.reason;
    const w = await store.putState(ctx.csid, out.state, ctx.version, nowMs);
    if (!w.ok) { result.degraded = w.reason === 'conflict' ? 'conflict' : (w.reason === 'overflow' ? 'overflow' : 'state_write_failed'); return result; }
    result.written = true;
    return result;
  } catch (e) {
    result.degraded = 'finish_failed';
    result.error = String((e && e.message) || e).slice(0, 160);
    return result;
  }
}

/**
 * After the response view is built. Writes the idempotency marker ONLY for a turn whose state was
 * persisted (a degraded attempt leaves no marker, so its retry is processed normally). Never throws.
 */
async function recordClientTurn(ctx, result, view, { store, nowMs = Date.now() } = {}) {
  if (!ctx || !ctx.clientTurnId || !ctx.csid || !result || !result.written) return { ok: false, reason: 'not_applicable' };
  try {
    const cached = view ? { ...view } : null;
    if (cached) delete cached.stateToken; // the token is re-issued per request
    return await store.putClientTurn(ctx.csid, ctx.clientTurnId, { version: ctx.version + 1, mode: ctx.mode, view: cached }, nowMs);
  } catch (e) {
    return { ok: false, reason: 'error', error: String((e && e.message) || e).slice(0, 160) };
  }
}

/** Safe correlation reference for a canonical session (never the csid itself; the csid is bearer-bound). */
function sessionRef(csid) {
  return csid ? crypto.createHash('sha256').update('cs-ref:' + csid).digest('hex').slice(0, 12) : null;
}

/** Compact mc/1 projection for traces/logs (no prose, no full classification). */
function mc1Summary(c) {
  if (!c || typeof c !== 'object') return null;
  const id = c.identity || {};
  return {
    scope: c.scope || null,
    appliance: (id.appliance && id.appliance.value) || null,
    make: (id.make && id.make.value) || null,
    model: Boolean(id.model && id.model.value),
    journey: (c.problem && c.problem.journey) || null,
    hazard: (c.safety && c.safety.hazard) || null,
    toPending: (c.reply && c.reply.toPending) || null,
    observations: Array.isArray(c.observations) ? c.observations.map((o) => o && o.key).filter(Boolean).slice(0, 12) : [],
    checks: Array.isArray(c.checks) ? c.checks.map((k) => k && `${k.check}:${k.status}`).filter(Boolean).slice(0, 12) : [],
  };
}

/**
 * One bounded summary of the canonical turn, shared by the BFF log line and the persisted diagnostic
 * trace stage. Contains no canonical state body, no token and no csid (only `ref`).
 */
function summarise(ctx, out, result) {
  if (!ctx || ctx.mode === 'off') return null;
  const ok = Boolean(result && result.written);
  const valid = out && typeof out === 'object' && !out.degraded;
  return {
    mode: ctx.mode,
    demoted: ctx.demoted || undefined,
    journeys: ctx.mode === 'control' ? ctx.journeys : undefined,
    duplicate: ctx.duplicate ? { source: ctx.duplicate.source, version: ctx.duplicate.version, cachedView: Boolean(ctx.duplicate.view) } : undefined,
    clientTurnId: ctx.clientTurnId ? true : undefined,
    issuedRequest: valid && out.issuedRequest ? out.issuedRequest : undefined,
    journey: valid && out.journey ? out.journey : undefined,
    ref: sessionRef(ctx.csid),
    priorVersion: ctx.block ? ctx.version : null,
    resultVersion: ok ? out.version : (ctx.block ? ctx.version : null),
    recovered: ctx.recovered || undefined,
    mc1: valid ? mc1Summary(out.classification) : null,
    rulesFired: valid && Array.isArray(out.rulesFired) ? out.rulesFired.slice(0, 30) : [],
    requestOutcome: valid ? (out.requestOutcome || null) : null,
    persistence: { recordWritten: Boolean(result && result.recordWritten), stateWritten: ok },
    stateBytes: ok && out.state ? bytes(out.state) : null,
    degraded: (result && result.degraded) || ctx.degraded || null,
    classifier: classifierSummary(out && out.classifier),
  };
}

/** mc/1 classifier observability (source, degraded reason, recall gap, latency). */
function classifierSummary(k) {
  if (!k || typeof k !== 'object') return null;
  return {
    source: typeof k.source === 'string' ? k.source.slice(0, 40) : null,
    degraded: Boolean(k.degraded), reason: k.reason ? String(k.reason).slice(0, 40) : null,
    recallGap: k.recallGap && k.recallGap.type ? { type: String(k.recallGap.type).slice(0, 20), roleFilled: Boolean(k.recallGap.roleFilled) } : null,
    questionCount: Number.isFinite(k.questionCount) ? k.questionCount : null,
    jevMs: Number.isFinite(k.jevMs) ? k.jevMs : null,
  };
}

/** Diagnostic-trace stage (admin trace only; never in the browser view). */
function traceStage(summary) {
  if (!summary) return null;
  return {
    id: 'canonical-state',
    label: summary.mode === 'control' ? `Canonical state persistence (cs/1, control gate: ${(summary.journeys || []).length} journeys)` : 'Canonical state persistence (cs/1 shadow, non-authoritative)',
    evidence: summary.persistence.stateWritten || summary.degraded ? 'OBSERVED' : 'NOT_CAPTURED',
    summary: summary.degraded
      ? `canonical ${summary.mode} degraded: ${summary.degraded}`
      : `canonical ${summary.mode} v${summary.priorVersion} -> v${summary.resultVersion}${summary.recovered ? ' (recovered one step)' : ''}`
        + (summary.journey && summary.journey.key ? ` · ${summary.journey.key}${summary.journey.control ? ' (control)' : ''}` : ''),
    detail: summary,
  };
}

module.exports = {
  STATE_PREFIX, TURN_PREFIX, CLIENT_PREFIX, CONTROL_JOURNEYS, SCHEMA, MAX_STATE_BYTES, MAX_CLASSIFICATION_BYTES,
  stateKey, turnKey, clientKey, digest, resolveMode, isConditionalFailure,
  createStateStore, prepareTurn, finishTurn, recordClientTurn, recoverOneStep, validateOutput, loadCore,
  sessionRef, mc1Summary, summarise, traceStage,
};
