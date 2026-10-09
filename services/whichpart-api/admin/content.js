'use strict';

/**
 * Admin: the knowledge and media libraries. Their overlay stores, the overlay cache the customer path also reads, and
 * their routes. Knowledge Admin shows effective media, so the two share state.
 */
const transcripts = require('../transcripts');
const knowledgeInspect = require('../knowledge-inspect');
const mediaInspect = require('../media-inspect');
const mediaAdmin = require('../media-admin');
const knowledgeAdmin = require('../knowledge-admin');
const { ORCHESTRATOR_URL, ENGINE_URL, LEARNING_BUCKET } = require('../config.js');
const { log } = require('../log.js');
const { parseJsonBody, queryParam, fetchHealth, respond } = require('../http-io.js');
const { requireAdmin } = require('../session.js');
const { s3client, _streamToString, acqS3 } = require('../s3.js');

let _mediaAdminStore = null;
let _overlayCache = { at: 0, state: null };

function mediaAdminS3() {
  const isPrecondition = (e) => {
    const status = e && e.$metadata && e.$metadata.httpStatusCode;
    const name = e && (e.name || e.Code || e.code);
    return status === 412 || status === 409 || name === 'PreconditionFailed' || name === 'ConditionalRequestConflict';
  };
  return {
    getObject: (key) => acqS3.getObject(key),
    // state.json with its ETag, and ETag-conditional writes (optimistic concurrency on the whole document).
    async getState(key) {
      const { GetObjectCommand } = require('@aws-sdk/client-s3');
      try {
        const r = await s3client().send(new GetObjectCommand({ Bucket: LEARNING_BUCKET, Key: key }));
        return { body: await _streamToString(r.Body), etag: r.ETag || null };
      } catch (e) {
        if (e && (e.name === 'NoSuchKey' || (e.$metadata && e.$metadata.httpStatusCode === 404))) return null;
        throw e;
      }
    },
    async putState(key, body, opts) {
      const { PutObjectCommand } = require('@aws-sdk/client-s3');
      const params = { Bucket: LEARNING_BUCKET, Key: key, Body: body, ContentType: 'application/json' };
      if (opts && opts.ifMatch) params.IfMatch = opts.ifMatch;
      if (opts && opts.ifNoneMatch) params.IfNoneMatch = opts.ifNoneMatch;
      try {
        await s3client().send(new PutObjectCommand(params));
      } catch (e) {
        if (isPrecondition(e)) { const pe = new Error('precondition failed'); pe.code = 'precondition'; throw pe; }
        throw e;
      }
    },
    async putObject(key, body) {
      const { PutObjectCommand } = require('@aws-sdk/client-s3');
      await s3client().send(new PutObjectCommand({
        Bucket: LEARNING_BUCKET, Key: key, Body: body,
        ContentType: Buffer.isBuffer(body) ? 'application/octet-stream' : 'application/json',
      }));
    },
    async putBinary(key, buf, contentType) {
      const { PutObjectCommand } = require('@aws-sdk/client-s3');
      await s3client().send(new PutObjectCommand({
        Bucket: LEARNING_BUCKET, Key: key, Body: buf,
        ContentType: contentType || 'application/octet-stream',
      }));
    },
  };
}
function webMediaPut() {
  const bucket = process.env.WHICHPART_WEB_BUCKET || 'whichpart-web-800960611664';
  return {
    async putPublicMedia(fileName, buf, contentType) {
      const { PutObjectCommand } = require('@aws-sdk/client-s3');
      const name = String(fileName || '').replace(/^\/+/, '');
      if (!/^[a-zA-Z0-9._-]+$/.test(name)) throw new Error('unsafe-filename');
      await s3client().send(new PutObjectCommand({
        Bucket: bucket, Key: 'media/' + name, Body: buf,
        ContentType: contentType || 'application/octet-stream',
        CacheControl: 'max-age=300, must-revalidate',
      }));
    },
  };
}
function mediaStore() {
  if (_mediaAdminStore) return _mediaAdminStore;
  _mediaAdminStore = mediaAdmin.createStore({ s3: mediaAdminS3(), web: webMediaPut() });
  return _mediaAdminStore;
}
function setMediaAdminStore(store) {
  _mediaAdminStore = store;
  _overlayCache = { at: 0, state: null };
}
async function loadOverlayCached() {
  const now = Date.now();
  const ttl = 10000;
  if (_overlayCache.state && (now - _overlayCache.at) < ttl) return _overlayCache.state;
  try {
    const state = await mediaStore().loadState();
    _overlayCache = { at: now, state, failed: false };
    return state;
  } catch (e) {
    log({ evt: 'media-overlay-load-failed', error: String(e && e.message || e) });
    if (_overlayCache.state) {
      _overlayCache.at = now;
      _overlayCache.failed = true;
      return _overlayCache.state;
    }
    return mediaAdmin.emptyState();
  }
}
function mediaAdminError(e) {
  const status = (e && e.status) || (e && e.code === 'not_found' ? 404 : 400);
  const body = { error: (e && e.message) || 'Media management failed', code: e && e.code };
  if (e && e.extra) body.extra = e.extra;
  return respond(status, body);
}
// ---- Knowledge management (drafts / publish / versions / rollback / archive) ----------------
// Store: LEARNING_BUCKET knowledge-admin/ (see knowledge-admin.js). Every S3 write is conditional.
function knowledgeAdminS3() {
  const isPrecondition = (e) => {
    const status = e && e.$metadata && e.$metadata.httpStatusCode;
    const name = e && (e.name || e.Code || e.code);
    return status === 412 || status === 409 || name === 'PreconditionFailed' || name === 'ConditionalRequestConflict';
  };
  return {
    async get(key) {
      const { GetObjectCommand } = require('@aws-sdk/client-s3');
      try {
        const r = await s3client().send(new GetObjectCommand({ Bucket: LEARNING_BUCKET, Key: key }));
        return { body: await _streamToString(r.Body), etag: r.ETag || null };
      } catch (e) {
        if (e && (e.name === 'NoSuchKey' || (e.$metadata && e.$metadata.httpStatusCode === 404))) return null;
        throw e;
      }
    },
    async put(key, body, opts) {
      const { PutObjectCommand } = require('@aws-sdk/client-s3');
      const params = { Bucket: LEARNING_BUCKET, Key: key, Body: body, ContentType: 'application/json' };
      if (opts && opts.ifMatch) params.IfMatch = opts.ifMatch;
      if (opts && opts.ifNoneMatch) params.IfNoneMatch = opts.ifNoneMatch;
      try {
        const r = await s3client().send(new PutObjectCommand(params));
        return { etag: r.ETag || null };
      } catch (e) {
        if (isPrecondition(e)) { const pe = new Error('precondition failed'); pe.code = 'precondition'; throw pe; }
        throw e;
      }
    },
    async del(key) {
      const { DeleteObjectCommand } = require('@aws-sdk/client-s3');
      await s3client().send(new DeleteObjectCommand({ Bucket: LEARNING_BUCKET, Key: key }));
    },
  };
}
// Same embedding endpoint + model family part-finder uses for queries and the offline index build.
async function knowledgeEmbed(text, model) {
  const base = String(process.env.EMBED_URL || process.env.LM_STUDIO_URL || '').replace(/\/+$/, '');
  if (!base) throw new Error('embedding endpoint not configured');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
  try {
    const r = await fetch(base + '/v1/embeddings', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model, input: text }),
      signal: ctrl.signal,
    });
    if (!r.ok) throw new Error('embed ' + r.status);
    const data = await r.json();
    return data && data.data && data.data[0] && data.data[0].embedding;
  } finally { clearTimeout(timer); }
}
async function knowledgeEngineHealth() {
  const h = await fetchHealth(ENGINE_URL.replace(/\/$/, '') + '/health', 5000);
  return h && h.json;
}
let _knowledgeAdminStore = null;
function knowledgeStore() {
  if (_knowledgeAdminStore) return _knowledgeAdminStore;
  _knowledgeAdminStore = knowledgeAdmin.createStore({
    s3: knowledgeAdminS3(), embed: knowledgeEmbed, engineHealth: knowledgeEngineHealth, log,
  });
  return _knowledgeAdminStore;
}
function setKnowledgeAdminStore(store) { _knowledgeAdminStore = store; }
// Refresh the overlay/draft view knowledge-inspect merges into list/detail (and Media's picker).
async function refreshKnowledgeView() {
  await refreshKnowledgeMediaView();
  try {
    knowledgeInspect.setAdminView(await knowledgeStore().inspectView());
    return { ok: true, mediaUnavailable: _knowledgeMediaUnavailable || undefined };
  } catch (e) {
    log({ evt: 'knowledge-view-refresh-failed', error: String(e && e.message || e) });
    return { ok: false, mediaUnavailable: _knowledgeMediaUnavailable || undefined };
  }
}
// Knowledge Admin shows EFFECTIVE Media (shipped join + Media overlay, merged exactly as live diagnosis
// merges it). Read through the same 10 s overlay cache the customer boundary uses. Outside Lambda the
// overlay is only read from an injected store (tests / harness) or with MEDIA_OVERLAY_LIVE=1, so unit
// tests never touch production S3.
let _knowledgeMediaUnavailable = false;
async function refreshKnowledgeMediaView() {
  const live = _mediaAdminStore || process.env.AWS_LAMBDA_FUNCTION_NAME || process.env.MEDIA_OVERLAY_LIVE === '1';
  if (!live) { knowledgeInspect.setMediaView(null); _knowledgeMediaUnavailable = false; return; }
  const overlay = await loadOverlayCached();
  _knowledgeMediaUnavailable = Boolean(_overlayCache.failed || !_overlayCache.state);
  knowledgeInspect.setMediaView(mediaInspect.knowledgeMediaView(overlay));
}
function knowledgeAdminError(e) {
  const status = (e && e.status) || 500;
  const body = { error: (e && e.message) || 'Knowledge management failed', code: (e && e.code) || 'error' };
  if (e && e.extra) Object.assign(body, e.extra);
  if (status >= 500) log({ evt: 'knowledge-admin-failed', code: body.code, error: body.error });
  return respond(status, body);
}

