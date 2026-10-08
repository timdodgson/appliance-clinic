/**
 * Phase 7: batch runs default to staging, production needs explicit intent, and live AI routing (also read by the
 * Spares4Repairs diagnosis service) is never rewritten for a run that does not carry recorded routing intent.
 */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const { decideTarget, routingAllowed } = require('../benchmark/target.js');
const { createRoutingOverride, planOverride } = require('../benchmark/routing-override.js');
const { createStore: createAcqStore, memoryS3 } = require('../benchmark/acq-store.js');

const NOW = () => Date.parse('2026-10-08T12:00:00Z');
const LIVE = { version: 3, routing: { understand: 'jev', compose: 'local' }, local: { model: 'live-model' }, frontier: { enabled: false } };
const noChange = planOverride(LIVE, { compose: { provider: 'lmstudio', model: '' } });
const change = planOverride(LIVE, { compose: { provider: 'openai', model: 'gpt-x' } });

describe('decideTarget', () => {
  it('defaults to staging and refuses while no staging is configured', () => {
    const d = decideTarget({}, { plan: noChange, env: {} });
    expect(d.ok).toBe(false);
    expect(d.status).toBe(409);
    expect(d.body.error).toBe('STAGING_NOT_CONFIGURED');
    expect(decideTarget({ target: 'staging' }, { plan: noChange, env: {} }).body.error).toBe('STAGING_NOT_CONFIGURED');
  });
  it('accepts staging once a staging environment is configured', () => {
    const d = decideTarget({}, { plan: change, env: { BENCHMARK_STAGING_URL: 'https://staging.example.test/api' } });
    expect(d).toMatchObject({ ok: true, target: 'staging', productionIntent: null });
  });
  it('rejects an unknown target', () => {
    expect(decideTarget({ target: 'prod' }, { plan: noChange, env: {} })).toMatchObject({ ok: false, status: 400 });
    expect(decideTarget({ target: ['production'] }, { plan: noChange, env: {} })).toMatchObject({ ok: false, status: 400 });
  });
  it('production needs confirmProduction === true (not truthy)', () => {
    for (const c of [undefined, false, 'true', 1]) {
      const d = decideTarget({ target: 'production', confirmProduction: c }, { plan: noChange, env: {} });
      expect(d.body.error).toBe('PRODUCTION_CONFIRMATION_REQUIRED');
    }
  });
  it('production without a routing change needs no routing confirmation, and records intent', () => {
    const d = decideTarget({ target: 'production', confirmProduction: true }, { plan: noChange, by: 'a@example.test', now: NOW, env: {} });
    expect(d).toEqual({ ok: true, target: 'production', productionIntent: { by: 'a@example.test', at: '2026-10-08T12:00:00.000Z', routing: false } });
  });
  it('a routing change needs confirmProductionRouting === true, and lists the changes', () => {
    const d = decideTarget({ target: 'production', confirmProduction: true }, { plan: change, env: {} });
    expect(d).toMatchObject({ ok: false, status: 409, body: { error: 'PRODUCTION_ROUTING_CONFIRMATION_REQUIRED' } });
    expect(d.body.changes.map((c) => c.field)).toContain('routing.compose');
    const ok = decideTarget({ target: 'production', confirmProduction: true, confirmProductionRouting: true }, { plan: change, env: {} });
    expect(ok.ok).toBe(true);
    expect(ok.productionIntent.routing).toBe(true);
  });
  it('an unknown plan (live document unreadable) is treated as a routing change', () => {
    expect(decideTarget({ target: 'production', confirmProduction: true }, { plan: null, env: {} }).body.error).toBe('PRODUCTION_ROUTING_CONFIRMATION_REQUIRED');
  });
});

