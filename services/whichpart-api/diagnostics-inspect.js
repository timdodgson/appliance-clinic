'use strict';
const { engineGetHeaders } = require('./engine-signature.js');
/**
 * Read-only Diagnostics snapshot for the ApplianceClinic admin console.
 *
 * Builds a field-whitelisted view of what is deployed and whether important
 * pieces are reachable. Does not mutate diagnosis, routing, prompts, indexes,
 * media mappings, or configuration. Never returns process.env or secrets.
 */

const SECRET_KEY = /token|secret|password|api[_-]?key|credential|authorization|bearer|cookie/i;
const SECRET_VALUE = /sk-[A-Za-z0-9]{8,}|AKIA[0-9A-Z]{8,}|Bearer\s+[A-Za-z0-9._~+/-]+=*/i;

const MCP_FIELDS = ['status', 'service', 'version', 'datasetVersion', 'mappingCount', 'baselineMappingCount', 'uniqueLookupCount', 'effectiveActiveCount', 'datasetV1Hash', 'enrichmentV1Hash', 'overlay'];
const ENGINE_SERVICE = 'diagnosis-engine';
const ENGINE_FIELDS = ['status', 'health', 'healthReason', 'service', 'version', 'diagnosis', 'models', 'media'];
const ENGINE_DIAGNOSIS_FIELDS = ['architecture'];
const ENGINE_STAGE_FIELDS = ['configured', 'provider', 'model'];
const ENGINE_MEDIA_FIELDS = [
  'resolverAvailable', 'baselineLoaded', 'overlayState', 'overlayUpdatedAt',
  'overlayVersion', 'effectiveMappingIdentities', 'cacheTtlSeconds',
];

const SYSTEM_PATH = {
  title: 'System path',
  summary: 'A customer request reaches WhichPart API, which runs one ac2 turn on the diagnosis engine: the advisor (Claude, with tools) inside the deterministic guardrail kernel (hazard word lists, banned advice, unverified identifiers, catalogue-only parts). The engine looks up error codes and parts itself. The browser never calls those services directly.',
  steps: [
    { id: 'customer', label: 'Customer request' },
    { id: 'whichpart-api', label: 'WhichPart API', role: 'Customer boundary / BFF: the session token and the conversation record' },
    { id: 'diagnosis-engine', label: 'Diagnosis engine', role: 'ac2 turn: advisor → guardrail kernel → response' },
    { id: 'customer-view', label: 'Customer view', role: 'Reply, media and parts' },
  ],
};

const ROUTING = {
  note: 'There is one diagnosis path (ac2, ADR 0023). Every turn goes to the diagnosis engine; this page does not change it.',
  paths: [
    { cue: 'Every customer turn', destination: 'Diagnosis engine (ac2: the advisor inside the guardrail kernel; error-code and parts tools)' },
  ],
};

function iso(d) {
  try { return (d instanceof Date ? d : new Date(d)).toISOString(); } catch { return null; }
}

function hostOf(url) {
  if (!url) return null;
  try { return new URL(String(url)).host || null; } catch { return null; }
}

function isSecretKey(k) { return SECRET_KEY.test(String(k || '')); }

function scrubValue(v) {
  if (v == null) return v;
  if (typeof v === 'string') {
    if (SECRET_VALUE.test(v)) return '[redacted]';
    return v;
  }
  if (typeof v === 'number' || typeof v === 'boolean') return v;
  if (Array.isArray(v)) return v.map(scrubValue);
  if (typeof v === 'object') return pick(v, Object.keys(v));
  return null;
}

function pick(obj, keys) {
  const out = {};
  if (!obj || typeof obj !== 'object') return out;
  (keys || []).forEach((k) => {
    if (isSecretKey(k)) return;
    if (!Object.prototype.hasOwnProperty.call(obj, k)) return;
    const v = obj[k];
    if (v === undefined) return;
    out[k] = scrubValue(v);
  });
  return out;
}

