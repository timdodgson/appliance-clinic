/**
 * Stage C: BFF-owned durable cs/1 state — store, turn record, one-step replay, per-turn protocol.
 * In-memory DynamoDB double that enforces the real condition expressions. No AWS, no network.
 */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const cs = require('../conversation-state.js');
const tok = require('../state-token.js');
const cs1 = require('../../part-finder/canonical/cs1.js');
const { merge } = require('../../part-finder/canonical/merge.js');
const { SECRETS, mockDdb, intentFor, partFinderUnderstand } = require('./canonical-test-helpers.cjs');

const NOW_MS = 1_800_000_000_000;
const SHADOW = { CANONICAL_MODE: 'shadow' };
const bytes24 = (b) => () => Buffer.alloc(24, b);
const CSID = tok.newCanonicalSessionId(bytes24(1));
const tokenFor = (csid, nowSec = NOW_MS / 1000) => tok.issueToken(csid, SECRETS, { nowSec });

function setup() {
  const db = mockDdb();
  const store = cs.createStateStore({ table: 'whichpart-transcripts', call: db.call, env: {} });
  return { db, store };
}
/** One full shadow turn: prepare → "orchestrator" (real part-finder merge) → finish. */
async function turn({ store, token, intent, newId = bytes24(1), env = SHADOW, out } = {}) {
  const ctx = await cs.prepareTurn({ body: token ? { stateToken: token } : {}, store, secrets: SECRETS, env, nowMs: NOW_MS, newId });
  const result = ctx.block ? (out !== undefined ? out(ctx) : partFinderUnderstand(ctx.block, intent)) : undefined;
  const fin = await cs.finishTurn(ctx, result, { store, messageId: 'rid-1', nowMs: NOW_MS });
  return { ctx, result, fin };
}

describe('mode', () => {
  it('off by default; control is demoted to shadow; garbage → off', () => {
    expect(cs.resolveMode({})).toMatchObject({ mode: 'off' });
    expect(cs.resolveMode({ CANONICAL_MODE: 'shadow' })).toMatchObject({ mode: 'shadow', demoted: false });
    expect(cs.resolveMode({ CANONICAL_MODE: 'control' })).toMatchObject({ mode: 'shadow', demoted: true });
    expect(cs.resolveMode({ CANONICAL_MODE: 'yes' })).toMatchObject({ mode: 'off', invalid: true });
  });
  it('off does no work: no store calls, no token, no block', async () => {
    const { db, store } = setup();
    const ctx = await cs.prepareTurn({ body: { stateToken: tokenFor(CSID) }, store, secrets: SECRETS, env: {}, nowMs: NOW_MS });
    expect(ctx).toMatchObject({ mode: 'off', block: null, token: null, degraded: null });
    expect(db.calls).toEqual([]);
  });
});

