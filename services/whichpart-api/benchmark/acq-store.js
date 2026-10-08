'use strict';
/**
 * ACQ-100 run store — S3-backed persistence + queue for benchmark runs and the
 * worker heartbeat. The S3 client is INJECTED so this is unit-testable with an
 * in-memory fake (no AWS). Both whichpart-api (control plane: enqueue/read) and
 * the local worker (execution plane: claim/progress/complete) use this.
 *
 * S3 layout (bucket = whichpart-learning-*):
 *   acq/runs/<runId>.json        full run record (config snapshot, status,
 *                                progress, aggregate, per-journey results)
 *   acq/worker/status.json       worker heartbeat { workerId, at, currentRunId }
 *
 * A run record never stores API keys. It DOES record provider/model identity
 * (required for the comparison) and the benchmark/judge/pricing versions.
 */

const ACQ_PREFIX = 'acq/runs/';
const WORKER_STATUS_KEY = 'acq/worker/status.json';
const WORKER_STALE_MS = 45000; // heartbeat older than this => worker OFFLINE

const RUN_STATUS = Object.freeze({
  QUEUED: 'QUEUED',           // enqueued; waiting for a worker
  RUNNING: 'RUNNING',         // a worker has claimed it
  COMPLETED: 'COMPLETED',
  CANCELLED: 'CANCELLED',
  FAILED: 'FAILED',
  // Terminal: the run ended but production routing could not be restored/verified (or conflicted).
  // The routing override stays visible and blocks further routing batches until resolved.
  RESTORE_FAILED: 'RESTORE_FAILED',
});

/**
 * @param {object} deps
 *  - s3: { getObject(key):Promise<string|null>, putObject(key,body):Promise<void>, list(prefix):Promise<string[]> }
 *  - now?: ()=>number
 *  - randomId?: ()=>string
 */