async function adminKnowledge(event) {
  if (!(await requireAdmin(event))) return respond(401, { error: 'Unauthorized' });
  const qs = (event && event.queryStringParameters) || {};
  const view = await refreshKnowledgeView();
  const list = knowledgeInspect.listKnowledge({ q: qs.q, family: qs.family });
  if (!view.ok) list.overlayUnavailable = true;
  if (view.mediaUnavailable) list.mediaOverlayUnavailable = true;
  const orchUrl = ORCHESTRATOR_URL.replace(/\/$/, '') + '/health';
  let rag = { state: 'unknown' };
  try {
    const orch = await fetchHealth(orchUrl, 5000);
    rag = { ok: !!(orch.json && orch.json.diagnosticRag),
      state: (orch.json && orch.json.diagnosticRag) || 'unknown',
      reportedBy: 'orchestrator',
      orchestratorVersion: (orch.json && orch.json.version) || null };
  } catch { /* keep unknown */ }
  return respond(200, Object.assign({}, list, {
    rag,
    helpHubs: transcripts.HELP_HUBS,
  }));
}

async function adminKnowledgeRecord(event) {
  if (!(await requireAdmin(event))) return respond(401, { error: 'Unauthorized' });
  const id = queryParam(event, 'id');
  if (!id) return respond(400, { error: 'id required' });
  const view = await refreshKnowledgeView();
  const rec = knowledgeInspect.getKnowledge(id);
  if (!rec) return respond(404, { error: 'not found' });
  let admin = null;
  try { admin = await knowledgeStore().getView(id); } catch (e) { if (!e || e.status !== 404) admin = { unavailable: true }; }
  return respond(200, Object.assign({}, rec, { admin, overlayUnavailable: !view.ok || undefined, mediaOverlayUnavailable: view.mediaUnavailable }));
}
// Every Knowledge mutation: admin session required, JSON body, expectedRevision echoed back.
async function knowledgeMutation(event, fn) {
  const actor = await requireAdmin(event);
  if (!actor) return respond(401, { error: 'Unauthorized' });
  let body = {};
  if (event.body) {
    try { body = JSON.parse(event.body); } catch { return respond(400, { error: 'invalid JSON', code: 'json' }); }
    if (!body || typeof body !== 'object' || Array.isArray(body)) return respond(400, { error: 'invalid JSON', code: 'json' });
  }
  const id = queryParam(event, 'id') || body.id || null;
  try {
    const out = await fn({ actor, body, id });
    await refreshKnowledgeView();
    return respond(200, out);
  } catch (e) { return knowledgeAdminError(e); }
}
function needId(id) { if (!id) throw knowledgeAdmin.err('validation', 'id required', 400); return id; }
async function adminKnowledgeDraft(event, method) {
  if (method === 'POST') {
    // POST without id = create a new record as a draft; POST ?id= = start a draft from the live content.
    return knowledgeMutation(event, ({ actor, body, id }) => id
      ? knowledgeStore().startDraft(id, body.expectedRevision, actor)
      : knowledgeStore().createDraft(body.content || body, actor, { createdFrom: body.createdFrom || null }));
  }
  if (method === 'PUT') {
    return knowledgeMutation(event, ({ actor, body, id }) => knowledgeStore().saveDraft(needId(id), body.expectedRevision, body.content, actor));
  }
  if (method === 'DELETE') {
    return knowledgeMutation(event, ({ actor, body, id }) => knowledgeStore().deleteDraft(needId(id),
      body.expectedRevision != null ? body.expectedRevision : queryParam(event, 'expectedRevision'), actor));
  }
  return respond(405, { error: 'POST, PUT or DELETE' });
}
async function adminKnowledgeVersions(event) {
  if (!(await requireAdmin(event))) return respond(401, { error: 'Unauthorized' });
  const id = queryParam(event, 'id');
  if (!id) return respond(400, { error: 'id required' });
  const v = queryParam(event, 'v');
  try {
    if (v != null && v !== '') return respond(200, await knowledgeStore().getVersion(id, v));
    return respond(200, await knowledgeStore().listVersions(id));
  } catch (e) { return knowledgeAdminError(e); }
}

