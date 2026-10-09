/**
 * GOLD v2 remediation, journey diagnostics (typed turns, no scenario text): a microwave hum while it heats normally is
 * normal (the HV boundary stays for no heat / sparking); a corded vacuum never takes the battery path; a dishwasher filter
 * cleaned with water still standing moves on to the next owner-safe checks; water inside a warm fridge is the defrost
 * drain; a washer-dryer leak only while drying is the condensed-water path.
 */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
globalThis.awslambda = globalThis.awslambda || { streamifyResponse: (f) => f, HttpResponseStream: { from: (s) => s } };
const H = require('./helpers/b2-journey.cjs');
const L = require('../part-finder-lambda.js')._internal;
const rq = require('../canonical/requests.js');
const Q = require('../canonical/mc1-questions.js');
const { emptyState } = require('../canonical/cs1.js');
const { C, O, K } = H;
const ap = (a) => ({ appliance: { value: a, basis: 'stated' } });
const open = (a, j, obs = []) => H.opener(j, null, obs, {}, ap(a));
const ck = (c, r = 'clear') => C({ checks: [K(c, 'done', r)] });
const ob = (...o) => C({ observations: o });
const PACK = (k) => L.CANONICAL_JOURNEY_PACKS[k];
const J = (k) => require(PACK(k).pipeline.replace('./canonical/', '../canonical/'));
const compose = (k) => require(PACK(k).compose.replace('./canonical/', '../canonical/'));
const text = (k, r) => { const JC = compose(k); return JC.template(JC.brief(r.state, r.last, null, {})); };

describe('microwave: a normal running hum vs the HV boundary', () => {
  const MW = (obs) => open('microwave', 'noisy', obs);
  it('a hum while it heats normally → normal running hum, no part, no handoff', () => {
    const r = H.play(J('mw-noisy-sparking'), [MW([O('humNoise'), O('heatPresent')])]);
    expect(r.rules).toEqual(['MN5:normal-operating-hum']);
    expect(r.last.conclusion).toMatchObject({ handoff: 'none', noPart: true });
  });
  it('a hum with the heat unknown asks about the heat first', () => {
    expect(H.play(J('mw-noisy-sparking'), [MW([O('humNoise')]), ob(O('heatPresent'))]).rules).toEqual(['MN14:heatState', 'MN5:normal-operating-hum']);
  });
  it('a hum with NO heat stays on the HV side (engineer, stop using it)', () => {
    const r = H.play(J('mw-noisy-sparking'), [MW([O('humNoise'), O('noHeat')])]);
    expect(r.last).toMatchObject({ rule: 'MN22', target: 'high-voltage-noise' });
    expect(r.last.conclusion.handoff).toBe('engineer');
  });
  it('a hum with sparking is never "normal"', () => {
    const r = H.play(J('mw-noisy-sparking'), [C({ identity: ap('microwave'), intent: 'report_fault', problem: { journey: 'sparking' }, observations: [O('humNoise'), O('heatPresent')], safety: { hazard: 'microwave_arcing' } })]);
    expect(r.last.kind).toBe('safety_stop');
  });
});

describe('vacuum: a corded vacuum has no battery', () => {
  const KEYS = ['vacuum-low-suction', 'vacuum-pulsing-cutting-out', 'vacuum-not-running', 'vacuum-brush-not-turning', 'vacuum-battery-runtime', 'vacuum-noisy'];
  it('corded + cuts out after a short run → the airflow (pulsing / cut-out) path, not the battery', async () => {
    expect(await H.ownerOf(L, [open('vacuum', 'cuts-out', [O('vacuumCorded'), O('shortRuntime')])], KEYS)).toBe('vacuum-pulsing-cutting-out');
    expect(await H.ownerOf(L, [open('vacuum', 'battery-problem', [O('vacuumCorded')])], KEYS)).toBe('vacuum-pulsing-cutting-out');
  });
  it('cordless + short runtime keeps the battery path', async () => {
    expect(await H.ownerOf(L, [open('vacuum', 'cuts-out', [O('vacuumCordless'), O('shortRuntime')])], KEYS)).toBe('vacuum-battery-runtime');
  });
});

describe('dishwasher: filter cleaned but water still standing → the next owner-safe checks before any handoff', () => {
  it('pump cover → drain hose follow', () => {
    const r = H.play(J('dw-not-draining'), [open('dishwasher', 'not-draining', [O('waterRemaining')]),
      C({ checks: [K('dishwasher-filter', 'done', 'found_and_cleared')], observations: [O('faultPersists')] }), ck('pump-impeller')]);
    expect(r.rules).toEqual(['A11:dishwasher-filter', 'A12:pump-impeller', 'A13:drain-hose']);
  });
});

describe('fridge freezer: poor cooling with water inside is one fault (defrost drain)', () => {
  const FF = (obs) => open('fridge-freezer', 'not-cooling', obs);
  it('water inside → the defrost drain check; cleared + cold again → no part', () => {
    const r = H.play(J('ff-not-cooling'), [FF([O('bothCompartmentsWarm'), O('waterInsideFridge'), O('doorLeftOpen', false)]),
      ck('defrost-drain', 'found_and_cleared'), ob(O('faultPersists', false))]);
    expect(r.rules).toEqual(['FC23:defrost-drain', 'FC6:retest', 'FC7:blocked-defrost-drain']);
  });
  it('without water inside the drain is never asked', () => {
    expect(H.play(J('ff-not-cooling'), [FF([O('bothCompartmentsWarm'), O('doorLeftOpen', false)])]).rules).toEqual(['FC13:temp-setting']);
  });
});

describe('washer-dryer: a leak only while drying is the condensed-water path', () => {
  const WD = (j, obs) => open('washer-dryer', j, obs);
  const KEYS = ['wd-not-drying', 'wd-leaking'];
  it('routes to the drying side; pump filter → drain hose → condenser water path (engineer)', async () => {
    expect(await H.ownerOf(L, [WD('leaking', [O('wdDrySide')])], KEYS)).toBe('wd-not-drying');
    const r = H.play(J('wd-not-drying'), [WD('leaking', [O('wdDrySide')]), ck('drain-filter'), ck('drain-hose')]);
    expect(r.rules).toEqual(['WY15:drain-filter', 'WY16:drain-hose', 'WY22:condenser-water-path']);
    expect(r.last.conclusion.handoff).toBe('engineer');
  });
  it('a wash-side leak stays on the wash side', async () => {
    expect(await H.ownerOf(L, [WD('leaking', [O('leakAtDoor'), O('wdDrySide', false)])], KEYS)).toBe('wd-leaking');
  });
});
