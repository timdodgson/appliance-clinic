import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { checkWrites, loadManifest, probePolicy, proofWriteStatements, SANDBOX_NAMES, stepWriteStatements, toSandbox } from '../src/production/import-writes.js';
import { executionPolicy } from '../src/production/toolkit.js';
import { readJson, REPO_ROOT } from '../src/util/files.js';
import { iamGlobMatch } from '../src/sandbox/approval-a.js';

const A = '800960611664';

describe('toSandbox', () => {
  it('maps whole production names only, in one pass', () => {
    expect(toSandbox({ r: `arn:aws:iam::${A}:role/whichpart-api-role`, f: 'whichpart-api', t: 'whichpart-api-review' }))
      .toEqual({ r: `arn:aws:iam::${A}:role/whichpart-api-role-sbx`, f: 'whichpart-api-sbx', t: 'whichpart-api-review' });
  });
  it('maps a secret ARN, keeping its random suffix for the probe to resolve', () => {
    expect(toSandbox(`arn:aws:secretsmanager:eu-west-1:${A}:secret:spares4repairs/dev/applianceclinic-ai-config-s40OwY`))
      .toBe(`arn:aws:secretsmanager:eu-west-1:${A}:secret:applianceclinic-sbx/ai-config-s40OwY`);
    expect(toSandbox({ Name: 'spares4repairs/diag-orchestrator/bearer-token' })).toEqual({ Name: 'applianceclinic-sbx/diag-orchestrator/bearer-token' });
  });
  it('maps every production name to a sandbox name', () => {
    for (const v of Object.values(SANDBOX_NAMES)) expect(v).toMatch(/-sbx|applianceclinic-sbx\/|ESBXPLACEHOLDER/);
  });
});

describe('probePolicy', () => {
  it('is read-only without writes, and grants exactly the writes given, on sandbox resources only', () => {
    const ro = probePolicy();
    for (const s of ro.Statement) for (const a of s.Action) expect(a).toMatch(/^[a-z0-9-]+:(Get|List|Describe|BatchGet)/);
    const p = probePolicy(['ecr:SetRepositoryPolicy']);
    const w = p.Statement.find((s) => s.Sid === 'Writeecr');
    expect(w.Action).toEqual(['ecr:SetRepositoryPolicy']);
    expect(w.Resource.some((r) => iamGlobMatch(r, `arn:aws:ecr:eu-west-1:${A}:repository/spares4repairs-error-code-mcp`))).toBe(false);
    expect(w.Resource.some((r) => iamGlobMatch(r, `arn:aws:ecr:eu-west-1:${A}:repository/spares4repairs-error-code-mcp-sbx`))).toBe(true);
    expect(() => probePolicy(['ecr:*'])).toThrow(/exact action/);
  });
});

describe('checkWrites', () => {
  const manifest = { types: { 'AWS::ECR::Repository': { expectedWrites: ['ecr:SetRepositoryPolicy', 'ecr:TagResource'], forbiddenWrites: ['ecr:DeleteRepositoryPolicy'] } } };
  const ev = (action) => ({ action, resource: 'r' });
  it('passes expected writes, and fails forbidden or unknown ones', () => {
    expect(checkWrites([ev('ecr:SetRepositoryPolicy'), ev('ecr:TagResource')], manifest, ['AWS::ECR::Repository'])).toEqual([]);
    expect(checkWrites([ev('ecr:DeleteRepositoryPolicy')], manifest, ['AWS::ECR::Repository']).map((f) => f.rule)).toEqual(['forbidden-write']);
    expect(checkWrites([ev('ecr:PutLifecyclePolicy')], manifest, ['AWS::ECR::Repository']).map((f) => f.rule)).toEqual(['unexpected-write']);
  });
});

