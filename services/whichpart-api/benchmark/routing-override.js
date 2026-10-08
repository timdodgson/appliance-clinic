'use strict';
/**
 * Batch routing override — single owner of LIVE AI routing during a batch run.
 *
 * A batch run that needs different COMPOSE routing temporarily changes the live AI-config document
 * (the deployed Part Finder reads only that). This module makes that change safe:
 *
 *   • ONE owner: a lease document `acq/routing/override.json` written with S3 conditional writes
 *     (If-None-Match / If-Match). A second run cannot take ownership while one is active/blocked.
 *   • EXACT snapshot: the full pre-run AI-config document (every field, unknown fields included)
 *     is persisted in the lease BEFORE any change, with its content revision and version.
 *   • MINIMAL override: temporary config = pre-run document + only the fields the run needs.
 *     UNDERSTAND is TypeSafe Jev, so a run's UNDERSTAND provider is never applied.
 *   • SAFE restore: only if the live document is still exactly the batch-written one. Anything
 *     else is a CONFLICT — the newer config is kept and further routing batches are blocked until
 *     an admin decides. After writing, the document is read back and verified before release.
 *   • AUDITED: start and restore are entries in the same AI-config history Settings uses
 *     (system actor + the requesting admin + run id + from → to + reason + version).
 *   • IDEMPOTENT: every transition is keyed by run id + state + revision; retries never duplicate
 *     history entries or double-apply.
 *   • RECOVERABLE: owners heartbeat the lease. A stale lease (crashed/paused worker) or a lease
 *     whose run is already terminal is restored by `recover()` — run from the worker loop AND
 *     from the deployed API's 15-minute schedule, so a dead worker cannot leave it live.
 *
 * No secrets: the AI-config document holds no keys (they are separate secrets).
 */

const { readBackAfterWrite } = require('../config-readback.js');
const { routingAllowed } = require('./target.js');

const LOCK_KEY = 'acq/routing/override.json';
const SCHEMA = 'acq-routing-override/1';
const SYSTEM_ACTOR = 'system:batch-runner';
const AUDIT_KEYS = ['version', 'updatedAt', 'updatedByEmail', 'history'];
const DEFAULT_LEASE_MS = 3 * 60 * 1000;
const HISTORY_CAP = 50;
const ACTIVE = new Set(['acquired', 'applied', 'restoring', 'restore_failed']);
const BLOCKED = new Set(['conflict']);
const TERMINAL_RUN = new Set(['COMPLETED', 'CANCELLED', 'FAILED', 'RESTORE_FAILED']);

const clone = (v) => (v == null ? v : JSON.parse(JSON.stringify(v)));
function canonical(v) {
  if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
  if (v && typeof v === 'object') return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + canonical(v[k])).join(',') + '}';
  return JSON.stringify(v === undefined ? null : v);
}
/** Every configuration field of the document, i.e. everything except the audit envelope. */
function configFields(doc) {
  const out = {};
  Object.keys(doc || {}).forEach((k) => { if (AUDIT_KEYS.indexOf(k) === -1) out[k] = clone(doc[k]); });
  return out;
}
function sameConfig(a, b) { return canonical(configFields(a)) === canonical(configFields(b)); }

const FIELDS = [
  ['routing.compose', 'COMPOSE provider'], ['routing.understand', 'Legacy UNDERSTAND routing'],
  ['local.enabled', 'Private AI enabled'], ['local.model', 'Private AI model id'], ['local.endpoint', 'Private AI endpoint override'],
  ['frontier.enabled', 'OpenAI enabled'], ['frontier.model', 'OpenAI model'],
];
function get(doc, p) { const [a, b] = p.split('.'); return doc && doc[a] && doc[a][b] !== undefined ? doc[a][b] : null; }
function endpointHost(v) { if (!v) return '(deployed default)'; try { return new URL(v).host; } catch { return '(custom address)'; } }
function diff(from, to) {
  return FIELDS.filter(([p]) => canonical(get(from, p)) !== canonical(get(to, p))).map(([p, label]) => ({
    field: p, label,
    from: p === 'local.endpoint' ? endpointHost(get(from, p)) : get(from, p),
    to: p === 'local.endpoint' ? endpointHost(get(to, p)) : get(to, p),
  }));
}

/**
 * Minimal temporary config for a run: pre-run fields + only what the run's COMPOSE needs.
 * runConfig = { understand:{provider,model}, compose:{provider,model} } (the run's frozen snapshot).
 */
