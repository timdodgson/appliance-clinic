/**
 * Diagnosis engine read-only GET /health — no diagnosis, no LLM, no mutation.
 */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const health = require('../health.js');
const media = require('../media.js');
const handlerSrc = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'handler.js'), 'utf8');

function deps(overrides) {
  return Object.assign({
    describeMediaBaseline: () => ({ loaded: true, identityCount: 22 }),
    ensureMediaOverlay: async () => {},
    getMediaOverlayCache: () => ({ applied: true, failed: false, overlayPresent: false, updatedAt: null, version: null }),
    getEffectiveMediaJoin: () => ({ byKnowledgeId: {}, byComponent: {} }),
    countJoinIdentities: () => 22,
    loadAdminInference: async () => ({ config: { model: 'claude-opus-5-5' }, anthropicKey: 'sk-must-not-leak' }),
  }, overrides);
}

describe('GET health succeeds', () => {
  it('returns a whitelisted healthy payload from loaded artifacts', async () => {
    const hit = await health.handle({ rawPath: '/health', requestContext: { http: { method: 'GET', path: '/health' } } }, deps());
    expect(hit.status).toBe(200);
    const b = hit.body;
    expect(b.service).toBe('diagnosis-engine');
    expect(b.status).toBe('ok');
    expect(b.health).toBe('healthy');
    expect(b.diagnosis).toEqual({ architecture: 'ac2' });
    expect(b.models.reasoner.configured).toBe(true);
    expect(b.models.inferenceTested).toBe(false);
    expect(b.media.resolverAvailable).toBe(true);
    expect(b.media.overlayState).toBe('none');
    expect(Object.keys(b).sort()).toEqual([
      'diagnosis', 'health', 'healthReason', 'media', 'models', 'service', 'status', 'version',
    ]);
  });

  it('reports the ac2 architecture and the real shipped media baseline', async () => {
    media.resetMediaOverlayCache();
    const body = await health.build(deps({
      describeMediaBaseline: media.describeMediaBaseline,
      getEffectiveMediaJoin: media.getEffectiveMediaJoin,
      countJoinIdentities: media.countJoinIdentities,
    }));
    expect(body.diagnosis.architecture).toBe('ac2');
    expect(body.media.baselineLoaded).toBe(true);
    expect(body.media.effectiveMappingIdentities).toBeGreaterThan(0);
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
    const healthAt = handlerSrc.indexOf('health.handle(');
    const messagesAt = handlerSrc.indexOf('let messages = body.messages');
    expect(healthAt).toBeGreaterThan(0);
    expect(messagesAt).toBeGreaterThan(healthAt);
    expect(handlerSrc.indexOf('await ac2.turn(')).toBeGreaterThan(healthAt);
  });
  it('does not infer through the provider', async () => {
    let inferred = false;
    const body = await health.build(deps({
      resolveAdvisorProvider: () => ({ name: 'anthropic', model: null, converse: async () => { inferred = true; return {}; } }),
    }));
    expect(body.models.inferenceTested).toBe(false);
    expect(inferred).toBe(false);
  });
});

