'use strict';
/**
 * ApplianceClinic AI provider configuration — control plane (server-side).
 *
 * This is the WRITE/READ side used by the WhichPart admin console (via the
 * whichpart-api BFF). It persists the non-secret operational config and the
 * write-only OpenAI credential to Secrets Manager, using the SAME secret IDs
 * the part-finder RAG engine reads at runtime (services/part-finder/admin-config.js):
 *
 *   spares4repairs/<STAGE>/applianceclinic-ai-config   (non-secret: routing/models/history)
 *   spares4repairs/<STAGE>/applianceclinic-openai      (secret: { apiKey } — never returned)
 *   spares4repairs/<STAGE>/applianceclinic-jev         (secret: { accountId, apiToken, gatewayId? } — token never returned)
 *
 * Routing maps onto the provider abstraction: local -> LM Studio, frontier ->
 * OpenAI, chosen independently per stage. There is NO silent fallback: a config
 * that would activate an invalid frontier route is rejected here, and the
 * runtime raises an explicit error rather than quietly using local.
 */

const STAGE = process.env.STAGE || 'dev';
// Phase 7 (D): the secret ids can be set by environment (the AC namespace applianceclinic/production/*); the
// defaults are the original ids.
const AI_CONFIG_SECRET_ID = process.env.AI_CONFIG_SECRET_ID || `spares4repairs/${STAGE}/applianceclinic-ai-config`;
const OPENAI_SECRET_ID = process.env.OPENAI_SECRET_ID || `spares4repairs/${STAGE}/applianceclinic-openai`;
const JEV_SECRET_ID = process.env.JEV_SECRET_ID || `spares4repairs/${STAGE}/applianceclinic-jev`;
const JEV_MODEL = 'typesafe/jev';
const JEV_PROVIDER_LABEL = 'TypeSafe Jev via Cloudflare';
const JEV_ENDPOINT = 'https://api.cloudflare.com/client/v4/accounts';
const HISTORY_CAP = 50; // Settings changes + batch override start/restore events

let _sm = null;
function sm() {
  if (!_sm) {
    // Provided by the nodejs20.x Lambda runtime (as with the cognito client).
    const { SecretsManagerClient } = require('@aws-sdk/client-secrets-manager');
    _sm = new SecretsManagerClient({ region: process.env.AWS_REGION || 'eu-west-1' });
  }
  return _sm;
}

function defaultConfig() {
  return {
    // endpoint blank => the RAG engine uses its own deployed LM_STUDIO_URL.
    local: { enabled: true, endpoint: '', model: '' },
    frontier: { enabled: false, provider: 'openai', model: '' },
    routing: { understand: 'local', compose: 'local' },
    lastFrontierTest: null,
    updatedAt: null,
    updatedByEmail: null,
    version: 1,
    history: [],
  };
}

function kind(v, fallback) { return v === 'frontier' || v === 'local' ? v : fallback; }

/** Coerce arbitrary parsed JSON into a well-formed config (defaults fill gaps). */
function normalise(raw) {
  const d = defaultConfig();
  const o = raw && typeof raw === 'object' ? raw : {};
  const local = o.local || {};
  const frontier = o.frontier || {};
  const routing = o.routing || {};
  return {
    local: {
      enabled: local.enabled !== undefined ? local.enabled === true : d.local.enabled,
      endpoint: typeof local.endpoint === 'string' ? local.endpoint.trim() : d.local.endpoint,
      model: typeof local.model === 'string' ? local.model.trim() : d.local.model,
    },
    frontier: {
      enabled: frontier.enabled === true,
      provider: 'openai',
      model: typeof frontier.model === 'string' ? frontier.model.trim() : d.frontier.model,
    },
    routing: {
      understand: kind(routing.understand, d.routing.understand),
      compose: kind(routing.compose, d.routing.compose),
    },
    lastFrontierTest: o.lastFrontierTest || null,
    updatedAt: typeof o.updatedAt === 'string' ? o.updatedAt : null,
    updatedByEmail: typeof o.updatedByEmail === 'string' ? o.updatedByEmail : null,
    version: Number.isInteger(o.version) && o.version > 0 ? o.version : d.version,
    history: Array.isArray(o.history) ? o.history : [],
  };
}

