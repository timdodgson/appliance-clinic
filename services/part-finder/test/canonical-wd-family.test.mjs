/** Washer-dryer family: wash side reuses the accepted WM journeys through the view (certified separately); native drying side. */
import { describe, it, expect, afterEach } from 'vitest';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
globalThis.awslambda = globalThis.awslambda || { streamifyResponse: (f) => f, HttpResponseStream: { from: (s) => s } };
const H = require('./helpers/b2-journey.cjs');
const L = require('../part-finder-lambda.js')._internal;
const W = require('../canonical/wd-family.js');
const { C, O, K } = H;
const WDI = { appliance: { value: 'washer-dryer', basis: 'stated' } };
const WD = (j, obs = [], extra = {}) => H.opener(j, null, obs, extra, WDI);
const ck = (c, r = 'clear') => C({ checks: [K(c, 'done', r)] });
const ob = (...o) => C({ observations: o });
const PACK = (k) => L.CANONICAL_JOURNEY_PACKS[k];
const J = (k) => require(PACK(k).pipeline.replace('./canonical/', '../canonical/'));
const WASH = W.WASH.map((w) => w[0]);
const KEYS = ['wd-not-drying', ...WASH];
const WM = ['wm-not-draining', 'wm-not-spinning', 'wm-leaking', 'wm-not-filling', 'wm-overfilling', 'wm-door', 'wm-excessive-vibration', 'wm-noisy', 'wm-not-heating'];
const OPEN = {
  'wd-not-draining': [WD('not-draining', [O('waterRemaining')])], 'wd-not-spinning': [WD('not-spinning'), ob(O('waterRemaining', false))], 'wd-leaking': [WD('leaking', [O('leakAtDoor')])],
  'wd-not-filling': [WD('not-filling')], 'wd-overfilling': [WD('overfilling')], 'wd-door': [WD('door-problem', [O('doorOpens', false)])], 'wd-excessive-vibration': [WD('vibration')],
  'wd-noisy': [WD('noisy', [O('noiseOnSpin')])], 'wd-not-heating-wash': [WD('no-heat', [O('noHeat')]), ob(O('wdDrySide', false))], 'wd-not-drying': [WD('not-drying', [O('heatPresent')])],
};
// The same turns typed as a washing machine: the wrapper must reach exactly the WM journey's NextAction (rule / kind / target).
const asWM = (turns) => turns.map((c) => (c.identity && c.identity.appliance && c.identity.appliance.value === 'washer-dryer'
  ? { ...c, identity: { ...c.identity, appliance: { value: 'washing-machine', basis: 'stated' } } } : c));
const DRY = {
  capacity: [[WD('not-drying', [O('heatPresent')]), ck('wd-dry-capacity', 'found_and_cleared'), ob(O('faultPersists', false))], 'WY11:wd-dry-capacity WY6:retest WY7:drying-load-over-capacity'],
  airflow: [[WD('not-drying', [O('heatPresent')]), ck('wd-dry-capacity'), ck('programme-setting'), ck('inlet-hose-tap'), ck('drain-filter')],
    'WY11:wd-dry-capacity WY12:programme-setting WY13:inlet-hose-tap WY14:drain-filter WY22:drying-fan-or-air-duct'],
  heater: [[WD('not-drying', [O('noHeat')]), ck('programme-setting')], 'WY12:programme-setting WY22:drying-heater-or-thermostat'],
  tap: [[WD('not-drying', [O('heatPresent')]), ck('wd-dry-capacity'), ck('programme-setting'), ck('inlet-hose-tap', 'found_and_cleared'), ob(O('faultPersists', false))],
    'WY11:wd-dry-capacity WY12:programme-setting WY13:inlet-hose-tap WY6:retest WY7:condenser-water-supply'],
  sideHandoff: [[WD('no-heat', [O('noHeat'), O('wdDrySide')])], 'WY12:programme-setting'],
};

