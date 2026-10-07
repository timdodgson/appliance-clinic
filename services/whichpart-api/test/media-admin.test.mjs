/**
 * Media Management overlay — create / edit / map / retire / integrity / auth.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const mediaAdmin = require('../media-admin.js');
const mediaInspect = require('../media-inspect.js');
const api = require('../index.js');

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

function memS3(opts) {
  const files = new Map();
  const etags = new Map();
  const failState = Boolean(opts && opts.failState);
  let n = 0;
  const s3 = {
    files,
    etags,
    public: [],
    stateWrites: 0,
    race: null, // optional fn run just before the next conditional state write (simulates another admin)
    async getObject(key) { return files.has(key) ? files.get(key) : null; },
    async putObject(key, body) {
      if (failState && key === mediaAdmin.STATE_KEY) throw new Error('s3-put-fail');
      files.set(key, Buffer.isBuffer(body) ? body.toString('utf8') : String(body));
      etags.set(key, '"e' + (++n) + '"');
    },
    async getState(key) { return files.has(key) ? { body: files.get(key), etag: etags.get(key) } : null; },
    async putState(key, body, o) {
      if (s3.race) { const r = s3.race; s3.race = null; await r(); }
      if (failState) throw new Error('s3-put-fail');
      const cur = etags.get(key);
      if ((o && o.ifNoneMatch === '*' && files.has(key)) || (o && o.ifMatch && o.ifMatch !== cur)) {
        const e = new Error('precondition'); e.code = 'precondition'; throw e;
      }
      files.set(key, body);
      etags.set(key, '"e' + (++n) + '"');
      s3.stateWrites += 1;
    },
    async putBinary(key, buf) { files.set(key, buf); },
  };
  return s3;
}
// Same pixel with one changed byte after IEND (distinct content, still a valid PNG header/IHDR).
const PNG2 = Buffer.concat([Buffer.from(PNG, 'base64'), Buffer.from([0x00])]).toString('base64');
const SVG_OK = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10"/></svg>').toString('base64');
const SVG_BAD = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>').toString('base64');

function store(s3, webOk) {
  const web = {
    async putPublicMedia(name, buf, type) {
      if (webOk === false) throw new Error('web-put-fail');
      s3.public.push({ name, bytes: buf.length, type });
    },
  };
  return mediaAdmin.createStore({ s3, web, now: () => new Date('2026-09-19T12:00:00.000Z') });
}

const imageBody = {
  type: 'IMAGE',
  id: 'admin-test-pixel',
  title: 'Temporary admin test image',
  description: 'Temporary test caption for Media Management validation.',
  alt: 'One-pixel test image used only for admin media management tests',
  families: ['dishwasher'],
  fileName: 'admin-test-pixel.png',
  dataBase64: PNG,
};

describe('create and validation', () => {
  it('creates a local image identity without touching shipped counts until overlay is applied', async () => {
    const s3 = memS3();
    const svc = store(s3);
    const rec = await svc.create(imageBody);
    expect(rec.id).toBe('admin-test-pixel');
    expect(rec.origin).toBe('admin');
    expect(rec.title).toBe('Temporary admin test image');
    expect(rec.previewUrl).toMatch(/^\/media\/admin-test-pixel-[0-9a-f]{12}\.png$/);
    expect(rec.admin.revision).toBe(1);
    expect(rec.admin.currentVersion).toBe(1);
    expect(rec.used).toBe(false);
    expect(s3.public.some((p) => /^admin-test-pixel-[0-9a-f]{12}\.png$/.test(p.name))).toBe(true);
    const list = await svc.inspectList({});
    expect(list.total).toBe(39);
    expect(list.records.some((r) => r.id === 'admin-test-pixel')).toBe(true);
    const shipped = mediaInspect.listMedia({});
    expect(shipped.total).toBe(38);
    expect(shipped.usedCount).toBe(22);
  });

  it('rejects a duplicate explicit id', async () => {
    const svc = store(memS3());
    await svc.create(imageBody);
    await expect(svc.create(imageBody)).rejects.toMatchObject({ code: 'duplicate' });
  });

  it('rejects unsupported upload types and missing customer metadata', async () => {
    const svc = store(memS3());
    await expect(svc.create(Object.assign({}, imageBody, { fileName: 'x.exe', id: 'bad-ext' })))
      .rejects.toMatchObject({ code: 'file_type' });
    await expect(svc.create(Object.assign({}, imageBody, { id: 'no-alt', alt: '' })))
      .rejects.toMatchObject({ code: 'alt' });
    await expect(svc.create({ type: 'IMAGE', id: 'no-file-here', title: 'Needs a file', description: 'y', alt: 'z' }))
      .rejects.toMatchObject({ code: 'file' });
  });

  it('rejects untrusted video hosts and autoplay', async () => {
    const svc = store(memS3());
    await expect(svc.create({
      type: 'VIDEO', id: 'evil-vid', title: 'Bad host', description: 'desc',
      videoId: 'dQw4w9wgGcQ', embedUrl: 'https://www.youtube.com/embed/dQw4w9wgGcQ',
    })).rejects.toMatchObject({ code: 'video_host' });
    await expect(svc.create({
      type: 'VIDEO', id: 'auto-vid', title: 'Autoplay', description: 'desc',
      videoId: 'dQw4w9wgGcQ',
      embedUrl: 'https://www.youtube-nocookie.com/embed/dQw4w9wgGcQ?rel=0&autoplay=1',
    })).rejects.toMatchObject({ code: 'autoplay' });
  });

  it('accepts a trusted youtube-nocookie video', async () => {
    const rec = await store(memS3()).create({
      type: 'VIDEO', id: 'admin-test-video', title: 'Temporary admin test video',
      description: 'Trusted privacy-enhanced embed for management tests.',
      videoId: 'dQw4w9wgGcQ',
      embedUrl: 'https://www.youtube-nocookie.com/embed/dQw4w9wgGcQ?rel=0',
    });
    expect(rec.type).toBe('VIDEO');
    expect(rec.embedUrl).toContain('youtube-nocookie.com');
    expect(rec.embedUrl).not.toMatch(/autoplay=1/);
  });
});

describe('metadata vs mappings', () => {
  it('edits customer presentation without changing knowledge mappings', async () => {
    const svc = store(memS3());
    await svc.create(imageBody);
    const before = mediaInspect.getMedia('vac-lost-suction');
    const rec = await svc.updateMetadata('admin-test-pixel', {
      title: 'Updated test title',
      description: 'Updated description for customers.',
      alt: 'Updated alt text for the test pixel',
      families: ['dishwasher'],
    });
    expect(rec.title).toBe('Temporary admin test image'); // saved as a draft: live unchanged
    expect(rec.admin.draft.title).toBe('Updated test title');
    const pub = await svc.publish('admin-test-pixel', { expectedRevision: rec.admin.revision });
    expect(pub.title).toBe('Updated test title');
    expect(rec.knowledge).toEqual([]);
    const after = mediaInspect.getMedia('vac-lost-suction');
    expect(after.knowledge.map((k) => k.knowledgeId).sort()).toEqual(
      before.knowledge.map((k) => k.knowledgeId).sort(),
    );
    await expect(svc.updateMetadata('admin-test-pixel', { title: 'x', description: 'y', alt: 'z', mappings: [] }))
      .rejects.toMatchObject({ code: 'boundary' });
  });
});

describe('knowledge mappings', () => {
  it('attaches and detaches an existing Knowledge record with confirmation', async () => {
    const svc = store(memS3());
    await svc.create(imageBody);
    await expect(svc.attachMapping('admin-test-pixel', { knowledgeId: 'dishwasher:not-draining' }))
      .rejects.toMatchObject({ code: 'confirm' });
    const attached = await svc.attachMapping('admin-test-pixel', {
      knowledgeId: 'dishwasher:not-draining',
      confirmDiagnostic: true,
      description: 'Test mapping description',
      relatedCheck: 'Temporary related check',
    });
    expect(attached.knowledge.some((k) => k.knowledgeId === 'dishwasher:not-draining')).toBe(true);
    const multi = await svc.attachMapping('admin-test-pixel', {
      knowledgeId: 'dishwasher:poor-clean-results',
      confirmDiagnostic: true,
    });
    expect(multi.knowledge.map((k) => k.knowledgeId).sort()).toEqual([
      'dishwasher:not-draining', 'dishwasher:poor-clean-results',
    ]);
    const detached = await svc.detachMapping('admin-test-pixel', 'dishwasher:not-draining', { confirmDiagnostic: true });
    expect(detached.knowledge.map((k) => k.knowledgeId)).toEqual(['dishwasher:poor-clean-results']);
  });

  it('rejects a nonexistent knowledge id', async () => {
    const svc = store(memS3());
    await svc.create(imageBody);
    await expect(svc.attachMapping('admin-test-pixel', {
      knowledgeId: 'not-a-real:topic', confirmDiagnostic: true,
    })).rejects.toMatchObject({ code: 'knowledge' });
  });

  it('does not alter the vacuum cuts-out mapping', async () => {
    const svc = store(memS3());
    await svc.create(imageBody);
    await svc.attachMapping('admin-test-pixel', {
      knowledgeId: 'dishwasher:not-draining', confirmDiagnostic: true,
    });
    const vac = await svc.inspectOne('vac-lost-suction');
    expect(vac.knowledge.map((k) => k.knowledgeId).sort()).toEqual([
      'vacuum:cuts-out', 'vacuum:lost-suction',
    ]);
  });

  it('detaches a shipped mapping with a durable tombstone that survives reload', async () => {
    const s3 = memS3();
    const svc = store(s3);
    await svc.detachMapping('dishwasher-filter', 'dishwasher:not-draining', { confirmDiagnostic: true });
    const rec = await svc.inspectOne('dishwasher-filter');
    expect(rec.knowledge.map((k) => k.knowledgeId)).not.toContain('dishwasher:not-draining');
    expect(rec.knowledge.map((k) => k.knowledgeId)).toContain('dishwasher:poor-clean-results');
    const listed = await svc.inspectList({});
    const card = listed.records.find((r) => r.id === 'dishwasher-filter');
    expect(card.knowledgePreview.map((k) => k.knowledgeId)).not.toContain('dishwasher:not-draining');
    const svc2 = store(s3);
    const rec2 = await svc2.inspectOne('dishwasher-filter');
    expect(rec2.knowledge.map((k) => k.knowledgeId)).not.toContain('dishwasher:not-draining');
    const reattached = await svc2.attachMapping('dishwasher-filter', {
      knowledgeId: 'dishwasher:not-draining', confirmDiagnostic: true,
    });
    expect(reattached.knowledge.map((k) => k.knowledgeId)).toContain('dishwasher:not-draining');
  });

  it('does not apply a malformed overlay and does not overwrite it', async () => {
    const s3 = memS3();
    s3.files.set(mediaAdmin.STATE_KEY, '{not-json');
    const svc = store(s3);
    await expect(svc.inspectList({})).rejects.toMatchObject({ code: 'malformed', status: 503 });
    await expect(svc.create(imageBody)).rejects.toMatchObject({ code: 'malformed' });
    expect(await s3.getObject(mediaAdmin.STATE_KEY)).toBe('{not-json');
  });
});

describe('component mappings', () => {
  it('inspects the active byComponent join and can attach/detach with confirmation', async () => {
    const oven = mediaInspect.getMedia('oven-element-about');
    expect(oven.components.some((c) => c.componentKey === 'oven-cooker:fan-oven-element')).toBe(true);
    const svc = store(memS3());
    await svc.create(imageBody);
    await expect(svc.attachComponent('admin-test-pixel', { componentKey: 'oven-cooker:fan-oven-element' }))
      .rejects.toMatchObject({ code: 'confirm' });
    const attached = await svc.attachComponent('admin-test-pixel', {
      componentKey: 'oven-cooker:fan-oven-element', confirmDiagnostic: true,
    });
    expect(attached.components.some((c) => c.componentKey === 'oven-cooker:fan-oven-element')).toBe(true);
    const detached = await svc.detachComponent('admin-test-pixel', 'oven-cooker:fan-oven-element', { confirmDiagnostic: true });
    expect(detached.components.length).toBe(0);
    const still = await svc.inspectOne('oven-element-about');
    expect(still.components.some((c) => c.componentKey === 'oven-cooker:fan-oven-element')).toBe(true);
  });
});

describe('retirement, replace, preview, partial write', () => {
  it('retires without deleting files and withholds from diagnostic usage', async () => {
    const s3 = memS3();
    const svc = store(s3);
    await svc.create(imageBody);
    await svc.attachMapping('admin-test-pixel', {
      knowledgeId: 'dishwasher:not-draining', confirmDiagnostic: true,
    });
    const retired = await svc.retire('admin-test-pixel', { confirm: true });
    expect(retired.status).toBe('retired');
    expect(retired.knowledge.some((k) => k.knowledgeId === 'dishwasher:not-draining')).toBe(true);
    expect(s3.public.length).toBeGreaterThan(0);
    const restored = await svc.restore('admin-test-pixel', {});
    expect(restored.status).toBe('active');
    expect(restored.knowledge.some((k) => k.knowledgeId === 'dishwasher:not-draining')).toBe(true);
  });

  it('retiring shipped media keeps inspector history but live join withholds it', async () => {
    const svc = store(memS3());
    const retired = await svc.retire('vac-lost-suction', { confirm: true });
    expect(retired.status).toBe('retired');
    expect(retired.knowledge.map((k) => k.knowledgeId).sort()).toEqual([
      'vacuum:cuts-out', 'vacuum:lost-suction',
    ]);
    const restored = await svc.restore('vac-lost-suction', {});
    expect(restored.status).toBe('active');
    expect(restored.knowledge.map((k) => k.knowledgeId).sort()).toEqual([
      'vacuum:cuts-out', 'vacuum:lost-suction',
    ]);
  });

  it('hard-deletes only unused admin-origin items', async () => {
    const svc = store(memS3());
    await svc.create(imageBody);
    await expect(svc.hardDelete('vac-lost-suction', { confirm: true }))
      .rejects.toMatchObject({ code: 'forbidden' });
    const gone = await svc.hardDelete('admin-test-pixel', { confirm: true });
    expect(gone.deleted).toBe(true);
    expect(await svc.inspectOne('admin-test-pixel')).toBeNull();
    const list = await svc.inspectList({});
    expect(list.records.some((r) => r.id === 'admin-test-pixel')).toBe(false);
  });

  it('replaces a file under the same identity as a DRAFT with a new immutable url', async () => {
    const svc = store(memS3());
    const created = await svc.create(imageBody);
    const rec = await svc.replaceFile('admin-test-pixel', {
      confirm: true, fileName: 'admin-test-pixel.png', dataBase64: PNG2,
    });
    expect(rec.id).toBe('admin-test-pixel');
    expect(rec.previewUrl).toBe(created.previewUrl); // live file unchanged until publish
    expect(rec.admin.draft.previewUrl).toMatch(/^\/media\/admin-test-pixel-[0-9a-f]{12}\.png$/);
    expect(rec.admin.draft.previewUrl).not.toBe(created.previewUrl);
    expect(rec.admin.pendingChanges).toEqual(['url']);
  });

  it('projects a customer preview', async () => {
    const svc = store(memS3());
    const rec = await svc.create(imageBody);
    const preview = svc.customerPreview(rec);
    expect(preview.kind).toBe('customer');
    expect(preview.media[0].title).toBe(rec.title);
    expect(preview.media[0].url).toBe(rec.previewUrl);
  });

  it('does not save metadata if public publish fails after private store', async () => {
    const s3 = memS3();
    const svc = store(s3, false);
    await expect(svc.create(imageBody)).rejects.toMatchObject({ code: 'partial', status: 503 });
    const raw = await s3.getObject(mediaAdmin.STATE_KEY);
    expect(raw).toBeNull();
  });

  it('does not save metadata if state.json put fails after files', async () => {
    const s3 = memS3({ failState: true });
    const svc = store(s3);
    await expect(svc.create(imageBody)).rejects.toMatchObject({ code: 'partial', status: 503 });
  });
});

describe('HTTP auth and methods', () => {
  function event(path, method, body, qs) {
    return {
      rawPath: path,
      requestContext: { http: { method, path }, requestId: 't' },
      headers: {}, cookies: [], body: body ? JSON.stringify(body) : '',
      queryStringParameters: qs || {},
    };
  }

  beforeEach(() => {
    api.setMediaAdminStore(store(memS3()));
    api.setSessionForTests(null);
  });
  afterEach(() => {
    api.setSessionForTests(null);
    api.setMediaAdminStore(null);
  });

  it('rejects unauthenticated GET and mutations', async () => {
    expect((await api.handler(event('/api/admin/media', 'GET'))).statusCode).toBe(401);
    expect((await api.handler(event('/api/admin/media', 'POST', imageBody))).statusCode).toBe(401);
    expect((await api.handler(event('/api/admin/media/record', 'PATCH', { title: 'x' }, { id: 'vac-lost-suction' }))).statusCode).toBe(401);
    expect((await api.handler(event('/api/admin/media/record/map', 'POST', {}, { id: 'vac-lost-suction' }))).statusCode).toBe(401);
  });

  it('allows admin mutations and still requires confirmation', async () => {
    api.setSessionForTests(async () => ({ isAdmin: true, email: 'admin@test' }));
    const created = await api.handler(event('/api/admin/media', 'POST', imageBody));
    expect(created.statusCode).toBe(200);
    const listed = await api.handler(event('/api/admin/media', 'GET'));
    expect(listed.statusCode).toBe(200);
    const noRev = await api.handler(event('/api/admin/media/record/map', 'POST', {
      knowledgeId: 'dishwasher:not-draining', confirmDiagnostic: true,
    }, { id: 'admin-test-pixel' }));
    expect(noRev.statusCode).toBe(400);
    expect(JSON.parse(noRev.body).code).toBe('revision_required');
    const map = await api.handler(event('/api/admin/media/record/map', 'POST', {
      knowledgeId: 'dishwasher:not-draining', expectedRevision: 1,
    }, { id: 'admin-test-pixel' }));
    expect(map.statusCode).toBe(400);
    const body = JSON.parse(map.body);
    expect(body.code).toBe('confirm');
    const preview = await api.handler(event('/api/admin/media/preview', 'GET', null, { id: 'admin-test-pixel' }));
    expect(preview.statusCode).toBe(200);
    expect(JSON.parse(preview.body).kind).toBe('customer');
  });

  it('has no public upload path', async () => {
    const res = await api.handler(event('/api/media', 'POST', imageBody));
    expect(res.statusCode === 401 || res.statusCode === 404 || res.statusCode >= 400).toBe(true);
  });
});

describe('customer boundary overlay', () => {
  it('withholds retired identities from customer media without changing diagnosis fields', () => {
    const overlay = mediaAdmin.emptyState();
    overlay.identities['wm-pump-filter'] = { origin: 'shipped', status: 'retired', catalogue: { id: 'wm-pump-filter' } };
    const media = mediaAdmin.applyToCustomerMedia([
      { id: 'wm-pump-filter', type: 'DIAGRAM', title: 'Pump filter', url: '/media/wm-pump-filter.svg' },
      { id: 'other', type: 'IMAGE', title: 'Other', url: '/media/x.png' },
    ], overlay);
    expect(media.map((m) => m.id)).toEqual(['other']);
    const untouched = api.toWhichPartView({
      outcome: 'ANSWER', message: 'Hello.', media: [
        { id: 'wm-pump-filter', type: 'IMAGE', title: 'Pump', url: '/media/wm-pump-filter.svg' },
      ],
    }, 't');
    expect(untouched.diagnosis.faultId).toBeNull();
    expect(untouched.media.length).toBe(1);
  });
});

// ------------------------------------------------------------------ hardening (draft / versions / safety)
const mediaEffective = require('../../part-finder/media-effective.js');
const liveJoin = (state) => mediaEffective.mergeJoin(
  JSON.parse(require('node:fs').readFileSync(require('node:path').join(require('../knowledge-inspect.js').loadCorpus().dir, 'media-information.json'), 'utf8')),
  state,
);
const liveItem = (state, kid, id) => (liveJoin(state).byKnowledgeId[kid] || []).find((m) => m.id === id);

describe('draft → publish boundary (live diagnosis never reads drafts)', () => {
  it('a draft edit on a LIVE shipped item does not change the live join or the customer boundary', async () => {
    const s3 = memS3();
    const svc = store(s3);
    const before = liveItem(null, 'washing-machine:not-draining', 'wm-pump-filter');
    const d = await svc.saveDraft('wm-pump-filter', { expectedRevision: 0, title: 'DRAFT title — not live', caption: 'Draft caption.' });
    expect(d.admin.draftPending).toBe(true);
    expect(d.admin.pendingChanges.sort()).toEqual(['caption', 'title']);
    expect(d.title).toBe(before.title);
    const state = JSON.parse(s3.files.get(mediaAdmin.STATE_KEY));
    expect(liveItem(state, 'washing-machine:not-draining', 'wm-pump-filter')).toEqual(before);
    const customer = mediaAdmin.applyToCustomerMedia([{ id: 'wm-pump-filter', type: 'DIAGRAM', title: before.title, url: before.asset }], state);
    expect(customer[0].title).toBe(before.title);
    expect(customer[0].url).toBe(before.asset);
  });

  it('publish makes the draft live as v1 on top of the v0 shipped baseline; rollback creates v2', async () => {
    const s3 = memS3();
    const svc = store(s3);
    const base = liveItem(null, 'washing-machine:not-draining', 'wm-pump-filter');
    let r = await svc.saveDraft('wm-pump-filter', { expectedRevision: 0, title: 'Published title', actor: 'a@x' });
    r = await svc.publish('wm-pump-filter', { expectedRevision: r.admin.revision, note: 'test', actor: 'a@x' });
    expect(r.published.version).toBe(1);
    expect(r.admin.currentVersion).toBe(1);
    expect(r.admin.versions.map((v) => v.version)).toEqual([0, 1]);
    expect(r.admin.versions[1].changed).toEqual(['title']);
    expect(r.admin.versions[1].publishedBy).toBe('a@x');
    let state = JSON.parse(s3.files.get(mediaAdmin.STATE_KEY));
    expect(liveItem(state, 'washing-machine:not-draining', 'wm-pump-filter').title).toBe('Published title');
    // text-only edit keeps the shipped file on every mapping
    expect(liveItem(state, 'washing-machine:not-draining', 'wm-pump-filter').asset).toBe(base.asset);
    r = await svc.rollback('wm-pump-filter', { expectedRevision: r.admin.revision, toVersion: 0 });
    expect(r.published.version).toBe(2);
    expect(r.admin.versions.find((v) => v.version === 2).source).toBe('rollback');
    expect(r.admin.versions.find((v) => v.version === 2).rolledBackFrom).toBe(0);
    state = JSON.parse(s3.files.get(mediaAdmin.STATE_KEY));
    expect(liveItem(state, 'washing-machine:not-draining', 'wm-pump-filter')).toEqual(base);
    // history is immutable: v1 is still viewable
    const v1 = await svc.version('wm-pump-filter', 1);
    expect(v1.record.title).toBe('Published title');
    const v0 = await svc.version('wm-pump-filter', 0);
    expect(v0.record.title).toBe(base.title);
  });

  it('a replacement file only reaches diagnosis on publish, and rollback restores the earlier file', async () => {
    const s3 = memS3();
    const svc = store(s3);
    let r = await svc.create(imageBody);
    const v1Url = r.previewUrl;
    r = await svc.attachMapping('admin-test-pixel', { expectedRevision: r.admin.revision, knowledgeId: 'dishwasher:not-draining', confirmDiagnostic: true });
    r = await svc.replaceFile('admin-test-pixel', { expectedRevision: r.admin.revision, fileName: 'new.png', dataBase64: PNG2 });
    const v2Url = r.admin.draft.previewUrl;
    let state = JSON.parse(s3.files.get(mediaAdmin.STATE_KEY));
    expect(liveItem(state, 'dishwasher:not-draining', 'admin-test-pixel').asset).toBe(v1Url);
    r = await svc.publish('admin-test-pixel', { expectedRevision: r.admin.revision });
    state = JSON.parse(s3.files.get(mediaAdmin.STATE_KEY));
    expect(liveItem(state, 'dishwasher:not-draining', 'admin-test-pixel').asset).toBe(v2Url);
    r = await svc.rollback('admin-test-pixel', { expectedRevision: r.admin.revision, toVersion: 1 });
    state = JSON.parse(s3.files.get(mediaAdmin.STATE_KEY));
    expect(liveItem(state, 'dishwasher:not-draining', 'admin-test-pixel').asset).toBe(v1Url);
    expect(r.admin.versions.map((v) => v.version)).toEqual([1, 2, 3]);
    // both files are retained (immutable keys, never overwritten)
    expect(s3.public.map((p) => '/media/' + p.name)).toEqual(expect.arrayContaining([v1Url, v2Url]));
  });

  it('discard drops the draft without touching live; rollback/publish refuse in the wrong state', async () => {
    const svc = store(memS3());
    let r = await svc.saveDraft('vac-lost-suction', { expectedRevision: 0, title: 'Throwaway draft' });
    await expect(svc.rollback('vac-lost-suction', { expectedRevision: r.admin.revision, toVersion: 0 }))
      .rejects.toMatchObject({ code: 'draft_pending', status: 409 });
    r = await svc.discardDraft('vac-lost-suction', { expectedRevision: r.admin.revision });
    expect(r.admin.draftPending).toBe(false);
    expect(r.title).toBe('Poor suction — what to check first');
    await expect(svc.publish('vac-lost-suction', { expectedRevision: r.admin.revision }))
      .rejects.toMatchObject({ code: 'no_draft' });
    r = await svc.retire('vac-lost-suction', { expectedRevision: r.admin.revision, confirm: true });
    await expect(svc.saveDraft('vac-lost-suction', { expectedRevision: r.admin.revision, title: 'x' }))
      .rejects.toMatchObject({ code: 'retired' });
  });

  it('publish validates the draft', async () => {
    const s3 = memS3();
    const svc = store(s3);
    let r = await svc.create(imageBody);
    const state = JSON.parse(s3.files.get(mediaAdmin.STATE_KEY));
    state.identities['admin-test-pixel'].draft = { catalogue: Object.assign({}, state.identities['admin-test-pixel'].catalogue, { alt: '' }) };
    s3.files.set(mediaAdmin.STATE_KEY, JSON.stringify(state));
    await expect(svc.publish('admin-test-pixel', { expectedRevision: r.admin.revision }))
      .rejects.toMatchObject({ code: 'invalid', extra: { fields: ['alt'] } });
  });
});

describe('optimistic concurrency', () => {
  it('a stale expectedRevision is rejected with 409 and nothing is written', async () => {
    const s3 = memS3();
    const svc = store(s3);
    const r = await svc.saveDraft('vac-lost-suction', { expectedRevision: 0, title: 'First editor' });
    const writes = s3.stateWrites;
    await expect(svc.saveDraft('vac-lost-suction', { expectedRevision: 0, title: 'Second editor (stale)' }))
      .rejects.toMatchObject({ code: 'conflict', status: 409, extra: { currentRevision: r.admin.revision } });
    await expect(svc.retire('vac-lost-suction', { expectedRevision: 0, confirm: true })).rejects.toMatchObject({ code: 'conflict' });
    expect(s3.stateWrites).toBe(writes);
  });

  it('a concurrent write between load and save is detected by the ETag and re-validated', async () => {
    const s3 = memS3();
    const svc = store(s3);
    await svc.saveDraft('vac-lost-suction', { expectedRevision: 0, title: 'Base' });
    // Another admin writes after our load: the ETag no longer matches, so we reload; the revision check then fails.
    s3.race = async () => { await store(s3).saveDraft('vac-lost-suction', { expectedRevision: 1, title: 'Other admin' }); };
    await expect(svc.saveDraft('vac-lost-suction', { expectedRevision: 1, title: 'Mine' })).rejects.toMatchObject({ code: 'conflict' });
    const now = await svc.inspectOne('vac-lost-suction');
    expect(now.admin.draft.title).toBe('Other admin');
  });

  it('unrelated items still save when another item changed concurrently (retry on fresh state)', async () => {
    const s3 = memS3();
    const svc = store(s3);
    await svc.saveDraft('vac-lost-suction', { expectedRevision: 0, title: 'A' });
    s3.race = async () => { await store(s3).saveDraft('wm-pump-filter', { expectedRevision: 0, title: 'B' }); };
    const r = await svc.saveDraft('vac-lost-suction', { expectedRevision: 1, title: 'A2' });
    expect(r.admin.draft.title).toBe('A2');
    expect((await svc.inspectOne('wm-pump-filter')).admin.draft.title).toBe('B');
  });
});

describe('upload validation (content, not just the file name)', () => {
  const up = (o) => Object.assign({}, imageBody, o);
  it('rejects content that does not match the extension and non-images renamed as images', async () => {
    const svc = store(memS3());
    await expect(svc.create(up({ id: 'renamed-svg', fileName: 'x.png', dataBase64: SVG_OK }))).rejects.toMatchObject({ code: 'file_mismatch' });
    await expect(svc.create(up({ id: 'html-png', fileName: 'x.png', dataBase64: Buffer.from('<html><script>1</script></html>').toString('base64') })))
      .rejects.toMatchObject({ code: 'file_type' });
  });
  it('rejects active SVG content and accepts a plain SVG drawing', async () => {
    const svc = store(memS3());
    await expect(svc.create(up({ id: 'bad-svg', fileName: 'x.svg', dataBase64: SVG_BAD }))).rejects.toMatchObject({ code: 'file_unsafe' });
    const onload = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"></svg>').toString('base64');
    await expect(svc.create(up({ id: 'bad-svg2', fileName: 'x.svg', dataBase64: onload }))).rejects.toMatchObject({ code: 'file_unsafe' });
    const ext = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><image href="https://evil.example/x.png"/></svg>').toString('base64');
    await expect(svc.create(up({ id: 'bad-svg3', fileName: 'x.svg', dataBase64: ext }))).rejects.toMatchObject({ code: 'file_unsafe' });
    const ok = await svc.create(up({ id: 'plain-svg', type: 'DIAGRAM', fileName: 'x.svg', dataBase64: SVG_OK }));
    expect(ok.previewUrl).toMatch(/^\/media\/plain-svg-[0-9a-f]{12}\.svg$/);
  });
  it('records dimensions and rejects oversize files and dimensions', async () => {
    const s3 = memS3();
    const svc = store(s3);
    await svc.create(imageBody);
    const st = JSON.parse(s3.files.get(mediaAdmin.STATE_KEY));
    const f = Object.values(st.files)[0];
    expect(f).toMatchObject({ mediaId: 'admin-test-pixel', width: 1, height: 1, contentType: 'image/png', bytes: Buffer.from(PNG, 'base64').length });
    expect(f.sha256).toMatch(/^[0-9a-f]{64}$/);
    const huge = Buffer.from(PNG, 'base64');
    huge.writeUInt32BE(9000, 16);
    await expect(svc.create(up({ id: 'huge-dim', dataBase64: huge.toString('base64') }))).rejects.toMatchObject({ code: 'file_dimensions' });
    const big = Buffer.concat([Buffer.from(PNG, 'base64'), Buffer.alloc(mediaAdmin.MAX_BYTES)]);
    await expect(svc.create(up({ id: 'too-big', dataBase64: big.toString('base64') }))).rejects.toMatchObject({ code: 'file_size' });
  });
  it('duplicate uploads are detected by content hash; uploads can never overwrite another file', async () => {
    const s3 = memS3();
    const svc = store(s3);
    await svc.create(imageBody);
    await expect(svc.create(up({ id: 'copy-of-pixel', fileName: 'admin-test-pixel.png' }))).rejects.toMatchObject({ code: 'duplicate_file', extra: { mediaId: 'admin-test-pixel' } });
    const other = await svc.create(up({ id: 'other-pixel', fileName: 'admin-test-pixel.png', dataBase64: PNG2 }));
    expect(other.previewUrl).not.toBe((await svc.inspectOne('admin-test-pixel')).previewUrl);
    // the shipped-path overwrite switch no longer exists
    const r = await svc.create(up({ id: 'no-overwrite', fileName: 'wm-transit-bolts.png', dataBase64: Buffer.concat([Buffer.from(PNG, 'base64'), Buffer.from([1])]).toString('base64'), replaceExistingFile: true }));
    expect(r.previewUrl).not.toBe('/media/wm-transit-bolts.png');
  });
  it('validates video ids and embed/id agreement', async () => {
    const svc = store(memS3());
    const v = { type: 'VIDEO', title: 'v', description: 'd' };
    await expect(svc.create(Object.assign({ id: 'vid-a', videoId: 'not a video id' }, v))).rejects.toMatchObject({ code: 'video' });
    await expect(svc.create(Object.assign({ id: 'vid-b', videoId: 'dQw4w9wgGcQ', embedUrl: 'https://www.youtube-nocookie.com/embed/AAAAAAAAAAA' }, v)))
      .rejects.toMatchObject({ code: 'video' });
  });
});

describe('referential safety: archive vs delete', () => {
  it('admin items that were ever attached to diagnosis cannot be hard-deleted (archive instead)', async () => {
    const svc = store(memS3());
    let r = await svc.create(imageBody);
    expect(r.admin.canDelete).toBe(true);
    r = await svc.attachMapping('admin-test-pixel', { expectedRevision: r.admin.revision, knowledgeId: 'dishwasher:not-draining', confirmDiagnostic: true });
    expect(r.admin.canDelete).toBe(false);
    await expect(svc.hardDelete('admin-test-pixel', { expectedRevision: r.admin.revision, confirm: true })).rejects.toMatchObject({ code: 'in_use', status: 409 });
    // retired-but-mapped used to be deletable; it is not now
    r = await svc.retire('admin-test-pixel', { expectedRevision: r.admin.revision, confirm: true });
    await expect(svc.hardDelete('admin-test-pixel', { expectedRevision: r.admin.revision, confirm: true })).rejects.toMatchObject({ code: 'in_use' });
    // detached afterwards: still never deletable, because it has been live
    r = await svc.restore('admin-test-pixel', { expectedRevision: r.admin.revision });
    r = await svc.detachMapping('admin-test-pixel', 'dishwasher:not-draining', { expectedRevision: r.admin.revision, confirmDiagnostic: true });
    expect(r.used).toBe(false);
    expect(r.admin.everUsed).toBe(true);
    expect(r.admin.deleteBlockedReason).toMatch(/attached to diagnosis before/);
    await expect(svc.hardDelete('admin-test-pixel', { expectedRevision: r.admin.revision, confirm: true })).rejects.toMatchObject({ code: 'in_use' });
  });

  it('usage lists Knowledge, components, canonical journeys and Help Hubs by structured id', async () => {
    const r = await store(memS3()).inspectOne('wm-pump-filter');
    expect(r.admin.usage.knowledge.map((k) => k.knowledgeId)).toContain('washing-machine:not-draining');
    expect(r.admin.usage.canonical.map((c) => c.journey)).toEqual(expect.arrayContaining(['wm-not-draining', 'wm-leaking']));
    expect(r.admin.usage.canonical.every((c) => c.actionKey && c.knowledgeId)).toBe(true);
    expect(r.admin.usage.helpHubs.map((h) => h.slug)).toContain('washing-machines');
    expect(r.admin.canDelete).toBe(false);
    const oven = await store(memS3()).inspectOne('oven-element-about');
    expect(oven.admin.usage.components.map((c) => c.componentKey)).toContain('oven-cooker:fan-oven-element');
  });

  it('archive withholds the item from the live join and the customer boundary; restore brings it back', async () => {
    const s3 = memS3();
    const svc = store(s3);
    let r = await svc.retire('dishwasher-filter', { expectedRevision: 0, confirm: true, reason: 'test', actor: 'a@x' });
    expect(r.admin.retiredBy).toBe('a@x');
    let st = JSON.parse(s3.files.get(mediaAdmin.STATE_KEY));
    expect(liveItem(st, 'dishwasher:not-draining', 'dishwasher-filter')).toBeUndefined();
    expect(mediaAdmin.applyToCustomerMedia([{ id: 'dishwasher-filter', title: 't', url: '/media/x.svg' }], st)).toEqual([]);
    await expect(svc.retire('dishwasher-filter', { expectedRevision: r.admin.revision, confirm: true })).rejects.toMatchObject({ code: 'invalid_state' });
    r = await svc.restore('dishwasher-filter', { expectedRevision: r.admin.revision });
    st = JSON.parse(s3.files.get(mediaAdmin.STATE_KEY));
    expect(liveItem(st, 'dishwasher:not-draining', 'dishwasher-filter')).toEqual(liveItem(null, 'dishwasher:not-draining', 'dishwasher-filter'));
  });

  it('canonical refs file is current (structured ids from MEDIA_BY_KEY, not text matching)', () => {
    const { build } = require('../scripts/build-media-canonical-refs.cjs');
    expect(require('../media-canonical-refs.json')).toEqual(build());
  });
});

describe('HTTP: new routes require admin; revision required; actor stamped from the session', () => {
  function ev(path, method, body, qs) {
    return { rawPath: path, requestContext: { http: { method, path }, requestId: 't' }, headers: {}, cookies: [], body: body ? JSON.stringify(body) : '', queryStringParameters: qs || {} };
  }
  let s3;
  beforeEach(() => { s3 = memS3(); api.setMediaAdminStore(store(s3)); api.setSessionForTests(null); });
  afterEach(() => { api.setSessionForTests(null); api.setMediaAdminStore(null); });

  it('401 on every mutation without an admin session', async () => {
    const q = { id: 'vac-lost-suction' };
    for (const [p, m] of [['/api/admin/media/record/publish', 'POST'], ['/api/admin/media/record/rollback', 'POST'], ['/api/admin/media/record/discard', 'POST'],
      ['/api/admin/media/record/version', 'GET'], ['/api/admin/media/record/retire', 'POST'], ['/api/admin/media/record/restore', 'POST'],
      ['/api/admin/media/record', 'DELETE'], ['/api/admin/media/record/replace', 'POST'], ['/api/admin/media/record/component', 'POST']]) {
      expect((await api.handler(ev(p, m, { expectedRevision: 0 }, q))).statusCode).toBe(401);
    }
    api.setSessionForTests(async () => ({ isAdmin: false, email: 'user@x' }));
    expect((await api.handler(ev('/api/admin/media/record/publish', 'POST', { expectedRevision: 0 }, q))).statusCode).toBe(401);
  });

  it('405 on wrong methods for the new routes', async () => {
    api.setSessionForTests(async () => ({ isAdmin: true, email: 'admin@test' }));
    expect((await api.handler(ev('/api/admin/media/record/publish', 'GET', null, { id: 'x' }))).statusCode).toBe(405);
    expect((await api.handler(ev('/api/admin/media/record/version', 'POST', {}, { id: 'x' }))).statusCode).toBe(405);
  });

  it('PATCH saves a draft with the session actor (client actor ignored); stale revision → 409', async () => {
    api.setSessionForTests(async () => ({ isAdmin: true, email: 'admin@test' }));
    const noRev = await api.handler(ev('/api/admin/media/record', 'PATCH', { title: 'x' }, { id: 'vac-lost-suction' }));
    expect(noRev.statusCode).toBe(400);
    const r = await api.handler(ev('/api/admin/media/record', 'PATCH', { expectedRevision: 0, title: 'HTTP draft', actor: 'spoof@evil' }, { id: 'vac-lost-suction' }));
    expect(r.statusCode).toBe(200);
    const body = JSON.parse(r.body);
    expect(body.admin.draftSavedBy).toBe('admin@test');
    expect(body.title).toBe('Poor suction — what to check first');
    const stale = await api.handler(ev('/api/admin/media/record', 'PATCH', { expectedRevision: 0, title: 'stale' }, { id: 'vac-lost-suction' }));
    expect(stale.statusCode).toBe(409);
    expect(JSON.parse(stale.body).code).toBe('conflict');
    const pub = await api.handler(ev('/api/admin/media/record/publish', 'POST', { expectedRevision: body.admin.revision }, { id: 'vac-lost-suction' }));
    expect(JSON.parse(pub.body).admin.publishedBy).toBe('admin@test');
    const v = await api.handler(ev('/api/admin/media/record/version', 'GET', null, { id: 'vac-lost-suction', v: '1' }));
    expect(JSON.parse(v.body).version.record.title).toBe('HTTP draft');
  });
});
