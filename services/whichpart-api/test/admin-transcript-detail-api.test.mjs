/**
 * Transcript enrichment + Admin transcript API, against the REAL BFF handler. The orchestrator is mocked (fetch) but
 * runs the REAL part-finder canonical runtime for the turn (merge → journey → policy → COMPOSE with a fake LM), so the
 * stored canonical-audit/1 block is what production writes. Proves:
 *   - a controlled turn writes the audit; the browser view is unchanged by it (and by an audit failure)
 *   - idempotent duplicate marks the original turn as replayed
 *   - list stays compact; detail returns per-turn audits in order; unknown / invalid ids; old + mixed sessions
 *   - auth unchanged (401 without an admin session); no token / csid in the stored record
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

process.env.ORCHESTRATOR_URL = 'http://orchestrator.test';
process.env.ORCHESTRATOR_TOKEN = '';
const handlerPath = require.resolve('../index.js');
delete require.cache[handlerPath];
const api = require(handlerPath);
const transcripts = require('../transcripts.js');
const audit = require('../canonical-audit.js');
const { SECRETS, mockDdb } = require('./canonical-test-helpers.cjs');
const F = require('./canonical-audit-fixtures.cjs');

const BY_TEXT = { 'my hotpoint washing machine will not drain': F.TURNS.wmOpen, 'the filter is clear': F.TURNS.wmFilterClear };
let realFetch; let db; let orchCalls;
function installOrchestrator() {
  realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const p = JSON.parse(init.body);
    orchCalls += 1;
    const latest = p.latestMessage || '';
    const out = { route: 'SYMPTOMS', outcome: 'ANSWER', message: 'Legacy reply.', provenance: {}, parts: [],
      understood: { appliance: 'washing-machine' }, _diagnosticTrace: { schemaVersion: '1.0', stages: [{ id: 'routing', label: 'Routing', evidence: 'OBSERVED', summary: 'SYMPTOMS', detail: null }] } };
    const c = BY_TEXT[latest];
    if (p.canonical && c) {
      const blk = { ...p.canonical, control: p.canonical.control || { journeys: [] } };
      const t = await F.runTurn(c, blk);
      out._canonical = t.out;
      out._diagnosticTrace = t.trace;
      if (t.reply) out.message = t.reply;
    }
    return { ok: true, status: 200, json: async () => out };
  };
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

beforeAll(() => { installOrchestrator(); api.setMediaAdminStore({ loadState: async () => null }); });
afterAll(() => { globalThis.fetch = realFetch; delete process.env.CANONICAL_MODE; delete process.env.CANONICAL_CONTROL_JOURNEYS; api.setSessionForTests(null); });
beforeEach(() => {
  db = mockDdb(); orchCalls = 0;
  process.env.CANONICAL_MODE = 'control';
  process.env.CANONICAL_CONTROL_JOURNEYS = F.REG.KEYS.join('+');
  const cs = require('../conversation-state.js');
  api.setCanonicalDepsForTests({ store: cs.createStateStore({ table: 'whichpart-transcripts', call: db.call, env: {} }), secretsLoader: async () => SECRETS,
    newId: () => Buffer.alloc(24, 9) });
  api.setTranscriptStore(transcripts.createMemoryStore());
});

describe('enrichment through the real handler', () => {
  it('two controlled turns: per-turn audits in order, view unchanged, no token / csid stored', async () => {
    const store = transcripts.createMemoryStore(); api.setTranscriptStore(store);
    const r1 = await say('my hotpoint washing machine will not drain', [], { ctid: 'ct-0001' });
    expect(r1.status).toBe(200);
    const r2 = await say('the filter is clear', [{ role: 'user', content: 'my hotpoint washing machine will not drain' }, { role: 'assistant', content: r1.json.reply }],
      { ctid: 'ct-0002', token: r1.json.stateToken });
    const rec = await store.get(SID);
    expect(rec.turns.map((t) => [t.seq, t.canonical && t.canonical.policy && t.canonical.policy.rule])).toEqual([[1, 'R7'], [2, 'R8']]);
    expect(rec.turns[1].canonical).toMatchObject({ path: 'control', owner: 'wm-not-draining', version: { before: 1, after: 2 } });
    const dump = JSON.stringify(rec);
    expect(dump).not.toContain(r1.json.stateToken);
    expect(dump).not.toContain(r2.json.stateToken);
    expect(dump).not.toMatch(/cs_[A-Za-z0-9_-]{32}/);
    // the browser view never carries the audit
    expect(r1.raw).not.toMatch(/canonical-audit|stateDelta|"_canonical"/);
  });
  it('an audit failure never changes the customer response', async () => {
    const r1 = await say('my hotpoint washing machine will not drain', [], { ctid: 'ct-0101' });
    const orig = audit.buildCanonicalTranscriptAudit;
    audit.buildCanonicalTranscriptAudit = () => { throw new Error('boom'); };
    try {
      db = mockDdb();
      const cs = require('../conversation-state.js');
      api.setCanonicalDepsForTests({ store: cs.createStateStore({ table: 'whichpart-transcripts', call: db.call, env: {} }) });
      api.setTranscriptStore(transcripts.createMemoryStore());
      const r1b = await say('my hotpoint washing machine will not drain', [], { ctid: 'ct-0101' });
      const strip = (j) => JSON.stringify({ ...j, requestId: null, stateToken: null });
      expect(strip(r1b.json)).toBe(strip(r1.json));
    } finally { audit.buildCanonicalTranscriptAudit = orig; }
  });
  it('idempotent duplicate (same clientTurnId): cached view returned, original audit marked replayed', async () => {
    const store = transcripts.createMemoryStore(); api.setTranscriptStore(store);
    const r1 = await say('my hotpoint washing machine will not drain', [], { ctid: 'ct-0201' });
    const before = orchCalls;
    const dup = await say('my hotpoint washing machine will not drain', [], { ctid: 'ct-0201', token: r1.json.stateToken });
    expect(orchCalls).toBe(before);                                        // not re-processed
    expect(dup.json.reply).toBe(r1.json.reply);
    const t = (await store.get(SID)).turns;
    expect(t).toHaveLength(1);
    expect(t[0].canonical.persistence.idempotentReplay.count).toBe(1);
    expect(t[0].canonical.policy.rule).toBe('R7');
  });
  it('canonical off: legacy turns carry no audit (nothing fabricated)', async () => {
    process.env.CANONICAL_MODE = 'off';
    const store = transcripts.createMemoryStore(); api.setTranscriptStore(store);
    await say('my hotpoint washing machine will not drain', [], { ctid: 'ct-0301' });
    expect((await store.get(SID)).turns[0].canonical).toBeNull();
  });
});

describe('admin transcript API', () => {
  async function seedMixed(store) {
    process.env.CANONICAL_MODE = 'off';
    await say('hello there legacy first', [], { ctid: 'ct-0401' });                  // legacy turn (no canonical)
    process.env.CANONICAL_MODE = 'control';
    await say('my hotpoint washing machine will not drain', [], { ctid: 'ct-0402' }); // canonical controlled turn
    return store.get(SID);
  }
  it('auth unchanged: list and detail are 401 without an admin session', async () => {
    expect((await call('GET', '/api/admin/transcripts', { admin: false })).status).toBe(401);
    expect((await call('GET', '/api/admin/transcripts/session', { qs: { id: SID }, admin: false })).status).toBe(401);
  });
  it('detail: unknown → 404, invalid id → 400', async () => {
    expect((await call('GET', '/api/admin/transcripts/session', { qs: { id: 'unknown-session-xyz' } })).status).toBe(404);
    expect((await call('GET', '/api/admin/transcripts/session', { qs: { id: 'bad' } })).status).toBe(400);
  });
  it('mixed legacy / canonical session: detail returns each turn with its own audit (or null), in order', async () => {
    const store = transcripts.createMemoryStore(); api.setTranscriptStore(store);
    await seedMixed(store);
    const d = await call('GET', '/api/admin/transcripts/session', { qs: { id: SID } });
    expect(d.status).toBe(200);
    const turns = d.json.customerVisible.turns;
    expect(turns.map((t) => t.seq)).toEqual([1, 2]);
    expect(turns[0].canonical).toBeNull();
    expect(turns[0].runtime).toMatchObject({ route: 'SYMPTOMS' });
    expect(turns[1].canonical).toMatchObject({ schemaVersion: 'canonical-audit/1', path: 'control', policy: { rule: 'R7' } });
    expect(d.json.overview.canonical).toMatchObject({ path: 'mixed', journey: 'wm-not-draining', counts: { control: 1, legacy: 1 } });
  });
  it('list: compact rows (no per-turn audit), newest first, cursor pagination, canonical filters', async () => {
    const store = transcripts.createMemoryStore(); api.setTranscriptStore(store);
    for (let i = 0; i < 3; i++) {
      const rec = transcripts.emptyRecord(`s-page-session-${i}`, new Date(Date.UTC(2026, 9, 1, 10, i)));
      rec.turns = [{ seq: 1, customer: { text: `t${i}` }, customerVisible: { reply: 'r' } }]; rec.turnCount = 1;
      await store.put(rec);
    }
    await seedMixed(store);
    const p1 = await call('GET', '/api/admin/transcripts', { qs: { limit: '2' } });
    expect(p1.json.items.map((r) => r.sessionId)).toEqual([SID, 's-page-session-2']);
    expect(p1.raw).not.toMatch(/stateDelta|"diagnostics"|nextAction|"turns"/);
    expect(p1.json.items[0]).toMatchObject({ canonical: { path: 'mixed', journey: 'wm-not-draining' }, partRecommended: false });
    const p2 = await call('GET', '/api/admin/transcripts', { qs: { limit: '2', cursor: p1.json.nextCursor } });
    expect(p2.json.items.map((r) => r.sessionId)).toEqual(['s-page-session-1', 's-page-session-0']);
    const f = await call('GET', '/api/admin/transcripts', { qs: { journey: 'wm-not-draining' } });
    expect(f.json.items.map((r) => r.sessionId)).toEqual([SID]);
    const l = await call('GET', '/api/admin/transcripts', { qs: { canonical: 'legacy' } });
    expect(l.json.items).toHaveLength(3);
  });
});