function planOverride(preDoc, runConfig) {
  const pre = configFields(preDoc || {});
  const next = clone(pre);
  const compose = (runConfig && runConfig.compose) || {};
  const model = typeof compose.model === 'string' ? compose.model.trim() : '';
  const notes = [];
  const ensure = (k) => { if (!next[k] || typeof next[k] !== 'object') next[k] = {}; };
  if (compose.provider === 'openai') {
    ensure('routing'); ensure('frontier');
    next.routing.compose = 'frontier';
    next.frontier.enabled = true;
    next.frontier.provider = 'openai';
    if (model) next.frontier.model = model;
  } else if (compose.provider === 'lmstudio') {
    if (get(pre, 'routing.compose') !== 'local') { ensure('routing'); next.routing.compose = 'local'; }
    if (model) { ensure('local'); next.local.model = model; }
  }
  const u = (runConfig && runConfig.understand) || {};
  if (u.provider === 'openai') notes.push('UNDERSTAND is TypeSafe Jev: the run\u2019s OpenAI UNDERSTAND setting has no live lever and was not applied.');
  const changes = diff(pre, next);
  return { required: changes.length > 0, fields: next, changes, notes };
}

function createRoutingOverride(deps) {
  const lockStore = deps.lockStore;       // { get(key) -> {body, etag}|null, put(key, body, {ifMatch|ifNoneMatch}) (throws code 'precondition') }
  const loadDoc = deps.loadDoc;           // () -> { status, doc }
  const saveDoc = deps.saveDoc;           // (doc) -> void
  const revisionOf = deps.revisionOf;     // (doc) -> string  (Settings' content revision)
  const now = deps.now || (() => Date.now());
  const leaseMs = deps.leaseMs || DEFAULT_LEASE_MS;
  const validate = deps.validate || null; // async (fieldsDoc) -> [errors]
  const log = deps.log || (() => {});
  const iso = () => new Date(now()).toISOString();
  // Read-after-write verification (see readBack): bounded re-reads while the store still shows the old version.
  const readBackAttempts = Number.isInteger(deps.readBackAttempts) && deps.readBackAttempts > 0 ? deps.readBackAttempts : 8;
  const readBackDelayMs = Number.isFinite(deps.readBackDelayMs) ? deps.readBackDelayMs : 750;
  const sleep = deps.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));

  async function readLock() {
    const r = await lockStore.get(LOCK_KEY);
    if (!r || !r.body) return { lock: null, etag: null };
    try { return { lock: JSON.parse(r.body), etag: r.etag || null }; } catch { return { lock: { schema: SCHEMA, state: 'conflict', corrupt: true }, etag: r.etag || null }; }
  }
  async function writeLock(lock, etag) {
    lock.updatedAt = iso();
    await lockStore.put(LOCK_KEY, JSON.stringify(lock), etag ? { ifMatch: etag } : { ifNoneMatch: '*' });
    const again = await lockStore.get(LOCK_KEY);
    return again ? again.etag : null;
  }
  function event(lock, state, detail) {
    lock.events = (lock.events || []).concat([{ at: iso(), state, detail: detail || null }]).slice(-40);
  }
  function stale(lock) {
    const t = Date.parse(lock && (lock.heartbeatAt || lock.acquiredAt) || '');
    return !Number.isFinite(t) || now() - t > (lock.leaseMs || leaseMs);
  }
  function historyEntry(kind, lock, fromDoc, toDoc, note) {
    return {
      at: iso(), byEmail: SYSTEM_ACTOR, requestedBy: lock.requestedBy || null, event: kind, runId: lock.runId,
      note: note || null, changes: diff(fromDoc, toDoc), fromRevision: revisionOf(fromDoc),
    };
  }
  /** Write `fields` as the new document, appending one audit entry to the CURRENT document's history. */
  function nextDocument(fields, currentDoc, entry) {
    const prevVersion = Number.isInteger(currentDoc && currentDoc.version) && currentDoc.version > 0 ? currentDoc.version : 1;
    entry.version = prevVersion + 1;
    const hist = Array.isArray(currentDoc && currentDoc.history) ? currentDoc.history : [];
    return Object.assign(clone(fields), { version: prevVersion + 1, updatedAt: entry.at, updatedByEmail: SYSTEM_ACTOR, history: [entry].concat(hist).slice(0, HISTORY_CAP) });
  }
  async function current() {
    const c = await loadDoc();
    if (!c || c.status !== 'ok' || !c.doc) return null;
    return c.doc;
  }
  /**
   * Read-after-write verification. Secrets Manager reads are eventually consistent: straight after a
   * PutSecretValue a read can still return the PREVIOUS version. So a read that still shows the
   * revision we wrote over (`priorRevision`) is "not visible yet" and is re-read (bounded); any OTHER
   * revision is a genuine different writer and is returned at once. Returns the last document read.
   */
  async function readBack(expectedRevision, priorRevision) {
    // The shared rule (config-readback.js): re-read only while the exact prior revision is still
    // shown; any other revision is returned at once (a genuine different writer).
    const r = await readBackAfterWrite({
      read: () => current(), revisionOf, expectedRevision, priorRevision,
      attempts: readBackAttempts, delayMs: readBackDelayMs, sleep,
    });
    return r.doc;
  }

  /** Public, secret-free summary for the API / UI / run record. */
  function summary(lock) {
    if (!lock) return null;
    return {
      schema: lock.schema || SCHEMA, runId: lock.runId || null, state: lock.state || null,
      active: ACTIVE.has(lock.state), blocked: BLOCKED.has(lock.state),
      owner: lock.owner || null, requestedBy: lock.requestedBy || null,
      acquiredAt: lock.acquiredAt || null, heartbeatAt: lock.heartbeatAt || null, leaseMs: lock.leaseMs || leaseMs,
      appliedAt: lock.appliedAt || null, releasedAt: lock.releasedAt || null,
      preRun: lock.preRun ? { revision: lock.preRun.revision, version: lock.preRun.version, routing: routingOf(lock.preRun.doc) } : null,
      temporary: lock.temporary ? { revision: lock.temporary.revision || null, version: lock.temporary.version || null, changes: lock.temporary.changes || [], routing: routingOf(lock.temporary.fields) } : null,
      restore: lock.restore || null, resolution: lock.resolution || null, notes: lock.notes || [],
      events: (lock.events || []).slice(-12),
    };
  }
  function routingOf(doc) {
    const compose = get(doc, 'routing.compose') || 'local';
    return { compose, composeLabel: compose === 'frontier' ? 'OpenAI' : 'Private AI', model: compose === 'frontier' ? (get(doc, 'frontier.model') || null) : (get(doc, 'local.model') || null) };
  }

  async function status() { const { lock } = await readLock(); return summary(lock); }

  /** Take ownership and apply the minimal override for `run`. Idempotent for the same run id. */
  async function begin({ run, workerId }) {
    const { lock: existing, etag } = await readLock();
    if (existing && BLOCKED.has(existing.state)) return { ok: false, code: 'blocked', lock: summary(existing) };
    if (existing && ACTIVE.has(existing.state) && existing.runId !== run.runId) return { ok: false, code: 'busy', lock: summary(existing) };
    if (existing && existing.runId === run.runId && existing.state === 'applied') {
      return { ok: true, required: true, resumed: true, lock: summary(existing) };
    }
    const cur = await loadDoc();
    if (!cur || cur.status === 'unavailable') return { ok: false, code: 'config_unavailable' };
    if (cur.status !== 'ok' || !cur.doc) return { ok: false, code: 'no_config_document', detail: 'The AI configuration document is ' + (cur && cur.status) + '; a batch must not create or reshape it.' };
    const curRev = revisionOf(cur.doc);

    // Resume a crashed acquisition for the SAME run (nothing or exactly our write happened).
    if (existing && existing.runId === run.runId && existing.state === 'acquired') {
      if (existing.temporary && existing.temporary.revision && curRev === existing.temporary.revision) {
        existing.state = 'applied'; existing.appliedAt = iso(); event(existing, 'applied', 'resumed after restart');
        await writeLock(existing, etag);
        return { ok: true, required: true, resumed: true, lock: summary(existing) };
      }
      if (curRev !== existing.preRun.revision) {
        existing.state = 'conflict';
        existing.restore = { status: 'conflict', at: iso(), detail: 'Config changed while ownership was being taken; nothing was applied by this run.', currentRevision: curRev };
        event(existing, 'conflict', 'config changed during acquisition'); await writeLock(existing, etag);
        return { ok: false, code: 'conflict', lock: summary(existing) };
      }
    }

    const plan = planOverride(cur.doc, run.config);
    if (!plan.required) return { ok: true, required: false, notes: plan.notes };
    // Phase 7: live routing is production configuration (the diagnosis service reads it too). Only a run queued with
    // recorded production routing intent (target.js) may change it. Nothing is written when refused.
    if (!routingAllowed(run)) return { ok: false, code: 'production_routing_not_confirmed', changes: plan.changes };
    if (validate) {
      const errors = await validate(plan.fields);
      if (errors && errors.length) return { ok: false, code: 'invalid_override', errors };
    }
    const lock = (existing && existing.runId === run.runId && existing.state === 'acquired') ? existing : {
      schema: SCHEMA, runId: run.runId, owner: { workerId }, requestedBy: run.enqueuedByEmail || null,
      reason: 'Batch run ' + run.runId + (run.label ? ' (' + run.label + ')' : ''),
      acquiredAt: iso(), heartbeatAt: iso(), leaseMs, state: 'acquired',
      preRun: { doc: clone(cur.doc), revision: curRev, version: cur.doc.version || null, capturedAt: iso() },
      temporary: { fields: plan.fields, changes: plan.changes, revision: null, version: null },
      notes: plan.notes, events: [],
    };
    if (lock === existing) { lock.owner = { workerId }; lock.heartbeatAt = iso(); }
    else event(lock, 'acquired', null);
    let lockEtag;
    try { lockEtag = await writeLock(lock, lock === existing ? etag : (existing ? etag : null)); }
    catch (e) {
      if (e && e.code === 'precondition') return { ok: false, code: 'busy', detail: 'Another run took ownership first.' };
      throw e;
    }
    // Narrow the race with a concurrent Settings write: the snapshot must still be what is live.
    const again = await current();
    if (!again || revisionOf(again) !== curRev) {
      lock.state = 'released'; lock.releasedAt = iso();
      lock.restore = { status: 'not_applied', at: iso(), detail: 'Config changed while ownership was being taken; nothing was applied.' };
      event(lock, 'released', 'config changed before apply'); await writeLock(lock, lockEtag);
      return { ok: false, code: 'config_changed' };
    }
    const entry = historyEntry('batch-override-start', lock, cur.doc, plan.fields, 'Temporary routing for batch run ' + run.runId);
    const temp = nextDocument(plan.fields, cur.doc, entry);
    lock.temporary.revision = revisionOf(temp);
    lock.temporary.version = temp.version;
    lockEtag = await writeLock(lock, lockEtag); // record the target revision BEFORE writing (crash-safe)
    try {
      await saveDoc(temp);
    } catch (e) {
      const rb = await current().catch(() => null);
      if (rb && revisionOf(rb) === curRev) {
        lock.state = 'released'; lock.releasedAt = iso();
        lock.restore = { status: 'not_applied', at: iso(), detail: 'Temporary config write failed; production config unchanged.' };
        event(lock, 'released', 'apply write failed'); await writeLock(lock, lockEtag);
        return { ok: false, code: 'apply_failed' };
      }
      if (!rb || revisionOf(rb) !== lock.temporary.revision) {
        lock.state = 'restore_failed';
        lock.restore = { status: 'unknown', at: iso(), detail: 'Temporary config write failed with an unknown outcome; recovery will verify and restore.' };
        event(lock, 'restore_failed', 'apply outcome unknown'); await writeLock(lock, lockEtag);
        return { ok: false, code: 'apply_unknown' };
      }
    }
    const verify = await readBack(lock.temporary.revision, curRev);
    if (!verify || revisionOf(verify) !== lock.temporary.revision) {
      lock.state = 'conflict';
      lock.restore = { status: 'conflict', at: iso(), detail: 'The temporary config could not be verified after writing (another writer?). Nothing will be overwritten automatically.', currentRevision: verify ? revisionOf(verify) : null };
      event(lock, 'conflict', 'temporary config not verified'); await writeLock(lock, lockEtag);
      return { ok: false, code: 'conflict', lock: summary(lock) };
    }
    lock.state = 'applied'; lock.appliedAt = iso(); lock.heartbeatAt = iso();
    event(lock, 'applied', null);
    await writeLock(lock, lockEtag);
    log({ evt: 'batch-routing-override', state: 'applied', runId: run.runId, changes: plan.changes.map((c) => c.field), version: temp.version });
    return { ok: true, required: true, lock: summary(lock) };
  }

  async function heartbeat(runId, workerId) {
    for (let i = 0; i < 2; i++) {
      const { lock, etag } = await readLock();
      if (!lock || lock.runId !== runId || !ACTIVE.has(lock.state)) return false;
      lock.heartbeatAt = iso(); lock.owner = { workerId };
      try { await writeLock(lock, etag); return true; } catch (e) { if (!(e && e.code === 'precondition')) throw e; }
    }
    return false;
  }
  /** The run may keep testing only while it still owns an APPLIED override. */
  async function stillOwned(runId) {
    const { lock } = await readLock();
    return Boolean(lock && lock.runId === runId && lock.state === 'applied');
  }

  /**
   * THE single restore path (completed / failed / cancelled / timed out / recovered).
   * Restores the exact pre-run configuration only if live config is still the batch-written one.
   */
  async function restore({ runId, reason, actor }) {
    const { lock, etag } = await readLock();
    if (!lock || lock.runId !== runId) return { ok: true, state: 'none' };
    if (lock.state === 'released') return { ok: true, state: 'released', already: true, lock: summary(lock) };
    if (BLOCKED.has(lock.state)) return { ok: false, code: 'conflict', lock: summary(lock) };
    const cur = await loadDoc().catch(() => null);
    if (!cur || cur.status !== 'ok' || !cur.doc) {
      lock.state = 'restore_failed';
      lock.restore = { status: 'failed', at: iso(), detail: 'AI configuration could not be read for restore (' + ((cur && cur.status) || 'error') + ').' };
      event(lock, 'restore_failed', 'config unreadable'); await writeLock(lock, etag);
      return { ok: false, code: 'restore_failed', lock: summary(lock) };
    }
    const preDoc = lock.preRun.doc;
    let lockEtag = etag;
    const release = async (detail, revision) => {
      lock.state = 'released'; lock.releasedAt = iso();
      lock.restore = { status: 'restored', verified: true, at: iso(), revision: revision || revisionOf(cur.doc), detail, reason: reason || null, by: actor || SYSTEM_ACTOR };
      event(lock, 'released', detail); await writeLock(lock, lockEtag);
      log({ evt: 'batch-routing-override', state: 'released', runId, detail });
      return { ok: true, state: 'released', lock: summary(lock) };
    };
    // Already exactly the pre-run config (a retried restore, or the temporary write never landed).
    if (sameConfig(cur.doc, preDoc)) return release('Live config already equals the exact pre-run config.');
    if (!lock.temporary || !lock.temporary.revision || revisionOf(cur.doc) !== lock.temporary.revision) {
      lock.state = 'conflict';
      lock.restore = {
        status: 'conflict', at: iso(), currentRevision: revisionOf(cur.doc), expectedRevision: lock.temporary && lock.temporary.revision,
        detail: 'The live AI configuration changed during the run. It was NOT overwritten. An admin must decide whether to keep it or restore the pre-run configuration.',
        reason: reason || null,
      };
      event(lock, 'conflict', 'live config is not the batch-written config');
      await writeLock(lock, lockEtag);
      log({ evt: 'batch-routing-override', state: 'conflict', runId });
      return { ok: false, code: 'conflict', lock: summary(lock) };
    }
    lock.state = 'restoring'; event(lock, 'restoring', reason || null);
    lockEtag = await writeLock(lock, lockEtag);
    const entry = historyEntry('batch-override-restore', lock, cur.doc, preDoc, 'Restore exact pre-run config after batch run ' + runId + (reason ? ' — ' + reason : ''));
    const restoredDoc = nextDocument(configFields(preDoc), cur.doc, entry);
    try { await saveDoc(restoredDoc); } catch (e) {
      lock.state = 'restore_failed';
      lock.restore = { status: 'failed', at: iso(), detail: 'Writing the pre-run config failed: ' + String((e && e.name) || 'Error') + '. Temporary routing may still be live; recovery will retry.' };
      event(lock, 'restore_failed', 'restore write failed'); await writeLock(lock, lockEtag);
      return { ok: false, code: 'restore_failed', lock: summary(lock) };
    }
    const rb = await readBack(revisionOf(restoredDoc), revisionOf(cur.doc));
    if (!rb || !sameConfig(rb, preDoc) || revisionOf(rb) !== revisionOf(restoredDoc)) {
      lock.state = 'restore_failed';
      lock.restore = { status: 'unverified', at: iso(), detail: 'The restored config could not be verified on read-back. Ownership is retained; recovery will re-check.', currentRevision: rb ? revisionOf(rb) : null };
      event(lock, 'restore_failed', 'restore not verified'); await writeLock(lock, lockEtag);
      return { ok: false, code: 'restore_unverified', lock: summary(lock) };
    }
    cur.doc = rb;
    return release('Exact pre-run config restored and verified.', revisionOf(rb));
  }

  /**
   * Orphan recovery: restore an override whose owner's lease expired or whose run already ended,
   * or retry a failed restore. Never touches a healthy owner. Safe to call often, from anywhere.
   */
  async function recover({ getRun, markRunLost, actor }) {
    const { lock } = await readLock();
    if (!lock || lock.state === 'released') return { action: 'none' };
    if (BLOCKED.has(lock.state)) return { action: 'blocked', lock: summary(lock) };
    const run = getRun ? await getRun(lock.runId).catch(() => null) : null;
    const runEnded = Boolean(run && TERMINAL_RUN.has(run.status));
    if (lock.state !== 'restore_failed' && !stale(lock) && !runEnded) return { action: 'none', owner: 'alive' };
    const why = lock.state === 'restore_failed' ? 'retrying a failed restore' : (runEnded ? 'run already ended' : 'owner lease expired (worker lost)');
    const r = await restore({ runId: lock.runId, reason: 'recovery: ' + why, actor: actor || 'system:recovery' });
    if (run && !runEnded && markRunLost) {
      await markRunLost(lock.runId, r.ok ? 'Worker lost; production routing was restored by recovery.' : 'Worker lost; routing restore needs attention (' + (r.code || 'error') + ').', r.ok).catch(() => {});
    }
    return { action: r.ok ? 'restored' : (r.code === 'conflict' ? 'blocked' : 'retry'), result: r, why };
  }

  /**
   * Admin decision for a CONFLICT (or a persistent restore failure):
   *   keep-current       — the live config stays as it is; ownership is released.
   *   restore-pre-run    — write the exact pre-run config, but only if live config is still the one
   *                        the admin reviewed (expectedRevision).
   */
  async function resolve({ runId, decision, note, by, expectedRevision }) {
    const { lock, etag } = await readLock();
    if (!lock || lock.runId !== runId || lock.state === 'released') return { ok: false, code: 'not_found' };
    if (!BLOCKED.has(lock.state) && lock.state !== 'restore_failed') return { ok: false, code: 'not_blocked' };
    const cur = await current();
    if (!cur) return { ok: false, code: 'config_unavailable' };
    if (expectedRevision && revisionOf(cur) !== expectedRevision) return { ok: false, code: 'stale', currentRevision: revisionOf(cur) };
    let lockEtag = etag;
    if (decision === 'restore-pre-run') {
      if (!sameConfig(cur, lock.preRun.doc)) {
        const entry = historyEntry('batch-override-restore', lock, cur, lock.preRun.doc, 'Admin restored the pre-run config for batch run ' + runId + (note ? ' — ' + note : ''));
        entry.byEmail = by; entry.requestedBy = lock.requestedBy || null;
        const doc = nextDocument(configFields(lock.preRun.doc), cur, entry);
        doc.updatedByEmail = by;
        await saveDoc(doc);
        const rb = await readBack(revisionOf(doc), revisionOf(cur));
        if (!rb || !sameConfig(rb, lock.preRun.doc)) return { ok: false, code: 'restore_unverified' };
      }
    } else if (decision !== 'keep-current') return { ok: false, code: 'bad_decision' };
    lock.state = 'released'; lock.releasedAt = iso();
    lock.resolution = { decision, note: note || null, by, at: iso(), revision: revisionOf(await current()) };
    event(lock, 'released', 'admin resolution: ' + decision);
    await writeLock(lock, lockEtag);
    log({ evt: 'batch-routing-override', state: 'resolved', runId, decision, by });
    return { ok: true, lock: summary(lock) };
  }

  return { LOCK_KEY, readLock, status, begin, heartbeat, stillOwned, restore, recover, resolve, summary, stale };
}

module.exports = {
  LOCK_KEY, SCHEMA, SYSTEM_ACTOR, AUDIT_KEYS, DEFAULT_LEASE_MS, ACTIVE, BLOCKED,
  canonical, configFields, sameConfig, diff, planOverride, createRoutingOverride,
};
