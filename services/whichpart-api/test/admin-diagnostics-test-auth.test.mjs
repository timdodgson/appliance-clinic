/**
 * Diagnostics / Test Admin API — authoritative auth table, method hygiene, input validation,
 * library concurrency and read-only diagnostics.
 *
 * Routes are DERIVED from the router source (every `path.endsWith('/admin/library…')`,
 * `'/admin/benchmark…'` and `'/admin/diagnostics'` branch in index.js), so a new Test-area route
 * added without the gate fails here automatically. For every route × method: no session → 401
 * (or 405 for an unsupported method), non-admin session → 401, and the Test-area S3 store and
 * the AI-config secret are NEVER reached — tripwires throw on any call.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const api = require('../index.js');
const aiConfig = require('../ai-config.js');
const registry = require('../../part-finder/canonical/journey-registry.js');
const mediaAdmin = require('../media-admin.js');
const src = require('./api-source.cjs')();

const ROUTES = Array.from(new Set(Array.from(src.matchAll(/path\.endsWith\('(\/admin\/(?:library|benchmark|diagnostics)[a-z/_-]*)'\)/g)).map((m) => m[1]))).sort();
const METHODS = ['GET', 'POST', 'PATCH', 'PUT', 'DELETE'];
// The methods the Admin client actually uses — everything else must be 405.
const SUPPORTED = {
  '/admin/library': ['GET'],
  '/admin/library/import': ['POST'],
  '/admin/library/journey': ['GET', 'POST'],
  '/admin/library/journey/delete': ['POST'],
  '/admin/library/journey/duplicate': ['POST'],
  '/admin/library/journey/edit': ['POST'],
  '/admin/library/journey/flags': ['POST'],
  '/admin/benchmark/build-run': ['POST'],
  '/admin/benchmark/compare': ['GET'],
  '/admin/benchmark/config': ['GET'],
  '/admin/benchmark/estimate': ['POST'],
  '/admin/benchmark/rerun': ['POST'],
  '/admin/benchmark/review': ['GET', 'POST'],
  '/admin/benchmark/reviews': ['GET'],
  '/admin/benchmark/run': ['GET', 'POST'],
  '/admin/benchmark/run/cancel': ['POST'],
  '/admin/benchmark/routing-override/recover': ['POST'],
  '/admin/benchmark/routing-override/resolve': ['POST'],
  '/admin/benchmark/runs': ['GET'],
  '/admin/benchmark/scenario-conversations': ['GET'],
  '/admin/benchmark/transcript': ['GET'],
  '/admin/diagnostics': ['GET'],
};
const RUN = 'acq-2026-01-01T00-00-00-000Z-abc12345';

let touched = [];
const tripS3 = {
  getObject: async (k) => { touched.push('s3.get'); throw new Error('S3 reached before auth: ' + k); },
  putObject: async (k) => { touched.push('s3.put'); throw new Error('S3 reached before auth: ' + k); },
  list: async (p) => { touched.push('s3.list'); throw new Error('S3 reached before auth: ' + p); },
};
const AI_FNS = ['loadConfig', 'isKeyConfigured', 'saveConfig', 'loadJevWithStatus'];
const realAi = {};

function memS3() {
  const m = new Map();
  return {
    m,
    getObject: async (k) => (m.has(k) ? m.get(k) : null),
    putObject: async (k, b) => { m.set(k, b); },
    list: async (p) => Array.from(m.keys()).filter((k) => k.startsWith(p)),
  };
}
function ev(route, method, opts = {}) {
  const p = '/api' + route;
  return {
    rawPath: p, requestContext: { http: { method, path: p }, requestId: 'dt-auth' },
    headers: {}, cookies: [],
    body: opts.body !== undefined ? (typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body)) : JSON.stringify({ id: 'WM-001', run: RUN, journey: 'WM-001', state: 'looks_good', changes: {} }),
    queryStringParameters: opts.qs || { id: 'WM-001', run: RUN, journey: 'WM-001', a: RUN, b: RUN },
  };
}
const ADMIN = async () => ({ username: 'a', email: 'admin@example.test', isAdmin: true });
const USER = async () => ({ username: 'u', email: 'user@example.test', isAdmin: false });

function stubAi(fake) {
  for (const k of AI_FNS) aiConfig[k] = fake[k] || (async () => { touched.push('ai.' + k); throw new Error('ai-config reached: ' + k); });
}
beforeAll(() => { for (const k of AI_FNS) realAi[k] = aiConfig[k]; });
afterAll(() => { for (const k of AI_FNS) aiConfig[k] = realAi[k]; api.setAcqS3ForTests(null); api.setSessionForTests(null); });

describe('NAVIGATION/AUTH — Test-area route table (derived from the router)', () => {
  it('finds every Library / Benchmark / Diagnostics route', () => {
    expect(ROUTES).toEqual(Object.keys(SUPPORTED).sort());
    expect(ROUTES.length).toBe(22);
  });

  for (const [label, session] of [['no session', null], ['non-admin session', USER]]) {
    it(label + ': every route × method is 401 (or 405 if unsupported) and never reaches S3 or ai-config', async () => {
      api.setSessionForTests(session);
      api.setAcqS3ForTests(tripS3);
      stubAi({});
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
          } else {
            // 405 bodies name the allowed methods only — no data.
            expect(Object.keys(JSON.parse(r.body))).toEqual(['error']);
          }
        }
        expect(supported, route).toEqual(SUPPORTED[route]);
      }
      expect(touched).toEqual([]);
      expect(table.filter((t) => (t[2] >= 200 && t[2] < 300) || t[2] >= 500)).toEqual([]);
    });
  }

  it('/admin/library/import (an S3 seed write) is no longer reachable without admin', async () => {
    api.setAcqS3ForTests(tripS3); touched = [];
    api.setSessionForTests(null);
    expect((await api.handler(ev('/admin/library/import', 'POST'))).statusCode).toBe(401);
    api.setSessionForTests(USER);
    expect((await api.handler(ev('/admin/library/import', 'POST'))).statusCode).toBe(401);
    expect(touched).toEqual([]);
  });

  it('an admin session reaches the handler (the tripwire proves the table is meaningful)', async () => {
    api.setSessionForTests(ADMIN);
    api.setAcqS3ForTests(tripS3);
    touched = [];
    const r = await api.handler(ev('/admin/benchmark/runs', 'GET'));
    expect(touched.length).toBeGreaterThan(0);
    expect(r.statusCode).not.toBe(401);
  });

  it('ERRORS: a store failure is a clean JSON 500 with no internal detail', async () => {
    api.setSessionForTests(ADMIN);
    api.setAcqS3ForTests(tripS3);
    const r = await api.handler(ev('/admin/benchmark/runs', 'GET'));
    expect(r.statusCode).toBe(500);
    expect(JSON.parse(r.body)).toEqual({ error: 'The test service could not complete this request. Try again.' });
    expect(r.body).not.toMatch(/S3 reached|acq\/runs/);
  });

  it('unsupported methods are 405 even for an admin, before any store access', async () => {
    api.setSessionForTests(ADMIN);
    api.setAcqS3ForTests(tripS3);
    touched = [];
    for (const [route, m] of [['/admin/library', 'DELETE'], ['/admin/benchmark/runs', 'POST'], ['/admin/benchmark/transcript', 'PUT'], ['/admin/library/journey', 'PATCH']]) {
      expect((await api.handler(ev(route, m))).statusCode, route + ' ' + m).toBe(405);
    }
    expect(touched).toEqual([]);
  });
});

describe('AUTH — admin-api log carries a real auth category for Test-area routes', () => {
  it('logs unauthenticated / forbidden / admin, never not-checked, and no secrets', async () => {
    const lines = [];
    const orig = console.log;
    console.log = (x) => { lines.push(String(x)); };
    try {
      api.setAcqS3ForTests(memS3());
      stubAi({ loadConfig: async () => ({}), isKeyConfigured: async () => false, loadJevWithStatus: async () => ({ public: {} }) });
      api.setSessionForTests(null);
      const e = ev('/admin/library/journey/edit', 'POST', { body: { id: 'WM-001', changes: { title: 'SECRET-TITLE' } } });
      e.cookies = ['wp_session=SECRET-TOKEN-VALUE'];
      await api.handler(e);
      api.setSessionForTests(USER);
      await api.handler(ev('/admin/benchmark/runs', 'GET'));
      api.setSessionForTests(ADMIN);
      await api.handler(ev('/admin/benchmark/runs', 'GET'));
    } finally { console.log = orig; api.setSessionForTests(null); }
    const admin = lines.filter((l) => l.indexOf('"evt":"admin-api"') !== -1).map((l) => JSON.parse(l));
    expect(admin.map((a) => [a.path, a.auth, a.status])).toEqual([
      ['/api/admin/library/journey/edit', 'unauthenticated', 401],
      ['/api/admin/benchmark/runs', 'forbidden', 401],
      ['/api/admin/benchmark/runs', 'admin', 200],
    ]);
    const all = lines.join('\n');
    for (const secret of ['SECRET-TOKEN-VALUE', 'SECRET-TITLE', 'wp_session', 'admin@example.test']) expect(all).not.toContain(secret);
  });
});

describe('INPUT — ids used in S3 keys are validated before any store call', () => {
  afterEach(() => { api.setSessionForTests(null); });
  it('rejects malformed run / scenario ids with 400 and touches nothing', async () => {
    api.setSessionForTests(ADMIN);
    api.setAcqS3ForTests(tripS3);
    touched = [];
    const cases = [
      ['/admin/benchmark/run', 'GET', { qs: { id: '../library' } }],
      ['/admin/benchmark/run', 'GET', { qs: { id: 'acq-x/../../y' } }],
      ['/admin/benchmark/transcript', 'GET', { qs: { run: RUN, journey: 'WM-001/../x' } }],
      ['/admin/benchmark/transcript', 'GET', { qs: { run: 'nope', journey: 'WM-001' } }],
      ['/admin/benchmark/scenario-conversations', 'GET', { qs: { journey: '<script>' } }],
      ['/admin/benchmark/reviews', 'GET', { qs: { run: 'acq-' } }],
      ['/admin/benchmark/review', 'GET', { qs: { run: RUN, journey: 'a b' } }],
      ['/admin/benchmark/review', 'POST', { body: { run: RUN + '/x', journey: 'WM-001', state: 'looks_good' } }],
      ['/admin/benchmark/compare', 'GET', { qs: { a: RUN, b: '../x' } }],
      ['/admin/benchmark/run/cancel', 'POST', { body: { id: 'acq-../../x' } }],
      ['/admin/benchmark/rerun', 'POST', { body: { id: '/etc/passwd' } }],
      ['/admin/library/journey', 'GET', { qs: { id: 'WM-001/../../x' } }],
      ['/admin/library/journey', 'GET', { qs: { id: 'new' } }],
      ['/admin/library/journey/edit', 'POST', { body: { id: '../x', changes: {} } }],
      ['/admin/library/journey/flags', 'POST', { body: { id: 'WM-001', changes: [] } }],
      ['/admin/library/journey/delete', 'POST', { body: { id: 'a/b' } }],
      ['/admin/library/journey/duplicate', 'POST', { body: { id: 'WM-001', overrides: { journeyId: '../x' } } }],
      ['/admin/library/journey', 'POST', { body: { journeyId: 'x/y', family: 'vacuum' } }],
      ['/admin/benchmark/build-run', 'POST', { body: { mode: 'MANUAL', manualIds: ['WM-001', '../x'] } }],
      ['/admin/benchmark/build-run', 'POST', { body: { mode: 'MANUAL', manualIds: 'WM-001' } }],
      ['/admin/benchmark/review', 'POST', { body: { run: RUN, journey: 'WM-001', state: 'looks_good', note: 'x'.repeat(4001) } }],
    ];
    for (const [route, m, o] of cases) {
      const r = await api.handler(ev(route, m, o));
      expect(r.statusCode, route + ' ' + m + ' ' + JSON.stringify(o).slice(0, 60)).toBe(400);
    }
    expect(touched).toEqual([]);
  });

  it('caps request bodies at 64 KB (413) before any store call', async () => {
    api.setSessionForTests(ADMIN);
    api.setAcqS3ForTests(tripS3);
    touched = [];
    const r = await api.handler(ev('/admin/library/journey', 'POST', { body: JSON.stringify({ family: 'vacuum', title: 'x'.repeat(70 * 1024) }) }));
    expect(r.statusCode).toBe(413);
    expect(touched).toEqual([]);
  });

  it('invalid JSON is a 400, not a 500', async () => {
    api.setSessionForTests(ADMIN);
    api.setAcqS3ForTests(memS3());
    expect((await api.handler(ev('/admin/library/journey', 'POST', { body: '{not json' }))).statusCode).toBe(400);
    expect((await api.handler(ev('/admin/library/journey/edit', 'POST', { body: '[1,2]' }))).statusCode).toBe(400);
  });
});

describe('ACTIONS — library concurrency, actor attribution and safe delete', () => {
  afterEach(() => { api.setSessionForTests(null); });
  async function seeded() {
    const s3 = memS3();
    api.setAcqS3ForTests(s3);
    api.setSessionForTests(ADMIN);
    const r = await api.handler(ev('/admin/library', 'GET', { qs: {} }));
    expect(r.statusCode).toBe(200);
    return s3;
  }
  async function getJ(id) { return JSON.parse((await api.handler(ev('/admin/library/journey', 'GET', { qs: { id } }))).body).journey; }

  it('a stale expectedUpdatedAt is refused with 409 and changes nothing', async () => {
    const s3 = await seeded();
    const j = await getJ('WM-001');
    const before = s3.m.get('acq/library.json');
    const stale = await api.handler(ev('/admin/library/journey/edit', 'POST', { body: { id: 'WM-001', expectedUpdatedAt: '1999-01-01T00:00:00.000Z', changes: { title: 'Stale write' } } }));
    expect(stale.statusCode).toBe(409);
    expect(JSON.parse(stale.body).error).toBe('STALE');
    expect(s3.m.get('acq/library.json')).toBe(before);
    const fresh = await api.handler(ev('/admin/library/journey/edit', 'POST', { body: { id: 'WM-001', expectedUpdatedAt: j.updatedAt, changes: { title: 'Fresh write' } } }));
    expect(fresh.statusCode).toBe(200);
    const after = JSON.parse(fresh.body);
    expect(after.title).toBe('Fresh write');
    expect(after.updatedBy).toBe('admin@example.test');
    // The old token is now stale for the next writer too (flags / delete).
    expect((await api.handler(ev('/admin/library/journey/flags', 'POST', { body: { id: 'WM-001', expectedUpdatedAt: j.updatedAt, changes: { archived: true } } }))).statusCode).toBe(409);
    expect((await api.handler(ev('/admin/library/journey/delete', 'POST', { body: { id: 'WM-001', expectedUpdatedAt: j.updatedAt } }))).statusCode).toBe(409);
  });

  it('retire / restore records the acting admin; omitting the precondition keeps old behaviour', async () => {
    await seeded();
    const r = await api.handler(ev('/admin/library/journey/flags', 'POST', { body: { id: 'WM-002', changes: { archived: true } } }));
    expect(r.statusCode).toBe(200);
    const j = JSON.parse(r.body);
    expect(j.archived).toBe(true);
    expect(j.updatedBy).toBe('admin@example.test');
  });

  it('unknown scenario is a 404, not a 400/500', async () => {
    await seeded();
    expect((await api.handler(ev('/admin/library/journey/edit', 'POST', { body: { id: 'ZZ-999', changes: {} } }))).statusCode).toBe(404);
    expect((await api.handler(ev('/admin/library/journey/flags', 'POST', { body: { id: 'ZZ-999', changes: { archived: true } } }))).statusCode).toBe(404);
    expect((await api.handler(ev('/admin/library/journey/duplicate', 'POST', { body: { id: 'ZZ-999' } }))).statusCode).toBe(404);
  });

  it('safe delete counts EVERY persisted run, not only the newest 200', async () => {
    const s3 = await seeded();
    // 201 runs; only the OLDEST one used WM-003.
    for (let i = 0; i < 201; i++) {
      const runId = 'acq-2026-01-01T00-00-' + String(i).padStart(3, '0') + 'Z-r' + i;
      const ids = i === 0 ? ['WM-003'] : ['WM-004'];
      s3.m.set('acq/runs/' + runId + '.json', JSON.stringify({ runId, status: 'COMPLETED', startedAt: '2026-01-01T00:00:' + String(i).padStart(3, '0'), manifest: { journeyCount: 1, journeys: ids.map((journeyId) => ({ journeyId, version: 1 })) }, results: [] }));
    }
    const r = await api.handler(ev('/admin/library/journey/delete', 'POST', { body: { id: 'WM-003' } }));
    expect(r.statusCode).toBe(200);
    expect(JSON.parse(r.body)).toEqual({ deleted: false, archived: true });
  });

  it('cancelling an unknown run is a 404 and writes nothing', async () => {
    const s3 = await seeded();
    const keys = Array.from(s3.m.keys());
    const r = await api.handler(ev('/admin/benchmark/run/cancel', 'POST', { body: { id: RUN } }));
    expect(r.statusCode).toBe(404);
    expect(Array.from(s3.m.keys())).toEqual(keys);
  });
});

describe('CANONICAL — Diagnostics exposes the canonical mode read-only', () => {
  const env = { mode: process.env.CANONICAL_MODE, keys: process.env.CANONICAL_CONTROL_JOURNEYS };
  afterEach(() => {
    if (env.mode === undefined) delete process.env.CANONICAL_MODE; else process.env.CANONICAL_MODE = env.mode;
    if (env.keys === undefined) delete process.env.CANONICAL_CONTROL_JOURNEYS; else process.env.CANONICAL_CONTROL_JOURNEYS = env.keys;
    api.setDiagnosticsDepsForTests(null);
    api.setSessionForTests(null);
  });
  async function snapshot() {
    api.setSessionForTests(ADMIN);
    api.setDiagnosticsDepsForTests({
      fetch: async () => ({ ok: true, status: 200, json: async () => ({}), text: async () => '{}' }),
      orchestratorHealthUrl: '', mcpHealthUrl: '', partFinderHealthUrl: '',
      loadOverlay: async () => mediaAdmin.emptyState(),
      loadModels: async () => null,
    });
    const r = await api.handler(ev('/admin/diagnostics', 'GET', { qs: {} }));
    expect(r.statusCode).toBe(200);
    return JSON.parse(r.body);
  }
  it('control mode reports the enabled journey count, never the keys themselves', async () => {
    const keys = registry.KEYS.slice(0, 3);
    process.env.CANONICAL_MODE = 'control';
    process.env.CANONICAL_CONTROL_JOURNEYS = keys.join('+') + '+not-a-real-journey';
    const d = await snapshot();
    expect(d.runtime.canonical).toEqual({ mode: 'control', modeLabel: 'Control (allow-listed journeys)', controlJourneyCount: 3, demoted: false, invalid: false, unknownKeyCount: 1 });
    for (const k of keys) expect(JSON.stringify(d)).not.toContain(k);
  });
  it('off / shadow / empty control allow-list are reported truthfully', async () => {
    process.env.CANONICAL_MODE = 'off';
    expect((await snapshot()).runtime.canonical.mode).toBe('off');
    process.env.CANONICAL_MODE = 'shadow';
    expect((await snapshot()).runtime.canonical.mode).toBe('shadow');
    process.env.CANONICAL_MODE = 'control';
    process.env.CANONICAL_CONTROL_JOURNEYS = '';
    const d = await snapshot();
    expect(d.runtime.canonical.mode).toBe('shadow');
    expect(d.runtime.canonical.demoted).toBe(true);
  });
  it('diagnostics stays GET-only and has no way to change the mode', () => {
    expect(SUPPORTED['/admin/diagnostics']).toEqual(['GET']);
    const fn = src.slice(src.indexOf('function diagnosticsCanonicalMode'), src.indexOf('async function adminDiagnostics'));
    expect(fn).not.toMatch(/process\.env\.CANONICAL_MODE\s*=/);
    expect(fn).not.toMatch(/UpdateFunctionConfiguration/);
  });
});
