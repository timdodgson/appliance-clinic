/** Fridge / freezer journey 2 (ff-too-cold-freezing): diagnostics, policy, no part ever, COMPOSE contract, routing. */
import { describe, it, expect, afterEach } from 'vitest';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
globalThis.awslambda = globalThis.awslambda || { streamifyResponse: (f) => f, HttpResponseStream: { from: (s) => s } };
const H = require('./helpers/b2-journey.cjs');
const J = require('../canonical/ff2-too-cold.js');
const L = require('../part-finder-lambda.js')._internal;
const { C, O, K } = H;

const cold = (obs = [], extra = {}) => H.ffOpener('over-cooling', 'cooling', obs, extra);
const ok = (c) => C({ checks: [K(c, 'done', 'clear')] });
const SEQ = {
  fastFreeze: [cold(), C({ checks: [K('temp-setting', 'done', 'found_and_cleared')] }), C({ observations: [O('faultPersists', false)] })],
  backWall: [cold([], { scope: 'fridge_only' }), ok('temp-setting'), C({ checks: [K('vents-clear', 'done', 'found_and_cleared')] }), C({ observations: [O('faultPersists', false)] })],
  garage: [cold(), ok('temp-setting'), ok('vents-clear'), C({ observations: [O('inColdOrHotLocation')] })],
  allFine: [cold(), ok('temp-setting'), ok('vents-clear'), C({ observations: [O('inColdOrHotLocation', false)] }), H.model('FF200DP', 'hotpoint')],
  vague: [cold(), C({ reply: { toPending: 'cannot_answer' } }), C({ reply: { toPending: 'cannot_answer' } }), C({ reply: { toPending: 'cannot_answer' } })],
};
const run = (k) => H.play(J, SEQ[k], { modelParts: [{ title: 'Fridge Stat' }, { title: 'Fridge Temperature Control Unit' }] });

describe('policy / diagnostics', () => {
  it('settings first: fast-freeze left on → retest → likely fixed', () => { expect(run('fastFreeze').rules).toEqual(['FX10:temp-setting', 'FX6:retest', 'FX7:temperature-setting']); });
  it('food against the back wall (fridge) → moved → likely fixed', () => { expect(run('backWall').last).toMatchObject({ rule: 'FX7', target: 'food-against-back-wall' }); });
  it('very cold room → install, no part', () => { expect(run('garage').last).toMatchObject({ target: 'room-temperature-location', conclusion: { handoff: 'install', noPart: true } }); });
  it('all fine → thermostat / sensor / damper (engineer), never a part even with a model and parts listed', () => {
    const r = run('allFine');
    expect(r.last).toMatchObject({ kind: 'conclude', target: 'thermostat-sensor-or-damper', conclusion: { handoff: 'engineer', noPart: true } });
    expect(Object.keys(run('vague').actions.concat(r.actions).filter((a) => a.action.kind === 'recommend_part'))).toEqual([]);
    expect(r.rules.some((x) => /model/.test(x))).toBe(false);
  });
});
describe('COMPOSE contract', () => {
  it('every action reached obeys the contract', () => {
    expect(H.composeProblems(J, J.P, Object.keys(SEQ).flatMap((k) => run(k).actions))).toEqual([]);
  });
});
afterEach(() => { delete process.env.CANONICAL_FF2_CONTROL; });
describe('routing / gate', () => {
  it('own gate; a dishwasher / oven never routes here; kill switch', async () => {
    const all = ['ff-too-cold-freezing', 'ff-not-cooling'];
    expect(await H.ownerOf(L, [cold()], all)).toBe('ff-too-cold-freezing');
    expect(await H.ownerOf(L, [H.opener('over-cooling', 'cooling', [], {}, { appliance: { value: 'oven-cooker', basis: 'stated' } })], all)).toBe(null);
    process.env.CANONICAL_FF2_CONTROL = '0';
    expect((await H.routeWith(L, [cold()], all)).journey.control).toBe(false);
  });
});
