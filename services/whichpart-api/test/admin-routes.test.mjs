/**
 * Phase 8: the API's routes survive the split of index.js, every admin route refuses an unauthenticated caller, and
 * the routes that had no test (/auth/logout, /admin/transcripts/stats, /admin/transcripts/policy) behave as before.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const api = require('../index.js');
const transcripts = require('../transcripts');
const src = require('./api-source.cjs')();

// Every path the router matched before the split, in router order.
const ROUTES = [
  '/auth/login', '/auth/logout', '/auth/me', '/admin/health', '/admin/dashboard', '/admin/settings/jev/test',
  '/admin/settings/jev', '/admin/settings/diagnostic-inference', '/admin/settings', '/admin/ai-config/key',
  '/admin/ai-config/test-local', '/admin/ai-config/test-frontier', '/admin/ai-config/local-models',
  '/admin/ai-config/frontier-models', '/admin/ai-config', '/admin/library/journey/edit',
  '/admin/library/journey/duplicate', '/admin/library/journey/flags', '/admin/library/journey/delete',
  '/admin/library/journey', '/admin/library/import', '/admin/library', '/admin/benchmark/build-run',
  '/admin/benchmark/rerun', '/admin/benchmark/estimate', '/admin/benchmark/routing-override/resolve',
  '/admin/benchmark/routing-override/recover', '/admin/benchmark/run/cancel', '/admin/benchmark/transcript',
  '/admin/benchmark/scenario-conversations', '/admin/benchmark/reviews', '/admin/benchmark/review',
  '/admin/benchmark/run', '/admin/benchmark/runs', '/admin/benchmark/compare', '/admin/benchmark/config',
  '/admin/transcripts/stats', '/admin/transcripts/policy', '/admin/transcripts/quality',
  '/admin/transcripts/session/review', '/admin/transcripts/session', '/admin/transcripts', '/admin/knowledge/record',
  '/admin/knowledge/draft', '/admin/knowledge/validate', '/admin/knowledge/versions', '/admin/knowledge/publish',
  '/admin/knowledge/rollback', '/admin/knowledge/archive', '/admin/knowledge/restore', '/admin/knowledge',
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

describe('/admin/transcripts/stats and /policy', () => {
  it('stats: admin gets the store stats with the retention policy', async () => {
    api.setSessionForTests(ADMIN);
    api.setTranscriptStore({ stats: async () => ({ sessions: 3, turns: 7 }) });
    const res = await api.handler(ev('/admin/transcripts/stats', 'GET'));
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ sessions: 3, turns: 7, policy: transcripts.policy() });
  });
  it('stats: a failing store is a 503, not a 200 with empty numbers', async () => {
    api.setSessionForTests(ADMIN);
    api.setTranscriptStore({ stats: async () => { throw new Error('ddb down'); } });
    const res = await api.handler(ev('/admin/transcripts/stats', 'GET'));
    expect(res.statusCode).toBe(503);
    expect(JSON.parse(res.body)).toEqual({ error: 'Transcript store unavailable' });
  });
  it('policy: admin gets the retention policy', async () => {
    api.setSessionForTests(ADMIN);
    const res = await api.handler(ev('/admin/transcripts/policy', 'GET'));
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual(transcripts.policy());
  });
});
