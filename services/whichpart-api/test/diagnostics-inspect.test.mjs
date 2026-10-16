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

// A retired orchestrator payload: never an engine health payload.
const orchLegacy = { status: 'ok', service: 'customer-diagnostic-orchestrator', version: '1', diagnosisEngine: 'configured' };

const mcpOk = {
  status: 'ok',
  service: 'error-code-mcp',
  version: '1',
  datasetVersion: '1',
  mappingCount: 847,
  datasetV1Hash: 'abc123def456',
  enrichmentV1Hash: 'fed654cba321',
  bearerToken: 'abc',
  apiKey: 'sk-this-must-never-leak',
};

// Exactly the diagnosis engine GET /health shape (services/diagnosis-engine/health.js) plus planted extras.
const engineOk = {
  status: 'ok',
  health: 'healthy',
  healthReason: 'The diagnosis engine is running; the advisor model and media are available',
  service: 'diagnosis-engine',
  version: '2',
  diagnosis: { architecture: 'ac2', packSecret: 'sk-diagnosis-must-never-leak' },
  models: {
    reasoner: { configured: true, provider: 'anthropic', model: 'claude-opus-5-5' },
    inferenceTested: false,
    note: 'The advisor model (Claude) serves every turn. Inference was not tested.',
    apiKey: 'sk-engine-must-never-leak',
  },
  media: {
    resolverAvailable: true, baselineLoaded: true, overlayState: 'none',
    overlayUpdatedAt: null, overlayVersion: null, effectiveMappingIdentities: 22, cacheTtlSeconds: 10,
  },
  OPENAI_API_KEY: 'sk-process-env-leak',
  prompt: 'you are a helpful assistant',
};

function engineProbe(json, extra) {
  return Object.assign({
    ok: true, status: 200, json, latencyMs: 123, probedAt: '2026-09-20T12:00:00.000Z',
  }, extra || {});
}

