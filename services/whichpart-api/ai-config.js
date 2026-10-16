'use strict';
/**
 * The admin AI configuration (server side, Secrets Manager): the advisor's model, and the write-only model credential.
 *
 *   AI_CONFIG_SECRET_ID   { model, version, history, updatedAt, updatedByEmail }   non-secret; the diagnosis engine
 *                         reads `model` (admin-config.js there). A document written before change 23.3 named the
 *                         model as frontier.model and carried routing fields: normalise() reads either shape.
 *   OPENAI_SECRET_ID      { anthropicApiKey, updatedAt, updatedByEmail, history }  the key is never returned to the
 *                         browser. The secret keeps its historical name: renaming a secret is a production change.
 *
 * There is one provider (Claude, the Anthropic Messages API) since 23.3; Settings edits the model id only.
 */

const STAGE = process.env.STAGE || 'dev';
const AI_CONFIG_SECRET_ID = process.env.AI_CONFIG_SECRET_ID || `spares4repairs/${STAGE}/applianceclinic-ai-config`;
const OPENAI_SECRET_ID = process.env.OPENAI_SECRET_ID || `spares4repairs/${STAGE}/applianceclinic-openai`;
const ANTHROPIC_BASE_URL = 'https://api.anthropic.com/v1';
const ANTHROPIC_VERSION = '2023-06-01';
const PROVIDER = 'anthropic';
const PROVIDER_LABEL = 'Anthropic (Claude)';
const HISTORY_CAP = 20;

let _sm = null;
function sm() {
  if (!_sm) {
    const { SecretsManagerClient } = require('@aws-sdk/client-secrets-manager');
    _sm = new SecretsManagerClient({ region: process.env.AWS_REGION || 'eu-west-1' });
  }
  return _sm;
}

function defaultConfig() {
  return { model: '', updatedAt: null, updatedByEmail: null, version: 1, history: [] };
}

/** Coerce a stored document into a well-formed config. */
function normalise(raw) {
  const d = defaultConfig();
  const o = raw && typeof raw === 'object' ? raw : {};
  const model = typeof o.model === 'string' ? o.model : (o.frontier && typeof o.frontier.model === 'string' ? o.frontier.model : '');
  return {
    model: model.trim(),
    updatedAt: typeof o.updatedAt === 'string' ? o.updatedAt : null,
    updatedByEmail: typeof o.updatedByEmail === 'string' ? o.updatedByEmail : null,
    version: Number.isInteger(o.version) && o.version > 0 ? o.version : d.version,
    history: Array.isArray(o.history) ? o.history : [],
  };
}

/** The fields a change is audited on. */
function auditable(cfg) { return { model: cfg.model }; }

/** What the admin pages show for the advisor. Never a key. */
function advisorView(cfg, keyConfigured) {
  const model = String((cfg && cfg.model) || '').trim();
  return { provider: PROVIDER, providerLabel: PROVIDER_LABEL, model: model || null, modelLabel: model || 'Model not set', credentialConfigured: Boolean(keyConfigured) };
}

// `extra` (Settings): { note, changes:[{field,label,from,to}], fromRevision } — all non-secret.
function withHistory(prev, next, byEmail, extra) {
  const version = (Number.isInteger(prev.version) && prev.version > 0 ? prev.version : 1) + 1;
  const entry = { at: new Date().toISOString(), byEmail, previous: auditable(prev), next: auditable(next), version };
  if (extra && extra.note) entry.note = String(extra.note).slice(0, 300);
  if (extra && Array.isArray(extra.changes)) entry.changes = extra.changes.slice(0, 20);
  if (extra && extra.fromRevision) entry.fromRevision = extra.fromRevision;
  const history = [entry].concat(prev.history || []).slice(0, HISTORY_CAP);
  return Object.assign({}, next, { history, updatedAt: entry.at, updatedByEmail: byEmail, version });
}

// ---- Secrets Manager I/O ----------------------------------------------------

async function _get(secretId) {
  const { GetSecretValueCommand } = require('@aws-sdk/client-secrets-manager');
  const res = await sm().send(new GetSecretValueCommand({ SecretId: secretId }));
  return res.SecretString || null;
}
async function _put(secretId, str) {
  const { PutSecretValueCommand, CreateSecretCommand, ResourceNotFoundException } = require('@aws-sdk/client-secrets-manager');
  try {
    await sm().send(new PutSecretValueCommand({ SecretId: secretId, SecretString: str }));
  } catch (err) {
    if (err instanceof ResourceNotFoundException || (err && err.name === 'ResourceNotFoundException')) {
      await sm().send(new CreateSecretCommand({ Name: secretId, SecretString: str }));
    } else {
      throw err;
    }
  }
}

/** Load the configuration, or defaults when the secret does not exist yet. */
async function loadConfig() {
  return (await loadConfigWithStatus()).cfg;
}

/** status: ok | absent | malformed | unavailable, so Settings can say "using defaults" without inventing live values. */
async function loadConfigWithStatus() {
  try {
    const s = await _get(AI_CONFIG_SECRET_ID);
    if (!s) return { cfg: defaultConfig(), status: 'absent' };
    try {
      return { cfg: normalise(JSON.parse(s)), status: 'ok' };
    } catch {
      return { cfg: defaultConfig(), status: 'malformed' };
    }
  } catch {
    return { cfg: defaultConfig(), status: 'unavailable' };
  }
}

