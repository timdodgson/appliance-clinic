'use strict';

/**
 * Which Part API — anti-corruption / boundary layer.
 *
 * The Which Part UI depends solely on the retailer-neutral contract produced here
 * (Diagnosis / CandidateComponent / CanonicalPart / Offer[]). This boundary now calls the
 * Customer Diagnostic Orchestrator (ONE diagnostic API) instead of the RAG engine directly.
 * The orchestrator internally fans out to the Error-Code MCP and the Diagnostic RAG; the browser
 * never chooses between them and never sees downstream credentials.
 *
 *   Browser -> /api (this Lambda) -> Orchestrator /diagnose (bearer) -> MCP / RAG
 *
 * FIT INVARIANT preserved: a part is MODEL_CONFIRMED only when the customer's model was actually
 * resolved AND the part is model-specific (not brand-only) — otherwise VERIFY_FIT.
 * Downstream bearer tokens come from env only (never committed/logged/returned to the client).
 */

const settingsAdmin = require('./settings-admin.js');
const transcripts = require('./transcripts');
const conversationState = require('./conversation-state');
const liveTest = require('./live-test.js');
const benchmarkAuth = require('./benchmark-auth.js');
const stateTokenMod = require('./state-token');
const transcriptReview = require('./transcript-review');
const recallStoreMod = require('./recalls/store');
const recallIngest = require('./recalls/ingest');
const mediaAdmin = require('./media-admin');
const knowledgeAdmin = require('./knowledge-admin');
const diagnosticsInspect = require('./diagnostics-inspect');
const errorCodesAdmin = require('./error-codes-admin');
const httpHeaders = require('./http-headers.js');
const {
  ORCHESTRATOR_URL, ORCHESTRATOR_TOKEN, ENGINE_URL, S4R_PRODUCT_BASE_URL, CLIENT_ID, ORCH_TIMEOUT_MS,
  MAX_MESSAGES,
} = require('./config.js');
const { log } = require('./log.js');
const { fetchWithThrottleRetry } = require('./orchestrator-retry.js');
const { queryParam, authPath, CORS, respond } = require('./http-io.js');
const { setRateLimitStoreForTests, rateLimited } = require('./rate-limiting.js');
const { authLogin, authMe, authLogout, setSessionForTests, requireAdmin } = require('./session.js');
const { setAcqS3ForTests } = require('./s3.js');
const { routingOverride, recoverRoutingOverride } = require('./benchmark-state.js');
const {
  setTranscriptStore, persistTranscriptTurn, persistTranscriptReplay, canonicalTranscriptAudit,
  persistTranscriptEnd,
} = require('./transcript-store.js');
const {
  setMediaAdminStore, loadOverlayCached, knowledgeStore, setKnowledgeAdminStore, adminKnowledge,
  adminKnowledgeRecord, knowledgeMutation, needId, adminKnowledgeDraft, adminKnowledgeVersions, adminMedia,
  adminMediaRecord, adminMediaCreate, adminMediaPatch, adminMediaReplace, adminMediaAction, adminMediaVersion,
  adminMediaMap, adminMediaComponent, adminMediaRetire, adminMediaRestore, adminMediaDelete, adminMediaPreview,
  adminMediaKnowledge,
} = require('./admin/content.js');
const { recallStore, setRecallStore, recallHandlers, recallAdmin, recallAdminRoute } = require('./admin/recalls.js');
const {
  setTranscriptReviewJudge, runTranscriptReviewBatch, adminTranscriptList, adminTranscriptGet,
  adminTranscriptStats, adminTranscriptPolicy, adminTranscriptReview, adminTranscriptQuality,
} = require('./admin/transcripts.js');
const { adminHealth, adminDashboard } = require('./admin/health.js');
const {
  setErrorCodesClientForTests, adminErrorCodes, adminErrorCodeRecord, adminErrorCodeAction, adminErrorCodeRetire,
  adminErrorCodeRestore, adminErrorCodeVersion, adminErrorCodePreview,
} = require('./admin/error-codes.js');
const { setDiagnosticsDepsForTests, adminDiagnostics } = require('./admin/diagnostics.js');
const {
  testAdminRoute, routingOverrideResolve, routingOverrideRecover, libraryImport, libraryList, libraryJourneyGet,
  libraryCreate, libraryEdit, libraryDuplicate, libraryFlags, libraryDelete, benchmarkBuildRun, benchmarkRerun,
  benchmarkEstimate, acqBenchmarkConfig, acqBenchmarkRun, acqBenchmarkRuns, acqBenchmarkRunGet,
  acqBenchmarkCancel, acqTranscriptGet, acqScenarioConversations, acqReviewsForRun, acqReviewGet, acqReviewSave,
  acqBenchmarkCompare,
} = require('./admin/test-area.js');
const {
  setSettingsDepsForTests, settingsAdminRoute, aiConfigGet, aiConfigSaveKey, aiConfigTestLocal,
  aiConfigTestFrontier, aiConfigLocalModels, aiConfigFrontierModels, adminSettingsGet,
  adminSettingsInferencePatch, adminSettingsJevPatch, adminSettingsJevTest,
} = require('./admin/settings.js');

let _benchmarkSecretsLoader = () => benchmarkAuth.loadSecrets();
function setBenchmarkDepsForTests({ secretsLoader } = {}) { _benchmarkSecretsLoader = secretsLoader || (() => benchmarkAuth.loadSecrets()); }

// ---- conversation transport (Story 3: STRUCTURAL only; Jev in the orchestrator owns meaning) --
function textOf(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.filter((p) => p && p.type === 'text' && p.text).map((p) => p.text).join(' ');
  }
  return '';
}
function hasImage(content) {
  return Array.isArray(content) && content.some((p) => p && p.type === 'image_url');
}
function imageOf(content) {
  if (!Array.isArray(content)) return null;
  const p = content.find((x) => x && x.type === 'image_url' && x.image_url && x.image_url.url);
  return p ? p.image_url.url : null;
}
function deriveContext(messages) {
  // Story 3: STRUCTURAL transport only. The BFF assembles the conversation and forwards it; it does
  // NOT interpret customer meaning. Appliance family, symptom presence, model-vs-error-code and
  // answer/confirmation semantics are the orchestrator's single Jev UNDERSTAND (run before routing).
  const userTexts = messages.filter((m) => m && m.role === 'user').map((m) => textOf(m.content));
  const assistantTexts = messages.filter((m) => m && m.role === 'assistant').map((m) => textOf(m.content));
  // current-turn message = latest user text (or empty if only a photo was sent)
  const lastUser = [...messages].reverse().find((m) => m && m.role === 'user');
  const message = lastUser ? textOf(lastUser.content) : '';
  const photoOnly = Boolean(lastUser && hasImage(lastUser.content) && !message.trim());
  // Latest-turn rating-plate image; carried forward (structural) if this turn has none, so the
  // RAG vision can still read a plate the customer sent on an earlier turn.
  let latestImage = lastUser ? imageOf(lastUser.content) : null;
  if (!latestImage) {
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m && m.role === 'user' && hasImage(m.content)) { latestImage = imageOf(m.content); break; }
    }
  }
  // STABLE per-conversation session key. The orchestrator holds deterministic ConversationState
  // keyed by this id and must be able to find it again on the NEXT turn, so the key has to be
  // stable across a conversation's turns (established facts persist) yet distinct per conversation
  // (state never bleeds between customers). The volatile per-request id used before (Date.now +
  // random, plus a hash of ALL user turns that itself changed as the thread grew) guaranteed a
  // store miss every turn, so the whole persistence/reconciliation layer never engaged. The caller
  // threads in the client's stable per-conversation id (observability.sessionId) when present; this
  // fallback — a deterministic fingerprint of the OPENING customer turn — covers clients that send
  // none (it is the only signal present from turn 1 and unchanged as the thread grows). Fallback
  // collisions are limited to warm-container lifetime AND an identical opening message with no
  // client session id; the production client always carries one, so this is an edge case.
  const openerKey = (userTexts.find((t) => (t || '').trim()) || '').trim();
  const sessionId = 'wp-' + hashStr(openerKey);
  // CLIENT-CARRIED CONTEXT: send the WHOLE accumulated conversation each turn so the single Jev
  // UNDERSTAND sees the full thread (retention/correction) with a stateless-per-request session.
  let conversationText = userTexts.map((t) => (t || '').trim()).filter(Boolean).join('. ');
  // When assistant turns are present, send a labelled transcript so a later "I don't know" is bound
  // to the question that was asked (structural transcript formatting; routing.customer_speech
  // strips advisor lines so they never become customer facts).
  if (assistantTexts.length) {
    const labelled = [];
    for (const m of messages) {
      if (!m) continue;
      const t = (textOf(m.content) || '').trim();
      if (!t) continue;
      if (m.role === 'user') labelled.push('Customer: ' + t.slice(0, 1200));
      else if (m.role === 'assistant') labelled.push('Advisor asked: ' + t.slice(0, 500));
    }
    if (labelled.length >= 2) conversationText = labelled.join('\n');
  }
  const turnIndex = Math.max(0, userTexts.length - 1);
  const latestMessage = message || '';
  return { message, conversationText, sessionId, photoOnly, latestImage, turnIndex, latestMessage };
}

