'use strict';

/**
 * Admin test area: the question library, the run builder, ACQ-100 and GOLD v2 benchmark control plane, routing
 * overrides, transcripts and reviews of benchmark runs.
 */
const aiConfig = require('../ai-config.js');
// ---- ACQ-100 quality benchmark (admin control plane) ------------------------
// whichpart-api is the CONTROL PLANE: it enqueues runs, lists/reads them, sets
// cancel, and reports worker heartbeat — all from S3 (the learning bucket). The
// local worker daemon is the EXECUTION PLANE (it runs journeys against this same
// customer path). No API keys are ever stored in run records or returned.
const acqScoring = require('../benchmark/acq-scoring.js');
const acqCorpus = require('../benchmark/acq-corpus.js');
const acqGrade = require('../benchmark/acq-grade.js');
const acqJudge = require('../benchmark/acq-judge.js');
// GOLD v2 is the ACTIVE, recommended quality benchmark (semantic-first, judges
// the whole conversation with a critical-failure override, Jev as the fixed
// judge). ACQ-100 above remains as NON-AUTHORITATIVE legacy. The config endpoint
// labels both so no score is ever shown unlabelled.
const goldV2Version = require('../benchmark/gold-v2/version.js');
// Batch routing override (benchmark/routing-override.js): the API reads its status, blocks Settings
// inference writes while a batch owns live routing, recovers orphans on its 15-minute schedule and
// applies admin conflict resolutions. The worker on the Private AI machine is the normal owner.
const { planOverride } = require('../benchmark/routing-override.js');
const benchmarkTarget = require('../benchmark/target.js');
const acqLibrary = require('../benchmark/acq-library.js');
// Engineer transcript reviews — human annotation stored under acq/reviews/ (same
// bucket/prefix/IAM as runs). Deliberately separate from run scores + scenario gold.
const { createReviewStore } = require('../benchmark/acq-reviews.js');
const { ACQ_JUDGE_MODEL } = require('../config.js');
const { log } = require('../log.js');
const { queryParam, readJson, authPath, respond } = require('../http-io.js');
const { requireSession, requireAdmin } = require('../session.js');
const { acqS3 } = require('../s3.js');
const {
  acqStore, routingOverride, routingOverrideStatusSafe, recoverRoutingOverride,
} = require('../benchmark-state.js');

const acqLib = acqLibrary.createLibrary({ s3: acqS3 });

const acqReviews = createReviewStore({ s3: acqS3 });

/** "Private AI → Private AI" / "Frontier → Private AI" from a run's candidate config. */
function providerPairLabel(config) {
  const lbl = (p) => (p && p.provider === 'openai') ? 'Frontier' : 'Private AI';
  return `${lbl(config && config.understand)} \u2192 ${lbl(config && config.compose)}`;
}
/** MACHINE verdict for a single journey result (mirrors the run-level classifyRun). */
function verdictForResult(r) {
  if (!r) return 'UNKNOWN';
  if ((r.hardViolations || []).length) return 'FAILED';
  if (!r.reachedOutcome) return 'NEEDS REVIEW';
  return 'GOOD';
}
/** Human-readable EXPECTED summary from the pinned scenario gold — only present fields. */
function summariseExpected(gold) {
  if (!gold) return null;
  const out = {};
  if (gold.expectedOutcome) out.outcome = gold.expectedOutcome;
  const comps = (gold.expectedComponents && gold.expectedComponents.length ? gold.expectedComponents : gold.goldSuspects) || [];
  if (comps.length) out.components = comps;
  if (gold.followUpTargetFact) out.shouldAsk = gold.followUpTargetFact;
  if (gold.mustSafetyStop) out.safety = 'Must trigger a safety stop';
  if (gold.mustNotPart) out.mustNotPart = true;
  if (gold.forbiddenOutcomes && gold.forbiddenOutcomes.length) out.mustNotDo = gold.forbiddenOutcomes;
  if (gold.idealTurns || gold.maxTurns) out.turns = { ideal: gold.idealTurns || null, max: gold.maxTurns || null };
  if (gold.expectMedia) out.expectMedia = true;
  return out;
}
/** Human-readable ACTUAL summary from the persisted per-journey result. */
function summariseActual(r) {
  if (!r) return null;
  const hv = r.hardViolations || [];
  const last = (r.transcript || [])[(r.transcript || []).length - 1] || {};
  const out = {
    reachedOutcome: !!r.reachedOutcome,
    turns: r.assistantTurns != null ? r.assistantTurns : (r.transcript || []).length,
    hardViolations: hv,
    safety: (hv.indexOf('FAILED_SAFETY_STOP') >= 0 || hv.indexOf('UNSAFE_ADVICE') >= 0) ? 'Safety issue' : 'No safety issue',
  };
  if (last.suggestedChecks && last.suggestedChecks.length) out.suggestedChecks = last.suggestedChecks;
  return out;
}

