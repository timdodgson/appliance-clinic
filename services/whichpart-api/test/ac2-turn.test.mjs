/**
 * The ac2 turn at the BFF (ac2-turn.js, ac2-state.js): the only diagnose path. The engine call, state persistence with a
 * version condition, the projection to the customer view, and explicit failures (no fallback answer, state not
 * advanced).
 */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const T = require('../ac2-turn.js');
const S = require('../ac2-state.js');
const { toWhichPartView } = require('../index.js');

const SECRETS = { current: 'x'.repeat(48), previous: null };

function memStore() {
  const items = new Map();
  return {
    items,
    async load(csid) { const it = items.get(csid); return it ? { status: 'ok', state: it.state, version: it.state.turn } : { status: 'missing', state: null, version: 0 }; },
    async save(csid, state, expected) {
      const cur = items.get(csid);
      if ((cur ? cur.state.turn : 0) !== expected) return { ok: false, reason: 'conflict' };
      items.set(csid, { state }); return { ok: true };
    },
  };
}
function engineReturning(response, stateTurn = 1) {
  const calls = [];
  return { calls, fn: async (raw) => { calls.push(JSON.parse(raw)); return { status: 200, json: { type: 'ac2', response, state: { schema: 'ac2/1', turn: (calls[calls.length - 1].ac2.state ? calls[calls.length - 1].ac2.state.turn : 0) + stateTurn, facts: [] }, audit: { turn: 1, safety: { hazards: [], gates: [] }, claims: { rejected: [], checked: 0 } } } }; } };
}
const deps = (engine, store) => ({ callEngine: engine.fn, secretsLoader: async () => SECRETS, store });

describe('turn', () => {
  it('sends the signed turn with the prior ledger, persists the new one and keeps the session token', async () => {
    const store = memStore();
    const engine = engineReturning({ outcome: 'ANSWER', message: 'Is there water left in the drum?' });
    const first = await T.handle({ body: {}, messages: [{ role: 'user', content: 'washing machine won\'t drain' }] }, deps(engine, store));
    expect(first.error).toBeUndefined();
    expect(engine.calls[0]).toMatchObject({ mode: 'turn', ac2: { state: null } });
    const second = await T.handle({ body: { stateToken: first.token }, messages: [{ role: 'user', content: 'yes' }] }, deps(engine, store));
    expect(second.token).toBe(first.token);
    expect(engine.calls[1].ac2.state).toMatchObject({ schema: 'ac2/1', turn: 1 });
    expect([...store.items.values()][0].state.turn).toBe(2);
  });

  it('projects safety, parts and the model request into the customer view', () => {
    const orch = T.orchShape({ outcome: 'ANSWER', message: 'Stop using it.', safety: { class: 'burning', stopUse: true, message: 'x' }, parts: [{ partNo: 'P1', title: 'Pump', price: 12.5 }], resolvedModel: 'M1', modelRequired: false });
    const view = toWhichPartView(orch, 'rid', null);
    expect(view.safety).toBe(true);
    expect(view.parts).toEqual([]); // parts are never shown on a safety stop
    const ok = toWhichPartView(T.orchShape({ outcome: 'ANSWER', message: 'The drain pump.', parts: [{ partNo: 'P1', title: 'Drain Pump', price: 12.5 }], resolvedModel: 'M1' }), 'rid', null);
    expect(ok.parts[0]).toMatchObject({ name: 'Drain Pump', fitStatus: 'MODEL_CONFIRMED' });
    expect(toWhichPartView(T.orchShape({ outcome: 'ANSWER', message: 'Need the model.', modelRequired: true }), 'rid', null).needsModel).toBe(true);
  });

  it('an engine failure is an explicit error and does not advance the state', async () => {
    const store = memStore();
    const fail = { fn: async () => ({ status: 503, json: { errorCode: 'reasoner_unavailable' } }) };
    const r = await T.handle({ body: {}, messages: [{ role: 'user', content: 'hob not working' }] }, deps(fail, store));
    expect(r.error).toBe('reasoner_unavailable');
    expect(store.items.size).toBe(0);
    const thrown = { fn: async () => { throw new Error('timeout'); } };
    expect((await T.handle({ body: {}, messages: [{ role: 'user', content: 'x' }] }, deps(thrown, store))).error).toBe('engine_unreachable');
  });

  it('a concurrent turn that lost the version race is an error, not a second write', async () => {
    const store = memStore();
    const engine = engineReturning({ outcome: 'ANSWER', message: 'ok' }, 2); // returns a state two turns ahead of the prior
    const r = await T.handle({ body: {}, messages: [{ role: 'user', content: 'x' }] }, deps(engine, store));
    expect(r.error).toBeUndefined();
    const store2 = memStore();
    store2.save = async () => ({ ok: false, reason: 'conflict' });
    expect((await T.handle({ body: {}, messages: [{ role: 'user', content: 'x' }] }, deps(engine, store2))).error).toBe('state_save_conflict');
  });

  it('no session secret: explicit error', async () => {
    const r = await T.handle({ body: {}, messages: [] }, { callEngine: async () => ({}), secretsLoader: async () => null, store: memStore() });
    expect(r.error).toBe('state_secret_unavailable');
  });
});

