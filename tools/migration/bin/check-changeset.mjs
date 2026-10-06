#!/usr/bin/env node
/**
 * Check a CloudFormation change set before it is executed. No AWS calls.
 *
 *   aws cloudformation describe-change-set --stack-name <stack> --change-set-name <name> > changeset.json
 *   node bin/check-changeset.mjs --changeset changeset.json --mode import|update --step <step.json>
 *        [--denylist ../../docs/migration/s4r-denylist.json] [--template cdk.out/<Stack>.template.json]
 *        [--inventory <dir>]
 *
 * step.json: { "step": "5.1", "allowedPhysicalIds": [...], "approvedRemovals": [...], "s4rConsumedPhysicalIds": [...],
 *              "acknowledgedReferences": [{ "value": "<S4R id>", "reason": "<why an AC resource refers to it>" }] }
 * --inventory supplies secret digests so literal secret values in the template are detected.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { checkChangeSet } from '../src/changeset/check.js';
import { collectDigests } from '../src/redact.js';
import { parseArgs, requireFlag } from '../src/util/args.js';
import { readJson, REPO_ROOT } from '../src/util/files.js';

const { flags } = parseArgs(process.argv.slice(2));
const denylistPath = flags.denylist ? String(flags.denylist) : join(REPO_ROOT, 'docs', 'migration', 's4r-denylist.json');
const step = readJson(String(requireFlag(flags, 'step')));
let secretDigests = [];
if (flags.inventory) {
  const digests = new Set();
  for (const f of ['lambda-functions.json', 'secrets.json']) {
    const p = join(String(flags.inventory), f);
    if (existsSync(p)) collectDigests(readJson(p), digests);
  }
  secretDigests = [...digests];
}
const result = checkChangeSet({
  changeSet: readJson(String(requireFlag(flags, 'changeset'))),
  denylist: readJson(denylistPath).entries,
  mode: String(requireFlag(flags, 'mode')),
  allowedPhysicalIds: step.allowedPhysicalIds || [],
  approvedRemovals: step.approvedRemovals || [],
  s4rConsumedPhysicalIds: step.s4rConsumedPhysicalIds || [],
  acknowledgedReferences: step.acknowledgedReferences || [],
  template: flags.template ? readJson(String(flags.template)) : null,
  secretDigests,
});
console.log(JSON.stringify({ step: step.step || null, ...result }, null, 2));
console.log(result.ok ? '\nPASS' : '\nFAIL: do not execute this change set.');
process.exitCode = result.ok ? 0 : 1;
