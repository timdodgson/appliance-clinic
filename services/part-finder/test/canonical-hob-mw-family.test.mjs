/** Hob (4) and microwave (6) families: ownership, policy paths, safety (gas / HV / sparking / door-start), part gates, COMPOSE, gates. */
import { describe, it, expect, afterEach } from 'vitest';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
globalThis.awslambda = globalThis.awslambda || { streamifyResponse: (f) => f, HttpResponseStream: { from: (s) => s } };
const H = require('./helpers/b2-journey.cjs');
const L = require('../part-finder-lambda.js')._internal;
const { C, O, K } = H;
const ap = (a) => ({ appliance: { value: a, basis: 'stated' } });
const HB = (j, obs = []) => H.opener(j, null, obs, {}, ap('hob'));
const MW = (j, obs = []) => H.opener(j, null, obs, {}, ap('microwave'));
const ck = (c, r = 'clear') => C({ checks: [K(c, 'done', r)] });
const ob = (...o) => C({ observations: o });
const m = () => H.model('NNE271WM', 'panasonic');
const MWP = [{ title: 'Door Latch Hook' }, { title: 'Turntable Coupler' }, { title: 'Roller Ring' }, { title: 'Waveguide Cover' }, { title: 'Turntable Motor' }, { title: 'Magnetron' }];
const PACK = (k) => L.CANONICAL_JOURNEY_PACKS[k];
const J = (k) => require(PACK(k).pipeline.replace('./canonical/', '../canonical/'));
const HOB = ['hob-zone-not-heating', 'hob-no-power', 'hob-overheating-control', 'hob-ignition-gas'];
const MWK = ['mw-not-heating', 'mw-not-starting', 'mw-door', 'mw-turntable', 'mw-noisy-sparking', 'mw-starts-when-door-closes'];
const arcOpener = () => C({ identity: ap('microwave'), intent: 'report_fault', problem: { journey: 'sparking' }, safety: { hazard: 'microwave_arcing' } });
const SEQ = {
  'hob-zone-not-heating': { pan: [[HB('no-heat', [O('inductionHob'), O('panSymbolFlashing')])], 'HZ12:panTest'], ceramic: [[HB('no-heat', [O('ceramicHob')]), ck('child-lock')], 'HZ11:child-lock HZ22:element-or-zone-control'] },
  'hob-no-power': { dead: [[HB('wont-start', [O('noPower')]), ck('power-supply')], 'HP11:power-supply HP22:mains-connection-or-power-side'] },
  'hob-overheating-control': { stuck: [[HB('overheating', [O('stuckOnHigh')])], 'HO5:zone-stuck-on'], vent: [[HB('cuts-out', [O('inductionHob'), O('overheatsThenCuts')])], 'HO22:cooling-or-ventilation'] },
  'hob-ignition-gas': { clicks: [[HB('wont-light', [O('gasHob'), O('sparkClicks')])], 'GH11:oneBurnerOnly'] },
  'mw-not-heating': { runs: [[MW('no-heat'), ck('programme-setting'), ob(O('runsNormally'))], 'MH10:programme-setting MH11:runsNormally MH22:high-voltage-heating-system'] },
  'mw-not-starting': { lock: [[MW('wont-start', [O('noPower', false)]), ob(O('doorRecognised')), ck('child-lock', 'found_and_cleared'), ob(O('faultPersists', false))], 'MS12:doorRecognised MS13:child-lock MS6:retest MS7:control-or-child-lock'] },
  'mw-door': { latch: [[MW('door-problem', [O('doorRecognised', false)]), ck('mw-door-check', 'fault_seen'), m()], 'MD10:mw-door-check MD20:model MD21:mw-door-latch'], glass: [[MW('door-problem', [O('doorGlassCracked')])], 'MD5:door-glass-cracked'] },
  'mw-turntable': { coupler: [[MW('turntable-not-turning', [O('turntableTurns', false)]), ck('turntable-parts', 'fault_seen'), m()], 'MT10:turntable-parts MT20:model MT21:turntable-coupler-or-ring'],
    motor: [[MW('turntable-not-turning'), ck('turntable-parts')], 'MT10:turntable-parts MT22:turntable-motor'] },
  'mw-noisy-sparking': { cover: [[arcOpener(), ob(O('waveguideCoverDamaged')), m()], 'MN1:mw-arcing MN20:model MN21:waveguide-cover'],
    untyped: [[MW('sparking'), ob(O('metalInside'))], /^MN1:mw-arcing MN11:mw-cavity-check$/],
    noisy: [[MW('noisy', [O('rattlingNoise')]), ck('turntable-parts', 'found_and_cleared'), ob(O('faultPersists', false))], 'MN13:turntable-parts MN6:retest MN7:turntable-noise'] },
  'mw-starts-when-door-closes': { start: [[MW('wont-start', [O('startsWhenDoorCloses')])], 'MC5:door-interlock-or-control'] },
};
const run = (k, n) => H.play(J(k), SEQ[k][n][0], { modelParts: MWP });
describe('policy paths (expectations fixed before running)', () => {
  for (const k of [...HOB, ...MWK]) for (const n of Object.keys(SEQ[k])) {
    it(`${k} · ${n}`, () => { const e = SEQ[k][n][1]; const got = run(k, n).rules.join(' '); if (e instanceof RegExp) expect(got).toMatch(e); else expect(got).toBe(e); });
  }
});
describe('safety boundaries', () => {
  it('not heating alone never recommends the magnetron (or any HV part), even when it is on the model list', () => {
    const r = H.play(J('mw-not-heating'), [MW('no-heat'), ck('programme-setting'), ob(O('runsNormally')), m()], { modelParts: MWP });
    expect(r.actions.some((a) => a.action.kind === 'recommend_part')).toBe(false);
    expect(r.last.conclusion).toMatchObject({ handoff: 'engineer', noPart: true });
  });
  it('a sparking report stops use on the turn it is reported, typed hazard or not', () => {
    expect(H.play(J('mw-noisy-sparking'), [arcOpener()]).last).toMatchObject({ kind: 'safety_stop', target: 'mw-arcing' });
    expect(H.play(J('mw-noisy-sparking'), [MW('sparking')]).last).toMatchObject({ kind: 'safety_stop', target: 'mw-arcing' });
  });
  it('starts when the door closes: stop use, engineer, never the magnetron, no questions', () => {
    const r = run('mw-starts-when-door-closes', 'start');
    expect(r.last).toMatchObject({ kind: 'conclude', pending: null, conclusion: { handoff: 'engineer', noPart: true } });
  });
  it('an unsafe HV request is declined with fixed copy', () => {
    const r = H.play(J('mw-not-heating'), [MW('no-heat'), C({ safety: { unsafeAction: 'hv_microwave_work' } })]);
    expect(r.last).toMatchObject({ target: 'unsafe-request-declined', conclusion: { unsafeAction: 'hv_microwave_work' } });
    const JC = require('../canonical/mw1-not-heating.js');
    expect(JC.template(JC.brief(r.state, r.last, null, {}))).toMatch(/lethal charge/);
  });
  it('hob overheating / stuck on: safety first, no part guessing; induction module never from a generic failure', () => {
    for (const k of HOB) for (const n of Object.keys(SEQ[k])) expect(run(k, n).actions.some((a) => a.action.kind === 'recommend_part')).toBe(false);
  });
  it('hob gas smell: sticky stop', () => {
    const r = H.play(J('hob-ignition-gas'), [HB('wont-light', [O('gasHob')]), C({ safety: { hazard: 'gas_smell' } }), ob(O('sparkClicks'))]);
    expect(r.actions.slice(1).every((a) => a.action.kind === 'safety_stop')).toBe(true);
  });
});
describe('ownership', () => {
  const cases = [
    [[HB('no-heat')], 'hob-zone-not-heating'], [[HB('wont-start', [O('noPower')])], 'hob-no-power'], [[HB('overheating')], 'hob-overheating-control'],
    [[HB('wont-light', [O('gasHob')])], 'hob-ignition-gas'], [[HB('no-heat', [O('gasHob')])], 'hob-ignition-gas'],
    [[MW('no-heat')], 'mw-not-heating'], [[MW('wont-start')], 'mw-not-starting'], [[MW('door-problem')], 'mw-door'], [[MW('wont-start', [O('doorRecognised', false)])], 'mw-door'],
    [[MW('turntable-not-turning')], 'mw-turntable'], [[MW('sparking')], 'mw-noisy-sparking'], [[MW('noisy')], 'mw-noisy-sparking'], [[MW('wont-start', [O('startsWhenDoorCloses')])], 'mw-starts-when-door-closes'],
  ];
  for (const [t, k] of cases) it(`→ ${k} (${t[0].problem.journey})`, async () => { expect(await H.ownerOf(L, t, [...HOB, ...MWK])).toBe(k); });
});
describe('COMPOSE contract', () => {
  it('every action reached obeys the contract', () => {
    for (const k of [...HOB, ...MWK]) for (const n of Object.keys(SEQ[k])) {
      expect(H.composeProblems(require(PACK(k).compose.replace('./canonical/', '../canonical/')), null, run(k, n).actions)).toEqual([]);
    }
  });
});
afterEach(() => { for (const k of [...HOB, ...MWK]) delete process.env[PACK(k).killEnv]; });
describe('gates', () => {
  it('per-key kill switch and allow-list', async () => {
    for (const [k, t] of [['hob-zone-not-heating', [HB('no-heat')]], ['mw-turntable', [MW('turntable-not-turning')]]]) {
      expect((await H.routeWith(L, t, [k])).journey.control).toBe(true);
      expect((await H.routeWith(L, t, [])).journey.control).toBe(false);
      process.env[PACK(k).killEnv] = '0';
      expect((await H.routeWith(L, t, [k])).journey.control).toBe(false);
    }
  });
});
