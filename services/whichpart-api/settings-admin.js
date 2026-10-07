'use strict';
/**
 * ApplianceClinic Settings — admin view-model over the real configuration.
 *
 * Settings is not an environment editor. It exposes the small set of product
 * configuration an administrator should understand, plus the existing
 * diagnostic-inference control plane (Secrets Manager) that Part Finder already
 * consumes. Secrets, prompts, GOLD harness knobs, and dataset editors stay out.
 */

const crypto = require('crypto');
const aiConfig = require('./ai-config');
const transcripts = require('./transcripts');
const reviewConfig = require('./transcript-review/config');
const { readBackAfterWrite } = require('./config-readback');

// Part Finder caches the admin config secret for 60 s (admin-config.js CACHE_TTL_MS) and, separately,
// the resolved COMPOSE provider for 60 s (part-finder-lambda.js PROVIDERS_TTL_MS). Because UNDERSTAND
// refreshes the shared secret cache on its own schedule, a COMPOSE change can take up to ~2 minutes
// to reach a warm Part Finder instance; Jev UNDERSTAND credentials up to ~1 minute. Cold instances
// read on their first request.
const PROPAGATION_TTL_MS = 60 * 1000;
const COMPOSE_PROPAGATION_MAX_MS = 2 * PROPAGATION_TTL_MS;
const JEV_PROPAGATION_MAX_MS = PROPAGATION_TTL_MS;
const NOTE_MIN = 5;
const NOTE_MAX = 300;
const HISTORY_VIEW = 10;
// Model ids: provider ids like "gpt-5.6-terra", "qwen/qwen3-8b", "lmstudio-community/x@q4". No spaces/quotes.
const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,119}$/;
const OPENAI_LIKE_RE = /^(gpt-|o\d|chatgpt|text-|davinci)/i;
const MEDIA_OVERLAY_TTL_MS = 10 * 1000;
const ERROR_CODE_OVERLAY_TTL_MS = 10 * 1000;
const CONVERSATION_WINDOW = 12;

const PATCH_ROOT_KEYS = new Set(['expectedVersion', 'expectedRevision', 'note', 'routing', 'local', 'frontier']);
const PATCH_ROUTING_KEYS = new Set(['understand', 'compose']);
const PATCH_LOCAL_KEYS = new Set(['enabled', 'endpoint', 'model']);
const PATCH_FRONTIER_KEYS = new Set(['enabled', 'model']);
const SECRET_FIELD_RE = /^(apiKey|apiToken|password|token|secret|authorization|bearer|accessKey|secretAccessKey)$/i;

const PATCH_JEV_KEYS = new Set(['expectedVersion', 'accountId', 'gatewayId', 'apiToken', 'note']);

// ---- concurrency token, diffs, validation helpers -----------------------------------------------

/**
 * Content revision of the stored AI config. Every writer of the secret (Settings, and the batch
 * test runner, which rewrites routing without bumping `version`) changes it, so a stale page is
 * detected even when the version number did not move.
 */
function configRevision(cfg) {
  const c = aiConfig.normalise(cfg || {});
  const basis = JSON.stringify({ a: aiConfig.auditable(c), v: c.version || 1, u: c.updatedAt || null });
  return crypto.createHash('sha256').update(basis).digest('hex').slice(0, 16);
}

