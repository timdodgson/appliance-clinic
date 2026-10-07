/**
 * Stage C BFF contract (SHADOW ONLY), against the REAL handler with a mocked orchestrator (fetch) and
 * an in-memory DynamoDB double. Proves:
 *   - off (default): no state I/O, no `canonical` sent, no `stateToken` in the browser JSON, view unchanged
 *   - shadow: token issued, state loaded + sent, `_canonical` persisted, then STRIPPED from the browser JSON
 *   - invalid token / read failure / conflict / orchestrator failure degrade the shadow only
 *   - the customer-facing view is byte-identical (apart from stateToken) across off / shadow / degraded
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
const { SECRETS, mockDdb, partFinderUnderstand } = require('./canonical-test-helpers.cjs');

const CSID = tok.newCanonicalSessionId(() => Buffer.alloc(24, 3));
const ORCH_VIEW = {
  route: 'SYMPTOMS', outcome: 'ANSWER', message: 'Let us check the drain filter first.',
  provenance: {}, parts: [], understood: { make: null, appliance: 'washing-machine', displayedCode: null },
};

let db; let sent; let orchMode; let realFetch;
function installOrchestrator() {
  realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const payload = JSON.parse(init.body);
    sent.push(payload);
    if (orchMode === 'down') throw new Error('ECONNREFUSED');
    const out = JSON.parse(JSON.stringify(ORCH_VIEW));
    out._diagnosticTrace = { schemaVersion: '1.0', stages: [{ id: 'routing', label: 'Routing', evidence: 'OBSERVED', summary: 'SYMPTOMS', detail: null }] };
    // What the real orchestrator does: pass part-finder's merged result back as `_canonical`.
    if (payload.canonical && orchMode !== 'no-canonical') out._canonical = partFinderUnderstand(payload.canonical);
    if (out._canonical && orchMode === 'classifier') {
      out._canonical.classifier = { source: 'mc1-questions', degraded: false, recallGap: { type: 'model', roleFilled: false }, questionCount: 64, jevMs: 410,
        comparison: { agree: 18, total: 21, byKind: { newly_populated: 2, removed: 1 }, fields: ['identity.make', 'checks', 'problem.journey'] } };
    }
    return { ok: true, status: 200, json: async () => out };
  };
}
async function post(body) {
  const res = await api.handler({ requestContext: { http: { method: 'POST', path: '/' } }, headers: {}, body: JSON.stringify(body) });
  return { status: res.statusCode, raw: res.body, json: JSON.parse(res.body) };
}
const msg = (t = 'my washing machine will not drain') => ({ messages: [{ role: 'user', content: t }] });

beforeAll(() => {
  installOrchestrator();
  api.setTranscriptStore(transcripts.createMemoryStore());
  api.setMediaAdminStore({ loadState: async () => null });
});
afterAll(() => { globalThis.fetch = realFetch; delete process.env.CANONICAL_MODE; });
beforeEach(() => {
  db = mockDdb(); sent = []; orchMode = 'ok';
  const conversationState = require('../conversation-state.js');
  api.setCanonicalDepsForTests({
    store: conversationState.createStateStore({ table: 'whichpart-transcripts', call: db.call, env: {} }),
    secretsLoader: async () => SECRETS,
    newId: () => Buffer.alloc(24, 3),
  });
  delete process.env.CANONICAL_MODE;
});

const stripToken = (v) => { const o = { ...v }; delete o.stateToken; delete o.requestId; delete o.traceId; return o; };

describe('off (default)', () => {
  it('no canonical work: no DynamoDB calls, no block to the orchestrator, no stateToken in the view', async () => {
    const r = await post({ ...msg(), stateToken: tok.issueToken(CSID, SECRETS) });
    expect(r.status).toBe(200);
    expect(db.calls).toEqual([]);
    expect(sent[0].canonical).toBeUndefined();
    expect('stateToken' in r.json).toBe(false);
    expect(r.raw).not.toMatch(/_canonical|cs\/1/);
  });
});

describe('shadow', () => {
  beforeEach(() => { process.env.CANONICAL_MODE = 'shadow'; });

  it('first turn: server-minted csid, version-0 block sent, state persisted, `_canonical` stripped', async () => {
    const r = await post(msg());
    expect(sent[0].canonical).toEqual({ schema: 'cs/1', mode: 'shadow', sessionId: CSID, version: 0, state: null, degraded: null });
    expect(tok.verifyToken(r.json.stateToken, SECRETS)).toMatchObject({ ok: true, csid: CSID });
    expect(r.raw).not.toMatch(/_canonical|cs\/1|stateJson|"canonical"/);
    expect(r.raw).not.toContain(CSID + '"'); // csid appears only inside the opaque token
    expect(db.items.get('STATE#' + CSID).stateVersion.N).toBe('1');
    expect(db.items.has(`STATETURN#${CSID}#1`)).toBe(true);
  });

  it('second turn: browser echoes the token; prior state is loaded and sent; version advances', async () => {
    const r1 = await post(msg());
    const r2 = await post({ ...msg('still not draining'), stateToken: r1.json.stateToken });
    expect(sent[1].canonical.version).toBe(1);
    expect(sent[1].canonical.state.version).toBe(1);
    expect(db.items.get('STATE#' + CSID).stateVersion.N).toBe('2');
    expect(tok.verifyToken(r2.json.stateToken, SECRETS).csid).toBe(CSID);
  });

  it('customer view is identical to off mode apart from the opaque stateToken', async () => {
    const shadow = await post(msg());
    process.env.CANONICAL_MODE = 'off';
    const off = await post(msg());
    expect(stripToken(shadow.json)).toEqual(stripToken(off.json));
  });

  it('canonical state and the token never enter the transcript record; client sessionId ≠ csid', async () => {
    const store = transcripts.createMemoryStore();
    api.setTranscriptStore(store);
    const sid = 'client-session-0001';
    const r = await post({ ...msg(), observability: { sessionId: sid } });
    const rec = await store.get(sid);
    expect(rec).toBeTruthy();
    const dump = JSON.stringify(rec);
    expect(dump).not.toContain(r.json.stateToken);
    expect(dump).not.toContain(CSID);
    expect(dump).not.toMatch(/_canonical|stateJson|classificationJson|"applianceEstablishment"/); // no state body
    expect(sent[0].sessionId).toBe(sid);                 // orchestrator session key = client id
    expect(sent[0].canonical.sessionId).toBe(CSID);      // canonical session = server-minted id
    api.setTranscriptStore(transcripts.createMemoryStore());
  });

  it('admin diagnostic trace carries a bounded canonical-state stage (ref, versions, mc/1 summary, rules, persistence)', async () => {
    const store = transcripts.createMemoryStore();
    api.setTranscriptStore(store);
    const sid = 'client-session-0002';
    const r1 = await post({ ...msg(), observability: { sessionId: sid } });
    await post({ ...msg('still not draining'), stateToken: r1.json.stateToken, observability: { sessionId: sid } });
    const rec = await store.get(sid);
    const stages = rec.turns.map((t) => t.diagnosticTrace.stages.find((s) => s.id === 'canonical-state'));
    expect(stages.every(Boolean)).toBe(true);
    const conversationState = require('../conversation-state.js');
    expect(stages[0].detail).toMatchObject({ mode: 'shadow', ref: conversationState.sessionRef(CSID), priorVersion: 0, resultVersion: 1,
      persistence: { recordWritten: true, stateWritten: true }, degraded: null });
    expect(stages[1].detail).toMatchObject({ priorVersion: 1, resultVersion: 2 });
    expect(stages[1].detail.mc1).toMatchObject({ scope: 'appliance', appliance: 'washing-machine' });
    expect(Array.isArray(stages[1].detail.rulesFired)).toBe(true);
    expect(stages[1].detail.stateBytes).toBeGreaterThan(0);
    expect(JSON.stringify(stages)).not.toContain(CSID);
    expect(JSON.stringify(stages)).not.toContain(r1.json.stateToken);
    api.setTranscriptStore(transcripts.createMemoryStore());
  });

  it('mc/1 classifier observability (source, recall gap, latency) reaches the trace, bounded; no comparison payload', async () => {
    const store = transcripts.createMemoryStore();
    api.setTranscriptStore(store);
    orchMode = 'classifier';
    const sid = 'client-session-0004';
    await post({ ...msg(), observability: { sessionId: sid } });
    const st = (await store.get(sid)).turns[0].diagnosticTrace.stages.find((s) => s.id === 'canonical-state');
    expect(st.detail.classifier).toEqual({ source: 'mc1-questions', degraded: false, reason: null, recallGap: { type: 'model', roleFilled: false },
      questionCount: 64, jevMs: 410 }); // an upstream `comparison` field (retired Stage A diff) is not carried
    api.setTranscriptStore(transcripts.createMemoryStore());
  });

  it('degraded turns are visible in the trace stage too', async () => {
    const store = transcripts.createMemoryStore();
    api.setTranscriptStore(store);
    const sid = 'client-session-0003';
    await post({ ...msg(), stateToken: 'garbage', observability: { sessionId: sid } });
    const st = (await store.get(sid)).turns[0].diagnosticTrace.stages.find((s) => s.id === 'canonical-state');
    expect(st.detail).toMatchObject({ degraded: 'token_malformed', persistence: { stateWritten: false } });
    api.setTranscriptStore(transcripts.createMemoryStore());
  });

  it('control is demoted to shadow (same behaviour, never authoritative)', async () => {
    process.env.CANONICAL_MODE = 'control';
    const r = await post(msg());
    expect(sent[0].canonical.mode).toBe('shadow');
    expect(r.json.stateToken).toBeTruthy();
  });

  it('forged token: degraded, no state read, no block, fresh token; response still succeeds', async () => {
    const forged = tok.issueToken(CSID, { current: 'x'.repeat(40) });
    const r = await post({ ...msg(), stateToken: forged });
    expect(r.status).toBe(200);
    expect(sent[0].canonical).toBeUndefined();
    expect(db.calls).toEqual([]);
    expect(tok.verifyToken(r.json.stateToken, SECRETS).ok).toBe(true);
  });

  it('read failure: no block, nothing persisted, response succeeds', async () => {
    const r1 = await post(msg());
    db.faults.push({ action: 'GetItem', match: () => true, error: new Error('throttled'), once: true });
    const before = JSON.stringify([...db.items]);
    const r2 = await post({ ...msg('again'), stateToken: r1.json.stateToken });
    expect(r2.status).toBe(200);
    expect(sent[1].canonical).toBeUndefined();
    expect(JSON.stringify([...db.items])).toBe(before);
  });

  it('conflict on the state write: no overwrite, response succeeds', async () => {
    const r1 = await post(msg());
    db.faults.push({ action: 'PutItem', match: (pk) => pk.startsWith('STATE#'), error: db.condError(), once: true });
    const r2 = await post({ ...msg('again'), stateToken: r1.json.stateToken });
    expect(r2.status).toBe(200);
    expect(r2.json.reply || r2.json.message || r2.json).toBeTruthy();
    expect(db.items.get('STATE#' + CSID).stateVersion.N).toBe('1');
  });

  it('orchestrator returns no `_canonical`: nothing persisted, response succeeds', async () => {
    orchMode = 'no-canonical';
    const r = await post(msg());
    expect(r.status).toBe(200);
    expect(db.calls.filter((c) => c.action === 'PutItem')).toEqual([]);
  });

  it('orchestrator down: fallback view still carries the token; nothing persisted', async () => {
    orchMode = 'down';
    const r = await post(msg());
    expect(r.status).toBe(200);
    expect(r.json.stateToken).toBeTruthy();
    expect(db.calls.filter((c) => c.action === 'PutItem')).toEqual([]);
  });

  it('no signing secret: canonical disabled, no token, no I/O', async () => {
    api.setCanonicalDepsForTests({ secretsLoader: async () => null });
    const r = await post(msg());
    expect('stateToken' in r.json).toBe(false);
    expect(sent[0].canonical).toBeUndefined();
    expect(db.calls).toEqual([]);
  });

  it('store construction failure is contained (prepare_failed), response succeeds', async () => {
    api.setCanonicalDepsForTests({ store: { loadState: async () => { throw new Error('boom'); },
      getTurnRecord: async () => ({ status: 'missing' }), putState: async () => ({ ok: true }), putTurnRecord: async () => ({ ok: true }) } });
    const r1 = await post(msg());
    const r2 = await post({ ...msg(), stateToken: r1.json.stateToken });
    expect(r2.status).toBe(200);
  });
});