describe('state store: keys, item shape, conditional writes', () => {
  it('STATE#<csid> item shape; no gsiPk; TTL; version mirrored as stateVersion', async () => {
    const { db, store } = setup();
    const s = { ...cs1.emptyState(CSID), version: 1 };
    expect(await store.putState(CSID, s, 0, NOW_MS)).toMatchObject({ ok: true });
    const it = db.items.get('STATE#' + CSID);
    expect(Object.keys(it).sort()).toEqual(['expiresAt', 'pk', 'schemaVersion', 'sessionId', 'stateBytes', 'stateDigest',
      'stateJson', 'stateVersion', 'updatedAt'].sort());
    expect(it.gsiPk).toBeUndefined();
    expect(it).toMatchObject({ schemaVersion: { S: 'cs/1' }, sessionId: { S: CSID }, stateVersion: { N: '1' } });
    expect(Number(it.expiresAt.N)).toBe(NOW_MS / 1000 + 90 * 86400);
    expect(it.stateDigest.S).toBe(cs.digest(s));
  });
  it('expected 0 = create-only; expected N = only if stored stateVersion == N (no overwrite on conflict)', async () => {
    const { db, store } = setup();
    const s1 = { ...cs1.emptyState(CSID), version: 1 };
    const s2 = { ...cs1.emptyState(CSID), version: 2 };
    await store.putState(CSID, s1, 0);
    expect(await store.putState(CSID, s1, 0)).toMatchObject({ ok: false, reason: 'conflict' });
    expect(await store.putState(CSID, s2, 5)).toMatchObject({ ok: false, reason: 'conflict' });
    expect(db.items.get('STATE#' + CSID).stateVersion.N).toBe('1');
    expect(await store.putState(CSID, s2, 1)).toMatchObject({ ok: true });
    expect(db.calls.filter((c) => c.action === 'PutItem').map((c) => c.cond))
      .toEqual(['attribute_not_exists(pk)', 'attribute_not_exists(pk)', 'stateVersion = :v', 'stateVersion = :v']);
  });
  it('64 KB cap: oversize state is never written', async () => {
    const { db, store } = setup();
    const big = { ...cs1.emptyState(CSID), version: 1, inferred: { pad: 'x'.repeat(cs.MAX_STATE_BYTES) } };
    expect(await store.putState(CSID, big, 0)).toMatchObject({ ok: false, reason: 'overflow' });
    expect(db.items.size).toBe(0);
  });
  it('load: missing / ok / malformed / schema mismatch / digest mismatch / read error', async () => {
    const { db, store } = setup();
    expect(await store.loadState(CSID)).toEqual({ status: 'missing', version: 0, state: null });
    const s = { ...cs1.emptyState(CSID), version: 1 };
    await store.putState(CSID, s, 0);
    expect(await store.loadState(CSID)).toEqual({ status: 'ok', version: 1, state: s });
    const item = db.items.get('STATE#' + CSID);
    db.items.set('STATE#' + CSID, { ...item, stateJson: { S: '{nope' } });
    expect((await store.loadState(CSID)).status).toBe('malformed');
    db.items.set('STATE#' + CSID, { ...item, stateVersion: { N: '7' } });
    expect(await store.loadState(CSID)).toMatchObject({ status: 'malformed', reason: 'state_shape' });
    db.items.set('STATE#' + CSID, { ...item, stateJson: { S: JSON.stringify({ ...s, sessionId: 'cs_other' }) } });
    expect(await store.loadState(CSID)).toMatchObject({ status: 'malformed', reason: 'state_shape' });
    db.items.set('STATE#' + CSID, { ...item, stateJson: { S: JSON.stringify({ ...s, resolution: 'resolved' }) } });
    expect(await store.loadState(CSID)).toMatchObject({ status: 'malformed', reason: 'digest' });
    db.items.set('STATE#' + CSID, { ...item, schemaVersion: { S: 'cs/0' } });
    expect((await store.loadState(CSID)).status).toBe('schema_mismatch');
    db.faults.push({ action: 'GetItem', match: () => true, error: new Error('throttled') });
    expect((await store.loadState(CSID)).status).toBe('error');
  });
});

describe('turn record (STATETURN#<csid>#<version>)', () => {
  const rec = (v, extra = {}) => ({ sessionId: CSID, priorVersion: v - 1, version: v, messageId: 'rid', mode: 'shadow',
    classification: { schema: 'mc/1' }, priorDigest: 'a', stateDigest: 'b', rulesFired: ['M1'], ...extra });
  it('shape + key; immutable (second write → exists); no gsiPk', async () => {
    const { db, store } = setup();
    expect(await store.putTurnRecord(rec(1), NOW_MS)).toEqual({ ok: true });
    const it = db.items.get(`STATETURN#${CSID}#1`);
    expect(Object.keys(it).sort()).toEqual(['classificationJson', 'createdAt', 'expiresAt', 'messageId', 'mode', 'pk',
      'priorDigest', 'priorVersion', 'rulesFired', 'schemaVersion', 'sessionId', 'stateDigest', 'version'].sort());
    expect(it.gsiPk).toBeUndefined();
    expect(await store.putTurnRecord(rec(1, { stateDigest: 'c' }))).toMatchObject({ ok: false, reason: 'exists' });
    expect(db.items.get(`STATETURN#${CSID}#1`).stateDigest.S).toBe('b');
  });
  it('round-trips; malformed records are reported, never used', async () => {
    const { db, store } = setup();
    await store.putTurnRecord(rec(2));
    expect((await store.getTurnRecord(CSID, 2)).record).toMatchObject({ version: 2, priorVersion: 1, classification: { schema: 'mc/1' } });
    expect((await store.getTurnRecord(CSID, 3)).status).toBe('missing');
    const k = `STATETURN#${CSID}#2`;
    db.items.set(k, { ...db.items.get(k), priorVersion: { N: '0' } });
    expect((await store.getTurnRecord(CSID, 2)).status).toBe('malformed');
  });
  it('classification > 16 KB is not recorded', async () => {
    const { store } = setup();
    expect(await store.putTurnRecord(rec(1, { classification: { pad: 'x'.repeat(17 * 1024) } }))).toMatchObject({ ok: false, reason: 'overflow' });
  });
});

