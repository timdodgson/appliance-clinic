/**
 * #21 (Phase 7): a required canonical COMPOSE whose provider failed is an explicit failure, not a normal-looking
 * template reply. The real handler, a mocked orchestrator (fetch) and an in-memory DynamoDB double. Proves:
 *   - the structured violation `compose_failed` (canonical-control stage) yields the documented "AI service
 *     unavailable" reply with error:true; the canonical state is NOT advanced; a retry with the same token proceeds
 *   - output-contract fallbacks (e.g. `extra-questions`), the fixed safety-stop copy and normal COMPOSE are unchanged
 *   - detection reads the structured field only: the same words in a reply never trigger it
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

const CSID = tok.newCanonicalSessionId(() => Buffer.alloc(24, 5));
const TEMPLATE = 'Switch the machine off at the wall. Can you see water in the drum?';
let db; let sent; let compose; let realFetch; let reply;

function installOrchestrator() {
  realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const payload = JSON.parse(init.body);
    sent.push(payload);
    const out = { route: 'SYMPTOMS', outcome: 'ANSWER', message: reply, provenance: {}, parts: [], understood: { appliance: 'washing-machine' } };
    out._diagnosticTrace = { schemaVersion: '1.0', stages: [
      { id: 'routing', label: 'Routing', evidence: 'OBSERVED', summary: 'SYMPTOMS', detail: null },
      ...(compose ? [{ id: 'canonical-control', label: 'Canonical control', evidence: 'OBSERVED', summary: 'x', detail: { compose } }] : []),
    ] };
    if (payload.canonical) out._canonical = partFinderUnderstand(payload.canonical);
    return { ok: true, status: 200, json: async () => out };
  };
}
async function post(body) {
  const res = await api.handler({ requestContext: { http: { method: 'POST', path: '/' } }, headers: {}, body: JSON.stringify(body) });
  return { status: res.statusCode, json: JSON.parse(res.body) };
}
const msg = (t = 'my washing machine will not drain') => ({ messages: [{ role: 'user', content: t }] });
const stateVersion = () => Number(db.items.get('STATE#' + CSID).stateVersion.N);

beforeAll(() => {
  installOrchestrator();
  api.setTranscriptStore(transcripts.createMemoryStore());
  api.setMediaAdminStore({ loadState: async () => null });
});
afterAll(() => { globalThis.fetch = realFetch; delete process.env.CANONICAL_MODE; });
beforeEach(() => {
  db = mockDdb(); sent = []; compose = null; reply = TEMPLATE;
  api.setCanonicalDepsForTests({
    store: conversationState.createStateStore({ table: 'whichpart-transcripts', call: db.call, env: {} }),
    secretsLoader: async () => SECRETS,
    newId: () => Buffer.alloc(24, 5),
  });
  process.env.CANONICAL_MODE = 'shadow';
});

describe('#21: a COMPOSE provider failure is an explicit failure', () => {
  it('detects only the structured violation', () => {
    expect(api.composeProviderFailed({ stages: [{ id: 'canonical-control', detail: { compose: { source: 'template', violations: ['compose_failed'] } } }] })).toBe(true);
    expect(api.composeProviderFailed({ stages: [{ id: 'canonical-control', detail: { compose: { source: 'template', violations: ['extra-questions'] } } }] })).toBe(false);
    expect(api.composeProviderFailed({ stages: [{ id: 'canonical-control', detail: { compose: { source: 'compose', violations: [] } } }] })).toBe(false);
    expect(api.composeProviderFailed({ stages: [{ id: 'routing', detail: { compose: { violations: ['compose_failed'] } } }] })).toBe(false);
    expect(api.composeProviderFailed(null)).toBe(false);
    expect(api.composeProviderFailed({ stages: 'compose_failed' })).toBe(false);
  });

  it('returns the documented failure reply, error:true, and does not advance the canonical state', async () => {
    const r1 = await post(msg());
    expect(r1.json.error).toBeUndefined();
    expect(stateVersion()).toBe(1);

    compose = { source: 'template', violations: ['compose_failed'] };
    const r2 = await post({ ...msg('still not draining'), stateToken: r1.json.stateToken });
    expect(r2.status).toBe(200);
    expect(r2.json.error).toBe(true);
    expect(r2.json.errorCode).toBe('ai_unavailable');
    expect(r2.json.reply).toBe('AI service unavailable. Please try again in a moment.');
    expect(r2.json.reply).not.toBe(TEMPLATE); // never the normal-looking template
    expect(r2.json.parts).toEqual([]);
    expect(stateVersion()).toBe(1); // the customer never saw this turn's question: no state change
    expect(tok.verifyToken(r2.json.stateToken, SECRETS)).toMatchObject({ ok: true, csid: CSID });

    compose = { source: 'compose', violations: [] };
    reply = 'Let us check the drain filter first. Is there water in the drum?';
    const r3 = await post({ ...msg('still not draining'), stateToken: r2.json.stateToken });
    expect(r3.json.error).toBeUndefined();
    expect(r3.json.reply).toBe(reply);
    expect(stateVersion()).toBe(2); // the retry is processed against the same state
  });

  it('keeps output-contract fallbacks and the fixed safety-stop copy as normal turns', async () => {
    compose = { source: 'template', violations: ['extra-questions'] };
    const a = await post(msg());
    expect(a.json.error).toBeUndefined();
    expect(a.json.reply).toBe(TEMPLATE);
    compose = { source: 'template', violations: [] };
    const b = await post(msg());
    expect(b.json.error).toBeUndefined();
  });

  it('never infers failure from words in the reply', async () => {
    reply = 'compose_failed: AI service unavailable';
    compose = { source: 'compose', violations: [] };
    const r = await post(msg());
    expect(r.json.error).toBeUndefined();
    expect(r.json.reply).toBe(reply);
  });
});
