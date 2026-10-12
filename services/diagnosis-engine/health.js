'use strict';
/**
 * Read-only diagnosis engine health.
 *
 * Reports the canonical journey registry, the media mappings, and whether UNDERSTAND (Jev) / COMPOSE routing can be
 * resolved. Does not diagnose, call a model, mutate mappings, or return secrets.
 */

const { resolveProvidersFromAdminConfig } = require('./inference.js');
const mediaEffective = require('./media-effective.js');

const SERVICE = 'diagnosis-engine';
const VERSION = '1';

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

function describeModels(opts) {
  const note = 'UNDERSTAND is TypeSafe Jev. COMPOSE is a separate generative provider. Inference was not tested.';
  const blank = {
    understand: { configured: false, provider: null, model: null },
    compose: { configured: false, provider: null, model: null },
    inferenceTested: false,
    note,
  };
  const admin = (opts && opts.admin) || { config: null, openaiKey: null, jevConfigured: false };
  const understand = admin.jevConfigured
    ? { configured: true, provider: 'jev', model: 'typesafe/jev' }
    : { configured: false, provider: null, model: null };
  try {
    const resolve = (opts && opts.resolveProvidersFromAdminConfig) || resolveProvidersFromAdminConfig;
    const env = (opts && opts.env) || process.env;
    const noInfer = {
      request() { return Promise.reject(new Error('health-does-not-infer')); },
      stream() { return Promise.reject(new Error('health-does-not-infer')); },
    };
    const providers = resolve(admin.config, admin.openaiKey, env, { transport: noInfer });
    function stage(p) {
      if (!p) return { configured: false, provider: null, model: null };
      return {
        configured: true,
        provider: p.name || null,
        model: p.model || null,
      };
    }
    return {
      understand,
      compose: stage(providers.compose),
      inferenceTested: false,
      note,
    };
  } catch {
    return {
      understand,
      compose: blank.compose,
      inferenceTested: false,
      note,
    };
  }
}

function overall(canonical, models, media) {
  const issues = [];
  if (!canonical.journeys) issues.push('No canonical journey is registered');
  if (!(models.understand && models.understand.configured) || !(models.compose && models.compose.configured)) {
    issues.push('UNDERSTAND or COMPOSE is not configured');
  }
  if (!media.baselineLoaded) issues.push('Media baseline mappings are not loaded');
  if (media.overlayState === 'unavailable') {
    issues.push('Media overlay store could not be read; shipped baseline is in use');
  }
  if (issues.length) {
    return { status: 'degraded', health: 'degraded', healthReason: issues.join('. ') };
  }
  return { status: 'ok', health: 'healthy', healthReason: 'The diagnosis engine is running; journeys, models and media are available' };
}

async function build(deps) {
  deps = deps || {};
  const describeBaseline = deps.describeMediaBaseline || (() => ({ loaded: false, identityCount: 0 }));
  const baseline = describeBaseline() || {};
  const canonical = { journeys: Object.keys(require('./canonical-runtime.js').PACKS || {}).length };

  let admin = { config: null, openaiKey: null, jevConfigured: false };
  if (typeof deps.loadAdminInference === 'function') {
    try { admin = await deps.loadAdminInference(deps.adminOpts || {}); } catch { admin = { config: null, openaiKey: null, jevConfigured: false }; }
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

  const head = overall(canonical, models, media);
  return {
    status: head.status,
    health: head.health,
    healthReason: head.healthReason,
    service: SERVICE,
    version: VERSION,
    canonical,
    models: {
      understand: pick(models.understand, STAGE_FIELDS),
      compose: pick(models.compose, STAGE_FIELDS),
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
    canonical: { journeys: 0 },
    models: {
      understand: { configured: false, provider: null, model: null },
      compose: { configured: false, provider: null, model: null },
      inferenceTested: false,
      note: 'Configured means routing and model identifiers are present. Inference was not tested.',
    },
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
  STAGE_FIELDS,
  MEDIA_FIELDS,
  isHealthPath,
  httpMeta,
  handle,
  build,
  describeModels,
  degradedFromError,
};
