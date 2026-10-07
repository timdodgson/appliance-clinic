/** Vacuum family (6 journeys): airflow-first ownership, battery only with runtime / charge evidence, part gates, model tokens, COMPOSE, gates. */
import { describe, it, expect, afterEach } from 'vitest';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
globalThis.awslambda = globalThis.awslambda || { streamifyResponse: (f) => f, HttpResponseStream: { from: (s) => s } };
const H = require('./helpers/b2-journey.cjs');
const L = require('../part-finder-lambda.js')._internal;
const Q = require('../canonical/mc1-questions.js');
const F = require('../canonical/vac-family.js');
const { C, O, K } = H;
const VI = { appliance: { value: 'vacuum', basis: 'stated' } };
const V = (j, obs = [], id = {}) => H.opener(j, null, obs, {}, { ...VI, ...id });
const ck = (c, r = 'clear') => C({ checks: [K(c, 'done', r)] });
const ob = (...o) => C({ observations: o });
const noModel = () => C({ identity: { modelStatus: 'unavailable' }, reply: { toPending: 'cannot_answer' } });
const P = [{ title: 'Pre Motor Filter' }, { title: 'Hose Assembly' }, { title: 'Brushbar' }, { title: 'Drive Belt' }, { title: 'Battery Pack 22.2V' }, { title: 'Charger' }, { title: 'Motor' }];
const PACK = (k) => L.CANONICAL_JOURNEY_PACKS[k];
const J = (k) => require(PACK(k).pipeline.replace('./canonical/', '../canonical/'));
const KEYS = ['vacuum-low-suction', 'vacuum-pulsing-cutting-out', 'vacuum-not-running', 'vacuum-brush-not-turning', 'vacuum-battery-runtime', 'vacuum-noisy'];
const fixed = (c) => [ck(c, 'found_and_cleared'), ob(O('faultPersists', false))];
const SEQ = {
  'vacuum-low-suction': {
    filter: [[V('lost-suction', [O('weakSuction')]), ...fixed('vacuum-bin-filters')], 'VS10:vacuum-bin-filters VS6:retest VS7:bin-or-filters'],
    hoseBlock: [[V('lost-suction'), ck('vacuum-bin-filters'), ...fixed('vacuum-blockage')], 'VS10:vacuum-bin-filters VS11:vacuum-blockage VS6:retest VS7:airflow-blockage'],
    motorArea: [[V('lost-suction'), ck('vacuum-bin-filters'), ck('vacuum-blockage'), ck('brush-bar-clear')], 'VS10:vacuum-bin-filters VS11:vacuum-blockage VS12:brush-bar-clear VS22:internal-seal-or-motor-area'],
    hosePart: [[V('lost-suction'), ck('vacuum-bin-filters'), ck('vacuum-blockage', 'fault_seen'), H.model('DC40', 'dyson')], 'VS10:vacuum-bin-filters VS11:vacuum-blockage VS20:model VS21:vacuum-hose'],
    noModel: [[V('lost-suction'), ck('vacuum-bin-filters', 'fault_seen'), noModel()], 'VS10:vacuum-bin-filters VS20:model VS22:bin-or-filters'],
  },
  'vacuum-pulsing-cutting-out': {
    dysonV6: [[V('pulsing', [], { model: { value: 'V6', basis: 'stated' } }), ...fixed('vacuum-bin-filters')], 'VP10:vacuum-bin-filters VP6:retest VP7:bin-or-filters'],
    batteryLast: [[V('pulsing'), ck('vacuum-bin-filters'), ck('vacuum-blockage'), ck('brush-bar-clear'), ob(O('vacuumCordless')), ob(O('shortRuntime'))],
      'VP10:vacuum-bin-filters VP11:vacuum-blockage VP12:brush-bar-clear VP13:vacType VP14:vacBattery VP22:battery-or-charging'],
    corded: [[V('pulsing', [O('vacuumCorded')]), ck('vacuum-bin-filters'), ck('vacuum-blockage'), ck('brush-bar-clear')], 'VP10:vacuum-bin-filters VP11:vacuum-blockage VP12:brush-bar-clear VP22:internal-motor-or-electronics'],
  },
  'vacuum-not-running': {
    fuse: [[V('wont-start', [O('noPower')]), ob(O('vacuumCorded')), ...fixed('power-supply')], 'VN10:vacType VN11:power-supply VN6:retest VN7:mains-supply-or-fuse'],
    cable: [[V('wont-start', [O('vacuumCorded')]), ck('power-supply', 'fault_seen')], 'VN11:power-supply VN5:damaged-cable-stop-use'],
    internal: [[V('wont-start', [O('vacuumCorded')]), ck('power-supply'), ck('vacuum-blockage')], 'VN11:power-supply VN13:vacuum-blockage VN22:switch-cable-or-motor'],
  },
  'vacuum-brush-not-turning': {
    tangled: [[V('brush-bar-not-spinning', [O('brushNotSpinning')]), ...fixed('brush-bar-clear')], 'VB10:brush-bar-clear VB6:retest VB7:brush-bar-tangled-or-jammed'],
    broken: [[V('brush-bar-not-spinning'), ck('brush-bar-clear', 'fault_seen'), H.model('DC33', 'dyson')], 'VB10:brush-bar-clear VB20:model VB21:vacuum-brush-bar'],
    belt: [[V('brush-bar-not-spinning', [O('vacuumCorded')]), ck('brush-bar-clear'), ck('drive-belt', 'fault_seen'), H.model('DC33', 'dyson')], 'VB10:brush-bar-clear VB12:drive-belt VB20:model VB21:vacuum-belt'],
    floorhead: [[V('brush-bar-not-spinning', [O('vacuumCordless')]), ck('brush-bar-clear')], 'VB10:brush-bar-clear VB22:floorhead-drive'],
  },
  'vacuum-battery-runtime': {
    justified: [[V('cuts-out', [O('vacuumCordless'), O('shortRuntime')]), ck('vacuum-charger-check'), ck('programme-setting'), ck('vacuum-bin-filters'), H.model('DC35', 'dyson')],
      'VR11:vacuum-charger-check VR12:programme-setting VR13:vacuum-bin-filters VR20:model VR21:vacuum-battery'],
    boost: [[V('battery-problem', [O('vacuumCordless'), O('shortRuntime')]), ck('vacuum-charger-check'), ...fixed('programme-setting')], 'VR11:vacuum-charger-check VR12:programme-setting VR6:retest VR7:boost-or-max-mode'],
    wontCharge: [[V('battery-problem', [O('vacuumCordless'), O('wontCharge')]), ck('vacuum-charger-check', 'fault_seen')], 'VR11:vacuum-charger-check VR22:battery-or-charger-not-charging'],
    notJustified: [[V('battery-problem', [O('shortRuntime')]), ck('vacuum-charger-check'), ck('programme-setting'), ...fixed('vacuum-bin-filters')],
      'VR11:vacuum-charger-check VR12:programme-setting VR13:vacuum-bin-filters VR6:retest VR7:filters-choking-motor'],
  },
  'vacuum-noisy': {
    whistle: [[V('noisy', [O('whistleNoise')]), ...fixed('vacuum-blockage')], 'VY11:vacuum-blockage VY6:retest VY7:airflow-blockage'],
    grinding: [[V('noisy', [O('grindingNoise')]), ck('vacuum-blockage'), ck('brush-bar-clear'), ck('vacuum-bin-filters')], 'VY11:vacuum-blockage VY12:brush-bar-clear VY13:vacuum-bin-filters VY22:motor-bearing-or-fan'],
  },
};
const run = (k, n) => H.play(J(k), SEQ[k][n][0], { modelParts: P });
describe('policy paths (expectations fixed before running)', () => {
  for (const k of KEYS) for (const n of Object.keys(SEQ[k])) it(`${k} · ${n}`, () => { expect(run(k, n).rules.join(' ')).toBe(SEQ[k][n][1]); });
});
describe('vacuum rules', () => {
  it('pulsing: airflow first; no battery part from pulsing (even cordless with short runtime)', () => {
    const r = run('vacuum-pulsing-cutting-out', 'batteryLast');
    expect(r.rules.indexOf('VP14:vacBattery')).toBeGreaterThan(r.rules.indexOf('VP11:vacuum-blockage'));
    expect(r.actions.some((a) => a.action.kind === 'recommend_part')).toBe(false);
  });
  it('no motor from weak suction alone — the motor area is an engineer conclusion, never a part', () => {
    const r = run('vacuum-low-suction', 'motorArea');
    expect(r.last.conclusion).toMatchObject({ handoff: 'engineer', noPart: true });
    expect(Object.values(require('../canonical/vac1-low-suction.js').COMPONENT_LABEL)).not.toContain('motor');
  });
  it('a battery part needs short runtime from a full charge AND charger, mode and filters all fine', () => {
    expect(run('vacuum-battery-runtime', 'justified').last).toMatchObject({ kind: 'recommend_part', target: 'vacuum-battery' });
    for (const n of ['boost', 'wontCharge', 'notJustified']) expect(run('vacuum-battery-runtime', n).actions.some((a) => a.action.kind === 'recommend_part')).toBe(false);
  });
  it('a damaged mains cable stops use (no diagnosis carried on)', () => { expect(run('vacuum-not-running', 'cable').last.conclusion).toMatchObject({ handoff: 'engineer', noPart: true }); });
  it('model tokens such as V6 / V11 / DC35 are identity, never displayed codes', () => {
    const plan = { stateAppliance: 'vacuum', roles: { candModel: [], candCode: ['k1'] }, candidates: { identifiers: [{ id: 'i1', value: 'V6' }], brands: [], components: [] } };
    const a = { k1: { type: 'choice', choice: 'i1', confidence: 0.9 }, mcAppliance: { type: 'choice', choice: 'vacuum', confidence: 0.9 }, mcJourney: { type: 'choice', choice: 'error-code-only', confidence: 0.9 } };
    const { classification: c } = Q.adaptMc1Answers(a, { ...plan, roles: { candCode: [{ key: 'k1', ids: ['i1'] }] } });
    expect(c.identity.displayedCode).toBe(null);
    expect(c.identity.model && c.identity.model.value).toBe('V6');
    expect(c.problem.journey).toBe(null);
    expect(F.vacType({ identity: { model: { value: 'V11' } }, evidence: { observations: {} } }).type).toBe('cordless');
  });
});
describe('round-1 live fixes', () => {
  it('a broken brush bar commits even when "not spinning" was stated (tangles are ruled out by the breakage)', () => {
    const r = H.play(J('vacuum-brush-not-turning'), [V('brush-bar-not-spinning', [O('brushNotSpinning')]), ck('brush-bar-clear', 'fault_seen'), H.model('DC35', 'dyson')], { modelParts: P });
    expect(r.rules).toEqual(['VB10:brush-bar-clear', 'VB20:model', 'VB21:vacuum-brush-bar']);
  });
  it('a trip / blown fuse alone belongs to not-running (sticky safety stop), never legacy', async () => {
    const t = [C({ identity: VI, intent: 'report_fault', problem: { journey: 'trips-electrics' }, safety: { hazard: 'supply_trip' } })];
    expect(await H.ownerOf(L, t, KEYS)).toBe('vacuum-not-running');
    expect(H.play(J('vacuum-not-running'), t).last.kind).toBe('safety_stop');
  });
});
describe('ownership', () => {
  const cases = [
    [[V('lost-suction')], 'vacuum-low-suction'], [[V('pulsing')], 'vacuum-pulsing-cutting-out'], [[V('cuts-out')], 'vacuum-pulsing-cutting-out'],
    [[V('cuts-out', [O('shortRuntime')])], 'vacuum-battery-runtime'], [[V('wont-start')], 'vacuum-not-running'], [[V('wont-start', [O('vacuumCordless'), O('wontCharge')])], 'vacuum-battery-runtime'],
    [[V('wont-start', [O('vacuumCorded'), O('wontCharge')])], 'vacuum-not-running'], [[V('battery-problem')], 'vacuum-battery-runtime'], [[V('brush-bar-not-spinning')], 'vacuum-brush-not-turning'], [[V('noisy')], 'vacuum-noisy'],
  ];
  for (const [t, k] of cases) it(`→ ${k} (${t[0].problem.journey})`, async () => { expect(await H.ownerOf(L, t, KEYS)).toBe(k); });
});
describe('COMPOSE contract', () => {
  it('every action reached obeys the contract', () => {
    for (const k of KEYS) for (const n of Object.keys(SEQ[k])) expect(H.composeProblems(require(PACK(k).compose.replace('./canonical/', '../canonical/')), null, run(k, n).actions)).toEqual([]);
  });
});
afterEach(() => { for (const k of KEYS) delete process.env[PACK(k).killEnv]; });
describe('gates', () => {
  it('per-key kill switch and allow-list', async () => {
    const t = [V('pulsing')]; const k = 'vacuum-pulsing-cutting-out';
    expect((await H.routeWith(L, t, [k])).journey.control).toBe(true);
    expect((await H.routeWith(L, t, KEYS.filter((x) => x !== k))).journey.control).toBe(false);
    process.env[PACK(k).killEnv] = '0';
    expect((await H.routeWith(L, t, KEYS)).journey.control).toBe(false);
  });
});
