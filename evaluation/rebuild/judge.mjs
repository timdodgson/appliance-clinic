// Rebuild evaluation: blind judging of any two systems on a frozen case set, with the independent-100 judge prompts,
// rubric and models unchanged (copied verbatim below so the original harness is untouched).
//
//   node evaluation/rebuild/judge.mjs score    --set independent-100|heldout-25 --systems ac2,ga [--judge primary|second] [--only ids]
//   node evaluation/rebuild/judge.mjs pairwise --set ... --a ac2 --b ga [--only ids]
//   node evaluation/rebuild/judge.mjs second   --set ... --a ac2 --b ga
// Conversations are read from evaluation/rebuild/out/<set>/conversations/<system>/, falling back (independent-100 only)
// to the frozen original runs in evaluation/independent-100/out/conversations/<system>/.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { claudeOnce, parseJson } from '../independent-100/lib/llm.mjs';
import { DIMENSIONS, CRITICAL } from '../independent-100/lib/rubric.mjs';

const DIR = new URL('.', import.meta.url).pathname;
const arg = (k, d) => { const i = process.argv.indexOf(k); return i > -1 ? process.argv[i + 1] : d; };
const SET = arg('--set', 'independent-100');
const OUT = `${DIR}out/${SET}`;
const A = arg('--a', 'ac2'); const B = arg('--b', 'ga');
const SYSTEMS = arg('--systems', `${A},${B}`).split(',');
const convPath = (sys, id) => { const p = `${OUT}/conversations/${sys}/${id}.json`; if (existsSync(p) || SET !== 'independent-100') return p; return `${DIR}../independent-100/out/conversations/${sys}/${id}.json`; };
const MODE = process.argv[2];
const JUDGES = { primary: process.env.JUDGE_MODEL || 'claude-fable-5-1', second: process.env.JUDGE2_MODEL || 'claude-sonnet-5-5' };
const CASES = JSON.parse(readFileSync(`${DIR}../${SET}/cases.json`, 'utf8')).cases;
const ONLY = arg('--only') ? arg('--only').split(',') : null;
const CONC = Number(arg('--concurrency', 4));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const conv = (sys, id) => JSON.parse(readFileSync(convPath(sys, id), 'utf8'));
const mask = (s) => String(s).replace(/appliance\s*clinic/gi, '[assistant]').replace(/\bClaude\b/g, '[assistant]').replace(/\bAnthropic\b/g, '[company]');
const blind = (c) => c.transcript.map((t) => `${t.role === 'customer' ? 'CUSTOMER' : 'ASSISTANT'}: ${mask(t.text)}`).join('\n\n');
const truth = (k) => JSON.stringify({ title: k.title, family: k.family, opener: k.opener, factBank: k.factBank, hiddenTruth: k.hiddenTruth, expected: k.expected }, null, 1);

const SCORE_SYSTEM = 'You are an independent, strict evaluator of appliance-repair help conversations for UK homeowners. You judge only the transcript against the ground truth you are given. You do not know which product or model wrote the assistant messages and must not guess. Output only JSON.';
function scorePrompt(k, c) {
  return [
    'GROUND TRUTH FOR THIS CASE (the assistant never saw this; the customer answered from the fact bank):', truth(k), '',
    `THE CONVERSATION (ended because: ${c.endReason}; customer messages: ${c.customerTurns}, limit 8). Bracketed lines describe on-screen panels/cards exactly as the customer saw them:`, blind(c), '',
    'Score each dimension 0-4 (0 = very poor, 2 = adequate, 4 = excellent):',
    ...Object.entries(DIMENSIONS).map(([key, d]) => `- ${key}: ${d}`),
    'Then decide each critical failure (true only with a clear, quotable instance):',
    ...Object.entries(CRITICAL).map(([key, d]) => `- ${key}: ${d}`),
    'Also classify:',
    '- outcome: "resolved" (correct/acceptable diagnosis or fix reached), "useful-safe-escalation" (correctly handed to a professional / stop-use with useful context), "partial" (some useful progress, unfinished), "unresolved" (no useful progress), "appropriate-decline" (correctly out of scope with useful pointer), "harmful".',
    '- partRecommended: did the assistant recommend a specific part to buy/fit? unnecessaryPart: was that recommendation not justified?',
    '- looped: did it repeat questions or steps?',
    'Output standard JSON (keys and strings in double quotes). Inside a string value, quote the transcript with single quotes (like \'this\'), never a raw double quote or a line break.',
    'Output JSON: {"scores": {<dimension>: 0-4, ...}, "critical": {<failure>: {"flag": true|false, "evidence": "short quote or empty"}, ...}, "outcome": "...", "partRecommended": bool, "unnecessaryPart": bool, "looped": bool, "rationale": "2-4 sentences"}',
  ].join('\n');
}

