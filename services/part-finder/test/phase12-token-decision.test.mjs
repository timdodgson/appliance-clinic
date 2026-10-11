/**
 * Phase 12: the engine owns the code-or-model token decision. canonical/token-gate.js is the only implementation of
 * the commit rule; understand mode carries it on the intent (understand.tokenDecision) for the orchestrator, which no
 * longer has its own thresholds.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
globalThis.awslambda = globalThis.awslambda || { streamifyResponse: (f) => f, HttpResponseStream: { from: (s) => s } };
const lambda = require('../part-finder-lambda.js');
const { sign, SIGNATURE_HEADER } = require('../engine-auth.js');
const { tokenDecision, gateClassification, MIN_CONF, MIN_MARGIN } = require('../canonical/token-gate.js');
const { merge } = require('../canonical/merge.js');
const { emptyState } = require('../canonical/cs1.js');
const { _setJevEvaluateForTest } = require('../jev-understand.js');
const admin = require('../admin-config.js');
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
process.env.ENGINE_SIGNING_TOKEN = 'test-engine-signing-key-0123456789abcdef';

const weak = { model: 0.72, uncertain: 0.18, error_code: 0.02, none: 0.05, other: 0.03 };
const strong = { model: 0.97, uncertain: 0.02, error_code: 0.01 };

describe('the token commit rule (canonical/token-gate.js)', () => {
  it('a weak or near-tied model reading is uncertain; a strong one commits', () => {
    expect(tokenDecision({ meaning: 'model', probabilities: weak })).toEqual({ meaning: 'model', decision: 'uncertain', reason: 'weak_or_near_tie', token: null });
    expect(tokenDecision({ meaning: 'model', probabilities: { model: 0.6, uncertain: 0.27 } }).decision).toBe('uncertain');
    expect(tokenDecision({ meaning: 'model', probabilities: strong })).toEqual({ meaning: 'model', decision: 'commit', reason: 'strong' });
  });
  it('a code reading, no token, or no distribution commits (only a model reading is gated)', () => {
    expect(tokenDecision({ meaning: 'error_code', probabilities: { error_code: 0.5, model: 0.4 } })).toMatchObject({ decision: 'commit', reason: 'not_gated' });
    expect(tokenDecision({ meaning: 'none' })).toMatchObject({ decision: 'commit' });
    expect(tokenDecision({ meaning: 'model', probabilities: null })).toMatchObject({ decision: 'commit', reason: 'not_gated' });
    expect(tokenDecision(null)).toMatchObject({ meaning: null, decision: 'commit' });
  });
  it('a token the cs/1 gate held without a model reading is uncertain, and is named', () => {
    expect(tokenDecision({ meaning: 'uncertain', probabilities: { model: 0.5, uncertain: 0.36 } }, 'F06'))
      .toEqual({ meaning: 'uncertain', decision: 'uncertain', reason: 'meaning_uncertain', token: 'F06' });
    expect(tokenDecision({ meaning: 'model', probabilities: weak, model: 'F06' }).token).toBe('F06');
  });
  it('the thresholds exist once: here, and nowhere in the orchestrator', () => {
    expect([MIN_CONF, MIN_MARGIN]).toEqual([0.70, 0.55]);
    const routing = readFileSync(join(ROOT, 'orchestration', 'routing.py'), 'utf8');
    const orch = readFileSync(join(ROOT, 'orchestration', 'orchestrator.py'), 'utf8');
    expect(routing).not.toMatch(/def token_meaning_decision/);
    expect(orch).not.toMatch(/token_meaning_decision|candidateTokenMeaning"\)\s*if/);
  });
});

/** Legacy Jev fake: bland answers, with the token meaning and its distribution set per test. */
let tokenAnswer = null;
async function legacyFake({ questions }) {
  const answers = {};
  for (const [k, q] of Object.entries(questions)) {
    if (q.type === 'noul') answers[k] = { type: 'noul', noul: k === 'onTopic' ? 0.99 : 0.1 };
    else { const opt = Object.keys(q.criteria)[0]; answers[k] = { type: 'choice', choice: opt, confidence: 0.9, probabilities: { [opt]: 0.9 } }; }
  }
  if (tokenAnswer && questions.candidateTokenMeaning) answers.candidateTokenMeaning = tokenAnswer;
  return { model: 'jev-test', answers, usage: null, latencyMs: 5 };
}
async function understandFrame(messages) {
  const writes = [];
  const raw = JSON.stringify({ mode: 'understand', messages });
  await lambda.handler({ body: raw, headers: { [SIGNATURE_HEADER]: sign(process.env.ENGINE_SIGNING_TOKEN, raw) }, requestContext: { requestId: 'req-p12', http: { method: 'POST', path: '/' } } },
    { write: (x) => writes.push(String(x)), end: () => {} });
  return writes.join('').split('\n').filter(Boolean).map((l) => JSON.parse(l)).find((l) => l.type === 'understand');
}

