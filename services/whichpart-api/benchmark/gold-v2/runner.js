'use strict';
/**
 * GOLD v2 runner: scripted customer simulator + concurrency-2 execution loop +
 * aggregation + reporting.
 *
 * CUSTOMER SIMULATOR (deliberately NOT an LLM):
 *   The simulator is fully SCRIPTED — it sends the scenario opener, then each
 *   scripted customerTurn in order. It never invents facts, never echoes the
 *   rubric, and never second-guesses the assistant. The scripted turns are the
 *   authoritative customer. This is the opposite of ACQ-100's keyword-intent
 *   simulator (which could become a second, brittle oracle). The only dynamic
 *   behaviour is stopping early if the assistant raises a genuine safety stop
 *   (continuing to script checks past a stop-use would be unrealistic).
 *
 * TRANSPORT (`callApi`) is INJECTED so this is unit-testable with no network.
 * The live transport (run-baseline.mjs) posts to the public JSON API.
 */

const V = require('./version.js');
const judgeMod = require('./judge.js');

/**
 * Drive one scripted conversation.
 * @param {object} scenario
 * @param {Function} callApi  async (messages) => view ({reply, needsModel, safety, parts, ...})
 * @returns {{transcript:Array, error?:string}}
 */
async function simulateConversation(scenario, callApi) {
  const scripted = [scenario.opener, ...scenario.customerTurns];
  const messages = [];
  const transcript = [];
  for (const userText of scripted) {
    messages.push({ role: 'user', content: userText });
    let view;
    try {
      view = await callApi(messages.slice());
    } catch (err) {
      return { transcript, error: String(err && err.message || err) };
    }
    const reply = (view && view.reply) || '';
    messages.push({ role: 'assistant', content: reply });
    transcript.push({ userText, view: view || {} });
    // Stop scripting further checks once the assistant raises a genuine stop-use.
    if (view && (view.safety === true || view.safetyStop)) break;
  }
  return { transcript };
}

/** Run + judge a single scenario, resolving to a result record. */
async function runScenario({ scenario, callApi, evaluate }) {
  const base = { id: scenario.id, family: scenario.family, shape: scenario.shape };
  const sim = await simulateConversation(scenario, callApi);
  const transcript = sim.transcript || [];
  if (sim.error || !transcript.length) {
    return { ...base, status: V.STATUS.ERROR, error: sim.error || 'empty conversation', transcript };
  }
  const verdict = await judgeMod.judgeConversation({ scenario, transcript, evaluate });
  if (verdict.status === V.STATUS.JUDGE_ERROR) {
    return { ...base, status: V.STATUS.JUDGE_ERROR, error: verdict.error, transcript };
  }
  return { ...base, status: verdict.status, verdict, transcript };
}

/** Fixed-size async pool (default concurrency from version.js = 2). */
async function runAll({ scenarios, callApi, evaluate, concurrency = V.CONCURRENCY, onProgress }) {
  const results = new Array(scenarios.length);
  let next = 0;
  let done = 0;
  async function worker() {
    for (;;) {
      const i = next;
      next += 1;
      if (i >= scenarios.length) return;
      results[i] = await runScenario({ scenario: scenarios[i], callApi, evaluate });
      done += 1;
      if (typeof onProgress === 'function') onProgress({ done, total: scenarios.length, result: results[i] });
    }
  }
  const pool = Math.max(1, Math.min(concurrency, scenarios.length));
  await Promise.all(Array.from({ length: pool }, worker));
  return results;
}

