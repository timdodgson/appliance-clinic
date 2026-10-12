/**
 * Phase 8: the admin error responses are a contract with the admin UI:
 *   - Media: status from the error (default 404 for not_found, else 400), body {error, code, extra nested}.
 * (The Knowledge write endpoints and their error shape were removed with the knowledge publish workflow, ADR 0019.)
 * These tests pin the shape, so a later clean-up cannot change them without a coordinated UI change
 * (docs/architecture/error-handling.md).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const api = require('../index.js');

const ADMIN = async () => ({ username: 'a', email: 'admin@example.test', isAdmin: true });
function ev(route, method, body, query = '') {
  const p = '/api' + route;
  return { rawPath: p, rawQueryString: query, requestContext: { http: { method, path: p }, requestId: 'errors' }, headers: {}, cookies: [], body: JSON.stringify(body || {}) };
}
const err = (message, props) => Object.assign(new Error(message), props);

afterEach(() => { api.setSessionForTests(null); api.setMediaAdminStore(null); });

describe('media admin errors', () => {
  it('not_found without a status is a 404', async () => {
    api.setSessionForTests(ADMIN);
    api.setMediaAdminStore({ create: async () => { throw err('No such media', { code: 'not_found' }); } });
    const res = await api.handler(ev('/admin/media', 'POST', { title: 'x' }));
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body)).toEqual({ error: 'No such media', code: 'not_found' });
  });
  it('another error without a status is a 400, with extra nested', async () => {
    api.setSessionForTests(ADMIN);
    api.setMediaAdminStore({ create: async () => { throw err('Title is required', { code: 'validation', extra: { field: 'title' } }); } });
    const res = await api.handler(ev('/admin/media', 'POST', {}));
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body)).toEqual({ error: 'Title is required', code: 'validation', extra: { field: 'title' } });
  });
});