/** Ensure the library is seeded from the ACQ-100 corpus (idempotent). */
async function ensureLibrary() {
  const raw = acqCorpus.loadCorpus();
  return acqLib.ensureSeeded(raw.journeys);
}
/** Set of journeyIds that have ever participated in a persisted run (for safe-delete + detail). */
async function journeyRunUsage() {
  // Every persisted run counts as history (listRuns reads all run objects anyway; the cap only
  // trimmed the result). A scenario used by an older run must never be hard-deleted.
  const runs = await acqStore.listRuns(Number.MAX_SAFE_INTEGER);
  const used = new Set(); const recent = {};
  for (const r of runs) {
    const ids = (r.manifest && r.manifest.journeys) ? r.manifest.journeys.map((m) => m.journeyId) : [];
    for (const id of ids) { used.add(id); (recent[id] = recent[id] || []).push({ runId: r.runId, label: r.label, status: r.status, at: r.startedAt }); }
  }
  return { used, recent };
}
// ---- Test-area route gate + input hygiene ----
// Run ids are minted by acq-store (`acq-<iso>-<rand>`); scenario ids are short slugs (WM-001, VC-014).
// Both are used inside S3 object keys, so anything else is rejected before a store call.
const RUN_ID_RE = /^acq-[A-Za-z0-9-]{1,80}$/;
const JOURNEY_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const TEST_ADMIN_MAX_BODY = 64 * 1024;
const MAX_MANUAL_IDS = 200;
function isRunId(v) { return typeof v === 'string' && RUN_ID_RE.test(v); }
// 'new' is reserved for the Admin "#test/scenario/new" route.
function isJourneyId(v) { return typeof v === 'string' && JOURNEY_ID_RE.test(v) && v.toLowerCase() !== 'new'; }
function invalidId(what) { return respond(400, { error: 'invalid ' + what }); }
/**
 * Method check → admin auth → body cap → handler. Unsupported methods get 405 before any session
 * lookup; non-admin / missing sessions get 401 before any store access. Sets the admin-api log's
 * auth category (via requireAdmin) so these routes no longer log as "not-checked".
 */
async function testAdminRoute(event, method, handlers) {
  const handler = Object.prototype.hasOwnProperty.call(handlers, method) ? handlers[method] : null;
  if (!handler) return respond(405, { error: Object.keys(handlers).join(' or ') + ' only' });
  if (!(await requireAdmin(event))) return respond(401, { error: 'Unauthorized' });
  if (method !== 'GET' && String((event && event.body) || '').length > TEST_ADMIN_MAX_BODY) return respond(413, { error: 'request body too large' });
  try {
    return await handler(event);
  } catch (e) {
    // A store/network failure is a clean JSON 500 (never an unhandled Lambda error or a stack trace).
    log({ evt: 'test-admin-error', path: String(authPath(event) || '').split('?')[0].slice(0, 120), error: String((e && e.message) || e).slice(0, 160) });
    return respond(500, { error: 'The test service could not complete this request. Try again.' });
  }
}
/** Library writes carry an optional optimistic-concurrency precondition (the record's updatedAt). */
function libraryWriteError(e) {
  if (e && e.code === 'STALE') return respond(409, { error: 'STALE', message: 'This scenario changed since you opened it. Reload it, then make your change again.', updatedAt: e.updatedAt || null });
  if (e && e.code === 'NOT_FOUND') return respond(404, { error: 'not found' });
  return respond(400, { error: e.message, problems: (e && e.problems) || null });
}

/**
 * Phase 7: where a batch run goes, and the production intent it needs (benchmark/target.js). The default is staging;
 * production needs confirmProduction, and confirmProductionRouting when the run would change live AI routing.
 * Returns {snapshotFields} to merge into the run snapshot, or {response} to return.
 */
async function batchTarget(b, understand, compose, s) {
  let plan = null;
  try {
    const cur = await aiConfig.loadConfigDocument();
    if (cur && cur.status === 'ok' && cur.doc) plan = planOverride(cur.doc, { understand, compose });
  } catch { plan = null; }
  const d = benchmarkTarget.decideTarget(b, { plan, by: s.email || s.username || 'admin' });
  if (!d.ok) return { response: respond(d.status, d.body) };
  log({ evt: 'benchmark-target', target: d.target, routing: Boolean(d.productionIntent && d.productionIntent.routing) });
  return { snapshotFields: { target: d.target, productionIntent: d.productionIntent } };
}
/** While a routing-override CONFLICT is unresolved no new batch may be queued (they would wait forever). */
async function routingConflictResponse() {
  const ro = await routingOverrideStatusSafe();
  if (ro && ro.blocked) {
    return respond(409, { error: 'ROUTING_OVERRIDE_CONFLICT', message: 'Batch run ' + ro.runId + ' could not safely restore live AI routing. Resolve it in Test → Batch before starting another run.', routingOverride: ro });
  }
  return null;
}
/** POST /admin/benchmark/routing-override/resolve { runId, decision, note, expectedRevision } */
async function routingOverrideResolve(event) {
  const s = await requireSession(event); if (!s || !s.isAdmin) return respond(401, { error: 'Unauthorized' });
  const b = readJson(event);
  if (!b || !isRunId(b.runId)) return invalidId('run id');
  if (b.decision !== 'keep-current' && b.decision !== 'restore-pre-run') return respond(400, { error: 'decision must be keep-current or restore-pre-run' });
  const note = typeof b.note === 'string' ? b.note.trim() : '';
  if (note.length < 5 || note.length > 300) return respond(400, { error: 'A reason of 5–300 characters is required.', details: ['note'] });
  if (b.expectedRevision != null && (typeof b.expectedRevision !== 'string' || !/^[0-9a-f]{16}$/.test(b.expectedRevision))) return respond(400, { error: 'expectedRevision is malformed' });
  const r = await routingOverride.resolve({ runId: b.runId, decision: b.decision, note, by: s.email || s.username || 'admin', expectedRevision: b.expectedRevision || null });
  if (!r.ok) {
    const st = r.code === 'not_found' ? 404 : (r.code === 'stale' ? 409 : 400);
    return respond(st, { error: r.code, message: r.code === 'stale' ? 'Live configuration changed since you reviewed it. Reload and review again.' : 'Could not resolve the routing override (' + r.code + ').', currentRevision: r.currentRevision || null });
  }
  log({ evt: 'settings-change', kind: 'batch-routing-resolution', by: s.email || s.username || 'admin', fields: ['routing-override'], runId: b.runId, decision: b.decision });
  return respond(200, { routingOverride: r.lock });
}
/** POST /admin/benchmark/routing-override/recover — run orphan recovery now (same rules as the schedule). */
async function routingOverrideRecover(event) {
  const s = await requireSession(event); if (!s || !s.isAdmin) return respond(401, { error: 'Unauthorized' });
  const r = await recoverRoutingOverride('admin:' + (s.email || s.username || 'admin'));
  return respond(200, { action: r.action, why: r.why || null, routingOverride: await routingOverrideStatusSafe() });
}

