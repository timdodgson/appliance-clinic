'use strict';
const { engineGetHeaders } = require('./engine-signature.js');
/**
 * ApplianceClinic Settings — admin view-model over the real configuration.
 *
 * Settings is not an environment editor. It shows the small set of product configuration an administrator should
 * understand, and edits one thing: the advisor's model (ai-config.js, Secrets Manager, which the diagnosis engine
 * reads). Secrets, prompts and datasets stay out.
 */

const crypto = require('crypto');
const aiConfig = require('./ai-config');
const transcripts = require('./transcripts');
const { readBackAfterWrite } = require('./config-readback');

// The diagnosis engine caches the configuration for 60 s (admin-config.js) and the resolved provider for 60 s
// (engine/config.js), so a model change can take up to about 2 minutes to reach a warm instance.
const PROPAGATION_TTL_MS = 60 * 1000;
const PROPAGATION_MAX_MS = 2 * PROPAGATION_TTL_MS;
const NOTE_MIN = 5;
const NOTE_MAX = 300;
const HISTORY_VIEW = 10;
// Model ids: provider ids like "claude-opus-5-5". No spaces or quotes.
const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,119}$/;
const MEDIA_OVERLAY_TTL_MS = 10 * 1000;
const ERROR_CODE_OVERLAY_TTL_MS = 10 * 1000;
const CONVERSATION_WINDOW = 12;

const PATCH_KEYS = new Set(['expectedVersion', 'expectedRevision', 'note', 'model']);
const SECRET_FIELD_RE = /^(apiKey|anthropicApiKey|apiToken|password|token|secret|authorization|bearer|accessKey|secretAccessKey)$/i;

// ---- concurrency token, diffs, validation helpers -----------------------------------------------

/** Content revision of the stored configuration: every writer changes it, so a stale page is detected. */
function configRevision(cfg) {
  const c = aiConfig.normalise(cfg || {});
  return crypto.createHash('sha256').update(JSON.stringify({ a: aiConfig.auditable(c), v: c.version })).digest('hex').slice(0, 16);
}

function diffConfigs(prev, next) {
  const p = aiConfig.normalise(prev); const n = aiConfig.normalise(next);
  return p.model === n.model ? [] : [{ field: 'model', label: 'Advisor model', from: p.model, to: n.model }];
}

function validModel(v) { return typeof v === 'string' && MODEL_RE.test(v); }

function parseNote(v) {
  if (v == null || v === '') return { ok: true, note: null };
  if (typeof v !== 'string') return { ok: false };
  const t = v.trim();
  if (t.length < NOTE_MIN || t.length > NOTE_MAX) return { ok: false };
  return { ok: true, note: t };
}

function rejectSecrets(obj) {
  return Object.keys(obj || {}).filter((k) => SECRET_FIELD_RE.test(k));
}

/** The PATCH body of a model change: { expectedVersion, expectedRevision?, model, note? }. */
function parseModelPatch(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { ok: false, status: 400, error: 'A JSON object is required' };
  const secrets = rejectSecrets(body);
  if (secrets.length) return { ok: false, status: 400, error: 'Credentials are not accepted here', details: secrets };
  const unknown = Object.keys(body).filter((k) => !PATCH_KEYS.has(k));
  if (unknown.length) return { ok: false, status: 400, error: 'Unknown setting', details: unknown };
  if (!Number.isInteger(body.expectedVersion) || body.expectedVersion < 1) return { ok: false, status: 400, error: 'expectedVersion is required' };
  if (body.expectedRevision != null && (typeof body.expectedRevision !== 'string' || !/^[0-9a-f]{16}$/.test(body.expectedRevision))) {
    return { ok: false, status: 400, error: 'expectedRevision is malformed' };
  }
  const model = typeof body.model === 'string' ? body.model.trim() : '';
  if (!validModel(model)) return { ok: false, status: 400, error: 'Model id must be up to 120 characters: letters, digits and . _ : / @ + -', details: ['model'] };
  const note = parseNote(body.note);
  if (!note.ok) return { ok: false, status: 400, error: 'Change reason must be ' + NOTE_MIN + '–' + NOTE_MAX + ' characters', details: ['note'] };
  return { ok: true, expectedVersion: body.expectedVersion, expectedRevision: body.expectedRevision || null, note: note.note, model };
}

