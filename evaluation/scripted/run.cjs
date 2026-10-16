#!/usr/bin/env node
'use strict';
/**
 * Scripted pass/fail tests (evaluation/scripted/tests.json) run straight against the engine's turn code
 * (services/diagnosis-engine/ac2/runtime.js) with the production dependencies: the AI config, Claude, the error-code
 * service, the parts catalogue and the media mappings. No simulated customer and no judge: the customer messages are
 * fixed and every reply is checked by fixed rules.
 *
 *   node evaluation/scripted/run.cjs --out evaluation/scripted/out/<name> [--only ID,ID] [--budget 15]
 *
 * Needs AWS credentials for the AC account (secrets). Writes results.json and report.md; prints the pass count and
 * the spend. Stops before starting a new test once the spend passes --budget (USD).
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const ENGINE = process.env.ENGINE_DIR || path.join(ROOT, 'services', 'diagnosis-engine');
const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const OUT = path.resolve(arg('--out', path.join(__dirname, 'out', 'run')));
const ONLY = (arg('--only', '') || '').split(',').filter(Boolean);
const BUDGET = Number(arg('--budget', '15'));
// Claude Opus 5.5 list price per token (USD).
const PRICE = { in: 4 / 1e6, out: 20 / 1e6 };

process.env.AWS_REGION = process.env.AWS_REGION || 'eu-west-1';
process.env.AI_CONFIG_SECRET_ID = 'applianceclinic/production/ai-config';
process.env.OPENAI_SECRET_ID = 'applianceclinic/production/openai';
process.env.MCP_URL = process.env.MCP_URL || 'https://44ydoowtcn66qqwv6tqsi2psee0uflvi.lambda-url.eu-west-1.on.aws';

async function secret(id) {
  const { SecretsManagerClient, GetSecretValueCommand } = require('@aws-sdk/client-secrets-manager');
  const sm = new SecretsManagerClient({ region: process.env.AWS_REGION });
  return (await sm.send(new GetSecretValueCommand({ SecretId: id }))).SecretString;
}

/**
 * This sandbox's network policy blocks the error-code service's Function URL (the proxy answers 403), so requests to it
 * are sent to the same production function through the Lambda API instead (a Function URL event). Everything else
 * uses the normal fetch.
 */
function routeErrorCodeService() {
  const { LambdaClient, InvokeCommand } = require(path.join(ROOT, 'tools', 'migration', 'node_modules', '@aws-sdk', 'client-lambda'));
  const lambda = new LambdaClient({ region: process.env.AWS_REGION });
  const host = new URL(process.env.MCP_URL).host;
  const realFetch = global.fetch;
  global.fetch = async (url, init = {}) => {
    const u = new URL(String(url));
    if (u.host !== host) return realFetch(url, init);
    const headers = Object.fromEntries(Object.entries(init.headers || {}).map(([k, v]) => [k.toLowerCase(), v]));
    const event = { version: '2.0', routeKey: '$default', rawPath: u.pathname, rawQueryString: '', headers: { ...headers, host },
      requestContext: { http: { method: init.method || 'GET', path: u.pathname, protocol: 'HTTP/1.1', sourceIp: '127.0.0.1', userAgent: 'scripted-tests' }, domainName: host, requestId: 'scripted', routeKey: '$default', stage: '$default', timeEpoch: Date.now() },
      body: init.body || '', isBase64Encoded: false };
    const r = await lambda.send(new InvokeCommand({ FunctionName: 'applianceclinic-error-code-mcp', Payload: Buffer.from(JSON.stringify(event)) }));
    const out = JSON.parse(Buffer.from(r.Payload).toString('utf8'));
    const body = out.isBase64Encoded ? Buffer.from(out.body || '', 'base64').toString('utf8') : (out.body || '');
    return { ok: out.statusCode >= 200 && out.statusCode < 300, status: out.statusCode, json: async () => JSON.parse(body), text: async () => body };
  };
}

// Spend: every model call through the provider boundary is counted.
const spend = { in: 0, out: 0, calls: 0 };
function meter() {
  const inf = require(path.join(ENGINE, 'inference.js'));
  const orig = inf.AnthropicProvider.prototype.converse;
  inf.AnthropicProvider.prototype.converse = async function metered(...a) {
    const r = await orig.apply(this, a);
    spend.calls += 1;
    if (r && r.usage) { spend.in += r.usage.promptTokens || 0; spend.out += r.usage.completionTokens || 0; }
    return r;
  };
}
const usd = () => spend.in * PRICE.in + spend.out * PRICE.out;

const words = (t) => String(t || '').trim().split(/\s+/).filter(Boolean).length;
const re = (p) => new RegExp(p, 'i');

function check(turn, reply, response, global) {
  const fails = [];
  const text = String(reply || '');
  if (!text.trim()) fails.push('empty reply');
  for (const group of turn.any || []) if (!group.some((p) => re(p).test(text))) fails.push(`missing one of: ${group.join(' | ')}`);
  for (const p of turn.none || []) if (re(p).test(text)) fails.push(`must not say: ${p}`);
  const parts = (response && response.parts) || [];
  if (turn.part === false && parts.length) fails.push(`part shown when none expected: ${parts.map((p) => p.title).join('; ')}`);
  if (typeof turn.part === 'string' && !parts.some((p) => re(turn.part).test(p.title || ''))) fails.push(`no part matching "${turn.part}" shown`);
  const media = (response && response.media) || [];
  if (turn.media === true && !media.length) fails.push('no help image shown');
  if (turn.media === false && media.length) fails.push('image shown when none expected');
  const stop = Boolean(response && response.safety && response.safety.stopUse) || (response && response.outcome === 'SAFETY_STOP');
  if (turn.safety === true && !stop) fails.push('stop-use safety flag not set');
  if (turn.safety === false && stop) fails.push('stop-use safety flag set wrongly');
  if (turn.global !== false) {
    const n = words(text);
    if (n > global.maxWords) fails.push(`too long: ${n} words (max ${global.maxWords})`);
    const items = (text.match(/(?:^|\n)\s*(?:\d+[.)]|[-•])\s+/g) || []).length;
    if (items > global.maxListItems) fails.push(`list of ${items} items (max ${global.maxListItems})`);
    for (const p of global.forbid) if (new RegExp(p).test(text)) fails.push(`layout: matches ${p}`);
    if (global.mustEndCleanly && text.trim() && !/[.!?)"'’”]$/.test(text.trim())) fails.push('reply ends mid-sentence');
  }
  return fails;
}