async function libraryImport(event) {
  if (!(await requireAdmin(event))) return respond(401, { error: 'Unauthorized' });
  return respond(200, await ensureLibrary());
}

// ---- Question Library endpoints (admin) ----
async function libraryList(event) {
  const s = await requireSession(event); if (!s || !s.isAdmin) return respond(401, { error: 'Unauthorized' });
  await ensureLibrary();
  const L = await acqLib.loadLibrary();
  const qs = (event && event.queryStringParameters) || {};
  const filters = { q: qs.q, family: qs.family, difficulty: qs.difficulty, category: qs.category, source: qs.source, reviewStatus: qs.reviewStatus,
    multiTurn: qs.multiTurn === 'true' ? true : qs.multiTurn === 'false' ? false : undefined,
    enabled: qs.enabled === 'true' ? true : qs.enabled === 'false' ? false : undefined,
    includeArchived: qs.includeArchived === 'true' };
  return respond(200, { metrics: acqLib.metrics(L), journeys: acqLib.listJourneys(L, filters), categories: acqLibrary.CATEGORIES, families: acqLibrary.FAMILIES, sourceTypes: acqLibrary.SOURCE_TYPES, reviewStates: acqLibrary.REVIEW_STATES });
}
async function libraryJourneyGet(event) {
  const s = await requireSession(event); if (!s || !s.isAdmin) return respond(401, { error: 'Unauthorized' });
  const id = queryParam(event, 'id'); if (!id) return respond(400, { error: 'id required' });
  if (!isJourneyId(id)) return invalidId('id');
  const j = await acqLib.getJourney(id); if (!j) return respond(404, { error: 'not found' });
  const { recent } = await journeyRunUsage();
  return respond(200, { journey: j, recentResults: recent[id] || [] });
}
async function libraryCreate(event) {
  const s = await requireSession(event); if (!s || !s.isAdmin) return respond(401, { error: 'Unauthorized' });
  const b = readJson(event); if (!b || typeof b !== 'object' || Array.isArray(b)) return respond(400, { error: 'invalid JSON' });
  if (b.journeyId != null && !isJourneyId(b.journeyId)) return invalidId('journeyId');
  try { const rec = await acqLib.createJourney(b, s.email || s.username); return respond(200, rec); }
  catch (e) { return libraryWriteError(e); }
}
// Library writes take the client's last-seen `expectedUpdatedAt` (optional for older clients):
// a mismatch is a 409 so a stale editor never silently overwrites someone else's change.
function libraryWriteBody(event) {
  const b = readJson(event);
  if (!b || typeof b !== 'object' || Array.isArray(b) || !b.id) return { error: respond(400, { error: 'id required' }) };
  if (!isJourneyId(b.id)) return { error: invalidId('id') };
  if (b.changes != null && (typeof b.changes !== 'object' || Array.isArray(b.changes))) return { error: respond(400, { error: 'changes must be an object' }) };
  if (b.expectedUpdatedAt != null && typeof b.expectedUpdatedAt !== 'string') return { error: respond(400, { error: 'expectedUpdatedAt must be a string' }) };
  return { body: b, opts: { expectedUpdatedAt: b.expectedUpdatedAt || null } };
}
async function libraryEdit(event) {
  const s = await requireSession(event); if (!s || !s.isAdmin) return respond(401, { error: 'Unauthorized' });
  const w = libraryWriteBody(event); if (w.error) return w.error;
  try { const rec = await acqLib.editJourney(w.body.id, w.body.changes || {}, s.email || s.username, w.opts); return respond(200, rec); }
  catch (e) { return libraryWriteError(e); }
}
async function libraryDuplicate(event) {
  const s = await requireSession(event); if (!s || !s.isAdmin) return respond(401, { error: 'Unauthorized' });
  const b = readJson(event); if (!b || !b.id) return respond(400, { error: 'id required' });
  if (!isJourneyId(b.id)) return invalidId('id');
  if (b.overrides != null && (typeof b.overrides !== 'object' || Array.isArray(b.overrides))) return respond(400, { error: 'overrides must be an object' });
  if (b.overrides && b.overrides.journeyId != null && !isJourneyId(b.overrides.journeyId)) return invalidId('journeyId');
  try { const rec = await acqLib.duplicateJourney(b.id, b.overrides || {}, s.email || s.username); return respond(200, rec); }
  catch (e) { return libraryWriteError(e); }
}
async function libraryFlags(event) {
  const s = await requireSession(event); if (!s || !s.isAdmin) return respond(401, { error: 'Unauthorized' });
  const w = libraryWriteBody(event); if (w.error) return w.error;
  try { const rec = await acqLib.setFlags(w.body.id, w.body.changes || {}, s.email || s.username, w.opts); return respond(200, rec); }
  catch (e) { return libraryWriteError(e); }
}
async function libraryDelete(event) {
  const s = await requireSession(event); if (!s || !s.isAdmin) return respond(401, { error: 'Unauthorized' });
  const w = libraryWriteBody(event); if (w.error) return w.error;
  const { used } = await journeyRunUsage();
  try { const r = await acqLib.safeDelete(w.body.id, used.has(w.body.id), s.email || s.username, w.opts); return respond(200, r); }
  catch (e) { return libraryWriteError(e); }
}

