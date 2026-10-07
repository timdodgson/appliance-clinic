/** Tumble dryer journey 4 (td-noisy): typed noise, roller part gate, never motor / bearing from generic noisy, routing. */
import { describe, it, expect, afterEach } from 'vitest';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
globalThis.awslambda = globalThis.awslambda || { streamifyResponse: (f) => f, HttpResponseStream: { from: (s) => s } };
const H = require('./helpers/b2-journey.cjs');
const J = require('../canonical/td4-noisy.js');
const L = require('../part-finder-lambda.js')._internal;
const { C, O, K } = H;

const noisy = (obs = []) => H.tdOpener('noisy', 'noise', obs);
const SEQ = {
  coin: [noisy([O('rattlingNoise')]), C({ checks: [K('drum-foreign-object', 'done', 'found_and_cleared')] }), C({ observations: [O('faultPersists', false)] })],
  stuck: [noisy([O('knockingNoise')]), C({ checks: [K('drum-foreign-object', 'done', 'found_not_cleared')] })],
  roller: [noisy([O('squealNoise')]), C({ checks: [K('drum-by-hand', 'done', 'fault_seen')] }), H.model('DCU7230', 'beko')],
  smooth: [noisy([O('grindingNoise')]), C({ checks: [K('drum-by-hand', 'done', 'clear')] })],
  hum: [noisy([O('humNoise')]), C({ observations: [O('dryerHeatPump')] })],
  generic: [noisy(), C({ reply: { toPending: 'cannot_answer' } }), C({ reply: { toPending: 'cannot_answer' } })],
};
const run = (k, mp = [{ title: 'Roller Assembly' }, { title: 'Dryer Motor Unit' }]) => H.play(J, SEQ[k], { modelParts: mp });

describe('policy / part gate', () => {
  it('rattle → loose item found → retest → fixed; stuck out of reach → engineer', () => {
    expect(run('coin').rules).toEqual(['DN11:drum-foreign-object', 'DN6:retest', 'DN7:foreign-object']);
    expect(run('stuck').last).toMatchObject({ kind: 'conclude', target: 'object-out-of-reach', conclusion: { handoff: 'engineer' } });
  });
  it('squeal + rough by hand + model → roller / idler part', () => { expect(run('roller').rules).toEqual(['DN12:drum-by-hand', 'DN20:model', 'DN21:drum-roller']); });
  it('grind but smooth by hand → drive area (engineer), no part; hum on a heat pump → normal', () => {
    expect(run('smooth').last).toMatchObject({ target: 'drive-area', conclusion: { noPart: true } });
    expect(run('hum').last).toMatchObject({ target: 'normal-pump-or-compressor-hum', conclusion: { noPart: true } });
  });
  it('generic "noisy" never concludes motor / bearing and never recommends a part', () => {
    const r = run('generic');
    expect(r.rules[0]).toBe('DN10:noiseType');
    expect(r.actions.some((a) => a.action.kind === 'recommend_part')).toBe(false);
    expect(JSON.stringify(r.last.conclusion || {})).not.toMatch(/motor|bearing/);
  });
});
describe('COMPOSE contract', () => {
  it('every action reached obeys the contract', () => { expect(H.composeProblems(J, J.P, Object.keys(SEQ).flatMap((k) => run(k).actions))).toEqual([]); });
});
afterEach(() => { delete process.env.CANONICAL_TD4_CONTROL; });
describe('routing / gate', () => {
  it('dryer noise here; washing machine and fridge noise elsewhere; kill switch', async () => {
    const all = ['td-noisy', 'wm-noisy', 'ff-noisy'];
    expect(await H.ownerOf(L, [noisy([O('squealNoise')])], all)).toBe('td-noisy');
    expect(await H.ownerOf(L, [H.ffOpener('noisy', 'noise', [O('humNoise')])], all)).toBe('ff-noisy');
    process.env.CANONICAL_TD4_CONTROL = '0';
    expect((await H.routeWith(L, [noisy([O('squealNoise')])], all)).journey.control).toBe(false);
  });
});
