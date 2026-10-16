/**
 * Settings admin view-model and mutation contract (settings-admin.js): the advisor's model is the one editable
 * setting; everything else is shown read-only, and no secret ever reaches the view.
 *
 *   npx vitest run services/whichpart-api/test/settings-admin.test.mjs
 */
import { describe, it, expect, afterEach } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const settings = require('../settings-admin.js');
const ai = require('../ai-config.js');
const api = require('../index.js');

function event(path, method, body) {
  return { rawPath: path, requestContext: { http: { method, path }, requestId: 't' }, headers: {}, cookies: [], body: body ? JSON.stringify(body) : '' };
}
function memStore(initial) {
  let cfg = ai.normalise(initial || ai.defaultConfig());
  const writes = [];
  return {
    writes,
    async loadConfigWithStatus() { return { cfg: JSON.parse(JSON.stringify(cfg)), status: 'ok' }; },
    async saveConfig(next) { writes.push(JSON.parse(JSON.stringify(next))); cfg = ai.normalise(JSON.parse(JSON.stringify(next))); },
    snapshot() { return cfg; },
  };
}
const NOSLEEP = { sleep: async () => {}, attempts: 3, delayMs: 0 };
const running = (model) => ({ available: true, provider: 'anthropic', model });
function deps(store, extra) {
  return Object.assign({ loadConfigWithStatus: store.loadConfigWithStatus, saveConfig: store.saveConfig, isKeyConfigured: async () => true,
    runningModels: { available: false, reason: 'down' }, engineHealthUrl: '', readBack: NOSLEEP, byEmail: 'admin@example.test' }, extra || {});
}

describe('view model', () => {
  it('shows the advisor as the one editable setting, with its source, store status and propagation', async () => {
    const view = await settings.buildView(deps(memStore({ model: 'claude-opus-5-5', version: 3 }), { runningModels: running('claude-opus-5-5') }));
    expect(view.advisor).toMatchObject({ editable: true, source: 'Admin runtime configuration', version: 3, store: { status: 'ok', note: null },
      configured: { provider: 'anthropic', providerLabel: 'Anthropic (Claude)', model: 'claude-opus-5-5', credentialConfigured: true },
      running: { available: true, model: 'claude-opus-5-5' }, sync: { status: 'in_sync' }, credential: { configured: true } });
    expect(view.advisor.revision).toMatch(/^[0-9a-f]{16}$/);
    expect(view.advisor.propagation.maxMs).toBe(120000);
    expect(view.runtimeStatus).toMatchObject({ editable: false, architecture: 'ac2' });
    expect(view.transcripts.editable).toBe(false);
    expect(view.conversation).toMatchObject({ editable: false, windowTurns: 12 });
    expect(view.elsewhere.some((e) => e.href === '#media')).toBe(true);
    expect(view.elsewhere.some((e) => e.href === '#mcp')).toBe(true);
    expect(view).not.toHaveProperty('diagnosticInference');
    expect(view).not.toHaveProperty('jev');
    expect(view).not.toHaveProperty('productionReview');
  });
  it('never returns secrets, routing or env dumps', async () => {
    const view = await settings.buildView(deps(memStore({ model: 'claude-opus-5-5' })));
    const s = JSON.stringify(view);
    expect(s).not.toMatch(/apiKey|anthropicApiKey|apiToken|sk-|AKIA|Bearer |MCP_BEARER|password|process\.env/i);
    expect(s).not.toMatch(/routing|frontier|lmstudio|qwen|jev/i);
  });
  it('marks the running value unverifiable when the diagnosis engine is silent, mismatch when it runs another model', async () => {
    const silent = await settings.buildView(deps(memStore({ model: 'a' })));
    expect(silent.advisor.sync.status).toBe('unverifiable');
    expect(silent.advisor.running.available).toBe(false);
    const other = await settings.buildView(deps(memStore({ model: 'a' }), { runningModels: running('b') }));
    expect(other.advisor.sync.status).toBe('mismatch');
  });
  it('a model stored by the earlier document shape (frontier.model) is read as the advisor model', async () => {
    const view = await settings.buildView(deps(memStore({ routing: { compose: 'frontier' }, frontier: { model: 'claude-x' }, version: 7 })));
    expect(view.advisor.configured.model).toBe('claude-x');
    expect(view.advisor.version).toBe(7);
  });
  it('surfaces an absent store as defaults without claiming a live save', async () => {
    const view = await settings.buildView(Object.assign(deps(memStore()), { loadConfigWithStatus: async () => ({ cfg: ai.defaultConfig(), status: 'absent' }) }));
    expect(view.advisor.store.status).toBe('absent');
    expect(view.advisor.store.note).toMatch(/no model is set/i);
    expect(view.advisor.configured.modelLabel).toBe('Model not set');
  });
});