describe('the expected-write manifest and the production step policies', () => {
  const manifest = loadManifest();
  const step = (n) => readJson(join(REPO_ROOT, 'infra', 'production', 'steps', `${n}.json`));
  const writes = (n) => stepWriteStatements(step(n), manifest);
  it('covers every resource type of every Phase 5 step', () => {
    for (const n of ['5.1', '5.2', '5.3a', '5.3b', '5.4', '5.5', '5.6', '5.7a', '5.7b', '5.7c', '5.8', '5.9', '5.10']) {
      for (const e of step(n).import) expect(manifest.types[e.ResourceType], `${n} ${e.ResourceType}`).toBeDefined();
    }
  });
  it('never expects a write it also forbids, and never a delete', () => {
    for (const [t, m] of Object.entries(manifest.types)) {
      for (const w of m.expectedWrites) {
        expect(m.forbiddenWrites, t).not.toContain(w);
        expect(w, t).not.toMatch(/Delete|Remove|Untag|PutSecretValue|PassRole|UpdateFunction(Configuration|Code)/);
      }
    }
  });
  it('grants 5.1 exactly the four ECR writes, on exactly the canary repository', () => {
    expect(writes('5.1')).toEqual([{ Sid: 'Step51Writes1', Effect: 'Allow', Action: ['ecr:PutImageScanningConfiguration', 'ecr:PutImageTagMutability', 'ecr:SetRepositoryPolicy', 'ecr:TagResource'], Resource: [`arn:aws:ecr:eu-west-1:${A}:repository/spares4repairs-error-code-mcp`] }]);
  });
  it('grants no write at all for tables, roles, inline policies, URLs and permissions', () => {
    for (const n of ['5.3a', '5.3b', '5.5', '5.6', '5.8']) expect(writes(n), n).toEqual([]);
  });
  it('scopes Lambda and rule tagging to the step\'s own resources; 5.10 only to the diagnosis Lambda', () => {
    expect(writes('5.7c')).toEqual([{ Sid: 'Step57cWrites1', Effect: 'Allow', Action: ['lambda:TagResource'], Resource: [`arn:aws:lambda:eu-west-1:${A}:function:whichpart-api`] }]);
    expect(writes('5.10')[0].Resource).toEqual([`arn:aws:lambda:eu-west-1:${A}:function:spares4repairs-part-finder`]);
    expect(writes('5.9')[0].Action).toEqual(['events:TagResource']);
  });
  it('keeps the read-only base and appends only the step writes', () => {
    const base = executionPolicy();
    const p = executionPolicy(writes('5.2'));
    expect(p.Statement.slice(0, base.Statement.length)).toEqual(base.Statement);
    const added = p.Statement.slice(base.Statement.length).flatMap((x) => x.Action);
    expect(added.sort()).toEqual(['ecr:PutImageScanningConfiguration', 'ecr:PutImageTagMutability', 'ecr:SetRepositoryPolicy', 'ecr:TagResource', 'secretsmanager:TagResource', 'secretsmanager:UpdateSecret']);
  });
  it('checks real CloudTrail writes: the S3 TagResource alias, a secret value, a refused call', () => {
    const ev = (action, request = [], errorCode = null) => ({ action, resource: 'r', request, errorCode });
    expect(checkWrites([ev('s3:TagResource')], manifest, ['AWS::S3::Bucket'])).toEqual([]);
    expect(checkWrites([ev('secretsmanager:UpdateSecret', ['secretId', 'description'])], manifest, ['AWS::SecretsManager::Secret'])).toEqual([]);
    expect(checkWrites([ev('secretsmanager:UpdateSecret', ['secretId', 'secretString'])], manifest, ['AWS::SecretsManager::Secret']).map((f) => f.rule)).toEqual(['forbidden-parameter']);
    expect(checkWrites([ev('ecr:DeleteRepositoryPolicy', [], 'AccessDenied')], manifest, ['AWS::ECR::Repository']).map((f) => f.rule)).toEqual(['forbidden-write', 'write-refused']);
    expect(checkWrites([ev('lambda:UpdateFunctionConfiguration')], manifest, ['AWS::Lambda::Function']).map((f) => f.rule)).toEqual(['forbidden-write']);
  });
});

describe('real CloudTrail writes from the sandbox import-semantics probe', () => {
  const runs = readJson(join(REPO_ROOT, 'tools', 'migration', 'test', 'fixtures', 'sandbox', 'import-writes.cloudtrail.json'));
  const manifest = loadManifest();
  const check = (name) => checkWrites(runs[name].events, manifest, runs[name].types).map((f) => `${f.rule} ${f.action}`);
  it('passes every confirmed pattern: the template matching live, the manifest\'s writes only', () => {
    for (const name of ['5.1 policy declared', '5.2 repository and secrets', '5.4 buckets and policy', '5.7a image function', '5.7c zip function', '5.10 diagnosis copy']) {
      expect(check(name), name).toEqual([]);
    }
  });
  it('fails the production 5.1 pattern: the undeclared repository policy is deleted', () => {
    expect(check('5.1 policy undeclared, read-only')).toEqual(expect.arrayContaining(['forbidden-write ecr:DeleteRepositoryPolicy', 'write-refused ecr:DeleteRepositoryPolicy']));
    expect(check('5.1 policy undeclared, delete allowed')).toContain('forbidden-write ecr:DeleteRepositoryPolicy');
  });
  it('shows no secret value written: UpdateSecret carries the description at most', () => {
    for (const e of runs['5.2 repository and secrets'].events.filter((x) => x.action === 'secretsmanager:UpdateSecret')) {
      expect(e.request).not.toContain('secretString');
      expect(e.request).not.toContain('secretBinary');
    }
  });
});

