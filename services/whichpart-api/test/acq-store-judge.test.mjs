/**
 * ACQ-100 store + judge tests — persistence, config snapshot immutability,
 * queue/claim, progress, cancel, worker heartbeat online/offline, judge
 * anonymisation (candidate identity hidden), judge parsing, and no-secret-leak.
 * Fully offline: in-memory S3 + injected judge call.
 */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const { createStore, memoryS3, RUN_STATUS, WORKER_STALE_MS } = require('../benchmark/acq-store.js');
const judge = require('../benchmark/acq-judge.js');

function fixedClock(start) { let t = start; return { now: () => t, advance: (ms) => { t += ms; } }; }
const snapshot = () => ({ benchmarkVersion: 'ACQ-100-V1', scorerVersion: 'acq-scoring-v1', pricingVersion: 'p1', judge: { provider: 'openai', model: 'gpt-5.6-terra', promptHash: 'h' }, understand: { provider: 'lmstudio', model: '' }, compose: { provider: 'openai', model: 'gpt-5.6-terra' }, journeyCount: 3 });

describe('store — enqueue + snapshot immutability', () => {
  it('enqueues a QUEUED run recording provider/model identity and versions, no keys', async () => {
    const s3 = memoryS3(); const clk = fixedClock(1000);
    const store = createStore({ s3, now: clk.now, randomId: () => 'abc' });
    const rec = await store.enqueueRun(snapshot(), { email: 'tom@x.com', label: 'LOCAL / FRONTIER' });
    expect(rec.status).toBe(RUN_STATUS.QUEUED);
    expect(rec.config.understand.provider).toBe('lmstudio');
    expect(rec.config.compose.model).toBe('gpt-5.6-terra');
    expect(rec.benchmarkVersion).toBe('ACQ-100-V1');
    expect(rec.concurrency).toBe(1);
    expect(JSON.stringify(rec)).not.toMatch(/sk-|apiKey/i);
  });
  it('config snapshot on the run is not affected by later edits (immutability by value)', async () => {
    const s3 = memoryS3(); const store = createStore({ s3, now: fixedClock(1).now, randomId: () => 'x' });
    const snap = snapshot();
    const rec = await store.enqueueRun(snap, {});
    snap.compose.model = 'CHANGED-AFTER-ENQUEUE';
    const fresh = await store.getRun(rec.runId);
    expect(fresh.config.compose.model).toBe('gpt-5.6-terra');
  });
});

describe('store — queue/claim/progress/complete/cancel', () => {
  it('claimNext picks the oldest QUEUED run and flips it to RUNNING', async () => {
    const s3 = memoryS3(); const clk = fixedClock(1000);
    const store = createStore({ s3, now: clk.now, randomId: (() => { let i = 0; return () => 'r' + (i++); })() });
    const r1 = await store.enqueueRun(snapshot(), {}); clk.advance(1000);
    await store.enqueueRun(snapshot(), {});
    const claimed = await store.claimNext('worker-1');
    expect(claimed.runId).toBe(r1.runId);
    expect(claimed.status).toBe(RUN_STATUS.RUNNING);
    expect(claimed.workerId).toBe('worker-1');
  });
  it('records incremental progress + per-journey results, then completes', async () => {
    const s3 = memoryS3(); const store = createStore({ s3, now: fixedClock(1).now, randomId: () => 'z' });
    const rec = await store.enqueueRun(snapshot(), {});
    await store.claimRun(rec.runId, 'w');
    await store.recordJourneyResult(rec.runId, { journeyId: 'WM-001', quality: 80, hardViolations: [] }, { done: 1, total: 3, currentJourneyId: 'WM-001' });
    const mid = await store.getRun(rec.runId);
    expect(mid.results.length).toBe(1);
    expect(mid.progress.done).toBe(1);
    await store.completeRun(rec.runId, { quality: 80, hardViolations: 0 });
    const done = await store.getRun(rec.runId);
    expect(done.status).toBe(RUN_STATUS.COMPLETED);
    expect(done.aggregate.quality).toBe(80);
  });
  it('cancel of a QUEUED run cancels immediately; cancel of RUNNING sets the flag', async () => {
    const s3 = memoryS3(); const store = createStore({ s3, now: fixedClock(1).now, randomId: (() => { let i = 0; return () => 'c' + i++; })() });
    const q = await store.enqueueRun(snapshot(), {});
    const cq = await store.requestCancel(q.runId);
    expect(cq.status).toBe(RUN_STATUS.CANCELLED);
    const r = await store.enqueueRun(snapshot(), {});
    await store.claimRun(r.runId, 'w');
    const cr = await store.requestCancel(r.runId);
    expect(cr.status).toBe(RUN_STATUS.RUNNING);
    expect(cr.cancelRequested).toBe(true);
  });
});