// ---- aggregation -------------------------------------------------------------
function aggregate(results) {
  const total = results.length;
  const statusCounts = { PASS: 0, FAIL: 0, ERROR: 0, JUDGE_ERROR: 0 };
  const byFamily = {};
  const dimTotals = {};
  const dimCounts = {};
  let criticalCount = 0;
  const judged = [];

  for (const r of results) {
    statusCounts[r.status] = (statusCounts[r.status] || 0) + 1;
    const fam = byFamily[r.family] || (byFamily[r.family] = { total: 0, pass: 0, fail: 0, error: 0, judgeError: 0 });
    fam.total += 1;
    if (r.status === 'PASS') fam.pass += 1;
    else if (r.status === 'FAIL') fam.fail += 1;
    else if (r.status === 'ERROR') fam.error += 1;
    else if (r.status === 'JUDGE_ERROR') fam.judgeError += 1;

    if (r.verdict) {
      judged.push(r);
      criticalCount += (r.verdict.criticalFailures || []).length;
      for (const [k, v] of Object.entries(r.verdict.dimensions || {})) {
        dimTotals[k] = (dimTotals[k] || 0) + v;
        dimCounts[k] = (dimCounts[k] || 0) + 1;
      }
    }
  }

  const dimensionMeans = {};
  for (const k of Object.keys(dimTotals)) {
    dimensionMeans[k] = Number((dimTotals[k] / dimCounts[k]).toFixed(3));
  }
  const judgedCount = judged.length;
  const passRateOfJudged = judgedCount ? Number((statusCounts.PASS / judgedCount).toFixed(3)) : 0;

  return {
    total,
    statusCounts,
    passRateOfJudged,
    passOutOfTotal: `${statusCounts.PASS}/${total}`,
    criticalCount,
    byFamily,
    dimensionMeans,
  };
}

// ---- reporting ---------------------------------------------------------------
function formatReport(agg, results, metadata) {
  const lines = [];
  lines.push('# GOLD v2 benchmark report');
  lines.push('');
  lines.push(`- Benchmark: ${metadata.benchmark}`);
  lines.push(`- Scenario set: ${metadata.scenarioSetVersion}`);
  lines.push(`- Judge: ${metadata.judgeModel} (${metadata.judgePromptVersion})`);
  lines.push(`- Product SHA: ${metadata.productSha || 'unknown'}`);
  lines.push(`- Generated: ${metadata.generatedAt}`);
  lines.push(`- Policy: PASS mean ≥ ${metadata.passMin}/4, safety ≥ ${metadata.safetyMin}/4, no critical failure`);
  lines.push('');
  lines.push('## Headline');
  lines.push('');
  lines.push(`**${agg.passOutOfTotal} scenarios PASS.**`);
  lines.push('');
  lines.push(`- PASS ${agg.statusCounts.PASS} · FAIL ${agg.statusCounts.FAIL} · ERROR ${agg.statusCounts.ERROR} · JUDGE_ERROR ${agg.statusCounts.JUDGE_ERROR}`);
  lines.push(`- Critical failures observed: ${agg.criticalCount}`);
  lines.push('');
  lines.push('## Per family');
  lines.push('');
  lines.push('| Family | Pass | Fail | Error | JudgeErr | Total |');
  lines.push('|---|---|---|---|---|---|');
  for (const [fam, f] of Object.entries(agg.byFamily)) {
    lines.push(`| ${fam} | ${f.pass} | ${f.fail} | ${f.error} | ${f.judgeError} | ${f.total} |`);
  }
  lines.push('');
  lines.push('## Per dimension (mean of judged conversations, 0–4)');
  lines.push('');
  lines.push('| Dimension | Mean |');
  lines.push('|---|---|');
  for (const [k, v] of Object.entries(agg.dimensionMeans)) lines.push(`| ${k} | ${v} |`);
  lines.push('');
  lines.push('## Failing / errored scenarios');
  lines.push('');
  const failing = results.filter((r) => r.status !== 'PASS');
  if (!failing.length) {
    lines.push('_None._');
  } else {
    for (const r of failing) {
      lines.push(`### ${r.id} (${r.family}) — ${r.status}`);
      if (r.verdict) lines.push(`- ${r.verdict.summary}`);
      if (r.error) lines.push(`- error: ${r.error}`);
      if (r.verdict && r.verdict.issues && r.verdict.issues.length) {
        for (const iss of r.verdict.issues) lines.push(`  - [${iss.type}] ${iss.text}`);
      }
      lines.push('');
      lines.push('Transcript:');
      for (const t of r.transcript) {
        lines.push(`- 👤 ${t.userText}`);
        lines.push(`  🤖 ${((t.view && t.view.reply) || '').replace(/\s+/g, ' ').slice(0, 600)}`);
      }
      lines.push('');
    }
  }
  return lines.join('\n');
}

module.exports = {
  simulateConversation,
  runScenario,
  runAll,
  aggregate,
  formatReport,
};
