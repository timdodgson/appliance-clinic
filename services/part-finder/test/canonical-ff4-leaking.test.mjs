/** Fridge / freezer journey 4 (ff-leaking-water): inside vs under vs supply line, part gate, containment, COMPOSE, routing. */
import { describe, it, expect, afterEach } from 'vitest';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
globalThis.awslambda = globalThis.awslambda || { streamifyResponse: (f) => f, HttpResponseStream: { from: (s) => s } };
const H = require('./helpers/b2-journey.cjs');
const J = require('../canonical/ff4-leaking.js');
const L = require('../part-finder-lambda.js')._internal;
const { C, O, K } = H;

const leak = (obs = []) => H.ffOpener('leaking', 'water', obs);
const m = () => H.model('FF200DP', 'hotpoint');
const SEQ = {
  insideDrain: [leak([O('waterInsideFridge')]), C({ checks: [K('defrost-drain', 'done', 'found_and_cleared')] }), C({ observations: [O('faultPersists', false)] })],
  insideStuck: [leak([O('waterInsideFridge')]), C({ checks: [K('defrost-drain', 'done', 'found_not_cleared')] })],
  condensation: [leak([O('waterInsideFridge')]), C({ checks: [K('defrost-drain', 'done', 'clear')] }), C({ observations: [O('doorLeftOpen')] })],
  underTray: [leak(), C({ observations: [O('leakUnderneath')] }), C({ checks: [K('drip-tray', 'done', 'fault_seen')] }), m()],
  underRefit: [leak([O('leakUnderneath')]), C({ checks: [K('drip-tray', 'done', 'found_and_cleared')] }), C({ observations: [O('faultPersists', false)] })],
  supplyLoose: [leak([O('leakFromSupplyLine')]), C({ checks: [K('inlet-connection', 'done', 'found_and_cleared')] }), C({ observations: [O('faultPersists', false)] })],
  supplyDamaged: [leak([O('leakFromSupplyLine')]), C({ checks: [K('inlet-connection', 'done', 'fault_seen')] }), m()],
  supplyFlood: [leak([O('leakFromSupplyLine'), O('majorLeak')])],
  wetSocket: [leak([O('leakUnderneath')]), C({ safety: { hazard: 'electrical_water' } })],
};
const run = (k) => H.play(J, SEQ[k], { modelParts: [{ title: 'Drip Tray' }, { title: 'Water Supply Hose' }] });

describe('policy / diagnostics', () => {
  it('INSIDE → defrost drain hole → cleared → retest → fixed; stuck → engineer (no sharp tools)', () => {
    expect(run('insideDrain').rules).toEqual(['FL11:defrost-drain', 'FL6:retest', 'FL7:blocked-defrost-drain']);
    expect(run('insideDrain').actions[0].action.requires).toEqual(['no_sharp_tools_on_ice']);
    expect(run('insideStuck').last).toMatchObject({ kind: 'conclude', target: 'blocked-defrost-drain', conclusion: { handoff: 'engineer', noPart: true } });
  });
  it('inside with the drain clear + door left open → condensation (no part)', () => { expect(run('condensation').last).toMatchObject({ target: 'condensation-door-or-warm-food', conclusion: { noPart: true } }); });
  it('location asked first when not stated; UNDER → drip tray (unplug, hot compressor) → cracked + model → tray part', () => {
    const r = run('underTray');
    expect(r.rules).toEqual(['FL10:ffLeakLocation', 'FL14:drip-tray', 'FL20:model', 'FL21:drip-tray']);
    expect(r.actions[1].action.requires).toEqual(['unplug_fridge', 'ff_hot_compressor', 'no_refrigerant_work']);
    expect(run('underRefit').last.rule).toBe('FL7');
  });
  it('SUPPLY LINE → connection (tap off, hand-tight); damaged → plumbing, no fridge part', () => {
    expect(run('supplyLoose').rules).toEqual(['FL13:inlet-connection', 'FL6:retest', 'FL7:water-supply-line']);
    expect(run('supplyLoose').actions[0].action.requires).toEqual(['water_off_at_tap', 'hand_tight_only']);
    expect(run('supplyDamaged').last).toMatchObject({ kind: 'conclude', target: 'water-supply-line', conclusion: { handoff: 'plumbing', noPart: true } });
  });
  it('a large supply leak → stop the water first; water near the socket → sticky safety stop', () => {
    expect(run('supplyFlood').last).toMatchObject({ kind: 'safety_stop', target: 'major-leak' });
    expect(run('wetSocket').last).toMatchObject({ kind: 'safety_stop', target: 'electrical_water' });
  });
});
describe('COMPOSE contract', () => {
  it('every action reached obeys the contract', () => { expect(H.composeProblems(J, J.P, Object.keys(SEQ).flatMap((k) => run(k).actions))).toEqual([]); });
});
afterEach(() => { delete process.env.CANONICAL_FF4_CONTROL; });
describe('routing / gate', () => {
  it('fridge leak here; leak + heavy ice → frost (supply-line leak stays here); dishwasher / washer leaks unchanged; kill switch', async () => {
    const all = ['ff-leaking-water', 'ff-ice-frost-build-up', 'dw-leaking', 'wm-leaking'];
    expect(await H.ownerOf(L, [leak([O('leakUnderneath')])], all)).toBe('ff-leaking-water');
    expect(await H.ownerOf(L, [leak([O('waterInsideFridge'), O('heavyIce')])], all)).toBe('ff-ice-frost-build-up');
    expect(await H.ownerOf(L, [leak([O('leakFromSupplyLine'), O('heavyIce')])], all)).toBe('ff-leaking-water');
    expect(await H.ownerOf(L, [H.dwOpener('leaking', 'water', [O('leakUnderneath')])], all)).toBe('dw-leaking');
    expect(await H.ownerOf(L, [H.opener('leaking', 'water', [O('leakAtDoor')])], all)).toBe('wm-leaking');
    process.env.CANONICAL_FF4_CONTROL = '0';
    expect((await H.routeWith(L, [leak([O('leakUnderneath')])], all)).journey.control).toBe(false);
  });
});