const FIELD_LABELS = {
  'routing.compose': 'COMPOSE provider',
  'routing.understand': 'Legacy UNDERSTAND routing',
  'local.enabled': 'Private AI enabled',
  'local.model': 'Private AI model id',
  'local.endpoint': 'Private AI endpoint override',
  'frontier.enabled': 'OpenAI enabled',
  'frontier.model': 'OpenAI model',
};
function flat(a) {
  return {
    'routing.compose': a.routing.compose,
    'routing.understand': a.routing.understand,
    'local.enabled': a.local.enabled,
    'local.model': a.local.model || '',
    'local.endpoint': a.local.endpoint || '',
    'frontier.enabled': a.frontier.enabled,
    'frontier.model': a.frontier.model || '',
  };
}
/** Field-level before/after list. The endpoint value is reduced to its host (never paths/queries). */
function diffConfigs(prev, next) {
  const p = flat(aiConfig.auditable(aiConfig.normalise(prev)));
  const n = flat(aiConfig.auditable(aiConfig.normalise(next)));
  return Object.keys(FIELD_LABELS).filter((k) => p[k] !== n[k]).map((k) => ({
    field: k, label: FIELD_LABELS[k],
    from: k === 'local.endpoint' ? endpointDisplay(p[k]) : p[k],
    to: k === 'local.endpoint' ? endpointDisplay(n[k]) : n[k],
  }));
}
function endpointDisplay(v) {
  if (!v) return '(deployed default)';
  try { return new URL(v).host; } catch { return '(custom address)'; }
}
/** Which changes alter live customer COMPOSE (and therefore require a change reason). */
function liveImpact(changes, next) {
  const route = next.routing.compose;
  return changes.filter((c) => c.field === 'routing.compose'
    || c.field === 'local.endpoint' || c.field === 'local.enabled'
    || (c.field === 'local.model' && route === 'local')
    || (c.field === 'frontier.model' && route === 'frontier')
    || (c.field === 'frontier.enabled' && route === 'frontier'));
}
function validEndpoint(v) {
  if (v === '') return true;
  if (typeof v !== 'string' || v.length > 200) return false;
  let u;
  try { u = new URL(v); } catch { return false; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return false;
  if (u.username || u.password || u.search || u.hash) return false;
  // Never let customer inference be pointed at cloud metadata / link-local addresses.
  if (/^(169\.254\.|\[?fe80:|metadata\.google)/i.test(u.hostname)) return false;
  return true;
}
function validModel(v) { return v === '' || (typeof v === 'string' && MODEL_RE.test(v)); }
function parseNote(v) {
  if (v == null || v === '') return { ok: true, note: null };
  if (typeof v !== 'string') return { ok: false };
  const t = v.trim();
  if (t.length && (t.length < NOTE_MIN || t.length > NOTE_MAX)) return { ok: false };
  return { ok: true, note: t || null };
}

function providerLabel(provider) {
  if (provider === 'openai') return 'OpenAI';
  if (provider === 'lmstudio') return 'Private AI';
  if (provider === 'jev') return 'TypeSafe Jev via Cloudflare';
  return provider || 'Unknown';
}

function routeProvider(route, cfg) {
  if (route === 'frontier') {
    return {
      route: 'frontier',
      provider: 'openai',
      providerLabel: providerLabel('openai'),
      model: (cfg.frontier && cfg.frontier.model) || null,
      modelLabel: (cfg.frontier && cfg.frontier.model) || 'Model not set',
    };
  }
  const pinned = String((cfg.local && cfg.local.model) || '').trim();
  return {
    route: 'local',
    provider: 'lmstudio',
    providerLabel: providerLabel('lmstudio'),
    model: pinned || null,
    modelLabel: pinned || 'Model managed by LM Studio',
  };
}

function compareStage(configured, running) {
  if (!running || running.available !== true) {
    return {
      status: 'unverifiable',
      label: 'Running value not currently verifiable',
    };
  }
  const sameProvider = configured.provider === running.provider;
  const pinned = configured.model;
  const sameModel = !pinned || pinned === running.model;
  if (sameProvider && sameModel) {
    return { status: 'in_sync', label: 'In sync' };
  }
  return { status: 'mismatch', label: 'Running value differs from configuration' };
}

function parseRunningStage(raw) {
  if (!raw || typeof raw !== 'object') return { available: false };
  const provider = typeof raw.provider === 'string' ? raw.provider : null;
  const model = typeof raw.model === 'string' && raw.model.trim() ? raw.model.trim() : null;
  if (!provider) return { available: false };
  return {
    available: true,
    configured: raw.configured === true,
    provider,
    providerLabel: providerLabel(provider),
    model,
    modelLabel: model || (provider === 'lmstudio' ? 'Model managed by LM Studio' : 'Model not reported'),
  };
}

function storeNote(status) {
  if (status === 'ok') return null;
  if (status === 'absent') return 'No saved admin configuration yet — deployed defaults are in effect.';
  if (status === 'malformed') return 'Saved configuration was unreadable. Deployed defaults are shown until it is saved again.';
  if (status === 'unavailable') return 'Configuration store is unavailable. Deployed defaults are shown.';
  return null;
}

function extraKeys(obj, allowed) {
  return Object.keys(obj || {}).filter((k) => !allowed.has(k));
}

function rejectSecrets(obj, path) {
  if (!obj || typeof obj !== 'object') return null;
  for (const k of Object.keys(obj)) {
    if (SECRET_FIELD_RE.test(k)) return path + k;
    if (obj[k] && typeof obj[k] === 'object' && !Array.isArray(obj[k])) {
      const nested = rejectSecrets(obj[k], path + k + '.');
      if (nested) return nested;
    }
  }
  return null;
}

function parseInferencePatch(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, status: 400, error: 'Malformed payload' };
  }
  const secret = rejectSecrets(body, '');
  if (secret) return { ok: false, status: 400, error: 'Secret fields are not accepted', detail: secret };
  const unknown = extraKeys(body, PATCH_ROOT_KEYS);
  if (unknown.length) return { ok: false, status: 400, error: 'Unknown setting', details: unknown };
  if (!Number.isInteger(body.expectedVersion) || body.expectedVersion < 1) {
    return { ok: false, status: 400, error: 'expectedVersion is required' };
  }
  if (body.routing) {
    const bad = extraKeys(body.routing, PATCH_ROUTING_KEYS);
    if (bad.length) return { ok: false, status: 400, error: 'Unknown setting', details: bad.map((k) => 'routing.' + k) };
    for (const k of PATCH_ROUTING_KEYS) {
      if (body.routing[k] != null && body.routing[k] !== 'local' && body.routing[k] !== 'frontier') {
        return { ok: false, status: 400, error: 'Unsupported provider route', details: ['routing.' + k] };
      }
    }
  }
  if (body.local) {
    const bad = extraKeys(body.local, PATCH_LOCAL_KEYS);
    if (bad.length) return { ok: false, status: 400, error: 'Unknown setting', details: bad.map((k) => 'local.' + k) };
    if (body.local.enabled != null && typeof body.local.enabled !== 'boolean') {
      return { ok: false, status: 400, error: 'Malformed value', details: ['local.enabled'] };
    }
    if (body.local.endpoint != null && typeof body.local.endpoint !== 'string') {
      return { ok: false, status: 400, error: 'Malformed value', details: ['local.endpoint'] };
    }
    if (body.local.model != null && typeof body.local.model !== 'string') {
      return { ok: false, status: 400, error: 'Malformed value', details: ['local.model'] };
    }
  }
  if (body.frontier) {
    const bad = extraKeys(body.frontier, PATCH_FRONTIER_KEYS);
    if (bad.length) return { ok: false, status: 400, error: 'Unknown setting', details: bad.map((k) => 'frontier.' + k) };
    if (body.frontier.enabled != null && typeof body.frontier.enabled !== 'boolean') {
      return { ok: false, status: 400, error: 'Malformed value', details: ['frontier.enabled'] };
    }
    if (body.frontier.model != null && typeof body.frontier.model !== 'string') {
      return { ok: false, status: 400, error: 'Malformed value', details: ['frontier.model'] };
    }
    if (body.frontier.provider && body.frontier.provider !== 'openai') {
      return { ok: false, status: 400, error: 'Unsupported provider', details: ['frontier.provider'] };
    }
  }
  // Real constraints, not just types (the browser's dropdowns are not authoritative).
  if (body.local && body.local.model != null && !validModel(body.local.model.trim())) {
    return { ok: false, status: 400, error: 'Model id must be up to 120 characters: letters, digits and . _ : / @ + -', details: ['local.model'] };
  }
  if (body.frontier && body.frontier.model != null && !validModel(body.frontier.model.trim())) {
    return { ok: false, status: 400, error: 'Model id must be up to 120 characters: letters, digits and . _ : / @ + -', details: ['frontier.model'] };
  }
  if (body.local && body.local.endpoint != null && !validEndpoint(body.local.endpoint.trim())) {
    return { ok: false, status: 400, error: 'Private AI endpoint must be an http(s) address without credentials, query or fragment', details: ['local.endpoint'] };
  }
  if (body.expectedRevision != null && (typeof body.expectedRevision !== 'string' || !/^[0-9a-f]{16}$/.test(body.expectedRevision))) {
    return { ok: false, status: 400, error: 'expectedRevision is malformed' };
  }
  const note = parseNote(body.note);
  if (!note.ok) return { ok: false, status: 400, error: 'Change reason must be ' + NOTE_MIN + '–' + NOTE_MAX + ' characters', details: ['note'] };
  const patch = Object.assign({}, body);
  delete patch.note; delete patch.expectedRevision; delete patch.expectedVersion;
  return { ok: true, expectedVersion: body.expectedVersion, expectedRevision: body.expectedRevision || null, note: note.note, patch };
}

