/**
 * Settings Apply read-after-write — the SAME eventual-consistency rule the batch routing override
 * uses (config-readback.js). Secrets Manager can briefly return the PREVIOUS version right after a
 * successful PutSecretValue (observed live 2026-10-05). Deterministic failure injection; no AWS.
 */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const ai = require('../ai-config.js');
const settings = require('../settings-admin.js');
const { readBackAfterWrite } = require('../config-readback.js');

const NOSLEEP = { sleep: async () => {}, attempts: 8, delayMs: 0 };

/**
 * An eventually-consistent AI-config store. After a save, the next `stale` reads still return the
 * previous document; `afterSave` can inject another writer; `readFail` fails reads.
 */
function ecStore({ stale = 0, afterSave = null, readFail = 0 } = {}) {
  let cfg = ai.normalise(ai.defaultConfig());
  let prev = null; let staleLeft = 0; let failLeft = readFail;
  const writes = []; let reads = 0;
  return {
    writes, get reads() { return reads; },
    async loadConfigWithStatus() {
      reads++;
      if (writes.length && failLeft > 0) { failLeft--; return { cfg: ai.defaultConfig(), status: 'unavailable' }; }
      if (staleLeft > 0 && prev) { staleLeft--; return { cfg: JSON.parse(JSON.stringify(prev)), status: 'ok' }; }
      return { cfg: JSON.parse(JSON.stringify(cfg)), status: 'ok' };
    },
    async saveConfig(next) {
      writes.push(JSON.parse(JSON.stringify(next)));
      prev = cfg; staleLeft = stale;
      cfg = ai.normalise(JSON.parse(JSON.stringify(next)));
      if (afterSave) afterSave((fn) => { const c = JSON.parse(JSON.stringify(cfg)); fn(c); cfg = ai.normalise(c); prev = cfg; staleLeft = 0; });
    },
    snapshot() { return cfg; },
  };
}
function deps(store, extra) {
  return Object.assign({
    loadConfigWithStatus: store.loadConfigWithStatus.bind(store), saveConfig: store.saveConfig.bind(store),
    isKeyConfigured: async () => true, runningModels: { available: false }, partFinderHealthUrl: '',
    loadJevWithStatus: async () => ({ status: 'absent', stored: null, public: ai.defaultJevPublic() }),
    readBack: NOSLEEP, byEmail: 'admin@example.test',
  }, extra || {});
}
async function apply(store, extra, body) {
  const rev = (await settings.buildView(deps(store))).diagnosticInference.revision;
  return settings.saveInferencePatch(Object.assign(deps(store, extra), { body: Object.assign({ expectedVersion: 1, expectedRevision: rev, local: { model: 'qwen' }, note: 'set the model' }, body || {}) }));
}

