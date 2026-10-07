'use strict';
/**
 * ACQ-100 grading + run aggregation + compare maths.
 *
 * gradeJourney: turns one simulator journey-run (+ its gold, + optional judge
 * dimension scores) into a per-journey result: 0-100 quality, dimension scores,
 * hard violations (separate), efficiency/turn metrics, latency, notJudged flags.
 *
 * aggregateRun: rolls per-journey results into the run-level primary metrics.
 *
 * compareRuns: produces BETTER / WORSE / SAME(within tolerance) per metric with
 * a correctness/safety-guarded decision framework (never crown a winner on
 * overall score alone).
 */

const S = require('./acq-scoring.js');

function gradeJourney(run, gold, judgeScores) {
  const transcript = run.transcript || [];
  const finalView = transcript.length ? transcript[transcript.length - 1].view : null;

  const eff = S.gradeEfficiency(transcript, gold, run.outcomeTurnIndex);
  const correctness = S.scoreCorrectness(finalView, gold, eff);
  const efficiency = S.scoreEfficiency(eff, gold);
  const questionDet = S.scoreQuestionDeterministic(transcript, gold, eff);
  const grounding = S.scoreGrounding(finalView, gold);
  const safety = S.scoreSafety(transcript, gold);
  const hardViolations = S.detectHardViolations(transcript, finalView, gold);

  const { quality, dimensions, notJudged } = S.combineQuality(
    { correctness, efficiency, questionDet, grounding, safety },
    judgeScores || null,
  );

  return {
    journeyId: run.journeyId,
    family: run.family,
    quality,
    dimensions,
    notJudged,
    hardViolations,
    // efficiency / turn metrics
    reachedOutcome: eff.reachedOutcome,
    turnsToOutcome: eff.turnsToOutcome,
    assistantTurns: eff.assistantTurns,
    totalTurns: eff.totalTurns,
    firstResponseResolution: eff.firstResponseResolution,
    maxTurnExceeded: eff.maxTurnExceeded,
    clarifications: eff.clarifications,
    usefulClarifications: eff.usefulClarifications,
    unnecessaryClarifications: eff.unnecessaryClarifications,
    // latency (customer-perceived; internal stage split NOT AVAILABLE)
    perTurnLatencyMs: run.perTurnLatencyMs || [],
    firstResponseMs: run.firstResponseMs,
    totalElapsedMs: run.totalElapsedMs,
    stopReason: run.stopReason,
    // scoring detail (for per-journey drill-down)
    detail: { correctness: correctness.detail, efficiency: efficiency.detail, question: questionDet.detail, grounding: grounding.detail, safety: safety.detail },
  };
}

function mean(nums) { const v = nums.filter((n) => typeof n === 'number' && isFinite(n)); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; }
function rate(count, total) { return total ? Math.round((count / total) * 1000) / 10 : 0; }

/** Roll per-journey results into run-level metrics. */
function aggregateRun(results) {
  const n = results.length;
  const withOutcome = results.filter((r) => r.reachedOutcome);
  const turns = withOutcome.map((r) => r.turnsToOutcome).filter((t) => typeof t === 'number').sort((a, b) => a - b);
  const totalClar = results.reduce((a, r) => a + (r.clarifications || 0), 0);
  const unnecessary = results.reduce((a, r) => a + (r.unnecessaryClarifications || 0), 0);
  const hardViolationList = [];
  for (const r of results) for (const v of (r.hardViolations || [])) hardViolationList.push({ journeyId: r.journeyId, violation: v });

  const dimAvg = {};
  for (const k of Object.keys(S.WEIGHTS)) dimAvg[k] = round1(mean(results.map((r) => r.dimensions[k])));

  return {
    journeyCount: n,
    quality: round1(mean(results.map((r) => r.quality))),
    dimensions: dimAvg,
    correctness: dimAvg.DIAGNOSTIC_CORRECTNESS,
    hardViolations: hardViolationList.length,
    hardViolationList,
    // turn efficiency to correct grounded outcome
    correctOutcomeRate: rate(withOutcome.length, n),
    meanTurnsToOutcome: round2(mean(turns)),
    medianTurnsToOutcome: S.percentile(turns, 50),
    p90TurnsToOutcome: S.percentile(turns, 90),
    firstResponseResolutionRate: rate(results.filter((r) => r.firstResponseResolution).length, n),
    unnecessaryQuestionRate: rate(unnecessary, Math.max(1, totalClar)),
    maxTurnExceeded: results.filter((r) => r.maxTurnExceeded).length,
    // latency (customer-perceived)
    latency: S.aggregateLatency(results),
    // token/cost — honest availability
    tokenUsage: 'NOT AVAILABLE AT CUSTOMER BOUNDARY',
    apiCost: 'NOT AVAILABLE / NOT CONFIGURED',
    errors: results.filter((r) => r.stopReason === 'TRANSPORT_ERROR').length,
    // Judge coverage: when subjective dims were NOT judged (deterministic-only),
    // the quality score is NOT a fully-comparable 0-100 — the UI must flag this.
    judgedJourneys: results.filter((r) => r.judged).length,
    subjectiveJudged: results.some((r) => r.judged),
  };
}
function round1(x) { return typeof x === 'number' ? Math.round(x * 10) / 10 : x; }
function round2(x) { return typeof x === 'number' ? Math.round(x * 100) / 100 : x; }

