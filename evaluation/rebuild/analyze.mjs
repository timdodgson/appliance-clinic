// Aggregate rebuild judgements for one frozen case set into evaluation/rebuild/results-<set>.json, with the same metric
// definitions as evaluation/independent-100/analyze.mjs. For independent-100, the original systems' judgements (ac, ga)
// are read from the frozen original run.
//
//   node evaluation/rebuild/analyze.mjs --set independent-100|heldout-25 [--systems ac2,ac,ga] [--pairs ac2-ga,ac-ga,ac2-ac] [--only ids]
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { DIMENSIONS, CRITICAL } from '../independent-100/lib/rubric.mjs';

const DIR = new URL('.', import.meta.url).pathname;
const arg = (k, d) => { const i = process.argv.indexOf(k); return i > -1 ? process.argv[i + 1] : d; };
const SET = arg('--set', 'independent-100');
const OUT = arg('--out', `${DIR}out/${SET}`);
const ORIG = `${DIR}../independent-100/out`;
const SYS = arg('--systems', 'ac2,ac,ga').split(',');
const PAIRS = arg('--pairs', 'ac2-ga,ac-ga,ac2-ac').split(',');
const ONLY = arg('--only') ? arg('--only').split(',') : null;
const CASES = JSON.parse(readFileSync(`${DIR}../${SET}/cases.json`, 'utf8')).cases.filter((k) => !ONLY || ONLY.includes(k.id));
const rd = (p) => (existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null);
const first = (...ps) => { for (const p of ps) { const x = rd(p); if (x) return x; } return null; };
const orig = SET === 'independent-100';
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const r2 = (x) => (x == null ? null : Math.round(x * 100) / 100);

function judged(s, id, which) {
  return first(`${OUT}/judge/${which}/${id}.${s}.json`, orig ? `${ORIG}/judge/${which}/${id}.${s}.json` : '');
}
function pairOf(pair, id) {
  const [a, b] = pair.split('-');
  const p = first(`${OUT}/judge/pairwise-${a}-${b}/${id}.json`, orig && pair === 'ac-ga' ? `${ORIG}/judge/pairwise/${id}.json` : '');
  return p;
}

const rows = CASES.map((k) => {
  const row = { id: k.id, family: k.family, tags: k.tags };
  for (const s of SYS) {
    const c = first(`${OUT}/conversations/${s}/${k.id}.json`, orig ? `${ORIG}/conversations/${s}/${k.id}.json` : '');
    const p = judged(s, k.id, 'primary'); const q = judged(s, k.id, 'second');
    const crit = (j) => j && Object.fromEntries(Object.entries(j.critical || {}).map(([x, v]) => [x, Boolean(v && v.flag)]));
    row[s] = c && { endReason: c.endReason, customerTurns: c.customerTurns, ms: (c.meta || []).map((m) => m.ms).filter(Number.isFinite),
      primary: p && { scores: p.scores, critical: crit(p), outcome: p.outcome, partRecommended: p.partRecommended, unnecessaryPart: p.unnecessaryPart, looped: p.looped },
      second: q && { scores: q.scores, critical: crit(q), outcome: q.outcome } };
  }
  row.pairs = Object.fromEntries(PAIRS.map((pr) => [pr, pairOf(pr, k.id)]));
  return row;
});

function sys(s, sel) {
  const xs = sel.map((r) => r[s]).filter((x) => x && x.primary);
  const oc = (o) => xs.filter((x) => x.primary.outcome === o).length;
  const n = xs.length || 1;
  const ms = xs.flatMap((x) => x.ms).sort((a, b) => a - b);
  return {
    n: xs.length,
    overall: r2(mean(xs.map((x) => x.primary.scores.overall))),
    dimensions: Object.fromEntries(Object.keys(DIMENSIONS).map((d) => [d, r2(mean(xs.map((x) => x.primary.scores[d])))])),
    outcomes: Object.fromEntries(['resolved', 'useful-safe-escalation', 'partial', 'unresolved', 'appropriate-decline', 'harmful'].map((o) => [o, oc(o)])),
    completionRate: r2((oc('resolved') + oc('useful-safe-escalation') + oc('appropriate-decline')) / n),
    criticalFailures: Object.fromEntries(Object.keys(CRITICAL).map((c) => [c, xs.filter((x) => x.primary.critical[c]).length])),
    conversationsWithAnyCritical: xs.filter((x) => Object.values(x.primary.critical).some(Boolean)).length,
    conversationsWithConfirmedCritical: xs.filter((x) => x.second && Object.keys(CRITICAL).some((c) => x.primary.critical[c] && x.second.critical[c])).length,
    unsafeDiy: xs.filter((x) => x.primary.critical.unsafeDiy).length,
    harmful: oc('harmful'),
    fabricatedEvidenceRate: r2(xs.filter((x) => x.primary.critical.inventedEvidence).length / n),
    loopRate: r2(xs.filter((x) => x.primary.looped).length / n),
    partRecommendedRate: r2(xs.filter((x) => x.primary.partRecommended).length / n),
    unnecessaryPartRate: r2(xs.filter((x) => x.primary.unnecessaryPart).length / n),
    medianTurnMs: ms.length ? ms[ms.length >> 1] : null,
    p90TurnMs: ms.length ? ms[Math.floor(ms.length * 0.9)] : null,
    meanCustomerTurns: r2(mean(xs.map((x) => x.customerTurns))),
  };
}
function pairs(sel) {
  return Object.fromEntries(PAIRS.map((pr) => {
    const [a, b] = pr.split('-');
    const ps = sel.map((r) => r.pairs[pr]).filter(Boolean);
    const w = { [a]: ps.filter((p) => p.winner === a).length, tie: ps.filter((p) => p.winner === 'tie').length, [b]: ps.filter((p) => p.winner === b).length, n: ps.length };
    w.winOrTieRate = ps.length ? r2((w[a] + w.tie) / ps.length) : null;
    return [pr, w];
  }));
}
const summary = (sel) => ({ ...Object.fromEntries(SYS.map((s) => [s, sys(s, sel)])), pairwise: pairs(sel) });
const families = [...new Set(CASES.map((k) => k.family))];
const result = { set: SET, systems: SYS, all: summary(rows), byFamily: Object.fromEntries(families.map((f) => [f, summary(rows.filter((r) => r.family === f))])), cases: rows };
writeFileSync(arg('--results', `${DIR}results-${SET}${ONLY ? '-subset' : ''}.json`), `${JSON.stringify(result, null, 1)}\n`);
const brief = Object.fromEntries(SYS.map((s) => { const x = result.all[s]; return [s, { n: x.n, overall: x.overall, completion: x.completionRate, crit: x.conversationsWithAnyCritical, unsafeDiy: x.unsafeDiy, harmful: x.harmful, fabricated: x.fabricatedEvidenceRate, loop: x.loopRate, partRec: x.partRecommendedRate, unnecessaryPart: x.unnecessaryPartRate, medianMs: x.medianTurnMs }]; }));
console.log(JSON.stringify({ ...brief, pairwise: result.all.pairwise }, null, 1));
