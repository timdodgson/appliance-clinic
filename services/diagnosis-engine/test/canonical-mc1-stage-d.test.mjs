/**
 * Stage D (B–E): message-only canonical mc/1 classifier — question set + adapter, exact typed assertions.
 *
 * Every fixture is run through the REAL request builder (candidates + context-dependent questions) and
 * the REAL adapter, answered by an oracle that can only pick options the request actually offers. So a
 * fixture passes only if (a) the needed value is a candidate, (b) the needed question exists in that
 * context, and (c) the adapter maps it to exactly the expected mc/1 with every other leaf null/empty.
 * Semantic accuracy of real Jev is measured separately by the live evaluation (same fixtures).
 */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { buildCandidates } = require('../canonical/candidates.js');
const Q = require('../canonical/mc1-questions.js');
const { merge } = require('../canonical/merge.js');
const cs1 = require('../canonical/cs1.js');
const { ALL, FIXTURES, CONTEXT, NO_RETENTION, RECALL, WM } = require('./fixtures/mc1-stage-d-fixtures.cjs');
const H = require('./helpers/mc1-stage-d.cjs');

function run(fx) {
  const state = H.stateFromCtx(fx.ctx);
  const req = Q.buildMc1Request({ latestMessage: fx.message, priorAssistantMessage: fx.prior || null, state, candidates: buildCandidates(fx.message) });
  const { answers, missing } = H.oracleAnswers(fx, req);
  const out = Q.adaptMc1Answers(answers, req.plan, { messageId: fx.id });
  return { req, out, missing, state };
}

describe('fixture corpus size', () => {
  it('50–90 focused message fixtures', () => {
    expect(FIXTURES.length).toBeGreaterThanOrEqual(50);
    expect(ALL.length).toBeLessThanOrEqual(90);
  });
});

describe('B. message classification fixtures (exact mc/1, all unasserted leaves null/empty)', () => {
  for (const fx of ALL) {
    it(`${fx.group}: ${fx.id} — "${fx.message}"`, () => {
      const { out, missing } = run(fx);
      expect(missing).toEqual([]);
      expect(out.classification).toEqual(H.expectedMc1(fx.expect, fx.id));
      if (fx.expect.partNumber) expect(out.meta.partNumber).toBe(fx.expect.partNumber);
      if (fx.expect.recallGap) expect(out.meta.recallGap && out.meta.recallGap.type).toBe(fx.expect.recallGap);
    });
  }
});

describe('C. context: questions exist only where structured context makes them meaningful', () => {
  it('toPending is asked only when a structured pendingRequest exists (never from assistant prose)', () => {
    const withPending = run(CONTEXT.find((f) => f.id === 'cx-clear-filter')).req;
    const noPending = run(CONTEXT.find((f) => f.id === 'cx-clear-nothing')).req;
    expect(withPending.questions.mcToPending).toBeTruthy();
    expect(withPending.state.pendingRequest).toMatchObject({ slot: 'CHECK', target: 'drain-filter' });
    expect(noPending.questions.mcToPending).toBeUndefined();
    const prose = Q.buildMc1Request({ latestMessage: "It's clear", priorAssistantMessage: 'Please check the drain filter. Is it clear?', state: H.stateFromCtx(WM), candidates: buildCandidates("It's clear") });
    expect(prose.questions.mcToPending).toBeUndefined();
    expect(prose.state.pendingRequest).toBeNull();
  });
  it('a stray toPending answer without pending context is ignored', () => {
    const fx = CONTEXT.find((f) => f.id === 'cx-dk-nothing');
    const { req } = run(fx);
    const out = Q.adaptMc1Answers({ mcScope: { type: 'choice', choice: 'appliance', confidence: 0.9 }, mcToPending: { type: 'choice', choice: 'cannot_answer', confidence: 0.9 } }, req.plan);
    expect(out.classification.reply.toPending).toBeNull();
  });
  it('same message, different pending -> different check target', () => {
    const f = run(CONTEXT.find((x) => x.id === 'cx-clear-filter')).out.classification.checks;
    const h = run(CONTEXT.find((x) => x.id === 'cx-clear-hose')).out.classification.checks;
    expect(f).toEqual([{ check: 'drain-filter', status: 'done', result: 'clear' }]);
    expect(h).toEqual([{ check: 'drain-hose', status: 'done', result: 'clear' }]);
  });
  it('pending description is structured (slot/target), with fixed wording only', () => {
    const { req } = run(CONTEXT.find((x) => x.id === 'cx-dk-model'));
    expect(req.state.pendingRequest).toEqual({ slot: 'IDENTITY', target: 'model', description: 'We asked the customer for the appliance model number.' });
  });
  it('correction questions exist only for fields present in state', () => {
    const empty = Q.buildMc1Request({ latestMessage: "Actually it's a dishwasher", state: null, candidates: buildCandidates('x') });
    expect(Object.keys(empty.questions).filter((k) => k.startsWith('mcCorrect__'))).toEqual([]);
    const wm = Q.buildMc1Request({ latestMessage: "Actually it's a dishwasher", state: H.stateFromCtx({ ...WM, make: 'hotpoint', checks: { 'drain-filter': ['done', 'clear'] } }), candidates: buildCandidates('x') });
    expect(wm.plan.correctable.map(([, p]) => p)).toEqual(['identity.appliance', 'identity.make', 'problem.journey', 'checks.drain-filter']);
  });
});

