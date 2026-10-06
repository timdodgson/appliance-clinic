import { describe, expect, it } from 'vitest';
import { collectDigests, isSecretName, redactDeep, redactEnvironment, sha256Hex } from '../src/redact.js';

describe('redactEnvironment', () => {
  it('hashes secret-named values and keeps identifiers and ordinary settings', () => {
    const env = {
      ORCHESTRATOR_TOKEN: 'abc123',
      MCP_BEARER_TOKEN: 'def456',
      CANONICAL_TOKEN_SECRET_ID: 'spares4repairs/dev/applianceclinic-canonical-state-token',
      ENGINE_URL: 'https://example.lambda-url.eu-west-1.on.aws/',
      TRANSCRIPT_RETENTION_DAYS: '90',
      CANONICAL_MODE: 'off',
    };
    const out = redactEnvironment(env);
    expect(out.ORCHESTRATOR_TOKEN).toEqual({ redacted: true, sha256: sha256Hex('abc123'), length: 6 });
    expect(out.MCP_BEARER_TOKEN.redacted).toBe(true);
    expect(out.CANONICAL_TOKEN_SECRET_ID).toBe(env.CANONICAL_TOKEN_SECRET_ID);
    expect(out.ENGINE_URL).toBe(env.ENGINE_URL);
    expect(out.TRANSCRIPT_RETENTION_DAYS).toBe('90');
    expect(out.CANONICAL_MODE).toBe('off');
    expect(JSON.stringify(out)).not.toContain('abc123');
  });

  it('hashes opaque values whatever their name', () => {
    const value = 'Zm9vYmFyYmF6cXV4cXV1eGNvcmdlZ3JhdWx0Z2FycGx5';
    expect(redactEnvironment({ HARMLESS_LOOKING: value }).HARMLESS_LOOKING.redacted).toBe(true);
  });

  it('does not treat ARNs as opaque secrets', () => {
    const arn = 'arn:aws:secretsmanager:eu-west-1:000000000000:secret:name-AbCdEf';
    expect(redactEnvironment({ SOME_SECRET_ARN: arn }).SOME_SECRET_ARN).toBe(arn);
  });
});

describe('isSecretName', () => {
  it.each([['OPENAI_API_KEY', true], ['ORCH_BEARER_TOKEN', true], ['BENCHMARK_SERVICE_SECRET', true], ['BENCHMARK_SERVICE_SECRET_ID', false], ['AUTHOR_NAME', false], ['LEARNING_BUCKET', false]])('%s -> %s', (name, expected) => {
    expect(isSecretName(name)).toBe(expected);
  });
});

describe('redactDeep and collectDigests', () => {
  it('redacts nested secrets and collects their digests', () => {
    const doc = { routing: { compose: { provider: 'openai', model: 'gpt-x' } }, apiKey: 'sk-should-not-appear', nested: [{ token: 't0ken' }] };
    const out = redactDeep(doc);
    expect(out.routing.compose).toEqual({ provider: 'openai', model: 'gpt-x' });
    expect(JSON.stringify(out)).not.toContain('sk-should-not-appear');
    expect(JSON.stringify(out)).not.toContain('t0ken');
    const digests = collectDigests(out);
    expect(digests.has(sha256Hex('sk-should-not-appear'))).toBe(true);
    expect(digests.has(sha256Hex('t0ken'))).toBe(true);
  });
});