// ---- Run Builder: build + enqueue (LOCAL default; FRONTIER gated) ----
function usesFrontier(u, c) { return (u && u.provider === 'openai') || (c && c.provider === 'openai'); }
async function benchmarkBuildRun(event) {
  const s = await requireSession(event); if (!s || !s.isAdmin) return respond(401, { error: 'Unauthorized' });
  const b = readJson(event); if (!b || typeof b !== 'object' || Array.isArray(b)) return respond(400, { error: 'invalid JSON' });
  if (b.manualIds != null) {
    if (!Array.isArray(b.manualIds) || b.manualIds.length > MAX_MANUAL_IDS || !b.manualIds.every(isJourneyId)) return respond(400, { error: 'manualIds must be up to ' + MAX_MANUAL_IDS + ' scenario ids' });
  }
  await ensureLibrary();
  const [L, cfg, keyConfigured] = await Promise.all([acqLib.loadLibrary(), aiConfig.loadConfig(), aiConfig.isKeyConfigured()]);
  const understand = b.understand || { provider: 'lmstudio', model: '' };
  const compose = b.compose || { provider: 'lmstudio', model: '' };
  const judgeMode = b.judgeMode === 'DETERMINISTIC_ONLY' ? 'DETERMINISTIC_ONLY' : 'FULL';
  // FRONTIER gating (non-negotiable): experiment definition + explicit confirm.
  if (usesFrontier(understand, compose)) {
    if (!keyConfigured) return respond(400, { error: 'Frontier requires a saved OpenAI API key.' });
    if (!b.experiment || !b.experiment.name || !b.experiment.hypothesis) return respond(400, { error: 'FRONTIER_EXPERIMENT_REQUIRED', message: 'A frontier experiment needs a name and a hypothesis.' });
    if (b.confirmFrontier !== true) return respond(400, { error: 'FRONTIER_CONFIRMATION_REQUIRED', message: 'Explicit confirmation required to make paid frontier API calls.' });
  }
  const seed = (b.mode === 'RANDOM' || b.mode === 'BALANCED') ? (b.seed != null ? b.seed : (Date.now() % 1000000)) : null;
  const manifest = acqLibrary.buildManifest({ lib: L, mode: b.mode || 'BALANCED', n: b.n, filters: b.filters || {}, seed, manualIds: b.manualIds }, acqLib);
  if (!manifest.journeyCount) return respond(400, { error: 'No journeys selected (check filters/approved pool).' });
  const raw = acqCorpus.loadCorpus();
  const snapshot = {
    benchmarkVersion: acqScoring.ACQ_BENCHMARK_VERSION, scorerVersion: acqScoring.ACQ_SCORER_VERSION, pricingVersion: acqScoring.PRICING_VERSION,
    judge: { provider: 'openai', model: ACQ_JUDGE_MODEL, promptHash: acqJudge.judgePromptHash(raw.journeys[0]), mode: judgeMode },
    understand, compose, manifest, experiment: b.experiment || null, judgeMode, journeyCount: manifest.journeyCount,
  };
  const tgt = await batchTarget(b, understand, compose, s); if (tgt.response) return tgt.response;
  Object.assign(snapshot, tgt.snapshotFields);
  const blockedBy = await routingConflictResponse(); if (blockedBy) return blockedBy;
  const rec = await acqStore.enqueueRun(snapshot, { email: s.email || s.username, label: b.label });
  return respond(200, { runId: rec.runId, status: rec.status, label: rec.label, runMode: rec.runMode, journeyCount: manifest.journeyCount, seed });
}

async function benchmarkRerun(event) {
  const s = await requireSession(event); if (!s || !s.isAdmin) return respond(401, { error: 'Unauthorized' });
  const b = readJson(event); if (!b || !b.id) return respond(400, { error: 'id required' });
  if (!isRunId(b.id)) return invalidId('run id');
  const src = await acqStore.getRun(b.id); if (!src) return respond(404, { error: 'source run not found' });
  const manifest = src.manifest || (src.journeyCount ? null : null);
  if (!manifest) return respond(400, { error: 'source run has no frozen manifest (legacy run) — cannot rerun exact set' });
  const understand = b.understand || src.config.understand;
  const compose = b.compose || src.config.compose;
  const judgeMode = b.judgeMode || src.judgeMode || 'FULL';
  const keyConfigured = await aiConfig.isKeyConfigured();
  if (usesFrontier(understand, compose)) {
    if (!keyConfigured) return respond(400, { error: 'Frontier requires a saved OpenAI API key.' });
    if (!b.experiment || !b.experiment.name || !b.experiment.hypothesis) return respond(400, { error: 'FRONTIER_EXPERIMENT_REQUIRED' });
    if (b.confirmFrontier !== true) return respond(400, { error: 'FRONTIER_CONFIRMATION_REQUIRED' });
  }
  const raw = acqCorpus.loadCorpus();
  const snapshot = {
    benchmarkVersion: src.benchmarkVersion, scorerVersion: acqScoring.ACQ_SCORER_VERSION, pricingVersion: acqScoring.PRICING_VERSION,
    judge: { provider: 'openai', model: ACQ_JUDGE_MODEL, promptHash: acqJudge.judgePromptHash(raw.journeys[0]), mode: judgeMode },
    understand, compose, manifest, experiment: b.experiment || null, judgeMode, journeyCount: manifest.journeyCount,
  };
  const tgt = await batchTarget(b, understand, compose, s); if (tgt.response) return tgt.response;
  Object.assign(snapshot, tgt.snapshotFields);
  const blockedBy = await routingConflictResponse(); if (blockedBy) return blockedBy;
  const rec = await acqStore.enqueueRun(snapshot, { email: s.email || s.username, label: b.label || (src.label + ' (rerun)') });
  return respond(200, { runId: rec.runId, status: rec.status, label: rec.label, journeyCount: manifest.journeyCount, sameQuestionsAs: src.runId });
}

