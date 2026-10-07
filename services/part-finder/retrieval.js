/**
 * In-Lambda knowledge retrieval for WhichPart diagnosis.
 *
 * Loads the precomputed, versioned knowledge index at cold start. At request
 * time: metadata-filter by appliance family (then make/platform where known),
 * embed the query via the local embedding model, cosine-rank, return a SMALL
 * high-quality set (default top 5). Falls back to lexical overlap scoring if the
 * embedding endpoint is unavailable, so retrieval never hard-fails the request.
 *
 * Facts (safety, error codes, compatibility, stock) do NOT come from here.
 */
const fs = require('fs');
const path = require('path');
const { canonFamily, familyScopeIsStrict, applyFuelFilter } = require('./identity.js');
const mediaEffective = require('./media-effective');

const EMBED_URL = process.env.EMBED_URL || process.env.LM_STUDIO_URL || 'http://localhost:1234';
const EMBED_MODEL = process.env.EMBED_MODEL || 'text-embedding-nomic-embed-text-v1.5';
const EMBED_TIMEOUT_MS = Number(process.env.EMBED_TIMEOUT_MS) || 4000;

let INDEX = { version: 'none', dims: 0, docs: [] };
try {
  INDEX = JSON.parse(
    fs.readFileSync(path.join(__dirname, 'knowledge', 'knowledge-index.json'), 'utf8'),
  );
} catch (e) {
  console.error('[retrieval] knowledge index not loaded:', e.message);
}

// Customer-visible SAFETY INFORMATION, keyed by knowledgeId ("appliance:faultId"). Loaded at cold
// start from a SEPARATE artifact that is NOT part of the retrieval index — so safety text can never
// influence retrieval similarity. Attached to a response purely by GROUNDED NODE IDENTITY, never by
// semantic match. Absence of a key => no safety information for that node.
let SAFETY_INFO = {};
try {
  const si = JSON.parse(
    fs.readFileSync(path.join(__dirname, 'knowledge', 'safety-information.json'), 'utf8'),
  );
  SAFETY_INFO = si.byKnowledgeId || {};
} catch (e) {
  console.error('[retrieval] safety-information not loaded:', e.message);
}

/**
 * Return the pre-written, evidence-backed safetyInformation for a grounded node, or null.
 * Lookup is by node identity (applianceFamily + faultId) — deterministic, not retrieval-driven.
 * The returned object is the stored record verbatim; callers MUST render it as-is (never via an LLM).
 */
function getSafetyInformation(applianceFamily, faultId) {
  if (!applianceFamily || !faultId) return null;
  return SAFETY_INFO[`${applianceFamily}:${faultId}`] || null;
}

// First-class NORMAL / EXPECTED behaviour knowledge. Loaded at cold start from a SEPARATE artifact
// that is deliberately NOT part of the retrieval vector index (mirrors safety-information.json /
// media-information.json) — normal-behaviour recognition is a deterministic, identity/cue-driven
// decision, never a fuzzy similarity match. matchNormalBehaviour() (in the orchestrator) consumes
// these records. Absence of the file => empty list => the model's own normalBehaviour flag still works.
let NORMAL_BEHAVIOUR = [];
try {
  const nb = JSON.parse(
    fs.readFileSync(path.join(__dirname, 'knowledge', 'normal-behaviour.json'), 'utf8'),
  );
  NORMAL_BEHAVIOUR = Array.isArray(nb.records) ? nb.records : [];
} catch (e) {
  console.error('[retrieval] normal-behaviour knowledge not loaded:', e.message);
}

/**
 * Return the full list of NORMAL-behaviour knowledge records (verbatim). Deterministic; not
 * retrieval-driven. The orchestrator's matchNormalBehaviour() applies the family/make/cue/veto
 * matching — this accessor just supplies the authored knowledge (single source of truth).
 */
function getNormalBehaviourRecords() {
  return NORMAL_BEHAVIOUR;
}