describe('shared rule (config-readback.js)', () => {
  const rev = (d) => d.rev;
  it('expected revision → verified on the first read', async () => {
    const r = await readBackAfterWrite({ read: async () => ({ rev: 'NEW' }), revisionOf: rev, expectedRevision: 'NEW', priorRevision: 'OLD', ...NOSLEEP });
    expect(r).toMatchObject({ status: 'verified', reads: 1 });
  });
  it('old revision then new → verified after re-reads', async () => {
    const seq = ['OLD', 'OLD', 'NEW']; let i = 0;
    const r = await readBackAfterWrite({ read: async () => ({ rev: seq[Math.min(i++, 2)] }), revisionOf: rev, expectedRevision: 'NEW', priorRevision: 'OLD', ...NOSLEEP });
    expect(r).toMatchObject({ status: 'verified', reads: 3 });
  });
  it('a third revision → conflict at once (never waited out)', async () => {
    let n = 0;
    const r = await readBackAfterWrite({ read: async () => { n++; return { rev: 'OTHER' }; }, revisionOf: rev, expectedRevision: 'NEW', priorRevision: 'OLD', ...NOSLEEP });
    expect(r).toMatchObject({ status: 'conflict', revision: 'OTHER' });
    expect(n).toBe(1);
  });
  it('old revision for the whole window → not_visible (bounded)', async () => {
    let n = 0;
    const r = await readBackAfterWrite({ read: async () => { n++; return { rev: 'OLD' }; }, revisionOf: rev, expectedRevision: 'NEW', priorRevision: 'OLD', ...NOSLEEP });
    expect(r).toMatchObject({ status: 'not_visible' });
    expect(n).toBe(8);
  });
  it('every read fails → read_failed; a failed read then the new revision → verified', async () => {
    expect((await readBackAfterWrite({ read: async () => { throw new Error('x'); }, revisionOf: rev, expectedRevision: 'NEW', priorRevision: 'OLD', ...NOSLEEP })).status).toBe('read_failed');
    let i = 0;
    expect((await readBackAfterWrite({ read: async () => (i++ === 0 ? null : { rev: 'NEW' }), revisionOf: rev, expectedRevision: 'NEW', priorRevision: 'OLD', ...NOSLEEP })).status).toBe('verified');
  });
  it('the batch routing override uses the same module (one consistency strategy)', () => {
    const ro = fs.readFileSync(path.join(here, '..', 'benchmark', 'routing-override.js'), 'utf8');
    const sa = fs.readFileSync(path.join(here, '..', 'settings-admin.js'), 'utf8');
    expect(ro).toContain("require('../config-readback.js')");
    expect(sa).toContain("require('./config-readback')");
    const deploy = fs.readFileSync(path.join(here, '..', 'deploy.sh'), 'utf8');
    expect(deploy).toMatch(/zip -qr \/tmp\/whichpart-api\.zip[^\n]*config-readback\.js/);
  });
});

describe('Settings Apply (diagnostic inference)', () => {
  it('write succeeds, first reads return the OLD revision, later the new → success, verified, no 409', async () => {
    const store = ecStore({ stale: 3 });
    const r = await apply(store);
    expect(r.ok).toBe(true);
    expect(r.apply).toMatchObject({ written: true, verified: true, verification: 'verified', version: 2 });
    expect(store.writes).toHaveLength(1);                 // one write — read-back never re-writes
    expect(store.snapshot().history).toHaveLength(1);     // one history entry
    expect(store.snapshot().history[0]).toMatchObject({ byEmail: 'admin@example.test', note: 'set the model' });
    expect(store.snapshot().history[0].changes.find((c) => c.field === 'local.model')).toMatchObject({ to: 'qwen' });
  });
  it('BEFORE this fix the same store would have produced a false 409 (one immediate read)', async () => {
    const store = ecStore({ stale: 3 });
    const r = await apply(store, { readBack: { ...NOSLEEP, attempts: 1 } });
    expect(r.ok).toBe(true);
    expect(r.apply.verification).toBe('not_visible'); // and never a 409 any more
  });
  it('old revision persists for the whole window → explicit not_visible, written, not a 409 and not "nothing applied"', async () => {
    const store = ecStore({ stale: 100 });
    const r = await apply(store);
    expect(r.ok).toBe(true);
    expect(r.status).toBe(200);
    expect(r.apply).toMatchObject({ written: true, verified: false, verification: 'not_visible' });
    expect(r.apply.verificationNote).toMatch(/accepted the change/);
    expect(store.writes).toHaveLength(1);
  });
  it('a DIFFERENT revision appears → real conflict (409 concurrent_write), at once', async () => {
    const store = ecStore({ stale: 0, afterSave: (other) => other((c) => { c.routing.compose = 'local'; c.local.model = 'other-writer'; }) });
    const before = store.reads;
    const r = await apply(store);
    expect(r).toMatchObject({ ok: false, status: 409, code: 'concurrent_write' });
    expect(store.reads - before).toBeLessThanOrEqual(3); // buildView read + load + ONE verify read
  });
  it('another writer arriving WHILE the old revision is still shown is still a conflict', async () => {
    let otherWrite;
    const store = ecStore({ stale: 2, afterSave: (other) => { otherWrite = other; } });
    let n = 0;
    const r = await apply(store, { readBack: { ...NOSLEEP, sleep: async () => { if (++n === 1) otherWrite((c) => { c.local.model = 'other-writer'; }); } } });
    expect(r).toMatchObject({ ok: false, status: 409, code: 'concurrent_write' });
  });
  it('the store cannot be read back → written, verification read_failed (not 409, not 503)', async () => {
    const store = ecStore({ readFail: 100 });
    const r = await apply(store);
    expect(r.ok).toBe(true);
    expect(r.apply).toMatchObject({ written: true, verified: false, verification: 'read_failed' });
  });
  it('the write itself fails → 503 store_failed, nothing written, no read-back', async () => {
    const store = ecStore();
    const r = await apply(store, { saveConfig: async () => { throw new Error('ThrottlingException'); } });
    expect(r).toMatchObject({ ok: false, status: 503, code: 'store_failed' });
  });
  it('a stale page is still a 409 conflict before anything is written', async () => {
    const store = ecStore();
    const r = await settings.saveInferencePatch(Object.assign(deps(store), { body: { expectedVersion: 1, expectedRevision: '0123456789abcdef', local: { model: 'qwen' }, note: 'set the model' } }));
    expect(r).toMatchObject({ ok: false, status: 409, code: 'conflict' });
    expect(store.writes).toHaveLength(0);
  });
  it('no-op apply: no write, no history, no version bump, no read-back', async () => {
    const store = ecStore();
    const r = await settings.saveInferencePatch(Object.assign(deps(store), { body: { expectedVersion: 1, routing: { compose: 'local' }, local: { model: '' } } }));
    expect(r.ok).toBe(true);
    expect(r.apply.written).toBe(false);
    expect(store.writes).toHaveLength(0);
    expect(store.snapshot().version || 1).toBe(1);
  });
});