function createStore(deps) {
  const s3 = deps.s3;
  const now = deps.now || (() => Date.now());
  const randomId = deps.randomId || (() => Math.random().toString(36).slice(2, 10));

  const key = (runId) => `${ACQ_PREFIX}${runId}.json`;

  async function getRun(runId) {
    const raw = await s3.getObject(key(runId));
    return raw ? JSON.parse(raw) : null;
  }
  async function putRun(rec) {
    await s3.putObject(key(rec.runId), JSON.stringify(rec));
    return rec;
  }
  async function listRuns(limit = 50) {
    const keys = await s3.list(ACQ_PREFIX);
    const recs = [];
    for (const k of keys) {
      const raw = await s3.getObject(k);
      if (!raw) continue;
      try {
        const r = JSON.parse(raw);
        // Return a light summary for listing (omit heavy per-journey results).
        recs.push(summarise(r));
      } catch { /* skip corrupt */ }
    }
    recs.sort((a, b) => String(b.startedAt || '').localeCompare(String(a.startedAt || '')));
    return recs.slice(0, limit);
  }

  /**
   * Enqueue a new run with an IMMUTABLE config snapshot. The snapshot is taken
   * here so a later admin change to the live provider config cannot alter an
   * in-flight/queued run. `snapshot` must include understand/compose
   * provider+model, judge provider+model+version, benchmarkVersion, pricingVersion.
   */
  async function enqueueRun(snapshot, meta = {}) {
    const runId = `acq-${new Date(now()).toISOString().replace(/[:.]/g, '-')}-${randomId()}`;
    const rec = {
      runId,
      benchmarkVersion: snapshot.benchmarkVersion,
      scorerVersion: snapshot.scorerVersion,
      judge: snapshot.judge || null,          // { provider, model, promptHash } (no key)
      pricingVersion: snapshot.pricingVersion || null,
      config: {                                 // candidate identity (recorded exactly)
        understand: snapshot.understand,        // { provider, model }
        compose: snapshot.compose,              // { provider, model }
      },
      // Phase 7: where the run goes and the recorded production intent (benchmark/target.js).
      target: snapshot.target || null,
      productionIntent: snapshot.productionIntent || null,
      label: meta.label || labelFor(snapshot),
      concurrency: 1,                           // ACQ-100 V1: always 1
      journeyCount: (snapshot.manifest && snapshot.manifest.journeyCount) || snapshot.journeyCount || null,
      // Frozen run manifest (exact journeyId+version list + selection provenance).
      // Once enqueued the run pins to this even if the library is later edited.
      manifest: snapshot.manifest || null,
      // Experiment metadata (required for FRONTIER runs; null for LOCAL validation).
      experiment: snapshot.experiment || null,
      // FULL (subjective dims judged) | DETERMINISTIC_ONLY (subjective NOT JUDGED).
      judgeMode: snapshot.judgeMode || 'FULL',
      runMode: (snapshot.understand && snapshot.understand.provider === 'openai') || (snapshot.compose && snapshot.compose.provider === 'openai') ? 'FRONTIER_EXPERIMENT' : 'LOCAL_VALIDATION',
      status: RUN_STATUS.QUEUED,
      cancelRequested: false,
      enqueuedByEmail: meta.email || null,
      startedAt: new Date(now()).toISOString(),
      claimedAt: null,
      completedAt: null,
      workerId: null,
      progress: { done: 0, total: snapshot.journeyCount || 0, currentFamily: null, currentJourneyId: null, hardViolations: 0, errors: 0 },
      aggregate: null,
      results: [],
    };
    return putRun(rec);
  }

  /**
   * Worker claims a specific queued run. With an ETag-capable S3 (getWithEtag / putIfMatch) the claim
   * is a conditional write, so two workers can never both claim the same run.
   */
  async function claimRun(runId, workerId) {
    if (s3.getWithEtag && s3.putIfMatch) {
      const got = await s3.getWithEtag(key(runId));
      if (!got || !got.body) throw new Error('run not found');
      const rec = JSON.parse(got.body);
      if (rec.status !== RUN_STATUS.QUEUED) return { claimed: false, rec };
      rec.status = RUN_STATUS.RUNNING; rec.workerId = workerId; rec.claimedAt = new Date(now()).toISOString();
      try { await s3.putIfMatch(key(runId), JSON.stringify(rec), got.etag); }
      catch (e) { if (e && e.code === 'precondition') return { claimed: false, rec: await getRun(runId) }; throw e; }
      return { claimed: true, rec };
    }
    const rec = await getRun(runId);
    if (!rec) throw new Error('run not found');
    if (rec.status !== RUN_STATUS.QUEUED) return { claimed: false, rec };
    rec.status = RUN_STATUS.RUNNING;
    rec.workerId = workerId;
    rec.claimedAt = new Date(now()).toISOString();
    await putRun(rec);
    return { claimed: true, rec };
  }
  /** Put a claimed run back in the queue (e.g. another run owns live routing). */
  async function requeueRun(runId, note) {
    const rec = await getRun(runId);
    if (!rec || rec.status !== RUN_STATUS.RUNNING) return rec;
    rec.status = RUN_STATUS.QUEUED; rec.workerId = null; rec.claimedAt = null; rec.queueNote = note || null;
    await putRun(rec);
    return rec;
  }
  /** Mirror the routing-override state onto the run record (secret-free summary). */
  async function setRoutingOverride(runId, info) {
    const rec = await getRun(runId);
    if (!rec) return null;
    rec.routingOverride = info || null;
    await putRun(rec);
    return rec;
  }
  /** Recovery: a RUNNING run whose worker vanished. */
  async function markRunLost(runId, note, restored) {
    const rec = await getRun(runId);
    if (!rec || (rec.status !== RUN_STATUS.RUNNING && rec.status !== RUN_STATUS.QUEUED)) return rec;
    rec.status = restored ? RUN_STATUS.FAILED : RUN_STATUS.RESTORE_FAILED;
    rec.outcome = 'FAILED'; rec.error = note || 'worker lost';
    rec.completedAt = new Date(now()).toISOString();
    await putRun(rec);
    return rec;
  }

  /** Find the oldest QUEUED run (FIFO) for a worker to pick up. */
  async function claimNext(workerId) {
    const summaries = await listRuns(100);
    const queued = summaries.filter((r) => r.status === RUN_STATUS.QUEUED).sort((a, b) => String(a.startedAt).localeCompare(String(b.startedAt)));
    if (!queued.length) return null;
    const { claimed, rec } = await claimRun(queued[0].runId, workerId);
    return claimed ? rec : null;
  }

  /** Persist incremental progress + append a per-journey result. */
  async function recordJourneyResult(runId, journeyResult, progress) {
    const rec = await getRun(runId);
    if (!rec) throw new Error('run not found');
    rec.results.push(journeyResult);
    rec.progress = Object.assign({}, rec.progress, progress || {});
    await putRun(rec);
    return rec;
  }

  async function completeRun(runId, aggregate, status = RUN_STATUS.COMPLETED, extra) {
    const rec = await getRun(runId);
    if (!rec) throw new Error('run not found');
    rec.aggregate = aggregate;
    rec.status = status;
    if (extra && typeof extra === 'object') Object.assign(rec, extra);
    rec.completedAt = new Date(now()).toISOString();
    await putRun(rec);
    return rec;
  }

  /** Admin requests cancellation; the worker observes the flag between journeys. */
  async function requestCancel(runId) {
    const rec = await getRun(runId);
    if (!rec) throw new Error('run not found');
    if (rec.status === RUN_STATUS.COMPLETED || rec.status === RUN_STATUS.CANCELLED) return rec;
    rec.cancelRequested = true;
    if (rec.status === RUN_STATUS.QUEUED) { rec.status = RUN_STATUS.CANCELLED; rec.completedAt = new Date(now()).toISOString(); }
    await putRun(rec);
    return rec;
  }

  // ---- worker heartbeat -----------------------------------------------------
  async function heartbeat(workerId, currentRunId) {
    const status = { workerId, at: new Date(now()).toISOString(), atMs: now(), currentRunId: currentRunId || null };
    await s3.putObject(WORKER_STATUS_KEY, JSON.stringify(status));
    return status;
  }
  async function workerStatus() {
    const raw = await s3.getObject(WORKER_STATUS_KEY);
    if (!raw) return { online: false, lastHeartbeat: null, currentRunId: null };
    let s;
    try { s = JSON.parse(raw); } catch { return { online: false, lastHeartbeat: null, currentRunId: null }; }
    const ageMs = now() - (s.atMs || 0);
    return { online: ageMs <= WORKER_STALE_MS, lastHeartbeat: s.at || null, ageMs, currentRunId: s.currentRunId || null, workerId: s.workerId || null };
  }

  return {
    RUN_STATUS, getRun, putRun, listRuns, enqueueRun, claimRun, claimNext, requeueRun, setRoutingOverride, markRunLost,
    recordJourneyResult, completeRun, requestCancel, heartbeat, workerStatus,
  };
}