// ---- what is running, from the diagnosis engine's health ----------------------------------------

async function probeEngineModels(opts) {
  const fetchFn = opts.fetch || fetch;
  const url = String(opts.engineHealthUrl || '').replace(/\/$/, '');
  if (!url) return { available: false, reason: 'No diagnosis engine health URL is configured' };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs || 5000);
  try {
    const res = await fetchFn(url + '/health', { signal: ctrl.signal, headers: { accept: 'application/json', ...engineGetHeaders(url + '/health') } });
    const json = await res.json().catch(() => null);
    const r = json && json.models && json.models.reasoner;
    if (!res.ok || !r) return { available: false, reason: 'The diagnosis engine health did not report the advisor model' };
    if (!r.configured) return { available: false, reason: 'The diagnosis engine reports no configured model' };
    return { available: true, provider: r.provider || null, model: r.model || null };
  } catch {
    return { available: false, reason: 'The diagnosis engine health unreachable' };
  } finally {
    clearTimeout(timer);
  }
}

function syncOf(configured, running) {
  if (!running || !running.available) return { status: 'unverifiable', label: (running && running.reason) || 'Running value not currently verifiable' };
  if (running.provider === configured.provider && running.model === configured.model) return { status: 'in_sync', label: 'The diagnosis engine is running the stored model' };
  return { status: 'mismatch', label: 'The diagnosis engine reports a different model (it may not have picked the change up yet)' };
}

function storeNote(status) {
  if (status === 'absent') return 'No saved configuration yet: no model is set, so the advisor cannot run until one is saved.';
  if (status === 'malformed') return 'The saved configuration could not be read; defaults are shown. Saving writes a well-formed document.';
  if (status === 'unavailable') return 'The configuration store could not be reached. Values shown may be stale.';
  return null;
}

function historyView(history) {
  return (history || []).slice(0, HISTORY_VIEW).map((h) => ({
    at: h.at || null, byEmail: h.byEmail || null, version: h.version || null, note: h.note || null, fromRevision: h.fromRevision || null,
    changes: Array.isArray(h.changes) ? h.changes.map((c) => ({ field: c.field, label: c.label, from: c.from, to: c.to })) : [],
  }));
}