function applyInferencePatch(prev, patch) {
  const merged = {
    local: Object.assign({}, prev.local, patch.local || {}),
    frontier: Object.assign({}, prev.frontier, patch.frontier || {}, { provider: 'openai' }),
    routing: Object.assign({}, prev.routing, patch.routing || {}),
    lastFrontierTest: prev.lastFrontierTest || null,
  };
  if (merged.routing.understand === 'frontier' || merged.routing.compose === 'frontier') {
    merged.frontier.enabled = true;
  }
  return aiConfig.normalise(merged);
}

async function probePartFinderModels(opts) {
  const fetchFn = opts.fetch || fetch;
  const url = String(opts.partFinderHealthUrl || '').replace(/\/$/, '');
  if (!url) return { available: false, reason: 'No Part Finder health URL' };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs || 5000);
  try {
    const res = await fetchFn(url + '/health', { signal: ctrl.signal, headers: { accept: 'application/json' } });
    const json = await res.json().catch(() => null);
    if (!res.ok || !json || !json.models) return { available: false, reason: 'Part Finder health did not report models' };
    return {
      available: true,
      understand: parseRunningStage(json.models.understand),
      compose: parseRunningStage(json.models.compose),
    };
  } catch {
    return { available: false, reason: 'Part Finder health unreachable' };
  } finally {
    clearTimeout(timer);
  }
}

function runningView(runningStage) {
  if (runningStage && runningStage.available) {
    return {
      available: true,
      provider: runningStage.provider,
      providerLabel: runningStage.providerLabel || providerLabel(runningStage.provider),
      model: runningStage.model,
      modelLabel: runningStage.modelLabel || runningStage.model,
    };
  }
  return { available: false, reason: (runningStage && runningStage.reason) || 'Running value not currently verifiable' };
}

function stageView(name, cfg, setupStage, runningStage) {
  const route = cfg.routing[name];
  const configured = routeProvider(route, cfg);
  const setup = setupStage || {};
  // Show the model id Part Finder ACTUALLY sends (resolveProvidersFromAdminConfig passes local.model
  // verbatim to LM Studio). describeSetup hides an OpenAI-looking pinned id as "managed by LM Studio"
  // for the Test page; Settings must not hide it, so it is shown with an explicit warning instead.
  const pinnedLocal = route === 'local' ? String((cfg.local && cfg.local.model) || '').trim() : '';
  const frontierModel = String((cfg.frontier && cfg.frontier.model) || '').trim();
  const suspicious = Boolean(pinnedLocal) && (OPENAI_LIKE_RE.test(pinnedLocal) || pinnedLocal === frontierModel || pinnedLocal === (setupStage && setupStage.judgeModel));
  const configuredView = {
    provider: configured.provider,
    providerLabel: configured.providerLabel,
    model: route === 'local' ? (pinnedLocal || null) : (setupStage ? setup.model : configured.model),
    modelLabel: route === 'local' ? (pinnedLocal ? pinnedLocal + ' (pinned)' : 'Model managed by LM Studio') : ((setupStage && setup.modelLabel) || configured.modelLabel),
    route: configured.route,
    warning: suspicious
      ? 'The pinned Private AI model id "' + pinnedLocal + '" looks like an OpenAI model name. Part Finder sends exactly this id to Private AI (LM Studio) for every COMPOSE request. It was most likely left behind by a batch test run. Review it before relying on it.'
      : null,
  };
  return {
    id: name,
    label: name === 'understand' ? 'UNDERSTAND' : 'COMPOSE',
    purpose: name === 'understand'
      ? 'Interprets the customer’s description before retrieval.'
      : 'Writes the customer-facing diagnostic reply.',
    editable: true,
    source: 'Admin runtime configuration',
    sourceKind: 'admin_runtime',
    configured: configuredView,
    running: runningView(runningStage),
    sync: compareStage(
      { provider: configuredView.provider, model: configuredView.model },
      runningStage && runningStage.available ? runningStage : { available: false },
    ),
  };
}

function jevUnderstandView(jevPublic, runningStage) {
  const configuredView = {
    provider: 'jev',
    providerLabel: aiConfig.JEV_PROVIDER_LABEL,
    model: aiConfig.JEV_MODEL,
    modelLabel: aiConfig.JEV_MODEL,
    route: 'jev',
  };
  const running = runningView(runningStage);
  return {
    id: 'understand',
    label: 'UNDERSTAND',
    purpose: 'TypeSafe Jev interprets the customer’s description as typed semantic decisions before retrieval.',
    editable: true,
    editableLabel: 'Yes — Jev UNDERSTAND section',
    source: 'Admin runtime configuration',
    sourceKind: 'admin_runtime',
    configured: configuredView,
    running,
    sync: compareStage(
      { provider: configuredView.provider, model: configuredView.model },
      running.available ? running : { available: false },
    ),
  };
}

