/** Tumble dryer journey 1 (td-not-heating): technology-aware airflow / heater path, heat-pump heater block, COMPOSE, routing. */
import { describe, it, expect, afterEach } from 'vitest';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
globalThis.awslambda = globalThis.awslambda || { streamifyResponse: (f) => f, HttpResponseStream: { from: (s) => s } };
const H = require('./helpers/b2-journey.cjs');
const J = require('../canonical/td1-not-heating.js');
const L = require('../part-finder-lambda.js')._internal;
const { C, O, K } = H;

const HOT = { make: { value: 'hotpoint', basis: 'stated' }, displayedCode: 'F04' };
const cold = (obs = [O('noHeat')], id = {}) => H.tdOpener('no-heat', 'heat', obs, {}, id);
const ok = (c) => C({ checks: [K(c, 'done', 'clear')] });
const m = (x = 'TCFS83BGPUK') => H.model(x, 'hotpoint');
const MP_C = [{ title: 'Heater Element 2050W' }, { title: 'Tumble Dryer Float Now Black' }];
const MP_HP = [{ title: 'Heat Pump Compressor' }, { title: 'Heater Element 2050W' }];
const SEQ = {
  filter: [cold([O('noHeat'), O('dryerCondenser')]), ok('programme-setting'), C({ checks: [K('lint-filter', 'done', 'found_and_cleared')] }), C({ observations: [O('faultPersists', false)] })],
  ventedClear: [cold([O('noHeat'), O('dryerVented')]), ok('programme-setting'), ok('lint-filter'), ok('vent-duct'), C({ observations: [O('restartsAfterCooling', false)] }), m('TVM560P')],
  heaterCode: [cold([O('noHeat'), O('dryerCondenser')], HOT), ok('programme-setting'), ok('lint-filter'), ok('condenser'), C({ observations: [O('restartsAfterCooling', false)] }), m()],
  heatPumpCode: [cold([O('noHeat'), O('dryerHeatPump')], HOT), ok('programme-setting'), ok('lint-filter'), ok('condenser'), m()],
  heatPumpWarm: [H.tdOpener('no-heat', 'heat', [O('heatPresent'), O('dryerHeatPump')])],
  unknownType: [cold(), C({ reply: { toPending: 'cannot_answer' } })],
  trip: [cold(), C({ safety: { hazard: 'supply_trip' } })],
};
const run = (k, mp = MP_C) => H.play(J, SEQ[k], { modelParts: mp });

describe('policy / diagnostics', () => {
  it('type first when unknown, then programme → filter; blocked filter → retest → fixed (airflow tripped the cut-out)', () => {
    expect(run('unknownType').rules[0]).toBe('DH11:dryerType');
    expect(run('filter').rules).toEqual(['DH12:programme-setting', 'DH13:lint-filter', 'DH6:retest', 'DH7:airflow-thermal-cut-out']);
  });
  it('vented: vent hose (not condenser); airflow clear, no code → heater / cut-out family, engineer, no part', () => {
    const r = run('ventedClear', [{ title: '2200 Watt Vented Heating Element' }]);
    expect(r.rules.slice(0, 4)).toEqual(['DH12:programme-setting', 'DH13:lint-filter', 'DH15:vent-duct', 'DH16:restartsAfterCooling']);
    expect(r.last).toMatchObject({ kind: 'conclude', target: 'heater-or-thermal-cut-out', conclusion: { noPart: true } });
  });
  it('conventional + heating code + airflow cleared + model with a heater → heater part', () => {
    const r = run('heaterCode');
    expect(r.prep.diag.leader).toMatchObject({ family: 'heater-or-thermal-cut-out', component: 'heater' });
    expect(r.last).toMatchObject({ kind: 'recommend_part', target: 'heater' });
  });
  it('heat pump: never a conventional heater (even with the code and a heater title on the list)', () => {
    const r = run('heatPumpCode', MP_HP);
    expect(r.prep.diag.leader.family).toBe('heat-pump-system');
    expect(r.actions.some((a) => a.action.kind === 'recommend_part')).toBe(false);
    expect(J.P.partGate(r.state, { ...r.prep.diag, partEvidence: { sufficient: true, component: 'heater' }, architecture: { type: 'heat-pump' } }, { available: true, component: 'heater' }).failed)
      .toContain('K7-heat-pump-or-unknown-technology');
  });
  it('heat pump warm (not hot) → normal, no part', () => { expect(run('heatPumpWarm').last).toMatchObject({ target: 'heat-pump-runs-cooler', conclusion: { noPart: true } }); });
  it('a later "it gets warm" outranks an earlier "no heat" (latest statement wins), and vice versa', () => {
    const r = H.play(J, [cold([O('noHeat'), O('dryerCondenser')]), C({ observations: [O('heatPresent')], checks: [K('programme-setting', 'done', 'clear')] })]);
    expect(r.prep.diag.facts).toContain('warm'); expect(r.prep.diag.facts).not.toContain('cold');
  });
  it('trip → sticky safety stop', () => { expect(run('trip').last).toMatchObject({ kind: 'safety_stop', rule: 'DH1' }); });
});
describe('COMPOSE contract', () => {
  it('every action reached obeys the contract', () => { expect(H.composeProblems(J, J.P, Object.keys(SEQ).flatMap((k) => run(k).actions))).toEqual([]); });
});
afterEach(() => { delete process.env.CANONICAL_TD1_CONTROL; });
describe('routing / gate', () => {
  it('no heat here; not drying + no heat here; washer-dryer is its own family (not TD); washing machine no-heat stays wm-not-heating; kill switch', async () => {
    const all = ['td-not-heating', 'td-not-drying', 'wm-not-heating'];
    expect(await H.ownerOf(L, [cold()], all)).toBe('td-not-heating');
    expect(await H.ownerOf(L, [H.tdOpener('not-drying', 'drying', [O('noHeat')])], all)).toBe('td-not-heating');
    // a washer-dryer is never the tumble-dryer family: its own family owns it (final pass), and only controls when gated
    const wd = [H.opener('no-heat', 'heat', [O('noHeat')], {}, { appliance: { value: 'washer-dryer', basis: 'stated' } })];
    expect(await H.ownerOf(L, wd, all)).toBe('wd-not-heating-wash');
    expect((await H.routeWith(L, wd, all)).journey.control).toBe(false);
    expect(await H.ownerOf(L, [H.opener('no-heat', 'heat', [O('noHeat')])], all)).toBe('wm-not-heating');
    process.env.CANONICAL_TD1_CONTROL = '0';
    expect((await H.routeWith(L, [cold()], all)).journey.control).toBe(false);
  });
});
