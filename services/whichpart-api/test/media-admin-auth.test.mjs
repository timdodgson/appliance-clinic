/**
 * Authoritative auth table for EVERY Admin Media API route.
 *
 * Routes are DERIVED from the router source (every `path.endsWith('/admin/media…')` branch in
 * index.js), so a new Media route added without auth fails here automatically. For every route ×
 * method: no session → 401 (or 405 for an unsupported method), non-admin session → 401 (existing
 * convention: requireAdmin returns 401 for both), and the Media store is NEVER reached — a tripwire
 * store throws on any call, proving no handler logic runs before auth.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const api = require('../index.js');
const src = fs.readFileSync(path.join(here, '..', 'index.js'), 'utf8');

const ROUTES = Array.from(new Set(Array.from(src.matchAll(/path\.endsWith\('(\/admin\/media[a-z/_-]*)'\)/g)).map((m) => m[1]))).sort();
const METHODS = ['GET', 'POST', 'PATCH', 'PUT', 'DELETE'];

let touched = [];
const tripwire = new Proxy({}, {
  get(_t, prop) {
    if (prop === 'then') return undefined;
    return () => { touched.push(String(prop)); throw new Error('media store reached before auth: ' + String(prop)); };
  },
});
function ev(route, method) {
  const p = '/api' + route;
  return {
    rawPath: p, requestContext: { http: { method, path: p }, requestId: 'auth-table' },
    headers: {}, cookies: [], body: JSON.stringify({ expectedRevision: 0, confirm: true, confirmDiagnostic: true, knowledgeId: 'dishwasher:not-draining' }),
    queryStringParameters: { id: 'vac-lost-suction', v: '0', q: 'x' },
  };
}

describe('Admin Media route auth table (derived from the router)', () => {
  beforeAll(() => { api.setMediaAdminStore(tripwire); });
  afterAll(() => { api.setSessionForTests(null); api.setMediaAdminStore(null); });

  it('finds every Media route in the router', () => {
    expect(ROUTES).toEqual(expect.arrayContaining([
      '/admin/media', '/admin/media/knowledge', '/admin/media/preview', '/admin/media/record',
      '/admin/media/record/component', '/admin/media/record/discard', '/admin/media/record/map',
      '/admin/media/record/publish', '/admin/media/record/replace', '/admin/media/record/restore',
      '/admin/media/record/retire', '/admin/media/record/rollback', '/admin/media/record/version',
    ]));
    expect(ROUTES.length).toBe(13);
  });

  for (const [label, session] of [['no session', null], ['non-admin session', async () => ({ username: 'u', email: 'user@example.test', isAdmin: false })]]) {
    it(label + ': every route × method is 401 (or 405 if unsupported) and never reaches the store', async () => {
      api.setSessionForTests(session);
      touched = [];
      const table = [];
      for (const route of ROUTES) {
        const supported = [];
        for (const method of METHODS) {
          const r = await api.handler(ev(route, method));
          table.push([route, method, r.statusCode]);
          expect([401, 405], route + ' ' + method).toContain(r.statusCode);
          if (r.statusCode === 401) {
            supported.push(method);
            expect(JSON.parse(r.body)).toEqual({ error: 'Unauthorized' });
          }
        }
        expect(supported.length, route + ' has at least one supported method').toBeGreaterThan(0);
      }
      expect(touched).toEqual([]);
      // 13 routes × 5 methods, none 2xx / 5xx
      expect(table.length).toBe(ROUTES.length * METHODS.length);
      expect(table.filter((t) => t[2] >= 200 && t[2] < 300 || t[2] >= 500)).toEqual([]);
    });
  }

  it('an admin session does reach the handler (the tripwire proves the table above is meaningful)', async () => {
    api.setSessionForTests(async () => ({ username: 'a', email: 'admin@example.test', isAdmin: true }));
    touched = [];
    const r = await api.handler(ev('/admin/media/record', 'GET'));
    expect(touched.length).toBeGreaterThan(0);
    expect(r.statusCode).not.toBe(401);
  });
});

describe('admin request log (path, method, auth category, status — no secrets)', () => {
  it('logs one concise line per admin request and never logs cookies, tokens, queries or bodies', async () => {
    const lines = [];
    const orig = console.log;
    console.log = (x) => { lines.push(String(x)); };
    try {
      api.setSessionForTests(null);
      const e = ev('/admin/media/record/publish', 'POST');
      e.cookies = ['wp_session=SECRET-TOKEN-VALUE'];
      e.headers = { cookie: 'wp_session=SECRET-TOKEN-VALUE', authorization: 'Bearer SECRET-BEARER' };
      e.body = JSON.stringify({ expectedRevision: 0, password: 'SECRET-PASSWORD' });
      await api.handler(e);
      api.setSessionForTests(async () => ({ username: 'u', email: 'user@example.test', isAdmin: false }));
      await api.handler(ev('/admin/media', 'GET'));
    } finally { console.log = orig; api.setSessionForTests(null); }
    const admin = lines.filter((l) => l.indexOf('"evt":"admin-api"') !== -1).map((l) => JSON.parse(l));
    expect(admin).toEqual([
      expect.objectContaining({ evt: 'admin-api', method: 'POST', path: '/api/admin/media/record/publish', auth: 'unauthenticated', status: 401, rid: 'auth-table' }),
      expect.objectContaining({ evt: 'admin-api', method: 'GET', path: '/api/admin/media', auth: 'forbidden', status: 401 }),
    ]);
    const all = lines.join('\n');
    for (const secret of ['SECRET-TOKEN-VALUE', 'SECRET-BEARER', 'SECRET-PASSWORD', 'vac-lost-suction', 'wp_session']) expect(all).not.toContain(secret);
  });
});
