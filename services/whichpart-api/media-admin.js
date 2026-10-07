'use strict';
/**
 * Durable Media Management overlay.
 *
 * Authoritative runtime store: S3 (LEARNING_BUCKET / media-admin/state.json), one document written with
 * ETag-conditional puts (IfMatch / IfNoneMatch) and a per-item `revision` for stale-edit protection.
 * Binaries: S3 media-admin/files/* (private copy) and the public web bucket /media/* — IMMUTABLE,
 * content-addressed names (<id>-<sha256/12>.<ext>). Nothing is ever overwritten in place or deleted.
 * Shipped git JSON remains the baseline; the overlay merges on read.
 *
 * Live boundary (what customers can see):
 *   - identities[id].catalogue  = the LIVE presentation override (title / caption / alt / file url)
 *   - identities[id].draft      = unpublished edits / replacement file. Never read by live diagnosis
 *                                 (part-finder media-effective.js and applyToCustomerMedia read `catalogue` only).
 *   - versions[]                = immutable published presentations (each points at an immutable file);
 *                                 publish / rollback append a version. Shipped items have a virtual v0 baseline.
 *   - byKnowledgeId / byComponent (+ detach tombstones) = diagnostic usage. Attach / detach are explicit,
 *     confirmed, revision-checked live changes (a new item has no live effect until it is attached).
 * Does not rewrite diagnostic prompts, RAG ranking, or knowledge docs.
 */
const crypto = require('crypto');
const mediaInspect = require('./media-inspect');
const knowledgeInspect = require('./knowledge-inspect');

const STATE_KEY = 'media-admin/state.json';
const FILE_PREFIX = 'media-admin/files/';
// Request bodies carry base64 (×4/3) through a Lambda function URL (6 MB payload limit), so 4 MB of file.
const MAX_BYTES = 4 * 1024 * 1024;
const MAX_DIMENSION = 8000;
const MAX_ACTIONS = 40;
const WRITE_RETRIES = 3;
const ALLOWED_TYPES = ['IMAGE', 'DIAGRAM', 'VIDEO'];
const ALLOWED_EXT = { '.png': 'image/png', '.svg': 'image/svg+xml', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' };
const FAMILIES = mediaInspect.FAMILIES;
const ID_RE = /^[a-z][a-z0-9-]{1,78}$/;
const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;
const CONFLICT_CODES = ['conflict', 'in_use', 'invalid_state', 'draft_pending', 'no_draft', 'duplicate', 'duplicate_file', 'file_exists', 'retired'];
const CHANGE_LABELS = { title: 'Title', caption: 'Customer description', alt: 'Alt text', families: 'Appliance family', url: 'File' };

let CANONICAL_REFS = { byMediaId: {} };
try { CANONICAL_REFS = require('./media-canonical-refs.json'); } catch { /* optional in unit contexts */ }

function iso(d) { return (d || new Date()).toISOString(); }
function clone(x) { return x == null ? x : JSON.parse(JSON.stringify(x)); }

function emptyState() {
  return {
    version: 1,
    updatedAt: null,
    identities: {},
    byKnowledgeId: {},
    byComponent: {},
    detachedByKnowledgeId: {},
    detachedByComponent: {},
    files: {},
    actions: [],
  };
}

function parseJson(s) {
  try { return JSON.parse(s); } catch { return null; }
}

function slugId(title) {
  const s = String(title || 'media').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);
  return s || 'media';
}

function extOf(name) {
  const n = String(name || '').toLowerCase();
  const i = n.lastIndexOf('.');
  return i === -1 ? '' : n.slice(i);
}

function safeFileName(name) {
  const base = String(name || 'asset').toLowerCase().split(/[/\\]/).pop();
  const cleaned = base.replace(/[^a-z0-9._-]+/g, '-').replace(/^[.-]+/, '');
  return cleaned || 'asset.bin';
}

function decodeData(dataBase64) {
  if (!dataBase64) return null;
  const s = String(dataBase64).replace(/^data:[^;]+;base64,/, '');
  const buf = Buffer.from(s, 'base64');
  if (!buf.length) return null;
  return buf;
}

function err(code, message, extra) {
  const e = new Error(message);
  e.code = code;
  e.status = code === 'unauthorized' ? 401 : (code === 'not_found' ? 404 : (CONFLICT_CODES.indexOf(code) !== -1 ? 409 : 400));
  if (extra) e.extra = extra;
  return e;
}

function recordAction(state, action) {
  state.actions = [{ at: action.at, type: action.type, id: action.id || null, actor: action.actor || null }]
    .concat(state.actions || []).slice(0, MAX_ACTIONS);
}

function identityExists(id, overlay) {
  const { byId } = mediaInspect.buildIdentities(overlay);
  return Boolean(byId[id]);
}

function knowledgeExists(id) {
  return Boolean(knowledgeInspect.getKnowledge(id));
}

function currentJoin(overlay) {
  const applied = mediaInspect.applyOverlay(
    { items: [] },
    (function load() {
      const fs = require('fs');
      const path = require('path');
      const corpus = knowledgeInspect.loadCorpus();
      try {
        return JSON.parse(fs.readFileSync(path.join(corpus.dir, 'media-information.json'), 'utf8'));
      } catch { return { byKnowledgeId: {}, byComponent: {} }; }
    })(),
    overlay,
  );
  return applied.join;
}

function nodeList(overlay, knowledgeId) {
  const join = currentJoin(overlay);
  return (join.byKnowledgeId[knowledgeId] || []).slice();
}

function componentList(overlay, componentKey) {
  const join = currentJoin(overlay);
  return (join.byComponent[componentKey] || []).slice();
}

function overlayList(state, mapName, key) {
  return ((state[mapName] || {})[key] || []).filter((m) => m && m.id && !m.detached);
}

function clearDetach(state, mapName, key, id) {
  const bag = state[mapName] || {};
  if (!bag[key] || !bag[key][id]) return;
  const next = Object.assign({}, bag[key]);
  delete next[id];
  bag[key] = next;
  state[mapName] = bag;
}

function markDetach(state, mapName, key, id) {
  state[mapName] = state[mapName] || {};
  state[mapName][key] = Object.assign({}, state[mapName][key] || {}, { [id]: true });
}

