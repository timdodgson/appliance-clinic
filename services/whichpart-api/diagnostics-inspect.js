'use strict';
/**
 * Read-only Diagnostics snapshot for the ApplianceClinic admin console.
 *
 * Builds a field-whitelisted view of what is deployed and whether important
 * pieces are reachable. Does not mutate diagnosis, routing, prompts, indexes,
 * media mappings, or configuration. Never returns process.env or secrets.
 */

const SECRET_KEY = /token|secret|password|api[_-]?key|credential|authorization|bearer|cookie/i;
const SECRET_VALUE = /sk-[A-Za-z0-9]{8,}|AKIA[0-9A-Z]{8,}|Bearer\s+[A-Za-z0-9._~+/-]+=*/i;

const ORCH_FIELDS = ['status', 'service', 'version', 'errorCodeMcp', 'diagnosticRag'];
const MCP_FIELDS = ['status', 'service', 'version', 'datasetVersion', 'mappingCount', 'baselineMappingCount', 'uniqueLookupCount', 'effectiveActiveCount', 'datasetV1Hash', 'enrichmentV1Hash', 'overlay'];
const PF_FIELDS = ['status', 'health', 'healthReason', 'service', 'version', 'knowledge', 'rag', 'models', 'media'];
const PF_KNOWLEDGE_FIELDS = ['loaded', 'records', 'faultIds', 'families', 'version'];
const PF_RAG_FIELDS = ['loaded', 'indexedRecords', 'indexVersion', 'embeddingModel', 'dims', 'builtAt', 'mismatch'];
const PF_STAGE_FIELDS = ['configured', 'provider', 'model'];
const PF_MEDIA_FIELDS = [
  'resolverAvailable', 'baselineLoaded', 'overlayState', 'overlayUpdatedAt',
  'overlayVersion', 'effectiveMappingIdentities', 'cacheTtlSeconds',
];

const SYSTEM_PATH = {
  title: 'System path',
  summary: 'A customer request reaches WhichPart API, which calls the orchestrator. The orchestrator sends error-code turns to Error Code MCP and symptom turns to Part Finder (UNDERSTAND, RAG, COMPOSE). The browser never calls those services directly.',
  steps: [
    { id: 'customer', label: 'Customer request' },
    { id: 'whichpart-api', label: 'WhichPart API', role: 'Customer boundary / BFF' },
    { id: 'orchestrator', label: 'Orchestrator', role: 'Routes the turn' },
    {
      id: 'routing',
      kind: 'branch',
      branches: [
        { when: 'Error-code identity or cue', then: 'Error Code MCP' },
        { when: 'Symptoms', then: 'Part Finder → RAG → Compose' },
        { when: 'Error code and symptoms', then: 'Error Code MCP and Part Finder together' },
      ],
    },
    { id: 'customer-view', label: 'Customer view', role: 'Reply, media and parts' },
  ],
};