// Curated differential (likelyComponents) for a GROUNDED node, looked up by node identity from the
// full index — deterministic and independent of retrieval ranking. This lets the customer-facing
// suspect list come from the knowledge for the node we grounded to, even when the vector retrieval
// top-K mis-ranked (e.g. surfaced the wrong appliance). Absence => empty list.
const DOC_BY_ID = {};
for (const d of INDEX.docs || []) DOC_BY_ID[d.knowledgeId] = d;
function getLikelyComponents(applianceFamily, faultId) {
  if (!applianceFamily || !faultId) return [];
  const d = DOC_BY_ID[`${applianceFamily}:${faultId}`];
  return (d && Array.isArray(d.likelyComponents)) ? d.likelyComponents.slice() : [];
}

// The full authored knowledge record for a grounded fault (label, ranked likelyComponents,
// adviceBeforeReplacement, clarifyingQuestion, discriminators, checks). Returned read-only so the
// deterministic reply renderer can state the diagnostic conclusion / ranked model-independent
// differential / safe next step from TYPED knowledge instead of leaving it to the COMPOSE LLM.
function getKnowledgeRecord(applianceFamily, faultId) {
  if (!applianceFamily || !faultId) return null;
  const d = DOC_BY_ID[`${applianceFamily}:${faultId}`];
  if (!d) return null;
  return {
    knowledgeId: d.knowledgeId,
    label: d.label || null,
    outcome: d.outcome || null,
    likelyComponents: Array.isArray(d.likelyComponents) ? d.likelyComponents.slice() : [],
    adviceBeforeReplacement: Array.isArray(d.adviceBeforeReplacement) ? d.adviceBeforeReplacement.slice() : [],
    clarifyingQuestion: d.clarifyingQuestion || null,
    secondaryQuestion: d.secondaryQuestion || null,
    discriminators: Array.isArray(d.discriminators) ? d.discriminators.slice() : [],
    checks: Array.isArray(d.checks) ? d.checks.slice() : [],
  };
}

// ADMIN KNOWLEDGE OVERLAY (published knowledge only). The shipped index above is the baseline. Admin
// publish / rollback / archive writes LEARNING_BUCKET knowledge-admin/published.json:
//   { schema, version, docs: { [knowledgeId]: <index doc incl. text + vector + safetyInformation> }, archived: [ids] }
// Published docs replace their baseline doc by knowledgeId (or are added); archived ids leave the
// retrieval pool and the identity lookups. Drafts are never in this file. The overlay is validated
// as a whole (dims must match the shipped index) — a malformed overlay is rejected and the last
// good state (or the baseline) stays in use. Same 10s TTL / last-good stance as the media overlay.
const KNOWLEDGE_OVERLAY_KEY = 'knowledge-admin/published.json';
const KNOWLEDGE_OVERLAY_TTL_MS = 10000;
const BASE_INDEX = INDEX;
const BASE_DOCS = (INDEX.docs || []).slice();
const BASE_SAFETY = Object.assign({}, SAFETY_INFO);
let _knowledgeOverlay = { at: 0, applied: false, failed: false, inFlight: null, version: 0, updatedAt: null, docs: 0, archived: 0 };
let _knowledgeOverlayLoader = null;

function validateKnowledgeOverlay(ov) {
  if (!ov || typeof ov !== 'object' || Array.isArray(ov)) throw new Error('malformed-knowledge-overlay');
  const docs = ov.docs || {};
  if (typeof docs !== 'object' || Array.isArray(docs)) throw new Error('malformed-knowledge-overlay: docs');
  const dims = BASE_INDEX.dims || 0;
  Object.keys(docs).forEach((id) => {
    const d = docs[id];
    if (!d || d.knowledgeId !== id) throw new Error(`knowledge-overlay: id mismatch ${id}`);
    if (!d.applianceFamily || !d.faultId || `${d.applianceFamily}:${d.faultId}` !== id) throw new Error(`knowledge-overlay: identity ${id}`);
    if (typeof d.text !== 'string' || !d.text) throw new Error(`knowledge-overlay: text ${id}`);
    if (!Array.isArray(d.vector) || (dims && d.vector.length !== dims)) throw new Error(`knowledge-overlay: vector ${id}`);
  });
  if (ov.archived != null && !Array.isArray(ov.archived)) throw new Error('malformed-knowledge-overlay: archived');
  return { docs, archived: new Set(ov.archived || []), version: Number(ov.version) || 0, updatedAt: ov.updatedAt || null };
}