async function buildView(opts) {
  opts = opts || {};
  const load = opts.loadConfigWithStatus || aiConfig.loadConfigWithStatus.bind(aiConfig);
  const keyFn = opts.isKeyConfigured || aiConfig.isKeyConfigured.bind(aiConfig);
  const [store, keyConfigured] = await Promise.all([load(), keyFn()]);
  const cfg = store.cfg;
  const running = opts.runningModels || await probeEngineModels({ fetch: opts.fetch, engineHealthUrl: opts.engineHealthUrl, timeoutMs: opts.timeoutMs });
  const policy = (opts.transcriptPolicy || transcripts.policy)();
  const configured = aiConfig.advisorView(cfg, keyConfigured);
  let keyMeta;
  if (opts.loadKeyMeta) keyMeta = await opts.loadKeyMeta();
  else if (opts.isKeyConfigured) keyMeta = { configured: keyConfigured, updatedAt: null, updatedByEmail: null, history: [] };
  else keyMeta = await aiConfig.loadKeyMeta();
  return {
    purpose: 'Configuration used by ApplianceClinic. Changes here affect live behaviour. Only the advisor model is editable.',
    advisor: {
      editable: true,
      source: 'Admin runtime configuration',
      store: { status: store.status, note: storeNote(store.status) },
      version: cfg.version || 1,
      revision: configRevision(cfg),
      updatedAt: cfg.updatedAt || null,
      updatedByEmail: cfg.updatedByEmail || null,
      history: historyView(cfg.history),
      configured,
      running: running.available ? { available: true, provider: running.provider, providerLabel: aiConfig.PROVIDER_LABEL, model: running.model, modelLabel: running.model || 'Model not reported' } : { available: false, reason: running.reason || 'Running value not currently verifiable' },
      sync: syncOf(configured, running),
      credential: {
        configured: keyConfigured,
        updatedAt: keyMeta.updatedAt || null,
        updatedByEmail: keyMeta.updatedByEmail || null,
        history: (keyMeta.history || []).slice(0, HISTORY_VIEW),
        usedBy: 'The diagnosis engine (every customer turn) and the Settings connection check.',
      },
      propagation: {
        ttlMs: PROPAGATION_TTL_MS,
        maxMs: PROPAGATION_MAX_MS,
        note: 'New diagnoses use a saved model within about 2 minutes (each warm diagnosis engine instance caches the configuration and the provider for up to 60 s each). In-flight turns keep the model they already loaded.',
      },
    },
    runtimeStatus: {
      editable: false,
      architecture: 'ac2',
      architectureNote: 'Every diagnosis turn runs the advisor (Claude, with tools) inside the deterministic guardrail kernel (ADR 0023). There is no other diagnosis path.',
    },
    transcripts: {
      editable: false, source: 'Deployment environment', managedAt: 'deployment', managedIn: 'Transcripts',
      retentionDays: policy.retentionDays, inactiveAfterMinutes: policy.inactiveAfterMinutes, ttlAttribute: policy.ttlAttribute,
      summary: policy.summary, stored: policy.stored, notStored: policy.notStored,
    },
    conversation: {
      editable: false, source: 'Shipped application configuration', managedAt: 'code', windowTurns: CONVERSATION_WINDOW,
      note: 'Customer and admin diagnostic requests send at most this many recent turns.',
    },
    elsewhere: [
      { id: 'media', title: 'Media mappings', href: '#media', note: 'Presentation and diagnostic media are managed in Media.' },
      { id: 'error-codes', title: 'Error-code catalogue', href: '#mcp', note: 'Error-code meanings are managed in Error Codes.' },
      { id: 'knowledge', title: 'Diagnostic knowledge', href: '#knowledge', note: 'Symptom and fault topics are inspected in Knowledge.' },
      { id: 'recalls', title: 'Recall ingest', href: '#safety', note: 'Recall import stays on Safety ingest.' },
      { id: 'diagnostics', title: 'Runtime health', href: '#diagnostics', note: 'What is running is inspected in Diagnostics.' },
    ],
    technical: {
      diagnosticCacheTtlSeconds: PROPAGATION_TTL_MS / 1000,
      mediaOverlayCacheTtlSeconds: MEDIA_OVERLAY_TTL_MS / 1000,
      errorCodeOverlayCacheTtlSeconds: ERROR_CODE_OVERLAY_TTL_MS / 1000,
      conversationWindowTurns: CONVERSATION_WINDOW,
      configurationStore: 'Admin runtime configuration (durable, not an environment-variable dump)',
      coldStart: 'A cold diagnosis engine process reads the configuration on its first request, then caches it for about one minute.',
      lastGood: 'If the configuration store is missing or unreadable, the diagnosis engine has no model and every turn is an explicit "temporarily unavailable" error (no fallback).',
    },
  };
}

