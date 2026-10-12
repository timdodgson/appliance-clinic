'use strict';

/** Transcript persistence for the customer path (anonymous, TTL-limited; failures never reach the customer). */
// Production transcript observability (anonymous, TTL-limited). Never on the
// customer-critical path: persist failures are logged and swallowed.
const transcripts = require('./transcripts');
const { log } = require('./log.js');

let _transcriptStore = null;

function transcriptStore() {
  if (_transcriptStore) return _transcriptStore;
  try {
    _transcriptStore = transcripts.createDynamoStore();
  } catch (e) {
    log({ evt: 'transcript-store-init-failed', error: String(e && e.message || e) });
    _transcriptStore = transcripts.createMemoryStore();
  }
  return _transcriptStore;
}
function setTranscriptStore(store) { _transcriptStore = store; }

/** `ac2` is the turn's ac2-transcript-audit/1 object. */
async function persistTranscriptTurn(obs, messages, view, orch, rid, ac2) {
  if (!obs) return;
  await transcripts.persistSafely(transcriptStore(), () =>
    transcripts.persistTurn(transcriptStore(), obs, { messages, view, orch, requestId: rid, ac2: ac2 || null }), log);
}
async function persistTranscriptEnd(obs) {
  if (!obs) return;
  await transcripts.persistSafely(transcriptStore(), () =>
    transcripts.persistEnd(transcriptStore(), obs), log);
}

module.exports = {
  transcriptStore, setTranscriptStore, persistTranscriptTurn, persistTranscriptEnd,
};