function auditable(cfg) {
  return {
    local: { enabled: cfg.local.enabled, endpoint: cfg.local.endpoint, model: cfg.local.model },
    frontier: { enabled: cfg.frontier.enabled, provider: cfg.frontier.provider, model: cfg.frontier.model },
    routing: { understand: cfg.routing.understand, compose: cfg.routing.compose },
  };
}

/**
 * Validate a proposed config is safe to ACTIVATE. A stage routed to FRONTIER
 * needs frontier.enabled + a stored credential + a model. A stage routed to
 * LOCAL needs local.enabled (a blank endpoint is fine — the engine uses its own
 * deployed LM_STUDIO_URL). No silent fallback: invalid routing is rejected.
 */
function validateActivation(cfg, keyConfigured) {
  const errors = [];
  const stages = [['UNDERSTAND', cfg.routing.understand], ['COMPOSE', cfg.routing.compose]];
  for (const [label, k] of stages) {
    if (k === 'frontier') {
      if (!cfg.frontier.enabled) errors.push(`${label} is routed to Frontier but Frontier is disabled.`);
      if (!keyConfigured) errors.push(`${label} is routed to Frontier but no OpenAI API key is configured.`);
      if (!cfg.frontier.model) errors.push(`${label} is routed to Frontier but no Frontier model is set.`);
    } else if (!cfg.local.enabled) {
      errors.push(`${label} is routed to Local but the Local provider is disabled.`);
    }
  }
  return { ok: errors.length === 0, errors };
}

/** Shape for the admin browser: adds the configured boolean + effective summary. Never a key. */
function toClientView(cfg, keyConfigured) {
  const providerFor = (k) =>
    k === 'frontier'
      ? { kind: k, provider: 'openai', model: cfg.frontier.model || null }
      : { kind: k, provider: 'lmstudio', model: cfg.local.model || '(loaded model)' };
  return {
    local: cfg.local,
    frontier: { enabled: cfg.frontier.enabled, provider: cfg.frontier.provider, model: cfg.frontier.model, configured: keyConfigured },
    routing: cfg.routing,
    effective: { understand: providerFor(cfg.routing.understand), compose: providerFor(cfg.routing.compose) },
    lastFrontierTest: cfg.lastFrontierTest || null,
    updatedAt: cfg.updatedAt || null,
    updatedByEmail: cfg.updatedByEmail || null,
    version: cfg.version || 1,
  };
}

