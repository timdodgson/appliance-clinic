'use strict';

/**
 * Structured semantic-review contract for production transcripts.
 *
 * Quality meaning is judged by an LLM. This module only validates shape,
 * enumerations, and provenance fields. It does not score conversation text.
 */

// s10-v1: multi-turn state-progression dimension + typed progression flags added. The version bump
// is intentional — existing s9-v1 reviews are treated as a prior schema (auto-review re-runs for
// never-reviewed records; already-reviewed records need a manual re-review, see eligibility.js).
const REVIEW_VERSION = 's10-v1';
const REVIEW_PROMPT_VERSION = 's10-v1';

const OVERALL = ['good', 'mixed', 'poor', 'insufficient_evidence'];
const OUTCOME = ['useful_outcome', 'partial_outcome', 'no_useful_outcome', 'abandoned', 'insufficient_evidence'];
const UNDERSTANDING = ['good', 'mixed', 'poor', 'insufficient_evidence'];
const DIAGNOSTIC = ['good', 'mixed', 'poor', 'not_applicable', 'insufficient_evidence'];
const CONVERSATION = ['good', 'mixed', 'poor', 'insufficient_evidence'];
const SAFETY = ['appropriate', 'concern', 'not_applicable', 'insufficient_evidence'];
const PARTS = ['appropriate', 'concern', 'not_applicable', 'insufficient_evidence'];
const MEDIA = ['useful', 'missed_opportunity', 'not_applicable', 'insufficient_evidence'];
const LOOPING = ['none', 'minor', 'significant'];
// MULTI-TURN STATE PROGRESSION (s10): did the assistant respect what the customer had already
// established across turns? good = established facts retained and the diagnosis advanced; mixed =
// minor lapse; poor = established appliance/make/model/symptom forgotten, a resolved detail
// re-requested, ruled-out evidence ignored, or a restart after the customer answered;
// insufficient_evidence = single-turn / too little to judge progression.
const STATE_PROGRESSION = ['good', 'mixed', 'poor', 'insufficient_evidence'];
// Typed per-failure flags (one semantic decision each). Positive flags (legitimateCorrection,
// advancedAfterCheck) prevent a legitimate customer correction being mislabelled as forgetting.
const PROGRESSION_FLAG_KEYS = [
  'forgotEstablishedState',
  'repeatedResolvedModelRequest',
  'ignoredNegativeEvidence',
  'restartedAfterAnswer',
  'unresolvedCorrection',
  'repeatedQuestionNoProgress',
  'legitimateCorrection',
  'advancedAfterCheck',
];
const PROGRESSION_CONCERN_FLAGS = [
  'forgotEstablishedState',
  'repeatedResolvedModelRequest',
  'ignoredNegativeEvidence',
  'restartedAfterAnswer',
  'unresolvedCorrection',
  'repeatedQuestionNoProgress',
];
const PRIORITY = ['normal', 'worth_reviewing', 'important'];
const PRODUCT_AREAS = [
  'understanding',
  'clarification',
  'diagnostic_reasoning',
  'knowledge',
  'parts',
  'media',
  'safety',
  'conversation_flow',
  'identification',
  'other',
];
const REVIEW_STATUS = ['none', 'awaiting', 'reviewed', 'failed'];

const ENUMS = {
  overallAssessment: OVERALL,
  outcome: OUTCOME,
  understanding: UNDERSTANDING,
  diagnosticReasoning: DIAGNOSTIC,
  conversationQuality: CONVERSATION,
  safetyHandling: SAFETY,
  partsHandling: PARTS,
  mediaHandling: MEDIA,
  looping: LOOPING,
  reviewPriority: PRIORITY,
};

function emptyReviewState() {
  return {
    status: 'none',
    version: null,
    promptVersion: null,
    reviewedAt: null,
    lastAttemptAt: null,
    attemptCount: 0,
    model: null,
    provider: null,
    error: null,
    assessment: null,
  };
}

function clip(s, n) {
  if (s == null) return '';
  const t = String(s);
  return t.length > n ? t.slice(0, n) : t;
}

function oneOf(value, allowed) {
  return typeof value === 'string' && allowed.indexOf(value) !== -1 ? value : null;
}

function stringList(arr, maxItems, maxLen) {
  if (!Array.isArray(arr)) return [];
  const out = [];
  for (const item of arr) {
    if (typeof item !== 'string') continue;
    const t = clip(item.trim(), maxLen);
    if (!t) continue;
    out.push(t);
    if (out.length >= maxItems) break;
  }
  return out;
}

function productAreas(arr) {
  if (!Array.isArray(arr)) return [];
  const seen = {};
  const out = [];
  for (const item of arr) {
    const key = typeof item === 'string' ? item.trim() : '';
    if (PRODUCT_AREAS.indexOf(key) === -1) continue;
    if (seen[key]) continue;
    seen[key] = true;
    out.push(key);
    if (out.length >= 6) break;
  }
  return out;
}

