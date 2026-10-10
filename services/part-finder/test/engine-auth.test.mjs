/**
 * ADR 0017: orchestrator-only engine fields are honoured only with a valid AC signature over the exact body.
 * S4R's /part-finder page sends a plain {messages} request with no signature; that path must be unchanged.
 */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const A = require('../engine-auth.js');
const W = require('../../whichpart-api/engine-signature.js');

const KEY = 'k0123456789abcdef0123456789abcdef0123456789abcdef';
const NOW = 1760000000;
const ev = (sig, origin) => ({ headers: { ...(sig ? { 'x-ac-engine-signature': sig } : {}), ...(origin ? { origin } : {}) } });
const internalBody = { messages: [{ role: 'user', content: 'x' }], mode: 'understand' };
const raw = JSON.stringify(internalBody);
const gate = (body, rawBody, sig) => A.gateInternalFields(body, ev(sig), rawBody, { key: KEY, nowS: NOW });

describe('signature', () => {
  it('a valid signature verifies (constant-time compare)', () => {
    expect(A.verify(ev(A.sign(KEY, raw, NOW)), raw, KEY, NOW)).toBe('valid');
  });
  it('the orchestrator (Python) and whichpart-api signers produce the header the engine verifies', () => {
    expect('t=1760000000,v1=80dcc066b6ae45059ddfceef809cdc8475691b38ed215bddc136a83e6acbba18').toBe(A.sign(KEY, raw, NOW));
    expect(W.engineSignature(raw, KEY, NOW)).toBe(A.sign(KEY, raw, NOW));
    expect(A.verify(ev('t=1760000000,v1=80dcc066b6ae45059ddfceef809cdc8475691b38ed215bddc136a83e6acbba18'), raw, KEY, NOW)).toBe('valid');
  });
  it('a tampered body fails verification', () => {
    const sig = A.sign(KEY, raw, NOW);
    expect(A.verify(ev(sig), raw.replace('understand', 'understane'), KEY, NOW)).toBe('invalid');
  });
  it('a wrong key, a stale timestamp and a malformed header are each rejected', () => {
    expect(A.verify(ev(A.sign('x'.repeat(48), raw, NOW)), raw, KEY, NOW)).toBe('invalid');
    expect(A.verify(ev(A.sign(KEY, raw, NOW - A.MAX_SKEW_S - 1)), raw, KEY, NOW)).toBe('stale');
    expect(A.verify(ev('t=abc,v1=zz'), raw, KEY, NOW)).toBe('malformed');
    expect(A.verify(ev(), raw, KEY, NOW)).toBe('missing');
    expect(A.verify(ev(A.sign(KEY, raw, NOW)), raw, null, NOW)).toBe('no_key');
  });
});

describe('enforcement', () => {
  it('a valid signed request keeps its internal fields', () => {
    const g = gate(internalBody, raw, A.sign(KEY, raw, NOW));
    expect(g.body).toEqual(internalBody);
    expect(g.record).toMatchObject({ signature: 'valid', dropped: false, present: ['mode'] });
  });
  it('unsigned internal fields are dropped and the request becomes a plain {messages} request', () => {
    const forged = { messages: internalBody.messages, mode: 'understand', understand: { _requestClass: 'appliance_request' }, canonical: { schema: 'cs/1' }, established: { applianceFamily: 'oven' }, seed: 7 };
    const g = gate(forged, JSON.stringify(forged), null);
    expect(g.body).toEqual({ messages: internalBody.messages });
    expect(g.record).toMatchObject({ signature: 'missing', dropped: true });
    expect(g.record.present.sort()).toEqual(['canonical', 'established', 'mode', 'seed', 'understand']);
  });
  it('an invalid signature is treated like no signature', () => {
    const g = gate(internalBody, raw, A.sign(KEY, '{}', NOW));
    expect(g.body).toEqual({ messages: internalBody.messages });
    expect(g.record.signature).toBe('invalid');
  });
  it('unsigned feedback is dropped (the request then has no messages and is refused as before)', () => {
    const fb = { feedback: { traceId: 't', rating: 1 } };
    expect(gate(fb, JSON.stringify(fb), null, 'enforce').body).toEqual({});
  });
  it('without a signing key every internal field is dropped (fails closed)', () => {
    const g = A.gateInternalFields(internalBody, ev(A.sign(KEY, raw, NOW)), raw, { key: null, nowS: NOW });
    expect(g.body).toEqual({ messages: internalBody.messages });
    expect(g.record.signature).toBe('no_key');
  });
});

describe('S4R compatibility', () => {
  it('the S4R /part-finder request (plain {messages}, S4R origin, no signature) is passed through untouched', () => {
    const s4r = { messages: [{ role: 'user', content: "My washing machine won't drain, it's a Bosch" }] };
    const g = A.gateInternalFields(s4r, ev(null, 'https://spares4repairs.co.uk'), JSON.stringify(s4r), { key: KEY, nowS: NOW });
    expect(g.body).toBe(s4r);
    expect(g.record).toMatchObject({ present: [], dropped: false });
  });
  it('a signing key shorter than 32 characters is no key', () => {
    expect(A.signingKey({ ENGINE_SIGNING_TOKEN: 'short' })).toBeNull();
  });
  it('the auth log carries the Origin host only', () => {
    expect(A.headerHost('https://spares4repairs.co.uk')).toBe('spares4repairs.co.uk');
    expect(A.headerHost(undefined)).toBeNull();
  });
});
