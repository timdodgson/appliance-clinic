/** Fridge / freezer journey 7 (ff-not-running-dead): NO POWER / LIGHTS BUT NOT RUNNING / CLICK-START / RUNNING NOT COOLING. */
import { describe, it, expect, afterEach } from 'vitest';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
globalThis.awslambda = globalThis.awslambda || { streamifyResponse: (f) => f, HttpResponseStream: { from: (s) => s } };
const H = require('./helpers/b2-journey.cjs');
const J = require('../canonical/ff7-not-running.js');
const L = require('../part-finder-lambda.js')._internal;
const { C, O, K } = H;

const dead = (obs = [], journey = 'wont-start') => H.ffOpener(journey, 'power', obs);
const SEQ = {
  fuse: [dead([O('noPower')]), C({ checks: [K('power-supply', 'done', 'found_and_cleared')] }), C({ observations: [O('faultPersists', false)] })],
  socketOk: [dead([O('noPower')]), C({ checks: [K('power-supply', 'done', 'clear')] })],
  lightsSilent: [dead(), C({ observations: [O('noPower', false)] }), C({ observations: [O('compressorRuns', false)] })],
  clicks: [dead([O('clicksNoStart')], 'not-cooling'), C({ checks: [K('condenser-coil-clear', 'done', 'clear')] }), H.model('FF200DP', 'hotpoint')],
  clicksCoils: [dead([O('clicksNoStart')]), C({ checks: [K('condenser-coil-clear', 'done', 'found_and_cleared')] }), C({ observations: [O('faultPersists', false)] })],
  running: [dead([O('noPower', false)]), C({ observations: [O('compressorRuns')] })],
  trip: [dead(), C({ safety: { hazard: 'supply_trip' } }), C({ observations: [O('noPower')] })],
  burning: [dead([O('clicksNoStart')]), C({ safety: { hazard: 'burning' } })],
};
const run = (k) => H.play(J, SEQ[k], { modelParts: [{ title: 'Compressor Start Relay' }, { title: 'Compressor' }] });

describe('four states', () => {
  it('NO POWER → supply check (no electrical testing, food safety first) → fuse → retest → fixed; socket fine → engineer', () => {
    const f = run('fuse');
    expect(f.rules).toEqual(['FP11:power-supply', 'FP6:retest', 'FP7:power-supply']);
    expect(f.actions[0].action.requires).toEqual(['no_live_electrical_checks']);
    expect(run('socketOk').last).toMatchObject({ target: 'mains-or-control-dead', conclusion: { handoff: 'engineer', noPart: true } });
    expect(H.play(J, [dead()]).last).toMatchObject({ target: 'noPower', requires: ['ff_food_safety'] });
  });
  it('LIGHTS BUT NOT RUNNING → listen only → control / start side (engineer)', () => {
    const r = run('lightsSilent');
    expect(r.rules).toEqual(['FP10:noPower', 'FP12:ffCompressorState', 'FP22:lights-on-not-running']);
    expect(r.actions[1].action.requires).toEqual(['ff_listen_only']);
  });
  it('CLICK-START → coils / space → start relay or compressor: engineer, never a part even with model + parts listed', () => {
    const r = run('clicks');
    expect(r.prep.entry.applies).toBe(true);
    expect(r.last).toMatchObject({ kind: 'conclude', target: 'click-start-relay-or-compressor', conclusion: { handoff: 'engineer', noPart: true } });
    expect(run('clicksCoils').last.rule).toBe('FP7');
  });
  it('RUNNING BUT NOT COOLING → sealed system (engineer), no part', () => { expect(run('running').last).toMatchObject({ target: 'running-not-cooling', conclusion: { noPart: true } }); });
  it('a trip alone (derived trips-electrics journey) is owned here → safety stop', () => {
    const r = H.play(J, [C({ identity: H.FFI, intent: 'report_fault', safety: { hazard: 'supply_trip' } })]);
    expect(r.prep.entry.applies).toBe(true);
    expect(r.last).toMatchObject({ kind: 'safety_stop', rule: 'FP1' });
  });
  it('a trip or burning smell is a sticky safety stop (no reset loop)', () => {
    expect(run('trip').last).toMatchObject({ kind: 'safety_stop', rule: 'FP1' });
    expect(run('burning').last).toMatchObject({ kind: 'safety_stop', target: 'burning' });
  });
});
describe('COMPOSE contract', () => {
  it('every action reached obeys the contract; no live compressor / mains testing', () => {
    expect(H.composeProblems(J, J.P, Object.keys(SEQ).flatMap((k) => run(k).actions))).toEqual([]);
    expect(JSON.stringify({ T: J.TASK })).not.toMatch(/multimeter|test the (compressor|relay|plug)|remove the (back|rear) (panel|cover)|shake the relay/i);
  });
});
afterEach(() => { delete process.env.CANONICAL_FF7_CONTROL; });
describe('routing / gate', () => {
  it('dead / clicking / silent on a not-cooling report owned here; dishwasher dead unchanged; kill switch', async () => {
    const all = ['ff-not-running-dead', 'ff-not-cooling', 'dw-door-not-starting'];
    expect(await H.ownerOf(L, [dead([O('noPower')])], all)).toBe('ff-not-running-dead');
    expect(await H.ownerOf(L, [dead([O('compressorRuns', false)], 'not-cooling')], all)).toBe('ff-not-running-dead');
    expect(await H.ownerOf(L, [H.dwOpener('wont-start', 'power', [O('noPower')])], all)).toBe('dw-door-not-starting');
    process.env.CANONICAL_FF7_CONTROL = '0';
    expect((await H.routeWith(L, [dead([O('noPower')])], all)).journey.control).toBe(false);
  });
});
