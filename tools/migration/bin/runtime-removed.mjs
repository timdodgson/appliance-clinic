#!/usr/bin/env node
/**
 * Record deleted runtime files in docs/migration/runtime-changes.json: every `modified` entry whose file no longer
 * exists moves to `removed` with the change id and reason given; every imported file (both import manifests) that no
 * longer exists and is not yet listed as removed is added to `removed` too; an `added` entry whose file is gone is simply
 * dropped (`removed` lists imported files only, as the tooling tests require). No AWS calls.
 *
 *   node bin/runtime-removed.mjs <change-id> "<reason>"
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from '../src/util/files.js';

const [id, reason] = process.argv.slice(2);
if (!id || !reason) { console.error('usage: runtime-removed.mjs <change-id> "<reason>"'); process.exit(2); }
const path = join(REPO_ROOT, 'docs', 'migration', 'runtime-changes.json');
const doc = JSON.parse(readFileSync(path, 'utf8'));
const manifests = ['import-manifest.json', 'import-manifest-phase-2b.json']
  .map((n) => JSON.parse(readFileSync(join(REPO_ROOT, 'docs', 'migration', n), 'utf8')));
const gone = [];
const dropped = [];
doc.modified = doc.modified.filter((f) => {
  if (existsSync(join(REPO_ROOT, f.path))) return true;
  gone.push(f.path);
  doc.removed.push({ path: f.path, changes: [id], reason });
  return false;
});
doc.added = doc.added.filter((f) => {
  if (existsSync(join(REPO_ROOT, f.path))) return true;
  dropped.push(f.path);
  return false;
});
const already = new Set(doc.removed.map((f) => f.path));
for (const m of manifests) {
  for (const f of m.files) {
    if (existsSync(join(REPO_ROOT, f.path)) || already.has(f.path)) continue;
    gone.push(f.path);
    doc.removed.push({ path: f.path, changes: [id], reason });
    already.add(f.path);
  }
}
writeFileSync(path, `${JSON.stringify(doc, null, 2)}\n`);
console.log(`removed ${gone.length}: ${gone.join(', ') || 'none'}`);
if (dropped.length) console.log(`dropped (never imported) ${dropped.length}: ${dropped.join(', ')}`);