function labelFor(s) {
  const u = s.understand || {}; const c = s.compose || {};
  const p = (x) => (x.provider === 'openai' ? 'FRONTIER' : 'LOCAL');
  return `${p(u)} / ${p(c)}`;
}
function summarise(r) {
  return {
    runId: r.runId, label: r.label, status: r.status, benchmarkVersion: r.benchmarkVersion,
    config: r.config, judge: r.judge, concurrency: r.concurrency,
    startedAt: r.startedAt, claimedAt: r.claimedAt, completedAt: r.completedAt,
    progress: r.progress, cancelRequested: r.cancelRequested,
    aggregate: r.aggregate, journeyCount: r.journeyCount, enqueuedByEmail: r.enqueuedByEmail,
    manifest: r.manifest || null, experiment: r.experiment || null, judgeMode: r.judgeMode || 'FULL', runMode: r.runMode || null,
    outcome: r.outcome || null, error: r.error || null,
    routingOverride: r.routingOverride ? { state: r.routingOverride.state, required: r.routingOverride.required, restore: r.routingOverride.restore || null } : null,
  };
}

function etagOf(body) { return '"' + require('crypto').createHash('md5').update(String(body)).digest('hex') + '"'; }
/** In-memory S3 shim for tests. */
function memoryS3() {
  const store = new Map();
  return {
    _store: store,
    async getObject(k) { return store.has(k) ? store.get(k) : null; },
    async putObject(k, body) { store.set(k, body); },
    async getWithEtag(k) { return store.has(k) ? { body: store.get(k), etag: etagOf(store.get(k)) } : null; },
    async putIfMatch(k, body, etag) {
      if (!store.has(k) || etagOf(store.get(k)) !== etag) { const e = new Error('precondition failed'); e.code = 'precondition'; throw e; }
      store.set(k, body);
    },
    async list(prefix) { return [...store.keys()].filter((k) => k.startsWith(prefix)); },
  };
}

module.exports = { createStore, memoryS3, labelFor, summarise, ACQ_PREFIX, WORKER_STATUS_KEY, WORKER_STALE_MS, RUN_STATUS };
