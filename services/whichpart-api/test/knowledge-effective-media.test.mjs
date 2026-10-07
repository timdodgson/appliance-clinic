/**
 * Knowledge Admin shows EFFECTIVE Media — the same merge live diagnosis uses (part-finder
 * media-effective.js over the shipped join + the Media overlay) — driven through the real Media store.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const api = require('../index.js');
const mediaAdmin = require('../media-admin.js');
const mediaInspect = require('../media-inspect.js');
const knowledgeInspect = require('../knowledge-inspect.js');

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const PNG2 = Buffer.concat([Buffer.from(PNG, 'base64'), Buffer.from([7])]).toString('base64');

function memS3() {
  const files = new Map(); const etags = new Map(); let n = 0;
  const s3 = {
    files, writes: 0,
    async getObject(k) { return files.has(k) ? files.get(k) : null; },
    async putObject(k, b) { files.set(k, b); etags.set(k, '"e' + (++n) + '"'); },
    async getState(k) { return files.has(k) ? { body: files.get(k), etag: etags.get(k) } : null; },
    async putState(k, b, o) {
      if ((o && o.ifNoneMatch === '*' && files.has(k)) || (o && o.ifMatch && o.ifMatch !== etags.get(k))) { const e = new Error('pre'); e.code = 'precondition'; throw e; }
      files.set(k, b); etags.set(k, '"e' + (++n) + '"'); s3.writes += 1;
    },
    async putBinary(k, b) { files.set(k, b); },
  };
  return s3;
}
const web = { async putPublicMedia() {} };
const state = (s3) => (s3.files.has(mediaAdmin.STATE_KEY) ? JSON.parse(s3.files.get(mediaAdmin.STATE_KEY)) : null);
/** Knowledge's view of one record's media after applying the effective view for this overlay. */
function knMedia(s3, kid) {
  knowledgeInspect.setMediaView(mediaInspect.knowledgeMediaView(state(s3)));
  return knowledgeInspect.getKnowledge(kid).media;
}
const summary = (kid) => knowledgeInspect.listKnowledge({}).records.find((r) => r.knowledgeId === kid);