describe('per-turn protocol (prepare → orchestrator → finish)', () => {
  it('no token → new server-minted csid, version 0, block sent with null state, nothing loaded', async () => {
    const { db, store } = setup();
    const { ctx, fin } = await turn({ store });
    expect(ctx.csid).toBe(CSID);
    expect(ctx.block).toEqual({ schema: 'cs/1', mode: 'shadow', sessionId: CSID, version: 0, state: null, degraded: null });
    expect(tok.verifyToken(ctx.token, SECRETS, { nowSec: NOW_MS / 1000 }).csid).toBe(CSID);
    expect(db.calls.filter((c) => c.action === 'GetItem')).toEqual([]);
    expect(fin).toMatchObject({ written: true, recordWritten: true, degraded: null });
  });
  it('ordering: turn record is written BEFORE the conditional state write', async () => {
    const { db, store } = setup();
    await turn({ store });
    const puts = db.calls.filter((c) => c.action === 'PutItem').map((c) => c.pk);
    expect(puts).toEqual([`STATETURN#${CSID}#1`, `STATE#${CSID}`]);
  });
  it('continuity: version counts merged customer messages; state carries across turns', async () => {
    const { db, store } = setup();
    const t1 = await turn({ store });
    const t2 = await turn({ store, token: t1.ctx.token, intent: intentFor({ evStandingWater: noulV(0.95) }) });
    expect(t2.ctx.version).toBe(1);
    expect(t2.ctx.block.state).toEqual(t1.result.state);
    expect(t2.result.version).toBe(2);
    const t3 = await turn({ store, token: t2.ctx.token });
    expect(t3.ctx.version).toBe(2);
    const loaded = await store.loadState(CSID);
    expect(loaded.version).toBe(3);
    expect(loaded.state.version).toBe(3);
    expect(db.items.get('STATE#' + CSID).stateVersion.N).toBe('3');
    for (const v of [1, 2, 3]) expect(db.items.has(`STATETURN#${CSID}#${v}`)).toBe(true);
    expect(loaded.state.identity.appliance.value).toBe('washing-machine');
  });
  it('invalid / forged / expired token → degraded token_<reason>, no read, no block, fresh token for next turn', async () => {
    for (const [token, reason] of [
      ['garbage', 'token_malformed'],
      [tokenFor(CSID).replace(/.$/, (c) => (c === 'A' ? 'B' : 'A')), 'token_bad_signature'],
      [tok.issueToken(CSID, SECRETS, { nowSec: NOW_MS / 1000 - tok.DEFAULT_TTL_SECONDS - 5 }), 'token_expired'],
    ]) {
      const { db, store } = setup();
      const { ctx, fin } = await turn({ store, token, newId: bytes24(2) });
      expect(ctx.degraded).toBe(reason);
      expect(ctx.block).toBeNull();
      expect(db.calls).toEqual([]);
      expect(tok.verifyToken(ctx.token, SECRETS, { nowSec: NOW_MS / 1000 }).csid).toBe(tok.newCanonicalSessionId(bytes24(2)));
      expect(fin).toMatchObject({ written: false, degraded: reason });
    }
  });
  it('no signing secret → canonical disabled (no_signing_secret), no token', async () => {
    const { db, store } = setup();
    const ctx = await cs.prepareTurn({ body: {}, store, secrets: null, env: SHADOW, nowMs: NOW_MS });
    expect(ctx).toMatchObject({ degraded: 'no_signing_secret', block: null, token: null });
    expect(db.calls).toEqual([]);
  });
  it('read failure → read_failed, no block, NOTHING persisted from an assumed-empty state; token re-issued', async () => {
    const { db, store } = setup();
    const t1 = await turn({ store });
    db.faults.push({ action: 'GetItem', match: (pk) => pk.startsWith('STATE#'), error: new Error('throttled'), once: true });
    const before = JSON.stringify([...db.items]);
    const t2 = await turn({ store, token: t1.ctx.token });
    expect(t2.ctx).toMatchObject({ degraded: 'read_failed', block: null });
    expect(t2.ctx.token).toBeTruthy();
    expect(JSON.stringify([...db.items])).toBe(before);
  });
  it('malformed stored state → state_malformed, no block, no write', async () => {
    const { db, store } = setup();
    const t1 = await turn({ store });
    const k = 'STATE#' + CSID;
    db.items.set(k, { ...db.items.get(k), stateJson: { S: '{' } });
    const t2 = await turn({ store, token: t1.ctx.token });
    expect(t2.ctx).toMatchObject({ degraded: 'state_malformed', block: null });
  });
  it('conflict: concurrent turn already owns the version → no overwrite, degraded conflict', async () => {
    const { db, store } = setup();
    const t1 = await turn({ store });
    // Two turns prepared against version 1 concurrently.
    const a = await cs.prepareTurn({ body: { stateToken: t1.ctx.token }, store, secrets: SECRETS, env: SHADOW, nowMs: NOW_MS });
    const b = await cs.prepareTurn({ body: { stateToken: t1.ctx.token }, store, secrets: SECRETS, env: SHADOW, nowMs: NOW_MS });
    const fa = await cs.finishTurn(a, partFinderUnderstand(a.block), { store, messageId: 'a', nowMs: NOW_MS });
    const winner = db.items.get('STATE#' + CSID).stateDigest.S;
    const fb = await cs.finishTurn(b, partFinderUnderstand(b.block, intentFor({ applianceFamily: { type: 'choice', choice: 'dishwasher', confidence: 0.95, probabilities: { dishwasher: 0.95 } } })),
      { store, messageId: 'b', nowMs: NOW_MS });
    expect(fa).toMatchObject({ written: true });
    expect(fb).toMatchObject({ written: false, degraded: 'conflict' });
    expect(db.items.get('STATE#' + CSID).stateDigest.S).toBe(winner);
    expect(db.items.get(`STATETURN#${CSID}#2`).messageId.S).toBe('a');
  });
  it('state conditional failure after a fresh record → conflict (state not overwritten)', async () => {
    const { db, store } = setup();
    const t1 = await turn({ store });
    const ctx = await cs.prepareTurn({ body: { stateToken: t1.ctx.token }, store, secrets: SECRETS, env: SHADOW, nowMs: NOW_MS });
    // someone else advanced STATE without a record at v2 (simulated)
    const k = 'STATE#' + CSID;
    db.items.set(k, { ...db.items.get(k), stateVersion: { N: '9' } });
    const fin = await cs.finishTurn(ctx, partFinderUnderstand(ctx.block), { store, messageId: 'x', nowMs: NOW_MS });
    expect(fin).toMatchObject({ written: false, recordWritten: true, degraded: 'conflict' });
    expect(db.items.get(k).stateVersion.N).toBe('9');
  });
  it('turn-record write error → state still written (record is recovery aid only), degraded noted', async () => {
    const { db, store } = setup();
    db.faults.push({ action: 'PutItem', match: (pk) => pk.startsWith('STATETURN#'), error: new Error('throttled'), once: true });
    const { fin } = await turn({ store });
    expect(fin).toMatchObject({ written: true, recordWritten: false, degraded: 'turn_record_error' });
    expect((await store.loadState(CSID)).version).toBe(1);
  });
  it('invalid orchestrator output is never persisted', async () => {
    const cases = [
      [() => undefined, 'missing_output'],
      [(c) => ({ ...partFinderUnderstand(c.block), degraded: 'merge_failed' }), 'upstream_merge_failed'],
      [(c) => ({ ...partFinderUnderstand(c.block), sessionId: tok.newCanonicalSessionId(bytes24(5)) }), 'output_session_mismatch'],
      [(c) => ({ ...partFinderUnderstand(c.block), version: 5 }), 'output_version_mismatch'],
      [(c) => ({ ...partFinderUnderstand(c.block), state: { ...partFinderUnderstand(c.block).state, version: 4 } }), 'output_state_invalid'],
      [(c) => ({ ...partFinderUnderstand(c.block), classification: null }), 'output_classification_missing'],
    ];
    for (const [out, reason] of cases) {
      const { db, store } = setup();
      const { fin } = await turn({ store, out });
      expect(fin).toMatchObject({ written: false, degraded: reason });
      expect(db.calls.filter((c) => c.action === 'PutItem')).toEqual([]);
    }
  });
});