async function benchmarkEstimate(event) {
  const s = await requireSession(event); if (!s || !s.isAdmin) return respond(401, { error: 'Unauthorized' });
  const b = readJson(event) || {};
  await ensureLibrary();
  const L = await acqLib.loadLibrary();
  const seed = (b.mode === 'RANDOM' || b.mode === 'BALANCED') ? (b.seed != null ? b.seed : 0) : null;
  const manifest = acqLibrary.buildManifest({ lib: L, mode: b.mode || 'BALANCED', n: b.n, filters: b.filters || {}, seed, manualIds: b.manualIds }, acqLib);
  const resolved = acqLibrary.resolveManifest(L, manifest);
  const maxTurns = resolved.reduce((a, r) => a + ((r.gold && r.gold.maxTurns) || 4), 0);
  const understand = b.understand || { provider: 'lmstudio' }; const compose = b.compose || { provider: 'lmstudio' };
  const frontierStages = [understand.provider === 'openai' ? 'UNDERSTAND' : null, compose.provider === 'openai' ? 'COMPOSE' : null].filter(Boolean);
  return respond(200, {
    journeyCount: manifest.journeyCount, expectedMaxTurns: maxTurns, candidateFrontierStages: frontierStages,
    frontierExperiment: frontierStages.length > 0, judge: { provider: 'openai', model: ACQ_JUDGE_MODEL, mode: b.judgeMode || 'FULL' },
    candidateApiCost: 'NOT AVAILABLE — TOKEN USAGE NOT EXPOSED AT CUSTOMER BOUNDARY',
    judgeApiNote: (b.judgeMode === 'DETERMINISTIC_ONLY') ? 'No judge calls (deterministic-only): subjective dimensions NOT JUDGED.' : 'Judge makes paid API calls per journey even for LOCAL/LOCAL runs.',
    seed,
  });
}

/** Map the saved ai-config into a candidate {understand,compose} provider/model pair. */
function acqCandidateFromConfig(cfg) {
  const local = { provider: 'lmstudio', model: cfg.local.model || '(loaded model)' };
  const frontier = { provider: 'openai', model: cfg.frontier.model || null };
  return {
    understand: cfg.routing.understand === 'frontier' ? frontier : local,
    compose: cfg.routing.compose === 'frontier' ? frontier : local,
  };
}

async function acqBenchmarkConfig(event) {
  const session = await requireSession(event);
  if (!session || !session.isAdmin) return respond(401, { error: 'Unauthorized' });
  const [cfg, keyConfigured, jevLoaded, worker] = await Promise.all([
    aiConfig.loadConfig(),
    aiConfig.isKeyConfigured(),
    aiConfig.loadJevWithStatus(),
    acqStore.workerStatus(),
  ]);
  const raw = acqCorpus.loadCorpus();
  const dist = acqCorpus.distribution(raw);
  return respond(200, {
    benchmarkVersion: acqScoring.ACQ_BENCHMARK_VERSION,
    // Authoritative labelling of which quality benchmark governs. GOLD v2 is the
    // active/recommended suite; ACQ-100 is retained only as legacy and must never
    // be presented as the current quality score.
    qualityBenchmark: {
      active: {
        id: goldV2Version.BENCHMARK,
        label: 'GOLD v2',
        status: 'active',
        recommended: true,
        judgeModel: goldV2Version.JUDGE_MODEL,
        judgePromptVersion: goldV2Version.JUDGE_PROMPT_VERSION,
        scenarioCount: 50,
        concurrency: goldV2Version.CONCURRENCY,
        passPolicy: `mean \u2265 ${goldV2Version.PASS_MIN}/4, safety \u2265 ${goldV2Version.SAFETY_MIN}/4, no critical failure`,
        run: 'node services/whichpart-api/benchmark/gold-v2/run-baseline.mjs',
        note: 'Semantic-first: judges the whole conversation on ten 0\u20134 dimensions with a critical-failure override.',
      },
      legacy: {
        id: acqScoring.ACQ_BENCHMARK_VERSION,
        label: 'ACQ-100',
        status: 'legacy',
        recommended: false,
        authoritative: false,
        note: 'Retained for history only. Not the current quality score.',
      },
    },
    journeyCount: dist.total,
    distribution: { byFamily: dist.byFamily, multiTurn: dist.multiTurn, singleTurn: dist.singleTurn },
    weights: acqScoring.WEIGHTS,
    candidate: acqCandidateFromConfig(cfg),
    judge: { provider: 'openai', model: ACQ_JUDGE_MODEL, configured: keyConfigured, promptHash: acqJudge.judgePromptHash(raw.journeys[0]) },
    // Correctness-first, human labels for the THREE distinct AI identities (guards
    // against the quality reviewer/judge model masquerading as the local model).
    setup: aiConfig.describeSetup({
      cfg, judgeModel: ACQ_JUDGE_MODEL, keyConfigured,
      jevConfigured: Boolean(jevLoaded.public && jevLoaded.public.credentialConfigured),
    }),
    worker,
    // Who (if anyone) currently owns live AI routing, and the restore state. Secret-free.
    routingOverride: await routingOverrideStatusSafe(),
    concurrency: 1,
    tokenUsage: 'NOT AVAILABLE AT CUSTOMER BOUNDARY',
    apiCost: 'NOT AVAILABLE / NOT CONFIGURED',
  });
}

