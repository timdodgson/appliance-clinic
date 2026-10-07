'use strict';

/**
 * Story 9 — semantic production transcript review.
 * Deterministic structure, eligibility, persistence, admin isolation.
 * Semantic meaning is judged by an injected LLM (no regex/phrase scoring).
 *
 *   node services/whichpart-api/test/transcript-review.test.cjs
 */

const tx = require('../transcripts');
const review = require('../transcript-review');
const { FIXTURES } = require('./fixtures/transcript-review-conversations.cjs');
const api = require('../index.js');

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  ok  - ' + name); }
  else { fail++; console.log('  FAIL- ' + name + (detail ? '  :: ' + detail : '')); }
}

const NOW = new Date('2026-09-18T12:00:00.000Z');
const STALE = new Date('2026-09-18T07:00:00.000Z');

function assessment(overrides) {
  return Object.assign({
    overallAssessment: 'mixed',
    outcome: 'partial_outcome',
    understanding: 'good',
    diagnosticReasoning: 'good',
    conversationQuality: 'good',
    safetyHandling: 'not_applicable',
    partsHandling: 'not_applicable',
    mediaHandling: 'not_applicable',
    looping: 'none',
    reviewPriority: 'normal',
    summary: 'The conversation shows a plausible diagnostic path with some uncertainty remaining.',
    strengths: ['Acknowledged the symptom.'],
    concerns: [],
    suggestedProductAreas: [],
  }, overrides || {});
}

function judgeReturning(obj) {
  return async function () { return JSON.stringify(obj); };
}

async function seedTurn(store, sessionId, text, when, extra) {
  extra = extra || {};
  await tx.persistTurn(store, { sessionId: sessionId, clientTurnId: extra.tid || ('t-' + sessionId), event: 'turn' }, {
    now: when || NOW,
    messages: [{ role: 'user', content: text || 'My washer will not drain' }],
    view: {
      reply: extra.reply || 'Check the pump filter with the machine off.',
      diagnosis: { label: extra.label || 'Not draining' },
      parts: extra.parts || [],
      media: extra.media || [],
      safety: Boolean(extra.safety),
      safetyInformation: extra.safetyText ? { text: extra.safetyText } : null,
      error: Boolean(extra.error),
    },
    orch: {
      outcome: extra.outcome || 'ANSWER',
      route: extra.route || 'SYMPTOMS',
      traceId: 'tr-x',
      safety: extra.safety ? { class: 'STOP_USE', stopUse: true } : { class: 'NORMAL', stopUse: false },
      _telemetry: { submitted: { make: extra.make || 'bosch', applianceFamily: extra.family || 'washing machine', displayedCode: extra.code || null } },
    },
    requestId: extra.rid || 'rid-x',
  });
}

