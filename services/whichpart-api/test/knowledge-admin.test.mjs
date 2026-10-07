/**
 * Knowledge management: drafts, explicit publish, immutable versions, rollback, archive, delete,
 * validation, optimistic concurrency, failure isolation, auth on every mutation.
 * Uses an in-memory S3 with real ETag / IfMatch / IfNoneMatch semantics and an injected embedder +
 * part-finder health probe (which actually merges the overlay through part-finder retrieval.js).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const ka = require('../knowledge-admin.js');
const kn = require('../knowledge-inspect.js');
const retrieval = require('../../part-finder/retrieval.js');

const DIMS = 768;
const BASE_LABEL = require('../../part-finder/knowledge/knowledge-docs.json').docs.find((d) => d.knowledgeId === 'washing-machine:not-draining').label;
const ACTOR = { username: 'admin', email: 'admin@example.com', isAdmin: true };

function memS3() {
  const objects = new Map();
  let n = 0;
  const api = {
    objects,
    failPutFor: null,
    async get(key) { const o = objects.get(key); return o ? { body: o.body, etag: o.etag } : null; },
    async put(key, body, opts) {
      if (api.failPutFor && api.failPutFor(key)) throw new Error('boom');
      const cur = objects.get(key);
      if (opts && opts.ifNoneMatch === '*' && cur) { const e = new Error('pre'); e.code = 'precondition'; throw e; }
      if (opts && opts.ifMatch && (!cur || cur.etag !== opts.ifMatch)) { const e = new Error('pre'); e.code = 'precondition'; throw e; }
      const etag = '"e' + (++n) + '"';
      objects.set(key, { body, etag });
      return { etag };
    },
    async del(key) { objects.delete(key); },
    json(key) { const o = objects.get(key); return o ? JSON.parse(o.body) : null; },
  };
  return api;
}
function fakeEmbed(text) {
  // Deterministic pseudo-embedding (shape matches the shipped nomic index).
  const v = new Array(DIMS).fill(0);
  for (let i = 0; i < text.length; i++) v[i % DIMS] += (text.charCodeAt(i) % 7) / 10;
  return Promise.resolve(v);
}
// A part-finder that really loads the overlay object the BFF wrote, through retrieval.js.
function engineFor(s3) {
  return async () => {
    retrieval.setKnowledgeOverlayLoader(async () => s3.json(ka.PUBLISHED_KEY));
    await retrieval.ensureKnowledgeOverlay({ ttlMs: 0 });
    return { knowledgeOverlay: retrieval.getKnowledgeOverlayCache(), knowledge: { records: retrieval.describeLoadedIndex().records } };
  };
}
function store(s3, extra) {
  return ka.createStore(Object.assign({
    s3, embed: fakeEmbed, engineHealth: engineFor(s3), sleep: async () => {}, confirmTimeoutMs: 0, confirmIntervalMs: 0,
  }, extra || {}));
}
const NEW = {
  applianceFamily: 'dishwasher', faultId: 'test-crud-item', label: 'Test CRUD item',
  outcome: 'ADVICE_ONLY', provenance: 'engineer', symptoms: ['beeps three times at the end'],
};

beforeEach(() => {
  kn.resetCache();
  retrieval.setKnowledgeOverlayLoader(async () => null);
  retrieval.resetKnowledgeOverlayCache();
});

describe('text assembly parity with the offline build', () => {
  const { docs } = require('../../part-finder/knowledge/knowledge-docs.json');
  it('assembleText is byte-identical for all 171 shipped docs', () => {
    expect(docs.length).toBe(171);
    for (const d of docs) expect(ka.assembleText(d)).toBe(d.text);
  });
  it('copy → validate → build of an unchanged baseline record reproduces the shipped text', () => {
    const safety = require('../../part-finder/knowledge/safety-information.json').byKnowledgeId;
    const bad = [];
    for (const d of docs) {
      const { content, errors } = ka.validateContent(ka.editableFrom(d, safety[d.knowledgeId] || null), 'publish', { knownIds: new Set(docs.map((x) => x.knowledgeId)) });
      if (errors.length) bad.push([d.knowledgeId, errors]);
      const built = ka.buildPublishedDoc(content, '1.0.0');
      if (built.text !== d.text) bad.push([d.knowledgeId, 'text']);
      if (JSON.stringify(built.likelyComponents) !== JSON.stringify(d.likelyComponents)) bad.push([d.knowledgeId, 'likely']);
    }
    expect(bad).toEqual([]);
  });
});

describe('validation', () => {
  it('rejects bad identity, outcome, component type and safety class', () => {
    const { errors } = ka.validateContent({
      applianceFamily: 'toaster', faultId: 'Bad Id', label: '', outcome: 'SELL', provenance: 'x',
      components: [{ name: 'Pump', type: 'widget' }],
      safetyInformation: { classification: 'PANIC' },
    }, 'draft');
    const fields = errors.map((e) => e.field);
    expect(fields).toEqual(expect.arrayContaining(['applianceFamily', 'faultId', 'label', 'outcome', 'provenance', 'components[0].type', 'safetyInformation.classification']));
  });
  it('publish needs symptoms, sourced safety and resolvable related topics', () => {
    const { errors } = ka.validateContent(Object.assign({}, NEW, {
      symptoms: [], alternatives: ['no-such-topic'],
      safetyInformation: { text: 'Unplug it', classification: 'STOP_USE', provenance: [] },
    }), 'publish', { knownIds: new Set(['dishwasher:not-draining']) });
    const fields = errors.map((e) => e.field);
    expect(fields).toEqual(expect.arrayContaining(['symptoms', 'alternatives[0]', 'safetyInformation.hazard', 'safetyInformation.applicability', 'safetyInformation.provenance']));
  });
  it('drops blank editor rows and duplicate symptoms', () => {
    const { content, errors } = ka.validateContent(Object.assign({}, NEW, {
      symptoms: ['a', ' ', 'a', 'b'], components: [{ name: '', supports: [''] }, { name: 'Filter', type: 'check', supports: ['x', ''] }],
    }), 'draft');
    expect(errors).toEqual([]);
    expect(content.symptoms).toEqual(['a', 'b']);
    expect(content.components).toEqual([{ name: 'Filter', type: 'check', partName: null, supports: ['x'], against: [] }]);
  });
});

describe('draft lifecycle never touches production', () => {
  it('create → save → delete a never-published draft; published.json is never written', async () => {
    const s3 = memS3();
    const st = store(s3);
    const v = await st.createDraft(NEW, ACTOR);
    expect(v.state).toBe('draft');
    expect(v.stateLabel).toBe('Draft');
    expect(v.revision).toBe(1);
    expect(v.canDelete).toBe(true);
    const v2 = await st.saveDraft(v.knowledgeId, 1, Object.assign({}, v.draft, { label: 'Renamed' }), ACTOR);
    expect(v2.draft.label).toBe('Renamed');
    expect(v2.revision).toBe(2);
    expect(s3.objects.has(ka.PUBLISHED_KEY)).toBe(false);
    const del = await st.deleteDraft(v.knowledgeId, 2, ACTOR);
    expect(del.deleted).toBe(true);
    expect(s3.json(ka.STATE_KEY).records[v.knowledgeId]).toBeUndefined();
    expect(s3.objects.has(ka.PUBLISHED_KEY)).toBe(false);
  });
  it('editing a baseline record creates a draft but live content and RAG stay on baseline', async () => {
    const s3 = memS3();
    const st = store(s3);
    const id = 'washing-machine:not-draining';
    const v = await st.startDraft(id, 0, ACTOR);
    expect(v.stateLabel).toBe('Draft changes pending');
    const changed = Object.assign({}, v.draft, { label: 'Not draining (edited)' });
    const v2 = await st.saveDraft(id, v.revision, changed, ACTOR);
    expect(v2.pendingChanges).toEqual(['label']);
    expect(v2.live.label).toBe(BASE_LABEL);
    expect(s3.objects.has(ka.PUBLISHED_KEY)).toBe(false);
    // Engine still on the baseline.
    await engineFor(s3)();
    expect(retrieval.getKnowledgeRecord('washing-machine', 'not-draining').label).toBe(BASE_LABEL);
  });
  it('rejects duplicates of baseline ids and identity changes', async () => {
    const st = store(memS3());
    await expect(st.createDraft(Object.assign({}, NEW, { faultId: 'not-draining' }), ACTOR)).rejects.toMatchObject({ status: 409, code: 'exists' });
    const v = await st.createDraft(NEW, ACTOR);
    await expect(st.saveDraft(v.knowledgeId, 1, Object.assign({}, v.draft, { faultId: 'other' }), ACTOR)).rejects.toMatchObject({ status: 400 });
  });
});

describe('optimistic concurrency', () => {
  it('a stale expectedRevision is a 409 and does not overwrite', async () => {
    const s3 = memS3();
    const st = store(s3);
    const v = await st.createDraft(NEW, ACTOR);
    await st.saveDraft(v.knowledgeId, 1, Object.assign({}, v.draft, { label: 'First' }), ACTOR);
    await expect(st.saveDraft(v.knowledgeId, 1, Object.assign({}, v.draft, { label: 'Second' }), ACTOR))
      .rejects.toMatchObject({ status: 409, code: 'conflict', extra: { revision: 2 } });
    expect(s3.json(ka.STATE_KEY).records[v.knowledgeId].draft.label).toBe('First');
  });
  it('a concurrent S3 writer is detected by ETag and the write is retried on fresh state', async () => {
    const s3 = memS3();
    const st = store(s3);
    await st.createDraft(NEW, ACTOR);
    const realPut = s3.put;
    let raced = false;
    s3.put = async (key, body, opts) => {
      if (!raced && key === ka.STATE_KEY) {
        raced = true;
        const cur = s3.json(ka.STATE_KEY);
        cur.records['dishwasher:other-writer'] = { knowledgeId: 'dishwasher:other-writer', origin: 'admin', revision: 1, currentVersion: 0, versions: [], draft: Object.assign({}, NEW, { faultId: 'other-writer', knowledgeId: 'dishwasher:other-writer' }) };
        await realPut(key, JSON.stringify(cur), { ifMatch: s3.objects.get(key).etag });
      }
      return realPut(key, body, opts);
    };
    await st.saveDraft('dishwasher:test-crud-item', 1, Object.assign({}, NEW, { label: 'Mine' }), ACTOR);
    const state = s3.json(ka.STATE_KEY);
    expect(state.records['dishwasher:test-crud-item'].draft.label).toBe('Mine');
    expect(state.records['dishwasher:other-writer']).toBeTruthy();
  });
});

describe('publish is the boundary that changes production RAG', () => {
  it('publishing a new record creates v1, the engine retrieves it, and history records the author', async () => {
    const s3 = memS3();
    const st = store(s3);
    const v = await st.createDraft(Object.assign({}, NEW, { outcome: 'ADVICE_ONLY' }), ACTOR);
    const p = await st.publish(v.knowledgeId, v.revision, 'first publish', ACTOR);
    expect(p.published.version).toBe(1);
    expect(p.published.engine.confirmed).toBe(true);
    expect(p.state).toBe('published');
    expect(p.currentVersion).toBe(1);
    expect(p.draft).toBeNull();
    expect(p.versions[0]).toMatchObject({ version: 1, publishedBy: 'admin@example.com', note: 'first publish', source: 'draft' });
    const ver = s3.json(ka.versionKey(v.knowledgeId, 1));
    expect(ver.vector.length).toBe(DIMS);
    expect(ver.doc.text).toBe(ka.assembleText(ver.doc));
    // Part-finder now has 172 records and identity lookup works.
    expect(retrieval.describeLoadedIndex().records).toBe(172);
    expect(retrieval.getKnowledgeRecord('dishwasher', 'test-crud-item').label).toBe('Test CRUD item');
    const r = await retrieval.retrieve({ applianceFamily: 'dishwasher' }, 'beeps three times at the end', 500);
    expect(r.docs.map((d) => d.knowledgeId)).toContain('dishwasher:test-crud-item');
  });
  it('publishing an edit of a baseline record replaces it in the engine (same count)', async () => {
    const s3 = memS3();
    const st = store(s3);
    const id = 'washing-machine:not-draining';
    const v = await st.startDraft(id, 0, ACTOR);
    const v2 = await st.saveDraft(id, v.revision, Object.assign({}, v.draft, { label: 'Not draining (edited)' }), ACTOR);
    const p = await st.publish(id, v2.revision, null, ACTOR);
    expect(p.currentVersion).toBe(1);
    expect(p.versions.map((x) => x.version)).toEqual([1, 0]);
    expect(retrieval.describeLoadedIndex().records).toBe(171);
    expect(retrieval.getKnowledgeRecord('washing-machine', 'not-draining').label).toBe('Not draining (edited)');
  });
  it('a stale revision cannot publish', async () => {
    const st = store(memS3());
    const v = await st.createDraft(NEW, ACTOR);
    await expect(st.publish(v.knowledgeId, 0, null, ACTOR)).rejects.toMatchObject({ status: 409 });
  });
  it('an invalid draft is refused at publish with field errors', async () => {
    const st = store(memS3());
    const v = await st.createDraft(Object.assign({}, NEW, { symptoms: [] }), ACTOR);
    await expect(st.publish(v.knowledgeId, v.revision, null, ACTOR)).rejects.toMatchObject({ status: 400, code: 'validation' });
  });
});

describe('failed publish leaves the previous live version intact', () => {
  it('embedding failure → nothing written to published.json, draft kept', async () => {
    const s3 = memS3();
    const st = store(s3, { embed: async () => { throw new Error('down'); } });
    const v = await st.createDraft(NEW, ACTOR);
    await expect(st.publish(v.knowledgeId, v.revision, null, ACTOR)).rejects.toMatchObject({ status: 502, code: 'embed_failed' });
    expect(s3.objects.has(ka.PUBLISHED_KEY)).toBe(false);
    expect(s3.objects.has(ka.versionKey(v.knowledgeId, 1))).toBe(false);
    expect(s3.json(ka.STATE_KEY).records[v.knowledgeId].draft).toBeTruthy();
  });
  it('wrong embedding dimensions are refused', async () => {
    const st = store(memS3(), { embed: async () => [0.1, 0.2] });
    const v = await st.createDraft(NEW, ACTOR);
    await expect(st.publish(v.knowledgeId, v.revision, null, ACTOR)).rejects.toMatchObject({ code: 'embed_failed' });
  });
  it('engine does not confirm → overlay entry reverted, version file removed, v1 stays live', async () => {
    const s3 = memS3();
    let healthy = true;
    const real = engineFor(s3);
    const st = store(s3, { engineHealth: async () => (healthy ? real() : { knowledgeOverlay: { state: 'unavailable', version: 0 } }) });
    const id = 'washing-machine:not-draining';
    let v = await st.startDraft(id, 0, ACTOR);
    v = await st.saveDraft(id, v.revision, Object.assign({}, v.draft, { label: 'Edit one' }), ACTOR);
    v = await st.publish(id, v.revision, null, ACTOR);
    v = await st.startDraft(id, v.revision, ACTOR);
    v = await st.saveDraft(id, v.revision, Object.assign({}, v.draft, { label: 'Edit two' }), ACTOR);
    healthy = false;
    await expect(st.publish(id, v.revision, null, ACTOR)).rejects.toMatchObject({ status: 502, code: 'live_unconfirmed', extra: { reverted: true } });
    const pub = s3.json(ka.PUBLISHED_KEY);
    expect(pub.docs[id].label).toBe('Edit one');
    expect(pub.docs[id].publishedVersion).toBe(1);
    expect(s3.objects.has(ka.versionKey(id, 2))).toBe(false);
    const rec = s3.json(ka.STATE_KEY).records[id];
    expect(rec.currentVersion).toBe(1);
    expect(rec.draft.label).toBe('Edit two');
  });
  it('the engine rejects a malformed overlay and keeps the last good knowledge', async () => {
    const s3 = memS3();
    const st = store(s3);
    const v = await st.createDraft(NEW, ACTOR);
    await st.publish(v.knowledgeId, v.revision, null, ACTOR);
    expect(retrieval.describeLoadedIndex().records).toBe(172);
    retrieval.setKnowledgeOverlayLoader(async () => ({ version: 99, docs: { 'dishwasher:x': { knowledgeId: 'dishwasher:x' } } }));
    await retrieval.ensureKnowledgeOverlay({ ttlMs: 0 });
    expect(retrieval.getKnowledgeOverlayCache().state).toBe('unavailable');
    expect(retrieval.describeLoadedIndex().records).toBe(172);
  });
});

describe('versions, rollback, archive', () => {
  async function threeVersions() {
    const s3 = memS3();
    const st = store(s3);
    let v = await st.createDraft(NEW, ACTOR);
    for (const label of ['L1', 'L2', 'L3', 'L4']) {
      if (!v.draft) v = await st.startDraft(v.knowledgeId, v.revision, ACTOR);
      v = await st.saveDraft(v.knowledgeId, v.revision, Object.assign({}, v.draft, { label }), ACTOR);
      v = await st.publish(v.knowledgeId, v.revision, null, ACTOR);
    }
    return { s3, st, v };
  }
  it('rollback to v2 creates v5 with v2 content; v1–v4 are untouched', async () => {
    const { s3, st, v } = await threeVersions();
    const before = [1, 2, 3, 4].map((n) => s3.objects.get(ka.versionKey(v.knowledgeId, n)).body);
    const r = await st.rollback(v.knowledgeId, v.revision, 2, 'undo', ACTOR);
    expect(r.currentVersion).toBe(5);
    expect(r.versions[0]).toMatchObject({ version: 5, source: 'rollback', rolledBackFrom: 2 });
    expect(s3.json(ka.versionKey(v.knowledgeId, 5)).content.label).toBe('L2');
    expect([1, 2, 3, 4].map((n) => s3.objects.get(ka.versionKey(v.knowledgeId, n)).body)).toEqual(before);
    expect(retrieval.getKnowledgeRecord('dishwasher', 'test-crud-item').label).toBe('L2');
    const v2 = await st.getVersion(v.knowledgeId, 2);
    expect(v2.content.label).toBe('L2');
    expect(v2.vector).toBeUndefined();
  });
  it('rollback to the shipped baseline (v0) is a new version too', async () => {
    const s3 = memS3();
    const st = store(s3);
    const id = 'washing-machine:not-draining';
    let v = await st.startDraft(id, 0, ACTOR);
    v = await st.saveDraft(id, v.revision, Object.assign({}, v.draft, { label: 'Changed' }), ACTOR);
    v = await st.publish(id, v.revision, null, ACTOR);
    v = await st.rollback(id, v.revision, 0, null, ACTOR);
    expect(v.currentVersion).toBe(2);
    expect(retrieval.getKnowledgeRecord('washing-machine', 'not-draining').label).toBe(BASE_LABEL);
    expect(s3.json(ka.PUBLISHED_KEY).docs[id].text).toBe(require('../../part-finder/knowledge/knowledge-docs.json').docs.find((d) => d.knowledgeId === id).text);
  });
  it('rollback is blocked while a draft is pending', async () => {
    const { st, v } = await threeVersions();
    const d = await st.startDraft(v.knowledgeId, v.revision, ACTOR);
    await expect(st.rollback(v.knowledgeId, d.revision, 1, null, ACTOR)).rejects.toMatchObject({ code: 'draft_pending' });
  });
  it('archive removes a record from the active RAG (history kept); restore brings it back; no hard delete', async () => {
    const s3 = memS3();
    const st = store(s3);
    const id = 'washing-machine:not-draining';
    let v = await st.archive(id, 0, ACTOR);
    expect(v.state).toBe('archived');
    expect(retrieval.describeLoadedIndex().records).toBe(170);
    expect(retrieval.getKnowledgeRecord('washing-machine', 'not-draining')).toBeNull();
    const r = await retrieval.retrieve({ applianceFamily: 'washing-machine' }, 'not draining', 50);
    expect(r.docs.map((d) => d.knowledgeId)).not.toContain(id);
    await expect(st.deleteDraft(id, v.revision, ACTOR)).rejects.toMatchObject({ status: 409 });
    await expect(st.startDraft(id, v.revision, ACTOR)).rejects.toMatchObject({ status: 409 });
    v = await st.restore(id, v.revision, ACTOR);
    expect(v.state).toBe('published');
    expect(retrieval.describeLoadedIndex().records).toBe(171);
    expect(retrieval.getKnowledgeRecord('washing-machine', 'not-draining').label).toBe(BASE_LABEL);
  });
  it('published records cannot be hard deleted; DELETE only discards the pending draft', async () => {
    const { s3, st, v } = await threeVersions();
    const d = await st.startDraft(v.knowledgeId, v.revision, ACTOR);
    const after = await st.deleteDraft(v.knowledgeId, d.revision, ACTOR);
    expect(after.deleted).toBeUndefined();
    expect(after.draft).toBeNull();
    expect(after.currentVersion).toBe(4);
    expect(s3.json(ka.PUBLISHED_KEY).docs[v.knowledgeId]).toBeTruthy();
    await expect(st.deleteDraft(v.knowledgeId, after.revision, ACTOR)).rejects.toMatchObject({ status: 409 });
  });
});

describe('knowledge-inspect merges the admin view', () => {
  it('lists drafts / published / archived with state labels', async () => {
    const s3 = memS3();
    const st = store(s3);
    await st.createDraft(NEW, ACTOR);
    await st.archive('vacuum:cuts-out', 0, ACTOR);
    const sd = await st.startDraft('washing-machine:not-draining', 0, ACTOR);
    expect(sd.draftPending).toBe(true);
    kn.setAdminView(await st.inspectView());
    const list = kn.listKnowledge({});
    expect(list.total).toBe(172);
    expect(list.baselineTotal).toBe(171);
    const by = Object.fromEntries(list.records.map((r) => [r.knowledgeId, r]));
    expect(by['dishwasher:test-crud-item'].stateLabel).toBe('Draft');
    expect(by['dishwasher:test-crud-item'].indexed).toBe(false);
    expect(by['vacuum:cuts-out'].stateLabel).toBe('Archived');
    expect(by['washing-machine:not-draining'].stateLabel).toBe('Draft changes pending');
    expect(by['washing-machine:door-locked'] ? by['washing-machine:door-locked'].stateLabel : 'Published').toBe('Published');
    expect(list.stateCounts).toMatchObject({ draft: 1, archived: 1, draftPending: 1 });
    expect(JSON.stringify(list)).not.toMatch(/"vector"/);
    const rec = kn.getKnowledge('dishwasher:test-crud-item');
    expect(rec.source).toBe('draft');
    expect(rec.technical.text).toBeNull();
  });
});

describe('HTTP: every mutation requires an admin session', () => {
  it('401 without a session, 405 on wrong methods, 200 with admin', async () => {
    const api = require('../index.js');
    const s3 = memS3();
    api.setKnowledgeAdminStore(store(s3));
    const call = (method, path, body) => api.handler({
      rawPath: path, rawQueryString: '', requestContext: { http: { method, path } },
      headers: {}, body: body ? JSON.stringify(body) : undefined,
    });
    api.setSessionForTests(async () => null);
    for (const [m, p] of [['POST', '/api/admin/knowledge/draft'], ['PUT', '/api/admin/knowledge/draft'], ['DELETE', '/api/admin/knowledge/draft'],
      ['POST', '/api/admin/knowledge/publish'], ['POST', '/api/admin/knowledge/rollback'], ['POST', '/api/admin/knowledge/archive'],
      ['POST', '/api/admin/knowledge/restore'], ['GET', '/api/admin/knowledge/versions']]) {
      const r = await call(m, p, NEW);
      expect([p, m, r.statusCode]).toEqual([p, m, 401]);
    }
    expect(s3.objects.size).toBe(0);
    api.setSessionForTests(async () => ({ username: 'nonadmin', isAdmin: false }));
    expect((await call('POST', '/api/admin/knowledge/draft', NEW)).statusCode).toBe(401);
    api.setSessionForTests(async () => ACTOR);
    expect((await call('GET', '/api/admin/knowledge/publish')).statusCode).toBe(405);
    const created = await call('POST', '/api/admin/knowledge/draft', { content: NEW });
    expect(created.statusCode).toBe(200);
    const body = JSON.parse(created.body);
    expect(body.state).toBe('draft');
    const list = JSON.parse((await call('GET', '/api/admin/knowledge')).body);
    expect(list.records.find((r) => r.knowledgeId === 'dishwasher:test-crud-item').stateLabel).toBe('Draft');
    const stale = await api.handler({ rawPath: '/api/admin/knowledge/draft', rawQueryString: 'id=dishwasher%3Atest-crud-item', queryStringParameters: { id: 'dishwasher:test-crud-item' }, requestContext: { http: { method: 'PUT', path: '/api/admin/knowledge/draft' } }, headers: {}, body: JSON.stringify({ expectedRevision: 0, content: NEW }) });
    expect(stale.statusCode).toBe(409);
    const del = await api.handler({ rawPath: '/api/admin/knowledge/draft', rawQueryString: 'id=dishwasher%3Atest-crud-item', queryStringParameters: { id: 'dishwasher:test-crud-item' }, requestContext: { http: { method: 'DELETE', path: '/api/admin/knowledge/draft' } }, headers: {}, body: JSON.stringify({ expectedRevision: 1 }) });
    expect(JSON.parse(del.body)).toMatchObject({ deleted: true });
    api.setSessionForTests(null);
    api.setKnowledgeAdminStore(null);
    kn.setAdminView(null);
  });
});

describe('authoring support: readiness check and duplicate-as-new-draft', () => {
  it('checkDraft runs the publish validation without writing anything', async () => {
    const s3 = memS3();
    const st = store(s3);
    const bad = await st.checkDraft(Object.assign({}, NEW, { symptoms: [], alternatives: ['no-such-topic'] }));
    expect(bad.ready).toBe(false);
    expect(bad.errors.map((e) => e.field)).toEqual(expect.arrayContaining(['symptoms', 'alternatives[0]']));
    const good = await st.checkDraft(NEW);
    expect(good).toEqual({ ready: true, errors: [] });
    const taken = await st.checkDraft(Object.assign({}, NEW, { faultId: 'not-draining' }));
    expect(taken.errors).toContainEqual({ field: 'faultId', message: 'A knowledge record with this id already exists' });
    const existing = await st.checkDraft(Object.assign({}, NEW, { applianceFamily: 'x', faultId: 'y' }), 'washing-machine:not-draining');
    expect(existing.ready).toBe(true);
    expect(s3.objects.size).toBe(0);
    // Same verdict as publish itself.
    const v = await st.createDraft(Object.assign({}, NEW, { symptoms: [] }), ACTOR);
    const chk = await st.checkDraft(v.draft, v.knowledgeId);
    const pub = await st.publish(v.knowledgeId, v.revision, null, ACTOR).catch((e) => e);
    expect(pub.extra.errors).toEqual(chk.errors);
  });
  it('duplicate records createdFrom as provenance only; new record is an unpublished draft with no history', async () => {
    const s3 = memS3();
    const st = store(s3);
    const v = await st.createDraft(Object.assign({}, NEW, { faultId: 'copy-of-drain' }), ACTOR, { createdFrom: 'dishwasher:not-draining' });
    expect(v.createdFrom).toEqual({ knowledgeId: 'dishwasher:not-draining', version: 'Baseline (shipped)' });
    expect(v.state).toBe('draft');
    expect(v.currentVersion).toBe(0);
    expect(v.versions).toEqual([]);
    expect(s3.objects.has(ka.PUBLISHED_KEY)).toBe(false);
    expect(s3.json(ka.STATE_KEY).records['dishwasher:not-draining']).toBeUndefined();
    await expect(st.createDraft(Object.assign({}, NEW, { faultId: 'copy-two' }), ACTOR, { createdFrom: 'dishwasher:nope' }))
      .rejects.toMatchObject({ status: 400 });
  });
  it('HTTP /validate is admin-only and POST-only', async () => {
    const api = require('../index.js');
    const s3 = memS3();
    api.setKnowledgeAdminStore(store(s3));
    const call = (method, body) => api.handler({ rawPath: '/api/admin/knowledge/validate', rawQueryString: '', requestContext: { http: { method, path: '/api/admin/knowledge/validate' } }, headers: {}, body: body ? JSON.stringify(body) : undefined });
    api.setSessionForTests(async () => null);
    expect((await call('POST', { content: NEW })).statusCode).toBe(401);
    api.setSessionForTests(async () => ACTOR);
    expect((await call('GET')).statusCode).toBe(405);
    const r = await call('POST', { content: Object.assign({}, NEW, { symptoms: [] }) });
    expect(r.statusCode).toBe(200);
    expect(JSON.parse(r.body).errors[0].field).toBe('symptoms');
    expect(s3.objects.size).toBe(0);
    api.setSessionForTests(null);
    api.setKnowledgeAdminStore(null);
    kn.setAdminView(null);
  });
});