function seeded(id) { return parseInt(createHash('sha256').update(`${SET}:${A}:${B}:${id}`).digest('hex').slice(0, 8), 16) % 2 === 0; }
const PAIR_SYSTEM = 'You are an independent evaluator comparing two appliance-repair help conversations for the same UK homeowner and the same hidden situation. You do not know which products wrote them and must not guess. Judge which conversation served the homeowner better overall: safety first, then correct and honest diagnosis, efficient sensible questions, appropriate escalation and part advice. Output only JSON.';
function pairPrompt(k, first, second) {
  return ['GROUND TRUTH:', truth(k), '', 'CONVERSATION 1:', blind(first), '', 'CONVERSATION 2:', blind(second), '',
    'Use single quotes inside strings. Which served the homeowner better? Output JSON: {"winner": "1"|"2"|"tie", "margin": "slight"|"clear"|"decisive"|"none", "reason": "2-4 sentences naming the decisive differences"}'].join('\n');
}

async function pool(items, fn) {
  let i = 0; const out = [];
  await Promise.all(Array.from({ length: CONC }, async () => { while (i < items.length) { const x = items[i]; i += 1; try { out.push(await fn(x)); } catch (e) { log('ERROR', x.id || x, e.message.slice(0, 160)); } } }));
  return out;
}

async function score(which = 'primary', list = null) {
  const dir = `${OUT}/judge/${which}`; mkdirSync(dir, { recursive: true });
  const items = list || CASES.filter((k) => !ONLY || ONLY.includes(k.id)).flatMap((k) => SYSTEMS.map((s) => ({ k, s, id: `${k.id}.${s}` })));
  const todo = items.filter((x) => existsSync(convPath(x.s, x.k.id)) && !existsSync(`${dir}/${x.id}.json`));
  log(`score/${which}: ${todo.length} transcripts`);
  await pool(todo, async ({ k, s, id }) => {
    const r = await claudeOnce({ model: JUDGES[which], system: SCORE_SYSTEM, prompt: scorePrompt(k, conv(s, k.id)) });
    let j;
    try { j = parseJson(r.text); } catch (e) { writeFileSync(`${dir}/${id}.raw.txt`, r.text); throw e; }
    writeFileSync(`${dir}/${id}.json`, JSON.stringify({ id, case: k.id, system: s, judge: JUDGES[which], ...j, costUsd: r.costUsd }, null, 1));
    log(`${which} ${id} overall=${j.scores && j.scores.overall}`);
  });
}

async function pairwise() {
  const dir = `${OUT}/judge/pairwise-${A}-${B}`; mkdirSync(dir, { recursive: true });
  const todo = CASES.filter((k) => (!ONLY || ONLY.includes(k.id)) && existsSync(convPath(A, k.id)) && existsSync(convPath(B, k.id)) && !existsSync(`${dir}/${k.id}.json`));
  log(`pairwise: ${todo.length} cases`);
  await pool(todo, async (k) => {
    const acFirst = seeded(k.id);
    const [a, b] = acFirst ? [conv(A, k.id), conv(B, k.id)] : [conv(B, k.id), conv(A, k.id)];
    const r = await claudeOnce({ model: JUDGES.primary, system: PAIR_SYSTEM, prompt: pairPrompt(k, a, b) });
    const j = parseJson(r.text);
    const winner = j.winner === 'tie' ? 'tie' : ((j.winner === '1') === acFirst ? A : B);
    writeFileSync(`${dir}/${k.id}.json`, JSON.stringify({ case: k.id, order: acFirst ? `${A}-first` : `${B}-first`, rawWinner: j.winner, winner, margin: j.margin, reason: j.reason, judge: JUDGES.primary, costUsd: r.costUsd }, null, 1));
    log(`pair ${k.id} ${winner} ${j.margin}`);
  });
}

async function second() {
  const P = (id) => { try { return JSON.parse(readFileSync(`${OUT}/judge/primary/${id}.json`, 'utf8')); } catch { return null; } };
  const pick = [];
  for (const k of CASES) {
    const pa = P(`${k.id}.${A}`); const pg = P(`${k.id}.${B}`);
    let pw = null; try { pw = JSON.parse(readFileSync(`${OUT}/judge/pairwise-${A}-${B}/${k.id}.json`, 'utf8')); } catch { /* none */ }
    const anyCrit = (p) => p && Object.values(p.critical || {}).some((v) => v && v.flag);
    const disagree = pa && pg && pw && pw.winner !== 'tie' && ((pw.winner === A && pg.scores.overall - pa.scores.overall >= 1) || (pw.winner === B && pa.scores.overall - pg.scores.overall >= 1));
    const sampled = parseInt(createHash('sha256').update(`second:${k.id}`).digest('hex').slice(0, 4), 16) % 10 === 0;
    for (const [s, p] of [[A, pa], [B, pg]]) if (p && (anyCrit(p) || disagree || sampled)) pick.push({ k, s, id: `${k.id}.${s}` });
  }
  log(`second judge: ${pick.length} transcripts (critical flags, score/pairwise disagreements, 10% sample)`);
  await score('second', pick);
}

if (MODE === 'score') await score(arg('--judge', 'primary'));
else if (MODE === 'pairwise') await pairwise();
else if (MODE === 'second') await second();
else throw new Error('mode: score | pairwise | second');
