/**
 * Transcript enrichment + Admin transcript API, against the REAL BFF handler. The diagnosis engine is a fake (the ac2
 * turn's engine call), the ledger store is in memory, so the stored ac2-transcript-audit/1 block is what production
 * writes. Proves:
 *   - each ac2 turn stores its audit (never a canonical block); the browser view never carries it; no token / csid
 *   - historical canonical-audit/1 turns (written before the journey controller was retired) stay readable: detail
 *     returns them, the list summarises them, and a session that mixes them with ac2 turns is reported as mixed
 *   - list stays compact; detail returns per-turn audits in order; unknown / invalid ids
 *   - auth unchanged (401 without an admin session)
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
/** The engine's ac2 turn: a reply and an advanced ledger, with a bounded audit. */
async function fakeEngine(raw) {
  engineCalls += 1;
  const body = JSON.parse(raw);
  const prior = body.ac2 && body.ac2.state;
  const turn = (prior ? prior.turn : 0) + 1;
  const state = { schema: 'ac3/1', turn, stage: 2, outcome: null, narrowed: null, asked: [], hazards: [],
    customer: { appliance: { value: 'washing-machine', confidence: 0.9, turn: 1 }, brand: { value: 'hotpoint', confidence: 0.9, turn: 1 }, model: null, codes: [], symptom: { value: 'not draining', confidence: 0.9, turn: 1 }, symptomArea: null, checks: [{ check: 'pump filter', result: 'clear', turn }], modelUnavailable: false },
    knowledge: { knowledgeIds: [], fault: null, causes: [], components: [], codeMeanings: [], modelInfo: [] } };
  const audit = { schema: 'ac3-audit/1', turn, provider: { name: 'test', model: 'm' }, timings: { totalMs: 5 }, safety: { hazards: [], gates: [] },
    partGate: { outcome: 'none' }, tags: { labels: { appliance: { value: 'washing-machine', confidence: 0.9 } }, stage: 2, replyAction: { value: 'asks_question', confidence: 0.8 } } };
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

/** A turn as the retired journey controller stored it (canonical-audit/1), for the read-only legacy path. */
function legacyCanonicalTurn(seq, at) {
  return {
    seq, at, clientTurnId: `ct-old-${seq}`, customer: { text: 'my hotpoint washing machine will not drain', photo: false },
    customerVisible: { reply: 'Is the drain filter clear?' }, metadata: { route: 'SYMPTOMS', outcome: 'ANSWER', requestId: 'old' },
    diagnosticTrace: null,
    canonical: { schemaVersion: 'canonical-audit/1', path: 'control', mode: 'control', controlled: true, owner: 'wm-not-draining', ref: 'abcdef012345',
      appliance: 'washing-machine', version: { before: 0, after: 1 }, policy: { rule: 'R7', kind: 'ask_check', target: 'drain-filter' },
      nextAction: { kind: 'ask_check', target: 'drain-filter', rule: 'R7' }, stateDelta: [{ op: 'add', field: 'appliance', to: 'washing-machine' }],
      persistence: { written: true, recordWritten: true } },
  };
}
async function seedHistorical(store, sessionId, at) {
  const rec = transcripts.emptyRecord(sessionId, new Date(at));
  rec.turns = [legacyCanonicalTurn(1, at)];
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
    expect(rec.turns[1].ac2).toMatchObject({ schemaVersion: 'ac2-transcript-audit/1', path: 'ac2', status: 'stage_2', partGate: { outcome: 'none' }, tags: { stage: 2, replyAction: { value: 'asks_question' } } });
    for (const t of rec.turns) expect(t).not.toHaveProperty('canonical');
    const dump = JSON.stringify(rec);
    expect(dump).not.toContain(r1.json.stateToken);
    expect(dump).not.toMatch(/cs_[A-Za-z0-9_-]{32}/);
    // the browser view never carries the audit
    expect(r1.raw).not.toMatch(/ac2-transcript-audit|claimsChecked|"ledger"/);
  });
  it('a turn the engine could not answer is stored as a failed ac2 turn, and the customer sees the explicit error', async () => {
    const store = transcripts.createMemoryStore(); api.setTranscriptStore(store);
    api.setAc2DepsForTests({ callEngine: async () => ({ status: 503, json: { errorCode: 'reasoner_unavailable' } }) });
    const r = await say('my hotpoint washing machine will not drain', [], { ctid: 'ct-0101' });
    expect(r.json).toMatchObject({ error: true, errorCode: 'ai_unavailable', degraded: 'reasoner_unavailable' });
    expect((await store.get(SID)).turns[0].ac2).toMatchObject({ path: 'ac2', error: 'reasoner_unavailable' });
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
  it('a historical canonical-audit/1 session stays readable: detail returns the stored audit, the list summarises it', async () => {
    const store = transcripts.createMemoryStore(); api.setTranscriptStore(store);
    await seedHistorical(store, 's-historical-0001', '2026-10-01T10:00:00.000Z');
    const d = await call('GET', '/api/admin/transcripts/session', { qs: { id: 's-historical-0001' } });
    expect(d.status).toBe(200);
    const turns = d.json.customerVisible.turns;
    expect(turns[0].canonical).toMatchObject({ schemaVersion: 'canonical-audit/1', path: 'control', policy: { rule: 'R7' } });
    expect(turns[0].ac2).toBeNull();
    expect(d.json.overview.canonical).toMatchObject({ path: 'control', journey: 'wm-not-draining', counts: { control: 1 } });
  });
  it('a session that continues after the cutover is mixed; the older canonical audit is kept read-only', async () => {
    const store = transcripts.createMemoryStore(); api.setTranscriptStore(store);
    await seedHistorical(store, SID, '2026-10-01T10:00:00.000Z');
    await say('the filter is clear', [{ role: 'user', content: 'my hotpoint washing machine will not drain' }, { role: 'assistant', content: 'Is the drain filter clear?' }], { ctid: 'ct-0402' });
    const d = await call('GET', '/api/admin/transcripts/session', { qs: { id: SID } });
    const turns = d.json.customerVisible.turns;
    expect(turns.map((t) => t.seq)).toEqual([1, 2]);
    expect(turns[0].canonical).toMatchObject({ schemaVersion: 'canonical-audit/1', owner: 'wm-not-draining' });
    expect(turns[1].canonical).toBeNull();
    expect(turns[1].ac2).toMatchObject({ path: 'ac2' });
    expect(d.json.overview.canonical).toMatchObject({ path: 'mixed', journey: 'wm-not-draining', counts: { control: 1, ac2: 1 } });
  });
  it('list: compact rows (no per-turn audit), newest first, cursor pagination, path and journey filters', async () => {
    const store = transcripts.createMemoryStore(); api.setTranscriptStore(store);
    for (let i = 0; i < 3; i++) {
      const rec = transcripts.emptyRecord(`s-page-session-${i}`, new Date(Date.UTC(2026, 9, 1, 10, i)));
      rec.turns = [{ seq: 1, customer: { text: `t${i}` }, customerVisible: { reply: 'r' } }]; rec.turnCount = 1;
      await store.put(rec);
    }
    await seedHistorical(store, 's-historical-0002', '2026-10-01T09:00:00.000Z');
    await say('my hotpoint washing machine will not drain', [], { ctid: 'ct-0501' });
    const p1 = await call('GET', '/api/admin/transcripts', { qs: { limit: '2' } });
    expect(p1.json.items.map((r) => r.sessionId)).toEqual([SID, 's-page-session-2']);
    expect(p1.raw).not.toMatch(/stateDelta|"ledger"|nextAction|"turns":\[/);
    expect(p1.json.items[0]).toMatchObject({ canonical: { path: 'ac2' } });
    const p2 = await call('GET', '/api/admin/transcripts', { qs: { limit: '2', cursor: p1.json.nextCursor } });
    expect(p2.json.items.map((r) => r.sessionId)).toEqual(['s-page-session-1', 's-page-session-0']);
    expect((await call('GET', '/api/admin/transcripts', { qs: { journey: 'wm-not-draining' } })).json.items.map((r) => r.sessionId)).toEqual(['s-historical-0002']);
    expect((await call('GET', '/api/admin/transcripts', { qs: { canonical: 'ac2' } })).json.items.map((r) => r.sessionId)).toEqual([SID]);
    expect((await call('GET', '/api/admin/transcripts', { qs: { canonical: 'legacy' } })).json.items).toHaveLength(3);
  });
});
