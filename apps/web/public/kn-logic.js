/*
 * Knowledge inspector — pure list/search helpers (no DOM, no diagnosis).
 * Admin catalogue discovery only. Not used by customer diagnosis.
 */
(function (root, factory) {
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

  function hubForFamily(hubs, family) {
    hubs = hubs || [];
    var key = String(family || '').replace(/-/g, ' ');
    return hubs.find(function (h) {
      return h.family === family || h.family === key || (h.slug || '').indexOf(String(family || '').split('-')[0]) === 0;
    }) || null;
  }

  function missing(label, value) {
    if (value == null || value === '' || (Array.isArray(value) && !value.length)) return label;
    return null;
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

  // ---- Knowledge management helpers (editor + state labels). Pure; no DOM, no network. ----
  var FIELD_LABELS = {
    label: 'Title', outcome: 'Outcome', provenance: 'Provenance', symptoms: 'Customer symptoms',
    components: 'Likely causes / components', likelyComponents: 'Likely parts in order',
    discriminators: 'Overview / engineering notes', clarifyingQuestion: 'Clarifying question', secondaryQuestion: 'Secondary question',
    adviceBeforeReplacement: 'Advice before replacement', commonConfusion: 'Common confusion',
    alternatives: 'Related topics', safetyInformation: 'Safety information',
    applianceFamily: 'Appliance', faultId: 'faultId',
  };
  var SAFETY_CLASSES = ['STOP_USE', 'DO_NOT_OPEN', 'EMERGENCY_ACTION', 'MAINTENANCE_SAFETY'];

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

  function emptyContent(family, faultId) {
    return {
      applianceFamily: family || '', faultId: faultId || '', label: '', outcome: 'PART_ROUTING', provenance: 'engineer',
      symptoms: [''], components: [], likelyComponents: [], discriminators: [], clarifyingQuestion: null,
      secondaryQuestion: null, adviceBeforeReplacement: [], commonConfusion: [], alternatives: [], safetyInformation: null,
    };
  }
  function emptyComponent() { return { name: '', type: 'part', partName: null, supports: [], against: [] }; }
  function emptyConfusion() { return { name: '', note: null, wouldApplyIf: [] }; }
  function emptySafety() { return { text: '', hazard: '', classification: '', applicability: '', provenance: [emptySafetySource()] }; }
  function emptySafetySource() { return { sourceType: '', publisher: '', title: null, url: '', retrieved: null }; }

  function clone(x) { return x == null ? x : JSON.parse(JSON.stringify(x)); }
  function splitPath(path) {
    return String(path || '').split('.').filter(function (p) { return p !== ''; }).map(function (p) {
      return /^\d+$/.test(p) ? Number(p) : p;
    });
  }
  function getPath(obj, path) {
    var parts = splitPath(path);
    var cur = obj;
    for (var i = 0; i < parts.length; i++) { if (cur == null) return undefined; cur = cur[parts[i]]; }
    return cur;
  }
  function setPath(obj, path, value) {
    var parts = splitPath(path);
    var cur = obj;
    for (var i = 0; i < parts.length - 1; i++) {
      if (cur[parts[i]] == null) cur[parts[i]] = typeof parts[i + 1] === 'number' ? [] : {};
      cur = cur[parts[i]];
    }
    cur[parts[parts.length - 1]] = value;
    return obj;
  }
  function listAdd(obj, path, item) {
    var list = getPath(obj, path);
    if (!Array.isArray(list)) { list = []; setPath(obj, path, list); }
    list.push(item);
    return list.length - 1;
  }
  function listRemove(obj, path, index) {
    var list = getPath(obj, path);
    if (Array.isArray(list) && index >= 0 && index < list.length) list.splice(index, 1);
  }
  function listMove(obj, path, index, dir) {
    var list = getPath(obj, path);
    var to = index + dir;
    if (!Array.isArray(list) || to < 0 || to >= list.length) return false;
    var t = list[index]; list[index] = list[to]; list[to] = t;
    return true;
  }
  // Same derivation the server/offline build uses for typed components.
  function deriveLikelyComponents(components) {
    var list = components || [];
    var typed = list.some(function (c) { return c.type || c.partName; });
    var out = [];
    list.forEach(function (c) {
      var name = typed ? ((c.type === 'part' || c.partName) ? (c.partName || c.name) : null) : c.name;
      name = String(name || '').trim();
      if (name && out.indexOf(name) === -1) out.push(name);
    });
    return out;
  }
  // Comparable form: trims strings and drops blank list rows, so an untouched form is not "dirty".
  function canonical(content) {
    function walk(v) {
      if (Array.isArray(v)) {
        return v.map(walk).filter(function (x) { return !(x === '' || x == null); });
      }
      if (v && typeof v === 'object') {
        var o = {};
        Object.keys(v).sort().forEach(function (k) { o[k] = walk(v[k]); });
        return o;
      }
      if (typeof v === 'string') { var t = v.trim(); return t === '' ? null : t; }
      return v == null ? null : v;
    }
    return JSON.stringify(walk(content || {}));
  }
  function isDirty(a, b) { return canonical(a) !== canonical(b); }
  function changeSummary(fields) {
    return (fields || []).map(function (f) { return FIELD_LABELS[f] || f; });
  }
  // Server error field "components[0].supports[2]" → editor path "components.0.supports.2".
  function errorPath(field) { return String(field || '').replace(/\[(\d+)\]/g, '.$1'); }
  function versionLabel(v) {
    if (!v) return '';
    if (v.version === 0) return 'Baseline (shipped)';
    return 'v' + v.version + (v.source === 'rollback' ? ' · rollback to ' + (v.rolledBackFrom === 0 ? 'baseline' : 'v' + v.rolledBackFrom) : '');
  }
  function publishConfirmText(label, nextVersion, changes, isNew) {
    var lines = ['Publish “' + (label || 'this record') + '” as v' + nextVersion + '?', ''];
    lines.push(isNew
      ? 'This adds a new topic to live diagnosis.'
      : 'This replaces the live version in diagnosis.');
    if (changes && changes.length) lines.push('Changes: ' + changeSummary(changes).join(', ') + '.');
    lines.push('', 'ApplianceClinic embeds the text and only reports success once production has loaded it.');
    return lines.join('\n');
  }
  function rollbackConfirmText(label, toVersion, nextVersion) {
    var from = toVersion === 0 ? 'the shipped baseline' : 'v' + toVersion;
    return 'Roll back “' + (label || 'this record') + '” to ' + from + '?\n\nThis creates v' + nextVersion
      + ' with the content of ' + from + ' and makes it live. All earlier versions stay in history.';
  }

  // Catalogue-backed = the record exists in the shipped baseline (origin/hasBaseline from the server).
  // Only an explicitly Admin-created, overlay-only record counts as not catalogue-backed; anything
  // ambiguous (missing admin metadata) gets the stronger warning.
  function isCatalogueBacked(admin) {
    return !(admin && admin.origin === 'admin' && admin.hasBaseline === false);
  }
  function archiveConfirmText(label, admin) {
    var head = 'Archive “' + (label || 'this record') + '”?';
    if (isCatalogueBacked(admin)) {
      return head + '\n\nThis is a shipped catalogue-backed record. Archiving removes its diagnostic knowledge from the live engine. '
        + 'The fault and its journey still exist, but ApplianceClinic will no longer retrieve this Knowledge record when diagnosing it.'
        + '\n\nVersion history is kept and you can restore it.';
    }
    return head + '\n\nIt stops being used in live diagnosis. Its version history is kept and it can be restored.';
  }

  // Unsaved-changes guard for leaving the Knowledge editor inside Admin (sidebar, in-page links,
  // browser Back). deps: isDirty() -> bool, ask(done(leave)) shows the Stay / Leave choice,
  // discard() drops the editor state. leave(proceed, stay) runs proceed immediately when clean.
  var LEAVE_TEXT = {
    title: 'Leave without saving?',
    body: 'You have unsaved Knowledge changes. If you leave now they will be lost. Your saved draft and the live knowledge are not affected.',
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

  // ---- Authoring helpers (guided create, quick lists, cause cards, readiness, publish review) ----
  // Placeholder examples only; placeholders are never saved.
  var GENERIC_EXAMPLES = {
    symptoms: ['won’t start', 'stops part way through', 'makes a grinding noise'],
    cause: 'e.g. door switch', evidence: 'e.g. only happens when the door is opened', advice: 'e.g. check the plug and fuse first',
    question: 'e.g. Does it fail straight away or part way through?', confusion: 'e.g. a tripped fuse',
  };
  var FAMILY_EXAMPLES = {
    'washing-machine': { symptoms: ['water left in drum', 'won’t pump out', 'stops before spin'], cause: 'e.g. drain pump', evidence: 'e.g. pump hums but water does not move', advice: 'e.g. clean the pump filter first', question: 'e.g. Can you hear the pump running when it should drain?', confusion: 'e.g. a blocked sink waste' },
    'washer-dryer': { symptoms: ['clothes still damp after drying', 'drying takes hours', 'water left in drum'], cause: 'e.g. condenser', evidence: 'e.g. drum is warm but clothes stay damp', advice: 'e.g. dry a smaller load', question: 'e.g. Is there any heat during the drying stage?', confusion: 'e.g. overloading' },
    'tumble-dryer': { symptoms: ['no heat', 'clothes still damp', 'drum not turning'], cause: 'e.g. heating element', evidence: 'e.g. drum turns but air is cold', advice: 'e.g. clean the lint filter and condenser', question: 'e.g. Does the drum turn but stay cold?', confusion: 'e.g. a full water container' },
    'dishwasher': { symptoms: ['water left in the bottom', 'won’t pump out', 'stops mid cycle and beeps'], cause: 'e.g. drain pump', evidence: 'e.g. pump hums but water stays', advice: 'e.g. clean the filter in the base', question: 'e.g. Is there water in the bottom after the cycle?', confusion: 'e.g. a kinked drain hose' },
    'oven-cooker': { symptoms: ['oven not heating', 'fan runs but no heat', 'takes ages to cook'], cause: 'e.g. fan oven element', evidence: 'e.g. fan runs but the cavity stays cold', advice: 'e.g. check the clock or timer is set', question: 'e.g. Does the grill still work?', confusion: 'e.g. the clock not being set' },
    'hobs': { symptoms: ['one ring not working', 'hob won’t turn on', 'ring stays on full'], cause: 'e.g. hotplate element', evidence: 'e.g. only one zone affected', advice: 'e.g. check the child lock', question: 'e.g. Is it one zone or the whole hob?', confusion: 'e.g. child lock on' },
    'fridge-freezer': { symptoms: ['fridge not cold', 'freezer frosting up', 'water inside the fridge'], cause: 'e.g. thermostat', evidence: 'e.g. compressor runs but fridge stays warm', advice: 'e.g. clear the back vent of food', question: 'e.g. Is the freezer cold while the fridge is warm?', confusion: 'e.g. door left ajar' },
    'microwave': { symptoms: ['runs but doesn’t heat', 'sparking inside', 'turntable not turning'], cause: 'e.g. magnetron', evidence: 'e.g. lights and turntable work but food stays cold', advice: 'e.g. check the door closes fully', question: 'e.g. Does the turntable turn while it runs?', confusion: 'e.g. metal in the cavity' },
    'vacuum': { symptoms: ['lost suction', 'cuts out after a few minutes', 'smells of burning'], cause: 'e.g. blocked filter', evidence: 'e.g. suction returns after cleaning the filter', advice: 'e.g. empty the bin and wash the filters', question: 'e.g. Does it cut out and restart after cooling?', confusion: 'e.g. a full bin' },
  };
  function examplesFor(family) { return FAMILY_EXAMPLES[family] || GENERIC_EXAMPLES; }

  // Short plain-English help for fields whose purpose is not obvious.
  var HELP = {
    label: 'The topic as an engineer would name it. Customers do not see this verbatim.',
    overview: 'A plain explanation of the fault and the facts that tell it apart from similar faults. One note per line.',
    symptoms: 'Phrases customers actually use. Press Enter after each one, or paste a list (one per line).',
    causes: 'In initial diagnostic order. Check = inspect or clean first, not a part to sell. Part = a replacement component.',
    supports: 'Evidence that makes this cause more likely.',
    against: 'Evidence that makes this cause less likely.',
    likelyComponents: 'Parts used for part ranking, in order. Pure checks are not parts.',
    clarifyingQuestion: 'A question that helps separate two or more likely causes.',
    secondaryQuestion: 'Asked if the first question did not settle it.',
    advice: 'Checks or fixes to try before recommending a replacement part.',
    confusion: 'Something this fault is often mistaken for.',
    wouldApplyIf: 'Only consider it if this is true.',
    alternatives: 'Other topics on the same appliance this is easily confused with. Use their topic id.',
    outcome: 'Suggest parts when a replacement is a likely fix. Advice only when the fix is a setting, usage or cleaning.',
    safety: 'Pre-written safety text shown to customers verbatim. Every statement needs a source.',
    provenance: 'Where this knowledge came from.',
  };

  var FAULT_ID_RE = /^[a-z0-9][a-z0-9-]{1,63}$/; // mirrors the server rule
  function slugify(s) {
    return String(s || '').toLowerCase().replace(/['’]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64);
  }
  // Pasted / typed text → list items. One item per line; bullets and numbering stripped; blanks dropped.
  // Only ever used for flat text lists, never nested structures.
  function splitLines(text) {
    return String(text == null ? '' : text).split(/\r?\n/).map(function (l) {
      return l.replace(/^\s*(?:[-*•·]|\d+[.)])\s+/, '').trim();
    }).filter(Boolean);
  }
  function isMultiLine(text) { return splitLines(text).length > 1; }
  function nonBlank(list) { return (list || []).filter(function (x) { return String(x == null ? '' : x).trim(); }); }

  function causeSummary(c) {
    c = c || {};
    var name = String(c.name || '').trim();
    var f = nonBlank(c.supports).length;
    var a = nonBlank(c.against).length;
    var warnings = [];
    if (!name) warnings.push('No name');
    if (!f && !a) warnings.push('No evidence');
    if (!c.type) warnings.push('Part or check not set');
    return {
      label: name || 'Unnamed cause',
      type: c.type === 'part' ? 'Part' : (c.type === 'check' ? 'Check' : null),
      forCount: f, againstCount: a, warnings: warnings,
      countsText: f + ' FOR · ' + a + ' AGAINST',
    };
  }

  // Non-blocking authoring suggestions. Never block publish — the server decides that.
  function suggestions(c) {
    c = c || {};
    var out = [];
    (c.components || []).forEach(function (comp, i) {
      var s = causeSummary(comp);
      if (!String(comp.name || '').trim()) return;
      if (s.warnings.indexOf('No evidence') !== -1) out.push({ field: 'components[' + i + ']', message: 'Cause “' + s.label + '” has no FOR or AGAINST evidence' });
      if (!comp.type) out.push({ field: 'components[' + i + '].type', message: 'Cause “' + s.label + '”: choose Part or Check' });
    });
    if (!nonBlank(c.discriminators).length) out.push({ field: 'discriminators', message: 'No overview / engineering notes yet' });
    if (!String(c.clarifyingQuestion || '').trim()) out.push({ field: 'clarifyingQuestion', message: 'No clarifying question yet' });
    if (!nonBlank(c.adviceBeforeReplacement).length) out.push({ field: 'adviceBeforeReplacement', message: 'No advice before replacing a part' });
    return out;
  }

  // Readiness = the server's publish validation (authoritative) + plain counts + suggestions.
  function readiness(c, serverErrors) {
    c = c || {};
    var errs = serverErrors || [];
    var bad = function (prefix) { return errs.some(function (e) { return String(e.field || '').indexOf(prefix) === 0; }); };
    var n = function (list) { return nonBlank(list).length; };
    var causes = (c.components || []).filter(function (x) { return String((x && x.name) || '').trim(); }).length;
    var si = c.safetyInformation;
    var checks = [
      { ok: !!String(c.label || '').trim() && !bad('label'), label: String(c.label || '').trim() ? 'Title' : 'No title' },
      { ok: n(c.discriminators) > 0, soft: true, label: n(c.discriminators) ? 'Overview' : 'No overview' },
      { ok: n(c.symptoms) > 0 && !bad('symptoms'), label: n(c.symptoms) ? n(c.symptoms) + ' customer symptom' + (n(c.symptoms) === 1 ? '' : 's') : 'No customer symptoms' },
      { ok: causes > 0 && !bad('components'), soft: true, label: causes ? causes + ' likely cause' + (causes === 1 ? '' : 's') : 'No likely causes' },
    ];
    if (si) checks.push({ ok: !bad('safetyInformation'), label: bad('safetyInformation') ? 'Safety information incomplete' : 'Safety information sourced' });
    if (n(c.alternatives)) checks.push({ ok: !bad('alternatives'), label: bad('alternatives') ? 'Related topics need fixing' : 'Related topics valid' });
    return { ready: errs.length === 0, checks: checks, errors: errs, suggestions: suggestions(c) };
  }

  var SECTION_OF = {
    applianceFamily: 'basic', faultId: 'basic', label: 'basic', outcome: 'basic', discriminators: 'basic',
    symptoms: 'customers', components: 'causes', likelyComponents: 'causes',
    clarifyingQuestion: 'questions', secondaryQuestion: 'questions', adviceBeforeReplacement: 'advice',
    safetyInformation: 'safety', commonConfusion: 'confusion', alternatives: 'related', provenance: 'advanced',
  };
  // Server error field → where it lives in the editor (section, which card to expand, input path).
  function errorTarget(field) {
    var path = errorPath(field);
    var root = path.split('.')[0];
    var m = /^components\.(\d+)/.exec(path);
    var c = /^commonConfusion\.(\d+)/.exec(path);
    return {
      path: path, section: SECTION_OF[root] || 'advanced',
      causeIndex: m ? Number(m[1]) : null, confusionIndex: c ? Number(c[1]) : null,
    };
  }
  function fieldLabel(field) {
    var t = errorTarget(field);
    var root = t.path.split('.')[0];
    var base = FIELD_LABELS[root] || root;
    if (t.causeIndex != null) base = 'Cause ' + (t.causeIndex + 1);
    if (t.confusionIndex != null) base = 'Common confusion ' + (t.confusionIndex + 1);
    return base;
  }

  // Compact pre-publish review from the draft (+ the server's changed-field list).
  function publishReview(content, admin) {
    content = content || {};
    admin = admin || {};
    var n = function (list) { return nonBlank(list).length; };
    var questions = (String(content.clarifyingQuestion || '').trim() ? 1 : 0) + (String(content.secondaryQuestion || '').trim() ? 1 : 0);
    return {
      title: content.label || admin.knowledgeId || '',
      family: familyLabel(content.applianceFamily),
      faultId: content.faultId || '',
      nextVersion: (admin.currentVersion || 0) + 1,
      isNew: !admin.everPublished,
      symptoms: n(content.symptoms),
      causes: (content.components || []).filter(function (x) { return String((x && x.name) || '').trim(); }).length,
      questions: questions,
      advice: n(content.adviceBeforeReplacement),
      safety: content.safetyInformation ? (safetyLabel(content.safetyInformation.classification) || 'Present') : null,
      outcome: content.outcome === 'ADVICE_ONLY' ? 'Advice only' : 'Suggest parts',
      changed: changeSummary(admin.pendingChanges || []),
    };
  }

  return {
    GENERIC_EXAMPLES: GENERIC_EXAMPLES,
    FAMILY_EXAMPLES: FAMILY_EXAMPLES,
    examplesFor: examplesFor,
    HELP: HELP,
    slugify: slugify,
    FAULT_ID_RE: FAULT_ID_RE,
    splitLines: splitLines,
    isMultiLine: isMultiLine,
    causeSummary: causeSummary,
    suggestions: suggestions,
    readiness: readiness,
    errorTarget: errorTarget,
    fieldLabel: fieldLabel,
    publishReview: publishReview,
    isCatalogueBacked: isCatalogueBacked,
    archiveConfirmText: archiveConfirmText,
    LEAVE_TEXT: LEAVE_TEXT,
    createLeaveGuard: createLeaveGuard,
    FIELD_LABELS: FIELD_LABELS,
    SAFETY_CLASSES: SAFETY_CLASSES,
    stateChip: stateChip,
    emptyContent: emptyContent,
    emptyComponent: emptyComponent,
    emptyConfusion: emptyConfusion,
    emptySafety: emptySafety,
    emptySafetySource: emptySafetySource,
    clone: clone,
    getPath: getPath,
    setPath: setPath,
    listAdd: listAdd,
    listRemove: listRemove,
    listMove: listMove,
    deriveLikelyComponents: deriveLikelyComponents,
    canonical: canonical,
    isDirty: isDirty,
    changeSummary: changeSummary,
    errorPath: errorPath,
    versionLabel: versionLabel,
    publishConfirmText: publishConfirmText,
    rollbackConfirmText: rollbackConfirmText,
    FAMILIES: FAMILIES,
    familyLabel: familyLabel,
    filterRecords: filterRecords,
    groupByFamily: groupByFamily,
    hubForFamily: hubForFamily,
    missing: missing,
    safetyLabel: safetyLabel,
    orderComponents: orderComponents,
  };
});