// Pure merge of the shipped baseline with a validated overlay (exported for tests).
function mergeKnowledgeOverlay(baseDocs, baseSafety, overlay) {
  if (!overlay) return { docs: baseDocs.slice(), safety: Object.assign({}, baseSafety) };
  const { docs: odocs, archived } = overlay;
  const out = [];
  const seen = new Set();
  for (const d of baseDocs) {
    seen.add(d.knowledgeId);
    if (archived.has(d.knowledgeId)) continue;
    out.push(odocs[d.knowledgeId] ? stripOverlayDoc(odocs[d.knowledgeId]) : d);
  }
  Object.keys(odocs).forEach((id) => {
    if (seen.has(id) || archived.has(id)) return;
    out.push(stripOverlayDoc(odocs[id]));
  });
  const safety = Object.assign({}, baseSafety);
  Object.keys(odocs).forEach((id) => {
    if (odocs[id].safetyInformation) safety[id] = odocs[id].safetyInformation;
    else delete safety[id];
  });
  return { docs: out, safety };
}
function stripOverlayDoc(d) {
  // Same shape as a shipped index doc: no customer safety / admin content in the retrieval pool.
  const { safetyInformation, content, publishedAt, publishedBy, ...rest } = d;
  return rest;
}

function applyKnowledgeOverlay(overlay) {
  const merged = mergeKnowledgeOverlay(BASE_DOCS, BASE_SAFETY, overlay);
  INDEX = Object.assign({}, BASE_INDEX, { docs: merged.docs, count: merged.docs.length });
  Object.keys(DOC_BY_ID).forEach((k) => { delete DOC_BY_ID[k]; });
  for (const d of merged.docs) DOC_BY_ID[d.knowledgeId] = d;
  SAFETY_INFO = merged.safety;
}

function setKnowledgeOverlayLoader(fn) { _knowledgeOverlayLoader = fn; }
function resetKnowledgeOverlayCache() {
  _knowledgeOverlay = { at: 0, applied: false, failed: false, inFlight: null, version: 0, updatedAt: null, docs: 0, archived: 0 };
  applyKnowledgeOverlay(null);
}

async function defaultFetchKnowledgeOverlay() {
  const bucket = process.env.LEARNING_BUCKET || '';
  if (!bucket) return null;
  const { S3Client, GetObjectCommand } = require('@aws-sdk/client-s3');
  if (!defaultFetchKnowledgeOverlay._s3) {
    defaultFetchKnowledgeOverlay._s3 = new S3Client({ region: process.env.AWS_REGION || 'eu-west-1' });
  }
  const res = await defaultFetchKnowledgeOverlay._s3.send(new GetObjectCommand({ Bucket: bucket, Key: KNOWLEDGE_OVERLAY_KEY }));
  const chunks = [];
  for await (const chunk of res.Body) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : null;
}

function isMissingObject(e) {
  const name = e && (e.name || e.Code || e.code);
  const status = e && e.$metadata && e.$metadata.httpStatusCode;
  return name === 'NoSuchKey' || name === 'NotFound' || status === 404
    || /NoSuchKey|specified key does not exist/i.test(String(e && e.message || e));
}

