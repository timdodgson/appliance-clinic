/**
 * The engine boundary (ADR 0017, 0019, 0020), on the real handler with no network:
 *   - every request must carry a valid AC engine signature; an unsigned or wrongly signed one is refused (401) whatever
 *     it contains, including a plain {messages} body. There is no anonymous request path;
 *   - ac2 is the only diagnose path: a signed request that is neither feedback nor `mode: 'turn'` is refused (400),
 *     including the retired understand mode and canonical diagnose calls;
 *   - a signed turn is answered by the ac2 turn; a reasoner that cannot run is an explicit 503, never another answer;
 *   - signed feedback is served;
 *   - responses carry no CORS headers (the engine is called only by AC services, never by a browser).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

process.env.ENGINE_SIGNING_TOKEN = process.env.ENGINE_SIGNING_TOKEN || 'test-engine-signing-key-0123456789abcdef';
const lambda = require('../handler.js');
const { sign, SIGNATURE_HEADER } = require('../engine-auth.js');

const MSG = [{ role: 'user', content: 'my oven smells of gas' }];

async function call(body, { signature = 'none' } = {}) {
  const raw = JSON.stringify(body);
  const headers = signature === 'valid' ? { [SIGNATURE_HEADER]: sign(process.env.ENGINE_SIGNING_TOKEN, raw) }
    : signature === 'wrong' ? { [SIGNATURE_HEADER]: sign('another-key-0123456789abcdef-0123456789', raw) } : {};
  const res = await lambda.handler({ body: raw, headers, requestContext: { requestId: 'boundary', http: { method: 'POST', path: '/' } } });
  let json = null;
  try { json = JSON.parse(String(res.body || '')); } catch { json = null; }
  return { status: res.statusCode, headers: res.headers || {}, json: json || {} };
}

// The reasoner is never reached on these paths: a gas smell is a deterministic safety stop.
const failing = { compose: { name: 'test', model: 'm', infer: async () => { throw Object.assign(new Error('down'), { category: 'NETWORK' }); } } };
afterEach(() => { lambda._internal._setProvidersForTest(null); });

describe('an unsigned or wrongly signed request is refused', () => {
  for (const body of [{ messages: MSG }, { messages: MSG, mode: 'turn' }, { messages: MSG, mode: 'turn', ac2: { state: null } },
    { messages: MSG, mode: 'understand' }, { feedback: { traceId: 't', rating: 'up' } }]) {
    const name = Object.keys(body).join('+') + (body.mode ? `:${body.mode}` : '');
    it(`${name}, unsigned: 401 engine_signature_required`, async () => {
      const r = await call(body);
      expect(r.status).toBe(401);
      expect(r.json.errorCode).toBe('engine_signature_required');
      expect(r.json.type).toBeUndefined();
    });
    it(`${name}, wrong key: 401`, async () => {
      expect((await call(body, { signature: 'wrong' })).status).toBe(401);
    });
  }
});

describe('ac2 is the only diagnose path', () => {
  for (const body of [{ messages: MSG }, { messages: MSG, mode: 'understand' }, { messages: MSG, canonical: { schema: 'cs/1', mode: 'control' } },
    { messages: MSG, mode: 'diagnose' }]) {
    it(`signed ${Object.keys(body).join('+')}${body.mode ? `:${body.mode}` : ''} without mode 'turn': 400`, async () => {
      const r = await call(body, { signature: 'valid' });
      expect(r.status).toBe(400);
      expect(r.json.errorCode).toBe('unsupported_request');
    });
  }
  it('a signed turn is answered by the ac2 turn', async () => {
    lambda._internal._setProvidersForTest(failing);
    const r = await call({ messages: MSG, mode: 'turn', ac2: { state: null, tools: { recalls: [] } } }, { signature: 'valid' });
    expect(r.status).toBe(200);
    expect(r.json.type).toBe('ac2');
    expect(r.json.response.outcome).toBe('SAFETY_STOP');
    expect(r.json.state.schema).toBe('ac2/1');
  });
  it('a turn whose reasoner cannot run is an explicit 503', async () => {
    lambda._internal._setProvidersForTest(failing);
    const r = await call({ messages: [{ role: 'user', content: 'my bosch washing machine will not drain' }], mode: 'turn', ac2: { state: null } }, { signature: 'valid' });
    expect(r.status).toBe(503);
    expect(r.json.errorCode).toBe('reasoner_unavailable');
  });
  it('a signed turn without messages: 400', async () => {
    expect((await call({ mode: 'turn' }, { signature: 'valid' })).status).toBe(400);
  });
});

describe('signed requests are served', () => {
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
