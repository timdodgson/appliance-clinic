/**
 * Phase 11 D1: after a conclusion, every further reply that added nothing new got the same short follow-up, word
 * for word (a post-release journey: two "nothing new" replies in a row, the same line twice). The policy knew the
 * conclusion was being given again but not that the follow-up had already been given. The count is read from cs/1
 * (the turns since the last request with no new evidence), so nothing is latched. Typed turns, no customer text.
 */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
globalThis.awslambda = globalThis.awslambda || { streamifyResponse: (f) => f, HttpResponseStream: { from: (s) => s } };
const H = require('./helpers/b2-journey.cjs');
const L = require('../part-finder-lambda.js')._internal;
const { C, O, K } = H;
const ap = (a) => ({ appliance: { value: a, basis: 'stated' } });
const open = (a, j, obs = []) => H.opener(j, null, obs, {}, ap(a));
const PACK = (k) => L.CANONICAL_JOURNEY_PACKS[k];
const J = (k) => require(PACK(k).pipeline.replace('./canonical/', '../canonical/'));
const compose = (k) => require(PACK(k).compose.replace('./canonical/', '../canonical/'));
const text = (k, r) => { const JC = compose(k); return JC.template(JC.brief(r.state, r.last, null, {})); };

const KEY = 'mw-not-starting';
const concluded = [open('microwave', 'wont-start', [O('noPower')]), C({ reply: { toPending: 'cannot_answer' } })];
const quiet = () => C({});

describe('a conclusion and the replies after it that add nothing new', () => {
  const r1 = H.play(J(KEY), [...concluded, quiet()]);
  const r2 = H.play(J(KEY), [...concluded, quiet(), quiet()]);
  const r3 = H.play(J(KEY), [...concluded, quiet(), quiet(), quiet()]);
  const t1 = text(KEY, r1); const t2 = text(KEY, r2); const t3 = text(KEY, r3);

  it('the first is the short follow-up', () => {
    expect(r1.last.conclusion).toMatchObject({ repeat: true, followUp: 1 });
    expect(t1).toMatch(/nothing changes from what I said/);
  });
  it('the second is not the same line again: it closes with the way forward and what would reopen it', () => {
    expect(r2.last.conclusion).toMatchObject({ repeat: true, followUp: 2 });
    expect(t2).not.toBe(t1);
    expect(t2).toMatch(/tell me and I'll look at it again/);
  });
  it('after that the reply invites anything new instead of repeating either', () => {
    expect(r3.last.conclusion.followUp).toBe(3);
    expect(new Set([t1, t2, t3]).size).toBe(3);
    expect((t3.match(/\?/g) || []).length).toBe(1);
  });
  it('new evidence after the conclusion is re-evaluated, and the count starts again', () => {
    const r = H.play(J(KEY), [...concluded, quiet(), C({ checks: [K('power-supply', 'done', 'clear')] }), quiet()]);
    expect(r.last.conclusion && r.last.conclusion.followUp).not.toBe(3);
  });
  it('the count is derived from cs/1 alone (replaying the same state gives the same reply)', () => {
    const again = compose(KEY);
    expect(again.template(again.brief(r2.state, r2.last, null, {}))).toBe(t2);
  });
});

/**
 * Phase 11 final journeys: an opener that volunteers the model and that the filter is already cleaned, with water still
 * left. mc/1 records the filter check as done with no result; the policy concluded "blocked filter" on the first turn
 * (pointing back at the filter just cleaned) instead of moving to the next owner check.
 */
describe('a volunteered "already cleaned it" with the fault still there moves on to the next check', () => {
  const op = H.opener('not-draining', null, [O('waterRemaining'), O('faultPersists')], {},
    { appliance: { value: 'dishwasher', basis: 'stated' }, make: { value: 'beko', basis: 'stated' }, model: { value: 'DFN05R10W', basis: 'stated' } });
  it('done with no result stated, fault persists: the pump cover check, not a filter conclusion', () => {
    const r = H.play(J('dw-not-draining'), [C({ ...op, checks: [K('dishwasher-filter', 'done', null)] })]);
    expect(r.rules).toEqual(['A12:pump-impeller']);
  });
  it('unchanged when the result is stated (clear, or found and cleared)', () => {
    for (const res of ['clear', 'found_and_cleared']) {
      expect(H.play(J('dw-not-draining'), [C({ ...op, checks: [K('dishwasher-filter', 'done', res)] })]).rules).toEqual(['A12:pump-impeller']);
    }
  });
  it('done with no result and the fault NOT persisting is not a failed fix', () => {
    const op2 = H.opener('not-draining', null, [O('waterRemaining')], {}, { appliance: { value: 'dishwasher', basis: 'stated' } });
    const r = H.play(J('dw-not-draining'), [C({ ...op2, checks: [K('dishwasher-filter', 'done', null)] })]);
    expect(r.rules[0]).not.toBe('A12:pump-impeller');
  });
});