describe('D. no retention: state is context, never copied into mc/1', () => {
  it('"I don\'t know" with washing-machine / not-draining in state -> no appliance, no journey', () => {
    const fx = NO_RETENTION.find((f) => f.id === 'nr-dont-know');
    const { out, req } = run(fx);
    expect(req.state.currentState.appliance).toBe('washing-machine');
    expect(req.state.currentState.activeProblem.journey).toBe('not-draining');
    expect(out.classification.identity.appliance).toEqual({ value: null, basis: null });
    expect(out.classification.problem.journey).toBeNull();
    expect(out.classification.observations).toEqual([]);
  });
  it('merge retains appliance + journey across the sparse turn', () => {
    const fx = NO_RETENTION.find((f) => f.id === 'nr-dont-know');
    const { out, state } = run(fx);
    const { state: next } = merge(state, out.classification, { turn: state.version + 1 });
    expect(next.identity.appliance.value).toBe('washing-machine');
    expect(cs1.activeProblem(next).journey.value).toBe('not-draining');
    expect(next.version).toBe(state.version + 1);
  });
  it('the adapter never reads state: identical answers give identical mc/1 with or without context', () => {
    const fx = NO_RETENTION.find((f) => f.id === 'nr-yes');
    const a = run(fx).out.classification;
    const b = run({ ...fx, ctx: null }).out.classification;
    expect(a).toEqual(b);
  });
});

describe('E. stated vs inferred provenance (strict)', () => {
  const basis = (id) => run(ALL.find((f) => f.id === id)).out.classification.identity.appliance;
  it('Dyson -> vacuum inferred, make dyson stated', () => {
    const c = run(ALL.find((f) => f.id === 'id-dyson-inferred')).out.classification;
    expect(c.identity.appliance).toEqual({ value: 'vacuum', basis: 'inferred' });
    expect(c.identity.make).toEqual({ value: 'dyson', basis: 'stated' });
  });
  it('"vacuum" / "hoover" as a noun -> stated; Hoover as brand of a washing machine -> make', () => {
    expect(basis('id-vacuum-stated')).toEqual({ value: 'vacuum', basis: 'stated' });
    expect(basis('id-hoover-noun')).toEqual({ value: 'vacuum', basis: 'stated' });
    const c = run(ALL.find((f) => f.id === 'id-hoover-brand-wm')).out.classification;
    expect(c.identity.make).toEqual({ value: 'hoover', basis: 'stated' });
  });
  it('model-only follow-up restates no appliance', () => {
    expect(basis('id-model-only-followup')).toEqual({ value: null, basis: null });
    expect(basis('id-neff-model-followup')).toEqual({ value: null, basis: null });
  });
  it('an unclear/absent basis answer is NEVER promoted to stated', () => {
    const fx = ALL.find((f) => f.id === 'id-vacuum-stated');
    const { req, out: base } = run(fx);
    const { answers } = H.oracleAnswers(fx, req);
    for (const b of [{ type: 'choice', choice: 'none', confidence: 0.9 }, { type: 'choice', choice: 'stated', confidence: 0.3 }, undefined]) {
      const out = Q.adaptMc1Answers({ ...answers, mcApplianceBasis: b }, req.plan);
      expect(out.classification.identity.appliance).toEqual({ value: 'vacuum', basis: 'inferred' });
    }
    expect(base.classification.identity.appliance.basis).toBe('stated');
  });
  it('component-derived family is inferred', () => {
    const msg = 'water is pouring out of the soap drawer';
    const req = Q.buildMc1Request({ latestMessage: msg, candidates: buildCandidates(msg) });
    const out = Q.adaptMc1Answers({ mcScope: { type: 'choice', choice: 'appliance', confidence: 0.9 }, mcAppliance: { type: 'choice', choice: 'washing-machine', confidence: 0.8 },
      mcApplianceBasis: { type: 'choice', choice: 'inferred', confidence: 0.8 } }, req.plan);
    expect(out.classification.identity.appliance).toEqual({ value: 'washing-machine', basis: 'inferred' });
  });
  it('customer correction: stated value + correction path', () => {
    const c = run(ALL.find((f) => f.id === 'co-dishwasher')).out.classification;
    expect(c.identity.appliance).toEqual({ value: 'dishwasher', basis: 'stated' });
    expect(c.reply.correction).toEqual(['identity.appliance']);
  });
});

