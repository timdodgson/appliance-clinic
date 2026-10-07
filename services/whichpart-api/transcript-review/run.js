'use strict';

/**
 * Execute semantic review outside the customer diagnostic path.
 * Persistence of the original transcript never depends on this succeeding:
 * review writes are a separate put of the same item, and failures are stored
 * as review.status=failed without throwing to the caller unless requested.
 */

const schema = require('./schema');
const eligibility = require('./eligibility');
const { judgeRecord } = require('./judge');
const { resolveReviewConfig } = require('./config');
const { fromRecords } = require('./aggregates');

function nowIso(now) {
  return (now || new Date()).toISOString();
}

function markAttempt(rec, now, extras) {
  const prev = schema.compactReview(rec.review);
  rec.review = Object.assign(prev, {
    status: 'awaiting',
    lastAttemptAt: nowIso(now),
    attemptCount: (prev.attemptCount || 0) + 1,
    error: null,
  }, extras || {});
  return rec;
}

function markFailed(rec, now, error, extras) {
  const prev = schema.compactReview(rec.review);
  rec.review = Object.assign(prev, {
    status: 'failed',
    lastAttemptAt: nowIso(now),
    error: schema.clip(error || 'review-failed', 240),
    assessment: prev.assessment,
  }, extras || {});
  return rec;
}

function markReviewed(rec, now, parsed, extras) {
  const prev = schema.compactReview(rec.review);
  rec.review = Object.assign(prev, {
    status: 'reviewed',
    version: schema.REVIEW_VERSION,
    promptVersion: schema.REVIEW_PROMPT_VERSION,
    reviewedAt: nowIso(now),
    lastAttemptAt: nowIso(now),
    error: null,
    assessment: parsed.assessment,
  }, extras || {});
  return rec;
}

async function persistReviewOnly(store, rec) {
  // Do not refresh TTL or lastActivityAt — review metadata must die with the transcript.
  await store.put(rec);
  return rec;
}

async function reviewOne(opts) {
  const store = opts.store;
  const rec = opts.rec;
  const now = opts.now || new Date();
  const log = typeof opts.log === 'function' ? opts.log : function () {};
  const cfg = opts.config || resolveReviewConfig(opts.env);
  const extras = {
    model: cfg.model || null,
    provider: cfg.provider || null,
  };
  try {
    markAttempt(rec, now, extras);
    await persistReviewOnly(store, rec);
    if (!cfg.enabled) {
      markFailed(rec, now, 'review-disabled', extras);
      await persistReviewOnly(store, rec);
      return { ok: false, reason: 'review-disabled', sessionId: rec.sessionId };
    }
    const judged = await judgeRecord(rec, {
      now: now,
      config: cfg,
      callJudge: opts.callJudge,
      env: opts.env,
    });
    extras.model = (judged.config && judged.config.model) || extras.model;
    extras.provider = (judged.config && judged.config.provider) || extras.provider;
    extras.promptVersion = judged.promptVersion || schema.REVIEW_PROMPT_VERSION;
    if (!judged.parsed || !judged.parsed.ok) {
      markFailed(rec, now, (judged.parsed && judged.parsed.error) || 'malformed-judge-output', extras);
      await persistReviewOnly(store, rec);
      log({ evt: 'transcript-review-failed', sessionId: rec.sessionId, error: rec.review.error });
      return { ok: false, reason: rec.review.error, sessionId: rec.sessionId };
    }
    markReviewed(rec, now, judged.parsed, extras);
    await persistReviewOnly(store, rec);
    log({
      evt: 'transcript-review-ok',
      sessionId: rec.sessionId,
      version: schema.REVIEW_VERSION,
      overall: rec.review.assessment.overallAssessment,
      priority: rec.review.assessment.reviewPriority,
    });
    return { ok: true, sessionId: rec.sessionId, assessment: rec.review.assessment };
  } catch (e) {
    const msg = String((e && e.message) || e || 'review-failed');
    try {
      markFailed(rec, now, msg, extras);
      await persistReviewOnly(store, rec);
    } catch (persistErr) {
      log({
        evt: 'transcript-review-persist-failed',
        sessionId: rec.sessionId,
        error: String(persistErr && persistErr.message || persistErr),
      });
    }
    log({ evt: 'transcript-review-failed', sessionId: rec.sessionId, error: msg });
    return { ok: false, reason: msg, sessionId: rec.sessionId };
  }
}

async function reviewSession(opts) {
  const store = opts.store;
  const now = opts.now || new Date();
  const rec = await store.get(opts.sessionId);
  if (!rec) return { ok: false, reason: 'not-found', http: 404 };
  const decision = opts.manual
    ? eligibility.manualDecision(rec, now)
    : eligibility.autoDecision(rec, now, schema.REVIEW_VERSION);
  if (!decision.ok) {
    return { ok: false, reason: decision.reason, http: decision.http || 409, sessionId: rec.sessionId };
  }
  const result = await reviewOne({
    store: store,
    rec: rec,
    now: now,
    log: opts.log,
    callJudge: opts.callJudge,
    config: opts.config,
    env: opts.env,
  });
  return result;
}

async function runBatch(opts) {
  const store = opts.store;
  const now = opts.now || new Date();
  const log = typeof opts.log === 'function' ? opts.log : function () {};
  const cfg = opts.config || resolveReviewConfig(opts.env);
  if (!cfg.enabled) {
    log({ evt: 'transcript-review-skipped', reason: 'disabled' });
    return { ok: true, skipped: true, reason: 'disabled', attempted: 0 };
  }
  const limit = cfg.maxPerRun;
  let records = [];
  if (typeof store.listRecentRecords === 'function') {
    records = await store.listRecentRecords(Math.max(40, limit * 12), now);
  }
  const picked = [];
  for (const rec of records) {
    const d = eligibility.autoDecision(rec, now, schema.REVIEW_VERSION);
    if (d.ok) picked.push(rec);
    if (picked.length >= limit) break;
  }
  const results = [];
  for (const rec of picked) {
    results.push(await reviewOne({
      store: store,
      rec: rec,
      now: now,
      log: log,
      callJudge: opts.callJudge,
      config: cfg,
      env: opts.env,
    }));
  }
  return {
    ok: true,
    attempted: results.length,
    reviewed: results.filter((r) => r.ok).length,
    failed: results.filter((r) => !r.ok).length,
    results: results,
  };
}

async function qualityFromStore(store, now) {
  const t = now || new Date();
  let records = [];
  if (typeof store.listRecentRecords === 'function') {
    records = await store.listRecentRecords(200, t);
  }
  return fromRecords(records, t);
}

module.exports = {
  reviewOne,
  reviewSession,
  runBatch,
  qualityFromStore,
  markAttempt,
  markFailed,
  markReviewed,
};