// Human, correctness-first description of the THREE DISTINCT AI identities the
// tester involves: UNDERSTAND (customer inference), COMPOSE (customer inference)
// and the QUALITY REVIEWER / JUDGE (only used for Full Quality Review). Pure and
// unit-tested. CRITICAL: the judge model must NEVER be presented as a
// customer-inference (local candidate) model. A local model that is blank, the
// "(loaded model)" sentinel, or that accidentally equals the judge/frontier model
// is shown as the safe managed fallback so the reviewer model can never
// masquerade as the local model that is answering the customer.
const LOCAL_MANAGED_MODEL = 'Model managed by LM Studio';
function describeSetup(opts) {
  const cfg = (opts && opts.cfg) || defaultConfig();
  const judgeModel = String((opts && opts.judgeModel) || '').trim();
  const keyConfigured = !!(opts && opts.keyConfigured);
  const jevConfigured = !!(opts && opts.jevConfigured);
  const localModel = String((cfg.local && cfg.local.model) || '').trim();
  const frontierModel = String((cfg.frontier && cfg.frontier.model) || '').trim();
  function stage(routeKind) {
    if (routeKind === 'frontier') {
      return { provider: 'openai', providerLabel: 'OpenAI', model: frontierModel || null, modelLabel: frontierModel || 'Model not set' };
    }
    // LOCAL: refuse to surface a frontier/judge model (or the sentinel) as the
    // local customer-inference model. This is the anti-masquerade guard.
    const masquerade = !localModel || localModel === '(loaded model)' || localModel === judgeModel || (frontierModel && localModel === frontierModel);
    const safe = masquerade ? null : localModel;
    return { provider: 'lmstudio', providerLabel: 'Private AI', model: safe, modelLabel: safe || LOCAL_MANAGED_MODEL };
  }
  return {
    // UNDERSTAND is TypeSafe Jev. Leftover local/frontier routing in the AI
    // config secret does not describe this stage and must not be shown as if it did.
    understand: {
      provider: 'jev',
      providerLabel: JEV_PROVIDER_LABEL,
      model: JEV_MODEL,
      modelLabel: JEV_MODEL,
      configured: jevConfigured,
    },
    compose: stage(cfg.routing.compose),
    judge: {
      provider: 'openai', providerLabel: 'OpenAI',
      model: judgeModel || null, modelLabel: judgeModel || 'Reviewer not set',
      configured: keyConfigured, note: 'Only used when Full Quality Review is selected',
    },
  };
}