/**
 * Parse and validate an LLM assessment object.
 * Returns { ok:true, assessment } or { ok:false, error }.
 * Extra keys (including any chain-of-thought) are dropped.
 */
function validateAssessment(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: 'malformed-judge-output' };
  }
  const fields = {};
  for (const [key, allowed] of Object.entries(ENUMS)) {
    const v = oneOf(raw[key], allowed);
    if (!v) return { ok: false, error: 'malformed-judge-output', field: key };
    fields[key] = v;
  }
  const summary = clip(raw.summary, 600).trim();
  if (!summary) return { ok: false, error: 'malformed-judge-output', field: 'summary' };
  // Additive (s10): stateProgression + progressionFlags. Optional so the existing OpenAI/LM Studio
  // judge output (which may omit them) still validates; they default to insufficient_evidence / {}.
  const stateProgression = oneOf(raw.stateProgression, STATE_PROGRESSION) || 'insufficient_evidence';
  return {
    ok: true,
    assessment: {
      reviewVersion: REVIEW_VERSION,
      overallAssessment: fields.overallAssessment,
      outcome: fields.outcome,
      understanding: fields.understanding,
      diagnosticReasoning: fields.diagnosticReasoning,
      conversationQuality: fields.conversationQuality,
      safetyHandling: fields.safetyHandling,
      partsHandling: fields.partsHandling,
      mediaHandling: fields.mediaHandling,
      looping: fields.looping,
      stateProgression: stateProgression,
      progressionFlags: progressionFlags(raw.progressionFlags),
      reviewPriority: fields.reviewPriority,
      summary: summary,
      strengths: stringList(raw.strengths, 6, 240),
      concerns: stringList(raw.concerns, 6, 240),
      suggestedProductAreas: productAreas(raw.suggestedProductAreas || raw.suggestedProductArea),
    },
  };
}

// Typed, bounded progression flags: only known keys, strictly boolean true kept. Everything else is
// dropped (an absent/false/non-boolean flag is simply not asserted).
function progressionFlags(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const key of PROGRESSION_FLAG_KEYS) {
    if (raw[key] === true) out[key] = true;
  }
  return out;
}

function compactReview(review) {
  const r = review && typeof review === 'object' ? review : emptyReviewState();
  const a = r.assessment || null;
  return {
    status: oneOf(r.status, REVIEW_STATUS) || 'none',
    version: r.version || null,
    promptVersion: r.promptVersion || null,
    reviewedAt: r.reviewedAt || null,
    lastAttemptAt: r.lastAttemptAt || null,
    attemptCount: Number(r.attemptCount) || 0,
    model: r.model || null,
    provider: r.provider || null,
    error: r.error ? clip(r.error, 240) : null,
    assessment: a,
  };
}

function jsonSchemaForJudge() {
  const strEnum = (values) => ({ type: 'string', enum: values });
  return {
    type: 'object',
    additionalProperties: false,
    required: Object.keys(ENUMS).concat(['summary', 'strengths', 'concerns', 'suggestedProductAreas']),
    properties: {
      overallAssessment: strEnum(OVERALL),
      outcome: strEnum(OUTCOME),
      understanding: strEnum(UNDERSTANDING),
      diagnosticReasoning: strEnum(DIAGNOSTIC),
      conversationQuality: strEnum(CONVERSATION),
      safetyHandling: strEnum(SAFETY),
      partsHandling: strEnum(PARTS),
      mediaHandling: strEnum(MEDIA),
      looping: strEnum(LOOPING),
      stateProgression: strEnum(STATE_PROGRESSION),
      reviewPriority: strEnum(PRIORITY),
      summary: { type: 'string' },
      strengths: { type: 'array', items: { type: 'string' } },
      concerns: { type: 'array', items: { type: 'string' } },
      suggestedProductAreas: { type: 'array', items: { type: 'string', enum: PRODUCT_AREAS } },
    },
  };
}

module.exports = {
  REVIEW_VERSION,
  REVIEW_PROMPT_VERSION,
  OVERALL,
  OUTCOME,
  UNDERSTANDING,
  DIAGNOSTIC,
  CONVERSATION,
  SAFETY,
  PARTS,
  MEDIA,
  LOOPING,
  STATE_PROGRESSION,
  PROGRESSION_FLAG_KEYS,
  PROGRESSION_CONCERN_FLAGS,
  PRIORITY,
  PRODUCT_AREAS,
  REVIEW_STATUS,
  ENUMS,
  emptyReviewState,
  validateAssessment,
  progressionFlags,
  compactReview,
  jsonSchemaForJudge,
  clip,
};