function jevStoreNote(status) {
  if (status === 'ok') return null;
  if (status === 'absent') return 'No Jev credential is stored yet. UNDERSTAND cannot run until it is configured here.';
  if (status === 'malformed') return 'Stored Jev configuration was unreadable. Re-enter the Cloudflare account ID and token.';
  if (status === 'unavailable') return 'Jev configuration store is unavailable.';
  return null;
}

function jevView(jevLoaded, runningStage) {
  const pub = (jevLoaded && jevLoaded.public) || aiConfig.defaultJevPublic();
  const running = runningView(runningStage);
  const credentialConfigured = pub.credentialConfigured === true;
  return {
    editable: true,
    source: 'Admin runtime configuration',
    provider: pub.provider,
    providerLabel: pub.providerLabel,
    model: pub.model,
    accountId: pub.accountId,
    gatewayId: pub.gatewayId,
    credentialConfigured,
    credential: credentialConfigured ? 'configured' : 'missing',
    version: pub.version || 1,
    updatedAt: pub.updatedAt || null,
    updatedByEmail: pub.updatedByEmail || null,
    history: (pub.history || []).slice(0, HISTORY_VIEW),
    propagation: { maxMs: JEV_PROPAGATION_MAX_MS, note: 'Each warm Part Finder instance uses a saved Jev change within about 1 minute.' },
    store: { status: (jevLoaded && jevLoaded.status) || 'absent', note: jevStoreNote(jevLoaded && jevLoaded.status) },
    running,
    sync: compareStage(
      { provider: 'jev', model: aiConfig.JEV_MODEL },
      running.available ? running : { available: false },
    ),
  };
}

function parseJevPatch(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, status: 400, error: 'Malformed payload' };
  }
  const withoutToken = Object.assign({}, body);
  delete withoutToken.apiToken;
  const secret = rejectSecrets(withoutToken, '');
  if (secret) return { ok: false, status: 400, error: 'Secret fields are not accepted', detail: secret };
  const unknown = extraKeys(body, PATCH_JEV_KEYS);
  if (unknown.length) return { ok: false, status: 400, error: 'Unknown setting', details: unknown };
  if (!Number.isInteger(body.expectedVersion) || body.expectedVersion < 1) {
    return { ok: false, status: 400, error: 'expectedVersion is required' };
  }
  if (body.accountId != null && typeof body.accountId !== 'string') {
    return { ok: false, status: 400, error: 'Malformed value', details: ['accountId'] };
  }
  if (body.gatewayId != null && typeof body.gatewayId !== 'string') {
    return { ok: false, status: 400, error: 'Malformed value', details: ['gatewayId'] };
  }
  if (body.apiToken != null && typeof body.apiToken !== 'string') {
    return { ok: false, status: 400, error: 'Malformed value', details: ['apiToken'] };
  }
  const idRe = /^[A-Za-z0-9_-]{1,64}$/;
  if (typeof body.accountId === 'string' && body.accountId.trim() && !idRe.test(body.accountId.trim())) {
    return { ok: false, status: 400, error: 'Cloudflare Account ID must be letters, digits, - or _ (up to 64)', details: ['accountId'] };
  }
  if (typeof body.gatewayId === 'string' && body.gatewayId.trim() && !idRe.test(body.gatewayId.trim())) {
    return { ok: false, status: 400, error: 'Gateway ID must be letters, digits, - or _ (up to 64)', details: ['gatewayId'] };
  }
  if (typeof body.apiToken === 'string' && body.apiToken.length > 400) {
    return { ok: false, status: 400, error: 'API token is too long', details: ['apiToken'] };
  }
  const note = parseNote(body.note);
  if (!note.ok) return { ok: false, status: 400, error: 'Change reason must be ' + NOTE_MIN + '–' + NOTE_MAX + ' characters', details: ['note'] };
  return {
    ok: true,
    note: note.note,
    expectedVersion: body.expectedVersion,
    patch: {
      accountId: typeof body.accountId === 'string' ? body.accountId.trim() : undefined,
      gatewayId: typeof body.gatewayId === 'string' ? body.gatewayId.trim() : undefined,
      apiToken: typeof body.apiToken === 'string' ? body.apiToken.trim() : undefined,
    },
  };
}

function applyJevPatch(prevStored, patch, byEmail, note) {
  const prev = prevStored || { accountId: '', apiToken: '', gatewayId: null, version: 1 };
  const accountId = patch.accountId ? patch.accountId : (prev.accountId || '');
  const apiToken = patch.apiToken ? patch.apiToken : (prev.apiToken || '');
  let gatewayId = prev.gatewayId || null;
  if (patch.gatewayId !== undefined) gatewayId = patch.gatewayId || null;
  const version = (Number.isInteger(prev.version) && prev.version > 0 ? prev.version : 1) + 1;
  const at = new Date().toISOString();
  // Audit entry: identifiers before/after (not secret), whether the token was replaced (never the token).
  const entry = { at, byEmail: byEmail || 'admin', note: note || null, version, tokenReplaced: Boolean(patch.apiToken) && patch.apiToken !== prev.apiToken };
  if ((prev.accountId || '') !== accountId) entry.accountId = { from: prev.accountId || null, to: accountId || null };
  if ((prev.gatewayId || null) !== gatewayId) entry.gatewayId = { from: prev.gatewayId || null, to: gatewayId };
  return {
    accountId,
    apiToken,
    gatewayId,
    version,
    updatedAt: at,
    updatedByEmail: byEmail || 'admin',
    history: [entry].concat(Array.isArray(prev.history) ? prev.history : []).slice(0, 20),
    _changed: Boolean(entry.tokenReplaced || entry.accountId || entry.gatewayId),
  };
}

