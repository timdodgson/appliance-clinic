/**
 * Read-only Diagnostics snapshot — health honesty, partial failure, secret whitelist.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const dg = require('../diagnostics-inspect.js');
const knowledgeInspect = require('../knowledge-inspect.js');
const mediaInspect = require('../media-inspect.js');
const mediaAdmin = require('../media-admin.js');
const api = require('../index.js');

function jsonRes(obj, status) {
  return {
    ok: status == null || (status >= 200 && status < 300),
    status: status == null ? 200 : status,
    text: async () => JSON.stringify(obj),
  };
}

function textRes(text, status) {
  return {
    ok: status == null || (status >= 200 && status < 300),
    status: status == null ? 200 : status,
    text: async () => text,
  };
}

const orchOk = {
  status: 'ok',
  service: 'customer-diagnostic-orchestrator',
  version: '1',
  errorCodeMcp: 'configured',
  diagnosticRag: 'configured',
  apiKey: 'sk-this-must-never-leak',
  ORCHESTRATOR_TOKEN: 'secret-token',
};

const mcpOk = {
  status: 'ok',
  service: 'error-code-mcp',
  version: '1',
  datasetVersion: '1',
  mappingCount: 847,
  datasetV1Hash: 'abc123def456',
  enrichmentV1Hash: 'fed654cba321',
  bearerToken: 'abc',
};

const pfOk = {
  status: 'ok',
  health: 'healthy',
  healthReason: 'Part Finder is running and essential diagnostic artifacts are loaded',
  service: 'part-finder',
  version: '1',
  knowledge: { loaded: true, records: 171, faultIds: 103, families: 9, version: '1.0.0' },
  rag: {
    loaded: true, indexedRecords: 171, indexVersion: '1.0.0',
    embeddingModel: 'text-embedding-nomic-embed-text-v1.5', dims: 768,
    builtAt: '2026-09-15T17:03:01.989Z', mismatch: false,
  },
  models: {
    understand: { configured: true, provider: 'lmstudio', model: null },
    compose: { configured: true, provider: 'lmstudio', model: null },
    inferenceTested: false,
    note: 'Configured means routing and model identifiers are present. Inference was not tested.',
    apiKey: 'sk-pf-must-never-leak',
  },
  media: {
    resolverAvailable: true, baselineLoaded: true, overlayState: 'none',
    overlayUpdatedAt: null, overlayVersion: null, effectiveMappingIdentities: 22, cacheTtlSeconds: 10,
  },
  OPENAI_API_KEY: 'sk-process-env-leak',
  prompt: 'you are a helpful assistant',
};

function pfProbe(json, extra) {
  return Object.assign({
    ok: true, status: 200, json, latencyMs: 123, probedAt: '2026-09-20T12:00:00.000Z',
  }, extra || {});
}

function setup(overrides) {
  const models = {
    understand: { provider: 'lmstudio', providerLabel: 'Private AI', model: null, modelLabel: 'Model managed by LM Studio' },
    compose: { provider: 'lmstudio', providerLabel: 'Private AI', model: null, modelLabel: 'Model managed by LM Studio' },
    judge: {
      provider: 'openai', providerLabel: 'OpenAI', model: 'gpt-5.6-terra', modelLabel: 'gpt-5.6-terra',
      configured: true, note: 'Only used when Full Quality Review is selected',
    },
  };
  return Object.assign({
    now: new Date('2026-09-20T12:00:00.000Z'),
    probes: {
      orchestrator: { ok: true, status: 200, json: orchOk, latencyMs: 214, probedAt: '2026-09-20T12:00:00.000Z' },
      mcp: { ok: true, status: 200, json: mcpOk, latencyMs: 90, probedAt: '2026-09-20T12:00:00.000Z' },
    },
    knowledge: dg.knowledgeRuntime(knowledgeInspect),
    media: dg.mediaRuntime({ ok: true, state: mediaAdmin.emptyState(), loadedAt: '2026-09-20T12:00:00.000Z' }, mediaInspect),
    models: dg.modelsRuntime(models),
    runtime: {
      maxConversationTurns: 12,
      orchestratorTimeoutMs: 120000,
      families: knowledgeInspect.FAMILIES,
      s4rProductBaseHost: 'd1hrb3pgx61xww.cloudfront.net',
      orchestratorHost: 'orch.example',
      mcpHealthHost: 'mcp.example',
      engineHost: 'engine.example',
    },
  }, overrides);
}

function byId(snap, id) {
  return snap.components.find((c) => c.id === id);
}

describe('health classification', () => {
  it('marks a successful probe healthy', () => {
    const h = dg.classifyProbe({ ok: true, status: 200, json: { status: 'ok', service: 'x' } }, { complete: (j) => j.status === 'ok' });
    expect(h.health).toBe('healthy');
    expect(h.healthLabel).toBe('Healthy');
  });
  it('marks timeout unavailable', () => {
    const h = dg.classifyProbe({ ok: false, error: 'timeout' });
    expect(h.health).toBe('unavailable');
    expect(h.healthReason).toMatch(/timed out/i);
  });
  it('marks malformed JSON degraded', () => {
    const h = dg.classifyProbe({ ok: true, status: 200, json: null });
    expect(h.health).toBe('degraded');
    expect(h.healthReason).toMatch(/not usable JSON/i);
  });
  it('does not treat a missing probe as failure', () => {
    const h = dg.classifyProbe({ skipped: true, skipReason: 'No reliable health probe available' });
    expect(h.health).toBe('unknown');
    expect(h.healthLabel).toBe('Unknown');
  });
  it('marks incomplete expected fields degraded', () => {
    const h = dg.classifyProbe({ ok: true, status: 200, json: { hello: true } }, { complete: (j) => j.status === 'ok' });
    expect(h.health).toBe('degraded');
  });
});

describe('snapshot whitelist and honesty', () => {
  it('returns the system path and deployed components', () => {
    const snap = dg.buildSnapshot(setup());
    expect(snap.ok).toBe(true);
    expect(snap.readOnly).toBe(true);
    expect(snap.purpose).toMatch(/deployed ApplianceClinic diagnostic system/);
    expect(snap.systemPath.steps.map((s) => s.id)).toEqual([
      'customer', 'whichpart-api', 'orchestrator', 'routing', 'customer-view',
    ]);
    expect(snap.components.map((c) => c.id)).toEqual([
      'whichpart-api', 'orchestrator', 'part-finder', 'rag-index', 'error-code-mcp', 'media-resolver', 'parts-catalogue',
    ]);
  });

  it('does not treat Part Finder config as healthy when the health probe is skipped', () => {
    const snap = dg.buildSnapshot(setup());
    const pf = byId(snap, 'part-finder');
    expect(pf.health).toBe('unknown');
    expect(pf.healthReason).toMatch(/No reliable health probe available/i);
    expect(pf.facts.some((f) => /configured/.test(f.value))).toBe(true);
    expect(byId(snap, 'rag-index').health).toBe('unknown');
    expect(byId(snap, 'rag-index').facts.some((f) => f.label === 'Bundled reference artifacts')).toBe(true);
    expect(byId(snap, 'rag-index').role).toMatch(/running Part Finder process/);
  });

  it('keeps MCP unavailable from hiding a healthy orchestrator', () => {
    const snap = dg.buildSnapshot(setup({
      probes: {
        orchestrator: { ok: true, status: 200, json: orchOk, latencyMs: 50, probedAt: '2026-09-20T12:00:00.000Z' },
        mcp: { ok: false, error: 'timeout', latencyMs: 5000, probedAt: '2026-09-20T12:00:00.000Z' },
      },
    }));
    expect(byId(snap, 'orchestrator').health).toBe('healthy');
    expect(byId(snap, 'error-code-mcp').health).toBe('unavailable');
    expect(byId(snap, 'whichpart-api').health).toBe('healthy');
    expect(snap.ok).toBe(true);
  });

  it('strips secrets from probe payloads', () => {
    const snap = dg.buildSnapshot(setup());
    const raw = JSON.stringify(snap);
    expect(raw).not.toMatch(/sk-this-must-never-leak/);
    expect(raw).not.toMatch(/secret-token/);
    expect(raw).not.toMatch(/bearerToken/);
    expect(raw).not.toMatch(/ORCHESTRATOR_TOKEN/);
    expect(raw).not.toMatch(/process\.env/);
    expect(Object.keys(byId(snap, 'orchestrator').technical.reported).sort()).toEqual(
      ['diagnosticRag', 'errorCodeMcp', 'service', 'status', 'version'],
    );
  });

  it('handles missing versions honestly', () => {
    const snap = dg.buildSnapshot(setup({
      probes: {
        orchestrator: { ok: true, status: 200, json: { status: 'ok' }, latencyMs: 10, probedAt: '2026-09-20T12:00:00.000Z' },
        mcp: { skipped: true, skipReason: 'No reliable health probe available' },
      },
    }));
    expect(byId(snap, 'orchestrator').version.label).toBe('Version not exposed by runtime');
    expect(byId(snap, 'error-code-mcp').health).toBe('unknown');
    expect(byId(snap, 'error-code-mcp').facts.some((f) => /Not reported|Version not exposed|No reliable/.test(f.value))).toBe(true);
  });

  it('keeps BFF bundled knowledge as a labelled reference copy, not Part Finder runtime', () => {
    const snap = dg.buildSnapshot(setup());
    expect(snap.knowledge.canonicalRecords).toBe(171);
    expect(snap.knowledge.index.count).toBe(171);
    expect(snap.knowledge.families).toBeGreaterThan(0);
    expect(snap.knowledge.faultIds).toBeGreaterThan(0);
    expect(snap.knowledge.mismatch).toBe(false);
    expect(byId(snap, 'rag-index').health).toBe('unknown');
    expect(byId(snap, 'rag-index').healthReason).toMatch(/Bundled WhichPart API artifacts are a reference copy/);
    expect(byId(snap, 'rag-index').links.some((l) => l.href === '#knowledge')).toBe(true);
    expect(snap.runtime.ragIndex.source).toBe('bff-bundled');
  });

  it('records a canonical/index mismatch as degraded data', () => {
    const kn = dg.knowledgeRuntime({
      loadCorpus: () => ({
        docsVersion: 'test',
        docs: [{ knowledgeId: 'a', faultId: 'a', applianceFamily: 'vacuum' }],
        indexMeta: { version: 'x', count: 9, embedModel: 'e', dims: 3, builtAt: 't' },
      }),
    });
    expect(kn.health).toBe('degraded');
    expect(kn.mismatch).toBe(true);
    expect(kn.mismatchNote).toMatch(/1 records.*9/);
  });

  it('shows media overlay none vs active without duplicating the catalogue', () => {
    const none = dg.buildSnapshot(setup());
    expect(none.media.overlay.label).toBe('none');
    expect(none.media.baselineCount).toBe(38);
    expect(byId(none, 'media-resolver').links.some((l) => l.href === '#media')).toBe(true);
    expect(JSON.stringify(none.media)).not.toMatch(/vac-lost-suction/);

    const overlay = mediaAdmin.emptyState();
    overlay.identities['admin-x'] = { origin: 'admin', status: 'active' };
    overlay.updatedAt = '2026-09-20T11:00:00.000Z';
    const active = dg.buildSnapshot(setup({
      media: dg.mediaRuntime({ ok: true, state: overlay, loadedAt: '2026-09-20T12:00:00.000Z' }, mediaInspect),
    }));
    expect(active.media.overlay.label).toBe('active');
    expect(active.media.overlay.identityCount).toBe(1);
  });

  it('treats overlay load failure as degraded, not a page failure', () => {
    const snap = dg.buildSnapshot(setup({
      media: dg.mediaRuntime({ ok: false, state: mediaAdmin.emptyState(), loadedAt: '2026-09-20T12:00:00.000Z' }, mediaInspect),
    }));
    expect(snap.ok).toBe(true);
    expect(byId(snap, 'media-resolver').health).toBe('degraded');
    expect(byId(snap, 'whichpart-api').health).toBe('healthy');
  });

  it('includes MCP runtime facts without catalogue rows', () => {
    const snap = dg.buildSnapshot(setup());
    expect(snap.mcp.mappingCount).toBe(847);
    expect(snap.mcp.datasetV1Hash).toBe('abc123def456');
    expect(JSON.stringify(snap.mcp)).not.toMatch(/E15/);
    expect(byId(snap, 'error-code-mcp').links.some((l) => l.href === '#mcp')).toBe(true);
  });

  it('shows UNDERSTAND/COMPOSE labels and never a judge key', () => {
    const snap = dg.buildSnapshot(setup());
    expect(snap.models.understand.providerLabel).toBe('Private AI');
    expect(snap.models.compose.modelLabel).toBe('Model managed by LM Studio');
    expect(snap.runtime.models.understand.provider).toBe('lmstudio');
    expect(JSON.stringify(snap)).not.toMatch(/apiKey/);
  });

  it('does not invent a unified deployment version', () => {
    const snap = dg.buildSnapshot(setup());
    expect(snap.version).toBeUndefined();
    expect(snap.technical.notExposed).toContain('Lambda code hashes');
  });
});

describe('Part Finder health probe', () => {
  it('marks Part Finder Healthy from a real health payload and uses those counts for Knowledge/RAG', () => {
    const snap = dg.buildSnapshot(setup({
      probes: {
        orchestrator: { ok: true, status: 200, json: orchOk, latencyMs: 214, probedAt: '2026-09-20T12:00:00.000Z' },
        mcp: { ok: true, status: 200, json: mcpOk, latencyMs: 90, probedAt: '2026-09-20T12:00:00.000Z' },
        partFinder: pfProbe(pfOk),
      },
    }));
    const pf = byId(snap, 'part-finder');
    expect(pf.health).toBe('healthy');
    expect(pf.healthLabel).toBe('Healthy');
    expect(pf.latencyMs).toBe(123);
    expect(pf.probedAt).toBe('2026-09-20T12:00:00.000Z');
    expect(pf.facts.some((f) => f.label === 'Knowledge loaded' && f.value === '171 records')).toBe(true);
    expect(pf.facts.some((f) => f.label === 'RAG' && f.value === '171 indexed')).toBe(true);
    expect(pf.facts.some((f) => f.label === 'Models' && f.value === 'Configured')).toBe(true);
    expect(pf.facts.some((f) => f.label === 'Media resolver' && f.value === 'Available')).toBe(true);
    const rag = byId(snap, 'rag-index');
    expect(rag.health).toBe('healthy');
    expect(rag.healthReason).toMatch(/running Part Finder process/);
    expect(rag.facts.some((f) => f.label === 'Part Finder runtime knowledge' && f.value === '171 records')).toBe(true);
    expect(rag.facts.some((f) => f.label === 'Part Finder RAG index' && f.value === '171 indexed')).toBe(true);
    expect(rag.facts.some((f) => f.label === 'BFF bundled copy')).toBe(false);
    expect(snap.runtime.ragIndex.source).toBe('part-finder');
    expect(snap.runtime.ragIndex.embedModel).toBe('text-embedding-nomic-embed-text-v1.5');
    const raw = JSON.stringify(snap);
    expect(raw).not.toMatch(/sk-pf-must-never-leak/);
    expect(raw).not.toMatch(/sk-process-env-leak/);
    expect(raw).not.toMatch(/you are a helpful assistant/);
  });

  it('marks Part Finder Degraded from an internal mismatch and shows the factual reason', () => {
    const json = JSON.parse(JSON.stringify(pfOk));
    json.status = 'degraded';
    json.health = 'degraded';
    json.healthReason = 'Loaded document count and index count differ';
    json.knowledge.records = 10;
    json.rag.indexedRecords = 171;
    json.rag.mismatch = true;
    const snap = dg.buildSnapshot(setup({
      probes: {
        orchestrator: { ok: true, status: 200, json: orchOk, latencyMs: 50, probedAt: '2026-09-20T12:00:00.000Z' },
        mcp: { ok: true, status: 200, json: mcpOk, latencyMs: 90, probedAt: '2026-09-20T12:00:00.000Z' },
        partFinder: pfProbe(json),
      },
    }));
    expect(byId(snap, 'part-finder').health).toBe('degraded');
    expect(byId(snap, 'part-finder').healthReason).toMatch(/differ/i);
    expect(byId(snap, 'rag-index').health).toBe('degraded');
    expect(byId(snap, 'rag-index').facts.some((f) => f.label === 'Mismatch')).toBe(true);
    expect(byId(snap, 'rag-index').facts.some((f) => f.label === 'BFF bundled copy' && /171 canonical/.test(f.value))).toBe(true);
    expect(byId(snap, 'orchestrator').health).toBe('healthy');
  });

  it('marks Part Finder Unavailable when the probe fails and does not present BFF artifacts as runtime RAG', () => {
    const snap = dg.buildSnapshot(setup({
      probes: {
        orchestrator: { ok: true, status: 200, json: orchOk, latencyMs: 50, probedAt: '2026-09-20T12:00:00.000Z' },
        mcp: { ok: true, status: 200, json: mcpOk, latencyMs: 90, probedAt: '2026-09-20T12:00:00.000Z' },
        partFinder: { ok: false, error: 'timeout', latencyMs: 5000, probedAt: '2026-09-20T12:00:00.000Z' },
      },
    }));
    expect(byId(snap, 'part-finder').health).toBe('unavailable');
    expect(byId(snap, 'part-finder').latencyMs).toBe(5000);
    expect(byId(snap, 'rag-index').health).toBe('unavailable');
    expect(byId(snap, 'rag-index').healthReason).toMatch(/not proof the running process is loaded/);
    expect(byId(snap, 'rag-index').facts.some((f) => f.label === 'Bundled reference artifacts' && /171 canonical/.test(f.value))).toBe(true);
    expect(byId(snap, 'rag-index').version.value).toBe(null);
    expect(byId(snap, 'orchestrator').health).toBe('healthy');
    expect(byId(snap, 'error-code-mcp').health).toBe('healthy');
    expect(snap.ok).toBe(true);
  });

  it('does not treat an orchestrator or MCP payload as Part Finder healthy', () => {
    const snap = dg.buildSnapshot(setup({
      probes: {
        orchestrator: { ok: true, status: 200, json: orchOk, latencyMs: 10, probedAt: '2026-09-20T12:00:00.000Z' },
        mcp: { ok: true, status: 200, json: mcpOk, latencyMs: 10, probedAt: '2026-09-20T12:00:00.000Z' },
        partFinder: pfProbe(mcpOk),
      },
    }));
    expect(byId(snap, 'part-finder').health).toBe('degraded');
    expect(byId(snap, 'part-finder').healthReason).toMatch(/not a Part Finder health payload/);
  });
});

describe('collect probes with isolation', () => {
  it('survives a timed-out dependency and a malformed one without treating BFF artifacts as Part Finder runtime', async () => {
    const fetchImpl = async (url) => {
      if (String(url).includes('orch')) {
        const err = new Error('The operation was aborted');
        err.name = 'AbortError';
        throw err;
      }
      return textRes('not-json{', 200);
    };
    const snap = await dg.collect({
      fetch: fetchImpl,
      orchestratorHealthUrl: 'https://orch.example/health',
      mcpHealthUrl: 'https://mcp.example/health',
      knowledgeInspect,
      mediaInspect,
      loadOverlay: async () => mediaAdmin.emptyState(),
      loadModels: async () => ({ unavailable: true }),
      runtime: { maxConversationTurns: 12, families: knowledgeInspect.FAMILIES },
      now: new Date('2026-09-20T12:00:00.000Z'),
    });
    expect(snap.ok).toBe(true);
    expect(byId(snap, 'orchestrator').health).toBe('unavailable');
    expect(byId(snap, 'error-code-mcp').health).toBe('degraded');
    expect(byId(snap, 'part-finder').health).toBe('unknown');
    expect(byId(snap, 'rag-index').health).toBe('unknown');
    expect(byId(snap, 'whichpart-api').health).toBe('healthy');
  });

  it('keeps Part Finder healthy when the orchestrator probe fails', async () => {
    const fetchImpl = async (url) => {
      if (String(url).includes('orch')) {
        const err = new Error('The operation was aborted');
        err.name = 'AbortError';
        throw err;
      }
      if (String(url).includes('engine')) return jsonRes(pfOk);
      return jsonRes(mcpOk);
    };
    const snap = await dg.collect({
      fetch: fetchImpl,
      orchestratorHealthUrl: 'https://orch.example/health',
      mcpHealthUrl: 'https://mcp.example/health',
      partFinderHealthUrl: 'https://engine.example/health',
      knowledgeInspect,
      mediaInspect,
      loadOverlay: async () => mediaAdmin.emptyState(),
      loadModels: async () => ({ unavailable: true }),
      runtime: { families: knowledgeInspect.FAMILIES },
    });
    expect(snap.ok).toBe(true);
    expect(byId(snap, 'orchestrator').health).toBe('unavailable');
    expect(byId(snap, 'part-finder').health).toBe('healthy');
    expect(byId(snap, 'error-code-mcp').health).toBe('healthy');
    expect(byId(snap, 'rag-index').health).toBe('healthy');
    expect(byId(snap, 'rag-index').facts.some((f) => f.label === 'Part Finder RAG index')).toBe(true);
  });

  it('does not fail the snapshot if overlay loading throws', async () => {
    const snap = await dg.collect({
      fetch: async () => jsonRes(orchOk),
      orchestratorHealthUrl: 'https://orch.example/health',
      mcpHealthUrl: '',
      knowledgeInspect,
      mediaInspect,
      loadOverlay: async () => { throw new Error('s3-down'); },
      emptyOverlay: mediaAdmin.emptyState(),
      loadModels: async () => { throw new Error('secrets-down'); },
      runtime: { families: knowledgeInspect.FAMILIES },
    });
    expect(snap.ok).toBe(true);
    expect(byId(snap, 'media-resolver').health).toBe('degraded');
    expect(snap.models.understand).toBe(null);
    expect(byId(snap, 'error-code-mcp').health).toBe('unknown');
  });
});

describe('HTTP auth and method', () => {
  function event(path, method) {
    return {
      rawPath: path,
      requestContext: { http: { method, path }, requestId: 't' },
      headers: {}, cookies: [], body: '', queryStringParameters: {},
    };
  }

  afterEach(() => {
    api.setSessionForTests(null);
    api.setDiagnosticsDepsForTests(null);
  });

  it('requires admin auth and rejects POST', async () => {
    api.setSessionForTests(null);
    expect((await api.handler(event('/api/admin/diagnostics', 'GET'))).statusCode).toBe(401);
    expect((await api.handler(event('/api/admin/diagnostics', 'POST'))).statusCode).toBe(405);
  });

  it('returns a useful snapshot for an admin without leaking env', async () => {
    api.setSessionForTests(async () => ({ isAdmin: true, email: 'admin@test' }));
    api.setDiagnosticsDepsForTests({
      fetch: async (url) => {
        const u = String(url);
        if (u.includes('orch')) return jsonRes(orchOk);
        if (u.includes('engine')) return jsonRes(pfOk);
        return jsonRes(mcpOk);
      },
      orchestratorHealthUrl: 'https://orch.example/health',
      mcpHealthUrl: 'https://mcp.example/health',
      partFinderHealthUrl: 'https://engine.example/health',
      loadOverlay: async () => mediaAdmin.emptyState(),
      loadModels: async () => ({
        understand: { provider: 'lmstudio', providerLabel: 'Private AI', model: null, modelLabel: 'Model managed by LM Studio' },
        compose: { provider: 'lmstudio', providerLabel: 'Private AI', model: null, modelLabel: 'Model managed by LM Studio' },
      }),
      now: new Date('2026-09-20T12:00:00.000Z'),
    });
    const res = await api.handler(event('/api/admin/diagnostics', 'GET'));
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.ok).toBe(true);
    expect(body.components.length).toBe(7);
    expect(JSON.stringify(body)).not.toMatch(/sk-/);
    expect(JSON.stringify(body)).not.toMatch(/AWS_SECRET/);
    expect(body.runtime.conversationWindowTurns).toBe(12);
    expect(byId(body, 'part-finder').health).toBe('healthy');
    expect(byId(body, 'rag-index').health).toBe('healthy');
    expect(JSON.stringify(body)).not.toMatch(/sk-pf-must-never-leak/);
    api.setDiagnosticsDepsForTests(null);
    api.setSessionForTests(null);
  });
});
