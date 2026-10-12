/** Layer A — dishwasher batch-1 mc/1 classification fixtures (exact, real request builder + adapter + oracle). */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { buildCandidates } = require('../canonical/candidates.js');
const Q = require('../canonical/mc1-questions.js');
const H = require('./helpers/mc1-stage-d.cjs');
const { DWF: B2 } = require('./fixtures/mc1-dw-fixtures.cjs');

describe('A. dishwasher classification fixtures', () => {
  for (const fx of B2) {
    it(`${fx.group}: ${fx.id} — "${fx.message}"`, () => {
      const state = H.stateFromCtx(fx.ctx);
      const req = Q.buildMc1Request({ latestMessage: fx.message, state, candidates: buildCandidates(fx.message) });
      const { answers, missing } = H.oracleAnswers(fx, req);
      expect(missing).toEqual([]);
      expect(Q.adaptMc1Answers(answers, req.plan, { messageId: fx.id }).classification).toEqual(H.expectedMc1(fx.expect, fx.id));
    });
  }
  it('dishwasher check targets: dishwasher-only checks never offered in a washing-machine context and vice versa', () => {
    const opts = (appliance, journey) => Object.keys(Q.buildMc1Request({ latestMessage: 'x', state: H.stateFromCtx({ appliance: [appliance, 'stated'], journey }), candidates: buildCandidates('x') }).questions.mcCheckA.criteria);
    const dw = opts('dishwasher', 'not-draining');
    expect(dw).toEqual(expect.arrayContaining(['dishwasher-filter', 'waste-spigot', 'spray-arms', 'door-start-test']));
    expect(dw).not.toContain('drain-filter'); expect(dw).not.toContain('transit-bolts'); expect(dw).not.toContain('door-closed-latched');
    const wm = opts('washing-machine', 'not-draining');
    for (const k of ['waste-spigot', 'loading-clearance', 'dw-dispenser', 'rinse-aid', 'door-start-test', 'spray-arms', 'dishwasher-filter']) expect(wm).not.toContain(k);
    expect(dw.length).toBeLessThanOrEqual(33);
  });
  it('pending dishwasher door test asks doorRecognised', () => {
    const r = Q.buildMc1Request({ latestMessage: 'x', state: H.stateFromCtx({ appliance: ['dishwasher', 'stated'], journey: 'door-problem', pending: { slot: 'CHECK', target: 'door-start-test' } }), candidates: buildCandidates('x') });
    expect(r.plan.pendingObservation).toEqual(['mcPendingObservation', 'doorRecognised']);
  });
});