describe('routingAllowed', () => {
  it('only a production run with recorded routing intent', () => {
    expect(routingAllowed({ target: 'production', productionIntent: { routing: true } })).toBe(true);
    expect(routingAllowed({ target: 'production', productionIntent: { routing: false } })).toBe(false);
    expect(routingAllowed({ target: 'staging', productionIntent: { routing: true } })).toBe(false);
    expect(routingAllowed({ productionIntent: { routing: 'true' }, target: 'production' })).toBe(false);
    expect(routingAllowed({})).toBe(false);
    expect(routingAllowed(null)).toBe(false);
  });
});

function harness() {
  const writes = { lock: 0, doc: 0 };
  let lock = null; let etag = 0; let doc = JSON.parse(JSON.stringify(LIVE));
  const ro = createRoutingOverride({
    lockStore: {
      get: async () => (lock ? { body: JSON.stringify(lock), etag: String(etag) } : null),
      put: async (k, body) => { writes.lock++; lock = JSON.parse(body); etag++; return String(etag); },
    },
    loadDoc: async () => ({ status: 'ok', doc: JSON.parse(JSON.stringify(doc)) }),
    saveDoc: async (d) => { writes.doc++; doc = JSON.parse(JSON.stringify(d)); },
    revisionOf: (d) => JSON.stringify(d.routing) + JSON.stringify(d.local) + JSON.stringify(d.frontier) + String(d.version),
    log: () => {},
  });
  return { ro, writes, getDoc: () => doc };
}
const run = (extra) => ({ runId: 'acq-2026-10-08T12-00-00-000Z-abcd1234', label: 't', config: { understand: { provider: 'lmstudio' }, compose: { provider: 'openai', model: 'gpt-x' } }, ...extra });

describe('routing override begin()', () => {
  it('refuses a routing change for a run without recorded intent, and writes nothing', async () => {
    for (const r of [run(), run({ target: 'production', productionIntent: { routing: false } }), run({ target: 'staging' })]) {
      const h = harness();
      const res = await h.ro.begin({ run: r, workerId: 'w' });
      expect(res).toMatchObject({ ok: false, code: 'production_routing_not_confirmed' });
      expect(h.writes).toEqual({ lock: 0, doc: 0 });
      expect(h.getDoc()).toEqual(LIVE);
    }
  });
  it('a run that needs no routing change is unaffected', async () => {
    const h = harness();
    const res = await h.ro.begin({ run: run({ config: { compose: { provider: 'lmstudio', model: '' } } }), workerId: 'w' });
    expect(res).toMatchObject({ ok: true, required: false });
    expect(h.writes.doc).toBe(0);
  });
  it('a run with recorded production routing intent proceeds to take the lease', async () => {
    const h = harness();
    await h.ro.begin({ run: run({ target: 'production', productionIntent: { by: 'a', at: 'x', routing: true } }), workerId: 'w' }).catch(() => null);
    expect(h.writes.lock).toBeGreaterThan(0); // the guard let it through to the existing lease logic
  });
});

describe('the run record carries the target and intent', () => {
  it('enqueueRun records target and productionIntent', async () => {
    const store = createAcqStore({ s3: memoryS3() });
    const rec = await store.enqueueRun({ benchmarkVersion: 'v', understand: { provider: 'lmstudio' }, compose: { provider: 'lmstudio' }, journeyCount: 1,
      target: 'production', productionIntent: { by: 'a@example.test', at: 'x', routing: false } }, { email: 'a@example.test' });
    expect(rec.target).toBe('production');
    expect(rec.productionIntent).toEqual({ by: 'a@example.test', at: 'x', routing: false });
  });
});

describe('source guard: every enqueue goes through the target gate', () => {
  it('each acqStore.enqueueRun call in index.js is preceded by batchTarget in the same handler', () => {
    const src = fs.readFileSync(path.join(here, '..', 'index.js'), 'utf8');
    const calls = [...src.matchAll(/acqStore\.enqueueRun\(/g)].map((m) => m.index);
    expect(calls.length).toBe(3);
    for (const i of calls) {
      const fnStart = src.lastIndexOf('\nasync function ', i);
      expect(src.slice(fnStart, i)).toMatch(/await batchTarget\(/);
    }
  });
});
