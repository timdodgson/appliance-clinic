/**
 * Typed customer-evidence contract (STRUCTURAL/schema/adapter/merge tests only).
 *
 * These prove the schema, adapter, provenance, UNKNOWN semantics, exclusive
 * negative evidence, and — for Story 2 — the CONSUMPTION boundary: the adapter's
 * typed facts merge into the engine's fact channel via mergeDerivedFacts (Jev is
 * now authoritative for diagnostic observations). Natural-language correctness is
 * proven separately by the Jev/LLM semantic assessment + GOLD, not here.
 */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
// part-finder-lambda.js references the Lambda streaming global at load time.
globalThis.awslambda = globalThis.awslambda || {
  streamifyResponse: (fn) => fn,
  HttpResponseStream: { from: (s) => s },
};
const {
  CUSTOMER_EVIDENCE_SPEC,
  CUSTOMER_EVIDENCE_KEYS,
  buildCustomerEvidenceQuestions,
  adaptCustomerEvidence,
  buildQuestions,
  adaptJevToIntent,
} = require('../jev-understand.js');
const { mergeDerivedFacts } = require('../part-finder-lambda.js')._internal;

// Minimal core answer set (mirrors the real Jev core decisions) so adaptJevToIntent runs.
function coreAnswers(partial) {
  const base = {
    onTopic: { type: 'noul', noul: 0.99 },
    userIntent: { type: 'choice', choice: 'EVIDENCE_UPDATE', confidence: 1, probabilities: {} },
    applianceFamily: { type: 'choice', choice: 'unknown', confidence: 1, probabilities: {} },
    identitySufficiency: { type: 'choice', choice: 'need_make_and_model', confidence: 0.8, probabilities: {} },
    candidateTokenMeaning: { type: 'choice', choice: 'none', confidence: 1, probabilities: {} },
    answeredPrevious: { type: 'choice', choice: 'not_applicable', confidence: 1, probabilities: {} },
    partReadiness: { type: 'choice', choice: 'diagnosis_only', confidence: 1, probabilities: {} },
    cannotAnswer: { type: 'noul', noul: 0.01 },
    safetySignificance: { type: 'choice', choice: 'none', confidence: 1, probabilities: {} },
    symptomFamily: { type: 'choice', choice: 'not_heating', confidence: 0.9, probabilities: {} },
    needMoreInfo: { type: 'noul', noul: 0.9 },
    moreDiscriminationRequired: { type: 'noul', noul: 0.2 },
    normalBehaviour: { type: 'noul', noul: 0.02 },
    modelUnavailable: { type: 'noul', noul: 0.02 },
    latestTurnEstablishes: { type: 'choice', choice: 'check_result', confidence: 0.9, probabilities: {} },
  };
  return { ...base, ...partial };
}
const NOUL_TRUE = { type: 'noul', noul: 0.95 };
const NOUL_FALSE = { type: 'noul', noul: 0.02 };
const NOUL_UNCERTAIN = { type: 'noul', noul: 0.5 };
const choice = (c, conf = 0.9) => ({ type: 'choice', choice: c, confidence: conf, probabilities: {} });
function factMap(ev) {
  const m = new Map();
  for (const f of ev.facts) m.set(f.name, f.value);
  return m;
}

describe('evidence question set', () => {
  it('builds one typed question per spec dimension with the right type', () => {
    const q = buildCustomerEvidenceQuestions();
    expect(Object.keys(q).length).toBe(CUSTOMER_EVIDENCE_SPEC.length);
    for (const dim of CUSTOMER_EVIDENCE_SPEC) {
      expect(q[dim.key]).toBeTruthy();
      expect(q[dim.key].type).toBe(dim.type);
      expect(typeof q[dim.key].instructions).toBe('string');
      expect(q[dim.key].criteria && typeof q[dim.key].criteria).toBe('object');
    }
  });
  it('merges evidence questions into the full UNDERSTAND question map', () => {
    const q = buildQuestions({});
    for (const k of CUSTOMER_EVIDENCE_KEYS) expect(q[k]).toBeTruthy();
    // Core decisions are still present.
    expect(q.userIntent).toBeTruthy();
    expect(q.symptomFamily).toBeTruthy();
  });
});