describe('patch validation', () => {
  const base = { expectedVersion: 1, model: 'claude-opus-5-5', note: 'valid reason' };
  it('accepts a model id with a reason', () => {
    expect(settings.parseModelPatch(base)).toMatchObject({ ok: true, model: 'claude-opus-5-5', note: 'valid reason', expectedRevision: null });
  });
  for (const [name, body] of [
    ['bad model id', { model: 'claude 3; rm -rf' }],
    ['too-long model', { model: 'x'.repeat(121) }],
    ['empty model', { model: '' }],
    ['unknown setting', { temperature: 0.2 }],
    ['routing', { routing: { compose: 'frontier' } }],
    ['secret field', { apiKey: 'sk-secret' }],
    ['credential field', { anthropicApiKey: 'sk-secret' }],
    ['client-supplied actor', { byEmail: 'someone@else' }],
    ['malformed revision', { expectedRevision: 'nothex' }],
    ['short reason', { note: 'no' }],
    ['missing expectedVersion', { expectedVersion: undefined }],
  ]) {
    it('rejects ' + name, () => {
      const r = settings.parseModelPatch(Object.assign({}, base, body));
      expect(r.ok).toBe(false);
      expect(r.status).toBe(400);
    });
  }
  it('rejects a non-object body', () => {
    expect(settings.parseModelPatch([1, 2]).ok).toBe(false);
    expect(settings.parseModelPatch(null).ok).toBe(false);
  });
});

describe('persistence and conflict', () => {
  it('saves one whole document with history, bumps the version and verifies the write', async () => {
    const store = memStore({ model: 'old-model' });
    const rev = (await settings.buildView(deps(store))).advisor.revision;
    const r = await settings.saveModelPatch(Object.assign(deps(store), { body: { expectedVersion: 1, expectedRevision: rev, model: 'claude-opus-5-5', note: 'Move to Opus' } }));
    expect(r.ok).toBe(true);
    expect(r.apply).toMatchObject({ written: true, verified: true, verification: 'verified', liveImpact: true, version: 2, changed: [{ field: 'model', from: 'old-model', to: 'claude-opus-5-5' }] });
    expect(store.writes).toHaveLength(1);
    const w = store.writes[0];
    expect(w).toMatchObject({ model: 'claude-opus-5-5', version: 2, updatedByEmail: 'admin@example.test' });
    expect(w.history[0]).toMatchObject({ byEmail: 'admin@example.test', note: 'Move to Opus', version: 2, fromRevision: rev, changes: [{ field: 'model', to: 'claude-opus-5-5' }] });
    expect(r.view.advisor).toMatchObject({ version: 2, configured: { model: 'claude-opus-5-5' } });
    expect(r.view.advisor.history[0]).toMatchObject({ note: 'Move to Opus', changes: [{ field: 'model', label: 'Advisor model', from: 'old-model', to: 'claude-opus-5-5' }] });
  });
  it('a change needs a reason; nothing is written without it', async () => {
    const store = memStore({ model: 'old-model' });
    const r = await settings.saveModelPatch(Object.assign(deps(store), { body: { expectedVersion: 1, model: 'claude-opus-5-5' } }));
    expect(r).toMatchObject({ ok: false, status: 400, code: 'reason_required' });
    expect(store.writes).toEqual([]);
  });
  it('a no-op apply writes nothing and needs no reason', async () => {
    const store = memStore({ model: 'same' });
    const r = await settings.saveModelPatch(Object.assign(deps(store), { body: { expectedVersion: 1, model: 'same' } }));
    expect(r.ok).toBe(true);
    expect(r.apply.written).toBe(false);
    expect(store.writes).toEqual([]);
  });
  it('a stale version or revision is a 409 before anything is written', async () => {
    const store = memStore({ model: 'a', version: 4 });
    const stale = await settings.saveModelPatch(Object.assign(deps(store), { body: { expectedVersion: 1, model: 'b', note: 'set the model' } }));
    expect(stale).toMatchObject({ ok: false, status: 409, code: 'conflict', currentVersion: 4 });
    const badRev = await settings.saveModelPatch(Object.assign(deps(store), { body: { expectedVersion: 4, expectedRevision: '0123456789abcdef', model: 'b', note: 'set the model' } }));
    expect(badRev).toMatchObject({ ok: false, status: 409, code: 'conflict' });
    expect(store.writes).toEqual([]);
  });
  it('an unversioned rewrite by another writer (same version, other content) makes the page stale', async () => {
    const store = memStore({ model: 'a' });
    const rev = (await settings.buildView(deps(store))).advisor.revision;
    store.snapshot().model = 'written-elsewhere';
    const r = await settings.saveModelPatch(Object.assign(deps(store), { body: { expectedVersion: 1, expectedRevision: rev, model: 'b', note: 'set the model' } }));
    expect(r).toMatchObject({ ok: false, status: 409, code: 'conflict' });
    expect(store.snapshot().model).toBe('written-elsewhere');
  });
  it('an unavailable store is a 503 and a failed write is store_failed', async () => {
    const down = await settings.saveModelPatch(Object.assign(deps(memStore()), { loadConfigWithStatus: async () => ({ cfg: ai.defaultConfig(), status: 'unavailable' }), body: { expectedVersion: 1, model: 'b', note: 'set the model' } }));
    expect(down.status).toBe(503);
    const store = memStore();
    const failed = await settings.saveModelPatch(Object.assign(deps(store, { saveConfig: async () => { throw new Error('throttled'); } }), { body: { expectedVersion: 1, model: 'b', note: 'set the model' } }));
    expect(failed).toMatchObject({ ok: false, status: 503, code: 'store_failed' });
  });
});

