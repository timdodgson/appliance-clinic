'use strict';
/**
 * Read-only Part Finder runtime health.
 *
 * Reports already-loaded knowledge/index/media state and whether UNDERSTAND /
 * COMPOSE routing can be resolved. Does not diagnose, retrieve for a query,
 * call an LLM, mutate mappings, or return secrets.
 */

const { resolveProvidersFromAdminConfig } = require('./inference.js');
const mediaEffective = require('./media-effective.js');

const SERVICE = 'part-finder';
const VERSION = '1';

const KNOWLEDGE_FIELDS = ['loaded', 'records', 'faultIds', 'families', 'version'];
const RAG_FIELDS = ['loaded', 'indexedRecords', 'indexVersion', 'embeddingModel', 'dims', 'builtAt', 'mismatch'];
const STAGE_FIELDS = ['configured', 'provider', 'model'];
const KNOWLEDGE_OVERLAY_FIELDS = ['state', 'version', 'updatedAt', 'docs', 'archived'];
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

function overall(knowledge, rag, models, media, knowledgeOverlay) {
  const issues = [];
  if (!knowledge.loaded) issues.push('Knowledge index is not loaded');
  if (!rag.loaded) issues.push('RAG index is not loaded');
  if (knowledge.mismatch || rag.mismatch) issues.push('Loaded document count and index count differ');
  if (!(models.understand && models.understand.configured) || !(models.compose && models.compose.configured)) {
    issues.push('UNDERSTAND or COMPOSE is not configured');
  }
  if (!media.baselineLoaded) issues.push('Media baseline mappings are not loaded');
  if (media.overlayState === 'unavailable') {
    issues.push('Media overlay store could not be read; shipped baseline is in use');
  }
  if (knowledgeOverlay && knowledgeOverlay.state === 'unavailable') {
    issues.push('Published knowledge overlay could not be read; last good knowledge is in use');
  }
  if (issues.length) {
    return { status: 'degraded', health: 'degraded', healthReason: issues.join('. ') };
  }
  return {
    status: 'ok',
    health: 'healthy',
    healthReason: 'Part Finder is running and essential diagnostic artifacts are loaded',
  };
}

async function build(deps) {
  deps = deps || {};
  const describeIndex = deps.describeIndex || (() => ({
    loaded: false, records: 0, faultIds: 0, families: 0, version: null,
    indexedRecords: 0, indexVersion: null, embeddingModel: null, dims: null, builtAt: null, mismatch: false,
  }));
  const describeBaseline = deps.describeMediaBaseline || (() => ({ loaded: false, identityCount: 0 }));
  // Load the published Admin knowledge overlay first so the counts below describe what diagnosis uses.
  if (typeof deps.ensureKnowledgeOverlay === 'function') {
    try { await deps.ensureKnowledgeOverlay(); } catch { /* recorded on the overlay cache */ }
  }
  const ko = (typeof deps.getKnowledgeOverlayCache === 'function' ? deps.getKnowledgeOverlayCache() : null)
    || { state: 'none', version: 0, updatedAt: null, docs: 0, archived: 0 };
  const index = describeIndex() || {};
  const baseline = describeBaseline() || {};

  const knowledge = {
    loaded: !!index.loaded,
    records: index.records != null ? index.records : null,
    faultIds: index.faultIds != null ? index.faultIds : null,
    families: index.families != null ? index.families : null,
    version: index.version || null,
  };
  const rag = {
    loaded: !!index.loaded,
    indexedRecords: index.indexedRecords != null ? index.indexedRecords : knowledge.records,
    indexVersion: index.indexVersion || index.version || null,
    embeddingModel: index.embeddingModel || null,
    dims: index.dims != null ? index.dims : null,
    builtAt: index.builtAt || null,
    mismatch: !!index.mismatch,
  };

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

  const head = overall(knowledge, rag, models, media, ko);
  return {
    status: head.status,
    health: head.health,
    healthReason: head.healthReason,
    service: SERVICE,
    version: VERSION,
    knowledge: pick(knowledge, KNOWLEDGE_FIELDS),
    rag: pick(rag, RAG_FIELDS),
    models: {
      understand: pick(models.understand, STAGE_FIELDS),
      compose: pick(models.compose, STAGE_FIELDS),
      inferenceTested: false,
      note: models.note,
    },
    media: pick(media, MEDIA_FIELDS),
    knowledgeOverlay: pick(ko, KNOWLEDGE_OVERLAY_FIELDS),
  };
}

function degradedFromError() {
  return {
    status: 'degraded',
    health: 'degraded',
    healthReason: 'Health collector hit an unexpected error',
    service: SERVICE,
    version: VERSION,
    knowledge: { loaded: false, records: null, faultIds: null, families: null, version: null },
    rag: { loaded: false, indexedRecords: null, indexVersion: null, embeddingModel: null, dims: null, builtAt: null, mismatch: false },
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
    knowledgeOverlay: { state: 'unavailable', version: 0, updatedAt: null, docs: 0, archived: 0 },
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
  KNOWLEDGE_FIELDS,
  RAG_FIELDS,
  STAGE_FIELDS,
  MEDIA_FIELDS,
  KNOWLEDGE_OVERLAY_FIELDS,
  isHealthPath,
  httpMeta,
  handle,
  build,
  describeModels,
  degradedFromError,
};