function mappingFromIdentity(id, overlay, extras) {
  const rec = mediaInspect.getMedia(id, overlay);
  if (!rec) throw err('not_found', 'Media identity not found');
  const item = {
    id: rec.id,
    type: rec.type,
    title: rec.title,
    description: extras.description != null ? extras.description : rec.description,
    caption: extras.caption != null ? extras.caption : rec.caption,
    alt: rec.alt,
    relatedCheck: extras.relatedCheck != null ? extras.relatedCheck : rec.relatedCheck,
    applicability: extras.applicability || rec.applicability || 'GENERIC',
  };
  if (rec.type === 'VIDEO') {
    item.provider = 'YOUTUBE';
    item.videoId = rec.videoId;
    item.embedUrl = rec.embedUrl;
    item.attribution = rec.attribution;
    item.sourcePageUrl = rec.sourcePageUrl;
  } else {
    item.asset = rec.previewUrl;
  }
  if (extras.intent === 'ABOUT' || extras.intent === 'SAFE_CHECK') item.intent = extras.intent;
  if (typeof extras.priority === 'number') item.priority = extras.priority;
  // safetyClass is never inferred. Only copy if already stored on this identity's mappings.
  if (rec.safetyClass) item.safetyClass = rec.safetyClass;
  if (extras.makes && extras.makes.length) item.makes = extras.makes.slice();
  if (extras.errorCodes && extras.errorCodes.length) item.errorCodes = extras.errorCodes.slice();
  return item;
}