describe('read-after-write (config-readback.js): Secrets Manager reads are eventually consistent', () => {
  function ecStore({ stale = 0, afterSave = null, readFail = 0 } = {}) {
    let cfg = ai.normalise(ai.defaultConfig()); let prev = null; let staleLeft = 0; let failLeft = readFail; const writes = [];
    return {
      writes,
      async loadConfigWithStatus() {
        if (writes.length && failLeft > 0) { failLeft--; return { cfg: ai.defaultConfig(), status: 'unavailable' }; }
        if (staleLeft > 0 && prev) { staleLeft--; return { cfg: JSON.parse(JSON.stringify(prev)), status: 'ok' }; }
        return { cfg: JSON.parse(JSON.stringify(cfg)), status: 'ok' };
      },
      async saveConfig(next) {
        writes.push(JSON.parse(JSON.stringify(next))); prev = cfg; staleLeft = stale; cfg = ai.normalise(JSON.parse(JSON.stringify(next)));
        if (afterSave) { const c = JSON.parse(JSON.stringify(cfg)); afterSave(c); cfg = ai.normalise(c); prev = cfg; staleLeft = 0; }
      },
    };
  }
  const apply = (store, extra) => settings.saveModelPatch(Object.assign(deps(store, extra), { readBack: { ...NOSLEEP, attempts: 8 }, body: { expectedVersion: 1, model: 'claude-opus-5-5', note: 'set the model' } }));
  it('old revision for a few reads, then the new one → verified, one write', async () => {
    const r = await apply(ecStore({ stale: 3 }));
    expect(r.ok).toBe(true);
    expect(r.apply).toMatchObject({ written: true, verified: true, verification: 'verified' });
  });
  it('old revision for the whole window → written but not_visible, never a 409', async () => {
    const r = await apply(ecStore({ stale: 100 }));
    expect(r).toMatchObject({ ok: true, status: 200 });
    expect(r.apply).toMatchObject({ written: true, verified: false, verification: 'not_visible' });
    expect(r.apply.verificationNote).toMatch(/accepted the change/);
  });
  it('a different revision appears → 409 concurrent_write, at once', async () => {
    const r = await apply(ecStore({ afterSave: (c) => { c.model = 'other-writer'; } }));
    expect(r).toMatchObject({ ok: false, status: 409, code: 'concurrent_write' });
  });
  it('the store cannot be read back → written, verification read_failed', async () => {
    const r = await apply(ecStore({ readFail: 100 }));
    expect(r.apply).toMatchObject({ written: true, verified: false, verification: 'read_failed' });
  });
});

