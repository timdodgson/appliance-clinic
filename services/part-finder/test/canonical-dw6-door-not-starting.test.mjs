/** Dishwasher journey 6 (dw-door-not-starting): diagnostics, policy, part gate, COMPOSE contract, routing / handoffs. */
import { describe, it, expect, afterEach } from 'vitest';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
globalThis.awslambda = globalThis.awslambda || { streamifyResponse: (f) => f, HttpResponseStream: { from: (s) => s } };
const H = require('./helpers/b2-journey.cjs');
const J = require('../canonical/dw6-door-not-starting.js');
const L = require('../part-finder-lambda.js')._internal;
const { C, O, K } = H;

const door = (obs = []) => H.dwOpener('door-problem', 'door', obs);
const nostart = (obs = []) => H.dwOpener('wont-start', 'power', obs);
const MP = [{ title: 'Door Lock Complete' }];
const m = () => H.model('HFC3C26W', 'hotpoint');
const SEQ = {
  latch: [door([O('doorRecognised', false)]), C({ observations: [O('doorRecognised', false)] }), C({ checks: [K('door-catch', 'done', 'clear')] }), m()],
  pushed: [door([O('startsWhenPushed')]), C({ observations: [O('doorRecognised', false)] }), C({ checks: [K('door-catch', 'done', 'clear')] }), m()],
  obstruction: [door([O('doorCloses', false)]), C({ observations: [O('doorRecognised', false)] }), C({ checks: [K('door-catch', 'done', 'found_and_cleared')] }), C({ observations: [O('faultPersists', false)] })],
  recognised: [nostart([O('noPower', false)]), C({ observations: [O('doorRecognised')] }), C({ checks: [K('child-lock', 'done', 'clear')] }), C({ checks: [K('programme-setting', 'done', 'clear')] }), m()],
  childLock: [nostart([O('noPower', false), O('doorRecognised')]), C({ checks: [K('child-lock', 'done', 'found_and_cleared')] }), C({ observations: [O('faultPersists', false)] })],
  delay: [nostart([O('noPower', false), O('doorRecognised')]), C({ checks: [K('child-lock', 'done', 'clear')] }), C({ checks: [K('programme-setting', 'done', 'found_and_cleared')] }), C({ observations: [O('faultPersists', false)] })],
  deadFuse: [nostart([O('noPower')]), C({ checks: [K('power-supply', 'done', 'found_and_cleared')] }), C({ observations: [O('faultPersists', false)] })],
  deadSocketOk: [nostart([O('noPower')]), C({ checks: [K('power-supply', 'done', 'clear')] }), m()],
  latchNoModel: [door([O('doorCloses', false)]), C({ observations: [O('doorRecognised', false)] }), C({ checks: [K('door-catch', 'done', 'fault_seen')] }), H.noModel()],
  flood: [nostart([O('waterInBase')])],
  trip: [nostart(), C({ safety: { hazard: 'supply_trip' } })],
  vague: [nostart(), C({ reply: { toPending: 'cannot_answer' } }), C({ reply: { toPending: 'cannot_answer' } })],
};
const run = (k) => H.play(J, SEQ[k], { modelParts: MP });

describe('diagnostics', () => {
  it('still says door open after shutting firmly / only starts when pushed → door latch component', () => {
    expect(run('latch').prep.diag.leader).toMatchObject({ family: 'door-latch', component: 'door-lock' });
    expect(run('pushed').prep.diag.leader).toMatchObject({ family: 'door-latch', component: 'door-lock' });
  });
  it('dead with the socket fine → mains / control (engineer), never the latch', () => {
    const d = run('deadSocketOk').prep.diag;
    expect(d.leader.family).toBe('mains-or-control-dead');
    expect(d.contradicted.map((c) => c.family)).toContain('door-latch');
  });
});
describe('policy', () => {
  it('door not recognised → shut firmly → latch / strike → model → door latch part', () => { expect(run('latch').rules).toEqual(['G13:door-start-test', 'G14:door-catch', 'G20:model', 'G21:door-lock']); });
  it('door recognised → never re-asks the latch: child lock → delay start → start-control engineer', () => {
    const r = run('recognised');
    expect(r.rules).toEqual(['G12:doorRecognised', 'G15:child-lock', 'G16:programme-setting', 'G22:start-control', 'G22:start-control']);
    expect(r.rules.some((x) => /door-start-test|door-catch/.test(x))).toBe(false);
  });
  it('child lock / delay start / obstruction → retest → likely fixed (no part)', () => {
    expect(run('childLock').last.rule).toBe('G7');
    expect(run('delay').last).toMatchObject({ rule: 'G7', target: 'delay-start-or-programme' });
    expect(run('obstruction').last).toMatchObject({ rule: 'G7', target: 'door-obstruction-or-alignment' });
  });
  it('dead: supply check (no electrical testing) → fuse fixed → likely fixed; socket fine → engineer', () => {
    const f = run('deadFuse');
    expect(f.rules).toEqual(['G11:power-supply', 'G6:retest', 'G7:power-supply']);
    expect(f.actions[0].action.requires).toEqual(['no_live_electrical_checks']);
    expect(run('deadSocketOk').last).toMatchObject({ target: 'mains-or-control-dead', conclusion: { handoff: 'engineer', noPart: true } });
  });
  it('flood protection → dw-leaking owns it; trip → safety stop; vague → concludes', () => {
    expect(run('flood').prep.entry).toMatchObject({ applies: false, drainOwned: true });
    expect(run('trip').last).toMatchObject({ kind: 'safety_stop', rule: 'G1' });
    expect(run('vague').rules.slice(-1)[0]).toMatch(/^G22:/);
  });
});
describe('part gate', () => {
  it('model unavailable → latch component conclusion, no part; recognised path never yields a part', () => {
    expect(run('latchNoModel').last).toMatchObject({ kind: 'conclude', conclusion: { component: 'door-lock' } });
    expect(run('recognised').last.kind).toBe('conclude');
  });
});
describe('COMPOSE contract', () => {
  it('every action reached obeys the contract; never suggests bypassing the door switch', () => {
    const seen = Object.keys(SEQ).flatMap((k) => run(k).actions);
    expect(H.composeProblems(J, J.P, seen)).toEqual([]);
    expect(JSON.stringify(J.TASK)).not.toMatch(/(?<!never try to force or |don't try to force or )bypass|tape|jumper/i);
  });
});
afterEach(() => { delete process.env.CANONICAL_DW6_CONTROL; });
describe('routing / gate', () => {
  it('own gate; washing-machine door stays wm-door; flood → dw-leaking; kill switch', async () => {
    const all = ['dw-door-not-starting', 'dw-leaking', 'wm-door'];
    expect((await H.routeWith(L, [door([O('doorRecognised', false)])], all)).journey).toMatchObject({ key: 'dw-door-not-starting', control: true });
    expect((await H.routeWith(L, [nostart([O('waterInBase')])], all)).journey.key).toBe('dw-leaking');
    expect((await H.routeWith(L, [H.opener('door-problem', 'door', [O('doorOpens', false)])], all)).journey.key).toBe('wm-door');
    process.env.CANONICAL_DW6_CONTROL = '0';
    expect((await H.routeWith(L, [door([O('doorRecognised', false)])], all)).journey.control).toBe(false);
  });
});
