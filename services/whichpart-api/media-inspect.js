'use strict';
/**
 * Read-only inspector over shipped customer-help media, files, and diagnostic mappings.
 * Does not mutate assets, catalogue rows, or knowledge mappings.
 */
const path = require('path');
const knowledgeInspect = require('./knowledge-inspect');
let mediaEffective;
try { mediaEffective = require('../part-finder/media-effective'); }
catch { mediaEffective = require('./media-effective'); }

const FAMILIES = knowledgeInspect.FAMILIES;
const familyLabel = knowledgeInspect.familyLabel;

const VIDEO_EMBED_HOSTS = new Set(['www.youtube-nocookie.com', 'youtube-nocookie.com']);

const HELP_HUBS = [
  { family: 'washing-machine', slug: 'washing-machines', title: 'Washing machine help — drain, leaks and noise' },
  { family: 'washer-dryer', slug: 'washer-dryers', title: 'Washer dryer help — wash, dry and leaks' },
  { family: 'tumble-dryer', slug: 'tumble-dryers', title: 'Tumble dryer help — drying, heat and filters' },
  { family: 'dishwasher', slug: 'dishwashers', title: 'Dishwasher help — draining, cleaning and leaks' },
  { family: 'fridge-freezer', slug: 'fridge-freezers', title: 'Fridge-freezer help — cooling, ice and seals' },
  { family: 'oven-cooker', slug: 'ovens-cookers', title: 'Oven and cooker help — heat, fans and gas safety' },
  { family: 'hobs', slug: 'hobs', title: 'Hob help — zones, ignition and cracked glass' },
  { family: 'microwave', slug: 'microwaves', title: 'Microwave help — not heating, sparks and doors' },
  { family: 'vacuum', slug: 'vacuum-cleaners', title: 'Vacuum cleaner help — suction, blockages and brush bars' },
];

/** Factual Help Hub file usage from public hub HTML (not diagnostic mappings). */
const HELP_HUB_FILES = {
  'wm-pump-filter.svg': ['washing-machines', 'washer-dryers'],
  'wm-inlet-hose-filter.svg': ['washing-machines'],
  'wm-door-seal.svg': ['washing-machines'],
  'wm-transit-bolts.png': ['washing-machines'],
  'dishwasher-filter.svg': ['dishwashers'],
  'dishwasher-spray-arm.svg': ['dishwashers'],
  'td-lint-filter.svg': ['tumble-dryers'],
  'td-condenser.svg': ['tumble-dryers', 'washer-dryers'],
  'oven-not-heating-cooking-unevenly.png': ['ovens-cookers'],
  'hob-not-heating-heating-unevenly.png': ['hobs'],
  'fridge-freezer-not-cooling-properly.png': ['fridge-freezers'],
  'vac-poor-suction-loss-of-power.png': ['vacuum-cleaners'],
};

function hubBySlug(slug) {
  return HELP_HUBS.find((h) => h.slug === slug) || { slug, title: slug, family: null };
}

function isTrustedVideoEmbed(u) {
  try {
    const url = new URL(String(u));
    return url.protocol === 'https:' && VIDEO_EMBED_HOSTS.has(url.hostname.toLowerCase());
  } catch { return false; }
}

function loadCatalogue() {
  try { return require('./media-catalogue.json'); }
  catch { return { version: '1', itemCount: 0, items: [] }; }
}

