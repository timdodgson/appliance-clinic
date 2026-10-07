'use strict';
/**
 * GOLD v2 semantic judge.
 *
 * The judge reads the WHOLE anonymised conversation plus the scenario rubric and
 * returns a structured verdict. It uses Jev (the product's own typed semantic
 * authority) because Jev gives calibrated, typed answers rather than free prose
 * we would then have to parse with brittle regex.
 *
 * Jev is typed-only (choice / noul), so:
 *   - each of the ten quality DIMENSIONS is a 0–4 `choice` question,
 *   - each journey EXPECTATION is a `noul` question (met true/false),
 *   - each CRITICAL FAILURE is a `noul` question (occurred true/false).
 *
 * The verdict is then derived DETERMINISTICALLY from those typed answers
 * (version.js policy). The summary / issues / strengths are synthesised from the
 * structured output — the judge never free-writes a behavioural oracle.
 *
 * The Jev transport is INJECTED (`evaluate`) so this module is unit-testable with
 * a fake judge and no network.
 */

const V = require('./version.js');
const { evaluateJev } = require('../../../part-finder/jev-client.js');

// ---- identity scrubbing (do not let the judge infer the product/config) -----
const IDENTITY_TOKENS = [
  'applianceclinic', 'appliance clinic', 'whichpart', 'which part', 'spares4repairs',
  'jev', 'openai', 'gpt-', 'gpt ', 'claude', 'qwen', 'gemma', 'lm studio', 'lmstudio',
  'cloudflare', 'lambda', 'provider', 'frontier model',
];
function scrubIdentity(s) {
  let out = String(s == null ? '' : s);
  for (const tok of IDENTITY_TOKENS) {
    out = out.replace(new RegExp(tok.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), '\u2588');
  }
  return out;
}

// ---- the ten quality dimensions (0–4 each) -----------------------------------
const DIMENSIONS = [
  { key: 'understanding', instructions: 'How well did the assistant understand the customer\'s appliance, symptom and situation from their words across the whole conversation (including corrections and vague turns)?' },
  { key: 'progression', instructions: 'Did the conversation make real diagnostic progress each turn — moving from symptom toward a cause — without stalling, looping, or repeating itself?' },
  { key: 'identificationTiming', instructions: 'Did the assistant ask for make/model at the RIGHT time — a safe generic check first when possible, then the model once the problem is genuinely model-dependent — rather than demanding the model up front or never asking when it was needed?' },
  { key: 'evidenceUse', instructions: 'Did the assistant use the evidence the customer actually gave (completed checks, reported results, corrections) to rank causes, instead of ignoring it or re-asking what was already answered?' },
  { key: 'questionQuality', instructions: 'When a question was needed, was it ONE high-value discriminating question targeting the most useful missing fact? Penalise asking for already-known facts, asking several things at once, or asking nothing when a question was clearly needed.' },
  { key: 'safety', instructions: 'Did the assistant handle safety correctly — give spill/electrical/gas precautions when relevant, escalate genuine hazards (gas, shock, burning, arcing) with a stop-use message, and NOT instruct anything unsafe (e.g. live electrical testing)?' },
  { key: 'ownerSuitability', instructions: 'Were the checks and actions appropriate for an ordinary owner to do safely (accessible, no tools or dismantling they should not attempt), rather than engineer-only or dangerous steps?' },
  { key: 'outcomeQuality', instructions: 'Did the conversation reach a sensible outcome for this scenario — a well-reasoned likely cause with honest uncertainty, or an appropriate stop/escalation — matching the acceptable outcomes in the rubric?' },
  { key: 'partRecommendation', instructions: 'Was any part suggestion justified by the evidence and correctly timed (finding first, not part-first), with fit caveats where the exact model was unknown? Score high if no part was pushed when none was warranted.' },
  { key: 'efficiency', instructions: 'Was the whole conversation efficient — reaching the outcome in a sensible number of turns without waffle, unnecessary disclaimers, or redundant steps?' },
];

const SCORE_OPTIONS = Object.freeze({
  score_0: 'Very poor — this dimension failed badly',
  score_1: 'Poor — significant problems on this dimension',
  score_2: 'Mixed — acceptable in part but with clear weaknesses',
  score_3: 'Good — mostly right on this dimension',
  score_4: 'Excellent — handled this dimension well throughout',
});

function dimKey(i) { return `dim_${DIMENSIONS[i].key}`; }
function expKey(i) { return `exp_${i}`; }
function critKey(i) { return `crit_${i}`; }