function healthOf(status, reason) {
  const s = status === 'healthy' || status === 'degraded' || status === 'unavailable' || status === 'unknown'
    ? status : 'unknown';
  const labels = {
    healthy: 'Healthy',
    degraded: 'Degraded',
    unavailable: 'Unavailable',
    unknown: 'Unknown',
  };
  return { health: s, healthLabel: labels[s], healthReason: reason || defaultReason(s) };
}

function defaultReason(s) {
  if (s === 'healthy') return 'Probe succeeded';
  if (s === 'degraded') return 'Probe succeeded but dependency or state is incomplete';
  if (s === 'unavailable') return 'Probe failed';
  return 'No reliable health probe available';
}

function classifyProbe(probe, opts) {
  opts = opts || {};
  if (!probe || probe.skipped) {
    return healthOf('unknown', (probe && probe.skipReason) || 'No reliable health probe available');
  }
  if (probe.ok === false || probe.error) {
    const err = String(probe.error || '');
    if (err === 'timeout' || /aborted|abort|timeout/i.test(err)) {
      return healthOf('unavailable', 'Probe timed out');
    }
    if (probe.status) return healthOf('unavailable', 'Probe failed (HTTP ' + probe.status + ')');
    return healthOf('unavailable', err ? ('Probe failed: ' + err) : 'Probe failed');
  }
  if (!probe.json || typeof probe.json !== 'object' || Array.isArray(probe.json)) {
    return healthOf('degraded', 'Probe succeeded but the response was not usable JSON');
  }
  if (typeof opts.complete === 'function' && !opts.complete(probe.json)) {
    return healthOf('degraded', 'Probe succeeded but expected fields were missing');
  }
  return healthOf('healthy', 'Probe succeeded');
}

function pickEngine(json) {
  const raw = pick(json, ENGINE_FIELDS);
  if (raw.diagnosis && typeof raw.diagnosis === 'object') raw.diagnosis = pick(raw.diagnosis, ENGINE_DIAGNOSIS_FIELDS);
  if (raw.media && typeof raw.media === 'object') raw.media = pick(raw.media, ENGINE_MEDIA_FIELDS);
  if (raw.models && typeof raw.models === 'object') {
    raw.models = {
      reasoner: pick(raw.models.reasoner, ENGINE_STAGE_FIELDS),
      inferenceTested: raw.models.inferenceTested === true,
      note: typeof raw.models.note === 'string' ? raw.models.note : null,
    };
  }
  return raw;
}

function classifyEngineProbe(probe) {
  if (!probe || probe.skipped) {
    return healthOf('unknown', (probe && probe.skipReason) || 'No reliable health probe available');
  }
  if (probe.ok === false || probe.error) {
    return classifyProbe(probe);
  }
  if (!probe.json || typeof probe.json !== 'object' || Array.isArray(probe.json)) {
    return healthOf('degraded', 'Probe succeeded but the response was not usable JSON');
  }
  const j = probe.json;
  if (j.service !== ENGINE_SERVICE) {
    return healthOf('degraded', 'Probe succeeded but the response was not a diagnosis engine health payload');
  }
  if (j.status === 'degraded' || j.health === 'degraded') {
    return healthOf('degraded', j.healthReason || 'The diagnosis engine reported incomplete runtime state');
  }
  if (j.status === 'ok' || j.health === 'healthy') {
    return healthOf('healthy', j.healthReason || 'Probe succeeded');
  }
  return healthOf('degraded', 'Probe succeeded but expected health fields were missing');
}

