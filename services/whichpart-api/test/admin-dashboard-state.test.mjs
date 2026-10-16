/**
 * Dashboard "Production state" (admin/health.js dashboardState): read-only facts from sources the BFF
 * already reads, each failing on its own, admin-only, no secrets or ids. No AWS: every store is a double.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
process.env.MCP_HEALTH_URL = 'http://mcp.test/health';
process.env.ENGINE_URL = 'http://engine.test/';
const handlerPath = require.resolve('../index.js');
delete require.cache[handlerPath];
const api = require(handlerPath);
const ai = require('../ai-config.js');
const transcripts = require('../transcripts.js');

const ADMIN = async () => ({ username: 'a', email: 'admin@example.test', isAdmin: true });
let realFetch; let realLoad; let realKey; const probed = [];
beforeAll(() => {
  realFetch = globalThis.fetch; realLoad = ai.loadConfig; realKey = ai.isKeyConfigured;
  globalThis.fetch = async (url) => {
    const u = String(url);
    const body = u.startsWith('http://mcp.test') ? { status: 'ok', effectiveActiveCount: 783, overlay: { state: 'none' } }
      : { status: 'ok', health: 'healthy', service: 'diagnosis-engine', diagnosis: { architecture: 'ac2' } };
    probed.push(u);
    return { ok: true, status: 200, text: async () => JSON.stringify(body), json: async () => body };
  };
  ai.loadConfig = async () => ai.normalise({ model: 'claude-opus-5-5', version: 9 });
  ai.isKeyConfigured = async () => true;
  api.setTranscriptStore(transcripts.createMemoryStore());
  api.setMediaAdminStore({ loadState: async () => ({ version: 1, updatedAt: null, identities: {}, byKnowledgeId: {}, byComponent: {} }) });
  api.setRecallStore({ getMeta: async () => ({ site: { pages: 59, records: 47 }, lastSuccessAt: '2026-10-05T06:00:38.748Z' }) });
});
afterAll(() => { globalThis.fetch = realFetch; ai.loadConfig = realLoad; ai.isKeyConfigured = realKey; api.setSessionForTests(null); api.setRecallStore(null); });
const get = () => api.handler({ rawPath: '/api/admin/dashboard', requestContext: { http: { method: 'GET', path: '/api/admin/dashboard' }, requestId: 'd' }, headers: {}, cookies: [], queryStringParameters: { period: '7d' } });

describe('Dashboard production state', () => {
  it('is admin-only', async () => {
    api.setSessionForTests(null);
    expect((await get()).statusCode).toBe(401);
  });
  it('reports the architecture, the advisor model, Error Codes, media and recalls from existing sources', async () => {
    api.setSessionForTests(ADMIN);
    const r = await get();
    expect(r.statusCode).toBe(200);
    const body = JSON.parse(r.body);
    const s = body.state;
    expect(s.diagnosis).toEqual({ architecture: 'ac2' });
    expect(s).not.toHaveProperty('canonical');
    expect(s).not.toHaveProperty('override');
    expect(s).not.toHaveProperty('routing');
    expect(s.advisor).toEqual({ provider: 'Anthropic (Claude)', model: 'claude-opus-5-5', credentialConfigured: true, version: 9 });
    // The diagnosis engine is probed directly (no orchestrator hop).
    expect(probed).toContain('http://engine.test/health');
    expect(body.health).toMatchObject({ ok: true, label: 'Healthy', failed: [] });
    expect(body.health.summaryLine).toBe('API · Diagnosis engine · Error codes');
    expect(body.activity).toMatchObject({ sessionsToday: 0, partSessionsToday: 0 });
    expect(s.errorCodes).toMatchObject({ ok: true, active: 783, overlay: 'none' });
    expect(s.media).toMatchObject({ overlay: 'absent', records: 0 });
    expect(s.recalls).toMatchObject({ listed: 47 });
    expect(r.body).not.toMatch(/apiKey|anthropicApiKey|secret|stateToken|cst1\./i);
  });
  it('a part that cannot be read is { unavailable } — the rest still render', async () => {
    api.setSessionForTests(ADMIN);
    ai.loadConfig = async () => { throw new Error('secrets manager down'); };
    api.setRecallStore({ getMeta: async () => { throw new Error('ddb down'); } });
    const s = JSON.parse((await get()).body).state;
    expect(s.advisor).toEqual({ unavailable: true });
    expect(s.recalls).toEqual({ unavailable: true });
    expect(s.errorCodes.active).toBe(783);
  });
  it('a failing service is named in the compact health with its reason', async () => {
    api.setSessionForTests(ADMIN);
    const keep = globalThis.fetch;
    globalThis.fetch = async (url) => {
      const u = String(url);
      const body = u.startsWith('http://mcp.test') ? { status: 'ok', effectiveActiveCount: 1 }
        : { status: 'degraded', health: 'degraded', healthReason: "The advisor's model is not configured", service: 'diagnosis-engine' };
      return { ok: true, status: 200, text: async () => JSON.stringify(body), json: async () => body };
    };
    try {
      const body = JSON.parse((await get()).body);
      expect(body.health).toMatchObject({ ok: false, label: 'Problem', failed: [{ name: 'Diagnosis engine', detail: "The advisor's model is not configured" }] });
    } finally { globalThis.fetch = keep; }
  });
  it('GET /admin/health is gated by the same requireAdmin as the dashboard', async () => {
    api.setSessionForTests(null);
    const r = await api.handler({ rawPath: '/api/admin/health', requestContext: { http: { method: 'GET', path: '/api/admin/health' }, requestId: 'h' }, headers: {}, cookies: [] });
    expect(r.statusCode).toBe(401);
  });
});
