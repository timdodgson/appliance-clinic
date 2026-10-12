/**
 * whichpart-api's engine request signing (ADR 0017 HMAC, ADR 0019 SigV4 for the AWS_IAM Function URL). The SigV4
 * vectors were cross-checked against botocore's SigV4Auth (service `lambda`, eu-west-1) for the same inputs.
 */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { sigv4Headers, signedJsonHeaders, engineGetHeaders, ENGINE_SIGNATURE_HEADER } = require('../engine-signature.js');

const ENV = { AWS_ACCESS_KEY_ID: 'AKIDEXAMPLE', AWS_SECRET_ACCESS_KEY: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY', AWS_SESSION_TOKEN: 'tok', AWS_REGION: 'eu-west-1' };
const AT = new Date('2026-10-12T01:40:57Z');
const sig = (h) => h.authorization.split('Signature=')[1];

describe('SigV4 (service lambda)', () => {
  it('signs a POST with the HMAC header exactly as botocore does', () => {
    const h = sigv4Headers('POST', 'https://abc.lambda-url.eu-west-1.on.aws/', '{"a":1}',
      { 'content-type': 'application/json', 'x-ac-engine-signature': 't=1,v1=ff' }, ENV, AT);
    expect(sig(h)).toBe('e2a4b14d3dc30de59ea5476697ca2827865ebf785115baf4a90f7e188ee497c2');
    expect(h.authorization).toContain('SignedHeaders=content-type;host;x-ac-engine-signature;x-amz-content-sha256;x-amz-date;x-amz-security-token');
    expect(h['x-amz-security-token']).toBe('tok');
    expect(h.host).toBeUndefined();
  });
  it('signs a GET of /health exactly as botocore does', () => {
    expect(sig(sigv4Headers('GET', 'https://abc.lambda-url.eu-west-1.on.aws/health', '', {}, ENV, AT)))
      .toBe('6371fc474a7f3ccf0ab6dc0b99a9727e23b9e3892b8ca04630bd114f5da94e9a');
  });
  it('adds nothing without credentials', () => {
    expect(sigv4Headers('GET', 'https://abc.lambda-url.eu-west-1.on.aws/health', '', { a: '1' }, {})).toEqual({ a: '1' });
  });
});

describe('engine request headers', () => {
  it('a JSON POST carries the HMAC; with a URL and credentials, SigV4 too', () => {
    const saved = { ...process.env };
    try {
      process.env.ENGINE_SIGNING_TOKEN = 'k'.repeat(40);
      for (const k of ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN']) delete process.env[k];
      expect(signedJsonHeaders('{}', 'https://abc.lambda-url.eu-west-1.on.aws/')[ENGINE_SIGNATURE_HEADER]).toMatch(/^t=\d+,v1=[0-9a-f]{64}$/);
      expect(engineGetHeaders('https://abc.lambda-url.eu-west-1.on.aws/health')).toEqual({});
      Object.assign(process.env, ENV);
      const h = signedJsonHeaders('{}', 'https://abc.lambda-url.eu-west-1.on.aws/');
      expect(h.authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\//);
      expect(h.authorization).toContain('x-ac-engine-signature');
    } finally {
      for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
      Object.assign(process.env, saved);
    }
  });
});
