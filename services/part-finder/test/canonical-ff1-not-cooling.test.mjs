/** Fridge / freezer journey 1 (ff-not-cooling): diagnostics, policy, part gate, COMPOSE contract, routing / handoffs. */
import { describe, it, expect, afterEach } from 'vitest';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
globalThis.awslambda = globalThis.awslambda || { streamifyResponse: (f) => f, HttpResponseStream: { from: (s) => s } };
const H = require('./helpers/b2-journey.cjs');
const J = require('../canonical/ff1-not-cooling.js');
const L = require('../part-finder-lambda.js')._internal;
const { C, O, K } = H;

const warm = (obs = [], extra = {}, id = {}) => H.ffOpener('not-cooling', 'cooling', obs, extra, id);
const ok = (c) => C({ checks: [K(c, 'done', 'clear')] });
const m = () => H.model('FF200DP', 'hotpoint');
const SEQ = {
  doorLeft: [warm([O('doorLeftOpen')]), C({ observations: [O('faultPersists', false)] })],
  setting: [warm([O('bothCompartmentsWarm'), O('doorLeftOpen', false)]), C({ checks: [K('temp-setting', 'done', 'found_and_cleared')] }), C({ observations: [O('faultPersists', false)] })],
  fridgeOnly: [warm([O('doorLeftOpen', false)], { scope: 'fridge_only' }), ok('temp-setting'), ok('vents-clear'), ok('door-seal'), C({ observations: [O('fanAudible', false)] })],
  fanCode: [warm([O('doorLeftOpen', false)], { scope: 'fridge_only' }, { make: { value: 'hotpoint', basis: 'stated' }, displayedCode: 'F04' }), ok('temp-setting'), ok('vents-clear'), ok('door-seal'),
    C({ observations: [O('fanAudible', false)] }), m()],
  both: [warm([O('bothCompartmentsWarm'), O('doorLeftOpen', false)]), ok('temp-setting'), ok('vents-clear'), ok('door-seal'), ok('condenser-coil-clear'),
    C({ observations: [O('inColdOrHotLocation', false)] }), C({ observations: [O('compressorRuns')] })],
  sealTorn: [warm([O('bothCompartmentsWarm'), O('doorLeftOpen', false)]), ok('temp-setting'), ok('vents-clear'), C({ checks: [K('door-seal', 'done', 'fault_seen')] }), m()],
  garage: [warm([O('doorLeftOpen', false)], { scope: 'freezer_only' }), ok('temp-setting'), ok('vents-clear'), ok('door-seal'), ok('condenser-coil-clear'), C({ observations: [O('inColdOrHotLocation')] }),
    C({ observations: [O('compressorRuns')] })],
  warmOnly: [warm(), C({ reply: { toPending: 'cannot_answer' } }), C({ reply: { toPending: 'cannot_answer' } })],
  trip: [warm(), C({ safety: { hazard: 'supply_trip' } })],
};
const run = (k, mp = [{ title: 'Fridge Door Seal' }, { title: 'Fridge Fan Motor' }]) => H.play(J, SEQ[k], { modelParts: mp });

