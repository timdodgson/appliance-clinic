#!/usr/bin/env node
/**
 * Phase 4 sandbox guard (#34). Run before every sandbox action; exit code 1 means STOP.
 * Only `caller` calls AWS, and only sts:GetCallerIdentity through the read-only client.
 *
 *   node bin/sandbox-guard.mjs caller [--bootstrap]
 *   node bin/sandbox-guard.mjs target --type <CloudFormation type> --id <name or id> [--parent <name>]
 *   node bin/sandbox-guard.mjs document --file <template, change set or any JSON/text>
 *   node bin/sandbox-guard.mjs env --function <name>-sbx --file <environment JSON>
 *
 * All but `caller` accept --generated <file>: the recorded AWS-generated sandbox identifiers,
 * [{ "type": "AWS::Lambda::Url", "id": "<host>", "parent": "<allowlisted name>" }], by default
 * .migration-output/sandbox-generated.json when it exists.
 * --bootstrap allows the caller to be someone other than the sandbox operator, for approval point A only.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { GetCallerIdentityCommand, STSClient } from '@aws-sdk/client-sts';
import { guardReadOnly } from '../src/aws/readonly-client.js';
import {
  buildLists, checkCaller, checkDocument, checkFunctionEnv, checkTarget, loadSandboxLists, SANDBOX_REGION,
} from '../src/sandbox/guard.js';
import { parseArgs, requireFlag } from '../src/util/args.js';
import { readJson, REPO_ROOT } from '../src/util/files.js';

const { positional, flags } = parseArgs(process.argv.slice(2));
const command = positional[0];

function lists() {
  const defaultGenerated = join(REPO_ROOT, '.migration-output', 'sandbox-generated.json');
  const path = flags.generated ? String(flags.generated) : existsSync(defaultGenerated) ? defaultGenerated : null;
  return buildLists({ ...loadSandboxLists(), generated: path ? readJson(path) : [] });
}

const readDoc = (path) => {
  const text = readFileSync(path, 'utf8');
  try { return JSON.parse(text); } catch { return text; }
};

let failures;
let subject;
if (command === 'caller') {
  const region = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || '';
  const id = await guardReadOnly(new STSClient({ region: region || SANDBOX_REGION })).send(new GetCallerIdentityCommand({}));
  subject = { account: id.Account, region, arn: id.Arn };
  failures = checkCaller(subject, { bootstrap: Boolean(flags.bootstrap) });
} else if (command === 'target') {
  subject = { type: String(requireFlag(flags, 'type')), id: String(requireFlag(flags, 'id')), parent: flags.parent ? String(flags.parent) : undefined };
  failures = checkTarget(lists(), subject);
} else if (command === 'document') {
  subject = { file: String(requireFlag(flags, 'file')) };
  failures = checkDocument(lists(), readDoc(subject.file));
} else if (command === 'env') {
  subject = { function: String(requireFlag(flags, 'function')), file: String(requireFlag(flags, 'file')) };
  const doc = readDoc(subject.file);
  failures = checkFunctionEnv(lists(), subject.function, doc?.Variables || doc?.Environment?.Variables || doc);
} else {
  console.error('Usage: sandbox-guard.mjs caller|target|document|env ... (see the header of this file)');
  process.exit(2);
}

console.log(JSON.stringify({ command, subject, ok: failures.length === 0, failures }, null, 2));
console.log(failures.length === 0 ? '\nPASS' : '\nSTOP: do not run this sandbox action.');
process.exitCode = failures.length === 0 ? 0 : 1;
