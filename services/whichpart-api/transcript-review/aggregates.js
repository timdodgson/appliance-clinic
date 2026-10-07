'use strict';

/**
 * Deterministic counts from stored LLM classifications.
 * Does not inspect transcript text.
 */

const eligibility = require('./eligibility');
const schema = require('./schema');

function bump(map, key) {
  if (!key) return;
  map[key] = (map[key] || 0) + 1;
}

function emptyEnumCounts(values) {
  const o = {};
  for (const v of values) o[v] = 0;
  return o;
}

function fromRecords(records, now) {
  const rows = Array.isArray(records) ? records : [];
  const overall = emptyEnumCounts(schema.OVERALL);
  const outcome = emptyEnumCounts(schema.OUTCOME);
  const priority = emptyEnumCounts(schema.PRIORITY);
  const productAreas = {};
  let reviewed = 0;
  let awaiting = 0;
  let failed = 0;
  let loopingSignificant = 0;
  let safetyConcern = 0;
  for (const rec of rows) {
    const disp = eligibility.displayReviewStatus(rec, now);
    if (disp === 'awaiting') awaiting += 1;
    if (disp === 'failed') failed += 1;
    if (disp !== 'reviewed') continue;
    reviewed += 1;
    const a = rec.review && rec.review.assessment;
    if (!a) continue;
    bump(overall, a.overallAssessment);
    bump(outcome, a.outcome);
    bump(priority, a.reviewPriority);
    if (a.looping === 'significant') loopingSignificant += 1;
    if (a.safetyHandling === 'concern') safetyConcern += 1;
    for (const area of a.suggestedProductAreas || []) bump(productAreas, area);
  }
  const productAreaList = Object.keys(productAreas)
    .sort((a, b) => productAreas[b] - productAreas[a] || a.localeCompare(b))
    .map((area) => ({ area: area, count: productAreas[area] }));
  return {
    sampleSize: rows.length,
    reviewed: reviewed,
    awaiting: awaiting,
    failed: failed,
    overall: overall,
    outcome: outcome,
    priority: priority,
    loopingSignificant: loopingSignificant,
    safetyConcern: safetyConcern,
    productAreas: productAreaList,
    note: 'Counts are exact tallies of stored LLM reviews in this sample. They are not statistical significance.',
  };
}

module.exports = { fromRecords };
