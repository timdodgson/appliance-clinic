#!/usr/bin/env node
/**
 * Phase 0 inventory. READ-ONLY: every AWS call goes through the read-only guard.
 *
 *   node bin/inventory.mjs [--out <dir>] [--download-code] [--hash-secret-values] [--cloudtrail]
 *                          [--expect-account <id>]
 *
 * --download-code       fetch deployed Lambda zips (HTTP GET of the pre-signed code URL)
 * --hash-secret-values  read secret values to record digests and JSON key names (values never written)
 * --cloudtrail          look up creation events for ownership evidence (last 90 days only)
 */
import { join } from 'node:path';
import { GetCallerIdentityCommand } from '@aws-sdk/client-sts';
import { createReadOnlyClients } from '../src/aws/clients.js';
import { loadResourceConfig, withAccount } from '../src/config.js';
import { investigateApiPermissions } from '../src/inventory/apigateway.js';
import { inventoryDistribution, inventoryCloudFrontFunction, listDistributions, distributionsUsingFunctions } from '../src/inventory/cloudfront.js';
import { inventoryStacks } from '../src/inventory/cloudformation.js';
import { creationEvents } from '../src/inventory/cloudtrail.js';
import { inventoryTable } from '../src/inventory/dynamodb.js';
import { inventoryRepository, digestFromImageUri } from '../src/inventory/ecr.js';
import { inventoryRule } from '../src/inventory/events.js';
import { inventoryRole } from '../src/inventory/iam.js';
import { inventoryFunction, listAllFunctions, roleUsage } from '../src/inventory/lambda.js';
import { ownershipChecks, externalDependencies } from '../src/inventory/ownership-checks.js';
import { inventoryBucket } from '../src/inventory/s3.js';
import { inventorySecret, listSecretsByPrefix } from '../src/inventory/secrets.js';
import { parseArgs } from '../src/util/args.js';
import { timestampDir, writeJson, DEFAULT_OUTPUT_ROOT } from '../src/util/files.js';

const { flags } = parseArgs(process.argv.slice(2));
const config = loadResourceConfig();
const out = flags.out ? String(flags.out) : timestampDir(DEFAULT_OUTPUT_ROOT, 'inventory');
const c = createReadOnlyClients({ ...config, allowSecretValues: Boolean(flags['hash-secret-values']) });
const errors = [];

async function area(name, fn) {
  try {
    const value = await fn();
    writeJson(join(out, `${name}.json`), value);
    console.log(`  ${name}: ok`);
    return value;
  } catch (err) {
    errors.push({ area: name, error: err.name, message: err.message });
    console.error(`  ${name}: FAILED (${err.name}: ${err.message})`);
    return null;
  }
}

let identity;
try {
  identity = await c.sts.send(new GetCallerIdentityCommand({}));
} catch (err) {
  console.error(`Could not identify the AWS caller (${err.name}: ${err.message}). Check AWS_PROFILE; see docs/migration/runbooks/phase-0-inventory.md.`);
  process.exit(2);
}
const account = identity.Account;
if (flags['expect-account'] && String(flags['expect-account']) !== account) {
  console.error(`Refusing to run: credentials are for account ${account}, expected ${flags['expect-account']}.`);
  process.exit(2);
}
console.log(`Inventory of account ${account} (${config.region}) as ${identity.Arn}\nWriting to ${out}`);

const meta = await area('meta', async () => ({
  capturedAt: new Date().toISOString(),
  accountId: account,
  callerArn: identity.Arn,
  region: config.region,
  options: { downloadCode: Boolean(flags['download-code']), hashSecretValues: Boolean(flags['hash-secret-values']), cloudtrail: Boolean(flags.cloudtrail) },
}));

const stacks = await area('cloudformation-stacks', async () => {
  const all = [];
  for (const region of config.stackRegions) all.push(...(await inventoryStacks(c.cloudformation[region], region)));
  return all;
});

const allFunctions = await area('lambda-all-functions', () => listAllFunctions(c.lambda));
const usage = allFunctions ? roleUsage(allFunctions) : {};
const candidateNames = config.lambdas.map((l) => l.name);
const functions = await area('lambda-functions', async () => {
  const list = [];
  for (const l of config.lambdas) {
    const exists = allFunctions ? allFunctions.some((f) => f.name === l.name) : true;
    if (!exists) { list.push({ name: l.name, exists: false }); continue; }
    const rec = await inventoryFunction(c.lambda, l.name, { downloadCodeTo: flags['download-code'] ? join(out, 'artifacts') : null });
    list.push({ exists: true, s4rConsumed: Boolean(l.s4rConsumed), ...rec });
  }
  return list;
});

