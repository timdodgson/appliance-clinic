import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  AC, POLICY, QUALIFIER, TOOLKIT_STACK, denyPolicy, executionPolicy, patchBootstrapTemplate,
} from '../src/production/toolkit.js';
import { iamGlobMatch, MANAGED_POLICY_MAX, policySize } from '../src/sandbox/approval-a.js';
import { readJson, REPO_ROOT } from '../src/util/files.js';

const A = '800960611664';
const dir = join(REPO_ROOT, 'docs', 'migration', 'phase-5', 'toolkit');
const committed = (n) => JSON.parse(readFileSync(join(dir, n), 'utf8'));
const stock = readJson(join(REPO_ROOT, 'docs', 'migration', 'sandbox', 'approval-a', 'bootstrap-stock-v32.json'));
const exec = executionPolicy();
const deny = denyPolicy();
const list = (x) => (Array.isArray(x) ? x : [x]);
const matches = (statement, arn) => list(statement.Resource).some((r) => iamGlobMatch(r, arn));
const actionMatches = (statement, action) => list(statement.Action).some((a) => iamGlobMatch(a, action));
const allows = (action, arn) => exec.Statement.some((s) => s.Effect === 'Allow' && actionMatches(s, action) && matches(s, arn));
const denies = (action, arn) => deny.Statement.some((s) => s.Effect === 'Deny' && !s.Condition && (s.Action ? actionMatches(s, action) : !list(s.NotAction).some((a) => iamGlobMatch(a, action))) && matches(s, arn));

const acArns = readJson(join(REPO_ROOT, 'docs', 'migration', 'ac-production-denylist.json')).entries
  .map((e) => e.value)
  .filter((v) => v.startsWith('arn:') && !v.endsWith('/') && !v.endsWith('-') && !/cloudfront|acm:/.test(v));
const s4rArns = readJson(join(REPO_ROOT, 'docs', 'migration', 's4r-denylist.json')).entries.map((e) => e.value).filter((v) => v.startsWith('arn:'));
const S4R = {
  role: `arn:aws:iam::${A}:role/SparesSite-dev-ServerFunctionRoleC337EDB9-7aUzUc2qUHib`,
  stack: `arn:aws:cloudformation:eu-west-1:${A}:stack/SparesSite-dev/5ae181b0-847e-11f1-a8f4-060bd449d135`,
  toolkit: `arn:aws:cloudformation:eu-west-1:${A}:stack/CDKToolkit/0a6119bd-7ccb-4746-8279-d9cbb789265e`,
  api: 'arn:aws:apigateway:eu-west-1::/apis/65vnizdmk4',
  route: 'arn:aws:apigateway:eu-west-1::/apis/65vnizdmk4/routes/ncdglq1',
  pool: `arn:aws:cognito-idp:eu-west-1:${A}:userpool/eu-west-1_mUWucohuX`,
  server: `arn:aws:lambda:eu-west-1:${A}:function:spares4repairs-server-dev`,
  bucket: 'arn:aws:s3:::spares4repairs-orders-dev',
  secret: `arn:aws:secretsmanager:eu-west-1:${A}:secret:spares4repairs/dev/stripe-LvGdUb`,
};

describe('the production toolkit documents', () => {
  it('are committed exactly as generated', () => {
    expect(committed('ac-cfn-execution.json')).toEqual(exec);
    expect(committed('ac-deny-s4r.json')).toEqual(deny);
    expect(committed('bootstrap-acclinic.json')).toEqual(patchBootstrapTemplate(stock));
  });
  it('fit the managed-policy size limit', () => {
    expect(policySize(exec)).toBeLessThanOrEqual(MANAGED_POLICY_MAX);
    expect(policySize(deny)).toBeLessThanOrEqual(MANAGED_POLICY_MAX);
  });
});