function loadJoin() {
  const corpus = knowledgeInspect.loadCorpus();
  const dir = corpus.dir;
  let join = { byKnowledgeId: {}, byComponent: {} };
  try {
    const fs = require('fs');
    const p = path.join(dir, 'media-information.json');
    if (fs.existsSync(p)) join = JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch { /* empty */ }
  return { corpus, join };
}

function typeLabel(type) {
  if (type === 'VIDEO') return 'Video';
  if (type === 'DIAGRAM') return 'Diagram';
  if (type === 'IMAGE') return 'Image';
  return type || 'Other';
}

function fileNameFromUrl(url) {
  if (!url) return null;
  const s = String(url);
  const i = s.lastIndexOf('/');
  return i === -1 ? s : s.slice(i + 1);
}

function knowledgeLookup(corpus) {
  const by = {};
  (corpus.docs || []).forEach((d) => {
    by[d.knowledgeId] = { knowledgeId: d.knowledgeId, faultId: d.faultId, label: d.label, applianceFamily: d.applianceFamily };
  });
  return by;
}

function hubsForFile(file) {
  return (HELP_HUB_FILES[file] || []).map((slug) => {
    const h = hubBySlug(slug);
    return { slug: h.slug, title: h.title, family: h.family };
  });
}

function cloneJson(x) {
  return mediaEffective.cloneJson(x);
}

function applyOverlay(catalogue, join, overlay) {
  if (!overlay) return { catalogue, join, retired: {}, origins: {}, extraUrls: [] };
  const cat = cloneJson(catalogue);
  cat.items = Array.isArray(cat.items) ? cat.items.slice() : [];
  // An id can have several catalogue rows (e.g. png + svg). The overlay merges into the PRIMARY row — the
  // same row pickPrimary() presents (mapped/captioned first, then non-SVG) — never an arbitrary later row.
  const rank = (it) => (((it.knowledgeIds || []).length || it.caption) ? 0 : 2) + (/\.svg$/i.test(it.file || it.url || '') ? 1 : 0);
  const byIndex = {};
  cat.items.forEach((it, i) => {
    if (!it || !it.id) return;
    if (byIndex[it.id] == null || rank(it) < rank(cat.items[byIndex[it.id]])) byIndex[it.id] = i;
  });
  const retired = {};
  const origins = {};
  const extraUrls = [];
  Object.keys(overlay.identities || {}).forEach((id) => {
    const rec = overlay.identities[id] || {};
    origins[id] = rec.origin || 'admin';
    if (rec.status === 'retired') retired[id] = rec.retiredAt || true;
    if (rec.removed) {
      cat.items = cat.items.filter((it) => it.id !== id);
      delete byIndex[id];
      return;
    }
    if (!rec.catalogue) return;
    // null / undefined override fields mean "keep the shipped value" (e.g. a text-only edit keeps shipped files).
    const row = { id };
    Object.keys(rec.catalogue).forEach((k) => { if (rec.catalogue[k] != null) row[k] = rec.catalogue[k]; });
    if (row.url) extraUrls.push(row.url);
    if (byIndex[id] == null) {
      byIndex[id] = cat.items.length;
      cat.items.push(row);
    } else {
      cat.items[byIndex[id]] = Object.assign({}, cat.items[byIndex[id]], row, { id });
    }
  });
  const jn = mediaEffective.mergeJoin(join, overlay, { includeRetired: true });
  return { catalogue: cat, join: jn, retired, origins, extraUrls };
}

function buildIdentities(overlay) {
  const shippedCat = loadCatalogue();
  const { corpus, join: shippedJoin } = loadJoin();
  const applied = applyOverlay(shippedCat, shippedJoin, overlay);
  const catalogue = applied.catalogue;
  const join = applied.join;
  const knBy = knowledgeLookup(corpus);
  const knownUrls = new Set((catalogue.items || []).map((it) => it.url).filter(Boolean));
  applied.extraUrls.forEach((u) => knownUrls.add(u));
  const byId = {};

  function ensure(id) {
    if (!byId[id]) {
      byId[id] = {
        id,
        catalogueRows: [],
        mappings: [],
        origin: 'shipped',
        status: 'active',
        retiredAt: null,
        catalogueOverridden: false,
      };
    }
    return byId[id];
  }

  (catalogue.items || []).forEach((it) => {
    const rec = ensure(it.id || it.file || it.url);
    rec.catalogueRows.push(it);
    rec.origin = applied.origins[rec.id] || rec.origin || 'shipped';
    rec.status = applied.retired[rec.id] ? 'retired' : 'active';
    rec.retiredAt = applied.retired[rec.id] === true ? null : (applied.retired[rec.id] || null);
    if (applied.origins[rec.id] && overlay && overlay.identities && overlay.identities[rec.id] && overlay.identities[rec.id].catalogue) {
      rec.catalogueOverridden = true;
    }
  });

  Object.keys(join.byKnowledgeId || {}).forEach((kid) => {
    (join.byKnowledgeId[kid] || []).forEach((m) => {
      const rec = ensure(m.id);
      rec.mappings.push({
        source: 'knowledge',
        knowledgeId: kid,
        componentKey: null,
        id: m.id,
        type: m.type,
        title: m.title,
        description: m.description || m.caption || null,
        caption: m.caption || null,
        alt: m.alt || null,
        relatedCheck: m.relatedCheck || null,
        asset: m.asset || null,
        videoId: m.videoId || null,
        embedUrl: m.embedUrl || null,
        makes: m.makes || null,
        errorCodes: m.errorCodes || null,
        safetyClass: m.safetyClass || null,
        applicability: m.applicability || null,
        intent: m.intent || null,
        concepts: m.concepts || null,
        attribution: m.attribution || null,
        sourcePageUrl: m.sourcePageUrl || null,
        provider: m.provider || null,
        provenance: m.provenance || [],
      });
    });
  });

  Object.keys(join.byComponent || {}).forEach((ckey) => {
    (join.byComponent[ckey] || []).forEach((m) => {
      const rec = ensure(m.id);
      rec.mappings.push({
        source: 'component',
        knowledgeId: null,
        componentKey: ckey,
        id: m.id,
        type: m.type,
        title: m.title,
        description: m.description || m.caption || null,
        caption: m.caption || null,
        alt: m.alt || null,
        relatedCheck: m.relatedCheck || null,
        asset: m.asset || null,
        videoId: m.videoId || null,
        embedUrl: m.embedUrl || null,
        makes: m.makes || null,
        errorCodes: m.errorCodes || null,
        safetyClass: m.safetyClass || null,
        applicability: m.applicability || null,
        intent: m.intent || null,
        concepts: m.concepts || null,
        attribution: m.attribution || null,
        sourcePageUrl: m.sourcePageUrl || null,
        provider: m.provider || null,
        provenance: m.provenance || [],
      });
    });
  });

  Object.keys(applied.origins).forEach((id) => {
    if (overlay && overlay.identities && overlay.identities[id] && overlay.identities[id].removed) return;
    const rec = ensure(id);
    rec.origin = applied.origins[id];
    rec.status = applied.retired[id] ? 'retired' : (rec.status || 'active');
    rec.retiredAt = applied.retired[id] === true ? null : (applied.retired[id] || rec.retiredAt || null);
  });
  return { byId, catalogue, corpus, knBy, knownUrls, overlay: overlay || null };
}

function pickPrimary(bundle) {
  const mapped = bundle.mappings[0] || null;
  const rows = bundle.catalogueRows.slice();
  rows.sort((a, b) => {
    const aMapped = (a.knowledgeIds || []).length || a.caption ? 0 : 1;
    const bMapped = (b.knowledgeIds || []).length || b.caption ? 0 : 1;
    if (aMapped !== bMapped) return aMapped - bMapped;
    const aSvg = /\.svg$/i.test(a.file || a.url || '') ? 1 : 0;
    const bSvg = /\.svg$/i.test(b.file || b.url || '') ? 1 : 0;
    return aSvg - bSvg;
  });
  const row = rows[0] || null;
  const type = (mapped && mapped.type) || (row && row.type) || 'IMAGE';
  const title = (bundle.catalogueOverridden && row && row.title)
    ? row.title
    : ((mapped && mapped.title) || (row && row.title) || bundle.id);
  const description = (bundle.catalogueOverridden && row && (row.caption || row.description))
    ? (row.caption || row.description)
    : ((mapped && mapped.description) || (row && row.caption) || null);
  const alt = (bundle.catalogueOverridden && row && row.alt)
    ? row.alt
    : ((mapped && mapped.alt) || (row && row.alt) || null);
  let previewUrl = null;
  let videoId = (mapped && mapped.videoId) || (row && row.videoId) || null;
  let embedUrl = (mapped && mapped.embedUrl) || (row && row.embedUrl) || null;
  if (type === 'VIDEO') {
    previewUrl = null;
  } else if (mapped && mapped.asset) {
    previewUrl = mapped.asset;
  } else if (row && row.url && !videoId) {
    previewUrl = row.url;
  }
  const trusted = type === 'VIDEO' ? isTrustedVideoEmbed(embedUrl) : true;
  return { mapped, row, type, title, description, alt, previewUrl, videoId, embedUrl, trusted };
}

function isJoinDetached(overlay, knowledgeId, mediaId) {
  if (!overlay || !knowledgeId || !mediaId) return false;
  const bag = overlay.detachedByKnowledgeId && overlay.detachedByKnowledgeId[knowledgeId];
  if (bag && bag[mediaId]) return true;
  const list = overlay.byKnowledgeId && overlay.byKnowledgeId[knowledgeId];
  if (Array.isArray(list) && list.some((m) => m && m.id === mediaId && m.detached)) return true;
  return false;
}

function knowledgeUsage(bundle, knBy, overlay) {
  const seen = {};
  const out = [];
  bundle.mappings.forEach((m) => {
    if (!m.knowledgeId) return;
    if (seen[m.knowledgeId]) {
      seen[m.knowledgeId].descriptions.push(m.description);
      return;
    }
    const kn = knBy[m.knowledgeId] || {};
    const rec = {
      knowledgeId: m.knowledgeId,
      label: kn.label || m.knowledgeId,
      faultId: kn.faultId || (m.knowledgeId.indexOf(':') !== -1 ? m.knowledgeId.split(':').slice(1).join(':') : m.knowledgeId),
      applianceFamily: kn.applianceFamily || m.knowledgeId.split(':')[0],
      familyLabel: familyLabel(kn.applianceFamily || m.knowledgeId.split(':')[0]),
      relatedCheck: m.relatedCheck || null,
      description: m.description || null,
      descriptions: m.description ? [m.description] : [],
      intent: m.intent || null,
      applicability: m.applicability || null,
    };
    seen[m.knowledgeId] = rec;
    out.push(rec);
  });
  bundle.catalogueRows.forEach((row) => {
    (row.knowledgeIds || []).forEach((kid) => {
      if (seen[kid]) return;
      if (isJoinDetached(overlay, kid, bundle.id)) return;
      const kn = knBy[kid] || {};
      out.push({
        knowledgeId: kid,
        label: kn.label || kid,
        faultId: kn.faultId || (kid.indexOf(':') !== -1 ? kid.split(':').slice(1).join(':') : kid),
        applianceFamily: kn.applianceFamily || kid.split(':')[0],
        familyLabel: familyLabel(kn.applianceFamily || kid.split(':')[0]),
        relatedCheck: row.relatedCheck || null,
        description: row.caption || null,
        descriptions: row.caption ? [row.caption] : [],
        intent: null,
        applicability: null,
      });
      seen[kid] = true;
    });
  });
  return out;
}

function componentUsage(bundle) {
  return bundle.mappings.filter((m) => m.source === 'component').map((m) => ({
    componentKey: m.componentKey,
    relatedCheck: m.relatedCheck || null,
    description: m.description || null,
    intent: m.intent || null,
  }));
}

function familiesOf(bundle, usage) {
  const set = {};
  usage.forEach((u) => { if (u.applianceFamily) set[u.applianceFamily] = true; });
  bundle.catalogueRows.forEach((row) => (row.families || []).forEach((f) => { set[f] = true; }));
  bundle.mappings.forEach((m) => {
    if (m.knowledgeId) set[m.knowledgeId.split(':')[0]] = true;
    if (m.componentKey) set[m.componentKey.split(':')[0]] = true;
  });
  return FAMILIES.filter((f) => set[f]).concat(Object.keys(set).filter((f) => FAMILIES.indexOf(f) === -1));
}

function helpHubsOf(bundle) {
  const seen = {};
  const out = [];
  bundle.catalogueRows.forEach((row) => {
    hubsForFile(row.file || fileNameFromUrl(row.url)).forEach((h) => {
      if (seen[h.slug]) return;
      seen[h.slug] = true;
      out.push(h);
    });
  });
  bundle.mappings.forEach((m) => {
    hubsForFile(fileNameFromUrl(m.asset)).forEach((h) => {
      if (seen[h.slug]) return;
      seen[h.slug] = true;
      out.push(h);
    });
  });
  return out;
}

function availability(bundle, primary, knownUrls) {
  if (primary.type === 'VIDEO') {
    if (primary.videoId && primary.trusted) return { available: true, state: 'available', note: null };
    if (primary.videoId && !primary.trusted) {
      return { available: false, state: 'unavailable', note: 'Referenced asset could not be loaded. External embed host is not on the trusted list.' };
    }
    return { available: false, state: 'unavailable', note: 'Referenced asset could not be loaded. No trusted video reference recorded.' };
  }
  const urls = [];
  if (primary.previewUrl) urls.push(primary.previewUrl);
  bundle.catalogueRows.forEach((r) => { if (r.url) urls.push(r.url); });
  bundle.mappings.forEach((m) => { if (m.asset) urls.push(m.asset); });
  const local = urls.filter((u) => String(u).indexOf('/media/') === 0);
  if (!local.length && !primary.videoId) {
    return { available: false, state: 'unavailable', note: 'Referenced asset could not be loaded.' };
  }
  const missing = local.filter((u) => knownUrls.size && !knownUrls.has(u));
  if (local.length && missing.length === local.length) {
    return { available: false, state: 'unavailable', note: 'Referenced file unavailable' };
  }
  return { available: true, state: 'available', note: null };
}

function searchHaystack(bundle, primary, usage, hubs) {
  const bits = [
    bundle.id, primary.title, primary.description, primary.alt, primary.type,
    primary.videoId, primary.previewUrl, primary.embedUrl,
  ];
  bundle.catalogueRows.forEach((r) => {
    bits.push(r.file, r.url, r.title, r.caption, r.alt, r.relatedCheck);
  });
  bundle.mappings.forEach((m) => {
    bits.push(m.knowledgeId, m.componentKey, m.title, m.description, m.relatedCheck,
      (m.errorCodes || []).join('\n'), (m.makes || []).join('\n'), m.asset);
  });
  usage.forEach((u) => bits.push(u.knowledgeId, u.label, u.faultId, u.relatedCheck, u.description));
  hubs.forEach((h) => bits.push(h.title, h.slug, h.family));
  return bits.filter(Boolean).join('\n').toLowerCase();
}

function sameFileAs(bundle, byId) {
  const urls = new Set();
  bundle.catalogueRows.forEach((r) => { if (r.url) urls.add(r.url); });
  bundle.mappings.forEach((m) => { if (m.asset) urls.add(m.asset); });
  if (!urls.size) return [];
  const out = [];
  Object.keys(byId).sort().forEach((id) => {
    if (id === bundle.id) return;
    const other = byId[id];
    const hit = other.catalogueRows.some((r) => r.url && urls.has(r.url))
      || other.mappings.some((m) => m.asset && urls.has(m.asset));
    if (!hit) return;
    const primary = pickPrimary(other);
    out.push({ id, title: primary.title, type: primary.type });
  });
  return out;
}

function summarise(bundle, knBy, knownUrls, overlay) {
  const primary = pickPrimary(bundle);
  const usage = knowledgeUsage(bundle, knBy, overlay);
  const components = componentUsage(bundle);
  const families = familiesOf(bundle, usage);
  const hubs = helpHubsOf(bundle);
  const avail = availability(bundle, primary, knownUrls);
  const used = usage.length > 0 || components.length > 0;
  const desc = primary.description && String(primary.description).trim();
  const alt = primary.alt && String(primary.alt).trim();
  const gaps = [];
  if (!used) gaps.push('Not linked to diagnostic knowledge');
  if (!desc) gaps.push('No customer description recorded');
  if (!alt && primary.type !== 'VIDEO') gaps.push('No alt text recorded');
  if (!avail.available) gaps.push('Referenced file unavailable');
  if (!families.length) gaps.push('No appliance family recorded');
  const errorCodes = [];
  bundle.mappings.forEach((m) => (m.errorCodes || []).forEach((c) => {
    if (errorCodes.indexOf(c) === -1) errorCodes.push(c);
  }));
  const files = bundle.catalogueRows.map((r) => ({
    file: r.file, url: r.url, type: r.type, bytes: r.bytes, videoId: r.videoId,
  }));
  const previewKind = primary.type === 'VIDEO' ? 'video' : (primary.previewUrl ? 'image' : 'none');
  return {
    id: bundle.id,
    title: primary.title,
    type: primary.type,
    typeLabel: typeLabel(primary.type),
    families,
    familyLabel: families.length ? families.map(familyLabel).join(', ') : null,
    descriptionPreview: desc ? String(desc).slice(0, 180) : null,
    knowledgeCount: usage.length,
    knowledgePreview: usage.slice(0, 3).map((u) => ({ knowledgeId: u.knowledgeId, label: u.label, faultId: u.faultId })),
    used,
    origin: bundle.origin || 'shipped',
    status: bundle.status || 'active',
    retiredAt: bundle.retiredAt || null,
    available: avail.available,
    availabilityState: avail.state,
    availabilityNote: avail.note,
    helpHubCount: hubs.length,
    errorCodes,
    previewUrl: primary.previewUrl,
    previewKind,
    videoId: primary.videoId,
    gaps,
    searchText: searchHaystack(bundle, primary, usage, hubs),
    files,
  };
}

function listMedia(opts) {
  const overlay = opts && opts.overlay;
  const { byId, knBy, knownUrls, catalogue } = buildIdentities(overlay);
  const q = String((opts && opts.q) || '').trim().toLowerCase();
  const family = (opts && opts.family) || '';
  const type = (opts && opts.type) || '';
  const usage = (opts && opts.usage) || '';
  let records = Object.keys(byId).sort().map((id) => summarise(byId[id], knBy, knownUrls, overlay));
  if (family) records = records.filter((r) => (r.families || []).indexOf(family) !== -1);
  if (type) records = records.filter((r) => r.type === type);
  if (usage === 'used') records = records.filter((r) => r.used && r.status !== 'retired');
  if (usage === 'unused') records = records.filter((r) => !r.used && r.status !== 'retired');
  if (usage === 'unavailable') records = records.filter((r) => !r.available);
  if (usage === 'retired') records = records.filter((r) => r.status === 'retired');
  if (q) records = records.filter((r) => String(r.searchText || '').indexOf(q) !== -1);
  const byFamily = {};
  Object.keys(byId).forEach((id) => {
    summarise(byId[id], knBy, knownUrls, overlay).families.forEach((f) => {
      byFamily[f] = (byFamily[f] || 0) + 1;
    });
  });
  const families = FAMILIES.filter((f) => byFamily[f]).map((f) => ({ family: f, label: familyLabel(f), count: byFamily[f] }));
  const all = Object.keys(byId).map((id) => summarise(byId[id], knBy, knownUrls, overlay));
  return {
    frozen: true,
    managed: true,
    note: 'Inspect the help images and videos ApplianceClinic can show customers. Customer presentation and diagnostic mappings are separate operations.',
    catalogueVersion: catalogue.version || null,
    total: all.length,
    matching: records.length,
    usedCount: all.filter((r) => r.used).length,
    unusedCount: all.filter((r) => !r.used).length,
    families,
    types: ['IMAGE', 'DIAGRAM', 'VIDEO'],
    records,
  };
}

function getMedia(id, overlay) {
  const { byId, knBy, knownUrls } = buildIdentities(overlay);
  const bundle = byId[id];
  if (!bundle) return null;
  const summary = summarise(bundle, knBy, knownUrls, overlay);
  const primary = pickPrimary(bundle);
  const aliases = sameFileAs(bundle, byId);
  const usage = knowledgeUsage(bundle, knBy, overlay);
  const components = componentUsage(bundle);
  const hubs = helpHubsOf(bundle);
  const errorCodes = [];
  const makes = [];
  bundle.mappings.forEach((m) => {
    (m.errorCodes || []).forEach((c) => { if (errorCodes.indexOf(c) === -1) errorCodes.push(c); });
    (m.makes || []).forEach((c) => { if (makes.indexOf(c) === -1) makes.push(c); });
  });
  const safetyClass = (bundle.mappings.find((m) => m.safetyClass) || {}).safetyClass || null;
  const relatedCheck = (bundle.mappings.find((m) => m.relatedCheck) || {}).relatedCheck
    || (bundle.catalogueRows.find((r) => r.relatedCheck) || {}).relatedCheck || null;
  const provenance = [];
  bundle.mappings.forEach((m) => (m.provenance || []).forEach((p) => provenance.push(p)));
  return {
    id: bundle.id,
    title: summary.title,
    type: summary.type,
    typeLabel: summary.typeLabel,
    families: summary.families,
    familyLabel: summary.familyLabel,
    description: primary.description || null,
    caption: (bundle.catalogueRows.find((r) => r.caption) || {}).caption || primary.description || null,
    alt: primary.alt || null,
    relatedCheck,
    attribution: (bundle.mappings.find((m) => m.attribution) || bundle.catalogueRows.find((r) => r.attribution) || {}).attribution || null,
    sourcePageUrl: (bundle.mappings.find((m) => m.sourcePageUrl) || bundle.catalogueRows.find((r) => r.sourcePageUrl) || {}).sourcePageUrl || null,
    intent: (bundle.mappings.find((m) => m.intent) || {}).intent || null,
    safetyClass,
    applicability: (bundle.mappings.find((m) => m.applicability) || {}).applicability || null,
    makes,
    errorCodes,
    previewUrl: summary.previewUrl,
    previewKind: summary.previewKind,
    videoId: summary.videoId,
    embedUrl: primary.trusted ? primary.embedUrl : null,
    embedTrusted: primary.type !== 'VIDEO' || primary.trusted,
    available: summary.available,
    availabilityState: summary.availabilityState,
    availabilityNote: summary.availabilityNote,
    used: summary.used,
    origin: bundle.origin || 'shipped',
    status: bundle.status || 'active',
    retiredAt: bundle.retiredAt || null,
    knowledge: usage,
    components,
    sameFileAs: aliases,
    helpHubs: hubs,
    gaps: summary.gaps,
    files: bundle.catalogueRows.map((r) => ({
      file: r.file || null,
      url: r.url || null,
      type: r.type || null,
      bytes: r.bytes == null ? null : r.bytes,
      videoId: r.videoId || null,
      embedUrl: r.embedUrl && isTrustedVideoEmbed(r.embedUrl) ? r.embedUrl : null,
    })),
    mappings: bundle.mappings.map((m) => ({
      source: m.source,
      knowledgeId: m.knowledgeId,
      componentKey: m.componentKey,
      relatedCheck: m.relatedCheck,
      description: m.description,
      intent: m.intent,
      makes: m.makes,
      errorCodes: m.errorCodes,
      safetyClass: m.safetyClass,
      asset: m.asset,
    })),
    provenance,
    technical: {
      id: bundle.id,
      type: summary.type,
      previewUrl: summary.previewUrl,
      videoId: summary.videoId,
      embedUrl: primary.embedUrl || null,
      embedTrusted: primary.trusted,
      catalogueRows: bundle.catalogueRows.length,
      mappingCount: bundle.mappings.length,
      sameFileAs: aliases.map((a) => a.id),
    },
    raw: {
      catalogueRows: bundle.catalogueRows,
      mappings: bundle.mappings.map((m) => ({
        source: m.source,
        knowledgeId: m.knowledgeId,
        componentKey: m.componentKey,
        id: m.id,
        type: m.type,
        title: m.title,
        description: m.description,
        caption: m.caption,
        alt: m.alt,
        relatedCheck: m.relatedCheck,
        asset: m.asset,
        videoId: m.videoId,
        embedUrl: m.embedUrl,
        makes: m.makes,
        errorCodes: m.errorCodes,
        safetyClass: m.safetyClass,
        applicability: m.applicability,
        intent: m.intent,
        attribution: m.attribution,
        sourcePageUrl: m.sourcePageUrl,
        provider: m.provider,
        provenance: m.provenance,
      })),
    },
  };
}

/**
 * Effective Media joins for Knowledge Admin, computed with the SAME merge live diagnosis uses
 * (part-finder media-effective.js mergeJoin over the shipped join + the Media overlay):
 *   live — what diagnosis can show now: published presentation/file, attachments, no archived/deleted ids.
 *   all  — live plus archived items that are still attached (so Knowledge can flag them, never hide them).
 * Drafts are never part of either: the merge reads only identities[id].catalogue, never .draft.
 */
function knowledgeMediaView(overlay) {
  const { join } = loadJoin();
  return {
    live: mediaEffective.mergeJoin(join, overlay || null),
    all: mediaEffective.mergeJoin(join, overlay || null, { includeRetired: true }),
  };
}

module.exports = {
  knowledgeMediaView,
  FAMILIES, familyLabel, typeLabel, isTrustedVideoEmbed,
  listMedia, getMedia, buildIdentities, applyOverlay, HELP_HUBS, HELP_HUB_FILES,
};
