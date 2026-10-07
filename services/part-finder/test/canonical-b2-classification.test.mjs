/** Layer A — batch-2 washing-machine mc/1 classification fixtures (exact, real request builder + adapter + oracle). */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { buildCandidates } = require('../canonical/candidates.js');
const Q = require('../canonical/mc1-questions.js');
const H = require('./helpers/mc1-stage-d.cjs');
const { B2 } = require('./fixtures/mc1-b2-fixtures.cjs');

describe('A. batch-2 classification fixtures', () => {
  for (const fx of B2) {
    it(`${fx.group}: ${fx.id} — "${fx.message}"`, () => {
      const state = H.stateFromCtx(fx.ctx);
      const req = Q.buildMc1Request({ latestMessage: fx.message, state, candidates: buildCandidates(fx.message) });
      const { answers, missing } = H.oracleAnswers(fx, req);
      expect(missing).toEqual([]);
      expect(Q.adaptMc1Answers(answers, req.plan, { messageId: fx.id }).classification).toEqual(H.expectedMc1(fx.expect, fx.id));
    });
  }
  it('pending functional tests ask their outcome observation; group targets describe the question', () => {
    const plan = (journey, pending) => Q.buildMc1Request({ latestMessage: 'x', state: H.stateFromCtx({ appliance: ['washing-machine', 'stated'], journey, pending }), candidates: buildCandidates('x') });
    expect(plan('door-problem', { slot: 'CHECK', target: 'door-release-wait' }).plan.pendingObservation).toEqual(['mcPendingObservation', 'doorOpens']);
    expect(plan('overfilling', { slot: 'CHECK', target: 'power-off-fill-test' }).plan.pendingObservation).toEqual(['mcPendingObservation', 'fillsWhenOff']);
    expect(plan('no-heat', { slot: 'CHECK', target: 'hot-wash-test' }).plan.pendingObservation).toEqual(['mcPendingObservation', 'noHeat']);
    expect(plan('vibration', { slot: 'CHECK', target: 'retest' }).plan.pendingObservation).toEqual(['mcPendingObservation', 'faultPersists']);
    expect(plan('noisy', { slot: 'OBSERVATION', target: 'noiseType' }).state.pendingRequest.description).toMatch(/SOUNDS/);
  });
  it('check-target options stay within the Jev option limit per journey; J1–J3 contexts unchanged', () => {
    for (const j of [null, 'not-draining', 'not-spinning', 'leaking', 'not-filling', 'overfilling', 'door-problem', 'vibration', 'noisy', 'no-heat']) {
      const req = Q.buildMc1Request({ latestMessage: 'x', state: H.stateFromCtx({ appliance: ['washing-machine', 'stated'], journey: j || undefined }), candidates: buildCandidates('x') });
      const opts = Object.keys(req.questions.mcCheckA.criteria);
      expect(opts.length).toBeLessThanOrEqual(33);
      if (['not-draining', 'not-spinning', 'leaking', null].includes(j)) expect(opts).not.toContain('transit-bolts');
      if (j === 'vibration') expect(opts).toEqual(expect.arrayContaining(['transit-bolts', 'levelling', 'load-check']));
    }
    expect(Object.keys(Q.buildMc1Request({ latestMessage: 'x', candidates: buildCandidates('x') }).questions.mcJourney.criteria).length).toBeLessThanOrEqual(33);
  });
});
