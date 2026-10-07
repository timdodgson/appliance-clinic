/**
 * Journey 7 (wm-excessive-vibration): diagnostics, policy, part gate, COMPOSE contract, routing / gate.
 * Expectations from wm-batch-2-evidence.md §4 (no-part outcomes first; no suspension part from generic vibration).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
globalThis.awslambda = globalThis.awslambda || { streamifyResponse: (f) => f, HttpResponseStream: { from: (s) => s } };
const H = require('./helpers/b2-journey.cjs');
const J = require('../canonical/j7-pipeline.js');
const P = require('../canonical/j7-policy.js');
const JC = require('../canonical/j7-compose.js');
const L = require('../part-finder-lambda.js')._internal;
const { C, O, K } = H;

const op = (obs = []) => H.opener('vibration', 'motion', [O('excessiveVibration'), ...obs]);
const MP = [{ title: 'Shock Absorber' }, { title: 'Elastic Poly-Vee Belt 1270 J5' }];
const beko = () => H.model('WMB81445LW', 'beko');
const SEQ = {
  bolts: [op([O('recentInstallation')]), C({ checks: [K('transit-bolts', 'done', 'found_and_cleared')] }), C({ observations: [O('faultPersists', false)] }), C({ reply: { toPending: 'answered', outcome: 'resolved' } })],
  towels: [op([O('loadDependent')]), C({ observations: [O('recentInstallation', false)] }), C({ checks: [K('load-check', 'done', 'found_and_cleared')] }), C({ observations: [O('faultPersists', false)] })],
  suspension: [op(), C({ observations: [O('recentInstallation', false)] }), C({ checks: [K('load-check', 'done', 'clear')] }), C({ checks: [K('levelling', 'done', 'clear')] }),
    C({ observations: [O('shakesWhenEmpty')] }), C({ observations: [O('drumPlay')] }), beko()],
  damper: [op([O('recentInstallation', false)]), C({ checks: [K('load-check', 'done', 'clear'), K('shock-absorbers', 'done', 'fault_seen')] }), C({ checks: [K('levelling', 'done', 'clear')] }),
    C({ observations: [O('shakesWhenEmpty')] }), C({ observations: [O('drumPlay', false)] }), beko()],
  levelFails: [op(), C({ observations: [O('recentInstallation', false)] }), C({ checks: [K('load-check', 'done', 'clear')] }), C({ checks: [K('levelling', 'done', 'found_and_cleared')] }), C({ observations: [O('faultPersists')] })],
  moved: [op([O('recentInstallation')]), C({ checks: [K('transit-bolts', 'done', 'clear')] }), C({ checks: [K('load-check', 'done', 'clear')] }), C({ checks: [K('levelling', 'done', 'found_and_cleared')] }), C({ observations: [O('faultPersists', false)] })],
  bearing: [op([O('grindingNoise'), O('recentInstallation', false)]), C({ checks: [K('load-check', 'done', 'clear')] }), C({ checks: [K('levelling', 'done', 'clear')] }), C({ observations: [O('shakesWhenEmpty')] }), C({ observations: [O('drumPlay')] })],
  emptySmooth: [op([O('recentInstallation', false)]), C({ checks: [K('load-check', 'done', 'clear')] }), C({ checks: [K('levelling', 'done', 'clear')] }), C({ observations: [O('shakesWhenEmpty', false)] })],
  cannot: [op(), C({ reply: { toPending: 'cannot_answer' } }), C({ checks: [K('load-check', 'unable')] }), C({ checks: [K('levelling', 'unable')] }), C({ reply: { toPending: 'cannot_answer' } }), C({ reply: { toPending: 'cannot_answer' } })],
};
const run = (k) => H.play(J, SEQ[k], { modelParts: MP });

describe('diagnostics', () => {
  it('transit bolts / load / levelling fixes are no-part families', () => {
    expect(run('bolts').prep.diag.leader).toMatchObject({ family: 'transit-bolts', component: null });
    expect(run('towels').prep.diag).toMatchObject({ likelyResolved: true, leader: { family: 'load-imbalance' } });
  });
  it('generic shaking (empty, level, bolts out, loose) → suspension only at cause-family level (no part)', () => {
    const d = run('suspension').prep.diag;
    expect(d.leader).toMatchObject({ family: 'suspension-dampers', level: 'cause_family' });
    expect(d.partEvidence.sufficient).toBe(false);
  });
  it('a shock absorber actually seen broken → suspension component', () => {
    expect(run('damper').prep.diag.leader).toMatchObject({ family: 'suspension-dampers', component: 'shock-absorber' });
  });
  it('smooth with the drum empty → load imbalance, never suspension', () => {
    const d = run('emptySmooth').prep.diag;
    expect(d.leader.family).toBe('load-imbalance');
    expect(d.contradicted.map((c) => c.family)).toContain('suspension-dampers');
  });
});

describe('policy', () => {
  it('new machine → transit bolts → retest → likely fixed → close', () => { expect(run('bolts').rules).toEqual(['V11:transit-bolts', 'V6:retest', 'V7:transit-bolts', 'V2:transit-bolts']); });
  it('towels only → installed? → load → retest → likely fixed', () => { expect(run('towels').rules).toEqual(['V10:recentInstallation', 'V12:load-check', 'V6:retest', 'V7:load-imbalance']); });
  it('full path → suspension conclusion (engineer, no part) even with a model listing a shock absorber', () => {
    const r = run('suspension');
    expect(r.rules).toEqual(['V10:recentInstallation', 'V12:load-check', 'V13:levelling', 'V14:empty-vibration-test', 'V15:drum-play', 'V22:suspension-dampers', 'V22:suspension-dampers']);
    expect(r.last.conclusion).toMatchObject({ handoff: 'engineer', noPart: true });
  });
  it('empty spin test carries the violent-shaking stop and stand-clear safety', () => {
    expect(run('suspension').actions[3].action.requires).toEqual(['stop_if_violent_shaking', 'stand_clear_while_spinning']);
  });
  it('levelled but still shakes → continues to the empty spin test (no loop); moved house → levelling fix → likely fixed', () => {
    expect(run('levelFails').rules).toEqual(['V10:recentInstallation', 'V12:load-check', 'V13:levelling', 'V6:retest', 'V14:empty-vibration-test']);
    expect(run('moved').rules).toEqual(['V11:transit-bolts', 'V12:load-check', 'V13:levelling', 'V6:retest', 'V7:levelling-or-floor']);
  });
  it('grinding + loose drum → drum support / bearings, engineer, no part', () => {
    expect(run('bearing').last).toMatchObject({ kind: 'conclude', target: 'drum-support-or-bearings', conclusion: { noPart: true } });
  });
  it('cannot / unable throughout → still concludes (no loop)', () => {
    const r = run('cannot');
    expect(r.rules.slice(-1)[0]).toMatch(/^V22:/);
  });
});

describe('part gate', () => {
  it('seen-broken damper + model + listed → shock absorber part', () => { expect(run('damper').last).toMatchObject({ kind: 'recommend_part', target: 'shock-absorber', rule: 'V21' }); });
  it('generic suspension never passes K4', () => {
    const r = run('suspension');
    expect(P.partGate(r.state, r.prep.diag, { available: true, component: 'shock-absorber' }).failed).toContain('K4-evidence-insufficient');
  });
});

describe('COMPOSE contract', () => {
  it('every action reached obeys the contract; transit-bolt step carries the transit-bolt media', () => {
    const seen = Object.keys(SEQ).flatMap((k) => run(k).actions);
    expect(H.composeProblems(JC, P, seen)).toEqual([]);
    expect(J.mediaFor(run('bolts').actions[0].action)).toMatchObject({ ids: ['wm-transit-bolts'] });
  });
});

afterEach(() => { delete process.env.CANONICAL_J7_CONTROL; });
describe('routing / gate', () => {
  const { emptyState } = require('../canonical/cs1.js'); const { merge } = require('../canonical/merge.js');
  const T = (cs) => { let s = emptyState('cs_' + 'a'.repeat(32)); for (const c of cs) s = merge(s, c, { turn: s.version + 1 }).state; return { schema: 'cs/1', mode: 'control', sessionId: s.sessionId, priorVersion: s.version - 1, version: s.version, state: s, classification: cs[cs.length - 1], rulesFired: [], requestOutcome: null, degraded: null }; };
  const B = (journeys) => ({ schema: 'cs/1', mode: 'control', control: { journeys }, sessionId: 'x', version: 0, state: null, degraded: null });
  it('own gate key; not-spinning + shaking stays Journey 2; kill switch', async () => {
    expect((await L.canonicalJourneys(T([op()]), B(['wm-excessive-vibration']))).journey).toMatchObject({ key: 'wm-excessive-vibration', control: true });
    const j2 = await L.canonicalJourneys(T([H.opener('not-spinning', 'motion', [O('excessiveVibration'), O('waterRemaining', false)])]), B(['wm-not-spinning', 'wm-excessive-vibration']));
    expect(j2.journey.key).toBe('wm-not-spinning');
    process.env.CANONICAL_J7_CONTROL = '0';
    expect((await L.canonicalJourneys(T([op()]), B(['wm-excessive-vibration']))).journey.control).toBe(false);
  });
});
