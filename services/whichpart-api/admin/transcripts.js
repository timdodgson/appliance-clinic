'use strict';

/** Transcripts: the scheduled review batch, and the admin viewer, statistics, policy, quality and review routes. */
const transcripts = require('../transcripts');
const transcriptReview = require('../transcript-review');
const { log } = require('../log.js');
const { queryParam, respond } = require('../http-io.js');
const { requireAdmin } = require('../session.js');
const { transcriptStore } = require('../transcript-store.js');

let _transcriptReviewJudge = null;

function setTranscriptReviewJudge(fn) { _transcriptReviewJudge = fn; }

async function runTranscriptReviewBatch(now) {
  return transcriptReview.runBatch({
    store: transcriptStore(),
    now: now || new Date(),
    log: log,
    callJudge: _transcriptReviewJudge || undefined,
  });
}

async function adminTranscriptList(event) {
  if (!(await requireAdmin(event))) return respond(401, { error: 'Unauthorized' });
  const qs = (event && event.queryStringParameters) || {};
  try {
    const page = await transcriptStore().list(qs, new Date());
    return respond(200, page);
  } catch (e) {
    log({ evt: 'transcript-list-failed', error: String(e && e.message || e) });
    return respond(503, { error: 'Transcript store unavailable' });
  }
}

async function adminTranscriptGet(event) {
  if (!(await requireAdmin(event))) return respond(401, { error: 'Unauthorized' });
  const id = queryParam(event, 'id');
  if (!transcripts.isValidSessionId(id || '')) return respond(400, { error: 'id required' });
  try {
    const rec = await transcriptStore().get(id);
    if (!rec) return respond(404, { error: 'not found' });
    return respond(200, transcripts.drillDown(rec, new Date()));
  } catch (e) {
    log({ evt: 'transcript-get-failed', error: String(e && e.message || e) });
    return respond(503, { error: 'Transcript store unavailable' });
  }
}

async function adminTranscriptStats(event) {
  if (!(await requireAdmin(event))) return respond(401, { error: 'Unauthorized' });
  try {
    const stats = await transcriptStore().stats(new Date());
    return respond(200, { ...stats, policy: transcripts.policy() });
  } catch (e) {
    log({ evt: 'transcript-stats-failed', error: String(e && e.message || e) });
    return respond(503, { error: 'Transcript store unavailable' });
  }
}

async function adminTranscriptPolicy(event) {
  if (!(await requireAdmin(event))) return respond(401, { error: 'Unauthorized' });
  return respond(200, transcripts.policy());
}

async function adminTranscriptReview(event) {
  if (!(await requireAdmin(event))) return respond(401, { error: 'Unauthorized' });
  const method =
    (event.requestContext && event.requestContext.http && event.requestContext.http.method) ||
    event.httpMethod || 'GET';
  if (method !== 'POST') return respond(405, { error: 'POST only' });
  const id = queryParam(event, 'id');
  if (!transcripts.isValidSessionId(id || '')) return respond(400, { error: 'id required' });
  try {
    const result = await transcriptReview.reviewSession({
      store: transcriptStore(),
      sessionId: id,
      now: new Date(),
      manual: true,
      log: log,
      callJudge: _transcriptReviewJudge || undefined,
    });
    if (result.http) return respond(result.http, { error: result.reason, ok: false });
    const rec = await transcriptStore().get(id);
    if (!rec) return respond(404, { error: 'not found' });
    return respond(200, Object.assign(transcripts.drillDown(rec, new Date()), { reviewResult: result }));
  } catch (e) {
    log({ evt: 'transcript-review-manual-failed', error: String(e && e.message || e) });
    return respond(503, { error: 'Semantic review unavailable' });
  }
}

async function adminTranscriptQuality(event) {
  if (!(await requireAdmin(event))) return respond(401, { error: 'Unauthorized' });
  try {
    const quality = await transcriptReview.qualityFromStore(transcriptStore(), new Date());
    return respond(200, quality);
  } catch (e) {
    log({ evt: 'transcript-quality-failed', error: String(e && e.message || e) });
    return respond(503, { error: 'Transcript store unavailable' });
  }
}

module.exports = {
  setTranscriptReviewJudge, runTranscriptReviewBatch, adminTranscriptList, adminTranscriptGet,
  adminTranscriptStats, adminTranscriptPolicy, adminTranscriptReview, adminTranscriptQuality,
};