async function adminMedia(event) {
  if (!(await requireAdmin(event))) return respond(401, { error: 'Unauthorized' });
  const qs = (event && event.queryStringParameters) || {};
  try {
    const list = await mediaStore().inspectList({
      q: qs.q, family: qs.family, type: qs.type, usage: qs.usage,
    });
    return respond(200, Object.assign({}, list, { managed: true }));
  } catch (e) {
    log({ evt: 'media-list-overlay-failed', error: String(e && e.message || e) });
    return respond(200, Object.assign({}, mediaInspect.listMedia({
      q: qs.q, family: qs.family, type: qs.type, usage: qs.usage,
    }), { overlayUnavailable: true, managed: true }));
  }
}

async function adminMediaRecord(event) {
  if (!(await requireAdmin(event))) return respond(401, { error: 'Unauthorized' });
  const id = queryParam(event, 'id');
  if (!id) return respond(400, { error: 'id required' });
  try {
    const rec = await mediaStore().inspectOne(id);
    if (!rec) return respond(404, { error: 'not found' });
    return respond(200, rec);
  } catch (e) {
    const rec = mediaInspect.getMedia(id);
    if (!rec) return mediaAdminError(e);
    return respond(200, Object.assign({}, rec, { overlayUnavailable: true }));
  }
}

