import { describe, expect, it } from 'vitest';
import { generateDenylist } from '../src/denylist/generate.js';
import { findExactHits, scanDocument } from '../src/denylist/match.js';
import stacks from './fixtures/stacks.json' with { type: 'json' };

const known = [{ kind: 'physicalId', value: '65vnizdmk4', reason: 'S4R catalogue API.', source: 'manual' }];
const sharedPrefixSecrets = [
  { name: 'spares4repairs/dev/db-credentials', arn: 'arn:aws:secretsmanager:eu-west-1:000000000000:secret:spares4repairs/dev/db-credentials-AbCdEf' },
  { name: 'spares4repairs/dev/applianceclinic-ai-config', arn: 'arn:aws:secretsmanager:eu-west-1:000000000000:secret:spares4repairs/dev/applianceclinic-ai-config-GhIjKl' },
];

function build() {
  return generateDenylist({
    meta: { accountId: '000000000000' },
    stacks,
    sharedPrefixSecrets,
    acSecretPrefixes: ['spares4repairs/dev/applianceclinic-'],
    knownEntries: known,
    now: new Date('2026-10-07T00:00:00Z'),
  });
}

describe('generateDenylist', () => {
  it('denylists every non-AC stack and all of its resources', () => {
    const values = build().entries.map((e) => e.value);
    expect(values).toContain('SparesSite-dev');
    expect(values).toContain('eu-west-1_TESTPOOL1');
    expect(values).toContain('SparesSite-dev-ServerFunctionRole-ABC123');
    expect(values).toContain('spares4repairs-orders-dev');
  });

  it("never denylists Appliance Clinic's own stacks", () => {
    const values = build().entries.map((e) => e.value);
    expect(values).not.toContain('AcDataStack');
    expect(values).not.toContain('whichpart-recalls');
  });

  it('denylists shared-prefix secrets that are not AC candidates, and only those', () => {
    const values = build().entries.map((e) => e.value);
    expect(values).toContain(sharedPrefixSecrets[0].arn);
    expect(values).not.toContain(sharedPrefixSecrets[1].arn);
  });

  it('keeps manual entries and records provenance', () => {
    const d = build();
    expect(d.entries.find((e) => e.value === '65vnizdmk4').source).toBe('manual');
    expect(d.accountId).toBe('000000000000');
    expect(d.generatedAt).toBe('2026-10-07T00:00:00.000Z');
  });
});

describe('matching', () => {
  const { entries } = build();
  it('matches identifiers exactly and as ARN suffixes', () => {
    expect(findExactHits(entries, 'spares4repairs-orders-dev')).toHaveLength(1);
    expect(findExactHits(entries, 'arn:aws:dynamodb:eu-west-1:000000000000:table/spares4repairs-orders-dev')).toHaveLength(1);
    expect(findExactHits(entries, 'whichpart-transcripts')).toHaveLength(0);
  });

  it('finds S4R identifiers hidden in a document', () => {
    const doc = { Properties: { PolicyDocument: { Resource: 'arn:aws:cognito-idp:eu-west-1:000000000000:userpool/eu-west-1_TESTPOOL1' } } };
    expect(scanDocument(entries, doc).map((e) => e.value)).toContain('eu-west-1_TESTPOOL1');
  });
});
