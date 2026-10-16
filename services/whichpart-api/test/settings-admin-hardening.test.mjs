/**
 * Settings Admin hardening — auth table derived from the router, atomic single-document writes with audit, no writes
 * on view, secret handling (the credential is write-only, never echoed or logged) and read-only connection checks.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const api = require('../index.js');
const ai = require('../ai-config.js');
const src = require('./api-source.cjs')();

const ROUTES = Array.from(new Set(Array.from(src.matchAll(/path\.endsWith\('(\/admin\/(?:settings|ai-config)[a-z/_-]*)'\)/g)).map((m) => m[1]))).sort();
const METHODS = ['GET', 'POST', 'PATCH', 'PUT', 'DELETE'];
const SUPPORTED = {
  '/admin/ai-config/key': ['POST'],
  '/admin/ai-config/models': ['GET'],
  '/admin/ai-config/test': ['POST'],
  '/admin/settings': ['GET'],
  '/admin/settings/model': ['PATCH'],
};
const ADMIN = async () => ({ username: 'a', email: 'admin@example.test', isAdmin: true });
const USER = async () => ({ username: 'u', email: 'user@example.test', isAdmin: false });
function ev(route, method, body) {
  const p = '/api' + route;
  return { rawPath: p, requestContext: { http: { method, path: p }, requestId: 'st' }, headers: {}, cookies: [], body: body === undefined ? '{}' : (typeof body === 'string' ? body : JSON.stringify(body)) };
}
// Tripwire every Secrets-Manager-backed function the Settings handlers can reach.
const AI_FNS = ['loadConfig', 'loadConfigWithStatus', 'saveConfig', 'isKeyConfigured', 'saveKey', 'loadKeyMeta', 'getKey', 'probeModel', 'listModels'];
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
  };
}
const NOSLEEP = { sleep: async () => {}, attempts: 3, delayMs: 0 };
function deps(store, extra) {
  return Object.assign({ loadConfigWithStatus: store.loadConfigWithStatus, saveConfig: store.saveConfig, isKeyConfigured: async () => true, runningModels: { available: false }, engineHealthUrl: '', readBack: NOSLEEP }, extra || {});
}

afterEach(() => { restore(); api.setSessionForTests(null); api.setSettingsDepsForTests(null); });

describe('AUTH — every Settings / ai-config route (derived from the router)', () => {
  it('finds all routes: the model, the credential, the connection check and the model list', () => {
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
  it('the retired routing, Jev and provider-test routes are a 404 even for an admin, and reach no secret', async () => {
    api.setSessionForTests(ADMIN); tripwire(); touched = [];
    for (const [route, m] of [['/admin/ai-config', 'GET'], ['/admin/ai-config', 'POST'], ['/admin/settings/diagnostic-inference', 'PATCH'], ['/admin/settings/jev', 'PATCH'],
      ['/admin/settings/jev/test', 'POST'], ['/admin/ai-config/test-local', 'POST'], ['/admin/ai-config/test-frontier', 'POST'], ['/admin/ai-config/local-models', 'GET'], ['/admin/ai-config/frontier-models', 'GET']]) {
      const r = await api.handler(ev(route, m, { routing: { compose: 'frontier' }, expectedVersion: 1 }));
      expect(r.statusCode, route + ' ' + m).toBe(404);
    }
    expect(touched).toEqual([]);
  });
  it('admin requests log a real auth category', async () => {
    const lines = []; const orig = console.log; console.log = (x) => lines.push(String(x));
    try { api.setSessionForTests(USER); await api.handler(ev('/admin/settings', 'GET')); } finally { console.log = orig; }
    const l = lines.map((x) => { try { return JSON.parse(x); } catch { return null; } }).find((x) => x && x.evt === 'admin-api');
    expect(l).toMatchObject({ path: '/api/admin/settings', auth: 'forbidden', status: 401 });
  });
  it('an unexpected store failure is a clean JSON 500 with no internal detail', async () => {
    api.setSessionForTests(ADMIN);
    api.setSettingsDepsForTests(deps(memStore(), { loadConfigWithStatus: async () => { throw new Error('AccessDeniedException: arn:aws:secretsmanager:eu-west-1:1234'); } }));
    const r = await api.handler(ev('/admin/settings', 'GET'));
    expect(r.statusCode).toBe(500);
    expect(JSON.parse(r.body)).toEqual({ error: 'The settings service could not complete this request. Reload to confirm the current values.' });
    expect(r.body).not.toMatch(/arn:aws|AccessDenied/);
  });
});

describe('VIEW — no writes on load', () => {
  it('GET /admin/settings performs no write of any kind', async () => {
    api.setSessionForTests(ADMIN);
    const store = memStore({ model: 'claude-opus-5-5' });
    let wrote = 0;
    api.setSettingsDepsForTests(deps(store, { saveConfig: async () => { wrote++; } }));
    ai.saveConfig = async () => { wrote++; }; ai.saveKey = async () => { wrote++; };
    const r = await api.handler(ev('/admin/settings', 'GET', undefined));
    expect(r.statusCode).toBe(200);
    expect(wrote).toBe(0);
    const v = JSON.parse(r.body);
    expect(v.runtimeStatus).toMatchObject({ editable: false, architecture: 'ac2' });
    expect(v.advisor.configured.model).toBe('claude-opus-5-5');
  });
});

describe('ATOMICITY + AUDIT', () => {
  it('one apply = one whole-document write carrying the change, with the actor from the session, and an audit line', async () => {
    api.setSessionForTests(ADMIN);
    const store = memStore({ model: 'old' });
    api.setSettingsDepsForTests(deps(store));
    const v = JSON.parse((await api.handler(ev('/admin/settings', 'GET'))).body);
    const lines = []; const orig = console.log; console.log = (x) => lines.push(String(x));
    let r;
    try {
      r = await api.handler(ev('/admin/settings/model', 'PATCH', { expectedVersion: v.advisor.version, expectedRevision: v.advisor.revision, model: 'claude-opus-5-5', note: 'Move to Opus' }));
    } finally { console.log = orig; }
    expect(r.statusCode).toBe(200);
    expect(store.writes.length).toBe(1);
    const w = store.writes[0];
    expect(w).toMatchObject({ model: 'claude-opus-5-5', version: 2 });
    expect(w.history[0]).toMatchObject({ byEmail: 'admin@example.test', note: 'Move to Opus', version: 2, changes: [{ field: 'model', from: 'old', to: 'claude-opus-5-5' }] });
    const body = JSON.parse(r.body);
    expect(body.apply).toMatchObject({ written: true, verified: true, liveImpact: true });
    const l = lines.map((x) => { try { return JSON.parse(x); } catch { return null; } }).find((x) => x && x.evt === 'settings-change');
    expect(l).toMatchObject({ kind: 'model', by: 'admin@example.test', fields: ['model'], version: 2, verified: true });
  });
  it('a body with a credential field, an unknown field or invalid JSON is a 400 and writes nothing', async () => {
    api.setSessionForTests(ADMIN);
    const store = memStore({ model: 'old' });
    api.setSettingsDepsForTests(deps(store));
    for (const body of [{ expectedVersion: 1, model: 'x', note: 'valid reason', apiKey: 'sk-1' }, { expectedVersion: 1, model: 'x', note: 'valid reason', routing: {} }, '{not json', '[1,2]']) {
      expect((await api.handler(ev('/admin/settings/model', 'PATCH', body))).statusCode).toBe(400);
    }
    expect(store.writes).toEqual([]);
  });
  it('caps request bodies (413) before the handler runs', async () => {
    api.setSessionForTests(ADMIN);
    tripwire(); touched = [];
    const r = await api.handler(ev('/admin/settings/model', 'PATCH', { expectedVersion: 1, model: 'x', note: 'y'.repeat(20 * 1024) }));
    expect(r.statusCode).toBe(413);
    expect(touched).toEqual([]);
  });
});

describe('SECRETS + READ-ONLY ACTIONS', () => {
  it('credential save records who/when, never echoes or logs the key; a blank value does not delete', async () => {
    api.setSessionForTests(ADMIN);
    let saved = null;
    api.setSettingsDepsForTests({ saveKey: async (k, by) => { saved = { k, by }; return { at: '2026-10-03T00:00:00.000Z' }; } });
    const lines = []; const orig = console.log; console.log = (x) => lines.push(String(x));
    let r; let blank;
    try {
      r = await api.handler(ev('/admin/ai-config/key', 'POST', { apiKey: 'sk-test-SECRETVALUE1234567890' }));
      blank = await api.handler(ev('/admin/ai-config/key', 'POST', { apiKey: '' }));
    } finally { console.log = orig; }
    expect(r.statusCode).toBe(200);
    expect(JSON.parse(r.body)).toEqual({ configured: true, updatedAt: '2026-10-03T00:00:00.000Z' });
    expect(saved).toEqual({ k: 'sk-test-SECRETVALUE1234567890', by: 'admin@example.test' });
    expect(blank.statusCode).toBe(400);
    expect(lines.join('\n')).not.toContain('SECRETVALUE');
    expect(lines.join('\n')).toContain('"evt":"settings-change"');
  });
  it('the connection check never writes and ignores caller-supplied models and keys', async () => {
    api.setSessionForTests(ADMIN);
    const calls = []; let wrote = 0;
    api.setSettingsDepsForTests({
      loadConfig: async () => ai.normalise({ model: 'claude-opus-5-5' }), getKey: async () => 'sk-stored', saveConfig: async () => { wrote++; },
      probeModel: async (o) => { calls.push({ key: o.key, model: o.model }); return { status: 'ONLINE', latencyMs: 5 }; },
    });
    ai.saveConfig = async () => { wrote++; }; ai.saveKey = async () => { wrote++; };
    const r = await api.handler(ev('/admin/ai-config/test', 'POST', { model: 'evil', apiKey: 'sk-evil' }));
    expect(r.statusCode).toBe(200);
    expect(JSON.parse(r.body)).toEqual({ status: 'ONLINE', latencyMs: 5 });
    expect(calls).toEqual([{ key: 'sk-stored', model: 'claude-opus-5-5' }]);
    expect(wrote).toBe(0);
    expect(r.body).not.toContain('sk-stored');
  });
  it('the model list uses the stored key and returns ids only', async () => {
    api.setSessionForTests(ADMIN);
    api.setSettingsDepsForTests({ getKey: async () => 'sk-stored', listModels: async ({ key }) => ({ ok: true, configured: Boolean(key), models: ['claude-a', 'claude-b'] }) });
    const r = await api.handler(ev('/admin/ai-config/models', 'GET'));
    expect(JSON.parse(r.body)).toEqual({ ok: true, configured: true, models: ['claude-a', 'claude-b'] });
    expect(r.body).not.toContain('sk-stored');
    const none = await ai.listModels({ key: null });
    expect(none).toEqual({ ok: false, configured: false, models: [] });
  });
  it('the Settings view never contains secret values or the retired provider settings', async () => {
    api.setSessionForTests(ADMIN);
    api.setSettingsDepsForTests(deps(memStore({ model: 'claude-opus-5-5', frontier: { apiKey: 'sk-planted' } }), { loadKeyMeta: async () => ({ configured: true, updatedAt: 't', updatedByEmail: 'x@y', history: [{ at: 't', byEmail: 'x@y', replaced: false }] }) }));
    const r = await api.handler(ev('/admin/settings', 'GET'));
    expect(r.body).not.toMatch(/sk-planted|apiKey|anthropicApiKey|jev|lmstudio|frontier|routing/i);
    expect(JSON.parse(r.body).advisor.credential).toMatchObject({ configured: true, updatedByEmail: 'x@y' });
  });
});
