// Print the markdown tables for docs/evaluation/llm-led-rebuild.md from results-<set>.json (analyze.mjs) and the ac2
// conversation audits (latency, model calls, tokens, kernel activity) and judge files (evaluation cost).
//
//   node evaluation/rebuild/report.mjs
import { readFileSync, readdirSync, existsSync } from 'node:fs';

const DIR = new URL('.', import.meta.url).pathname;
const SETS = ['independent-100', 'heldout-25'];
const rd = (p) => JSON.parse(readFileSync(p, 'utf8'));
const pct = (x) => (x == null ? '–' : `${Math.round(x * 100)}%`);
const f2 = (x) => (x == null ? '–' : x.toFixed(2));
const NAME = { ac2: 'New AC (ac2)', ac: 'Old AC (journeys)', ga: 'General assistant' };

for (const set of SETS) {
  const p = `${DIR}results-${set}.json`;
  if (!existsSync(p)) continue;
  const r = rd(p).all;
  const sys = ['ac2', 'ac', 'ga'].filter((s) => r[s] && r[s].n);
  console.log(`\n### ${set}\n`);
  console.log(`| | ${sys.map((s) => NAME[s]).join(' | ')} |`);
  console.log(`|---|${sys.map(() => '---').join('|')}|`);
  const row = (label, fn) => console.log(`| ${label} | ${sys.map((s) => fn(r[s])).join(' | ')} |`);
  row('Conversations judged', (x) => x.n);
  row('Overall usefulness (0–4)', (x) => f2(x.overall));
  row('Resolved or usefully escalated / declined', (x) => pct(x.completionRate));
  row('Conversations with any critical failure', (x) => x.conversationsWithAnyCritical);
  row('…confirmed by the second judge', (x) => x.conversationsWithConfirmedCritical);
  row('Unsafe DIY instruction (critical)', (x) => x.unsafeDiy);
  row('Outcome judged harmful', (x) => x.harmful);
  row('Invented customer evidence', (x) => pct(x.fabricatedEvidenceRate));
  row('Looping', (x) => pct(x.loopRate));
  row('Recommended a part', (x) => pct(x.partRecommendedRate));
  row('Unnecessary part', (x) => pct(x.unnecessaryPartRate));
  row('Median turn latency', (x) => (x.medianTurnMs ? `${(x.medianTurnMs / 1000).toFixed(1)} s` : '–'));
  row('90th percentile turn latency', (x) => (x.p90TurnMs ? `${(x.p90TurnMs / 1000).toFixed(1)} s` : '–'));
  console.log('\n| Dimension (0–4) | ' + sys.map((s) => NAME[s]).join(' | ') + ' |');
  console.log(`|---|${sys.map(() => '---').join('|')}|`);
  for (const d of Object.keys(r[sys[0]].dimensions)) console.log(`| ${d} | ${sys.map((s) => f2(r[s].dimensions[d])).join(' | ')} |`);
  console.log('\n| Pairwise (blind) | first | tie | second | n | first win or tie |');
  console.log('|---|---|---|---|---|---|');
  for (const [pr, w] of Object.entries(r.pairwise)) {
    const [a, b] = pr.split('-');
    if (!w.n) continue;
    console.log(`| ${NAME[a]} vs ${NAME[b]} | ${w[a]} | ${w.tie} | ${w[b]} | ${w.n} | ${pct(w.winOrTieRate)} |`);
  }
  const crit = Object.keys(r[sys[0]].criticalFailures);
  console.log('\n| Critical failure (conversations) | ' + sys.map((s) => NAME[s]).join(' | ') + ' |');
  console.log(`|---|${sys.map(() => '---').join('|')}|`);
  for (const c of crit) console.log(`| ${c} | ${sys.map((s) => r[s].criticalFailures[c]).join(' | ')} |`);

  // ac2 kernel activity and model usage from the per-turn audits.
  const cdir = `${DIR}out/${set}/conversations/ac2`;
  if (existsSync(cdir)) {
    let turns = 0; let regen = 0; let rejected = 0; let gates = {}; let tokIn = 0; let tokOut = 0; let errors = 0; let parts = {}; let calls = 0;
    for (const f of readdirSync(cdir)) {
      const c = rd(`${cdir}/${f}`);
      for (const m of c.meta || []) {
        turns += 1;
        if (m.status !== 200 || m.error) errors += 1;
        const a = m.ac2 || {};
        if (a.regenerated) regen += 1;
        rejected += (a.claimsRejected || []).length;
        for (const g of (a.safety && a.safety.gates) || []) gates[g.gate] = (gates[g.gate] || 0) + 1;
        if (a.usage) { tokIn += a.usage.promptTokens || 0; tokOut += a.usage.completionTokens || 0; }
        calls += a.provider ? 2 + (a.regenerated ? 2 : 0) : 0;
        if (a.partGate) parts[a.partGate.outcome] = (parts[a.partGate.outcome] || 0) + 1;
      }
    }
    console.log(`\nac2 audit (${set}): turns ${turns}, explicit errors ${errors}, regenerated ${regen} (${pct(regen / (turns || 1))}), claims rejected ${rejected}, model calls ≈${calls} (${(calls / (turns || 1)).toFixed(2)}/turn), reasoner tokens in ${tokIn} / out ${tokOut} (mean ${Math.round(tokIn / (turns || 1))} / ${Math.round(tokOut / (turns || 1))} per turn), gates ${JSON.stringify(gates)}, part gate ${JSON.stringify(parts)}`);
  }
  // Evaluation cost (simulator, general assistant, judges) where the CLI reported it.
  let judgeUsd = 0;
  for (const sub of ['primary', 'second', 'pairwise-ac2-ga', 'pairwise-ac2-ac', 'pairwise-ac-ga']) {
    const jd = `${DIR}out/${set}/judge/${sub}`;
    if (!existsSync(jd)) continue;
    for (const f of readdirSync(jd)) if (f.endsWith('.json')) judgeUsd += rd(`${jd}/${f}`).costUsd || 0;
  }
  let simUsd = 0; let gaUsd = 0;
  for (const s of ['ac2', 'ac', 'ga']) {
    const cd = `${DIR}out/${set}/conversations/${s}`;
    if (!existsSync(cd)) continue;
    for (const f of readdirSync(cd)) { const c = rd(`${cd}/${f}`); simUsd += c.simCostUsd || 0; if (s === 'ga') gaUsd += (c.meta || []).reduce((a, m) => a + (m.costUsd || 0), 0); }
  }
  console.log(`evaluation cost (${set}, this run's files): judges $${judgeUsd.toFixed(2)}, simulator $${simUsd.toFixed(2)}, general assistant $${gaUsd.toFixed(2)}`);
}
