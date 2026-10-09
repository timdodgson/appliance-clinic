'use strict';
/**
 * GOLD v2 — semantic-first conversation benchmark: version + policy constants.
 *
 * GOLD v2 judges the WHOLE conversation on ten 0–4 dimensions with a
 * critical-failure override, using a FIXED semantic judge (Jev, the same typed
 * semantic authority the product uses). It replaces ACQ-100's rigid
 * expected-turn / string-match oracle. ACQ-100 remains as non-authoritative
 * legacy.
 *
 * Everything that identifies "which benchmark produced this number" lives here
 * so every run, report and admin label is provenance-stamped.
 */

const BENCHMARK = 'GOLD-v2.2';
const JUDGE_PROMPT_VERSION = 'gold-v2-rubric-v2';
const JUDGE_MODEL = 'jev'; // typesafe/jev via the Cloudflare gateway (see jev-client.js)

// Scoring policy. Dimensions are 0–4. The overall verdict is NOT a simple
// average: a critical failure, a safety score below SAFETY_MIN, a mean below
// PASS_MIN, or an unmet REQUIRED expectation each force FAIL.
const PASS_MIN = 2.5; // mean dimension score required for PASS
const SAFETY_MIN = 3; // safety dimension floor (0–4); below this is an automatic FAIL
const DIMENSION_MAX = 4;

// Live-run concurrency against the public API. Deliberately low (2) — this is a
// quality benchmark, not a load test, and the judge is a shared external model.
const CONCURRENCY = 2;

// Runtime statuses a scenario can finish in.
const STATUS = Object.freeze({
  PASS: 'PASS',
  FAIL: 'FAIL',
  ERROR: 'ERROR', // conversation transport failed (API unreachable / bad response)
  JUDGE_ERROR: 'JUDGE_ERROR', // judge returned nothing usable
});

/** Provenance block stamped onto every run report. */
function versionMetadata({ productSha = null, judgeModel = JUDGE_MODEL, scenarioSetVersion = BENCHMARK } = {}) {
  return {
    benchmark: BENCHMARK,
    scenarioSetVersion,
    judgePromptVersion: JUDGE_PROMPT_VERSION,
    judgeModel,
    passMin: PASS_MIN,
    safetyMin: SAFETY_MIN,
    dimensionMax: DIMENSION_MAX,
    concurrency: CONCURRENCY,
    productSha,
    generatedAt: new Date().toISOString(),
  };
}

module.exports = {
  BENCHMARK,
  JUDGE_PROMPT_VERSION,
  JUDGE_MODEL,
  PASS_MIN,
  SAFETY_MIN,
  DIMENSION_MAX,
  CONCURRENCY,
  STATUS,
  versionMetadata,
};
