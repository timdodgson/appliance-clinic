'use strict';
/**
 * Read-only diagnosis engine health.
 *
 * Reports the diagnosis architecture (ac2: the LLM-led turn inside the deterministic guardrail kernel), whether the
 * reasoner's provider (the admin AI configuration's COMPOSE route) can be resolved, and the media mappings. Does not
 * diagnose, call a model, mutate mappings, or return secrets.
 */

const { resolveProvidersFromAdminConfig } = require('./inference.js');
const mediaEffective = require('./media-effective.js');

const SERVICE = 'diagnosis-engine';
const VERSION = '2';
const ARCHITECTURE = 'ac2';

const STAGE_FIELDS = ['configured', 'provider', 'model'];
const MEDIA_FIELDS = [
  'resolverAvailable', 'baselineLoaded', 'overlayState', 'overlayUpdatedAt',
  'overlayVersion', 'effectiveMappingIdentities', 'cacheTtlSeconds',
];

function pick(obj, keys) {
  const out = {};
  (keys || []).forEach((k) => {
    if (obj && Object.prototype.hasOwnProperty.call(obj, k)) out[k] = obj[k];
  });
  return out;
}

function httpMeta(event) {
  const rc = (event && event.requestContext && event.requestContext.http) || {};
  const method = String(rc.method || event.httpMethod || 'POST').toUpperCase();
  const path = event.rawPath || rc.path || event.path || '/';
  return { method, path: String(path) };
}

function isHealthPath(path) {
  const p = String(path || '').replace(/\/+$/, '') || '/';
  return p === '/health' || p.endsWith('/health');
}

function overlayStateOf(cache) {
  if (cache && cache.failed) return 'unavailable';
  if (cache && cache.overlayPresent) return 'active';
  return 'none';
}

const NOTE = 'One inference provider serves the ac2 reasoner and its claim extractor (the AI configuration\'s COMPOSE route). Inference was not tested.';
const NOT_CONFIGURED = { configured: false, provider: null, model: null };

function describeModels(opts) {
  const admin = (opts && opts.admin) || { config: null, openaiKey: null };
  try {
    const resolve = (opts && opts.resolveProvidersFromAdminConfig) || resolveProvidersFromAdminConfig;
    const env = (opts && opts.env) || process.env;
    const noInfer = {
      request() { return Promise.reject(new Error('health-does-not-infer')); },
      stream() { return Promise.reject(new Error('health-does-not-infer')); },
    };
    const p = resolve(admin.config, admin.openaiKey, env, { transport: noInfer }).compose;
    return {
      reasoner: p ? { configured: true, provider: p.name || null, model: p.model || null } : { ...NOT_CONFIGURED },
      inferenceTested: false,
      note: NOTE,
    };
  } catch {
    return { reasoner: { ...NOT_CONFIGURED }, inferenceTested: false, note: NOTE };
  }
}

function overall(models, media) {
  const issues = [];
  if (!(models.reasoner && models.reasoner.configured)) issues.push('The reasoner\'s inference provider is not configured');
  if (!media.baselineLoaded) issues.push('Media baseline mappings are not loaded');
  if (media.overlayState === 'unavailable') {
    issues.push('Media overlay store could not be read; shipped baseline is in use');
  }
  if (issues.length) {
    return { status: 'degraded', health: 'degraded', healthReason: issues.join('. ') };
  }
  return { status: 'ok', health: 'healthy', healthReason: 'The diagnosis engine is running; the reasoner provider and media are available' };
}

async function build(deps) {
  deps = deps || {};
  const describeBaseline = deps.describeMediaBaseline || (() => ({ loaded: false, identityCount: 0 }));
  const baseline = describeBaseline() || {};

  let admin = { config: null, openaiKey: null };
  if (typeof deps.loadAdminInference === 'function') {
    try { admin = await deps.loadAdminInference(deps.adminOpts || {}); } catch { admin = { config: null, openaiKey: null }; }
  }
  const models = describeModels({
    admin,
    env: deps.env,
    resolveProvidersFromAdminConfig: deps.resolveProvidersFromAdminConfig,
  });

  if (typeof deps.ensureMediaOverlay === 'function') {
    try { await deps.ensureMediaOverlay(deps.mediaOpts || {}); } catch { /* overlay failure is recorded on the cache */ }
  }
  const cache = (typeof deps.getMediaOverlayCache === 'function' ? deps.getMediaOverlayCache() : null) || {};
  let effectiveCount = baseline.identityCount != null ? baseline.identityCount : null;
  if (typeof deps.getEffectiveMediaJoin === 'function' && typeof deps.countJoinIdentities === 'function') {
    try { effectiveCount = deps.countJoinIdentities(deps.getEffectiveMediaJoin()); } catch { /* keep baseline count */ }
  }
  const media = {
    resolverAvailable: !!baseline.loaded,
    baselineLoaded: !!baseline.loaded,
    overlayState: overlayStateOf(cache),
    overlayUpdatedAt: cache.updatedAt || null,
    overlayVersion: cache.version != null ? cache.version : null,
    effectiveMappingIdentities: effectiveCount,
    cacheTtlSeconds: Math.round(((deps.overlayTtlMs != null ? deps.overlayTtlMs : mediaEffective.OVERLAY_TTL_MS) || 10000) / 1000),
  };

  const head = overall(models, media);
  return {
    status: head.status,
    health: head.health,
    healthReason: head.healthReason,
    service: SERVICE,
    version: VERSION,
    diagnosis: { architecture: ARCHITECTURE },
    models: {
      reasoner: pick(models.reasoner, STAGE_FIELDS),
      inferenceTested: false,
      note: models.note,
    },
    media: pick(media, MEDIA_FIELDS),
  };
}

function degradedFromError() {
  return {
    status: 'degraded',
    health: 'degraded',
    healthReason: 'Health collector hit an unexpected error',
    service: SERVICE,
    version: VERSION,
    diagnosis: { architecture: ARCHITECTURE },
    models: { reasoner: { ...NOT_CONFIGURED }, inferenceTested: false, note: NOTE },
    media: {
      resolverAvailable: false, baselineLoaded: false, overlayState: 'unavailable',
      overlayUpdatedAt: null, overlayVersion: null, effectiveMappingIdentities: null, cacheTtlSeconds: 10,
    },
  };
}

async function handle(event, deps) {
  const { method, path } = httpMeta(event || {});
  if (!isHealthPath(path)) return null;
  if (method !== 'GET') return { status: 405, body: { error: 'GET only' } };
  try {
    return { status: 200, body: await build(deps) };
  } catch {
    return { status: 200, body: degradedFromError() };
  }
}

module.exports = {
  SERVICE,
  VERSION,
  ARCHITECTURE,
  STAGE_FIELDS,
  MEDIA_FIELDS,
  isHealthPath,
  httpMeta,
  handle,
  build,
  describeModels,
  degradedFromError,
};