describe('one-step replay (missed state write)', () => {
  async function missedWrite() {
    const { db, store } = setup();
    const t1 = await turn({ store });
    // Turn 2: the record lands, the state write is lost (Lambda died between the two writes).
    db.faults.push({ action: 'PutItem', match: (pk) => pk.startsWith('STATE#'), error: new Error('timeout'), once: true });
    const t2 = await turn({ store, token: t1.ctx.token });
    expect(t2.fin).toMatchObject({ written: false, recordWritten: true, degraded: 'state_write_failed' });
    expect((await store.loadState(CSID)).version).toBe(1);
    return { db, store, t1, t2 };
  }
  it('record N exists and STATE is N-1 → replay the typed classification, then continue normally', async () => {
    const { db, store, t2 } = await missedWrite();
    const t3 = await turn({ store, token: t2.ctx.token });
    expect(t3.ctx.recovered).toBe(true);
    expect(t3.ctx.degraded).toBeNull();
    expect(t3.ctx.version).toBe(2);
    expect(cs.digest(t3.ctx.block.state)).toBe(cs.digest(t2.result.state)); // byte-identical to what was lost
    expect(t3.fin.written).toBe(true);
    expect((await store.loadState(CSID)).version).toBe(3);
    // recovery used ONLY STATE + STATETURN items (never transcripts)
    expect(db.calls.every((c) => c.pk.startsWith('STATE#') || c.pk.startsWith('STATETURN#'))).toBe(true);
  });
  it('recovery from a missing STATE (first-turn state write lost) starts from emptyState(csid)', async () => {
    const { db, store } = setup();
    db.faults.push({ action: 'PutItem', match: (pk) => pk.startsWith('STATE#'), error: new Error('timeout'), once: true });
    const t1 = await turn({ store });
    expect((await store.loadState(CSID)).status).toBe('missing');
    const t2 = await turn({ store, token: t1.ctx.token });
    expect(t2.ctx).toMatchObject({ recovered: true, version: 1, degraded: null });
    expect(t2.ctx.block.state).toEqual(t1.result.state);
  });
  it('one step only: a second missing state (records N and N+1 both ahead) → replay_gap, no block', async () => {
    const { store, t2 } = await missedWrite();
    // Fabricate a valid-looking record v3 so that after replaying v2 another is still ahead.
    const r2 = (await store.getTurnRecord(CSID, 2)).record;
    await store.putTurnRecord({ ...r2, priorVersion: 2, version: 3, priorDigest: r2.stateDigest, messageId: 'x' });
    const t3 = await turn({ store, token: t2.ctx.token });
    expect(t3.ctx).toMatchObject({ degraded: 'replay_gap', block: null });
  });
  it('record does not reproduce from the current state → replay_prior_mismatch, no write', async () => {
    const { db, store, t2 } = await missedWrite();
    const k = `STATETURN#${CSID}#2`;
    db.items.set(k, { ...db.items.get(k), priorDigest: { S: 'f'.repeat(64) } });
    const t3 = await turn({ store, token: t2.ctx.token });
    expect(t3.ctx).toMatchObject({ degraded: 'replay_prior_mismatch', block: null, recovered: false });
    expect((await store.loadState(CSID)).version).toBe(1);
  });
  it('replayed merge does not match the recorded result → replay_result_mismatch, no write', async () => {
    const { db, store, t2 } = await missedWrite();
    const k = `STATETURN#${CSID}#2`;
    db.items.set(k, { ...db.items.get(k), stateDigest: { S: 'e'.repeat(64) } });
    const t3 = await turn({ store, token: t2.ctx.token });
    expect(t3.ctx.degraded).toBe('replay_result_mismatch');
    expect((await store.loadState(CSID)).version).toBe(1);
  });
  it('malformed record → replay_record_malformed', async () => {
    const { db, store, t2 } = await missedWrite();
    const k = `STATETURN#${CSID}#2`;
    db.items.set(k, { ...db.items.get(k), classificationJson: { S: '{' } });
    expect((await turn({ store, token: t2.ctx.token })).ctx.degraded).toBe('replay_record_malformed');
  });
  it('replay is the same pure merge part-finder ran (deterministic)', () => {
    const block = { schema: 'cs/1', mode: 'shadow', sessionId: CSID, version: 0, state: null, degraded: null };
    const out = partFinderUnderstand(block);
    const again = merge(cs1.emptyState(CSID), out.classification, { turn: 1 }).state;
    expect(cs.digest(again)).toBe(cs.digest(out.state));
    const r = cs.recoverOneStep({ csid: CSID, version: 0, state: null, mergeMod: { merge }, cs1,
      record: { priorVersion: 0, version: 1, priorDigest: cs.digest(cs1.emptyState(CSID)), stateDigest: cs.digest(out.state), classification: out.classification } });
    expect(r).toEqual({ ok: true, state: out.state });
  });
});

function noulV(v) { return { type: 'noul', noul: v }; }
