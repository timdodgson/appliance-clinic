/**
 * Part Finder read-only GET /health — no diagnosis, no LLM, no mutation.
 */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const health = require('../health.js');
const retrieval = require('../retrieval.js');
const handlerSrc = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'part-finder-lambda.js'), 'utf8');

const loadedIndex = {
  loaded: true,
  records: 171,
  faultIds: 103,
  families: 9,
  version: '1.0.0',
  indexedRecords: 171,
  indexVersion: '1.0.0',
  embeddingModel: 'text-embedding-nomic-embed-text-v1.5',
  dims: 768,
  builtAt: '2026-09-15T17:03:01.989Z',
  mismatch: false,
};

function deps(overrides) {
  return Object.assign({
    describeIndex: () => loadedIndex,
    describeMediaBaseline: () => ({ loaded: true, identityCount: 22 }),
    ensureMediaOverlay: async () => {},
    getMediaOverlayCache: () => ({ applied: true, failed: false, overlayPresent: false, updatedAt: null, version: null }),
    getEffectiveMediaJoin: () => ({ byKnowledgeId: {}, byComponent: {} }),
    countJoinIdentities: () => 22,
    loadAdminInference: async () => ({ config: null, openaiKey: 'sk-must-not-leak', jevConfigured: true }),
    env: { LM_STUDIO_URL: 'http://localhost:1234', UNDERSTAND_PROVIDER: 'lmstudio', COMPOSE_PROVIDER: 'lmstudio' },
  }, overrides);
}

describe('GET health succeeds', () => {
  it('returns a whitelisted healthy payload from loaded artifacts', async () => {
    const hit = await health.handle({ rawPath: '/health', requestContext: { http: { method: 'GET', path: '/health' } } }, deps());
    expect(hit.status).toBe(200);
    const b = hit.body;
    expect(b.service).toBe('part-finder');
    expect(b.status).toBe('ok');
    expect(b.health).toBe('healthy');
    expect(b.knowledge).toEqual({
      loaded: true, records: 171, faultIds: 103, families: 9, version: '1.0.0',
    });
    expect(b.rag.loaded).toBe(true);
    expect(b.rag.indexedRecords).toBe(171);
    expect(b.rag.indexVersion).toBe('1.0.0');
    expect(b.rag.embeddingModel).toBe('text-embedding-nomic-embed-text-v1.5');
    expect(b.models.understand.configured).toBe(true);
    expect(b.models.compose.configured).toBe(true);
    expect(b.models.inferenceTested).toBe(false);
    expect(b.media.resolverAvailable).toBe(true);
    expect(b.media.overlayState).toBe('none');
    expect(Object.keys(b).sort()).toEqual([
      'health', 'healthReason', 'knowledge', 'knowledgeOverlay', 'media', 'models', 'rag', 'service', 'status', 'version',
    ]);
    expect(b.knowledgeOverlay).toEqual({ state: 'none', version: 0, updatedAt: null, docs: 0, archived: 0 });
  });

  it('uses the real cold-start index without returning vectors', async () => {
    retrieval.resetMediaOverlayCache();
    const body = await health.build(deps({
      describeIndex: retrieval.describeLoadedIndex,
      describeMediaBaseline: retrieval.describeMediaBaseline,
      getEffectiveMediaJoin: retrieval.getEffectiveMediaJoin,
      countJoinIdentities: retrieval.countJoinIdentities,
    }));
    expect(body.knowledge.records).toBe(171);
    expect(body.knowledge.faultIds).toBe(103);
    expect(body.knowledge.families).toBe(9);
    expect(body.rag.indexedRecords).toBe(171);
    expect(JSON.stringify(body)).not.toMatch(/"vector"/);
  });
});

describe('unsupported mutation rejected', () => {
  it('rejects POST /health', async () => {
    const hit = await health.handle({ rawPath: '/health', requestContext: { http: { method: 'POST', path: '/health' } } }, deps());
    expect(hit.status).toBe(405);
    expect(hit.body.error).toBe('GET only');
  });
  it('rejects PUT /health', async () => {
    const hit = await health.handle({ rawPath: '/health', requestContext: { http: { method: 'PUT', path: '/health' } } }, deps());
    expect(hit.status).toBe(405);
  });
  it('does not intercept diagnosis POST /', async () => {
    const hit = await health.handle({ rawPath: '/', requestContext: { http: { method: 'POST', path: '/' } } }, deps());
    expect(hit).toBe(null);
  });
});

describe('no diagnosis / LLM / mutation', () => {
  it('handler source probes health before parsing messages', () => {
    const healthAt = handlerSrc.indexOf('partFinderHealth.handle');
    const messagesAt = handlerSrc.indexOf('let messages = body.messages');
    expect(healthAt).toBeGreaterThan(0);
    expect(messagesAt).toBeGreaterThan(healthAt);
    expect(handlerSrc).toMatch(/never enters UNDERSTAND/);
  });
  it('does not call retrieve or infer transports', async () => {
    let inferred = false;
    const body = await health.build(deps({
      resolveProvidersFromAdminConfig: () => ({
        understand: { name: 'lmstudio', model: null },
        compose: { name: 'lmstudio', model: null },
      }),
    }));
    expect(body.models.inferenceTested).toBe(false);
    expect(inferred).toBe(false);
    expect(handlerSrc.indexOf('retrieve(')).toBeGreaterThan(handlerSrc.indexOf('partFinderHealth.handle'));
  });
});