function conversationWindow(list, cap) {
  const limit = cap || MAX_MESSAGES;
  const hist = Array.isArray(list) ? list : [];
  if (!hist.length) return [];
  let firstUser = -1;
  for (let i = 0; i < hist.length; i++) {
    if (hist[i] && hist[i].role === 'user') { firstUser = i; break; }
  }
  if (firstUser < 0) return [];
  let start = Math.max(0, hist.length - limit);
  if (start < firstUser) start = firstUser;
  if (hist[start] && hist[start].role !== 'user') {
    const opening = hist[firstUser];
    const tail = hist.slice(-(limit - 1)).filter((m) => m !== opening);
    return [opening, ...tail];
  }
  return hist.slice(start);
}

function sanitiseConversation(messages) {
  const out = [];
  for (const m of messages || []) {
    if (!m || (m.role !== 'user' && m.role !== 'assistant')) continue;
    const t = (textOf(m.content) || '').trim();
    if (!t) continue;
    const rec = {
      role: m.role,
      content: t.slice(0, m.role === 'assistant' ? 900 : 2000),
    };
    if (m.role === 'assistant' && Array.isArray(m.media) && m.media.length) {
      rec.media = m.media.slice(0, 4).map((item) => ({
        id: item && item.id ? String(item.id).slice(0, 80) : null,
        type: item && item.type ? String(item.type).slice(0, 20) : null,
        title: item && item.title ? String(item.title).slice(0, 160) : '',
        url: item && item.url ? String(item.url).slice(0, 400) : null,
        videoId: item && item.videoId ? String(item.videoId).slice(0, 40) : null,
      }));
    }
    if (m.role === 'assistant' && m.safetyInformation) {
      const shown = m.safetyInformation;
      const text = typeof shown === 'string' ? shown : shown.text;
      if (text) rec.safetyInformation = { text: String(text).slice(0, 900) };
    }
    out.push(rec);
  }
  return conversationWindow(out, MAX_MESSAGES);
}

function hashStr(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) { h = (h * 31 + s.charCodeAt(i)) | 0; }
  return (h >>> 0).toString(36);
}

