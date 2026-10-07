'use strict';
/**
 * Inspector over the deployed diagnostic knowledge artifacts (the shipped baseline), optionally
 * merged with the Admin knowledge view (published overlay, drafts, archive state) supplied by
 * knowledge-admin.js via setAdminView(). Never mutates docs, indexes, embeddings or retrieval.
 */
const fs = require('fs');
const path = require('path');

const FAMILIES = [
  'washing-machine', 'washer-dryer', 'tumble-dryer', 'dishwasher',
  'oven-cooker', 'hobs', 'fridge-freezer', 'microwave', 'vacuum',
];

function resolveDir() {
  const bundled = path.join(__dirname, 'knowledge-inspect');
  if (fs.existsSync(path.join(bundled, 'knowledge-docs.json'))) return bundled;
  const source = path.join(__dirname, '..', 'part-finder', 'knowledge');
  if (fs.existsSync(path.join(source, 'knowledge-docs.json'))) return source;
  return bundled;
}

function readJson(dir, name) {
  const p = path.join(dir, name);
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function loadIndexMeta(dir) {
  const meta = readJson(dir, 'index-meta.json');
  if (meta) return meta;
  const idx = readJson(dir, 'knowledge-index.json');
  if (!idx) return null;
  return {
    version: idx.version || null,
    embedModel: idx.embedModel || null,
    dims: idx.dims || null,
    builtAt: idx.builtAt || null,
    count: idx.count || ((idx.docs && idx.docs.length) || 0),
    knowledgeIds: (idx.docs || []).map((d) => d.knowledgeId).filter(Boolean),
  };
}

let _cache = null;
function loadCorpus() {
  if (_cache) return _cache;
  const dir = resolveDir();
  const docsFile = readJson(dir, 'knowledge-docs.json') || { version: null, count: 0, docs: [] };
  const safetyFile = readJson(dir, 'safety-information.json') || { byKnowledgeId: {} };
  const mediaFile = readJson(dir, 'media-information.json') || { byKnowledgeId: {}, byComponent: {} };
  const indexMeta = loadIndexMeta(dir);
  const indexed = new Set((indexMeta && indexMeta.knowledgeIds) || []);
  _cache = {
    dir,
    docsVersion: docsFile.version || null,
    docs: docsFile.docs || [],
    safetyById: safetyFile.byKnowledgeId || {},
    mediaById: mediaFile.byKnowledgeId || {},
    mediaByComponent: mediaFile.byComponent || {},
    indexMeta,
    indexed,
  };
  return _cache;
}

function resetCache() { _cache = null; _admin = null; _media = null; }

// ---- Effective Media view (what live diagnosis uses) ---------------------------------------------
// Set by the BFF from the Media overlay through the SAME merge part-finder uses (media-effective.js):
//   live = mergeJoin(shipped, overlay)                      → active attachments (drafts never included)
//   all  = mergeJoin(shipped, overlay, {includeRetired})    → also archived items still attached
// Without a view (unit contexts / overlay never loaded) the shipped join is used, exactly as before.
let _media = null;
function setMediaView(view) { _media = view || null; }
function mediaView() { return _media; }

function mediaFor(id, doc, corpus) {
  if (!_media) {
    return compactMedia(corpus.mediaById[id] || doc.mediaInformation || [])
      .map((m) => Object.assign(m, { status: 'active', liveForDiagnosis: true }));
  }
  const live = ((_media.live && _media.live.byKnowledgeId) || {})[id] || [];
  const all = ((_media.all && _media.all.byKnowledgeId) || {})[id] || live;
  const liveIds = new Set(live.map((m) => m && m.id));
  return compactMedia(all).map((m) => Object.assign(m, liveIds.has(m.id)
    ? { status: 'active', liveForDiagnosis: true }
    : { status: 'archived', liveForDiagnosis: false }));
}

// ---- Admin overlay view (published overlay docs, drafts, archive state) ----------------------
// Shape: { overlayVersion, published: {id: doc}, archived: [id], records: {id: {state, stateLabel,
// draftPending, archived, currentVersion, liveVersionLabel, revision, draft}} }
let _admin = null;
function setAdminView(view) { _admin = view || null; }
function adminView() { return _admin; }

function statusOf(id) {
  const rec = _admin && _admin.records && _admin.records[id];
  if (rec) {
    return {
      state: rec.state, stateLabel: rec.stateLabel, draftPending: !!rec.draftPending,
      archived: !!rec.archived, currentVersion: rec.currentVersion || 0,
      liveVersionLabel: rec.liveVersionLabel || null, revision: rec.revision || 0,
    };
  }
  return {
    state: 'published', stateLabel: 'Published', draftPending: false, archived: false,
    currentVersion: 0, liveVersionLabel: 'Baseline (shipped)', revision: 0,
  };
}

// Effective records: baseline docs (replaced by their published overlay doc where one exists),
// plus overlay-only published docs, plus never-published drafts (shown from their draft content).
function effective() {
  const corpus = loadCorpus();
  const published = (_admin && _admin.published) || {};
  const records = (_admin && _admin.records) || {};
  const out = [];
  const seen = new Set();
  for (const d of corpus.docs) {
    seen.add(d.knowledgeId);
    const pub = published[d.knowledgeId];
    out.push(pub ? { doc: pub, source: 'overlay' } : { doc: d, source: 'baseline' });
  }
  Object.keys(published).forEach((id) => {
    if (seen.has(id)) return;
    seen.add(id);
    out.push({ doc: published[id], source: 'overlay' });
  });
  Object.keys(records).forEach((id) => {
    if (seen.has(id)) return;
    const r = records[id];
    if (!r || !r.draft) return;
    seen.add(id);
    out.push({ doc: r.draft, source: 'draft' });
  });
  return out;
}

function safetyFor(entry, corpus) {
  if (entry.source === 'baseline') return corpus.safetyById[entry.doc.knowledgeId] || null;
  return entry.doc.safetyInformation || null;
}
function indexedFor(entry, corpus) {
  if (entry.source === 'draft') return false;
  const st = statusOf(entry.doc.knowledgeId);
  if (st.archived) return false;
  if (entry.source === 'overlay') return true;
  return corpus.indexed.size ? corpus.indexed.has(entry.doc.knowledgeId) : null;
}

function familyLabel(family) {
  return String(family || '').replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

function provenanceLabel(value) {
  if (value == null || value === '') return null;
  if (typeof value === 'string') {
    if (value === 'engineer') return 'Engineer-authored domain knowledge';
    if (value === 'catalogue') return 'Fault catalogue';
    return value;
  }
  return null;
}

function compactMedia(items) {
  return (items || []).map((m) => ({
    id: m.id || null,
    type: m.type || null,
    title: m.title || m.id || null,
    relatedCheck: m.relatedCheck || null,
    asset: m.asset || null,
    videoId: m.videoId || null,
    makes: m.makes || null,
    errorCodes: m.errorCodes || null,
    caption: m.caption || m.description || null,
    alt: m.alt || null,
    attribution: m.attribution || null,
  }));
}

function relatedTopics(doc, corpus) {
  return (doc.alternatives || []).map((alt) => {
    const id = String(alt).indexOf(':') !== -1 ? alt : (doc.applianceFamily + ':' + alt);
    const found = (corpus.effectiveDocs || corpus.docs || []).find((d) => d.knowledgeId === id
      || (d.faultId === alt && d.applianceFamily === doc.applianceFamily));
    return {
      knowledgeId: found ? found.knowledgeId : id,
      label: found ? found.label : alt,
      available: !!found,
    };
  });
}

function extraSearchBits(doc, corpus, safetyOverride) {
  const bits = [];
  const safety = safetyOverride !== undefined ? safetyOverride : corpus.safetyById[doc.knowledgeId];
  if (safety) bits.push(safety.classification, safety.hazard, safety.text);
  const media = mediaFor(doc.knowledgeId, doc, corpus);
  (media || []).forEach((m) => {
    bits.push(m.title, m.id, m.relatedCheck, (m.errorCodes || []).join('\n'), (m.makes || []).join('\n'));
  });
  return bits.filter(Boolean);
}

function summarise(doc, corpus, entry) {
  const id = doc.knowledgeId;
  const safety = entry ? safetyFor(entry, corpus) : (corpus.safetyById[id] || null);
  const status = statusOf(id);
  const allMedia = mediaFor(id, doc, corpus);
  const media = allMedia.filter((m) => m.liveForDiagnosis);
  const components = doc.components || [];
  const likely = doc.likelyComponents || [];
  return {
    knowledgeId: id,
    applianceFamily: doc.applianceFamily,
    faultId: doc.faultId,
    label: doc.label,
    outcome: doc.outcome || null,
    provenance: typeof doc.provenance === 'string' ? doc.provenance : null,
    provenanceLabel: provenanceLabel(doc.provenance),
    symptomPreview: (doc.symptoms || []).slice(0, 4),
    symptomCount: (doc.symptoms || []).length,
    likelyComponents: likely.slice(0, 4),
    componentCount: Math.max(likely.length, components.length),
    hasSafety: !!safety,
    safetyClassification: safety && safety.classification ? safety.classification : null,
    hasMedia: media.length > 0,
    mediaCount: media.length,
    archivedMediaCount: allMedia.length - media.length,
    hasAdvice: !!(doc.adviceBeforeReplacement && doc.adviceBeforeReplacement.length),
    hasDiscriminators: !!(doc.discriminators && doc.discriminators.length),
    hasClarifyingQuestion: !!doc.clarifyingQuestion,
    hasComponents: components.length > 0,
    indexed: entry ? indexedFor(entry, corpus) : (corpus.indexed.size ? corpus.indexed.has(id) : null),
    state: status.state,
    stateLabel: status.stateLabel,
    draftPending: status.draftPending,
    liveVersionLabel: status.liveVersionLabel,
    searchText: searchHaystack(doc, extraSearchBits(doc, corpus, safety)),
  };
}

function searchHaystack(doc, extra) {
  const bits = [
    doc.knowledgeId, doc.faultId, doc.label, doc.applianceFamily,
    (doc.symptoms || []).join('\n'),
    (doc.likelyComponents || []).join('\n'),
    (doc.discriminators || []).join('\n'),
    (doc.adviceBeforeReplacement || []).join('\n'),
    doc.clarifyingQuestion || '',
    doc.secondaryQuestion || '',
    (doc.alternatives || []).join('\n'),
  ];
  (doc.components || []).forEach((c) => {
    bits.push(c.name, c.partName, (c.supports || []).join('\n'), (c.against || []).join('\n'));
  });
  (doc.commonConfusion || []).forEach((c) => {
    bits.push(c.name, c.note, (c.wouldApplyIf || []).join('\n'));
  });
  (extra || []).forEach((x) => bits.push(x));
  return bits.filter(Boolean).join('\n').toLowerCase();
}

function listKnowledge(opts) {
  const corpus = loadCorpus();
  const q = String((opts && opts.q) || '').trim().toLowerCase();
  const family = (opts && opts.family) || '';
  const all = effective();
  const ctx = Object.assign({}, corpus, { effectiveDocs: all.map((e) => e.doc) });
  let entries = all.slice();
  if (family) entries = entries.filter((e) => e.doc.applianceFamily === family);
  let records = entries.map((e) => summarise(e.doc, ctx, e));
  if (q) records = records.filter((r) => String(r.searchText || '').indexOf(q) !== -1);
  const byFamily = {};
  const stateCounts = { published: 0, draft: 0, archived: 0, draftPending: 0 };
  for (const e of all) {
    byFamily[e.doc.applianceFamily] = (byFamily[e.doc.applianceFamily] || 0) + 1;
    const st = statusOf(e.doc.knowledgeId);
    stateCounts[st.state] = (stateCounts[st.state] || 0) + 1;
    if (st.draftPending && st.state !== 'draft') stateCounts.draftPending++;
  }
  const families = FAMILIES.filter((f) => byFamily[f]).map((f) => ({ family: f, label: familyLabel(f), count: byFamily[f] }));
  return {
    frozen: false,
    managed: true,
    note: 'Diagnostic knowledge ApplianceClinic uses to understand symptoms, faults and components. Drafts never affect live diagnosis; publishing makes a change active.',
    baselineTotal: corpus.docs.length,
    overlayVersion: (_admin && _admin.overlayVersion) || 0,
    stateCounts,
    docsVersion: corpus.docsVersion,
    index: corpus.indexMeta ? {
      version: corpus.indexMeta.version,
      embedModel: corpus.indexMeta.embedModel,
      dims: corpus.indexMeta.dims,
      builtAt: corpus.indexMeta.builtAt,
      count: corpus.indexMeta.count,
    } : null,
    total: all.length,
    matching: records.length,
    families,
    records,
  };
}

function getKnowledge(id) {
  const corpus = loadCorpus();
  const all = effective();
  const entry = all.find((e) => e.doc.knowledgeId === id);
  if (!entry) return null;
  const doc = entry.doc;
  const ctx = Object.assign({}, corpus, { effectiveDocs: all.map((e) => e.doc) });
  const safety = safetyFor(entry, corpus);
  const status = statusOf(id);
  const indexed = indexedFor(entry, corpus);
  const media = mediaFor(id, doc, corpus);
  const liveMedia = media.filter((m) => m.liveForDiagnosis);
  const gaps = [];
  if (!doc.provenance) gaps.push('No provenance recorded');
  if (!liveMedia.length) gaps.push('No media linked');
  if (liveMedia.length < media.length) gaps.push('Archived media still attached');
  if (!(doc.discriminators && doc.discriminators.length) && !doc.clarifyingQuestion) gaps.push('No discriminator recorded');
  if (!(doc.adviceBeforeReplacement && doc.adviceBeforeReplacement.length)) gaps.push('No advice-before-replacement recorded');
  if (!(doc.components && doc.components.length) && !(doc.likelyComponents && doc.likelyComponents.length)) {
    gaps.push('No components recorded');
  }
  return {
    knowledgeId: doc.knowledgeId,
    version: doc.version || null,
    applianceFamily: doc.applianceFamily,
    familyLabel: familyLabel(doc.applianceFamily),
    faultId: doc.faultId,
    label: doc.label,
    outcome: doc.outcome || null,
    make: doc.make || null,
    platform: doc.platform || null,
    provenance: typeof doc.provenance === 'string' ? doc.provenance : null,
    provenanceLabel: provenanceLabel(doc.provenance) || 'No provenance recorded',
    symptoms: doc.symptoms || [],
    likelyComponents: doc.likelyComponents || [],
    componentFamilies: doc.componentFamilies || [],
    components: (doc.components || []).map((c) => ({
      name: c.name,
      type: c.type || null,
      partName: c.partName || null,
      supports: c.supports || [],
      against: c.against || [],
    })),
    discriminators: doc.discriminators || [],
    clarifyingQuestion: doc.clarifyingQuestion || null,
    secondaryQuestion: doc.secondaryQuestion || null,
    adviceBeforeReplacement: doc.adviceBeforeReplacement || [],
    commonConfusion: (doc.commonConfusion || []).map((c) => ({
      name: c.name,
      note: c.note || null,
      wouldApplyIf: c.wouldApplyIf || [],
    })),
    alternatives: doc.alternatives || [],
    safety: safety ? {
      classification: safety.classification || null,
      hazard: safety.hazard || null,
      text: safety.text || null,
      applicability: safety.applicability || null,
      provenance: safety.provenance || [],
    } : null,
    media,
    relatedTopics: relatedTopics(doc, ctx),
    indexed,
    source: entry.source,
    state: status.state,
    stateLabel: status.stateLabel,
    draftPending: status.draftPending,
    liveVersionLabel: status.liveVersionLabel,
    publishedVersion: doc.publishedVersion || null,
    index: corpus.indexMeta ? {
      version: corpus.indexMeta.version,
      embedModel: corpus.indexMeta.embedModel,
      dims: corpus.indexMeta.dims,
      builtAt: corpus.indexMeta.builtAt,
    } : null,
    gaps,
    technical: {
      knowledgeId: doc.knowledgeId,
      version: doc.version || null,
      docsVersion: corpus.docsVersion,
      source: entry.source,
      publishedVersion: doc.publishedVersion || null,
      indexed,
      embedModel: corpus.indexMeta && corpus.indexMeta.embedModel,
      indexBuiltAt: corpus.indexMeta && corpus.indexMeta.builtAt,
      text: entry.source === 'draft' ? null : (doc.text || null),
    },
  };
}

module.exports = {
  FAMILIES, familyLabel, provenanceLabel,
  loadCorpus, resetCache, listKnowledge, getKnowledge, searchHaystack, summarise,
  setAdminView, adminView, setMediaView, mediaView,
};