describe('knowledge / rag', () => {
  it('reports loaded counts and version', async () => {
    const body = await health.build(deps());
    expect(body.knowledge.loaded).toBe(true);
    expect(body.rag.loaded).toBe(true);
    expect(body.rag.mismatch).toBe(false);
  });
  it('marks canonical/index mismatch degraded', async () => {
    const body = await health.build(deps({
      describeIndex: () => Object.assign({}, loadedIndex, { records: 10, indexedRecords: 171, mismatch: true }),
    }));
    expect(body.health).toBe('degraded');
    expect(body.status).toBe('degraded');
    expect(body.healthReason).toMatch(/differ/i);
    expect(body.rag.mismatch).toBe(true);
  });
  it('marks a missing index degraded, not a crash', async () => {
    const body = await health.build(deps({
      describeIndex: () => ({
        loaded: false, records: 0, faultIds: 0, families: 0, version: null,
        indexedRecords: 0, indexVersion: null, embeddingModel: null, dims: null, builtAt: null, mismatch: false,
      }),
    }));
    expect(body.health).toBe('degraded');
    expect(body.knowledge.loaded).toBe(false);
    expect(body.service).toBe('part-finder');
  });
});

describe('models', () => {
  it('reports configured local routing without secrets', async () => {
    const body = await health.build(deps());
    expect(body.models.understand.configured).toBe(true);
    expect(body.models.understand.provider).toBe('jev');
    expect(body.models.understand.model).toBe('typesafe/jev');
    expect(body.models.inferenceTested).toBe(false);
    expect(JSON.stringify(body)).not.toMatch(/sk-must-not-leak/);
    expect(JSON.stringify(body)).not.toMatch(/openaiKey/);
  });
  it('reports frontier identifiers without the API key or Bearer header', async () => {
    const body = await health.build(deps({
      loadAdminInference: async () => ({
        config: {
          routing: { understand: 'frontier', compose: 'frontier' },
          frontier: { model: 'gpt-4o-mini' },
          local: {},
        },
        openaiKey: 'sk-must-not-leak',
        jevConfigured: true,
      }),
    }));
    expect(body.models.understand.provider).toBe('jev');
    expect(body.models.understand.model).toBe('typesafe/jev');
    expect(body.models.compose.provider).toBe('openai');
    expect(body.models.compose.model).toBe('gpt-4o-mini');
    const raw = JSON.stringify(body);
    expect(raw).not.toMatch(/sk-must-not-leak/);
    expect(raw).not.toMatch(/Bearer /);
    expect(raw).not.toMatch(/Authorization/);
  });
  it('reports missing configuration as not configured / degraded', async () => {
    const body = await health.build(deps({
      loadAdminInference: async () => ({ config: null, openaiKey: null, jevConfigured: false }),
      resolveProvidersFromAdminConfig: () => { throw new Error('CONFIG'); },
    }));
    expect(body.models.understand.configured).toBe(false);
    expect(body.models.compose.configured).toBe(false);
    expect(body.health).toBe('degraded');
  });
});

