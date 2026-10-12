/**
 * Canonical understand-mode wiring against the real handler with both Jev calls faked:
 *   - the message-only mc/1 call runs only when a cs/1 transport block is present and the kill switch is on;
 *   - its classification is the only input to the cs/1 merge;
 *   - the `understand` event payload is byte-identical with the classifier on, off, or failing;
 *   - a classifier failure (or CANONICAL_MC1_QUESTIONS=0) is `classification_degraded` — nothing merged;
 *   - the classifier's Jev state contains only latest-message context (no prior customer turns).
 */
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const lambda = require('../handler.js');
const { sign, SIGNATURE_HEADER } = require('../engine-auth.js');
// ADR 0017: understand mode and the canonical block are orchestrator-only fields, honoured only when signed.
process.env.ENGINE_SIGNING_TOKEN = 'test-engine-signing-key-0123456789abcdef';
const signedEvent = (body, extra = {}) => {
  const raw = JSON.stringify(body);
  return { body: raw, headers: { [SIGNATURE_HEADER]: sign(process.env.ENGINE_SIGNING_TOKEN, raw) }, ...extra };
};
const { _setJevEvaluateForTest } = require('../jev-understand.js');
const { _setMc1EvaluateForTest } = require('../jev-mc1.js');
const admin = require('../admin-config.js');

const CSID = 'cs_' + 'W'.repeat(32);
const block = { schema: 'cs/1', mode: 'shadow', sessionId: CSID, version: 0, state: null, degraded: null };
const MESSAGES = [
  { role: 'user', content: 'my machine is playing up' },
  { role: 'assistant', content: 'What is happening exactly?' },
  { role: 'user', content: 'Hotpoint washing machine ends full of water' },
];

/** Understanding fake: answer every asked question with a valid, bland value (first option / low noul). */
async function understandFake({ questions }) {
  const answers = {};
  for (const [k, q] of Object.entries(questions)) {
    if (q.type === 'noul') answers[k] = { type: 'noul', noul: k === 'onTopic' ? 0.99 : 0.1 };
    else { const opt = Object.keys(q.criteria)[0]; answers[k] = { type: 'choice', choice: opt, confidence: 0.9, probabilities: { [opt]: 0.9 } }; }
  }
  return { model: 'jev-test', answers, usage: null, latencyMs: 5 };
}
const ch = (c, conf = 0.95) => ({ type: 'choice', choice: c, confidence: conf, probabilities: { [c]: conf } });
let mc1Calls = [];
async function mc1Fake(req) {
  mc1Calls.push(req);
  const brand = Object.entries(req.questions.candMake ? req.questions.candMake.criteria : {}).find(([, d]) => d.includes('hotpoint'));
  return { model: 'jev-test', latencyMs: 4, answers: {
    mcScope: ch('appliance'), mcAppliance: ch('washing-machine'), mcApplianceBasis: ch('stated'), mcIntent: ch('report_fault'),
    mcFaultDomain: ch('water'), mcJourney: ch('not-draining'), mcObsStandingWater: ch('remains'), ...(brand ? { candMake: ch(brand[0]) } : {}),
  } };
}

async function understandCall(bodyExtra = {}) {
  const res = await lambda.handler(signedEvent({ mode: 'understand', messages: MESSAGES, ...bodyExtra }, { requestContext: { requestId: 'req-d1', http: { method: 'POST', path: '/' } } }));
  const lines = res.body.split('\n').filter(Boolean).map((l) => JSON.parse(l));
  return lines.find((l) => l.type === 'understand');
}

beforeAll(async () => {
  admin._resetCache();
  await admin.loadAdminInference({ fetchSecret: async () => null, env: { CLOUDFLARE_ACCOUNT_ID: 'acct', CLOUDFLARE_API_TOKEN: 'token-for-tests' } });
  _setJevEvaluateForTest(understandFake);
});
afterEach(() => { _setMc1EvaluateForTest(null); delete process.env.CANONICAL_MC1_QUESTIONS; mc1Calls = []; });