// ---- handler -----------------------------------------------------------------
// Admin API request log: one concise line per /admin/* request — method, path (no query string),
// auth category (admin | unauthenticated | forbidden | not-checked), status, request id. Never logs
// cookies, tokens, Authorization headers, query values or bodies.
function adminRequestLog(event, res, t0) {
  try {
    const path = String(authPath(event) || '');
    if (path.indexOf('/admin/') === -1 && !/\/admin$/.test(path)) return;
    log({
      evt: 'admin-api',
      method: (event.requestContext && event.requestContext.http && event.requestContext.http.method) || event.httpMethod || null,
      path: path.split('?')[0].slice(0, 120),
      auth: event._authCategory || 'not-checked',
      status: res && res.statusCode,
      rid: (event.requestContext && event.requestContext.requestId) || null,
      ms: Date.now() - t0,
    });
  } catch { /* logging must never affect the response */ }
}
exports.handler = async (event) => {
  const t0 = Date.now();
  // Phase 7: CORS only for the AC origins, and security headers, on every HTTP response (http-headers.js).
  const res = httpHeaders.finalizeResponse(event, await handleEvent(event));
  if (event && typeof event === 'object' && !event.transcriptReview && !event.recallIngest && event.source !== 'aws.events') adminRequestLog(event, res, t0);
  return res;
};
async function handleEvent(event) {
  if (event && event.transcriptReview) {
    // Every 15 minutes (whichpart-transcript-review schedule): restore a batch routing override whose
    // worker vanished (stale lease) or whose run already ended. A healthy owner is never touched.
    try {
      const rec = await recoverRoutingOverride('system:api-recovery');
      if (rec.action !== 'none') log({ evt: 'batch-routing-recovery', action: rec.action, why: rec.why || null, runId: rec.result && rec.result.lock ? rec.result.lock.runId : (rec.lock ? rec.lock.runId : null) });
    } catch (e) {
      log({ evt: 'batch-routing-recovery', action: 'error', error: String((e && e.name) || 'Error') });
    }
    try {
      const result = await runTranscriptReviewBatch(new Date());
      log({ evt: 'transcript-review-scheduled', attempted: result.attempted, reviewed: result.reviewed, failed: result.failed, skipped: result.skipped || false });
      return result;
    } catch (e) {
      log({ evt: 'transcript-review-scheduled-failed', error: String(e && e.message || e) });
      return { ok: false, error: String(e && e.message || e) };
    }
  }
  if (event && (event.source === 'aws.events' || event.recallIngest)) {
    const mode = event.recallIngest === 'backfill' ? 'backfill'
      : event.recallIngest === 'publish' ? 'publish' : 'daily';
    try {
      const result = await recallIngest.run({ store: recallStore(), mode, trigger: 'scheduled' });
      log({ evt: 'recall-ingest-scheduled', mode, ok: result.ok, counts: result.counts });
      return result;
    } catch (e) {
      log({ evt: 'recall-ingest-scheduled-failed', error: String(e && e.message || e) });
      throw e;
    }
  }
  const rid =
    (event.requestContext && event.requestContext.requestId) ||
    Math.random().toString(36).slice(2);
  const method =
    (event.requestContext && event.requestContext.http && event.requestContext.http.method) ||
    event.httpMethod || 'POST';

  if (method === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };

  // ---- auth + admin routes (BFF; diagnosis path below is unchanged) ----------
  const path = authPath(event);
  if (path.endsWith('/auth/login')) {
    return method === 'POST' ? authLogin(event) : respond(405, { error: 'POST only' });
  }
  if (path.endsWith('/auth/logout')) return authLogout(event);
  if (path.endsWith('/auth/me')) return authMe(event);
  if (path.endsWith('/admin/health')) return adminHealth(event);
  if (path.endsWith('/admin/dashboard')) return adminDashboard(event);
  // Settings + AI provider config (admin). Every route: unsupported method → 405, then admin auth →
  // 401, then a body cap, then the handler (clean JSON 500 on an unexpected failure). Sub-paths first.
  if (path.endsWith('/admin/settings/jev/test')) return settingsAdminRoute(event, method, { POST: adminSettingsJevTest });
  if (path.endsWith('/admin/settings/jev')) return settingsAdminRoute(event, method, { PATCH: adminSettingsJevPatch });
  if (path.endsWith('/admin/settings/diagnostic-inference')) return settingsAdminRoute(event, method, { PATCH: adminSettingsInferencePatch });
  if (path.endsWith('/admin/settings')) return settingsAdminRoute(event, method, { GET: adminSettingsGet });
  if (path.endsWith('/admin/ai-config/key')) return settingsAdminRoute(event, method, { POST: aiConfigSaveKey });
  if (path.endsWith('/admin/ai-config/test-local')) return settingsAdminRoute(event, method, { POST: aiConfigTestLocal });
  if (path.endsWith('/admin/ai-config/test-frontier')) return settingsAdminRoute(event, method, { POST: aiConfigTestFrontier });
  if (path.endsWith('/admin/ai-config/local-models')) return settingsAdminRoute(event, method, { GET: aiConfigLocalModels });
  if (path.endsWith('/admin/ai-config/frontier-models')) return settingsAdminRoute(event, method, { GET: aiConfigFrontierModels });
  // Read-only legacy view. The old unversioned whole-document POST writer is retired: live routing
  // changes go through PATCH /admin/settings/diagnostic-inference (revision check, reason, audit).
  if (path.endsWith('/admin/ai-config')) return settingsAdminRoute(event, method, { GET: aiConfigGet });
  // Question Library (admin). Sub-paths before base.
  // Test area: Question Library (scenarios) + batch runner. Every route goes through testAdminRoute:
  // unsupported method → 405, then admin auth → 401, then the handler. Sub-paths before base.
  if (path.endsWith('/admin/library/journey/edit')) return testAdminRoute(event, method, { POST: libraryEdit });
  if (path.endsWith('/admin/library/journey/duplicate')) return testAdminRoute(event, method, { POST: libraryDuplicate });
  if (path.endsWith('/admin/library/journey/flags')) return testAdminRoute(event, method, { POST: libraryFlags });
  if (path.endsWith('/admin/library/journey/delete')) return testAdminRoute(event, method, { POST: libraryDelete });
  if (path.endsWith('/admin/library/journey')) return testAdminRoute(event, method, { GET: libraryJourneyGet, POST: libraryCreate });
  if (path.endsWith('/admin/library/import')) return testAdminRoute(event, method, { POST: libraryImport });
  if (path.endsWith('/admin/library')) return testAdminRoute(event, method, { GET: libraryList });
  // Run builder
  if (path.endsWith('/admin/benchmark/build-run')) return testAdminRoute(event, method, { POST: benchmarkBuildRun });
  if (path.endsWith('/admin/benchmark/rerun')) return testAdminRoute(event, method, { POST: benchmarkRerun });
  if (path.endsWith('/admin/benchmark/estimate')) return testAdminRoute(event, method, { POST: benchmarkEstimate });
  // ACQ-100 quality benchmark (admin control plane). Sub-paths before base.
  if (path.endsWith('/admin/benchmark/routing-override/resolve')) return testAdminRoute(event, method, { POST: routingOverrideResolve });
  if (path.endsWith('/admin/benchmark/routing-override/recover')) return testAdminRoute(event, method, { POST: routingOverrideRecover });
  if (path.endsWith('/admin/benchmark/run/cancel')) return testAdminRoute(event, method, { POST: acqBenchmarkCancel });
  // Conversation transcript viewer + engineer review (sub-paths before base run).
  if (path.endsWith('/admin/benchmark/transcript')) return testAdminRoute(event, method, { GET: acqTranscriptGet });
  if (path.endsWith('/admin/benchmark/scenario-conversations')) return testAdminRoute(event, method, { GET: acqScenarioConversations });
  if (path.endsWith('/admin/benchmark/reviews')) return testAdminRoute(event, method, { GET: acqReviewsForRun });
  if (path.endsWith('/admin/benchmark/review')) return testAdminRoute(event, method, { GET: acqReviewGet, POST: acqReviewSave });
  if (path.endsWith('/admin/benchmark/run')) return testAdminRoute(event, method, { GET: acqBenchmarkRunGet, POST: acqBenchmarkRun });
  if (path.endsWith('/admin/benchmark/runs')) return testAdminRoute(event, method, { GET: acqBenchmarkRuns });
  if (path.endsWith('/admin/benchmark/compare')) return testAdminRoute(event, method, { GET: acqBenchmarkCompare });
  if (path.endsWith('/admin/benchmark/config')) return testAdminRoute(event, method, { GET: acqBenchmarkConfig });
  if (path.endsWith('/admin/transcripts/stats')) return adminTranscriptStats(event);
  if (path.endsWith('/admin/transcripts/policy')) return adminTranscriptPolicy(event);
  if (path.endsWith('/admin/transcripts/quality')) return adminTranscriptQuality(event);
  if (path.endsWith('/admin/transcripts/session/review')) return adminTranscriptReview(event);
  if (path.endsWith('/admin/transcripts/session')) return adminTranscriptGet(event);
  if (path.endsWith('/admin/transcripts')) return adminTranscriptList(event);
  if (path.endsWith('/admin/knowledge/record')) {
    if (method !== 'GET') return respond(405, { error: 'GET only' });
    return adminKnowledgeRecord(event);
  }
  if (path.endsWith('/admin/knowledge/draft')) return adminKnowledgeDraft(event, method);
  if (path.endsWith('/admin/knowledge/validate')) {
    // Read-only: runs publish validation over unsaved editor content. No writes.
    if (method !== 'POST') return respond(405, { error: 'POST only' });
    return knowledgeMutation(event, ({ body, id }) => knowledgeStore().checkDraft(body.content, id));
  }
  if (path.endsWith('/admin/knowledge/versions')) {
    if (method !== 'GET') return respond(405, { error: 'GET only' });
    return adminKnowledgeVersions(event);
  }
  if (path.endsWith('/admin/knowledge/publish')) {
    if (method !== 'POST') return respond(405, { error: 'POST only' });
    return knowledgeMutation(event, ({ actor, body, id }) => knowledgeStore().publish(needId(id), body.expectedRevision, body.note, actor));
  }
  if (path.endsWith('/admin/knowledge/rollback')) {
    if (method !== 'POST') return respond(405, { error: 'POST only' });
    return knowledgeMutation(event, ({ actor, body, id }) => knowledgeStore().rollback(needId(id), body.expectedRevision, body.toVersion, body.note, actor));
  }
  if (path.endsWith('/admin/knowledge/archive')) {
    if (method !== 'POST') return respond(405, { error: 'POST only' });
    return knowledgeMutation(event, ({ actor, body, id }) => knowledgeStore().archive(needId(id), body.expectedRevision, actor));
  }
  if (path.endsWith('/admin/knowledge/restore')) {
    if (method !== 'POST') return respond(405, { error: 'POST only' });
    return knowledgeMutation(event, ({ actor, body, id }) => knowledgeStore().restore(needId(id), body.expectedRevision, actor));
  }
  if (path.endsWith('/admin/knowledge')) {
    if (method !== 'GET') return respond(405, { error: 'GET only' });
    return adminKnowledge(event);
  }
  if (path.endsWith('/admin/media/knowledge')) {
    if (method !== 'GET') return respond(405, { error: 'GET only' });
    return adminMediaKnowledge(event);
  }
  if (path.endsWith('/admin/media/preview')) {
    if (method !== 'GET' && method !== 'POST') return respond(405, { error: 'GET or POST' });
    return adminMediaPreview(event, method);
  }
  if (path.endsWith('/admin/media/record/publish')) {
    if (method !== 'POST') return respond(405, { error: 'POST only' });
    return adminMediaAction(event, 'publish');
  }
  if (path.endsWith('/admin/media/record/rollback')) {
    if (method !== 'POST') return respond(405, { error: 'POST only' });
    return adminMediaAction(event, 'rollback');
  }
  if (path.endsWith('/admin/media/record/discard')) {
    if (method !== 'POST') return respond(405, { error: 'POST only' });
    return adminMediaAction(event, 'discardDraft');
  }
  if (path.endsWith('/admin/media/record/version')) {
    if (method !== 'GET') return respond(405, { error: 'GET only' });
    return adminMediaVersion(event);
  }
  if (path.endsWith('/admin/media/record/replace')) {
    if (method !== 'POST') return respond(405, { error: 'POST only' });
    return adminMediaReplace(event);
  }
  if (path.endsWith('/admin/media/record/map')) {
    if (method !== 'POST' && method !== 'PATCH' && method !== 'DELETE') return respond(405, { error: 'POST, PATCH or DELETE' });
    return adminMediaMap(event, method);
  }
  if (path.endsWith('/admin/media/record/component')) {
    if (method !== 'POST' && method !== 'DELETE') return respond(405, { error: 'POST or DELETE' });
    return adminMediaComponent(event, method);
  }
  if (path.endsWith('/admin/media/record/retire')) {
    if (method !== 'POST') return respond(405, { error: 'POST only' });
    return adminMediaRetire(event);
  }
  if (path.endsWith('/admin/media/record/restore')) {
    if (method !== 'POST') return respond(405, { error: 'POST only' });
    return adminMediaRestore(event);
  }
  if (path.endsWith('/admin/media/record')) {
    if (method === 'GET') return adminMediaRecord(event);
    if (method === 'PATCH') return adminMediaPatch(event);
    if (method === 'DELETE') return adminMediaDelete(event);
    return respond(405, { error: 'GET, PATCH or DELETE' });
  }
  if (path.endsWith('/admin/media')) {
    if (method === 'GET') return adminMedia(event);
    if (method === 'POST') return adminMediaCreate(event);
    return respond(405, { error: 'GET or POST' });
  }
  if (path.endsWith('/admin/diagnostics')) {
    if (method !== 'GET') return respond(405, { error: 'GET only' });
    return adminDiagnostics(event);
  }
  if (path.endsWith('/admin/error-codes/record/publish')) {
    if (method !== 'POST') return respond(405, { error: 'POST only' });
    return adminErrorCodeAction(event, 'publish');
  }
  if (path.endsWith('/admin/error-codes/record/rollback')) {
    if (method !== 'POST') return respond(405, { error: 'POST only' });
    return adminErrorCodeAction(event, 'rollback');
  }
  if (path.endsWith('/admin/error-codes/record/version')) {
    if (method !== 'GET') return respond(405, { error: 'GET only' });
    return adminErrorCodeVersion(event);
  }
  if (path.endsWith('/admin/error-codes/record/retire')) {
    if (method !== 'POST') return respond(405, { error: 'POST only' });
    return adminErrorCodeRetire(event);
  }
  if (path.endsWith('/admin/error-codes/record/restore')) {
    if (method !== 'POST') return respond(405, { error: 'POST only' });
    return adminErrorCodeRestore(event);
  }
  if (path.endsWith('/admin/error-codes/preview')) {
    if (method !== 'POST') return respond(405, { error: 'POST only' });
    return adminErrorCodePreview(event);
  }
  if (path.endsWith('/admin/error-codes/record')) {
    return adminErrorCodeRecord(event);
  }
  if (path.endsWith('/admin/error-codes')) {
    if (method !== 'GET' && method !== 'POST') return respond(405, { error: 'GET or POST' });
    return adminErrorCodes(event);
  }
  if (path.endsWith('/admin/recalls/records')) {
    return recallAdminRoute(event, method, ['GET'], () => recallAdmin.list((event && event.queryStringParameters) || {}));
  }
  if (path.endsWith('/admin/recalls/record/version')) {
    return recallAdminRoute(event, method, ['GET'], (_b, id) => recallAdmin.version(id, queryParam(event, 'v')));
  }
  if (path.endsWith('/admin/recalls/record/publish')) {
    return recallAdminRoute(event, method, ['POST'], (b, id) => recallAdmin.publish(id, b));
  }
  if (path.endsWith('/admin/recalls/record/discard')) {
    return recallAdminRoute(event, method, ['POST'], (b, id) => recallAdmin.discardDraft(id, b));
  }
  if (path.endsWith('/admin/recalls/record/archive')) {
    return recallAdminRoute(event, method, ['POST'], (b, id) => recallAdmin.archive(id, b));
  }
  if (path.endsWith('/admin/recalls/record/restore')) {
    return recallAdminRoute(event, method, ['POST'], (b, id) => recallAdmin.restore(id, b));
  }
  if (path.endsWith('/admin/recalls/record/rollback')) {
    return recallAdminRoute(event, method, ['POST'], (b, id) => recallAdmin.rollback(id, b));
  }
  if (path.endsWith('/admin/recalls/record')) {
    return recallAdminRoute(event, method, ['GET', 'PATCH'], (b, id) => (method === 'GET' ? recallAdmin.get(id) : recallAdmin.saveDraft(id, b)));
  }
  if (path.endsWith('/admin/recalls/ingest')) {
    if (method !== 'POST') return respond(405, { error: 'POST only' });
    const ingestActor = await requireAdmin(event);
    if (!ingestActor) return respond(401, { error: 'Unauthorized' });
    try {
      const result = await recallHandlers.adminIngest(event, ingestActor.email || ingestActor.username || null);
      if (result && result.running) return respond(409, result);
      return respond(result && result.ok === false ? 503 : 200, result);
    } catch (e) {
      log({ evt: 'recall-ingest-failed', error: String(e && e.message || e) });
      return respond(503, { error: 'OPSS request failed or timed out. The existing published dataset remains active.', preservedExisting: true });
    }
  }
  if (path.endsWith('/admin/safety-ingest/run')) {
    if (method !== 'POST') return respond(405, { error: 'POST only' });
    const runActor = await requireAdmin(event);
    if (!runActor) return respond(401, { error: 'Unauthorized' });
    try {
      const forced = Object.assign({}, event, { body: JSON.stringify({ mode: 'daily' }) });
      const result = await recallHandlers.adminIngest(forced, runActor.email || runActor.username || null);
      if (result && result.running) return respond(409, result);
      return respond(result && result.ok === false ? 503 : 200, result);
    } catch (e) {
      log({ evt: 'recall-ingest-failed', error: String(e && e.message || e) });
      return respond(503, { error: 'OPSS request failed or timed out. The existing published dataset remains active.', preservedExisting: true });
    }
  }
  if (path.endsWith('/admin/safety-ingest/history')) {
    if (method !== 'GET') return respond(405, { error: 'GET only' });
    if (!(await requireAdmin(event))) return respond(401, { error: 'Unauthorized' });
    try { return respond(200, await recallHandlers.adminHistory()); }
    catch (e) { return respond(503, { error: 'Recall store unavailable' }); }
  }
  if (path.endsWith('/admin/safety-ingest/runs')) {
    if (method !== 'GET') return respond(405, { error: 'GET only' });
    if (!(await requireAdmin(event))) return respond(401, { error: 'Unauthorized' });
    try {
      const out = await recallHandlers.adminRunGet(event);
      return respond(out.status || 200, out.body || out);
    } catch (e) { return respond(503, { error: 'Recall store unavailable' }); }
  }
  if (path.endsWith('/admin/safety-ingest')) {
    if (method !== 'GET') return respond(405, { error: 'GET only' });
    if (!(await requireAdmin(event))) return respond(401, { error: 'Unauthorized' });
    try { return respond(200, await recallHandlers.adminStatus()); }
    catch (e) { return respond(503, { error: 'Recall store unavailable' }); }
  }
  if (path.endsWith('/admin/recalls/status')) {
    if (!(await requireAdmin(event))) return respond(401, { error: 'Unauthorized' });
    if (method !== 'GET') return respond(405, { error: 'GET only' });
    try { return respond(200, await recallHandlers.adminStatus()); }
    catch (e) { return respond(503, { error: 'Recall store unavailable' }); }
  }
  if (path.endsWith('/recalls/lookup')) {
    if (method !== 'GET') return respond(405, { error: 'GET only' });
    const out = await recallHandlers.publicLookup(event);
    return respond(out.status || 200, out.body || out);
  }
  if (path.endsWith('/recalls/record')) {
    if (method !== 'GET') return respond(405, { error: 'GET only' });
    const out = await recallHandlers.publicGet(event);
    return respond(out.status || 200, out.body || out);
  }
  if (path.endsWith('/recalls') || path.endsWith('/recalls/')) {
    if (method !== 'GET') return respond(405, { error: 'GET only' });
    try { return respond(200, await recallHandlers.publicList(event)); }
    catch (e) { return respond(503, { error: 'Recall list unavailable' }); }
  }

  if (method !== 'POST') return respond(405, { error: 'POST only' });

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return respond(400, { error: 'invalid JSON' }); }

  // Admin Live Test (live-test.js): the same diagnose path, admin-only, never a customer transcript.
  // Checked BEFORE anything else runs so a non-admin `liveTest` request does no work at all.
  const live = liveTest.takeLiveTest(body);
  if (live) {
    if (!(await requireAdmin(event))) return respond(401, { error: 'Unauthorized' });
    if (!live.ok) return respond(400, { error: live.error });
  }
  if (live && Object.prototype.hasOwnProperty.call(body, 'benchmark')) return respond(400, { error: 'liveTest requests must not send benchmark' });
  const liveStateIn = live ? liveTest.stateInOf(body) : null;

  // Service-authenticated benchmark (benchmark-auth.js): the same diagnose path with a runner's own
  // conversation session id + clientTurnId and NO customer transcript. A `benchmark` object is
  // accepted only with a valid x-benchmark-signature (HMAC over this exact body); otherwise 401 —
  // never silently ignored. It is not an Admin session and grants nothing else.
  let bench = null;
  if (!live) {
    bench = benchmarkAuth.takeBenchmark(body);
    if (bench) {
      let secrets = null;
      try { secrets = await _benchmarkSecretsLoader(); } catch { secrets = null; }
      const auth = benchmarkAuth.verifyRequest(benchmarkAuth.headerOf(event, benchmarkAuth.HEADER), benchmarkAuth.rawBodyOf(event), secrets);
      if (!auth.ok) {
        log({ evt: 'benchmark-auth', rid, ok: false, reason: auth.reason });
        return respond(401, { error: 'Unauthorized' });
      }
      if (!bench.ok) return respond(400, { error: bench.error });
      if (body.feedback || !Array.isArray(body.messages)) return respond(400, { error: 'benchmark requires messages' });
    }
  }
  const benchStateIn = bench ? liveTest.stateInOf(body) : null;
  const benchStatus = (args) => Object.assign(liveTest.status(Object.assign({ stateIn: benchStateIn }, args)), { schema: 'benchmark/1', session: benchmarkAuth.sessionRef(bench.sessionId), clientTurnId: Boolean(bench.clientTurnId) });

  // Observability fields are stripped here and NEVER forwarded to the orchestrator.
  // (A live test / benchmark request is refused above if it carries observability, so `obs` is null for it.)
  const obs = live || bench ? null : transcripts.takeObservability(body);

  // Feedback pass-through: forward {feedback:{traceId,rating,note}} to the RAG engine (the single
  // S3 writer/redactor). The traceId originates from the RAG (carried through the orchestrator).
  if (live && (body.feedback || !Array.isArray(body.messages))) return respond(400, { error: 'liveTest requires messages' });
  if (body.feedback) {
    try {
      await fetch(ENGINE_URL, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ feedback: body.feedback }),
      });
    } catch (e) {
      log({ evt: 'whichpart-api', rid, feedbackError: e.message });
    }
    return respond(200, { ok: true });
  }

  if (obs && obs.event === 'end' && (!Array.isArray(body.messages) || body.messages.length === 0)) {
    await persistTranscriptEnd(obs);
    return respond(200, { ok: true });
  }

  let messages = body.messages;
  if (!Array.isArray(messages) || messages.length === 0) {
    return respond(400, { error: 'messages array required' });
  }
  messages = conversationWindow(messages, MAX_MESSAGES);
  if (!messages.length) {
    return respond(400, { error: 'messages array required' });
  }
  // Customer turns are counted (rate-limit.js); an admin Live Test and a verified benchmark turn are authenticated
  // and not counted.
  if (!live && !bench) {
    const limitedTurn = await rateLimited('diagnose', event, { session: obs && obs.sessionId });
    if (limitedTurn) return limitedTurn;
  }

  // CANONICAL STATE (canonical-architecture.md §11). The BFF owns durable cs/1 state. In `off` nothing
  // happens. In `shadow` / `control` the signed token is verified, state is loaded and sent to the
  // orchestrator, and the returned state is persisted. In `control` an allow-listed journey owns the
  // reply; every canonical failure degrades that turn to the legacy path.
  const canonCtx = await canonicalPrepare(body, live ? live.clientTurnId : (bench ? bench.clientTurnId : (obs && obs.clientTurnId)), rid);

  // IDEMPOTENT RETRY (canonical control): the same browser clientTurnId was already merged and
  // answered for this canonical session. Return the processed result; never merge again.
  if (canonCtx.duplicate && canonCtx.duplicate.view && canonCtx.mode === 'control') {
    const cached = { ...canonCtx.duplicate.view, requestId: rid };
    if (canonCtx.token) cached.stateToken = canonCtx.token;
    if (live) cached.liveTest = liveTest.status({ stateIn: liveStateIn, ctx: canonCtx, summary: null, tokenOut: Boolean(canonCtx.token), path: 'replayed' });
    if (bench) cached.benchmark = benchStatus({ ctx: canonCtx, summary: null, tokenOut: Boolean(canonCtx.token), path: 'replayed' });
    log({ evt: 'whichpart-api', rid, client: CLIENT_ID, liveTest: live ? true : undefined,
      benchmark: bench ? { auth: true, session: benchmarkAuth.sessionRef(bench.sessionId), turnId: Boolean(bench.clientTurnId), continuity: 'replayed' } : undefined,
      canonical: { mode: canonCtx.mode, duplicate: canonCtx.duplicate.source,
      version: canonCtx.version, ref: conversationState.sessionRef(canonCtx.csid), replayedView: true } });
    await persistTranscriptReplay(obs);
    return respond(200, cached);
  }

  const t0 = Date.now();
  let orch;
  try {
    // The client's stable per-conversation id (observability.sessionId, already validated by
    // takeObservability) is the orchestrator session key so its ConversationState persists across
    // turns. When the client sends no observability (e.g. the regression harness) the orchestrator
    // call falls back to a deterministic opening-turn fingerprint.
    orch = await callOrchestrator(messages, live ? live.sessionId : (bench ? bench.sessionId : (obs && obs.sessionId)), canonCtx.block);
  } catch (err) {
    log({ evt: 'whichpart-api', rid, error: err.message, ms: Date.now() - t0 });
    const fallback = fallbackView(rid);
    if (canonCtx.token) fallback.stateToken = canonCtx.token;
    if (live) fallback.liveTest = liveTest.status({ stateIn: liveStateIn, ctx: canonCtx, summary: null, tokenOut: Boolean(canonCtx.token), path: 'orchestrator_unavailable' });
    if (bench) fallback.benchmark = benchStatus({ ctx: canonCtx, summary: null, tokenOut: Boolean(canonCtx.token), path: 'orchestrator_unavailable' });
    await persistTranscriptTurn(obs, messages, fallback, null, rid,
      canonicalTranscriptAudit(canonCtx, null, { written: false, recordWritten: false, degraded: canonCtx.degraded }, null, 'orchestrator_unavailable'));
    return respond(200, fallback);
  }

  // #21: a REQUIRED canonical COMPOSE whose provider failed (structured violation `compose_failed` in the
  // canonical-control stage; never inferred from text) used to reach the customer as the deterministic template,
  // looking like a healthy turn. It is now an explicit failure: the documented "AI service unavailable" reply with
  // error:true, exactly the orchestrator-unavailable path, so the canonical state is NOT advanced (the customer never
  // saw this turn's question) and the turn is logged as failed. Output-contract fallbacks (tripwire, checkReply) and
  // the fixed safety-stop copy keep their deterministic template by design.
  if (composeProviderFailed(orch._diagnosticTrace)) {
    log({ evt: 'whichpart-api', rid, ok: false, composeFailed: true, route: orch.route, ms: Date.now() - t0,
      canonical: canonCtx.mode === 'off' ? undefined : { mode: canonCtx.mode, version: canonCtx.version, ref: conversationState.sessionRef(canonCtx.csid) } });
    const failed = aiUnavailableView(rid);
    if (canonCtx.token) failed.stateToken = canonCtx.token;
    if (live) failed.liveTest = liveTest.status({ stateIn: liveStateIn, ctx: canonCtx, summary: null, tokenOut: Boolean(canonCtx.token), path: 'compose_failed' });
    if (bench) failed.benchmark = benchStatus({ ctx: canonCtx, summary: null, tokenOut: Boolean(canonCtx.token), path: 'compose_failed' });
    await persistTranscriptTurn(obs, messages, failed, null, rid,
      canonicalTranscriptAudit(canonCtx, null, { written: false, recordWritten: false, degraded: canonCtx.degraded }, orch._diagnosticTrace, 'compose_failed'));
    return respond(200, failed);
  }

  const canonResult = await canonicalFinish(canonCtx, orch._canonical, rid);
  let canonSummary = null;
  try { canonSummary = conversationState.summarise(canonCtx, orch._canonical, canonResult); } catch { canonSummary = null; }
  // Live Test only: the merged state this turn actually persisted (projected, never returned whole).
  const liveMerged = (live || bench) && canonResult.written && orch._canonical && orch._canonical.state ? orch._canonical.state : null;
  // The transcript keeps only the bounded canonical-audit/1 projection (no state body, csid or token).
  const canonAudit = canonicalTranscriptAudit(canonCtx, orch._canonical, canonResult, orch._diagnosticTrace);
  delete orch._canonical; // server-side only; never reaches the view or the transcript
  // Admin diagnostic trace (persisted with the transcript turn, never in the browser view): a bounded
  // canonical persistence stage — mode, safe ref, versions, mc/1 summary, rules, persistence, degraded.
  if (canonSummary && orch._diagnosticTrace && Array.isArray(orch._diagnosticTrace.stages)) {
    orch._diagnosticTrace.stages.push(conversationState.traceStage(canonSummary));
  }

  let overlay = null;
  try { overlay = await loadOverlayCached(); } catch { overlay = null; }
  const view = toWhichPartView(orch, rid, overlay);
  // ADR 0016: a turn whose decision path could not run is an error, not a normal reply (the copy is the
  // orchestrator's own; the flag lets the client offer a retry and the transcript count it as failed).
  if (orch.outcome === 'SERVICE_UNAVAILABLE') view.error = true;
  if (canonCtx.token) view.stateToken = canonCtx.token;
  // Idempotency marker (+ cached view) only for a turn whose canonical state was persisted.
  if (canonResult.written && canonCtx.clientTurnId) {
    await conversationState.recordClientTurn(canonCtx, canonResult, view, { store: canonicalStore() });
  }
  // Attached after the idempotency cache is written, so a cached view never carries a live-test status.
  if (live) view.liveTest = liveTest.status({ stateIn: liveStateIn, ctx: canonCtx, summary: canonSummary, tokenOut: Boolean(canonCtx.token), mergedState: liveMerged });
  if (bench) view.benchmark = Object.assign(benchStatus({ ctx: canonCtx, summary: canonSummary, tokenOut: Boolean(canonCtx.token), mergedState: liveMerged }),
    { compose: composeOf(orch._diagnosticTrace) });
  const cr = orch.codeResult || null;
  const mcpInvoked = orch.route === 'ERROR_CODE' || orch.route === 'ERROR_CODE_AND_SYMPTOMS';
  const ragInvoked = orch.route === 'SYMPTOMS' || orch.route === 'ERROR_CODE_AND_SYMPTOMS';
  const submitted = (orch._telemetry && orch._telemetry.submitted) || null;
  log({
    evt: 'whichpart-api', rid, client: CLIENT_ID,
    // Admin Live Test turn: continuity status only (never the token, csid or state body).
    liveTest: live ? { stateIn: view.liveTest.stateIn, stateOut: view.liveTest.stateOut, continuity: view.liveTest.continuity, reason: view.liveTest.reason } : undefined,
    // Service-authenticated benchmark turn: safe refs only (never the session id, token or secret).
    benchmark: bench ? { auth: true, session: view.benchmark.session, turnId: view.benchmark.clientTurnId, stateIn: view.benchmark.stateIn, stateOut: view.benchmark.stateOut, continuity: view.benchmark.continuity, reason: view.benchmark.reason } : undefined,
    route: orch.route, outcome: orch.outcome,
    hasDisplayedCode: Boolean(cr && cr.displayed),
    mcpInvoked,
    ragInvoked,
    clarificationRequired: orch.outcome === 'CLARIFICATION_REQUIRED',
    safetyState: (orch.safety && orch.safety.class) || 'NORMAL',
    safetyStopUse: Boolean((orch.safety && orch.safety.stopUse) || orch.outcome === 'SAFETY_STOP'),
    partCount: view.parts.length,
    mcpSubmitted: submitted,
    mcpResolved: cr ? {
      displayed: cr.displayed || null,
      status: cr.status || null,
      recordType: cr.recordType || null,
      meaning: cr.meaning ? String(cr.meaning).slice(0, 180) : null,
      source: cr.source || null,
      confidence: cr.confidence || cr.mappingConfidence || null,
    } : null,
    ragConstrainedByMcp: Boolean(mcpInvoked && ragInvoked && cr && cr.status === 'RESOLVED'),
    canonical: canonCtx.mode === 'off' ? undefined : {
      mode: canonCtx.mode, demoted: canonCtx.demoted || undefined, version: canonCtx.version,
      duplicate: canonCtx.duplicate ? canonCtx.duplicate.source : undefined,
      appliance: canonSummary && canonSummary.mc1 ? canonSummary.mc1.appliance : undefined,
      control: canonSummary && canonSummary.journey ? {
        key: canonSummary.journey.key || null, applies: canonSummary.journey.applies, control: canonSummary.journey.control,
        rule: canonSummary.journey.nextAction ? canonSummary.journey.nextAction.rule : undefined,
        kind: canonSummary.journey.nextAction ? canonSummary.journey.nextAction.kind : undefined,
        target: canonSummary.journey.nextAction ? canonSummary.journey.nextAction.target : undefined,
      } : undefined,
      recovered: canonCtx.recovered || undefined,
      degraded: canonResult.degraded || canonCtx.degraded || null, written: canonResult.written,
      recordWritten: canonResult.recordWritten,
      ref: canonSummary ? canonSummary.ref : undefined,
      resultVersion: canonSummary ? canonSummary.resultVersion : undefined,
      rules: canonSummary ? canonSummary.rulesFired : undefined,
      stateBytes: canonSummary ? canonSummary.stateBytes : undefined,
      classifier: canonSummary && canonSummary.classifier ? {
        source: canonSummary.classifier.source, degraded: canonSummary.classifier.degraded || undefined,
        reason: canonSummary.classifier.reason || undefined, recallGap: canonSummary.classifier.recallGap,
      } : undefined,
    },
    ms: Date.now() - t0,
  });
  await persistTranscriptTurn(obs, messages, view, orch, rid, canonAudit);
  return respond(200, view);
};

