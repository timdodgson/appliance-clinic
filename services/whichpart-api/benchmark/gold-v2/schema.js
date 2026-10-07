'use strict';
/**
 * GOLD v2 scenario loader + validator.
 *
 * A GOLD v2 scenario is a CURATED owner journey described semantically. It
 * deliberately has NO exact assistant script — the judge evaluates the whole
 * conversation against the rubric, it does not diff against a gold reply.
 *
 * Each scenario:
 *   id                 unique, G2-<FAM>-NN
 *   family             one of the nine appliance families
 *   shape              journey-shape label (diversity bookkeeping)
 *   opener             the customer's first message
 *   customerTurns[]    scripted follow-up turns, in order (strings)
 *   facts[]            ground-truth facts the simulator may rely on
 *   safetyRequirements[] safety behaviours the assistant must honour
 *   journeyExpectations[] what a good journey does (soft, fold into dims)
 *   acceptableOutcomes[]  any of these is a satisfactory ending
 *   criticalFailures[] behaviours that force FAIL regardless of scores
 *   judgeNotes         free-text guidance for the judge
 */

const fs = require('fs');
const path = require('path');

const SCENARIOS_PATH = path.join(__dirname, 'scenarios.v2_0.json');

const EXPECTED_FAMILY_DISTRIBUTION = Object.freeze({
  'washing-machine': 8,
  'washer-dryer': 4,
  'tumble-dryer': 6,
  dishwasher: 6,
  'fridge-freezer': 6,
  'oven-cooker': 6,
  hobs: 4,
  microwave: 5,
  vacuum: 5,
});

const REQUIRED_SCENARIO_FIELDS = [
  'id', 'family', 'shape', 'opener', 'customerTurns', 'facts',
  'safetyRequirements', 'journeyExpectations', 'acceptableOutcomes',
  'criticalFailures', 'judgeNotes',
];

// Fields that would reintroduce rigid exact-reply matching. None may appear.
const FORBIDDEN_SCRIPT_FIELDS = [
  'expectedReply', 'expectedAssistant', 'assistantScript', 'goldReply',
  'script', 'expectedTurns', 'expectedResponse', 'mustInclude', 'mustContain',
];

const STRING_ARRAY_FIELDS = [
  'customerTurns', 'facts', 'safetyRequirements', 'journeyExpectations',
  'acceptableOutcomes', 'criticalFailures',
];

/** Validate a parsed scenario-set object, throwing on the first problem. */
function validateScenarioSet(data) {
  if (!data || typeof data !== 'object') throw new Error('scenario set is not an object');
  if (data.scenarioSetVersion !== 'GOLD-v2.0') {
    throw new Error(`unexpected scenarioSetVersion: ${data.scenarioSetVersion}`);
  }
  if (!Array.isArray(data.scenarios)) throw new Error('scenarios is not an array');
  if (data.scenarios.length !== 50) {
    throw new Error(`expected 50 scenarios, found ${data.scenarios.length}`);
  }

  const ids = new Set();
  const famCounts = {};
  for (const s of data.scenarios) {
    for (const f of REQUIRED_SCENARIO_FIELDS) {
      if (!(f in s)) throw new Error(`scenario ${s.id || '?'} missing field: ${f}`);
    }
    for (const f of FORBIDDEN_SCRIPT_FIELDS) {
      if (f in s) throw new Error(`scenario ${s.id} has forbidden exact-script field: ${f}`);
    }
    if (typeof s.id !== 'string' || !/^G2-[A-Z]+-\d{2}$/.test(s.id)) {
      throw new Error(`scenario has malformed id: ${s.id}`);
    }
    if (ids.has(s.id)) throw new Error(`duplicate scenario id: ${s.id}`);
    ids.add(s.id);
    if (typeof s.opener !== 'string' || !s.opener.trim()) {
      throw new Error(`scenario ${s.id} has empty opener`);
    }
    for (const f of STRING_ARRAY_FIELDS) {
      if (!Array.isArray(s[f]) || s[f].some((x) => typeof x !== 'string')) {
        throw new Error(`scenario ${s.id} field ${f} must be an array of strings`);
      }
    }
    if (!s.criticalFailures.length) throw new Error(`scenario ${s.id} has no criticalFailures`);
    if (!s.journeyExpectations.length) throw new Error(`scenario ${s.id} has no journeyExpectations`);
    if (!(s.family in EXPECTED_FAMILY_DISTRIBUTION)) {
      throw new Error(`scenario ${s.id} has unknown family: ${s.family}`);
    }
    famCounts[s.family] = (famCounts[s.family] || 0) + 1;
  }

  for (const [fam, want] of Object.entries(EXPECTED_FAMILY_DISTRIBUTION)) {
    if ((famCounts[fam] || 0) !== want) {
      throw new Error(`family ${fam}: expected ${want}, found ${famCounts[fam] || 0}`);
    }
  }
  return data;
}

/** Load + validate the on-disk scenario set (or a provided object, for tests). */
function loadScenarios(data) {
  const parsed = data || JSON.parse(fs.readFileSync(SCENARIOS_PATH, 'utf8'));
  return validateScenarioSet(parsed);
}

module.exports = {
  SCENARIOS_PATH,
  EXPECTED_FAMILY_DISTRIBUTION,
  REQUIRED_SCENARIO_FIELDS,
  FORBIDDEN_SCRIPT_FIELDS,
  validateScenarioSet,
  loadScenarios,
};
