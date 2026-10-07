/**
 * Engineer transcript reviews — store behaviour, validation, provenance,
 * version-pinning correctness, and the CRITICAL mutation proofs:
 *   - a review NEVER changes the benchmark score (acq/runs/*), and
 *   - a review NEVER changes the scenario gold (acq/library.json).
 * Fully offline: in-memory S3.
 */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const { createReviewStore, REVIEW_STATES, reviewKey } = require('../benchmark/acq-reviews.js');
const { memoryS3 } = require('../benchmark/acq-store.js');
const acqLib = require('../benchmark/acq-library.js');

describe('acq-reviews — store + validation + provenance', () => {
  it('round-trips a review and retains the future-RAG provenance links', async () => {
    const s3 = memoryS3();
    const store = createReviewStore({ s3, now: () => 1700000000000 });
    const saved = await store.putReview({ runId: 'acq-1', journeyId: 'WM-017', scenarioId: 'WM-017', journeyVersion: 2, family: 'washing-machine', state: 'needs_improvement', note: 'asked model too early', reviewer: 'tom@x' });
    expect(saved.state).toBe('needs_improvement');
    expect(saved.journeyVersion).toBe(2);
    expect(saved.scenarioId).toBe('WM-017');
    expect(saved.family).toBe('washing-machine');
    expect(saved.reviewer).toBe('tom@x');
    expect(saved.reviewedAt).toBe(new Date(1700000000000).toISOString());
    const got = await store.getReview('acq-1', 'WM-017');
    expect(got.note).toBe('asked model too early');
  });

  it('the three human states are exactly not_reviewed / looks_good / needs_improvement', () => {
    expect(REVIEW_STATES).toEqual(['not_reviewed', 'looks_good', 'needs_improvement']);
  });

  it('rejects an invalid state and writes nothing', async () => {
    const s3 = memoryS3();
    const store = createReviewStore({ s3 });
    await expect(store.putReview({ runId: 'r', journeyId: 'j', state: 'AMAZING' })).rejects.toThrow(/invalid review state/);
    expect(await store.getReview('r', 'j')).toBe(null);
    expect((await s3.list('acq/reviews/')).length).toBe(0);
  });

  it('a missing review returns null (graceful, not an error)', async () => {
    const store = createReviewStore({ s3: memoryS3() });
    expect(await store.getReview('nope', 'nope')).toBe(null);
  });

  it('reviewsForRun maps journeyId -> review and is scoped to that run', async () => {
    const store = createReviewStore({ s3: memoryS3() });
    await store.putReview({ runId: 'A', journeyId: 'WM-1', state: 'looks_good' });
    await store.putReview({ runId: 'A', journeyId: 'WM-2', state: 'needs_improvement' });
    await store.putReview({ runId: 'B', journeyId: 'WM-1', state: 'looks_good' });
    const m = await store.reviewsForRun('A');
    expect(Object.keys(m).sort()).toEqual(['WM-1', 'WM-2']);
    expect(m['WM-2'].state).toBe('needs_improvement');
    expect(m['WM-1'].state).toBe('looks_good');
  });

  it('filters by review state (needs_improvement query) for future evidence use', async () => {
    const store = createReviewStore({ s3: memoryS3() });
    await store.putReview({ runId: 'A', journeyId: 'WM-1', family: 'washing-machine', state: 'needs_improvement' });
    await store.putReview({ runId: 'A', journeyId: 'DW-1', family: 'dishwasher', state: 'looks_good' });
    const wmNeeds = await store.listReviews((r) => r.state === 'needs_improvement' && r.family === 'washing-machine');
    expect(wmNeeds.map((r) => r.journeyId)).toEqual(['WM-1']);
  });

  it('trims an over-long note', async () => {
    const store = createReviewStore({ s3: memoryS3() });
    const saved = await store.putReview({ runId: 'r', journeyId: 'j', state: 'looks_good', note: 'x'.repeat(5000) });
    expect(saved.note.length).toBe(4000);
  });

  it('key is deterministic + url-encoded', () => {
    expect(reviewKey('acq-2026-01', 'WM-017')).toBe('acq/reviews/acq-2026-01__WM-017.json');
  });
});

describe('review MUTATION isolation — never changes score or gold', () => {
  it('writing a review leaves the run record AND the library doc byte-identical', async () => {
    const s3 = memoryS3();
    await s3.putObject('acq/runs/acq-1.json', JSON.stringify({ runId: 'acq-1', aggregate: { quality: 80 }, results: [{ journeyId: 'WM-017', quality: 80 }] }));
    await s3.putObject('acq/library.json', JSON.stringify({ journeys: [{ journeyId: 'WM-017', currentVersion: 2 }] }));
    const runBefore = await s3.getObject('acq/runs/acq-1.json');
    const libBefore = await s3.getObject('acq/library.json');

    const store = createReviewStore({ s3 });
    await store.putReview({ runId: 'acq-1', journeyId: 'WM-017', state: 'needs_improvement', note: 'human opinion' });

    // The benchmark score object is untouched.
    expect(await s3.getObject('acq/runs/acq-1.json')).toBe(runBefore);
    // The scenario gold is untouched.
    expect(await s3.getObject('acq/library.json')).toBe(libBefore);
    // The only new object is under acq/reviews/.
    const reviewKeys = (await s3.list('acq/')).filter((k) => k.startsWith('acq/reviews/'));
    expect(reviewKeys.length).toBe(1);
  });
});

describe('transcript version pinning — historical gold stays with its version', () => {
  const journey = {
    journeyId: 'WM-017', family: 'washing-machine', title: 'Drum not turning', currentVersion: 3,
    versions: [
      { version: 1, opening: 'v1', turns: ['v1'], gold: { expectedOutcome: 'DIAGNOSIS', goldSuspects: ['Carbon brushes'] } },
      { version: 2, opening: 'v2', turns: ['v2'], gold: { expectedOutcome: 'DIAGNOSIS', goldSuspects: ['Motor'] } },
      { version: 3, opening: 'v3', turns: ['v3'], gold: { expectedOutcome: 'DIAGNOSIS', goldSuspects: ['PCB'] } },
    ],
  };
  it('resolves the PINNED version gold (v1), not the current version', () => {
    const pinned = acqLib.resolveVersion(journey, 1);
    expect(pinned.version).toBe(1);
    expect(pinned.gold.goldSuspects).toEqual(['Carbon brushes']);
  });
  it('MUTATION PROOF: pinned gold differs from current gold — ignoring the run version would show the wrong expected data', () => {
    const pinned = acqLib.resolveVersion(journey, 1);
    const current = acqLib.resolveVersion(journey, journey.currentVersion);
    expect(current.gold.goldSuspects).toEqual(['PCB']);
    expect(pinned.gold.goldSuspects).not.toEqual(current.gold.goldSuspects);
  });
});
