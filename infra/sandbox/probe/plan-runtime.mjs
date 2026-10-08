#!/usr/bin/env node
/**
 * The sandbox copies of the AC runtime resources for the import-semantics probe, derived from the production capture
 * (infra/production/capture-runtime.sh) so they have production's shape:
 *
 *   node plan-runtime.mjs <runtime-production.json> <stand-in pool id> <stand-in client id> <stand-in api id> > plan.json
 *
 * Names are mapped to their sandbox copies; inline policy names take the Phase 4 "-sbx" suffix; the S4R pool and API
 * become the stand-in's. Environment values never carry production values into the sandbox: URLs become
 * https://example.invalid/, bearer tokens are left for the setup to fill with dummies, admin user IDs become a zero UUID,
 * and the rest are name-mapped. Rules are DISABLED (Phase 4 rule: nothing runs on a schedule in the sandbox).
 * The plan holds no secret: it is safe to keep next to the probe results.
 */
import { readFileSync } from 'node:fs';
import { SANDBOX_NAMES, toSandbox } from '../../../tools/migration/src/production/import-writes.js';
import { REQUIRED_OVERRIDES } from '../../../tools/migration/src/sandbox/guard.js';

const [file, pool, client, api] = process.argv.slice(2);
if (!api) { console.error('usage: plan-runtime.mjs <capture> <pool> <client> <api>'); process.exit(2); }
const live = JSON.parse(readFileSync(file, 'utf8'));
const A = '800960611664';
const extra = {
  ...SANDBOX_NAMES,
  'spares4repairs/dev/applianceclinic-*': 'applianceclinic-sbx/*',
  'eu-west-1_mUWucohuX': pool,
  '65vnizdmk4': api,
  'whichpart-api-review': 'whichpart-api-review-sbx',
};
const map = (v) => toSandbox(v, extra);
const ZERO = '00000000-0000-0000-0000-000000000000';

/**
 * A sandbox function also sets every variable the Phase 4 guard requires, so the runtime never falls back to a
 * production default (runbook section 4). Production leaves these to the code's defaults; the sandbox copy carries a
 * few more variables than production, which does not change how CloudFormation's import handler treats Environment.
 */
const DEFAULT_BY_KIND = (key, fn) => ({
  stage: 'sbx', url: 'https://example.invalid/', generated: key === 'COGNITO_CLIENT_ID' ? client : pool,
  bucket: key === 'WHICHPART_WEB_BUCKET' ? `whichpart-web-sbx-${A}` : `whichpart-learning-sbx-${A}`,
  table: key === 'RECALL_TABLE' ? 'whichpart-recalls-sbx' : 'whichpart-transcripts-sbx',
  secret: key === 'BENCHMARK_SERVICE_SECRET_ID' ? 'applianceclinic-sbx/benchmark-service' : 'applianceclinic-sbx/canonical-state-token',
}[REQUIRED_OVERRIDES[fn][key]]);

function env(vars = {}, fn) {
  const out = {};
  for (const [k, v] of Object.entries(vars)) {
    if (/TOKEN$/.test(k)) out[k] = '@DUMMY@';
    else if (k === 'AC_ADMIN_SUBS') out[k] = ZERO;
    else if (k === 'COGNITO_USER_POOL_ID') out[k] = pool;
    else if (k === 'COGNITO_CLIENT_ID') out[k] = client;
    else if (/^https?:\/\//.test(v)) out[k] = 'https://example.invalid/';
    else out[k] = map(v);
  }
  for (const key of Object.keys(REQUIRED_OVERRIDES[fn] || {})) if (!(key in out)) out[key] = DEFAULT_BY_KIND(key, fn);
  return out;
}

const plan = { roles: {}, functions: {}, rules: {} };
for (const [name, r] of Object.entries(live.roles)) {
  plan.roles[map(name)] = {
    trust: r.trust, managed: r.managed,
    inline: Object.fromEntries(Object.entries(r.inline).map(([p, d]) => [`${p}-sbx`, map(d)])),
  };
}
for (const [name, f] of Object.entries(live.functions)) {
  const c = f.configuration;
  const role = c.Role.includes('SparesSite-dev-ServerFunctionRole')
    ? `arn:aws:iam::${A}:role/SparesSite-sbx-ServerFunctionRole` : map(c.Role);
  plan.functions[map(name)] = {
    packageType: c.PackageType, runtime: c.Runtime || null, handler: c.Handler || null, architectures: c.Architectures,
    memorySize: c.MemorySize, timeout: c.Timeout, role, environment: env(c.Environment?.Variables, map(name)),
    imageUri: f.code.imageUri ? map(f.code.imageUri.replace(/\/([a-z0-9-]+):/, (m, repo) => `/${extra[repo] || repo}:`)) : null,
    url: f.url ? { AuthType: f.url.AuthType, InvokeMode: f.url.InvokeMode, Cors: f.url.Cors || null } : null,
    statements: f.statements.map((s) => map(s)),
  };
}
for (const [name, r] of Object.entries(live.rules)) {
  plan.rules[map(name)] = {
    scheduleExpression: r.scheduleExpression, state: 'DISABLED',
    targets: r.targets.map((t) => ({ Id: extra[t.Id] || map(t.Id), Arn: map(t.Arn), ...(t.Input ? { Input: t.Input } : {}) })),
  };
}
console.log(JSON.stringify(plan, null, 2));