describe('store — worker heartbeat online/offline', () => {
  it('reports ONLINE within the stale window and OFFLINE beyond it', async () => {
    const s3 = memoryS3(); const clk = fixedClock(100000);
    const store = createStore({ s3, now: clk.now });
    await store.heartbeat('w1', 'run-1');
    let st = await store.workerStatus();
    expect(st.online).toBe(true);
    expect(st.currentRunId).toBe('run-1');
    clk.advance(WORKER_STALE_MS + 1000);
    st = await store.workerStatus();
    expect(st.online).toBe(false);
  });
  it('reports OFFLINE when no heartbeat exists', async () => {
    const store = createStore({ s3: memoryS3(), now: fixedClock(1).now });
    expect((await store.workerStatus()).online).toBe(false);
  });
});

describe('judge — anonymisation + parsing + no identity/secret leak', () => {
  const transcript = [
    { userText: 'my local Bosch washer wont spin', view: { reply: 'Using the OpenAI GPT-5 model, check the drive belt', suggestedChecks: ['drive belt'], needsModel: false } },
  ];
  const journey = { gold: { expectedOutcome: 'DIAGNOSIS', goldSuspects: ['drive belt'], mustInclude: ['drive belt'], followUpAppropriate: false } };
  it('scrubs candidate identity tokens from the anonymised transcript', () => {
    const anon = judge.anonymiseTranscript(transcript);
    const blob = JSON.stringify(anon).toLowerCase();
    expect(blob).not.toContain('openai');
    expect(blob).not.toContain('gpt-');
    expect(blob).not.toMatch(/\blocal\b/);
  });
  it('judge prompt contains gold + transcript but no provider identity', () => {
    const { messages } = judge.buildJudgePrompt(journey, transcript);
    const blob = JSON.stringify(messages).toLowerCase();
    expect(blob).toContain('gold');
    expect(blob).not.toContain('openai');
    expect(blob).not.toContain('lmstudio');
  });
  it('parses a valid judge response and clamps out-of-range values', () => {
    const parsed = judge.parseJudgeResponse('{"REASONING_DISCRIMINATION":140,"QUESTION_QUALITY":-5,"CUSTOMER_ANSWER_QUALITY":73,"rationale":"ok"}');
    expect(parsed.REASONING_DISCRIMINATION).toBe(100);
    expect(parsed.QUESTION_QUALITY).toBe(0);
    expect(parsed.CUSTOMER_ANSWER_QUALITY).toBe(73);
  });
  it('returns null on unusable judge output so the caller marks NOT JUDGED (no fabrication)', () => {
    expect(judge.parseJudgeResponse('the model was confused')).toBe(null);
    expect(judge.parseJudgeResponse('{"REASONING_DISCRIMINATION":80}')).toBe(null); // incomplete
  });
  it('judgeJourney returns null when no judge call is provided (unconfigured)', async () => {
    expect(await judge.judgeJourney(journey, transcript, null)).toBe(null);
  });
  it('judgeJourney routes through an injected fixed judge and returns scores', async () => {
    const call = async () => '{"REASONING_DISCRIMINATION":70,"QUESTION_QUALITY":90,"CUSTOMER_ANSWER_QUALITY":80,"rationale":"clear"}';
    const r = await judge.judgeJourney(journey, transcript, call);
    expect(r.QUESTION_QUALITY).toBe(90);
  });
  it('judgePromptHash is stable + versioned', () => {
    expect(judge.judgePromptHash(journey)).toMatch(/-acq-judge-rubric-v1$/);
  });
});
