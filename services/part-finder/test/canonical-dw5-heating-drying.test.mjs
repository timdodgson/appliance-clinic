/** Dishwasher journey 5 (dw-not-heating-drying): diagnostics, policy, part gate, COMPOSE contract, routing / gate. */
import { describe, it, expect, afterEach } from 'vitest';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
globalThis.awslambda = globalThis.awslambda || { streamifyResponse: (f) => f, HttpResponseStream: { from: (s) => s } };
const H = require('./helpers/b2-journey.cjs');
const J = require('../canonical/dw5-heating-drying.js');
const L = require('../part-finder-lambda.js')._internal;
const { C, O, K } = H;

const dry = (obs = []) => H.dwOpener('not-drying', 'drying', [O('dishesWet'), ...obs]);
const cold = (obs = [], id = {}) => H.dwOpener('no-heat', 'heat', [O('noHeat'), ...obs], {}, id);
const MP = [{ title: 'Heater Pump' }, { title: 'Door Lock Complete' }];
const m = () => H.model('DW1TEST', 'hotpoint');
const SEQ = {
  plastics: [dry(), C({ observations: [O('heatPresent')] }), C({ observations: [O('onlyPlasticsWet')] })],
  rinseAid: [dry([O('heatPresent')]), C({ observations: [O('onlyPlasticsWet', false)] }), C({ checks: [K('rinse-aid', 'done', 'found_and_cleared')] }), C({ observations: [O('faultPersists', false)] })],
  drySystem: [dry([O('heatPresent')]), C({ observations: [O('onlyPlasticsWet', false)] }), C({ checks: [K('rinse-aid', 'done', 'clear')] }), C({ observations: [O('hotProgrammeUsed')] }), m()],
  eco: [dry([O('heatPresent')]), C({ observations: [O('onlyPlasticsWet', false)] }), C({ checks: [K('rinse-aid', 'done', 'clear')] }), C({ observations: [O('hotProgrammeUsed', false)] })],
  noHeat: [cold([O('hotProgrammeUsed')]), C({ observations: [O('longCycle')] }), m()],
  test: [cold(), C({ observations: [O('hotProgrammeUsed', false)] }), C({ observations: [O('noHeat')] }), C({ observations: [O('longCycle')] })],
  code: [cold([O('hotProgrammeUsed')], { make: { value: 'hotpoint', basis: 'stated' }, displayedCode: 'F08' }), C({ observations: [O('longCycle')] }), m()],
  codeNoModel: [cold([O('hotProgrammeUsed')], { make: { value: 'hotpoint', basis: 'stated' }, displayedCode: 'F08' }), C({ observations: [O('longCycle')] }), H.noModel()],
  ntc: [cold([O('hotProgrammeUsed')], { make: { value: 'bosch', basis: 'stated' }, displayedCode: 'E13' }), C({ observations: [O('longCycle', false)] }), m()],
  trip: [cold(), C({ safety: { hazard: 'supply_trip' } }), C({})],
  burning: [dry(), C({ safety: { hazard: 'burning' } })],
};
const run = (k) => H.play(J, SEQ[k], { modelParts: MP });

describe('diagnostics', () => {
  it('wet dishes never imply the heater: plastics only → normal; hot + rinse aid fine + normal programme → drying system area', () => {
    const p = run('plastics').prep.diag;
    expect(p.leader.family).toBe('normal-condensation-drying');
    expect(p.contradicted.map((c) => c.family)).toContain('heater');
    expect(run('drySystem').prep.diag.leader).toMatchObject({ family: 'drying-system', level: 'cause_family' });
  });
  it('cold on a hot programme → heater only possible; heating code → heater component; NTC code → sensor area', () => {
    expect(run('noHeat').prep.diag.leader).toMatchObject({ family: 'heater', level: 'cause_family' });
    expect(run('code').prep.diag.leader).toMatchObject({ family: 'heater', component: 'heater' });
    expect(run('ntc').prep.diag.leader).toMatchObject({ family: 'temperature-sensor', level: 'cause_family' });
  });
});
describe('policy', () => {
  it('drying: hot? → plastics only → normal (no part)', () => { expect(run('plastics').rules).toEqual(['T10:heatState', 'T11:onlyPlasticsWet', 'T22:normal-condensation-drying']); });
  it('rinse aid empty → retest → likely fixed; eco → programme conclusion', () => {
    expect(run('rinseAid').rules).toEqual(['T11:onlyPlasticsWet', 'T12:rinse-aid', 'T6:retest', 'T7:rinse-aid']);
    expect(run('eco').last).toMatchObject({ target: 'programme-choice', conclusion: { noPart: true } });
  });
  it('heating: eco user → supervised intensive test → cold → long → heater possible, engineer, no part', () => {
    const r = run('test');
    expect(r.rules).toEqual(['T13:hotProgrammeUsed', 'T14:hot-wash-test', 'T15:longCycle', 'T22:heater']);
    expect(r.actions[1].action.requires).toEqual(['stop_if_trips_or_burning', 'dw_hot_steam']);
  });
  it('trip / burning → safety stop every turn', () => {
    expect(run('trip').rules.slice(1)).toEqual(['T1:supply_trip', 'T1:supply_trip']);
    expect(run('burning').last).toMatchObject({ kind: 'safety_stop', target: 'burning' });
  });
});
describe('part gate', () => {
  it('heating code + model + heater listed → heater; model unavailable → no part; no code → never; NTC → never', () => {
    expect(run('code').last).toMatchObject({ kind: 'recommend_part', target: 'heater' });
    expect(run('codeNoModel').last.kind).toBe('conclude');
    expect(run('noHeat').last.kind).toBe('conclude');
    expect(run('ntc').last.kind).toBe('conclude');
    expect(run('drySystem').last.kind).toBe('conclude');
  });
});
describe('COMPOSE contract', () => {
  it('every action reached obeys the contract; no live electrical testing', () => {
    const seen = Object.keys(SEQ).flatMap((k) => run(k).actions);
    expect(H.composeProblems(J, J.P, seen)).toEqual([]);
    expect(JSON.stringify(J.TASK)).not.toMatch(/multimeter|continuity|resistance|voltage/i);
  });
});
afterEach(() => { delete process.env.CANONICAL_DW5_CONTROL; });
describe('routing / gate', () => {
  it('own gate; washing-machine no-heat stays wm-not-heating; kill switch', async () => {
    expect((await H.routeWith(L, [dry()], ['dw-not-heating-drying'])).journey).toMatchObject({ key: 'dw-not-heating-drying', control: true });
    expect((await H.routeWith(L, [H.opener('no-heat', 'heat', [O('noHeat')])], ['wm-not-heating', 'dw-not-heating-drying'])).journey.key).toBe('wm-not-heating');
    process.env.CANONICAL_DW5_CONTROL = '0';
    expect((await H.routeWith(L, [dry()], ['dw-not-heating-drying'])).journey.control).toBe(false);
  });
});
