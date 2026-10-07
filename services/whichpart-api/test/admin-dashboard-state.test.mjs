/**
 * Dashboard "Production state" (index.js dashboardState): read-only facts from sources the BFF
 * already reads, each failing on its own, admin-only, no secrets or ids. No AWS: every store is a double.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
process.env.MCP_HEALTH_URL = 'http://mcp.test/health';
process.env.ORCHESTRATOR_URL = 'http://orchestrator.test';
process.env.CANONICAL_MODE = 'control';
const registry = require('../../part-finder/canonical/journey-registry.js');
process.env.CANONICAL_CONTROL_JOURNEYS = registry.KEYS.join('+');
const handlerPath = require.resolve('../index.js');
delete require.cache[handlerPath];
const api = require(handlerPath);
const ai = require('../ai-config.js');
const transcripts = require('../transcripts.js');
const { memoryS3 } = require('../benchmark/acq-store.js');

const ADMIN = async () => ({ username: 'a', email: 'admin@example.test', isAdmin: true });
let realFetch; let realLoad;
beforeAll(() => {
  realFetch = globalThis.fetch; realLoad = ai.loadConfig;
  globalThis.fetch = async (url) => {
    const u = String(url);
    const body = u.startsWith('http://mcp.test') ? { status: 'ok', effectiveActiveCount: 783, overlay: { state: 'none' } } : { status: 'ok', diagnosticRag: 'ok' };
    return { ok: true, status: 200, text: async () => JSON.stringify(body), json: async () => body };
  };
  ai.loadConfig = async () => ({ routing: { understand: 'local', compose: 'local' }, local: { model: 'gpt-5.6-terra' }, frontier: { model: 'x', enabled: false }, version: 9 });
  api.setTranscriptStore(transcripts.createMemoryStore());
  api.setAcqS3ForTests(memoryS3());
  api.setMediaAdminStore({ loadState: async () => ({ version: 1, updatedAt: null, identities: {}, byKnowledgeId: {}, byComponent: {} }) });
  api.setRecallStore({ getMeta: async () => ({ site: { pages: 59, records: 47 }, lastSuccessAt: '2026-10-05T06:00:38.748Z' }) });
});
afterAll(() => { globalThis.fetch = realFetch; ai.loadConfig = realLoad; api.setSessionForTests(null); api.setAcqS3ForTests(null); api.setRecallStore(null); });
const get = () => api.handler({ rawPath: '/api/admin/dashboard', requestContext: { http: { method: 'GET', path: '/api/admin/dashboard' }, requestId: 'd' }, headers: {}, cookies: [], queryStringParameters: { period: '7d' } });

describe('Dashboard production state', () => {
  it('is admin-only', async () => {
    api.setSessionForTests(null);
    expect((await get()).statusCode).toBe(401);
  });
  it('reports canonical, routing, override, Error Codes, media and recalls from existing sources', async () => {
    api.setSessionForTests(ADMIN);
    const r = await get();
    expect(r.statusCode).toBe(200);
    const s = JSON.parse(r.body).state;
    expect(s.canonical).toMatchObject({ mode: 'control', journeys: registry.KEYS.length });
    expect(s.routing).toMatchObject({ understand: 'TypeSafe Jev', compose: 'Private AI', composeModel: 'gpt-5.6-terra' });
    expect(s.override).toMatchObject({ active: false, blocked: false, runId: null });
    expect(s.errorCodes).toMatchObject({ ok: true, active: 783, overlay: 'none' });
    expect(s.media).toMatchObject({ overlay: 'absent', records: 0 });
    expect(s.recalls).toMatchObject({ listed: 47 });
    expect(r.body).not.toMatch(/apiKey|apiToken|secret|stateToken|cst1\./i);
  });
  it('a part that cannot be read is { unavailable } — the rest still render', async () => {
    api.setSessionForTests(ADMIN);
    ai.loadConfig = async () => { throw new Error('secrets manager down'); };
    api.setRecallStore({ getMeta: async () => { throw new Error('ddb down'); } });
    const s = JSON.parse((await get()).body).state;
    expect(s.routing).toEqual({ unavailable: true });
    expect(s.recalls).toEqual({ unavailable: true });
    expect(s.errorCodes.active).toBe(783);
  });
  it('GET /admin/health is gated by the same requireAdmin as the dashboard', async () => {
    api.setSessionForTests(null);
    const r = await api.handler({ rawPath: '/api/admin/health', requestContext: { http: { method: 'GET', path: '/api/admin/health' }, requestId: 'h' }, headers: {}, cookies: [] });
    expect(r.statusCode).toBe(401);
  });
});
