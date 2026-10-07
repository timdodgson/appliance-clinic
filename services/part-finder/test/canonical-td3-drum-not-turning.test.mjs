/** Tumble dryer journey 3 (td-drum-not-turning): belt only with a compatible dryer model, never a motor part, routing. */
import { describe, it, expect, afterEach } from 'vitest';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
globalThis.awslambda = globalThis.awslambda || { streamifyResponse: (f) => f, HttpResponseStream: { from: (s) => s } };
const H = require('./helpers/b2-journey.cjs');
const J = require('../canonical/td3-drum-not-turning.js');
const L = require('../part-finder-lambda.js')._internal;
const { C, O, K } = H;

const still = (obs = []) => H.tdOpener('drum-not-turning', 'motion', obs);
const ok = (c) => C({ checks: [K(c, 'done', 'clear')] });
const SEQ = {
  belt: [still([O('motorAudible')]), ok('load-check'), C({ checks: [K('drum-by-hand', 'done', 'clear')], observations: [O('drumUnusuallyFree')] }), H.model('TVM560P', 'hotpoint')],
  beltNoModel: [still([O('motorAudible')]), ok('load-check'), C({ checks: [K('drum-by-hand', 'done', 'clear')], observations: [O('drumUnusuallyFree')] }), H.noModel()],
  beltReported: [still(), C({ checks: [K('drive-belt', 'done', 'fault_seen')] }), H.model('TCFS83BGPUK', 'hotpoint')],
  seized: [still([O('motorAudible')]), ok('load-check'), C({ checks: [K('drum-by-hand', 'done', 'fault_seen')] })],
  silent: [still([O('motorAudible', false)]), ok('load-check'), ok('drum-by-hand')],
  overload: [still([O('motorAudible')]), C({ checks: [K('load-check', 'done', 'found_and_cleared')] }), C({ observations: [O('faultPersists', false)] })],
};
const run = (k, mp = [{ title: '1860 9 Rib *This is extremely tight when fitting' }, { title: 'Drive Belt 1991 H8' }]) => H.play(J, SEQ[k], { modelParts: mp });

describe('policy / part gate', () => {
  it('motor runs + drum very free → belt → model → dryer belt part', () => {
    expect(run('belt').rules).toEqual(['DT11:load-check', 'DT12:drum-by-hand', 'DT20:model', 'DT21:drive-belt']);
    expect(run('belt').last.conclusion.component).toBe('drive-belt');
  });
  it('no model → no belt recommendation; a washing-machine belt on the list never matches', () => {
    expect(run('beltNoModel').last).toMatchObject({ kind: 'conclude', conclusion: { component: 'drive-belt' } });
    expect(J.partLookupFrom([{ title: 'Washing Machine Drive Belt 1270 J5' }], 'drive-belt').available).toBe(false);
    expect(run('belt', [{ title: 'Washing Machine Drive Belt 1270 J5' }]).last.kind).toBe('conclude');
  });
  it('owner reports the belt snapped → belt with model', () => { expect(run('beltReported').last).toMatchObject({ kind: 'recommend_part', target: 'drive-belt' }); });
  it('stiff by hand → rollers / bearing (engineer); silent motor → motor / control (engineer, never a motor part)', () => {
    expect(run('seized').last).toMatchObject({ target: 'drum-seized-rollers-or-bearing', conclusion: { noPart: true } });
    expect(run('silent').last).toMatchObject({ target: 'motor-or-control', conclusion: { noPart: true, handoff: 'engineer' } });
  });
  it('"spins very easily" outranks a by-hand result mis-recorded as a fault in the same reply', () => {
    const r = H.play(J, [still([O('motorAudible')]), ok('load-check'), C({ checks: [K('drum-by-hand', 'done', 'fault_seen')], observations: [O('drumUnusuallyFree')] }), H.model('TVM560P', 'hotpoint')],
      { modelParts: [{ title: '1860 9 Rib *This is extremely tight when fitting' }] });
    expect(r.rules).toEqual(['DT11:load-check', 'DT12:drum-by-hand', 'DT20:model', 'DT21:drive-belt']);
  });
  it('overload fixed → retest → no part', () => { expect(run('overload').last.rule).toBe('DT7'); });
});
describe('COMPOSE contract', () => {
  it('every action reached obeys the contract', () => { expect(H.composeProblems(J, J.P, Object.keys(SEQ).flatMap((k) => run(k).actions))).toEqual([]); });
});
afterEach(() => { delete process.env.CANONICAL_TD3_CONTROL; });
describe('routing / gate', () => {
  it('drum not turning here; door not recognised → door / start; washing-machine drum stays WM; kill switch', async () => {
    const all = ['td-drum-not-turning', 'td-door-not-starting', 'wm-not-spinning'];
    expect(await H.ownerOf(L, [still()], all)).toBe('td-drum-not-turning');
    expect(await H.ownerOf(L, [still([O('doorRecognised', false)])], all)).toBe('td-door-not-starting');
    process.env.CANONICAL_TD3_CONTROL = '0';
    expect((await H.routeWith(L, [still()], all)).journey.control).toBe(false);
  });
});