describe('ac-cfn-execution', () => {
  it('allows reads only: no action that could change a resource, and never a secret value', () => {
    for (const s of exec.Statement) {
      expect(s.Effect).toBe('Allow');
      for (const a of list(s.Action)) expect(a, s.Sid).toMatch(/^[a-z0-9-]+:(Get|List|Describe|BatchGet)/);
      expect(list(s.Action)).not.toContain('secretsmanager:GetSecretValue');
    }
    for (const a of ['lambda:UpdateFunctionConfiguration', 'lambda:UpdateFunctionCode', 'lambda:AddPermission', 'lambda:TagResource', 'iam:PutRolePolicy',
      'iam:TagRole', 'dynamodb:UpdateTable', 'dynamodb:TagResource', 's3:PutBucketPolicy', 's3:PutBucketTagging', 'secretsmanager:GetSecretValue',
      'secretsmanager:TagResource', 'ecr:PutLifecyclePolicy', 'events:PutRule', 'events:PutTargets']) {
      expect(exec.Statement.some((s) => actionMatches(s, a)), a).toBe(false);
    }
  });
  it('reads every AC production resource of the import set', () => {
    const reads = {
      lambda: 'lambda:GetFunction', iam: 'iam:GetRole', dynamodb: 'dynamodb:DescribeTable', s3: 's3:GetBucketPolicy',
      secretsmanager: 'secretsmanager:DescribeSecret', ecr: 'ecr:DescribeRepositories', events: 'events:DescribeRule',
    };
    const targets = acArns.filter((a) => !/migration-backup|log-group|:role\/cdk-|s3:::cdk-/.test(a));
    expect(targets.length).toBeGreaterThan(20);
    for (const arn of targets) {
      const service = arn.split(':')[2];
      expect(allows(reads[service], arn), arn).toBe(true);
    }
  });
  it('reads no object in an AC bucket (customer data), and no S4R resource', () => {
    for (const b of AC.buckets) expect(allows('s3:GetObject', `arn:aws:s3:::${b}/any/key`)).toBe(false);
    for (const arn of [...s4rArns, ...Object.values(S4R)]) {
      for (const a of ['lambda:GetFunction', 'iam:GetRole', 'dynamodb:DescribeTable', 's3:GetBucketPolicy', 'secretsmanager:DescribeSecret']) {
        expect(allows(a, arn), `${a} ${arn}`).toBe(false);
      }
    }
  });
});

describe('ac-deny-s4r', () => {
  it('denies every action on the S4R role, stacks, API, pool, server Lambda, buckets and secrets', () => {
    for (const [k, arn] of Object.entries(S4R)) {
      for (const a of ['iam:PutRolePolicy', 'iam:PassRole', 'cloudformation:UpdateStack', 'apigateway:PATCH', 'cognito-idp:UpdateUserPool', 'lambda:UpdateFunctionCode', 's3:PutObject', 'secretsmanager:GetSecretValue']) {
        expect(denies(a, arn), `${k} ${a}`).toBe(true);
      }
    }
  });
  it('covers every ARN on the generated S4R denylist that names an S4R resource', () => {
    const reached = s4rArns.filter((arn) => !/cloudfront/.test(arn)).filter((arn) => !denies('*', arn));
    expect(reached).toEqual([]);
  });
  it('never denies an AC production resource: no S4R pattern reaches an AC name', () => {
    for (const arn of acArns) expect(denies('lambda:GetFunction', arn) && !/cloudfront|acm/.test(arn), arn).toBe(false);
    for (const s of deny.Statement.filter((x) => x.Sid === 'DenyS4R')) {
      for (const arn of acArns) expect(matches(s, arn), arn).toBe(false);
    }
  });
});

describe('the acclinic bootstrap template', () => {
  const t = patchBootstrapTemplate(stock);
  it('uses the acclinic qualifier and the two policies as the execution role policies', () => {
    expect(t.Parameters.Qualifier.Default).toBe(QUALIFIER);
    expect(t.Parameters.Qualifier.AllowedValues).toEqual([QUALIFIER]);
    expect(t.Parameters.CloudFormationExecutionPolicies.Default).toBe(`arn:aws:iam::${A}:policy/${POLICY.execution},arn:aws:iam::${A}:policy/${POLICY.deny}`);
    expect(t.Parameters.TrustedAccounts.Default).toBe('');
  });
  it('gives the deploy role CloudFormation rights on the AC stacks and the toolkit only', () => {
    for (const s of t.Resources.DeploymentActionRole.Properties.Policies[0].PolicyDocument.Statement) {
      if (list(s.Action).some((a) => a.startsWith('cloudformation:'))) {
        const res = JSON.stringify(s.Resource);
        expect(res).toMatch(/stack\/AcDataStack\/\*/);
        expect(res).not.toMatch(/stack\/\*|SparesSite|CDKToolkit/);
      }
    }
    expect(JSON.stringify(t.Resources.DeploymentActionRole.Properties.Policies)).toContain(`stack/${TOOLKIT_STACK}/*`);
  });
  it('attaches the S4R deny to every toolkit role, and retains every resource', () => {
    for (const n of ['DeploymentActionRole', 'FilePublishingRole', 'ImagePublishingRole', 'LookupRole']) {
      expect(JSON.stringify(t.Resources[n].Properties.ManagedPolicyArns), n).toContain(`policy/${POLICY.deny}`);
    }
    for (const r of Object.values(t.Resources)) expect(r.DeletionPolicy).toBe('Retain');
  });
});
