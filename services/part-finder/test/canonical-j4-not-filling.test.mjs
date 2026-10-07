/**
 * Journey 4 (wm-not-filling): B diagnostics, C policy (sequences through the real merge), D part gate,
 * E COMPOSE contract, routing / gate. Expectations from wm-batch-2-evidence.md §1.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
globalThis.awslambda = globalThis.awslambda || { streamifyResponse: (f) => f, HttpResponseStream: { from: (s) => s } };
const H = require('./helpers/b2-journey.cjs');
const J = require('../canonical/j4-pipeline.js');
const P = require('../canonical/j4-policy.js');
const JC = require('../canonical/j4-compose.js');
const L = require('../part-finder-lambda.js')._internal;
const { C, O, K } = H;

const op = (obs = [], extra = {}) => H.opener('not-filling', 'water', obs, extra);
const MP = [{ title: 'Fill Valve' }, { title: 'Door Lock' }, { title: 'Inlet Hose 1.5m' }, { title: 'Door Seal' }];
const none = op([O('waterEntering', false)]);
const SEQ = {
  allClear: [none, C({ observations: [O('supplyOk')] }), C({ observations: [O('doorLocks')] }), C({ checks: [K('inlet-hose-tap', 'done', 'clear')] }),
    C({ checks: [K('inlet-filter', 'done', 'clear')] }), H.model()],
  supplyOff: [none, C({ observations: [O('supplyOk', false)] })],
  slowMesh: [op([O('fillsSlowly')]), C({ observations: [O('supplyOk')] }), C({ checks: [K('inlet-hose-tap', 'done', 'clear')] }),
    C({ checks: [K('inlet-filter', 'done', 'found_and_cleared')] }), C({ observations: [O('faultPersists', false)] }), C({ reply: { toPending: 'answered', outcome: 'resolved' } })],
  doorNoLock: [op([O('waterEntering', false), O('supplyOk')]), C({ observations: [O('doorLocks', false)] }), C({ observations: [O('doorLocks', false)], reply: { toPending: 'answered' } }), H.model()],
  oneProgramme: [op([], { scope: 'one_programme' }), H.model()],
  kinked: [op([O('waterEntering', false), O('supplyOk')]), C({ observations: [O('doorLocks')] }), C({ checks: [K('inlet-hose-tap', 'done', 'found_and_cleared')] }), C({ observations: [O('faultPersists', false)] })],
  hoseSplit: [op([O('waterEntering', false), O('supplyOk'), O('doorLocks')]), C({ checks: [K('inlet-hose-tap', 'done', 'fault_seen')] }), H.model()],
  cannot: [none, C({ reply: { toPending: 'cannot_answer' } }), C({ reply: { toPending: 'cannot_answer' } }), C({ reply: { toPending: 'cannot_answer' } }), C({ reply: { toPending: 'cannot_answer' } })],
  ignoredTwice: [none, C({ reply: { toPending: 'ignored' } }), C({ reply: { toPending: 'ignored' } }), C({ reply: { toPending: 'ignored' } }), C({ reply: { toPending: 'ignored' } }), C({ reply: { toPending: 'ignored' } }), C({ reply: { toPending: 'ignored' } }), C({ reply: { toPending: 'ignored' } }), C({ reply: { toPending: 'ignored' } })],
  oneProgNoModel: [op([], { scope: 'one_programme' }), H.noModel()],
  makeOnly: [op([], { scope: 'one_programme' }), C({ identity: { make: { value: 'hotpoint', basis: 'stated' } } })],
};
const run = (k) => H.play(J, SEQ[k], { modelParts: MP });

describe('B. diagnostics', () => {
  it('all external checks clear, no water at all: inlet valve only POSSIBLE (pressure / control alternative), never a component', () => {
    const d = run('allClear').prep.diag;
    expect(d.leader).toMatchObject({ family: 'inlet-valve', committed: false, level: 'cause_family' });
    expect(d.partEvidence.sufficient).toBe(false);
  });
  it('only some programmes fill: inlet valve committed at component level (decisive)', () => {
    expect(run('oneProgramme').prep.diag.leader).toMatchObject({ family: 'inlet-valve', committed: true, component: 'inlet-valve' });
  });
  it('door closed firmly and still not locking: door interlock component', () => {
    expect(run('doorNoLock').prep.diag.leader).toMatchObject({ family: 'door-interlock', committed: true, component: 'door-lock' });
  });
  it('kinked hose fixed and fills: likely resolved; slow + mesh cleaned + fills: likely resolved', () => {
    expect(run('kinked').prep.diag).toMatchObject({ likelyResolved: true, leader: { family: 'tap-or-fill-hose' } });
    expect(H.play(J, SEQ.slowMesh.slice(0, 5)).prep.diag).toMatchObject({ likelyResolved: true, leader: { family: 'inlet-mesh-filter' } });
  });
  it('no evidence → no leader; a damaged fill hose commits tap-or-fill-hose at component level', () => {
    expect(H.play(J, [op()]).prep.diag.leader).toBe(null);
    expect(run('hoseSplit').prep.diag.leader).toMatchObject({ family: 'tap-or-fill-hose', component: 'inlet-hose' });
  });
});

describe('C. policy', () => {
  it('no water: supply → door lock → tap/hose → mesh → possible valve conclusion (no part, no model ask)', () => {
    const r = run('allClear');
    expect(r.rules).toEqual(['F11:supplyOk', 'F12:doorLocks', 'F14:inlet-hose-tap', 'F15:inlet-filter', 'F22:inlet-valve', 'F22:inlet-valve']);
    expect(r.last.conclusion).toMatchObject({ confidence: 'possible', handoff: 'engineer', noPart: true });
  });
  it('household supply off → plumbing conclusion, no part', () => {
    const r = run('supplyOff');
    expect(r.rules).toEqual(['F11:supplyOk', 'F5:household-supply']);
    expect(r.last.conclusion).toMatchObject({ handoff: 'plumbing', noPart: true });
  });
  it('slow fill → mesh cleaned → retest → likely fixed + CONFIRM → close', () => {
    const r = run('slowMesh');
    expect(r.rules).toEqual(['F11:supplyOk', 'F14:inlet-hose-tap', 'F15:inlet-filter', 'F6:retest', 'F7:inlet-mesh-filter', 'F2:inlet-mesh-filter']);
    expect(r.actions[4].action.pending).toMatchObject({ purpose: 'CONFIRM' });
  });
  it('door not locking → close firmly → model → door lock part', () => {
    expect(run('doorNoLock').rules).toEqual(['F12:doorLocks', 'F13:door-closed-latched', 'F20:model', 'F21:door-lock']);
  });
  it('kinked hose fixed → retest → likely fixed (no part)', () => { expect(run('kinked').rules).toEqual(['F12:doorLocks', 'F14:inlet-hose-tap', 'F6:retest', 'F7:tap-or-fill-hose']); });
  it('cannot answer anything → progresses, ends in a conclusion (no loop)', () => {
    const r = run('cannot');
    expect(r.rules.slice(-1)[0]).toMatch(/^F22:/);
  });
  it('ignored repeatedly: no target asked more than twice; ends in a conclusion', () => {
    const r = run('ignoredTwice');
    const n = {}; for (const q of r.state.requests) n[q.target] = (n[q.target] || 0) + 1;
    for (const v of Object.values(n)) expect(v).toBeLessThanOrEqual(2);
    expect(r.rules.slice(-1)[0]).toMatch(/^F22:/);
  });
});

describe('D. part gate', () => {
  it('only-some-programmes + model + valve listed → inlet valve; model unavailable → conclude, no part; make only → no part', () => {
    expect(run('oneProgramme').rules).toEqual(['F20:model', 'F21:inlet-valve']);
    const u = run('oneProgNoModel');
    expect(u.last).toMatchObject({ kind: 'conclude', rule: 'F22' });
    const m = run('makeOnly');
    expect(m.last.kind).not.toBe('recommend_part');
    expect(P.partGate(m.state, m.prep.diag, { available: true, component: 'inlet-valve' }).failed).toContain('K1-model-not-known');
  });
  it('model has no valve listed → no part (K5)', () => {
    const r = H.play(J, SEQ.oneProgramme, { modelParts: [{ title: 'Door Seal' }] });
    expect(r.last.kind).not.toBe('recommend_part');
    expect(r.last.conclusion).toMatchObject({ level: 'component', component: 'inlet-valve' });
  });
  it('all-clear no-water never reaches a valve part even with a valve listed', () => { expect(run('allClear').last.kind).toBe('conclude'); });
  it('part matchers: fill valve / inlet hose / door lock, never drain hose or door seal', () => {
    const pick = (titles, c) => J.partLookupFrom(titles.map((title) => ({ title })), c).parts.map((p) => p.title);
    expect(pick(['Fill Valve', 'Drain Hose', 'Solenoid Cold 2 Way'], 'inlet-valve')).toEqual(['Fill Valve', 'Solenoid Cold 2 Way']);
    expect(pick(['Drain Hose', 'Inlet Hose 1.5m'], 'inlet-hose')).toEqual(['Inlet Hose 1.5m']);
    expect(pick(['Door Seal', 'Door Lock', 'Door Interlock'], 'door-lock')).toEqual(['Door Lock', 'Door Interlock']);
  });
});

describe('E. COMPOSE contract', () => {
  it('every action reached in the fixtures obeys the contract', () => {
    const seen = Object.keys(SEQ).flatMap((k) => run(k).actions);
    expect(H.composeProblems(JC, P, seen)).toEqual([]);
  });
  it('inlet-filter step carries isolation, tap off, towels and rinse-only safety', () => {
    const a = run('allClear').actions[3].action;
    expect(a.requires).toEqual(['isolate_mains', 'water_off_at_tap', 'contain_water', 'mesh_rinse_only']);
  });
});

afterEach(() => { delete process.env.CANONICAL_J4_CONTROL; });
describe('routing / gate', () => {
  const { emptyState } = require('../canonical/cs1.js'); const { merge } = require('../canonical/merge.js');
  const T = (cs) => { let s = emptyState('cs_' + 'd'.repeat(32)); for (const c of cs) s = merge(s, c, { turn: s.version + 1 }).state; return { schema: 'cs/1', mode: 'control', sessionId: s.sessionId, priorVersion: s.version - 1, version: s.version, state: s, classification: cs[cs.length - 1], rulesFired: [], requestOutcome: null, degraded: null }; };
  const B = (journeys) => ({ schema: 'cs/1', mode: 'control', control: { journeys }, sessionId: 'x', version: 0, state: null, degraded: null });
  it('controls only with its own gate key; kill switch forces shadow; J1–J3 keys unaffected', async () => {
    const on = await L.canonicalJourneys(T([none]), B(['wm-not-draining', 'wm-not-filling']));
    expect(on.journey).toMatchObject({ key: 'wm-not-filling', control: true });
    expect(on.issuedRequest).toMatchObject({ target: 'supplyOk', journey: 'wm-not-filling' });
    const off = await L.canonicalJourneys(T([none]), B(['wm-not-draining', 'wm-not-spinning', 'wm-leaking']));
    expect(off.journey).toMatchObject({ key: 'wm-not-filling', control: false });
    expect(L.canonicalControls(off)).toBe(false);
    process.env.CANONICAL_J4_CONTROL = '0';
    expect((await L.canonicalJourneys(T([none]), B(['wm-not-filling']))).journey.control).toBe(false);
  });
});