async function saveModelPatch(opts) {
  opts = opts || {};
  const parsed = parseModelPatch(opts.body);
  if (!parsed.ok) return parsed;
  const load = opts.loadConfigWithStatus || aiConfig.loadConfigWithStatus.bind(aiConfig);
  const keyFn = opts.isKeyConfigured || aiConfig.isKeyConfigured.bind(aiConfig);
  const save = opts.saveConfig || aiConfig.saveConfig.bind(aiConfig);
  const [store, keyConfigured] = await Promise.all([load(), keyFn()]);
  if (store.status === 'unavailable') return { ok: false, status: 503, error: 'Configuration store is unavailable' };
  const prev = store.cfg;
  const currentRevision = configRevision(prev);
  const stale = parsed.expectedVersion !== (prev.version || 1) || (parsed.expectedRevision && parsed.expectedRevision !== currentRevision);
  if (stale) {
    return { ok: false, status: 409, code: 'conflict', error: 'Settings changed since you opened this page. Reload to review the current values, then apply your change again.', currentVersion: prev.version || 1, currentRevision };
  }
  const proposed = aiConfig.normalise(Object.assign({}, prev, { model: parsed.model }));
  const changes = diffConfigs(prev, proposed);
  if (!changes.length) {
    const view = await buildView(Object.assign({}, opts, { loadConfigWithStatus: async () => store, isKeyConfigured: async () => keyConfigured }));
    return { ok: true, status: 200, view, apply: { changed: [], written: false, note: 'No changes — nothing was written.' } };
  }
  // The model writes every live customer reply: a reason is always required.
  if (!parsed.note) return { ok: false, status: 400, code: 'reason_required', error: 'A change reason is required: the advisor model writes every live customer reply.', details: ['note'] };
  const next = aiConfig.withHistory(prev, proposed, opts.byEmail || 'admin', { note: parsed.note, changes, fromRevision: currentRevision });
  try {
    await save(next);
  } catch (e) {
    return { ok: false, status: 503, code: 'store_failed', error: 'The configuration store did not accept the change. Nothing was applied — reload to confirm the current values.' };
  }
  // Read back what is stored: Secrets Manager has no conditional put and its reads are eventually consistent
  // (config-readback.js), so a concurrent writer is detected after the fact.
  const expectRev = configRevision(next);
  const rb = await readBackAfterWrite(Object.assign({
    read: async () => { const r = await load(); return r && r.status === 'ok' ? r.cfg : null; },
    revisionOf: configRevision, expectedRevision: expectRev, priorRevision: currentRevision,
  }, opts.readBack || {}));
  if (rb.status === 'conflict') {
    return { ok: false, status: 409, code: 'concurrent_write', error: 'Another change was written at the same time. Reload to see which configuration is now stored before doing anything else.', currentRevision: rb.revision };
  }
  const verified = rb.status === 'verified';
  const effective = verified ? { cfg: rb.doc, status: 'ok' } : { cfg: next, status: 'ok' };
  const view = await buildView(Object.assign({}, opts, { loadConfigWithStatus: async () => effective, isKeyConfigured: async () => keyConfigured }));
  return {
    ok: true, status: 200, view,
    apply: {
      changed: changes, written: true, verified, liveImpact: true,
      verification: rb.status,
      ...(verified ? {} : { verificationNote: rb.status === 'not_visible'
        ? 'The store accepted the change, but reads still returned the previous version for ' + rb.reads + ' attempts. Reload Settings to confirm what is stored before changing anything else.'
        : 'The store accepted the change, but it could not be read back to confirm it. Reload Settings to confirm what is stored.' }),
      revision: expectRev, version: next.version,
      propagation: 'Stored. Each warm diagnosis engine instance picks this up within about ' + Math.round(PROPAGATION_MAX_MS / 60000) + ' minutes; the running value updates after that.',
    },
  };
}

/** Read-only connection check with the stored credential and the stored model; never the caller's values. */
async function testConnection(opts) {
  opts = opts || {};
  const load = opts.loadConfig || aiConfig.loadConfig.bind(aiConfig);
  const keyFn = opts.getKey || aiConfig.getKey.bind(aiConfig);
  const probe = opts.probeModel || aiConfig.probeModel.bind(aiConfig);
  const [cfg, key] = await Promise.all([load(), keyFn()]);
  return probe({ key, model: cfg.model, fetch: opts.fetch, timeoutMs: opts.timeoutMs || 12000 });
}

module.exports = {
  PROPAGATION_TTL_MS, PROPAGATION_MAX_MS, CONVERSATION_WINDOW, NOTE_MIN, NOTE_MAX,
  configRevision, diffConfigs, validModel, parseModelPatch, probeEngineModels, syncOf, historyView,
  buildView, saveModelPatch, testConnection,
};
