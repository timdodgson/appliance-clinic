/** Tumble dryer journey 6 (td-water-container-drain): vented gate, container / drain kit / condenser / pump, part gates, routing. */
import { describe, it, expect, afterEach } from 'vitest';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
globalThis.awslambda = globalThis.awslambda || { streamifyResponse: (f) => f, HttpResponseStream: { from: (s) => s } };
const H = require('./helpers/b2-journey.cjs');
const J = require('../canonical/td6-water-container.js');
const L = require('../part-finder-lambda.js')._internal;
const { C, O, K } = H;

const leak = (obs = [], journey = 'leaking', id = {}) => H.tdOpener(journey, 'water', obs, {}, id);
const ok = (c) => C({ checks: [K(c, 'done', 'clear')] });
const SEQ = {
  vented: [leak([O('dryerVented')])],
  ventedAsked: [leak(), C({ observations: [O('dryerVented')] })],
  warning: [leak([O('tankWarning'), O('dryerCondenser')], 'cuts-out'), C({ checks: [K('water-container', 'done', 'found_and_cleared')] }), C({ observations: [O('faultPersists', false)] })],
  drainKit: [leak([O('tankStaysEmpty'), O('dryerCondenser')]), ok('water-container'), C({ observations: [O('drainKitFitted')] })],
  condenser: [leak([O('tankStaysEmpty'), O('dryerCondenser'), O('leakUnderneath')]), ok('water-container'), C({ observations: [O('drainKitFitted', false)] }),
    C({ checks: [K('condenser', 'done', 'found_and_cleared')] }), C({ observations: [O('faultPersists', false)] })],
  pump: [leak([O('tankStaysEmpty'), O('dryerCondenser')], 'leaking', { make: { value: 'hotpoint', basis: 'stated' }, displayedCode: 'F05' }), ok('water-container'),
    C({ observations: [O('drainKitFitted', false)] }), ok('condenser'), H.model('TCM580P', 'hotpoint')],
  cracked: [leak([O('dryerCondenser'), O('leakUnderneath')]), C({ checks: [K('water-container', 'done', 'fault_seen')] }), H.model('TCFS83BGPUK', 'hotpoint')],
};
const run = (k, mp = [{ title: 'Tumble Dryer Water Tank' }, { title: 'Pipe Pump To Container' }]) => H.play(J, SEQ[k], { modelParts: mp });

describe('policy / diagnostics', () => {
  it('vented dryer: architecture gates the journey — "no container", no part, said once', () => {
    expect(run('vented').last).toMatchObject({ rule: 'DW5', target: 'vented-no-container', conclusion: { noPart: true } });
    expect(run('ventedAsked').rules).toEqual(['DW10:dryerType', 'DW5:vented-no-container']);
  });
  it('stops with the container warning → container emptied / reseated → retest → fixed', () => { expect(run('warning').rules).toEqual(['DW12:water-container', 'DW6:retest', 'DW7:container-full-or-not-seated']); });
  it('container stays empty with a drain kit fitted → normal, no part', () => { expect(run('drainKit').last).toMatchObject({ target: 'drain-kit-fitted', conclusion: { noPart: true } }); });
  it('clogged condenser → cleaned → fixed', () => { expect(run('condenser').last).toMatchObject({ rule: 'DW7', target: 'condenser-blocked' }); });
  it('pump code + empty container + condenser clean → pump component; a "pipe pump to container" is not a pump', () => {
    const r = run('pump');
    expect(r.prep.diag.leader).toMatchObject({ family: 'condensate-pump-or-float', component: 'condensate-pump' });
    expect(r.last).toMatchObject({ kind: 'conclude', conclusion: { component: 'condensate-pump' } });
  });
  it('cracked container (owner seen) + model → container part', () => { expect(run('cracked').last).toMatchObject({ kind: 'recommend_part', target: 'water-container' }); });
});
describe('COMPOSE contract', () => {
  it('every action reached obeys the contract', () => { expect(H.composeProblems(J, J.P, Object.keys(SEQ).flatMap((k) => run(k).actions))).toEqual([]); });
});
afterEach(() => { delete process.env.CANONICAL_TD6_CONTROL; });
describe('routing / gate', () => {
  it('dryer leak / container here; dishwasher / fridge leaks never here; kill switch', async () => {
    const all = ['td-water-container-drain', 'dw-leaking', 'ff-leaking-water'];
    expect(await H.ownerOf(L, [leak([O('leakUnderneath')])], all)).toBe('td-water-container-drain');
    expect(await H.ownerOf(L, [leak([O('tankStaysEmpty')], 'not-draining')], all)).toBe('td-water-container-drain');
    expect(await H.ownerOf(L, [H.dwOpener('leaking', 'water', [O('leakUnderneath')])], all)).toBe('dw-leaking');
    expect(await H.ownerOf(L, [H.ffOpener('leaking', 'water', [O('leakUnderneath')])], all)).toBe('ff-leaking-water');
    process.env.CANONICAL_TD6_CONTROL = '0';
    expect((await H.routeWith(L, [leak()], all)).journey.control).toBe(false);
  });
});
