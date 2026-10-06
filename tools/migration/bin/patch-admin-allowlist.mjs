#!/usr/bin/env node
/**
 * Phase 1: write a patched copy of the deployed whichpart-api zip. No AWS calls.
 *
 *   node bin/patch-admin-allowlist.mjs --in <deployed.zip> --out <patched.zip> [--entry index.js]
 *
 * Every other zip entry is copied unchanged; prove it with:
 *   npm run compare:build -- <deployed.zip> <patched.zip> --allow-diff index.js
 */
import AdmZip from 'adm-zip';
import { patchSource } from '../src/hotfix/admin-allowlist.js';
import { parseArgs, requireFlag } from '../src/util/args.js';

const { flags } = parseArgs(process.argv.slice(2));
const input = String(requireFlag(flags, 'in'));
const output = String(requireFlag(flags, 'out'));
const entryName = flags.entry ? String(flags.entry) : 'index.js';
if (input === output) { console.error('--out must differ from --in; the deployed zip is the rollback artefact.'); process.exit(2); }

const zip = new AdmZip(input);
const entry = zip.getEntry(entryName);
if (!entry) { console.error(`${entryName} not found in ${input}`); process.exit(2); }
try {
  const patched = patchSource(entry.getData().toString('utf8'));
  zip.updateFile(entryName, Buffer.from(patched, 'utf8'));
  zip.writeZip(output);
  console.log(`Patched ${entryName}; wrote ${output}`);
} catch (err) {
  console.error(`${err.name}: ${err.message}`);
  process.exit(1);
}