async function timedProbe(url, timeoutMs, fetchImpl, headers) {
  if (!url) return { skipped: true, skipReason: 'No reliable health probe available' };
  const fetchFn = fetchImpl || fetch;
  const started = Date.now();
  const ctrl = new AbortController();
  const ms = timeoutMs || 5000;
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    const r = await fetchFn(url, { method: 'GET', signal: ctrl.signal, ...(headers ? { headers } : {}) });
    const text = await r.text();
    let json = null;
    try { json = JSON.parse(text); } catch { json = null; }
    return {
      ok: r.ok,
      status: r.status,
      json,
      latencyMs: Date.now() - started,
      probedAt: new Date().toISOString(),
    };
  } catch (e) {
    const msg = String(e && e.message || e);
    const timeout = /abort/i.test(msg);
    return {
      ok: false,
      error: timeout ? 'timeout' : msg,
      latencyMs: Date.now() - started,
      probedAt: new Date().toISOString(),
    };
  } finally {
    clearTimeout(timer);
  }
}

function overlayActive(state) {
  if (!state || typeof state !== 'object') return false;
  const n = Object.keys(state.identities || {}).length
    + Object.keys(state.byKnowledgeId || {}).length
    + Object.keys(state.byComponent || {}).length
    + Object.keys(state.detachedByKnowledgeId || {}).length
    + Object.keys(state.detachedByComponent || {}).length;
  return n > 0;
}

function overlaySummary(state) {
  const identities = Object.keys((state && state.identities) || {});
  const knowledgeKeys = Object.keys((state && state.byKnowledgeId) || {});
  const componentKeys = Object.keys((state && state.byComponent) || {});
  const detached = Object.keys((state && state.detachedByKnowledgeId) || {}).length
    + Object.keys((state && state.detachedByComponent) || {}).length;
  const present = overlayActive(state);
  return {
    present,
    label: present ? 'active' : 'none',
    identityCount: identities.length,
    knowledgeMappingKeys: knowledgeKeys.length,
    componentMappingKeys: componentKeys.length,
    detachedKeys: detached,
    updatedAt: (state && state.updatedAt) || null,
    version: (state && state.version) || null,
  };
}

function knowledgeRuntime(knowledgeInspect) {
  if (!knowledgeInspect || typeof knowledgeInspect.loadCorpus !== 'function') {
    return {
      ...healthOf('unknown', 'Knowledge artifacts were not available to inspect'),
      canonicalRecords: null,
      faultIds: null,
      families: null,
      docsVersion: null,
      index: null,
      mismatch: false,
      mismatchNote: null,
    };
  }
  const corpus = knowledgeInspect.loadCorpus();
  const docs = (corpus && corpus.docs) || [];
  const faultIds = new Set();
  const families = {};
  docs.forEach((d) => {
    if (d && d.faultId) faultIds.add(d.faultId);
    if (d && d.applianceFamily) families[d.applianceFamily] = true;
  });
  const index = corpus && corpus.indexMeta ? {
    version: corpus.indexMeta.version || null,
    embedModel: corpus.indexMeta.embedModel || null,
    dims: corpus.indexMeta.dims || null,
    builtAt: corpus.indexMeta.builtAt || null,
    count: corpus.indexMeta.count != null ? corpus.indexMeta.count : null,
  } : null;
  const indexedCount = index && index.count != null ? index.count : null;
  const mismatch = index != null && indexedCount != null && indexedCount !== docs.length;
  const loaded = healthOf(
    !index ? 'unknown' : (mismatch ? 'degraded' : 'healthy'),
    !index
      ? 'Index metadata was not found with the bundled artifacts'
      : (mismatch
        ? 'Canonical knowledge and the bundled knowledge index counts differ'
        : 'Bundled knowledge and index artifacts are loaded'),
  );
  return {
    ...loaded,
    canonicalRecords: docs.length,
    faultIds: faultIds.size,
    families: Object.keys(families).length,
    docsVersion: (corpus && corpus.docsVersion) || null,
    index,
    mismatch,
    mismatchNote: mismatch
      ? ('Canonical knowledge has ' + docs.length + ' records; the bundled knowledge index has ' + indexedCount + '.')
      : null,
  };
}

