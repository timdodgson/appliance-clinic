/**
 * Customer explanatory media for canonical NextActions: the shipped mappings (knowledge/media-information.json) merged
 * with the durable Admin overlay (S3 media-admin/state.json, through media-effective.mergeJoin), and the selection of
 * the items a step shows. Attached by grounded identity only, never by similarity.
 */
const fs = require('fs');
const path = require('path');
const mediaEffective = require('./media-effective');

// Customer EXPLANATORY MEDIA. Loaded from a SEPARATE artifact so it never depends on
// wording. Attached by grounded IDENTITY only:
//   - byKnowledgeId: keyed by node identity  "applianceFamily:faultId"
//   - byComponent:   keyed by grounded component identity  "applianceFamily:<canonical component>"
// Absence of a key => no media for that node/component.
//
// Shipped JSON is the baseline. The durable admin overlay (S3 media-admin/state.json) is merged
// through media-effective.mergeJoin so live diagnosis uses the same effective mappings as Admin.
const SHIPPED_JOIN = { byKnowledgeId: {}, byComponent: {} };
try {
  const mi = JSON.parse(
    fs.readFileSync(path.join(__dirname, 'knowledge', 'media-information.json'), 'utf8'),
  );
  SHIPPED_JOIN.byKnowledgeId = mi.byKnowledgeId || {};
  SHIPPED_JOIN.byComponent = mi.byComponent || {};
} catch (e) {
  console.error('[media] media-information not loaded:', e.message);
}

let MEDIA_INFO = SHIPPED_JOIN.byKnowledgeId;
let MEDIA_BY_COMPONENT = SHIPPED_JOIN.byComponent;

const MEDIA_OVERLAY_TTL_MS = mediaEffective.OVERLAY_TTL_MS;
let _mediaOverlay = { at: 0, state: null, applied: false, inFlight: null, failed: false };
let _mediaOverlayLoader = null;

function applyMediaOverlayState(overlay) {
  const eff = mediaEffective.mergeJoin(SHIPPED_JOIN, overlay);
  MEDIA_INFO = eff.byKnowledgeId;
  MEDIA_BY_COMPONENT = eff.byComponent;
}

function getEffectiveMediaJoin() {
  return { byKnowledgeId: MEDIA_INFO, byComponent: MEDIA_BY_COMPONENT };
}

// Test seams: replace the S3 overlay loader, and clear the cached overlay.
function setMediaOverlayLoader(fn) {
  _mediaOverlayLoader = fn;
}

function resetMediaOverlayCache() {
  _mediaOverlay = { at: 0, state: null, applied: false, inFlight: null, failed: false };
  applyMediaOverlayState(null);
}

async function defaultFetchMediaOverlay() {
  const bucket = process.env.LEARNING_BUCKET || '';
  if (!bucket) return null;
  const { S3Client, GetObjectCommand } = require('@aws-sdk/client-s3');
  if (!defaultFetchMediaOverlay._s3) {
    defaultFetchMediaOverlay._s3 = new S3Client({ region: process.env.AWS_REGION || 'eu-west-1' });
  }
  const res = await defaultFetchMediaOverlay._s3.send(new GetObjectCommand({
    Bucket: bucket, Key: mediaEffective.STATE_KEY,
  }));
  const chunks = [];
  for await (const chunk of res.Body) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return null;
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('malformed-overlay');
  }
  return parsed;
}

async function ensureMediaOverlay(opts) {
  const now = (opts && opts.now) || Date.now();
  const ttl = (opts && opts.ttlMs != null) ? opts.ttlMs : MEDIA_OVERLAY_TTL_MS;
  if (_mediaOverlay.applied && (now - _mediaOverlay.at) < ttl) {
    return _mediaOverlay;
  }
  if (_mediaOverlay.inFlight) return _mediaOverlay.inFlight;
  _mediaOverlay.inFlight = (async () => {
    try {
      const loader = _mediaOverlayLoader || defaultFetchMediaOverlay;
      const state = await loader();
      applyMediaOverlayState(state);
      _mediaOverlay = { at: now, state: state || null, applied: true, inFlight: null, failed: false };
    } catch (e) {
      const name = e && (e.name || e.Code || e.code);
      const status = e && e.$metadata && e.$metadata.httpStatusCode;
      const missing = name === 'NoSuchKey' || name === 'NotFound' || name === 'NoSuchKeyException'
        || status === 404
        || /NoSuchKey|specified key does not exist/i.test(String(e && e.message || e));
      if (missing) {
        applyMediaOverlayState(null);
        _mediaOverlay = { at: now, state: null, applied: true, inFlight: null, failed: false };
      } else {
        console.error('[media] media overlay load failed:', e && e.message || e);
        if (!_mediaOverlay.applied) applyMediaOverlayState(null);
        _mediaOverlay.at = now;
        _mediaOverlay.failed = true;
        _mediaOverlay.inFlight = null;
        _mediaOverlay.applied = true;
      }
    }
    return _mediaOverlay;
  })();
  try {
    return await _mediaOverlay.inFlight;
  } finally {
    if (_mediaOverlay.inFlight) _mediaOverlay.inFlight = null;
  }
}