function setup(overrides) {
  const models = {
    advisor: { provider: 'anthropic', providerLabel: 'Anthropic (Claude)', model: 'claude-opus-5-5', modelLabel: 'claude-opus-5-5', credentialConfigured: true },
  };
  return Object.assign({
    now: new Date('2026-09-20T12:00:00.000Z'),
    probes: {
      mcp: { ok: true, status: 200, json: mcpOk, latencyMs: 90, probedAt: '2026-09-20T12:00:00.000Z' },
    },
    knowledge: dg.knowledgeRuntime(knowledgeInspect),
    media: dg.mediaRuntime({ ok: true, state: mediaAdmin.emptyState(), loadedAt: '2026-09-20T12:00:00.000Z' }, mediaInspect),
    models: dg.modelsRuntime(models),
    runtime: {
      maxConversationTurns: 12,
      families: knowledgeInspect.FAMILIES,
      s4rProductBaseHost: 'd1hrb3pgx61xww.cloudfront.net',
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
      'customer', 'whichpart-api', 'diagnosis-engine', 'customer-view',
    ]);
    expect(snap.components.map((c) => c.id)).toEqual([
      'whichpart-api', 'diagnosis-engine', 'error-code-mcp', 'media-resolver', 'parts-catalogue',
    ]);
    const eng = byId(snap, 'diagnosis-engine');
    expect(eng.name).toBe('Diagnosis engine');
    expect(eng.role).toMatch(/ac2 diagnosis: the advisor \(Claude, with tools\) inside the deterministic guardrail kernel/);
    expect(snap.runtime.diagnosis.architecture).toBe('ac2');
  });

  it('describes the one ac2 path without an orchestrator, Part Finder or a RAG index', () => {
    const snap = dg.buildSnapshot(setup());
    const text = JSON.stringify(snap.systemPath);
    expect(text).toMatch(/diagnosis engine/i);
    expect(text).toMatch(/ac2/);
    expect(text).not.toMatch(/Part Finder|RAG|orchestrator|Jev|cs\/1/i);
    expect(snap).not.toHaveProperty('routing');
    expect(snap).not.toHaveProperty('links');
    expect(JSON.stringify(snap)).not.toMatch(/orchestrator/i);
    expect(snap.runtime.ragIndex).toBeUndefined();
    expect(snap.technical.identifiers.ragIndexVersion).toBeUndefined();
    expect(JSON.stringify(snap.components)).not.toMatch(/Part Finder|RAG/);
  });

  it('does not treat diagnosis engine config as healthy when the health probe is skipped', () => {
    const snap = dg.buildSnapshot(setup());
    const eng = byId(snap, 'diagnosis-engine');
    expect(eng.health).toBe('unknown');
    expect(eng.healthReason).toMatch(/No reliable health probe available/i);
    expect(eng.facts.some((f) => f.label === 'Reachability')).toBe(true);
    expect(eng.facts.some((f) => f.label === 'Architecture')).toBe(false);
  });

  it('keeps MCP unavailable from hiding a healthy engine', () => {
    const snap = dg.buildSnapshot(setup({
      probes: {
        engine: engineProbe(engineOk),
        mcp: { ok: false, error: 'timeout', latencyMs: 5000, probedAt: '2026-09-20T12:00:00.000Z' },
      },
    }));
    expect(byId(snap, 'diagnosis-engine').health).toBe('healthy');
    expect(byId(snap, 'error-code-mcp').health).toBe('unavailable');
    expect(byId(snap, 'whichpart-api').health).toBe('healthy');
    expect(snap.ok).toBe(true);
  });

  it('strips secrets from probe payloads', () => {
    const snap = dg.buildSnapshot(setup());
    const raw = JSON.stringify(snap);
    expect(raw).not.toMatch(/sk-this-must-never-leak/);
    expect(raw).not.toMatch(/bearerToken/);
    expect(raw).not.toMatch(/process\.env/);
  });

  it('handles missing versions honestly', () => {
    const snap = dg.buildSnapshot(setup({
      probes: {
        engine: engineProbe({ ...engineOk, version: undefined }),
        mcp: { skipped: true, skipReason: 'No reliable health probe available' },
      },
    }));
    expect(byId(snap, 'diagnosis-engine').version.label).toBe('Version not exposed by runtime');
    expect(byId(snap, 'error-code-mcp').health).toBe('unknown');
    expect(byId(snap, 'error-code-mcp').facts.some((f) => /Not reported|Version not exposed|No reliable/.test(f.value))).toBe(true);
  });

  it('keeps BFF bundled knowledge data without attributing an index to the engine', () => {
    const snap = dg.buildSnapshot(setup());
    expect(snap.knowledge.canonicalRecords).toBe(171);
    expect(snap.knowledge.health).toBe('healthy');
    expect(snap.knowledge.families).toBeGreaterThan(0);
    expect(snap.knowledge.faultIds).toBeGreaterThan(0);
    expect(snap.knowledge).not.toHaveProperty('index');
    expect(JSON.stringify(snap.knowledge)).not.toMatch(/embed|index/i);
    expect(byId(snap, 'diagnosis-engine').facts.some((f) => /Knowledge|RAG/.test(f.label))).toBe(false);
  });

  it('reports no bundled knowledge as unknown, never as healthy', () => {
    const kn = dg.knowledgeRuntime({ loadCorpus: () => ({ docsVersion: 'test', docs: [] }) });
    expect(kn.health).toBe('unknown');
    expect(kn.canonicalRecords).toBe(0);
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

  it('shows the advisor model, no COMPOSE / UNDERSTAND stage, and never a key', () => {
    const snap = dg.buildSnapshot(setup());
    expect(snap.models.advisor.providerLabel).toBe('Anthropic (Claude)');
    expect(snap.models.advisor.modelLabel).toBe('claude-opus-5-5');
    expect(snap.models).not.toHaveProperty('understand');
    expect(snap.models).not.toHaveProperty('compose');
    expect(snap.models).not.toHaveProperty('judge');
    expect(snap.runtime.models.advisor.provider).toBe('anthropic');
    expect(JSON.stringify(snap)).not.toMatch(/apiKey/);
  });

  it('does not invent a unified deployment version', () => {
    const snap = dg.buildSnapshot(setup());
    expect(snap.version).toBeUndefined();
    expect(snap.technical.notExposed).toContain('Lambda code hashes');
  });
});

