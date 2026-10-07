'use strict';
/**
 * ACQ-100 corpus loader + validator + distribution stats.
 * Pure/offline: reads the versioned JSON, validates each journey's shape, and
 * exposes coverage stats used by tests and the admin report.
 */
const fs = require('fs');
const path = require('path');

const CORPUS_PATH = path.join(__dirname, 'acq-100.v1.json');

function loadCorpus(file) {
  const raw = JSON.parse(fs.readFileSync(file || CORPUS_PATH, 'utf8'));
  if (!raw || !Array.isArray(raw.journeys)) throw new Error('ACQ corpus: journeys[] missing');
  return raw;
}

const VALID_OUTCOMES = new Set(['DIAGNOSIS', 'NORMAL', 'NO_PART', 'EXTERNAL', 'SAFETY_STOP']);
const FAMILIES = ['washing-machine', 'washer-dryer', 'tumble-dryer', 'dishwasher', 'oven-cooker', 'hobs', 'fridge-freezer', 'microwave', 'vacuum'];

/** Validate one journey; returns array of problems (empty = ok). */
function validateJourney(j) {
  const problems = [];
  if (!j.journeyId) problems.push('missing journeyId');
  if (!FAMILIES.includes(j.family)) problems.push(`bad family: ${j.family}`);
  if (!Array.isArray(j.turns) || !j.turns.length || !String(j.turns[0]).trim()) problems.push('missing opening turn');
  const g = j.gold || {};
  if (!VALID_OUTCOMES.has(g.expectedOutcome)) problems.push(`bad expectedOutcome: ${g.expectedOutcome}`);
  if (g.followUpAppropriate === true && !g.followUpTargetFact) problems.push('followUp appropriate but no followUpTargetFact');
  if (g.followUpAppropriate === true && !(g.simulatedAnswers || g.lateModel || g.scriptedFollowups)) problems.push('followUp appropriate but no simulatedAnswers/lateModel');
  if (g.expectedOutcome === 'DIAGNOSIS' && !(g.goldSuspects && g.goldSuspects.length)) problems.push('diagnosis journey has no goldSuspects');
  if (typeof g.maxTurns === 'number' && typeof g.idealTurns === 'number' && g.idealTurns > g.maxTurns) problems.push('idealTurns > maxTurns');
  return problems;
}

function validateCorpus(raw) {
  const all = [];
  for (const j of raw.journeys) {
    const p = validateJourney(j);
    if (p.length) all.push({ journeyId: j.journeyId, problems: p });
  }
  return all;
}

function distribution(raw) {
  const byFamily = {};
  const byCategory = {};
  let multiTurn = 0;
  let singleTurn = 0;
  for (const j of raw.journeys) {
    byFamily[j.family] = (byFamily[j.family] || 0) + 1;
    for (const c of (j.categories || [])) byCategory[c] = (byCategory[c] || 0) + 1;
    const g = j.gold || {};
    if (g.followUpAppropriate === true) multiTurn++; else singleTurn++;
  }
  return { total: raw.journeys.length, byFamily, byCategory, multiTurn, singleTurn };
}

module.exports = { CORPUS_PATH, loadCorpus, validateJourney, validateCorpus, distribution, VALID_OUTCOMES, FAMILIES };
