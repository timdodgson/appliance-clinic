/** Layer A — fridge / freezer and tumble dryer mc/1 classification fixtures (exact, real request builder + adapter + oracle) and family bleed. */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { buildCandidates } = require('../canonical/candidates.js');
const Q = require('../canonical/mc1-questions.js');
const mc1 = require('../canonical/mc1.js');
const H = require('./helpers/mc1-stage-d.cjs');
const { ALL } = require('./fixtures/mc1-fftd-fixtures.cjs');

const opts = (appliance, journey) => Object.keys(Q.buildMc1Request({ latestMessage: 'x', state: H.stateFromCtx({ appliance: [appliance, 'stated'], journey }), candidates: buildCandidates('x') }).questions.mcCheckA.criteria);
const FF_ONLY = ['temp-setting', 'vents-clear', 'condenser-coil-clear', 'defrost-drain', 'ff-door-fit', 'ff-clearance', 'drip-tray'];
const TD_ONLY = ['sensor-bars'];

describe('A. fridge / freezer and tumble dryer classification fixtures', () => {
  for (const fx of ALL) {
    it(`${fx.group}: ${fx.id} — "${fx.message}"`, () => {
      const state = H.stateFromCtx(fx.ctx);
      const req = Q.buildMc1Request({ latestMessage: fx.message, state, candidates: buildCandidates(fx.message) });
      const { answers, missing } = H.oracleAnswers(fx, req);
      expect(missing).toEqual([]);
      expect(Q.adaptMc1Answers(answers, req.plan, { messageId: fx.id }).classification).toEqual(H.expectedMc1(fx.expect, fx.id));
    });
  }
});
describe('family bleed: check targets per appliance context', () => {
  it('fridge context offers only fridge checks (no condensate / container / dryer filter / WM checks)', () => {
    const ff = opts('fridge-freezer', 'not-cooling');
    expect(ff).toEqual(expect.arrayContaining([...FF_ONLY, 'door-seal', 'defrost', 'power-supply']));
    for (const k of ['water-container', 'condenser', 'lint-filter', 'vent-duct', 'sensor-bars', 'drain-filter', 'drive-belt', 'dishwasher-filter', 'door-start-test']) expect(ff).not.toContain(k);
    expect(ff.length).toBeLessThanOrEqual(33);
  });
  it('tumble dryer context offers only dryer checks (condensate / container are dryer-only; no fridge coils)', () => {
    const td = opts('tumble-dryer', 'not-drying');
    expect(td).toEqual(expect.arrayContaining(['lint-filter', 'condenser', 'vent-duct', 'water-container', 'sensor-bars', 'drive-belt', 'door-start-test']));
    for (const k of [...FF_ONLY, 'defrost', 'drain-filter', 'dishwasher-filter', 'spray-arms', 'transit-bolts']) expect(td).not.toContain(k);
    expect(td.length).toBeLessThanOrEqual(33);
  });
  it('fridge / dryer-only checks are never offered in washing-machine, dishwasher or unknown contexts', () => {
    for (const [a, j] of [['washing-machine', 'not-draining'], ['washing-machine', 'noisy'], ['dishwasher', 'not-draining'], ['oven-cooker', 'no-heat'], ['vacuum', 'lost-suction']]) {
      const o = opts(a, j);
      for (const k of [...FF_ONLY, ...TD_ONLY]) expect(o).not.toContain(k);
    }
    const none = Object.keys(Q.buildMc1Request({ latestMessage: 'x', state: null, candidates: buildCandidates('x') }).questions.mcCheckA.criteria);
    for (const k of [...FF_ONLY, ...TD_ONLY]) expect(none).not.toContain(k);
  });
  it('washing-machine and dishwasher check targets are unchanged by this batch', () => {
    expect(opts('dishwasher', 'not-draining')).not.toContain('sensor-bars');
    expect(opts('washing-machine', 'not-draining')).toEqual(expect.arrayContaining(['drain-filter', 'drain-hose', 'pump-impeller']));
  });
  it('compressor / fridge fan questions are scoped to refrigeration; container / dryer type to dryers', () => {
    const q = Q.buildMc1Request({ latestMessage: 'x', state: null, candidates: buildCandidates('x') }).questions;
    expect(q.mcObsFfCompressor.instructions).toMatch(/Only for a FRIDGE \/ FREEZER \(never a heat-pump tumble dryer/);
    expect(q.mcObsFan.instructions).toMatch(/tumble dryer, oven or vacuum fan is not this/);
    expect(q.mcObsTank.instructions).toMatch(/never a dishwasher, washing machine or fridge/);
    expect(q.mcObsDryerType.instructions).toMatch(/not a washer-dryer/);
    expect(q.mcJourney.criteria).toBeTruthy();
    expect(Object.keys(q.mcJourney.criteria).length).toBeLessThanOrEqual(32);
  });
  it('pending dryer door test asks doorRecognised; pending fridge observations are labelled by state', () => {
    const r = Q.buildMc1Request({ latestMessage: 'x', state: H.stateFromCtx({ appliance: TDA(), journey: 'door-problem', pending: { slot: 'CHECK', target: 'door-start-test' } }), candidates: buildCandidates('x') });
    expect(r.plan.pendingObservation).toEqual(['mcPendingObservation', 'doorRecognised']);
    const f = Q.buildMc1Request({ latestMessage: 'x', state: H.stateFromCtx({ appliance: ['fridge-freezer', 'stated'], journey: 'not-cooling', pending: { slot: 'OBSERVATION', target: 'compressorRuns' } }), candidates: buildCandidates('x') });
    expect(f.questions.mcPendingObservation.criteria.no).toMatch(/SILENT/);
  });
  it('every new observation / check key is in the mc/1 vocabulary', () => {
    for (const k of ['noiseStopsWhenDoorOpen', 'clicksNoStart', 'compressorRuns', 'waterInsideFridge', 'leakFromSupplyLine', 'doorLeftOpen', 'iceReturns', 'frostOnBackWall',
      'dryerVented', 'dryerCondenser', 'dryerHeatPump', 'restartsAfterCooling', 'tankStaysEmpty', 'tankWarning', 'drainKitFitted']) expect(mc1.OBSERVATION_KEYS).toContain(k);
    for (const k of [...FF_ONLY, ...TD_ONLY]) { expect(mc1.CHECK_KEYS).toContain(k); expect(Q.CHECK_DESC[k]).toBeTruthy(); }
  });
});
function TDA() { return ['tumble-dryer', 'stated']; }
