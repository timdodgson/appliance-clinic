import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import AdmZip from 'adm-zip';
import { describe, expect, it } from 'vitest';
import { compareArtifacts } from '../src/compare/build-equivalence.js';
import { diffValues, splitCloudFormationTags } from '../src/compare/config-diff.js';
import { compareDeployedWithSource } from '../src/compare/deployed-vs-source.js';
import { lambdaCodeSha256OfFile, readDirEntries, readZipEntries } from '../src/compare/zip.js';
import { lambdaCodeSha256 } from '../src/inventory/lambda.js';

function makeZip(files, { comment } = {}) {
  const zip = new AdmZip();
  for (const [path, content] of Object.entries(files)) zip.addFile(path, Buffer.from(content));
  if (comment) zip.addZipComment(comment);
  const file = join(mkdtempSync(join(tmpdir(), 'acz-')), 'a.zip');
  zip.writeZip(file);
  return file;
}

function makeDir(files) {
  const root = mkdtempSync(join(tmpdir(), 'acd-'));
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(root, path, '..'), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  return root;
}

describe('deployed vs source', () => {
  it('matches files by content even when the deploy script moved them', () => {
    const artifact = readZipEntries(makeZip({ 'index.js': 'api', 'cs1.js': 'canonical', 'node_modules/@aws-sdk/x/index.js': 'dep', 'node_modules/left-pad/i.js': 'd2' }));
    const source = readDirEntries(makeDir({ 'services/whichpart-api/index.js': 'api', 'services/part-finder/canonical/cs1.js': 'canonical' }));
    const r = compareDeployedWithSource(artifact, source);
    expect(r.summary.equivalent).toBe(true);
    expect(r.summary.bundledDependencyFiles).toBe(2);
    expect(r.bundledPackages).toEqual(['@aws-sdk/x', 'left-pad']);
  });

  it('reports deployed code that is not in the source', () => {
    const artifact = readZipEntries(makeZip({ 'index.js': 'api from a feature branch' }));
    const source = readDirEntries(makeDir({ 'services/whichpart-api/index.js': 'api on main' }));
    const r = compareDeployedWithSource(artifact, source);
    expect(r.summary.equivalent).toBe(false);
    expect(r.unmatched.map((u) => u.path)).toEqual(['index.js']);
  });
});

describe('build equivalence', () => {
  it('treats zips with identical files as equivalent although their CodeSha256 differs', () => {
    const a = makeZip({ 'a.js': '1', 'b.js': '2' });
    const b = makeZip({ 'b.js': '2', 'a.js': '1' }, { comment: 'rebuilt' });
    const r = compareArtifacts(readZipEntries(a), readZipEntries(b));
    expect(r.equivalent).toBe(true);
    expect(lambdaCodeSha256OfFile(a)).not.toBe(lambdaCodeSha256OfFile(b));
  });

  it('accepts exactly the allowed differences, as for a hotfix', () => {
    const before = readZipEntries(makeZip({ 'index.js': 'old', 'other.js': 'same' }));
    const after = readZipEntries(makeZip({ 'index.js': 'patched', 'other.js': 'same' }));
    expect(compareArtifacts(before, after, { allowedDifferences: ['index.js'] }).equivalent).toBe(true);
    expect(compareArtifacts(before, after).unexpected).toEqual(['index.js']);
  });

  it('fails when an allowed difference did not actually happen', () => {
    const same = readZipEntries(makeZip({ 'index.js': 'x' }));
    const r = compareArtifacts(same, same, { allowedDifferences: ['index.js'] });
    expect(r.equivalent).toBe(false);
    expect(r.missingExpected).toEqual(['index.js']);
  });

  it('reports added and removed files', () => {
    const r = compareArtifacts(readZipEntries(makeZip({ 'a.js': '1' })), readZipEntries(makeZip({ 'b.js': '1' })));
    expect(r.onlyInA).toEqual(['a.js']);
    expect(r.onlyInB).toEqual(['b.js']);
  });

  it('computes CodeSha256 the way Lambda does', () => {
    expect(lambdaCodeSha256(Buffer.from('abc'))).toBe('ungWv48Bz+pBQUDeXa4iI7ADYaOWF3qctBD/YfIAFa0=');
  });
});

describe('config diff', () => {
  it('ignores volatile fields and reports real drift', () => {
    const before = { name: 'whichpart-api', LastModified: 'a', RevisionId: '1', Timeout: 30, Environment: { Variables: { MODE: 'off' } } };
    const after = { name: 'whichpart-api', LastModified: 'b', RevisionId: '2', Timeout: 60, Environment: { Variables: { MODE: 'off' } } };
    expect(diffValues(before, after)).toEqual([{ path: 'Timeout', before: 30, after: 60 }]);
  });

  it('separates CloudFormation-added tags from drift', () => {
    const diffs = diffValues({ tags: [] }, { tags: [{ Key: 'aws:cloudformation:stack-name', Value: 'AcDataStack' }] });
    const { drift, cloudformationTags } = splitCloudFormationTags(diffs);
    expect(drift).toHaveLength(0);
    expect(cloudformationTags).toHaveLength(1);
  });

  it('does not hide a difference that merely mentions a stack ARN', () => {
    const stack = { stackName: 'ApplianceClinicSandboxToolkit', stackId: 'arn:aws:cloudformation:eu-west-1:0:stack/ApplianceClinicSandboxToolkit/x' };
    const { drift, cloudformationTags } = splitCloudFormationTags(diffValues([{ stackName: 'CDKToolkit' }], [{ stackName: 'CDKToolkit' }, stack]));
    expect(drift.map((d) => d.path)).toEqual(['[stackName=ApplianceClinicSandboxToolkit]']);
    expect(cloudformationTags).toEqual([]);
  });

  it('matches records by identity, so one added record does not shift the rest', () => {
    const before = [{ stackName: 'B', status: 'OK' }, { stackName: 'C', status: 'OK' }];
    const after = [{ stackName: 'A', status: 'NEW' }, { stackName: 'B', status: 'OK' }, { stackName: 'C', status: 'CHANGED' }];
    expect(diffValues(before, after).map((d) => d.path).sort()).toEqual(['[stackName=A]', '[stackName=C].status']);
  });

  it('treats the PITR restore window as volatile', () => {
    const t = (x) => ({ pointInTimeRecovery: { PointInTimeRecoveryDescription: { PointInTimeRecoveryStatus: 'ENABLED', LatestRestorableDateTime: x } } });
    expect(diffValues(t('a'), t('b'))).toEqual([]);
  });
});