// ---- orchestrator call --------------------------------------------------------
// Pick the orchestrator session key. The client's stable per-conversation id (observability
// sessionId) is preferred so the orchestrator's deterministic ConversationState is found again on
// the next turn and established facts persist. transcripts.isValidSessionId guards the format the
// orchestrator keys on; anything missing/invalid falls back to the deterministic opening-turn
// fingerprint computed by deriveContext. Pure + exported for unit tests (no network).
function resolveOrchestratorSessionId(clientSessionId, fallbackSessionId) {
  if (clientSessionId && transcripts.isValidSessionId(clientSessionId)) return clientSessionId;
  return fallbackSessionId;
}

// ---- canonical state (cs/1 transport + persistence) ------------------------------------------------
let _canonicalStore = null;
let _canonicalSecretsLoader = () => stateTokenMod.loadSecrets();
let _canonicalNewId = undefined;
function canonicalStore() {
  if (!_canonicalStore) _canonicalStore = conversationState.createStateStore();
  return _canonicalStore;
}
function setCanonicalDepsForTests({ store, secretsLoader, newId } = {}) {
  if (store !== undefined) _canonicalStore = store;
  if (secretsLoader !== undefined) _canonicalSecretsLoader = secretsLoader;
  if (newId !== undefined) _canonicalNewId = newId;
}
let _canonicalUnknownLogged = false;
/** Never throws; `off` mode does no work at all. */
async function canonicalPrepare(body, clientTurnId, rid) {
  const { mode, demoted, unknown } = conversationState.resolveMode();
  // An allow-list key that is not in the journey registry is never enabled; say so once per container.
  if (unknown && unknown.length && !_canonicalUnknownLogged) {
    _canonicalUnknownLogged = true;
    log({ evt: 'canonical-config', warning: 'unknown CANONICAL_CONTROL_JOURNEYS keys ignored', unknown: unknown.slice(0, 20).map((k) => String(k).slice(0, 60)) });
  }
  if (mode === 'off') return { mode: 'off', block: null, token: null, degraded: null };
  try {
    let secrets = null;
    try { secrets = await _canonicalSecretsLoader(); } catch { secrets = null; }
    const ctx = await conversationState.prepareTurn({ body, store: canonicalStore(), secrets, newId: _canonicalNewId, clientTurnId });
    if (ctx.degraded) log({ evt: 'canonical-prepare', rid, mode: ctx.mode, degraded: ctx.degraded });
    return ctx;
  } catch (e) {
    // e.g. store construction failed. The legacy path continues; canonical is simply off this turn.
    log({ evt: 'canonical-prepare', rid, mode, degraded: 'prepare_failed', error: String((e && e.message) || e).slice(0, 160) });
    return { mode, demoted, block: null, token: null, version: 0, degraded: 'prepare_failed' };
  }
}
async function canonicalFinish(ctx, out, rid) {
  if (!ctx || !ctx.block) return { written: false, recordWritten: false, degraded: ctx ? ctx.degraded : null };
  try {
    const r = await conversationState.finishTurn(ctx, out, { store: canonicalStore(), messageId: rid });
    if (r.degraded) log({ evt: 'canonical-finish', rid, degraded: r.degraded, written: r.written });
    return r;
  } catch (e) {
    return { written: false, recordWritten: false, degraded: 'finish_failed' };
  }
}

