/*
 * Media inspector — pure list/search helpers (no DOM, no diagnosis).
 * Admin catalogue discovery only. Not used by customer diagnosis.
 */
(/** @param {any} root @param {() => any} factory */ function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.MdLogic = api;
})(typeof window !== 'undefined' ? window : typeof global !== 'undefined' ? global : this, function () {
  'use strict';

  var FAMILIES = [
    'washing-machine', 'washer-dryer', 'tumble-dryer', 'dishwasher',
    'oven-cooker', 'hobs', 'fridge-freezer', 'microwave', 'vacuum',
  ];
  var VIDEO_EMBED_HOSTS = { 'www.youtube-nocookie.com': true, 'youtube-nocookie.com': true };

  function familyLabel(family) {
    return String(family || '').replace(/-/g, ' ').replace(/\b\w/g, function (c) { return c.toUpperCase(); });
  }

  function typeLabel(type) {
    if (type === 'VIDEO') return 'Video';
    if (type === 'DIAGRAM') return 'Diagram';
    if (type === 'IMAGE') return 'Image';
    return type || 'Other';
  }

  function isTrustedVideoEmbed(u) {
    try {
      var url = new URL(String(u));
      return url.protocol === 'https:' && !!VIDEO_EMBED_HOSTS[url.hostname.toLowerCase()];
    } catch (e) { return false; }
  }

  function safeEmbedUrl(u) {
    if (!isTrustedVideoEmbed(u)) return null;
    try {
      var url = new URL(String(u));
      url.searchParams.delete('autoplay');
      url.searchParams.delete('mute');
      return url.toString();
    } catch (e) { return null; }
  }

  function filterRecords(records, opts) {
    opts = opts || {};
    var q = String(opts.q || '').trim().toLowerCase();
    var family = opts.family || '';
    var type = opts.type || '';
    var usage = opts.usage || '';
    return (records || []).filter(function (r) {
      if (family && (r.families || []).indexOf(family) === -1) return false;
      if (type && r.type !== type) return false;
      if (usage === 'used' && (!r.used || r.status === 'retired')) return false;
      if (usage === 'unused' && (r.used || r.status === 'retired')) return false;
      if (usage === 'unavailable' && r.available) return false;
      if (usage === 'retired' && r.status !== 'retired') return false;
      if (usage === 'draft' && !r.draftPending) return false;
      if (!q) return true;
      var hay = String(r.searchText || [
        r.id, r.title, r.descriptionPreview, r.familyLabel, r.type,
        (r.knowledgePreview || []).map(function (k) { return [k.knowledgeId, k.label, k.faultId].join(' '); }).join(' '),
      ].join('\n')).toLowerCase();
      return hay.indexOf(q) !== -1;
    });
  }

  function groupByFamily(records) {
    var groups = [];
    var by = {};
    var none = [];
    FAMILIES.forEach(function (f) { by[f] = []; });
    (records || []).forEach(function (r) {
      var fams = r.families || [];
      if (!fams.length) { none.push(r); return; }
      var f = fams[0];
      if (!by[f]) by[f] = [];
      by[f].push(r);
    });
    FAMILIES.forEach(function (f) {
      if (by[f] && by[f].length) groups.push({ family: f, label: familyLabel(f), records: by[f] });
    });
    Object.keys(by).forEach(function (f) {
      if (FAMILIES.indexOf(f) === -1 && by[f].length) {
        groups.push({ family: f, label: familyLabel(f), records: by[f] });
      }
    });
    if (none.length) {
      groups.push({ family: '', label: 'No appliance family recorded', records: none });
    }
    return groups;
  }

  function usageLabel(rec) {
    var n = rec.knowledgeCount || 0;
    if (n === 1) return 'Used by 1 diagnostic topic';
    if (n > 1) return 'Used by ' + n + ' diagnostic topics';
    return 'Not currently linked to diagnostic knowledge';
  }

  // Lifecycle chip (reuses the Knowledge kn-state classes). 'retired' is the stored value for Archived.
  function stateChip(rec, admin) {
    var r = rec || {};
    var status = (admin && admin.status) || r.status;
    var draft = admin ? admin.draftPending : r.draftPending;
    if (status === 'retired') return { label: 'Archived', cls: 'kn-state kn-state--archived' };
    if (draft) return { label: 'Live · draft pending', cls: 'kn-state kn-state--published kn-state--pending' };
    return { label: 'Live', cls: 'kn-state kn-state--published' };
  }

  var CHANGE_LABELS = { title: 'Title', caption: 'Customer description', alt: 'Alt text', families: 'Appliance family', url: 'File' };
  function changeLabels(fields) {
    var out = [];
    (fields || []).forEach(function (f) {
      var l = CHANGE_LABELS[f] || String(f);
      if (out.indexOf(l) === -1) out.push(l);
    });
    return out;
  }

  // Map a server validation error code to the editor control that needs attention (or null).
  var ERROR_FIELDS = {
    title: 'mdEditTitle', description: 'mdEditCaption', alt: 'mdEditAlt', family: 'mdEditFams',
    file: 'mdEditFile', file_type: 'mdEditFile', file_size: 'mdEditFile', file_mismatch: 'mdEditFile',
    file_unsafe: 'mdEditFile', file_dimensions: 'mdEditFile', duplicate_file: 'mdEditFile', file_exists: 'mdEditFile',
    video: 'mdEditVideoId', video_host: 'mdEditEmbed', autoplay: 'mdEditEmbed', type: 'mdEditType',
  };
  var PUBLISH_FIELDS = { title: 'mdEditTitle', caption: 'mdEditCaption', alt: 'mdEditAlt', file: 'mdEditFile' };
  function errorField(body) {
    var b = body || {};
    var fields = (b.extra && b.extra.fields) || [];
    if (fields.length && PUBLISH_FIELDS[fields[0]]) return PUBLISH_FIELDS[fields[0]];
    return ERROR_FIELDS[b.code] || null;
  }

  function missing(label, value) {
    if (value == null || value === '' || (Array.isArray(value) && !value.length)) return label;
    return null;
  }

  return {
    FAMILIES: FAMILIES,
    familyLabel: familyLabel,
    typeLabel: typeLabel,
    isTrustedVideoEmbed: isTrustedVideoEmbed,
    safeEmbedUrl: safeEmbedUrl,
    filterRecords: filterRecords,
    groupByFamily: groupByFamily,
    usageLabel: usageLabel,
    stateChip: stateChip,
    changeLabels: changeLabels,
    errorField: errorField,
    missing: missing,
  };
});
