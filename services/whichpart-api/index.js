'use strict';

/**
 * Which Part API — anti-corruption / boundary layer.
 *
 * The Which Part UI depends solely on the retailer-neutral contract produced here
 * (Diagnosis / CandidateComponent / CanonicalPart / Offer[]). Every customer turn is one ac2 turn
 * (ADR 0020): this boundary loads the conversation's evidence ledger, calls the diagnosis engine
 * (signed, `mode: 'turn'`) and persists the new ledger. The browser never sees downstream credentials.
 *
 *   Browser -> /api (this Lambda) -> diagnosis engine (ac2 turn, AWS_IAM + AC signature)
 *
 * FIT INVARIANT preserved: a part is MODEL_CONFIRMED only when the customer's model was actually
 * resolved AND the part is model-specific (not brand-only) — otherwise VERIFY_FIT.
 * Downstream bearer tokens come from env only (never committed/logged/returned to the client).
 */

const settingsAdmin = require('./settings-admin.js');
const transcripts = require('./transcripts');
const ac2State = require('./ac2-state');
const ac2Turn = require('./ac2-turn');
const liveTest = require('./live-test.js');
const benchmarkAuth = require('./benchmark-auth.js');
const stateTokenMod = require('./state-token');
const transcriptReview = require('./transcript-review');
const recallStoreMod = require('./recalls/store');
const recallIngest = require('./recalls/ingest');
const recallMatch = require('./recalls/match');
const mediaAdmin = require('./media-admin');
const diagnosticsInspect = require('./diagnostics-inspect');
const errorCodesAdmin = require('./error-codes-admin');
const httpHeaders = require('./http-headers.js');
const { ENGINE_URL, S4R_PRODUCT_BASE_URL, CLIENT_ID, MAX_MESSAGES } = require('./config.js');
const { signedJsonHeaders } = require('./engine-signature.js');
const { log } = require('./log.js');
const { queryParam, authPath, CORS, respond } = require('./http-io.js');
const { setRateLimitStoreForTests, rateLimited } = require('./rate-limiting.js');
const turnstile = require('./turnstile.js');
const { clientIp } = require('./rate-limit.js');
const { authLogin, authMe, authLogout, setSessionForTests, requireAdmin } = require('./session.js');
const { setAcqS3ForTests } = require('./s3.js');
const { routingOverride, recoverRoutingOverride } = require('./benchmark-state.js');
const { setTranscriptStore, persistTranscriptTurn, persistTranscriptEnd } = require('./transcript-store.js');
const {
  setMediaAdminStore, loadOverlayCached, adminKnowledge, adminKnowledgeRecord, adminMedia,
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

// ---- conversation transport (structural only; the ac2 turn owns meaning) ------------------------------
function hasImage(content) {
  return Array.isArray(content) && content.some((p) => p && p.type === 'image_url');
}
function imageOf(content) {
  if (!Array.isArray(content)) return null;
  const p = content.find((x) => x && x.type === 'image_url' && x.image_url && x.image_url.url);
  return p ? p.image_url.url : null;
}
/** The customer's latest photo (a rating plate, a part): this turn's, else the most recent earlier one. */
function latestImageOf(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m && m.role === 'user' && hasImage(m.content)) return imageOf(m.content);
  }
  return null;
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
  // Knowledge is read-only (ADR 0019 removed the publish workflow). Any other /admin/knowledge/* path, including the
  // retired draft/validate/versions/publish/rollback/archive/restore endpoints, is a 404, never the diagnose path below.
  if (path.includes('/admin/knowledge/')) return respond(404, { error: 'not found' });
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
  // conversation session id and NO customer transcript. A `benchmark` object is
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

  // Observability fields are stripped here and NEVER forwarded to the engine.
  // (A live test / benchmark request is refused above if it carries observability, so `obs` is null for it.)
  const obs = live || bench ? null : transcripts.takeObservability(body);

  // Feedback pass-through: forward {feedback:{traceId,rating,note}} to the diagnosis engine (the single
  // S3 writer/redactor).
  if (live && (body.feedback || !Array.isArray(body.messages))) return respond(400, { error: 'liveTest requires messages' });
  if (body.feedback) {
    try {
      const feedbackBody = JSON.stringify({ feedback: body.feedback });
      await fetch(ENGINE_URL, { method: 'POST', headers: signedJsonHeaders(feedbackBody, ENGINE_URL), body: feedbackBody });
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
    // Bot check (turnstile.js): a new conversation, i.e. one without a valid signed state token, needs a passing
    // Cloudflare Turnstile token. Later turns carry the state token this API issued, so the check runs once.
    if (turnstile.mode() !== 'off') {
      let newConversation = true;
      try {
        if (body.stateToken) newConversation = !stateTokenMod.verifyToken(body.stateToken, await stateTokenMod.loadSecrets()).ok;
      } catch { newConversation = true; }
      const blocked = await turnstile.guard({ token: body.turnstile, newConversation, ip: clientIp(event).ip, log: (x) => log({ ...x, rid }) });
      if (blocked) return blocked;
    }
  }

  // ac2 (ADR 0020): LLM-led diagnosis inside the deterministic guardrail kernel (services/diagnosis-engine/ac2). It is
  // the only diagnose path; the engine's turn pipeline is the whole decision path.
  return ac2Respond({ body, messages, rid, live, bench, obs, liveStateIn });
};

