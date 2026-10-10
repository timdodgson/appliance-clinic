import { describe, expect, it } from 'vitest';
import { overridesDrift, leaseState, sha256, keySha256 } from '../src/production/overrides-drift.js';

// Phase 11 (E): the declared runtime state against the deployed configuration. Findings name keys, never values.
const REF = '{{resolve:secretsmanager:applianceclinic/production/x:SecretString:token::v1}}';
const declared = () => ({
  f: { env: { set: { MODE: 'control', TOKEN_X: REF, MARK: 'x=v1' }, unset: ['OLD'], digests: { TUNNEL: `sha256:${sha256('https://a.example')}` } },
    code: { s3Bucket: 'b', s3Key: 'k' } },
  g: { env: { set: {} }, code: { imageUri: 'acct.dkr.ecr/repo@sha256:abc' } },
});
const live = () => ({
  f: { env: { MODE: 'control', TOKEN_X: 'resolved-secret', MARK: 'x=v1', TUNNEL: 'https://a.example' }, codeSha256: 'REF' },
  g: { env: {}, imageDigest: 'sha256:abc' },
});

describe('overrides drift', () => {
  it('declared state equal to live: no findings (a secret reference is checked by presence only)', () => {
    expect(overridesDrift(declared(), live(), { f: 'REF' })).toEqual({ ok: true, findings: [] });
  });
  it('a behavioural switch that exists only on the live function is drift', () => {
    const l = live(); l.f.env.CANONICAL_J1_CONTROL = '0';
    expect(overridesDrift(declared(), l, { f: 'REF' }).findings).toEqual([{ fn: 'f', kind: 'undeclared', key: 'CANONICAL_J1_CONTROL' }]);
  });
  it('a changed value, a removed variable, an unset one present, a changed digest, code and image are each drift', () => {
    const l = live(); l.f.env.MODE = 'shadow'; delete l.f.env.MARK; l.f.env.OLD = '1'; l.f.env.TUNNEL = 'https://b.example';
    l.f.codeSha256 = 'OTHER'; l.g.imageDigest = 'sha256:def';
    const kinds = overridesDrift(declared(), l, { f: 'REF' }).findings.map((x) => `${x.fn}:${x.kind}:${x.key || ''}`).sort();
    expect(kinds).toEqual(['f:code-differs:', 'f:declared-but-absent:MARK', 'f:digest-differs:TUNNEL', 'f:unset-but-present:OLD', 'f:value-differs:MODE', 'g:image-differs:'].sort());
  });
  it('never puts a value in a finding', () => {
    const l = live(); l.f.env.MODE = 'leaky-value';
    expect(JSON.stringify(overridesDrift(declared(), l, { f: 'REF' }))).not.toMatch(/leaky-value|resolved-secret|a\.example/);
  });
  it('a staged key names the code hash it must deploy (url-safe base64 in the file name)', () => {
    expect(keySha256('phase8/spares4repairs-part-finder-K0GOjl_gA71tVJCISd2MDq_4Kh2j9Yyl_54v35sDuFQ.zip')).toBe('K0GOjl/gA71tVJCISd2MDq/4Kh2j9Yyl/54v35sDuFQ=');
    expect(keySha256('phase5/other.zip')).toBeNull();
    const d = declared(); d.f.code.s3Key = 'phase8/f-K0GOjl_gA71tVJCISd2MDq_4Kh2j9Yyl_54v35sDuFQ.zip';
    const l = live(); l.f.codeSha256 = 'K0GOjl/gA71tVJCISd2MDq/4Kh2j9Yyl/54v35sDuFQ=';
    expect(overridesDrift(d, l, { f: 'STALE-REFERENCE' }).ok).toBe(true);
  });
  it('a benchmark routing lease is active only while unreleased and unexpired', () => {
    const now = Date.parse('2026-10-10T12:00:00Z');
    expect(leaseState({ state: 'released' }, now)).toBe('released');
    expect(leaseState({ state: 'held', heartbeatAt: '2026-10-10T11:59:00Z', leaseMs: 180000 }, now)).toBe('active');
    expect(leaseState({ state: 'held', heartbeatAt: '2026-10-10T11:00:00Z', leaseMs: 180000 }, now)).toBe('expired');
    expect(leaseState(null, now)).toBe('none');
  });
});