describe('question set hygiene (no policy questions, latest-message scoped)', () => {
  const req = run(FIXTURES[0]).req;
  it('no legacy policy / conversation-wide question keys', () => {
    for (const k of ['needMoreInfo', 'identitySufficiency', 'moreDiscriminationRequired', 'normalBehaviour', 'partReadiness',
      'latestTurnEstablishes', 'answeredPrevious', 'cannotAnswer', 'onTopic', 'userIntent', 'applianceFamilyProvenance']) {
      expect(req.questions[k]).toBeUndefined();
    }
  });
  it('every question is explicitly scoped to the latest customer message', () => {
    for (const [k, q] of Object.entries(req.questions)) expect([k, /latest customer message|LATEST customer message/i.test(q.instructions)]).toEqual([k, true]);
  });
  it('Jev state carries only the allowed context (no prior customer turns / transcript)', () => {
    expect(Object.keys(req.state).sort()).toEqual(['brandMentions', 'componentMentions', 'currentState', 'identifierCandidates',
      'latestCustomerMessage', 'pendingRequest', 'priorAssistantMessage', 'task'].sort());
  });
  it('every choice question stays within 32 options + none', () => {
    for (const q of Object.values(req.questions)) if (q.type === 'choice') expect(Object.keys(q.criteria).length).toBeLessThanOrEqual(33);
  });
  it('one semantic fact, one field: options never emit derived siblings', () => {
    for (const o of Q.OBS) if (o.options) for (const v of Object.values(o.options)) expect(v.length).toBe(3); // [key, value, desc]
  });
});

describe('adapter thresholds and safety of defaults', () => {
  const fx = FIXTURES[0];
  const { req } = run(fx);
  it('below-threshold / uncertain / missing answers are not stated', () => {
    const out = Q.adaptMc1Answers({ mcScope: { type: 'choice', choice: 'appliance', confidence: 0.9 },
      mcJourney: { type: 'choice', choice: 'not-draining', confidence: 0.3 }, mcHazard: { type: 'choice', choice: 'uncertain', confidence: 0.9 },
      mcObsWaterReturns: { type: 'noul', noul: 0.6 } }, req.plan);
    expect(out.classification).toEqual(H.expectedMc1({ scope: 'appliance' }));
    expect(out.meta.uncertain).toContain('mcJourney');
  });
  it('empty answers -> scope unclear, everything null (never a guess)', () => {
    expect(Q.adaptMc1Answers({}, req.plan).classification).toEqual(H.expectedMc1({}));
  });
  it('invalid enum values are rejected by mc/1 validation', () => {
    const out = Q.adaptMc1Answers({ mcScope: { type: 'choice', choice: 'appliance', confidence: 0.9 }, mcJourney: { type: 'choice', choice: 'made-up', confidence: 0.99 } }, req.plan);
    expect(out.classification.problem.journey).toBeNull();
  });
  it('a token chosen as the model is not also the displayed code', () => {
    const msg = 'Hotpoint WMUD962P';
    const r = Q.buildMc1Request({ latestMessage: msg, candidates: buildCandidates(msg) });
    const t = r.plan.candidates.identifiers[0].id;
    const out = Q.adaptMc1Answers({ candModel: { type: 'choice', choice: t, confidence: 0.9 }, candCode: { type: 'choice', choice: t, confidence: 0.9 } }, r.plan);
    expect(out.classification.identity.model.value).toBe('WMUD962P');
    expect(out.classification.identity.displayedCode).toBeNull();
  });
  it('degraded classification: scope unclear, everything null', () => {
    const d = Q.degradedClassification('m1', 'TIMEOUT');
    expect(d.meta).toMatchObject({ degraded: true, reason: 'TIMEOUT' });
    expect(d.classification).toEqual(H.expectedMc1({}, 'm1'));
  });
});

describe('recall fixtures', () => {
  it('digit-free model name -> recall gap, model null', () => {
    const { out } = run(RECALL[0]);
    expect(out.classification.identity.model.value).toBeNull();
    expect(out.meta.recallGap).toEqual({ type: 'model', roleFilled: false });
  });
});