describe('connection check and running model', () => {
  it('uses the stored credential and model only, and reports CONFIG when the credential is missing', async () => {
    const calls = [];
    const probe = async (o) => { calls.push(o); return { status: 'ONLINE', latencyMs: 5 }; };
    const r = await settings.testConnection({ loadConfig: async () => ai.normalise({ model: 'claude-opus-5-5' }), getKey: async () => 'sk-x', probeModel: probe });
    expect(r.status).toBe('ONLINE');
    expect(calls[0]).toMatchObject({ key: 'sk-x', model: 'claude-opus-5-5' });
    const missing = await ai.probeModel({ key: null, model: 'm' });
    expect(missing).toMatchObject({ status: 'CONFIG_ERROR' });
  });
  it('probeModel asks the Messages API for the model and classifies the answer, never returning the key', async () => {
    const seen = [];
    const f = async (url, init) => { seen.push([url, init.headers['x-api-key']]); return { ok: false, status: 404, json: async () => ({}) }; };
    const r = await ai.probeModel({ key: 'sk-secret', model: 'claude-x', fetch: f });
    expect(r).toMatchObject({ status: 'MODEL_ERROR', detail: 'Model not found' });
    expect(seen[0][0]).toBe('https://api.anthropic.com/v1/models/claude-x');
    expect(seen[0][1]).toBe('sk-secret');
    expect(JSON.stringify(r)).not.toContain('sk-secret');
    expect((await ai.probeModel({ key: 'k', model: 'm', fetch: async () => ({ ok: false, status: 401 }) })).status).toBe('CONFIG_ERROR');
    expect((await ai.probeModel({ key: 'k', model: 'm', fetch: async () => { throw new Error('ECONNRESET'); } })).status).toBe('OFFLINE');
  });
  it('reads the running model from the engine health', async () => {
    const health = { status: 'ok', service: 'diagnosis-engine', diagnosis: { architecture: 'ac2' }, models: { reasoner: { configured: true, provider: 'anthropic', model: 'claude-x' }, inferenceTested: false } };
    const r = await settings.probeEngineModels({ engineHealthUrl: 'https://engine.example/', fetch: async () => ({ ok: true, json: async () => health }) });
    expect(r).toEqual({ available: true, provider: 'anthropic', model: 'claude-x' });
    const none = await settings.probeEngineModels({ engineHealthUrl: 'https://engine.example/', fetch: async () => ({ ok: true, json: async () => ({ models: { reasoner: { configured: false } } }) }) });
    expect(none.available).toBe(false);
  });
});

describe('HTTP', () => {
  afterEach(() => { api.setSessionForTests(null); api.setSettingsDepsForTests(null); });
  it('GET and PATCH require admin', async () => {
    expect((await api.handler(event('/api/admin/settings', 'GET'))).statusCode).toBe(401);
    expect((await api.handler(event('/api/admin/settings/model', 'PATCH', { expectedVersion: 1 }))).statusCode).toBe(401);
  });
  it('admin GET returns the view model without secrets; PATCH persists and rejects a stale version', async () => {
    api.setSessionForTests(async () => ({ isAdmin: true, email: 'admin@test' }));
    const store = memStore({ model: 'old' });
    api.setSettingsDepsForTests({ loadConfigWithStatus: store.loadConfigWithStatus, saveConfig: store.saveConfig, isKeyConfigured: async () => true, runningModels: running('old'), engineHealthUrl: '', readBack: NOSLEEP });
    const res = await api.handler(event('/api/admin/settings', 'GET'));
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.advisor.configured).toMatchObject({ model: 'old', credentialConfigured: true });
    expect(res.body).not.toMatch(/apiKey|anthropicApiKey|sk-/);
    const okRes = await api.handler(event('/api/admin/settings/model', 'PATCH', { expectedVersion: 1, expectedRevision: body.advisor.revision, model: 'claude-opus-5-5', note: 'Move to Opus' }));
    expect(okRes.statusCode).toBe(200);
    const saved = JSON.parse(okRes.body);
    expect(saved.advisor.version).toBe(2);
    expect(saved.apply).toMatchObject({ written: true, verified: true });
    expect(saved.advisor.history[0]).toMatchObject({ byEmail: 'admin@test', note: 'Move to Opus' });
    const stale = await api.handler(event('/api/admin/settings/model', 'PATCH', { expectedVersion: 1, model: 'other', note: 'stale page' }));
    expect(stale.statusCode).toBe(409);
    expect(store.snapshot().model).toBe('claude-opus-5-5');
  });
});
