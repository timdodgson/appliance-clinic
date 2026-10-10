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
