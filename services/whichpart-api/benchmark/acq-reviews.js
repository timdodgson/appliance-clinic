'use strict';
/**
 * Engineer transcript reviews — HUMAN annotation of a single conversation
 * result (one journey inside one run).
 *
 * This is deliberately SEPARATE from:
 *   - the benchmark score (acq/runs/<runId>.json — never touched here), and
 *   - the scenario gold (acq/library.json — never touched here).
 * A review is human opinion about a conversation; it must not be able to change
 * the machine result or the scenario's expected data.
 *
 * Storage: one small S3 doc per (run, journey) at
 *   acq/reviews/<runId>__<journeyId>.json
 * under the SAME acq/ prefix the run store uses, so the existing Lambda IAM
 * policy (Get/Put on acq/*, List prefix acq/*) already covers it — no infra change.
 *
 * FUTURE-RAG PROVENANCE: every review retains the links
 *   transcript -> run (runId) -> scenario (scenarioId + journeyVersion) -> review
 * so a later task can query e.g. "reviewed NEEDS_IMPROVEMENT washing-machine
 * conversations" by listing this prefix. This module does NOT implement any RAG
 * behaviour — it only stores the annotation.
 */

const REVIEW_PREFIX = 'acq/reviews/';
// The three HUMAN review states. Kept intentionally distinct from the MACHINE
// verdict (GOOD / NEEDS REVIEW / FAILED) — a human may disagree with the machine.
const REVIEW_STATES = ['not_reviewed', 'looks_good', 'needs_improvement'];
const MAX_NOTE_LEN = 4000;

/** Deterministic S3 key. runId + journeyId are url-encoded so any punctuation is safe. */
function reviewKey(runId, journeyId) {
  return `${REVIEW_PREFIX}${encodeURIComponent(String(runId))}__${encodeURIComponent(String(journeyId))}.json`;
}

function isValidState(state) { return REVIEW_STATES.indexOf(state) !== -1; }

/**
 * @param {object} deps
 *  - s3: { getObject(key), putObject(key,body), list(prefix) }  (injected; unit-testable)
 *  - now?: ()=>number
 */
function createReviewStore(deps) {
  const s3 = deps.s3;
  const now = deps.now || (() => Date.now());

  async function getReview(runId, journeyId) {
    if (!runId || !journeyId) return null;
    const raw = await s3.getObject(reviewKey(runId, journeyId));
    if (!raw) return null;
    try { return JSON.parse(raw); } catch { return null; }
  }

  /**
   * Persist a review. Validates the state (rejects anything outside REVIEW_STATES).
   * Only writes to acq/reviews/ — never to the run or the library. Returns the
   * stored record. `note` is trimmed to a sane maximum.
   */
  async function putReview(input) {
    const state = input && input.state;
    if (!isValidState(state)) { const e = new Error('invalid review state: ' + state); e.code = 'BAD_STATE'; throw e; }
    const runId = input.runId; const journeyId = input.journeyId;
    if (!runId || !journeyId) { const e = new Error('runId and journeyId required'); e.code = 'BAD_KEY'; throw e; }
    const rec = {
      runId,
      journeyId,
      // Provenance links retained for future RAG evidence queries.
      scenarioId: input.scenarioId || journeyId,
      journeyVersion: (input.journeyVersion === undefined ? null : input.journeyVersion),
      family: input.family || null,
      state,
      note: typeof input.note === 'string' ? input.note.slice(0, MAX_NOTE_LEN) : '',
      reviewedAt: new Date(now()).toISOString(),
      reviewer: input.reviewer || null,
    };
    await s3.putObject(reviewKey(runId, journeyId), JSON.stringify(rec));
    return rec;
  }

  /** All reviews (for filtering / future evidence queries). Optional predicate filter. */
  async function listReviews(filter) {
    const keys = await s3.list(REVIEW_PREFIX);
    const out = [];
    for (const k of keys) {
      const raw = await s3.getObject(k);
      if (!raw) continue;
      let rec; try { rec = JSON.parse(raw); } catch { continue; }
      if (filter && !filter(rec)) continue;
      out.push(rec);
    }
    return out;
  }

  /** Map of journeyId -> review for a specific run (used to badge result rows). */
  async function reviewsForRun(runId) {
    const all = await listReviews((r) => r.runId === runId);
    const map = {};
    for (const r of all) map[r.journeyId] = r;
    return map;
  }

  return { REVIEW_STATES, REVIEW_PREFIX, reviewKey, isValidState, getReview, putReview, listReviews, reviewsForRun };
}

module.exports = { createReviewStore, REVIEW_STATES, REVIEW_PREFIX, reviewKey, isValidState };