describe('canonical classification in understand mode', () => {
  it('the mc/1 classification feeds the merge', async () => {
    _setMc1EvaluateForTest(mc1Fake);
    const ev = await understandCall({ canonical: block });
    expect(mc1Calls.length).toBe(1);
    const c = ev.canonical;
    expect(c).toMatchObject({ schema: 'cs/1', sessionId: CSID, priorVersion: 0, version: 1, degraded: null });
    expect(c.classification.identity.make).toEqual({ value: 'hotpoint', basis: 'stated' });
    expect(c.classification.observations).toEqual([{ key: 'waterRemaining', value: true }]);
    expect(c.state.identity.make.value).toBe('hotpoint');
    expect(c.classifier).toMatchObject({ source: 'mc1-questions', degraded: false });
    expect(c.classifier).not.toHaveProperty('comparison'); // the Stage A comparison is retired
  });
  it('the classifier Jev state is latest-message scoped (no prior customer turns)', async () => {
    _setMc1EvaluateForTest(mc1Fake);
    await understandCall({ canonical: block });
    const st = mc1Calls[0].state;
    expect(st.latestCustomerMessage).toBe('Hotpoint washing machine ends full of water');
    expect(st.priorAssistantMessage).toBe('What is happening exactly?');
    expect(JSON.stringify(st)).not.toContain('playing up');
    expect(st.pendingRequest).toBeNull();
    expect(st.currentState).toBeNull();
  });
  it('the understand payload is identical with the classifier on, off, failing, or absent', async () => {
    _setMc1EvaluateForTest(mc1Fake);
    const on = await understandCall({ canonical: block });
    _setMc1EvaluateForTest(async () => { throw new Error('jev down'); });
    const failing = await understandCall({ canonical: block });
    process.env.CANONICAL_MC1_QUESTIONS = '0';
    const off = await understandCall({ canonical: block });
    delete process.env.CANONICAL_MC1_QUESTIONS;
    const none = await understandCall({});
    expect(on.jev).toMatchObject({ invoked: true, ok: true }); // the understanding call really ran (not degraded)
    expect(on.understand.applianceType).toBe('washing-machine');
    const payload = (e) => JSON.stringify({ understand: e.understand, jev: { ...e.jev, latencyMs: 0 } });
    expect(payload(failing)).toBe(payload(on));
    expect(payload(off)).toBe(payload(on));
    expect(payload(none)).toBe(payload(on));
    expect(none.canonical).toBeUndefined();
  });
  it('classifier failure -> classification_degraded (nothing merged)', async () => {
    _setMc1EvaluateForTest(async () => { throw Object.assign(new Error('timeout'), { category: 'TIMEOUT' }); });
    const ev = await understandCall({ canonical: block });
    expect(ev.canonical).toMatchObject({ degraded: 'classification_degraded', state: null, version: 0 });
    expect(ev.canonical.classifier).toMatchObject({ source: 'mc1-questions', degraded: true });
  });
  it('kill switch CANONICAL_MC1_QUESTIONS=0 -> no classifier call, classification_degraded (nothing merged)', async () => {
    _setMc1EvaluateForTest(mc1Fake);
    process.env.CANONICAL_MC1_QUESTIONS = '0';
    const ev = await understandCall({ canonical: { ...block, mode: 'control', control: { journeys: ['wm-not-draining'] } } });
    expect(mc1Calls.length).toBe(0);
    expect(ev.canonical).toMatchObject({ degraded: 'classification_degraded', state: null, version: 0 });
    expect(ev.canonical.classifier).toMatchObject({ degraded: true, reason: 'classifier_disabled' });
    expect(ev.canonical.journey == null || ev.canonical.journey.control === false).toBe(true);
  });
  it('no transport block -> no classifier call', async () => {
    _setMc1EvaluateForTest(mc1Fake);
    await understandCall({});
    await understandCall({ canonical: { mode: 'shadow' } });
    expect(mc1Calls.length).toBe(0);
  });
  it('prior cs/1 state is passed as read-only context and retained by merge on a sparse turn', async () => {
    _setMc1EvaluateForTest(mc1Fake);
    const first = (await understandCall({ canonical: block })).canonical;
    _setMc1EvaluateForTest(async (req) => { mc1Calls.push(req); return { model: 't', latencyMs: 1, answers: { mcScope: ch('appliance') } }; });
    const msgs = [...MESSAGES, { role: 'assistant', content: 'Can you hear the pump?' }, { role: 'user', content: "I don't know" }];
    const res = await lambda.handler(signedEvent({ mode: 'understand', messages: msgs, canonical: { ...block, version: 1, state: first.state } }, { requestContext: { requestId: 'req-d2' } }));
    const ev = res.body.split('\n').filter(Boolean).map((l) => JSON.parse(l)).find((l) => l.type === 'understand');
    expect(mc1Calls[mc1Calls.length - 1].state.currentState).toMatchObject({ appliance: 'washing-machine', make: 'hotpoint', activeProblem: { journey: 'not-draining' } });
    expect(ev.canonical.classification.identity.appliance.value).toBeNull();
    expect(ev.canonical.classification.problem.journey).toBeNull();
    expect(ev.canonical.state.identity.appliance.value).toBe('washing-machine');
    expect(ev.canonical.state.version).toBe(2);
  });
});
