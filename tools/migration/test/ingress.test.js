import { describe, expect, it } from 'vitest';
import { summariseIngress, verifyIngress } from '../src/baseline/ingress.js';

describe('/ai/chat ingress check', () => {
  const res = (text, status = 200, type = 'application/json') => ({ status, headers: { 'content-type': type }, text });
  const ndjson = [JSON.stringify({ type: 'delta', text: 'x' }), JSON.stringify({ type: 'done', parts: [], understood: {} })].join('\n');

  it('summarises JSON and NDJSON responses', () => {
    expect(summariseIngress(res('{"reply":"x","parts":[]}'))).toMatchObject({ framing: 'json', jsonKeys: ['parts', 'reply'] });
    expect(summariseIngress(res(ndjson, 200, 'application/x-ndjson'))).toMatchObject({ framing: 'ndjson', stream: { hasDone: true } });
  });

  it('passes an unchanged response and fails on status, framing or lost fields', () => {
    const base = summariseIngress(res('{"reply":"x","parts":[]}'));
    expect(verifyIngress(base, summariseIngress(res('{"reply":"y","parts":[1]}'))).ok).toBe(true);
    expect(verifyIngress(base, summariseIngress(res('{"error":"x"}', 502))).problems.map((p) => p.check)).toEqual(expect.arrayContaining(['status', 'json-keys-removed']));
    expect(verifyIngress(base, summariseIngress(res(ndjson))).problems.map((p) => p.check)).toContain('framing');
  });
});