describe('diagnosis engine health probe', () => {
  const okProbes = () => ({
    mcp: { ok: true, status: 200, json: mcpOk, latencyMs: 90, probedAt: '2026-09-20T12:00:00.000Z' },
  });

  it('marks the engine Healthy from a real health payload and shows the architecture, advisor and media', () => {
    const snap = dg.buildSnapshot(setup({ probes: { ...okProbes(), engine: engineProbe(engineOk) } }));
    const eng = byId(snap, 'diagnosis-engine');
    expect(eng.health).toBe('healthy');
    expect(eng.healthLabel).toBe('Healthy');
    expect(eng.healthReason).toMatch(/diagnosis engine is running/);
    expect(eng.latencyMs).toBe(123);
    expect(eng.probedAt).toBe('2026-09-20T12:00:00.000Z');
    expect(eng.version.value).toBe('2');
    const fact = (label) => (eng.facts.find((f) => f.label === label) || {}).value;
    expect(fact('Architecture')).toBe('ac2');
    expect(fact('Advisor model')).toBe('Configured');
    expect(fact('Advisor')).toBe('anthropic · claude-opus-5-5');
    expect(fact('Inference tested')).toBe('no');
    expect(fact('Media resolver')).toBe('Available');
    expect(fact('Overlay')).toBe('none (shipped baseline)');
    expect(fact('Last probe')).toBe('123 ms');
    expect(eng.facts.some((f) => /Knowledge|RAG|faultIds|Families/.test(f.label))).toBe(false);
    expect(eng.technical.note).toBe('GET /health on the diagnosis engine (ENGINE_URL), the function every customer turn calls.');
    expect(Object.keys(eng.technical.reported).sort()).toEqual(
      ['diagnosis', 'health', 'healthReason', 'media', 'models', 'service', 'status', 'version'],
    );
    expect(eng.technical.reported.diagnosis).toEqual({ architecture: 'ac2' });
    expect(snap.technical.probes.engine.httpStatus).toBe(200);
    expect(snap.technical.identifiers.engineHost).toBe('engine.example');
    expect(snap.evidence.lastSuccessfulProbes.some((p) => p.id === 'diagnosis-engine')).toBe(true);
    const raw = JSON.stringify(snap);
    expect(raw).not.toMatch(/sk-engine-must-never-leak/);
    expect(raw).not.toMatch(/sk-diagnosis-must-never-leak/);
    expect(raw).not.toMatch(/sk-process-env-leak/);
    expect(raw).not.toMatch(/you are a helpful assistant/);
  });

  it('ignores legacy knowledge/rag fields even if a payload still carries them', () => {
    const json = { ...engineOk, knowledge: { loaded: true, records: 171 }, rag: { loaded: true, indexedRecords: 171 } };
    const picked = dg.pickEngine(json);
    expect(picked.knowledge).toBeUndefined();
    expect(picked.rag).toBeUndefined();
  });

  it('marks the engine Degraded and shows its factual reason', () => {
    const json = JSON.parse(JSON.stringify(engineOk));
    json.status = 'degraded';
    json.health = 'degraded';
    json.healthReason = 'The advisor\'s model is not configured';
    json.models.reasoner = { configured: false, provider: null, model: null };
    const snap = dg.buildSnapshot(setup({ probes: { ...okProbes(), engine: engineProbe(json) } }));
    const eng = byId(snap, 'diagnosis-engine');
    expect(eng.health).toBe('degraded');
    expect(eng.healthReason).toMatch(/not configured/);
    expect(eng.facts.some((f) => f.label === 'Advisor model' && f.value === 'Not configured')).toBe(true);
    expect(byId(snap, 'error-code-mcp').health).toBe('healthy');
  });

  it('marks the engine Unavailable when the probe fails', () => {
    const snap = dg.buildSnapshot(setup({
      probes: { ...okProbes(), engine: { ok: false, error: 'timeout', latencyMs: 5000, probedAt: '2026-09-20T12:00:00.000Z' } },
    }));
    const eng = byId(snap, 'diagnosis-engine');
    expect(eng.health).toBe('unavailable');
    expect(eng.latencyMs).toBe(5000);
    expect(eng.version.value).toBe(null);
    expect(snap.evidence.lastFailedProbes.some((p) => p.id === 'diagnosis-engine')).toBe(true);
    expect(byId(snap, 'error-code-mcp').health).toBe('healthy');
    expect(snap.ok).toBe(true);
  });

  it('rejects a legacy part-finder payload as not a diagnosis engine health payload', () => {
    const legacy = { ...engineOk, service: 'part-finder' };
    const h = dg.classifyEngineProbe(engineProbe(legacy));
    expect(h.health).toBe('degraded');
    expect(h.healthReason).toMatch(/not a diagnosis engine health payload/);
    const snap = dg.buildSnapshot(setup({ probes: { ...okProbes(), engine: engineProbe(legacy) } }));
    expect(byId(snap, 'diagnosis-engine').health).toBe('degraded');
    expect(byId(snap, 'diagnosis-engine').healthReason).toMatch(/not a diagnosis engine health payload/);
  });

  it('does not treat a retired orchestrator, MCP or service-less payload as the engine', () => {
    for (const json of [mcpOk, orchLegacy, { status: 'ok', health: 'healthy' }]) {
      const snap = dg.buildSnapshot(setup({ probes: { ...okProbes(), engine: engineProbe(json) } }));
      expect(byId(snap, 'diagnosis-engine').health).toBe('degraded');
      expect(byId(snap, 'diagnosis-engine').healthReason).toMatch(/not a diagnosis engine health payload/);
    }
  });
});

