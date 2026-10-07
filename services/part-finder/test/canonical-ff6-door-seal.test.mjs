/** Fridge / freezer journey 6 (ff-door-seal-door): obstruction / seal / hinge, gasket & hinge gates, COMPOSE, routing. */
import { describe, it, expect, afterEach } from 'vitest';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
globalThis.awslambda = globalThis.awslambda || { streamifyResponse: (f) => f, HttpResponseStream: { from: (s) => s } };
const H = require('./helpers/b2-journey.cjs');
const J = require('../canonical/ff6-door-seal.js');
const L = require('../part-finder-lambda.js')._internal;
const { C, O, K } = H;

const door = (obs = [O('doorNotSeating')]) => H.ffOpener('door-problem', 'door', obs);
const m = () => H.model('FF200DP', 'hotpoint');
const SEQ = {
  obstruction: [door(), C({ checks: [K('ff-door-fit', 'done', 'found_and_cleared')] }), C({ observations: [O('faultPersists', false)] })],
  hinge: [door(), C({ checks: [K('ff-door-fit', 'done', 'fault_seen')] }), m()],
  sealTorn: [door(), C({ checks: [K('ff-door-fit', 'done', 'clear')] }), C({ checks: [K('door-seal', 'done', 'fault_seen')] }), m()],
  sealTornNoModel: [door(), C({ checks: [K('ff-door-fit', 'done', 'clear')] }), C({ checks: [K('door-seal', 'done', 'fault_seen')] }), H.noModel()],
  allFine: [H.ffOpener('not-cooling', 'cooling', [O('doorNotSeating')]), C({ checks: [K('ff-door-fit', 'done', 'clear')] }), C({ checks: [K('door-seal', 'done', 'clear')] }), m()],
};
const run = (k, mp = [{ title: 'Lower Hinge' }]) => H.play(J, SEQ[k], { modelParts: mp });

describe('policy / part gate', () => {
  it('obstruction / levelling first → fixed → retest → no part', () => { expect(run('obstruction').rules).toEqual(['FD10:ff-door-fit', 'FD6:retest', 'FD7:door-obstruction-or-level']); });
  it('hinge broken (owner seen) + model + part on the model → hinge', () => { expect(run('hinge').rules).toEqual(['FD10:ff-door-fit', 'FD20:model', 'FD21:door-hinge']); });
  it('seal torn + model but no gasket on the model list → component conclusion, no part; no model → no part', () => {
    expect(run('sealTorn').last).toMatchObject({ kind: 'conclude', conclusion: { component: 'door-seal' } });
    expect(run('sealTorn', [{ title: 'Fridge Door Gasket' }]).last).toMatchObject({ kind: 'recommend_part', target: 'door-seal' });
    expect(run('sealTornNoModel').last.kind).toBe('conclude');
  });
  it('warm + door not sealing but door and seal fine → no gasket ever (door closes fine)', () => {
    const r = run('allFine', [{ title: 'Fridge Door Gasket' }]);
    expect(r.prep.entry.applies).toBe(true);
    expect(r.last).toMatchObject({ kind: 'conclude', target: 'door-closes-fine', conclusion: { noPart: true } });
    expect(r.actions.some((a) => a.action.kind === 'recommend_part')).toBe(false);
  });
});
describe('COMPOSE contract', () => {
  it('every action reached obeys the contract', () => { expect(H.composeProblems(J, J.P, Object.keys(SEQ).flatMap((k) => run(k).actions))).toEqual([]); });
});
afterEach(() => { delete process.env.CANONICAL_FF6_CONTROL; });
describe('routing / gate', () => {
  it('fridge door here; washing-machine / dishwasher doors unchanged; kill switch', async () => {
    const all = ['ff-door-seal-door', 'wm-door', 'dw-door-not-starting'];
    expect(await H.ownerOf(L, [door()], all)).toBe('ff-door-seal-door');
    expect(await H.ownerOf(L, [H.opener('door-problem', 'door', [O('doorOpens', false)])], all)).toBe('wm-door');
    expect(await H.ownerOf(L, [H.dwOpener('door-problem', 'door', [O('doorRecognised', false)])], all)).toBe('dw-door-not-starting');
    process.env.CANONICAL_FF6_CONTROL = '0';
    expect((await H.routeWith(L, [door()], all)).journey.control).toBe(false);
  });
});