function mediaRuntime(overlayLoad, mediaInspect) {
  const failed = !!(overlayLoad && overlayLoad.ok === false);
  const state = (overlayLoad && overlayLoad.state) || null;
  const overlay = overlaySummary(state);
  let baselineTotal = null;
  let effectiveTotal = null;
  let catalogueVersion = null;
  try {
    if (mediaInspect && typeof mediaInspect.listMedia === 'function') {
      const baseline = mediaInspect.listMedia({});
      const effective = mediaInspect.listMedia({ overlay: state || undefined });
      baselineTotal = baseline && baseline.total != null ? baseline.total : null;
      effectiveTotal = effective && effective.total != null ? effective.total : null;
      catalogueVersion = (effective && effective.catalogueVersion) || (baseline && baseline.catalogueVersion) || null;
    }
  } catch { /* keep counts unknown */ }
  const health = failed
    ? healthOf('degraded', 'Overlay store could not be read; shipped baseline is in use')
    : healthOf('healthy', 'Effective media resolver is loaded');
  return {
    ...health,
    resolver: 'Effective mapping is shipped baseline plus optional S3 admin overlay',
    baselineLoaded: baselineTotal != null,
    baselineCount: baselineTotal,
    effectiveCount: effectiveTotal,
    catalogueVersion,
    overlay,
    cacheTtlMs: 10000,
    loadedAt: (overlayLoad && overlayLoad.loadedAt) || null,
    overlayUnavailable: failed,
  };
}

function modelsRuntime(setup) {
  if (!setup || setup.unavailable || !setup.advisor) {
    return { ...healthOf('unknown', 'Model configuration was not available to inspect'), advisor: null };
  }
  const s = setup.advisor;
  return {
    advisor: {
      provider: s.provider || null,
      providerLabel: s.providerLabel || null,
      model: s.model || null,
      modelLabel: s.modelLabel || (s.model ? s.model : 'Model not set'),
      credentialConfigured: Boolean(s.credentialConfigured),
    },
  };
}

function component(id, name, role, health, extras) {
  const x = extras || {};
  return {
    id,
    name,
    role,
    health: health.health,
    healthLabel: health.healthLabel,
    healthReason: health.healthReason,
    latencyMs: x.latencyMs != null ? x.latencyMs : null,
    probedAt: x.probedAt || null,
    version: x.version || { label: 'Version not exposed by runtime', value: null },
    facts: x.facts || [],
    links: x.links || [],
    technical: x.technical || null,
  };
}

function versionField(value, missingLabel) {
  if (value == null || value === '') {
    return { label: missingLabel || 'Version not exposed by runtime', value: null };
  }
  return { label: String(value), value: String(value) };
}

