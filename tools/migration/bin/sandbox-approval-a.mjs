#!/usr/bin/env node
/**
 * Render the approval point A documents (#34) into docs/migration/sandbox/approval-a/. No AWS calls.
 *
 *   node bin/sandbox-approval-a.mjs [--check]
 *
 * --check  fail (exit 1) if a committed document differs from what the generator produces
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  budget, budgetNotifications, denyPolicy, executionPolicy, operatorPolicy, operatorTrustPolicy, patchBootstrapTemplate,
} from '../src/sandbox/approval-a.js';
import { parseArgs } from '../src/util/args.js';
import { REPO_ROOT } from '../src/util/files.js';

export const APPROVAL_A_DIR = join(REPO_ROOT, 'docs', 'migration', 'sandbox', 'approval-a');
const { flags } = parseArgs(process.argv.slice(2));
const stock = JSON.parse(readFileSync(join(APPROVAL_A_DIR, 'bootstrap-stock-v32.json'), 'utf8'));
const files = {
  'ac-operator-policy-sbx.json': operatorPolicy(),
  'ac-cfn-execution-sbx.json': executionPolicy(),
  'ac-deny-production-sbx.json': denyPolicy(),
  'ac-operator-sbx-trust.json': operatorTrustPolicy(),
  'ac-budget-sbx.json': budget(),
  'ac-budget-sbx-notifications.json': budgetNotifications(),
  'bootstrap-acsbx.json': patchBootstrapTemplate(stock),
};
let stale = 0;
for (const [name, value] of Object.entries(files)) {
  const text = `${JSON.stringify(value, null, 2)}\n`;
  const path = join(APPROVAL_A_DIR, name);
  if (flags.check) {
    let current = null;
    try { current = readFileSync(path, 'utf8'); } catch { /* missing */ }
    if (current !== text) { console.error(`stale: ${name}`); stale += 1; }
  } else writeFileSync(path, text);
}
console.log(flags.check ? `${stale} stale document(s).` : `Rendered ${Object.keys(files).length} documents into ${APPROVAL_A_DIR}`);
process.exitCode = stale ? 1 : 0;
