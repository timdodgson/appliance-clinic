/**
 * Safety / Recall hardening — ingest safety, Admin listing decisions (draft → publish → versions →
 * rollback, archive/restore), concurrency, provenance/supersession, matching boundary, auth.
 * Drives the REAL ingest pipeline (parse → classify → lifecycle → store) over a memory store and
 * fixture GOV.UK documents. No network.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const storeMod = require('../recalls/store.js');
const ingest = require('../recalls/ingest.js');
const lifecycle = require('../recalls/lifecycle.js');
const recallAdmin = require('../recalls/admin.js');
const http = require('../recalls/http.js');
const fixtures = require('./fixtures/opss-content');
const api = require('../index.js');

const clone = (x) => JSON.parse(JSON.stringify(x));
const ADMIN = 'admin@example.test';
const WASHER = fixtures.foldingWasher.content_id;
const DRYER = fixtures.haierDryer.content_id;
const HOB = fixtures.samsungHob.content_id;
const WALLBOX = fixtures.wallbox.content_id;

function gov(docs) {
  return function fetchFn(url) {
    const u = String(url);
    if (u.indexOf('https://www.gov.uk/api/search.json') === 0) {
      const results = Object.keys(docs).map((link) => ({ link, title: docs[link].title, description: docs[link].description, public_timestamp: docs[link].public_updated_at }));
      return Promise.resolve({ ok: true, status: 200, text: async () => JSON.stringify({ total: results.length, results }) });
    }
    if (u.indexOf('https://www.gov.uk/api/content/') === 0) {
      const p = u.replace('https://www.gov.uk/api/content', '');
      const doc = docs[p];
      if (doc === 'FAIL') return Promise.reject(new Error('socket hang up'));
      if (!doc) return Promise.resolve({ ok: false, status: 404, text: async () => '{}' });
      return Promise.resolve({ ok: true, status: 200, text: async () => JSON.stringify(doc) });
    }
    return Promise.reject(new Error('blocked ' + u));
  };
}
function baseDocs() {
  const out = {};
  ['foldingWasher', 'haierDryer', 'samsungHob', 'wallbox', 'pressureWasher'].forEach((k) => { out[fixtures[k].base_path] = clone(fixtures[k]); });
  return out;
}
async function seeded() {
  const store = storeMod.createMemoryStore();
  const docs = baseDocs();
  const r = await ingest.run({ store, fetch: gov(docs), skipPublish: true, now: new Date('2026-09-18T12:00:00Z'), mode: 'backfill' });
  expect(r.ok).toBe(true);
  return { store, docs };
}
function adminFor(store, pages) {
  return recallAdmin.createAdmin(() => store, {
    now: () => new Date('2026-09-21T10:00:00Z'),
    publishSite: async (s, nowIso, put, unlisted) => { pages.push({ unlisted: (unlisted || []).map((u) => u.slug), listed: (await s.listPublished()).map((r) => r.slug) }); return { pages: 1 }; },
  });
}
const lookup = async (store, q, family) => (await http.createHandlers(() => store).publicLookup({ queryStringParameters: { q, family } })).body;
const publicGet = async (store, id) => http.createHandlers(() => store).publicGet({ queryStringParameters: { id } });

describe('ingest: validation, partial failure, mass-unlisting guard, idempotency', () => {
  it('valid ingest lists in-scope notices; duplicate ingest changes nothing', async () => {
    const { store, docs } = await seeded();
    expect((await store.listPublished()).map((r) => r.contentId).sort()).toEqual([WASHER, DRYER, HOB].sort());
    const before = JSON.stringify(await store.listAll());
    const again = await ingest.run({ store, fetch: gov(docs), skipPublish: true, now: new Date('2026-09-18T13:00:00Z'), mode: 'backfill' });
    expect(again.counts.created).toBe(0);
    expect(again.counts.changed).toBe(0);
    const after = await store.listAll();
    expect(after.length).toBe(JSON.parse(before).length);
    expect(after.map((r) => [r.contentId, r.state, r.bodyHash])).toEqual(JSON.parse(before).map((r) => [r.contentId, r.state, r.bodyHash]));
  });

  it('a malformed refresh of a live notice is rejected and the live row is untouched', async () => {
    const { store, docs } = await seeded();
    const live = await store.get(DRYER);
    const bad = docs[fixtures.haierDryer.base_path];
    bad.details.body += '<p>changed</p>';
    delete bad.details.metadata.product_recall_alert_date;
    delete bad.first_published_at;
    const r = await ingest.run({ store, fetch: gov(docs), skipPublish: true, now: new Date('2026-09-19T12:00:00Z'), mode: 'backfill' });
    expect(r.counts.reasons['invalid-source']).toBe(1);
    const now = await store.get(DRYER);
    expect(now.bodyHash).toBe(live.bodyHash);
    expect(now.state).toBe('published');
    expect(now.alertDate).toBe(live.alertDate);
  });

  it('a malformed NEW notice is held for review, never listed', async () => {
    const store = storeMod.createMemoryStore();
    const docs = baseDocs();
    const d = docs[fixtures.haierDryer.base_path];
    delete d.details.metadata.product_recall_alert_date;
    delete d.first_published_at;
    await ingest.run({ store, fetch: gov(docs), skipPublish: true, now: new Date('2026-09-18T12:00:00Z'), mode: 'backfill' });
    const rec = await store.get(DRYER);
    expect(rec.state).toBe('review');
    expect(rec.validation).toMatchObject({ ok: false, fields: ['alertDate'] });
    expect((await store.listPublished()).map((x) => x.contentId)).not.toContain(DRYER);
  });

  it('partial fetch failure: other notices update, the failed one keeps its last-good row', async () => {
    const { store, docs } = await seeded();
    const hobBefore = await store.get(HOB);
    docs[fixtures.samsungHob.base_path] = 'FAIL';
    docs[fixtures.haierDryer.base_path].details.body = docs[fixtures.haierDryer.base_path].details.body.replace('HD80-A3S979', 'HD80-A3S979, HD100-NEW');
    const r = await ingest.run({ store, fetch: gov(docs), skipPublish: true, now: new Date('2026-09-19T12:00:00Z'), mode: 'backfill' });
    expect(r.counts.failed).toBe(1);
    expect((await store.get(HOB)).bodyHash).toBe(hobBefore.bodyHash);
    expect((await store.get(HOB)).state).toBe('published');
    expect((await store.get(DRYER)).models).toContain('HD100-NEW');
  });

  it('a run that would unlist many live notices is held (live dataset kept) and reported', async () => {
    const store = storeMod.createMemoryStore();
    const docs = {};
    for (let i = 0; i < 6; i += 1) {
      const d = clone(fixtures.foldingWasher);
      d.content_id = '11111111-1111-4111-8111-11111111110' + i;
      d.base_path = fixtures.foldingWasher.base_path + '-' + i;
      d.details.body += '<p>' + i + '</p>';
      docs[d.base_path] = d;
    }
    await ingest.run({ store, fetch: gov(docs), skipPublish: true, now: new Date('2026-09-18T12:00:00Z'), mode: 'backfill' });
    expect((await store.listPublished()).length).toBe(6);
    Object.values(docs).forEach((d) => {
      d.title = 'Product Safety Report: High Pressure Washer Gun';
      d.details.body = d.details.body.replace(/Clothes Washers/g, 'Pressure Washers').replace(/Folding Washing Machine/g, 'High Pressure Washer Gun') + '<p>x</p>';
    });
    const r = await ingest.run({ store, fetch: gov(docs), skipPublish: true, now: new Date('2026-09-19T12:00:00Z'), mode: 'backfill' });
    expect(r.counts.heldUnlistings).toBe(6);
    expect((await store.listPublished()).length).toBe(6);
    const meta = await store.getMeta();
    expect(meta.lastFailureSafe).toBe(true);
    expect(meta.history[0].note).toMatch(/above the safety limit/);
  });

  it('a superseded source keeps the original official content (source revisions), current reflects the update', async () => {
    const { store, docs } = await seeded();
    const original = await store.get(DRYER);
    docs[fixtures.haierDryer.base_path].details.body = docs[fixtures.haierDryer.base_path].details.body.replace('HD80-A3S979', 'HD80-A3S979, HD100-NEW');
    await ingest.run({ store, fetch: gov(docs), skipPublish: true, now: new Date('2026-09-19T12:00:00Z'), mode: 'backfill' });
    const cur = await store.get(DRYER);
    expect(cur.models).toContain('HD100-NEW');
    expect(cur.sourceRevisions.length).toBe(1);
    expect(cur.sourceRevisions[0]).toMatchObject({ bodyHash: original.bodyHash, title: original.title, hazard: original.hazard, models: original.models, supersededAt: '2026-09-19T12:00:00.000Z' });
  });
});

describe('Admin listing decision: draft → publish → versions → rollback; archive / restore', () => {
  let store; let docs; let pages; let adm;
  beforeEach(async () => { ({ store, docs } = await seeded()); pages = []; adm = adminFor(store, pages); });

  it('save draft does NOT change customers; publish does (held notice becomes listed)', async () => {
    const held = await adm.get(WALLBOX);
    expect(held.state).toBe('excluded');
    const d = await adm.saveDraft(WALLBOX, { expectedRevision: held.admin.revision, family: 'washing machine', note: 'Test: correct listing for this notice', actor: ADMIN });
    expect(d.admin.draft).toMatchObject({ status: 'published', family: 'washing machine', savedBy: ADMIN });
    expect(d.state).toBe('excluded');
    expect(d.admin.draftEffect).toMatchObject({ listed: true, state: 'published' });
    expect((await store.listPublished()).map((r) => r.contentId)).not.toContain(WALLBOX);
    expect((await publicGet(store, WALLBOX)).status).toBe(404);
    expect(pages).toEqual([]); // no public page work for a draft
    const p = await adm.publish(WALLBOX, { expectedRevision: d.admin.revision, actor: ADMIN });
    expect(p.state).toBe('published');
    expect(p.family).toBe('washing machine');
    expect(p.applied).toEqual({ version: 1 });
    expect((await store.listPublished()).map((r) => r.contentId)).toContain(WALLBOX);
    expect((await publicGet(store, WALLBOX)).status).toBe(200);
    expect(pages.length).toBe(1);
    const v = p.admin.versions.find((x) => x.version === 1);
    expect(v).toMatchObject({ action: 'publish', by: ADMIN, previousRevision: 1, newRevision: 2, effectiveState: 'published', sourceHash: (await store.get(WALLBOX)).bodyHash });
    expect(v.changed).toEqual(['status', 'family', 'note']);
  });

  it('archive withholds from every customer surface, keeps source + history; restore brings it back', async () => {
    const r0 = await adm.get(DRYER);
    await expect(adm.archive(DRYER, { expectedRevision: r0.admin.revision, reason: '' })).rejects.toMatchObject({ code: 'invalid' });
    const a = await adm.archive(DRYER, { expectedRevision: r0.admin.revision, reason: 'Duplicate of the manufacturer notice', actor: ADMIN });
    expect(a.state).toBe('archived');
    expect((await store.listPublished()).map((r) => r.contentId)).not.toContain(DRYER);
    expect((await publicGet(store, DRYER)).status).toBe(404);
    expect((await lookup(store, 'HD90-A3S979')).items).toEqual([]);
    expect(pages[0].unlisted).toEqual([r0.slug]);
    const raw = await store.get(DRYER);
    expect(raw.hazard).toBe(r0.notice.hazard);
    expect(raw.sourceUrl).toBe(r0.sourceUrl);
    const back = await adm.restore(DRYER, { expectedRevision: a.admin.revision, actor: ADMIN });
    expect(back.state).toBe('published');
    expect((await lookup(store, 'HD90-A3S979')).items.map((x) => x.id)).toEqual([DRYER]);
    expect(back.admin.versions.map((v) => [v.version, v.action])).toEqual([[0, 'ingest'], [1, 'archive'], [2, 'restore']]);
  });

  it('rollback creates a NEW version from older content and never rewrites history', async () => {
    let r = await adm.get(WALLBOX);
    r = await adm.saveDraft(WALLBOX, { expectedRevision: r.admin.revision, family: 'washing machine', note: 'First family decision', actor: ADMIN });
    r = await adm.publish(WALLBOX, { expectedRevision: r.admin.revision, actor: ADMIN });
    r = await adm.saveDraft(WALLBOX, { expectedRevision: r.admin.revision, family: 'tumble-dryer', note: 'Second family decision', actor: ADMIN });
    r = await adm.publish(WALLBOX, { expectedRevision: r.admin.revision, actor: ADMIN });
    expect(r.family).toBe('tumble-dryer');
    const v1Before = clone(r.admin.versions.find((v) => v.version === 1));
    r = await adm.rollback(WALLBOX, { expectedRevision: r.admin.revision, toVersion: 1, actor: ADMIN });
    expect(r.applied).toEqual({ version: 3 });
    expect(r.family).toBe('washing machine');
    expect(r.admin.versions.find((v) => v.version === 3)).toMatchObject({ action: 'rollback', rolledBackFrom: 1 });
    expect(r.admin.versions.find((v) => v.version === 1)).toEqual(v1Before);
    r = await adm.rollback(WALLBOX, { expectedRevision: r.admin.revision, toVersion: 0, actor: ADMIN });
    expect(r.state).toBe('excluded'); // v0 = as ingested: classifier decision again
    expect((await store.listPublished()).map((x) => x.contentId)).not.toContain(WALLBOX);
    expect(pages[pages.length - 1].unlisted).toEqual([r.slug]);
    await expect(adm.rollback(WALLBOX, { expectedRevision: r.admin.revision, toVersion: 4 })).rejects.toMatchObject({ code: 'invalid' });
  });

  it('discard drops the draft; nothing live changes; delete is not offered', async () => {
    let r = await adm.get(HOB);
    r = await adm.saveDraft(HOB, { expectedRevision: r.admin.revision, family: 'oven-cooker', note: 'Trying a different family', actor: ADMIN });
    expect(r.family).toBe('hobs');
    await expect(adm.rollback(HOB, { expectedRevision: r.admin.revision, toVersion: 0 })).rejects.toMatchObject({ code: 'draft_pending' });
    r = await adm.discardDraft(HOB, { expectedRevision: r.admin.revision });
    expect(r.admin.draft).toBeNull();
    expect(r.family).toBe('hobs');
    expect(r.admin.canDelete).toBe(false);
    expect(pages).toEqual([]);
  });

  it('validation: family + reason required; withdrawn notices cannot be listed', async () => {
    const r = await adm.get(WALLBOX);
    await expect(adm.saveDraft(WALLBOX, { expectedRevision: r.admin.revision, family: 'cars', note: 'valid reason' })).rejects.toMatchObject({ code: 'invalid', extra: { fields: ['family'] } });
    await expect(adm.saveDraft(WALLBOX, { expectedRevision: r.admin.revision, family: 'hobs', note: 'x' })).rejects.toMatchObject({ code: 'invalid', extra: { fields: ['note'] } });
    const raw = await store.get(DRYER);
    raw.withdrawn = { at: '2026-09-20', explanation: 'Withdrawn by OPSS' };
    lifecycle.applyEffective(raw);
    await store.put(raw);
    const w = await adm.get(DRYER);
    expect(w.state).toBe('withdrawn');
    expect((await store.listPublished()).map((x) => x.contentId)).not.toContain(DRYER);
    await expect(adm.saveDraft(DRYER, { expectedRevision: w.admin.revision, family: 'tumble-dryer', note: 'Try to relist it' })).rejects.toMatchObject({ code: 'invalid_state' });
  });

  it('an Admin decision survives a later source refresh; the decision records which source it was made on', async () => {
    let r = await adm.get(WALLBOX);
    r = await adm.saveDraft(WALLBOX, { expectedRevision: r.admin.revision, family: 'washing machine', note: 'List under washing machines', actor: ADMIN });
    r = await adm.publish(WALLBOX, { expectedRevision: r.admin.revision, actor: ADMIN });
    const madeOn = r.admin.versions[1].sourceHash;
    docs[fixtures.wallbox.base_path].details.body += '<p>source update</p>';
    await ingest.run({ store, fetch: gov(docs), skipPublish: true, now: new Date('2026-09-22T12:00:00Z'), mode: 'backfill' });
    const after = await adm.get(WALLBOX);
    expect(after.state).toBe('published');
    expect(after.family).toBe('washing machine');
    expect(after.sourceRevisions[0].bodyHash).toBe(madeOn);
    const v = await adm.version(WALLBOX, 1);
    expect(v.sameSourceAsCurrent).toBe(false);
    expect(v.sourceAtThatTime).not.toBeNull();
  });

  it('publish refuses when the official notice changed after the draft was reviewed', async () => {
    let r = await adm.get(WALLBOX);
    r = await adm.saveDraft(WALLBOX, { expectedRevision: r.admin.revision, family: 'washing machine', note: 'List under washing machines' });
    await expect(adm.publish(WALLBOX, { expectedRevision: r.admin.revision, expectedSourceHash: 'not-the-current-hash' })).rejects.toMatchObject({ code: 'source_changed', status: 409 });
  });
});

describe('concurrency', () => {
  it('a stale editor is rejected (409) and nothing is written', async () => {
    const { store } = await seeded();
    const adm = adminFor(store, []);
    const r = await adm.get(HOB);
    await adm.saveDraft(HOB, { expectedRevision: r.admin.revision, family: 'oven-cooker', note: 'First editor reason' });
    const rev = (await store.get(HOB))._rev;
    await expect(adm.saveDraft(HOB, { expectedRevision: r.admin.revision, family: 'hobs', note: 'Second editor reason' })).rejects.toMatchObject({ code: 'conflict', status: 409 });
    await expect(adm.saveDraft(HOB, { family: 'hobs', note: 'No revision at all' })).rejects.toMatchObject({ code: 'revision_required' });
    expect((await store.get(HOB))._rev).toBe(rev);
  });

  it('an ingest write racing an Admin decision does not erase the decision', async () => {
    const { store, docs } = await seeded();
    const adm = adminFor(store, []);
    let r = await adm.get(WALLBOX);
    // simulate: ingest read the row (rev N), then Admin published, then ingest writes with the stale rev
    const staleRead = await store.get(WALLBOX);
    r = await adm.saveDraft(WALLBOX, { expectedRevision: r.admin.revision, family: 'hobs', note: 'Admin decision during ingest' });
    r = await adm.publish(WALLBOX, { expectedRevision: r.admin.revision });
    const pending = { record: Object.assign(clone(staleRead), { lastCheckedAt: '2026-09-23T00:00:00.000Z' }), expectedRev: staleRead._rev };
    lifecycle.applyEffective(pending.record);
    const w = await ingest.writeIngested(store, pending, '2026-09-23T00:00:00.000Z');
    expect(w.retried).toBe(true);
    const now = await store.get(WALLBOX);
    expect(now.admin.live).toMatchObject({ status: 'published', family: 'hobs' });
    expect(now.state).toBe('published');
    expect(docs).toBeTruthy();
  });

  it('live Admin actions refuse while an ingest holds the lock', async () => {
    const { store } = await seeded();
    const adm = adminFor(store, []);
    await store.tryLock({ runId: 'ingest-1', trigger: 'scheduled', startedAt: '2026-09-21T09:59:00Z', expiresAt: '2026-09-21T10:30:00Z' }, new Date('2026-09-21T10:00:00Z'));
    const r = await adm.get(DRYER);
    await expect(adm.archive(DRYER, { expectedRevision: r.admin.revision, reason: 'Archive while ingest running' })).rejects.toMatchObject({ code: 'ingest_running' });
    expect((await store.get(DRYER)).state).toBe('published');
  });
});

describe('matching + customer boundary (unchanged semantics)', () => {
  it('matching model gets the notice; unrelated appliance does not; held/excluded never match', async () => {
    const { store } = await seeded();
    expect((await lookup(store, 'HD90-A3S979')).items.map((x) => x.id)).toEqual([DRYER]);
    expect((await lookup(store, 'Bosch WAW28750GB')).items).toEqual([]);
    expect((await lookup(store, 'Wallbox Pulsar')).items).toEqual([]);
    expect((await lookup(store, 'HD90-A3S979')).items[0].sourceName).toBe('UK Office for Product Safety and Standards');
    expect((await lookup(store, 'HD90-A3S979')).items[0].sourceUrl).toMatch(/^https:\/\/www\.gov\.uk\/product-safety-alerts-reports-recalls\//);
  });

  it('public payloads expose no Admin decision data', async () => {
    const { store } = await seeded();
    const adm = adminFor(store, []);
    const r = await adm.get(HOB);
    await adm.saveDraft(HOB, { expectedRevision: r.admin.revision, family: 'hobs', note: 'Internal reason not for customers' });
    const pub = (await publicGet(store, HOB)).body;
    expect(JSON.stringify(pub)).not.toMatch(/Internal reason|admin|draft|classification|bodyHash|validation/);
  });

  it('recall data never enters the diagnosis view (toWhichPartView has no recall field)', () => {
    const v = api.toWhichPartView({ outcome: 'SAFETY_STOP', message: 'Stop using it.', safety: { class: 'STOP_USE', stopUse: true } }, 't');
    expect(Object.keys(v)).not.toContain('recall');
    expect(Object.keys(v)).not.toContain('recalls');
    expect(v.safety).toBe(true);
    const src = fs.readFileSync(path.join(here, '..', 'index.js'), 'utf8');
    const view = src.slice(src.indexOf('function toWhichPartView'), src.indexOf('function isTrustedVideoEmbed'));
    expect(view).not.toMatch(/recall/i);
  });
});

describe('HTTP: every Safety / Recall admin route requires admin (derived from the router)', () => {
  const src = fs.readFileSync(path.join(here, '..', 'index.js'), 'utf8');
  const ROUTES = Array.from(new Set(Array.from(src.matchAll(/path\.endsWith\('(\/admin\/(?:recalls|safety-ingest)[a-z/_-]*)'\)/g)).map((m) => m[1]))).sort();
  const METHODS = ['GET', 'POST', 'PATCH', 'PUT', 'DELETE'];
  let store; let writes;
  function ev(route, method) {
    const p = '/api' + route;
    return { rawPath: p, requestContext: { http: { method, path: p }, requestId: 'auth' }, headers: {}, cookies: [], body: JSON.stringify({ expectedRevision: 0, family: 'hobs', note: 'auth table probe', reason: 'auth table probe', toVersion: 0, mode: 'backfill' }), queryStringParameters: { id: HOB, v: '0' } };
  }
  beforeEach(async () => {
    ({ store } = await seeded());
    writes = 0;
    const realPut = store.put.bind(store);
    store.put = async (...a) => { writes += 1; return realPut(...a); };
    const realLock = store.tryLock.bind(store);
    store.tryLock = async (...a) => { writes += 1; return realLock(...a); };
    api.setRecallStore(store);
  });
  afterEach(() => { api.setSessionForTests(null); });

  it('finds every admin Safety/Recall route', () => {
    expect(ROUTES).toEqual(expect.arrayContaining([
      '/admin/recalls/ingest', '/admin/recalls/record', '/admin/recalls/record/archive', '/admin/recalls/record/discard',
      '/admin/recalls/record/publish', '/admin/recalls/record/restore', '/admin/recalls/record/rollback', '/admin/recalls/record/version',
      '/admin/recalls/records', '/admin/recalls/status', '/admin/safety-ingest', '/admin/safety-ingest/history',
      '/admin/safety-ingest/run', '/admin/safety-ingest/runs',
    ]));
    expect(ROUTES.length).toBe(14);
  });

  for (const [label, session] of [['no session', null], ['non-admin session', async () => ({ username: 'u', email: 'user@example.test', isAdmin: false })]]) {
    it(label + ': every route × method → 401/405, nothing written or locked', async () => {
      api.setSessionForTests(session);
      const before = JSON.stringify(await store.listAll());
      for (const route of ROUTES) {
        let supported = 0;
        for (const method of METHODS) {
          const r = await api.handler(ev(route, method));
          expect([401, 405], route + ' ' + method).toContain(r.statusCode);
          if (r.statusCode === 401) supported += 1;
        }
        expect(supported, route).toBeGreaterThan(0);
      }
      expect(writes).toBe(0);
      expect(JSON.stringify(await store.listAll())).toBe(before);
    });
  }

  it('admin: actor comes from the session (client actor ignored); stale revision → 409; manual run cannot claim "scheduled"', async () => {
    api.setSessionForTests(async () => ({ username: 'a', email: ADMIN, isAdmin: true }));
    const get = await api.handler(Object.assign(ev('/admin/recalls/record', 'GET'), { queryStringParameters: { id: WALLBOX } }));
    const rec = JSON.parse(get.body);
    const patch = await api.handler(Object.assign(ev('/admin/recalls/record', 'PATCH'), {
      queryStringParameters: { id: WALLBOX },
      body: JSON.stringify({ expectedRevision: rec.admin.revision, family: 'hobs', note: 'HTTP draft reason', actor: 'spoof@evil' }),
    }));
    expect(patch.statusCode).toBe(200);
    expect(JSON.parse(patch.body).admin.draft.savedBy).toBe(ADMIN);
    const stale = await api.handler(Object.assign(ev('/admin/recalls/record', 'PATCH'), {
      queryStringParameters: { id: WALLBOX },
      body: JSON.stringify({ expectedRevision: rec.admin.revision, family: 'hobs', note: 'Stale editor reason' }),
    }));
    expect(stale.statusCode).toBe(409);
    expect(JSON.parse(stale.body).code).toBe('conflict');
    const list = JSON.parse((await api.handler(Object.assign(ev('/admin/recalls/records', 'GET'), { queryStringParameters: { state: 'draft' } }))).body);
    expect(list.records.map((r) => r.id)).toEqual([WALLBOX]);
    const handlers = http.createHandlers(() => store, async (opts) => opts);
    const seen = await handlers.adminIngest({ body: JSON.stringify({ mode: 'daily', trigger: 'scheduled', skipPublish: true }) }, ADMIN);
    expect(seen).toMatchObject({ trigger: 'manual', actor: ADMIN });
    expect(seen.skipPublish).toBeUndefined();
  });
});
