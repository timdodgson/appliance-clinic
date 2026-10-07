/**
 * Settings admin view-model and mutation contract.
 *
 *   npx vitest run services/whichpart-api/test/settings-admin.test.mjs
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const settings = require('../settings-admin.js');
const ai = require('../ai-config.js');
const api = require('../index.js');

function event(path, method, body) {
  return {
    rawPath: path,
    requestContext: { http: { method, path }, requestId: 't' },
    headers: {}, cookies: [], body: body ? JSON.stringify(body) : '',
  };
}

function memJev(initial) {
  let stored = initial || null;
  return {
    async loadJevWithStatus() {
      if (!stored) return { status: 'absent', stored: null, public: ai.defaultJevPublic() };
      return { status: 'ok', stored: Object.assign({}, stored), public: ai.toJevPublic(stored) };
    },
    async saveJevStored(next) { stored = next; },
    snapshot() { return stored; },
  };
}

const absentJev = {
  async loadJevWithStatus() {
    return { status: 'absent', stored: null, public: ai.defaultJevPublic() };
  },
};

function memStore(initial) {
  let cfg = ai.normalise(initial || ai.defaultConfig());
  return {
    async loadConfigWithStatus() { return { cfg, status: 'ok' }; },
    async saveConfig(next) { cfg = next; },
    snapshot() { return cfg; },
  };
}

const runningLocal = {
  available: true,
  understand: { available: true, provider: 'lmstudio', providerLabel: 'Private AI', model: 'qwen-local', modelLabel: 'qwen-local' },
  compose: { available: true, provider: 'lmstudio', providerLabel: 'Private AI', model: 'qwen-local', modelLabel: 'qwen-local' },
};

describe('view model', () => {
  it('lists supported settings with sources and editability', async () => {
    const view = await settings.buildView({
      loadConfigWithStatus: async () => ({ cfg: ai.defaultConfig(), status: 'ok' }),
      isKeyConfigured: async () => false,
      loadJevWithStatus: absentJev.loadJevWithStatus,
      runningModels: runningLocal,
      judgeModel: 'gpt-5.6-terra',
      env: { TRANSCRIPT_REVIEW_PROVIDER: 'lmstudio', TRANSCRIPT_REVIEW_ENABLED: '1' },
    });
    expect(view.diagnosticInference.editable).toBe(true);
    expect(view.diagnosticInference.understand.source).toBe('Admin runtime configuration');
    expect(view.diagnosticInference.understand.configured.provider).toBe('jev');
    expect(view.diagnosticInference.understand.configured.model).toBe('typesafe/jev');
    expect(view.jev.providerLabel).toBe('TypeSafe Jev via Cloudflare');
    expect(view.jev.credentialConfigured).toBe(false);
    expect(view.diagnosticInference.compose.editable).toBe(true);
    expect(view.productionReview.editable).toBe(false);
    expect(view.productionReview.transcriptReview.source).toBe('Deployment environment');
    expect(view.transcripts.editable).toBe(false);
    expect(view.conversation.editable).toBe(false);
    expect(view.conversation.windowTurns).toBe(12);
    expect(view.elsewhere.some((e) => e.href === '#media')).toBe(true);
    expect(view.elsewhere.some((e) => e.href === '#mcp')).toBe(true);
  });

  it('never returns secrets or env dumps', async () => {
    const cfg = ai.normalise({ local: { enabled: true, model: 'qwen' }, routing: { understand: 'local', compose: 'local' } });
    const view = await settings.buildView({
      loadConfigWithStatus: async () => ({ cfg, status: 'ok' }),
      isKeyConfigured: async () => true,
      loadJevWithStatus: absentJev.loadJevWithStatus,
      runningModels: runningLocal,
      judgeModel: 'gpt-5.6-terra',
    });
    const s = JSON.stringify(view);
    expect(s).not.toMatch(/apiKey|apiToken|sk-|AKIA|Bearer |MCP_BEARER|password/i);
    expect(view.diagnosticInference.frontier.credential).toBe('configured');
    expect(view.jev.credentialConfigured).toBe(false);
    expect(s).not.toContain('process.env');
  });

  it('marks running value unverifiable when Part Finder is silent', async () => {
    const view = await settings.buildView({
      loadConfigWithStatus: async () => ({ cfg: ai.defaultConfig(), status: 'ok' }),
      isKeyConfigured: async () => false,
      runningModels: { available: false, reason: 'down' },
    });
    expect(view.diagnosticInference.understand.sync.status).toBe('unverifiable');
    expect(view.diagnosticInference.understand.running.available).toBe(false);
  });

  it('reports in-sync vs mismatch from Part Finder health', async () => {
    const cfg = ai.normalise({
      local: { enabled: true, model: 'qwen-local' },
      routing: { understand: 'local', compose: 'local' },
    });
    const runningJev = {
      available: true,
      understand: { available: true, provider: 'jev', providerLabel: 'TypeSafe Jev via Cloudflare', model: 'typesafe/jev', modelLabel: 'typesafe/jev' },
      compose: runningLocal.compose,
    };
    const sync = await settings.buildView({
      loadConfigWithStatus: async () => ({ cfg, status: 'ok' }),
      isKeyConfigured: async () => false,
      runningModels: runningJev,
    });
    expect(sync.diagnosticInference.understand.sync.status).toBe('in_sync');
    expect(sync.diagnosticInference.compose.sync.status).toBe('in_sync');
    const mismatch = await settings.buildView({
      loadConfigWithStatus: async () => ({ cfg, status: 'ok' }),
      isKeyConfigured: async () => false,
      runningModels: {
        available: true,
        understand: { available: true, provider: 'openai', model: 'gpt-x' },
        compose: runningLocal.compose,
      },
    });
    expect(mismatch.diagnosticInference.understand.sync.status).toBe('mismatch');
  });

  it('excludes GOLD harness knobs and prompt text', async () => {
    const view = await settings.buildView({
      loadConfigWithStatus: async () => ({ cfg: ai.defaultConfig(), status: 'ok' }),
      isKeyConfigured: async () => false,
      runningModels: { available: false },
    });
    const s = JSON.stringify(view);
    expect(s).not.toMatch(/pass_threshold|review_threshold|whichpart-regression-judge|You are an appliance/i);
  });

  it('surface store-absent as defaults without claiming live save', async () => {
    const view = await settings.buildView({
      loadConfigWithStatus: async () => ({ cfg: ai.defaultConfig(), status: 'absent' }),
      isKeyConfigured: async () => false,
      runningModels: { available: false },
    });
    expect(view.diagnosticInference.store.status).toBe('absent');
    expect(view.diagnosticInference.store.note).toMatch(/defaults/i);
  });

  it('uses describeSetup so the judge/frontier model cannot masquerade as Private AI', async () => {
    const cfg = ai.normalise({
      local: { enabled: true, model: 'gpt-5.6-terra' },
      frontier: { enabled: true, provider: 'openai', model: 'gpt-5.6-terra' },
      routing: { understand: 'local', compose: 'local' },
    });
    const view = await settings.buildView({
      loadConfigWithStatus: async () => ({ cfg, status: 'ok' }),
      isKeyConfigured: async () => true,
      runningModels: { available: false },
      judgeModel: 'gpt-5.6-terra',
    });
    expect(view.diagnosticInference.setup.understand.modelLabel).toBe('typesafe/jev');
    expect(view.diagnosticInference.understand.configured.modelLabel).toBe('typesafe/jev');
    expect(view.diagnosticInference.understand.configured.model).toBe('typesafe/jev');
    expect(view.diagnosticInference.setup.compose.modelLabel).toBe('Model managed by LM Studio');
    expect(view.productionReview.qualityReviewer.model).toBe('gpt-5.6-terra');
  });
});

describe('patch validation', () => {
  it('accepts a valid local/local save', () => {
    const r = settings.parseInferencePatch({
      expectedVersion: 1,
      routing: { understand: 'local', compose: 'local' },
      local: { enabled: true, model: 'qwen' },
    });
    expect(r.ok).toBe(true);
  });
  it('rejects unknown settings', () => {
    const r = settings.parseInferencePatch({ expectedVersion: 1, temperature: 0.2 });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/Unknown setting/);
  });
  it('rejects secret fields', () => {
    const r = settings.parseInferencePatch({ expectedVersion: 1, apiKey: 'sk-secret' });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/Secret/);
  });
  it('rejects unsupported routes', () => {
    const r = settings.parseInferencePatch({ expectedVersion: 1, routing: { understand: 'anthropic' } });
    expect(r.ok).toBe(false);
  });
  it('rejects missing expectedVersion', () => {
    const r = settings.parseInferencePatch({ routing: { understand: 'local' } });
    expect(r.ok).toBe(false);
  });
});

describe('persistence and conflict', () => {
  it('saves, reloads, and increments version', async () => {
    const store = memStore();
    const saved = await settings.saveInferencePatch({
      body: { expectedVersion: 1, routing: { understand: 'local', compose: 'local' }, local: { model: 'qwen-b' }, note: 'Pin qwen-b for COMPOSE' },
      loadConfigWithStatus: store.loadConfigWithStatus,
      saveConfig: store.saveConfig,
      isKeyConfigured: async () => false,
      runningModels: runningLocal,
    });
    expect(saved.ok).toBe(true);
    expect(saved.view.diagnosticInference.version).toBe(2);
    expect(store.snapshot().local.model).toBe('qwen-b');
  });
  it('rejects stale version without overwriting', async () => {
    const store = memStore();
    store.snapshot().version = 4;
    await store.saveConfig(Object.assign({}, store.snapshot(), { version: 4 }));
    const r = await settings.saveInferencePatch({
      body: { expectedVersion: 1, routing: { understand: 'local', compose: 'local' } },
      loadConfigWithStatus: store.loadConfigWithStatus,
      saveConfig: store.saveConfig,
      isKeyConfigured: async () => false,
      runningModels: runningLocal,
    });
    expect(r.ok).toBe(false);
    expect(r.status).toBe(409);
    expect(store.snapshot().version).toBe(4);
  });
  it('rejects frontier routing without a credential', async () => {
    const store = memStore();
    const r = await settings.saveInferencePatch({
      body: {
        expectedVersion: 1,
        routing: { understand: 'frontier', compose: 'local' },
        frontier: { enabled: true, model: 'gpt-4o-mini' },
      },
      loadConfigWithStatus: store.loadConfigWithStatus,
      saveConfig: store.saveConfig,
      isKeyConfigured: async () => false,
      runningModels: runningLocal,
    });
    expect(r.ok).toBe(false);
    expect(r.status).toBe(400);
  });
  it('treats unavailable store as 503', async () => {
    const r = await settings.saveInferencePatch({
      body: { expectedVersion: 1, routing: { understand: 'local', compose: 'local' } },
      loadConfigWithStatus: async () => ({ cfg: ai.defaultConfig(), status: 'unavailable' }),
      saveConfig: async () => { throw new Error('should not save'); },
      isKeyConfigured: async () => false,
      runningModels: { available: false },
    });
    expect(r.status).toBe(503);
  });
});

describe('Jev patch validation and persistence', () => {
  it('accepts the designed fields and rejects unknown or extra secrets', () => {
    expect(settings.parseJevPatch({
      expectedVersion: 1,
      accountId: 'acc',
      apiToken: 'tok',
      gatewayId: 'gw',
    }).ok).toBe(true);
    expect(settings.parseJevPatch({ expectedVersion: 1, secret: 'nope' }).ok).toBe(false);
    expect(settings.parseJevPatch({ expectedVersion: 1, endpoint: 'https://evil' }).ok).toBe(false);
  });
  it('blank token preserves the stored credential; replacement replaces it', async () => {
    const jev = memJev({ accountId: 'acc', apiToken: 'old-token', gatewayId: null, version: 1 });
    const store = memStore();
    const first = await settings.saveJevPatch({
      body: { expectedVersion: 1, accountId: 'acc', apiToken: '' },
      loadConfigWithStatus: store.loadConfigWithStatus,
      isKeyConfigured: async () => false,
      loadJevWithStatus: jev.loadJevWithStatus,
      saveJevStored: jev.saveJevStored,
      runningModels: { available: false },
    });
    expect(first.ok).toBe(true);
    expect(first.apply.written).toBe(false); // nothing changed → nothing written (no needless live write)
    expect(jev.snapshot().apiToken).toBe('old-token');
    expect(first.view.jev.credentialConfigured).toBe(true);
    expect(JSON.stringify(first.view)).not.toMatch(/old-token|apiToken/);
    const replaced = await settings.saveJevPatch({
      body: { expectedVersion: 1, accountId: 'acc', apiToken: 'new-token', note: 'Rotate the Jev token' },
      loadConfigWithStatus: store.loadConfigWithStatus,
      isKeyConfigured: async () => false,
      loadJevWithStatus: jev.loadJevWithStatus,
      saveJevStored: jev.saveJevStored,
      runningModels: { available: false },
    });
    expect(replaced.ok).toBe(true);
    expect(jev.snapshot().apiToken).toBe('new-token');
    expect(JSON.stringify(replaced.view)).not.toMatch(/new-token|old-token|apiToken/);
  });
  it('rejects a stale Jev version without overwriting', async () => {
    const jev = memJev({ accountId: 'acc', apiToken: 'tok', version: 4 });
    const r = await settings.saveJevPatch({
      body: { expectedVersion: 1, accountId: 'acc', apiToken: 'other' },
      loadJevWithStatus: jev.loadJevWithStatus,
      saveJevStored: async () => { throw new Error('should not save'); },
      loadConfigWithStatus: memStore().loadConfigWithStatus,
      isKeyConfigured: async () => false,
      runningModels: { available: false },
    });
    expect(r.status).toBe(409);
    expect(jev.snapshot().apiToken).toBe('tok');
  });
  it('connection test reports CONFIG when the credential is missing', async () => {
    const r = await settings.testJevConnection({
      getJevCredentials: async () => null,
    });
    expect(r.status).toBe('FAILED');
    expect(r.errorCategory).toBe('CONFIG');
    expect(r.connected).toBe(false);
  });
});

describe('HTTP auth', () => {
  beforeEach(() => {
    api.setSessionForTests(null);
    api.setSettingsDepsForTests(null);
  });
  afterEach(() => {
    api.setSessionForTests(null);
    api.setSettingsDepsForTests(null);
  });
  it('GET and PATCH require admin', async () => {
    expect((await api.handler(event('/api/admin/settings', 'GET'))).statusCode).toBe(401);
    expect((await api.handler(event('/api/admin/settings/diagnostic-inference', 'PATCH', { expectedVersion: 1 }))).statusCode).toBe(401);
  });
  it('admin GET returns the view model without secrets', async () => {
    api.setSessionForTests(async () => ({ isAdmin: true, email: 'admin@test' }));
    const store = memStore();
    api.setSettingsDepsForTests({
      loadConfigWithStatus: store.loadConfigWithStatus,
      isKeyConfigured: async () => false,
      loadJevWithStatus: absentJev.loadJevWithStatus,
      runningModels: runningLocal,
      partFinderHealthUrl: '',
    });
    const res = await api.handler(event('/api/admin/settings', 'GET'));
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.diagnosticInference.understand.configured.provider).toBe('jev');
    expect(body.jev.credentialConfigured).toBe(false);
    expect(JSON.stringify(body)).not.toMatch(/apiKey|apiToken|sk-/);
  });
  it('admin PATCH persists and rejects a stale version', async () => {
    api.setSessionForTests(async () => ({ isAdmin: true, email: 'admin@test' }));
    const store = memStore();
    api.setSettingsDepsForTests({
      loadConfigWithStatus: store.loadConfigWithStatus,
      saveConfig: store.saveConfig,
      isKeyConfigured: async () => false,
      runningModels: runningLocal,
      partFinderHealthUrl: '',
    });
    const okRes = await api.handler(event('/api/admin/settings/diagnostic-inference', 'PATCH', {
      expectedVersion: 1,
      routing: { understand: 'local', compose: 'local' },
      local: { model: 'qwen-c' },
      note: 'Pin qwen-c for COMPOSE',
    }));
    expect(okRes.statusCode).toBe(200);
    expect(JSON.parse(okRes.body).diagnosticInference.version).toBe(2);
    const stale = await api.handler(event('/api/admin/settings/diagnostic-inference', 'PATCH', {
      expectedVersion: 1,
      routing: { understand: 'local', compose: 'local' },
    }));
    expect(stale.statusCode).toBe(409);
    expect(store.snapshot().local.model).toBe('qwen-c');
  });
  it('Jev GET/PATCH/test require admin', async () => {
    expect((await api.handler(event('/api/admin/settings/jev', 'PATCH', { expectedVersion: 1 }))).statusCode).toBe(401);
    expect((await api.handler(event('/api/admin/settings/jev/test', 'POST', {}))).statusCode).toBe(401);
  });
  it('admin can save Jev config write-only and test without receiving the token', async () => {
    api.setSessionForTests(async () => ({ isAdmin: true, email: 'admin@test' }));
    const store = memStore();
    const jev = memJev();
    api.setSettingsDepsForTests({
      loadConfigWithStatus: store.loadConfigWithStatus,
      saveConfig: store.saveConfig,
      isKeyConfigured: async () => false,
      loadJevWithStatus: jev.loadJevWithStatus,
      saveJevStored: jev.saveJevStored,
      getJevCredentials: async () => {
        const s = jev.snapshot();
        return s && s.apiToken ? { accountId: s.accountId, apiToken: s.apiToken, gatewayId: s.gatewayId } : null;
      },
      probeJev: async () => ({ status: 'ONLINE', connected: true, model: 'typesafe/jev', latencyMs: 42, errorCategory: null }),
      runningModels: runningLocal,
      partFinderHealthUrl: '',
    });
    const saved = await api.handler(event('/api/admin/settings/jev', 'PATCH', {
      expectedVersion: 1,
      accountId: 'cf-account',
      apiToken: 'write-only-secret',
      gatewayId: 'gw-1',
      note: 'Initial Jev configuration',
    }));
    expect(saved.statusCode).toBe(200);
    const body = JSON.parse(saved.body);
    expect(body.jev.credentialConfigured).toBe(true);
    expect(body.jev.accountId).toBe('cf-account');
    expect(body.jev.gatewayId).toBe('gw-1');
    expect(JSON.stringify(body)).not.toMatch(/write-only-secret|apiToken/);
    expect(jev.snapshot().apiToken).toBe('write-only-secret');
    const preserve = await api.handler(event('/api/admin/settings/jev', 'PATCH', {
      expectedVersion: 2,
      accountId: 'cf-account-2',
      apiToken: '',
      note: 'Move to the second account',
    }));
    expect(preserve.statusCode).toBe(200);
    expect(jev.snapshot().apiToken).toBe('write-only-secret');
    expect(jev.snapshot().accountId).toBe('cf-account-2');
    const testRes = await api.handler(event('/api/admin/settings/jev/test', 'POST', {}));
    expect(testRes.statusCode).toBe(200);
    const testBody = JSON.parse(testRes.body);
    expect(testBody.connected).toBe(true);
    expect(testBody.model).toBe('typesafe/jev');
    expect(testBody.latencyMs).toBe(42);
    expect(JSON.stringify(testBody)).not.toMatch(/write-only-secret|apiToken/);
  });
});