// `extra` (Settings): { note, changes:[{field,label,from,to}], fromRevision } — all non-secret.
function withHistory(prev, next, byEmail, extra) {
  const entry = { at: new Date().toISOString(), byEmail, previous: auditable(prev), next: auditable(next) };
  if (extra && extra.note) entry.note = String(extra.note).slice(0, 300);
  if (extra && Array.isArray(extra.changes)) entry.changes = extra.changes.slice(0, 20);
  if (extra && extra.fromRevision) entry.fromRevision = extra.fromRevision;
  entry.version = (Number.isInteger(prev.version) && prev.version > 0 ? prev.version : 1) + 1;
  const history = [entry].concat(prev.history || []).slice(0, HISTORY_CAP);
  const version = (Number.isInteger(prev.version) && prev.version > 0 ? prev.version : 1) + 1;
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

/** Load the operational config, or defaults when the secret doesn't exist yet. */
async function loadConfig() {
  return (await loadConfigWithStatus()).cfg;
}

/**
 * Distinguish store states so Settings can say “using defaults” without inventing live values.
 * status: ok | absent | malformed | unavailable
 */
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

/**
 * The EXACT stored AI-config document (no normalisation, unknown fields kept), for the batch
 * routing override's snapshot/restore. status: ok | absent | malformed | unavailable.
 * The document holds no secrets (keys live in their own secrets).
 */
async function loadConfigDocument() {
  let s;
  try { s = await _get(AI_CONFIG_SECRET_ID); } catch (e) {
    if (e && (e.name === 'ResourceNotFoundException' || e.__type === 'ResourceNotFoundException')) return { status: 'absent', raw: null, doc: null };
    return { status: 'unavailable', raw: null, doc: null, error: String((e && e.name) || 'Error') };
  }
  if (!s) return { status: 'absent', raw: null, doc: null };
  try {
    const doc = JSON.parse(s);
    if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return { status: 'malformed', raw: s, doc: null };
    return { status: 'ok', raw: s, doc };
  } catch { return { status: 'malformed', raw: s, doc: null }; }
}
async function saveConfigDocument(doc) { await _put(AI_CONFIG_SECRET_ID, JSON.stringify(doc)); }

/** Whether an OpenAI credential is stored (boolean only — never the value). */
async function isKeyConfigured() {
  try {
    const s = await _get(OPENAI_SECRET_ID);
    if (!s) return false;
    const parsed = JSON.parse(s);
    return typeof parsed.apiKey === 'string' && parsed.apiKey.trim().length > 0;
  } catch { return false; }
}

/**
 * Replace the OpenAI credential. Non-secret audit metadata (who/when, last 20 replacements) is kept
 * beside it in the same secret; Part Finder reads only `apiKey`. The key is never returned.
 */
async function saveKey(apiKey, byEmail) {
  const prev = await loadKeyMeta();
  const at = new Date().toISOString();
  const history = [{ at, byEmail: byEmail || 'admin', replaced: prev.configured }].concat(prev.history || []).slice(0, HISTORY_CAP);
  await _put(OPENAI_SECRET_ID, JSON.stringify({ apiKey, updatedAt: at, updatedByEmail: byEmail || 'admin', history }));
  return { at };
}

/** Credential presence + audit metadata only (never the key). */
async function loadKeyMeta() {
  try {
    const s = await _get(OPENAI_SECRET_ID);
    if (!s) return { configured: false, updatedAt: null, updatedByEmail: null, history: [] };
    const p = JSON.parse(s);
    return {
      configured: typeof p.apiKey === 'string' && p.apiKey.trim().length > 0,
      updatedAt: typeof p.updatedAt === 'string' ? p.updatedAt : null,
      updatedByEmail: typeof p.updatedByEmail === 'string' ? p.updatedByEmail : null,
      history: Array.isArray(p.history) ? p.history.filter((h) => h && typeof h.at === 'string').map((h) => ({ at: h.at, byEmail: typeof h.byEmail === 'string' ? h.byEmail : null, replaced: Boolean(h.replaced) })) : [],
    };
  } catch { return { configured: false, updatedAt: null, updatedByEmail: null, history: [] }; }
}

/** Server-only: read the credential for a frontier connection test. */
async function getKey() {
  try {
    const s = await _get(OPENAI_SECRET_ID);
    if (!s) return null;
    const parsed = JSON.parse(s);
    return typeof parsed.apiKey === 'string' && parsed.apiKey.trim() ? parsed.apiKey : null;
  } catch { return null; }
}

// ---- Jev UNDERSTAND credential (write-only token; Secrets Manager only) ----

function isResourceMissing(err) {
  return Boolean(err && (err.name === 'ResourceNotFoundException' || err.__type === 'ResourceNotFoundException'));
}

function parseJevStored(raw) {
  const parsed = typeof raw === 'string' ? JSON.parse(raw) : (raw || {});
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('malformed');
  }
  const accountId = typeof parsed.accountId === 'string' ? parsed.accountId.trim() : '';
  const tok = parsed.apiToken || parsed.apiKey || parsed.token;
  const apiToken = typeof tok === 'string' ? tok.trim() : '';
  const gatewayId = typeof parsed.gatewayId === 'string' && parsed.gatewayId.trim() ? parsed.gatewayId.trim() : null;
  const version = Number.isInteger(parsed.version) && parsed.version > 0 ? parsed.version : 1;
  return {
    accountId,
    apiToken,
    gatewayId,
    version,
    updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : null,
    updatedByEmail: typeof parsed.updatedByEmail === 'string' ? parsed.updatedByEmail : null,
    // Non-secret change history (Settings). Never contains the token.
    history: Array.isArray(parsed.history) ? parsed.history.filter((h) => h && typeof h.at === 'string').slice(0, HISTORY_CAP).map(jevHistoryEntry) : [],
  };
}
function jevHistoryEntry(h) {
  const str = (v) => (typeof v === 'string' ? v : null);
  return {
    at: h.at, byEmail: str(h.byEmail), note: str(h.note), version: Number.isInteger(h.version) ? h.version : null,
    accountId: h.accountId && typeof h.accountId === 'object' ? { from: str(h.accountId.from), to: str(h.accountId.to) } : null,
    gatewayId: h.gatewayId && typeof h.gatewayId === 'object' ? { from: str(h.gatewayId.from), to: str(h.gatewayId.to) } : null,
    tokenReplaced: Boolean(h.tokenReplaced),
  };
}

