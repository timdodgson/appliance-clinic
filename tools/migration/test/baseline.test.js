import { describe, expect, it } from 'vitest';
import { contractFrom, summariseNdjson, verifyContract } from '../src/baseline/contract.js';
import { assertSafeRequest, BaselineGuardError, createGuardedFetch, hostsOf } from '../src/baseline/http.js';
import { checkExpectations, compareSmoke, summariseApiResponse } from '../src/baseline/smoke.js';

const hosts = ['applianceclinic.ai', 'diag.example.on.aws'];

describe('baseline request guard', () => {
  it('refuses admin and benchmark routes', () => {
    expect(() => assertSafeRequest('https://applianceclinic.ai/api/admin/ai-config', null, hosts)).toThrow(BaselineGuardError);
    expect(() => assertSafeRequest('https://applianceclinic.ai/api/benchmark/run', null, hosts)).toThrow(BaselineGuardError);
  });

  it('refuses bodies that would store transcripts or change routing', () => {
    for (const key of ['observability', 'liveTest', 'benchmark']) {
      expect(() => assertSafeRequest('https://applianceclinic.ai/api', { messages: [], [key]: {} }, hosts)).toThrow(BaselineGuardError);
    }
  });

  it('refuses unconfigured hosts and allows a plain customer request', () => {
    expect(() => assertSafeRequest('https://elsewhere.example/api', null, hosts)).toThrow(BaselineGuardError);
    expect(() => assertSafeRequest('https://applianceclinic.ai/api', { messages: [] }, hosts)).not.toThrow();
  });

  it('enforces the request cap', async () => {
    const fake = async () => new Response('{}', { status: 200 });
    const f = createGuardedFetch({ allowedHosts: hosts, maxRequests: 1, timeoutMs: 1000, fetchImpl: fake });
    await f('https://applianceclinic.ai/api', { method: 'POST', body: { messages: [] } });
    await expect(f('https://applianceclinic.ai/api', { method: 'POST', body: { messages: [] } })).rejects.toThrow(/cap/);
  });

  it('derives hosts from configured endpoints', () => {
    expect(hostsOf({ a: 'https://x.example/p', b: ['https://y.example/'], c: 'not a url' })).toEqual(['x.example', 'y.example']);
  });
});

const stream = [
  JSON.stringify({ type: 'delta', text: 'Check the ' }),
  JSON.stringify({ type: 'delta', text: 'filter.' }),
  JSON.stringify({ type: 'done', parts: [{ title: 'Pump', partNo: 'P1', partId: 1, price: '9.99', link: 'https://shop.example/p' }], understood: { make: 'Bosch', appliance: 'washing machine', model: null, fault: 'not draining', code: null }, safetyStop: null, remoteActionClass: null, safetyInformation: null }),
  '',
].join('\n');

const capture = (overrides = {}) => contractFrom({
  preflight: { status: 200, headers: { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'POST' } },
  post: { status: 200, headers: { 'content-type': 'application/x-ndjson; charset=utf-8', 'access-control-allow-origin': '*' }, text: stream, ...overrides },
});

describe('S4R /part-finder contract', () => {
  it('summarises the NDJSON stream the way the S4R page reads it', () => {
    const s = summariseNdjson(stream);
    expect(s).toMatchObject({ eventTypes: ['delta', 'done'], deltaCount: 2, hasDone: true, lastEventType: 'done', unparsableLines: 0 });
    expect(s.partFields).toEqual(['link', 'partId', 'partNo', 'price', 'title']);
    expect(s.understoodFields).toContain('make');
  });

  it('verifies an unchanged capture', () => {
    expect(verifyContract(capture(), capture(), { requiredDoneFields: ['parts', 'understood'], requiredPartFields: ['partNo'] }).ok).toBe(true);
  });

  it('fails when CORS for the S4R origin changes', () => {
    const changed = capture({ headers: { 'content-type': 'application/x-ndjson', 'access-control-allow-origin': 'https://applianceclinic.ai' } });
    expect(verifyContract(capture(), changed).problems.map((p) => p.check)).toContain('post.cors');
  });

  it('fails when the stream loses a field the S4R page reads', () => {
    const broken = [JSON.stringify({ type: 'delta', text: 'x' }), JSON.stringify({ type: 'done', parts: [{ title: 'Pump' }] })].join('\n');
    const r = verifyContract(capture(), capture({ text: broken }), { requiredDoneFields: ['understood'], requiredPartFields: ['partNo'] });
    const checks = r.problems.map((p) => p.check);
    expect(checks).toContain('done.field');
    expect(checks).toContain('part.field');
  });

  it('fails when the response stops being NDJSON', () => {
    const r = verifyContract(capture(), capture({ text: '{"reply":"not a stream"}' }));
    expect(r.ok).toBe(false);
  });
});

describe('smoke comparison', () => {
  const res = (body, status = 200) => ({ status, headers: { 'content-type': 'application/json' }, text: JSON.stringify(body), ms: 10 });
  const base = { gas: summariseApiResponse(res({ reply: 'Turn off the gas supply and leave the property.', safety: true, parts: [] })) };

  it('passes when exact fields match and prose stays within the band', () => {
    const cur = { gas: summariseApiResponse(res({ reply: 'Leave the property and turn off the gas at the meter.', safety: true, parts: [] })) };
    expect(compareSmoke(base, cur).ok).toBe(true);
  });

  it('fails when a safety decision changes', () => {
    const cur = { gas: summariseApiResponse(res({ reply: 'Check the burner.', safety: false, parts: [] })) };
    expect(compareSmoke(base, cur).exact.map((e) => e.check)).toContain('safety');
  });

  it('checks scenario expectations', () => {
    expect(checkExpectations({ expect: { safety: true } }, base.gas)).toEqual([]);
    expect(checkExpectations({ expect: { safety: false } }, base.gas)).toHaveLength(1);
  });
});
