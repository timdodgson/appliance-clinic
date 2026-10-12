// Aggregate the blind judgements into evaluation/independent-100/results.json (machine-readable) and print the tables
// used in docs/evaluation/independent-100-case-benchmark.md.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { DIMENSIONS, CRITICAL } from './lib/rubric.mjs';

const DIR = new URL('.', import.meta.url).pathname;
const OUT = `${DIR}out`;
const CASES = JSON.parse(readFileSync(`${DIR}cases.json`, 'utf8')).cases;
const rd = (p) => (existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null);
const SYS = ['ac', 'ga'];
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const median = (xs) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const r2 = (x) => (x == null ? null : Math.round(x * 100) / 100);

const rows = CASES.map((k) => {
  const row = { id: k.id, family: k.family, tags: k.tags, difficulty: k.difficulty, expected: { criticalSafetyStop: k.expected.criticalSafetyStop, noPartNeeded: k.expected.noPartNeeded, outOfScope: k.expected.outOfScope, partRecommendation: k.expected.partRecommendation } };
  for (const s of SYS) {
    const c = rd(`${OUT}/conversations/${s}/${k.id}.json`); const p = rd(`${OUT}/judge/primary/${k.id}.${s}.json`); const q = rd(`${OUT}/judge/second/${k.id}.${s}.json`);
    row[s] = c && {
      endReason: c.endReason, customerTurns: c.customerTurns,
      primary: p && { scores: p.scores, critical: Object.fromEntries(Object.entries(p.critical || {}).map(([x, v]) => [x, Boolean(v && v.flag)])), criticalEvidence: Object.fromEntries(Object.entries(p.critical || {}).filter(([, v]) => v && v.flag).map(([x, v]) => [x, v.evidence])), outcome: p.outcome, partRecommended: p.partRecommended, unnecessaryPart: p.unnecessaryPart, looped: p.looped, rationale: p.rationale },
      second: q && { scores: q.scores, critical: Object.fromEntries(Object.entries(q.critical || {}).map(([x, v]) => [x, Boolean(v && v.flag)])), outcome: q.outcome },
    };
  }
  row.pairwise = rd(`${OUT}/judge/pairwise/${k.id}.json`);
  return row;
});

function summary(sel) {
  const out = {};
  for (const s of SYS) {
    const xs = sel.map((r) => r[s]).filter((x) => x && x.primary);
    const dim = {};
    for (const d of Object.keys(DIMENSIONS)) dim[d] = { mean: r2(mean(xs.map((x) => x.primary.scores[d]))), median: median(xs.map((x) => x.primary.scores[d])) };
    const crit = {}; for (const c of Object.keys(CRITICAL)) crit[c] = xs.filter((x) => x.primary.critical[c]).length;
    const confirmed = {}; for (const c of Object.keys(CRITICAL)) confirmed[c] = xs.filter((x) => x.primary.critical[c] && x.second && x.second.critical[c]).length;
    const anyCrit = xs.filter((x) => Object.values(x.primary.critical).some(Boolean)).length;
    const anyConfirmed = xs.filter((x) => x.second && Object.keys(CRITICAL).some((c) => x.primary.critical[c] && x.second.critical[c])).length;
    const oc = (o) => xs.filter((x) => x.primary.outcome === o).length;
    out[s] = {
      n: xs.length, dimensions: dim,
      criticalFailures: crit, criticalConfirmedBySecondJudge: confirmed, conversationsWithAnyCritical: anyCrit, conversationsWithConfirmedCritical: anyConfirmed,
      outcomes: Object.fromEntries(['resolved', 'useful-safe-escalation', 'partial', 'unresolved', 'appropriate-decline', 'harmful'].map((o) => [o, oc(o)])),
      completionRate: r2((oc('resolved') + oc('useful-safe-escalation') + oc('appropriate-decline')) / (xs.length || 1)),
      usefulSafeEscalationRate: r2(oc('useful-safe-escalation') / (xs.length || 1)),
      fabricatedEvidenceRate: r2(xs.filter((x) => x.primary.critical.inventedEvidence).length / (xs.length || 1)),
      unnecessaryPartRate: r2(xs.filter((x) => x.primary.unnecessaryPart).length / (xs.length || 1)),
      partRecommendedRate: r2(xs.filter((x) => x.primary.partRecommended).length / (xs.length || 1)),
      loopRate: r2(xs.filter((x) => x.primary.looped).length / (xs.length || 1)),
      meanCustomerTurns: r2(mean(xs.map((x) => x.customerTurns))),
      endReasons: xs.reduce((a, x) => ({ ...a, [x.endReason]: (a[x.endReason] || 0) + 1 }), {}),
    };
  }
  const pw = sel.map((r) => r.pairwise).filter(Boolean);
  out.pairwise = { ac: pw.filter((p) => p.winner === 'ac').length, ga: pw.filter((p) => p.winner === 'ga').length, tie: pw.filter((p) => p.winner === 'tie').length, n: pw.length };
  const both = sel.filter((r) => r.ac && r.ac.primary && r.ga && r.ga.primary);
  out.overallScoreWDL = { acHigher: both.filter((r) => r.ac.primary.scores.overall > r.ga.primary.scores.overall).length, equal: both.filter((r) => r.ac.primary.scores.overall === r.ga.primary.scores.overall).length, gaHigher: both.filter((r) => r.ac.primary.scores.overall < r.ga.primary.scores.overall).length };
  return out;
}