async function callOrchestrator(messages, clientSessionId, canonicalBlock) {
  // Story 3: the BFF is a STRUCTURAL transport. It assembles the conversation and forwards it; it
  // does NOT interpret customer meaning (appliance family, symptom presence, model-vs-error-code
  // are the orchestrator's single Jev UNDERSTAND, which runs BEFORE routing). The old deriveContext
  // semantic parsing and the competing extract-intent LLM classifier have been removed — one
  // semantic authority, no boundary duplication.
  const ctx = deriveContext(messages);
  // Prefer the client's stable per-conversation id so the orchestrator's ConversationState persists
  // across turns; fall back to the deterministic opening-turn fingerprint for clients that send no
  // observability session.
  const sessionId = resolveOrchestratorSessionId(clientSessionId, ctx.sessionId);
  const payload = {
    // Accumulated conversation (client-carried context) so the orchestrator's single Jev pass sees
    // the whole thread every turn (retention/correction), now with a STABLE per-conversation session
    // so already-established facts are retained deterministically instead of re-derived each turn.
    message: ctx.conversationText || ctx.message, sessionId,
    includeEnrichment: true,
    latestMessage: ctx.latestMessage, turnIndex: ctx.turnIndex,
    conversation: sanitiseConversation(messages),
    // Forward the latest-turn rating-plate image so the orchestrator/RAG vision can read it.
    ...(ctx.latestImage ? { image: ctx.latestImage } : {}),
    // Canonical cs/1 block (mode, allow-list, csid, prior state). Present only when canonical runs this turn.
    ...(canonicalBlock ? { canonical: canonicalBlock } : {}),
  };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ORCH_TIMEOUT_MS);
  try {
    const headers = { 'content-type': 'application/json' };
    if (ORCHESTRATOR_TOKEN) headers.authorization = 'Bearer ' + ORCHESTRATOR_TOKEN;
    // A throttled (429) call never ran, so it is retried a bounded number of times inside the same overall timeout; a
    // throttle that persists is still reported as a failure below.
    const res = await fetchWithThrottleRetry(fetch, ORCHESTRATOR_URL.replace(/\/$/, '') + '/diagnose', {
      method: 'POST', headers, body: JSON.stringify(payload), signal: controller.signal,
    }, { onRetry: ({ attempt, delayMs }) => log({ evt: 'orchestrator-throttled', attempt, delayMs }) });
    if (!res.ok) throw new Error('orchestrator http ' + res.status);
    const out = await res.json();
    out._photoOnly = ctx.photoOnly;
    // Telemetry only — never customer-facing. Story 3: the BFF no longer derives semantics, so this
    // reflects what the orchestrator (single Jev authority) resolved, not a boundary re-parse.
    const understood = (out.understood && typeof out.understood === 'object') ? out.understood : {};
    out._telemetry = {
      submitted: {
        // What the orchestrator ACTUALLY routed/submitted this turn (single Jev authority), not a
        // boundary re-parse: the customer's displayed code (compound preserved), structural make,
        // and Jev's appliance family. Falls back to the resolved codeResult for the displayed code.
        displayedCode: understood.displayedCode || (out.codeResult && out.codeResult.displayed) || null,
        make: understood.make || null,
        applianceFamily: understood.appliance || null,
      },
    };
    return out;
  } finally {
    clearTimeout(timer);
  }
}

