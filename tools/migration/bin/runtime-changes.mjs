#!/usr/bin/env node
/**
 * Phase 7 onwards: refresh the SHA-256s in docs/migration/runtime-changes.json after a deliberate runtime change.
 * No AWS calls.
 *
 *   node bin/runtime-changes.mjs [--write]     without --write, list the entries whose hash is stale (exit 1 if any)
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from '../src/util/files.js';

const path = join(REPO_ROOT, 'docs', 'migration', 'runtime-changes.json');
const doc = JSON.parse(readFileSync(path, 'utf8'));
const sha256 = (p) => createHash('sha256').update(readFileSync(join(REPO_ROOT, p))).digest('hex');
const stale = [];
for (const f of [...doc.modified, ...doc.added]) {
  const now = sha256(f.path);
  if (now !== f.sha256) { stale.push(f.path); f.sha256 = now; }
}
if (process.argv.includes('--write')) {
  writeFileSync(path, `${JSON.stringify(doc, null, 2)}\n`);
  console.log(`updated ${stale.length}: ${stale.join(', ') || 'none'}`);
} else {
  console.log(stale.length ? `stale: ${stale.join(', ')}` : 'all current');
  process.exitCode = stale.length ? 1 : 0;
}