describe('real CloudTrail writes from the production imports 5.1 to 5.10', () => {
  const runs = readJson(join(REPO_ROOT, 'tools', 'migration', 'test', 'fixtures', 'production', 'import-writes.cloudtrail.json'));
  const manifest = loadManifest();
  it('every step wrote only what the manifest expects for its types, with no refused call', () => {
    expect(Object.keys(runs)).toEqual(['5.1', '5.2', '5.3a', '5.3b', '5.4', '5.5', '5.6', '5.7a', '5.7b', '5.7c', '5.8', '5.9', '5.10']);
    for (const [step, run] of Object.entries(runs)) {
      expect(checkWrites(run.events, manifest, run.types), step).toEqual([]);
      expect(run.events.filter((e) => e.errorCode), step).toEqual([]);
    }
  });
  it('the read-only types wrote nothing', () => {
    for (const step of ['5.3a', '5.3b', '5.5', '5.6', '5.8']) expect(runs[step].events, step).toEqual([]);
  });
  it('5.10 made exactly the approved write: lambda:TagResource on the diagnosis function', () => {
    expect(runs['5.10'].events.map((e) => `${e.action} ${e.resource}`))
      .toEqual(['lambda:TagResource arn:aws:lambda:eu-west-1:800960611664:function:spares4repairs-part-finder']);
  });
  it('no secret value was written', () => {
    for (const e of runs['5.2'].events.filter((x) => x.action === 'secretsmanager:UpdateSecret')) {
      expect(e.request).not.toContain('secretString');
      expect(e.request).not.toContain('secretBinary');
      expect(e.request).not.toContain('kmsKeyId');
    }
  });
});

describe('Phase 6 ownership proof writes (docs/migration/phase-6-proof-writes.json)', () => {
  const proof = readJson(join(REPO_ROOT, 'docs', 'migration', 'phase-6-proof-writes.json'));
  const ECR = ['AWS::ECR::Repository'];
  const ev = (action, errorCode = null) => ({ action, resource: proof.resource.arn, errorCode, request: [] });
  it('grants the ECR update writes on exactly the one proof repository', () => {
    expect(proofWriteStatements(proof)).toEqual([{ Sid: 'Phase6ProofWrites', Effect: 'Allow', Resource: ['arn:aws:ecr:eu-west-1:800960611664:repository/spares4repairs-error-code-mcp'],
      Action: ['ecr:PutImageScanningConfiguration', 'ecr:PutImageTagMutability', 'ecr:SetRepositoryPolicy', 'ecr:TagResource', 'ecr:UntagResource'] }]);
    expect(proof.grant).not.toEqual(expect.arrayContaining(['ecr:DeleteRepository']));
    expect(() => proofWriteStatements({ resource: {}, grant: [] })).toThrow();
  });
  it('the add update may tag but never untag', () => {
    expect(checkWrites([ev('ecr:TagResource'), ev('ecr:SetRepositoryPolicy')], proof.variants.add, ECR)).toEqual([]);
    expect(checkWrites([ev('ecr:UntagResource')], proof.variants.add, ECR).map((f) => f.rule)).toEqual(['forbidden-write']);
  });
  it('the remove update may untag; deletions and lifecycle writes stay forbidden', () => {
    expect(checkWrites([ev('ecr:UntagResource')], proof.variants.remove, ECR)).toEqual([]);
    expect(checkWrites([ev('ecr:DeleteRepositoryPolicy'), ev('ecr:PutLifecyclePolicy')], proof.variants.remove, ECR).map((f) => f.rule)).toEqual(['forbidden-write', 'forbidden-write']);
    expect(checkWrites([ev('lambda:TagResource')], proof.variants.remove, ECR).map((f) => f.rule)).toEqual(['unexpected-write']);
    expect(checkWrites([ev('ecr:UntagResource', 'AccessDenied')], proof.variants.remove, ECR).map((f) => f.rule)).toEqual(['write-refused']);
  });
});