describe('adapter: value semantics + provenance', () => {
  it('maps a choice to TRUE and sets exclusive siblings FALSE (explicit negative evidence)', () => {
    const ev = adaptCustomerEvidence({ evHeatState: choice('heat_present') });
    const m = factMap(ev);
    expect(m.get('heatPresent')).toBe('TRUE');
    expect(m.get('noHeat')).toBe('FALSE');
    for (const f of ev.facts) {
      expect(f.provenance).toBe('customer_stated');
      expect(f.source).toBe('jev');
    }
  });
  it('no_heat asserts noHeat TRUE and heatPresent FALSE', () => {
    const m = factMap(adaptCustomerEvidence({ evHeatState: choice('no_heat') }));
    expect(m.get('noHeat')).toBe('TRUE');
    expect(m.get('heatPresent')).toBe('FALSE');
  });
  it('overheats_then_cuts records heat present too', () => {
    const m = factMap(adaptCustomerEvidence({ evHeatState: choice('overheats_then_cuts') }));
    expect(m.get('overheatsThenCuts')).toBe('TRUE');
    expect(m.get('heatPresent')).toBe('TRUE');
    expect(m.get('noHeat')).toBe('FALSE');
  });
  it('waterEntering supports both TRUE and explicit FALSE', () => {
    expect(factMap(adaptCustomerEvidence({ evWaterFill: choice('entering') })).get('waterEntering')).toBe('TRUE');
    expect(factMap(adaptCustomerEvidence({ evWaterFill: choice('not_entering') })).get('waterEntering')).toBe('FALSE');
  });
  it('noul TRUE asserts the fact; FALSE/absent asserts nothing (UNKNOWN)', () => {
    expect(factMap(adaptCustomerEvidence({ evStandingWater: NOUL_TRUE })).get('waterRemaining')).toBe('TRUE');
    expect(adaptCustomerEvidence({ evStandingWater: NOUL_FALSE }).facts.find((f) => f.name === 'waterRemaining')).toBeUndefined();
    expect(adaptCustomerEvidence({}).facts.length).toBe(0);
  });
  it('uncertain choice/noul contributes nothing (never a guess)', () => {
    expect(adaptCustomerEvidence({ evHeatState: choice('unknown') }).facts.length).toBe(0);
    expect(adaptCustomerEvidence({ evDrumTurns: { type: 'choice', choice: 'turns', confidence: 0.1, probabilities: {} } }).facts.length).toBe(0);
    expect(adaptCustomerEvidence({ evTripsElectrics: NOUL_UNCERTAIN }).facts.length).toBe(0);
  });
  it('maps check-reported evidence and replacement/recovery flags', () => {
    const m = factMap(adaptCustomerEvidence({
      evFilterChecked: NOUL_TRUE, evAirflowChecked: NOUL_TRUE,
      evImpellerClear: NOUL_TRUE, evReplacedPartRemains: NOUL_TRUE, evFunctionRecovered: NOUL_TRUE,
    }));
    expect(m.get('filterChecked')).toBe('TRUE');
    expect(m.get('airflowChecked')).toBe('TRUE');
    expect(m.get('impellerClear')).toBe('TRUE');
    expect(m.get('replacedPartRemains')).toBe('TRUE');
    expect(m.get('functionRecovered')).toBe('TRUE');
  });
  it('intervention outcome is captured off the facts channel', () => {
    expect(adaptCustomerEvidence({ evIntervention: choice('temporary') }).intervention).toEqual({ outcome: 'temporary', confidence: 0.9 });
    expect(adaptCustomerEvidence({ evIntervention: choice('none') }).intervention).toBeNull();
    // and it does not leak into facts
    expect(adaptCustomerEvidence({ evIntervention: choice('temporary') }).facts.length).toBe(0);
  });
  it('carries a confidence for each asserted fact', () => {
    const ev = adaptCustomerEvidence({ evDrumTurns: choice('turns', 0.77) });
    expect(ev.facts[0].confidence).toBe(0.77);
  });
});