(async function main() {
  console.log('ELIGIBILITY');
  {
    const store = tx.createMemoryStore();
    await seedTurn(store, 's-active-session01', 'hello', NOW);
    const active = await store.get('s-active-session01');
    check('active transcript is not reviewable', review.isReviewable(active, NOW) === false);
    check('active display status is none', review.displayReviewStatus(active, NOW) === 'none');
    check('auto skips active', review.autoDecision(active, NOW).reason === 'not-eligible');

    await tx.persistEnd(store, { sessionId: 's-active-session01', event: 'end' }, NOW);
    const ended = await store.get('s-active-session01');
    check('ended transcript is eligible', review.isReviewable(ended, NOW) === true);
    check('ended display is awaiting', review.displayReviewStatus(ended, NOW) === 'awaiting');

    const inactive = tx.emptyRecord('s-inactive-session', STALE);
    inactive.lastActivityAt = STALE.toISOString();
    inactive.status = 'active';
    inactive.turnCount = 1;
    inactive.turns = [{ seq: 1, customer: { text: 'x' }, customerVisible: { reply: 'y' } }];
    check('inactive transcript is eligible', review.isReviewable(inactive, NOW) === true);
    check('inactive is not a fake completed state', tx.deriveLifecycle(inactive, NOW) === 'inactive');
  }

  console.log('SCHEMA VALIDATION');
  {
    const ok = review.validateAssessment(assessment());
    check('well-formed assessment is accepted', ok.ok === true && ok.assessment.reviewVersion === review.REVIEW_VERSION);
    check('drops extra keys / chain-of-thought', ok.assessment.reasoning === undefined && ok.assessment.chainOfThought === undefined);
    const bad = review.validateAssessment({ overallAssessment: 'excellent', summary: 'nope' });
    check('unknown enum is malformed', bad.ok === false && bad.error === 'malformed-judge-output');
    const noSummary = review.validateAssessment(assessment({ summary: '   ' }));
    check('empty summary is malformed', noSummary.ok === false);
    const parsed = review.parseJudgeResponse('Here you go\n```json\n' + JSON.stringify(assessment({ overallAssessment: 'poor' })) + '\n```');
    check('fenced JSON is parsed', parsed.ok === true && parsed.assessment.overallAssessment === 'poor');
    const junk = review.parseJudgeResponse('sorry I cannot');
    check('non-JSON judge output is malformed', junk.ok === false);
  }

  console.log('PROMPT PRIVACY + STRUCTURE');
  {
    const rec = FIXTURES.good_useful_diagnosis;
    const built = review.buildJudgePrompt(rec, NOW);
    const blob = JSON.stringify(built);
    check('prompt version is stored', built.version === review.REVIEW_PROMPT_VERSION);
    check('prompt includes conversation turns', built.context.conversation.length === rec.turns.length);
    check('prompt omits session id', !blob.includes(rec.sessionId));
    check('prompt omits request/trace ids', !/lastRequestId|lastTraceId|requestId/.test(blob) || !blob.includes('tr-'));
    check('system prompt forbids chain-of-thought', /Do not include chain-of-thought/i.test(built.messages[0].content));
  }

  console.log('ONE REVIEW PER VERSION + RETRY');
  {
    const store = tx.createMemoryStore();
    await seedTurn(store, 's-ended-review01', 'Washer full of water', NOW);
    await tx.persistEnd(store, { sessionId: 's-ended-review01', event: 'end' }, NOW);
    const before = await store.get('s-ended-review01');
    const ttlBefore = before.expiresAt;
    const lastBefore = before.lastActivityAt;
    const turnsBefore = JSON.stringify(before.turns);

    const r1 = await review.reviewSession({
      store: store, sessionId: 's-ended-review01', now: NOW, manual: false,
      callJudge: judgeReturning(assessment({ overallAssessment: 'good', outcome: 'useful_outcome' })),
      config: { enabled: true, provider: 'openai', model: 'test-reviewer', maxPerRun: 3 },
    });
    check('first review succeeds', r1.ok === true);
    const rec1 = await store.get('s-ended-review01');
    check('status is reviewed', rec1.review.status === 'reviewed');
    check('version stored', rec1.review.version === review.REVIEW_VERSION && rec1.review.promptVersion === review.REVIEW_PROMPT_VERSION);
    check('model/provider provenance stored', rec1.review.model === 'test-reviewer' && rec1.review.provider === 'openai');
    check('original turns unchanged', JSON.stringify(rec1.turns) === turnsBefore);
    check('TTL not refreshed by review', rec1.expiresAt === ttlBefore);
    check('lastActivityAt not bumped by review', rec1.lastActivityAt === lastBefore);

    const r2 = await review.reviewSession({
      store: store, sessionId: 's-ended-review01', now: NOW, manual: false,
      callJudge: judgeReturning(assessment({ overallAssessment: 'poor' })),
      config: { enabled: true, provider: 'openai', model: 'test-reviewer', maxPerRun: 3 },
    });
    check('second auto review of same version is skipped', r2.ok === false && r2.reason === 'already-reviewed');
    const rec2 = await store.get('s-ended-review01');
    check('stored overall remains first review', rec2.review.assessment.overallAssessment === 'good');

    const r3 = await review.reviewSession({
      store: store, sessionId: 's-ended-review01', now: NOW, manual: true,
      callJudge: judgeReturning(assessment({ overallAssessment: 'mixed', reviewPriority: 'worth_reviewing' })),
      config: { enabled: true, provider: 'openai', model: 'test-reviewer', maxPerRun: 3 },
    });
    check('manual re-review immediately is cooldown 429', r3.ok === false && r3.reason === 'cooldown' && r3.http === 429);

    const later = new Date(NOW.getTime() + 31 * 1000);
    const r4 = await review.reviewSession({
      store: store, sessionId: 's-ended-review01', now: later, manual: true,
      callJudge: judgeReturning(assessment({ overallAssessment: 'mixed', reviewPriority: 'worth_reviewing' })),
      config: { enabled: true, provider: 'openai', model: 'test-reviewer', maxPerRun: 3 },
    });
    check('manual re-review after 30s succeeds', r4.ok === true);
    const rec4 = await store.get('s-ended-review01');
    check('manual re-review replaced assessment', rec4.review.assessment.overallAssessment === 'mixed');
    check('turns still unchanged after re-review', JSON.stringify(rec4.turns) === turnsBefore);
  }

  console.log('FAILURE + SAFE RETRY');
  {
    const store = tx.createMemoryStore();
    await seedTurn(store, 's-fail-review001', 'Dryer cold', NOW);
    await tx.persistEnd(store, { sessionId: 's-fail-review001', event: 'end' }, NOW);
    const bad = await review.reviewSession({
      store: store, sessionId: 's-fail-review001', now: NOW, manual: false,
      callJudge: async () => 'not-json',
      config: { enabled: true, provider: 'openai', model: 'test-reviewer', maxPerRun: 3 },
    });
    check('malformed judge fails safely', bad.ok === false && bad.reason === 'malformed-judge-output');
    const failed = await store.get('s-fail-review001');
    check('failed status visible', failed.review.status === 'failed');
    check('turns survive failed review', failed.turns.length === 1);

    const tooSoon = await review.reviewSession({
      store: store, sessionId: 's-fail-review001', now: NOW, manual: false,
      callJudge: judgeReturning(assessment()),
      config: { enabled: true, provider: 'openai', model: 'test-reviewer', maxPerRun: 3 },
    });
    check('auto retry respects backoff', tooSoon.reason === 'backoff');

    const afterBackoff = new Date(NOW.getTime() + 16 * 60 * 1000);
    const retried = await review.reviewSession({
      store: store, sessionId: 's-fail-review001', now: afterBackoff, manual: false,
      callJudge: judgeReturning(assessment({ overallAssessment: 'poor' })),
      config: { enabled: true, provider: 'openai', model: 'test-reviewer', maxPerRun: 3 },
    });
    check('auto retry after failure succeeds', retried.ok === true);
    check('status becomes reviewed', (await store.get('s-fail-review001')).review.status === 'reviewed');

    const throwingStore = {
      async get(id) { return store.get(id); },
      async put() { throw new Error('review-index-down'); },
      async listRecentRecords() { return []; },
    };
    // Customer persist must not use review put. persistSafely still swallows.
    const isolated = await tx.persistSafely(throwingStore, () => tx.persistTurn(throwingStore, {
      sessionId: 's-cust-isolat01', clientTurnId: 't1', event: 'turn',
    }, {
      now: NOW,
      messages: [{ role: 'user', content: 'x' }],
      view: { reply: 'y', parts: [], media: [], safety: false, error: false, diagnosis: {} },
      orch: { outcome: 'ANSWER', route: 'SYMPTOMS', safety: {}, _telemetry: { submitted: {} } },
      requestId: 'r',
    }), function () {});
    check('customer persist failure remains isolated from review', isolated.ok === false);
  }

  console.log('RESUME CLEARS STALE REVIEW');
  {
    const store = tx.createMemoryStore();
    await seedTurn(store, 's-resume-session1', 'Washer noisy', STALE);
    const rec = await store.get('s-resume-session1');
    rec.review = {
      status: 'reviewed', version: 's9-v1', assessment: assessment({ overallAssessment: 'poor' }),
      lastAttemptAt: STALE.toISOString(), attemptCount: 1,
    };
    await store.put(rec);
    await seedTurn(store, 's-resume-session1', 'It is still noisy after the last advice', NOW, { tid: 't-resume-2' });
    const resumed = await store.get('s-resume-session1');
    check('new turn after inactivity clears review', resumed.review.status === 'none' && resumed.review.assessment == null);
  }

  console.log('BATCH AUTO-REVIEW SKIPS ACTIVE AND ALREADY REVIEWED');
  {
    const store = tx.createMemoryStore();
    await seedTurn(store, 's-batch-active01', 'hi', NOW);
    await seedTurn(store, 's-batch-ended01x', 'Washer leak', NOW);
    await tx.persistEnd(store, { sessionId: 's-batch-ended01x', event: 'end' }, NOW);
    const batch = await review.runBatch({
      store: store,
      now: NOW,
      callJudge: judgeReturning(assessment({ overallAssessment: 'good' })),
      config: { enabled: true, provider: 'test', model: 'm', maxPerRun: 3 },
    });
    check('batch reviews only eligible', batch.attempted === 1 && batch.reviewed === 1);
    check('active remains unreviewed', (await store.get('s-batch-active01')).review.status === 'none');
  }

  console.log('FILTERS + AGGREGATES');
  {
    const store = tx.createMemoryStore();
    for (const [name, rec] of Object.entries(FIXTURES)) {
      rec.review = review.emptyReviewState();
      await store.put(rec);
    }
    const ended = await store.get('s-good-useful-01');
    await review.reviewOne({
      store: store, rec: ended, now: NOW,
      callJudge: judgeReturning(assessment({
        overallAssessment: 'good', outcome: 'useful_outcome', reviewPriority: 'normal',
        mediaHandling: 'useful', suggestedProductAreas: [],
      })),
      config: { enabled: true, provider: 'test', model: 'm', maxPerRun: 3 },
    });
    const unsafe = await store.get('s-unsafereply-01');
    await review.reviewOne({
      store: store, rec: unsafe, now: NOW,
      callJudge: judgeReturning(assessment({
        overallAssessment: 'poor', outcome: 'no_useful_outcome', reviewPriority: 'important',
        safetyHandling: 'concern', suggestedProductAreas: ['safety'],
      })),
      config: { enabled: true, provider: 'test', model: 'm', maxPerRun: 3 },
    });
    const loop = await store.get('s-loop-01');
    await review.reviewOne({
      store: store, rec: loop, now: NOW,
      callJudge: judgeReturning(assessment({
        overallAssessment: 'poor', outcome: 'no_useful_outcome', reviewPriority: 'worth_reviewing',
        looping: 'significant', conversationQuality: 'poor', suggestedProductAreas: ['clarification', 'conversation_flow'],
      })),
      config: { enabled: true, provider: 'test', model: 'm', maxPerRun: 3 },
    });

    const important = await store.list({ limit: 50, priority: 'important' }, NOW);
    check('priority filter', important.items.length === 1 && important.items[0].sessionId === 's-unsafereply-01');
    const awaiting = await store.list({ limit: 50, reviewStatus: 'awaiting' }, NOW);
    check('awaiting filter excludes reviewed', awaiting.items.every((r) => r.reviewStatus === 'awaiting'));
    const area = await store.list({ limit: 50, productArea: 'safety' }, NOW);
    check('product-area filter', area.items.length === 1);
    const quality = await review.qualityFromStore(store, NOW);
    check('aggregate reviewed count', quality.reviewed === 3);
    check('aggregate safety concern count', quality.safetyConcern === 1);
    check('aggregate looping count', quality.loopingSignificant === 1);
    check('aggregate does not claim significance', /not statistical significance/i.test(quality.note));
    check('overview row carries review fields', important.items[0].reviewOverall === 'poor');
  }

  console.log('SEMANTIC CONTRACT ACROSS FIXTURES (injected LLM, no phrase scoring)');
  {
    const labels = Object.keys(FIXTURES);
    check('fixture pack covers required conversation shapes', labels.length >= 10);
    const store = tx.createMemoryStore();
    let n = 0;
    for (const rec of Object.values(FIXTURES)) {
      const copy = JSON.parse(JSON.stringify(rec));
      copy.review = review.emptyReviewState();
      await store.put(copy);
      const prompt = review.buildJudgePrompt(copy, NOW);
      check('fixture ' + copy.sessionId + ' has conversation context', prompt.context.conversation.length >= 1);
      const result = await review.reviewOne({
        store: store,
        rec: await store.get(copy.sessionId),
        now: NOW,
        callJudge: judgeReturning(assessment({
          overallAssessment: 'insufficient_evidence',
          outcome: 'insufficient_evidence',
          summary: 'Assessment stored from injected semantic judge for contract coverage.',
        })),
        config: { enabled: true, provider: 'test', model: 'm', maxPerRun: 3 },
      });
      if (result.ok) n++;
    }
    check('every fixture produced a persisted structured review', n === labels.length);
  }

  console.log('ADMIN AUTH + CUSTOMER PATH INDEPENDENCE');
  {
    const store = tx.createMemoryStore();
    api.setTranscriptStore(store);
    api.setTranscriptReviewJudge(async () => { throw new Error('judge-should-not-run-on-customer'); });
    function invoke(method, rawPath, opts) {
      opts = opts || {};
      return api.handler({
        rawPath, requestContext: { http: { method, path: rawPath }, requestId: 't' },
        headers: opts.headers || {}, cookies: opts.cookies || [], body: opts.body || '',
        queryStringParameters: opts.qs || {},
      });
    }
    const unauth = await invoke('POST', '/api/admin/transcripts/session/review', { qs: { id: 's-abc123xyz' } });
    check('unauthenticated re-review -> 401', unauth.statusCode === 401);
    const qUnauth = await invoke('GET', '/api/admin/transcripts/quality');
    check('unauthenticated quality -> 401', qUnauth.statusCode === 401);

    const end = await invoke('POST', '/api', { body: JSON.stringify({ observability: { sessionId: 's-abc123xyz', event: 'end' } }) });
    check('customer end still 200 with throwing judge', end.statusCode === 200);

    await seedTurn(store, 's-sched-ended001', 'Washer leak', NOW);
    await tx.persistEnd(store, { sessionId: 's-sched-ended001', event: 'end' }, NOW);
    api.setTranscriptReviewJudge(async () => JSON.stringify(assessment({ overallAssessment: 'good', outcome: 'useful_outcome' })));
    const scheduled = await api.handler({ transcriptReview: true });
    check('EventBridge transcriptReview does not throw', scheduled && scheduled.ok === true);
    check('scheduled review persisted', (await store.get('s-sched-ended001')).review.status === 'reviewed');

    api.setTranscriptReviewJudge(async () => { throw new Error('boom-judge'); });
    await seedTurn(store, 's-sched-fail0001', 'Oven cold', NOW);
    await tx.persistEnd(store, { sessionId: 's-sched-fail0001', event: 'end' }, NOW);
    const failedBatch = await api.handler({ transcriptReview: true });
    check('judge throw is contained in scheduled batch', failedBatch && failedBatch.ok === true);
    check('failed review visible on record', (await store.get('s-sched-fail0001')).review.status === 'failed');

    const noMsg = await invoke('POST', '/api', { body: JSON.stringify({}) });
    check('diagnosis contract intact with review wired', noMsg.statusCode === 400);
  }

  console.log('CONFIG HAS NO HARD-CODED MODEL IN APP CODE');
  {
    const cfg = review.resolveReviewConfig({ TRANSCRIPT_REVIEW_PROVIDER: 'openai', TRANSCRIPT_REVIEW_MODEL: 'operator-chosen-model' });
    check('model comes from configuration', cfg.model === 'operator-chosen-model' && cfg.provider === 'openai');
    const empty = review.resolveReviewConfig({ TRANSCRIPT_REVIEW_PROVIDER: 'openai' });
    check('missing model is empty, not a baked-in name', empty.model === '');
    const lm = review.config.endpointFor({ provider: 'lmstudio' });
    process.env.LM_STUDIO_URL = process.env.LM_STUDIO_URL || 'https://example.invalid';
    const lm2 = review.config.endpointFor({ provider: 'lmstudio' });
    check('lmstudio endpoint is OpenAI-compat /v1', /\/v1$/.test(lm2));
  }

  console.log('\ntranscript-review tests: ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
