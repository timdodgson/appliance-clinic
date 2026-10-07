/**
 * Journey 1 control prerequisites in the BFF: the narrow control gate (resolveMode), clientTurnId
 * idempotency (STATECLIENT marker + turn-record detection) and replay of the issued policy request.
 * In-memory DynamoDB double enforcing the real condition expressions. No AWS, no network.
 */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const cs = require('../conversation-state.js');
const tok = require('../state-token.js');
const { SECRETS, mockDdb, intentFor, partFinderUnderstand, internal } = require('./canonical-test-helpers.cjs');

const NOW_MS = 1_800_000_000_000;
const CONTROL = { CANONICAL_MODE: 'control', CANONICAL_CONTROL_JOURNEYS: 'wm-not-draining' };
const SHADOW = { CANONICAL_MODE: 'shadow' };
const bytes24 = (b) => () => Buffer.alloc(24, b);
const CSID = tok.newCanonicalSessionId(bytes24(1));
const CSID2 = tok.newCanonicalSessionId(bytes24(2));
const tokenFor = (csid) => tok.issueToken(csid, SECRETS, { nowSec: NOW_MS / 1000 });
const VIEW = { reply: 'Switch it off and unplug it first. What did you find in the filter?', parts: [], rid: 'r1', stateToken: 'old' };

function setup() {
  const db = mockDdb();
  const store = cs.createStateStore({ table: 'whichpart-transcripts', call: db.call, env: {} });
  return { db, store };
}
/** What part-finder understand returns: merge + Journey 1 pipeline (real code). */
async function partFinder(block, intent = intentFor()) {
  return internal.canonicalJourneys(partFinderUnderstand(block, intent), block);
}
const prepare = (store, { csid = CSID, ctid, env = CONTROL } = {}) => cs.prepareTurn({
  body: { stateToken: tokenFor(csid) }, store, secrets: SECRETS, env, nowMs: NOW_MS, newId: bytes24(9), clientTurnId: ctid,
});
async function fullTurn(store, opts = {}) {
  const ctx = await prepare(store, opts);
  if (!ctx.block) return { ctx, fin: null };
  const out = opts.out ? opts.out(ctx) : await partFinder(ctx.block);
  const fin = await cs.finishTurn(ctx, out, { store, messageId: 'rid', nowMs: NOW_MS });
  if (opts.marker !== false) await cs.recordClientTurn(ctx, fin, VIEW, { store, nowMs: NOW_MS });
  return { ctx, out, fin };
}
const stateOf = async (store, csid = CSID) => (await store.loadState(csid)).state;

describe('control gate (resolveMode)', () => {
  it('control needs a known journey in CANONICAL_CONTROL_JOURNEYS; otherwise demoted to shadow', () => {
    expect(cs.resolveMode(CONTROL)).toMatchObject({ mode: 'control', journeys: ['wm-not-draining'], demoted: false });
    expect(cs.resolveMode({ CANONICAL_MODE: 'control' })).toMatchObject({ mode: 'shadow', demoted: true });
    expect(cs.resolveMode({ CANONICAL_MODE: 'control', CANONICAL_CONTROL_JOURNEYS: 'leaking,all' })).toMatchObject({ mode: 'shadow', demoted: true });
    expect(cs.resolveMode({ CANONICAL_MODE: 'control', CANONICAL_CONTROL_JOURNEYS: 'wm-not-draining,wm-not-spinning' })).toMatchObject({ mode: 'control', journeys: ['wm-not-draining', 'wm-not-spinning'] });
    expect(cs.resolveMode({ CANONICAL_MODE: 'control', CANONICAL_CONTROL_JOURNEYS: 'wm-not-spinning' })).toMatchObject({ mode: 'control', journeys: ['wm-not-spinning'] });
    expect(cs.resolveMode({ CANONICAL_MODE: 'control', CANONICAL_CONTROL_JOURNEYS: 'wm-not-draining+wm-not-spinning' })).toMatchObject({ mode: 'control', journeys: ['wm-not-draining', 'wm-not-spinning'] });
    expect(cs.resolveMode({ CANONICAL_MODE: 'shadow', CANONICAL_CONTROL_JOURNEYS: 'wm-not-draining' })).toMatchObject({ mode: 'shadow', journeys: [] });
  });
  it('control block carries mode + journey gate + clientTurnId; shadow block carries no gate', async () => {
    const { store } = setup();
    const c = await prepare(store, { ctid: 'turn-0001' });
    expect(c.block).toMatchObject({ mode: 'control', control: { journeys: ['wm-not-draining'] }, clientTurnId: 'turn-0001' });
    const s = await prepare(store, { ctid: 'turn-0001', env: SHADOW });
    expect(s.block.mode).toBe('shadow'); expect(s.block.control).toBeUndefined();
  });
  it('rollback by config: the same session under shadow issues no new requests', async () => {
    const { store } = setup();
    await fullTurn(store, { ctid: 'turn-0001' });
    expect((await stateOf(store)).requests).toHaveLength(1);
    await fullTurn(store, { ctid: 'turn-0002', env: SHADOW });
    const s = await stateOf(store);
    expect(s.version).toBe(2);
    expect(s.requests).toHaveLength(1); // closed by M20, nothing new issued in shadow
    expect(s.pendingRequest).toBe(null);
  });
});

