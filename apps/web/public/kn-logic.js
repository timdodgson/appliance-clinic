/*
 * Knowledge inspector — pure list/search helpers (no DOM, no diagnosis), plus the Admin-wide unsaved-changes guard.
 * Knowledge is read-only in the Admin (ADR 0019). Not used by customer diagnosis.
 */
(/** @param {any} root @param {() => any} factory */ function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.KnLogic = api;
})(typeof window !== 'undefined' ? window : typeof global !== 'undefined' ? global : this, function () {
  'use strict';

  var FAMILIES = [
    'washing-machine', 'washer-dryer', 'tumble-dryer', 'dishwasher',
    'oven-cooker', 'hobs', 'fridge-freezer', 'microwave', 'vacuum',
  ];

  function familyLabel(family) {
    return String(family || '').replace(/-/g, ' ').replace(/\b\w/g, function (c) { return c.toUpperCase(); });
  }

  function filterRecords(records, opts) {
    opts = opts || {};
    var q = String(opts.q || '').trim().toLowerCase();
    var family = opts.family || '';
    return (records || []).filter(function (r) {
      if (family && r.applianceFamily !== family) return false;
      if (!q) return true;
      var hay = String(r.searchText || [
        r.knowledgeId, r.faultId, r.label, r.applianceFamily,
        (r.symptomPreview || []).join(' '),
        (r.likelyComponents || []).join(' '),
      ].join('\n')).toLowerCase();
      return hay.indexOf(q) !== -1;
    });
  }

  function groupByFamily(records) {
    var groups = [];
    var by = {};
    FAMILIES.forEach(function (f) { by[f] = []; });
    (records || []).forEach(function (r) {
      if (!by[r.applianceFamily]) by[r.applianceFamily] = [];
      by[r.applianceFamily].push(r);
    });
    FAMILIES.forEach(function (f) {
      if (by[f] && by[f].length) groups.push({ family: f, label: familyLabel(f), records: by[f] });
    });
    Object.keys(by).forEach(function (f) {
      if (FAMILIES.indexOf(f) === -1 && by[f].length) {
        groups.push({ family: f, label: familyLabel(f), records: by[f] });
      }
    });
    return groups;
  }



  function safetyLabel(classification) {
    if (!classification) return null;
    if (classification === 'STOP_USE') return 'Stop use';
    if (classification === 'MAINTENANCE_SAFETY') return 'Maintenance safety';
    return String(classification).replace(/_/g, ' ');
  }

  function orderComponents(record) {
    record = record || {};
    var components = record.components || [];
    var likely = record.likelyComponents || [];
    var byKey = {};
    components.forEach(function (c) {
      byKey[String(c.partName || c.name || '').toLowerCase()] = c;
    });
    var seen = {};
    var out = [];
    likely.forEach(function (name, i) {
      var key = String(name || '').toLowerCase();
      var c = byKey[key];
      out.push(Object.assign({ rank: i + 1, name: name }, c || {}));
      if (!out[out.length - 1].name) out[out.length - 1].name = name;
      seen[key] = true;
    });
    components.forEach(function (c) {
      var key = String(c.partName || c.name || '').toLowerCase();
      if (!seen[key]) out.push(c);
    });
    return out;
  }


  // Admin-wide lifecycle vocabulary (same chips as Error Codes and Media, and as the "Live" marker in
  // every version history): Draft · not live / Live / Live · draft pending / Archived. The server's
  // stateLabel ("Published", "Draft changes pending") is the same state under an older name.
  function stateChip(rec) {
    rec = rec || {};
    var state = rec.state || 'published';
    var label = state === 'draft' ? 'Draft · not live' : state === 'archived' ? 'Archived'
      : (rec.draftPending ? 'Live · draft pending' : 'Live');
    var cls = 'kn-state kn-state--' + (state === 'published' && rec.draftPending ? 'pending' : state);
    return { label: label, cls: cls };
  }




  // Unsaved-changes guard for leaving an Admin editor (Media, Error Codes, Safety, Settings) via the sidebar, in-page links,
  // browser Back). deps: isDirty() -> bool, ask(done(leave)) shows the Stay / Leave choice,
  // discard() drops the editor state. leave(proceed, stay) runs proceed immediately when clean.
  var LEAVE_TEXT = {
    title: 'Leave without saving?',
    body: 'You have unsaved changes. If you leave now they will be lost. Your saved draft and the live content are not affected.',
    stay: 'Stay on this page',
    leave: 'Leave without saving',
  };
  function createLeaveGuard(deps) {
    var asking = false;
    function leave(proceed, stay) {
      if (!deps.isDirty()) { proceed(); return false; }
      if (asking) return true;
      asking = true;
      deps.ask(function (ok) {
        asking = false;
        if (ok) { deps.discard(); proceed(); } else if (stay) stay();
      });
      return true;
    }
    return { leave: leave, isAsking: function () { return asking; } };
  }









  return {
    LEAVE_TEXT: LEAVE_TEXT,
    createLeaveGuard: createLeaveGuard,
    stateChip: stateChip,
    familyLabel: familyLabel,
    filterRecords: filterRecords,
    groupByFamily: groupByFamily,
    safetyLabel: safetyLabel,
    orderComponents: orderComponents,
  };
});