describe('wash side: the WM journey under the view, certified separately', () => {
  for (const [key, j] of W.WASH.map((w) => [w[0], w[1]])) {
    it(`${key} owns its turns and matches ${j}'s NextAction; state keeps washer-dryer; request stamped with ${key}`, async () => {
      expect(await H.ownerOf(L, OPEN[key], KEYS)).toBe(key);
      const r = H.play(J(key), OPEN[key]);
      const wmKey = WM[W.WASH.findIndex((w) => w[0] === key)];
      expect(wmKey).toBeTruthy();
      const wm = H.play(require(`../canonical/${j}-pipeline.js`), asWM(OPEN[key]));
      const strip = (a) => ({ kind: a.kind, target: a.target, rule: a.rule });
      if (key !== 'wd-not-heating-wash') expect(strip(r.last)).toEqual(strip(wm.last));
      expect(r.state.identity.appliance.value).toBe('washer-dryer');
      expect(r.last.journey).toBe(key);
      const issued = (r.state.requests || []).filter((q) => q.journey);
      expect(issued.every((q) => q.journey === key)).toBe(true);
    });
  }
  it('the washing machine itself is unchanged: WM turns still route to the WM keys', async () => {
    for (const [i, key] of WASH.entries()) {
      if (key === 'wd-not-heating-wash') continue;
      expect(await H.ownerOf(L, asWM(OPEN[key]), [...WM, ...KEYS])).toBe(WM[i]);
    }
    expect(await H.ownerOf(L, [H.opener('no-heat', null, [O('noHeat')])], [...WM, ...KEYS])).toBe('wm-not-heating');
  });
});
describe('"doesn\'t heat" distinguishes wash water from drying air', () => {
  it('side unknown → wd-not-heating-wash asks the side first, once', () => {
    const r = H.play(J('wd-not-heating-wash'), [WD('no-heat', [O('noHeat')]), C({ reply: { toPending: 'cannot_answer' } })]);
    expect(r.rules[0]).toBe('H0:wdDrySide');
    expect(r.rules[1]).not.toBe('H0:wdDrySide');
  });
  it('wash side → the WM heating journey carries on', () => { expect(H.play(J('wd-not-heating-wash'), OPEN['wd-not-heating-wash']).rules).toEqual(['H0:wdDrySide', 'H10:hotProgrammeUsed']); });
  it('drying side → wd-not-drying takes over (one handoff)', async () => {
    expect(await H.ownerOf(L, [WD('no-heat', [O('noHeat')]), ob(O('wdDrySide'))], KEYS)).toBe('wd-not-drying');
    expect(await H.ownerOf(L, [WD('no-heat', [O('noHeat')], { scope: 'dry_only' })], KEYS)).toBe('wd-not-drying');
  });
});
describe('drying side (native, not the tumble-dryer architecture)', () => {
  for (const [n, [t, e]] of Object.entries(DRY)) it(`wd-not-drying · ${n}`, () => { expect(H.play(J('wd-not-drying'), t).rules.join(' ')).toBe(e); });
  it('load too big for the dry capacity is a no-part outcome', () => { expect(H.play(J('wd-not-drying'), DRY.capacity[0]).last.conclusion).toMatchObject({ noPart: true, handoff: 'none' }); });
  it('no drying-heater part without a drying-heater code AND no heat; the catalogue has no WD parts → never a part', () => {
    const parts = [{ title: 'Drying Heater Element' }];
    const r = H.play(J('wd-not-drying'), [...DRY.heater[0], H.model('WDD7143UK', 'hotpoint')], { modelParts: parts });
    expect(r.actions.some((a) => a.action.kind === 'recommend_part')).toBe(false);
    expect(Object.keys(require('../canonical/wd-not-drying.js').FAMILY)).not.toContain('FL'); // no tumble-dryer lint-filter family
  });
  it('a tumble dryer never reaches the washer-dryer family', async () => {
    expect(await H.ownerOf(L, [H.tdOpener('not-drying', null, [O('heatPresent')])], [...KEYS, 'td-not-drying'])).toBe('td-not-drying');
  });
});
describe('COMPOSE ask guard (final-pass packs)', () => {
  it('an ask reply that invents a component falls back to the fixed template; the WM packs are unchanged', () => {
    const JC = require('../canonical/wd-not-drying.js');
    const r = H.play(J('wd-not-drying'), [WD('not-drying')]);
    const b = JC.brief(r.state, r.last, null, {});
    const bad = JC.checkReply('We need to check if the heating element is working. Partway through drying, are the laundry and the door glass warm, or completely cold?', r.last, b);
    expect(bad.ok).toBe(false); expect(bad.violations).toContain('invented-component');
    const good = JC.checkReply('Let\'s see whether it gets warm. Partway through drying, are the laundry and the door glass warm, or completely cold?', r.last, b);
    expect(good.ok).toBe(true);
    const J9 = require('../canonical/j9-compose.js');
    const w = H.play(J('wd-not-heating-wash'), [WD('no-heat', [O('noHeat')]), ob(O('wdDrySide', false))]);
    expect(J9.checkReply('Is the heater element ok? Which programme and temperature were you using?', w.last, J9.brief(w.state, w.last, null, {})).violations).not.toContain('invented-component');
  });
});
describe('COMPOSE contract', () => {
  it('every action reached obeys the contract', () => {
    for (const k of KEYS) {
      const C2 = require(PACK(k).compose.replace('./canonical/', '../canonical/'));
      expect(H.composeProblems(C2, null, H.play(J(k), OPEN[k]).actions)).toEqual([]);
    }
    const JC = require('../canonical/wd-not-drying.js');
    for (const [t] of Object.values(DRY)) expect(H.composeProblems(JC, null, H.play(J('wd-not-drying'), t).actions)).toEqual([]);
    const J9 = require('../canonical/j9-compose.js');
    expect(H.composeProblems(J9, null, H.play(J('wd-not-heating-wash'), [WD('no-heat', [O('noHeat')])]).actions)).toEqual([]);
  });
});
afterEach(() => { for (const k of KEYS) delete process.env[PACK(k).killEnv]; });
describe('gates', () => {
  it('each WD key is independent of the WM key it reuses', async () => {
    const t = OPEN['wd-leaking'];
    expect((await H.routeWith(L, t, ['wm-leaking'])).journey.control).toBe(false); // the WM gate never controls a washer-dryer
    expect((await H.routeWith(L, t, ['wd-leaking'])).journey.control).toBe(true);
    process.env[PACK('wd-leaking').killEnv] = '0';
    expect((await H.routeWith(L, t, ['wd-leaking'])).journey.control).toBe(false);
    expect((await H.routeWith(L, asWM(t), ['wm-leaking'])).journey.control).toBe(true); // WM unaffected by the WD kill switch
  });
});
