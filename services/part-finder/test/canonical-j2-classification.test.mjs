/**
 * Layer A — Journey 2 mc/1 classification fixtures (exact typed mc/1 through the REAL request builder and
 * adapter, answered by an oracle that can only choose options the request offers). Live Jev accuracy on
 * the same fixtures: test/live/mc1-stage-d-eval.mjs --set j2.
 */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { buildCandidates } = require('../canonical/candidates.js');
const Q = require('../canonical/mc1-questions.js');
const H = require('./helpers/mc1-stage-d.cjs');
const { J2 } = require('./fixtures/mc1-j2-fixtures.cjs');

describe('A. Journey 2 classification fixtures', () => {
  for (const fx of J2) {
    it(`${fx.group}: ${fx.id} — "${fx.message}"`, () => {
      const state = H.stateFromCtx(fx.ctx);
      const req = Q.buildMc1Request({ latestMessage: fx.message, priorAssistantMessage: fx.prior || null, state, candidates: buildCandidates(fx.message) });
      const { answers, missing } = H.oracleAnswers(fx, req);
      expect(missing).toEqual([]);
      expect(Q.adaptMc1Answers(answers, req.plan, { messageId: fx.id }).classification).toEqual(H.expectedMc1(fx.expect, fx.id));
    });
  }
  it('pending G3 checks ask the outcome observation (empty-spin-test -> spinsEmpty, door -> doorLocks, spin-command -> commandedSpin)', () => {
    for (const [target, key] of [['empty-spin-test', 'spinsEmpty'], ['door-closed-latched', 'doorLocks'], ['spin-command', 'commandedSpin'], ['drain-command', 'commandedDrain']]) {
      const req = Q.buildMc1Request({ latestMessage: 'yes', state: H.stateFromCtx({ appliance: ['washing-machine', 'stated'], journey: 'not-spinning', pending: { slot: 'CHECK', target } }), candidates: buildCandidates('yes') });
      expect(req.plan.pendingObservation).toEqual(['mcPendingObservation', key]);
    }
  });
});
