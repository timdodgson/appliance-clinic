/** Layer A — Journey 3 mc/1 classification fixtures (exact, real request builder + adapter + oracle). */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { buildCandidates } = require('../canonical/candidates.js');
const Q = require('../canonical/mc1-questions.js');
const H = require('./helpers/mc1-stage-d.cjs');
const { J3 } = require('./fixtures/mc1-j3-fixtures.cjs');
describe('A. Journey 3 classification fixtures', () => {
  for (const fx of J3) {
    it(`${fx.group}: ${fx.id} — "${fx.message}"`, () => {
      const state = H.stateFromCtx(fx.ctx);
      const req = Q.buildMc1Request({ latestMessage: fx.message, state, candidates: buildCandidates(fx.message) });
      const { answers, missing } = H.oracleAnswers(fx, req);
      expect(missing).toEqual([]);
      expect(Q.adaptMc1Answers(answers, req.plan, { messageId: fx.id }).classification).toEqual(H.expectedMc1(fx.expect, fx.id));
    });
  }
  it('pending leak retest asks leakRecurs; group targets describe the question', () => {
    const st = H.stateFromCtx({ appliance: ['washing-machine', 'stated'], journey: 'leaking', pending: { slot: 'CHECK', target: 'leak-retest' } });
    expect(Q.buildMc1Request({ latestMessage: 'dry', state: st, candidates: buildCandidates('dry') }).plan.pendingObservation).toEqual(['mcPendingObservation', 'leakRecurs']);
    const st2 = H.stateFromCtx({ appliance: ['washing-machine', 'stated'], journey: 'leaking', pending: { slot: 'OBSERVATION', target: 'leakLocation' } });
    expect(Q.buildMc1Request({ latestMessage: 'front', state: st2, candidates: buildCandidates('front') }).state.pendingRequest.description).toMatch(/WHERE/);
  });
});
