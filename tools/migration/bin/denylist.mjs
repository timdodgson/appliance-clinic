#!/usr/bin/env node
/**
 * Generate docs/migration/s4r-denylist.json from a Phase 0 inventory directory. No AWS calls.
 *
 *   node bin/denylist.mjs --inventory <dir> [--write <path>]
 */
import { join } from 'node:path';
import { loadKnownS4R, loadResourceConfig } from '../src/config.js';
import { generateDenylist } from '../src/denylist/generate.js';
import { parseArgs, requireFlag } from '../src/util/args.js';
import { readJson, writeJson, REPO_ROOT } from '../src/util/files.js';

const { flags } = parseArgs(process.argv.slice(2));
const dir = String(requireFlag(flags, 'inventory'));
const target = flags.write ? String(flags.write) : join(REPO_ROOT, 'docs', 'migration', 's4r-denylist.json');
const config = loadResourceConfig();

const denylist = generateDenylist({
  meta: readJson(join(dir, 'meta.json')),
  stacks: readJson(join(dir, 'cloudformation-stacks.json')),
  sharedPrefixSecrets: readJson(join(dir, 'secrets-shared-prefix.json')),
  acSecretPrefixes: config.secretNamePrefixes,
  knownEntries: loadKnownS4R(),
});
writeJson(target, denylist);
const stacks = denylist.entries.filter((e) => e.kind === 'stack').length;
console.log(`Wrote ${denylist.entries.length} entries (${stacks} stacks) to ${target}`);