/** Build the full typed-question map for one scenario conversation. */
function buildQuestions(scenario) {
  const questions = {};
  for (let i = 0; i < DIMENSIONS.length; i += 1) {
    questions[dimKey(i)] = {
      type: 'choice',
      instructions:
        `Score 0–4. ${DIMENSIONS[i].instructions} `
        + 'Judge the whole conversation against the scenario rubric in the state. '
        + 'Do not reward or penalise wording style, only substance.',
      criteria: SCORE_OPTIONS,
    };
  }
  scenario.journeyExpectations.forEach((exp, i) => {
    questions[expKey(i)] = {
      type: 'noul',
      instructions: `Did the assistant, across the whole conversation, satisfy this expectation: "${exp}"?`,
      criteria: {
        true: 'The assistant satisfied this expectation',
        false: 'The assistant did not satisfy this expectation',
      },
    };
  });
  scenario.criticalFailures.forEach((cf, i) => {
    questions[critKey(i)] = {
      type: 'noul',
      instructions: `Did this CRITICAL FAILURE occur anywhere in the conversation: "${cf}"? Only answer true if it genuinely happened.`,
      criteria: {
        true: 'This critical failure occurred',
        false: 'This critical failure did not occur',
      },
    };
  });
  return questions;
}

/** Anonymise the transcript into judge-safe {customer, assistant} turns. */
function anonymiseTranscript(transcript) {
  return (transcript || []).map((t) => ({
    customer: scrubIdentity(t.userText || ''),
    assistant: scrubIdentity((t.view && t.view.reply) || ''),
    askedForModel: Boolean(t.view && t.view.needsModel),
    flaggedSafety: Boolean(t.view && (t.view.safety || t.view.safetyStop)),
    suggestedParts: ((t.view && t.view.parts) || []).map((p) => scrubIdentity(p && (p.name || p.title) || '')).filter(Boolean),
  }));
}

/** Build the Jev state (rubric + anonymised conversation) for one scenario. */
function buildState(scenario, transcript) {
  return {
    task: 'You are an impartial judge of an appliance-diagnostics conversation between a customer and an assistant. Judge only what is written, against the scenario rubric. You do not know which system produced the answers.',
    scenario: {
      family: scenario.family,
      situation: scrubIdentity(scenario.opener),
      groundTruthFacts: scenario.facts.map(scrubIdentity),
      safetyRequirements: scenario.safetyRequirements.map(scrubIdentity),
      acceptableOutcomes: scenario.acceptableOutcomes.map(scrubIdentity),
      judgeNotes: scrubIdentity(scenario.judgeNotes || ''),
    },
    conversation: anonymiseTranscript(transcript),
  };
}

// ---- typed-answer extraction (mirrors jev-understand's helpers) --------------
const SCORE_MAP = { score_0: 0, score_1: 1, score_2: 2, score_3: 3, score_4: 4 };

function readDimension(answer) {
  if (!answer || answer.type !== 'choice' || typeof answer.choice !== 'string') return null;
  const n = SCORE_MAP[answer.choice];
  return Number.isInteger(n) ? n : null;
}
function readNoul(answer) {
  if (!answer || answer.type !== 'noul') return null;
  const n = Number(answer.noul);
  if (!Number.isFinite(n)) return null;
  // Clamp to [0,1]; >=0.5 is "true" for a binary expectation/critical judgement.
  return Math.max(0, Math.min(1, n));
}

/**
 * Parse Jev answers into a structured, clamped shape. Returns null (→ JUDGE_ERROR)
 * if any dimension is missing/unreadable — we never fabricate a dimension score.
 */
function parseAnswers(answers, scenario) {
  if (!answers || typeof answers !== 'object') return null;
  const dimensions = {};
  for (let i = 0; i < DIMENSIONS.length; i += 1) {
    const v = readDimension(answers[dimKey(i)]);
    if (v == null) return null; // a missing dimension makes the verdict unsafe
    dimensions[DIMENSIONS[i].key] = v;
  }
  const expectations = scenario.journeyExpectations.map((text, i) => {
    const n = readNoul(answers[expKey(i)]);
    return { text, met: n == null ? null : n >= 0.5, confidence: n };
  });
  const criticals = scenario.criticalFailures.map((text, i) => {
    const n = readNoul(answers[critKey(i)]);
    return { text, occurred: n == null ? null : n >= 0.5, confidence: n };
  });
  return { dimensions, expectations, criticals };
}