async function ensureKnowledgeOverlay(opts) {
  const now = (opts && opts.now) || Date.now();
  const ttl = (opts && opts.ttlMs != null) ? opts.ttlMs : KNOWLEDGE_OVERLAY_TTL_MS;
  if (_knowledgeOverlay.applied && (now - _knowledgeOverlay.at) < ttl) return _knowledgeOverlay;
  if (_knowledgeOverlay.inFlight) return _knowledgeOverlay.inFlight;
  _knowledgeOverlay.inFlight = (async () => {
    try {
      const loader = _knowledgeOverlayLoader || defaultFetchKnowledgeOverlay;
      const raw = await loader();
      const ov = raw ? validateKnowledgeOverlay(raw) : null;
      applyKnowledgeOverlay(ov);
      _knowledgeOverlay = {
        at: now, applied: true, failed: false, inFlight: null,
        version: ov ? ov.version : 0, updatedAt: ov ? ov.updatedAt : null,
        docs: ov ? Object.keys(ov.docs).length : 0, archived: ov ? ov.archived.size : 0,
      };
    } catch (e) {
      if (isMissingObject(e)) {
        applyKnowledgeOverlay(null);
        _knowledgeOverlay = { at: now, applied: true, failed: false, inFlight: null, version: 0, updatedAt: null, docs: 0, archived: 0 };
      } else {
        // Keep the last good overlay (or the baseline when none was ever applied).
        console.error('[retrieval] knowledge overlay load failed:', e && e.message || e);
        if (!_knowledgeOverlay.applied) applyKnowledgeOverlay(null);
        _knowledgeOverlay.at = now;
        _knowledgeOverlay.failed = true;
        _knowledgeOverlay.applied = true;
        _knowledgeOverlay.inFlight = null;
      }
    }
    return _knowledgeOverlay;
  })();
  try {
    return await _knowledgeOverlay.inFlight;
  } finally {
    if (_knowledgeOverlay.inFlight) _knowledgeOverlay.inFlight = null;
  }
}

function getKnowledgeOverlayCache() {
  const o = _knowledgeOverlay;
  // 'active' = an admin overlay object was loaded (even if it currently overrides nothing).
  const state = o.failed ? 'unavailable' : (o.version > 0 ? 'active' : 'none');
  return { state, version: o.version || 0, updatedAt: o.updatedAt || null, docs: o.docs || 0, archived: o.archived || 0, at: o.at || 0 };
}

// Customer EXPLANATORY MEDIA. Loaded from a SEPARATE artifact (not the retrieval index) so it can
// never influence retrieval similarity. Attached by grounded IDENTITY only:
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
  console.error('[retrieval] media-information not loaded:', e.message);
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
        console.error('[retrieval] media overlay load failed:', e && e.message || e);
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

// Canonical COMPONENT identity for deterministic component-keyed media lookup. Pure, no fuzzy
// matching: lower-case, drop parenthetical notes, collapse any run of non-alphanumerics to a single
// hyphen. e.g. "Fan Oven Element" -> "fan-oven-element", "inlet valve (tap valve)" -> "inlet-valve".
// This is the SINGLE source of truth for the key form — the build (build-knowledge.mjs) imports and
// uses this exact function to canonicalise authored component keys, so source and runtime never drift.
const canonicalComponent = (s) => String(s || '')
  .toLowerCase()
  .replace(/\([^)]*\)/g, ' ')
  .replace(/[^a-z0-9]+/g, ' ')
  .trim()
  .replace(/\s+/g, '-');

// Explanatory-media INTENT contract (smallest first-class set):
//   SAFE_CHECK — customer-safe instructional/check media for an already-grounded diagnosis (default).
//   ABOUT      — identification/location/explanation ("this is the component / where it is"); NOT a
//                DIY repair instruction. The ONLY intent under which IDENTIFICATION_ONLY media may be
//                shown to a customer.
const MEDIA_INTENTS = new Set(['SAFE_CHECK', 'ABOUT']);
const mediaIntent = (m) => (MEDIA_INTENTS.has(m && m.intent) ? m.intent : 'SAFE_CHECK');

/**
 * Return the customer-facing EXPLANATORY media for an ALREADY-grounded diagnosis. This is a
 * DETERMINISTIC, POST-diagnosis presentation choice — it never influences diagnosis, retrieval,
 * routing, parts, fit or the safety-stop, and it is keyed purely by grounded IDENTITY (never
 * LLM/retrieval/prose):
 *   A. NODE identity      — MEDIA_INFO[`${family}:${faultId}`]
 *   B. COMPONENT identity — MEDIA_BY_COMPONENT[`${family}:${canonicalComponent(name)}`] for each
 *      already-grounded component name in ctx.components (the node-curated differential). This lets
 *      an existing authored asset attach to a grounded component even when the old fault-key
 *      architecture had no node entry for it.
 * Node + component candidates are merged (deduped by id), then ranked/gated by selectMedia. Passing
 * no ctx.components preserves the original node-only behaviour exactly (backward compatible).
 *
 * Honesty + safety gates (enforced in selectMedia):
 *   - TECHNICIAN_ONLY / REJECT media is NEVER returned to a customer (catalogued only).
 *   - IDENTIFICATION_ONLY media is returned ONLY under intent ABOUT (identification/explanation).
 *   - applicability: GENERIC always; MAKE_SPECIFIC needs a known make; MODEL_SPECIFIC needs a model.
 *   - a brand-matched item (makes[]) is shown ONLY for a matching make — never the wrong brand.
 */
