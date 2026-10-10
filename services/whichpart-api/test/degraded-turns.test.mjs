/**
 * ADR 0016 (Phase 10): a turn whose decision path could not run is an error, not a normal reply. Real transcripts
 * showed whole sessions of "I can't run the diagnosis right now" recorded as healthy turns and never reviewed.
 * The real handler, a mocked orchestrator (fetch) and an in-memory DynamoDB double. Proves:
 *   - an orchestrator SERVICE_UNAVAILABLE outcome reaches the browser with error:true and its own copy
 *   - a canonical result the orchestrator marked degraded is not persisted (the state version does not move)
 *   - a normal turn is unchanged
 *   - composeOf reads the structured COMPOSE record for the benchmark status
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

process.env.ORCHESTRATOR_URL = 'http://orchestrator.test';
process.env.ORCHESTRATOR_TOKEN = '';
process.env.ORCH_TIMEOUT_MS = '4000';
const handlerPath = require.resolve('../index.js');
delete require.cache[handlerPath];
const api = require(handlerPath);
const transcripts = require('../transcripts.js');
const tok = require('../state-token.js');
const conversationState = require('../conversation-state.js');
const { SECRETS, mockDdb, partFinderUnderstand } = require('./canonical-test-helpers.cjs');

const CSID = tok.newCanonicalSessionId(() => Buffer.alloc(24, 6));
let db; let realFetch; let outcome; let degradeCanonical;

beforeAll(() => {
  realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const payload = JSON.parse(init.body);
    const out = outcome === 'SERVICE_UNAVAILABLE'
      ? { route: 'SYMPTOMS', outcome, message: "I can't run the diagnosis right now. Please try again shortly.", provenance: {}, parts: [] }
      : { route: 'SYMPTOMS', outcome: 'ANSWER', message: 'Check the pump filter. Is it clear?', provenance: {}, parts: [], understood: { appliance: 'washing-machine' } };
    out._diagnosticTrace = { schemaVersion: '1.0', stages: [] };
    if (payload.canonical) {
      out._canonical = partFinderUnderstand(payload.canonical);
      if (degradeCanonical) out._canonical = { ...out._canonical, degraded: 'diagnose_unavailable' };
    }
    return { ok: true, status: 200, json: async () => out };
  };
  api.setTranscriptStore(transcripts.createMemoryStore());
  api.setMediaAdminStore({ loadState: async () => null });
});
afterAll(() => { globalThis.fetch = realFetch; delete process.env.CANONICAL_MODE; });
beforeEach(() => {
  db = mockDdb(); outcome = 'ANSWER'; degradeCanonical = false;
  api.setCanonicalDepsForTests({
    store: conversationState.createStateStore({ table: 'whichpart-transcripts', call: db.call, env: {} }),
    secretsLoader: async () => SECRETS,
    newId: () => Buffer.alloc(24, 6),
  });
  process.env.CANONICAL_MODE = 'shadow';
});
async function post(body) {
  const res = await api.handler({ requestContext: { http: { method: 'POST', path: '/' } }, headers: {}, body: JSON.stringify(body) });
  return { status: res.statusCode, json: JSON.parse(res.body) };
}
const msg = (t = 'my washing machine will not drain') => ({ messages: [{ role: 'user', content: t }] });
const stateVersion = () => Number(db.items.get('STATE#' + CSID).stateVersion.N);

describe('ADR 0016: degraded turns are errors', () => {
  it('a normal turn is not an error', async () => {
    const r = await post(msg());
    expect(r.json.error).toBeUndefined();
    expect(stateVersion()).toBe(1);
  });
  it('SERVICE_UNAVAILABLE reaches the browser as error:true with the orchestrator copy', async () => {
    outcome = 'SERVICE_UNAVAILABLE';
    const r = await post(msg());
    expect(r.status).toBe(200);
    expect(r.json.error).toBe(true);
    expect(r.json.reply).toMatch(/can't run the diagnosis/);
  });
  it('a canonical result marked degraded by the orchestrator is not persisted', async () => {
    const r1 = await post(msg());
    expect(stateVersion()).toBe(1);
    outcome = 'SERVICE_UNAVAILABLE'; degradeCanonical = true;
    const r2 = await post({ ...msg(), stateToken: r1.json.stateToken });
    expect(r2.json.error).toBe(true);
    expect(stateVersion()).toBe(1);
  });
});

describe('composeOf (benchmark COMPOSE telemetry)', () => {
  it('reads the canonical-control stage only', () => {
    expect(api.composeOf({ stages: [{ id: 'canonical-control', detail: { compose: { source: 'template', violations: ['prompt-echo'], error: null } } }] }))
      .toEqual({ source: 'template', violations: ['prompt-echo'], error: null });
    expect(api.composeOf({ stages: [{ id: 'routing', detail: { compose: { source: 'template' } } }] })).toBe(null);
    expect(api.composeOf(null)).toBe(null);
  });
});
