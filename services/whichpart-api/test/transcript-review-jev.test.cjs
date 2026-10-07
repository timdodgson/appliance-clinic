'use strict';

/**
 * Jev-based production transcript reviewer — contract + progression tests.
 *
 * The SEMANTIC meaning of each fixture (good progression / forgotten symptom / legitimate
 * correction / safety / …) is expressed as the TYPED Jev answers Jev would return for that
 * conversation (a `choice` or `noul` per question). These tests assert that the deterministic
 * adapter maps those typed answers onto the stored assessment contract and combines them into
 * reviewPriority / product areas / concerns / strengths correctly. There are NO regex / string /
 * phrase assertions against the conversation text to decide quality — quality is Jev's typed answer.
 *
 * Run: node services/whichpart-api/test/transcript-review-jev.test.cjs
 */
globalThis.awslambda = globalThis.awslambda || {
  streamifyResponse: (fn) => fn, HttpResponseStream: { from: (s) => s },
};

const review = require('../transcript-review');
const schema = require('../transcript-review/schema');
const jevReview = require('../transcript-review/jev-review');
const stateEv = require('../transcript-review/state-evidence');

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  ok  - ' + name); }
  else { fail++; console.log('  FAIL- ' + name + (detail ? '  :: ' + detail : '')); }
}

// ---- helpers: build a typed Jev answers map (what Jev "decided") -------------------------------
function choice(value, confidence) {
  return { type: 'choice', choice: value, confidence: confidence == null ? 0.9 : confidence, probabilities: {} };
}
function noul(v) { return { type: 'noul', noul: v ? 0.9 : 0.05 }; }

// Build a full typed answer set from a compact spec. Missing dimensions default sensibly.
function jevAnswers(spec) {
  spec = spec || {};
  const c = spec.choices || {};
  const flags = new Set(spec.flags || []);
  const a = {
    overallAssessment: choice(c.overallAssessment || 'good'),
    outcome: choice(c.outcome || 'useful_outcome'),
    understanding: choice(c.understanding || 'good'),
    diagnosticReasoning: choice(c.diagnosticReasoning || 'good'),
    conversationQuality: choice(c.conversationQuality || 'good'),
    safetyHandling: choice(c.safetyHandling || 'not_applicable'),
    partsHandling: choice(c.partsHandling || 'not_applicable'),
    mediaHandling: choice(c.mediaHandling || 'not_applicable'),
    looping: choice(c.looping || 'none'),
    stateProgression: choice(c.stateProgression || 'good'),
  };
  for (const key of schema.PROGRESSION_FLAG_KEYS) a[key] = noul(flags.has(key));
  return a;
}

// ---- helper: a minimal transcript record the reviewer can read ---------------------------------
function rec(turns, extra) {
  const now = new Date('2026-02-01T00:00:00Z').toISOString();
  return Object.assign({
    sessionId: 'sess-' + Math.random().toString(36).slice(2, 10),
    createdAt: now,
    lastActivityAt: now,
    status: 'ended',
    endedAt: now,
    turnCount: turns.length,
    family: 'washing-machine',
    make: null, model: null, errorCode: null, route: 'SYMPTOMS', outcome: 'ANSWER',
    safetyStop: false, safetyClass: null,
    turns: turns,
  }, extra || {});
}
function turn(seq, customer, assistant, progression, metadata) {
  return {
    seq: seq,
    at: new Date().toISOString(),
    customer: { text: customer, photo: false },
    customerVisible: { reply: assistant, parts: [], media: [] },
    metadata: Object.assign({ route: 'SYMPTOMS', outcome: 'ANSWER' }, metadata || {}),
    diagnosticTrace: progression ? { stages: [], stateProgression: progression } : null,
  };
}

async function judge(record, answers) {
  return jevReview.judgeViaJev(record, { now: new Date(), evaluate: async () => answers });
}

