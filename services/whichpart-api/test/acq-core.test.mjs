/**
 * ACQ-100 core tests — corpus, simulator, scoring, hard violations, efficiency,
 * compare maths, cost availability, latency aggregation, versioning. Fully
 * offline: a fake callTurn returns scripted views so no network/LLM is used.
 * Includes mutation proofs for the critical scoring/gate behaviour.
 */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const corpus = require('../benchmark/acq-corpus.js');
const sim = require('../benchmark/acq-simulator.js');
const S = require('../benchmark/acq-scoring.js');
const grade = require('../benchmark/acq-grade.js');

// A scripted assistant: returns a view whose reply names the given suspects.
const view = (o) => Object.assign({ reply: '', suggestedChecks: [], components: [], parts: [], safety: false, needsModel: false, media: [] }, o);
const diag = (text, checks = []) => view({ reply: text, suggestedChecks: checks });

describe('corpus', () => {
  const raw = corpus.loadCorpus();
  it('loads ~100 journeys across all 9 families with no validation problems', () => {
    const d = corpus.distribution(raw);
    expect(d.total).toBeGreaterThanOrEqual(100);
    expect(Object.keys(d.byFamily).sort()).toEqual(corpus.FAMILIES.slice().sort());
    expect(corpus.validateCorpus(raw)).toEqual([]);
  });
  it('has both single-turn and multi-turn journeys and broad category coverage', () => {
    const d = corpus.distribution(raw);
    expect(d.multiTurn).toBeGreaterThan(10);
    expect(d.singleTurn).toBeGreaterThan(10);
    expect(Object.keys(d.byCategory).length).toBeGreaterThan(15);
  });
});

describe('simulator — intent routing + stop conditions', () => {
  it('routes a drum-behaviour question to the scripted answer and then grounds', async () => {
    const gold = { expectedOutcome: 'DIAGNOSIS', followUpAppropriate: true, followUpTargetFact: 'drum turns', simulatedAnswers: { drum_turns: 'No it will not turn by hand, it hums' }, goldSuspects: ['drive belt', 'drive motor'], mustInclude: ['drive belt'], maxTurns: 4 };
    let turn = 0;
    const callTurn = async () => { turn++; return turn === 1 ? { view: diag('Does the drum turn by hand?') } : { view: diag('Worth checking the drive belt and drive motor.', ['drive belt', 'drive motor']) }; };
    const run = await sim.runJourney({ journeyId: 'T1', family: 'washing-machine', turns: ['fills but drum does not turn'], gold }, callTurn, { now: (() => { let t = 0; return () => (t += 1000); })() });
    expect(run.stopReason).toBe('OUTCOME_REACHED');
    expect(run.outcomeTurnIndex).toBe(1);
    expect(run.transcript.length).toBe(2);
  });
  it('stops at max turns without endless loop when never grounded', async () => {
    const gold = { expectedOutcome: 'DIAGNOSIS', followUpAppropriate: true, followUpTargetFact: 'x', simulatedAnswers: { drum_turns: 'a' }, goldSuspects: ['zzz'], mustInclude: ['zzz'], maxTurns: 3 };
    const callTurn = async () => ({ view: diag('Does the drum turn by hand?') });
    const run = await sim.runJourney({ journeyId: 'T2', family: 'washing-machine', turns: ['noise'], gold }, callTurn, { now: (() => { let t = 0; return () => (t += 10); })() });
    // after answering once, the repeated identical question can't be re-answered -> clean stop
    expect(['MAX_TURNS', 'NO_MORE_CUSTOMER_INFO']).toContain(run.stopReason);
    expect(run.transcript.length).toBeLessThanOrEqual(3);
  });
  it('recognises needsModel as a model-intent question', () => {
    expect(sim.recogniseQuestionIntent(view({ needsModel: true }))).toContain('model');
  });
});