function toJevPublic(stored) {
  const s = stored || {};
  return {
    provider: 'jev',
    providerLabel: JEV_PROVIDER_LABEL,
    model: JEV_MODEL,
    accountId: s.accountId || null,
    gatewayId: s.gatewayId || null,
    credentialConfigured: typeof s.apiToken === 'string' && s.apiToken.length > 0,
    version: Number.isInteger(s.version) && s.version > 0 ? s.version : 1,
    updatedAt: s.updatedAt || null,
    updatedByEmail: s.updatedByEmail || null,
    history: Array.isArray(s.history) ? s.history.map(jevHistoryEntry) : [],
  };
}

function defaultJevPublic() {
  return toJevPublic(null);
}

function jevSecretPayload(stored) {
  const payload = {
    accountId: stored.accountId || '',
    apiToken: stored.apiToken || '',
  };
  if (stored.gatewayId) payload.gatewayId = stored.gatewayId;
  payload.version = stored.version;
  payload.updatedAt = stored.updatedAt;
  payload.updatedByEmail = stored.updatedByEmail;
  if (Array.isArray(stored.history) && stored.history.length) payload.history = stored.history.slice(0, HISTORY_CAP).map(jevHistoryEntry);
  return payload;
}

async function loadJevWithStatus() {
  try {
    const s = await _get(JEV_SECRET_ID);
    if (!s) return { status: 'absent', stored: null, public: defaultJevPublic() };
    try {
      const stored = parseJevStored(s);
      return { status: 'ok', stored, public: toJevPublic(stored) };
    } catch {
      return { status: 'malformed', stored: null, public: defaultJevPublic() };
    }
  } catch (err) {
    if (isResourceMissing(err)) return { status: 'absent', stored: null, public: defaultJevPublic() };
    return { status: 'unavailable', stored: null, public: defaultJevPublic() };
  }
}

async function saveJevStored(stored) {
  await _put(JEV_SECRET_ID, JSON.stringify(jevSecretPayload(stored)));
}

/** Server-only: token is never returned to the browser. */
async function getJevCredentials() {
  const loaded = await loadJevWithStatus();
  if (!loaded.stored || !loaded.stored.apiToken || !loaded.stored.accountId) return null;
  return {
    accountId: loaded.stored.accountId,
    apiToken: loaded.stored.apiToken,
    gatewayId: loaded.stored.gatewayId || null,
  };
}

function hasJevAnswers(obj) {
  return Boolean(obj && typeof obj === 'object' && obj.answers && typeof obj.answers === 'object' && !Array.isArray(obj.answers));
}

/**
 * Cloudflare Workers AI wraps Jev as:
 *   { success, result: { state, result: { model, answers, usage }, gatewayMetadata } }
 */
function unwrapJevResult(parsed) {
  if (!parsed || typeof parsed !== 'object') return null;
  const nested = parsed.result && typeof parsed.result === 'object' ? parsed.result : null;
  const holders = [
    parsed,
    nested,
    nested && nested.result,
    nested && nested.response,
    parsed.response,
  ];
  for (const holder of holders) {
    if (hasJevAnswers(holder)) return holder;
  }
  return null;
}

/**
 * Harmless bounded Jev ping. Does not diagnose, create a transcript, touch GOLD,
 * or mutate diagnostic state. Never logs or returns the token.
 */