describe('session continuity (the Live Test status)', () => {
  const L = require('../live-test.js');
  it('reports a new session, then a continued one, never the token', async () => {
    const store = memStore();
    const engine = engineReturning({ outcome: 'ANSWER', message: 'Is there water left in the drum?' });
    const first = await T.handle({ body: {}, messages: [{ role: 'user', content: 'x' }] }, deps(engine, store));
    expect(first.session).toEqual({ fresh: true, rejected: null });
    const s1 = L.status({ stateIn: 'absent', result: first });
    expect(s1).toMatchObject({ schema: 'live-test/2', engine: 'ac2', ok: true, stateIn: 'absent', stateOut: 'issued', continuity: 'new', reason: null });
    const second = await T.handle({ body: { stateToken: first.token }, messages: [{ role: 'user', content: 'yes' }] }, deps(engine, store));
    const s2 = L.status({ stateIn: 'present', result: second });
    expect(s2).toMatchObject({ stateOut: 'refreshed', continuity: 'continued' });
    expect(JSON.stringify([s1, s2])).not.toContain(first.token);
  });
  it('a rejected token restarts the session and says why; a failed turn is reported as failed', async () => {
    const store = memStore();
    const engine = engineReturning({ outcome: 'ANSWER', message: 'ok' });
    const r = await T.handle({ body: { stateToken: 'cst1.cs_' + 'a'.repeat(32) + '.9999999999.' + 'b'.repeat(43) }, messages: [{ role: 'user', content: 'x' }] }, deps(engine, store));
    expect(L.status({ stateIn: 'present', result: r })).toMatchObject({ continuity: 'restarted', reason: 'bad_signature', stateOut: 'issued' });
    const fail = { fn: async () => ({ status: 503, json: { errorCode: 'reasoner_unavailable' } }) };
    const f = await T.handle({ body: {}, messages: [{ role: 'user', content: 'x' }] }, deps(fail, store));
    expect(L.status({ stateIn: 'absent', result: f })).toMatchObject({ ok: false, continuity: 'failed', reason: 'reasoner_unavailable' });
    expect(L.status({ stateIn: 'absent', result: { error: 'state_secret_unavailable' } })).toMatchObject({ continuity: 'unavailable', stateOut: 'none' });
  });
  it('a live test request carries only its conversation id', () => {
    const body = { messages: [], liveTest: { sessionId: 'lt-abcdef0123456789', clientTurnId: 'ignored' } };
    expect(L.takeLiveTest(body)).toEqual({ ok: true, sessionId: 'lt-abcdef0123456789' });
    expect(body.liveTest).toBeUndefined();
    expect(L.takeLiveTest({ liveTest: { sessionId: 'nope' } })).toMatchObject({ ok: false });
  });
});

describe('ac2-state', () => {
  it('rejects a tampered stored ledger', async () => {
    const items = {};
    const call = async (action, p) => {
      if (action === 'PutItem') { items[p.Item.pk.S] = p.Item; return {}; }
      if (action === 'GetItem') { const it = items[p.Key.pk.S]; return it ? { Item: { ...it, stateJson: { S: it.stateJson.S.replace('"turn":1', '"turn":1,"x":1') } } } : {}; }
      return {};
    };
    const store = S.createStore({ call, table: 't' });
    expect((await store.save('cs_x', { schema: 'ac2/1', turn: 1 }, 0)).ok).toBe(true);
    expect((await store.load('cs_x')).status).toBe('malformed');
  });
});