/** Change history for display: who / when / what changed from → to / why. Endpoint shown as host only. */
function historyView(history) {
  return (Array.isArray(history) ? history : []).slice(0, HISTORY_VIEW).map((h) => {
    let changes = Array.isArray(h.changes) ? h.changes : null;
    if (!changes && h.previous && h.next) {
      try { changes = diffConfigs(h.previous, h.next); } catch { changes = []; }
    }
    return {
      at: h.at || null, byEmail: h.byEmail || null, note: h.note || null, version: h.version || null,
      event: h.event || null, runId: h.runId || null, requestedBy: h.requestedBy || null,
      changes: (changes || []).map((c) => ({ field: c.field, label: c.label || FIELD_LABELS[c.field] || c.field, from: c.from, to: c.to })),
    };
  });
}

/**
 * Every setting Settings shows, traced to its runtime consumer. `impact`:
 *   high        — changes live customer diagnosis immediately-ish (after the cache TTL)
 *   production  — changes live behaviour only in some configurations (stated in `when`)
 *   none        — stored but not read by customer inference (legacy / validation-only)
 *   readonly    — deployment / code configuration, not editable here
 */
function settingsInventory(cfg, ctx) {
  const d = aiConfig.defaultConfig();
  const route = cfg.routing.compose;
  const composeTiming = 'Within about 2 minutes (Part Finder caches config and provider, 60 s each)';
  const row = (o) => Object.assign({ differsFromDefault: String(o.current) !== String(o.default) }, o);
  return [
    row({
      id: 'routing.compose', label: 'COMPOSE provider', group: 'ai-routing', editable: true, impact: 'high', reasonRequired: true,
      current: route, currentLabel: providerLabel(route === 'frontier' ? 'openai' : 'lmstudio'),
      default: d.routing.compose, defaultLabel: 'Private AI',
      consumer: 'Part Finder resolveProvidersFromAdminConfig → COMPOSE writes every customer reply',
      effect: composeTiming,
      impactText: 'Changes which AI writes the reply for every new customer diagnosis.' + (route === 'frontier' ? '' : ' Switching to OpenAI sends customer conversations to OpenAI.'),
    }),
    row({
      id: 'local.model', label: 'Private AI model id', group: 'ai-routing', editable: true,
      impact: route === 'local' ? 'high' : 'production', reasonRequired: route === 'local',
      current: cfg.local.model || '', currentLabel: cfg.local.model || 'Not pinned — LM Studio\u2019s loaded model',
      default: d.local.model, defaultLabel: 'Not pinned',
      consumer: 'Part Finder LMStudioProvider model id (sent verbatim)',
      effect: composeTiming,
      impactText: route === 'local' ? 'COMPOSE runs on Private AI now, so this id is sent with every live customer reply.' : 'Used only when COMPOSE is routed to Private AI (it is not now).',
      warning: (ctx.compose && ctx.compose.configured && ctx.compose.configured.warning) || null,
    }),
    row({
      id: 'frontier.model', label: 'OpenAI model', group: 'ai-routing', editable: true,
      impact: route === 'frontier' ? 'high' : 'production', reasonRequired: route === 'frontier',
      current: cfg.frontier.model || '', currentLabel: cfg.frontier.model || 'Not set',
      default: d.frontier.model, defaultLabel: 'Not set',
      consumer: 'Part Finder OpenAIProvider model id; also Test → Batch frontier experiments',
      effect: composeTiming,
      impactText: route === 'frontier' ? 'COMPOSE runs on OpenAI now, so this model writes every live customer reply.' : 'Used only when COMPOSE is routed to OpenAI (it is not now).',
    }),
    row({
      id: 'local.endpoint', label: 'Private AI endpoint override', group: 'ai-routing', editable: true, impact: 'high', reasonRequired: true,
      current: cfg.local.endpoint ? 'set' : 'unset', currentLabel: cfg.local.endpoint ? 'Custom address (' + endpointDisplay(cfg.local.endpoint) + ')' : 'Deployed default',
      default: 'unset', defaultLabel: 'Deployed default (LM_STUDIO_URL)',
      consumer: 'Part Finder LMStudioProvider base URL (overrides LM_STUDIO_URL)',
      effect: composeTiming,
      impactText: 'Points Private AI COMPOSE (and Settings connection checks) at a different server.',
    }),
    row({
      id: 'jev.credential', label: 'Jev UNDERSTAND (Cloudflare account, gateway, token)', group: 'ai-routing', editable: true, impact: 'high', reasonRequired: true,
      current: ctx.jev && ctx.jev.credentialConfigured ? 'configured' : 'missing',
      currentLabel: ctx.jev && ctx.jev.credentialConfigured ? 'Configured' + (ctx.jev.gatewayId ? ' · via AI Gateway' : '') : 'Not configured',
      default: 'missing', defaultLabel: 'Not configured (env fallback only)',
      consumer: 'Part Finder understand() → Jev interprets every customer message',
      effect: 'Within about 1 minute (Part Finder caches it for 60 s)',
      impactText: 'A wrong account or token makes every new customer turn fail UNDERSTAND.',
    }),
    row({
      id: 'openai.credential', label: 'OpenAI credential', group: 'credentials', editable: true, impact: route === 'frontier' ? 'high' : 'production', reasonRequired: false,
      current: ctx.keyConfigured ? 'configured' : 'missing', currentLabel: ctx.keyConfigured ? 'Configured' : 'Not configured',
      default: 'missing', defaultLabel: 'Not configured',
      consumer: 'Part Finder OpenAIProvider (only fetched while a stage routes to OpenAI); BFF quality reviewer and batch runs',
      effect: 'Part Finder: within about 1 minute while routed to OpenAI. Reviewer / batch: next use.',
      impactText: route === 'frontier' ? 'COMPOSE is routed to OpenAI: replacing the key affects live customer replies.' : 'No live customer effect while COMPOSE uses Private AI.',
    }),
    row({
      id: 'routing.understand', label: 'Legacy UNDERSTAND routing', group: 'legacy', editable: false, impact: 'none', deprecated: true,
      current: cfg.routing.understand, currentLabel: cfg.routing.understand === 'frontier' ? 'OpenAI' : 'Private AI',
      default: d.routing.understand, defaultLabel: 'Private AI',
      consumer: 'None for customers — UNDERSTAND is TypeSafe Jev. Still resolved (not used) by Part Finder and written by the batch runner.',
      effect: 'No customer effect',
      impactText: 'Deprecated. Not editable: a frontier value without a key would still break COMPOSE resolution.',
    }),
    row({
      id: 'local.enabled', label: 'Private AI enabled flag', group: 'legacy', editable: false, impact: 'none', deprecated: true,
      current: cfg.local.enabled, currentLabel: cfg.local.enabled ? 'On' : 'Off', default: d.local.enabled, defaultLabel: 'On',
      consumer: 'Not read by Part Finder. Only gates which routings Settings accepts.',
      effect: 'No runtime effect', impactText: 'Validation-only flag.',
    }),
    row({
      id: 'frontier.enabled', label: 'OpenAI enabled flag', group: 'legacy', editable: false, impact: 'none', deprecated: true,
      current: cfg.frontier.enabled, currentLabel: cfg.frontier.enabled ? 'On' : 'Off', default: d.frontier.enabled, defaultLabel: 'Off',
      consumer: 'Not read by Part Finder. Set automatically when COMPOSE routes to OpenAI; gates Settings validation.',
      effect: 'No runtime effect', impactText: 'Validation-only flag.',
    }),
  ];
}