function buildSnapshot(input) {
  const now = iso((input && input.now) || new Date());
  const mcpProbe = (input && input.probes && input.probes.mcp) || { skipped: true, skipReason: 'No reliable health probe available' };
  const engProbe = (input && input.probes && input.probes.engine) || { skipped: true, skipReason: 'No reliable health probe available' };
  const knowledge = (input && input.knowledge) || knowledgeRuntime(null);
  const media = (input && input.media) || mediaRuntime({ ok: false }, null);
  const models = (input && input.models) || modelsRuntime(null);
  const runtimeIn = (input && input.runtime) || {};

  const mcpSafe = pick(mcpProbe.json, MCP_FIELDS);
  const mcpHealth = classifyProbe(mcpProbe, {
    complete: (j) => j && (j.status === 'ok' || j.mappingCount != null || j.service),
  });

  const apiComp = component(
    'whichpart-api',
    'WhichPart API',
    'Customer boundary. Accepts the browser request, holds the conversation\'s record and runs the ac2 turn on the diagnosis engine.',
    healthOf('healthy', 'This Diagnostics request was served by WhichPart API'),
    {
      probedAt: now,
      version: versionField('whichpart-api', 'Version not exposed by runtime'),
      facts: [
        { label: 'Role', value: 'Customer boundary / BFF' },
        { label: 'Conversation window', value: runtimeIn.maxConversationTurns != null ? String(runtimeIn.maxConversationTurns) + ' turns' : 'Version not exposed by runtime' },
      ],
      technical: {
        service: 'whichpart-api',
        host: runtimeIn.apiHost || null,
        note: 'Lambda version and code hash are not exposed by this runtime',
      },
    },
  );

  const engSafe = pickEngine(engProbe.json);
  const engHealthState = classifyEngineProbe(engProbe);

  const engFacts = [];
  if (engSafe.diagnosis && engSafe.diagnosis.architecture) {
    engFacts.push({ label: 'Architecture', value: String(engSafe.diagnosis.architecture) });
  } else if (!engProbe.skipped && engHealthState.health !== 'unavailable') {
    engFacts.push({ label: 'Architecture', value: 'Not reported' });
  }
  if (engSafe.models && engSafe.models.reasoner) {
    engFacts.push({ label: 'Advisor model', value: engSafe.models.reasoner.configured ? 'Configured' : 'Not configured' });
    if (engSafe.models.reasoner.provider) {
      engFacts.push({
        label: 'Advisor',
        value: engSafe.models.reasoner.provider + (engSafe.models.reasoner.model ? ' · ' + engSafe.models.reasoner.model : ''),
      });
    }
    engFacts.push({ label: 'Inference tested', value: engSafe.models.inferenceTested ? 'yes' : 'no' });
  }
  if (engSafe.media) {
    engFacts.push({
      label: 'Media resolver',
      value: engSafe.media.resolverAvailable ? 'Available' : 'not loaded',
    });
    if (engSafe.media.overlayState) {
      engFacts.push({ label: 'Overlay', value: engSafe.media.overlayState === 'none' ? 'none (shipped baseline)' : engSafe.media.overlayState });
    }
  }
  if (engProbe.skipped) {
    engFacts.push({ label: 'Reachability', value: 'No reliable health probe available' });
  }
  if (engProbe.latencyMs != null && !engProbe.skipped) {
    engFacts.push({ label: 'Last probe', value: String(engProbe.latencyMs) + ' ms' });
  }
  const engComp = component(
    'diagnosis-engine',
    'Diagnosis engine',
    'ac2 diagnosis: the advisor (Claude, with tools) inside the deterministic guardrail kernel (hazard word lists, banned advice, unverified identifiers, catalogue-only parts).',
    engHealthState,
    {
      latencyMs: engProbe.skipped ? null : engProbe.latencyMs,
      probedAt: engProbe.probedAt || null,
      version: versionField(engSafe.version),
      facts: engFacts,
      technical: {
        engineHost: runtimeIn.engineHost || null,
        probe: engProbe.skipped ? { available: false, reason: engProbe.skipReason || 'No reliable health probe available' } : {
          httpStatus: engProbe.status != null ? engProbe.status : null,
          latencyMs: engProbe.latencyMs != null ? engProbe.latencyMs : null,
          probedAt: engProbe.probedAt || null,
          error: engProbe.error || null,
        },
        reported: engSafe,
        note: 'GET /health on the diagnosis engine (ENGINE_URL), the function every customer turn calls.',
      },
    },
  );

  const mcpFacts = [
    { label: 'Service', value: mcpSafe.service || 'error-code-mcp' },
    { label: 'Reported version', value: mcpSafe.version || 'Version not exposed by runtime' },
    { label: 'Catalogue version', value: mcpSafe.datasetVersion || 'Version not exposed by runtime' },
    { label: 'Supported codes', value: mcpSafe.mappingCount != null ? String(mcpSafe.mappingCount) : 'Not reported by this probe' },
  ];
  if (mcpProbe.latencyMs != null && !mcpProbe.skipped) {
    mcpFacts.push({ label: 'Last probe', value: String(mcpProbe.latencyMs) + ' ms' });
  }
  const mcpComp = component(
    'error-code-mcp',
    'Error Code MCP',
    'Error-code catalogue service behind the Admin error-code editor; the diagnosis engine looks codes up here (MCP).',
    mcpHealth,
    {
      latencyMs: mcpProbe.skipped ? null : mcpProbe.latencyMs,
      probedAt: mcpProbe.probedAt || null,
      version: versionField(mcpSafe.version || mcpSafe.datasetVersion),
      facts: mcpFacts,
      links: [{ href: '#mcp', label: 'Open Error Codes' }],
      technical: {
        host: runtimeIn.mcpHealthHost || null,
        datasetV1Hash: mcpSafe.datasetV1Hash || null,
        enrichmentV1Hash: mcpSafe.enrichmentV1Hash || null,
        baselineMappingCount: mcpSafe.baselineMappingCount != null ? mcpSafe.baselineMappingCount : null,
        uniqueLookupCount: mcpSafe.uniqueLookupCount != null ? mcpSafe.uniqueLookupCount : null,
        effectiveActiveCount: mcpSafe.effectiveActiveCount != null ? mcpSafe.effectiveActiveCount : null,
        overlay: mcpSafe.overlay && typeof mcpSafe.overlay === 'object' ? {
          state: mcpSafe.overlay.state || null,
          present: Boolean(mcpSafe.overlay.present),
          records: mcpSafe.overlay.records != null ? mcpSafe.overlay.records : null,
          retired: mcpSafe.overlay.retired != null ? mcpSafe.overlay.retired : null,
          adminActive: mcpSafe.overlay.adminActive != null ? mcpSafe.overlay.adminActive : null,
          updatedAt: mcpSafe.overlay.updatedAt || null,
        } : null,
        probe: mcpProbe.skipped ? { available: false, reason: mcpProbe.skipReason || 'No reliable health probe available' } : {
          httpStatus: mcpProbe.status != null ? mcpProbe.status : null,
          latencyMs: mcpProbe.latencyMs != null ? mcpProbe.latencyMs : null,
          probedAt: mcpProbe.probedAt || null,
          error: mcpProbe.error || null,
        },
      },
    },
  );

  const mediaFacts = [
    { label: 'Resolver', value: 'Effective mapping (baseline + overlay)' },
    { label: 'Baseline', value: media.baselineLoaded ? ((media.baselineCount != null ? media.baselineCount + ' identities' : 'loaded')) : 'Baseline not loaded' },
    { label: 'Admin overlay', value: media.overlay && media.overlay.present ? 'active' : 'none' },
    { label: 'Cache TTL', value: media.cacheTtlMs ? (Math.round(media.cacheTtlMs / 1000) + ' seconds') : 'Version not exposed by runtime' },
    { label: 'Effective identities', value: media.effectiveCount != null ? String(media.effectiveCount) : 'Not reported' },
  ];
  if (media.overlay && media.overlay.updatedAt) {
    mediaFacts.push({ label: 'Overlay updated', value: media.overlay.updatedAt });
  }
  const mediaComp = component(
    'media-resolver',
    'Media resolver',
    'Resolves the help images and videos shown with a diagnosis from shipped baseline plus an optional S3 admin overlay.',
    { health: media.health, healthLabel: media.healthLabel, healthReason: media.healthReason },
    {
      probedAt: media.loadedAt || now,
      version: versionField(media.catalogueVersion),
      facts: mediaFacts,
      links: [{ href: '#media', label: 'Open Media' }],
      technical: {
        cacheTtlMs: media.cacheTtlMs,
        overlay: media.overlay,
        overlayUnavailable: !!media.overlayUnavailable,
        catalogueVersion: media.catalogueVersion,
        baselineCount: media.baselineCount,
        effectiveCount: media.effectiveCount,
      },
    },
  );

  const partsHealth = healthOf('unknown', 'No reliable health probe available for the parts catalogue');
  const partsComp = component(
    'parts-catalogue',
    'Parts catalogue',
    'Spares4Repairs product pages used when a diagnosis names replacement parts.',
    partsHealth,
    {
      version: versionField(null, 'Version not exposed by runtime'),
      facts: [
        { label: 'Product host', value: runtimeIn.s4rProductBaseHost || 'Not configured' },
        { label: 'Reachability', value: 'No reliable health probe available' },
      ],
      technical: { host: runtimeIn.s4rProductBaseHost || null },
    },
  );

  const lastSuccess = [];
  const lastFailed = [];
  [apiComp, engComp, mcpComp].forEach((c) => {
    if (c.health === 'healthy' && c.probedAt) lastSuccess.push({ id: c.id, name: c.name, at: c.probedAt, latencyMs: c.latencyMs });
    if (c.health === 'unavailable' && c.probedAt) lastFailed.push({ id: c.id, name: c.name, at: c.probedAt, latencyMs: c.latencyMs, reason: c.healthReason });
  });

  const runtime = {
    conversationWindowTurns: runtimeIn.maxConversationTurns != null ? runtimeIn.maxConversationTurns : null,
    mediaOverlayCacheTtlMs: 10000,
    supportedFamilies: Array.isArray(runtimeIn.families) ? runtimeIn.families.slice() : [],
    models: {
      advisor: models.advisor,
    },
    // The diagnosis architecture: ac2 (the advisor inside the guardrail kernel) is the only one; not configurable.
    diagnosis: { architecture: 'ac2', label: 'ac2 — the advisor inside the deterministic guardrail kernel (every turn)' },
    note: 'Read-only. Settings owns writable AI configuration. Secrets are not included.',
  };

  const technical = {
    generatedAt: now,
    identifiers: {
      whichpartApi: 'whichpart-api',
      mcpHealthHost: runtimeIn.mcpHealthHost || null,
      engineHost: runtimeIn.engineHost || null,
      partsCatalogueHost: runtimeIn.s4rProductBaseHost || null,
      knowledgeDocsVersion: knowledge.docsVersion || null,
      mediaCatalogueVersion: media.catalogueVersion || null,
      mcpDatasetV1Hash: mcpSafe.datasetV1Hash || null,
      mcpEnrichmentV1Hash: mcpSafe.enrichmentV1Hash || null,
    },
    probes: {
      engine: engComp.technical && engComp.technical.probe,
      mcp: mcpComp.technical && mcpComp.technical.probe,
    },
    models: models,
    notExposed: [
      'Lambda version aliases',
      'Lambda code hashes',
      'Bearer tokens',
      'API keys and credentials',
      'System prompts',
    ],
  };

  return {
    ok: true,
    purpose: 'Inspect the deployed ApplianceClinic diagnostic system.',
    generatedAt: now,
    readOnly: true,
    systemPath: SYSTEM_PATH,
    routing: ROUTING,
    components: [apiComp, engComp, mcpComp, mediaComp, partsComp],
    knowledge,
    media,
    mcp: {
      health: mcpComp.health,
      healthLabel: mcpComp.healthLabel,
      healthReason: mcpComp.healthReason,
      service: mcpSafe.service || null,
      version: mcpSafe.version || null,
      datasetVersion: mcpSafe.datasetVersion || null,
      mappingCount: mcpSafe.mappingCount != null ? mcpSafe.mappingCount : null,
      datasetV1Hash: mcpSafe.datasetV1Hash || null,
      enrichmentV1Hash: mcpSafe.enrichmentV1Hash || null,
      probedAt: mcpComp.probedAt,
      latencyMs: mcpComp.latencyMs,
    },
    models,
    runtime,
    technical,
    evidence: {
      lastSuccessfulProbes: lastSuccess,
      lastFailedProbes: lastFailed,
    },
    links: {
      testApplianceClinic: '#test',
      knowledge: '#knowledge',
      media: '#media',
      errorCodes: '#mcp',
    },
  };
}