describe('adapter boundary (adaptJevToIntent keeps intent.facts empty; handler consumes)', () => {
  it('adaptJevToIntent attaches _jevEvidence; intent.facts is populated later by the handler', () => {
    const answers = coreAnswers({
      evHeatState: choice('no_heat'), evAirflowChecked: NOUL_TRUE, evFilterChecked: NOUL_TRUE,
    });
    const intent = adaptJevToIntent({ model: 'jev', answers }, { questions: buildQuestions({}), candidates: {}, latestUserText: 'still cold' });
    expect(intent._jevEvidence).toBeTruthy();
    expect(intent._jevEvidence.source).toBe('jev');
    expect(factMap(intent._jevEvidence).get('noHeat')).toBe('TRUE');
    // adaptJevToIntent itself does not populate intent.facts — the engine's fact-assembly
    // boundary in part-finder-lambda.js merges _jevEvidence.facts in (tested below).
    expect(Array.isArray(intent.facts)).toBe(true);
    expect(intent.facts.length).toBe(0);
    expect(intent.alreadyReplaced).toEqual([]);
    expect(intent.provenGood).toEqual([]);
    expect(intent.checksReported).toEqual([]);
  });
  it('missing evidence answers do NOT fail core UNDERSTAND (failure-tolerant)', () => {
    const intent = adaptJevToIntent({ model: 'jev', answers: coreAnswers({}) }, { questions: buildQuestions({}), candidates: {}, latestUserText: 'x' });
    expect(intent.onTopic).toBe(true);
    expect(intent._jevEvidence.facts.length).toBe(0);
  });
  it('every evidence key is excluded from the required core decisions', () => {
    for (const dim of CUSTOMER_EVIDENCE_SPEC) expect(CUSTOMER_EVIDENCE_KEYS.has(dim.key)).toBe(true);
  });
});

describe('consumption boundary (Story 2: Jev evidence → intent.facts via mergeDerivedFacts)', () => {
  // This mirrors what the handler does: intent.facts = mergeDerivedFacts(intent.facts,
  // intent._jevEvidence.facts filtered to TRUE/FALSE). Jev is authoritative for observations.
  const consume = (answers, existing = []) => {
    const derived = adaptCustomerEvidence(answers).facts
      .filter((f) => f.value === 'TRUE' || f.value === 'FALSE')
      .map((f) => ({ name: f.name, value: f.value }));
    return mergeDerivedFacts(existing, derived);
  };
  it('TRUE and explicit FALSE siblings flow into the fact channel', () => {
    const facts = consume({ evHeatState: choice('no_heat') });
    const m = new Map(facts.map((f) => [f.name, f.value]));
    expect(m.get('noHeat')).toBe('TRUE');
    expect(m.get('heatPresent')).toBe('FALSE');
  });
  it('UNKNOWN/absent evidence contributes no fact (never guessed)', () => {
    expect(consume({ evHeatState: choice('unknown') })).toEqual([]);
    expect(consume({ evStandingWater: NOUL_UNCERTAIN })).toEqual([]);
  });
  it('an explicit pre-existing fact is not overridden by the merge (customer/LLM wins over UNKNOWN only)', () => {
    // Existing explicit fact stays; Jev only fills absent/UNKNOWN names.
    const existing = [{ name: 'noHeat', value: 'FALSE' }];
    const facts = consume({ evHeatState: choice('no_heat') }, existing);
    const m = new Map(facts.map((f) => [f.name, f.value]));
    expect(m.get('noHeat')).toBe('FALSE'); // preserved
    expect(m.get('heatPresent')).toBe('FALSE'); // sibling still added
  });
  it('cannot-answer manufactures no observation facts', () => {
    const intent = adaptJevToIntent(
      { model: 'jev', answers: coreAnswers({ cannotAnswer: NOUL_TRUE }) },
      { questions: buildQuestions({}), candidates: {}, latestUserText: 'i dont know' },
    );
    const derived = intent._jevEvidence.facts.filter((f) => f.value === 'TRUE' || f.value === 'FALSE');
    expect(derived.length).toBe(0);
  });
});
