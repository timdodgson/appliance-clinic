/**
 * Phase 11 D2: a code-or-model token near Jev's commit threshold. Real shape (a post-release journey, no customer
 * text copied): a bare code with a misspelt brand was read by Jev as a weak MODEL (0.57 vs uncertain 0.29); the
 * orchestrator held it back but mc/1 committed it as the model in cs/1, and the misspelt brand was never a candidate.
 * Live probe values are used as the distributions below.
 */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const G = require('../canonical/token-gate.js');
const { buildCandidates } = require('../canonical/candidates.js');
const { merge } = require('../canonical/merge.js');
const { emptyState } = require('../canonical/cs1.js');

const CSID = 'cs_' + 'c'.repeat(32);
const cls = (identity = {}) => ({ scope: 'appliance', identity: { appliance: { value: 'washing-machine', basis: 'stated' }, make: { value: null, basis: null },
  model: { value: null, basis: null }, modelStatus: null, fuel: null, displayedCode: null, ...identity } });
const WEAK = { model: 0.57, error_code: 0.08, uncertain: 0.29, none: 0.03, other: 0.03 };
const STRONG_MODEL = { model: 1, error_code: 0, uncertain: 0 };
const ANSWER_CODE = { model: 0.05, error_code: 0.47, uncertain: 0.48 };

function turn(state, classification, signal) {
  const g = G.gateClassification(classification, signal, state);
  return { ...merge(state, g.classification, { turn: state.version + 1 }), decision: g.decision };
}

describe('one commit rule for a code-or-model token', () => {
  it('a weak model reading is held, not committed as the model (cs/1 never says "model = F06")', () => {
    const r = turn(emptyState(CSID), cls({ model: { value: 'F06', basis: 'stated' } }), { meaning: 'model', probabilities: WEAK, model: 'F06' });
    expect(r.decision).toBe('held');
    expect(r.state.identity.model.value).toBeNull();
    expect(r.state.identity.modelStatus).not.toBe('known');
    expect(r.state.identity.unconfirmedToken.value).toBe('F06');
    expect(r.state.identity.displayedCodes).toEqual([]);
  });

  it('the answer "it is still showing the error" commits the held token as the displayed code (token not lost)', () => {
    const t1 = turn(emptyState(CSID), cls({ model: { value: 'F06', basis: 'stated' } }), { meaning: 'model', probabilities: WEAK, model: 'F06' }).state;
    const r = turn(t1, cls(), { meaning: 'error_code', probabilities: ANSWER_CODE, errorCode: null });
    expect(r.decision).toBe('answered_code');
    expect(r.state.identity.displayedCodes.filter((f) => f.status === 'active').map((f) => f.value)).toEqual(['F06']);
    expect(r.state.identity.unconfirmedToken.value).toBeNull();
    expect(r.state.identity.model.value).toBeNull();
  });

  it('a decisive model answer commits the held token as the model', () => {
    const t1 = turn(emptyState(CSID), cls({ model: { value: 'WM1234', basis: 'stated' } }), { meaning: 'model', probabilities: WEAK, model: 'WM1234' }).state;
    const r = turn(t1, cls({ model: { value: 'WM1234', basis: 'stated' } }), { meaning: 'model', probabilities: STRONG_MODEL, model: 'WM1234' });
    expect(r.decision).toBe('answered_model');
    expect(r.state.identity.model.value).toBe('WM1234');
    expect(r.state.identity.unconfirmedToken.value).toBeNull();
  });

  it('an obvious model and an obvious code are committed directly (no hold)', () => {
    const m = turn(emptyState(CSID), cls({ model: { value: 'WAN28281GB', basis: 'stated' } }), { meaning: 'model', probabilities: STRONG_MODEL, model: 'WAN28281GB' });
    expect(m.decision).toBeNull();
    expect(m.state.identity.model.value).toBe('WAN28281GB');
    const c = turn(emptyState(CSID), cls({ displayedCode: 'E15' }), { meaning: 'error_code', probabilities: { error_code: 1 }, errorCode: 'E15' });
    expect(c.decision).toBeNull();
    expect(c.state.identity.displayedCodes.map((f) => f.value)).toEqual(['E15']);
  });

  it('a correction on a later turn ("that was the model number") supersedes the code', () => {
    const t1 = turn(emptyState(CSID), cls({ displayedCode: 'WAN28281' }), { meaning: 'error_code', probabilities: { error_code: 0.9 }, errorCode: 'WAN28281' }).state;
    const r = turn(t1, cls({ model: { value: 'WAN28281', basis: 'stated' } }), { meaning: 'model', probabilities: STRONG_MODEL, model: 'WAN28281' });
    expect(r.state.identity.model.value).toBe('WAN28281');
    expect(r.state.identity.displayedCodes.filter((f) => f.status === 'active')).toEqual([]);
  });

  it('a state written before Phase 11 (no unconfirmedToken) merges as before', () => {
    const old = emptyState(CSID); delete old.identity.unconfirmedToken;
    const r = turn(old, cls({ displayedCode: 'E15' }), { meaning: 'error_code', probabilities: { error_code: 1 }, errorCode: 'E15' });
    expect(r.state.identity.displayedCodes.map((f) => f.value)).toEqual(['E15']);
    expect(r.state.identity.unconfirmedToken).toBeUndefined();
  });

  it('the thresholds are the orchestrator gate\'s (0.70 confidence, 0.55 margin)', () => {
    expect([G.MIN_CONF, G.MIN_MARGIN]).toEqual([0.70, 0.55]);
    expect(G.modelReadingIsStrong({ model: 0.72, uncertain: 0.18 })).toBe(false);
    expect(G.modelReadingIsStrong({ model: 0.97, uncertain: 0.02 })).toBe(true);
    expect(G.modelReadingIsStrong(null)).toBe(true);
  });
});

describe('a misspelt brand is offered to mc/1 as a candidate (Jev still decides)', () => {
  it('one edit from a catalogue brand, same first letter', () => {
    expect(buildCandidates('F06 Horpoint Washing Machine').brands.map((b) => b.value)).toEqual(['hotpoint']);
    expect(buildCandidates('my Bocsh dishwasher').brands.map((b) => b.value)).toEqual(['bosch']);
  });
  it('ordinary words and exact brands are unchanged', () => {
    expect(buildCandidates('my dryer is broken and noisy').brands).toEqual([]);
    expect(buildCandidates('Hotpoint washer').brands.map((b) => b.value)).toEqual(['hotpoint']);
  });
});