/**
 * Compare two aggregated runs. Higher-is-better for quality/correctness/first-
 * response/dimensions; lower-is-better for turns/unnecessary-questions/latency/
 * hard-violations. Returns per-metric { a, b, delta, verdict } where verdict is
 * BETTER (b beats a), WORSE, or SAME (within tolerance).
 */
function compareRuns(a, b, opts = {}) {
  const tolPct = opts.tolerancePct != null ? opts.tolerancePct : 3; // within 3% = SAME
  const higher = ['quality', 'correctness', 'correctOutcomeRate', 'firstResponseResolutionRate'];
  const lower = ['meanTurnsToOutcome', 'medianTurnsToOutcome', 'p90TurnsToOutcome', 'unnecessaryQuestionRate', 'hardViolations'];
  const out = {};
  const cmp = (key, av, bv, higherBetter) => {
    if (av == null || bv == null) return { a: av, b: bv, delta: null, verdict: 'N/A' };
    const delta = Math.round((bv - av) * 100) / 100;
    const base = Math.abs(av) || 1;
    const within = Math.abs(delta) / base * 100 <= tolPct;
    let verdict;
    if (within) verdict = 'SAME';
    else if (higherBetter) verdict = bv > av ? 'BETTER' : 'WORSE';
    else verdict = bv < av ? 'BETTER' : 'WORSE';
    return { a: av, b: bv, delta, verdict };
  };
  for (const k of higher) out[k] = cmp(k, a[k], b[k], true);
  for (const k of lower) out[k] = cmp(k, a[k], b[k], false);
  // latency (customer-perceived response + complete conversation), lower better
  out.responseLatencyMean = cmp('responseLatencyMean', a.latency && a.latency.perTurnResponse && a.latency.perTurnResponse.mean, b.latency && b.latency.perTurnResponse && b.latency.perTurnResponse.mean, false);
  out.conversationElapsedMean = cmp('conversationElapsedMean', a.latency && a.latency.completeConversation && a.latency.completeConversation.mean, b.latency && b.latency.completeConversation && b.latency.completeConversation.mean, false);

  // Decision framework: b is a production improvement over a only if it does not
  // regress safety/correctness and does not add hard violations, AND it improves
  // quality OR efficiency meaningfully.
  const noNewHardViolations = (b.hardViolations || 0) <= (a.hardViolations || 0);
  const correctnessOk = out.correctness.verdict !== 'WORSE';
  const qualityUp = out.quality.verdict === 'BETTER';
  const efficiencyUp = out.meanTurnsToOutcome.verdict === 'BETTER' && out.quality.verdict !== 'WORSE';
  out._decision = {
    candidateIsImprovement: Boolean(noNewHardViolations && correctnessOk && (qualityUp || efficiencyUp)),
    noNewHardViolations, correctnessOk, qualityUp, efficiencyUp,
  };
  return out;
}

module.exports = { gradeJourney, aggregateRun, compareRuns, mean, rate, round1, round2 };
