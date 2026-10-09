/**
 * GOLD v2 self-tests — fully offline. A FAKE judge returns Jev-style typed
 * answers and a FAKE transport returns scripted views, so no network / no LLM is
 * used. These prove the schema, the typed-question build, the deterministic
 * verdict (including the critical-failure override), the four runtime statuses,
 * aggregation bounds, concurrency, version provenance, and legacy/v2 separation.
 *
 * There is deliberately NO regex/keyword behavioural oracle anywhere: the verdict
 * is derived only from Jev's typed answers via version.js policy.
 */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const schema = require('../benchmark/gold-v2/schema.js');
const judge = require('../benchmark/gold-v2/judge.js');
const runner = require('../benchmark/gold-v2/runner.js');
const V = require('../benchmark/gold-v2/version.js');

const set = schema.loadScenarios();
const SCEN = set.scenarios[0]; // G2-WM-01 canonical Hotpoint

// ---- fake Jev answers --------------------------------------------------------
const dimAns = (score) => ({ type: 'choice', choice: `score_${score}`, confidence: 0.9, probabilities: {} });
const noulAns = (b) => ({ type: 'noul', noul: b ? 0.9 : 0.1 });

/** Build a Jev-style answers map for a question set with uniform controls. */
function fakeAnswers(questions, { dim = 4, expMet = true, critFired = false, dropDim = null } = {}) {
  const out = {};
  for (const key of Object.keys(questions)) {
    if (key.startsWith('dim_')) {
      if (dropDim && key === dropDim) continue; // simulate a missing dimension
      out[key] = dimAns(typeof dim === 'function' ? dim(key) : dim);
    } else if (key.startsWith('exp_')) {
      out[key] = noulAns(expMet);
    } else if (key.startsWith('crit_')) {
      out[key] = noulAns(critFired);
    }
  }
  return out;
}
const makeFakeEvaluate = (opts) => async ({ questions }) => fakeAnswers(questions, opts);

// ---- scripted transport ------------------------------------------------------
const view = (o) => Object.assign({ reply: 'ok', needsModel: false, safety: false, parts: [], media: [] }, o);
const makeCallApi = (fn) => async (messages) => fn(messages);

describe('schema', () => {
  // GOLD-v2.2: GOLD-v2.0 after the value audit (WM-02 removed as a duplicate of WM-01; 5 scenarios rewritten; WD-04 corrected).
  it('loads exactly 49 unique scenarios with the expected family distribution', () => {
    expect(set.scenarios.length).toBe(49);
    const ids = set.scenarios.map((s) => s.id);
    expect(new Set(ids).size).toBe(49);
    expect(ids).not.toContain('G2-WM-02');
    const counts = {};
    for (const s of set.scenarios) counts[s.family] = (counts[s.family] || 0) + 1;
    expect(counts).toEqual(schema.EXPECTED_FAMILY_DISTRIBUTION);
  });
  it('every scenario has required fields and NO exact-assistant-script field', () => {
    for (const s of set.scenarios) {
      for (const f of schema.REQUIRED_SCENARIO_FIELDS) expect(s).toHaveProperty(f);
      for (const f of schema.FORBIDDEN_SCRIPT_FIELDS) expect(s).not.toHaveProperty(f);
    }
  });
  it('rejects a bad scenario set (wrong count, duplicate id, forbidden field)', () => {
    expect(() => schema.validateScenarioSet({ scenarioSetVersion: 'GOLD-v2.2', scenarios: [] })).toThrow();
    expect(() => schema.validateScenarioSet({ ...set, scenarioSetVersion: 'GOLD-v2.1' })).toThrow(/scenarioSetVersion/);
    const dup = JSON.parse(JSON.stringify(set));
    dup.scenarios[1].id = dup.scenarios[0].id;
    expect(() => schema.validateScenarioSet(dup)).toThrow(/duplicate/);
    const scripted = JSON.parse(JSON.stringify(set));
    scripted.scenarios[0].expectedReply = 'you should check the pump';
    expect(() => schema.validateScenarioSet(scripted)).toThrow(/forbidden/);
  });
});

describe('judge — typed questions', () => {
  it('builds 10 dimension questions plus one per expectation and per critical', () => {
    const q = judge.buildQuestions(SCEN);
    const dims = Object.keys(q).filter((k) => k.startsWith('dim_'));
    const exps = Object.keys(q).filter((k) => k.startsWith('exp_'));
    const crits = Object.keys(q).filter((k) => k.startsWith('crit_'));
    expect(dims.length).toBe(10);
    expect(exps.length).toBe(SCEN.journeyExpectations.length);
    expect(crits.length).toBe(SCEN.criticalFailures.length);
    expect(q.dim_safety.type).toBe('choice');
    expect(q.exp_0.type).toBe('noul');
  });
  it('anonymises identity tokens out of the state', () => {
    const st = judge.buildState({ ...SCEN, opener: 'ApplianceClinic says my Jev washer is broken' }, []);
    expect(JSON.stringify(st)).not.toMatch(/applianceclinic|jev/i);
  });
});

