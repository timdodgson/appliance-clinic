/*
 * Test Scenarios — pure library helpers (no DOM).
 *
 * A scenario describes a CUSTOMER SITUATION for deliberate probing.
 * Expected behaviour is semantic product behaviour, not regex/string scoring.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.CtsLogic = api;
})(typeof window !== 'undefined' ? window : typeof global !== 'undefined' ? global : this, function () {
  'use strict';

  var FAMILIES = ['washing-machine', 'washer-dryer', 'tumble-dryer', 'dishwasher', 'oven-cooker', 'hobs', 'fridge-freezer', 'microwave', 'vacuum'];
  var OUTCOMES = ['DIAGNOSIS', 'NORMAL', 'NO_PART', 'EXTERNAL', 'SAFETY_STOP'];
  var MAX_TURN_CHARS = 2000;
  var MAX_TITLE_CHARS = 160;
  var MAX_NOTE_CHARS = 4000;

  function trim(s) {
    return String(s == null ? '' : s).trim();
  }

  function cleanTurns(arr) {
    var out = [];
    (arr || []).forEach(function (t) {
      var v = trim(t);
      if (v) out.push(v);
    });
    return out;
  }

  function currentVersion(journey) {
    var vs = journey && journey.versions;
    if (!vs || !vs.length) return null;
    return vs.find(function (x) { return x.version === journey.currentVersion; }) || vs[vs.length - 1];
  }

  function customerTurnsFromVersion(version) {
    if (!version) return [];
    var stored = cleanTurns(version.turns);
    if (stored.length) return stored;
    var opening = trim(version.opening);
    return opening ? [opening] : [];
  }

  function customerJourney(journeyOrVersion) {
    var version = journeyOrVersion && journeyOrVersion.versions
      ? currentVersion(journeyOrVersion)
      : journeyOrVersion;
    var turns = customerTurnsFromVersion(version);
    return {
      opener: turns[0] || '',
      later: turns.slice(1),
      turns: turns,
      turnCount: turns.length,
    };
  }

  function suggestedLaterTurns(version) {
    var gold = (version && version.gold) || {};
    var journey = customerJourney(version);
    var seen = {};
    var later = [];
    function add(text) {
      var t = trim(text);
      if (!t) return;
      if (t === journey.opener) return;
      var key = t.toLowerCase();
      if (seen[key]) return;
      seen[key] = 1;
      later.push(t);
    }
    journey.later.forEach(add);
    (gold.scriptedFollowups || []).forEach(add);
    Object.keys(gold.simulatedAnswers || {}).forEach(function (k) {
      add(gold.simulatedAnswers[k]);
    });
    return later;
  }

  function openerPreview(text, max) {
    var t = trim(text);
    if (!t) return '';
    var limit = max || 110;
    if (t.length <= limit) return t;
    return t.slice(0, limit - 1).replace(/\s+\S*$/, '') + '\u2026';
  }

  function familyLabel(family) {
    return String(family || '').replace(/-/g, ' ').replace(/\b\w/g, function (c) { return c.toUpperCase(); });
  }

  function lifecycle(journey) {
    if (journey && journey.archived) return { key: 'retired', label: 'Retired' };
    if (journey && journey.enabled === false) return { key: 'disabled', label: 'Disabled' };
    return { key: 'active', label: 'Active' };
  }

  function coverageLabels(journey, version) {
    var gold = (version && version.gold) || {};
    var labels = [];
    var seen = {};
    function add(label) {
      var t = trim(label);
      if (!t || seen[t]) return;
      seen[t] = 1;
      labels.push(t);
    }
    (journey && journey.categories ? journey.categories : []).forEach(add);
    if (gold.mustSafetyStop || gold.expectedOutcome === 'SAFETY_STOP') add('Safety');
    if (gold.expectMedia) add('Media');
    if (gold.mustNotPart) add('No part yet');
    return labels;
  }

  function outcomeLabel(outcome) {
    var map = {
      DIAGNOSIS: 'Reach a useful diagnosis',
      NORMAL: 'Recognise normal behaviour',
      NO_PART: 'No part should be recommended yet',
      EXTERNAL: 'Point toward an external / professional issue',
      SAFETY_STOP: 'Stop use / professional-only',
    };
    return map[outcome] || trim(outcome);
  }

  function safetyExpectation(gold) {
    gold = gold || {};
    if (gold.mustSafetyStop || gold.expectedOutcome === 'SAFETY_STOP') {
      return 'Should stop use or treat this as professional-only.';
    }
    return 'Normal consumer checks are appropriate.';
  }

  function partsExpectation(gold) {
    gold = gold || {};
    if (gold.mustNotPart || gold.expectedOutcome === 'NO_PART' || gold.expectedOutcome === 'NORMAL' || gold.expectedOutcome === 'SAFETY_STOP') {
      return 'No part should be recommended yet.';
    }
    var suspects = (gold.goldSuspects || []).filter(Boolean);
    if (suspects.length) return 'Plausible leading component(s): ' + suspects.join(', ') + '.';
    return '';
  }

  function mediaExpectation(gold) {
    gold = gold || {};
    if (gold.expectMedia) return 'Helpful media is expected when it would actually help the customer.';
    return 'No media necessary.';
  }

  function validateScenario(input) {
    var errs = [];
    var title = trim(input && input.title);
    var family = trim(input && input.family);
    var turns = cleanTurns(input && input.turns);
    var gold = (input && input.gold) || {};
    if (!title) errs.push({ field: 'title', message: 'Name is required.' });
    else if (title.length > MAX_TITLE_CHARS) errs.push({ field: 'title', message: 'Name must be ' + MAX_TITLE_CHARS + ' characters or fewer.' });
    if (FAMILIES.indexOf(family) === -1) errs.push({ field: 'family', message: 'Choose a valid appliance family.' });
    if (!turns.length) errs.push({ field: 'turns', message: 'Add at least one customer opener.' });
    turns.forEach(function (t, i) {
      if (t.length > MAX_TURN_CHARS) errs.push({ field: 'turns', message: 'Customer turn ' + (i + 1) + ' is too long.' });
    });
    var rawTurns = (input && input.turns) || [];
    var blanks = rawTurns.filter(function (t) { return !trim(t); }).length;
    if (blanks && turns.length) errs.push({ field: 'turns', message: 'Remove blank customer turns before saving.' });
    if (OUTCOMES.indexOf(gold.expectedOutcome) === -1) errs.push({ field: 'outcome', message: 'Choose what behaviour this scenario is intended to exercise.' });
    if (gold.expectedOutcome === 'DIAGNOSIS' && !(gold.goldSuspects && gold.goldSuspects.length)) {
      errs.push({ field: 'suspects', message: 'Describe the leading diagnostic behaviour or component.' });
    }
    if (gold.followUpAppropriate && !trim(gold.followUpTargetFact)) {
      errs.push({ field: 'followTarget', message: 'Say what a useful follow-up should establish.' });
    }
    if (gold.idealTurns && gold.maxTurns && gold.idealTurns > gold.maxTurns) {
      errs.push({ field: 'turnsBudget', message: 'Ideal turns cannot exceed max turns.' });
    }
    var notes = trim(input && input.notes);
    if (notes.length > MAX_NOTE_CHARS) errs.push({ field: 'notes', message: 'Notes are too long.' });
    return errs;
  }

  function hasRegexScoring(text) {
    var s = String(text || '');
    return /regex must match|response contains|exact phrase equals|keyword count|string similarity/i.test(s);
  }

  return {
    FAMILIES: FAMILIES,
    OUTCOMES: OUTCOMES,
    MAX_TURN_CHARS: MAX_TURN_CHARS,
    trim: trim,
    cleanTurns: cleanTurns,
    currentVersion: currentVersion,
    customerTurnsFromVersion: customerTurnsFromVersion,
    customerJourney: customerJourney,
    suggestedLaterTurns: suggestedLaterTurns,
    openerPreview: openerPreview,
    familyLabel: familyLabel,
    lifecycle: lifecycle,
    coverageLabels: coverageLabels,
    outcomeLabel: outcomeLabel,
    safetyExpectation: safetyExpectation,
    partsExpectation: partsExpectation,
    mediaExpectation: mediaExpectation,
    validateScenario: validateScenario,
    hasRegexScoring: hasRegexScoring,
  };
});
