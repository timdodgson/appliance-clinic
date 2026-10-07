#!/usr/bin/env node
/**
 * Compare two inventory captures (directories written by bin/inventory.mjs). No AWS calls.
 * Lambda environment values are never printed or written: only names and SHA-256 digests.
 *
 *   node bin/compare-config.mjs <baseline-dir> <current-dir> [--out <file>]
 */
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { diffValues, redactEnvironmentDifferences, splitCloudFormationTags } from '../src/compare/config-diff.js';
import { parseArgs } from '../src/util/args.js';
import { readJson, writeJson } from '../src/util/files.js';

const { flags, positional } = parseArgs(process.argv.slice(2));
if (positional.length !== 2) { console.error('Usage: compare-config.mjs <baseline-dir> <current-dir>'); process.exit(2); }
const [baseDir, curDir] = positional;
const SKIP = new Set(['meta.json', 'errors.json', 'cloudtrail-creation-events.json']);
const report = {};
let driftCount = 0;
for (const file of readdirSync(baseDir).filter((f) => f.endsWith('.json') && !SKIP.has(f)).sort()) {
  const curPath = join(curDir, file);
  if (!existsSync(curPath)) { report[file] = { missingInCurrent: true }; driftCount += 1; continue; }
  // Environment values are redacted before anything is printed or written.
  const differences = redactEnvironmentDifferences(diffValues(readJson(join(baseDir, file)), readJson(curPath)));
  const { drift, cloudformationTags } = splitCloudFormationTags(differences);
  report[file] = { drift, cloudformationTags };
  driftCount += drift.length;
  for (const d of drift) console.log(`  ${file} ${d.path}: ${JSON.stringify(d.before)} -> ${JSON.stringify(d.after)}`);
}
if (flags.out) writeJson(String(flags.out), report);
console.log(`\n${driftCount} configuration difference(s).`);
process.exitCode = driftCount === 0 ? 0 : 1;
