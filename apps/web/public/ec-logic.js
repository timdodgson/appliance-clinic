/*
 * Error Codes inspector — pure list/search helpers (no DOM, no diagnosis).
 * Admin catalogue discovery only. Not used by customer diagnosis.
 */
(/** @param {any} root @param {() => any} factory */ function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.EcLogic = api;
})(typeof window !== 'undefined' ? window : typeof global !== 'undefined' ? global : this, function () {
  'use strict';

  var FAMILY_LABELS = {
    'washing-machine': 'Washing machines',
    'washer-dryer': 'Washer dryers',
    'tumble-dryer': 'Tumble dryers',
    dishwasher: 'Dishwashers',
    'cooker-oven': 'Cookers / ovens',
    'oven-cooker': 'Cookers / ovens',
    hobs: 'Hobs',
    'fridge-freezer': 'Fridge freezers',
    fridge: 'Fridges',
    freezer: 'Freezers',
    microwave: 'Microwaves',
    'vacuum-cleaner': 'Vacuum cleaners',
    vacuum: 'Vacuum cleaners',
    'cooker-hood': 'Cooker hoods',
    breadmaker: 'Bread makers',
    'coffee-maker': 'Coffee machines',
  };

  function familyLabel(family) {
    if (!family) return 'No appliance recorded';
    if (FAMILY_LABELS[family]) return FAMILY_LABELS[family];
    return String(family).replace(/-/g, ' ').replace(/\b\w/g, function (c) { return c.toUpperCase(); });
  }

  function brandLabel(brand) {
    if (!brand) return 'No brand recorded';
    return String(brand).replace(/\b\w/g, function (c) { return c.toUpperCase(); });
  }

  // Lifecycle labels. 'retired' is the stored value for Archived (kept for back-compat). The live
  // state is "Live", matching stateChip and every other Admin section.
  function statusLabel(status) {
    if (status === 'retired') return 'Archived';
    if (status === 'draft') return 'Draft';
    return 'Live';
  }

  // State chip for list cards and the detail header. Reuses the Knowledge kn-state classes.
  function stateChip(status, draftPending) {
    if (status === 'draft') return { label: 'Draft · not live', cls: 'kn-state kn-state--draft' };
    if (status === 'retired') return { label: 'Archived', cls: 'kn-state kn-state--archived' };
    if (draftPending) return { label: 'Live · draft pending', cls: 'kn-state kn-state--published kn-state--pending' };
    return { label: 'Live', cls: 'kn-state kn-state--published' };
  }

  var CHANGE_LABELS = {
    meaning: 'Meaning', shown: 'Aliases', applicabilityNote: 'Applicability', system: 'System',
    recordType: 'Record type', confidence: 'Confidence', declaredConfidence: 'Confidence',
    faultId: 'Fault id', notation: 'Notation', sourceRefs: 'Sources', provenance: 'Source / provenance',
    diagnosticHints: 'Diagnostic information', safety: 'Safety guidance',
  };
  function changeLabels(fields) {
    var out = [];
    (fields || []).forEach(function (f) {
      var l = CHANGE_LABELS[f] || String(f);
      if (out.indexOf(l) === -1) out.push(l);
    });
    return out;
  }

  // Map a server validation error to the editor control that needs attention (or null).
  function errorField(body, isNew) {
    body = body || {};
    var f = (body.fields && body.fields[0]) || '';
    var msg = String(body.message || '').toLowerCase();
    var code = body.error || '';
    if (f === 'meaning' || /meaning is required/.test(msg)) return 'ecfMeaning';
    if (f === 'safety.reason' || /requires a stored reason/.test(msg)) return 'ecfSafetyReason';
    if (f === 'safety.class' || /safety class/.test(msg)) return 'ecfSafety';
    if (f.indexOf('diagnosticHints.') === 0) {
      return { 'diagnosticHints.components': 'ecfComp', 'diagnosticHints.likelyCauses': 'ecfCauses', 'diagnosticHints.checks': 'ecfChecks' }[f] || null;
    }
    if (code === 'invalid_provenance' || /source url/.test(msg)) return 'ecfUrl';
    if (/record type/.test(msg)) return 'ecfType';
    if (/aliases must/.test(msg)) return 'ecfAliases';
    if (isNew) {
      if (code === 'invalid_family' || /appliance/.test(msg)) return 'ecfAppliance';
      if (/brand/.test(msg)) return 'ecfBrand';
      if (code === 'duplicate' || code === 'collision' || /error code/.test(msg)) return 'ecfCode';
    }
    if (code === 'collision' || /alias/.test(msg)) return 'ecfAliases';
    return null;
  }

  function originLabel(origin) {
    return origin === 'admin' ? 'Admin-created' : 'Shipped catalogue';
  }

  function sourceLabel(types, labels) {
    if (labels && labels.length) return labels.join(' · ');
    if (types && types.length) return types.join(' · ');
    return 'Not recorded';
  }

  function safeUrl(u) {
    var s = String(u || '').trim();
    if (!s) return null;
    if (/^(javascript|data|vbscript):/i.test(s)) return null;
    if (!/^https?:\/\//i.test(s)) return null;
    return s;
  }

  function filterRecords(records, opts) {
    opts = opts || {};
    var q = String(opts.q || '').trim().toLowerCase();
    var family = opts.family || '';
    var brand = opts.brand || '';
    var status = opts.status || '';
    var source = opts.source || '';
    return (records || []).filter(function (r) {
      if (family && (r.appliances || []).indexOf(family) === -1) return false;
      if (brand && (r.brands || []).indexOf(brand) === -1) return false;
      if (status && (r.status || 'active') !== status) return false;
      if (source === 'not-recorded' && (r.sourceTypes || []).length) return false;
      if (source && source !== 'not-recorded' && (r.sourceTypes || []).indexOf(source) === -1) return false;
      if (!q) return true;
      var hay = String(r.searchText || [
        r.code, (r.shown || []).join(' '), (r.brands || []).join(' '),
        (r.appliances || []).join(' '), r.meaning, r.mappingId,
        (r.sourceTypes || []).join(' '), r.origin, r.status,
      ].join('\n')).toLowerCase();
      return hay.indexOf(q) !== -1;
    });
  }

  function groupByFamilyBrand(records) {
    var groups = [];
    var byFam = {};
    (records || []).forEach(function (r) {
      var fam = (r.appliances && r.appliances[0]) || '';
      if (!byFam[fam]) byFam[fam] = {};
      var brand = (r.brands && r.brands[0]) || '';
      if (!byFam[fam][brand]) byFam[fam][brand] = [];
      byFam[fam][brand].push(r);
    });
    Object.keys(byFam).sort().forEach(function (fam) {
      var brands = [];
      Object.keys(byFam[fam]).sort().forEach(function (brand) {
        brands.push({ brand: brand, label: brandLabel(brand), records: byFam[fam][brand] });
      });
      groups.push({ family: fam, label: familyLabel(fam), brands: brands, count: brands.reduce(function (n, b) { return n + b.records.length; }, 0) });
    });
    return groups;
  }

  return {
    FAMILY_LABELS: FAMILY_LABELS,
    familyLabel: familyLabel,
    brandLabel: brandLabel,
    statusLabel: statusLabel,
    stateChip: stateChip,
    changeLabels: changeLabels,
    errorField: errorField,
    originLabel: originLabel,
    sourceLabel: sourceLabel,
    safeUrl: safeUrl,
    filterRecords: filterRecords,
    groupByFamilyBrand: groupByFamilyBrand,
  };
});
