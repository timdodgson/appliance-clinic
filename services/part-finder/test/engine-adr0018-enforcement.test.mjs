/**
 * ADR 0018 at the engine boundary (the real handler, no network):
 *   - S4R's plain unsigned {messages} request is served by the legacy pipeline, unchanged;
 *   - a request carrying AC/internal fields without a valid signature is refused (401), never served as a plain one;
 *   - a signed (AC) diagnose call that no canonical journey controls is refused (409), never answered by the legacy
 *     pipeline.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

// The response stream records the status the handler opens it with (the real runtime sends it as the HTTP status).
globalThis.awslambda = { streamifyResponse: (f) => f, HttpResponseStream: { from: (s, meta) => { s.meta = meta; return s; } } };
process.env.ENGINE_SIGNING_TOKEN = process.env.ENGINE_SIGNING_TOKEN || 'test-engine-signing-key-0123456789abcdef';
const lambda = require('../part-finder-lambda.js');
const U = require('../engine/understand.js');
const { sign, SIGNATURE_HEADER } = require('../engine-auth.js');

const MSG = [{ role: 'user', content: "my bosch washing machine won't drain, water left in the drum" }];
const WM = { onTopic: true, userIntent: 'DIAGNOSE', applianceType: 'washing machine', make: 'bosch', faultId: 'not-draining',
  fault: 'not draining', confidence: 0.9, _applianceFamilyProvenance: 'stated', _requestClass: 'appliance_request' };

async function call(body, { signed = false } = {}) {
  const raw = JSON.stringify(body);
  const headers = signed ? { [SIGNATURE_HEADER]: sign(process.env.ENGINE_SIGNING_TOKEN, raw) } : { origin: 'https://spares4repairs.co.uk' };
  const w = [];
  const stream = { write: (x) => w.push(String(x)), end: () => {} };
  await lambda.handler({ body: raw, headers, requestContext: { requestId: 'adr18', http: { method: 'POST', path: '/' } } }, stream);
  const lines = w.join('').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  return { status: stream.meta && stream.meta.statusCode, lines, done: lines.find((l) => l.type === 'done') };
}

beforeAll(() => {
  lambda._internal._setProvidersForTest({ compose: { infer: async (_r, { onDelta }) => onDelta('Check the pump filter at the bottom front. What did you find?') } });
  U._setUnderstandForTest(() => U.reviveInjectedIntent(WM));
});
afterAll(() => { lambda._internal._setProvidersForTest(null); U._setUnderstandForTest(null); });

const statusOf = (r) => r.status;
const errorOf = (r) => r.lines.find((l) => l.errorCode) || {};

describe('S4R contract: plain unsigned {messages}', () => {
  it('is served by the legacy pipeline (a done event, no rejection)', async () => {
    const r = await call({ messages: MSG });
    expect(r.done).toBeTruthy();
    expect(statusOf(r)).toBe(200);
  });
});

describe('AC/internal fields without a valid signature are refused', () => {
  for (const extra of [{ mode: 'understand' }, { understand: WM }, { canonical: { schema: 'cs/1', mode: 'control' } },
    { established: { applianceFamily: 'washing-machine' } }, { seed: 7 }, { feedback: { traceId: 't', rating: 1 } }]) {
    it(`${Object.keys(extra)[0]}: 401 engine_signature_required, never a diagnosis`, async () => {
      const r = await call({ messages: MSG, ...extra });
      expect(statusOf(r)).toBe(401);
      expect(errorOf(r).errorCode).toBe('engine_signature_required');
      expect(r.done).toBeFalsy();
    });
  }
});

describe('a signed AC diagnose call that no canonical journey controls is refused', () => {
  it('no canonical block: 409 canonical_not_controlled, never the legacy pipeline', async () => {
    const r = await call({ messages: MSG, understand: WM, seed: 1 }, { signed: true });
    expect(statusOf(r)).toBe(409);
    expect(errorOf(r).errorCode).toBe('canonical_not_controlled');
    expect(r.done).toBeFalsy();
  });
  it('a shadow / non-controlling canonical result: 409', async () => {
    const canonical = { schema: 'cs/1', mode: 'shadow', sessionId: 'cs_' + 'a'.repeat(32), priorVersion: 0, version: 1,
      state: { schemaVersion: 'cs/1' }, degraded: null, journey: { key: 'wm-not-draining', applies: true, control: false, nextAction: { kind: 'ask_check' } } };
    const r = await call({ messages: MSG, understand: WM, canonical }, { signed: true });
    expect(statusOf(r)).toBe(409);
  });
  it('signed understand mode is still served (it decides the canonical result)', async () => {
    const r = await call({ messages: MSG, mode: 'understand', seed: 1 }, { signed: true });
    expect(statusOf(r)).not.toBe(409);
    expect(r.lines.some((l) => l.type === 'understand')).toBe(true);
  });
});
