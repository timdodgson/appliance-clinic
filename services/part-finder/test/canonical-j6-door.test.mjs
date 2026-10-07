/**
 * Journey 6 (wm-door): diagnostics, policy, part gate, COMPOSE contract, routing / gate, and the retained-water
 * handoff to Journey 1. Expectations from wm-batch-2-evidence.md §3.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
globalThis.awslambda = globalThis.awslambda || { streamifyResponse: (f) => f, HttpResponseStream: { from: (s) => s } };
const H = require('./helpers/b2-journey.cjs');
const J = require('../canonical/j6-pipeline.js');
const J1 = require('../canonical/j1-pipeline.js');
const P = require('../canonical/j6-policy.js');
const JC = require('../canonical/j6-compose.js');
const L = require('../part-finder-lambda.js')._internal;
const { C, O, K } = H;

const op = (obs = []) => H.opener('door-problem', 'door', obs);
const MP = [{ title: 'Door Lock' }, { title: 'Door Handle' }, { title: 'Door Seal' }];
const SEQ = {
  waitOk: [op([O('doorOpens', false)]), C({ observations: [O('waterRemaining', false)] }), C({ observations: [O('doorOpens')] })],
  stuck: [op([O('doorOpens', false)]), C({ observations: [O('waterRemaining', false)] }), C({ observations: [O('doorOpens', false)] }), C({ checks: [K('child-lock', 'done', 'clear')] }), H.model()],
  childLock: [op([O('doorOpens', false), O('waterRemaining', false)]), C({ observations: [O('doorOpens', false)] }), C({ checks: [K('child-lock', 'done', 'found_and_cleared')] }), C({ observations: [O('faultPersists', false)] })],
  water: [op([O('doorOpens', false)]), C({ observations: [O('waterRemaining')] })],
  noLock: [op([O('doorLocks', false)]), C({ observations: [O('doorLocks', false)] }), C({ checks: [K('door-catch', 'done', 'clear')] }), H.model()],
  handle: [op([O('handleBroken')]), H.model()],
  wontClose: [op([O('doorCloses', false)]), C({ checks: [K('door-catch', 'done', 'fault_seen')] }), H.model()],
  clicking: [op([O('lockClicking')]), C({ observations: [O('doorLocks', false)] }), C({ checks: [K('door-catch', 'done', 'clear')] })],
  vague: [op(), C({ reply: { toPending: 'cannot_answer' } })],
  handleNoModel: [op([O('handleBroken')]), H.noModel()],
  noLockMake: [op([O('doorLocks', false)]), C({ observations: [O('doorLocks', false)] }), C({ checks: [K('door-catch', 'done', 'clear')] }), C({ identity: { make: { value: 'beko', basis: 'stated' } } })],
};
const run = (k) => H.play(J, SEQ[k], { modelParts: MP });

describe('diagnostics', () => {
  it('opens after waiting → normal release delay; stuck with no water after wait + child lock → lock / level sensing (no component)', () => {
    expect(run('waitOk').prep.diag.facts).toContain('opensAfterWait');
    const d = run('stuck').prep.diag;
    expect(['level-sensing-or-control', 'door-lock']).toContain(d.leader.family);
    expect(d.leader.level).toBe('cause_family');
  });
  it('closed firmly and still not locking → door lock component; broken handle / catch → handle component', () => {
    expect(run('noLock').prep.diag.leader).toMatchObject({ family: 'door-lock', component: 'door-lock' });
    expect(run('handle').prep.diag.leader).toMatchObject({ family: 'handle-or-catch', component: 'door-handle' });
    expect(run('wontClose').prep.diag.leader).toMatchObject({ family: 'handle-or-catch', component: 'door-handle' });
  });
});

describe('policy', () => {
  it('won\'t open: water? → wait / power-off → opens → normal delay (no part)', () => {
    const r = run('waitOk');
    expect(r.rules).toEqual(['D11:waterRemaining', 'D12:door-release-wait', 'D5:normal-release-delay']);
    expect(r.last.conclusion).toMatchObject({ noPart: true });
  });
  it('wait step never bypasses / forces the interlock', () => {
    expect(run('waitOk').actions[1].action.requires).toEqual(['never_bypass_interlock', 'do_not_force_door']);
  });
  it('won\'t open, stuck: wait → child lock → engineer conclusion, no part (even with a model)', () => {
    const r = run('stuck');
    expect(r.rules).toEqual(['D11:waterRemaining', 'D12:door-release-wait', 'D13:child-lock', 'D22:level-sensing-or-control', 'D22:level-sensing-or-control']);
    expect(r.last.conclusion).toMatchObject({ handoff: 'engineer', noPart: true });
  });
  it('child lock was on → retest → likely fixed', () => { expect(run('childLock').rules).toEqual(['D12:door-release-wait', 'D13:child-lock', 'D6:retest', 'D7:child-lock']); });
  it('water in the drum → Journey 1 owns it (door journey does not apply; Journey 1 asks the pump filter)', () => {
    const r = run('water');
    expect(r.prep.entry).toMatchObject({ applies: false, drainOwned: true });
    expect(H.play(J1, SEQ.water).last).toMatchObject({ rule: 'R7', target: 'drain-filter' });
  });
  it('won\'t lock: close firmly → catch → model → door lock part; clicking → same path', () => {
    expect(run('noLock').rules).toEqual(['D14:door-closed-latched', 'D15:door-catch', 'D20:model', 'D21:door-lock']);
    expect(run('clicking').rules).toEqual(['D14:door-closed-latched', 'D15:door-catch', 'D20:model']);
  });
  it('handle broken → model → handle part; won\'t close → catch → model → handle part', () => {
    expect(run('handle').rules).toEqual(['D20:model', 'D21:door-handle']);
    expect(run('wontClose').rules).toEqual(['D15:door-catch', 'D20:model', 'D21:door-handle']);
  });
  it('vague → ask which door fault; cannot answer → unconfirmed engineer conclusion', () => { expect(run('vague').rules).toEqual(['D10:doorSymptom', 'D22:fault-source-unconfirmed']); });
});

describe('part gate', () => {
  it('model unavailable → conclude handle component, no part; make only → K1', () => {
    expect(run('handleNoModel').last).toMatchObject({ kind: 'conclude', conclusion: { component: 'door-handle' } });
    const m = run('noLockMake');
    expect(P.partGate(m.state, m.prep.diag, { available: true, component: 'door-lock' }).failed).toContain('K1-model-not-known');
  });
  it('matchers: door lock never matches seal / handle; handle never matches lock', () => {
    const pick = (titles, c) => J.partLookupFrom(titles.map((title) => ({ title })), c).parts.map((p) => p.title);
    expect(pick(['Door Seal', 'Door Lock', 'Door Handle', 'Door Interlock'], 'door-lock')).toEqual(['Door Lock', 'Door Interlock']);
    expect(pick(['Door Seal', 'Door Lock', 'Handle'], 'door-handle')).toEqual(['Handle']);
  });
});

describe('COMPOSE contract', () => {
  it('every action reached obeys the contract; door copy never suggests bypassing or forcing', () => {
    const seen = Object.keys(SEQ).flatMap((k) => run(k).actions);
    expect(H.composeProblems(JC, P, seen)).toEqual([]);
    expect(JSON.stringify(JC.TASK)).not.toMatch(/(?<!never try to force or )bypass|prise|lever it|string to release|emergency release/i);
  });
});

afterEach(() => { delete process.env.CANONICAL_J6_CONTROL; });
describe('routing / gate', () => {
  const { emptyState } = require('../canonical/cs1.js'); const { merge } = require('../canonical/merge.js');
  const T = (cs) => { let s = emptyState('cs_' + 'f'.repeat(32)); for (const c of cs) s = merge(s, c, { turn: s.version + 1 }).state; return { schema: 'cs/1', mode: 'control', sessionId: s.sessionId, priorVersion: s.version - 1, version: s.version, state: s, classification: cs[cs.length - 1], rulesFired: [], requestOutcome: null, degraded: null }; };
  const B = (journeys) => ({ schema: 'cs/1', mode: 'control', control: { journeys }, sessionId: 'x', version: 0, state: null, degraded: null });
  it('own gate key; kill switch; retained water routes to Journey 1', async () => {
    expect((await L.canonicalJourneys(T([op([O('doorOpens', false)])]), B(['wm-door']))).journey).toMatchObject({ key: 'wm-door', control: true, nextAction: { rule: 'D11' } });
    const w = await L.canonicalJourneys(T(SEQ.water), B(['wm-not-draining', 'wm-door']));
    expect(w.journey).toMatchObject({ key: 'wm-not-draining', control: true });
    process.env.CANONICAL_J6_CONTROL = '0';
    expect((await L.canonicalJourneys(T([op([O('doorOpens', false)])]), B(['wm-door']))).journey.control).toBe(false);
  });
});
