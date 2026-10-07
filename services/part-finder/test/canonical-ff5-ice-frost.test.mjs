/** Fridge / freezer journey 5 (ff-ice-frost-build-up): one-off vs recurring, door / drain / defrost, part gate, COMPOSE, ownership. */
import { describe, it, expect, afterEach } from 'vitest';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
globalThis.awslambda = globalThis.awslambda || { streamifyResponse: (f) => f, HttpResponseStream: { from: (s) => s } };
const H = require('./helpers/b2-journey.cjs');
const J = require('../canonical/ff5-ice-frost.js');
const L = require('../part-finder-lambda.js')._internal;
const { C, O, K } = H;

const ice = (obs = [], journey = 'ice-build-up') => H.ffOpener(journey, 'cooling', obs);
const m = () => H.model('FF200DP', 'hotpoint');
const SEQ = {
  oneOff: [ice([O('heavyIce'), O('doorLeftOpen')])],
  backWallRecurs: [ice([O('heavyIce'), O('frostOnBackWall')]), C({ observations: [O('doorLeftOpen', false)] }), C({ checks: [K('defrost', 'done', 'found_and_cleared')] }),
    C({ observations: [O('faultPersists', true)] }), C({ checks: [K('door-seal', 'done', 'clear')] })],
  defrostOk: [ice([O('heavyIce'), O('frostOnBackWall'), O('doorLeftOpen', false)]), C({ checks: [K('defrost', 'done', 'found_and_cleared')] }), C({ observations: [O('iceReturns', false)] })],
  nearDoorTorn: [ice([O('frostNearDoor')]), C({ observations: [O('doorLeftOpen', false)] }), C({ checks: [K('door-seal', 'done', 'fault_seen')] }), m()],
  base: [ice([O('iceInBase'), O('doorLeftOpen', false)]), C({ checks: [K('defrost-drain', 'done', 'found_not_cleared')] })],
  warmFrost: [ice([O('heavyIce'), O('frostOnBackWall'), O('iceReturns'), O('doorLeftOpen', false)], 'not-cooling'), C({ checks: [K('door-seal', 'done', 'clear')] })],
  defrostCode: [H.ffOpener('error-code-only', 'controls', [], {}, { make: { value: 'hotpoint', basis: 'stated' }, displayedCode: 'F06' })],
};
const run = (k) => H.play(J, SEQ[k], { modelParts: [{ title: 'Fridge Door Seal' }] });

describe('policy / diagnostics', () => {
  it('one-off frost after the door was left open → full defrost advice, no part (early)', () => {
    expect(run('oneOff').last).toMatchObject({ rule: 'FI5', target: 'one-off-door-or-loading', conclusion: { noPart: true } });
  });
  it('back-wall frost returning after a full defrost (door shut, seal fine) → defrost system, engineer, no part', () => {
    const r = run('backWallRecurs');
    expect(r.rules).toEqual(['FI11:doorLeftOpen', 'FI14:defrost', 'FI6:retest', 'FI12:door-seal', 'FI22:defrost-system']);
    expect(r.actions[1].action.requires).toEqual(['unplug_fridge', 'ff_defrost_towels', 'no_sharp_tools_on_ice', 'no_panel_removal']);
    expect(r.last.conclusion).toMatchObject({ handoff: 'engineer', noPart: true });
  });
  it('"I\'ve done a full defrost" with no stated result still counts as the defrost → retest', () => {
    const r = H.play(J, [ice([O('heavyIce'), O('frostOnBackWall'), O('doorLeftOpen', false)]), C({ checks: [K('defrost', 'done', null)] }), C({ observations: [O('faultPersists', true)] })]);
    expect(r.rules).toEqual(['FI14:defrost', 'FI6:retest', 'FI12:door-seal']);
  });
  it('frost not back after the defrost → one-off, likely fixed', () => { expect(run('defrostOk').last).toMatchObject({ rule: 'FI7', target: 'one-off-door-or-loading' }); });
  it('frost round the door + torn seal + model → gasket part', () => { expect(run('nearDoorTorn').last).toMatchObject({ kind: 'recommend_part', target: 'door-seal' }); });
  it('ice in the base with the drain stuck → engineer (no chipping, no panels)', () => {
    expect(run('base').last).toMatchObject({ target: 'blocked-defrost-drain', conclusion: { handoff: 'engineer', noPart: true } });
  });
  it('warm + heavy frost is owned here (one owner); a defrost code is evidence only', () => {
    expect(run('warmFrost').prep.entry.applies).toBe(true);
    expect(run('warmFrost').last.target).toBe('defrost-system');
    const d = run('defrostCode');
    expect(d.prep.entry.applies).toBe(true);
    expect(d.last.kind).toBe('ask_observation');
  });
});
describe('COMPOSE contract', () => {
  it('every action reached obeys the contract; no sharp tools, no evaporator dismantling', () => {
    expect(H.composeProblems(J, J.P, Object.keys(SEQ).flatMap((k) => run(k).actions))).toEqual([]);
    expect(JSON.stringify(J.TASK)).not.toMatch(/hair ?dryer|knife|screwdriver|remove the (back|evaporator) (panel|cover)/i);
  });
});
afterEach(() => { delete process.env.CANONICAL_FF5_CONTROL; });
describe('routing / gate', () => {
  it('ice report here; not-cooling + heavy ice here; kill switch', async () => {
    const all = ['ff-ice-frost-build-up', 'ff-not-cooling', 'ff-leaking-water'];
    expect(await H.ownerOf(L, [ice([O('heavyIce')])], all)).toBe('ff-ice-frost-build-up');
    expect(await H.ownerOf(L, [ice([O('heavyIce')], 'not-cooling')], all)).toBe('ff-ice-frost-build-up');
    process.env.CANONICAL_FF5_CONTROL = '0';
    expect((await H.routeWith(L, [ice([O('heavyIce')])], all)).journey.control).toBe(false);
  });
});