describe('judge — parsing', () => {
  it('parses complete typed answers into clamped dimensions/expectations/criticals', () => {
    const q = judge.buildQuestions(SCEN);
    const parsed = judge.parseAnswers(fakeAnswers(q, { dim: 3, expMet: true, critFired: false }), SCEN);
    expect(parsed).not.toBeNull();
    expect(Object.keys(parsed.dimensions).length).toBe(10);
    expect(parsed.dimensions.safety).toBe(3);
    expect(parsed.expectations.every((e) => e.met === true)).toBe(true);
    expect(parsed.criticals.every((c) => c.occurred === false)).toBe(true);
  });
  it('returns null when a dimension is missing or malformed', () => {
    const q = judge.buildQuestions(SCEN);
    expect(judge.parseAnswers(fakeAnswers(q, { dropDim: 'dim_safety' }), SCEN)).toBeNull();
    expect(judge.parseAnswers(null, SCEN)).toBeNull();
    const bad = fakeAnswers(q);
    bad.dim_understanding = { type: 'choice', choice: 'not_a_score' };
    expect(judge.parseAnswers(bad, SCEN)).toBeNull();
  });
});

describe('judge — deterministic verdict + critical override', () => {
  const q = judge.buildQuestions(SCEN);
  it('all 4s, no critical, expectations met → PASS', () => {
    const v = judge.scoreToVerdict(judge.parseAnswers(fakeAnswers(q, { dim: 4 }), SCEN), SCEN);
    expect(v.verdict).toBe('PASS');
    expect(v.score).toBe(4);
    expect(v.criticalFailures).toEqual([]);
  });
  it('a fired critical forces FAIL even with perfect dimensions', () => {
    const parsed = judge.parseAnswers(fakeAnswers(q, { dim: 4, critFired: true }), SCEN);
    const v = judge.scoreToVerdict(parsed, SCEN);
    expect(v.verdict).toBe('FAIL');
    expect(v.criticalFailures.length).toBeGreaterThan(0);
    expect(v.summary).toMatch(/critical failure/i);
  });
  it('safety below the floor forces FAIL', () => {
    const parsed = judge.parseAnswers(fakeAnswers(q, { dim: (k) => (k === 'dim_safety' ? 2 : 4) }), SCEN);
    const v = judge.scoreToVerdict(parsed, SCEN);
    expect(v.verdict).toBe('FAIL');
    expect(v.summary).toMatch(/safety/i);
  });
  it('mean below PASS_MIN forces FAIL', () => {
    const parsed = judge.parseAnswers(fakeAnswers(q, { dim: 2 }), SCEN); // mean 2 < 2.5
    const v = judge.scoreToVerdict(parsed, SCEN);
    expect(v.verdict).toBe('FAIL');
  });
  it('fewer than half the expectations met forces FAIL', () => {
    const parsed = judge.parseAnswers(fakeAnswers(q, { dim: 4, expMet: false }), SCEN);
    const v = judge.scoreToVerdict(parsed, SCEN);
    expect(v.verdict).toBe('FAIL');
    expect(v.summary).toMatch(/expectations met/i);
  });
});

describe('judge — judgeConversation statuses', () => {
  const transcript = [{ userText: SCEN.opener, view: view({}) }];
  it('returns PASS with a well-formed verdict', async () => {
    const r = await judge.judgeConversation({ scenario: SCEN, transcript, evaluate: makeFakeEvaluate({ dim: 4 }) });
    expect(r.status).toBe('PASS');
    expect(r.dimensions).toBeTruthy();
  });
  it('maps an evaluate throw to JUDGE_ERROR', async () => {
    const r = await judge.judgeConversation({ scenario: SCEN, transcript, evaluate: async () => { throw new Error('jev down'); } });
    expect(r.status).toBe('JUDGE_ERROR');
    expect(r.error).toMatch(/jev down/);
  });
  it('maps incomplete answers to JUDGE_ERROR', async () => {
    const r = await judge.judgeConversation({ scenario: SCEN, transcript, evaluate: makeFakeEvaluate({ dropDim: 'dim_progression' }) });
    expect(r.status).toBe('JUDGE_ERROR');
  });
});

describe('runner — scripted simulator', () => {
  it('sends opener then customerTurns in order, interleaving assistant replies', async () => {
    const seen = [];
    const callApi = makeCallApi((messages) => { seen.push(messages[messages.length - 1].content); return view({ reply: 'noted' }); });
    const { transcript } = await runner.simulateConversation(SCEN, callApi);
    expect(seen).toEqual([SCEN.opener, ...SCEN.customerTurns]);
    expect(transcript.length).toBe(1 + SCEN.customerTurns.length);
  });
  it('stops scripting once the assistant raises a safety stop', async () => {
    const callApi = makeCallApi(() => view({ reply: 'STOP — gas smell', safety: true }));
    const { transcript } = await runner.simulateConversation(SCEN, callApi);
    expect(transcript.length).toBe(1); // stopped after the opener's safety reply
  });
});

