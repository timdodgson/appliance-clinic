// The change-set checker on real change sets from the Phase 4 sandbox (#34), as CloudFormation returned them, and on
// copies doctored into each failure the checker must catch.
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkChangeSet } from '../src/changeset/check.js';
import { buildLists } from '../src/sandbox/guard.js';
import { readJson, REPO_ROOT } from '../src/util/files.js';

const fixture = (n) => readJson(join(REPO_ROOT, 'tools', 'migration', 'test', 'fixtures', 'sandbox', n));
const doc = (n) => readJson(join(REPO_ROOT, 'docs', 'migration', n));
// The stand-in user pool's ID was generated at creation and recorded (infra/sandbox/lib.sh, record_generated).
const lists = buildLists({
  allowlist: doc('sandbox-allowlist.json'), acDenylist: doc('ac-production-denylist.json').entries, s4rDenylist: doc('s4r-denylist.json').entries,
  generated: [{ type: 'AWS::Cognito::UserPoolId', id: 'eu-west-1_h0dTMOGFQ', parent: 'SparesSite-sbx-UserPool' }],
});
// As bin/check-changeset.mjs runs sandbox mode: the S4R denylist here, the AC denylist through the sandbox lists.
const denylist = doc('s4r-denylist.json').entries;
const copy = (x) => JSON.parse(JSON.stringify(x));
const run = (changeSet, template, mode = 'sandbox', extra = {}) => checkChangeSet({ changeSet, template, mode, sandboxLists: lists, denylist, ...extra });
const rules = (r) => r.failures.map((f) => f.rule);

const importCs = fixture('runtime-import-1.changeset.json');
const urlRemove = fixture('runtime-url-remove.changeset.json');
const template = fixture('runtime.template.json');
const PROD_FN = 'arn:aws:lambda:eu-west-1:800960611664:function:spares4repairs-part-finder';

describe('real AcRuntimeStack-sbx change sets', () => {
  it('the runtime import (32 Import actions) passes the sandbox checker', () => {
    expect(importCs.Changes).toHaveLength(32);
    expect(rules(run(importCs, template))).toEqual([]);
  });
  it('the URL removal (5.8) passes: a removed URL is checked as the function its ARN names', () => {
    expect(urlRemove.Changes[0].ResourceChange).toMatchObject({ Action: 'Remove', ResourceType: 'AWS::Lambda::Url' });
    expect(rules(run(urlRemove, template))).toEqual([]);
  });
});

describe('real change sets, doctored into failures', () => {
  it('fails the URL removal when its physical ID is the production diagnosis Lambda', () => {
    const cs = copy(urlRemove);
    cs.Changes[0].ResourceChange.PhysicalResourceId = PROD_FN;
    expect(rules(run(cs, template))).toEqual(expect.arrayContaining(['change-target-denylisted', 'production-ac-identifier']));
  });
  it('fails the import in import mode when one action is not Import', () => {
    const cs = copy(importCs);
    cs.Changes[0].ResourceChange.Action = 'Modify';
    const ids = importCs.Changes.map((c) => c.ResourceChange.PhysicalResourceId);
    expect(rules(run(cs, template, 'import', { allowedPhysicalIds: ids }))).toContain('non-import-action');
  });
  it('fails a template that points a sandbox function at a production AC function', () => {
    const t = copy(template);
    t.Resources.whichpartapisbx.Properties.Environment.Variables.ENGINE_URL = PROD_FN;
    expect(rules(run(importCs, t))).toContain('production-ac-identifier');
  });
  it('fails a template that names the production S4R API', () => {
    const t = copy(template);
    t.Resources.spares4repairspartfindersbx.Properties.Environment.Variables.SEARCH_API = 'https://65vnizdmk4.execute-api.eu-west-1.amazonaws.com/api/search';
    expect(rules(run(importCs, t))).toContain('denylisted-identifier-in-template');
  });
  it('fails an imported resource without Retain', () => {
    const t = copy(template);
    delete t.Resources.whichpartapisbx.DeletionPolicy;
    expect(rules(run(importCs, t))).toContain('missing-retain-deletion-policy');
  });
  it('fails a change set on a production stack name', () => {
    expect(rules(run({ ...copy(importCs), StackName: 'AcRuntimeStack' }, template))).toContain('stack-not-sandbox');
  });
});
