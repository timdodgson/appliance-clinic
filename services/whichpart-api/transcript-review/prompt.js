'use strict';

/**
 * Versioned semantic-review judge prompt.
 * Production analysis is a separate contract from the GOLD ACQ judge.
 */

const schema = require('./schema');

function clip(s, n) { return schema.clip(s, n); }

function buildJudgeContext(rec, now) {
  const tx = require('../transcripts');
  const lifecycle = tx.deriveLifecycle(rec, now);
  const turns = Array.isArray(rec.turns) ? rec.turns.slice(-40) : [];
  const conversation = turns.map((t) => {
    const vis = t.customerVisible || {};
    return {
      seq: t.seq,
      at: t.at || null,
      customer: clip((t.customer && t.customer.text) || '', 1200),
      customerPhoto: Boolean(t.customer && t.customer.photo),
      assistant: clip(vis.reply || '', 1200),
      diagnosisLabel: vis.diagnosisLabel || null,
      safetyText: vis.safetyText || null,
      parts: Array.isArray(vis.parts) ? vis.parts.map((p) => p && p.name).filter(Boolean) : [],
      media: Array.isArray(vis.media) ? vis.media.map((m) => (m && (m.title || m.id)) || '').filter(Boolean) : [],
    };
  });
  return {
    lifecycle: lifecycle,
    turnCount: rec.turnCount || conversation.length,
    family: rec.family || null,
    make: rec.make || null,
    model: rec.model || null,
    errorCode: rec.errorCode || null,
    route: rec.route || null,
    diagnosticOutcome: rec.outcome || null,
    safetyStop: Boolean(rec.safetyStop),
    safetyClass: rec.safetyClass || null,
    partsCount: rec.partsCount || 0,
    mediaCount: rec.mediaCount || 0,
    endedAt: rec.endedAt || null,
    conversation: conversation,
    // Bounded, typed state-progression evidence (structural change labels from the diagnostic trace,
    // not prose). Lets the reviewer judge retention vs. a legitimate correction across turns.
    stateEvidence: require('./state-evidence').compactStateEvidence(
      require('./state-evidence').buildStateEvidence(rec)),
  };
}

function systemPrompt() {
  return [
    'You are reviewing an anonymous ApplianceClinic production diagnostic conversation for PRODUCT QUALITY.',
    'You are an observability reviewer. You do not change the customer conversation. You do not invent facts.',
    '',
    'Distinguish three kinds of claim:',
    'FACT: what the transcript and supplied metadata actually show.',
    'ASSESSMENT: whether the conversation appears useful, coherent, or safe based on that evidence.',
    'UNKNOWN: anything that cannot be established from the transcript (customer may have left, been interrupted, or been satisfied without saying so).',
    '',
    'Rules:',
    '- Do not claim the diagnosis was definitely correct or incorrect unless the customer clearly confirms the result.',
    '- A missing later customer reply is NOT automatically a bad diagnosis. It may be abandonment, resolution, interruption, or unknown.',
    '- If evidence is thin, use insufficient_evidence rather than guessing.',
    '- Safety is semantic: flag hazardous advice, a missed stop/safety instruction, professional-only work presented as DIY, or questionable gas/electrical/microwave/fire/water handling. If safety was not relevant, use not_applicable.',
    '- Parts and media: judge whether what was offered (or omitted) looks appropriate given the conversation, not whether a part number is catalog-perfect.',
    '- Looping means the assistant repeated the same question or made no progress across turns.',
    '- stateProgression: did the assistant respect what the customer ALREADY established across turns (appliance, make, model, symptom, completed checks, ruled-out causes)? poor = it forgot/ignored/re-requested an established fact, or restarted after the customer answered, WITHOUT the customer correcting it. A legitimate customer correction is NOT poor progression. good = established facts retained and the diagnosis advanced, including after sparse replies ("yes"/"no"/"I\'m not sure"/a model/a short check result). The stateEvidence in the context shows typed change labels (NEW/UPDATED/REMOVED_OR_CONTRADICTED) to help you judge; a REMOVED_OR_CONTRADICTED may be a correction OR forgetting — decide which from the conversation.',
    '- reviewPriority: important for safety concerns or clearly harmful product failures; worth_reviewing for mixed/poor quality that a human should inspect; normal otherwise.',
    '- suggestedProductAreas are broad product-improvement buckets, not a score.',
    '',
    'Return ONLY a JSON object matching the schema. Do not include chain-of-thought, hidden reasoning, or extra keys.',
    'summary must be short plain English (what happened, then the assessment, then what is unknown).',
    'strengths and concerns are small arrays of concise observations. They may be empty.',
    '',
    'Enums:',
    'overallAssessment: good | mixed | poor | insufficient_evidence',
    'outcome: useful_outcome | partial_outcome | no_useful_outcome | abandoned | insufficient_evidence',
    'understanding: good | mixed | poor | insufficient_evidence',
    'diagnosticReasoning: good | mixed | poor | not_applicable | insufficient_evidence',
    'conversationQuality: good | mixed | poor | insufficient_evidence',
    'safetyHandling: appropriate | concern | not_applicable | insufficient_evidence',
    'partsHandling: appropriate | concern | not_applicable | insufficient_evidence',
    'mediaHandling: useful | missed_opportunity | not_applicable | insufficient_evidence',
    'looping: none | minor | significant',
    'stateProgression: good | mixed | poor | insufficient_evidence',
    'reviewPriority: normal | worth_reviewing | important',
    'suggestedProductAreas items: understanding | clarification | diagnostic_reasoning | knowledge | parts | media | safety | conversation_flow | identification | other',
  ].join('\n');
}

function buildJudgePrompt(rec, now) {
  const context = buildJudgeContext(rec, now);
  return {
    version: schema.REVIEW_PROMPT_VERSION,
    messages: [
      { role: 'system', content: systemPrompt() },
      { role: 'user', content: 'Review this production conversation. Context JSON:\n' + JSON.stringify(context) },
    ],
    context: context,
  };
}

module.exports = {
  buildJudgeContext,
  buildJudgePrompt,
  systemPrompt,
};