// ---------------------------------------------------------------- file validation (content, not just name)
function svgDims(text) {
  const tag = (/<svg\b[^>]*>/i.exec(text) || [''])[0];
  const num = (name) => {
    const m = new RegExp('\\s' + name + '\\s*=\\s*["\']\\s*([0-9.]+)\\s*(px)?\\s*["\']', 'i').exec(tag);
    return m ? Math.round(Number(m[1])) : null;
  };
  let width = num('width');
  let height = num('height');
  if (!width || !height) {
    const vb = /\sviewBox\s*=\s*["']\s*[-0-9.]+[\s,]+[-0-9.]+[\s,]+([0-9.]+)[\s,]+([0-9.]+)\s*["']/i.exec(tag);
    if (vb) { width = width || Math.round(Number(vb[1])); height = height || Math.round(Number(vb[2])); }
  }
  return { width: width || null, height: height || null };
}

const SVG_UNSAFE = [
  [/<\s*script\b/i, 'script'],
  [/<\s*(foreignObject|iframe|embed|object|audio|video|link|meta|base|form|input|textarea|button)\b/i, 'embedded HTML element'],
  [/\son[a-z]+\s*=/i, 'event handler attribute'],
  [/javascript\s*:/i, 'javascript: URL'],
  [/<!ENTITY/i, 'XML entity'],
  [/<!DOCTYPE[^>]*\[/i, 'DOCTYPE internal subset'],
  [/@import/i, 'CSS @import'],
  [/url\s*\(\s*['"]?\s*(https?:|data:|\/\/)/i, 'external CSS url()'],
  [/(?:xlink:)?href\s*=\s*["']\s*(?!#)/i, 'non-local href'],
];

/** Identify an image by its bytes. Returns { kind, contentType, width, height } or throws. */
function inspectImage(buf, ext) {
  const b = buf;
  let kind = null;
  let width = null;
  let height = null;
  if (b.length >= 24 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) {
    kind = 'png';
    if (b.toString('ascii', 12, 16) === 'IHDR') { width = b.readUInt32BE(16); height = b.readUInt32BE(20); }
  } else if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) {
    kind = 'jpeg';
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) { i += 1; continue; }
      const marker = b[i + 1];
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0xff) { i += marker === 0xff ? 1 : 2; continue; }
      if (marker === 0xd9 || marker === 0xda) break;
      const len = b.readUInt16BE(i + 2);
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        height = b.readUInt16BE(i + 5); width = b.readUInt16BE(i + 7);
        break;
      }
      i += 2 + len;
    }
  } else if (b.length >= 10 && (b.toString('ascii', 0, 6) === 'GIF87a' || b.toString('ascii', 0, 6) === 'GIF89a')) {
    kind = 'gif'; width = b.readUInt16LE(6); height = b.readUInt16LE(8);
  } else if (b.length >= 30 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP') {
    kind = 'webp';
    const chunk = b.toString('ascii', 12, 16);
    if (chunk === 'VP8 ') { width = b.readUInt16LE(26) & 0x3fff; height = b.readUInt16LE(28) & 0x3fff; }
    else if (chunk === 'VP8L') { const bits = b.readUInt32LE(21); width = (bits & 0x3fff) + 1; height = ((bits >> 14) & 0x3fff) + 1; }
    else if (chunk === 'VP8X') { width = 1 + b.readUIntLE(24, 3); height = 1 + b.readUIntLE(27, 3); }
  } else {
    const text = b.toString('utf8');
    if (text.indexOf('\u0000') === -1 && /^\uFEFF?\s*(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*(<!DOCTYPE svg[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*<svg[\s>]/i.test(text)) {
      kind = 'svg';
      const bad = SVG_UNSAFE.find((p) => p[0].test(text));
      if (bad) throw err('file_unsafe', 'This SVG contains active or external content (' + bad[1] + '). Upload a plain SVG drawing or a PNG instead.');
      const d = svgDims(text); width = d.width; height = d.height;
    }
  }
  if (!kind) throw err('file_type', 'The file content is not a PNG, JPEG, GIF, WebP or SVG image.');
  const want = { '.png': 'png', '.jpg': 'jpeg', '.jpeg': 'jpeg', '.gif': 'gif', '.webp': 'webp', '.svg': 'svg' }[ext];
  if (want !== kind) throw err('file_mismatch', 'The file name says ' + (ext || 'nothing') + ' but the content is ' + kind.toUpperCase() + '. Rename or re-export the file.');
  if (kind !== 'svg') {
    if (!width || !height) throw err('file_dimensions', 'Could not read the image dimensions. Re-export the image and try again.');
  }
  if ((width && width > MAX_DIMENSION) || (height && height > MAX_DIMENSION)) {
    throw err('file_dimensions', 'Image is too large (' + width + '×' + height + '). Maximum ' + MAX_DIMENSION + ' pixels per side.');
  }
  return { kind, contentType: ALLOWED_EXT[ext], width: width || null, height: height || null };
}

/**
 * Validate and name an upload. Name is content-addressed (<id>-<sha256/12>.<ext>) so an upload can never
 * overwrite a shipped file, another item's file, or an earlier version of the same item.
 */
function prepareUpload(id, input, state) {
  const fileName = safeFileName(input.fileName || (id + '.png'));
  const ext = extOf(fileName);
  if (!ALLOWED_EXT[ext]) throw err('file_type', 'Unsupported file type. Use png, svg, jpg, webp or gif.');
  const buf = decodeData(input.dataBase64);
  if (!buf) throw err('file', 'An image file is required.');
  if (buf.length > MAX_BYTES) throw err('file_size', 'File is too large (4 MB maximum).');
  const info = inspectImage(buf, ext);
  const sha256 = crypto.createHash('sha256').update(buf).digest('hex');
  const stored = id + '-' + sha256.slice(0, 12) + (ext === '.jpeg' ? '.jpg' : ext);
  const files = (state && state.files) || {};
  const dupKey = Object.keys(files).find((k) => files[k] && files[k].sha256 === sha256 && files[k].mediaId && files[k].mediaId !== id);
  if (dupKey) {
    throw err('duplicate_file', 'This exact file is already used by media “' + files[dupKey].mediaId + '”. Reuse that item instead of uploading a copy.', { mediaId: files[dupKey].mediaId });
  }
  const shipped = mediaInspect.buildIdentities(null);
  if (shipped.knownUrls.has('/media/' + stored)) throw err('file_exists', 'A shipped file already exists at this path.');
  return {
    file: stored, url: '/media/' + stored, bytes: buf.length, contentType: info.contentType,
    width: info.width, height: info.height, sha256, originalName: fileName, buffer: buf,
  };
}

function validateCreate(input, overlay) {
  const type = String(input.type || '').toUpperCase();
  if (ALLOWED_TYPES.indexOf(type) === -1) throw err('type', 'Unsupported media type. Use IMAGE, DIAGRAM or VIDEO.');
  const title = String(input.title || '').trim();
  if (!title) throw err('title', 'Customer-facing title is required.');
  let id = String(input.id || slugId(title)).toLowerCase();
  if (!ID_RE.test(id)) throw err('id', 'Media id must be lowercase letters, numbers and hyphens.');
  if (identityExists(id, overlay)) {
    if (input.id) throw err('duplicate', 'A media identity with this id already exists.');
    let n = 2;
    while (identityExists(id + '-' + n, overlay)) n += 1;
    id = id + '-' + n;
  }
  const families = [].concat(input.families || input.family || []).filter(Boolean);
  families.forEach((f) => {
    if (FAMILIES.indexOf(f) === -1) throw err('family', 'Invalid appliance family: ' + f);
  });
  const description = String(input.description || input.caption || '').trim();
  const alt = String(input.alt || '').trim();
  if (type !== 'VIDEO' && !alt) throw err('alt', 'Meaningful customer alt text is required for images and diagrams.');
  if (!description) throw err('description', 'Customer description is required.');

  const out = {
    id, type, title, description,
    caption: String(input.caption || description).trim(),
    alt: type === 'VIDEO' ? (alt || null) : alt,
    families,
    relatedCheck: String(input.relatedCheck || '').trim() || null,
    attribution: String(input.attribution || '').trim() || null,
    sourcePageUrl: String(input.sourcePageUrl || '').trim() || null,
  };
  if (out.sourcePageUrl && !/^https:\/\//i.test(out.sourcePageUrl)) throw err('source_url', 'Source page URL must start with https://.');

  if (type === 'VIDEO') {
    const embedUrl = String(input.embedUrl || '').trim();
    const videoId = String(input.videoId || '').trim();
    if (!videoId) throw err('video', 'A YouTube video id is required.');
    if (!VIDEO_ID_RE.test(videoId)) throw err('video', 'A YouTube video id is 11 letters, numbers, - or _.');
    const url = embedUrl || ('https://www.youtube-nocookie.com/embed/' + videoId + '?rel=0');
    if (!mediaInspect.isTrustedVideoEmbed(url)) throw err('video_host', 'Only privacy-enhanced youtube-nocookie embeds are allowed.');
    if (/autoplay=1/i.test(url)) throw err('autoplay', 'Autoplay is not allowed.');
    if (url.indexOf('/embed/' + videoId) === -1) throw err('video', 'The embed URL does not match the video id.');
    out.videoId = videoId;
    out.embedUrl = url.replace(/[?&]autoplay=1/g, '');
    out.file = null;
    out.url = url;
    return out;
  }

  const up = prepareUpload(id, input, overlay);
  Object.assign(out, up);
  return out;
}

// ---------------------------------------------------------------- versions / admin view
function revOf(state, id) {
  const r = state.identities && state.identities[id];
  return (r && r.revision) || 0;
}
function checkRevision(state, id, expected) {
  if (expected === undefined || expected === null || expected === '') return;
  if (Number(expected) !== revOf(state, id)) {
    throw err('conflict', 'This media item was changed by someone else. Reload to see the latest version, then try again.', { currentRevision: revOf(state, id) });
  }
}
function ensureIdent(state, id, rec) {
  if (!state.identities[id]) state.identities[id] = { origin: (rec && rec.origin) || 'shipped', status: (rec && rec.status) || 'active', revision: 0 };
  return state.identities[id];
}
function touch(state, id, type, actor, at) {
  const r = state.identities[id];
  r.revision = (r.revision || 0) + 1;
  r.updatedAt = at;
  r.updatedBy = actor || null;
  recordAction(state, { at, type, id, actor });
  state.updatedAt = at;
}
function actorOf(input) { return (input && typeof input.actor === 'string' && input.actor.trim()) ? input.actor.trim().slice(0, 200) : null; }
function noteOf(input) { const n = input && input.note; return n ? String(n).trim().slice(0, 300) || null : null; }

/**
 * Presentation snapshot of the item as currently seen. For SHIPPED items file/url stay null ("the shipped
 * files"): a text-only edit must not pin every diagnostic mapping to one file. A replacement sets them.
 */
function catalogueOf(rec) {
  const f = (rec.files && rec.files[0]) || {};
  const shipped = (rec.origin || 'shipped') === 'shipped';
  return {
    id: rec.id, type: rec.type, title: rec.title || '', caption: rec.caption || rec.description || '',
    description: rec.caption || rec.description || '', alt: rec.alt || '', families: (rec.families || []).slice(),
    relatedCheck: rec.relatedCheck || null,
    file: shipped ? null : (f.file || null),
    url: shipped ? null : (rec.type === 'VIDEO' ? (rec.embedUrl || null) : (rec.previewUrl || f.url || null)),
    bytes: shipped ? null : (f.bytes == null ? null : f.bytes), videoId: rec.videoId || null, embedUrl: rec.embedUrl || null,
    attribution: rec.attribution || null, sourcePageUrl: rec.sourcePageUrl || null,
  };
}
function changedFields(a, b) {
  const x = a || {};
  const y = b || {};
  const out = [];
  if ((x.title || '') !== (y.title || '')) out.push('title');
  if ((x.caption || '') !== (y.caption || '')) out.push('caption');
  if ((x.alt || '') !== (y.alt || '')) out.push('alt');
  if ((x.families || []).join() !== (y.families || []).join()) out.push('families');
  if ((x.url || '') !== (y.url || '')) out.push('url');
  return out;
}
function withCatalogue(state, id, catalogue) {
  const s = clone(state);
  const r = s.identities[id] || (s.identities[id] = { origin: 'shipped', status: 'active' });
  if (catalogue) r.catalogue = clone(catalogue); else delete r.catalogue;
  return s;
}
function shippedRecord(id) { return mediaInspect.getMedia(id, null); }
function currentVersion(ident) { return (ident && ident.currentVersion) || 0; }
function legacyLive(ident) { return Boolean(ident && ident.catalogue && !(ident.versions || []).length); }

function versionList(ident, origin) {
  const out = [];
  if (origin === 'shipped') out.push({ version: 0, label: 'Shipped baseline', source: 'baseline' });
  ((ident && ident.versions) || []).forEach((v) => {
    out.push({
      version: v.version, label: 'v' + v.version, source: v.source, publishedAt: v.publishedAt || null,
      publishedBy: v.publishedBy || null, note: v.note || null, rolledBackFrom: v.rolledBackFrom == null ? null : v.rolledBackFrom,
      changed: v.changed || [], url: (v.catalogue && v.catalogue.url) || null,
    });
  });
  return out;
}

function canonicalUsage(id) {
  return ((CANONICAL_REFS.byMediaId || {})[id] || []).map((r) => Object.assign({}, r));
}

function adminView(state, id, rec) {
  const ident = (state.identities || {})[id] || {};
  const origin = ident.origin || rec.origin || 'shipped';
  const status = rec.status || 'active';
  const versions = versionList(ident, origin);
  const cur = currentVersion(ident);
  const draft = ident.draft || null;
  const canonical = canonicalUsage(id);
  const hubs = rec.helpHubs || [];
  const everUsed = Boolean(ident.everUsed || rec.used);
  let deleteBlocked = null;
  if (origin !== 'admin') deleteBlocked = 'Shipped media cannot be deleted. Archive it instead.';
  else if (rec.used) deleteBlocked = 'This media is attached to diagnosis. Archive it instead.';
  else if (ident.everUsed) deleteBlocked = 'This media has been attached to diagnosis before. Archive it instead so its history is kept.';
  else if (hubs.length) deleteBlocked = 'This file is used on a public Help Hub. Archive it instead.';
  else if (canonical.length) deleteBlocked = 'Canonical diagnostic journeys reference this media id. Archive it instead.';
  let draftRecord = null;
  let pending = [];
  if (draft) {
    draftRecord = mediaInspect.getMedia(id, withCatalogue(state, id, draft.catalogue));
    pending = changedFields(ident.catalogue || catalogueOf(rec), draft.catalogue);
  }
  let liveLabel;
  if (cur) liveLabel = 'v' + cur;
  else if (legacyLive(ident)) liveLabel = 'Live (before version history)';
  else liveLabel = origin === 'shipped' ? 'Shipped baseline' : 'Live';
  return {
    mediaId: id,
    origin,
    status,
    revision: ident.revision || 0,
    currentVersion: cur,
    liveVersionLabel: liveLabel,
    everUsed,
    draftPending: Boolean(draft),
    draftSavedAt: draft ? draft.savedAt : null,
    draftSavedBy: draft ? draft.savedBy : null,
    draft: draftRecord,
    pendingChanges: pending,
    versions,
    createdAt: ident.createdAt || null, createdBy: ident.createdBy || null,
    updatedAt: ident.updatedAt || null, updatedBy: ident.updatedBy || null,
    publishedAt: ident.publishedAt || null, publishedBy: ident.publishedBy || null,
    retiredAt: ident.retiredAt || null, retiredBy: ident.retiredBy || null, retiredReason: ident.retiredReason || null,
    usage: {
      knowledge: (rec.knowledge || []).map((k) => ({ knowledgeId: k.knowledgeId, label: k.label })),
      components: (rec.components || []).map((c) => ({ componentKey: c.componentKey })),
      canonical,
      helpHubs: hubs.map((h) => ({ slug: h.slug, title: h.title })),
    },
    canPublish: Boolean(draft) && status !== 'retired',
    canDiscard: Boolean(draft),
    canDelete: !deleteBlocked,
    deleteBlockedReason: deleteBlocked,
    canArchive: status !== 'retired',
    canRestore: status === 'retired',
    canRollback: status !== 'retired' && !draft && versions.length > 1,
  };
}

function createStore(deps) {
  const s3 = deps.s3;
  const web = deps.web || null;
  const nowFn = deps.now || (() => new Date());

  function normalise(parsed) {
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      const e = err('malformed', 'Media overlay is malformed and was not applied.');
      e.status = 503;
      throw e;
    }
    parsed.identities = parsed.identities || {};
    parsed.byKnowledgeId = parsed.byKnowledgeId || {};
    parsed.byComponent = parsed.byComponent || {};
    parsed.detachedByKnowledgeId = parsed.detachedByKnowledgeId || {};
    parsed.detachedByComponent = parsed.detachedByComponent || {};
    parsed.files = parsed.files || {};
    parsed.actions = parsed.actions || [];
    return parsed;
  }

  async function loadWithEtag() {
    if (s3.getState) {
      const r = await s3.getState(STATE_KEY);
      if (!r) return { state: emptyState(), etag: null };
      return { state: normalise(parseJson(r.body)), etag: r.etag || null };
    }
    const raw = await s3.getObject(STATE_KEY);
    if (!raw) return { state: emptyState(), etag: null };
    return { state: normalise(parseJson(raw)), etag: undefined };
  }

  async function loadState() {
    return (await loadWithEtag()).state;
  }

  async function saveState(state, etag, staged) {
    const body = JSON.stringify(state);
    try {
      if (s3.putState) await s3.putState(STATE_KEY, body, etag ? { ifMatch: etag } : { ifNoneMatch: '*' });
      else await s3.putObject(STATE_KEY, body);
    } catch (e) {
      if (e && e.code === 'precondition') throw e;
      const err2 = err('partial', 'Could not save media metadata after uploading files. Files were stored; metadata was not. Retry the save.');
      err2.status = 503;
      err2.extra = { staged: staged || null, cause: String(e && e.message || e) };
      throw err2;
    }
    return state;
  }

  /** Load fresh (with ETag) → fn(state) → conditional save; on a concurrent write, re-run on fresh state. */
  async function mutate(fn, staged) {
    for (let i = 0; i < WRITE_RETRIES; i += 1) {
      const { state, etag } = await loadWithEtag();
      const result = await fn(state);
      try {
        await saveState(state, etag, staged);
        return { state, result };
      } catch (e) {
        if (e && e.code === 'precondition') continue;
        throw e;
      }
    }
    throw err('conflict', 'Media changed while saving. Please try again.');
  }

  async function putBinary(fileName, buf, contentType) {
    const key = FILE_PREFIX + fileName;
    if (s3.putBinary) await s3.putBinary(key, buf, contentType);
    else await s3.putObject(key, buf);
    let publicOk = false;
    if (web && web.putPublicMedia) {
      try {
        await web.putPublicMedia(fileName, buf, contentType);
        publicOk = true;
      } catch (e) {
        return { key, publicOk: false, publicError: String(e && e.message || e) };
      }
    } else publicOk = true;
    return { key, publicOk };
  }

  async function uploadSpec(spec) {
    const bin = await putBinary(spec.file, spec.buffer, spec.contentType);
    if (!bin.publicOk) {
      const e = err('partial', 'File was stored privately but could not be published to /media/. Metadata was not saved. Retry.');
      e.status = 503;
      e.extra = { staged: [bin] };
      throw e;
    }
    return bin;
  }

  function registerFile(state, spec, id, actor, at) {
    state.files[spec.file] = {
      mediaId: id, sha256: spec.sha256, bytes: spec.bytes, contentType: spec.contentType,
      width: spec.width, height: spec.height, originalName: spec.originalName, uploadedAt: at, uploadedBy: actor || null,
    };
  }

  function detail(state, id) {
    const rec = mediaInspect.getMedia(id, state);
    if (!rec) return null;
    return Object.assign(rec, { admin: adminView(state, id, rec) });
  }
  function liveRecord(state, id) {
    const rec = mediaInspect.getMedia(id, state);
    if (!rec) throw err('not_found', 'Media identity not found');
    return rec;
  }

  async function inspectList(opts) {
    const overlay = await loadState();
    const list = mediaInspect.listMedia(Object.assign({}, opts || {}, { overlay }));
    list.records = list.records.map((r) => {
      const ident = overlay.identities[r.id] || {};
      return Object.assign(r, {
        revision: ident.revision || 0, currentVersion: currentVersion(ident),
        draftPending: Boolean(ident.draft), everUsed: Boolean(ident.everUsed || r.used),
        canonicalCount: canonicalUsage(r.id).length,
      });
    });
    list.draftCount = list.records.filter((r) => r.draftPending).length;
    return list;
  }
  async function inspectOne(id) {
    const overlay = await loadState();
    return detail(overlay, id);
  }

  async function create(input) {
    const pre = await loadState();
    const spec = validateCreate(input || {}, pre);
    const actor = actorOf(input);
    const staged = spec.buffer ? [await uploadSpec(spec)] : [];
    const { state } = await mutate((st) => {
      if (identityExists(spec.id, st)) throw err('duplicate', 'A media identity with this id already exists.');
      const at = iso(nowFn());
      const catalogue = {
        id: spec.id, title: spec.title, caption: spec.caption, description: spec.caption, alt: spec.alt || '', type: spec.type,
        families: spec.families, file: spec.file, url: spec.url, bytes: spec.bytes || null,
        contentType: spec.contentType || null, width: spec.width || null, height: spec.height || null, sha256: spec.sha256 || null,
        videoId: spec.videoId || null, embedUrl: spec.embedUrl || null, relatedCheck: spec.relatedCheck,
        attribution: spec.attribution, sourcePageUrl: spec.sourcePageUrl, knowledgeIds: [],
      };
      st.identities[spec.id] = {
        origin: 'admin', status: 'active', revision: 0,
        createdAt: at, createdBy: actor, updatedAt: at, retiredAt: null, everUsed: false,
        catalogue,
        currentVersion: 1,
        versions: [{ version: 1, source: 'create', publishedAt: at, publishedBy: actor, note: 'Created', rolledBackFrom: null, changed: [], catalogue: clone(catalogue) }],
        draft: null,
      };
      if (spec.buffer) registerFile(st, spec, spec.id, actor, at);
      touch(st, spec.id, 'create', actor, at);
    }, staged);
    return detail(state, spec.id);
  }

  /** Edit customer presentation and/or stage a replacement file as a DRAFT. Live diagnosis is not touched. */
  async function saveDraft(id, patch, fileInput) {
    patch = patch || {};
    if (patch.byKnowledgeId || patch.mappings || patch.knowledgeIds) {
      throw err('boundary', 'Customer presentation cannot change diagnostic mappings. Use mapping management.');
    }
    const actor = actorOf(patch);
    const pre = await loadState();
    const preRec = liveRecord(pre, id);
    let spec = null;
    let staged = [];
    if (fileInput && (fileInput.dataBase64 || fileInput.fileName)) {
      if (preRec.type === 'VIDEO') throw err('type', 'Replace is for local images and diagrams, not videos.');
      spec = prepareUpload(id, fileInput, pre);
      staged = [await uploadSpec(spec)];
    }
    const { state } = await mutate((st) => {
      const rec = liveRecord(st, id);
      checkRevision(st, id, patch.expectedRevision);
      if (rec.status === 'retired') throw err('retired', 'Restore this media before editing customer presentation.');
      const ident = ensureIdent(st, id, rec);
      const base = clone((ident.draft && ident.draft.catalogue) || ident.catalogue || catalogueOf(rec));
      const title = patch.title != null ? String(patch.title).trim() : base.title;
      if (!title) throw err('title', 'Customer-facing title is required.');
      const capIn = patch.caption != null ? patch.caption : patch.description;
      const caption = capIn != null ? String(capIn).trim() : (base.caption || '');
      if (!caption) throw err('description', 'Customer description is required.');
      const alt = patch.alt != null ? String(patch.alt).trim() : (base.alt || '');
      if (rec.type !== 'VIDEO' && !alt) throw err('alt', 'Meaningful customer alt text is required for images and diagrams.');
      let families = base.families || [];
      if (Array.isArray(patch.families) || patch.family) {
        families = [].concat(patch.families || patch.family || []).filter(Boolean);
        families.forEach((f) => {
          if (FAMILIES.indexOf(f) === -1) throw err('family', 'Invalid appliance family: ' + f);
        });
      }
      const next = Object.assign(base, { id, type: rec.type, title, caption, description: caption, alt, families });
      const at = iso(nowFn());
      if (spec) {
        Object.assign(next, {
          file: spec.file, url: spec.url, bytes: spec.bytes, contentType: spec.contentType,
          width: spec.width, height: spec.height, sha256: spec.sha256,
        });
        registerFile(st, spec, id, actor, at);
      }
      ident.draft = { catalogue: next, savedAt: at, savedBy: actor, baseVersion: currentVersion(ident) };
      touch(st, id, spec ? 'draft-replace' : 'draft', actor, at);
    }, staged);
    return detail(state, id);
  }

  // Back-compat names: both now save a DRAFT (nothing goes live until publish).
  function updateMetadata(id, patch) { return saveDraft(id, patch, null); }
  function replaceFile(id, input) {
    const i = input || {};
    return saveDraft(id, { expectedRevision: i.expectedRevision, actor: i.actor }, { fileName: i.fileName, dataBase64: i.dataBase64 });
  }

  async function discardDraft(id, input) {
    const actor = actorOf(input);
    const { state } = await mutate((st) => {
      liveRecord(st, id);
      checkRevision(st, id, input && input.expectedRevision);
      const ident = st.identities[id];
      if (!ident || !ident.draft) throw err('no_draft', 'There is no draft to discard.');
      ident.draft = null;
      touch(st, id, 'discard', actor, iso(nowFn()));
    });
    return detail(state, id);
  }

  /**
   * Point every overlay join item for this media id at the item's current live file: the published
   * replacement if there is one, otherwise the shipped asset of that same mapping (per key).
   */
  function syncAssets(st, id) {
    const ident = st.identities[id] || {};
    if (ident.catalogue && ident.catalogue.type === 'VIDEO') return;
    const url = ident.catalogue && ident.catalogue.url;
    const shippedJoin = url ? null : currentJoin(null);
    const shipped = url ? null : shippedRecord(id);
    ['byKnowledgeId', 'byComponent'].forEach((mapName) => {
      Object.keys(st[mapName] || {}).forEach((k) => {
        st[mapName][k] = (st[mapName][k] || []).map((m) => {
          if (!m || m.id !== id || !m.asset) return m;
          let next = url;
          if (!next) {
            const orig = ((shippedJoin[mapName] || {})[k] || []).find((x) => x && x.id === id);
            next = (orig && orig.asset) || (shipped && shipped.previewUrl) || m.asset;
          }
          return Object.assign({}, m, { asset: next });
        });
      });
    });
  }

  function goLive(st, id, rec, catalogue, meta, actor, at) {
    const ident = ensureIdent(st, id, rec);
    const versions = (ident.versions || []).slice();
    if (!versions.length && ident.catalogue) {
      // Live override from before version history: keep it recoverable as v1.
      versions.push({ version: 1, source: 'legacy', publishedAt: ident.updatedAt || null, publishedBy: null, note: 'Live presentation from before version history', rolledBackFrom: null, changed: [], catalogue: clone(ident.catalogue) });
    }
    const n = (versions.length ? versions[versions.length - 1].version : 0) + 1;
    const prev = ident.catalogue || catalogueOf(shippedRecord(id) || rec);
    const nextEff = catalogue || catalogueOf(shippedRecord(id) || rec);
    versions.push(Object.assign({}, meta, {
      version: n, publishedAt: at, publishedBy: actor, changed: changedFields(prev, nextEff), catalogue: clone(catalogue),
    }));
    ident.versions = versions;
    ident.currentVersion = n;
    if (catalogue) ident.catalogue = clone(catalogue); else delete ident.catalogue;
    ident.publishedAt = at;
    ident.publishedBy = actor;
    syncAssets(st, id);
    return n;
  }

  function validatePublishable(cat, type, origin) {
    const fields = [];
    if (!String(cat.title || '').trim()) fields.push('title');
    if (!String(cat.caption || '').trim()) fields.push('caption');
    if (type !== 'VIDEO' && !String(cat.alt || '').trim()) fields.push('alt');
    // Shipped items without a replacement keep their shipped files (url null = shipped).
    if (type !== 'VIDEO' && origin !== 'shipped' && !String(cat.url || '').trim()) fields.push('file');
    if (fields.length) throw err('invalid', 'This draft is not ready to publish.', { fields });
  }

  async function publish(id, input) {
    const actor = actorOf(input);
    let n = null;
    const { state } = await mutate((st) => {
      const rec = liveRecord(st, id);
      checkRevision(st, id, input && input.expectedRevision);
      const ident = st.identities[id];
      if (!ident || !ident.draft) throw err('no_draft', 'There is no draft to publish.');
      if (rec.status === 'retired') throw err('invalid_state', 'Restore this media before publishing.');
      validatePublishable(ident.draft.catalogue, rec.type, ident.origin || rec.origin);
      const at = iso(nowFn());
      n = goLive(st, id, rec, ident.draft.catalogue, { source: 'draft', note: noteOf(input), rolledBackFrom: null }, actor, at);
      ident.draft = null;
      touch(st, id, 'publish', actor, at);
    });
    return Object.assign(detail(state, id), { published: { version: n } });
  }

  async function rollback(id, input) {
    const actor = actorOf(input);
    let n = null;
    const to = input && input.toVersion;
    const { state } = await mutate((st) => {
      const rec = liveRecord(st, id);
      checkRevision(st, id, input && input.expectedRevision);
      const ident = ensureIdent(st, id, rec);
      if (rec.status === 'retired') throw err('invalid_state', 'Restore this media before rolling back.');
      if (ident.draft) throw err('draft_pending', 'Publish or discard the pending draft before rolling back.');
      const k = Number(to);
      if (to === undefined || to === null || to === '' || !Number.isInteger(k) || k < 0) throw err('invalid', 'Choose a version to roll back to.');
      if (k === currentVersion(ident) && !(k === 0 && legacyLive(ident))) throw err('invalid', 'That version is already live.');
      let catalogue;
      if (k === 0) {
        if ((ident.origin || rec.origin) !== 'shipped') throw err('invalid', 'Admin-created media has no shipped baseline.');
        catalogue = null;
      } else {
        const src = (ident.versions || []).find((v) => v.version === k);
        if (!src) throw err('not_found', 'Version v' + k + ' not found.');
        catalogue = clone(src.catalogue);
      }
      const at = iso(nowFn());
      n = goLive(st, id, rec, catalogue, { source: 'rollback', note: noteOf(input), rolledBackFrom: k }, actor, at);
      touch(st, id, 'rollback', actor, at);
    });
    return Object.assign(detail(state, id), { published: { version: n, rolledBackFrom: Number(to) } });
  }

  async function version(id, v) {
    const st = await loadState();
    const rec = liveRecord(st, id);
    const ident = st.identities[id] || {};
    const k = Number(v);
    if (!Number.isInteger(k) || k < 0) throw err('invalid', 'Invalid version.');
    if (k === 0) {
      if ((ident.origin || rec.origin) !== 'shipped') throw err('not_found', 'This media has no shipped baseline.');
      return { version: 0, source: 'baseline', label: 'Shipped baseline', record: mediaInspect.getMedia(id, withCatalogue(st, id, null)) };
    }
    const hit = (ident.versions || []).find((x) => x.version === k);
    if (!hit) throw err('not_found', 'Version not found.');
    return {
      version: hit.version, source: hit.source, publishedAt: hit.publishedAt, publishedBy: hit.publishedBy,
      note: hit.note, rolledBackFrom: hit.rolledBackFrom, changed: hit.changed || [],
      record: mediaInspect.getMedia(id, withCatalogue(st, id, hit.catalogue)),
    };
  }

  async function attachMapping(id, input) {
    const actor = actorOf(input);
    const { state } = await mutate((st) => {
      const rec = liveRecord(st, id);
      checkRevision(st, id, input && input.expectedRevision);
      if (rec.status === 'retired') throw err('retired', 'Restore this media before attaching it to diagnosis.');
      const knowledgeId = String((input && input.knowledgeId) || '').trim();
      if (!knowledgeId) throw err('knowledge', 'Choose an existing Knowledge record.');
      if (!knowledgeExists(knowledgeId)) throw err('knowledge', 'That Knowledge record does not exist.');
      if (!(input && input.confirmDiagnostic)) {
        throw err('confirm', 'Attaching media changes which customer diagnoses can surface this asset. Confirm to continue.');
      }
      if (nodeList(st, knowledgeId).some((m) => m && m.id === id)) {
        throw err('duplicate', 'This media is already mapped to that Knowledge record.');
      }
      const item = mappingFromIdentity(id, st, input || {});
      const list = overlayList(st, 'byKnowledgeId', knowledgeId);
      list.push(item);
      st.byKnowledgeId[knowledgeId] = list;
      clearDetach(st, 'detachedByKnowledgeId', knowledgeId, id);
      const ident = ensureIdent(st, id, rec);
      ident.everUsed = true;
      touch(st, id, 'map-attach', actor, iso(nowFn()));
    });
    return detail(state, id);
  }

  async function updateMapping(id, knowledgeId, input) {
    const actor = actorOf(input);
    const { state } = await mutate((st) => {
      const rec = liveRecord(st, id);
      checkRevision(st, id, input && input.expectedRevision);
      if (rec.status === 'retired') throw err('retired', 'Restore this media before editing its diagnostic mappings.');
      const kid = String(knowledgeId || (input && input.knowledgeId) || '').trim();
      if (!kid) throw err('knowledge', 'Knowledge id is required.');
      if (!knowledgeExists(kid)) throw err('knowledge', 'That Knowledge record does not exist.');
      if (!(input && input.confirmDiagnostic)) {
        throw err('confirm', 'Editing mapping text is a diagnostic-usage change. Confirm to continue.');
      }
      const effective = nodeList(st, kid).find((m) => m && m.id === id);
      if (!effective) throw err('not_found', 'This media is not mapped to that Knowledge record.');
      const list = overlayList(st, 'byKnowledgeId', kid);
      let item = list.find((m) => m && m.id === id);
      if (!item) {
        item = Object.assign({}, effective);
        list.push(item);
      }
      if (input.description != null) item.description = String(input.description).trim();
      if (input.caption != null) item.caption = String(input.caption).trim();
      if (input.relatedCheck != null) item.relatedCheck = String(input.relatedCheck).trim() || null;
      st.byKnowledgeId[kid] = list.map((m) => (m && m.id === id ? item : m));
      ensureIdent(st, id, rec);
      touch(st, id, 'map-edit', actor, iso(nowFn()));
    });
    return detail(state, id);
  }

  async function detachMapping(id, knowledgeId, input) {
    const actor = actorOf(input);
    const { state } = await mutate((st) => {
      const rec = liveRecord(st, id);
      checkRevision(st, id, input && input.expectedRevision);
      const kid = String(knowledgeId || '').trim();
      if (!kid) throw err('knowledge', 'Knowledge id is required.');
      if (!knowledgeExists(kid)) throw err('knowledge', 'That Knowledge record does not exist.');
      if (!(input && input.confirmDiagnostic)) {
        throw err('confirm', 'Detaching media changes which customer diagnoses can surface this asset. Confirm to continue.');
      }
      if (!nodeList(st, kid).some((m) => m && m.id === id)) {
        throw err('not_found', 'This media is not mapped to that Knowledge record.');
      }
      st.byKnowledgeId[kid] = overlayList(st, 'byKnowledgeId', kid).filter((m) => m && m.id !== id);
      markDetach(st, 'detachedByKnowledgeId', kid, id);
      ensureIdent(st, id, rec);
      touch(st, id, 'map-detach', actor, iso(nowFn()));
    });
    return detail(state, id);
  }

  async function attachComponent(id, input) {
    const actor = actorOf(input);
    const { state } = await mutate((st) => {
      const rec = liveRecord(st, id);
      checkRevision(st, id, input && input.expectedRevision);
      if (rec.status === 'retired') throw err('retired', 'Restore this media before attaching it to diagnosis.');
      const componentKey = String((input && input.componentKey) || '').trim();
      if (!/^[a-z0-9-]+:[a-z0-9-]+$/.test(componentKey)) throw err('component', 'Component key must be family:canonical-component.');
      const family = componentKey.split(':')[0];
      if (FAMILIES.indexOf(family) === -1) throw err('family', 'Invalid appliance family on component key.');
      if (!(input && input.confirmDiagnostic)) {
        throw err('confirm', 'Component mappings can surface this asset during diagnosis. Confirm to continue.');
      }
      if (componentList(st, componentKey).some((m) => m && m.id === id)) {
        throw err('duplicate', 'Already mapped to that component key.');
      }
      const list = overlayList(st, 'byComponent', componentKey);
      list.push(mappingFromIdentity(id, st, input || {}));
      st.byComponent[componentKey] = list;
      clearDetach(st, 'detachedByComponent', componentKey, id);
      const ident = ensureIdent(st, id, rec);
      ident.everUsed = true;
      touch(st, id, 'component-attach', actor, iso(nowFn()));
    });
    return detail(state, id);
  }

  async function detachComponent(id, componentKey, input) {
    const actor = actorOf(input);
    const { state } = await mutate((st) => {
      const rec = liveRecord(st, id);
      checkRevision(st, id, input && input.expectedRevision);
      const ck = String(componentKey || '').trim();
      if (!ck) throw err('component', 'Component key is required.');
      if (!(input && input.confirmDiagnostic)) {
        throw err('confirm', 'Detaching a component mapping can change diagnosis presentation. Confirm to continue.');
      }
      if (!componentList(st, ck).some((m) => m && m.id === id)) {
        throw err('not_found', 'This media is not mapped to that component key.');
      }
      st.byComponent[ck] = overlayList(st, 'byComponent', ck).filter((m) => m && m.id !== id);
      markDetach(st, 'detachedByComponent', ck, id);
      ensureIdent(st, id, rec);
      touch(st, id, 'component-detach', actor, iso(nowFn()));
    });
    return detail(state, id);
  }

  /** Archive (stored status 'retired'): withheld from every live join and the customer boundary. Reversible. */
  async function retire(id, input) {
    const actor = actorOf(input);
    const { state } = await mutate((st) => {
      const rec = liveRecord(st, id);
      checkRevision(st, id, input && input.expectedRevision);
      if (!(input && input.confirm)) throw err('confirm', 'Retirement requires confirmation.');
      if (rec.status === 'retired') throw err('invalid_state', 'Already archived.');
      const at = iso(nowFn());
      const ident = ensureIdent(st, id, rec);
      ident.status = 'retired';
      ident.retiredAt = at;
      ident.retiredBy = actor;
      ident.retiredReason = (input && input.reason) ? String(input.reason).trim().slice(0, 300) || null : null;
      touch(st, id, 'retire', actor, at);
    });
    return detail(state, id);
  }

  async function restore(id, input) {
    const actor = actorOf(input);
    const { state } = await mutate((st) => {
      const rec = liveRecord(st, id);
      checkRevision(st, id, input && input.expectedRevision);
      if (rec.status !== 'retired') throw err('invalid_state', 'This media is not archived.');
      const ident = ensureIdent(st, id, rec);
      ident.status = 'active';
      ident.retiredAt = null;
      ident.retiredBy = null;
      ident.retiredReason = null;
      touch(st, id, 'restore', actor, iso(nowFn()));
    });
    return detail(state, id);
  }

  /**
   * Remove an admin-created item that never reached diagnosis (created by mistake). Metadata only: the
   * immutable files are kept (no DeleteObject permission), so any URL a customer once saw keeps resolving.
   */
  async function hardDelete(id, input) {
    const actor = actorOf(input);
    await mutate((st) => {
      const rec = liveRecord(st, id);
      checkRevision(st, id, input && input.expectedRevision);
      const view = adminView(st, id, rec);
      if (view.origin !== 'admin') throw err('forbidden', 'Shipped media cannot be hard-deleted. Retire it instead.');
      if (!view.canDelete) throw err('in_use', view.deleteBlockedReason, { usage: view.usage });
      if (!(input && input.confirm)) throw err('confirm', 'Hard delete requires confirmation.');
      Object.keys(st.byKnowledgeId).forEach((kid) => {
        st.byKnowledgeId[kid] = (st.byKnowledgeId[kid] || []).filter((m) => m && m.id !== id);
      });
      Object.keys(st.byComponent).forEach((ck) => {
        st.byComponent[ck] = (st.byComponent[ck] || []).filter((m) => m && m.id !== id);
      });
      Object.keys(st.detachedByKnowledgeId || {}).forEach((kid) => markDetach(st, 'detachedByKnowledgeId', kid, id));
      Object.keys(st.detachedByComponent || {}).forEach((ck) => markDetach(st, 'detachedByComponent', ck, id));
      const at = iso(nowFn());
      // Tombstone so the shipped merge never resurrects an admin-only id.
      st.identities[id] = { origin: 'admin', removed: true, updatedAt: at, deletedBy: actor, revision: revOf(st, id) + 1 };
      recordAction(st, { at, type: 'delete', id, actor });
      st.updatedAt = at;
    });
    return { id, deleted: true };
  }

  function customerPreview(rec) {
    if (!rec) return null;
    const topics = (rec.knowledge || []).map((k) => ({
      knowledgeId: k.knowledgeId, label: k.label, faultId: k.faultId, applianceFamily: k.applianceFamily,
    }));
    if (rec.type === 'VIDEO') {
      return {
        kind: 'customer',
        note: 'This is the customer-facing presentation. Playback starts only if the customer presses play.',
        media: [{
          id: rec.id, type: 'VIDEO', title: rec.title, caption: rec.caption || rec.description || '',
          provider: 'YOUTUBE', videoId: rec.videoId, embedUrl: rec.embedUrl,
          attribution: rec.attribution, sourcePageUrl: rec.sourcePageUrl,
          intent: rec.intent === 'ABOUT' ? 'ABOUT' : 'SAFE_CHECK',
        }],
        knowledgeTopics: topics,
        retired: rec.status === 'retired',
      };
    }
    return {
      kind: 'customer',
      note: 'This is the customer-facing presentation for this asset.',
      media: [{
        id: rec.id, type: rec.type, title: rec.title,
        description: rec.description || '', url: rec.previewUrl, alt: rec.alt || rec.title,
        intent: rec.intent === 'ABOUT' ? 'ABOUT' : 'SAFE_CHECK',
      }],
      knowledgeTopics: topics,
      retired: rec.status === 'retired',
    };
  }

  async function previewCreate(input) {
    const state = await loadState();
    const spec = validateCreate(input || {}, state);
    const fake = {
      id: spec.id, type: spec.type, title: spec.title, description: spec.description,
      caption: spec.caption, alt: spec.alt, previewUrl: spec.url,
      videoId: spec.videoId, embedUrl: spec.embedUrl, attribution: spec.attribution,
      sourcePageUrl: spec.sourcePageUrl, knowledge: [], status: 'active', intent: 'SAFE_CHECK',
    };
    const preview = customerPreview(fake);
    preview.proposedId = spec.id;
    preview.file = spec.file || null;
    if (spec.width) preview.dimensions = { width: spec.width, height: spec.height };
    return preview;
  }

  function knowledgePicker(q) {
    const list = knowledgeInspect.listKnowledge({ q: q || '' });
    return (list.records || []).slice(0, 40).map((r) => ({
      knowledgeId: r.knowledgeId, label: r.label, faultId: r.faultId, applianceFamily: r.applianceFamily,
    }));
  }

  function overlayOf(state) { return state; }

  return {
    loadState, inspectList, inspectOne, create, saveDraft, updateMetadata, replaceFile, discardDraft, publish, rollback, version,
    attachMapping, updateMapping, detachMapping, attachComponent, detachComponent,
    retire, restore, hardDelete, customerPreview, previewCreate, knowledgePicker, overlayOf,
  };
}

module.exports = {
  STATE_KEY, FILE_PREFIX, MAX_BYTES, MAX_DIMENSION, FAMILIES, ALLOWED_TYPES, CHANGE_LABELS,
  emptyState, slugId, safeFileName, validateCreate, inspectImage, createStore, err, adminView, changedFields,
  applyToCustomerMedia,
};

function applyToCustomerMedia(media, overlay) {
  if (!Array.isArray(media)) return [];
  if (!overlay) return media;
  return media.map((m) => {
    if (!m) return null;
    const id = m.id;
    const rec = id && overlay.identities && overlay.identities[id];
    if (rec && (rec.status === 'retired' || rec.removed)) return null;
    if (!rec || !rec.catalogue) return m;
    const cat = rec.catalogue;
    const next = Object.assign({}, m);
    if (cat.title) next.title = cat.title;
    if (cat.caption) { next.caption = cat.caption; next.description = cat.caption; }
    if (cat.alt) next.alt = cat.alt;
    if (cat.url && next.url) next.url = cat.url;
    return next;
  }).filter(Boolean);
}
