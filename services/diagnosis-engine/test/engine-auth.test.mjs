/**
 * ADR 0017: internal engine fields are honoured only with a valid AC signature over the exact body.
 * ADR 0019: there is no unsigned request path; the handler refuses any request without a valid signature
 * (engine-signed-boundary.test.mjs).
 * ADR 0018: internal fields without a valid signature are refused, never dropped into a plain request.
 */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const A = require('../engine-auth.js');
const W = require('../../whichpart-api/engine-signature.js');

const KEY = 'k0123456789abcdef0123456789abcdef0123456789abcdef';
const NOW = 1760000000;
const ev = (sig, origin) => ({ headers: { ...(sig ? { 'x-ac-engine-signature': sig } : {}), ...(origin ? { origin } : {}) } });
const internalBody = { messages: [{ role: 'user', content: 'x' }], mode: 'turn' };
const raw = JSON.stringify(internalBody);
const gate = (body, rawBody, sig) => A.gateInternalFields(body, ev(sig), rawBody, { key: KEY, nowS: NOW });

describe('signature', () => {
  it('a valid signature verifies (constant-time compare)', () => {
    expect(A.verify(ev(A.sign(KEY, raw, NOW)), raw, KEY, NOW)).toBe('valid');
  });
  it('the recorded signature and the whichpart-api signer produce the header the engine verifies', () => {
    expect('t=1760000000,v1=962f81275cc379a23cc8ed160107a8fb63e4a2edf4ca708a5933967e88a27d67').toBe(A.sign(KEY, raw, NOW));
    expect(W.engineSignature(raw, KEY, NOW)).toBe(A.sign(KEY, raw, NOW));
    expect(A.verify(ev('t=1760000000,v1=962f81275cc379a23cc8ed160107a8fb63e4a2edf4ca708a5933967e88a27d67'), raw, KEY, NOW)).toBe('valid');
  });
  it('a tampered body fails verification', () => {
    const sig = A.sign(KEY, raw, NOW);
    expect(A.verify(ev(sig), raw.replace('turn', 'tern'), KEY, NOW)).toBe('invalid');
  });
  it('a wrong key, a stale timestamp and a malformed header are each rejected', () => {
    expect(A.verify(ev(A.sign('x'.repeat(48), raw, NOW)), raw, KEY, NOW)).toBe('invalid');
    expect(A.verify(ev(A.sign(KEY, raw, NOW - A.MAX_SKEW_S - 1)), raw, KEY, NOW)).toBe('stale');
    expect(A.verify(ev('t=abc,v1=zz'), raw, KEY, NOW)).toBe('malformed');
    expect(A.verify(ev(), raw, KEY, NOW)).toBe('missing');
    expect(A.verify(ev(A.sign(KEY, raw, NOW)), raw, null, NOW)).toBe('no_key');
  });
});

describe('enforcement (ADR 0018: refused, never stripped into a plain request)', () => {
  it('a valid signed request keeps its internal fields', () => {
    const g = gate(internalBody, raw, A.sign(KEY, raw, NOW));
    expect(g.body).toEqual(internalBody);
    expect(g.record).toMatchObject({ signature: 'valid', rejected: false, present: ['mode'] });
  });
  it('unsigned internal fields mark the request rejected (the handler refuses it)', () => {
    const forged = { messages: internalBody.messages, mode: 'turn', ac2: { state: { schema: 'ac2/1' } } };
    const g = gate(forged, JSON.stringify(forged), null);
    expect(g.record).toMatchObject({ signature: 'missing', rejected: true });
    expect(g.record.present.sort()).toEqual(['ac2', 'mode']);
  });
  it('an invalid signature is treated like no signature', () => {
    const g = gate(internalBody, raw, A.sign(KEY, '{}', NOW));
    expect(g.record).toMatchObject({ signature: 'invalid', rejected: true });
  });
  it('without a signing key any internal field is rejected (fails closed)', () => {
    const g = A.gateInternalFields(internalBody, ev(A.sign(KEY, raw, NOW)), raw, { key: null, nowS: NOW });
    expect(g.record).toMatchObject({ signature: 'no_key', rejected: true });
  });
});

describe('gate record and helpers', () => {
  it('a plain unsigned {messages} body has no internal fields to reject (the handler still refuses it for the missing signature)', () => {
    const s4r = { messages: [{ role: 'user', content: "My washing machine won't drain, it's a Bosch" }] };
    const g = A.gateInternalFields(s4r, ev(null, 'https://spares4repairs.co.uk'), JSON.stringify(s4r), { key: KEY, nowS: NOW });
    expect(g.body).toBe(s4r);
    expect(g.record).toMatchObject({ present: [], rejected: false });
  });
  it('a signing key shorter than 32 characters is no key', () => {
    expect(A.signingKey({ ENGINE_SIGNING_TOKEN: 'short' })).toBeNull();
  });
  it('the auth log carries the Origin host only', () => {
    expect(A.headerHost('https://spares4repairs.co.uk')).toBe('spares4repairs.co.uk');
    expect(A.headerHost(undefined)).toBeNull();
  });
});
