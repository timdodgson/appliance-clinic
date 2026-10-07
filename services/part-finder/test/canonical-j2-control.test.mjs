/**
 * Journey 2 canonical CONTROL wiring: journey routing (J1 first, then J2), its own gate, typed model part
 * list -> architecture + part lookup, COMPOSE wording-only response, media by action key, and the COMPOSE
 * contract (layer F). No network: provider / lookup injected.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
globalThis.awslambda = globalThis.awslambda || { streamifyResponse: (f) => f, HttpResponseStream: { from: (s) => s } };
const L = require('../part-finder-lambda.js')._internal;
const { merge } = require('../canonical/merge.js');
const { emptyState } = require('../canonical/cs1.js');
const mc1 = require('../canonical/mc1.js');
const JC = require('../canonical/j2-compose.js');
const P2 = require('../canonical/j2-policy.js');
const D2 = require('../canonical/j2-diagnostics.js');
const F = require('./j2-state-fixture.cjs');

const CSID = 'cs_' + 'b'.repeat(32);
const C = (f = {}) => mc1.validateClassification({ scope: 'appliance', ...f });
const WM = { identity: { appliance: { value: 'washing-machine', basis: 'stated' } }, problem: { journey: 'not-spinning', faultDomain: 'motion' } };
const BOTH = { schema: 'cs/1', mode: 'control', control: { journeys: ['wm-not-draining', 'wm-not-spinning'] }, sessionId: CSID, version: 0, state: null, degraded: null };
const J1ONLY = { ...BOTH, control: { journeys: ['wm-not-draining'] } };
function transportFor(cs) {
  let s = emptyState(CSID);
  for (const c of cs) s = merge(s, c, { turn: s.version + 1 }).state;
  return { schema: 'cs/1', mode: 'control', sessionId: CSID, priorVersion: s.version - 1, version: s.version, state: s, classification: cs[cs.length - 1], rulesFired: [], requestOutcome: null, degraded: null };
}
const fake = (text) => ({ infer: async (req, { onDelta }) => { fake.last = req; onDelta(text); } });
afterEach(() => { delete process.env.CANONICAL_J2_CONTROL; });
const opener = C({ ...WM, observations: [{ key: 'waterRemaining', value: false }, { key: 'drumTurns', value: true }] });

describe('understand: journey routing and gate', () => {
  it('not-spinning + drains -> Journey 2 controls (S12), Journey 1 does not apply', async () => {
    const t = await L.canonicalJourneys(transportFor([opener]), BOTH);
    expect(t.journey.key).not.toBe('wm-not-draining');
    expect(t.journey).toMatchObject({ key: 'wm-not-spinning', applies: true, control: true });
    expect(t.journey.nextAction).toMatchObject({ rule: 'S12', target: 'empty-spin-test' });
    expect(t.issuedRequest).toMatchObject({ target: 'empty-spin-test', journey: 'wm-not-spinning' });
  });
  it('not-spinning + water left -> Journey 1 owns it (drain first), no Journey 2 request', async () => {
    const t = await L.canonicalJourneys(transportFor([C({ ...WM, observations: [{ key: 'waterRemaining', value: true }] })]), BOTH);
    expect(t.journey).toMatchObject({ key: 'wm-not-draining', applies: true, control: true });
    expect(t.journey.key).toBe('wm-not-draining');
    expect(t.issuedRequest).toMatchObject({ target: 'drain-filter' });
  });
  it('J2 not in the allow-list -> trace only (shadow), no request; Journey 1 unaffected', async () => {
    const t = await L.canonicalJourneys(transportFor([opener]), J1ONLY);
    expect(t.journey).toMatchObject({ key: 'wm-not-spinning', applies: true, control: false });
    expect(t.issuedRequest).toBe(null);
    expect(L.canonicalControls(t)).toBe(false);
  });
  it('kill switch CANONICAL_J2_CONTROL=0 forces shadow', async () => {
    process.env.CANONICAL_J2_CONTROL = '0';
    const t = await L.canonicalJourneys(transportFor([opener]), BOTH);
    expect(t.journey.control).toBe(false);
  });
  it('unrelated journeys stay legacy (leak without its own gate / dryer)', async () => {
    // Leaking is Journey 3: it applies, but with only J1+J2 allow-listed it is shadow (no request, legacy answers).
    const leak = await L.canonicalJourneys(transportFor([C({ ...WM, problem: { journey: 'leaking', faultDomain: 'water' } })]), BOTH);
    expect(leak.journey).toMatchObject({ key: 'wm-leaking', control: false });
    expect(leak.issuedRequest).toBe(null);
    expect(L.canonicalControls(leak)).toBe(false);
    const dryer = await L.canonicalJourneys(transportFor([C({ identity: { appliance: { value: 'tumble-dryer', basis: 'stated' } }, problem: { journey: 'not-spinning' } })]), BOTH);
    expect(dryer.journey.applies).toBe(false);
    expect(dryer.issuedRequest).toBeUndefined();
  });
  it('confirmed model -> part list fetched once; belt-drive model with belt-off evidence -> recommend drive belt', async () => {
    const seq = [C({ ...WM, observations: [{ key: 'waterRemaining', value: false }, { key: 'drumTurns', value: false }] }),
      C({ checks: [{ check: 'drum-by-hand', status: 'done' }], observations: [{ key: 'drumUnusuallyFree', value: true }] }),
      C({ observations: [{ key: 'motorAudible', value: true }] }),
      C({ identity: { model: { value: 'WMB81445LW', basis: 'stated' }, make: { value: 'beko', basis: 'stated' } } })];
    const asked = [];
    const lookupFn = async (m) => { asked.push(m); return { parts: [{ title: 'Elastic Poly-Vee Belt 1270 J5', partNo: 'B1' }, { title: 'Door Seal', partNo: 'S1' }] }; };
    const t = await L.canonicalJourneys(transportFor(seq), BOTH, { lookupFn });
    expect(asked).toEqual(['WMB81445LW']);
    expect(t.journey.diagnostics.architecture).toMatchObject({ drive: 'belt' });
    expect(t.journey.nextAction).toMatchObject({ kind: 'recommend_part', target: 'drive-belt', rule: 'S18' });
    expect(t.journey.partLookup.parts.map((p) => p.partNo)).toEqual(['B1']);
  });
  it('LG with the same evidence -> belt impossible even if a belt were listed', async () => {
    const seq = [C({ ...WM, observations: [{ key: 'waterRemaining', value: false }, { key: 'drumTurns', value: false }] }),
      C({ checks: [{ check: 'drum-by-hand', status: 'done' }], observations: [{ key: 'drumUnusuallyFree', value: true }] }),
      C({ observations: [{ key: 'motorAudible', value: true }] }),
      C({ identity: { model: { value: 'F4V5VYP0W', basis: 'stated' }, make: { value: 'lg', basis: 'stated' } } })];
    const t = await L.canonicalJourneys(transportFor(seq), BOTH, { lookupFn: async () => ({ parts: [{ title: 'Poly-Vee Drive Belt' }] }) });
    expect(t.journey.nextAction.kind).not.toBe('recommend_part');
    expect(t.journey.diagnostics.architecture).toMatchObject({ drive: 'direct', motor: 'brushless' });
  });
});

async function respond(cs, text, opts = {}) {
  const t = await L.canonicalJourneys(transportFor(cs), BOTH, opts);
  return { t, r: await L.canonicalRespond({ canonical: t, messages: [], requestId: 'r' }, { provider: fake(text), ensureMedia: false }) };
}
describe('diagnose: COMPOSE wording only (Journey 2)', () => {
  it('empty-spin ask: wording kept, J2 understood facts, requires present', async () => {
    const txt = 'Thanks. Take the washing out, pause or cancel the programme and wait for the door to unlock before opening it. Run a spin-only programme with the drum empty — if it bangs or shakes violently, stop it straight away. Does it spin up properly when it\'s empty?';
    const { r } = await respond([opener], txt);
    expect(r.reply).toBe(txt);
    expect(r.done.understood).toMatchObject({ faultId: 'motor-drum', fault: 'not spinning' });
    expect(r.done.canonicalControl).toMatchObject({ journey: 'wm-not-spinning', compose: { source: 'compose' } });
  });
  it('missing door/shaking safety is added from fixed copy', async () => {
    const { r } = await respond([opener], 'Please run a spin with the drum empty. Does it spin up properly when it\'s empty?');
    expect(r.reply).toContain(JC.REQUIREMENT.pause_wait_door_unlock.copy);
    expect(r.reply).toContain(JC.REQUIREMENT.stop_if_violent_shaking.copy);
  });
  it('invented part / model ask / extra questions -> template', async () => {
    for (const bad of ['It is probably the carbon brushes, you should buy new carbon brushes. Does it spin empty?',
      'Run it empty. What is the model number? Does it spin? Is it loud?']) {
      const { r } = await respond([opener], bad);
      expect(r.done.canonicalControl.compose.source).toBe('template');
      expect(r.reply).toContain(JC.TASK['ask_check:empty-spin-test'].ask);
    }
  });
  it('a second (even rephrased) question -> template (exactly the one decided question)', async () => {
    const { r } = await respond([opener], 'Could you tell me what happens next? Specifically, does it spin up properly when it\'s empty?');
    expect(r.done.canonicalControl.compose.violations).toContain('extra-questions');
    expect((r.reply.match(/\?/g) || []).length).toBe(1);
  });
  it('burning smell -> fixed safety copy, no LLM', async () => {
    const { r } = await respond([opener, C({ safety: { hazard: 'burning' } })], 'IGNORED');
    expect(r.reply).toBe(JC.SAFETY_COPY.burning);
    expect(r.done.safetyStop).toBe('burning');
  });
  it('door check carries the door-lock media by action key', async () => {
    const t = await L.canonicalJourneys(transportFor([C({ ...WM, observations: [{ key: 'waterRemaining', value: false }, { key: 'drumTurns', value: false }, { key: 'doorLocks', value: false }] })]), BOTH);
    expect(t.journey.nextAction.target).toBe('door-closed-latched');
    expect(t.journey.media).toMatchObject({ knowledgeId: 'washing-machine:door-lock', ids: ['wm-door-lock-about'] });
  });
});

describe('COMPOSE contract (layer F)', () => {
  const B = () => F.base();
  it('every J2 action template is non-empty, has at most one question, and no purchase language unless recommend_part', () => {
    const states = [B(), F.delObs(B(), 'waterRemaining'), F.obs(B(), 'drumTurns', true, 1), F.obs(F.obs(B(), 'drumTurns', true, 1), 'spinsEmpty', true, 2),
      F.obs(B(), 'drumTurns', false, 1), F.obs(F.obs(B(), 'drumTurns', false, 1), 'doorLocks', false, 1), F.hazard(B(), 'burning'),
      F.obs(F.check(F.obs(B(), 'drumTurns', true, 1), 'drum-by-hand', 'done', 'fault_seen', 2), 'grindingNoise', true, 1)];
    for (const s of states) {
      const a = P2.policy(s, D2.diagnose(s), {});
      const txt = JC.template(JC.brief(s, a, null, {}));
      expect(txt.length).toBeGreaterThan(20);
      expect((txt.match(/\?/g) || []).length).toBeLessThanOrEqual(1);
      expect(/\b(buy|order|purchase)\b/i.test(txt)).toBe(false);
    }
  });
  it('direct-drive / brushless conclusions state the architecture (belt / brushes impossible)', () => {
    const s = F.model(F.obs(F.obs(F.check(F.obs(B(), 'drumTurns', false, 1), 'drum-by-hand', 'done', 'clear', 2), 'motorAudible', false, 3), 'drumTurns', false, 1), 'F4V5VYP0W', 'lg');
    const a = P2.policy(s, D2.diagnose(s, { errorCodes: require('../faults-catalogue.json').errorCodes }), {});
    const b = JC.brief(s, a, null, {});
    expect(b.facts.join(' ')).toMatch(/no drive belt/);
    expect(b.facts.join(' ')).toMatch(/no carbon brushes/);
    expect(JC.template(b)).toMatch(/carbon brushes can't be the cause/);
  });
  it('the prompt carries no transcript and no legacy prompt rules', () => {
    const s = F.obs(B(), 'drumTurns', true, 1);
    const msgs = JC.prompt(JC.brief(s, P2.policy(s, D2.diagnose(s), {}), null, {}));
    expect(msgs.map((m) => m.role)).toEqual(['system', 'user']);
    expect(msgs.map((m) => m.content).join('\n')).not.toMatch(/STANDING WATER|make and model/i);
  });
  it('unsafe instructions never appear in fixed copy (no live tests, no bypass, no panels-off running)', () => {
    const all = JSON.stringify(JC.TASK) + JSON.stringify(Object.values(JC.REQUIREMENT).map((r) => r.copy));
    expect(all).not.toMatch(/multimeter|test the (motor|voltage)|(?<!force or )bypass the|while (it'?s )?plugged in|remove the back panel/i);
  });
});