async function buildView(opts) {
  opts = opts || {};
  const load = opts.loadConfigWithStatus || aiConfig.loadConfigWithStatus.bind(aiConfig);
  const keyFn = opts.isKeyConfigured || aiConfig.isKeyConfigured.bind(aiConfig);
  const jevFn = opts.loadJevWithStatus || aiConfig.loadJevWithStatus.bind(aiConfig);
  const [store, keyConfigured, jevRaw] = await Promise.all([
    load(),
    keyFn(),
    jevFn().catch(() => ({ status: 'unavailable', stored: null, public: aiConfig.defaultJevPublic() })),
  ]);
  const jevLoaded = (jevRaw && jevRaw.public) ? jevRaw : { status: 'absent', stored: null, public: aiConfig.defaultJevPublic() };
  const cfg = store.cfg;
  const setup = aiConfig.describeSetup({
    cfg,
    judgeModel: opts.judgeModel || process.env.ACQ_JUDGE_MODEL || '',
    keyConfigured,
    jevConfigured: Boolean(jevLoaded && jevLoaded.public && jevLoaded.public.credentialConfigured),
  });
  const running = opts.runningModels
    || await probePartFinderModels({
      fetch: opts.fetch,
      partFinderHealthUrl: opts.partFinderHealthUrl,
      timeoutMs: opts.timeoutMs,
    });
  const review = reviewConfig.resolveReviewConfig(opts.env || process.env);
  const policy = (opts.transcriptPolicy || transcripts.policy)();
  const understand = jevUnderstandView(jevLoaded && jevLoaded.public, running.understand);
  const compose = stageView('compose', cfg, Object.assign({ judgeModel: opts.judgeModel || process.env.ACQ_JUDGE_MODEL || '' }, setup.compose), running.compose);
  let keyMeta;
  if (opts.loadKeyMeta) keyMeta = await opts.loadKeyMeta();
  else if (opts.isKeyConfigured) keyMeta = { configured: keyConfigured, updatedAt: null, updatedByEmail: null, history: [] };
  else keyMeta = await aiConfig.loadKeyMeta();
  const revision = configRevision(cfg);
  const inventory = settingsInventory(cfg, { keyConfigured, jev: jevLoaded && jevLoaded.public, compose });

  return {
    // Temporary batch routing override (secret-free). When active, the inference values below are
    // TEMPORARY batch state, not a permanent Admin setting.
    batchOverride: opts.batchOverride || null,
    purpose: 'Configuration used by ApplianceClinic. Changes here affect live behaviour. Only supported runtime settings are editable.',
    jev: jevView(jevLoaded, running.understand),
    diagnosticInference: {
      editable: true,
      source: 'Admin runtime configuration',
      store: storeNote(store.status) ? { status: store.status, note: storeNote(store.status) } : { status: store.status, note: null },
      version: cfg.version || 1,
      revision,
      updatedAt: cfg.updatedAt || null,
      updatedByEmail: cfg.updatedByEmail || null,
      // The batch test runner's temporary override is recorded in this same history (start + restore,
      // system actor, requesting admin, run id). History before that change may be missing batch writes.
      unauditedWriteNote: 'Batch test runs that need different COMPOSE routing record their temporary change and the exact restore here (actor system:batch-runner, with the requesting admin and run id). Batch writes made before this was introduced were not recorded and also reset this history.',
      history: historyView(cfg.history),
      settings: inventory,
      propagation: {
        ttlMs: PROPAGATION_TTL_MS,
        maxMs: COMPOSE_PROPAGATION_MAX_MS,
        note: 'New diagnoses use a saved COMPOSE change within about 2 minutes (each warm Part Finder instance caches the configuration and the provider for up to 60 s each). In-flight turns keep the provider they already loaded.',
      },
      understand,
      compose,
      local: {
        enabled: cfg.local.enabled === true,
        model: cfg.local.model || null,
        usesDeployedEndpoint: !cfg.local.endpoint,
        endpointOverrideSet: Boolean(cfg.local.endpoint),
      },
      frontier: {
        enabled: cfg.frontier.enabled === true,
        provider: 'openai',
        model: cfg.frontier.model || null,
        credential: keyConfigured ? 'configured' : 'missing',
        credentialUpdatedAt: keyMeta.updatedAt || null,
        credentialUpdatedByEmail: keyMeta.updatedByEmail || null,
        credentialHistory: (keyMeta.history || []).slice(0, HISTORY_VIEW),
        usedBy: 'COMPOSE when routed to OpenAI (currently ' + (cfg.routing.compose === 'frontier' ? 'YES — live customer replies' : 'not routed') + '), Test → Batch frontier experiments and the Full Quality Review reviewer.',
      },
      setup,
    },
    runtimeStatus: {
      editable: false,
      canonical: opts.canonical || null,
      canonicalNote: 'Canonical conversation mode is deployment configuration (CANONICAL_MODE / CANONICAL_CONTROL_JOURNEYS on the API). It is not editable in Admin and changes only with a deployment.',
    },
    productionReview: {
      editable: false,
      source: 'Deployment environment',
      transcriptReview: {
        editable: false,
        source: 'Deployment environment',
        managedAt: 'deployment',
        enabled: review.enabled === true,
        provider: review.provider || null,
        providerLabel: review.provider ? providerLabel(review.provider) : 'Not set',
        model: review.model || null,
        modelLabel: review.model || (review.provider === 'lmstudio' ? 'Model managed by LM Studio' : 'Not set'),
        customEndpoint: Boolean(review.url),
        maxPerRun: review.maxPerRun,
      },
      qualityReviewer: {
        editable: false,
        source: 'Deployment environment',
        managedAt: 'deployment',
        note: 'Used only for Test ApplianceClinic Full Quality Review. Not the GOLD harness.',
        provider: 'openai',
        providerLabel: 'OpenAI',
        model: setup.judge.model || null,
        modelLabel: setup.judge.modelLabel,
        credential: keyConfigured ? 'configured' : 'missing',
      },
    },
    transcripts: {
      editable: false,
      source: 'Deployment environment',
      managedAt: 'deployment',
      managedIn: 'Transcripts',
      retentionDays: policy.retentionDays,
      inactiveAfterMinutes: policy.inactiveAfterMinutes,
      ttlAttribute: policy.ttlAttribute,
      summary: policy.summary,
      stored: policy.stored,
      notStored: policy.notStored,
    },
    conversation: {
      editable: false,
      source: 'Shipped application configuration',
      managedAt: 'code',
      windowTurns: CONVERSATION_WINDOW,
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
      coldStart: 'A cold Part Finder process reads configuration on first request, then caches it for about one minute.',
      lastGood: 'If the configuration store is missing or unreadable, Part Finder uses its deployed local default rather than failing closed on every request.',
    },
  };
}