describe('collect probes with isolation', () => {
  it('survives a timed-out dependency and a malformed one, leaving an unconfigured engine Unknown', async () => {
    const fetchImpl = async () => textRes('not-json{', 200);
    const snap = await dg.collect({
      fetch: fetchImpl,
      mcpHealthUrl: 'https://mcp.example/health',
      knowledgeInspect,
      mediaInspect,
      loadOverlay: async () => mediaAdmin.emptyState(),
      loadModels: async () => ({ unavailable: true }),
      runtime: { maxConversationTurns: 12, families: knowledgeInspect.FAMILIES },
      now: new Date('2026-09-20T12:00:00.000Z'),
    });
    expect(snap.ok).toBe(true);
    expect(byId(snap, 'error-code-mcp').health).toBe('degraded');
    expect(byId(snap, 'diagnosis-engine').health).toBe('unknown');
    expect(byId(snap, 'diagnosis-engine').healthReason).toMatch(/Diagnosis engine health URL is not configured/);
    expect(byId(snap, 'whichpart-api').health).toBe('healthy');
  });

  it('keeps the diagnosis engine healthy when the MCP probe times out', async () => {
    const fetchImpl = async (url) => {
      if (String(url).includes('mcp')) {
        const err = new Error('The operation was aborted');
        err.name = 'AbortError';
        throw err;
      }
      return jsonRes(engineOk);
    };
    const snap = await dg.collect({
      fetch: fetchImpl,
      mcpHealthUrl: 'https://mcp.example/health',
      engineHealthUrl: 'https://engine.example/health',
      knowledgeInspect,
      mediaInspect,
      loadOverlay: async () => mediaAdmin.emptyState(),
      loadModels: async () => ({ unavailable: true }),
      runtime: { families: knowledgeInspect.FAMILIES },
    });
    expect(snap.ok).toBe(true);
    expect(byId(snap, 'error-code-mcp').health).toBe('unavailable');
    expect(byId(snap, 'diagnosis-engine').health).toBe('healthy');
    expect(byId(snap, 'diagnosis-engine').facts.some((f) => f.label === 'Architecture' && f.value === 'ac2')).toBe(true);
  });

  it('does not fail the snapshot if overlay loading throws', async () => {
    const snap = await dg.collect({
      fetch: async () => jsonRes(engineOk),
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
    expect(snap.models.advisor).toBe(null);
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
        if (u.includes('engine')) return jsonRes(engineOk);
        return jsonRes(mcpOk);
      },
      mcpHealthUrl: 'https://mcp.example/health',
      engineHealthUrl: 'https://engine.example/health',
      loadOverlay: async () => mediaAdmin.emptyState(),
      loadModels: async () => ({
        compose: { provider: 'lmstudio', providerLabel: 'Private AI', model: null, modelLabel: 'Model managed by LM Studio' },
      }),
      now: new Date('2026-09-20T12:00:00.000Z'),
    });
    const res = await api.handler(event('/api/admin/diagnostics', 'GET'));
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.ok).toBe(true);
    expect(body.components.length).toBe(5);
    expect(JSON.stringify(body)).not.toMatch(/sk-/);
    expect(JSON.stringify(body)).not.toMatch(/AWS_SECRET/);
    expect(body.runtime.conversationWindowTurns).toBe(12);
    expect(byId(body, 'diagnosis-engine').health).toBe('healthy');
    expect(body.components.some((c) => c.id === 'rag-index')).toBe(false);
    expect(JSON.stringify(body)).not.toMatch(/sk-engine-must-never-leak/);
    api.setDiagnosticsDepsForTests(null);
    api.setSessionForTests(null);
  });
});
