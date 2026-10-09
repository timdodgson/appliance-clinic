/** Tumble dryer journey 2 (td-not-drying): hot-but-damp is airflow / load / sensing (never the heater), filter part gate, routing. */
import { describe, it, expect, afterEach } from 'vitest';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
globalThis.awslambda = globalThis.awslambda || { streamifyResponse: (f) => f, HttpResponseStream: { from: (s) => s } };
const H = require('./helpers/b2-journey.cjs');
const J = require('../canonical/td2-not-drying.js');
const L = require('../part-finder-lambda.js')._internal;
const { C, O, K } = H;

const damp = (obs = [O('heatPresent')]) => H.tdOpener('not-drying', 'drying', obs);
const ok = (c) => C({ checks: [K(c, 'done', 'clear')] });
const m = () => H.model('TCFS83BGPUK', 'hotpoint');
const SEQ = {
  condenser: [damp([O('heatPresent'), O('dryerCondenser')]), ok('lint-filter'), ok('load-check'), C({ checks: [K('condenser', 'done', 'found_and_cleared')] }), C({ observations: [O('faultPersists', false)] })],
  vented: [damp([O('heatPresent'), O('dryerVented')]), ok('lint-filter'), ok('load-check'), C({ checks: [K('vent-duct', 'done', 'found_and_cleared')] }), C({ observations: [O('faultPersists', false)] })],
  sensor: [damp([O('heatPresent'), O('dryerHeatPump')]), ok('lint-filter'), ok('load-check'), ok('condenser'), C({ checks: [K('sensor-bars', 'done', 'found_and_cleared')] }), C({ observations: [O('faultPersists', false)] })],
  allFine: [damp([O('heatPresent'), O('dryerCondenser')]), ok('lint-filter'), ok('load-check'), ok('condenser'), ok('sensor-bars'), ok('programme-setting'), m()],
  torn: [damp([O('heatPresent'), O('dryerCondenser')]), C({ checks: [K('lint-filter', 'done', 'fault_seen')] }), m()],
};
const run = (k, mp = [{ title: 'Fluff Filter' }, { title: 'Heater Element 2050W' }]) => H.play(J, SEQ[k], { modelParts: mp });

describe('policy / diagnostics', () => {
  it('condenser dryer: filter → load → condenser (never the vent hose) → retest → fixed', () => {
    expect(run('condenser').rules).toEqual(['DD12:lint-filter', 'DD13:load-check', 'DD14:condenser', 'DD6:retest', 'DD7:condenser-blocked']);
  });
  it('vented dryer: vent hose (never the condenser)', () => {
    const r = run('vented');
    expect(r.rules).toEqual(['DD12:lint-filter', 'DD13:load-check', 'DD15:vent-duct', 'DD6:retest', 'DD7:vent-hose-restricted']);
  });
  it('heat pump: condenser / second filter then sensor strips', () => { expect(run('sensor').last).toMatchObject({ rule: 'DD7', target: 'moisture-sensor-strips' }); });
  it('hot, all owner checks fine → internal airflow (engineer), never the heater even with a heater on the model list', () => {
    const r = run('allFine');
    expect(r.last).toMatchObject({ kind: 'conclude', target: 'drying-airflow-system', conclusion: { noPart: true } });
    expect(Object.values(J.FAMILY)).not.toContain('heater');
    expect(r.actions.some((a) => a.action.kind === 'recommend_part')).toBe(false);
  });
  it('damp, heat not yet known → the fluff filter first, then the dryer type, then whether it heats', () => {
    expect(H.play(J, [damp([])]).rules).toEqual(['DD12:lint-filter']);
    expect(H.play(J, [damp([]), ok('lint-filter')]).rules).toEqual(['DD12:lint-filter', 'DD11:dryerType']);
  });
  it('torn lint filter (owner seen) + model → filter part', () => { expect(run('torn').rules).toEqual(['DD12:lint-filter', 'DD20:model', 'DD21:lint-filter']); });
});
describe('COMPOSE contract', () => {
  it('every action reached obeys the contract', () => { expect(H.composeProblems(J, J.P, Object.keys(SEQ).flatMap((k) => run(k).actions))).toEqual([]); });
});
afterEach(() => { delete process.env.CANONICAL_TD2_CONTROL; });
describe('routing / gate', () => {
  it('hot + not drying here; dishwasher not drying unchanged; kill switch', async () => {
    const all = ['td-not-drying', 'td-not-heating', 'dw-not-heating-drying'];
    expect(await H.ownerOf(L, [damp()], all)).toBe('td-not-drying');
    expect(await H.ownerOf(L, [H.dwOpener('not-drying', 'drying', [O('dishesWet')])], all)).toBe('dw-not-heating-drying');
    process.env.CANONICAL_TD2_CONTROL = '0';
    expect((await H.routeWith(L, [damp()], all)).journey.control).toBe(false);
  });
});
