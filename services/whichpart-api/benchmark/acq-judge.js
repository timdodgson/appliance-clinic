'use strict';
/**
 * ACQ-100 independent quality judge (subjective dimensions only).
 *
 * FAIRNESS CONTRACT:
 *   - The judge is a FIXED provider/model, configured separately from the
 *     candidate UNDERSTAND/COMPOSE pair, and identical across all four runs.
 *   - The judge NEVER sees candidate identity. buildJudgePrompt() emits only an
 *     anonymised transcript + structured gold + the rubric. anonymiseTranscript()
 *     strips any "local/frontier/openai/lmstudio/gpt/qwen/provider/model/config
 *     A-D" tokens so the judge cannot infer who produced the answer.
 *   - It scores ONLY the three subjective dimensions (0-100 each):
 *       REASONING_DISCRIMINATION, QUESTION_QUALITY, CUSTOMER_ANSWER_QUALITY.
 *     Correctness/efficiency/grounding/safety stay deterministic.
 *   - If no judge is configured, the caller uses deterministic proxies and marks
 *     those dimensions NOT JUDGED — this module never fabricates a score.
 *
 * The actual OpenAI call is injected (callJudge) so this is unit-testable with
 * no network; the worker supplies a real OpenAI-backed callJudge.
 */

const JUDGE_RUBRIC_VERSION = 'acq-judge-rubric-v1';

// Tokens that could leak candidate identity to the judge. Case-insensitive.
const IDENTITY_TOKENS = [
  'local', 'frontier', 'openai', 'open ai', 'lm studio', 'lmstudio', 'gpt-', 'gpt ', 'qwen', 'gemma', 'ornith',
  'provider', 'configuration a', 'configuration b', 'configuration c', 'configuration d', 'config a', 'config b', 'config c', 'config d',
];

/** Remove candidate-identity hints from any string. */
function scrubIdentity(s) {
  let out = String(s == null ? '' : s);
  for (const tok of IDENTITY_TOKENS) {
    out = out.replace(new RegExp(tok.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), '\u2588');
  }
  return out;
}

/** Anonymise a transcript into judge-safe turns (role + scrubbed text only). */
function anonymiseTranscript(transcript) {
  return (transcript || []).map((t) => ({
    customer: scrubIdentity(t.userText || ''),
    assistant: scrubIdentity((t.view && t.view.reply) || ''),
    // structured surface the judge may use, scrubbed
    suggestedChecks: ((t.view && t.view.suggestedChecks) || []).map(scrubIdentity),
    askedQuestion: /\?/.test(((t.view && t.view.reply) || '')) || Boolean(t.view && t.view.needsModel),
  }));
}

/** Build the anonymised judge request payload (messages for a chat model). */
function buildJudgePrompt(journey, transcript) {
  const gold = journey.gold || journey;
  const anon = anonymiseTranscript(transcript);
  const system = [
    'You are an impartial appliance-diagnostics quality judge.',
    'You are shown an ANONYMISED transcript between a customer and a diagnostic assistant, plus the gold expectations.',
    'You do NOT know which AI produced the answers. Judge only what is written.',
    'Score EXACTLY three dimensions, each 0-100 (higher is better):',
    'REASONING_DISCRIMINATION: did the assistant reason like an engineer, discriminate between plausible causes, and use the evidence given?',
    'QUESTION_QUALITY: if a follow-up was needed, did it ask ONE discriminating question targeting the highest-value missing fact? Penalise asking when unnecessary, asking for already-known facts, or asking multiple questions. If no question was needed and none asked, score high.',
    'CUSTOMER_ANSWER_QUALITY: is the reply understandable, concise, appropriately confident, finding-first (not part-first), non-repetitive, clear about uncertainty, and not a generic chatbot? Penalise waffle, unnecessary disclaimers, premature part push, false certainty, brand overclaim.',
    'Respond with ONLY a JSON object: {"REASONING_DISCRIMINATION":<0-100>,"QUESTION_QUALITY":<0-100>,"CUSTOMER_ANSWER_QUALITY":<0-100>,"rationale":"<one concise sentence>"}',
  ].join('\n');
  const goldSummary = {
    expectedOutcome: gold.expectedOutcome,
    expectedFindingOrSuspects: gold.mustInclude || gold.goldSuspects || [],
    followUpAppropriate: gold.followUpAppropriate === true,
    followUpShouldEstablish: gold.followUpTargetFact || null,
    immediateDiagnosisExpected: gold.immediateDiagnosis === true,
    maxSensibleTurns: gold.maxTurns || null,
  };
  const user = 'GOLD:\n' + JSON.stringify(goldSummary, null, 0) + '\n\nTRANSCRIPT:\n' + JSON.stringify(anon, null, 0);
  return { messages: [{ role: 'system', content: system }, { role: 'user', content: user }] };
}

/** Parse + clamp the judge's JSON reply into the three dimension scores. */
function parseJudgeResponse(text) {
  let obj = null;
  try {
    const m = String(text || '').match(/\{[\s\S]*\}/);
    obj = m ? JSON.parse(m[0]) : null;
  } catch { obj = null; }
  if (!obj || typeof obj !== 'object') return null;
  const clamp = (v) => {
    const n = Number(v);
    if (!isFinite(n)) return null;
    return Math.max(0, Math.min(100, Math.round(n)));
  };
  const out = {
    REASONING_DISCRIMINATION: clamp(obj.REASONING_DISCRIMINATION),
    QUESTION_QUALITY: clamp(obj.QUESTION_QUALITY),
    CUSTOMER_ANSWER_QUALITY: clamp(obj.CUSTOMER_ANSWER_QUALITY),
    rationale: typeof obj.rationale === 'string' ? obj.rationale.slice(0, 240) : null,
  };
  // Require all three to be present, else treat as unusable (caller falls back).
  if (out.REASONING_DISCRIMINATION == null || out.QUESTION_QUALITY == null || out.CUSTOMER_ANSWER_QUALITY == null) return null;
  return out;
}

/**
 * Judge one journey. `callJudge(messages) -> Promise<string>` performs the fixed
 * OpenAI call (injected). Returns null on any failure so the caller marks the
 * subjective dims NOT JUDGED rather than fabricating them.
 */
async function judgeJourney(journey, transcript, callJudge) {
  if (typeof callJudge !== 'function') return null;
  try {
    const { messages } = buildJudgePrompt(journey, transcript);
    const text = await callJudge(messages);
    return parseJudgeResponse(text);
  } catch {
    return null;
  }
}

/** Stable hash of the judge system prompt, persisted with each run for provenance. */
function judgePromptHash(journeyExample) {
  const { messages } = buildJudgePrompt(journeyExample || { gold: {} }, []);
  const sys = messages[0].content;
  let h = 0;
  for (let i = 0; i < sys.length; i++) h = (h * 31 + sys.charCodeAt(i)) | 0;
  return (h >>> 0).toString(16) + '-' + JUDGE_RUBRIC_VERSION;
}

module.exports = {
  JUDGE_RUBRIC_VERSION, IDENTITY_TOKENS,
  scrubIdentity, anonymiseTranscript, buildJudgePrompt, parseJudgeResponse, judgeJourney, judgePromptHash,
};
