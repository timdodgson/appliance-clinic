/** Oven / cooker family (8 journeys): ownership, per-journey policy paths, safety boundaries, part gates, COMPOSE contract, gates. */
import { describe, it, expect, afterEach } from 'vitest';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
globalThis.awslambda = globalThis.awslambda || { streamifyResponse: (f) => f, HttpResponseStream: { from: (s) => s } };
const H = require('./helpers/b2-journey.cjs');
const L = require('../part-finder-lambda.js')._internal;
const { C, O, K } = H;
const OVI = { appliance: { value: 'oven-cooker', basis: 'stated' } };
const OV = (j, obs = [], extra = {}, id = {}) => H.opener(j, null, obs, extra, { ...OVI, ...id });
const ck = (c, r = 'clear') => C({ checks: [K(c, 'done', r)] });
const ob = (...o) => C({ observations: o });
const hz = (h) => C({ safety: { hazard: h } });
const m = () => H.model('SA2540HIX', 'smeg');
const PARTS = [{ title: '2200W Grill Element' }, { title: 'Oven Door Gasket Seal' }, { title: 'Oven Fan Motor' }, { title: 'Door Hinge Left' }];
const GAS = { fuel: 'gas' };
const PACK = (k) => L.CANONICAL_JOURNEY_PACKS[k];
const J = (k) => require(PACK(k).pipeline.replace('./canonical/', '../canonical/'));
const KEYS = ['oven-not-heating', 'oven-overheating', 'oven-grill-not-working', 'oven-fan-not-working', 'oven-dead-no-power', 'oven-door', 'oven-tripping', 'cooker-ignition-gas'];
const SEQ = {
  'oven-not-heating': {
    clock: [[OV('no-heat'), ck('oven-clock-mode', 'found_and_cleared'), ob(O('faultPersists', false))], 'OH10:oven-clock-mode OH6:retest OH7:clock-or-auto-mode'],
    fanElement: [[OV('no-heat'), ck('oven-clock-mode'), ob(O('grillWorks'), O('mainOvenWorks', false)), ob(O('ovenFanTurns')), ck('programme-setting'), m()],
      'OH10:oven-clock-mode OH11:ovenFunctions OH12:ovenFanTurns OH13:programme-setting OH20:model OH22:fan-oven-element'],
  },
  'oven-overheating': { stuck: [[OV('overheating', [O('stuckOnHigh')])], 'OT5:control-stuck-on'] },
  'oven-grill-not-working': { grill: [[OV('no-heat', [O('grillWorks', false)])], 'OG10:mainOvenWorks'] },
  'oven-fan-not-working': {
    runOn: [[OV('noisy', [O('fanRunsAfterOff')])], 'OF5:cooling-fan-run-on'],
    motor: [[OV('no-heat', [O('ovenFanTurns', false)]), ob(O('grillWorks')), m()], 'OF11:grillWorks OF20:model OF21:oven-fan-motor'],
  },
  'oven-dead-no-power': {
    supply: [[OV('wont-start', [O('noPower')]), ck('power-supply', 'found_and_cleared'), ob(O('faultPersists', false))], 'OD11:power-supply OD6:retest OD7:supply-or-cooker-switch'],
    clock: [[OV('wont-start', [O('noPower', false)]), ck('oven-clock-mode', 'found_and_cleared'), ob(O('faultPersists', false))], 'OD12:oven-clock-mode OD6:retest OD7:clock-or-auto-mode'],
  },
  'oven-door': {
    glass: [[OV('door-problem', [O('doorGlassCracked')])], 'OR5:door-glass-cracked'],
    hinge: [[OV('door-problem', [O('doorCloses', false)]), ck('oven-door-fit', 'fault_seen'), m()], 'OR11:oven-door-fit OR20:model OR21:oven-door-hinge'],
    lock: [[OV('door-problem', [O('doorOpens', false)]), ob(O('doorOpens'))], 'OR10:reset-power-cycle OR7:lock-released-after-cooling'],
  },
  'oven-tripping': {
    trip: [[C({ identity: OVI, intent: 'report_fault', problem: { journey: 'no-heat' }, safety: { hazard: 'supply_trip' } }), ob(O('tripsImmediately')), ob(O('recentCleaning', false))],
      'OP1:oven-trip OP11:recentCleaning OP22:wiring-terminal-or-control'],
  },
  'cooker-ignition-gas': {
    caps: [[OV('wont-light', [O('sparkClicks')], {}, GAS), ob(O('oneBurnerOnly')), ck('burner-parts-clean', 'found_and_cleared'), ob(O('faultPersists', false))],
      'GC11:oneBurnerOnly GC12:burner-parts-clean GC6:retest GC7:burner-cap-wet-or-misaligned'],
    ffd: [[OV('wont-light', [O('flameGoesOut')], {}, GAS), ob(O('oneBurnerOnly')), ck('burner-parts-clean')], 'GC11:oneBurnerOnly GC12:burner-parts-clean GC22:flame-failure-device'],
    smell: [[OV('wont-light', [], {}, GAS), hz('gas_smell'), ob(O('sparkClicks'))], 'GC10:ignitionState GC1:gas_smell GC1:gas_smell'],
  },
};
const run = (k, n) => H.play(J(k), SEQ[k][n][0], { modelParts: PARTS });

