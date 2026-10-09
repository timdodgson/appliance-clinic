/**
 * Journey 5 (wm-overfilling): diagnostics, policy, part gate, COMPOSE contract, routing / gate.
 * Expectations from wm-batch-2-evidence.md §2 (off vs running split; containment first; never an uncontrolled test).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
globalThis.awslambda = globalThis.awslambda || { streamifyResponse: (f) => f, HttpResponseStream: { from: (s) => s } };
const H = require('./helpers/b2-journey.cjs');
const J = require('../canonical/j5-pipeline.js');
const P = require('../canonical/j5-policy.js');
const JC = require('../canonical/j5-compose.js');
const L = require('../part-finder-lambda.js')._internal;
const { C, O, K } = H;

const op = (obs = []) => H.opener('overfilling', 'water', obs);
const MP = [{ title: 'Fill Valve' }, { title: 'Door Lock' }];
const SEQ = {
  whenOff: [op([O('fillsWhenOff')]), C({ observations: [O('waterIsDirty', false)] }), H.model()],
  whenOffAsk: [op([O('fillsWhenOff')]), C({}), C({ observations: [O('waterIsDirty', false)] })],
  highRunning: [op(), C({ observations: [O('fillsWhenOff', false)] }), C({ observations: [O('waterLevelHigh')] })],
  siphon: [op(), C({ observations: [O('fillsWhenOff', false)] }), C({ observations: [O('waterLevelHigh', false)] }), C({ checks: [K('drain-hose-height', 'done', 'found_and_cleared')] }),
    C({ observations: [O('faultPersists', false)] }), C({ reply: { toPending: 'answered', outcome: 'resolved' } })],
  dirty: [op([O('fillsWhenOff')]), C({ observations: [O('waterIsDirty')] }), C({ checks: [K('drain-hose-height', 'done', 'clear')] })],
  dirtyKnown: [op([O('fillsWhenOff'), O('waterIsDirty')]), C({}), C({ checks: [K('drain-hose-height', 'done', 'clear')] })],
  test: [op(), C({ reply: { toPending: 'cannot_answer' } }), C({ reply: { toPending: 'cannot_answer' } }), C({ observations: [O('fillsWhenOff')] })],
  foam: [op([O('excessiveFoam')]), C({ observations: [O('fillsWhenOff', false)] })],
  flood: [op(), C({ observations: [O('majorLeak')] }), C({})],
  noModel: [op([O('fillsWhenOff')]), C({ observations: [O('waterIsDirty', false)] }), H.noModel()],
};
const run = (k) => H.play(J, SEQ[k], { modelParts: MP });

describe('diagnostics', () => {
  it('clean water entering with the machine OFF: inlet valve stuck open, component level', () => {
    expect(run('whenOff').prep.diag.leader).toMatchObject({ family: 'inlet-valve-stuck-open', committed: true, component: 'inlet-valve' });
  });
  it('stops when off + level too high: level sensing / control (never the valve)', () => {
    const d = run('highRunning').prep.diag;
    expect(d.leader).toMatchObject({ family: 'level-sensing-or-control' });
    expect(d.contradicted.map((c) => c.family)).toContain('inlet-valve-stuck-open');
  });
  it('dirty water appearing: never valve evidence; hose fitted correctly → household waste backflow', () => {
    const d = run('dirty').prep.diag;
    expect(d.contradicted.map((c) => c.family)).toContain('inlet-valve-stuck-open');
    expect(d.leader).toMatchObject({ family: 'waste-backflow' });
  });
});

describe('policy', () => {
  it('first report → containment safety stop (water off, power off only if dry), then diagnosis continues', () => {
    const r = run('whenOff');
    expect(r.actions[0].action).toMatchObject({ kind: 'safety_stop', target: 'uncontrolled-fill-off', rule: 'O1', pending: { target: 'waterIsDirty' } });
    expect(r.actions[0].action.requires).toEqual(['water_off_at_tap', 'power_off_only_if_dry', 'keep_clear_of_socket_if_water_near']);
    expect(r.rules).toEqual(['O1:uncontrolled-fill-off', 'O20:model', 'O21:inlet-valve']);
  });
  // GOLD v2 remediation: the clean-vs-dirty question asked with the containment stop is not re-asked when the reply
  // carries nothing; the journey moves on (model), and the clean-water answer that follows leads to the valve.
  it('fills when off, water type unanswered → not re-asked; clean water later → inlet valve', () => { expect(run('whenOffAsk').rules).toEqual(['O1:uncontrolled-fill-off', 'O20:model', 'O22:inlet-valve-stuck-open']); });
  it('stops when off + high level → engineer, no part', () => {
    const r = run('highRunning');
    expect(r.rules).toEqual(['O1:uncontrolled-fill', 'O13:waterLevelHigh', 'O22:level-sensing-or-control']);
    expect(r.last.conclusion).toMatchObject({ handoff: 'engineer', noPart: true });
  });
  it('siphon: level normal → drain hose height → refitted → retest → likely fixed → close', () => {
    expect(run('siphon').rules).toEqual(['O1:uncontrolled-fill', 'O13:waterLevelHigh', 'O14:drain-hose-height', 'O6:retest', 'O7:drain-hose-siphon', 'O2:drain-hose-siphon']);
  });
  it('cannot say whether it fills when off → one-minute supervised switched-off test (tap off after)', () => {
    const r = run('test');
    // the containment stop already asked off-vs-running (typed request), so "don't know" goes straight to the test
    expect(r.actions[0].action.pending).toMatchObject({ target: 'fillsWhenOff' });
    expect(r.rules.slice(0, 2)).toEqual(['O1:uncontrolled-fill', 'O11:power-off-fill-test']);
    expect(r.actions[1].action.requires).toEqual(['power_off_only_if_dry', 'watch_briefly_only', 'water_off_after_test']);
  });
  it('everything already known → containment copy without a question, then the next step', () => {
    const r = run('dirtyKnown');
    expect(r.actions[0].action).toMatchObject({ target: 'uncontrolled-fill-known', pending: null });
    expect(r.rules).toEqual(['O1:uncontrolled-fill-known', 'O14:drain-hose-height', 'O22:waste-backflow']);
  });
  it('foam → dose advice, no part; a large leak reported mid-journey stops once', () => {
    expect(run('foam').last).toMatchObject({ kind: 'conclude', target: 'foam-level' });
    const f = run('flood');
    expect(f.rules[1]).toBe('O1:uncontrolled-fill');
    expect(f.rules[2]).not.toBe('O1:uncontrolled-fill');
  });
});

describe('part gate', () => {
  it('model unavailable → conclude valve component, no part; containment turn blocks parts (K6)', () => {
    expect(run('noModel').last).toMatchObject({ kind: 'conclude', conclusion: { component: 'inlet-valve' } });
    const r = H.play(J, [op([O('fillsWhenOff')])]);
    expect(P.partGate(r.state, r.prep.diag, { available: true, component: 'inlet-valve' }).failed).toContain('K6-active-safety');
  });
});

describe('COMPOSE contract', () => {
  it('every action reached obeys the contract; containment copy is fixed and asks no question', () => {
    const seen = Object.keys(SEQ).flatMap((k) => run(k).actions);
    expect(H.composeProblems(JC, P, seen)).toEqual([]);
    expect(JC.SAFETY_COPY['uncontrolled-fill']).toMatch(/tap/);
    expect(JC.SAFETY_COPY['uncontrolled-fill']).not.toMatch(/\?/);
  });
  it('no copy asks the customer to leave the fill running', () => {
    expect(JSON.stringify(JC.TASK)).not.toMatch(/leave it (running|filling)|let it keep filling/i);
  });
});

afterEach(() => { delete process.env.CANONICAL_J5_CONTROL; });
describe('routing / gate', () => {
  const { emptyState } = require('../canonical/cs1.js'); const { merge } = require('../canonical/merge.js');
  const T = (cs) => { let s = emptyState('cs_' + 'e'.repeat(32)); for (const c of cs) s = merge(s, c, { turn: s.version + 1 }).state; return { schema: 'cs/1', mode: 'control', sessionId: s.sessionId, priorVersion: s.version - 1, version: s.version, state: s, classification: cs[cs.length - 1], rulesFired: [], requestOutcome: null, degraded: null }; };
  const B = (journeys) => ({ schema: 'cs/1', mode: 'control', control: { journeys }, sessionId: 'x', version: 0, state: null, degraded: null });
  it('own gate key; kill switch', async () => {
    expect((await L.canonicalJourneys(T([op()]), B(['wm-overfilling']))).journey).toMatchObject({ key: 'wm-overfilling', control: true, nextAction: { rule: 'O1' } });
    expect((await L.canonicalJourneys(T([op()]), B(['wm-not-filling']))).journey).toMatchObject({ key: 'wm-overfilling', control: false });
    process.env.CANONICAL_J5_CONTROL = '0';
    expect((await L.canonicalJourneys(T([op()]), B(['wm-overfilling']))).journey.control).toBe(false);
  });
});