describe('Knowledge sees effective Media (pure: real store flows + real merge)', () => {
  afterEach(() => knowledgeInspect.setMediaView(null));

  it('shipped active Media appears (no overlay = shipped baseline, unchanged behaviour)', () => {
    const s3 = memS3();
    const m = knMedia(s3, 'vacuum:lost-suction');
    expect(m.map((x) => [x.id, x.status, x.liveForDiagnosis])).toEqual([['vac-lost-suction', 'active', true]]);
    knowledgeInspect.setMediaView(null);
    expect(knowledgeInspect.getKnowledge('vacuum:lost-suction').media.map((x) => x.id)).toEqual(['vac-lost-suction']);
  });

  it('newly created + attached Admin Media appears with its published title and file', async () => {
    const s3 = memS3();
    const svc = mediaAdmin.createStore({ s3, web });
    let r = await svc.create({ type: 'IMAGE', id: 'kn-test-pixel', title: 'Knowledge test pixel', description: 'Test.', alt: 'Test pixel', families: ['dishwasher'], fileName: 'p.png', dataBase64: PNG });
    expect(knMedia(s3, 'dishwasher:not-draining').some((x) => x.id === 'kn-test-pixel')).toBe(false); // not attached yet
    r = await svc.attachMapping('kn-test-pixel', { expectedRevision: r.admin.revision, knowledgeId: 'dishwasher:not-draining', confirmDiagnostic: true });
    const hit = knMedia(s3, 'dishwasher:not-draining').find((x) => x.id === 'kn-test-pixel');
    expect(hit).toMatchObject({ id: 'kn-test-pixel', title: 'Knowledge test pixel', status: 'active', liveForDiagnosis: true, asset: r.previewUrl });
  });

  it('a DRAFT (text + replacement file) is invisible; publishing makes it visible; ids unchanged', async () => {
    const s3 = memS3();
    const svc = mediaAdmin.createStore({ s3, web });
    const before = knMedia(s3, 'dishwasher:not-draining');
    const ids = before.map((x) => x.id);
    const orig = before.find((x) => x.id === 'dishwasher-filter');
    let r = await svc.saveDraft('dishwasher-filter', { expectedRevision: 0, title: 'DRAFT dishwasher filter title' }, { fileName: 'new.png', dataBase64: PNG2 });
    let now = knMedia(s3, 'dishwasher:not-draining').find((x) => x.id === 'dishwasher-filter');
    expect(now.title).toBe(orig.title);
    expect(now.asset).toBe(orig.asset);
    r = await svc.publish('dishwasher-filter', { expectedRevision: r.admin.revision });
    now = knMedia(s3, 'dishwasher:not-draining').find((x) => x.id === 'dishwasher-filter');
    expect(now.title).toBe('DRAFT dishwasher filter title');
    expect(now.asset).toBe(r.previewUrl);
    expect(now.asset).not.toBe(orig.asset);
    expect(knMedia(s3, 'dishwasher:not-draining').map((x) => x.id)).toEqual(ids); // structured ids / order unchanged
  });

  it('archived Media is flagged (not dropped, not active); restore makes it active again', async () => {
    const s3 = memS3();
    const svc = mediaAdmin.createStore({ s3, web });
    let r = await svc.retire('vac-lost-suction', { expectedRevision: 0, confirm: true });
    const m = knMedia(s3, 'vacuum:lost-suction');
    expect(m.map((x) => [x.id, x.status, x.liveForDiagnosis])).toEqual([['vac-lost-suction', 'archived', false]]);
    const rec = knowledgeInspect.getKnowledge('vacuum:lost-suction');
    expect(rec.gaps).toEqual(expect.arrayContaining(['No media linked', 'Archived media still attached']));
    expect(summary('vacuum:lost-suction')).toMatchObject({ hasMedia: false, mediaCount: 0, archivedMediaCount: 1 });
    // the live join diagnosis uses really excludes it
    expect((mediaInspect.knowledgeMediaView(state(s3)).live.byKnowledgeId['vacuum:lost-suction'] || []).map((x) => x.id)).toEqual([]);
    r = await svc.restore('vac-lost-suction', { expectedRevision: r.admin.revision });
    expect(knMedia(s3, 'vacuum:lost-suction').map((x) => [x.id, x.status])).toEqual([['vac-lost-suction', 'active']]);
    expect(summary('vacuum:lost-suction')).toMatchObject({ hasMedia: true, mediaCount: 1, archivedMediaCount: 0 });
  });

  it('a hard-deleted (never-attached) Admin item never appears in Knowledge', async () => {
    const s3 = memS3();
    const svc = mediaAdmin.createStore({ s3, web });
    const r = await svc.create({ type: 'IMAGE', id: 'kn-gone', title: 'Gone', description: 'x', alt: 'x', fileName: 'g.png', dataBase64: PNG });
    await svc.hardDelete('kn-gone', { expectedRevision: r.admin.revision, confirm: true });
    const view = mediaInspect.knowledgeMediaView(state(s3));
    const allIds = Object.values(view.all.byKnowledgeId).flat().map((x) => x.id);
    expect(allIds).not.toContain('kn-gone');
  });

  it('a detached shipped mapping disappears from Knowledge (attachments are the effective join)', async () => {
    const s3 = memS3();
    const svc = mediaAdmin.createStore({ s3, web });
    await svc.detachMapping('dishwasher-filter', 'dishwasher:not-draining', { expectedRevision: 0, confirmDiagnostic: true });
    expect(knMedia(s3, 'dishwasher:not-draining').some((x) => x.id === 'dishwasher-filter')).toBe(false);
    expect(knMedia(s3, 'dishwasher:poor-clean-results').some((x) => x.id === 'dishwasher-filter')).toBe(true);
  });
});

describe('Knowledge HTTP reads use effective Media and never write', () => {
  let s3;
  function ev(p, qs) { return { rawPath: p, requestContext: { http: { method: 'GET', path: p }, requestId: 't' }, headers: {}, cookies: [], body: '', queryStringParameters: qs || {} }; }
  beforeEach(() => {
    s3 = memS3();
    api.setMediaAdminStore(mediaAdmin.createStore({ s3, web }));
    api.setKnowledgeAdminStore({ inspectView: async () => ({ overlayVersion: 0, published: {}, archived: [], records: {} }), getView: async () => null });
    api.setSessionForTests(async () => ({ username: 'a', email: 'admin@example.test', isAdmin: true }));
  });
  afterEach(() => {
    api.setSessionForTests(null); api.setMediaAdminStore(null); api.setKnowledgeAdminStore(null);
    knowledgeInspect.setMediaView(null);
  });

  it('record + list reflect an archived item, and viewing writes nothing', async () => {
    const svc = mediaAdmin.createStore({ s3, web });
    await svc.retire('vac-lost-suction', { expectedRevision: 0, confirm: true });
    api.setMediaAdminStore(svc); // also resets the BFF overlay cache
    const writes = s3.writes;
    const rec = JSON.parse((await api.handler(ev('/api/admin/knowledge/record', { id: 'vacuum:lost-suction' }))).body);
    expect(rec.media).toEqual([expect.objectContaining({ id: 'vac-lost-suction', status: 'archived', liveForDiagnosis: false })]);
    const list = JSON.parse((await api.handler(ev('/api/admin/knowledge'))).body);
    expect(list.records.find((r) => r.knowledgeId === 'vacuum:lost-suction')).toMatchObject({ mediaCount: 0, archivedMediaCount: 1 });
    expect(s3.writes).toBe(writes);
  });
});