function getMediaInformation(applianceFamily, faultId, ctx = {}) {
  if (!applianceFamily) return [];
  const nodeItems = (faultId && MEDIA_INFO[`${applianceFamily}:${faultId}`]) || [];
  const seen = new Set(nodeItems.map((m) => m.id));
  const componentItems = [];
  const comps = Array.isArray(ctx.components) ? ctx.components : [];
  for (const name of comps) {
    const key = `${applianceFamily}:${canonicalComponent(name)}`;
    const list = MEDIA_BY_COMPONENT[key];
    if (!Array.isArray(list)) continue;
    for (const it of list) {
      if (it && !seen.has(it.id)) { seen.add(it.id); componentItems.push(it); }
    }
  }
  return selectMedia(nodeItems.concat(componentItems), ctx);
}

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

function cosine(a, b) {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na && nb ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
}

async function embedQuery(text) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), EMBED_TIMEOUT_MS);
  try {
    const res = await fetch(`${EMBED_URL}/v1/embeddings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: EMBED_MODEL, input: text }),
      signal: ctrl.signal,
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data?.data?.[0]?.embedding || null;
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

function lexicalScore(queryTokens, doc) {
  const hay = (doc.text || '').toLowerCase();
  let hits = 0;
  for (const tok of queryTokens) if (tok.length > 2 && hay.includes(tok)) hits++;
  return queryTokens.length ? hits / queryTokens.length : 0;
}

// Common words that carry no diagnostic signal — excluded from the keyword boost
// so it triggers on discriminating terms ("pump", "leak", "drawer"), not filler.
const STOP = new Set([
  'the', 'and', 'but', 'for', 'not', 'wont', 'cant', 'doesnt', 'with', 'when',
  'from', 'that', 'this', 'have', 'has', 'was', 'are', 'its', 'you', 'get',
  'out', 'off', 'all', 'any', 'now', 'still', 'just', 'been', 'does', 'wont',
  'machine', 'appliance',
]);

// Lexical exact-match BOOSTER layered on top of the cosine score. A small
// embedding model can rank a doc that literally contains the customer's word
// (e.g. "pump", "drawer") below a semantically-fuzzy neighbour. We nudge exact
// hits on the query-facing fields (label + symptoms, NOT the technical prose) up
// the ranking. Capped small so semantics still lead; codes stay deterministic
// upstream, so this only helps component/symptom words.
function keywordBoost(queryTokens, doc) {
  const hay = `${doc.label || ''} ${(doc.symptoms || []).join(' ')}`.toLowerCase();
  let hits = 0;
  for (const tok of queryTokens) {
    if (tok.length >= 3 && !STOP.has(tok) && hay.includes(tok)) hits++;
  }
  return Math.min(0.15, 0.04 * hits);
}

/**
 * @param {object} ctx  { applianceFamily, make, platform }
 * @param {string} query  raw customer symptom text
 * @param {number} k  max docs to return
 * @returns {Promise<{docs, mode, latencyMs, indexVersion}>}
 */
async function retrieve(ctx = {}, query = '', k = 5) {
  const t0 = Date.now();
  let pool = INDEX.docs || [];
  if (!ctx.applianceFamily) {
    return { docs: [], mode: 'unresolved-family', latencyMs: Date.now() - t0, indexVersion: INDEX.version };
  }
  const strict = familyScopeIsStrict(ctx.familyEstablished || ctx.familyState);
  const filtered = applyFamilyFilter(pool, ctx.applianceFamily, strict || ctx.familyEstablished || ctx.familyState || false);
  if (strict && !filtered.length) {
    return { docs: [], mode: 'empty', latencyMs: Date.now() - t0, indexVersion: INDEX.version };
  }
  pool = filtered.length ? filtered : pool;
  if (!pool.length) {
    return { docs: [], mode: 'empty', latencyMs: Date.now() - t0, indexVersion: INDEX.version };
  }

  let mode = 'semantic';
  let scored;
  const qvec = await embedQuery(query);
  if (qvec && qvec.length === INDEX.dims) {
    const qtoks = query.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
    scored = pool.map((d) => ({ doc: d, score: cosine(qvec, d.vector) + keywordBoost(qtoks, d) }));
  } else {
    mode = 'lexical';
    const toks = query.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
    scored = pool.map((d) => ({ doc: d, score: lexicalScore(toks, d) }));
  }
  scored.sort((a, b) => b.score - a.score);
  const top = scored.slice(0, k);

  return {
    docs: top.map((s) => ({
      knowledgeId: s.doc.knowledgeId,
      applianceFamily: s.doc.applianceFamily,
      faultId: s.doc.faultId,
      label: s.doc.label,
      outcome: s.doc.outcome || 'PART_ROUTING',
      likelyComponents: s.doc.likelyComponents,
      discriminators: s.doc.discriminators,
      clarifyingQuestion: s.doc.clarifyingQuestion,
      text: s.doc.text,
      score: Math.round(s.score * 1000) / 1000,
    })),
    mode,
    latencyMs: Date.now() - t0,
    indexVersion: INDEX.version,
  };
}

/**
 * Scope retrieved docs to a conversation family.
 * WORKING and ESTABLISHED identity never fall back across families.
 * Unestablished guesses may fall back to the unfiltered pool.
 */
function applyFamilyFilter(docs, family, familyEstablishedOrState) {
  const list = docs || [];
  const want = canonFamily(family);
  if (!want) return list;
  const filtered = list.filter((d) => canonFamily(d && d.applianceFamily) === want);
  if (filtered.length) return filtered;
  if (familyScopeIsStrict(familyEstablishedOrState)) return [];
  return list;
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

/** Read-only facts about the already-loaded RAG index. Never returns vectors. */
function describeLoadedIndex() {
  const docs = INDEX.docs || [];
  const version = INDEX.version && INDEX.version !== 'none' ? INDEX.version : null;
  const loaded = !!(version && docs.length);
  const faultIds = new Set();
  const families = new Set();
  for (const d of docs) {
    if (d && d.faultId) faultIds.add(d.faultId);
    if (d && d.applianceFamily) families.add(d.applianceFamily);
  }
  const indexedRecords = INDEX.count != null ? INDEX.count : docs.length;
  return {
    loaded,
    records: docs.length,
    faultIds: faultIds.size,
    families: families.size,
    version,
    indexedRecords,
    indexVersion: version,
    embeddingModel: INDEX.embedModel || null,
    dims: INDEX.dims || null,
    builtAt: INDEX.builtAt || null,
    mismatch: INDEX.count != null && INDEX.count !== docs.length,
  };
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
  retrieve, getSafetyInformation, getMediaInformation, getNormalBehaviourRecords, selectMedia,
  mediaFingerprint, canonicalComponent, getLikelyComponents, getKnowledgeRecord, applyFamilyFilter, applyFuelFilter,
  ensureMediaOverlay, applyMediaOverlayState, getEffectiveMediaJoin, setMediaOverlayLoader,
  resetMediaOverlayCache, MEDIA_OVERLAY_TTL_MS, INDEX_VERSION: INDEX.version,
  ensureKnowledgeOverlay, setKnowledgeOverlayLoader, resetKnowledgeOverlayCache, getKnowledgeOverlayCache,
  mergeKnowledgeOverlay, validateKnowledgeOverlay, applyKnowledgeOverlay, KNOWLEDGE_OVERLAY_KEY, KNOWLEDGE_OVERLAY_TTL_MS,
  describeLoadedIndex, describeMediaBaseline, getMediaOverlayCache, countJoinIdentities, overlayPresent,
};