const has = (t) => (r) => r.tags.includes(t);
const SLICES = {
  all: () => true,
  'simple/common fault': (r) => r.difficulty === 'simple-common',
  'ambiguous fault': (r) => r.difficulty === 'ambiguous',
  'messy language': (r) => r.tags.includes('messy-spelling') || r.tags.includes('shorthand') || r.tags.includes('vague-opener'),
  'error-code case': (r) => r.tags.includes('error-code') || r.tags.includes('code-or-model-ambiguous'),
  'safety case': (r) => r.tags.includes('hazard') || r.expected.criticalSafetyStop,
  'no-part case': (r) => r.expected.noPartNeeded,
  'replaceable-part case': has('replaceable-part'),
  'out-of-scope case': (r) => r.expected.outOfScope,
  'model number given': (r) => r.tags.includes('full-model') || r.tags.includes('partial-model'),
  'customer cannot/refuses/does not know': (r) => r.tags.includes('customer-dont-know') || r.tags.includes('cannot-do-check') || r.tags.includes('refuses-check'),
};
const families = [...new Set(CASES.map((k) => k.family))];
const slices = Object.fromEntries(Object.entries(SLICES).map(([n, f]) => [n, { n: rows.filter(f).length, ...summary(rows.filter(f)) }]));
const byFamily = Object.fromEntries(families.map((f) => [f, { n: rows.filter((r) => r.family === f).length, ...summary(rows.filter((r) => r.family === f)) }]));

// judge agreement (second judge on its subset)
const agree = { overallWithin1: 0, n: 0, criticalAgreement: { primaryOnly: 0, both: 0, secondOnly: 0 } };
for (const r of rows) for (const s of SYS) {
  const x = r[s]; if (!x || !x.primary || !x.second) continue;
  agree.n += 1; if (Math.abs(x.primary.scores.overall - x.second.scores.overall) <= 1) agree.overallWithin1 += 1;
  for (const c of Object.keys(CRITICAL)) { const a = x.primary.critical[c]; const b = x.second.critical[c]; if (a && b) agree.criticalAgreement.both += 1; else if (a) agree.criticalAgreement.primaryOnly += 1; else if (b) agree.criticalAgreement.secondOnly += 1; }
}

const build = rd(`${OUT}/build.json`);
const result = { benchmark: 'independent-100/1', datasetSha256: process.env.DATASET_SHA || null, build, systems: { ac: 'Appliance Clinic live production (applianceclinic.ai)', ga: 'General-purpose assistant: claude-opus-5-5, generic system prompt, no tools' }, simulator: 'claude-sonnet-5-5', judges: { primary: 'claude-fable-5-1', second: 'claude-sonnet-5-5' }, slices, byFamily, judgeAgreement: agree, cases: rows };
writeFileSync(`${DIR}results.json`, `${JSON.stringify(result, null, 1)}\n`);
const a = slices.all;
console.log(JSON.stringify({ ac: { overall: a.ac.dimensions.overall, crit: a.ac.conversationsWithAnyCritical, confirmed: a.ac.conversationsWithConfirmedCritical, completion: a.ac.completionRate }, ga: { overall: a.ga.dimensions.overall, crit: a.ga.conversationsWithAnyCritical, confirmed: a.ga.conversationsWithConfirmedCritical, completion: a.ga.completionRate }, pairwise: a.pairwise, scoreWDL: a.overallScoreWDL, agree }, null, 1));
