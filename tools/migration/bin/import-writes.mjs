#!/usr/bin/env node
/**
 * Phase 5 import semantics helpers (src/production/import-writes.js). No AWS calls.
 *
 *   node bin/import-writes.mjs probe-policy [--writes a:B,c:D]       the sandbox probe role's inline policy
 *   node bin/import-writes.mjs sandbox-step --step <production step.json>   the same step with sandbox names
 *   node bin/import-writes.mjs check-writes --events <cloudtrail.json> --types T1,T2   writes against the manifest
 *   node bin/import-writes.mjs step-policy --step <production step.json>   ac-cfn-execution with the step's writes
 *   node bin/import-writes.mjs proof-policy --manifest <phase-6-proof-writes.json>   ac-cfn-execution with the proof's writes
 *   check-writes also takes --manifest <phase-6-proof-writes.json> --variant add|remove
 */
import { checkWrites, loadManifest, probePolicy, proofWriteStatements, stepWriteStatements, toSandbox } from '../src/production/import-writes.js';
import { executionPolicy } from '../src/production/toolkit.js';
import { parseArgs, requireFlag } from '../src/util/args.js';
import { readJson } from '../src/util/files.js';

const { positional, flags } = parseArgs(process.argv.slice(2));
const list = (v) => (v ? String(v).split(',').filter(Boolean) : []);

const [command] = positional;
if (command === 'probe-policy') {
  console.log(JSON.stringify(probePolicy(list(flags.writes)), null, 2));
} else if (command === 'sandbox-step') {
  const step = readJson(String(requireFlag(flags, 'step')));
  console.log(JSON.stringify({ ...toSandbox(step), stack: `${step.stack}-sbx` }, null, 2));
} else if (command === 'check-writes') {
  // --manifest <file> --variant <name>: a Phase 6 proof manifest (docs/migration/phase-6-proof-writes.json) instead of
  // the Phase 5 import manifest.
  const manifest = flags.manifest ? readJson(String(flags.manifest)).variants[String(requireFlag(flags, 'variant'))] : loadManifest();
  if (!manifest) throw new Error(`no variant ${flags.variant} in ${flags.manifest}`);
  const failures = checkWrites(readJson(String(requireFlag(flags, 'events'))), manifest, list(flags.types));
  console.log(JSON.stringify({ ok: failures.length === 0, failures }, null, 2));
  process.exitCode = failures.length ? 1 : 0;
} else if (command === 'proof-policy') {
  console.log(JSON.stringify(executionPolicy(proofWriteStatements(readJson(String(requireFlag(flags, 'manifest'))))), null, 2));
} else if (command === 'step-policy') {
  console.log(JSON.stringify(executionPolicy(stepWriteStatements(readJson(String(requireFlag(flags, 'step'))), loadManifest())), null, 2));
} else {
  console.error('Usage: import-writes.mjs probe-policy|sandbox-step|check-writes|step-policy|proof-policy');
  process.exitCode = 2;
}