describe('media', () => {
  it('treats no overlay as healthy shipped baseline', async () => {
    const body = await health.build(deps());
    expect(body.media.overlayState).toBe('none');
    expect(body.health).toBe('healthy');
    expect(body.media.baselineLoaded).toBe(true);
    expect(body.media.cacheTtlSeconds).toBe(10);
  });
  it('reports an active overlay without enumerating the catalogue', async () => {
    const body = await health.build(deps({
      getMediaOverlayCache: () => ({
        applied: true, failed: false, overlayPresent: true,
        updatedAt: '2026-09-20T12:00:00.000Z', version: 1,
      }),
    }));
    expect(body.media.overlayState).toBe('active');
    expect(body.media.overlayUpdatedAt).toBe('2026-09-20T12:00:00.000Z');
    expect(body.health).toBe('healthy');
    expect(JSON.stringify(body.media)).not.toMatch(/vac-lost-suction/);
  });
  it('treats overlay store failure as degraded, baseline still reported', async () => {
    const body = await health.build(deps({
      getMediaOverlayCache: () => ({ applied: true, failed: true, overlayPresent: false }),
    }));
    expect(body.media.overlayState).toBe('unavailable');
    expect(body.health).toBe('degraded');
    expect(body.media.baselineLoaded).toBe(true);
  });
  it('treats missing media baseline as degraded', async () => {
    const body = await health.build(deps({
      describeMediaBaseline: () => ({ loaded: false, identityCount: 0 }),
    }));
    expect(body.media.baselineLoaded).toBe(false);
    expect(body.health).toBe('degraded');
  });
  it('treats a missing overlay object (NoSuchKey) as none / healthy shipped baseline', async () => {
    retrieval.resetMediaOverlayCache();
    retrieval.setMediaOverlayLoader(async () => {
      const e = new Error('The specified key does not exist.');
      e.name = 'NoSuchKey';
      throw e;
    });
    try {
      const body = await health.build(deps({
        describeMediaBaseline: retrieval.describeMediaBaseline,
        ensureMediaOverlay: (opts) => retrieval.ensureMediaOverlay(opts),
        getMediaOverlayCache: retrieval.getMediaOverlayCache,
        getEffectiveMediaJoin: retrieval.getEffectiveMediaJoin,
        countJoinIdentities: retrieval.countJoinIdentities,
      }));
      expect(body.media.overlayState).toBe('none');
      expect(body.media.baselineLoaded).toBe(true);
      expect(body.health).toBe('healthy');
    } finally {
      retrieval.setMediaOverlayLoader(null);
      retrieval.resetMediaOverlayCache();
    }
  });
  it('treats a malformed overlay as overlay unavailable, not a crash', async () => {
    retrieval.resetMediaOverlayCache();
    retrieval.setMediaOverlayLoader(async () => { throw new Error('malformed-overlay'); });
    try {
      const body = await health.build(deps({
        describeMediaBaseline: retrieval.describeMediaBaseline,
        ensureMediaOverlay: (opts) => retrieval.ensureMediaOverlay(opts),
        getMediaOverlayCache: retrieval.getMediaOverlayCache,
        getEffectiveMediaJoin: retrieval.getEffectiveMediaJoin,
        countJoinIdentities: retrieval.countJoinIdentities,
      }));
      expect(body.media.overlayState).toBe('unavailable');
      expect(body.media.baselineLoaded).toBe(true);
      expect(body.health).toBe('degraded');
      expect(body.service).toBe('part-finder');
    } finally {
      retrieval.setMediaOverlayLoader(null);
      retrieval.resetMediaOverlayCache();
    }
  });
});

describe('health states', () => {
  it('is healthy when essential artifacts are loaded', async () => {
    const body = await health.build(deps());
    expect(body.health).toBe('healthy');
    expect(body.status).toBe('ok');
  });
  it('is degraded when essential artifacts fail', async () => {
    const body = await health.build(deps({
      describeIndex: () => ({
        loaded: false, records: 0, faultIds: 0, families: 0, version: null,
        indexedRecords: 0, indexVersion: null, embeddingModel: null, dims: null, builtAt: null, mismatch: false,
      }),
    }));
    expect(body.health).toBe('degraded');
    expect(body.status).toBe('degraded');
  });
  it('does not degrade when optional metadata cannot be calculated', async () => {
    const body = await health.build(deps({
      describeIndex: () => Object.assign({}, loadedIndex, { dims: null, builtAt: null }),
      countJoinIdentities: () => { throw new Error('optional-count-failed'); },
    }));
    expect(body.health).toBe('healthy');
    expect(body.rag.dims).toBe(null);
    expect(body.media.effectiveMappingIdentities).toBe(22);
  });
});

describe('security', () => {
  it('never dumps process.env or prompts', async () => {
    const body = await health.build(deps());
    const raw = JSON.stringify(body);
    expect(raw).not.toMatch(/process\.env/);
    expect(raw).not.toMatch(/OPENAI_API_KEY/);
    expect(raw).not.toMatch(/system prompt/i);
    expect(raw).not.toMatch(/Authorization/);
    expect(raw).not.toMatch(/localhost:1234/);
  });
  it('drops extra index fields including vectors and secrets', async () => {
    const body = await health.build(deps({
      describeIndex: () => Object.assign({}, loadedIndex, {
        docs: [{ vector: [0.1, 0.2], text: 'secret prompt' }],
        OPENAI_API_KEY: 'sk-extra',
      }),
    }));
    const raw = JSON.stringify(body);
    expect(raw).not.toMatch(/vector/);
    expect(raw).not.toMatch(/sk-extra/);
    expect(raw).not.toMatch(/secret prompt/);
    expect(Object.keys(body.knowledge).sort()).toEqual(['families', 'faultIds', 'loaded', 'records', 'version']);
    expect(Object.keys(body.rag).sort()).toEqual([
      'builtAt', 'dims', 'embeddingModel', 'indexVersion', 'indexedRecords', 'loaded', 'mismatch',
    ]);
    expect(Object.keys(body.media).sort()).toEqual([
      'baselineLoaded', 'cacheTtlSeconds', 'effectiveMappingIdentities', 'overlayState',
      'overlayUpdatedAt', 'overlayVersion', 'resolverAvailable',
    ]);
  });
  it('still returns a payload if the collector throws', async () => {
    const hit = await health.handle(
      { rawPath: '/health', requestContext: { http: { method: 'GET' } } },
      deps({ describeIndex: () => { throw new Error('boom'); } }),
    );
    expect(hit.status).toBe(200);
    expect(hit.body.health).toBe('degraded');
    expect(hit.body.service).toBe('part-finder');
  });
});