describe('policy paths (expectations fixed before running)', () => {
  for (const k of KEYS) for (const n of Object.keys(SEQ[k] || {})) {
    it(`${k} · ${n}`, () => { expect(run(k, n).rules.join(' ')).toBe(SEQ[k][n][1]); });
  }
});
describe('oven rules', () => {
  it('fan runs + grill works + main oven cold: the fan element is the candidate but NO part without a catalogue match (none on this model)', () => {
    const r = run('oven-not-heating', 'fanElement');
    expect(r.last).toMatchObject({ kind: 'conclude', conclusion: { level: 'component', component: 'fan-oven-element' } });
    expect(r.actions.some((a) => a.action.kind === 'recommend_part')).toBe(false);
  });
  it('the grill circuit is separate: a grill failure never infers the fan element', () => {
    const r = H.play(J('oven-grill-not-working'), [OV('no-heat', [O('grillWorks', false)]), ob(O('mainOvenWorks')), ck('oven-clock-mode'), ck('programme-setting')], { modelParts: PARTS });
    expect(r.actions.every((a) => a.action.target !== 'fan-oven-element' && (a.action.conclusion || {}).component !== 'fan-oven-element')).toBe(true);
  });
  it('tripping: safety stop on the report, no live testing, no specific electrical part, engineer', () => {
    const r = run('oven-tripping', 'trip');
    expect(r.actions[0].action).toMatchObject({ kind: 'safety_stop', target: 'oven-trip' });
    expect(r.last.conclusion).toMatchObject({ handoff: 'engineer', noPart: true });
  });
  it('gas smell: immediate stop, no diagnosis progression afterwards (sticky)', () => {
    const r = run('cooker-ignition-gas', 'smell');
    expect(r.actions.slice(1).every((a) => a.action.kind === 'safety_stop')).toBe(true);
  });
  it('flame goes out → Gas Safe engineer, no gas part', () => {
    expect(run('cooker-ignition-gas', 'ffd').last.conclusion).toMatchObject({ handoff: 'gas', noPart: true });
  });
  it('unsafe gas work and live testing are declined', () => {
    const r = H.play(J('cooker-ignition-gas'), [OV('wont-light', [O('flameGoesOut')], {}, GAS), C({ safety: { unsafeAction: 'gas_work' } })]);
    expect(r.last).toMatchObject({ target: 'unsafe-request-declined', conclusion: { unsafeAction: 'gas_work', noPart: true } });
    const t = H.play(J('oven-not-heating'), [OV('no-heat'), C({ safety: { unsafeAction: 'live_electrical_test' } })]);
    expect(t.last.target).toBe('unsafe-request-declined');
  });
});
describe('round-1 live fixes', () => {
  it('a restated trip ("it trips after a while") is an answer, not a second stop', () => {
    const r = H.play(J('oven-tripping'), [C({ identity: OVI, intent: 'report_fault', problem: { journey: 'trips-electrics' }, safety: { hazard: 'supply_trip' } }),
      C({ safety: { hazard: 'supply_trip' }, observations: [O('tripsImmediately', false)] }), ob(O('recentCleaning', false))]);
    expect(r.rules).toEqual(['OP1:oven-trip', 'OP11:recentCleaning', 'OP22:element-insulation']);
  });
  it('a fix that changes the observations never re-routes the heating journey (oven fixed → stays not-heating)', async () => {
    const t = [OV('no-heat', [O('grillWorks', false), O('mainOvenWorks', false)]), ck('oven-clock-mode'), ob(O('ovenFanTurns')), ck('programme-setting', 'found_and_cleared'),
      ob(O('faultPersists', false), O('mainOvenWorks'))];
    expect(H.play(J('oven-not-heating'), t).rules.slice(-1)[0]).toMatch(/^OH(7|2):/);
  });
  it('fan not turning with the main oven cold still asks whether the grill works', () => {
    expect(H.play(J('oven-fan-not-working'), [OV('no-heat', [O('ovenFanTurns', false), O('mainOvenWorks', false)])]).rules).toEqual(['OF11:grillWorks']);
  });
});
describe('ownership (one owner per conversation)', () => {
  const cases = [
    [[OV('no-heat')], 'oven-not-heating'], [[OV('no-heat', [O('ovenFanTurns', false)])], 'oven-fan-not-working'], [[OV('no-heat', [O('grillWorks', false)])], 'oven-grill-not-working'],
    [[OV('no-heat', [], {}, GAS)], 'cooker-ignition-gas'], [[OV('no-heat', [], {}, { fuel: 'dual' })], 'oven-not-heating'], [[OV('wont-light', [], {}, GAS)], 'cooker-ignition-gas'],
    [[OV('overheating')], 'oven-overheating'], [[OV('wont-start', [O('noPower')])], 'oven-dead-no-power'], [[OV('door-problem')], 'oven-door'], [[OV('noisy')], 'oven-fan-not-working'],
    [[C({ identity: OVI, intent: 'report_fault', problem: { journey: 'door-problem' }, safety: { hazard: 'supply_trip' } })], 'oven-tripping'],
  ];
  for (const [t, k] of cases) it(`→ ${k} (${t[0].problem.journey})`, async () => { expect(await H.ownerOf(L, t, KEYS)).toBe(k); });
});
describe('COMPOSE contract', () => {
  it('every action reached obeys the contract', () => {
    for (const k of KEYS) for (const n of Object.keys(SEQ[k] || {})) {
      expect(H.composeProblems(require(PACK(k).compose.replace('./canonical/', '../canonical/')), null, run(k, n).actions)).toEqual([]);
    }
  });
});
afterEach(() => { for (const k of KEYS) delete process.env[PACK(k).killEnv]; });
describe('gates', () => {
  it('each key has its own kill switch; control only when on the allow-list', async () => {
    const t = [OV('no-heat')];
    expect((await H.routeWith(L, t, KEYS)).journey.control).toBe(true);
    expect((await H.routeWith(L, t, KEYS.filter((k) => k !== 'oven-not-heating'))).journey.control).toBe(false);
    process.env[PACK('oven-not-heating').killEnv] = '0';
    expect((await H.routeWith(L, t, KEYS)).journey.control).toBe(false);
  });
});