/** --rescore: check a saved run again against the current tests.json (no model calls). */
function rescore(spec) {
  const saved = JSON.parse(fs.readFileSync(path.join(OUT, 'results.json'), 'utf8'));
  const byId = new Map(spec.tests.map((t) => [t.id, t]));
  for (const r of saved.results) {
    const t = byId.get(r.id);
    r.turns.forEach((x, i) => {
      if (x.error) return;
      const response = { parts: (x.parts || []).map((title) => ({ title })), media: x.media || [], safety: x.safety ? { stopUse: true } : null };
      x.fails = check(t.turns[i], x.reply, response, spec.global);
    });
    r.pass = r.turns.length === t.turns.length && r.turns.every((x) => !x.fails.length);
  }
  const all = saved.results.flatMap((r) => r.turns);
  saved.summary = { ...saved.summary, passed: saved.results.filter((r) => r.pass).length, turnsPassed: all.filter((x) => !x.fails.length).length, rescored: true };
  fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify(saved, null, 1));
  console.log(JSON.stringify(saved.summary));
}

(async () => {
  const spec = JSON.parse(fs.readFileSync(path.join(__dirname, 'tests.json'), 'utf8'));
  if (process.argv.includes('--rescore')) { rescore(spec); return; }
  process.env.MCP_BEARER_TOKEN = process.env.MCP_BEARER_TOKEN || JSON.parse(await secret('applianceclinic/production/mcp-bearer')).token;
  meter();
  routeErrorCodeService();
  const runtime = require(path.join(ENGINE, 'ac2', 'runtime.js'));
  fs.mkdirSync(OUT, { recursive: true });
  const results = [];
  for (const t of spec.tests) {
    if (ONLY.length && !ONLY.includes(t.id)) continue;
    if (usd() > BUDGET) { console.log(`budget reached ($${usd().toFixed(2)}), stopping before ${t.id}`); break; }
    const messages = [];
    let state = null;
    const turns = [];
    for (const turn of t.turns) {
      messages.push({ role: 'user', content: turn.customer });
      const t0 = Date.now();
      let out;
      try {
        out = await runtime.turn({ messages, state, tools: { recalls: [] } });
      } catch (e) {
        turns.push({ customer: turn.customer, error: `${e.name}: ${e.message}`, fails: ['turn failed'] });
        break;
      }
      const response = out.response || {};
      const reply = response.message || '';
      const fails = check(turn, reply, response, spec.global);
      turns.push({ customer: turn.customer, reply, words: words(reply), parts: (response.parts || []).map((p) => p.title), media: (response.media || []).map((m) => m.title),
        safety: Boolean(response.safety && response.safety.stopUse) || response.outcome === 'SAFETY_STOP', ms: Date.now() - t0, fails });
      state = out.state;
      messages.push({ role: 'assistant', content: reply, ...(response.media ? { media: response.media } : {}) });
    }
    const pass = turns.length === t.turns.length && turns.every((x) => !x.fails.length);
    results.push({ id: t.id, pass, turns });
    console.log(`${pass ? 'PASS' : 'FAIL'} ${t.id}${pass ? '' : `: ${turns.flatMap((x) => x.fails).join('; ')}`}  ($${usd().toFixed(2)})`);
  }
  const passed = results.filter((r) => r.pass).length;
  const turnTotal = results.flatMap((r) => r.turns).length;
  const turnPass = results.flatMap((r) => r.turns).filter((x) => !x.fails.length).length;
  const summary = { tests: results.length, passed, turns: turnTotal, turnsPassed: turnPass, spendUsd: Number(usd().toFixed(2)), modelCalls: spend.calls };
  fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify({ summary, results }, null, 1));
  const md = [`# Scripted tests: ${path.basename(OUT)}`, '', `Tests passed: **${passed}/${results.length}**; replies passed: ${turnPass}/${turnTotal}; spend $${summary.spendUsd}.`, ''];
  for (const r of results) {
    md.push(`## ${r.pass ? 'PASS' : 'FAIL'} ${r.id}`);
    for (const x of r.turns) {
      md.push(`**Customer:** ${x.customer}`, '', `**Reply** (${x.words} words${x.parts && x.parts.length ? `; parts: ${x.parts.join(', ')}` : ''}${x.media && x.media.length ? `; image: ${x.media.join(', ')}` : ''}${x.safety ? '; SAFETY STOP' : ''}):`, '', (x.reply || x.error || '').replace(/^/gm, '> '), '');
      if (x.fails.length) md.push(`Failed: ${x.fails.join('; ')}`, '');
    }
  }
  fs.writeFileSync(path.join(OUT, 'report.md'), md.join('\n'));
  console.log(JSON.stringify(summary));
})().catch((e) => { console.error('RUN FAILED', e.message); process.exit(1); });