// ---- orchestrator response -> retailer-neutral view --------------------------
function toWhichPartView(orch, rid, overlay) {
  const outcome = orch.outcome || 'ANSWER';
  const codeResult = orch.codeResult || null;
  const isSafety = outcome === 'SAFETY_STOP' || (orch.safety && orch.safety.stopUse);
  const recordType = codeResult && codeResult.recordType;
  const advisory = !isSafety && recordType === 'MAINTENANCE';

  let reply = sanitizeReply(orch.message || '');
  const mention = String(orch.componentMention || '').toLowerCase();
  const suppressCatalogueNames = mention === 'none' || mention === 'discuss';
  // Never dump a catalogue of possible components into the customer reply. The engine used to
  // fold suggestedChecks as "Worth checking: a, b, c" — that is not a next action.
  reply = reply.replace(/\s*Worth checking:\s*[^.]+\./g, '').trim();

  // FIT INVARIANT:


  // FIT INVARIANT: only MODEL_CONFIRMED with a genuinely resolved model AND a model-specific part.
  const hasResolvedModel = Boolean(orch.resolvedModel);
  const rawParts = (isSafety || suppressCatalogueNames) ? [] : (Array.isArray(orch.parts) ? orch.parts : []);
  const parts = rawParts
    .filter((p) => p && p.partNo)
    .map((p) => {
      const link = p.link || `/${p.partNo}`;
      return {
        canonicalPartId: `s4r:${p.partNo}`,
        name: p.title || p.partNo,
        imageUrl: p.image || p.imageUrl || null,
        fitStatus: (hasResolvedModel && !p._brandOnly) ? 'MODEL_CONFIRMED' : 'VERIFY_FIT',
        offers: [{
          retailer: 'Spares4Repairs',
          price: toPence(p.price),
          currency: 'GBP',
          url: `${S4R_PRODUCT_BASE_URL}${link.startsWith('/') ? '' : '/'}${link}`,
        }],
      };
    });

  const seen = new Set();
  const components = [];
  for (const p of parts) {
    if (seen.has(p.name)) continue;
    seen.add(p.name);
    components.push({ name: p.name, rank: p.fitStatus === 'MODEL_CONFIRMED' ? 'PRIMARY' : 'PLAUSIBLE' });
  }

  // Rating-plate extraction awaiting confirmation: expose ONLY the candidate model string (never the
  // vision-read make/appliance, which can be a legal-entity/appliance distractor) so the UI can show
  // "is this your model?". Parts stay empty until the customer confirms.
  const ie = orch.imageExtraction;
  const extractedModel = (ie && ie.status === 'IMAGE_EXTRACTED_UNCONFIRMED' && ie.model) ? String(ie.model) : null;

  // needsModel: only when identity is still missing. A candidate extracted from a photo is
  // confirmation-in-progress, not a missing model — do not show the generic model-entry control.
  const needs = (orch.clarification && orch.clarification.needs) || [];
  const needsStr = needs.map((n) => (n && typeof n === 'object') ? (n.attribute || JSON.stringify(n)) : String(n)).join(' ');
  const modelNeedRe = /scheme|model|e_?nr|pnc|12nc|serial|plate|identifi|generation|platform|architecture/i;
  const needsModel = !extractedModel && Boolean(
    orch.modelRequired
    || (outcome === 'CLARIFICATION_REQUIRED' && modelNeedRe.test(needsStr))
  );

  const label = (codeResult && codeResult.meaning) || (orch.diagnosis && orch.diagnosis.summary) || null;

  // Customer SAFETY INFORMATION — pre-written, evidence-backed text attached to the grounded node by
  // the RAG (node identity) and passed through the orchestrator verbatim. We surface ONLY the
  // customer-facing fields (text + classification); provenance/source internals stay server-side.
  // The `text` is passed through byte-for-byte (never rewritten). Suppressed on a safety-stop (that
  // reply already leads with the authoritative action). Absent => null (UI renders nothing).
  const si = orch.safetyInformation;
  const safetyInformation = (!isSafety && si && typeof si.text === 'string' && si.text.trim())
    ? { text: si.text, classification: si.classification || null }
    : null;

  // Customer instructional media (image/diagram/video) supporting a check on the grounded node.
  // Already a customer-safe subset from the RAG; re-project defensively so no extra field can leak
  // (provenance never passes), suppress entirely on a safety-stop, and HARD-RESTRICT video embeds to
  // the trusted provider host — a curated embed URL from any other host is dropped.
  // Explanatory-media intent (customer-safe): SAFE_CHECK (instructional/check) or ABOUT
  // (identification/explanation — non-DIY framing in the UI). Default SAFE_CHECK for backward compat.
  const mediaIntent = (m) => (m && m.intent === 'ABOUT' ? 'ABOUT' : 'SAFE_CHECK');
  const media = mediaAdmin.applyToCustomerMedia((!isSafety && Array.isArray(orch.media))
    ? orch.media.map((m) => {
        if (!m || !m.title) return null;
        if (m.type === 'VIDEO') {
          if (m.provider !== 'YOUTUBE' || !isTrustedVideoEmbed(m.embedUrl)) return null;
          return {
            type: 'VIDEO', title: m.title, caption: m.caption || m.description || '',
            provider: 'YOUTUBE', videoId: m.videoId || null, embedUrl: m.embedUrl,
            sourcePageUrl: (typeof m.sourcePageUrl === 'string' && /^https:\/\//i.test(m.sourcePageUrl)) ? m.sourcePageUrl : null,
            attribution: m.attribution || null, intent: mediaIntent(m), id: m.id || null,
          };
        }
        if (!m.url) return null;
        return { type: m.type || 'IMAGE', title: m.title, description: m.description || '', url: m.url, alt: m.alt || m.title, intent: mediaIntent(m), id: m.id || null };
      }).filter(Boolean)
    : [], overlay);

  // Relay the orchestrator's STRUCTURED pending request (customer-safe: slot/purpose/status only) so
  // a client that can carry conversation state echoes it back next turn. Absent => null.
  const pr = orch.pendingRequest;
  const pendingRequest = (pr && typeof pr === 'object' && typeof pr.slot === 'string')
    ? { slot: pr.slot, purpose: pr.purpose || null, status: pr.status || 'PENDING' }
    : null;

  return {
    requestId: rid,
    traceId: orch.traceId || null,
    reply,
    advisory,
    safety: Boolean(isSafety),
    pendingRequest,
    safetyInformation,
    needsModel,
    extractedModel,
    media,
    diagnosis: {
      faultId: null, // internal scheme/fault ids are never surfaced to the client
      label,
      summary: firstSentence(reply),
    },
    components,
    // The engine's full differential (customer-safe suspect names). The customer-facing `reply` is a
    // concise, prioritised engineering explanation (it deliberately does NOT list every suspect);
    // this structured field carries the complete differential for the UI and for quality grading, so
    // measuring differential breadth never forces verbose prose.
    suggestedChecks: Array.isArray(orch.suggestedChecks) ? orch.suggestedChecks : [],
    parts,
  };
}

// Trusted VIDEO embed hosts (privacy-enhanced YouTube only). The customer response may only carry an
// embed URL whose host is in this allowlist — no arbitrary iframes, even from curated data.
const VIDEO_EMBED_HOSTS = new Set(['www.youtube-nocookie.com', 'youtube-nocookie.com']);
function isTrustedVideoEmbed(u) {
  try {
    const url = new URL(String(u));
    return url.protocol === 'https:' && VIDEO_EMBED_HOSTS.has(url.hostname.toLowerCase());
  } catch { return false; }
}

function sanitizeReply(text) {
  return String(text)
    .replace(/\[([^\]]+)\]\((?:\/|https?:)[^)]*\)/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/^[ \t]*[*-][ \t]+/gm, '\u2022 ')
    .replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1$2')
    .replace(/[ \t]+\n/g, '\n')
    .trim();
}
function toPence(price) {
  const n = parseFloat(price);
  return Number.isFinite(n) ? Math.round(n * 100) : null;
}
function firstSentence(text) {
  if (!text) return '';
  const m = text.match(/^.*?[.!?](\s|$)/);
  return (m ? m[0] : text).trim();
}
/** The canonical-control stage's COMPOSE record (source, violations, error class), for the benchmark status. */
function composeOf(trace) {
  const st = trace && Array.isArray(trace.stages) ? trace.stages.find((x) => x && x.id === 'canonical-control') : null;
  const c = st && st.detail && st.detail.compose;
  return c ? { source: c.source || null, violations: Array.isArray(c.violations) ? c.violations.slice(0, 8) : [], error: c.error || null } : null;
}
/** #21: true when the canonical-control stage reports a COMPOSE provider failure (structured, not text). */
function composeProviderFailed(trace) {
  const st = trace && Array.isArray(trace.stages) ? trace.stages.find((x) => x && x.id === 'canonical-control') : null;
  const c = st && st.detail && st.detail.compose;
  return Boolean(c && Array.isArray(c.violations) && c.violations.indexOf('compose_failed') !== -1);
}
/** The documented public failure reply (the diagnosis service's "AI service unavailable"), as an error view. */
function aiUnavailableView(rid) {
  return { ...fallbackView(rid), reply: 'AI service unavailable. Please try again in a moment.', errorCode: 'ai_unavailable' };
}
function fallbackView(rid) {
  return {
    requestId: rid,
    reply: "Sorry \u2014 something went wrong working that out. Please try again in a moment, or rephrase the problem.",
    needsModel: false, safety: false, advisory: false, safetyInformation: null, extractedModel: null, media: [],
    diagnosis: { faultId: null, label: null, summary: '' },
    components: [], parts: [], error: true,
  };
}

