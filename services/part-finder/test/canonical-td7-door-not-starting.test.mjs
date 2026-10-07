/** Tumble dryer journey 7 (td-door-not-starting): dead / door not recognised / recognised, latch part gate, never bypass, routing. */
import { describe, it, expect, afterEach } from 'vitest';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
globalThis.awslambda = globalThis.awslambda || { streamifyResponse: (f) => f, HttpResponseStream: { from: (s) => s } };
const H = require('./helpers/b2-journey.cjs');
const J = require('../canonical/td7-door-not-starting.js');
const L = require('../part-finder-lambda.js')._internal;
const { C, O, K } = H;

const door = (obs = []) => H.tdOpener('door-problem', 'door', obs);
const nostart = (obs = []) => H.tdOpener('wont-start', 'power', obs);
const m = () => H.model('TCFS83BGP9UK', 'hotpoint');
const SEQ = {
  latch: [door([O('doorRecognised', false)]), C({ observations: [O('doorRecognised', false)] }), C({ checks: [K('door-catch', 'done', 'clear')] }), m()],
  fluff: [door([O('doorRecognised', false)]), C({ observations: [O('doorRecognised', false)] }), C({ checks: [K('door-catch', 'done', 'found_and_cleared')] }), C({ observations: [O('faultPersists', false)] })],
  recognised: [nostart([O('noPower', false)]), C({ observations: [O('doorRecognised')] }), C({ checks: [K('child-lock', 'done', 'clear')] }), C({ checks: [K('programme-setting', 'done', 'clear')] })],
  dead: [nostart([O('noPower')]), C({ checks: [K('power-supply', 'done', 'clear')] })],
  plinth: [door([O('doorRecognised', false)]), C({ observations: [O('doorRecognised', false)] }), C({ checks: [K('door-catch', 'done', 'fault_seen')] }), m()],
};
const run = (k, mp = [{ title: 'Door Lock' }, { title: 'Plinth Cover Catch' }]) => H.play(J, SEQ[k], { modelParts: mp });

describe('policy / part gate', () => {
  it('door not recognised → shut firmly → catch → model → door latch part', () => { expect(run('latch').rules).toEqual(['DG13:door-start-test', 'DG14:door-catch', 'DG20:model', 'DG21:door-latch']); });
  it('fluff in the catch → cleared → retest → fixed', () => { expect(run('fluff').last).toMatchObject({ rule: 'DG7', target: 'door-obstruction-or-alignment' }); });
  it('door recognised → child lock → delay → start control (engineer); never re-asks the latch', () => {
    const r = run('recognised');
    expect(r.rules).toEqual(['DG12:doorRecognised', 'DG15:child-lock', 'DG16:programme-setting', 'DG22:start-control']);
  });
  it('dead with the socket fine → mains / control (engineer)', () => { expect(run('dead').last).toMatchObject({ target: 'mains-or-control-dead', conclusion: { handoff: 'engineer' } }); });
  it('a request to bypass the interlock is declined (P8), never instructed', () => {
    const r = H.play(J, [door([O('doorRecognised', false)]), C({ safety: { unsafeAction: 'bypass_safety_device' } })]);
    expect(r.last).toMatchObject({ rule: 'DG8', kind: 'conclude', conclusion: { noPart: true } });
    expect(J.template(J.brief(r.state, r.last, null, {}))).toMatch(/can't help with getting round/);
  });
  it('a plinth cover catch is never the door latch', () => {
    expect(run('plinth', [{ title: 'Plinth Cover Catch' }]).last).toMatchObject({ kind: 'conclude', conclusion: { component: 'door-latch' } });
  });
});
describe('COMPOSE contract', () => {
  it('every action reached obeys the contract; never suggests bypassing the interlock', () => {
    expect(H.composeProblems(J, J.P, Object.keys(SEQ).flatMap((k) => run(k).actions))).toEqual([]);
    expect(JSON.stringify(J.TASK)).not.toMatch(/(?<!don't try to force or )bypass|tape|jumper|magnet/i);
  });
});
afterEach(() => { delete process.env.CANONICAL_TD7_CONTROL; });
describe('routing / gate', () => {
  it('dryer door / start here; container warning → water; dishwasher door unchanged; kill switch', async () => {
    const all = ['td-door-not-starting', 'td-water-container-drain', 'dw-door-not-starting'];
    expect(await H.ownerOf(L, [door([O('doorRecognised', false)])], all)).toBe('td-door-not-starting');
    expect(await H.ownerOf(L, [nostart([O('tankWarning')])], all)).toBe('td-water-container-drain');
    expect(await H.ownerOf(L, [H.dwOpener('door-problem', 'door', [O('doorRecognised', false)])], all)).toBe('dw-door-not-starting');
    process.env.CANONICAL_TD7_CONTROL = '0';
    expect((await H.routeWith(L, [door()], all)).journey.control).toBe(false);
  });
});