// Which APIs may invoke each function, and whether any of them actually does (read-only).
await area('apigateway-permissions', async () => {
  const list = [];
  for (const f of functions || []) {
    if (!f.exists || !f.resourcePolicy) continue;
    list.push(...(await investigateApiPermissions({ apigateway: c.apigateway, apigatewayv2: c.apigatewayv2, functionName: f.name, policy: f.resourcePolicy, stacks: stacks || [] })));
  }
  return list;
});

const roleNames = new Set(config.roles);
for (const f of functions || []) if (f.exists) roleNames.add(String(f.configuration.Role).split('/').pop());
const roles = await area('iam-roles', async () => {
  const list = [];
  for (const name of [...roleNames].sort()) list.push(await inventoryRole(c.iam, name));
  return list;
});

const tables = await area('dynamodb-tables', async () => Promise.all(config.tables.map((t) => inventoryTable(c.dynamodb, t))));

const buckets = await area('s3-buckets', async () => {
  const list = [];
  for (const b of config.buckets) {
    list.push(await inventoryBucket(c.s3, withAccount(b.name, account), { manifest: b.manifest, captureObjects: b.captureObjects || [], captureTo: join(out, 'captured-objects') }));
  }
  return list;
});

const secrets = await area('secrets', async () => {
  const found = await listSecretsByPrefix(c.secrets, config.secretNamePrefixes);
  const list = [];
  for (const s of found) list.push(await inventorySecret(c.secrets, s.ARN, { hashValue: Boolean(flags['hash-secret-values']) }));
  return list;
});
// Names and ARNs only, of every secret under the shared prefix: the denylist needs the S4R ones.
await area('secrets-shared-prefix', async () => (await listSecretsByPrefix(c.secrets, ['spares4repairs/'])).map((s) => ({ name: s.Name, arn: s.ARN })));

const repositories = await area('ecr-repositories', async () => {
  const list = await Promise.all(config.ecrRepositories.map((r) => inventoryRepository(c.ecr, r)));
  for (const repo of list) {
    if (!repo.exists) continue;
    repo.deployedBy = (functions || [])
      .filter((f) => f.exists && f.code.resolvedImageUri && f.code.resolvedImageUri.startsWith(repo.uri))
      .map((f) => ({ function: f.name, digest: digestFromImageUri(f.code.resolvedImageUri) }));
  }
  return list;
});

const rules = await area('eventbridge-rules', async () => Promise.all(config.eventRules.map((r) => inventoryRule(c.events, r))));

const cloudfront = await area('cloudfront', async () => {
  const dists = await listDistributions(c.cloudfront);
  const ac = dists.filter((d) => ((d.Aliases && d.Aliases.Items) || []).some((a) => config.cloudfront.aliases.includes(a)));
  const acDistributions = [];
  for (const d of ac) acDistributions.push(await inventoryDistribution(c.cloudfront, d.Id));
  const fns = [];
  for (const name of config.cloudfront.functions) fns.push(await inventoryCloudFrontFunction(c.cloudfront, name));
  const sharing = distributionsUsingFunctions(dists, config.cloudfront.functions);
  const acIds = new Set(ac.map((d) => d.Id));
  return { distributions: acDistributions, functions: fns, otherDistributions: sharing.filter((h) => !acIds.has(h.distributionId)) };
});

if (flags.cloudtrail) await area('cloudtrail-creation-events', () => creationEvents(c.cloudtrail, config.cloudtrailEventNames));

await area('external-dependencies', async () => externalDependencies((functions || []).filter((f) => f.exists)));

const flagsFound = await area('ownership-flags', async () => ownershipChecks({
  stacks: stacks || [],
  functions: functions || [],
  roleUsage: usage,
  candidateFunctionNames: candidateNames,
  roles: roles || [],
  tables: tables || [],
  buckets: buckets || [],
  secrets: secrets || [],
  repositories: repositories || [],
  rules: rules || [],
  cloudfrontSharing: cloudfront || { otherDistributions: [] },
}));

writeJson(join(out, 'errors.json'), errors);
const stops = (flagsFound || []).filter((f) => f.severity === 'stop');
console.log(`\nDone. ${errors.length} area error(s), ${stops.length} ownership STOP flag(s).`);
for (const s of stops) console.log(`  STOP ${s.kind} ${s.id}: ${s.reason}`);
if (meta === null || errors.length) process.exitCode = 1;