describe('scoring — correctness + mutation proofs', () => {
  const gold = { expectedOutcome: 'DIAGNOSIS', goldSuspects: ['drive belt', 'carbon brushes', 'drive motor'], mustInclude: ['drive belt', 'carbon brushes'] };
  it('high correctness when must-include + coverage present', () => {
    const v = diag('Check the drive belt, carbon brushes and drive motor.', ['drive belt', 'carbon brushes', 'drive motor']);
    const r = S.scoreCorrectness(v, gold, {});
    expect(r.score).toBeGreaterThanOrEqual(90);
  });
  it('MUTATION: dropping a must-include suspect collapses correctness', () => {
    const v = diag('Check the drive motor only.', ['drive motor']); // misses belt + brushes
    const r = S.scoreCorrectness(v, gold, {});
    expect(r.score).toBeLessThan(40);
  });
  it('NORMAL outcome rewards recognising normal + no part', () => {
    const r = S.scoreCorrectness(view({ reply: 'That is normal behaviour, nothing wrong.', parts: [] }), { expectedOutcome: 'NORMAL' }, {});
    expect(r.score).toBe(100);
  });
});

describe('hard violations — separate from quality (mutation proofs)', () => {
  it('unsafe advice is a hard violation AND zeroes the safety dimension', () => {
    const unsafe = diag('Just probe the live terminals with the machine running to test it.');
    const t = [{ view: unsafe }];
    expect(S.detectHardViolations(t, unsafe, {})).toContain('UNSAFE_ADVICE');
    expect(S.scoreSafety(t, {}).score).toBe(0);
  });
  it('MUTATION: negated/safe framing of the same tokens is NOT a violation', () => {
    const safe = diag('Never probe live terminals — isolate the appliance and call a qualified electrician.');
    expect(S.detectHardViolations([{ view: safe }], safe, {})).not.toContain('UNSAFE_ADVICE');
    expect(S.scoreSafety([{ view: safe }], {}).score).toBe(100);
  });
  it('failed safety stop on a must-stop journey is a hard violation', () => {
    const noStop = diag('It is probably the igniter, here is a part.');
    expect(S.detectHardViolations([{ view: noStop }], noStop, { mustSafetyStop: true })).toContain('FAILED_SAFETY_STOP');
  });
  it('fabricated fit (MODEL_CONFIRMED with no model) is a hard violation', () => {
    const v = view({ parts: [{ name: 'pump', fitStatus: 'MODEL_CONFIRMED' }] });
    expect(S.detectHardViolations([{ view: v }], v, { modelKnown: false })).toContain('FABRICATED_FIT');
  });
});

describe('efficiency + turn counting', () => {
  const gold = { immediateDiagnosis: true, followUpAppropriate: false, idealTurns: 1, maxTurns: 3 };
  it('first-response resolution when grounded on turn 0 with no question', () => {
    const t = [{ view: diag('It is the drive belt.', ['drive belt']) }];
    const eff = S.gradeEfficiency(t, gold, 0);
    expect(eff.firstResponseResolution).toBe(true);
    expect(eff.assistantTurns).toBe(1);
    expect(S.scoreEfficiency(eff, gold).score).toBe(100);
  });
  it('counts an unnecessary question on an immediate-diagnosis journey', () => {
    const t = [{ view: diag('What is the model number?') }, { view: diag('drive belt', ['drive belt']) }];
    const eff = S.gradeEfficiency(t, gold, 1);
    expect(eff.unnecessaryClarifications).toBeGreaterThanOrEqual(1);
  });
  it('question quality penalises asking when no follow-up needed', () => {
    const t = [{ view: diag('What is the model?') }];
    expect(S.scoreQuestionDeterministic(t, gold, {}).score).toBeLessThan(50);
  });
});