async function acqBenchmarkRun(event) {
  const session = await requireSession(event);
  if (!session || !session.isAdmin) return respond(401, { error: 'Unauthorized' });
  const body = readJson(event) || {};
  const [cfg, keyConfigured] = await Promise.all([aiConfig.loadConfig(), aiConfig.isKeyConfigured()]);
  // Explicit config (for the 4-combo comparison) or the persisted admin config.
  const candidate = (body.understand && body.compose) ? { understand: body.understand, compose: body.compose } : acqCandidateFromConfig(cfg);
  // Refuse to enqueue a frontier candidate with no key (no silent fallback).
  const usesFrontier = candidate.understand.provider === 'openai' || candidate.compose.provider === 'openai';
  if (usesFrontier && !keyConfigured) return respond(400, { error: 'Frontier candidate requires a saved OpenAI API key.' });
  const raw = acqCorpus.loadCorpus();
  const snapshot = {
    benchmarkVersion: acqScoring.ACQ_BENCHMARK_VERSION,
    scorerVersion: acqScoring.ACQ_SCORER_VERSION,
    pricingVersion: acqScoring.PRICING_VERSION,
    judge: { provider: 'openai', model: ACQ_JUDGE_MODEL, promptHash: acqJudge.judgePromptHash(raw.journeys[0]) },
    understand: candidate.understand,
    compose: candidate.compose,
    journeyCount: raw.journeys.length,
  };
  const tgt = await batchTarget(body, candidate.understand, candidate.compose, session); if (tgt.response) return tgt.response;
  Object.assign(snapshot, tgt.snapshotFields);
  const blockedBy = await routingConflictResponse(); if (blockedBy) return blockedBy;
  const rec = await acqStore.enqueueRun(snapshot, { email: session.email || session.username, label: body.label });
  return respond(200, { runId: rec.runId, status: rec.status, label: rec.label });
}

async function acqBenchmarkRuns(event) {
  const session = await requireSession(event);
  if (!session || !session.isAdmin) return respond(401, { error: 'Unauthorized' });
  const runs = await acqStore.listRuns(100);
  const worker = await acqStore.workerStatus();
  return respond(200, { runs, worker });
}

async function acqBenchmarkRunGet(event) {
  const session = await requireSession(event);
  if (!session || !session.isAdmin) return respond(401, { error: 'Unauthorized' });
  const id = queryParam(event, 'id');
  if (!id) return respond(400, { error: 'id required' });
  if (!isRunId(id)) return invalidId('run id');
  const rec = await acqStore.getRun(id);
  if (!rec) return respond(404, { error: 'run not found' });
  return respond(200, rec);
}

async function acqBenchmarkCancel(event) {
  const session = await requireSession(event);
  if (!session || !session.isAdmin) return respond(401, { error: 'Unauthorized' });
  const body = readJson(event) || {};
  if (!body.id) return respond(400, { error: 'id required' });
  if (!isRunId(body.id)) return invalidId('run id');
  const existing = await acqStore.getRun(body.id);
  if (!existing) return respond(404, { error: 'run not found' });
  const rec = await acqStore.requestCancel(body.id);
  return respond(200, { runId: rec.runId, status: rec.status, cancelRequested: rec.cancelRequested });
}

/**
 * GET /admin/benchmark/transcript?run=<runId>&journey=<journeyId>
 * Compose a human-readable conversation-review payload from EXISTING persisted
 * data: the run's per-journey result (transcript + scores) + the scenario gold
 * resolved at the VERSION the run pinned (never the current library version) +
 * the engineer review. Read-only; mutates nothing.
 */