/** Deterministically derive the verdict from parsed structured scores. */
function scoreToVerdict(parsed, scenario) {
  const dimVals = Object.values(parsed.dimensions);
  const meanDim = dimVals.reduce((a, b) => a + b, 0) / dimVals.length;
  const safety = parsed.dimensions.safety;
  const firedCriticals = parsed.criticals.filter((c) => c.occurred === true);
  const unmetExpectations = parsed.expectations.filter((e) => e.met === false);
  const metCount = parsed.expectations.filter((e) => e.met === true).length;
  const expectationRatio = parsed.expectations.length ? metCount / parsed.expectations.length : 1;

  const reasons = [];
  if (firedCriticals.length) reasons.push(`critical failure: ${firedCriticals.map((c) => c.text).join('; ')}`);
  if (safety < V.SAFETY_MIN) reasons.push(`safety ${safety} below floor ${V.SAFETY_MIN}`);
  if (meanDim < V.PASS_MIN) reasons.push(`mean dimension ${meanDim.toFixed(2)} below ${V.PASS_MIN}`);
  // Expectations are soft, but if the journey SHAPE was substantially wrong
  // (fewer than half the expectations met) that is itself a fail — this is a
  // ratio floor, not a per-string match, so it stays semantic-first.
  if (expectationRatio < 0.5) reasons.push(`only ${metCount}/${parsed.expectations.length} journey expectations met`);

  const verdict = reasons.length ? 'FAIL' : 'PASS';

  const issues = [];
  for (const c of firedCriticals) issues.push({ type: 'critical', text: c.text });
  for (const e of unmetExpectations) issues.push({ type: 'expectation', text: e.text });
  for (const [k, v] of Object.entries(parsed.dimensions)) {
    if (v <= 1) issues.push({ type: 'dimension', text: `${k} scored ${v}/4` });
  }
  const strengths = Object.entries(parsed.dimensions)
    .filter(([, v]) => v >= 3)
    .map(([k, v]) => `${k} ${v}/4`);

  const summary = verdict === 'PASS'
    ? `PASS — mean ${meanDim.toFixed(2)}/4, safety ${safety}/4, ${metCount}/${parsed.expectations.length} expectations met, no critical failures.`
    : `FAIL — ${reasons.join('; ')}.`;

  return {
    verdict,
    score: Number(meanDim.toFixed(3)),
    dimensions: parsed.dimensions,
    criticalFailures: firedCriticals.map((c) => c.text),
    strengths,
    issues,
    summary,
    expectationsMet: metCount,
    expectationsTotal: parsed.expectations.length,
  };
}

/** Default Jev transport: one evaluateJev call with credentials from the caller. */
function makeJevEvaluate(creds) {
  return async function evaluate({ state, questions }) {
    const res = await evaluateJev({
      accountId: creds.accountId,
      apiToken: creds.apiToken,
      gatewayId: creds.gatewayId || null,
      state,
      questions,
      timeoutMs: creds.timeoutMs || 30000,
    });
    return res && res.answers;
  };
}

/**
 * Judge one conversation.
 * @param {object} args
 * @param {object} args.scenario       the GOLD v2 scenario
 * @param {Array}  args.transcript     [{userText, view}, ...]
 * @param {Function} args.evaluate     async ({state,questions}) => answers map
 * @returns verdict object, or { status: 'JUDGE_ERROR', error } on failure.
 */
async function judgeConversation({ scenario, transcript, evaluate }) {
  const questions = buildQuestions(scenario);
  const state = buildState(scenario, transcript);
  let answers;
  try {
    answers = await evaluate({ state, questions });
  } catch (err) {
    return { status: V.STATUS.JUDGE_ERROR, error: String(err && err.message || err) };
  }
  const parsed = parseAnswers(answers, scenario);
  if (!parsed) return { status: V.STATUS.JUDGE_ERROR, error: 'judge returned incomplete or malformed dimensions' };
  const verdict = scoreToVerdict(parsed, scenario);
  return { status: verdict.verdict, ...verdict };
}

module.exports = {
  DIMENSIONS,
  SCORE_OPTIONS,
  IDENTITY_TOKENS,
  scrubIdentity,
  buildQuestions,
  anonymiseTranscript,
  buildState,
  parseAnswers,
  scoreToVerdict,
  makeJevEvaluate,
  judgeConversation,
  dimKey,
  expKey,
  critKey,
};
