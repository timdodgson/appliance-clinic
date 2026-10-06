#!/usr/bin/env node
/**
 * Compare a deployed Lambda artefact with a source export. No AWS calls.
 *
 *   node bin/compare-source.mjs --artifact <zip-or-dir> --source <dir> [--out <file>]
 *
 * Create the source export without touching the monorepo's working tree, for example:
 *   git -C <spares4repairs-clone> archive 13b7a50 | tar -x -C <empty-dir>
 */
import { compareDeployedWithSource } from '../src/compare/deployed-vs-source.js';
import { readEntries } from '../src/compare/zip.js';
import { parseArgs, requireFlag } from '../src/util/args.js';
import { writeJson } from '../src/util/files.js';

const { flags } = parseArgs(process.argv.slice(2));
const result = compareDeployedWithSource(readEntries(String(requireFlag(flags, 'artifact'))), readEntries(String(requireFlag(flags, 'source'))));
if (flags.out) writeJson(String(flags.out), result);
console.log(JSON.stringify(result.summary, null, 2));
for (const u of result.unmatched) console.log(`  not in source: ${u.path}`);
process.exitCode = result.summary.equivalent ? 0 : 1;
