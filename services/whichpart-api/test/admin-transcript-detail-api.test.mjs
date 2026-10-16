/**
 * Transcript enrichment + Admin transcript API, against the REAL BFF handler. The diagnosis engine is a fake (the ac2
 * turn's engine call), the record store is in memory, so the stored ac2-transcript-audit/2 block is what production
 * writes. Proves:
 *   - each ac2 turn stores its bounded audit; the browser view never carries it; no token / csid is stored
 *   - a turn the engine could not answer is stored as a failed turn and the customer sees the explicit error
 *   - records written by the earlier audit schema (/1) stay readable
 *   - list stays compact; detail returns per-turn audits in order; unknown / invalid ids; auth unchanged
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const api = require('../index.js');
const transcripts = require('../transcripts.js');

const SECRETS = { current: 's'.repeat(48), previous: null };
let engineCalls;
function memLedger() {
  const items = new Map();
  return {
    async load(csid) { const it = items.get(csid); return it ? { status: 'ok', state: it, version: it.turn } : { status: 'missing', state: null, version: 0 }; },
    async save(csid, state, expected) {
      const cur = items.get(csid);
      if ((cur ? cur.turn : 0) !== expected) return { ok: false, reason: 'conflict' };
      items.set(csid, state); return { ok: true };
    },
  };
}
/** The engine's ac2 turn: a reply and an advanced record, with the bounded audit the engine writes (ac2/turn.js). */
async function fakeEngine(raw) {
  engineCalls += 1;
  const body = JSON.parse(raw);
  const prior = body.ac2 && body.ac2.state;
  const turn = (prior ? prior.turn : 0) + 1;
  const state = { schema: 'ac3/1', turn, outcome: turn === 1 ? 'diagnosing' : 'part_needed', hazards: [],
    customer: { appliance: 'washing machine', brand: 'hotpoint', model: null, codes: [], symptom: 'not draining' } };
  const audit = { schema: 'ac4-audit/1', turn, provider: { name: 'anthropic', model: 'm' }, timings: { adviseMs: 4, totalMs: 5 }, usage: { inputTokens: 10, outputTokens: 5 },
    toolCalls: ['send_reply'], safety: { hazards: [], gates: [] }, partGate: { outcome: 'none', component: null, reason: null },
    tags: { outcome: state.outcome, media: null, enrichment: { knowledgeIds: ['washing-machine:not-draining'], codes: [], recalls: 0, parts: 0 } }, escalation: null };
  return { status: 200, json: { type: 'ac2', response: { outcome: 'ANSWER', message: turn === 1 ? 'Is there water left in the drum?' : 'Next, check the pump filter.' }, state, audit } };
}
async function call(method, rawPath, { body, qs, admin = true } = {}) {
  api.setSessionForTests(admin ? async () => ({ username: 'a', email: 'a@x', isAdmin: true }) : async () => null);
  const res = await api.handler({ rawPath, requestContext: { http: { method, path: rawPath }, requestId: 'r' }, headers: {}, cookies: [],
    body: body ? JSON.stringify(body) : '', queryStringParameters: qs || {} });
  return { status: res.statusCode, json: JSON.parse(res.body || '{}'), raw: res.body };
}
const SID = 'client-detail-0001';
async function say(text, history = [], { ctid, token } = {}) {
  const messages = [...history, { role: 'user', content: text }];
  return call('POST', '/api', { body: { messages, ...(token ? { stateToken: token } : {}), observability: { sessionId: SID, clientTurnId: ctid } }, admin: false });
}

/** A turn as the earlier engine stored it (ac2-transcript-audit/1, with a ledger), for the read-only legacy path. */
function legacyAuditTurn(seq, at) {
  return {
    seq, at, clientTurnId: `ct-old-${seq}`, customer: { text: 'my beko dishwasher shows E15', photo: false },
    customerVisible: { reply: 'E15 means water in the base.', parts: [], media: [] }, metadata: { route: 'AC2', outcome: 'ANSWER', requestId: 'old' },
    ac2: { schemaVersion: 'ac2-transcript-audit/1', path: 'ac2', turn: 1, status: 'narrowing', provider: { name: 'bedrock', model: 'old' },
      partGate: { outcome: 'none' }, ledger: { appliance: { value: 'dishwasher' }, brand: { value: 'Beko' }, model: null, facts: [] } },
  };
}
async function seedHistorical(store, sessionId, at) {
  const rec = transcripts.emptyRecord(sessionId, new Date(at));
  rec.turns = [legacyAuditTurn(1, at)];
  rec.turnCount = 1;
  await store.put(rec);
}

beforeAll(() => {
  api.setMediaAdminStore({ loadState: async () => null });
  api.setStateTokenDepsForTests({ secretsLoader: async () => SECRETS });
});
afterAll(() => { api.setSessionForTests(null); api.setStateTokenDepsForTests({}); api.setAc2DepsForTests({ store: null }); });
beforeEach(() => {
  engineCalls = 0;
  api.setAc2DepsForTests({ store: memLedger(), callEngine: fakeEngine });
  api.setTranscriptStore(transcripts.createMemoryStore());
});

