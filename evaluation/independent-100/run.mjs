// Run the 100 conversations for one or both systems. Each conversation: the case opener, then the shared customer
// simulator answers from the fact bank until it ends the conversation or 8 customer messages have been sent.
//
//   node evaluation/independent-100/run.mjs --system ac|ga [--only WM-01,WM-02] [--concurrency N]
//
// Writes evaluation/independent-100/out/conversations/<system>/<id>.json (skips ids already written: resumable).
// AC safety: a Jev 402 or three 429s/503s stop the AC run (production must never be put at risk).
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import * as AC from './lib/ac.mjs';
import * as GA from './lib/ga.mjs';
import { nextCustomerTurn, MAX_CUSTOMER_TURNS } from './lib/sim.mjs';

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > -1 ? process.argv[i + 1] : d; };
const SYSTEM = arg('--system');
if (!['ac', 'ga'].includes(SYSTEM)) throw new Error('--system ac|ga');
const DIR = new URL('.', import.meta.url).pathname;
const OUT = `${arg('--out', `${DIR}out`)}/conversations/${SYSTEM}`;
mkdirSync(OUT, { recursive: true });
const CASES = JSON.parse(readFileSync(arg('--cases', `${DIR}cases.json`), 'utf8')).cases;
const ONLY = arg('--only') ? arg('--only').split(',') : null;
const CONC = Number(arg('--concurrency', SYSTEM === 'ac' ? 2 : 4));
const todo = CASES.filter((c) => (!ONLY || ONLY.includes(c.id)) && !existsSync(`${OUT}/${c.id}.json`));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

let stop = null; let acBad = 0;
const START = new Date().toISOString();

async function runCase(kase) {
  const sys = SYSTEM === 'ac' ? AC : GA;
  const conv = sys.conversation(kase.id);
  const transcript = []; const meta = []; let simCost = 0; let endReason = null;
  let message = kase.opener;
  for (let turn = 1; ; turn += 1) {
    transcript.push({ role: 'customer', text: message });
    const r = await conv.send(message);
    const shown = sys.render(r);
    transcript.push({ role: 'assistant', text: shown });
    if (SYSTEM === 'ac') {
      const v = r.view || {};
      meta.push({ turn, status: r.status, ms: r.ms, retried: Boolean(r.retried), label: v.diagnosis && v.diagnosis.label, safety: Boolean(v.safety), parts: (v.parts || []).map((p) => ({ name: p.name, fit: p.fitStatus, url: p.offers && p.offers[0] && p.offers[0].url })), media: (v.media || []).length, needsModel: Boolean(v.needsModel), error: v.error || null });
      if (r.status === 402 || (r.view && /402|payment/i.test(JSON.stringify(r.view.error || '')))) stop = 'AC returned a credit error';
      if (r.status !== 200) { acBad += 1; if (acBad >= 3) stop = `AC returned ${acBad} errors (last HTTP ${r.status})`; } else acBad = 0;
      if (r.status !== 200) { endReason = 'service-error'; break; }
    } else {
      meta.push({ turn, status: r.status, ms: r.ms, costUsd: r.costUsd || 0, error: r.error || null });
      if (r.status !== 200) { endReason = 'service-error'; break; }
    }
    if (turn >= MAX_CUSTOMER_TURNS) { endReason = 'turn-limit'; break; }
    const s = await nextCustomerTurn({ kase, transcript, customerTurnsSoFar: turn });
    simCost += s.costUsd;
    if (s.end || !s.message.trim()) { endReason = s.endReason || 'concluded'; break; }
    message = s.message;
  }
  const rec = { id: kase.id, system: SYSTEM, sessionId: conv.sessionId, endReason, customerTurns: transcript.filter((t) => t.role === 'customer').length, transcript, meta, simCostUsd: simCost, finishedAt: new Date().toISOString() };
  writeFileSync(`${OUT}/${kase.id}.json`, JSON.stringify(rec, null, 1));
  return rec;
}

function jevErrorsSinceStart() {
  try {
    const q = 'fields @timestamp, @message | filter @message like /Jev HTTP|JevError|engine_unavailable/ | stats count() as n';
    const out = execFileSync('bash', [process.env.INSIGHTS || '', '/aws/lambda/applianceclinic-diagnosis-engine', '1', q], { encoding: 'utf8' });
    const rows = JSON.parse(out).rows || []; return Number((rows[0] && rows[0].n) || 0);
  } catch (e) { log('jev check failed:', e.message.slice(0, 120)); return 0; }
}

if (SYSTEM === 'ac') await AC.init();
log(`${SYSTEM}: ${todo.length} cases to run (concurrency ${CONC})`);
let next = 0; let done = 0; const baselineJev = SYSTEM === 'ac' ? jevErrorsSinceStart() : 0;
async function worker() {
  while (!stop) {
    const i = next; next += 1; if (i >= todo.length) return;
    try {
      const r = await runCase(todo[i]);
      done += 1; log(`${done}/${todo.length} ${r.id} ${r.endReason} turns=${r.customerTurns}`);
    } catch (e) { log(`ERROR ${todo[i].id}: ${e.message.slice(0, 200)}`); }
    if (SYSTEM === 'ac' && done && done % 10 === 0) {
      const n = jevErrorsSinceStart();
      log(`jev/engine error lines in the last hour: ${n} (baseline ${baselineJev})`);
      if (n - baselineJev >= 3) stop = `Jev/engine errors rose by ${n - baselineJev}`;
    }
  }
}
await Promise.all(Array.from({ length: CONC }, worker));
if (stop) { log(`STOPPED: ${stop}`); process.exitCode = 2; }
log(`done ${readdirSync(OUT).length} conversations in ${OUT} (started ${START})`);