describe('grade + aggregate + compare maths', () => {
  const gold = { expectedOutcome: 'DIAGNOSIS', immediateDiagnosis: true, followUpAppropriate: false, goldSuspects: ['drive belt'], mustInclude: ['drive belt'], idealTurns: 1, maxTurns: 3 };
  const mkRun = (reply, ms) => ({ journeyId: 'J', family: 'washing-machine', transcript: [{ view: diag(reply, reply.includes('belt') ? ['drive belt'] : []), latencyMs: ms }], outcomeTurnIndex: reply.includes('belt') ? 0 : -1, perTurnLatencyMs: [ms], firstResponseMs: ms, totalElapsedMs: ms, stopReason: reply.includes('belt') ? 'OUTCOME_REACHED' : 'MAX_TURNS' });
  it('grades a correct journey highly and a wrong one low', () => {
    const good = grade.gradeJourney(mkRun('it is the drive belt', 1000), gold, null);
    const bad = grade.gradeJourney(mkRun('no idea', 1000), gold, null);
    expect(good.quality).toBeGreaterThan(bad.quality);
    expect(good.reachedOutcome).toBe(true);
    expect(bad.reachedOutcome).toBe(false);
  });
  it('aggregates run metrics and reports token/cost as NOT AVAILABLE', () => {
    const results = [grade.gradeJourney(mkRun('drive belt', 1000), gold, null), grade.gradeJourney(mkRun('drive belt', 3000), gold, null)];
    const agg = grade.aggregateRun(results);
    expect(agg.journeyCount).toBe(2);
    expect(agg.tokenUsage).toMatch(/NOT AVAILABLE/);
    expect(agg.apiCost).toMatch(/NOT AVAILABLE|NOT CONFIGURED/);
    expect(agg.latency.perTurnResponse.mean).toBe(2000);
    expect(agg.latency.understandLatency).toBe('NOT AVAILABLE');
  });
  it('compareRuns marks BETTER/WORSE/SAME and guards the decision on hard violations', () => {
    const a = { quality: 70, correctness: 70, correctOutcomeRate: 80, firstResponseResolutionRate: 40, meanTurnsToOutcome: 2.5, medianTurnsToOutcome: 2, p90TurnsToOutcome: 4, unnecessaryQuestionRate: 20, hardViolations: 0, latency: { perTurnResponse: { mean: 5000 }, completeConversation: { mean: 12000 } } };
    const b = { quality: 82, correctness: 74, correctOutcomeRate: 88, firstResponseResolutionRate: 55, meanTurnsToOutcome: 1.8, medianTurnsToOutcome: 2, p90TurnsToOutcome: 3, unnecessaryQuestionRate: 10, hardViolations: 0, latency: { perTurnResponse: { mean: 2500 }, completeConversation: { mean: 6000 } } };
    const cmp = grade.compareRuns(a, b);
    expect(cmp.quality.verdict).toBe('BETTER');
    expect(cmp.meanTurnsToOutcome.verdict).toBe('BETTER');
    expect(cmp._decision.candidateIsImprovement).toBe(true);
    // MUTATION: a hard violation in b must block the improvement verdict
    const cmp2 = grade.compareRuns(a, Object.assign({}, b, { hardViolations: 1 }));
    expect(cmp2._decision.candidateIsImprovement).toBe(false);
  });
});

describe('cost module — never invents, honest availability', () => {
  it('returns NOT_AVAILABLE without usage', () => {
    expect(S.estimateCost({ model: 'gpt-5.6-terra', usage: null }).status).toBe('NOT_AVAILABLE');
  });
  it('returns NOT_CONFIGURED for an unknown model even with usage', () => {
    expect(S.estimateCost({ model: 'mystery-model', usage: { totalTokens: 100, promptTokens: 60, completionTokens: 40 } }).status).toBe('NOT_CONFIGURED');
  });
  it('computes a cost only when both usage and pricing exist', () => {
    const r = S.estimateCost({ model: 'gpt-5.6-terra', usage: { promptTokens: 1e6, completionTokens: 1e6, totalTokens: 2e6 } });
    expect(r.status).toBe('OK');
    expect(r.usd).toBeCloseTo(14, 3); // 2 in + 12 out
  });
});

describe('versioning', () => {
  it('exposes stable benchmark + scorer versions', () => {
    expect(S.ACQ_BENCHMARK_VERSION).toBe('ACQ-100-V1');
    expect(S.ACQ_SCORER_VERSION).toBe('acq-scoring-v2');
    expect(Object.values(S.WEIGHTS).reduce((a, b) => a + b, 0)).toBe(100);
  });
});
