'use strict';

/**
 * Deterministic eligibility / retry / idempotency for semantic review.
 * Does not inspect conversation meaning.
 */

const { REVIEW_VERSION } = require('./schema');

const MAX_ATTEMPTS = 5;
const RETRY_AFTER_MS = 15 * 60 * 1000;
const IN_PROGRESS_MS = 10 * 60 * 1000;
const MANUAL_COOLDOWN_MS = 30 * 1000;

function lifecycleOf(rec, now) {
  const tx = require('../transcripts');
  return tx.deriveLifecycle(rec, now);
}

function isReviewable(rec, now) {
  if (!rec) return false;
  const life = lifecycleOf(rec, now);
  if (life !== 'ended' && life !== 'inactive') return false;
  return (rec.turnCount || 0) >= 1;
}

function displayReviewStatus(rec, now) {
  const st = (rec && rec.review && rec.review.status) || 'none';
  if (st === 'reviewed' || st === 'failed') return st;
  if (isReviewable(rec, now)) return 'awaiting';
  return 'none';
}

function ageMs(iso, now) {
  if (!iso) return Infinity;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return Infinity;
  return (now || new Date()).getTime() - t;
}

function autoDecision(rec, now, version) {
  const ver = version || REVIEW_VERSION;
  if (!isReviewable(rec, now)) return { ok: false, reason: 'not-eligible' };
  const r = (rec && rec.review) || {};
  const status = r.status || 'none';
  if (status === 'reviewed' && r.version === ver) return { ok: false, reason: 'already-reviewed' };
  if (status === 'reviewed' && r.version !== ver) {
    return { ok: false, reason: 'version-bump-needs-manual' };
  }
  if (status === 'awaiting') {
    if (ageMs(r.lastAttemptAt, now) < IN_PROGRESS_MS) return { ok: false, reason: 'in-progress' };
    if ((r.attemptCount || 0) >= MAX_ATTEMPTS) return { ok: false, reason: 'max-attempts' };
    return { ok: true, reason: 'stuck-awaiting' };
  }
  if (status === 'failed') {
    if ((r.attemptCount || 0) >= MAX_ATTEMPTS) return { ok: false, reason: 'max-attempts' };
    if (ageMs(r.lastAttemptAt, now) < RETRY_AFTER_MS) return { ok: false, reason: 'backoff' };
    return { ok: true, reason: 'retry-after-failure' };
  }
  return { ok: true, reason: 'never-reviewed' };
}

function manualDecision(rec, now) {
  if (!isReviewable(rec, now)) return { ok: false, reason: 'not-eligible', http: 409 };
  const r = (rec && rec.review) || {};
  if (ageMs(r.lastAttemptAt, now) < MANUAL_COOLDOWN_MS) {
    return { ok: false, reason: 'cooldown', http: 429 };
  }
  return { ok: true, reason: 'manual' };
}

module.exports = {
  MAX_ATTEMPTS,
  RETRY_AFTER_MS,
  IN_PROGRESS_MS,
  MANUAL_COOLDOWN_MS,
  isReviewable,
  displayReviewStatus,
  autoDecision,
  manualDecision,
  lifecycleOf,
};
