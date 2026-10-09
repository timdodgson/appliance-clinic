/**
 * DIAGNOSIS vs PART-FIT semantic-contract tests.
 *
 * A useful DIAGNOSIS can be delivered without a model number; a model number is only needed to
 * confirm the EXACT replacement PART. The response surface can carry a full diagnosis AND a model
 * request at once. The scorer previously conflated the two: `needsModel` counted as "asked a
 * question", so on an immediate-diagnosis gold a PART-FIT model request tanked QUESTION_QUALITY
 * (100->20) and was scored as an unnecessary clarification. These tests lock the corrected contract:
 * a part-fit model request (diagnosis already delivered) is NOT a diagnostic clarification, while a
 * real diagnostic question, or a model request WITHOUT a delivered diagnosis, still is.
 *
 * Also source-guards the part-finder COMPOSE change (diagnosis-first, model-for-exact-part framing).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const S = require('../benchmark/acq-scoring.js');
const HERE = dirname(fileURLToPath(import.meta.url));

const view = (o) => Object.assign(
  { reply: '', suggestedChecks: [], components: [], parts: [], safety: false, needsModel: false, diagnosis: { faultId: null, label: null, summary: '' } },
  o,
);
// A part-fit model request: full diagnosis delivered + model invited for the exact PART (no diagnostic "?").
const partFitView = view({
  reply: 'The 22E code indicates the fridge evaporator-fan system — often ice build-up around the fan, though the fan motor or defrost can be involved. If you want me to identify the exact replacement part, tell me the model number.',
  needsModel: true,
  diagnosis: { faultId: null, label: 'Internal (evaporator) fan fault', summary: 'evaporator fan system' },
  components: [{ name: 'fan motor', rank: 'PLAUSIBLE' }, { name: 'defrost heater', rank: 'PLAUSIBLE' }],
  suggestedChecks: ['evaporator fan motor', 'defrost heater'],
});
// A model request with NO diagnosis delivered (failure to diagnose immediately).
const bareModelView = view({ reply: 'What is the model number? It is on the rating plate.', needsModel: true });
// A genuine diagnostic clarification (asks about behaviour, not the model).
const diagnosticQView = view({ reply: 'Does it still get cold, or is the freezer warm too?' });
// A clean immediate diagnosis with no question at all.
const cleanDiagView = view({
  reply: 'The 22E code points to the evaporator-fan system; check the fan for ice and that it spins.',
  diagnosis: { faultId: null, label: 'Internal (evaporator) fan fault', summary: 'fan system' },
  components: [{ name: 'fan motor', rank: 'PLAUSIBLE' }],
});

const immediateGold = { expectedOutcome: 'DIAGNOSIS', immediateDiagnosis: true, followUpAppropriate: false, mustInclude: ['fan'], goldSuspects: ['evaporator fan', 'fan motor'] };
const followUpGold = { expectedOutcome: 'DIAGNOSIS', immediateDiagnosis: false, followUpAppropriate: true, followUpTargetFact: 'what does the display show' };

describe('diagnosis-vs-part-fit helpers', () => {
  it('diagnosisDelivered: true when a fault label / components / checks are present', () => {
    expect(S.diagnosisDelivered(partFitView)).toBe(true);
    expect(S.diagnosisDelivered(cleanDiagView)).toBe(true);
    expect(S.diagnosisDelivered(bareModelView)).toBe(false);
    expect(S.diagnosisDelivered(diagnosticQView)).toBe(false);
  });
  it('modelOnlyRequest: a part-fit model request with a delivered diagnosis (no diagnostic question)', () => {
    expect(S.modelOnlyRequest(partFitView)).toBe(true);
    // model requested but NO diagnosis delivered -> not a part-fit request (it IS a failure to diagnose)
    expect(S.modelOnlyRequest(bareModelView)).toBe(false);
    // a diagnostic question is not a model-only request
    expect(S.modelOnlyRequest(diagnosticQView)).toBe(false);
    // no question at all -> not a "request"
    expect(S.modelOnlyRequest(cleanDiagView)).toBe(false);
  });
  it('askedDiagnosticQuestion: excludes a pure part-fit model request, includes real diagnostic questions', () => {
    expect(S.askedDiagnosticQuestion(partFitView)).toBe(false);
    expect(S.askedDiagnosticQuestion(diagnosticQView)).toBe(true);
    expect(S.askedDiagnosticQuestion(bareModelView)).toBe(true); // model asked with no diagnosis = diagnostic failure
    expect(S.askedDiagnosticQuestion(cleanDiagView)).toBe(false);
  });
});

describe('QUESTION_QUALITY (immediate/no-followup gold)', () => {
  const q = (v) => S.scoreQuestionDeterministic([{ view: v }], immediateGold, {}).score;
  it('A part-fit model request is NOT penalised (100)', () => { expect(q(partFitView)).toBe(100); });
  it('clean immediate diagnosis (no question) scores 100', () => { expect(q(cleanDiagView)).toBe(100); });
  it('a real diagnostic question scores 20', () => { expect(q(diagnosticQView)).toBe(20); });
  it('a bare model request with no diagnosis scores 20 (failure to diagnose)', () => { expect(q(bareModelView)).toBe(20); });
});

describe('CONVERSATION_EFFICIENCY unnecessary-clarifications (immediate gold)', () => {
  const clar = (v, outcomeIdx) => S.gradeEfficiency([{ view: v, latencyMs: 1 }], immediateGold, outcomeIdx).unnecessaryClarifications;
  it('part-fit model request is NOT an unnecessary clarification', () => { expect(clar(partFitView, 0)).toBe(0); });
  it('a real diagnostic question IS an unnecessary clarification on an immediate gold', () => { expect(clar(diagnosticQView, -1)).toBe(1); });
  it('a bare model request (no diagnosis) IS unnecessary on an immediate gold', () => { expect(clar(bareModelView, -1)).toBe(1); });
});

describe('follow-up golds are unchanged (FF-005 protection)', () => {
  it('the part-fit exemption does NOT apply when a diagnostic follow-up is appropriate', () => {
    // On a followUp gold, a model request is still treated as a question (a suboptimal follow-up),
    // not silently exempted — so FF-005-style question scoring is preserved.
    const det = S.scoreQuestionDeterministic([{ view: partFitView }], followUpGold, {});
    // followUp branch: asked a question -> onTarget check (model != "what does the display show") -> 60
    expect(det.score).toBe(60);
  });
});

describe('calibration / grounding untouched (exact fit not claimed without model)', () => {
  it('claiming MODEL_CONFIRMED fit when the model was never supplied is still penalised', () => {
    const g = { modelKnown: false };
    const withConfirmed = view({ parts: [{ name: 'fan motor', fitStatus: 'MODEL_CONFIRMED' }] });
    const withVerify = view({ parts: [{ name: 'fan motor', fitStatus: 'VERIFY_FIT' }] });
    expect(S.scoreGrounding(withConfirmed, g).score).toBeLessThan(S.scoreGrounding(withVerify, g).score);
  });
});

describe('safety precedence (unchanged)', () => {
  it('a safety reply triggers regardless of model availability', () => {
    expect(S.safetyTriggered(view({ reply: 'Stop using it and unplug it; get a qualified engineer to check it.', needsModel: false }))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// MUTATION-STYLE / SOURCE GUARDS
// ---------------------------------------------------------------------------
describe('source guards', () => {
  const scoringSrc = readFileSync(join(HERE, '..', 'benchmark', 'acq-scoring.js'), 'utf8');
  const composeSrc = require('../../part-finder/test/engine-source.cjs')();

  it('scoring: modelOnlyRequest requires a delivered diagnosis (cannot exempt a bare model ask)', () => {
    expect(/function modelOnlyRequest\(view\)\s*\{[\s\S]*?diagnosisDelivered\(view\)/.test(scoringSrc)).toBe(true);
  });
  it('scoring: QUESTION_QUALITY immediate branch uses askedDiagnosticQuestion (not raw askedQuestion)', () => {
    expect(/askedDiag = askedDiagnosticQuestion\(firstView\)/.test(scoringSrc)).toBe(true);
  });
  it('scoring: efficiency exempts a part-fit model request only on immediate/no-followup golds', () => {
    expect(/\(gold\.immediateDiagnosis \|\| !followUpAppropriate\) && modelOnlyRequest\(transcript\[i\]\.view\)\) continue;/.test(scoringSrc)).toBe(true);
  });
  it('COMPOSE: separates diagnosis from exact part fit (model NOT needed to diagnose)', () => {
    expect(/is NOT needed to give a useful DIAGNOSIS/.test(composeSrc)).toBe(true);
    expect(/identify the exact replacement part/i.test(composeSrc)).toBe(true);
  });
  it('COMPOSE: sparse-catalogue steer no longer gates the diagnosis behind the model', () => {
    // The old wording "ASK for the model number ... BEFORE offering parts" (which withheld the
    // diagnosis) must be gone; the diagnosis-first framing must be present.
    expect(/ASK for the model number \(using the locations above\) BEFORE offering parts/.test(composeSrc)).toBe(false);
    expect(/Still give the DIAGNOSIS first/.test(composeSrc)).toBe(true);
  });
});