async function saveInferencePatch(opts) {
  opts = opts || {};
  const parsed = parseInferencePatch(opts.body);
  if (!parsed.ok) return parsed;
  const load = opts.loadConfigWithStatus || aiConfig.loadConfigWithStatus.bind(aiConfig);
  const keyFn = opts.isKeyConfigured || aiConfig.isKeyConfigured.bind(aiConfig);
  const save = opts.saveConfig || aiConfig.saveConfig.bind(aiConfig);
  const [store, keyConfigured] = await Promise.all([load(), keyFn()]);
  if (store.status === 'unavailable') {
    return { ok: false, status: 503, error: 'Configuration store is unavailable' };
  }
  const prev = store.cfg;
  const currentRevision = configRevision(prev);
  const stale = parsed.expectedVersion !== (prev.version || 1)
    || (parsed.expectedRevision && parsed.expectedRevision !== currentRevision);
  if (stale) {
    return {
      ok: false,
      status: 409,
      code: 'conflict',
      error: 'Settings changed since you opened this page. Reload to review the current values, then apply your change again.',
      currentVersion: prev.version || 1,
      currentRevision,
    };
  }
  // A batch run that owns live routing (or an unresolved restore conflict) blocks inference writes:
  // the live document is temporary batch state, and the batch restores the exact pre-run document.
  const bo = opts.getBatchOverride ? await opts.getBatchOverride() : null;
  if (bo && (bo.active || bo.blocked)) {
    return {
      ok: false, status: 409, code: 'batch_override_active',
      error: bo.blocked
        ? 'Batch run ' + bo.runId + ' could not safely restore live AI routing. Resolve it in Test → Batch before changing diagnostic inference.'
        : 'Batch run ' + bo.runId + ' currently owns live AI routing (temporary override since ' + (bo.appliedAt || bo.acquiredAt) + '). Diagnostic inference changes are blocked until it finishes and the exact pre-run configuration is restored.',
      currentRevision,
    };
  }
  const proposed = applyInferencePatch(prev, parsed.patch);
  const changes = diffConfigs(prev, proposed);
  // UNDERSTAND is TypeSafe Jev: the legacy routing.understand field has no customer effect, but a
  // frontier value without a key would still break COMPOSE resolution in Part Finder. Not editable here.
  if (changes.some((c) => c.field === 'routing.understand')) {
    return { ok: false, status: 400, error: 'UNDERSTAND is TypeSafe Jev. The legacy UNDERSTAND routing value cannot be changed here.', details: ['routing.understand'] };
  }
  if (!changes.length) {
    const view = await buildView(Object.assign({}, opts, { loadConfigWithStatus: async () => store, isKeyConfigured: async () => keyConfigured }));
    return { ok: true, status: 200, view, apply: { changed: [], written: false, note: 'No changes — nothing was written.' } };
  }
  const { ok, errors } = aiConfig.validateActivation(proposed, keyConfigured);
  if (!ok) return { ok: false, status: 400, error: 'Invalid AI configuration', details: errors };
  const impact = liveImpact(changes, proposed);
  if (impact.length && !parsed.note) {
    return { ok: false, status: 400, code: 'reason_required', error: 'A change reason is required for changes that alter live customer diagnosis.', details: ['note'] };
  }
  const next = aiConfig.withHistory(prev, proposed, opts.byEmail || 'admin', {
    note: parsed.note, changes, fromRevision: currentRevision,
  });
  try {
    await save(next);
  } catch (e) {
    return { ok: false, status: 503, code: 'store_failed', error: 'The configuration store did not accept the change. Nothing was applied — reload to confirm the current values.' };
  }
  // Read back what is actually stored. Secrets Manager has no conditional put, so this is how a
  // concurrent writer (another admin, or the batch test runner) is detected after the fact. Its reads
  // are also eventually consistent, so the shared rule (config-readback.js, the same one the batch
  // routing override uses) re-reads only while the exact PRIOR revision is still shown.
  const expectRev = configRevision(next);
  const rb = await readBackAfterWrite(Object.assign({
    read: async () => { const r = await load(); return r && r.status === 'ok' ? r.cfg : null; },
    revisionOf: configRevision, expectedRevision: expectRev, priorRevision: currentRevision,
  }, opts.readBack || {}));
  if (rb.status === 'conflict') {
    return {
      ok: false, status: 409, code: 'concurrent_write',
      error: 'Another change was written at the same time. Reload to see which configuration is now stored before doing anything else.',
      currentRevision: rb.revision,
    };
  }
  const verified = rb.status === 'verified';
  const effective = verified ? { cfg: rb.doc, status: 'ok' } : { cfg: next, status: 'ok' };
  const view = await buildView(Object.assign({}, opts, {
    loadConfigWithStatus: async () => effective,
    isKeyConfigured: async () => keyConfigured,
  }));
  return {
    ok: true, status: 200, view,
    apply: {
      changed: changes, written: true, verified, liveImpact: impact.length > 0,
      // verified | not_visible (store accepted the write; reads kept showing the previous version for
      // the whole bounded window) | read_failed (the store could not be read back). Never a 409.
      verification: rb.status,
      ...(verified ? {} : { verificationNote: rb.status === 'not_visible'
        ? 'The store accepted the change, but reads still returned the previous version for ' + rb.reads + ' attempts. Reload Settings to confirm what is stored before changing anything else.'
        : 'The store accepted the change, but it could not be read back to confirm it. Reload Settings to confirm what is stored.' }),
      revision: expectRev, version: next.version,
      propagation: 'Stored. Each warm Part Finder instance picks this up within about ' + Math.round(COMPOSE_PROPAGATION_MAX_MS / 60000) + ' minutes (cached twice for up to 60 s); the running value below updates after that.',
    },
  };
}

