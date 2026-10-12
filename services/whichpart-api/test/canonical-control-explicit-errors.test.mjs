/**
 * ADR 0018 (with ADR 0016): in canonical CONTROL mode an AC turn is canonical or an explicit error. Against the REAL
 * handler with a mocked orchestrator (fetch) and an in-memory DynamoDB double. Proves:
 *   - a turn whose canonical state could not be prepared is answered with an explicit error and the orchestrator is
 *     never called (nothing can answer it some other way);
 *   - a reply whose canonical result degraded, or could not be recorded, is not shown as a normal answer;
 *   - an orchestrator SERVICE_UNAVAILABLE carries the degraded reason in the view;
 *   - an invalid / expired token starts a fresh canonical session (not a non-canonical turn);
 *   - nothing advances on a failed turn.
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
const { SECRETS, mockDdb, engineUnderstand } = require('./canonical-test-helpers.cjs');

const ORCH_VIEW = {
  route: 'SYMPTOMS', outcome: 'ANSWER', message: 'Let us check the drain filter first.',
  provenance: {}, parts: [], understood: { make: null, appliance: 'washing-machine', displayedCode: null },
};

let db; let sent; let orchMode; let realFetch;
beforeAll(() => {
  realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const payload = JSON.parse(init.body);
    sent.push(payload);
    const out = JSON.parse(JSON.stringify(ORCH_VIEW));
    out._diagnosticTrace = { schemaVersion: '1.0', stages: [] };
    if (payload.canonical) out._canonical = engineUnderstand(payload.canonical);
    if (orchMode === 'degraded' && out._canonical) out._canonical = { ...out._canonical, degraded: 'classification_degraded' };
    if (orchMode === 'unavailable') {
      out.outcome = 'SERVICE_UNAVAILABLE'; out.message = 'Sorry, the diagnosis service is unavailable right now.';
      out._canonical = { ...out._canonical, degraded: 'understand_unavailable' };
    }
    if (orchMode === 'no-canonical') delete out._canonical;
    return { ok: true, status: 200, json: async () => out };
  };
  api.setTranscriptStore(transcripts.createMemoryStore());
  api.setMediaAdminStore({ loadState: async () => null });
});
afterAll(() => { globalThis.fetch = realFetch; delete process.env.CANONICAL_MODE; delete process.env.CANONICAL_CONTROL_JOURNEYS; });
beforeEach(() => {
  db = mockDdb(); sent = []; orchMode = 'ok';
  const conversationState = require('../conversation-state.js');
  api.setCanonicalDepsForTests({
    store: conversationState.createStateStore({ table: 'whichpart-transcripts', call: db.call, env: {} }),
    secretsLoader: async () => SECRETS,
    newId: () => Buffer.alloc(24, 5),
  });
  process.env.CANONICAL_MODE = 'control';
  process.env.CANONICAL_CONTROL_JOURNEYS = 'wm-not-draining';
});

async function post(body) {
  const res = await api.handler({ requestContext: { http: { method: 'POST', path: '/' } }, headers: {}, body: JSON.stringify(body) });
  return { status: res.statusCode, json: JSON.parse(res.body) };
}
const msg = (t = 'my washing machine will not drain') => ({ messages: [{ role: 'user', content: t }] });
const stateItems = () => JSON.stringify([...db.items].filter(([k]) => k.startsWith('STATE#')));

describe('control mode: prepare failures are explicit errors, never answered another way', () => {
  it('a state read failure: explicit error with the reason; the orchestrator is not called; nothing advances', async () => {
    const r1 = await post(msg());
    expect(r1.json.error).toBeUndefined();
    db.faults.push({ action: 'GetItem', match: () => true, error: new Error('throttled'), once: true });
    const before = stateItems();
    const r2 = await post({ ...msg('again'), stateToken: r1.json.stateToken });
    expect(r2.json).toMatchObject({ error: true, errorCode: 'canonical_unavailable', degraded: 'read_failed' });
    expect(r2.json.reply).not.toMatch(/drain filter/);
    expect(sent).toHaveLength(1);
    expect(stateItems()).toBe(before);
  });
  it('no signing secret: explicit error, no orchestrator call', async () => {
    const conversationState = require('../conversation-state.js');
    api.setCanonicalDepsForTests({ store: conversationState.createStateStore({ table: 'whichpart-transcripts', call: db.call, env: {} }), secretsLoader: async () => null, newId: () => Buffer.alloc(24, 5) });
    const r = await post(msg());
    expect(r.json).toMatchObject({ error: true, degraded: 'no_signing_secret' });
    expect(sent).toHaveLength(0);
  });
  it('an expired token starts a fresh canonical session on this turn (control block at version 0)', async () => {
    const expired = tok.issueToken(tok.newCanonicalSessionId(() => Buffer.alloc(24, 9)), SECRETS, { nowSec: Math.floor(Date.now() / 1000) - tok.DEFAULT_TTL_SECONDS - 5 });
    const r = await post({ ...msg(), stateToken: expired });
    expect(r.json.error).toBeUndefined();
    expect(sent[0].canonical).toMatchObject({ mode: 'control', version: 0, state: null });
  });
});

describe('control mode: a degraded or unrecorded canonical result is not shown as a normal reply', () => {
  it('the canonical result came back degraded: explicit error with the reason; nothing persisted', async () => {
    orchMode = 'degraded';
    const before = stateItems();
    const r = await post(msg());
    expect(r.json).toMatchObject({ error: true, errorCode: 'canonical_unavailable', degraded: 'upstream_classification_degraded' });
    expect(r.json.reply).not.toMatch(/drain filter/);
    expect(stateItems()).toBe(before);
  });
  it('no canonical result at all: explicit error', async () => {
    orchMode = 'no-canonical';
    const r = await post(msg());
    expect(r.json).toMatchObject({ error: true, degraded: 'missing_output' });
  });
  it('orchestrator SERVICE_UNAVAILABLE: error with the degraded reason, its own copy', async () => {
    orchMode = 'unavailable';
    const r = await post(msg());
    expect(r.json).toMatchObject({ error: true, degraded: 'understand_unavailable' });
  });
  it('a healthy canonical turn is a normal reply and persists state', async () => {
    const r = await post(msg());
    expect(r.json.error).toBeUndefined();
    expect(r.json.reply).toMatch(/drain filter/);
    expect(stateItems()).not.toBe('[]');
  });
});
