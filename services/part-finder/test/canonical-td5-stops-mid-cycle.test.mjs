/** Tumble dryer journey 5 (td-stops-mid-cycle): restarts after cooling + airflow = thermal (never the motor), routing. */
import { describe, it, expect, afterEach } from 'vitest';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
globalThis.awslambda = globalThis.awslambda || { streamifyResponse: (f) => f, HttpResponseStream: { from: (s) => s } };
const H = require('./helpers/b2-journey.cjs');
const J = require('../canonical/td5-stops-mid-cycle.js');
const L = require('../part-finder-lambda.js')._internal;
const { C, O, K } = H;

const stops = (obs = []) => H.tdOpener('cuts-out', 'power', obs);
const ok = (c) => C({ checks: [K(c, 'done', 'clear')] });
const SEQ = {
  airflow: [stops([O('restartsAfterCooling'), O('dryerVented')]), C({ checks: [K('lint-filter', 'done', 'found_and_cleared')] }), C({ observations: [O('faultPersists', false)] })],
  vent: [stops([O('restartsAfterCooling'), O('dryerVented')]), ok('lint-filter'), C({ checks: [K('vent-duct', 'done', 'found_and_cleared')] }), C({ observations: [O('faultPersists', false)] })],
  thermal: [stops([O('restartsAfterCooling'), O('dryerCondenser')]), ok('lint-filter'), ok('condenser'), ok('load-check')],
  noRestart: [stops([O('restartsAfterCooling', false), O('dryerCondenser')]), ok('lint-filter'), ok('condenser'), ok('load-check'), ok('sensor-bars')],
  trip: [stops(), C({ safety: { hazard: 'supply_trip' } })],
};
const run = (k) => H.play(J, SEQ[k], { modelParts: [{ title: 'Dryer Motor Unit' }] });

describe('policy / diagnostics', () => {
  it('restarts after cooling + blocked filter → airflow overheating → fixed', () => { expect(run('airflow').rules).toEqual(['DS12:lint-filter', 'DS6:retest', 'DS7:airflow-overheating']); });
  it('vented: vent hose checked; condenser: condenser checked', () => {
    expect(run('vent').rules[1]).toBe('DS14:vent-duct');
    expect(run('thermal').rules[1]).toBe('DS13:condenser');
  });
  it('restarts after cooling with airflow clear → thermal protection / thermostat (engineer) — not the motor', () => {
    const r = run('thermal');
    expect(r.last).toMatchObject({ target: 'thermal-protection-or-thermostat', conclusion: { noPart: true, handoff: 'engineer' } });
    expect(Object.values(J.FAMILY).some((f) => /motor/.test(f))).toBe(false);
  });
  it('never restarts, all fine → control / power (engineer)', () => { expect(run('noRestart').last.target).toBe('control-or-power'); });
  it('a trip alone (derived trips-electrics journey) is owned here → safety stop', () => {
    expect(H.play(J, [C({ identity: H.TDI, intent: 'report_fault', safety: { hazard: 'supply_trip' } })]).last).toMatchObject({ kind: 'safety_stop', rule: 'DS1' });
  });
  it('trip → sticky safety stop', () => { expect(run('trip').last).toMatchObject({ kind: 'safety_stop', rule: 'DS1' }); });
});
describe('COMPOSE contract', () => {
  it('every action reached obeys the contract', () => { expect(H.composeProblems(J, J.P, Object.keys(SEQ).flatMap((k) => run(k).actions))).toEqual([]); });
});
afterEach(() => { delete process.env.CANONICAL_TD5_CONTROL; });
describe('routing / gate', () => {
  it('stops here; stops + container warning → water container; kill switch', async () => {
    const all = ['td-stops-mid-cycle', 'td-water-container-drain'];
    expect(await H.ownerOf(L, [stops([O('restartsAfterCooling')])], all)).toBe('td-stops-mid-cycle');
    expect(await H.ownerOf(L, [stops([O('tankWarning')])], all)).toBe('td-water-container-drain');
    process.env.CANONICAL_TD5_CONTROL = '0';
    expect((await H.routeWith(L, [stops()], all)).journey.control).toBe(false);
  });
});