(async () => {
  // ============ CONTRACT: typed questions ============
  console.log('TYPED QUESTIONS');
  {
    const q = jevReview.buildReviewQuestions();
    const dims = ['overallAssessment', 'outcome', 'understanding', 'diagnosticReasoning',
      'conversationQuality', 'safetyHandling', 'partsHandling', 'mediaHandling', 'looping', 'stateProgression'];
    check('a typed question exists for every scored dimension', dims.every((d) => q[d] && q[d].type === 'choice'));
    check('a typed noul question exists for every progression flag',
      schema.PROGRESSION_FLAG_KEYS.every((k) => q[k] && q[k].type === 'noul' && q[k].criteria && q[k].criteria.true));
    check('choice questions carry enum option criteria',
      Object.keys(q.stateProgression.criteria).sort().join(',') === schema.STATE_PROGRESSION.slice().sort().join(','));
  }

  // ============ CONTRACT: adapter maps typed answers -> assessment ============
  console.log('ADAPTER CONTRACT');
  {
    const out = await judge(rec([turn(1, 'my washing machine won\'t spin', 'Check the filter.')]),
      jevAnswers({ choices: { overallAssessment: 'good' } }));
    check('judgeViaJev returns a valid assessment', out.parsed.ok === true, JSON.stringify(out.parsed));
    check('config provenance is jev', out.config.provider === 'jev' && out.config.model === jevReview.JEV_MODEL);
    check('promptVersion is the current review version', out.promptVersion === schema.REVIEW_PROMPT_VERSION);
    const a = out.parsed.assessment;
    check('stateProgression present in assessment', a.stateProgression === 'good');
    check('progressionFlags present (typed object)', a.progressionFlags && typeof a.progressionFlags === 'object');
    check('summary is non-empty plain text', typeof a.summary === 'string' && a.summary.length > 0);
  }

  // ============ low-confidence choice falls back, not asserted ============
  {
    const a = jevReview.assessFromAnswers({ stateProgression: choice('poor', 0.2) });
    check('low-confidence choice is treated as insufficient_evidence (not asserted poor)',
      a.stateProgression === 'insufficient_evidence', a.stateProgression);
  }

  // ============ FIXTURE A — good progression ============
  console.log('FIXTURE A — good progression');
  {
    const r = rec([
      turn(1, 'washing machine won\'t spin, water left', 'Likely a drain blockage. Check the filter.'),
      turn(2, 'the filter is clear', 'Thanks — since the filter is clear, check the drain hose next.'),
    ]);
    const out = await judge(r, jevAnswers({ choices: { stateProgression: 'good', overallAssessment: 'good' }, flags: ['advancedAfterCheck'] }));
    const a = out.parsed.assessment;
    check('A: good progression', a.stateProgression === 'good');
    check('A: not flagged for attention', a.reviewPriority === 'normal', a.reviewPriority);
    check('A: advancement recorded as a strength', a.strengths.some((s) => /advanced|prior context/i.test(s)));
    check('A: no progression concern', a.progressionFlags.forgotEstablishedState !== true);
  }

  // ============ FIXTURE B — forgotten symptom ============
  console.log('FIXTURE B — forgotten symptom');
  {
    const r = rec([
      turn(1, 'dishwasher not draining', 'Let\'s check the filter.'),
      turn(2, 'it\'s a Bosch', 'What appliance are we talking about? Please describe the problem.'),
    ]);
    const out = await judge(r, jevAnswers({
      choices: { stateProgression: 'poor', conversationQuality: 'mixed', overallAssessment: 'mixed' },
      flags: ['forgotEstablishedState'],
    }));
    const a = out.parsed.assessment;
    check('B: poor progression', a.stateProgression === 'poor');
    check('B: forgot flag carried', a.progressionFlags.forgotEstablishedState === true);
    check('B: flagged worth_reviewing', a.reviewPriority === 'worth_reviewing', a.reviewPriority);
    check('B: concern mentions forgetting', a.concerns.some((c) => /forget/i.test(c)));
    check('B: product areas include conversation_flow + identification',
      a.suggestedProductAreas.indexOf('conversation_flow') !== -1 && a.suggestedProductAreas.indexOf('identification') !== -1,
      a.suggestedProductAreas.join(','));
  }

  // ============ FIXTURE C — repeated model request ============
  console.log('FIXTURE C — repeated model request');
  {
    const out = await judge(rec([
      turn(1, 'oven not heating, model is HBA5780S0B', 'Thanks. Let me check.'),
      turn(2, 'any ideas?', 'What is the model number on the rating plate?'),
    ]), jevAnswers({ choices: { stateProgression: 'poor' }, flags: ['repeatedResolvedModelRequest'] }));
    const a = out.parsed.assessment;
    check('C: repeated-model flag carried', a.progressionFlags.repeatedResolvedModelRequest === true);
    check('C: flagged worth_reviewing', a.reviewPriority === 'worth_reviewing');
    check('C: identification product area', a.suggestedProductAreas.indexOf('identification') !== -1);
    check('C: concern mentions model re-request', a.concerns.some((c) => /model/i.test(c)));
  }

  // ============ FIXTURE D — ignored negative evidence ============
  console.log('FIXTURE D — ignored negative evidence');
  {
    const out = await judge(rec([
      turn(1, 'won\'t drain, filter already clean', 'Clean the filter.'),
      turn(2, 'I said the filter is clean', 'Please clean the filter.'),
    ]), jevAnswers({ choices: { diagnosticReasoning: 'poor', stateProgression: 'poor' }, flags: ['ignoredNegativeEvidence'] }));
    const a = out.parsed.assessment;
    check('D: ignored-negative flag carried', a.progressionFlags.ignoredNegativeEvidence === true);
    check('D: diagnostic_reasoning product area', a.suggestedProductAreas.indexOf('diagnostic_reasoning') !== -1);
    check('D: flagged worth_reviewing', a.reviewPriority === 'worth_reviewing');
  }

  // ============ FIXTURE E — legitimate correction (NOT forgetting) ============
  console.log('FIXTURE E — legitimate correction');
  {
    const out = await judge(rec([
      turn(1, 'my washing machine won\'t spin', 'Let\'s look at the drum.'),
      turn(2, 'sorry it\'s actually my dishwasher', 'No problem — for the dishwasher, let\'s check drainage.'),
    ]), jevAnswers({ choices: { stateProgression: 'good', overallAssessment: 'good' }, flags: ['legitimateCorrection'] }));
    const a = out.parsed.assessment;
    check('E: NOT marked as forgetting', a.progressionFlags.forgotEstablishedState !== true);
    check('E: progression stays good', a.stateProgression === 'good');
    check('E: correction recorded as a strength', a.strengths.some((s) => /correction/i.test(s)));
    check('E: not flagged for attention', a.reviewPriority === 'normal', a.reviewPriority);
  }

  // ============ FIXTURE F — abandonment is not automatic failure ============
  console.log('FIXTURE F — abandonment');
  {
    const out = await judge(rec([
      turn(1, 'fridge not cold', 'Is the freezer also warm, or just the fridge?'),
    ]), jevAnswers({ choices: { outcome: 'abandoned', overallAssessment: 'insufficient_evidence', stateProgression: 'insufficient_evidence' } }));
    const a = out.parsed.assessment;
    check('F: outcome abandoned', a.outcome === 'abandoned');
    check('F: NOT marked poor automatically', a.overallAssessment !== 'poor', a.overallAssessment);
    check('F: not flagged for attention', a.reviewPriority === 'normal', a.reviewPriority);
  }

  // ============ FIXTURE G — safety ============
  console.log('FIXTURE G — safety');
  {
    const out = await judge(rec([
      turn(1, 'I can smell gas from my oven and want to fix it myself', 'Here is how to take the gas valve apart...'),
    ]), jevAnswers({ choices: { safetyHandling: 'concern', overallAssessment: 'poor' } }));
    const a = out.parsed.assessment;
    check('G: safety concern', a.safetyHandling === 'concern');
    check('G: reviewPriority important', a.reviewPriority === 'important', a.reviewPriority);
    check('G: safety product area', a.suggestedProductAreas.indexOf('safety') !== -1);
  }

  // ============ FIXTURE H — good short/sparse reply ============
  console.log('FIXTURE H — good sparse reply');
  {
    const out = await judge(rec([
      turn(1, 'washer won\'t spin, water left', 'Does it make a humming noise when it tries to spin?'),
      turn(2, 'no', 'Thanks. Since there is no hum, the next check is the drain pump filter.'),
    ]), jevAnswers({ choices: { stateProgression: 'good', overallAssessment: 'good' }, flags: ['advancedAfterCheck'] }));
    const a = out.parsed.assessment;
    check('H: progression good after a sparse "no"', a.stateProgression === 'good');
    check('H: not flagged for attention', a.reviewPriority === 'normal');
    check('H: no forgetting/looping concern', a.progressionFlags.forgotEstablishedState !== true && a.looping === 'none');
  }

  // ============ STATE EVIDENCE (structural, from stored trace) ============
  console.log('STATE EVIDENCE');
  {
    const r = rec([
      turn(1, 'washer won\'t spin, water left', 'Check the filter.', [
        { path: 'customer.appliance', change: 'NEW', value: 'washing-machine' },
        { path: 'customer.fault', change: 'NEW', value: 'not spinning' },
      ]),
      turn(2, 'it\'s a Bosch', 'Which appliance is this?', [
        { path: 'customer.make', change: 'NEW', value: 'bosch' },
        { path: 'customer.appliance', change: 'REMOVED_OR_CONTRADICTED', previous: 'washing-machine' },
        { path: 'customer.fault', change: 'REMOVED_OR_CONTRADICTED', previous: 'not spinning' },
      ]),
    ]);
    const ev = stateEv.buildStateEvidence(r);
    check('evidence surfaces identity + problem drops', ev.droppedGroups.identity === true && ev.droppedGroups.problem === true);
    check('evidence timeline only lists meaningful changes',
      ev.timeline.length === 2 && ev.timeline[1].changes.some((c) => c.change === 'REMOVED_OR_CONTRADICTED'));
    check('evidence records a make addition (NEW)', ev.timeline[1].changes.some((c) => c.field === 'make' && c.change === 'NEW'));
    check('compactStateEvidence renders field:change strings', (() => {
      const c = stateEv.compactStateEvidence(ev);
      return c.timeline[0].changes.every((s) => /:(NEW|UPDATED|REMOVED_OR_CONTRADICTED)$/.test(s));
    })());
  }

  // ============ s9 -> s10 additive validation (backward compatible) ============
  console.log('ADDITIVE SCHEMA');
  {
    const s9raw = {
      overallAssessment: 'good', outcome: 'useful_outcome', understanding: 'good',
      diagnosticReasoning: 'good', conversationQuality: 'good', safetyHandling: 'not_applicable',
      partsHandling: 'not_applicable', mediaHandling: 'not_applicable', looping: 'none',
      reviewPriority: 'normal', summary: 'ok', strengths: [], concerns: [], suggestedProductAreas: [],
    };
    const v = schema.validateAssessment(s9raw);
    check('s9-style assessment (no stateProgression) still validates', v.ok === true);
    check('stateProgression defaults to insufficient_evidence', v.assessment.stateProgression === 'insufficient_evidence');
    check('progressionFlags defaults to {}', JSON.stringify(v.assessment.progressionFlags) === '{}');
  }

  console.log(`\ntranscript-review-jev: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
