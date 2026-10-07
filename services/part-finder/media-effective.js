'use strict';
/**
 * Effective media mappings = shipped baseline + durable admin overlay.
 *
 * Used by:
 *   - admin Media inspector (whichpart-api)
 *   - live diagnostic media selection (part-finder getMediaInformation)
 *
 * Overlay items ADD or REPLACE by id. Detach is a durable tombstone so deleting
 * an overlay add cannot resurrect a shipped mapping. Retired/removed identities
 * are stripped from every join list.
 *
 * Pure. No I/O.
 */
const OVERLAY_TTL_MS = Number(process.env.MEDIA_OVERLAY_TTL_MS || 10000);
const STATE_KEY = 'media-admin/state.json';

function cloneJson(x) {
  if (x == null) return x;
  return JSON.parse(JSON.stringify(x));
}

function identityFlags(overlay) {
  const retired = {};
  const removed = {};
  const catalogueById = {};
  Object.keys((overlay && overlay.identities) || {}).forEach((id) => {
    const rec = overlay.identities[id] || {};
    if (rec.status === 'retired') retired[id] = rec.retiredAt || true;
    if (rec.removed) removed[id] = true;
    if (rec.catalogue) catalogueById[id] = rec.catalogue;
  });
  return { retired, removed, catalogueById };
}

function detachedIds(overlay, kind, key) {
  const out = {};
  const map = kind === 'component'
    ? ((overlay && overlay.detachedByComponent) || {})
    : ((overlay && overlay.detachedByKnowledgeId) || {});
  const rec = map[key];
  if (rec && typeof rec === 'object' && !Array.isArray(rec)) {
    Object.keys(rec).forEach((id) => { if (rec[id]) out[id] = true; });
  }
  const lists = kind === 'component'
    ? (overlay && overlay.byComponent)
    : (overlay && overlay.byKnowledgeId);
  const list = lists && lists[key];
  if (Array.isArray(list)) {
    list.forEach((m) => { if (m && m.id && m.detached) out[m.id] = true; });
  }
  return out;
}

function applyCatalogue(item, catalogueById) {
  if (!item || !item.id) return item;
  const cat = catalogueById[item.id];
  if (!cat) return item;
  const next = Object.assign({}, item);
  if (cat.title) next.title = cat.title;
  if (cat.caption) {
    next.caption = cat.caption;
    next.description = cat.caption;
  }
  if (cat.alt) next.alt = cat.alt;
  if (cat.url && next.asset && cat.type !== 'VIDEO') next.asset = cat.url;
  if (cat.embedUrl && next.embedUrl) next.embedUrl = cat.embedUrl;
  if (cat.videoId && next.videoId) next.videoId = cat.videoId;
  return next;
}

function mergeOneList(shippedList, overlayList, detached, flags) {
  const byId = new Map();
  const order = [];
  function drop(id) {
    if (!id) return;
    byId.delete(id);
  }
  function put(item) {
    if (!item || !item.id || item.detached) return;
    if (detached[item.id] || flags.retired[item.id] || flags.removed[item.id]) {
      drop(item.id);
      return;
    }
    const next = applyCatalogue(item, flags.catalogueById);
    if (!byId.has(item.id)) order.push(item.id);
    byId.set(item.id, next);
  }
  (shippedList || []).forEach(put);
  (overlayList || []).forEach(put);
  Object.keys(detached).forEach(drop);
  Object.keys(flags.retired).forEach(drop);
  Object.keys(flags.removed).forEach(drop);
  return order.filter((id) => byId.has(id)).map((id) => byId.get(id));
}

function mergeMap(shippedMap, overlayMap, overlay, kind, flags) {
  const shipped = shippedMap || {};
  const extra = overlayMap || {};
  const detachedMap = kind === 'component'
    ? ((overlay && overlay.detachedByComponent) || {})
    : ((overlay && overlay.detachedByKnowledgeId) || {});
  const keys = new Set([...Object.keys(shipped), ...Object.keys(extra), ...Object.keys(detachedMap)]);
  const out = {};
  keys.forEach((key) => {
    if (Object.prototype.hasOwnProperty.call(extra, key) && extra[key] == null) {
      out[key] = [];
      return;
    }
    const list = mergeOneList(
      shipped[key],
      extra[key],
      detachedIds(overlay, kind, key),
      flags,
    );
    if (list.length || shipped[key] || extra[key] || detachedMap[key]) out[key] = list;
  });
  return out;
}

/**
 * @param {{byKnowledgeId?: object, byComponent?: object}} shippedJoin
 * @param {object|null} overlay  admin S3 state.json
 * @returns {{byKnowledgeId: object, byComponent: object}}
 */
function mergeJoin(shippedJoin, overlay, opts) {
  const shipped = {
    byKnowledgeId: (shippedJoin && shippedJoin.byKnowledgeId) || {},
    byComponent: (shippedJoin && shippedJoin.byComponent) || {},
  };
  if (!overlay) {
    return {
      byKnowledgeId: cloneJson(shipped.byKnowledgeId) || {},
      byComponent: cloneJson(shipped.byComponent) || {},
    };
  }
  const flags = identityFlags(overlay);
  if (opts && opts.includeRetired) flags.retired = {};
  return {
    byKnowledgeId: mergeMap(shipped.byKnowledgeId, overlay.byKnowledgeId, overlay, 'knowledge', flags),
    byComponent: mergeMap(shipped.byComponent, overlay.byComponent, overlay, 'component', flags),
  };
}

function mappingIds(join, knowledgeId) {
  return ((join && join.byKnowledgeId && join.byKnowledgeId[knowledgeId]) || [])
    .map((m) => m && m.id).filter(Boolean);
}

module.exports = {
  OVERLAY_TTL_MS,
  STATE_KEY,
  cloneJson,
  identityFlags,
  mergeJoin,
  mappingIds,
};
