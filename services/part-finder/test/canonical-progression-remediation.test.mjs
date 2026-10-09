/**
 * GOLD v2 remediation, progression and classification (typed turns, no scenario text): new facts supersede a question
 * (judged against the pre-merge state); an ignored request is not re-asked; an owner check the customer moved past is
 * carried into the conclusion; a repeated conclusion is a short follow-up; a stated dryer type narrows the classifier's
 * check choices; the check-result question is self-contained.
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

describe('progression: new facts, ignored requests, owner checks, repeated conclusions', () => {
  const withPending = () => rq.issueRequest(emptyState('cs_x'), { slot: 'OBSERVATION', target: 'leakLocation', purpose: 'DIAGNOSIS' }, 1).state;
  it('a restated known fact is not new: the unanswered question is cannot_answer, not superseded', () => {
    const before = { ...withPending(), evidence: { observations: { noHeat: { value: true, turn: 1 } }, checks: {}, replacedParts: [], customerTheories: [] } };
    expect(rq.recordOutcome(before, C({ observations: [O('noHeat')] }), 2, before).outcome).toBe('cannot_answer');
    expect(rq.recordOutcome(before, C({ observations: [O('leaksOnDrain')] }), 2, before).outcome).toBe('superseded');
  });
  it('a model given instead of an answer supersedes the request (identity is judged against the pre-merge state)', () => {
    const r = H.play(J('dw-not-draining'), [open('dishwasher', 'not-draining', [O('waterRemaining')]), H.model('SMS25AW00G', 'bosch')]);
    expect(r.state.requests[0]).toMatchObject({ target: 'dishwasher-filter', outcome: 'superseded' });
  });
  it('an ignored owner check is not re-asked; the conclusion carries it once, with its safety requirements', () => {
    const r = H.play(J('mw-not-starting'), [open('microwave', 'wont-start', [O('noPower')]), C({ reply: { toPending: 'cannot_answer' } })]);
    expect(r.rules).toEqual(['MS11:power-supply', 'MS22:supply-or-plug-fuse']);
    expect(r.last.conclusion.ownerCheck).toBe('power-supply');
    expect(r.last.requires).toEqual(['no_live_electrical_checks']);
    expect(text('mw-not-starting', r)).toMatch(/try another appliance in that socket/);
  });
  it('the same conclusion with nothing new since is a short follow-up, not a repeat', () => {
    const r = H.play(J('mw-not-starting'), [open('microwave', 'wont-start', [O('noPower')]), C({ reply: { toPending: 'cannot_answer' } }), C({})]);
    expect(r.rules.slice(-1)).toEqual(['MS22:supply-or-plug-fuse']);
    expect(r.last.conclusion.repeat).toBe(true);
    const t = text('mw-not-starting', r);
    expect(t).toMatch(/nothing changes from what I said/);
    expect(t).not.toMatch(/try another appliance/);
  });
});

describe('classifier: dryer type narrows the check choices; check result is self-contained', () => {
  const state = (obs) => {
    const s = emptyState('cs_x');
    s.identity.appliance = { value: 'tumble-dryer', basis: 'stated', turn: 1 };
    for (const [k, v] of Object.entries(obs)) s.evidence.observations[k] = { value: v, basis: 'stated', turn: 1 };
    return s;
  };
  const crit = (obs) => Object.keys(Q.buildMc1Request({ latestMessage: 'x', state: state(obs), candidates: { identifiers: [], brands: [], components: [] } }).questions.mcCheckA.criteria);
  it('vented → no condenser / water container; condenser → no vent duct', () => {
    expect(crit({ dryerVented: true })).not.toEqual(expect.arrayContaining(['condenser']));
    expect(crit({ dryerVented: true })).toEqual(expect.arrayContaining(['lint-filter', 'vent-duct']));
    expect(crit({ dryerCondenser: true })).not.toEqual(expect.arrayContaining(['vent-duct']));
  });
  it('the result question never refers to another question\'s answer', () => {
    const q = Q.buildMc1Request({ latestMessage: 'x', state: null, candidates: { identifiers: [], brands: [], components: [] } }).questions;
    expect(q.mcCheckAResult.instructions).not.toMatch(/mcCheck/);
    expect(q.mcCheckBResult.instructions).not.toMatch(/mcCheck/);
  });
  it('a check whose target is clear but whose result answer is "none" counts as done when "done" outweighs "not done"', () => {
    const plan = { checks: [['mcCheckA', 'mcCheckAResult']], questionKeys: [], candidates: { identifiers: [], brands: [], components: [] }, roles: {} };
    const out = Q.adaptMc1Answers({
      mcCheckA: { type: 'choice', choice: 'lint-filter', probabilities: { 'lint-filter': 0.98, none: 0.02 }, confidence: 0.98 },
      mcCheckAResult: { type: 'choice', choice: 'none', probabilities: { done_found_and_cleared: 0.3, done_no_result: 0.1, not_done: 0.05, none: 0.55 }, confidence: 0.55 },
    }, plan, {});
    expect(out.classification.checks).toEqual([expect.objectContaining({ check: 'lint-filter', status: 'done', result: 'found_and_cleared' })]);
  });
});