async function saveConfig(cfg) { await _put(AI_CONFIG_SECRET_ID, JSON.stringify(cfg)); }

// ---- the model credential (write-only) ----------------------------------------------------------

function parseCredential(raw) {
  const p = raw ? JSON.parse(raw) : {};
  const key = p && typeof p.anthropicApiKey === 'string' && p.anthropicApiKey.trim() ? p.anthropicApiKey.trim() : null;
  return {
    key,
    updatedAt: p && typeof p.updatedAt === 'string' ? p.updatedAt : null,
    updatedByEmail: p && typeof p.updatedByEmail === 'string' ? p.updatedByEmail : null,
    history: p && Array.isArray(p.history) ? p.history.filter((h) => h && typeof h.at === 'string').map((h) => ({ at: h.at, byEmail: typeof h.byEmail === 'string' ? h.byEmail : null, replaced: Boolean(h.replaced) })) : [],
  };
}

/** Whether a credential is stored (boolean only, never the value). */
async function isKeyConfigured() {
  try { return Boolean(parseCredential(await _get(OPENAI_SECRET_ID)).key); } catch { return false; }
}

/**
 * Replace the credential. Non-secret audit metadata (who/when, last 20 replacements) is kept beside it in the same
 * secret; the diagnosis engine reads only `anthropicApiKey`. The key is never returned.
 */
async function saveKey(apiKey, byEmail) {
  const prev = await loadKeyMeta();
  const at = new Date().toISOString();
  const history = [{ at, byEmail: byEmail || 'admin', replaced: prev.configured }].concat(prev.history || []).slice(0, HISTORY_CAP);
  await _put(OPENAI_SECRET_ID, JSON.stringify({ anthropicApiKey: apiKey, updatedAt: at, updatedByEmail: byEmail || 'admin', history }));
  return { at };
}

/** Credential presence and audit metadata only (never the key). */
async function loadKeyMeta() {
  try {
    const c = parseCredential(await _get(OPENAI_SECRET_ID));
    return { configured: Boolean(c.key), updatedAt: c.updatedAt, updatedByEmail: c.updatedByEmail, history: c.history };
  } catch { return { configured: false, updatedAt: null, updatedByEmail: null, history: [] }; }
}

/** Server-only: the credential for a connection check. */
async function getKey() {
  try { return parseCredential(await _get(OPENAI_SECRET_ID)).key; } catch { return null; }
}

// ---- Connection check (read-only; no customer data) ----------------------------------------------

/**
 * Check that the stored credential can see the configured model: GET /v1/models/{model}. Returns
 * { status: ONLINE | CONFIG_ERROR | MODEL_ERROR | OFFLINE, latencyMs, detail? }. Never returns the key.
 */
async function probeModel({ key, model, fetch: fetchFn, timeoutMs = 12000 } = {}) {
  if (!key) return { status: 'CONFIG_ERROR', latencyMs: null, detail: 'No credential configured' };
  if (!model) return { status: 'MODEL_ERROR', latencyMs: null, detail: 'No model configured' };
  const f = fetchFn || fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const started = Date.now();
  try {
    const res = await f(`${ANTHROPIC_BASE_URL}/models/${encodeURIComponent(model)}`, { method: 'GET', headers: { 'x-api-key': key, 'anthropic-version': ANTHROPIC_VERSION }, signal: controller.signal });
    const latencyMs = Date.now() - started;
    if (res.ok) return { status: 'ONLINE', latencyMs };
    if (res.status === 401 || res.status === 403) return { status: 'CONFIG_ERROR', latencyMs, detail: 'Credential rejected' };
    if (res.status === 404) return { status: 'MODEL_ERROR', latencyMs, detail: 'Model not found' };
    let detail = '';
    try { const j = await res.json(); detail = (j.error && (j.error.message || j.error.type)) || ''; } catch { detail = ''; }
    return { status: 'CONFIG_ERROR', latencyMs, detail: String(detail).slice(0, 160) || ('HTTP ' + res.status) };
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
    return { status: 'OFFLINE', latencyMs: Date.now() - started, detail: /abort/i.test(msg) ? 'Timed out' : 'Unreachable' };
  } finally {
    clearTimeout(timer);
  }
}

/** The models the credential can use (ids only), for the Settings picker. */
async function listModels({ key, fetch: fetchFn } = {}) {
  if (!key) return { ok: false, configured: false, models: [] };
  const f = fetchFn || fetch;
  try {
    const r = await f(`${ANTHROPIC_BASE_URL}/models?limit=100`, { headers: { 'x-api-key': key, 'anthropic-version': ANTHROPIC_VERSION } });
    if (!r.ok) return { ok: false, configured: true, models: [] };
    const j = await r.json();
    return { ok: true, configured: true, models: (j.data || []).map((m) => m.id).filter((id) => typeof id === 'string').sort() };
  } catch {
    return { ok: false, configured: true, models: [] };
  }
}

module.exports = {
  AI_CONFIG_SECRET_ID, OPENAI_SECRET_ID, PROVIDER, PROVIDER_LABEL,
  defaultConfig, normalise, auditable, advisorView, withHistory,
  loadConfig, loadConfigWithStatus, saveConfig, isKeyConfigured, saveKey, loadKeyMeta, getKey, probeModel, listModels,
};
