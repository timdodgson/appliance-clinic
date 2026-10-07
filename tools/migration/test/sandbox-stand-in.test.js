import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkChangeSet } from '../src/changeset/check.js';
import { loadSandboxLists } from '../src/sandbox/guard.js';
import { readJson, REPO_ROOT } from '../src/util/files.js';

const lists = loadSandboxLists();
const s4rDeny = readJson(join(REPO_ROOT, 'docs', 'migration', 's4r-denylist.json')).entries;
const template = JSON.parse(readFileSync(join(REPO_ROOT, 'infra', 'sandbox', 'stand-in', 'sparessite-sbx.json'), 'utf8'));
const addAll = (t, stackName = 'SparesSite-sbx') => ({
  StackName: stackName,
  Changes: Object.entries(t.Resources).map(([id, r]) => ({ Type: 'Resource', ResourceChange: { Action: 'Add', LogicalResourceId: id, ResourceType: r.Type } })),
});
const run = (changeSet, t = template) => checkChangeSet({ changeSet, template: t, mode: 'sandbox', sandboxLists: lists, denylist: s4rDeny });

describe('the SparesSite-sbx stand-in', () => {
  it('passes the sandbox checker as a whole: children are checked as their sandbox parents', () => {
    const r = run(addAll(template));
    expect(r.failures).toEqual([]);
    expect(r.changes).toBe(Object.keys(template.Resources).length);
  });
  it('carries Retain, the sandbox tag and the boundary', () => {
    for (const r of Object.values(template.Resources)) expect(r.DeletionPolicy).toBe('Retain');
    expect(template.Resources.ServerFunctionRole.Properties.PermissionsBoundary).toBe('arn:aws:iam::800960611664:policy/ac-cfn-execution-sbx');
    expect(template.Resources.HttpApi.Properties.Tags).toEqual({ 'ac:sandbox': 'phase-4' });
    expect(template.Resources.UserPool.Properties.UserPoolTags).toEqual({ 'ac:sandbox': 'phase-4' });
  });
  it('fails a child whose parent is not a sandbox resource', () => {
    const t = JSON.parse(JSON.stringify(template));
    t.Resources.ServerInvokePermission.Properties.FunctionName = 'spares4repairs-part-finder';
    const rules = run(addAll(t), t).failures.map((f) => f.rule);
    expect(rules).toEqual(expect.arrayContaining(['change-target-not-sandbox', 'change-target-denylisted']));
  });
  it('fails a route on the production S4R API, by literal ApiId', () => {
    const t = JSON.parse(JSON.stringify(template));
    t.Resources.SearchRoute.Properties.ApiId = '65vnizdmk4';
    expect(run(addAll(t), t).failures.map((f) => f.rule)).toEqual(expect.arrayContaining(['change-target-not-sandbox', 'change-target-denylisted']));
  });
  it('identifies an AWS::IAM::Policy by its declared name, not its generated physical ID', () => {
    const cs = { StackName: 'SparesSite-sbx', Changes: [{ Type: 'Resource', ResourceChange: { Action: 'Modify', LogicalResourceId: 'ServerPolicy', PhysicalResourceId: 'Spare-Serve-XYZ123', ResourceType: 'AWS::IAM::Policy' } }] };
    expect(run(cs).failures).toEqual([]);
    const t = JSON.parse(JSON.stringify(template));
    t.Resources.ServerPolicy.Properties.PolicyName = 'ServerFunctionRoleDefaultPolicy975E5328';
    expect(run(cs, t).failures.map((f) => f.rule)).toContain('change-target-not-sandbox');
  });
  it('fails a denylisted physical ID on an existing child even if the template looks sandbox', () => {
    const cs = { StackName: 'SparesSite-sbx', Changes: [{ Type: 'Resource', ResourceChange: { Action: 'Modify', LogicalResourceId: 'HttpApi', PhysicalResourceId: '65vnizdmk4', ResourceType: 'AWS::ApiGatewayV2::Api' } }] };
    expect(run(cs).failures.map((f) => f.rule)).toEqual(expect.arrayContaining(['change-target-not-sandbox', 'change-target-denylisted']));
  });
  it('reads a removed RolePolicy by its physical ID policy|role, as role/policy (T5)', () => {
    const cs = (id) => ({ StackName: 'AcIamExperiments-sbx', Changes: [{ Type: 'Resource', ResourceChange: { Action: 'Remove', LogicalResourceId: 'T5Policy', PhysicalResourceId: id, ResourceType: 'AWS::IAM::RolePolicy' } }] });
    expect(run(cs('iam-t5-policy-sbx|iam-t5-role-sbx'), { Resources: {} }).failures).toEqual([]);
    expect(run(cs('whichpart-cognito-auth|whichpart-api-role'), { Resources: {} }).failures.map((f) => f.rule)).toEqual(expect.arrayContaining(['change-target-not-sandbox', 'change-target-denylisted']));
  });
});