describe('enrichment through the real handler', () => {
  it('two ac2 turns: per-turn audits in order, view unchanged, no token / csid stored', async () => {
    const store = transcripts.createMemoryStore(); api.setTranscriptStore(store);
    const r1 = await say('my hotpoint washing machine will not drain', [], { ctid: 'ct-0001' });
    expect(r1.status).toBe(200);
    expect(r1.json.reply).toBe('Is there water left in the drum?');
    const r2 = await say('yes, lots of water', [{ role: 'user', content: 'my hotpoint washing machine will not drain' }, { role: 'assistant', content: r1.json.reply }],
      { ctid: 'ct-0002', token: r1.json.stateToken });
    expect(r2.json.stateToken).toBe(r1.json.stateToken);
    expect(engineCalls).toBe(2);
    const rec = await store.get(SID);
    expect(rec.turns.map((t) => [t.seq, t.ac2 && t.ac2.turn])).toEqual([[1, 1], [2, 2]]);
    expect(rec.turns[1].ac2).toMatchObject({ schemaVersion: 'ac2-transcript-audit/2', path: 'ac2', outcome: 'part_needed', partGate: { outcome: 'none' },
      customer: { appliance: 'washing machine', brand: 'hotpoint', model: null }, toolCalls: ['send_reply'], tags: { outcome: 'part_needed' } });
    expect(rec).toMatchObject({ family: 'washing machine', make: 'hotpoint' });
    for (const t of rec.turns) expect(t).not.toHaveProperty('canonical');
    const dump = JSON.stringify(rec);
    expect(dump).not.toContain(r1.json.stateToken);
    expect(dump).not.toMatch(/cs_[A-Za-z0-9_-]{32}/);
    // the browser view never carries the audit
    expect(r1.raw).not.toMatch(/ac2-transcript-audit|toolCalls|"audit"/);
  });
  it('a turn the engine could not answer is stored as a failed ac2 turn, and the customer sees the explicit error', async () => {
    const store = transcripts.createMemoryStore(); api.setTranscriptStore(store);
    api.setAc2DepsForTests({ callEngine: async () => ({ status: 503, json: { errorCode: 'advisor_unavailable' } }) });
    const r = await say('my hotpoint washing machine will not drain', [], { ctid: 'ct-0101' });
    expect(r.json).toMatchObject({ error: true, errorCode: 'ai_unavailable', degraded: 'advisor_unavailable' });
    expect((await store.get(SID)).turns[0].ac2).toMatchObject({ path: 'ac2', error: 'advisor_unavailable' });
    expect((await call('GET', '/api/admin/transcripts', { qs: { degraded: '1' } })).json.items.map((r) => r.sessionId)).toEqual([SID]);
  });
});

describe('admin transcript API', () => {
  it('auth unchanged: list and detail are 401 without an admin session', async () => {
    expect((await call('GET', '/api/admin/transcripts', { admin: false })).status).toBe(401);
    expect((await call('GET', '/api/admin/transcripts/session', { qs: { id: SID }, admin: false })).status).toBe(401);
  });
  it('detail: unknown → 404, invalid id → 400', async () => {
    expect((await call('GET', '/api/admin/transcripts/session', { qs: { id: 'unknown-session-xyz' } })).status).toBe(404);
    expect((await call('GET', '/api/admin/transcripts/session', { qs: { id: 'bad' } })).status).toBe(400);
  });
  it('a session written by the earlier audit schema stays readable: detail returns the audit, the list summarises it', async () => {
    const store = transcripts.createMemoryStore(); api.setTranscriptStore(store);
    await seedHistorical(store, 's-historical-0001', '2026-10-01T10:00:00.000Z');
    const d = await call('GET', '/api/admin/transcripts/session', { qs: { id: 's-historical-0001' } });
    expect(d.status).toBe(200);
    const turns = d.json.customerVisible.turns;
    expect(turns[0].ac2).toMatchObject({ schemaVersion: 'ac2-transcript-audit/1', turn: 1, status: 'narrowing' });
    expect(turns[0].runtime).toMatchObject({ route: 'AC2', outcome: 'ANSWER' });
    expect(d.json.overview.ac2).toMatchObject({ turns: 1, outcome: 'narrowing', appliance: 'dishwasher', errors: 0 });
    expect(d.json.overview.family).toBe('dishwasher');
  });
  it('list: compact rows (no per-turn audit), newest first, cursor pagination, family and outcome filters', async () => {
    const store = transcripts.createMemoryStore(); api.setTranscriptStore(store);
    for (let i = 0; i < 3; i++) {
      const rec = transcripts.emptyRecord(`s-page-session-${i}`, new Date(Date.UTC(2026, 9, 1, 10, i)));
      rec.turns = [{ seq: 1, customer: { text: `t${i}` }, customerVisible: { reply: 'r', parts: [], media: [] } }]; rec.turnCount = 1;
      await store.put(rec);
    }
    await seedHistorical(store, 's-historical-0002', '2026-10-01T09:00:00.000Z');
    await say('my hotpoint washing machine will not drain', [], { ctid: 'ct-0501' });
    const p1 = await call('GET', '/api/admin/transcripts', { qs: { limit: '2' } });
    expect(p1.json.items.map((r) => r.sessionId)).toEqual([SID, 's-page-session-2']);
    expect(p1.raw).not.toMatch(/toolCalls|"turns":\[|enrichment/);
    expect(p1.json.items[0]).toMatchObject({ family: 'washing machine', make: 'hotpoint', ac2: { turns: 1, outcome: 'diagnosing' }, partRecommended: false });
    expect(p1.json.viewCounts).toEqual({ all: 5, safety: 0, errors: 0, parts: 0 });
    const p2 = await call('GET', '/api/admin/transcripts', { qs: { limit: '2', cursor: p1.json.nextCursor } });
    expect(p2.json.items.map((r) => r.sessionId)).toEqual(['s-page-session-1', 's-page-session-0']);
    expect((await call('GET', '/api/admin/transcripts', { qs: { family: 'dishwasher' } })).json.items.map((r) => r.sessionId)).toEqual(['s-historical-0002']);
    expect((await call('GET', '/api/admin/transcripts', { qs: { outcome: 'diagnosing' } })).json.items.map((r) => r.sessionId)).toEqual([SID]);
    expect((await call('GET', '/api/admin/transcripts', { qs: { partRecommended: '0' } })).json.items).toHaveLength(5);
  });
});