describe('Settings Apply (Jev) — same rule, version identity', () => {
  function jevStore({ stale = 0, bump = false } = {}) {
    let stored = { accountId: 'acc', apiToken: 'old-secret-token', gatewayId: '', version: 1, history: [] };
    let prev = null; let staleLeft = 0; const writes = [];
    return {
      writes,
      async load() { const s = staleLeft > 0 && prev ? (staleLeft--, prev) : stored; return { status: 'ok', stored: s, public: ai.toJevPublic(s) }; },
      async save(n) { writes.push(n); prev = stored; staleLeft = stale; stored = n; if (bump) { stored = { ...n, version: n.version + 1 }; prev = stored; staleLeft = 0; } },
    };
  }
  const run = (s) => settings.saveJevPatch({ body: { expectedVersion: 1, accountId: 'acc2', apiToken: 'new-secret-token', note: 'Move account' }, byEmail: 'admin@example.test', loadJevWithStatus: s.load, saveJevStored: s.save, loadConfigWithStatus: ecStore().loadConfigWithStatus, isKeyConfigured: async () => false, runningModels: { available: false }, readBack: NOSLEEP });
  it('old version briefly, then the new one → verified', async () => {
    const s = jevStore({ stale: 2 });
    const r = await run(s);
    expect(r.ok).toBe(true);
    expect(r.apply).toMatchObject({ written: true, verified: true, verification: 'verified' });
    expect(s.writes).toHaveLength(1);
  });
  it('a different version → 409 concurrent_write', async () => {
    const r = await run(jevStore({ bump: true }));
    expect(r).toMatchObject({ ok: false, status: 409, code: 'concurrent_write' });
  });
  it('never returns the token in the response', async () => {
    const r = await run(jevStore({ stale: 1 }));
    expect(JSON.stringify(r)).not.toMatch(/new-secret-token|old-secret-token/);
  });
});