async function saveJevPatch(opts) {
  opts = opts || {};
  const parsed = parseJevPatch(opts.body);
  if (!parsed.ok) return parsed;
  const loadJev = opts.loadJevWithStatus || aiConfig.loadJevWithStatus.bind(aiConfig);
  const saveJev = opts.saveJevStored || aiConfig.saveJevStored.bind(aiConfig);
  const loaded = await loadJev();
  if (loaded.status === 'unavailable') {
    return { ok: false, status: 503, error: 'Jev configuration store is unavailable' };
  }
  const prevVersion = (loaded.public && loaded.public.version) || 1;
  if (parsed.expectedVersion !== prevVersion) {
    return {
      ok: false,
      status: 409,
      error: 'Settings were changed since this page was loaded. Refresh and review before saving.',
      currentVersion: prevVersion,
    };
  }
  const next = applyJevPatch(loaded.stored, parsed.patch, opts.byEmail || 'admin', parsed.note);
  if (!next.accountId || !next.apiToken) {
    return {
      ok: false,
      status: 400,
      error: 'Cloudflare Account ID and API token are required to configure Jev.',
    };
  }
  const changed = next._changed;
  delete next._changed;
  if (loaded.stored && !changed) {
    const view = await buildView(Object.assign({}, opts, { loadJevWithStatus: async () => loaded }));
    return { ok: true, status: 200, view, apply: { written: false, note: 'No changes — nothing was written.' } };
  }
  // Jev powers live UNDERSTAND for every customer turn: a reason is required for any change.
  if (!parsed.note) {
    return { ok: false, status: 400, code: 'reason_required', error: 'A change reason is required: Jev UNDERSTAND interprets every live customer message.', details: ['note'] };
  }
  try {
    await saveJev(next);
  } catch (e) {
    return { ok: false, status: 503, code: 'store_failed', error: 'The Jev configuration store did not accept the change. Nothing was applied.' };
  }
  // Same read-back rule as diagnostic inference (config-readback.js); Jev's identity is its version.
  const rb = await readBackAfterWrite(Object.assign({
    read: async () => { const r = await loadJev(); return r && r.status === 'ok' ? r : null; },
    revisionOf: (r) => String((r.public && r.public.version) || 1),
    expectedRevision: String(next.version), priorRevision: String(prevVersion),
  }, opts.readBack || {}));
  if (rb.status === 'conflict') {
    return { ok: false, status: 409, code: 'concurrent_write', error: 'Another Jev change was written at the same time. Reload to see what is now stored.' };
  }
  const verified = rb.status === 'verified';
  const effective = verified ? rb.doc : { status: 'ok', stored: next, public: aiConfig.toJevPublic(next) };
  const view = await buildView(Object.assign({}, opts, { loadJevWithStatus: async () => effective }));
  return {
    ok: true, status: 200, view,
    apply: { written: true, verified, verification: rb.status, version: next.version, propagation: 'Stored. Each warm Part Finder instance uses it within about 1 minute.' },
  };
}

async function testJevConnection(opts) {
  opts = opts || {};
  const credsFn = opts.getJevCredentials || aiConfig.getJevCredentials.bind(aiConfig);
  const probe = opts.probeJev || aiConfig.probeJev.bind(aiConfig);
  const creds = await credsFn();
  if (!creds) {
    return { status: 'FAILED', connected: false, model: null, latencyMs: null, errorCategory: 'CONFIG' };
  }
  return probe({
    accountId: creds.accountId,
    apiToken: creds.apiToken,
    gatewayId: creds.gatewayId,
    fetch: opts.fetch,
    timeoutMs: opts.timeoutMs || 12000,
  });
}

module.exports = {
  PROPAGATION_TTL_MS,
  COMPOSE_PROPAGATION_MAX_MS,
  JEV_PROPAGATION_MAX_MS,
  CONVERSATION_WINDOW,
  configRevision,
  diffConfigs,
  liveImpact,
  validEndpoint,
  validModel,
  settingsInventory,
  historyView,
  compareStage,
  parseInferencePatch,
  applyInferencePatch,
  parseJevPatch,
  applyJevPatch,
  parseRunningStage,
  probePartFinderModels,
  buildView,
  saveInferencePatch,
  saveJevPatch,
  testJevConnection,
  providerLabel,
};
