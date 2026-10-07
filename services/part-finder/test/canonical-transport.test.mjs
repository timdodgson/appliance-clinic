/**
 * Part-finder side of the canonical cs/1 transport.
 * Understand mode merges ONCE from the transported prior (merge(prior, mc/1, {turn: version + 1}));
 * diagnose receives the merged result and never re-merges.
 */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
globalThis.awslambda = globalThis.awslambda || { streamifyResponse: (f) => f, HttpResponseStream: { from: (s) => s } };
const { _internal } = require('../part-finder-lambda.js');
const cs1 = require('../canonical/cs1.js');
const mc1v = require('../canonical/mc1.js');
const { merge } = require('../canonical/merge.js');
const { canonicalTransportMerge, isCanonicalTransportBlock, isCanonicalTransportResult, canonicalTransportMetric } = _internal;

const CSID = 'cs_' + 'Q'.repeat(32);
const block = (version, state) => ({ schema: 'cs/1', mode: 'shadow', sessionId: CSID, version, state, degraded: null });
const mc1 = (over = {}) => mc1v.validateClassification({
  scope: 'appliance', identity: { appliance: { value: 'washing-machine', basis: 'stated' } },
  problem: { journey: 'not-draining', faultDomain: 'drainage' }, observations: [{ key: 'waterRemaining', value: true }], ...over,
});

describe('canonicalTransportMerge', () => {
  it('version 0 + null state → merge(emptyState(csid), mc/1, {turn:1})', () => {
    const out = canonicalTransportMerge(mc1(), block(0, null));
    expect(out).toMatchObject({ schema: 'cs/1', mode: 'shadow', sessionId: CSID, priorVersion: 0, version: 1, degraded: null });
    const want = merge(cs1.emptyState(CSID), mc1(), { turn: 1 });
    expect(out.state).toEqual(want.state);
    expect(out.rulesFired).toEqual(want.trace.rules);
    expect(out.state.sessionId).toBe(CSID);
    expect(out.classification).toEqual(mc1());
  });
  it('continues from the transported prior (turn = version + 1), never from empty', () => {
    const t1 = canonicalTransportMerge(mc1(), block(0, null));
    const t2 = canonicalTransportMerge(mc1(), block(1, t1.state));
    expect(t2).toMatchObject({ priorVersion: 1, version: 2, degraded: null });
    expect(t2.state.version).toBe(2);
    expect(t2.state.problems.length).toBe(t1.state.problems.length);           // same problem continued
    expect(t2.state.identity.appliance.turn).toBe(1);                            // first assertion turn kept
  });
  it('does not mutate the transported block or the classification', () => {
    const t1 = canonicalTransportMerge(mc1(), block(0, null));
    const b = block(1, t1.state);
    const c = mc1();
    const before = JSON.stringify([b, c]);
    canonicalTransportMerge(c, b);
    expect(JSON.stringify([b, c])).toBe(before);
  });
  it('invalid prior → prior_state_invalid (no merge, version not advanced)', () => {
    const t1 = canonicalTransportMerge(mc1(), block(0, null));
    for (const b of [
      block(2, t1.state),                                   // version mismatch
      { ...block(1, t1.state), sessionId: 'cs_' + 'Z'.repeat(32) }, // session mismatch
      block(1, null),                                       // missing state for v>0
      block(1, { ...t1.state, schemaVersion: 'cs/0' }),
      { ...block(0, null), sessionId: 'browser-chosen' },   // not a server-minted csid
      { ...block(0, null), version: -1 },
    ]) {
      const out = canonicalTransportMerge(mc1(), b);
      expect(out.degraded).toBe('prior_state_invalid');
      expect(out.state).toBeNull();
      expect(out.version).toBe(out.priorVersion);
    }
  });
  it('no classification (Jev degraded / classifier off) → classification_degraded (not merged, not persisted)', () => {
    expect(canonicalTransportMerge(null, block(0, null))).toMatchObject({ degraded: 'classification_degraded', state: null, version: 0 });
    expect(canonicalTransportMerge(undefined, block(3, null)).version).toBe(3);
  });
  it('merge exception → merge_failed, contained', () => {
    // A structurally broken classification makes merge() throw; the transport contains it.
    const out = canonicalTransportMerge({ scope: 'appliance', identity: null }, block(0, null));
    expect(out).toMatchObject({ degraded: 'merge_failed', state: null, version: 0 });
    expect(typeof out.error).toBe('string');
  });
  it('metric projection is bounded', () => {
    const m = canonicalTransportMetric(canonicalTransportMerge(mc1(), block(0, null)));
    expect(Object.keys(m).sort()).toEqual(['classifier', 'degraded', 'journey', 'mode', 'priorVersion', 'rules', 'schema', 'stateBytes', 'version']);
    expect(m.journey).toBeNull(); // no journey step ran
    expect(JSON.stringify(m)).not.toContain(CSID);
  });
});

describe('transport shape guards', () => {
  it('a BFF prior block is a transport block; a merged result is a transport result (and not vice-versa)', () => {
    const out = canonicalTransportMerge(mc1(), block(0, null));
    expect(isCanonicalTransportBlock(block(0, null))).toBe(true);
    expect(isCanonicalTransportBlock({ ...block(0, null), mode: 'off' })).toBe(false);
    expect(isCanonicalTransportBlock(out)).toBe(false);
    expect(isCanonicalTransportResult(out)).toBe(true);
    expect(isCanonicalTransportResult(block(0, null))).toBe(false);
    expect(isCanonicalTransportResult({ ...out, degraded: 'x' })).toBe(false);
  });
});
