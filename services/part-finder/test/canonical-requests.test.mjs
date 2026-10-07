/**
 * Layer B — G2 request history (requests[] + pendingRequest): M20 outcome lifecycle, M21 issue helper.
 *
 * Note on partial / ignored: the accepted canonical M20 (with G2) records the outcome `partial` /
 * `ignored` on the request and clears pendingRequest. The request then remains RE-OFFERABLE: policy
 * may issue exactly one `reoffer` (M21). Nothing is "lost".
 */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { merge } = require('../canonical/merge.js');
const { emptyState } = require('../canonical/cs1.js');
const rq = require('../canonical/requests.js');
const mc1 = require('../canonical/mc1.js');

const C = (f = {}) => mc1.validateClassification({ scope: 'appliance', ...f });
const base = () => merge(emptyState('s'), C({ problem: { journey: 'not-draining' } })).state;
const issue = (s, target, slot = 'CHECK', kind) => rq.issueRequest(s, { slot, target, purpose: 'DIAGNOSIS', kind, journey: 'wm-not-draining', rule: 'R7' }, s.version).state;

describe('M21 issue', () => {
  it('append ask: entry fields + pendingRequest pointer', () => {
    const s = issue(base(), 'drain-filter');
    expect(s.requests).toEqual([{ id: 'q1', slot: 'CHECK', target: 'drain-filter', purpose: 'DIAGNOSIS', kind: 'ask',
      askedTurn: 1, journey: 'wm-not-draining', rule: 'R7', outcome: 'pending', resolvedTurn: null }]);
    expect(s.pendingRequest).toBe('q1');
  });
  it('append reoffer: default kind after a not_done outcome', () => {
    let s = issue(base(), 'drain-filter');
    s = merge(s, C({ checks: [{ check: 'drain-filter', status: 'not_done' }] })).state;
    s = issue(s, 'drain-filter');
    expect(s.requests[1].kind).toBe('reoffer');
    expect(rq.asked(s, 'drain-filter')).toBe(2);
    expect(rq.wasReoffered(s, 'drain-filter')).toBe(true);
  });
  it('append retest: explicit kind; retests do not count towards asked()', () => {
    let s = issue(base(), 'drain-command', 'CHECK');
    s = merge(s, C({ observations: [{ key: 'commandedDrain', value: false }] })).state;
    s = issue(s, 'drain-command', 'CHECK', 'retest');
    expect(s.requests[1].kind).toBe('retest');
    expect(rq.asked(s, 'drain-command')).toBe(1);
  });
  it('only one pending: issuing while one is pending supersedes it', () => {
    let s = issue(base(), 'drain-filter');
    s = issue(s, 'pumpHumming', 'OBSERVATION');
    expect(s.requests.map((r) => r.outcome)).toEqual(['superseded', 'pending']);
    expect(rq.pendingCount(s)).toBe(1);
    expect(s.pendingRequest).toBe('q2');
  });
  it('rejects malformed requests (typed contract)', () => {
    expect(() => rq.issueRequest(base(), { slot: 'PROSE', target: 'x', purpose: 'DIAGNOSIS' }, 1)).toThrow();
    expect(() => rq.issueRequest(base(), { slot: 'CHECK', purpose: 'DIAGNOSIS' }, 1)).toThrow();
  });
  it('issue does not mutate the input state', () => {
    const s0 = base();
    const before = JSON.stringify(s0);
    issue(s0, 'drain-filter');
    expect(JSON.stringify(s0)).toBe(before);
  });
});

