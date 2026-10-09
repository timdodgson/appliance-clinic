// GOLD v2 live run against production, using the repository's runner, judge and report unchanged (Phase 8).
//
//   AWS_REGION=eu-west-1 GOLD_OUT=.migration-output/gold-v2/<date> GOLD_PRODUCT_SHA=<sha> node tools/gold-v2/run-live.mjs
//
// Needs: AWS credentials that can read the two secrets below, and outbound HTTPS to applianceclinic.ai and
// api.cloudflare.com (the Jev judge). GOLD_ONLY=<id,id> runs a subset. Concurrency is the suite's own (version.js).
// Transport: the service-authenticated benchmark path of POST /api (benchmark-auth.js): no customer transcript,
// not rate-limited, conversation continuity by session id, clientTurnId and the canonical state token.
// Secrets (benchmark HMAC key, Jev judge credentials) are read from Secrets Manager into memory only.
import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const require = createRequire(fileURLToPath(new URL('../../services/whichpart-api/index.js', import.meta.url)));
process.env.JEV_SECRET_ID = 'applianceclinic/production/jev';
const runner = require('./benchmark/gold-v2/runner.js');
const judge = require('./benchmark/gold-v2/judge.js');
const V = require('./benchmark/gold-v2/version.js');
const SET = require('./benchmark/gold-v2/scenarios.v2_2.json');
const benchmarkAuth = require('./benchmark-auth.js');
const aiConfig = require('./ai-config.js');

const API = process.env.GOLD_API || 'https://applianceclinic.ai/api';
const OUT = process.env.GOLD_OUT;
const ONLY = process.env.GOLD_ONLY ? process.env.GOLD_ONLY.split(',') : null;
const rid = (n) => randomBytes(n).toString('hex');

const secrets = await benchmarkAuth.loadSecrets();
if (!secrets || !secrets.current) throw new Error('benchmark service secret unavailable');
const creds = await aiConfig.getJevCredentials();
if (!creds) throw new Error('Jev judge credentials unavailable');
const evaluate = judge.makeJevEvaluate(creds);

function transportFor(scenario) {
  const sessionId = `bm-gold-${scenario.id.toLowerCase()}-${rid(6)}`;
  let stateToken = null; let n = 0;
  return async (messages) => {
    n += 1;
    const body = { messages, benchmark: { sessionId, clientTurnId: `bt-${n}-${rid(4)}` } };
    if (stateToken) body.stateToken = stateToken;
    const raw = JSON.stringify(body);
    const res = await fetch(API, { method: 'POST', headers: { 'content-type': 'application/json', [benchmarkAuth.HEADER]: benchmarkAuth.signRequest(secrets.current, raw) }, body: raw });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const view = await res.json();
    if (view && typeof view.stateToken === 'string') stateToken = view.stateToken;
    return view;
  };
}

const scenarios = SET.scenarios.filter((s) => !ONLY || ONLY.includes(s.id));
const results = new Array(scenarios.length);
let next = 0; let done = 0;
async function worker() {
  for (;;) {
    const i = next; next += 1;
    if (i >= scenarios.length) return;
    results[i] = await runner.runScenario({ scenario: scenarios[i], callApi: transportFor(scenarios[i]), evaluate });
    done += 1;
    console.log(`${done}/${scenarios.length} ${results[i].id} ${results[i].status}${results[i].error ? ' ' + results[i].error : ''}`);
  }
}
await Promise.all(Array.from({ length: Math.min(V.CONCURRENCY, scenarios.length) }, worker));
const agg = runner.aggregate(results);
const meta = V.versionMetadata({ productSha: process.env.GOLD_PRODUCT_SHA || null, scenarioSetVersion: SET.scenarioSetVersion });
if (OUT) {
  mkdirSync(OUT, { recursive: true });
  writeFileSync(`${OUT}/results.json`, JSON.stringify({ meta, agg, results }, null, 2));
  writeFileSync(`${OUT}/report.md`, runner.formatReport(agg, results, meta));
}
console.log(JSON.stringify({ meta, agg }, null, 2));