// ---- ac2 turn ------------------------------------------------------------------------------------------
let _ac2Store = null;
function ac2Store() {
  if (!_ac2Store) _ac2Store = ac2State.createStore();
  return _ac2Store;
}
function setAc2DepsForTests({ store, callEngine } = {}) {
  if (store !== undefined) _ac2Store = store;
  if (callEngine !== undefined) _ac2CallEngine = callEngine;
}
let _ac2CallEngine = async (raw, timeoutMs) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(ENGINE_URL, { method: 'POST', headers: signedJsonHeaders(raw, ENGINE_URL), body: raw, signal: controller.signal });
    let json = null;
    try { json = await res.json(); } catch { json = null; }
    return { status: res.status, json };
  } finally {
    clearTimeout(timer);
  }
};
// Recall tool for the ac2 turn: strong matches only (an exact model identifier in a published notice), never a fuzzy
// resemblance. Published records are cached per container for five minutes.
let _recallCache = { at: 0, rows: [] };
async function ac2RecallLookup(messages) {
  const text = (messages || []).filter((m) => m && m.role === 'user').map((m) => (typeof m.content === 'string' ? m.content : '')).join(' ');
  const tokens = [...new Set((text.toUpperCase().match(/\b[A-Z0-9][A-Z0-9-]{4,19}\b/g) || []).filter((t) => /\d/.test(t) && /[A-Z]/.test(t)))].slice(0, 6);
  if (!tokens.length) return [];
  if (Date.now() - _recallCache.at > 300000) _recallCache = { at: Date.now(), rows: await recallStore().listPublished() };
  const out = [];
  for (const r of _recallCache.rows) {
    for (const t of tokens) {
      let m;
      try { m = recallMatch.matchQuery({ brand: r.brand, models: r.models, modelText: r.modelText, productName: r.productName, title: r.title, family: r.family, searchBlob: recallStoreMod.searchBlob(r) }, t); } catch { m = null; }
      if (m && m.strength === 'strong') { out.push({ title: String(r.title || '').slice(0, 160), url: r.slug ? `/recalls/${r.slug}/` : null, brand: r.brand || null }); break; }
    }
    if (out.length >= 3) break;
  }
  return out;
}

