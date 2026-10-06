#!/usr/bin/env node
/**
 * File-for-file comparison of two artefacts (zip or directory). No AWS calls.
 *
 *   node bin/compare-build.mjs <a> <b> [--allow-diff path[,path]] [--ignore path[,path]] [--out <file>]
 *
 * Phase 1: prove the hotfix zip differs from the deployed zip only in the intended file.
 * Phase 3: prove a build from this repository matches the deployed artefact.
 */
import { statSync } from 'node:fs';
import { compareArtifacts } from '../src/compare/build-equivalence.js';
import { lambdaCodeSha256OfFile, readEntries } from '../src/compare/zip.js';
import { parseArgs } from '../src/util/args.js';
import { writeJson } from '../src/util/files.js';

const { flags, positional } = parseArgs(process.argv.slice(2));
if (positional.length !== 2) { console.error('Usage: compare-build.mjs <a> <b> [--allow-diff p1,p2] [--ignore p1,p2]'); process.exit(2); }
const list = (v) => (typeof v === 'string' ? v.split(',').map((s) => s.trim()).filter(Boolean) : []);
const [a, b] = positional;
const result = compareArtifacts(readEntries(a), readEntries(b), { allowedDifferences: list(flags['allow-diff']), ignore: list(flags.ignore) });
const codeSha = (p) => (statSync(p).isDirectory() ? null : lambdaCodeSha256OfFile(p));
result.codeSha256 = { a: codeSha(a), b: codeSha(b) };
if (flags.out) writeJson(String(flags.out), result);
console.log(JSON.stringify(result, null, 2));
process.exitCode = result.equivalent ? 0 : 1;
