'use strict';

/** Transcript persistence for the customer path (anonymous, TTL-limited; failures never reach the customer). */
// Production transcript observability (anonymous, TTL-limited). Never on the
// customer-critical path: persist failures are logged and swallowed.
const transcripts = require('./transcripts');
const canonicalAudit = require('./canonical-audit');
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

async function persistTranscriptTurn(obs, messages, view, orch, rid, canonical) {
  if (!obs) return;
  await transcripts.persistSafely(transcriptStore(), () =>
    transcripts.persistTurn(transcriptStore(), obs, { messages, view, orch, requestId: rid, canonical: canonical || null }), log);
}
/** Idempotent duplicate answered from the cached view: mark the original transcript turn (nothing else changes). */
async function persistTranscriptReplay(obs) {
  if (!obs || !obs.clientTurnId) return;
  await transcripts.persistSafely(transcriptStore(), () => transcripts.persistReplay(transcriptStore(), obs), log);
}
/** canonical-audit/1 for the transcript (structured inputs only; never throws into the customer path). */
function canonicalTranscriptAudit(ctx, out, result, trace, error) {
  try { return canonicalAudit.buildCanonicalTranscriptAudit({ ctx, out, result, trace, error }); } catch (e) {
    log({ evt: 'canonical-audit-failed', error: String((e && e.message) || e).slice(0, 160) });
    return null;
  }
}
async function persistTranscriptEnd(obs) {
  if (!obs) return;
  await transcripts.persistSafely(transcriptStore(), () =>
    transcripts.persistEnd(transcriptStore(), obs), log);
}

module.exports = {
  transcriptStore, setTranscriptStore, persistTranscriptTurn, persistTranscriptReplay, canonicalTranscriptAudit,
  persistTranscriptEnd,
};
