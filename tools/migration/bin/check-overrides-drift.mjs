#!/usr/bin/env node
/**
 * Phase 11 (E): compare the declared runtime state with the deployed Lambda configuration (read-only).
 *   node bin/check-overrides-drift.mjs [--region eu-west-1]
 * Prints function, kind and key for every difference; never a value. Exit 1 on drift. Also reports, as information,
 * the AWSCURRENT version of the Admin-edited AI config secret (metadata only) and whether a benchmark routing lease
 * is active (an unreleased, unexpired lease outside a batch run is drift). Only the lease state is read and printed.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { GetFunctionCommand } from '@aws-sdk/client-lambda';
import { DescribeSecretCommand } from '@aws-sdk/client-secrets-manager';
import { GetObjectCommand } from '@aws-sdk/client-s3';
import { createReadOnlyClients } from '../src/aws/clients.js';
import { REPO_ROOT } from '../src/util/files.js';
import { overridesDrift, leaseState } from '../src/production/overrides-drift.js';

const region = process.argv.includes('--region') ? process.argv[process.argv.indexOf('--region') + 1] : 'eu-west-1';
const overrides = JSON.parse(readFileSync(join(REPO_ROOT, 'infra/cdk/config/runtime-overrides.json'), 'utf8'));
const c = createReadOnlyClients({ region, edgeRegion: "us-east-1", stackRegions: [region] });
const live = {}; const refs = {};
for (const fn of Object.keys(overrides.functions)) {
  const r = await c.lambda.send(new GetFunctionCommand({ FunctionName: fn }));
  live[fn] = { env: (r.Configuration.Environment && r.Configuration.Environment.Variables) || {}, codeSha256: r.Configuration.CodeSha256,
    imageDigest: r.Code && r.Code.ResolvedImageUri ? r.Code.ResolvedImageUri.split('@')[1] : null };
  try { refs[fn] = JSON.parse(readFileSync(join(REPO_ROOT, `build/reference/${fn}.zip.json`), 'utf8')).codeSha256; } catch { /* image function */ }
}
const result = overridesDrift(overrides.functions, live, refs);
const info = {};
try {
  const s = await c.secrets.send(new DescribeSecretCommand({ SecretId: 'applianceclinic/production/ai-config' }));
  info.aiConfig = { currentVersion: Object.entries(s.VersionIdsToStages || {}).find(([, st]) => st.includes('AWSCURRENT'))?.[0] || null,
    lastChanged: s.LastChangedDate || null };
} catch (e) { info.aiConfig = { error: e.name }; }
try {
  const o = await c.s3.send(new GetObjectCommand({ Bucket: 'whichpart-learning-800960611664', Key: 'acq/routing/override.json' }));
  const lease = JSON.parse(await o.Body.transformToString());
  info.routingLease = leaseState(lease, Date.now());
  if (info.routingLease === 'active') { result.findings.push({ fn: 'whichpart-api', kind: 'routing-lease-active' }); result.ok = false; }
} catch (e) { info.routingLease = e.name === 'NoSuchKey' ? 'none' : `unknown:${e.name}`; }
console.log(JSON.stringify({ ok: result.ok, findings: result.findings, info }, null, 1));
process.exit(result.ok ? 0 : 1);