const ROUTING = {
  note: 'High-level routing only. The orchestrator chooses the path from the customer turn; this page does not change it.',
  paths: [
    { cue: 'Error-code identity or cue', destination: 'Error Code MCP' },
    { cue: 'Symptoms', destination: 'Part Finder (UNDERSTAND → RAG → COMPOSE)' },
    { cue: 'Error code and symptoms', destination: 'Error Code MCP and Part Finder together' },
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

function pickPartFinder(json) {
  const raw = pick(json, PF_FIELDS);
  if (raw.knowledge && typeof raw.knowledge === 'object') raw.knowledge = pick(raw.knowledge, PF_KNOWLEDGE_FIELDS);
  if (raw.rag && typeof raw.rag === 'object') raw.rag = pick(raw.rag, PF_RAG_FIELDS);
  if (raw.media && typeof raw.media === 'object') raw.media = pick(raw.media, PF_MEDIA_FIELDS);
  if (raw.models && typeof raw.models === 'object') {
    raw.models = {
      understand: pick(raw.models.understand, PF_STAGE_FIELDS),
      compose: pick(raw.models.compose, PF_STAGE_FIELDS),
      inferenceTested: raw.models.inferenceTested === true,
      note: typeof raw.models.note === 'string' ? raw.models.note : null,
    };
  }
  return raw;
}

function classifyPartFinderProbe(probe) {
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
  if (j.service && j.service !== 'part-finder') {
    return healthOf('degraded', 'Probe succeeded but the response was not a Part Finder health payload');
  }
  if (j.status === 'degraded' || j.health === 'degraded') {
    return healthOf('degraded', j.healthReason || 'Part Finder reported incomplete runtime state');
  }
  if ((j.status === 'ok' || j.health === 'healthy') && j.service === 'part-finder') {
    return healthOf('healthy', j.healthReason || 'Probe succeeded');
  }
  if (j.service === 'part-finder') {
    return healthOf('degraded', 'Probe succeeded but expected health fields were missing');
  }
  return healthOf('degraded', 'Probe succeeded but the response was not a Part Finder health payload');
}

async function timedProbe(url, timeoutMs, fetchImpl) {
  if (!url) return { skipped: true, skipReason: 'No reliable health probe available' };
  const fetchFn = fetchImpl || fetch;
  const started = Date.now();
  const ctrl = new AbortController();
  const ms = timeoutMs || 5000;
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    const r = await fetchFn(url, { method: 'GET', signal: ctrl.signal });
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
        ? 'Canonical knowledge and the bundled RAG index counts differ'
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
      ? ('Canonical knowledge has ' + docs.length + ' records; the bundled RAG index has ' + indexedCount + '.')
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
  if (!setup || setup.unavailable) {
    return {
      ...healthOf('unknown', 'Model configuration was not available to inspect'),
      understand: null,
      compose: null,
      judge: null,
    };
  }
  function stage(s) {
    if (!s) return null;
    return {
      provider: s.provider || null,
      providerLabel: s.providerLabel || null,
      model: s.model || null,
      modelLabel: s.modelLabel || (s.model ? s.model : 'Version not exposed by runtime'),
    };
  }
  return {
    understand: stage(setup.understand),
    compose: stage(setup.compose),
    judge: setup.judge ? {
      provider: setup.judge.provider || null,
      providerLabel: setup.judge.providerLabel || null,
      model: setup.judge.model || null,
      modelLabel: setup.judge.modelLabel || null,
      configured: !!setup.judge.configured,
      note: 'Only used when Full Quality Review is selected. Not used for live customer diagnosis.',
    } : null,
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
  const orchProbe = (input && input.probes && input.probes.orchestrator) || { skipped: true, skipReason: 'No reliable health probe available' };
  const mcpProbe = (input && input.probes && input.probes.mcp) || { skipped: true, skipReason: 'No reliable health probe available' };
  const pfProbe = (input && input.probes && input.probes.partFinder) || { skipped: true, skipReason: 'No reliable health probe available' };
  const knowledge = (input && input.knowledge) || knowledgeRuntime(null);
  const media = (input && input.media) || mediaRuntime({ ok: false }, null);
  const models = (input && input.models) || modelsRuntime(null);
  const runtimeIn = (input && input.runtime) || {};

  const orchSafe = pick(orchProbe.json, ORCH_FIELDS);
  const mcpSafe = pick(mcpProbe.json, MCP_FIELDS);
  const orchHealth = classifyProbe(orchProbe, {
    complete: (j) => j && (j.status === 'ok' || j.service),
  });
  const mcpHealth = classifyProbe(mcpProbe, {
    complete: (j) => j && (j.status === 'ok' || j.mappingCount != null || j.service),
  });

  const partFinderConfig = orchSafe.diagnosticRag || null;
  const mcpConfigured = orchSafe.errorCodeMcp || null;

  const apiComp = component(
    'whichpart-api',
    'WhichPart API',
    'Customer boundary. Accepts the browser request and calls the orchestrator.',
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

  const orchFacts = [
    { label: 'Service', value: orchSafe.service || 'customer-diagnostic-orchestrator' },
    { label: 'Reported version', value: orchSafe.version || 'Version not exposed by runtime' },
    { label: 'Error Code MCP (config)', value: mcpConfigured || 'Not reported by this probe' },
    { label: 'Part Finder / RAG (config)', value: partFinderConfig || 'Not reported by this probe' },
  ];
  if (orchProbe.latencyMs != null && !orchProbe.skipped) {
    orchFacts.push({ label: 'Last probe', value: String(orchProbe.latencyMs) + ' ms' });
  }
  const orchComp = component(
    'orchestrator',
    'Orchestrator',
    'Routes each turn to Error Code MCP and/or Part Finder. Does not diagnose itself.',
    orchHealth,
    {
      latencyMs: orchProbe.skipped ? null : orchProbe.latencyMs,
      probedAt: orchProbe.probedAt || null,
      version: versionField(orchSafe.version),
      facts: orchFacts,
      technical: {
        host: runtimeIn.orchestratorHost || null,
        probe: orchProbe.skipped ? { available: false } : {
          httpStatus: orchProbe.status != null ? orchProbe.status : null,
          latencyMs: orchProbe.latencyMs != null ? orchProbe.latencyMs : null,
          probedAt: orchProbe.probedAt || null,
          error: orchProbe.error || null,
        },
        reported: orchSafe,
      },
    },
  );

  const pfSafe = pickPartFinder(pfProbe.json);
  const pfHealthState = classifyPartFinderProbe(pfProbe);

  const pfFacts = [];
  if (pfSafe.knowledge && pfSafe.knowledge.loaded) {
    pfFacts.push({ label: 'Knowledge loaded', value: String(pfSafe.knowledge.records) + ' records' });
    if (pfSafe.knowledge.faultIds != null) pfFacts.push({ label: 'faultIds', value: String(pfSafe.knowledge.faultIds) });
    if (pfSafe.knowledge.families != null) pfFacts.push({ label: 'Families', value: String(pfSafe.knowledge.families) });
  } else if (!pfProbe.skipped && pfHealthState.health !== 'unavailable') {
    pfFacts.push({ label: 'Knowledge loaded', value: 'not loaded' });
  }
  if (pfSafe.rag && pfSafe.rag.loaded) {
    pfFacts.push({ label: 'RAG', value: String(pfSafe.rag.indexedRecords) + ' indexed' });
  }
  if (pfSafe.models && pfSafe.models.understand && pfSafe.models.compose) {
    const u = pfSafe.models.understand.configured && pfSafe.models.compose.configured;
    pfFacts.push({ label: 'Models', value: u ? 'Configured' : 'Not configured' });
    if (pfSafe.models.understand.provider) {
      pfFacts.push({
        label: 'UNDERSTAND',
        value: pfSafe.models.understand.provider + (pfSafe.models.understand.model ? ' · ' + pfSafe.models.understand.model : ''),
      });
    }
    if (pfSafe.models.compose.provider) {
      pfFacts.push({
        label: 'COMPOSE',
        value: pfSafe.models.compose.provider + (pfSafe.models.compose.model ? ' · ' + pfSafe.models.compose.model : ''),
      });
    }
    pfFacts.push({ label: 'Inference tested', value: 'no' });
  }
  if (pfSafe.media) {
    pfFacts.push({
      label: 'Media resolver',
      value: pfSafe.media.resolverAvailable ? 'Available' : 'not loaded',
    });
    if (pfSafe.media.overlayState) {
      pfFacts.push({ label: 'Overlay', value: pfSafe.media.overlayState === 'none' ? 'none (shipped baseline)' : pfSafe.media.overlayState });
    }
  }
  pfFacts.push({
    label: 'Orchestrator config flag',
    value: partFinderConfig || 'Not reported (orchestrator probe did not return diagnosticRag)',
  });
  if (pfProbe.skipped) {
    pfFacts.push({ label: 'Reachability', value: 'No reliable health probe available' });
  }
  if (pfProbe.latencyMs != null && !pfProbe.skipped) {
    pfFacts.push({ label: 'Last probe', value: String(pfProbe.latencyMs) + ' ms' });
  }
  const pfComp = component(
    'part-finder',
    'Part Finder',
    'Live diagnostic reasoning: UNDERSTAND, RAG retrieval, and COMPOSE.',
    pfHealthState,
    {
      latencyMs: pfProbe.skipped ? null : pfProbe.latencyMs,
      probedAt: pfProbe.probedAt || null,
      version: versionField(pfSafe.version || (pfSafe.knowledge && pfSafe.knowledge.version)),
      facts: pfFacts,
      technical: {
        engineHost: runtimeIn.engineHost || null,
        probe: pfProbe.skipped ? { available: false, reason: pfProbe.skipReason || 'No reliable health probe available' } : {
          httpStatus: pfProbe.status != null ? pfProbe.status : null,
          latencyMs: pfProbe.latencyMs != null ? pfProbe.latencyMs : null,
          probedAt: pfProbe.probedAt || null,
          error: pfProbe.error || null,
        },
        reported: pfSafe,
        note: 'This probe is GET /health on the Part Finder Function URL (ENGINE_URL). The orchestrator calls the same process via RAG_URL, which is not exposed to this API.',
      },
    },
  );

  const pfKn = pfSafe.knowledge || {};
  const pfRag = pfSafe.rag || {};
  const pfReached = !pfProbe.skipped && pfHealthState.health !== 'unavailable';
  const ragFacts = [];
  let ragHealth;
  if (pfHealthState.health === 'unavailable' || pfProbe.skipped) {
    ragHealth = pfProbe.skipped
      ? healthOf('unknown', 'Part Finder health was not probed. Bundled WhichPart API artifacts are a reference copy, not proof the running process has loaded them.')
      : healthOf('unavailable', 'Part Finder health probe failed. Bundled WhichPart API artifacts are not proof the running process is loaded.');
    ragFacts.push({
      label: 'Part Finder runtime',
      value: pfProbe.skipped ? 'Not probed' : 'Unavailable',
    });
    ragFacts.push({
      label: 'Bundled reference artifacts',
      value: (knowledge.canonicalRecords != null && knowledge.index && knowledge.index.count != null)
        ? (knowledge.canonicalRecords + ' canonical / ' + knowledge.index.count + ' indexed')
        : 'Version not exposed by runtime',
    });
  } else {
    ragHealth = {
      health: pfHealthState.health,
      healthLabel: pfHealthState.healthLabel,
      healthReason: pfKn.loaded
        ? (pfRag.mismatch
          ? 'Part Finder loaded knowledge and index counts differ'
          : 'Counts are from the running Part Finder process')
        : (pfHealthState.healthReason || 'Part Finder knowledge index is not loaded'),
    };
    if (pfHealthState.health === 'healthy' && pfRag.mismatch) {
      ragHealth = healthOf('degraded', 'Part Finder loaded knowledge and index counts differ');
    }
    ragFacts.push({
      label: 'Part Finder runtime knowledge',
      value: pfKn.records != null ? String(pfKn.records) + ' records' : 'not loaded',
    });
    ragFacts.push({
      label: 'faultIds',
      value: pfKn.faultIds != null ? String(pfKn.faultIds) : 'Version not exposed by runtime',
    });
    ragFacts.push({
      label: 'Families',
      value: pfKn.families != null ? String(pfKn.families) : 'Version not exposed by runtime',
    });
    ragFacts.push({
      label: 'Part Finder RAG index',
      value: pfRag.indexedRecords != null ? String(pfRag.indexedRecords) + ' indexed' : 'not loaded',
    });
    ragFacts.push({
      label: 'Index identifier',
      value: pfRag.indexVersion || pfKn.version || 'Version not exposed by runtime',
    });
    if (pfRag.mismatch) {
      ragFacts.push({
        label: 'Mismatch',
        value: 'Part Finder loaded ' + pfKn.records + ' documents; index count is ' + pfRag.indexedRecords + '.',
      });
    }
    if (knowledge.canonicalRecords != null && pfKn.records != null && knowledge.canonicalRecords !== pfKn.records) {
      ragFacts.push({
        label: 'BFF bundled copy',
        value: knowledge.canonicalRecords + ' canonical / ' + ((knowledge.index && knowledge.index.count) || 'unknown') + ' indexed',
      });
    }
  }
  const ragComp = component(
    'rag-index',
    'Knowledge / RAG index',
    'Runtime knowledge loaded inside the running Part Finder process. This is not the WhichPart API bundled file copy.',
    ragHealth,
    {
      version: versionField(pfReached
        ? ((pfRag && pfRag.indexVersion) || (pfKn && pfKn.version))
        : null),
      facts: ragFacts,
      links: [{ href: '#knowledge', label: 'Open Knowledge' }],
      technical: {
        partFinder: { knowledge: pfKn, rag: pfRag },
        bffBundled: {
          docsVersion: knowledge.docsVersion,
          canonicalRecords: knowledge.canonicalRecords,
          index: knowledge.index,
          mismatch: knowledge.mismatch,
        },
        note: 'Primary counts are Part Finder GET /health. BFF bundled artifacts are a reference copy only.',
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
    'Frozen error-code catalogue lookup used when a turn is routed as an error code.',
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
  [apiComp, orchComp, pfComp, mcpComp].forEach((c) => {
    if (c.health === 'healthy' && c.probedAt) lastSuccess.push({ id: c.id, name: c.name, at: c.probedAt, latencyMs: c.latencyMs });
    if (c.health === 'unavailable' && c.probedAt) lastFailed.push({ id: c.id, name: c.name, at: c.probedAt, latencyMs: c.latencyMs, reason: c.healthReason });
  });

  const runtime = {
    conversationWindowTurns: runtimeIn.maxConversationTurns != null ? runtimeIn.maxConversationTurns : null,
    orchestratorTimeoutMs: runtimeIn.orchestratorTimeoutMs != null ? runtimeIn.orchestratorTimeoutMs : null,
    mediaOverlayCacheTtlMs: 10000,
    supportedFamilies: Array.isArray(runtimeIn.families) ? runtimeIn.families.slice() : [],
    ragIndex: (pfRag && pfRag.embeddingModel)
      ? {
        version: pfRag.indexVersion || null,
        embedModel: pfRag.embeddingModel,
        dims: pfRag.dims || null,
        builtAt: pfRag.builtAt || null,
        source: 'part-finder',
      }
      : (knowledge.index ? {
        version: knowledge.index.version || null,
        embedModel: knowledge.index.embedModel || null,
        dims: knowledge.index.dims || null,
        builtAt: knowledge.index.builtAt || null,
        source: 'bff-bundled',
      } : null),
    models: {
      understand: models.understand,
      compose: models.compose,
    },
    // Canonical conversation mode as resolved by the deployed API (read-only; allow-list keys
    // themselves are not exposed, only how many are enabled).
    canonical: canonicalRuntime(runtimeIn.canonical),
    note: 'Read-only. Settings owns writable AI configuration. Secrets are not included.',
  };

  const technical = {
    generatedAt: now,
    identifiers: {
      whichpartApi: 'whichpart-api',
      orchestratorHost: runtimeIn.orchestratorHost || null,
      mcpHealthHost: runtimeIn.mcpHealthHost || null,
      partFinderFeedbackHost: runtimeIn.engineHost || null,
      partsCatalogueHost: runtimeIn.s4rProductBaseHost || null,
      knowledgeDocsVersion: knowledge.docsVersion || null,
      ragIndexVersion: pfReached
        ? ((pfRag && pfRag.indexVersion) || null)
        : ((knowledge.index && knowledge.index.version) || null),
      mediaCatalogueVersion: media.catalogueVersion || null,
      mcpDatasetV1Hash: mcpSafe.datasetV1Hash || null,
      mcpEnrichmentV1Hash: mcpSafe.enrichmentV1Hash || null,
    },
    probes: {
      orchestrator: orchComp.technical && orchComp.technical.probe,
      partFinder: pfComp.technical && pfComp.technical.probe,
      mcp: mcpComp.technical && mcpComp.technical.probe,
    },
    models: models,
    notExposed: [
      'Lambda version aliases',
      'Lambda code hashes',
      'Orchestrator RAG_URL',
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
    components: [apiComp, orchComp, pfComp, ragComp, mcpComp, mediaComp, partsComp],
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

const CANONICAL_MODE_LABELS = { off: 'Off', shadow: 'Shadow (observe only)', control: 'Control (allow-listed journeys)', unknown: 'Unknown' };
function canonicalRuntime(c) {
  if (!c || typeof c !== 'object' || typeof c.mode !== 'string') return null;
  const mode = Object.prototype.hasOwnProperty.call(CANONICAL_MODE_LABELS, c.mode) ? c.mode : 'unknown';
  return {
    mode,
    modeLabel: CANONICAL_MODE_LABELS[mode],
    controlJourneyCount: Number.isFinite(c.controlJourneyCount) ? c.controlJourneyCount : null,
    demoted: !!c.demoted,
    invalid: !!c.invalid,
    unknownKeyCount: Number.isFinite(c.unknownKeyCount) ? c.unknownKeyCount : null,
  };
}

function failureSnapshot(err, runtime) {
  const base = buildSnapshot({
    now: new Date(),
    probes: {
      orchestrator: { skipped: true, skipReason: 'Diagnostics collector failed before probes completed' },
      partFinder: { skipped: true, skipReason: 'Diagnostics collector failed before probes completed' },
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

  const orchUrl = deps.orchestratorHealthUrl || '';
  const mcpUrl = deps.mcpHealthUrl || '';
  const pfUrl = deps.partFinderHealthUrl || '';

  const orchP = settled(timedProbe(orchUrl, timeoutMs, fetchImpl));
  const mcpP = mcpUrl
    ? settled(timedProbe(mcpUrl, timeoutMs, fetchImpl))
    : Promise.resolve({ ok: true, value: { skipped: true, skipReason: 'MCP health URL is not configured' } });
  const pfP = pfUrl
    ? settled(timedProbe(pfUrl, timeoutMs, fetchImpl))
    : Promise.resolve({ ok: true, value: { skipped: true, skipReason: 'Part Finder health URL is not configured' } });
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

  const [orch, mcp, pf, kn, media, models] = await Promise.all([orchP, mcpP, pfP, knP, mediaP, modelsP]);

  return buildSnapshot({
    now: deps.now || new Date(),
    probes: {
      orchestrator: orch.ok ? orch.value : { ok: false, error: String(orch.error && orch.error.message || orch.error || 'probe failed') },
      mcp: mcp.ok ? mcp.value : { ok: false, error: String(mcp.error && mcp.error.message || mcp.error || 'probe failed') },
      partFinder: pf.ok ? pf.value : { ok: false, error: String(pf.error && pf.error.message || pf.error || 'probe failed') },
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
  ORCH_FIELDS,
  MCP_FIELDS,
  PF_FIELDS,
  hostOf,
  pick,
  classifyProbe,
  classifyPartFinderProbe,
  timedProbe,
  overlayActive,
  overlaySummary,
  knowledgeRuntime,
  mediaRuntime,
  modelsRuntime,
  canonicalRuntime,
  buildSnapshot,
  failureSnapshot,
  collect,
  healthOf,
};