describe('M20 outcome lifecycle', () => {
  const pendingFilter = () => issue(base(), 'drain-filter');
  it('answered: target check done', () => {
    const r = merge(pendingFilter(), C({ checks: [{ check: 'drain-filter', status: 'done', result: 'clear' }] }));
    expect(r.trace.requestOutcome).toBe('answered');
    expect(r.state.requests[0]).toMatchObject({ outcome: 'answered', resolvedTurn: 2 });
    expect(r.state.pendingRequest).toBe(null);
  });
  it('cannot_answer', () => {
    expect(merge(pendingFilter(), C({ reply: { toPending: 'cannot_answer' } })).state.requests[0].outcome).toBe('cannot_answer');
  });
  it('declined (check status takes priority)', () => {
    expect(merge(pendingFilter(), C({ checks: [{ check: 'drain-filter', status: 'declined' }], reply: { toPending: 'answered' } }))
      .state.requests[0].outcome).toBe('declined');
  });
  it('unable', () => {
    expect(merge(pendingFilter(), C({ checks: [{ check: 'drain-filter', status: 'unable' }] })).state.requests[0].outcome).toBe('unable');
  });
  it('not_done', () => {
    expect(merge(pendingFilter(), C({ checks: [{ check: 'drain-filter', status: 'not_done' }] })).state.requests[0].outcome).toBe('not_done');
  });
  it('partial → outcome partial, re-offerable (a reoffer is the next request kind)', () => {
    let s = merge(pendingFilter(), C({ reply: { toPending: 'partial' } })).state;
    expect(s.requests[0].outcome).toBe('partial');
    s = issue(s, 'drain-filter');
    expect(s.requests[1].kind).toBe('reoffer');
  });
  it('ignored (unrelated on-topic content) → outcome ignored, re-offerable', () => {
    let s = merge(pendingFilter(), C({ intent: 'price_or_availability' })).state;
    expect(s.requests[0].outcome).toBe('ignored');
    s = issue(s, 'drain-filter');
    expect(s.requests[1].kind).toBe('reoffer');
  });
  it('identity target filled → answered', () => {
    const s = rq.issueRequest(base(), { slot: 'IDENTITY', target: 'model', purpose: 'PART_FIT' }, 1).state;
    expect(merge(s, C({ identity: { model: { value: 'WMUD962P', basis: 'stated' } } })).state.requests[0].outcome).toBe('answered');
  });
  it('off-topic / prompt attack leaves the pending request untouched', () => {
    const s = pendingFilter();
    for (const scope of ['prompt_attack', 'unrelated']) {
      const r = merge(s, C({ scope }));
      expect(r.state.requests[0]).toMatchObject({ outcome: 'pending', resolvedTurn: null });
      expect(r.state.pendingRequest).toBe('q1');
    }
  });
  it('outcome is written exactly once: a later message does not rewrite a resolved request', () => {
    let s = merge(pendingFilter(), C({ checks: [{ check: 'drain-filter', status: 'done', result: 'clear' }] })).state;
    s = merge(s, C({ reply: { toPending: 'cannot_answer' } })).state;
    expect(s.requests[0]).toMatchObject({ outcome: 'answered', resolvedTurn: 2 });
  });
  it('history is append-only across a sequence; at most one pending at any point', () => {
    let s = base();
    let lastLen = 0;
    const steps = [
      (x) => issue(x, 'drain-filter'),
      (x) => merge(x, C({ checks: [{ check: 'drain-filter', status: 'not_done' }] })).state,
      (x) => issue(x, 'drain-filter'),
      (x) => merge(x, C({ scope: 'unrelated' })).state,
      (x) => issue(x, 'drain-command'),
      (x) => merge(x, C({ observations: [{ key: 'commandedDrain', value: false }] })).state,
    ];
    const snapshots = [];
    for (const f of steps) {
      s = f(s);
      expect(s.requests.length).toBeGreaterThanOrEqual(lastLen);
      expect(rq.pendingCount(s)).toBeLessThanOrEqual(1);
      snapshots.push(JSON.parse(JSON.stringify(s.requests)));
      lastLen = s.requests.length;
    }
    // every earlier entry's id/target/kind/askedTurn is unchanged later (only outcome/resolvedTurn set once)
    const final = s.requests;
    for (const snap of snapshots) {
      snap.forEach((r, i) => {
        expect({ id: final[i].id, target: final[i].target, kind: final[i].kind, askedTurn: final[i].askedTurn })
          .toEqual({ id: r.id, target: r.target, kind: r.kind, askedTurn: r.askedTurn });
        if (r.outcome !== 'pending') expect(final[i].outcome).toBe(r.outcome);
      });
    }
    expect(final.map((r) => [r.target, r.kind, r.outcome])).toEqual([
      ['drain-filter', 'ask', 'not_done'], ['drain-filter', 'reoffer', 'superseded'], ['drain-command', 'ask', 'answered'],
    ]);
  });
  it('readers: asked / lastOutcome / requestsFor', () => {
    let s = issue(base(), 'drain-filter');
    s = merge(s, C({ checks: [{ check: 'drain-filter', status: 'unable' }] })).state;
    expect(rq.asked(s, 'drain-filter')).toBe(1);
    expect(rq.lastOutcome(s, 'drain-filter')).toBe('unable');
    expect(rq.requestsFor(s, 'drain-hose')).toEqual([]);
  });
});