// Exported for deterministic unit tests (no network / orchestrator needed).
module.exports.toWhichPartView = toWhichPartView;
module.exports.deriveContext = deriveContext;
module.exports.sanitiseConversation = sanitiseConversation;
module.exports.conversationWindow = conversationWindow;
module.exports.resolveOrchestratorSessionId = resolveOrchestratorSessionId;
module.exports.setTranscriptStore = setTranscriptStore;
module.exports.setCanonicalDepsForTests = setCanonicalDepsForTests;
module.exports.setBenchmarkDepsForTests = setBenchmarkDepsForTests;
module.exports.setTranscriptReviewJudge = setTranscriptReviewJudge;
module.exports.setRateLimitStoreForTests = setRateLimitStoreForTests;
module.exports.composeProviderFailed = composeProviderFailed;
module.exports.composeOf = composeOf;
module.exports.setMediaAdminStore = setMediaAdminStore;
module.exports.setKnowledgeAdminStore = setKnowledgeAdminStore;
module.exports.knowledgeAdmin = knowledgeAdmin;
module.exports.setDiagnosticsDepsForTests = setDiagnosticsDepsForTests;
module.exports.setSettingsDepsForTests = setSettingsDepsForTests;
module.exports.setSessionForTests = setSessionForTests;
module.exports.setAcqS3ForTests = setAcqS3ForTests;
module.exports.routingOverride = routingOverride;
module.exports.settingsAdmin = settingsAdmin;
module.exports.diagnosticsInspect = diagnosticsInspect;
module.exports.mediaAdmin = mediaAdmin;
module.exports.transcripts = transcripts;
module.exports.transcriptReview = transcriptReview;
module.exports.setErrorCodesClientForTests = setErrorCodesClientForTests;
module.exports.errorCodesAdmin = errorCodesAdmin;
module.exports.recallAdmin = recallAdmin;
module.exports.setRecallStore = setRecallStore;
module.exports.recallStoreMod = recallStoreMod;
