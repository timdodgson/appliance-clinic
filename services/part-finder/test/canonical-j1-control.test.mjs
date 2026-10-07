/**
 * Journey 1 canonical CONTROL wiring in part-finder (shared runtime): understand-mode journey step (gate, requests,
 * typed part lookup) and the diagnose-mode COMPOSE-wording-only response (media by check key, fixed
 * safety copy, contract checks, fallbacks). No network: provider/lookup are injected.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
globalThis.awslambda = globalThis.awslambda || { streamifyResponse: (f) => f, HttpResponseStream: { from: (s) => s } };
const L = require('../part-finder-lambda.js')._internal;
const { merge } = require('../canonical/merge.js');
const { emptyState } = require('../canonical/cs1.js');
const mc1 = require('../canonical/mc1.js');
const JC = require('../canonical/j1-compose.js');

const CSID = 'cs_' + 'a'.repeat(32);
const C = (f = {}) => mc1.validateClassification({ scope: 'appliance', ...f });
const WM = { identity: { appliance: { value: 'washing-machine', basis: 'stated' } }, problem: { journey: 'not-draining', faultDomain: 'water' } };
const CONTROL = { schema: 'cs/1', mode: 'control', control: { journeys: ['wm-not-draining'] }, sessionId: CSID, version: 0, state: null, degraded: null };
const SHADOW = { ...CONTROL, mode: 'shadow', control: undefined };
function transportFor(cs) {
  let s = emptyState(CSID);
  for (const c of cs) s = merge(s, c, { turn: s.version + 1 }).state;
  return { schema: 'cs/1', mode: 'control', sessionId: CSID, priorVersion: s.version - 1, version: s.version, state: s, classification: cs[cs.length - 1], rulesFired: [], requestOutcome: null, degraded: null };
}
const opener = C({ ...WM, observations: [{ key: 'waterRemaining', value: true }] });
const fakeProvider = (text) => ({ infer: async (req, { onDelta }) => { fakeProvider.last = req; onDelta(text); } });
afterEach(() => { delete process.env.CANONICAL_J1_CONTROL; });
// Journey 1 through the shared runtime (the same runJourney every journey uses)
const J1 = (tr, block, opts) => L.canonicalJourney(tr, block, 'wm-not-draining', opts);

describe('understand: Journey 1 through the shared journey runtime', () => {
  it('control + gate + J1 entry -> NextAction R7, request issued into state', async () => {
    const t = await J1(transportFor([opener]), CONTROL);
    expect(t.journey).toMatchObject({ applies: true, control: true });
    expect(t.journey.nextAction).toMatchObject({ kind: 'ask_check', target: 'drain-filter', rule: 'R7' });
    expect(t.issuedRequest).toMatchObject({ slot: 'CHECK', target: 'drain-filter', kind: 'ask', rule: 'R7' });
    expect(t.state.pendingRequest).toBe('q1');
    expect(t.journey.media).toMatchObject({ key: 'drain-filter' });
  });
  it('shadow block -> NextAction for trace only; no request, no state change', async () => {
    const tr = transportFor([opener]);
    const t = await J1(tr, SHADOW);
    expect(t.journey).toMatchObject({ applies: true, control: false, controlRequested: false });
    expect(t.issuedRequest).toBe(null);
    expect(JSON.stringify(t.state)).toBe(JSON.stringify(tr.state));
  });
  it('control requested but not Journey 1 (dishwasher / leaking) -> legacy', async () => {
    const dw = await J1(transportFor([C({ identity: { appliance: { value: 'dishwasher', basis: 'stated' } }, problem: { journey: 'not-draining' } })]), CONTROL);
    expect(dw.journey).toMatchObject({ applies: false, control: false, controlRequested: true });
    const lk = await J1(transportFor([C({ ...WM, problem: { journey: 'leaking', faultDomain: 'water' } })]), CONTROL);
    expect(lk.journey.control).toBe(false);
    expect(lk.issuedRequest).toBeUndefined();
  });
  it('gate without wm-not-draining, or kill switch -> no control', async () => {
    const other = await J1(transportFor([opener]), { ...CONTROL, control: { journeys: ['other'] } });
    expect(other.journey.control).toBe(false);
    process.env.CANONICAL_J1_CONTROL = '0';
    const killed = await J1(transportFor([opener]), CONTROL);
    expect(killed.journey.control).toBe(false);
  });
  it('degraded transport is passed through untouched', async () => {
    const d = { schema: 'cs/1', degraded: 'classification_degraded', state: null };
    expect(await L.canonicalJourneys(d, CONTROL)).toBe(d);
  });
  it('typed part lookup: confirmed model + sufficient evidence -> recommend_part with the matching pump only', async () => {
    const seq = [opener,
      C({ checks: [{ check: 'drain-filter', status: 'done', result: 'clear' }] }),
      C({ observations: [{ key: 'commandedDrain', value: false }, { key: 'pumpHumming', value: true }] }),
      C({ checks: [{ check: 'pump-impeller', status: 'done', result: 'clear' }] }),
      C({ checks: [{ check: 'drain-hose', status: 'done', result: 'clear' }] }),
      C({ identity: { model: { value: 'WAN28281GB', basis: 'stated' }, make: { value: 'bosch', basis: 'stated' } } })];
    const parts = [{ title: 'Drain Pump Filter', partNo: 'F1' }, { title: 'Drain Pump', partNo: 'P1', price: 30 }, { title: 'Door Seal', partNo: 'D1' }];
    let asked = null;
    const lookupFn = async (m) => { asked = m; return { parts, model: m }; };
    const t = await J1(transportFor(seq), CONTROL, { lookupFn });
    expect(asked).toBe('WAN28281GB');
    expect(t.journey.partLookup).toMatchObject({ available: true, component: 'drain-pump' });
    expect(t.journey.partLookup.parts.map((p) => p.partNo)).toEqual(['P1']);
    expect(t.journey.nextAction).toMatchObject({ kind: 'recommend_part', target: 'drain-pump', rule: 'R14' });
  });
  it('no part lookup at all unless the evidence + model gate is met (make only never looks up)', async () => {
    let called = false;
    const lookupFn = async () => { called = true; return { parts: [] }; };
    await J1(transportFor([C({ ...WM, identity: { ...WM.identity, make: { value: 'bosch', basis: 'stated' } }, observations: [{ key: 'waterRemaining', value: true }] })]), CONTROL, { lookupFn });
    expect(called).toBe(false);
  });
});

async function respond(cs, providerText, opts = {}) {
  const t = await J1(transportFor(cs), CONTROL, opts);
  return L.canonicalRespond({ canonical: t, messages: [{ role: 'user', content: 'x' }], requestId: 'r1' }, { provider: fakeProvider(providerText), ensureMedia: false });
}

describe('diagnose: canonicalRespond (COMPOSE wording only)', () => {
  it('ask filter: LLM wording kept; media selected by check key; one question; no parts', async () => {
    const txt = 'Switch the machine off and unplug it first. If it was a hot wash, let it cool. Put towels and a tray down. Unscrew the filter slowly and don\'t force it. What did you find in the filter?';
    const r = await respond([opener], txt);
    expect(r.reply).toBe(txt);
    expect(r.done.media.map((m) => m.id)).toEqual(['wm-pump-filter', 'wm-pump-unblock-howtorepair']);
    expect(r.done.parts).toEqual([]);
    expect(r.done.canonicalControl.compose.source).toBe('compose');
    expect(r.done.understood).toMatchObject({ grounded: true, faultId: 'not-draining', applianceType: 'washing-machine' });
    expect(fakeProvider.last.messages[1].content).toContain('End with this one question');
  });
  it('missing safety tokens are added from fixed copy (never dropped)', async () => {
    const r = await respond([opener], 'Have a look at the filter at the bottom front. What did you find?');
    expect(r.reply).toContain(JC.REQUIREMENT.isolate_mains.copy);
    expect(r.reply).toContain(JC.REQUIREMENT.contain_water.copy);
    expect(r.done.canonicalControl.compose.violations).toContain('safety-added:isolate_mains');
  });
  it('an extra question, a model ask or an invented part -> deterministic template', async () => {
    for (const bad of ['Unplug it. Check the filter? Also is the hose kinked? And what model is it? Any noise?',
      'Unplug it and check the filter. You may need to buy a new drain pump. What did you find?']) {
      const r = await respond([opener], bad);
      expect(r.done.canonicalControl.compose.source).toBe('template');
      expect(r.reply).toContain(JC.TASK['ask_check:drain-filter'].ask);
    }
  });
  it('safety stop: fixed copy only, no LLM, no media, safetyStop reason for the orchestrator', async () => {
    const r = await respond([opener, C({ safety: { hazard: 'electrical_water' } })], 'SHOULD NOT BE USED');
    expect(r.reply).toBe(JC.SAFETY_COPY.electrical_water);
    expect(r.done.safetyStop).toBe('electrical');
    expect(r.done.media).toEqual([]);
  });
  it('compose failure -> template (never stalls)', async () => {
    const t = await J1(transportFor([opener]), CONTROL);
    const r = await L.canonicalRespond({ canonical: t, messages: [], requestId: 'r' }, { provider: { infer: async () => { throw new Error('down'); } }, ensureMedia: false });
    expect(r.done.canonicalControl.compose.violations).toContain('compose_failed');
    expect(r.reply).toContain(JC.TASK['ask_check:drain-filter'].ask);
  });
  it('backflow conclusion shows the household-waste media; no part', async () => {
    const r = await respond([opener, C({ observations: [{ key: 'waterReturnsAfterDrain', value: true }] })], 'The problem is likely your household waste plumbing, not the machine. A plumber can clear the standpipe or sink trap; no machine part is needed.');
    expect(r.done.media.map((m) => m.id)).toEqual(['wm-backflow-sink-waste-pipe']);
    expect(r.done.parts).toEqual([]);
  });
  it('recommend_part carries the gated part card and purchase mention', async () => {
    const seq = [opener,
      C({ checks: [{ check: 'drain-filter', status: 'done', result: 'clear' }] }),
      C({ observations: [{ key: 'commandedDrain', value: false }, { key: 'pumpHumming', value: true }] }),
      C({ checks: [{ check: 'pump-impeller', status: 'done', result: 'clear' }] }),
      C({ checks: [{ check: 'drain-hose', status: 'done', result: 'clear' }] }),
      C({ identity: { model: { value: 'WAN28281GB', basis: 'stated' }, make: { value: 'bosch', basis: 'stated' } } })];
    const r = await respond(seq, 'With everything checked, the drain pump is the likely fault on your WAN28281GB. The matching drain pump is shown below.',
      { lookupFn: async () => ({ parts: [{ title: 'Drain Pump', partNo: 'P1' }] }) });
    expect(r.done.parts.map((p) => p.partNo)).toEqual(['P1']);
    expect(r.done.componentMention).toBe('purchase');
    expect(r.done.understood.candidateComponents).toEqual(['drain pump']);
  });
});

describe('legacy Journey 1 logic is bypassed on a controlled turn (structural)', () => {
  const fs = require('node:fs');
  const SRC = fs.readFileSync(new URL('../part-finder-lambda.js', import.meta.url), 'utf8');
  const handlerStart = SRC.indexOf("if (body.mode === 'understand')");
  const branch = SRC.indexOf('if (canonicalRuntime().controls(body.canonical)) {', handlerStart);
  it('the control branch returns before every legacy J1 progression / COMPOSE site in the handler', () => {
    expect(branch).toBeGreaterThan(handlerStart);
    const block = SRC.slice(branch, SRC.indexOf('\n    }\n', branch));
    expect(block).toContain('return;');
    for (const site of ['preferAccessibleFirstAction(intent, queryText, progress);', 'await composeStream(messages,',
      'reply = ensureAdviceThenIdentityAsk(reply, intent);', '|| latestTurnReportsRecovery(progress);']) {
      const at = SRC.indexOf(site, handlerStart);
      expect(at, site).toBeGreaterThan(branch);
    }
  });
  it('the canonical COMPOSE prompt carries no legacy J1 prompt rules (standing-water ordering, model-ask overrides)', () => {
    const F = require('./j1-state-fixture.cjs');
    const msgs = JC.prompt(JC.brief(F.base(), { kind: 'ask_check', target: 'drain-filter', requires: [], rule: 'R7', pending: null }, null, {}));
    const all = msgs.map((m) => m.content).join('\n');
    expect(all).not.toMatch(/STANDING WATER|drain command first|make and model/i);
  });
});

describe('j1-compose contract', () => {
  it('template for every policy action kind is non-empty and asks at most one question', () => {
    const F = require('./j1-state-fixture.cjs');
    const D = require('../canonical/j1-diagnostics.js');
    const P = require('../canonical/j1-policy.js');
    const states = [F.base(), F.check(F.base(), 'drain-filter', 'done', 'clear', 2), F.check(F.base(), 'drain-filter', 'done', 'found_and_cleared', 2),
      F.obs(F.base(), 'waterReturnsAfterDrain', true, 1), F.hazard(F.base(), 'electrical_water')];
    for (const s of states) {
      const a = P.policy(s, D.diagnose(s), {});
      const txt = JC.template(JC.brief(s, a, null, {}));
      expect(txt.length).toBeGreaterThan(20);
      expect((txt.match(/\?/g) || []).length).toBeLessThanOrEqual(1);
    }
  });
  it('the prompt never carries customer prose or the transcript', () => {
    const F = require('./j1-state-fixture.cjs');
    const a = { kind: 'ask_check', target: 'drain-filter', requires: ['isolate_mains'], rule: 'R7', pending: null };
    const msgs = JC.prompt(JC.brief(F.base(), a, null, {}));
    expect(msgs).toHaveLength(2);
    expect(msgs.map((m) => m.role)).toEqual(['system', 'user']);
  });
});