async function probeJev(opts) {
  opts = opts || {};
  const accountId = typeof opts.accountId === 'string' ? opts.accountId.trim() : '';
  const apiToken = typeof opts.apiToken === 'string' ? opts.apiToken.trim() : '';
  const gatewayId = typeof opts.gatewayId === 'string' && opts.gatewayId.trim() ? opts.gatewayId.trim() : '';
  const fetchFn = opts.fetch || fetch;
  const timeoutMs = opts.timeoutMs || 12000;
  if (!accountId || !apiToken) {
    return { status: 'FAILED', connected: false, model: null, latencyMs: null, errorCategory: 'CONFIG' };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const started = Date.now();
  const url = `${JEV_ENDPOINT}/${encodeURIComponent(accountId)}/ai/run`;
  const headers = {
    Authorization: 'Bearer ' + apiToken,
    Accept: 'application/json',
    'Content-Type': 'application/json',
  };
  if (gatewayId) headers['cf-aig-gateway-id'] = gatewayId;
  const body = JSON.stringify({
    model: JEV_MODEL,
    input: {
      state: 'ApplianceClinic connection check.',
      questions: {
        ping: {
          type: 'noul',
          instructions: 'Is this a connection check that you received?',
          criteria: { true: 'The request was received', false: 'The request was not received' },
        },
      },
    },
  });
  try {
    const res = await fetchFn(url, { method: 'POST', headers, body, signal: controller.signal });
    const latencyMs = Date.now() - started;
    if (res.status === 401 || res.status === 403) {
      return { status: 'FAILED', connected: false, model: null, latencyMs, errorCategory: 'AUTH' };
    }
    if (res.status === 408 || res.status === 504) {
      return { status: 'FAILED', connected: false, model: null, latencyMs, errorCategory: 'TIMEOUT' };
    }
    let parsed = null;
    try { parsed = await res.json(); } catch { parsed = null; }
    if (!res.ok) {
      return { status: 'FAILED', connected: false, model: null, latencyMs, errorCategory: 'HTTP' };
    }
    if (parsed && parsed.success === false) {
      const code = Array.isArray(parsed.errors) && parsed.errors[0] && parsed.errors[0].code;
      const cat = code === 10000 || code === 10001 ? 'AUTH' : 'HTTP';
      return { status: 'FAILED', connected: false, model: null, latencyMs, errorCategory: cat };
    }
    const result = unwrapJevResult(parsed);
    if (!result) {
      return { status: 'FAILED', connected: false, model: null, latencyMs, errorCategory: 'MALFORMED' };
    }
    const model = typeof result.model === 'string' && result.model.trim() ? result.model.trim() : JEV_MODEL;
    return { status: 'ONLINE', connected: true, model, latencyMs, errorCategory: null };
  } catch (err) {
    const latencyMs = Date.now() - started;
    const msg = err && err.message ? err.message : String(err);
    const errorCategory = /abort/i.test(msg) ? 'TIMEOUT' : 'NETWORK';
    return { status: 'FAILED', connected: false, model: null, latencyMs, errorCategory };
  } finally {
    clearTimeout(timer);
  }
}

// ---- Connection probe (synthetic ping only; no customer data) ---------------

async function probeChat(opts) {
  const { url, headers = {}, model, timeoutMs = 12000, openai = false } = opts;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const started = Date.now();
  // OpenAI's current models (GPT-5/o-series) require max_completion_tokens and
  // reject a non-default temperature, so the frontier probe must match the real
  // adapter's dialect. LM Studio keeps the classic max_tokens/temperature.
  const tokenCap = openai ? { max_completion_tokens: 16 } : { max_tokens: 1, temperature: 0 };
  const body = JSON.stringify(Object.assign(
    model ? { model } : {},
    { messages: [{ role: 'user', content: 'ping' }], stream: false },
    tokenCap,
  ));
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json' }, headers),
      body,
      signal: controller.signal,
    });
    const latencyMs = Date.now() - started;
    if (res.ok) return { status: 'ONLINE', latencyMs };
    let text = '';
    try { text = (await res.text()).slice(0, 400); } catch { /* ignore */ }
    // Surface the provider's real message (never contains the key) so setup
    // problems are diagnosable instead of a vague "unusable".
    let msg = '';
    try { const j = JSON.parse(text); msg = (j.error && (j.error.message || j.error.code)) || ''; } catch { msg = text; }
    msg = String(msg).slice(0, 160);
    if (res.status === 401 || res.status === 403) return { status: 'CONFIG_ERROR', latencyMs, detail: 'Credential rejected' };
    if (res.status === 404) return { status: 'MODEL_ERROR', latencyMs, detail: msg || 'Model not found' };
    if (/model/i.test(text) && !/parameter|unsupported|max_tokens|temperature/i.test(text)) return { status: 'MODEL_ERROR', latencyMs, detail: msg || 'Model not found or unusable' };
    return { status: 'CONFIG_ERROR', latencyMs, detail: msg || ('HTTP ' + res.status) };
  } catch (err) {
    const latencyMs = Date.now() - started;
    const msg = err && err.message ? err.message : String(err);
    return { status: 'OFFLINE', latencyMs, detail: /abort/i.test(msg) ? 'Timed out' : 'Unreachable' };
  } finally {
    clearTimeout(timer);
  }
}