describe('idempotency (clientTurnId)', () => {
  it('sequential duplicate: no merge, no version bump, cached view returned', async () => {
    const { store } = setup();
    const first = await fullTurn(store, { ctid: 'turn-0001' });
    expect(first.fin.written).toBe(true);
    const before = JSON.stringify(await stateOf(store));
    const dup = await prepare(store, { ctid: 'turn-0001' });
    expect(dup.block).toBe(null);
    expect(dup.duplicate).toMatchObject({ source: 'marker', version: 1 });
    expect(dup.duplicate.view.reply).toBe(VIEW.reply);
    expect(dup.duplicate.view.stateToken).toBeUndefined();
    expect(JSON.stringify(await stateOf(store))).toBe(before);
  });
  it('concurrent duplicate: both prepared before either finishes -> exactly one merge persists', async () => {
    const { store } = setup();
    await fullTurn(store, { ctid: 'turn-0001' });
    const a = await prepare(store, { ctid: 'turn-0002' });
    const b = await prepare(store, { ctid: 'turn-0002' });
    const [oa, ob] = [await partFinder(a.block), await partFinder(b.block)];
    const fa = await cs.finishTurn(a, oa, { store, messageId: 'a', nowMs: NOW_MS });
    const fb = await cs.finishTurn(b, ob, { store, messageId: 'b', nowMs: NOW_MS });
    expect([fa.written, fb.written].sort()).toEqual([false, true]);
    expect([fa.degraded, fb.degraded]).toContain('conflict');
    const s = await stateOf(store);
    expect(s.version).toBe(2);
    expect(s.requests.filter((r) => r.askedTurn === 2)).toHaveLength(1);
  });
  it('retry after timeout (state persisted, marker never written) -> detected via the turn record', async () => {
    const { store } = setup();
    await fullTurn(store, { ctid: 'turn-0001', marker: false });
    const dup = await prepare(store, { ctid: 'turn-0001' });
    expect(dup.block).toBe(null);
    expect(dup.duplicate).toMatchObject({ source: 'turn_record', version: 1, view: null });
    expect((await stateOf(store)).version).toBe(1);
  });
  it('retry after timeout where the state write was missed -> one-step recovery, then duplicate (no double merge)', async () => {
    const { db, store } = setup();
    await fullTurn(store, { ctid: 'turn-0001' });
    db.faults.push({ action: 'PutItem', match: (pk) => pk === 'STATE#' + CSID, once: true });
    const t2 = await fullTurn(store, { ctid: 'turn-0002' });
    expect(t2.fin.recordWritten).toBe(true);
    expect(t2.fin.written).toBe(false);
    const retry = await prepare(store, { ctid: 'turn-0002' });
    expect(retry.recovered).toBe(true);
    expect(retry.duplicate).toMatchObject({ source: 'turn_record', version: 2 });
    expect(retry.block).toBe(null);
    const s = await stateOf(store);
    expect(s.version).toBe(2);
    expect(JSON.stringify(s)).toBe(JSON.stringify(t2.out.state)); // replay = merge + issued request, digest-exact
  });
  it('same clientTurnId in a different canonical session does not collide', async () => {
    const { store } = setup();
    await fullTurn(store, { ctid: 'turn-0001' });
    const other = await prepare(store, { csid: CSID2, ctid: 'turn-0001' });
    expect(other.duplicate).toBe(null);
    expect(other.block).toBeTruthy();
  });
  it('duplicate after a degraded attempt is processed normally (no marker for a degraded turn)', async () => {
    const { db, store } = setup();
    const bad = await fullTurn(store, { ctid: 'turn-0001', out: (ctx) => ({ schema: 'cs/1', degraded: 'classification_degraded', sessionId: ctx.csid }) });
    expect(bad.fin.written).toBe(false);
    expect([...db.items.keys()].some((k) => k.startsWith('STATECLIENT#'))).toBe(false);
    const retry = await fullTurn(store, { ctid: 'turn-0001' });
    expect(retry.ctx.duplicate).toBe(null);
    expect(retry.fin.written).toBe(true);
    expect((await stateOf(store)).version).toBe(1);
  });
  it('no clientTurnId (e.g. harness) -> processed normally every time', async () => {
    const { store } = setup();
    await fullTurn(store, {});
    await fullTurn(store, {});
    expect((await stateOf(store)).version).toBe(2);
  });
  it('invalid clientTurnId is ignored, never used as a key', async () => {
    const { store } = setup();
    const c = await prepare(store, { ctid: 'x#y' });
    expect(c.clientTurnId).toBe(null);
  });
});

describe('turn record + replay of the issued request', () => {
  it('records clientTurnId, mode and issuedRequest; replay reproduces the control state exactly', async () => {
    const { db, store } = setup();
    db.faults.push({ action: 'PutItem', match: (pk) => pk === 'STATE#' + CSID, once: true });
    const t = await fullTurn(store, { ctid: 'turn-0001' });
    const rec = await store.getTurnRecord(CSID, 1);
    expect(rec.record).toMatchObject({ clientTurnId: 'turn-0001', mode: 'control' });
    expect(rec.record.issuedRequest).toMatchObject({ slot: 'CHECK', target: 'drain-filter', rule: 'R7' });
    const next = await prepare(store, { ctid: 'turn-0002' });
    expect(next.recovered).toBe(true);
    expect(JSON.stringify(next.priorState)).toBe(JSON.stringify(t.out.state));
    expect(next.priorState.pendingRequest).toBe('q1');
  });
  it('summary/trace carry the J1 decision without state body or csid', async () => {
    const { store } = setup();
    const t = await fullTurn(store, { ctid: 'turn-0001' });
    const sum = cs.summarise(t.ctx, t.out, t.fin);
    expect(sum.journey.nextAction).toMatchObject({ rule: 'R7' });
    expect(sum.issuedRequest).toMatchObject({ target: 'drain-filter' });
    expect(JSON.stringify(sum)).not.toContain(CSID);
    expect(cs.traceStage(sum).label).toContain('control');
  });
});