// Canonical normalisers for deterministic media matching (mirror the engine's own norms: brand is
// case/space/punctuation-insensitive; error codes are upper-cased alnum). Pure, no I/O.
const normMake = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const normCode = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

// Explanatory-media INTENT contract (smallest first-class set):
//   SAFE_CHECK — customer-safe instructional/check media for an already-grounded diagnosis (default).
//   ABOUT      — identification/location/explanation ("this is the component / where it is"); NOT a
//                DIY repair instruction. The ONLY intent under which IDENTIFICATION_ONLY media may be
//                shown to a customer.
const MEDIA_INTENTS = new Set(['SAFE_CHECK', 'ABOUT']);
const mediaIntent = (m) => (MEDIA_INTENTS.has(m && m.intent) ? m.intent : 'SAFE_CHECK');

// Pure, deterministic media selection over a merged media list (exported for unit tests). Given the
// customer's known make/model/errorCode/context, return the customer-facing media: at most one video
// (the single best), plus the single best eligible image. Technician-only/reject media is never
// returned; identification-only media is returned only under the ABOUT intent. No I/O.
function mediaFingerprint(m) {
  if (!m || typeof m !== 'object') return '';
  if (m.id) return `id:${m.id}`;
  if (m.videoId) return `vid:${m.videoId}`;
  const url = m.url || m.asset || m.embedUrl;
  if (url) return `url:${url}`;
  if (m.title) return `title:${String(m.title).toLowerCase().trim()}`;
  return '';
}

