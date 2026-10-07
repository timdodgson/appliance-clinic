#!/usr/bin/env node
/**
 * Render the Phase 5 production toolkit documents into docs/migration/phase-5/toolkit/. No AWS calls.
 *
 *   node bin/production-toolkit.mjs [--check]
 *
 * --check  fail (exit 1) if a committed document differs from what the generator produces
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { denyPolicy, executionPolicy, patchBootstrapTemplate } from '../src/production/toolkit.js';
import { parseArgs } from '../src/util/args.js';
import { REPO_ROOT } from '../src/util/files.js';

export const TOOLKIT_DIR = join(REPO_ROOT, 'docs', 'migration', 'phase-5', 'toolkit');
const { flags } = parseArgs(process.argv.slice(2));
const stock = JSON.parse(readFileSync(join(REPO_ROOT, 'docs', 'migration', 'sandbox', 'approval-a', 'bootstrap-stock-v32.json'), 'utf8'));
const files = {
  'ac-cfn-execution.json': executionPolicy(),
  'ac-deny-s4r.json': denyPolicy(),
  'bootstrap-acclinic.json': patchBootstrapTemplate(stock),
};
mkdirSync(TOOLKIT_DIR, { recursive: true });
let stale = 0;
for (const [name, value] of Object.entries(files)) {
  const text = `${JSON.stringify(value, null, 2)}\n`;
  const path = join(TOOLKIT_DIR, name);
  if (flags.check) {
    let current = null;
    try { current = readFileSync(path, 'utf8'); } catch { /* missing */ }
    if (current !== text) { console.error(`stale: ${name}`); stale += 1; }
  } else writeFileSync(path, text);
}
console.log(flags.check ? `${stale} stale document(s).` : `Rendered ${Object.keys(files).length} documents into ${TOOLKIT_DIR}`);
process.exitCode = stale ? 1 : 0;
