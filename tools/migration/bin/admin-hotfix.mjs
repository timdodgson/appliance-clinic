#!/usr/bin/env node
/**
 * Phase 1: apply or roll back the admin allowlist hotfix on whichpart-api.
 * MUTATING (SAFE AC CHANGE). Prints the plan unless --execute and --confirm-account are given.
 * Only PublishVersion, UpdateFunctionConfiguration and UpdateFunctionCode can be issued.
 * Environment values are read and written in memory only; they are never printed or saved.
 *
 *   node bin/admin-hotfix.mjs apply --original <deployed.zip> --patched <patched.zip>
 *        --expect-code-sha256 <from inventory> --subs <sub>[,<sub>] [--execute --confirm-account <id>]
 *   node bin/admin-hotfix.mjs rollback --original <deployed.zip> --expect-code-sha256 <from inventory>
 *        [--execute --confirm-account <id>]
 */
import { readFileSync } from 'node:fs';
import AdmZip from 'adm-zip';
import {
  GetFunctionConfigurationCommand,
  LambdaClient,
  PublishVersionCommand,
  UpdateFunctionCodeCommand,
  UpdateFunctionConfigurationCommand,
} from '@aws-sdk/client-lambda';
import { GetCallerIdentityCommand, STSClient } from '@aws-sdk/client-sts';
import { guardAllowlist } from '../src/aws/allowlisted-client.js';
import { guardReadOnly } from '../src/aws/readonly-client.js';
import { compareArtifacts } from '../src/compare/build-equivalence.js';
import { lambdaCodeSha256OfFile, readZipEntries } from '../src/compare/zip.js';
import { loadResourceConfig } from '../src/config.js';
import { mergeEnvironment, parseSubs, PATCH_MARKER, planHotfix, HotfixRefused } from '../src/hotfix/admin-allowlist.js';
import { parseArgs, requireFlag } from '../src/util/args.js';

const FUNCTION_NAME = 'whichpart-api';
const { flags, positional } = parseArgs(process.argv.slice(2));
const mode = positional[0];
if (!['apply', 'rollback'].includes(mode)) { console.error('Usage: admin-hotfix.mjs <apply|rollback> ...'); process.exit(2); }
const config = loadResourceConfig();
const lambdaRead = guardReadOnly(new LambdaClient({ region: config.region }));
const original = String(requireFlag(flags, 'original'));
const expected = String(requireFlag(flags, 'expect-code-sha256'));

async function waitForUpdate() {
  for (let i = 0; i < 60; i += 1) {
    const c = await lambdaRead.send(new GetFunctionConfigurationCommand({ FunctionName: FUNCTION_NAME }));
    if (c.LastUpdateStatus === 'Successful') return c;
    if (c.LastUpdateStatus === 'Failed') throw new Error(`Update failed: ${c.LastUpdateStatusReason}`);
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error('Timed out waiting for the function update.');
}

async function confirmAccount() {
  const account = (await guardReadOnly(new STSClient({ region: config.region })).send(new GetCallerIdentityCommand({}))).Account;
  if (String(flags['confirm-account'] || '') !== account) {
    console.error(`Refusing to run: --confirm-account must equal the caller account (${account}).`);
    process.exit(2);
  }
}

try {
  const live = await lambdaRead.send(new GetFunctionConfigurationCommand({ FunctionName: FUNCTION_NAME }));

  if (mode === 'apply') {
    const patched = String(requireFlag(flags, 'patched'));
    const subs = parseSubs(requireFlag(flags, 'subs'));
    const comparison = compareArtifacts(readZipEntries(original), readZipEntries(patched), { allowedDifferences: ['index.js'] });
    const patchedIndex = new AdmZip(patched).getEntry('index.js').getData().toString('utf8');
    const steps = planHotfix({
      functionName: FUNCTION_NAME,
      liveCodeSha256: live.CodeSha256,
      expectedCodeSha256: expected,
      originalZipCodeSha256: lambdaCodeSha256OfFile(original),
      comparison,
      patchedHasMarker: patchedIndex.includes(PATCH_MARKER),
      subs,
    });
    console.log('Admin hotfix plan (SAFE AC CHANGE):');
    for (const s of steps) console.log(`  ${s.step}: ${s.why}`);
    if (!flags.execute) { console.log('\nDry run. Nothing was changed.'); process.exit(0); }
    await confirmAccount();

    const lambda = guardAllowlist(new LambdaClient({ region: config.region }), ['PublishVersionCommand', 'UpdateFunctionConfigurationCommand', 'UpdateFunctionCodeCommand']);
    const version = await lambda.send(new PublishVersionCommand({ FunctionName: FUNCTION_NAME, CodeSha256: expected, Description: 'Snapshot before the Phase 1 admin allowlist hotfix' }));
    console.log(`  PublishVersion: version ${version.Version}`);
    const current = await lambdaRead.send(new GetFunctionConfigurationCommand({ FunctionName: FUNCTION_NAME }));
    await lambda.send(new UpdateFunctionConfigurationCommand({
      FunctionName: FUNCTION_NAME,
      RevisionId: current.RevisionId,
      Environment: { Variables: mergeEnvironment(current.Environment && current.Environment.Variables, subs) },
    }));
    const afterConfig = await waitForUpdate();
    console.log('  UpdateFunctionConfiguration: done');
    await lambda.send(new UpdateFunctionCodeCommand({ FunctionName: FUNCTION_NAME, ZipFile: readFileSync(patched), RevisionId: afterConfig.RevisionId }));
    const done = await waitForUpdate();
    const ok = done.CodeSha256 === lambdaCodeSha256OfFile(patched);
    console.log(`  UpdateFunctionCode: CodeSha256 ${ok ? 'matches the patched zip' : 'DOES NOT MATCH the patched zip'}`);
    console.log(`\nRollback: node bin/admin-hotfix.mjs rollback --original ${original} --expect-code-sha256 ${expected} --execute --confirm-account <id>`);
    process.exitCode = ok ? 0 : 1;
  } else {
    if (lambdaCodeSha256OfFile(original) !== expected) throw new HotfixRefused('The original zip does not match the expected CodeSha256.');
    console.log(`Rollback plan (SAFE AC CHANGE):\n  UpdateFunctionCode: restore the original zip (CodeSha256 ${expected}) to $LATEST.\n  ${'AC_ADMIN_SUBS'} is left in place; the original code ignores it.`);
    if (live.CodeSha256 === expected) { console.log('\nThe live code is already the original. Nothing to do.'); process.exit(0); }
    if (!flags.execute) { console.log('\nDry run. Nothing was changed.'); process.exit(0); }
    await confirmAccount();
    const lambda = guardAllowlist(new LambdaClient({ region: config.region }), ['UpdateFunctionCodeCommand']);
    await lambda.send(new UpdateFunctionCodeCommand({ FunctionName: FUNCTION_NAME, ZipFile: readFileSync(original), RevisionId: live.RevisionId }));
    const done = await waitForUpdate();
    console.log(`  UpdateFunctionCode: CodeSha256 ${done.CodeSha256 === expected ? 'matches the original' : 'DOES NOT MATCH the original'}`);
    process.exitCode = done.CodeSha256 === expected ? 0 : 1;
  }
} catch (err) {
  console.error(`${err.name}: ${err.message}`);
  process.exit(err instanceof HotfixRefused ? 1 : 2);
}
