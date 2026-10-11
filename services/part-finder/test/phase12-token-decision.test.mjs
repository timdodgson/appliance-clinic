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
const { tokenDecision, MIN_CONF, MIN_MARGIN } = require('../canonical/token-gate.js');
const { _setJevEvaluateForTest } = require('../jev-understand.js');
const admin = require('../admin-config.js');
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
process.env.ENGINE_SIGNING_TOKEN = 'test-engine-signing-key-0123456789abcdef';

const weak = { model: 0.72, uncertain: 0.18, error_code: 0.02, none: 0.05, other: 0.03 };
const strong = { model: 0.97, uncertain: 0.02, error_code: 0.01 };

describe('the token commit rule (canonical/token-gate.js)', () => {
  it('a weak or near-tied model reading is uncertain; a strong one commits', () => {
    expect(tokenDecision({ meaning: 'model', probabilities: weak })).toEqual({ meaning: 'model', decision: 'uncertain', reason: 'weak_or_near_tie' });
    expect(tokenDecision({ meaning: 'model', probabilities: { model: 0.6, uncertain: 0.27 } }).decision).toBe('uncertain');
    expect(tokenDecision({ meaning: 'model', probabilities: strong })).toEqual({ meaning: 'model', decision: 'commit', reason: 'strong' });
  });
  it('a code reading, no token, or no distribution commits (only a model reading is gated)', () => {
    expect(tokenDecision({ meaning: 'error_code', probabilities: { error_code: 0.5, model: 0.4 } })).toMatchObject({ decision: 'commit', reason: 'not_gated' });
    expect(tokenDecision({ meaning: 'none' })).toMatchObject({ decision: 'commit' });
    expect(tokenDecision({ meaning: 'model', probabilities: null })).toMatchObject({ decision: 'commit', reason: 'not_gated' });
    expect(tokenDecision(null)).toMatchObject({ meaning: null, decision: 'commit' });
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
    expect(f.understand.tokenDecision).toEqual({ meaning: 'model', decision: 'uncertain', reason: 'weak_or_near_tie' });
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
