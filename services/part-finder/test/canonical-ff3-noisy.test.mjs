/** Fridge / freezer journey 3 (ff-noisy): sound / source / door-open / cycle typing, part gate, COMPOSE contract, routing. */
import { describe, it, expect, afterEach } from 'vitest';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
globalThis.awslambda = globalThis.awslambda || { streamifyResponse: (f) => f, HttpResponseStream: { from: (s) => s } };
const H = require('./helpers/b2-journey.cjs');
const J = require('../canonical/ff3-noisy.js');
const L = require('../part-finder-lambda.js')._internal;
const { C, O, K } = H;

const noisy = (obs = []) => H.ffOpener('noisy', 'noise', obs);
const m = () => H.model('FF200DP', 'hotpoint');
const SEQ = {
  gurgle: [noisy([O('gurglingNoise')])],
  fan: [noisy([O('squealNoise')]), C({ observations: [O('noiseFromInside')] }), C({ observations: [O('noiseStopsWhenDoorOpen')] }), m()],
  fanNoModel: [noisy([O('grindingNoise'), O('noiseFromInside'), O('noiseStopsWhenDoorOpen')]), H.noModel()],
  insideNoStop: [noisy([O('squealNoise'), O('noiseFromInside')]), C({ observations: [O('noiseStopsWhenDoorOpen', false)] })],
  rattle: [noisy([O('rattlingNoise')]), C({ observations: [O('noiseFromInside', false)] }), C({ observations: [O('runsConstantly', false)] }), C({ checks: [K('ff-clearance', 'done', 'found_and_cleared')] }), C({ observations: [O('faultPersists', false)] })],
  backBuzz: [noisy([O('humNoise'), O('noiseFromInside', false)]), C({ observations: [O('runsConstantly', false)] }), C({ checks: [K('ff-clearance', 'done', 'clear')] }), C({ checks: [K('condenser-coil-clear', 'done', 'clear')] })],
  generic: [noisy(), C({ reply: { toPending: 'cannot_answer' } }), C({ reply: { toPending: 'cannot_answer' } })],
};
const run = (k, mp = [{ title: 'Fridge Fan Motor' }]) => H.play(J, SEQ[k], { modelParts: mp });

describe('typing and policy', () => {
  it('gurgling / cracking alone → normal, said once, no part (early)', () => { expect(run('gurgle').last).toMatchObject({ rule: 'FN5', target: 'normal-operating-noise', conclusion: { noPart: true } }); });
  it('generic "noisy" asks the sound first and never concludes a fan / compressor part', () => {
    const r = run('generic');
    expect(r.rules[0]).toBe('FN10:noiseType');
    expect(r.actions.some((a) => a.action.kind === 'recommend_part')).toBe(false);
  });
  it('inside + squeal + stops with the door open → internal fan → model → part', () => {
    expect(run('fan').rules).toEqual(['FN11:noiseFromInside', 'FN12:noiseStopsWhenDoorOpen', 'FN20:model', 'FN21:evaporator-fan']);
  });
  it('fan evidence without a model → component conclusion, no part; inside but not stopping with the door → no fan component', () => {
    expect(run('fanNoModel').last).toMatchObject({ kind: 'conclude', conclusion: { component: 'evaporator-fan' } });
    expect(run('insideNoStop').prep.diag.leader.component).toBe(null);
  });
  it('rattle from the back → clearance (owner fix) → retest → fixed', () => {
    expect(run('rattle').rules).toEqual(['FN11:noiseFromInside', 'FN13:runsConstantly', 'FN14:ff-clearance', 'FN6:retest', 'FN7:touching-or-loose-at-back']);
  });
  it('back buzz with everything clear → condenser fan / compressor area (engineer), no part', () => {
    expect(run('backBuzz').last).toMatchObject({ kind: 'conclude', target: 'condenser-fan-or-compressor-area', conclusion: { noPart: true, handoff: 'engineer' } });
  });
});
describe('COMPOSE contract', () => {
  it('every action reached obeys the contract', () => { expect(H.composeProblems(J, J.P, Object.keys(SEQ).flatMap((k) => run(k).actions))).toEqual([]); });
});
afterEach(() => { delete process.env.CANONICAL_FF3_CONTROL; });
describe('routing / gate', () => {
  it('fridge noise stays here; click-start → not-running; heavy ice → frost; washing-machine / dryer noise stay their own; kill switch', async () => {
    const all = ['ff-noisy', 'ff-not-running-dead', 'ff-ice-frost-build-up', 'wm-noisy', 'td-noisy'];
    expect(await H.ownerOf(L, [noisy([O('humNoise')])], all)).toBe('ff-noisy');
    expect(await H.ownerOf(L, [noisy([O('clicksNoStart')])], all)).toBe('ff-not-running-dead');
    expect(await H.ownerOf(L, [noisy([O('heavyIce')])], all)).toBe('ff-ice-frost-build-up');
    expect(await H.ownerOf(L, [H.opener('noisy', 'noise', [O('grindingNoise')])], all)).toBe('wm-noisy');
    expect(await H.ownerOf(L, [H.tdOpener('noisy', 'noise', [O('squealNoise')])], all)).toBe('td-noisy');
    process.env.CANONICAL_FF3_CONTROL = '0';
    expect((await H.routeWith(L, [noisy([O('humNoise')])], all)).journey.control).toBe(false);
  });
});