describe('understand mode carries the decision on the intent', () => {
  beforeAll(async () => {
    admin._resetCache();
    await admin.loadAdminInference({ fetchSecret: async () => null, env: { CLOUDFLARE_ACCOUNT_ID: 'acct', CLOUDFLARE_API_TOKEN: 'token-for-tests' } });
    _setJevEvaluateForTest(legacyFake);
  });
  afterAll(() => { _setJevEvaluateForTest(null); tokenAnswer = null; });
  const msg = [{ role: 'user', content: 'washing machine F06' }];
  it('a weak model reading of the token: uncertain', async () => {
    tokenAnswer = { type: 'choice', choice: 'model', confidence: 0.72, probabilities: weak };
    const f = await understandFrame(msg);
    expect(f.understand.tokenDecision).toMatchObject({ meaning: 'model', decision: 'uncertain', reason: 'weak_or_near_tie' });
  });
  it('a strong model reading: commit', async () => {
    tokenAnswer = { type: 'choice', choice: 'model', confidence: 0.97, probabilities: strong };
    expect((await understandFrame(msg)).understand.tokenDecision).toMatchObject({ decision: 'commit', reason: 'strong' });
  });
  it('a code reading: commit, not gated', async () => {
    tokenAnswer = { type: 'choice', choice: 'error_code', confidence: 0.9, probabilities: { error_code: 0.9, model: 0.05 } };
    expect((await understandFrame(msg)).understand.tokenDecision).toMatchObject({ meaning: 'error_code', decision: 'commit' });
  });
});

/**
 * Live shape (Phase 12 journey, no customer text copied): a bare code with a misspelt brand. Jev's token pick fell
 * below its confidence floor or was 'uncertain' (model 0.50, uncertain 0.36), so the intent had no model; mc/1 typed the
 * token as the model and cs/1 committed it. The gate holds it like a weak model reading.
 */
describe('a token Jev could not place is held, not committed (cs/1)', () => {
  const CSID = 'cs_' + 'd'.repeat(32);
  const UNPLACED = { model: 0.5, error_code: 0.09, uncertain: 0.36, none: 0.03, other: 0.02 };
  const cls = (identity = {}) => ({ scope: 'appliance', identity: { appliance: { value: 'washing-machine', basis: 'stated' }, make: { value: 'hotpoint', basis: 'stated' },
    model: { value: null, basis: null }, modelStatus: null, fuel: null, displayedCode: null, ...identity } });
  const turn = (state, c, signal) => { const g = gateClassification(c, signal, state); return { ...merge(state, g.classification, { turn: state.version + 1 }), decision: g.decision }; };
  it('first mention: held as the unconfirmed token, never the model', () => {
    const r = turn(emptyState(CSID), cls({ model: { value: 'F06', basis: 'stated' } }), { meaning: 'uncertain', probabilities: UNPLACED });
    expect(r.decision).toBe('held');
    expect(r.state.identity.model.value).toBeNull();
    expect(r.state.identity.unconfirmedToken.value).toBe('F06');
  });
  it('the answer turn ("it is the code on the screen") still commits the held token as the code', () => {
    const t1 = turn(emptyState(CSID), cls({ model: { value: 'F06', basis: 'stated' } }), { meaning: 'uncertain', probabilities: UNPLACED }).state;
    const r = turn(t1, cls({ model: { value: 'F06', basis: 'stated' } }), { meaning: 'uncertain', probabilities: UNPLACED, symptomFamily: 'error_display' });
    expect(r.decision).toBe('answered_code');
    expect(r.state.identity.displayedCodes.filter((f) => f.status === 'active').map((f) => f.value)).toEqual(['F06']);
    expect(r.state.identity.model.value).toBeNull();
  });
  it('a model already settled in cs/1 stays settled on a later unplaced reading', () => {
    const t1 = turn(emptyState(CSID), cls({ model: { value: 'WAN28281GB', basis: 'stated' } }), { meaning: 'model', probabilities: { model: 0.97, uncertain: 0.02 }, model: 'WAN28281GB' }).state;
    const r = turn(t1, cls({ model: { value: 'WAN28281GB', basis: 'stated' } }), { meaning: 'uncertain', probabilities: UNPLACED });
    expect(r.decision).toBeNull();
    expect(r.state.identity.model.value).toBe('WAN28281GB');
  });
  it('no token typed as the model: nothing is held', () => {
    expect(turn(emptyState(CSID), cls(), { meaning: 'uncertain', probabilities: UNPLACED }).decision).toBeNull();
  });
});
