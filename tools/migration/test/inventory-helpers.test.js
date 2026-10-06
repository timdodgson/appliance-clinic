import { describe, expect, it } from 'vitest';
import { distributionsUsingFunctions } from '../src/inventory/cloudfront.js';
import { stacksManaging } from '../src/inventory/cloudformation.js';
import { digestFromImageUri } from '../src/inventory/ecr.js';
import { roleUsage } from '../src/inventory/lambda.js';
import { externalDependencies, ownershipChecks } from '../src/inventory/ownership-checks.js';
import { extractOriginTrialTokens } from '../src/inventory/s3.js';
import { describeSecretValue } from '../src/inventory/secrets.js';
import stacks from './fixtures/stacks.json' with { type: 'json' };

describe('inventory helpers', () => {
  it('extracts the WebMCP origin-trial token from deployed HTML', () => {
    const html = '<head><meta http-equiv="origin-trial" content="TOKEN123"><title>x</title></head>';
    expect(extractOriginTrialTokens(html)).toEqual(['TOKEN123']);
    expect(extractOriginTrialTokens('<head></head>')).toEqual([]);
  });

  it('reads image digests from resolved image URIs', () => {
    const digest = `sha256:${'a'.repeat(64)}`;
    expect(digestFromImageUri(`000000000000.dkr.ecr.eu-west-1.amazonaws.com/repo@${digest}`)).toBe(digest);
    expect(digestFromImageUri('repo:v1')).toBeNull();
  });

  it('finds the stacks that manage a resource', () => {
    expect(stacksManaging(stacks, 'spares4repairs-orders-dev')).toEqual(['eu-west-1:SparesSite-dev']);
    expect(stacksManaging(stacks, 'whichpart-transcripts')).toEqual([]);
  });

  it('describes a secret value without storing it', () => {
    const d = describeSecretValue(JSON.stringify({ routing: { model: 'm' }, apiKey: 'super-secret-value' }));
    expect(d.json.keys).toEqual(['apiKey', 'routing']);
    expect(JSON.stringify(d)).not.toContain('super-secret-value');
  });

  it('detects CloudFront functions attached to another distribution', () => {
    const fn = (name) => ({ FunctionAssociations: { Items: [{ FunctionARN: `arn:aws:cloudfront::000000000000:function/${name}` }] } });
    const dists = [
      { Id: 'AC1', Aliases: { Items: ['applianceclinic.ai'] }, DefaultCacheBehavior: fn('whichpart-www-redirect') },
      { Id: 'S4R1', Aliases: { Items: ['spares4repairs.co.uk'] }, DefaultCacheBehavior: fn('whichpart-www-redirect') },
    ];
    expect(distributionsUsingFunctions(dists, ['whichpart-www-redirect']).map((h) => h.distributionId)).toEqual(['AC1', 'S4R1']);
  });
});

describe('ownership checks', () => {
  const base = { stacks, tables: [], buckets: [], secrets: [], repositories: [], rules: [], cloudfrontSharing: { otherDistributions: [] } };

  it('stops on a role shared with a non-candidate function', () => {
    const usage = roleUsage([{ name: 'spares4repairs-part-finder', role: 'arn:aws:iam::0:role/shared-role' }, { name: 'shop-fn', role: 'arn:aws:iam::0:role/shared-role' }]);
    const flags = ownershipChecks({ ...base, functions: [], roleUsage: usage, candidateFunctionNames: ['spares4repairs-part-finder'], roles: [{ roleName: 'shared-role', exists: true }] });
    expect(flags).toEqual([expect.objectContaining({ severity: 'stop', kind: 'iam-role', id: 'shared-role' })]);
  });

  it('stops on a candidate already managed by an S4R stack', () => {
    const flags = ownershipChecks({ ...base, functions: [], roleUsage: {}, candidateFunctionNames: [], roles: [], tables: [{ tableName: 'spares4repairs-orders-dev', exists: true }] });
    expect(flags[0]).toMatchObject({ severity: 'stop', kind: 'dynamodb-table' });
  });

  it('lists outbound hosts from non-secret environment values', () => {
    const deps = externalDependencies([{ name: 'whichpart-api', configuration: { Environment: { Variables: { ENGINE_URL: 'https://diag.example.on.aws/', MCP_BEARER_TOKEN: { redacted: true } } } } }]);
    expect(deps).toEqual([{ function: 'whichpart-api', variable: 'ENGINE_URL', host: 'diag.example.on.aws' }]);
  });
});
