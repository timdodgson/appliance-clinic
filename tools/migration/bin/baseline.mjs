#!/usr/bin/env node
/**
 * Behavioural baseline and S4R contract. Makes live HTTP requests only with --live.
 * Classification: SAFE AC CHANGE (customer-equivalent traffic and LLM spend; no transcripts
 * are stored because requests never carry `observability`). S4R checks are plain GETs.
 *
 *   node bin/baseline.mjs s4r-health --live [--out <file>]
 *   node bin/baseline.mjs contract capture --live --out <file>
 *   node bin/baseline.mjs contract verify --live --recorded <file>
 *   node bin/baseline.mjs smoke --live --out <file> [--compare <baseline-file>]
 *   node bin/baseline.mjs ingress capture --live --out <file>
 *   node bin/baseline.mjs ingress verify --live --recorded <file>
 *
 * `ingress` checks the diagnosis Lambda's second public ingress (S4R HTTP API, POST /ai/chat),
 * separately from the /part-finder contract.
 */
import { join } from 'node:path';
import { contractFrom, verifyContract } from '../src/baseline/contract.js';
import { summariseIngress, verifyIngress } from '../src/baseline/ingress.js';
import { createGuardedFetch, hostsOf } from '../src/baseline/http.js';
import { s4rHealth } from '../src/baseline/s4r-health.js';
import { checkExpectations, compareSmoke, summariseApiResponse } from '../src/baseline/smoke.js';
import { parseArgs } from '../src/util/args.js';
import { readJson, writeJson, TOOL_ROOT } from '../src/util/files.js';

const { flags, positional } = parseArgs(process.argv.slice(2));
const [command, sub] = positional;
const cfg = readJson(join(TOOL_ROOT, 'config', 'baseline.json'));
const usage = 'Usage: baseline.mjs <s4r-health | contract capture|verify | ingress capture|verify | smoke> --live [options]';

if (!command) { console.error(usage); process.exit(2); }
if (!flags.live) {
  console.log(`Dry run: "${positional.join(' ')}" would make live requests to: ${hostsOf(cfg.endpoints).join(', ')}.`);
  console.log('Add --live to run it. See docs/migration/runbooks/phase-0-baseline.md first.');
  process.exit(0);
}

const guardedFetch = createGuardedFetch({ allowedHosts: hostsOf(cfg.endpoints), maxRequests: cfg.limits.maxRequests, timeoutMs: cfg.limits.timeoutMs });
const capturedAt = new Date().toISOString();
const done = (result, ok) => {
  if (flags.out) writeJson(String(flags.out), { capturedAt, ...result });
  console.log(JSON.stringify(result, null, 2));
  process.exitCode = ok ? 0 : 1;
};

async function captureContract() {
  const url = cfg.endpoints.diagnosisFunctionUrl;
  const origin = cfg.endpoints.s4rOrigin;
  const preflight = await guardedFetch(url, { method: 'OPTIONS', headers: { origin, 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type' } });
  const post = await guardedFetch(url, { method: 'POST', headers: { origin }, body: cfg.partFinderContract.request });
  return contractFrom({ preflight, post });
}

if (command === 's4r-health') {
  const result = await s4rHealth(guardedFetch, cfg.endpoints);
  done(result, result.ok);
} else if (command === 'contract' && sub === 'capture') {
  const contract = await captureContract();
  done({ contract }, contract.post.status === 200 && contract.post.stream.hasDone);
} else if (command === 'contract' && sub === 'verify') {
  if (!flags.recorded) { console.error('contract verify needs --recorded <file>'); process.exit(2); }
  const recorded = readJson(String(flags.recorded)).contract;
  const current = await captureContract();
  const c = cfg.partFinderContract;
  const result = verifyContract(recorded, current, { requiredDoneFields: c.doneEventFieldsReadByS4R, requiredPartFields: c.partFieldsReadByS4R, requiredUnderstoodFields: c.understoodFieldsReadByS4R });
  done({ ...result, contract: current }, result.ok);
} else if (command === 'ingress' && (sub === 'capture' || sub === 'verify')) {
  const current = summariseIngress(await guardedFetch(cfg.endpoints.diagnosisAiChatRoute, { method: 'POST', body: cfg.aiChatIngress.request }));
  if (sub === 'capture') {
    done({ ingress: current }, current.status === 200);
  } else {
    if (!flags.recorded) { console.error('ingress verify needs --recorded <file>'); process.exit(2); }
    const result = verifyIngress(readJson(String(flags.recorded)).ingress, current);
    done({ ...result, ingress: current }, result.ok);
  }
} else if (command === 'smoke') {
  const summaries = {};
  const expectationProblems = [];
  for (const scenario of cfg.smokeScenarios) {
    const body = { messages: scenario.messages.map((content) => ({ role: 'user', content })) };
    const summary = summariseApiResponse(await guardedFetch(cfg.endpoints.acApi, { method: 'POST', body }));
    summaries[scenario.id] = summary;
    for (const p of checkExpectations(scenario, summary)) expectationProblems.push({ scenario: scenario.id, ...p });
  }
  const comparison = flags.compare ? compareSmoke(readJson(String(flags.compare)).summaries, summaries) : null;
  done({ summaries, expectationProblems, comparison }, expectationProblems.length === 0 && (!comparison || comparison.ok));
} else {
  console.error(usage);
  process.exit(2);
}