describe('diagnostics', () => {
  it('everything fine and running → sealed system only as "possible" (never committed, never a component): not cooling alone never claims the compressor', () => {
    const d = run('both').prep.diag;
    expect(d.leader).toMatchObject({ family: 'sealed-system-or-compressor', committed: false, level: 'cause_family' });
    expect(run('both').last.conclusion).toMatchObject({ confidence: 'possible', noPart: true, handoff: 'engineer' });
  });
  it('fridge warm + freezer cold + fan silent → airflow / fan family (no code: no component)', () => {
    expect(run('fridgeOnly').prep.diag.leader).toMatchObject({ family: 'internal-fan-or-airflow', level: 'cause_family' });
  });
  it('a gasket is never inferred from warmth: only an owner-seen torn seal reaches the door-seal component', () => {
    expect(run('both').prep.diag.facts).not.toContain('sealTorn');
    expect(run('sealTorn').prep.diag.leader).toMatchObject({ family: 'door-seal', component: 'door-seal' });
  });
});
describe('policy', () => {
  it('door left open → keep shut 24 h → recovered (no part)', () => {
    expect(run('doorLeft').rules).toEqual(['FC10:ffCompartment', 'FC7:door-left-open']);
  });
  it('compartment first (with food-safety copy), then settings; setting fixed → retest → likely fixed', () => {
    const r = H.play(J, [warm()]);
    expect(r.last).toMatchObject({ rule: 'FC10', target: 'ffCompartment', requires: ['ff_food_safety'] });
    expect(run('setting').rules).toEqual(['FC13:temp-setting', 'FC6:retest', 'FC7:temperature-setting']);
  });
  it('fridge only: no coils / compressor questions; fan question; then concludes engineer, no part', () => {
    const r = run('fridgeOnly');
    expect(r.rules).toEqual(['FC13:temp-setting', 'FC14:vents-clear', 'FC15:door-seal', 'FC18:fanAudible', 'FC22:internal-fan-or-airflow']);
    expect(r.last.conclusion).toMatchObject({ handoff: 'engineer', noPart: true });
  });
  it('both warm: settings → vents → seal → coils → room → running? (silent → handed to not-running, once)', () => {
    const r = run('both');
    expect(r.rules.slice(0, 6)).toEqual(['FC13:temp-setting', 'FC14:vents-clear', 'FC15:door-seal', 'FC16:condenser-coil-clear', 'FC17:inColdOrHotLocation', 'FC19:ffCompressorState']);
    const silent = H.play(J, [...SEQ.both.slice(0, -1), C({ observations: [O('compressorRuns', false)] })]);
    expect(silent.prep.entry).toMatchObject({ applies: false, drainOwned: true });
  });
  it('freezer warm in a cold garage → room temperature (install, no part)', () => {
    expect(run('garage').last).toMatchObject({ target: 'room-temperature-location', conclusion: { handoff: 'install', noPart: true } });
  });
  it('refrigerant DIY request → declined once (P8, no part), then the journey carries on', () => {
    const r = H.play(J, [warm([O('bothCompartmentsWarm')]), C({ safety: { unsafeAction: 'refrigerant_work' } }), C({ observations: [O('doorLeftOpen', false)] })]);
    expect(r.rules).toEqual(['FC11:doorLeftOpen', 'FC8:unsafe-request-declined', 'FC13:temp-setting']);
    expect(r.actions[1].action.conclusion).toMatchObject({ noPart: true, unsafeAction: 'refrigerant_work' });
    expect(J.template(J.brief(r.actions[1].state, r.actions[1].action, null, {}))).toMatch(/refrigeration engineer/);
  });
  it('trip → safety stop; vague → concludes without a part', () => {
    expect(run('trip').last).toMatchObject({ kind: 'safety_stop', rule: 'FC1' });
    expect(run('warmOnly').last.kind).not.toBe('recommend_part');
  });
});
describe('part gate', () => {
  it('torn seal + model + compatible part → gasket; no compatible part → component conclusion, no part', () => {
    expect(run('sealTorn').last).toMatchObject({ kind: 'recommend_part', target: 'door-seal', rule: 'FC21' });
    expect(run('sealTorn', [{ title: 'Lower Hinge' }]).last).toMatchObject({ kind: 'conclude', conclusion: { component: 'door-seal' } });
  });
  it('fan component only with a fan code AND the fan silent (+ model)', () => {
    const r = run('fanCode');
    expect(r.prep.diag.leader).toMatchObject({ family: 'internal-fan-or-airflow', component: 'evaporator-fan' });
    expect(r.last).toMatchObject({ kind: 'recommend_part', target: 'evaporator-fan' });
  });
});
describe('COMPOSE contract', () => {
  it('every action reached obeys the contract; no refrigerant DIY, no live compressor testing', () => {
    const seen = Object.keys(SEQ).flatMap((k) => run(k).actions);
    expect(H.composeProblems(J, J.P, seen)).toEqual([]);
    expect(JSON.stringify(J.TASK)).not.toMatch(/re-?gas|pierce|multimeter|test the (compressor|relay)|remove the (back|rear) (panel|cover)/i);
  });
  it('food-safety advice is factual and concise (5°C / 8°C / thawed food)', () => {
    expect(J.REQUIREMENT.ff_food_safety.copy).toMatch(/5°C or below/);
    expect(J.REQUIREMENT.ff_food_safety.copy).toMatch(/8°C/);
  });
});
afterEach(() => { delete process.env.CANONICAL_FF1_CONTROL; });
describe('routing / gate', () => {
  it('own gate; dead / clicking / door / heavy-ice owners; kill switch', async () => {
    const all = ['ff-not-cooling', 'ff-not-running-dead', 'ff-door-seal-door', 'ff-ice-frost-build-up'];
    expect(await H.ownerOf(L, [warm()], all)).toBe('ff-not-cooling');
    expect(await H.ownerOf(L, [warm([O('noPower')])], all)).toBe('ff-not-running-dead');
    expect(await H.ownerOf(L, [warm([O('clicksNoStart')])], all)).toBe('ff-not-running-dead');
    expect(await H.ownerOf(L, [warm([O('doorNotSeating')])], all)).toBe('ff-door-seal-door');
    expect(await H.ownerOf(L, [warm([O('heavyIce')])], all)).toBe('ff-ice-frost-build-up');
    process.env.CANONICAL_FF1_CONTROL = '0';
    expect((await H.routeWith(L, [warm()], all)).journey.control).toBe(false);
  });
});