// Media mutations: admin-only; the actor is stamped from the session (any client-supplied actor is dropped);
// every change to an existing item must carry the item revision it was made from (stale edits → 409).
function mediaActorBody(body, session) {
  const b = Object.assign({}, (body && typeof body === 'object' && !Array.isArray(body)) ? body : {});
  delete b.actor;
  b.actor = (session && (session.email || session.username)) || null;
  return b;
}
function mediaRevisionMissing(body) {
  return body.expectedRevision === undefined || body.expectedRevision === null || body.expectedRevision === '';
}
const MEDIA_REVISION_REQUIRED = { error: 'expectedRevision is required. Reload this media item and try again.', code: 'revision_required' };
async function mediaMutation(event, needsRevision, run) {
  const session = await requireAdmin(event);
  if (!session) return respond(401, { error: 'Unauthorized' });
  const id = queryParam(event, 'id');
  if (needsRevision && !id) return respond(400, { error: 'id required' });
  try {
    const body = mediaActorBody(await parseJsonBody(event), session);
    if (needsRevision && mediaRevisionMissing(body)) return respond(400, MEDIA_REVISION_REQUIRED);
    const rec = await run(mediaStore(), id, body);
    _overlayCache = { at: 0, state: null };
    return respond(200, rec);
  } catch (e) { return mediaAdminError(e); }
}