async function acqTranscriptGet(event) {
  const session = await requireSession(event);
  if (!session || !session.isAdmin) return respond(401, { error: 'Unauthorized' });
  const runId = queryParam(event, 'run');
  const journeyId = queryParam(event, 'journey');
  if (!runId || !journeyId) return respond(400, { error: 'run and journey required' });
  if (!isRunId(runId) || !isJourneyId(journeyId)) return invalidId('run or journey');
  const rec = await acqStore.getRun(runId);
  if (!rec) return respond(404, { error: 'run not found' });
  const result = (rec.results || []).find((r) => r.journeyId === journeyId);
  if (!result) return respond(404, { error: 'no conversation for that scenario in this run' });
  // Authoritative pinned version: the run's frozen manifest. Fall back to the
  // version stamped on the result. NEVER silently use the current library version.
  const manEntry = ((rec.manifest && rec.manifest.journeys) || []).find((m) => m.journeyId === journeyId);
  const pinnedVersion = manEntry ? manEntry.version : (result.journeyVersion != null ? result.journeyVersion : null);
  let expected = null; let scenarioTitle = journeyId;
  await ensureLibrary();
  const journey = await acqLib.getJourney(journeyId);
  if (journey) {
    scenarioTitle = journey.title || journeyId;
    const resolveTo = pinnedVersion == null ? journey.currentVersion : pinnedVersion;
    const resolved = acqLibrary.resolveVersion(journey, resolveTo);
    if (resolved && resolved.gold) expected = summariseExpected(resolved.gold);
  }
  const review = (await acqReviews.getReview(runId, journeyId)) || { runId, journeyId, state: 'not_reviewed', note: '', reviewer: null, reviewedAt: null };
  return respond(200, {
    runId, journeyId,
    provenance: {
      scenarioId: journeyId,
      scenarioTitle,
      journeyVersion: pinnedVersion,
      family: result.family || (journey && journey.family) || null,
      runLabel: rec.label || null,
      runDate: rec.completedAt || rec.startedAt || null,
      providerPair: providerPairLabel(rec.config),
      config: rec.config || null,
      judgeMode: rec.judgeMode || 'FULL',
      turns: result.assistantTurns != null ? result.assistantTurns : (result.transcript || []).length,
      totalElapsedMs: result.totalElapsedMs != null ? result.totalElapsedMs : null,
      runMode: rec.runMode || null,
    },
    transcript: result.transcript || [],
    expected,
    actual: summariseActual(result),
    result: {
      verdict: verdictForResult(result),
      quality: result.quality != null ? result.quality : null,
      judged: !!result.judged,
      dimensions: result.dimensions || {},
      notJudged: result.notJudged || [],
      hardViolations: result.hardViolations || [],
      reachedOutcome: !!result.reachedOutcome,
      turnsToOutcome: result.turnsToOutcome != null ? result.turnsToOutcome : null,
      latencyMs: result.totalElapsedMs != null ? result.totalElapsedMs : null,
      perTurnLatencyMs: result.perTurnLatencyMs || [],
    },
    review,
  });
}

/**
 * GET /admin/benchmark/scenario-conversations?journey=<journeyId>
 * All past conversations for one scenario across completed runs — each labelled
 * with the scenario VERSION that run pinned, the candidate config, the machine
 * verdict/quality and the engineer review state. Powers "Past conversations".
 */
async function acqScenarioConversations(event) {
  const session = await requireSession(event);
  if (!session || !session.isAdmin) return respond(401, { error: 'Unauthorized' });
  const journeyId = queryParam(event, 'journey');
  if (!journeyId) return respond(400, { error: 'journey required' });
  if (!isJourneyId(journeyId)) return invalidId('journey');
  const summaries = await acqStore.listRuns(200);
  const relevant = summaries.filter((r) => r.status === 'COMPLETED' && r.manifest && (r.manifest.journeys || []).some((m) => m.journeyId === journeyId));
  const conversations = [];
  for (const sm of relevant) {
    const rec = await acqStore.getRun(sm.runId);
    if (!rec) continue;
    const result = (rec.results || []).find((x) => x.journeyId === journeyId);
    if (!result) continue;
    const manEntry = (rec.manifest.journeys || []).find((m) => m.journeyId === journeyId);
    const review = await acqReviews.getReview(sm.runId, journeyId);
    conversations.push({
      runId: sm.runId,
      runLabel: rec.label || null,
      date: rec.completedAt || rec.startedAt || null,
      providerPair: providerPairLabel(rec.config),
      journeyVersion: manEntry ? manEntry.version : (result.journeyVersion != null ? result.journeyVersion : null),
      quality: result.quality != null ? result.quality : null,
      verdict: verdictForResult(result),
      reviewState: review ? review.state : 'not_reviewed',
    });
  }
  conversations.sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));
  return respond(200, { journeyId, conversations });
}

/** GET /admin/benchmark/reviews?run=<runId> — map of journeyId -> review for a run (badges + filter). */
async function acqReviewsForRun(event) {
  const session = await requireSession(event);
  if (!session || !session.isAdmin) return respond(401, { error: 'Unauthorized' });
  const runId = queryParam(event, 'run');
  if (!runId) return respond(400, { error: 'run required' });
  if (!isRunId(runId)) return invalidId('run');
  const reviews = await acqReviews.reviewsForRun(runId);
  return respond(200, { runId, reviews });
}

/** GET /admin/benchmark/review?run=&journey= — the engineer review (default not_reviewed). */
async function acqReviewGet(event) {
  const session = await requireSession(event);
  if (!session || !session.isAdmin) return respond(401, { error: 'Unauthorized' });
  const runId = queryParam(event, 'run');
  const journeyId = queryParam(event, 'journey');
  if (!runId || !journeyId) return respond(400, { error: 'run and journey required' });
  if (!isRunId(runId) || !isJourneyId(journeyId)) return invalidId('run or journey');
  const review = await acqReviews.getReview(runId, journeyId);
  return respond(200, review || { runId, journeyId, state: 'not_reviewed', note: '', reviewer: null, reviewedAt: null });
}

/**
 * POST /admin/benchmark/review { run, journey, state, note }
 * Persist a HUMAN review. Validates state. Writes ONLY to acq/reviews/ — never
 * to the run record (score) or the library (gold). Enriches with scenario
 * version + family (read from the run) for future-RAG provenance.
 */
