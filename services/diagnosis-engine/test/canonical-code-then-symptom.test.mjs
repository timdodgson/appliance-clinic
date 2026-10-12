/**
 * Code-then-symptom (GOLD G2-EC-02): the first turn gives only a displayed code (problem journey 'error-code-only', a
 * placeholder); the next turn describes what the appliance does. The described journey replaces the placeholder (merge
 * M4b), the code stays in identity, and the journey that owns the behaviour takes the turn. A real stated journey is never
 * replaced by a later 'error-code-only' (M5 conflict, unchanged).
 */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const H = require('./helpers/b2-journey.cjs');
const L = require('../handler.js')._internal;
const { emptyState } = require('../canonical/cs1.js');
const { merge } = require('../canonical/merge.js');
const { C } = H;

const TD = { appliance: { value: 'tumble-dryer', basis: 'stated' }, make: { value: 'hotpoint', basis: 'stated' } };
const codeTurn = C({ identity: { ...TD, displayedCode: 'F01' }, intent: 'report_fault', problem: { journey: 'error-code-only' } });
const play = (turns) => turns.reduce((s, c) => merge(s, c, { turn: s.version + 1 }).state, emptyState('cs_' + 'c'.repeat(32)));
const ALL = Object.keys(L.CANONICAL_JOURNEY_PACKS);

describe('merge M4b', () => {
  it('a described journey replaces the error-code-only placeholder; the code stays', () => {
    const s = play([codeTurn, C({ problem: { journey: 'cuts-out' } })]);
    const p = s.problems.filter((x) => x.status === 'active').pop();
    expect(p.journey.value).toBe('cuts-out');
    expect(p.journey.conflict).toBeFalsy();
    expect(s.identity.displayedCodes.filter((f) => f.status === 'active').pop().value).toBe('F01');
  });
  it('a stated journey is not replaced by a later error-code-only (still a conflict, journey kept)', () => {
    const s = play([C({ identity: TD, intent: 'report_fault', problem: { journey: 'cuts-out' } }), C({ problem: { journey: 'error-code-only' } })]);
    expect(s.problems.filter((x) => x.status === 'active').pop().journey.value).toBe('cuts-out');
  });
});

describe('routing after code-then-symptom', () => {
  it('the journey that owns the described behaviour takes the turn', async () => {
    expect(await H.ownerOf(L, [codeTurn], ALL)).toBe(null);
    expect(await H.ownerOf(L, [codeTurn, C({ problem: { journey: 'cuts-out' } })], ALL)).toBe('td-stops-mid-cycle');
  });
});