describe('models', () => {
  it('reports the configured model without the key', async () => {
    const body = await health.build(deps());
    expect(body.models.reasoner).toEqual({ configured: true, provider: 'anthropic', model: 'claude-opus-5-5' });
    expect(Object.keys(body.models).sort()).toEqual(['inferenceTested', 'note', 'reasoner']);
    expect(body.models.inferenceTested).toBe(false);
    expect(JSON.stringify(body)).not.toMatch(/sk-must-not-leak|anthropicKey|x-api-key/);
  });
  it('reads the model from a configuration document written before 23.3 (frontier.model)', async () => {
    const body = await health.build(deps({
      loadAdminInference: async () => ({
        config: { routing: { understand: 'local', compose: 'frontier' }, frontier: { provider: 'anthropic', model: 'claude-opus-5-5' }, local: {} },
        anthropicKey: 'sk-must-not-leak',
      }),
    }));
    expect(body.models.reasoner).toMatchObject({ configured: true, provider: 'anthropic', model: 'claude-opus-5-5' });
    expect(body.health).toBe('healthy');
    expect(JSON.stringify(body)).not.toMatch(/sk-must-not-leak/);
  });
  it('reports a missing model or key as not configured / degraded', async () => {
    const noConfig = await health.build(deps({ loadAdminInference: async () => ({ config: null, anthropicKey: null }) }));
    expect(noConfig.models.reasoner.configured).toBe(false);
    expect(noConfig.health).toBe('degraded');
    const noKey = await health.build(deps({ loadAdminInference: async () => ({ config: { model: 'claude-opus-5-5' }, anthropicKey: null }) }));
    expect(noKey.models.reasoner.configured).toBe(false);
    expect(noKey.healthReason).toMatch(/advisor's model is not configured/);
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
    media.resetMediaOverlayCache();
    media.setMediaOverlayLoader(async () => {
      const e = new Error('The specified key does not exist.');
      e.name = 'NoSuchKey';
      throw e;
    });
    try {
      const body = await health.build(deps({
        describeMediaBaseline: media.describeMediaBaseline,
        ensureMediaOverlay: (opts) => media.ensureMediaOverlay(opts),
        getMediaOverlayCache: media.getMediaOverlayCache,
        getEffectiveMediaJoin: media.getEffectiveMediaJoin,
        countJoinIdentities: media.countJoinIdentities,
      }));
      expect(body.media.overlayState).toBe('none');
      expect(body.media.baselineLoaded).toBe(true);
      expect(body.health).toBe('healthy');
    } finally {
      media.setMediaOverlayLoader(null);
      media.resetMediaOverlayCache();
    }
  });
  it('treats a malformed overlay as overlay unavailable, not a crash', async () => {
    media.resetMediaOverlayCache();
    media.setMediaOverlayLoader(async () => { throw new Error('malformed-overlay'); });
    try {
      const body = await health.build(deps({
        describeMediaBaseline: media.describeMediaBaseline,
        ensureMediaOverlay: (opts) => media.ensureMediaOverlay(opts),
        getMediaOverlayCache: media.getMediaOverlayCache,
        getEffectiveMediaJoin: media.getEffectiveMediaJoin,
        countJoinIdentities: media.countJoinIdentities,
      }));
      expect(body.media.overlayState).toBe('unavailable');
      expect(body.media.baselineLoaded).toBe(true);
      expect(body.health).toBe('degraded');
      expect(body.service).toBe('diagnosis-engine');
    } finally {
      media.setMediaOverlayLoader(null);
      media.resetMediaOverlayCache();
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
    const body = await health.build(deps({ describeMediaBaseline: () => ({ loaded: false, identityCount: 0 }) }));
    expect(body.health).toBe('degraded');
    expect(body.status).toBe('degraded');
  });
  it('does not degrade when optional metadata cannot be calculated', async () => {
    const body = await health.build(deps({
      countJoinIdentities: () => { throw new Error('optional-count-failed'); },
    }));
    expect(body.health).toBe('healthy');
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
  it('drops extra baseline fields, including secrets', async () => {
    const body = await health.build(deps({
      describeMediaBaseline: () => ({ loaded: true, identityCount: 22, OPENAI_API_KEY: 'sk-extra', prompt: 'secret prompt' }),
    }));
    const raw = JSON.stringify(body);
    expect(raw).not.toMatch(/sk-extra/);
    expect(raw).not.toMatch(/secret prompt/);
    expect(Object.keys(body.diagnosis)).toEqual(['architecture']);
    expect(Object.keys(body.media).sort()).toEqual([
      'baselineLoaded', 'cacheTtlSeconds', 'effectiveMappingIdentities', 'overlayState',
      'overlayUpdatedAt', 'overlayVersion', 'resolverAvailable',
    ]);
  });
  it('still returns a payload if the collector throws', async () => {
    const hit = await health.handle(
      { rawPath: '/health', requestContext: { http: { method: 'GET' } } },
      deps({ describeMediaBaseline: () => { throw new Error('boom'); } }),
    );
    expect(hit.status).toBe(200);
    expect(hit.body.health).toBe('degraded');
    expect(hit.body.service).toBe('diagnosis-engine');
  });
});