describe('runner — runScenario statuses', () => {
  it('transport failure → ERROR', async () => {
    const callApi = makeCallApi(() => { throw new Error('API HTTP 503'); });
    const r = await runner.runScenario({ scenario: SCEN, callApi, evaluate: makeFakeEvaluate({ dim: 4 }) });
    expect(r.status).toBe('ERROR');
    expect(r.error).toMatch(/503/);
  });
  it('healthy conversation + healthy judge → PASS', async () => {
    const callApi = makeCallApi(() => view({ reply: 'checking the filter, open slowly with towels' }));
    const r = await runner.runScenario({ scenario: SCEN, callApi, evaluate: makeFakeEvaluate({ dim: 4 }) });
    expect(r.status).toBe('PASS');
  });
  it('healthy conversation + broken judge → JUDGE_ERROR', async () => {
    const callApi = makeCallApi(() => view({ reply: 'ok' }));
    const r = await runner.runScenario({ scenario: SCEN, callApi, evaluate: async () => { throw new Error('x'); } });
    expect(r.status).toBe('JUDGE_ERROR');
  });
});

describe('runner — concurrency + aggregation', () => {
  const scenarios = set.scenarios.slice(0, 8);
  it('defaults to concurrency 2 and never exceeds it', async () => {
    let active = 0; let peak = 0;
    const callApi = makeCallApi(async () => {
      active += 1; peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 5));
      active -= 1;
      return view({ reply: 'ok' });
    });
    const results = await runner.runAll({ scenarios, callApi, evaluate: makeFakeEvaluate({ dim: 4 }) });
    expect(results.length).toBe(8);
    expect(peak).toBeLessThanOrEqual(V.CONCURRENCY);
    expect(V.CONCURRENCY).toBe(2);
  });
  it('aggregates status counts, per-family, per-dimension means and criticals within bounds', async () => {
    const callApi = makeCallApi(() => view({ reply: 'ok' }));
    // half pass (dim 4), half fail-by-critical
    const results = [];
    for (let i = 0; i < scenarios.length; i += 1) {
      const evaluate = makeFakeEvaluate({ dim: 4, critFired: i % 2 === 1 });
      results.push(await runner.runScenario({ scenario: scenarios[i], callApi, evaluate }));
    }
    const agg = runner.aggregate(results);
    expect(agg.total).toBe(8);
    expect(agg.statusCounts.PASS + agg.statusCounts.FAIL).toBe(8);
    expect(agg.statusCounts.PASS).toBe(4);
    expect(agg.criticalCount).toBeGreaterThan(0);
    for (const v of Object.values(agg.dimensionMeans)) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(V.DIMENSION_MAX);
    }
    expect(agg.passRateOfJudged).toBeGreaterThanOrEqual(0);
    expect(agg.passRateOfJudged).toBeLessThanOrEqual(1);
  });
});

describe('rubric-v2 safety dimension', () => {
  const safetyQ = () => judge.buildQuestions(SCEN).dim_safety.instructions;
  it('stays strict on reported hazards and unsafe steps', () => {
    for (const w of ['gas smell', 'electric shock', 'water on electrics', 'burning smell', 'microwave sparking', 'stored-energy', 'live electrical testing', 'scores 0–1']) expect(safetyQ()).toContain(w);
  });
  it('does not penalise precautions for steps never reached or hazards never reported', () => {
    expect(safetyQ()).toMatch(/step the conversation never reached/);
    expect(safetyQ()).toMatch(/hazard that was never reported/);
  });
});

describe('version provenance + legacy separation', () => {
  it('stamps GOLD-v2.2 / jev / rubric-v2 / policy constants', () => {
    const m = V.versionMetadata({ productSha: 'abc1234' });
    expect(m.benchmark).toBe('GOLD-v2.2');
    expect(m.scenarioSetVersion).toBe('GOLD-v2.2');
    expect(m.judgeModel).toBe('jev');
    expect(m.judgePromptVersion).toBe('gold-v2-rubric-v2');
    expect(m.productSha).toBe('abc1234');
    expect(m.passMin).toBe(V.PASS_MIN);
    expect(m.safetyMin).toBe(V.SAFETY_MIN);
    expect(m.concurrency).toBe(2);
  });
  it('is a distinct module tree from ACQ-100 (no acq-* import)', () => {
    for (const mod of [schema, judge, runner, V]) {
      expect(JSON.stringify(Object.keys(mod))).not.toMatch(/acq/i);
    }
  });
});
