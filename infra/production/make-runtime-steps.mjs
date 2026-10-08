#!/usr/bin/env node
/**
 * Write the Phase 5 runtime step files (infra/production/steps/5.5.json … 5.10.json) from a production capture
 * (capture-runtime.sh). Identifiers only: names, policy names, statement IDs and ARNs; never configuration values.
 *
 *   node make-runtime-steps.mjs <runtime-production.json>
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const live = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const dir = join(dirname(fileURLToPath(import.meta.url)), 'steps');
const logical = (n) => n.replace(/[^A-Za-z0-9]/g, '');
const A = '800960611664';
const S4R_ROLE = `arn:aws:iam::${A}:role/SparesSite-dev-ServerFunctionRoleC337EDB9-7aUzUc2qUHib`;
const fnArn = (f) => `arn:aws:lambda:eu-west-1:${A}:function:${f}`;
const NEVER = new Set(['apigateway-invoke']);

// The runtime template is cumulative: a later step's template still holds every resource already imported, so it
// carries the acknowledged S4R references of every earlier step as well as its own.
const carried = [];
function write(step, description, items, acknowledgedReferences = []) {
  carried.push(...acknowledgedReferences);
  const doc = { step, description, stack: 'AcRuntimeStack', allowedPhysicalIds: [], acknowledgedReferences: [...carried], import: [], expectedChanges: [] };
  for (const [type, logicalId, identifier, physicalId] of items) {
    doc.allowedPhysicalIds.push(physicalId);
    doc.import.push({ ResourceType: type, LogicalResourceId: logicalId, ResourceIdentifier: identifier });
    doc.expectedChanges.push({ action: 'Import', logicalId, type, physicalId });
  }
  writeFileSync(join(dir, `${step}.json`), `${JSON.stringify(doc, null, 2)}\n`);
}

const roles = Object.keys(live.roles);
write('5.5', 'The three AC IAM roles, without their inline policies (PLAN.md step 5.5). SAFE AC CHANGE.',
  roles.map((r) => ['AWS::IAM::Role', logical(r), { RoleName: r }, r]));

const POOL = 'eu-west-1_mUWucohuX';
write('5.6', 'The 9 AC inline policies as AWS::IAM::RolePolicy (PLAN.md step 5.6). SAFE AC CHANGE.',
  roles.flatMap((r) => Object.keys(live.roles[r].inline).map((p) => ['AWS::IAM::RolePolicy', logical(`${r}-${p}`), { PolicyName: p, RoleName: r }, `${p}|${r}`])),
  [{ value: POOL, reason: 'whichpart-cognito-auth (AC policy) allows AdminInitiateAuth on the S4R pool AC admin sign-in uses until Phase 7 (ownership.md). The policy is imported unchanged; the pool is S4R and never managed.' }]);

const FN = { '5.7a': 'spares4repairs-error-code-mcp', '5.7b': 'spares4repairs-diag-orchestrator', '5.7c': 'whichpart-api' };
// whichpart-api's environment names two S4R identifiers (ownership.md, Known S4R resources AC depends on).
const FN_REFERENCES = {
  'whichpart-api': [
    { value: '60phdcnl0eetdq4kcp327d0fkm', reason: 'COGNITO_CLIENT_ID: the S4R app client AC admin sign-in uses until Phase 7 (ownership.md, ADR 0006). An environment value of the AC function, imported unchanged; the client is S4R and never managed.' },
    { value: 'd1hrb3pgx61xww.cloudfront.net', reason: 'S4R_PRODUCT_BASE_URL: buy links point to the S4R shop CloudFront (ownership.md). An environment value of the AC function, imported unchanged; the distribution is S4R and never managed.' },
  ],
};
for (const [step, f] of Object.entries(FN)) {
  write(step, `Lambda function ${f} (PLAN.md step 5.7, least critical first). SAFE AC CHANGE.`, [['AWS::Lambda::Function', logical(f), { FunctionName: f }, f]], FN_REFERENCES[f]);
}

const urlAndPermissions = (f) => [
  ...(live.functions[f].url ? [['AWS::Lambda::Url', `${logical(f)}Url`, { FunctionArn: fnArn(f) }, fnArn(f)]] : []),
  ...live.functions[f].statements.filter((s) => !NEVER.has(s.Sid))
    .map((s) => ['AWS::Lambda::Permission', `${logical(f)}${logical(s.Sid)}`, { FunctionName: fnArn(f), Id: s.Sid }, s.Sid]),
];
write('5.8', 'Function URLs and permissions of the three AC functions (PLAN.md step 5.8). SAFE AC CHANGE.', Object.values(FN).flatMap(urlAndPermissions));

write('5.9', 'EventBridge rules, state as live (PLAN.md step 5.9). SAFE AC CHANGE.',
  Object.keys(live.rules).map((r) => ['AWS::Events::Rule', logical(r), { Arn: `arn:aws:events:eu-west-1:${A}:rule/${r}` }, `arn:aws:events:eu-west-1:${A}:rule/${r}`]));

const D = 'spares4repairs-part-finder';
write('5.10', 'Diagnosis Lambda, its URL and its AC-created permissions FnUrlPublic and PublicInvoke (PLAN.md step 5.10). POTENTIALLY IMPACTS S4R. Not its role; not apigateway-invoke.',
  [['AWS::Lambda::Function', logical(D), { FunctionName: D }, D], ...urlAndPermissions(D)],
  [{ value: 'SparesSite-dev-ServerFunctionRoleC337EDB9-7aUzUc2qUHib', reason: 'The diagnosis Lambda runs under the S4R server role (ADR 0011). The function references the role ARN unchanged; the role is never imported or modified.' },
   { value: S4R_ROLE, reason: 'The same role, by ARN, as the function\'s Role property.' }]);
console.log('wrote 5.5, 5.6, 5.7a, 5.7b, 5.7c, 5.8, 5.9, 5.10');
