/** Layer A — final-pass (oven / hob / microwave / vacuum / washer-dryer) mc/1 fixtures (real request builder + adapter + oracle) and family bleed. */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { buildCandidates } = require('../canonical/candidates.js');
const Q = require('../canonical/mc1-questions.js');
const H = require('./helpers/mc1-stage-d.cjs');
const { ALL } = require('./fixtures/mc1-final-fixtures.cjs');
const opts = (appliance, journey) => Object.keys(Q.buildMc1Request({ latestMessage: 'x', state: H.stateFromCtx({ appliance: [appliance, 'stated'], journey }), candidates: buildCandidates('x') }).questions.mcCheckA.criteria);
describe('A. final-pass classification fixtures', () => {
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
describe('family-scoped check targets', () => {
  it('each new family is offered only its own checks (within the option limit)', () => {
    const fam = { 'oven-cooker': ['oven-clock-mode', 'oven-door-fit', 'burner-parts-clean'], hob: ['pan-test', 'burner-parts-clean'], microwave: ['mw-door-check', 'turntable-parts', 'mw-cavity-check'],
      vacuum: ['vacuum-bin-filters', 'vacuum-blockage', 'brush-bar-clear', 'vacuum-charger-check', 'programme-setting'] };
    for (const [a, keys] of Object.entries(fam)) {
      const o = opts(a, null);
      expect(o).toEqual(expect.arrayContaining(keys));
      for (const k of ['drain-filter', 'lint-filter', 'temp-setting', 'dishwasher-filter', 'wd-dry-capacity']) expect(o).not.toContain(k);
      expect(o.length).toBeLessThanOrEqual(33);
    }
  });
  it('washer-dryer gets the WM checks plus the dry-capacity check; a washing machine never gets it', () => {
    expect(opts('washer-dryer', 'not-drying')).toEqual(expect.arrayContaining(['wd-dry-capacity', 'drain-filter', 'inlet-hose-tap']));
    expect(opts('washing-machine', 'not-draining')).not.toContain('wd-dry-capacity');
    for (const k of ['vacuum-charger-check', 'mw-cavity-check', 'oven-clock-mode']) expect(opts('washing-machine', 'noisy')).not.toContain(k);
  });
  it('fan / door questions are appliance-family scoped', () => {
    const q = Q.buildMc1Request({ latestMessage: 'x', state: null, candidates: buildCandidates('x') }).questions;
    expect(q.mcObsOvenFan.instructions).toMatch(/Only for an OVEN/);
    expect(q.mcObsOvenFan.instructions).toMatch(/fridge, dryer or microwave fan is not this/);
    expect(q.mcObsWdSide.instructions).toMatch(/Only for a WASHER-DRYER/);
    expect(Object.keys(q.mcJourney.criteria).length).toBeLessThanOrEqual(32);
  });
});