async function acqReviewSave(event) {
  const session = await requireSession(event);
  if (!session || !session.isAdmin) return respond(401, { error: 'Unauthorized' });
  const b = readJson(event);
  if (!b || !b.run || !b.journey) return respond(400, { error: 'run and journey required' });
  if (!isRunId(b.run) || !isJourneyId(b.journey)) return invalidId('run or journey');
  if (b.note != null && (typeof b.note !== 'string' || b.note.length > 4000)) return respond(400, { error: 'note must be text up to 4000 characters' });
  if (!acqReviews.isValidState(b.state)) return respond(400, { error: 'invalid review state', allowed: acqReviews.REVIEW_STATES });
  let journeyVersion = null; let family = null;
  const rec = await acqStore.getRun(b.run);
  if (rec) {
    const manEntry = ((rec.manifest && rec.manifest.journeys) || []).find((m) => m.journeyId === b.journey);
    const result = (rec.results || []).find((x) => x.journeyId === b.journey);
    journeyVersion = manEntry ? manEntry.version : (result && result.journeyVersion != null ? result.journeyVersion : null);
    family = result ? result.family : null;
  }
  try {
    const saved = await acqReviews.putReview({
      runId: b.run, journeyId: b.journey, scenarioId: b.journey, journeyVersion, family,
      state: b.state, note: b.note, reviewer: session.email || session.username,
    });
    return respond(200, saved);
  } catch (e) { return respond(400, { error: e.message }); }
}

async function acqBenchmarkCompare(event) {
  const session = await requireSession(event);
  if (!session || !session.isAdmin) return respond(401, { error: 'Unauthorized' });
  const a = queryParam(event, 'a'); const b = queryParam(event, 'b');
  if (!a || !b) return respond(400, { error: 'a and b run ids required' });
  if (!isRunId(a) || !isRunId(b)) return invalidId('run id');
  const [ra, rb] = await Promise.all([acqStore.getRun(a), acqStore.getRun(b)]);
  if (!ra || !rb || !ra.aggregate || !rb.aggregate) return respond(404, { error: 'both runs must exist and be complete' });
  const comparison = acqGrade.compareRuns(ra.aggregate, rb.aggregate);
  // Per-journey diff: quality + turns + questions per journeyId across both runs.
  const byId = (rec) => { const m = {}; for (const r of (rec.results || [])) m[r.journeyId] = r; return m; };
  const ma = byId(ra); const mb = byId(rb);
  const perJourney = [];
  for (const id of Object.keys(ma)) {
    const x = ma[id]; const y = mb[id]; if (!y) continue;
    perJourney.push({
      journeyId: id, family: x.family,
      a: { quality: x.quality, turns: x.assistantTurns, asked: x.clarifications, reached: x.reachedOutcome, hard: (x.hardViolations || []).length },
      b: { quality: y.quality, turns: y.assistantTurns, asked: y.clarifications, reached: y.reachedOutcome, hard: (y.hardViolations || []).length },
      qualityDelta: Math.round(((y.quality || 0) - (x.quality || 0)) * 10) / 10,
      note: diffNote(x, y),
    });
  }
  perJourney.sort((p, q) => Math.abs(q.qualityDelta) - Math.abs(p.qualityDelta));
  // Like-for-like safeguard: compare the frozen manifests. If the question sets
  // (or versions) differ, warn and compute a common-journey comparison using
  // only identical journeyId@version pairs.
  let manifestSafety = { identical: true, warning: null, commonCount: null, versionMismatches: [] };
  if (ra.manifest && rb.manifest) {
    const diff = acqLibrary.manifestDiff(ra.manifest, rb.manifest);
    manifestSafety = {
      identical: diff.identical, commonCount: diff.commonCount, aCount: diff.aCount, bCount: diff.bCount,
      versionMismatches: diff.versionMismatches,
      warning: diff.identical ? null : 'QUESTION SETS DIFFER — overall scores are not a clean A/B comparison. Use the common-journey comparison.',
    };
    if (!diff.identical) {
      const commonIds = new Set(diff.commonKeys.map((k) => k.split('@')[0]));
      const commonPerJourney = perJourney.filter((p) => commonIds.has(p.journeyId));
      manifestSafety.commonPerJourney = commonPerJourney;
      manifestSafety.commonMeanQualityDelta = commonPerJourney.length ? Math.round((commonPerJourney.reduce((a, p) => a + p.qualityDelta, 0) / commonPerJourney.length) * 10) / 10 : null;
    }
  } else {
    manifestSafety = { identical: false, warning: 'One or both runs are legacy (no frozen manifest) — not a version-pinned comparison.', commonCount: null, versionMismatches: [] };
  }
  return respond(200, { a: { runId: ra.runId, label: ra.label, config: ra.config, aggregate: ra.aggregate, judgeMode: ra.judgeMode, runMode: ra.runMode }, b: { runId: rb.runId, label: rb.label, config: rb.config, aggregate: rb.aggregate, judgeMode: rb.judgeMode, runMode: rb.runMode }, comparison, perJourney, manifestSafety });
}
function diffNote(x, y) {
  if (x.reachedOutcome && !y.reachedOutcome) return 'A correct, B wrong';
  if (!x.reachedOutcome && y.reachedOutcome) return 'B correct, A wrong';
  if ((y.clarifications || 0) > (x.clarifications || 0)) return 'B asked more questions';
  if ((y.clarifications || 0) < (x.clarifications || 0)) return 'B asked fewer questions';
  return '';
}

module.exports = {
  testAdminRoute, routingOverrideResolve, routingOverrideRecover, libraryImport, libraryList, libraryJourneyGet,
  libraryCreate, libraryEdit, libraryDuplicate, libraryFlags, libraryDelete, benchmarkBuildRun, benchmarkRerun,
  benchmarkEstimate, acqBenchmarkConfig, acqBenchmarkRun, acqBenchmarkRuns, acqBenchmarkRunGet,
  acqBenchmarkCancel, acqTranscriptGet, acqScenarioConversations, acqReviewsForRun, acqReviewGet, acqReviewSave,
  acqBenchmarkCompare,
};
