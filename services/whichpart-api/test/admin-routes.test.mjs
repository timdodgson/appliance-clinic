/**
 * Phase 8: the API's routes survive the split of index.js, every admin route refuses an unauthenticated caller, and
 * /auth/logout behaves as before. The unused /admin/transcripts/stats and /policy routes were removed with the admin
 * review of 2026-10-16 (the dashboard reads today's counts through /admin/dashboard).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const api = require('../index.js');
const transcripts = require('../transcripts');
const src = require('./api-source.cjs')();

// Every path the router matched before the split, in router order.
const ROUTES = [
  '/auth/login', '/auth/logout', '/auth/me', '/admin/health', '/admin/dashboard', '/admin/settings/model',
  '/admin/settings', '/admin/ai-config/key', '/admin/ai-config/test', '/admin/ai-config/models',
  '/admin/transcripts/session', '/admin/transcripts',
  '/admin/knowledge/record', '/admin/knowledge',
  '/admin/media/knowledge', '/admin/media/preview', '/admin/media/record/publish', '/admin/media/record/rollback',
  '/admin/media/record/discard', '/admin/media/record/version', '/admin/media/record/replace',
  '/admin/media/record/map', '/admin/media/record/component', '/admin/media/record/retire',
  '/admin/media/record/restore', '/admin/media/record', '/admin/media', '/admin/diagnostics',
  '/admin/error-codes/record/publish', '/admin/error-codes/record/rollback', '/admin/error-codes/record/version',
  '/admin/error-codes/record/retire', '/admin/error-codes/record/restore', '/admin/error-codes/preview',
  '/admin/error-codes/record', '/admin/error-codes', '/admin/recalls/records', '/admin/recalls/record/version',
  '/admin/recalls/record/publish', '/admin/recalls/record/discard', '/admin/recalls/record/archive',
  '/admin/recalls/record/restore', '/admin/recalls/record/rollback', '/admin/recalls/record',
  '/admin/recalls/ingest', '/admin/safety-ingest/run', '/admin/safety-ingest/history', '/admin/safety-ingest/runs',
  '/admin/safety-ingest', '/admin/recalls/status', '/recalls/lookup', '/recalls/record', '/recalls', '/recalls/',
];
const ADMIN = async () => ({ username: 'a', email: 'admin@example.test', isAdmin: true });
const USER = async () => ({ username: 'u', email: 'user@example.test', isAdmin: false });
const NOBODY = async () => null;
function ev(route, method, extra = {}) {
  const p = '/api' + route;
  return { rawPath: p, requestContext: { http: { method, path: p }, requestId: 'routes' }, headers: {}, cookies: [], body: '{}', ...extra };
}

afterEach(() => { api.setSessionForTests(null); api.setTranscriptStore(null); });

describe('routes', () => {
  it('the router still matches every route, in the same order', () => {
    const now = [...new Set([...src.matchAll(/path\.endsWith\('([^']+)'\)/g)].map((m) => m[1]))];
    expect(now).toEqual(ROUTES);
  });

  it.each(ROUTES.filter((r) => r.startsWith('/admin/')).flatMap((r) => [[r, 'GET'], [r, 'POST']]))(
    '%s %s refuses a caller with no session (401 or 405)', async (route, method) => {
      api.setSessionForTests(NOBODY);
      const res = await api.handler(ev(route, method));
      expect([401, 405]).toContain(res.statusCode);
    });

  it.each(ROUTES.filter((r) => r.startsWith('/admin/')).map((r) => [r]))(
    '%s refuses a signed-in non-admin (401 or 405)', async (route) => {
      api.setSessionForTests(USER);
      const res = await api.handler(ev(route, 'GET'));
      expect([401, 405]).toContain(res.statusCode);
    });
});

// ADR 0019: the knowledge publish workflow is gone. ADR 0023: the Test area (question library, ACQ-100 benchmark), the
// transcript review and the Jev / routing settings are gone. Their endpoints are a plain 404 for any caller and
// method — never routed to a store and never treated as a diagnose request.
const RETIRED_KNOWLEDGE_ROUTES = [
  ['POST', '/admin/knowledge/draft'], ['PUT', '/admin/knowledge/draft'], ['DELETE', '/admin/knowledge/draft'],
  ['POST', '/admin/knowledge/validate'], ['GET', '/admin/knowledge/versions'], ['POST', '/admin/knowledge/publish'],
  ['POST', '/admin/knowledge/rollback'], ['POST', '/admin/knowledge/archive'], ['POST', '/admin/knowledge/restore'],
  ['GET', '/admin/library'], ['POST', '/admin/library/journey/edit'], ['POST', '/admin/library/import'],
  ['GET', '/admin/benchmark/runs'], ['POST', '/admin/benchmark/run'], ['POST', '/admin/benchmark/routing-override/resolve'],
  ['GET', '/admin/benchmark/config'],
];
describe('retired knowledge, test-area and review routes', () => {
  it.each(RETIRED_KNOWLEDGE_ROUTES)('%s %s is 404 even for an admin', async (method, route) => {
    api.setSessionForTests(ADMIN);
    const res = await api.handler(ev(route, method, { rawQueryString: 'id=vacuum:lost-suction', body: JSON.stringify({ expectedRevision: 0 }) }));
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body)).toEqual({ error: 'not found' });
  });
  it('the read-only knowledge routes still answer', async () => {
    api.setSessionForTests(ADMIN);
    expect((await api.handler(ev('/admin/knowledge', 'GET'))).statusCode).toBe(200);
    expect((await api.handler(ev('/admin/knowledge/record', 'GET', { rawQueryString: 'id=vacuum:lost-suction', queryStringParameters: { id: 'vacuum:lost-suction' } }))).statusCode).toBe(200);
  });
  it.each([['PATCH', '/admin/settings/jev'], ['POST', '/admin/settings/jev/test'], ['PATCH', '/admin/settings/diagnostic-inference'],
    ['GET', '/admin/ai-config/local-models'], ['POST', '/admin/ai-config/test-local'], ['GET', '/admin/transcripts/quality'],
    ['POST', '/admin/transcripts/session/review']])('%s %s (retired settings / review route) is a 404, never the diagnose path', async (method, route) => {
    api.setSessionForTests(ADMIN);
    api.setTranscriptStore(transcripts.createMemoryStore());
    const res = await api.handler(ev(route, method, { body: JSON.stringify({ expectedVersion: 1, messages: [{ role: 'user', content: 'x' }] }) }));
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body)).toEqual({ error: 'not found' });
  });
  it('the API no longer exposes a knowledge admin store, a benchmark override or a transcript review', () => {
    expect(api.knowledgeAdmin).toBeUndefined();
    expect(api.setKnowledgeAdminStore).toBeUndefined();
    expect(api.routingOverride).toBeUndefined();
    expect(api.transcriptReview).toBeUndefined();
    expect(api.setBenchmarkDepsForTests).toBeUndefined();
    expect(src).not.toMatch(/require\('\.\/(benchmark-auth|transcript-review|benchmark-state|admin\/test-area|jev-client|canonical-audit)/);
  });
});

describe('/auth/logout', () => {
  it('clears both cookies and makes no Cognito call without a session cookie', async () => {
    const res = await api.handler(ev('/auth/logout', 'POST'));
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ ok: true });
    const cookies = res.cookies || res.multiValueHeaders?.['Set-Cookie'] || [];
    expect(cookies.join('\n')).toMatch(/wp_session=;[^\n]*Max-Age=0/i);
    expect(cookies.join('\n')).toMatch(/wp_logged_in=;[^\n]*Max-Age=0/i);
  });
});

describe('the removed transcript stats and policy routes', () => {
  it('are 404 for an admin, like every other unmatched /admin path', async () => {
    api.setSessionForTests(ADMIN);
    for (const p of ['/admin/transcripts/stats', '/admin/transcripts/policy']) {
      const res = await api.handler(ev(p, 'GET'));
      expect(res.statusCode, p).toBe(404);
    }
  });
});