function failureSnapshot(err, runtime) {
  const base = buildSnapshot({
    now: new Date(),
    probes: {
      engine: { skipped: true, skipReason: 'Diagnostics collector failed before probes completed' },
      mcp: { skipped: true, skipReason: 'Diagnostics collector failed before probes completed' },
    },
    knowledge: knowledgeRuntime(null),
    media: mediaRuntime({ ok: false, state: null }, null),
    models: modelsRuntime(null),
    runtime: runtime || {},
  });
  base.ok = true;
  base.collectorError = 'Diagnostics collector hit an unexpected error; partial information is shown.';
  if (err && err.message && !SECRET_VALUE.test(String(err.message))) {
    base.technical = Object.assign({}, base.technical, { collector: String(err.message).slice(0, 180) });
  }
  return base;
}

async function settled(promise) {
  try {
    return { ok: true, value: await promise };
  } catch (e) {
    return { ok: false, error: e };
  }
}

async function collect(deps) {
  deps = deps || {};
  const fetchImpl = deps.fetch || fetch;
  const timeoutMs = deps.timeoutMs || 5000;
  const runtime = deps.runtime || {};

  const mcpUrl = deps.mcpHealthUrl || '';
  const engUrl = deps.engineHealthUrl || '';

  const mcpP = mcpUrl
    ? settled(timedProbe(mcpUrl, timeoutMs, fetchImpl))
    : Promise.resolve({ ok: true, value: { skipped: true, skipReason: 'MCP health URL is not configured' } });
  const engP = engUrl
    ? settled(timedProbe(engUrl, timeoutMs, fetchImpl, engineGetHeaders(engUrl)))
    : Promise.resolve({ ok: true, value: { skipped: true, skipReason: 'Diagnosis engine health URL is not configured' } });
  const knP = settled(Promise.resolve().then(() => knowledgeRuntime(deps.knowledgeInspect)));
  const mediaP = settled((async () => {
    let overlayLoad = { ok: true, state: null, loadedAt: iso(new Date()) };
    try {
      const state = deps.loadOverlay ? await deps.loadOverlay() : null;
      overlayLoad = { ok: true, state: state || null, loadedAt: iso(new Date()) };
    } catch {
      overlayLoad = { ok: false, state: deps.emptyOverlay || null, loadedAt: iso(new Date()) };
    }
    return mediaRuntime(overlayLoad, deps.mediaInspect);
  })());
  const modelsP = settled((async () => {
    if (typeof deps.loadModels !== 'function') return modelsRuntime(null);
    return modelsRuntime(await deps.loadModels());
  })());

  const [mcp, eng, kn, media, models] = await Promise.all([mcpP, engP, knP, mediaP, modelsP]);

  return buildSnapshot({
    now: deps.now || new Date(),
    probes: {
      mcp: mcp.ok ? mcp.value : { ok: false, error: String(mcp.error && mcp.error.message || mcp.error || 'probe failed') },
      engine: eng.ok ? eng.value : { ok: false, error: String(eng.error && eng.error.message || eng.error || 'probe failed') },
    },
    knowledge: kn.ok ? kn.value : knowledgeRuntime(null),
    media: media.ok ? media.value : mediaRuntime({ ok: false, state: null }, null),
    models: models.ok ? models.value : modelsRuntime(null),
    runtime,
  });
}

module.exports = {
  SYSTEM_PATH,
  ROUTING,
  MCP_FIELDS,
  ENGINE_FIELDS,
  hostOf,
  pick,
  classifyProbe,
  classifyEngineProbe,
  pickEngine,
  timedProbe,
  overlayActive,
  overlaySummary,
  knowledgeRuntime,
  mediaRuntime,
  modelsRuntime,
  buildSnapshot,
  failureSnapshot,
  collect,
  healthOf,
};