async function ac2Respond({ body, messages, rid, live, bench, obs, liveStateIn }) {
  const t0 = Date.now();
  // An evaluation-only ablation is honoured only on an authenticated benchmark request.
  const control = bench && body && body.control === 'qwen-plain' ? 'qwen-plain' : null;
  const r = await ac2Turn.handle({ body, messages, image: latestImageOf(messages), control }, {
    callEngine: (raw, timeoutMs) => _ac2CallEngine(raw, timeoutMs), secretsLoader: () => _stateTokenSecretsLoader(), store: ac2Store(),
    recallLookup: (msgs) => ac2RecallLookup(msgs),
  });
  if (r.error) {
    log({ evt: 'whichpart-api', rid, ok: false, ac2: { error: r.error }, liveTest: live ? { session: live.sessionId } : undefined, ms: Date.now() - t0 });
    const failed = aiUnavailableView(rid);
    failed.error = true;
    failed.degraded = r.error;
    if (r.token) failed.stateToken = r.token;
    if (live) failed.liveTest = liveTest.status({ stateIn: liveStateIn, result: r });
    if (bench) failed.benchmark = { schema: 'benchmark/1', engine: 'ac2', ok: false, reason: r.error, session: benchmarkAuth.sessionRef(bench.sessionId) };
    await persistTranscriptTurn(obs, messages, failed, null, rid, { schemaVersion: 'ac2-transcript-audit/1', path: 'ac2', error: r.error, ms: Date.now() - t0 });
    return respond(200, failed);
  }
  let overlay = null;
  try { overlay = await loadOverlayCached(); } catch { overlay = null; }
  const view = toWhichPartView(r.orch, rid, overlay);
  view.stateToken = r.token;
  if (live) view.liveTest = liveTest.status({ stateIn: liveStateIn, result: r });
  if (bench) view.benchmark = { schema: 'benchmark/1', engine: 'ac2', ok: true, session: benchmarkAuth.sessionRef(bench.sessionId), audit: r.audit };
  log({ evt: 'whichpart-api', rid, client: CLIENT_ID, route: 'AC2', outcome: r.orch.outcome,
    benchmark: bench ? { auth: true, session: benchmarkAuth.sessionRef(bench.sessionId) } : undefined, liveTest: live ? { session: live.sessionId } : undefined,
    ac2: { turn: r.audit.turn, status: r.audit.status, hazards: r.audit.safety && r.audit.safety.hazards, gates: ((r.audit.safety && r.audit.safety.gates) || []).map((g) => g.gate),
      claimsRejected: r.audit.claimsRejected.length, regenerated: r.audit.regenerated, partGate: r.audit.partGate && r.audit.partGate.outcome,
      engineMs: r.ms, timings: r.audit.timings, provider: r.audit.provider },
    safetyStopUse: Boolean(r.orch.safety && r.orch.safety.stopUse), partCount: view.parts.length, ms: Date.now() - t0 });
  await persistTranscriptTurn(obs, messages, view, r.orch, rid, r.audit);
  return respond(200, view);
}

// ---- state token secrets (the signed session token every ac2 turn carries, state-token.js) ------------
let _stateTokenSecretsLoader = () => stateTokenMod.loadSecrets();
function setStateTokenDepsForTests({ secretsLoader } = {}) {
  _stateTokenSecretsLoader = secretsLoader || (() => stateTokenMod.loadSecrets());
}

// ---- ac2 turn response -> retailer-neutral view ------------------------------
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

  // needsModel: the part gate needs the customer's model number before it can recommend a part.
  const needsModel = Boolean(orch.modelRequired);

  const label = (codeResult && codeResult.meaning) || (orch.diagnosis && orch.diagnosis.summary) || null;

  // Customer SAFETY INFORMATION — pre-written, evidence-backed text attached by knowledge id by the
  // ac2 turn (knowledge/safety-information.json) and passed through verbatim. We surface ONLY the
  // customer-facing fields (text + classification); provenance/source internals stay server-side.
  // The `text` is passed through byte-for-byte (never rewritten). Suppressed on a safety-stop (that
  // reply already leads with the authoritative action). Absent => null (UI renders nothing).
  const si = orch.safetyInformation;
  const safetyInformation = (!isSafety && si && typeof si.text === 'string' && si.text.trim())
    ? { text: si.text, classification: si.classification || null }
    : null;

  // Customer instructional media (image/diagram/video) supporting a check on the grounded node.
  // Already a customer-safe subset from the engine; re-project defensively so no extra field can leak
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

  return {
    requestId: rid,
    traceId: orch.traceId || null,
    reply,
    advisory,
    safety: Boolean(isSafety),
    // Retired with the journey controller (no structured pending request, no unconfirmed photo reading); kept null in
    // the browser contract.
    pendingRequest: null,
    safetyInformation,
    needsModel,
    extractedModel: null,
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

// Exported for deterministic unit tests (no network / engine needed).
module.exports.toWhichPartView = toWhichPartView;
module.exports.latestImageOf = latestImageOf;
module.exports.conversationWindow = conversationWindow;
module.exports.setTranscriptStore = setTranscriptStore;
module.exports.setStateTokenDepsForTests = setStateTokenDepsForTests;
module.exports.setBenchmarkDepsForTests = setBenchmarkDepsForTests;
module.exports.setTranscriptReviewJudge = setTranscriptReviewJudge;
module.exports.setRateLimitStoreForTests = setRateLimitStoreForTests;
module.exports.setMediaAdminStore = setMediaAdminStore;
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
module.exports.setAc2DepsForTests = setAc2DepsForTests;