// ---- Model discovery (so the admin sees real model names, not free text) ---

/**
 * List the models known to the local LM Studio server. Prefers the native
 * /api/v0/models (which reports load state + architecture) and falls back to
 * the OpenAI-compatible /v1/models (ids only). Returns the currently LOADED
 * chat/vision model(s) so the UI can show exactly what is answering.
 */
async function listLocalModels(endpoint) {
  const base = String(endpoint || '').replace(/\/$/, '');
  if (!base) return { ok: false, loaded: [], all: [] };
  const headers = { 'ngrok-skip-browser-warning': '1' };
  try {
    const r = await fetch(base + '/api/v0/models', { headers });
    if (r.ok) {
      const j = await r.json();
      const arr = (j.data || j || []).filter((m) => m && m.type !== 'embeddings');
      return {
        ok: true,
        loaded: arr.filter((m) => m.state === 'loaded').map((m) => ({ id: m.id, arch: m.arch || null })),
        all: arr.map((m) => m.id),
      };
    }
  } catch { /* fall through */ }
  try {
    const r = await fetch(base + '/v1/models', { headers });
    if (r.ok) { const j = await r.json(); return { ok: true, loaded: [], all: (j.data || []).map((m) => m.id) }; }
  } catch { /* ignore */ }
  return { ok: false, loaded: [], all: [] };
}

/**
 * List the OpenAI chat models available to the stored credential. Filters out
 * non-chat model families (embeddings/audio/image/etc.) so the admin only sees
 * things they can actually route diagnosis to.
 */
async function listFrontierModels(key) {
  if (!key) return { ok: false, configured: false, models: [] };
  const base = (process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, '');
  try {
    const r = await fetch(base + '/models', { headers: { Authorization: 'Bearer ' + key } });
    if (!r.ok) return { ok: false, configured: true, models: [] };
    const j = await r.json();
    const models = (j.data || [])
      .map((m) => m.id)
      .filter((id) => /^(gpt-|o\d|chatgpt)/i.test(id) && !/(embed|whisper|tts|audio|image|dall|moderation|realtime|transcribe|search|instruct)/i.test(id))
      .sort();
    return { ok: true, configured: true, models };
  } catch {
    return { ok: false, configured: true, models: [] };
  }
}

module.exports = {
  AI_CONFIG_SECRET_ID, OPENAI_SECRET_ID, JEV_SECRET_ID, JEV_MODEL, JEV_PROVIDER_LABEL,
  defaultConfig, normalise, auditable, validateActivation, toClientView, withHistory,
  describeSetup, LOCAL_MANAGED_MODEL,
  loadConfig, loadConfigWithStatus, saveConfig, loadConfigDocument, saveConfigDocument, isKeyConfigured, saveKey, loadKeyMeta, getKey, probeChat,
  listLocalModels, listFrontierModels,
  parseJevStored, toJevPublic, defaultJevPublic, jevSecretPayload,
  loadJevWithStatus, saveJevStored, getJevCredentials, probeJev, unwrapJevResult,
};
