/**
 * Settings Admin hardening — auth table derived from the router, validation, revision concurrency
 * (including the batch runner's unversioned writes), change reasons, audit, atomic single-document
 * writes, verify-after-write, read-only connection checks, secret handling and no writes on view.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const api = require('../index.js');
const ai = require('../ai-config.js');
const settings = require('../settings-admin.js');
const src = fs.readFileSync(path.join(here, '..', 'index.js'), 'utf8');

const ROUTES = Array.from(new Set(Array.from(src.matchAll(/path\.endsWith\('(\/admin\/(?:settings|ai-config)[a-z/_-]*)'\)/g)).map((m) => m[1]))).sort();
const METHODS = ['GET', 'POST', 'PATCH', 'PUT', 'DELETE'];
const SUPPORTED = {
  '/admin/ai-config': ['GET'],
  '/admin/ai-config/frontier-models': ['GET'],
  '/admin/ai-config/key': ['POST'],
  '/admin/ai-config/local-models': ['GET'],
  '/admin/ai-config/test-frontier': ['POST'],
  '/admin/ai-config/test-local': ['POST'],
  '/admin/settings': ['GET'],
  '/admin/settings/diagnostic-inference': ['PATCH'],
  '/admin/settings/jev': ['PATCH'],
  '/admin/settings/jev/test': ['POST'],
};
const ADMIN = async () => ({ username: 'a', email: 'admin@example.test', isAdmin: true });
const USER = async () => ({ username: 'u', email: 'user@example.test', isAdmin: false });
function ev(route, method, body) {
  const p = '/api' + route;
  return { rawPath: p, requestContext: { http: { method, path: p }, requestId: 'st' }, headers: {}, cookies: [], body: body === undefined ? '{}' : JSON.stringify(body) };
}
// Tripwire every Secrets-Manager-backed function the Settings handlers can reach.
const AI_FNS = ['loadConfig', 'loadConfigWithStatus', 'saveConfig', 'isKeyConfigured', 'saveKey', 'loadKeyMeta', 'getKey', 'loadJevWithStatus', 'saveJevStored', 'getJevCredentials', 'probeChat', 'probeJev', 'listLocalModels', 'listFrontierModels'];
const real = {}; AI_FNS.forEach((k) => { real[k] = ai[k]; });
let touched = [];
function tripwire() { AI_FNS.forEach((k) => { ai[k] = async () => { touched.push(k); throw new Error('store reached: ' + k); }; }); }
function restore() { AI_FNS.forEach((k) => { ai[k] = real[k]; }); }

function memStore(initial) {
  let cfg = ai.normalise(initial || ai.defaultConfig());
  const writes = [];
  return {
    writes,
    async loadConfigWithStatus() { return { cfg: JSON.parse(JSON.stringify(cfg)), status: 'ok' }; },
    async saveConfig(next) { writes.push(JSON.parse(JSON.stringify(next))); cfg = ai.normalise(JSON.parse(JSON.stringify(next))); },
    snapshot() { return cfg; },
    // What the batch test runner's applyConfig does: rewrite routing/models, no version/history bump.
    workerWrite(fn) { const c = JSON.parse(JSON.stringify(cfg)); fn(c); cfg = ai.normalise(c); },
  };
}
const runningNone = { available: false };
function deps(store, extra) {
  return Object.assign({ loadConfigWithStatus: store.loadConfigWithStatus, saveConfig: store.saveConfig, isKeyConfigured: async () => true, loadJevWithStatus: async () => ({ status: 'absent', stored: null, public: ai.defaultJevPublic() }), runningModels: runningNone, partFinderHealthUrl: '' }, extra || {});
}

afterEach(() => { restore(); api.setSessionForTests(null); api.setSettingsDepsForTests(null); });

describe('AUTH — every Settings / ai-config route (derived from the router)', () => {
  it('finds all routes', () => {
    expect(ROUTES).toEqual(Object.keys(SUPPORTED).sort());
  });
  for (const [label, session] of [['no session', null], ['non-admin session', USER]]) {
    it(label + ': every route × method is 401 or 405 and never reaches a secret', async () => {
      api.setSessionForTests(session);
      tripwire(); touched = [];
      for (const route of ROUTES) {
        const ok401 = [];
        for (const m of METHODS) {
          const r = await api.handler(ev(route, m));
          expect([401, 405], route + ' ' + m).toContain(r.statusCode);
          if (r.statusCode === 401) { ok401.push(m); expect(JSON.parse(r.body)).toEqual({ error: 'Unauthorized' }); }
          else expect(Object.keys(JSON.parse(r.body))).toEqual(['error']);
        }
        expect(ok401, route).toEqual(SUPPORTED[route]);
      }
      expect(touched).toEqual([]);
    });
  }
  it('the retired POST /admin/ai-config writer is 405 even for an admin, and writes nothing', async () => {
    api.setSessionForTests(ADMIN); tripwire(); touched = [];
    const r = await api.handler(ev('/admin/ai-config', 'POST', { routing: { compose: 'frontier' } }));
    expect(r.statusCode).toBe(405);
    expect(touched).toEqual([]);
  });
  it('admin requests log a real auth category', async () => {
    const lines = []; const orig = console.log; console.log = (x) => lines.push(String(x));
    try { api.setSessionForTests(USER); await api.handler(ev('/admin/settings', 'GET')); } finally { console.log = orig; }
    const l = lines.map((x) => { try { return JSON.parse(x); } catch { return null; } }).find((x) => x && x.evt === 'admin-api');
    expect(l).toMatchObject({ path: '/api/admin/settings', auth: 'forbidden', status: 401 });
  });
});

describe('VIEW — no writes on load; inventory, current vs default, timing, canonical', () => {
  it('GET /admin/settings performs no write of any kind', async () => {
    api.setSessionForTests(ADMIN);
    const store = memStore();
    let wrote = 0;
    api.setSettingsDepsForTests(deps(store, { saveConfig: async () => { wrote++; }, saveJevStored: async () => { wrote++; } }));
    ai.saveConfig = async () => { wrote++; }; ai.saveKey = async () => { wrote++; }; ai.saveJevStored = async () => { wrote++; };
    const r = await api.handler(ev('/admin/settings', 'GET', undefined));
    expect(r.statusCode).toBe(200);
    expect(wrote).toBe(0);
    const v = JSON.parse(r.body);
    expect(v.runtimeStatus.canonical).toMatchObject({ mode: expect.any(String) });
    expect(v.runtimeStatus.editable).toBe(false);
  });
  it('inventory maps every setting to a runtime consumer with current, default, timing and impact', async () => {
    const cfg = ai.normalise({ local: { enabled: true, model: 'gpt-5.6-terra' }, frontier: { model: 'gpt-5.6-terra' }, routing: { understand: 'local', compose: 'local' } });
    const v = await settings.buildView({ loadConfigWithStatus: async () => ({ cfg, status: 'ok' }), isKeyConfigured: async () => true, runningModels: runningNone, judgeModel: 'gpt-5.6-terra' });
    const inv = Object.fromEntries(v.diagnosticInference.settings.map((s) => [s.id, s]));
    expect(Object.keys(inv).sort()).toEqual(['frontier.enabled', 'frontier.model', 'jev.credential', 'local.enabled', 'local.endpoint', 'local.model', 'openai.credential', 'routing.compose', 'routing.understand'].sort());
    for (const s of Object.values(inv)) {
      expect(s.consumer, s.id).toBeTruthy(); expect(s.effect, s.id).toBeTruthy(); expect(s.impactText, s.id).toBeTruthy();
      expect('default' in s && 'current' in s && 'differsFromDefault' in s).toBe(true);
    }
    expect(inv['routing.compose']).toMatchObject({ impact: 'high', current: 'local', differsFromDefault: false, editable: true });
    expect(inv['routing.compose'].effect).toMatch(/2 minutes/);
    expect(inv['local.model']).toMatchObject({ impact: 'high', current: 'gpt-5.6-terra', differsFromDefault: true });
    expect(inv['routing.understand']).toMatchObject({ deprecated: true, editable: false, impact: 'none' });
    expect(inv['local.enabled']).toMatchObject({ deprecated: true, editable: false });
    expect(inv['frontier.enabled']).toMatchObject({ deprecated: true, editable: false });
  });
  it('the real pinned COMPOSE model id is shown (not hidden), with a warning when it looks like OpenAI', async () => {
    const cfg = ai.normalise({ local: { enabled: true, model: 'gpt-5.6-terra' }, frontier: { model: 'gpt-5.6-terra' }, routing: { understand: 'local', compose: 'local' } });
    const v = await settings.buildView({ loadConfigWithStatus: async () => ({ cfg, status: 'ok' }), isKeyConfigured: async () => true, runningModels: { available: true, compose: { available: true, provider: 'lmstudio', model: 'gpt-5.6-terra' }, understand: { available: false } }, judgeModel: 'gpt-5.6-terra' });
    expect(v.diagnosticInference.compose.configured.model).toBe('gpt-5.6-terra');
    expect(v.diagnosticInference.compose.configured.warning).toMatch(/looks like an OpenAI model name/);
    expect(v.diagnosticInference.compose.sync.status).toBe('in_sync');
    // describeSetup (Test page) is unchanged.
    expect(v.diagnosticInference.setup.compose.modelLabel).toBe('Model managed by LM Studio');
  });
});

describe('VALIDATION — server-side, authoritative', () => {
  const base = { expectedVersion: 1, note: 'valid reason' };
  for (const [name, body] of [
    ['bad model id', { local: { model: 'qwen 3; rm -rf' } }],
    ['too-long model', { frontier: { model: 'x'.repeat(121) } }],
    ['endpoint with credentials', { local: { endpoint: 'https://user:pass@lm.example' } }],
    ['endpoint non-http', { local: { endpoint: 'file:///etc/passwd' } }],
    ['endpoint metadata', { local: { endpoint: 'http://169.254.169.254/latest' } }],
    ['endpoint query', { local: { endpoint: 'https://lm.example/?x=1' } }],
    ['unknown provider', { routing: { compose: 'anthropic' } }],
    ['client-supplied actor', { byEmail: 'someone@else' }],
    ['malformed revision', { expectedRevision: 'nothex' }],
    ['short reason', { note: 'no', local: { model: 'qwen' } }],
  ]) {
    it('rejects ' + name, () => {
      expect(settings.parseInferencePatch(Object.assign({}, base, body)).ok).toBe(false);
    });
  }
  it('accepts a clean https endpoint and normal model ids', () => {
    expect(settings.parseInferencePatch(Object.assign({}, base, { local: { endpoint: 'https://lm.example:8443/', model: 'qwen/qwen3-8b@q4_k_m' } })).ok).toBe(true);
  });
  it('the legacy UNDERSTAND routing cannot be changed (it has no customer effect but can break COMPOSE)', async () => {
    const store = memStore();
    const r = await settings.saveInferencePatch(Object.assign(deps(store), { body: { expectedVersion: 1, note: 'try it', routing: { understand: 'frontier' }, frontier: { model: 'gpt-x' } } }));
    expect(r).toMatchObject({ ok: false, status: 400 });
    expect(store.writes).toEqual([]);
  });
  it('Jev ids are validated', () => {
    expect(settings.parseJevPatch({ expectedVersion: 1, accountId: 'bad id!' }).ok).toBe(false);
    expect(settings.parseJevPatch({ expectedVersion: 1, gatewayId: '../x' }).ok).toBe(false);
  });
});

describe('REASON — required for changes that alter live customer diagnosis', () => {
  it('COMPOSE model change while COMPOSE is Private AI needs a reason; nothing is written without it', async () => {
    const store = memStore();
    const r = await settings.saveInferencePatch(Object.assign(deps(store), { body: { expectedVersion: 1, local: { model: 'qwen-x' } } }));
    expect(r).toMatchObject({ ok: false, status: 400, code: 'reason_required' });
    expect(store.writes).toEqual([]);
  });
  it('the OpenAI model while COMPOSE is Private AI is not live-impacting (no reason needed)', async () => {
    const store = memStore();
    const r = await settings.saveInferencePatch(Object.assign(deps(store), { body: { expectedVersion: 1, frontier: { model: 'gpt-5.6-terra' } } }));
    expect(r.ok).toBe(true);
    expect(r.apply.liveImpact).toBe(false);
  });
  it('Jev changes always need a reason', async () => {
    let stored = { accountId: 'acc', apiToken: 'tok', gatewayId: null, version: 1 };
    const loadJev = async () => ({ status: 'ok', stored: JSON.parse(JSON.stringify(stored)), public: ai.toJevPublic(stored) });
    const r = await settings.saveJevPatch({ body: { expectedVersion: 1, accountId: 'acc2' }, loadJevWithStatus: loadJev, saveJevStored: async (n) => { stored = n; }, loadConfigWithStatus: memStore().loadConfigWithStatus, isKeyConfigured: async () => false, runningModels: runningNone });
    expect(r).toMatchObject({ ok: false, code: 'reason_required' });
    expect(stored.accountId).toBe('acc');
  });
});

describe('CONCURRENCY — stale pages get 409, including after an unversioned batch-runner write', () => {
  it('a batch-runner rewrite (no version bump) makes the old revision stale', async () => {
    const store = memStore();
    const v = await settings.buildView(deps(store));
    const rev = v.diagnosticInference.revision;
    store.workerWrite((c) => { c.local.model = 'gpt-5.6-terra'; }); // version still 1
    const r = await settings.saveInferencePatch(Object.assign(deps(store), { body: { expectedVersion: 1, expectedRevision: rev, local: { model: 'qwen' }, note: 'set the model' } }));
    expect(r).toMatchObject({ ok: false, status: 409, code: 'conflict' });
    expect(r.error).toMatch(/Settings changed since you opened this page/);
    expect(store.snapshot().local.model).toBe('gpt-5.6-terra');
  });
  it('verify-after-write detects a concurrent writer and reports 409 instead of success', async () => {
    const store = memStore();
    const rev = (await settings.buildView(deps(store))).diagnosticInference.revision;
    const r = await settings.saveInferencePatch(Object.assign(deps(store, {
      saveConfig: async (n) => { await store.saveConfig(n); store.workerWrite((c) => { c.routing.compose = 'local'; c.local.model = 'other'; }); },
    }), { body: { expectedVersion: 1, expectedRevision: rev, local: { model: 'qwen' }, note: 'set the model' } }));
    expect(r).toMatchObject({ ok: false, status: 409, code: 'concurrent_write' });
  });
  it('a storage failure is reported as not applied (503), never as success', async () => {
    const store = memStore();
    const r = await settings.saveInferencePatch(Object.assign(deps(store, { saveConfig: async () => { throw new Error('throttled'); } }), { body: { expectedVersion: 1, local: { model: 'qwen' }, note: 'set the model' } }));
    expect(r).toMatchObject({ ok: false, status: 503, code: 'store_failed' });
  });
  it('a no-op apply writes nothing', async () => {
    const store = memStore();
    const r = await settings.saveInferencePatch(Object.assign(deps(store), { body: { expectedVersion: 1, routing: { compose: 'local' }, local: { model: '' } } }));
    expect(r.ok).toBe(true);
    expect(r.apply.written).toBe(false);
    expect(store.writes).toEqual([]);
  });
});

describe('ATOMICITY + AUDIT', () => {
  it('one apply = one whole-document write carrying every changed field, with actor from the session', async () => {
    api.setSessionForTests(ADMIN);
    const store = memStore();
    api.setSettingsDepsForTests(deps(store));
    const v = JSON.parse((await api.handler(ev('/admin/settings', 'GET'))).body);
    const r = await api.handler(ev('/admin/settings/diagnostic-inference', 'PATCH', {
      expectedVersion: v.diagnosticInference.version, expectedRevision: v.diagnosticInference.revision,
      routing: { compose: 'frontier' }, frontier: { model: 'gpt-5.6-terra' }, note: 'Trial OpenAI COMPOSE',
    }));
    expect(r.statusCode).toBe(200);
    expect(store.writes.length).toBe(1);
    const w = store.writes[0];
    expect(w.routing.compose).toBe('frontier');
    expect(w.frontier).toMatchObject({ model: 'gpt-5.6-terra', enabled: true });
    expect(w.version).toBe(2);
    expect(w.history[0]).toMatchObject({ byEmail: 'admin@example.test', note: 'Trial OpenAI COMPOSE', version: 2 });
    expect(w.history[0].changes.map((c) => c.field).sort()).toEqual(['frontier.enabled', 'frontier.model', 'routing.compose']);
    expect(w.history[0].changes.find((c) => c.field === 'routing.compose')).toMatchObject({ from: 'local', to: 'frontier' });
    const body = JSON.parse(r.body);
    expect(body.apply).toMatchObject({ written: true, verified: true, liveImpact: true });
    expect(body.diagnosticInference.history[0]).toMatchObject({ byEmail: 'admin@example.test', note: 'Trial OpenAI COMPOSE' });
  });
  it('the history view shows from → to, endpoint as host only', () => {
    const h = settings.historyView([{ at: 't', byEmail: 'a', previous: ai.auditable(ai.normalise({})), next: ai.auditable(ai.normalise({ local: { endpoint: 'https://lm.internal.example:9000/secret-path' } })) }]);
    expect(h[0].changes).toEqual([{ field: 'local.endpoint', label: 'Private AI endpoint override', from: '(deployed default)', to: 'lm.internal.example:9000' }]);
  });
  it('a settings-change audit line is logged with actor and fields, never secret values', async () => {
    api.setSessionForTests(ADMIN);
    const store = memStore();
    api.setSettingsDepsForTests(deps(store));
    const lines = []; const orig = console.log; console.log = (x) => lines.push(String(x));
    try {
      await api.handler(ev('/admin/settings/diagnostic-inference', 'PATCH', { expectedVersion: 1, local: { model: 'qwen-z' }, note: 'Pin qwen-z' }));
    } finally { console.log = orig; }
    const l = lines.map((x) => { try { return JSON.parse(x); } catch { return null; } }).find((x) => x && x.evt === 'settings-change');
    expect(l).toMatchObject({ kind: 'diagnostic-inference', by: 'admin@example.test', fields: ['local.model'], version: 2, verified: true });
  });
  it('Jev history records identifiers and whether the token was replaced — never the token', async () => {
    let stored = { accountId: 'acc', apiToken: 'old-secret-token', gatewayId: null, version: 1 };
    const loadJev = async () => ({ status: 'ok', stored: JSON.parse(JSON.stringify(stored)), public: ai.toJevPublic(stored) });
    const r = await settings.saveJevPatch({ body: { expectedVersion: 1, accountId: 'acc2', apiToken: 'new-secret-token', note: 'Move account' }, byEmail: 'admin@example.test', loadJevWithStatus: loadJev, saveJevStored: async (n) => { stored = n; }, loadConfigWithStatus: memStore().loadConfigWithStatus, isKeyConfigured: async () => false, runningModels: runningNone });
    expect(r.ok).toBe(true);
    expect(r.apply).toMatchObject({ written: true, verified: true });
    expect(stored.history[0]).toMatchObject({ byEmail: 'admin@example.test', note: 'Move account', tokenReplaced: true, accountId: { from: 'acc', to: 'acc2' } });
    expect(JSON.stringify(ai.jevSecretPayload(stored).history)).not.toMatch(/secret-token/);
    expect(JSON.stringify(r.view)).not.toMatch(/secret-token|apiToken/);
    expect(r.view.jev.history[0]).toMatchObject({ tokenReplaced: true, note: 'Move account' });
  });
});

describe('SECRETS + READ-ONLY ACTIONS', () => {
  it('OpenAI key save records who/when, never echoes or logs the key', async () => {
    api.setSessionForTests(ADMIN);
    let saved = null;
    ai.saveKey = async (k, by) => { saved = { k, by }; return { at: '2026-10-03T00:00:00.000Z' }; };
    const lines = []; const orig = console.log; console.log = (x) => lines.push(String(x));
    let r;
    try { r = await api.handler(ev('/admin/ai-config/key', 'POST', { apiKey: 'sk-test-SECRETVALUE1234567890' })); } finally { console.log = orig; }
    expect(r.statusCode).toBe(200);
    expect(JSON.parse(r.body)).toEqual({ configured: true, updatedAt: '2026-10-03T00:00:00.000Z' });
    expect(saved).toEqual({ k: 'sk-test-SECRETVALUE1234567890', by: 'admin@example.test' });
    expect(lines.join('\n')).not.toContain('SECRETVALUE');
    expect(lines.join('\n')).toContain('"evt":"settings-change"');
  });
  it('connection checks never write the live config and ignore caller-supplied endpoints/models', async () => {
    api.setSessionForTests(ADMIN);
    const calls = []; let wrote = 0;
    ai.loadConfig = async () => ai.normalise({ local: { endpoint: '', model: 'qwen' }, frontier: { model: 'gpt-5.6-terra' } });
    ai.saveConfig = async () => { wrote++; };
    ai.getKey = async () => 'sk-x';
    ai.probeChat = async (o) => { calls.push(o.url + '|' + (o.model || '')); return { status: 'ONLINE', latencyMs: 5 }; };
    const prev = process.env.LM_STUDIO_URL; process.env.LM_STUDIO_URL = 'https://lm.deployed.example';
    try {
      await api.handler(ev('/admin/ai-config/test-local', 'POST', { endpoint: 'http://169.254.169.254', model: 'evil' }));
      await api.handler(ev('/admin/ai-config/test-frontier', 'POST', { model: 'evil' }));
    } finally { if (prev === undefined) delete process.env.LM_STUDIO_URL; else process.env.LM_STUDIO_URL = prev; }
    expect(wrote).toBe(0);
    expect(calls[0]).toBe('https://lm.deployed.example/v1/chat/completions|qwen');
    expect(calls[1]).toMatch(/\/chat\/completions\|gpt-5\.6-terra$/);
  });
  it('the Settings view never contains secret values', async () => {
    const v = await settings.buildView({ loadConfigWithStatus: async () => ({ cfg: ai.normalise({ local: { endpoint: 'https://lm.example/private' } }), status: 'ok' }), isKeyConfigured: async () => true, runningModels: runningNone,
      loadJevWithStatus: async () => ({ status: 'ok', stored: { accountId: 'acc', apiToken: 'jev-SECRET' }, public: ai.toJevPublic({ accountId: 'acc', apiToken: 'jev-SECRET' }) }) });
    const s = JSON.stringify(v);
    expect(s).not.toMatch(/jev-SECRET|apiKey|apiToken|sk-/);
    expect(s).not.toContain('/private'); // endpoint shown as host only
  });
});
