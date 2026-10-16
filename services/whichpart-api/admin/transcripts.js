'use strict';

/** Transcripts: the admin viewer, statistics and policy routes. */
const transcripts = require('../transcripts');
const { log } = require('../log.js');
const { queryParam, respond } = require('../http-io.js');
const { requireAdmin } = require('../session.js');
const { transcriptStore } = require('../transcript-store.js');

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

module.exports = { adminTranscriptList, adminTranscriptGet, adminTranscriptStats, adminTranscriptPolicy };