function selectMedia(items, { make = null, model = null, errorCode = null, concepts = [],
  alreadyShown = [], nextAction = null, repeatRequested = false } = {}) {
  if (!Array.isArray(items) || !items.length) return [];
  const mk = normMake(make);
  const code = normCode(errorCode);
  const ctx = Array.isArray(concepts) ? concepts.map((c) => String(c || '').toLowerCase()).filter(Boolean) : [];
  const hasCtx = ctx.length > 0;
  const itemConcepts = (m) => (Array.isArray(m.concepts) ? m.concepts.map((c) => String(c || '').toLowerCase()) : []);
  const conceptMatch = (m) => itemConcepts(m).some((c) => ctx.includes(c));

  const eligible = items.filter((m) => {
    // SAFETY / HONESTY class gate:
    //   TECHNICIAN_ONLY, REJECT     -> never customer-visible.
    //   IDENTIFICATION_ONLY         -> only as ABOUT (identification/explanation), never as a check.
    //   CUSTOMER_SAFE (or absent)   -> allowed under any intent.
    const cls = m.safetyClass || 'CUSTOMER_SAFE';
    if (cls === 'TECHNICIAN_ONLY' || cls === 'REJECT') return false;
    if (cls === 'IDENTIFICATION_ONLY' && mediaIntent(m) !== 'ABOUT') return false;
    // Applicability honesty gate.
    if (m.applicability === 'MODEL_SPECIFIC' && !model) return false;
    if (m.applicability === 'MAKE_SPECIFIC' && !make) return false;
    // Brand-matched media only shows for a matching make (never the wrong brand).
    if (Array.isArray(m.makes) && m.makes.length) {
      if (!mk || !m.makes.some((x) => normMake(x) === mk)) return false;
    }
    // CONTEXT gate: a concept-tagged item shows ONLY when the derived engineering context matches
    // one of its concepts. Concept-less items are context-agnostic and stay eligible. This is what
    // keeps the household-waste/backflow graphic off an ordinary blocked drain, and keeps the
    // appliance pump/filter media off a household-plumbing backflow.
    const ic = itemConcepts(m);
    if (ic.length) {
      if (!hasCtx || !conceptMatch(m)) return false;
    }
    return true;
  });

  const shown = new Set((Array.isArray(alreadyShown) ? alreadyShown : []).map(mediaFingerprint).filter(Boolean));
  const progressed = eligible.filter((m) => {
    if (nextAction === 'identification' && mediaIntent(m) !== 'ABOUT') return false;
    if (nextAction === 'discriminator' && mediaIntent(m) === 'SAFE_CHECK') return false;
    if (Array.isArray(m.errorCodes) && m.errorCodes.length) {
      if (!code || !m.errorCodes.some((x) => normCode(x) === code)) return false;
    }
    if (!repeatRequested) {
      const fp = mediaFingerprint(m);
      if (fp && shown.has(fp)) return false;
    }
    return true;
  });

  const specificity = (a) => (a === 'MODEL_SPECIFIC' ? 2 : a === 'MAKE_SPECIFIC' ? 1 : 0);
  // Ordering: NODE RELEVANCE (already, by node identity) -> SAFETY (filtered above) -> CONTEXT ->
  // MAKE/MODEL/ERROR CODE -> SPECIFICITY -> PRIORITY. Context outweighs make/model/code/specificity
  // so a make-specific item about the WRONG engineering context can never beat the right one.
  const score = (m) => {
    let s = 0;
    if (conceptMatch(m)) s += 1000;
    if (Array.isArray(m.makes) && mk && m.makes.some((x) => normMake(x) === mk)) s += 100;
    if (Array.isArray(m.errorCodes) && code && m.errorCodes.some((x) => normCode(x) === code)) s += 50;
    s += specificity(m.applicability) * 10;
    s += (typeof m.priority === 'number' ? m.priority : 0);
    return s;
  };
  const rank = (a, b) => score(b) - score(a) || String(a.id).localeCompare(String(b.id));

  const images = progressed.filter((m) => m.type === 'IMAGE' || m.type === 'DIAGRAM').sort(rank);
  const videos = progressed.filter((m) => m.type === 'VIDEO').sort(rank);
  // The customer sees AT MOST one image + one video — the single best relevant of each.
  const out = [];
  if (images[0]) out.push(images[0]);
  if (videos[0]) out.push(videos[0]);
  return out;
}

function countJoinIdentities(join) {
  const ids = new Set();
  function walk(map) {
    Object.keys(map || {}).forEach((k) => {
      (map[k] || []).forEach((m) => { if (m && m.id) ids.add(m.id); });
    });
  }
  walk(join && join.byKnowledgeId);
  walk(join && join.byComponent);
  return ids.size;
}

function overlayPresent(state) {
  if (!state || typeof state !== 'object') return false;
  return Object.keys(state.identities || {}).length
    + Object.keys(state.byKnowledgeId || {}).length
    + Object.keys(state.byComponent || {}).length
    + Object.keys(state.detachedByKnowledgeId || {}).length
    + Object.keys(state.detachedByComponent || {}).length > 0;
}

function describeMediaBaseline() {
  const knowledgeKeys = Object.keys(SHIPPED_JOIN.byKnowledgeId || {}).length;
  const componentKeys = Object.keys(SHIPPED_JOIN.byComponent || {}).length;
  return {
    loaded: knowledgeKeys + componentKeys > 0,
    knowledgeKeys,
    componentKeys,
    identityCount: countJoinIdentities(SHIPPED_JOIN),
  };
}

function getMediaOverlayCache() {
  return {
    at: _mediaOverlay.at,
    applied: _mediaOverlay.applied,
    failed: !!_mediaOverlay.failed,
    overlayPresent: overlayPresent(_mediaOverlay.state),
    updatedAt: (_mediaOverlay.state && _mediaOverlay.state.updatedAt) || null,
    version: (_mediaOverlay.state && _mediaOverlay.state.version) || null,
  };
}

module.exports = {
  selectMedia,
  ensureMediaOverlay,
  getEffectiveMediaJoin,
  MEDIA_OVERLAY_TTL_MS,
  describeMediaBaseline,
  getMediaOverlayCache,
  countJoinIdentities,
  setMediaOverlayLoader,
  resetMediaOverlayCache,
};