function adminMediaCreate(event) {
  return mediaMutation(event, false, (store, _id, body) => store.create(body));
}

function adminMediaPatch(event) {
  return mediaMutation(event, true, (store, id, body) => store.saveDraft(id, body,
    body.dataBase64 || body.fileName ? { fileName: body.fileName, dataBase64: body.dataBase64 } : null));
}

function adminMediaReplace(event) {
  return mediaMutation(event, true, (store, id, body) => store.replaceFile(id, body));
}

function adminMediaAction(event, action) {
  return mediaMutation(event, true, (store, id, body) => store[action](id, body));
}

async function adminMediaVersion(event) {
  if (!(await requireAdmin(event))) return respond(401, { error: 'Unauthorized' });
  const id = queryParam(event, 'id');
  if (!id) return respond(400, { error: 'id required' });
  try {
    return respond(200, { version: await mediaStore().version(id, queryParam(event, 'v')) });
  } catch (e) { return mediaAdminError(e); }
}

function adminMediaMap(event, method) {
  return mediaMutation(event, true, (store, id, body) => {
    if (method === 'POST') return store.attachMapping(id, body);
    if (method === 'PATCH') return store.updateMapping(id, body.knowledgeId, body);
    return store.detachMapping(id, body.knowledgeId || queryParam(event, 'knowledgeId'), body);
  });
}

function adminMediaComponent(event, method) {
  return mediaMutation(event, true, (store, id, body) => (method === 'POST'
    ? store.attachComponent(id, body)
    : store.detachComponent(id, body.componentKey || queryParam(event, 'componentKey'), body)));
}

function adminMediaRetire(event) {
  return mediaMutation(event, true, (store, id, body) => store.retire(id, body));
}

function adminMediaRestore(event) {
  return mediaMutation(event, true, (store, id, body) => store.restore(id, body));
}

function adminMediaDelete(event) {
  return mediaMutation(event, true, (store, id, body) => store.hardDelete(id, body));
}

async function adminMediaPreview(event, method) {
  if (!(await requireAdmin(event))) return respond(401, { error: 'Unauthorized' });
  try {
    if (method === 'POST') {
      const body = await parseJsonBody(event);
      const preview = await mediaStore().previewCreate(body);
      return respond(200, preview);
    }
    const id = queryParam(event, 'id');
    if (!id) return respond(400, { error: 'id required' });
    const rec = await mediaStore().inspectOne(id);
    if (!rec) return respond(404, { error: 'not found' });
    return respond(200, mediaStore().customerPreview(rec));
  } catch (e) { return mediaAdminError(e); }
}

async function adminMediaKnowledge(event) {
  if (!(await requireAdmin(event))) return respond(401, { error: 'Unauthorized' });
  await refreshKnowledgeView();
  const qs = (event && event.queryStringParameters) || {};
  return respond(200, { records: mediaStore().knowledgePicker(qs.q || '') });
}

module.exports = {
  mediaStore, setMediaAdminStore, loadOverlayCached, knowledgeStore, setKnowledgeAdminStore, adminKnowledge,
  adminKnowledgeRecord, knowledgeMutation, needId, adminKnowledgeDraft, adminKnowledgeVersions, adminMedia,
  adminMediaRecord, adminMediaCreate, adminMediaPatch, adminMediaReplace, adminMediaAction, adminMediaVersion,
  adminMediaMap, adminMediaComponent, adminMediaRetire, adminMediaRestore, adminMediaDelete, adminMediaPreview,
  adminMediaKnowledge,
};
