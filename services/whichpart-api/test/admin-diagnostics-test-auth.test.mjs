/**
 * Diagnostics Admin API — auth table derived from the router, method hygiene, read-only diagnostics, and the admin
 * request log. For every route × method: no session → 401 (or 405 for an unsupported method), non-admin session →
 * 401, and the AI-config secret is NEVER reached — tripwires throw on any call. The retired Test area
 * (/admin/library, /admin/benchmark) is a 404 for everyone (ADR 0023).
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const api = require('../index.js');
const aiConfig = require('../ai-config.js');
const mediaAdmin = require('../media-admin.js');
const src = require('./api-source.cjs')();

const ROUTES = Array.from(new Set(Array.from(src.matchAll(/path\.endsWith\('(\/admin\/(?:library|benchmark|diagnostics)[a-z/_-]*)'\)/g)).map((m) => m[1]))).sort();
const METHODS = ['GET', 'POST', 'PATCH', 'PUT', 'DELETE'];
const SUPPORTED = { '/admin/diagnostics': ['GET'] };
const RETIRED = ['/admin/library', '/admin/library/journey', '/admin/library/import', '/admin/benchmark/runs', '/admin/benchmark/run', '/admin/benchmark/config', '/admin/benchmark/routing-override/resolve'];

let touched = [];
const AI_FNS = ['loadConfig', 'loadConfigWithStatus', 'isKeyConfigured', 'saveConfig', 'getKey'];
const realAi = {};
function ev(route, method, opts = {}) {
  const p = '/api' + route;
  return {
    rawPath: p, requestContext: { http: { method, path: p }, requestId: 'dt-auth' },
    headers: {}, cookies: [],
    body: opts.body !== undefined ? (typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body)) : JSON.stringify({ id: 'WM-001' }),
    queryStringParameters: opts.qs || { id: 'WM-001' },
  };
}
const ADMIN = async () => ({ username: 'a', email: 'admin@example.test', isAdmin: true });
const USER = async () => ({ username: 'u', email: 'user@example.test', isAdmin: false });

function stubAi(fake) {
  for (const k of AI_FNS) aiConfig[k] = fake[k] || (async () => { touched.push('ai.' + k); throw new Error('ai-config reached: ' + k); });
}
beforeAll(() => { for (const k of AI_FNS) realAi[k] = aiConfig[k]; });
afterAll(() => { for (const k of AI_FNS) aiConfig[k] = realAi[k]; api.setSessionForTests(null); api.setDiagnosticsDepsForTests(null); });
afterEach(() => { api.setSessionForTests(null); api.setDiagnosticsDepsForTests(null); });

describe('NAVIGATION/AUTH — Diagnostics route table (derived from the router)', () => {
  it('finds only the Diagnostics route: no Library or Benchmark route is routed any more', () => {
    expect(ROUTES).toEqual(['/admin/diagnostics']);
  });

  for (const [label, session] of [['no session', null], ['non-admin session', USER]]) {
    it(label + ': every route × method is 401 (or 405 if unsupported) and never reaches ai-config', async () => {
      api.setSessionForTests(session);
      stubAi({});
      touched = [];
      for (const route of ROUTES) {
        const supported = [];
        for (const method of METHODS) {
          const r = await api.handler(ev(route, method));
          expect([401, 405], route + ' ' + method).toContain(r.statusCode);
          if (r.statusCode === 401) {
            supported.push(method);
            expect(JSON.parse(r.body)).toEqual({ error: 'Unauthorized' });
          } else {
            expect(Object.keys(JSON.parse(r.body))).toEqual(['error']);
          }
        }
        expect(supported, route).toEqual(SUPPORTED[route]);
      }
      expect(touched).toEqual([]);
    });
  }

  it('the retired Test area is a 404 for every caller and method, and never the diagnose path', async () => {
    stubAi({});
    touched = [];
    for (const session of [null, USER, ADMIN]) {
      api.setSessionForTests(session);
      for (const route of RETIRED) {
        for (const method of METHODS) {
          const r = await api.handler(ev(route, method));
          expect(r.statusCode, route + ' ' + method).toBe(404);
          expect(JSON.parse(r.body)).toEqual({ error: 'not found' });
        }
      }
    }
    expect(touched).toEqual([]);
  });

  it('an admin session reaches the handler (the tripwire proves the table is meaningful)', async () => {
    api.setSessionForTests(ADMIN);
    stubAi({ loadConfig: async () => { touched.push('ai.loadConfig'); return aiConfig.defaultConfig(); }, isKeyConfigured: async () => { touched.push('ai.isKeyConfigured'); return false; } });
    api.setDiagnosticsDepsForTests({ fetch: async () => ({ ok: true, status: 200, json: async () => ({}), text: async () => '{}' }), mcpHealthUrl: '', engineHealthUrl: '', loadOverlay: async () => mediaAdmin.emptyState() });
    touched = [];
    const r = await api.handler(ev('/admin/diagnostics', 'GET'));
    expect(r.statusCode).toBe(200);
    expect(touched.length).toBeGreaterThan(0);
  });
});

describe('AUTH — admin-api log carries a real auth category', () => {
  it('logs unauthenticated / forbidden / admin, never not-checked, and no secrets', async () => {
    const lines = [];
    const orig = console.log;
    console.log = (x) => { lines.push(String(x)); };
    try {
      stubAi({ loadConfig: async () => aiConfig.defaultConfig(), isKeyConfigured: async () => false });
      api.setDiagnosticsDepsForTests({ fetch: async () => ({ ok: true, status: 200, json: async () => ({}), text: async () => '{}' }), mcpHealthUrl: '', engineHealthUrl: '', loadOverlay: async () => mediaAdmin.emptyState(), loadModels: async () => null });
      api.setSessionForTests(null);
      const e = ev('/admin/diagnostics', 'GET');
      e.cookies = ['wp_session=SECRET-TOKEN-VALUE'];
      await api.handler(e);
      api.setSessionForTests(USER);
      await api.handler(ev('/admin/diagnostics', 'GET'));
      api.setSessionForTests(ADMIN);
      await api.handler(ev('/admin/diagnostics', 'GET'));
    } finally { console.log = orig; api.setSessionForTests(null); }
    const admin = lines.filter((l) => l.indexOf('"evt":"admin-api"') !== -1).map((l) => JSON.parse(l));
    expect(admin.map((a) => [a.path, a.auth, a.status])).toEqual([
      ['/api/admin/diagnostics', 'unauthenticated', 401],
      ['/api/admin/diagnostics', 'forbidden', 401],
      ['/api/admin/diagnostics', 'admin', 200],
    ]);
    const all = lines.join('\n');
    for (const secret of ['SECRET-TOKEN-VALUE', 'wp_session', 'admin@example.test']) expect(all).not.toContain(secret);
  });
});

describe('ARCHITECTURE — Diagnostics reports ac2 read-only', () => {
  async function snapshot() {
    api.setSessionForTests(ADMIN);
    api.setDiagnosticsDepsForTests({
      fetch: async () => ({ ok: true, status: 200, json: async () => ({}), text: async () => '{}' }),
      mcpHealthUrl: '', engineHealthUrl: '',
      loadOverlay: async () => mediaAdmin.emptyState(),
      loadModels: async () => null,
    });
    const r = await api.handler(ev('/admin/diagnostics', 'GET', { qs: {} }));
    expect(r.statusCode).toBe(200);
    return JSON.parse(r.body);
  }
  it('the runtime reports the ac2 architecture, with no canonical or AC2 mode and no orchestrator', async () => {
    const d = await snapshot();
    expect(d.runtime.diagnosis).toMatchObject({ architecture: 'ac2' });
    expect(d.runtime).not.toHaveProperty('canonical');
    expect(d.runtime).not.toHaveProperty('ac2');
    expect(d.components.map((c) => c.id)).toEqual(['whichpart-api', 'diagnosis-engine', 'error-code-mcp', 'media-resolver', 'parts-catalogue']);
    expect(JSON.stringify(d)).not.toMatch(/orchestrator|reasoner|qwen|lm studio|jev/i);
  });
  it('diagnostics stays GET-only and reads no mode from the environment', () => {
    expect(SUPPORTED['/admin/diagnostics']).toEqual(['GET']);
    expect(src).not.toMatch(/CANONICAL_MODE|AC2_MODE|ORCHESTRATOR_URL/);
  });
});
