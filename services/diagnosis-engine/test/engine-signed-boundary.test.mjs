/**
 * The engine boundary (ADR 0017, 0018, 0019), on the real handler with no network:
 *   - every request must carry a valid AC engine signature; an unsigned or wrongly signed one is refused (401) whatever
 *     it contains, including a plain {messages} body. There is no anonymous request path;
 *   - a signed diagnose call that no canonical journey controls is refused (409), never answered another way;
 *   - signed understand mode and signed feedback are served;
 *   - responses carry no CORS headers (the engine is called only by AC services, never by a browser).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

process.env.ENGINE_SIGNING_TOKEN = process.env.ENGINE_SIGNING_TOKEN || 'test-engine-signing-key-0123456789abcdef';
const lambda = require('../handler.js');
const U = require('../engine/understand.js');
const { sign, SIGNATURE_HEADER } = require('../engine-auth.js');

const MSG = [{ role: 'user', content: "my bosch washing machine won't drain, water left in the drum" }];
const WM = { onTopic: true, userIntent: 'DIAGNOSE', applianceType: 'washing machine', make: 'bosch', faultId: 'not-draining',
  fault: 'not draining', confidence: 0.9 };

async function call(body, { signature = 'none' } = {}) {
  const raw = JSON.stringify(body);
  const headers = signature === 'valid' ? { [SIGNATURE_HEADER]: sign(process.env.ENGINE_SIGNING_TOKEN, raw) }
    : signature === 'wrong' ? { [SIGNATURE_HEADER]: sign('another-key-0123456789abcdef-0123456789', raw) } : {};
  const res = await lambda.handler({ body: raw, headers, requestContext: { requestId: 'boundary', http: { method: 'POST', path: '/' } } });
  const lines = String(res.body || '').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  return { status: res.statusCode, headers: res.headers || {}, lines, error: lines.find((l) => l.errorCode) || {} };
}

beforeAll(() => {
  lambda._internal._setProvidersForTest({ compose: { infer: async (_r, { onDelta }) => onDelta('Check the pump filter at the bottom front. What did you find?') } });
  U._setUnderstandForTest(() => ({ ...WM }));
});
afterAll(() => { lambda._internal._setProvidersForTest(null); U._setUnderstandForTest(null); });

describe('an unsigned or wrongly signed request is refused', () => {
  for (const body of [{ messages: MSG }, { messages: MSG, mode: 'understand' }, { messages: MSG, understand: WM },
    { messages: MSG, canonical: { schema: 'cs/1', mode: 'control' } }, { messages: MSG, seed: 7 },
    { feedback: { traceId: 't', rating: 'up' } }]) {
    const name = Object.keys(body).join('+');
    it(`${name}, unsigned: 401 engine_signature_required`, async () => {
      const r = await call(body);
      expect(r.status).toBe(401);
      expect(r.error.errorCode).toBe('engine_signature_required');
      expect(r.lines.some((l) => l.type === 'done' || l.type === 'understand')).toBe(false);
    });
    it(`${name}, wrong key: 401`, async () => {
      expect((await call(body, { signature: 'wrong' })).status).toBe(401);
    });
  }
});

describe('a signed diagnose call that no canonical journey controls is refused', () => {
  it('no canonical block: 409 canonical_not_controlled', async () => {
    const r = await call({ messages: MSG, understand: WM, seed: 1 }, { signature: 'valid' });
    expect(r.status).toBe(409);
    expect(r.error.errorCode).toBe('canonical_not_controlled');
  });
  it('a shadow / non-controlling canonical result: 409', async () => {
    const canonical = { schema: 'cs/1', mode: 'shadow', sessionId: 'cs_' + 'a'.repeat(32), priorVersion: 0, version: 1,
      state: { schemaVersion: 'cs/1' }, degraded: null, journey: { key: 'wm-not-draining', applies: true, control: false, nextAction: { kind: 'ask_check' } } };
    expect((await call({ messages: MSG, understand: WM, canonical }, { signature: 'valid' })).status).toBe(409);
  });
});

describe('signed requests are served', () => {
  it('understand mode returns the understanding', async () => {
    const r = await call({ messages: MSG, mode: 'understand', seed: 1 }, { signature: 'valid' });
    expect(r.status).toBe(200);
    expect(r.lines.some((l) => l.type === 'understand')).toBe(true);
  });
  it('feedback is accepted', async () => {
    const r = await call({ feedback: { traceId: 't', rating: 'up' } }, { signature: 'valid' });
    expect(r.status).toBe(200);
  });
  it('no response carries CORS headers', async () => {
    for (const r of [await call({ messages: MSG }), await call({ messages: MSG, mode: 'understand' }, { signature: 'valid' })]) {
      expect(Object.keys(r.headers).filter((h) => /^access-control-/i.test(h))).toEqual([]);
    }
  });
});
