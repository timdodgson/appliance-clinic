/**
 * Journey 3 canonical CONTROL wiring: journey routing (J1 -> J2 -> J3), its own gate / kill switch, typed model
 * part list -> part gate, COMPOSE wording-only response, media by action key, and the COMPOSE contract.
 * No network: provider / lookup injected.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
globalThis.awslambda = globalThis.awslambda || { streamifyResponse: (f) => f, HttpResponseStream: { from: (s) => s } };
const L = require('../part-finder-lambda.js')._internal;
const { merge } = require('../canonical/merge.js');
const { emptyState, newFact } = require('../canonical/cs1.js');
const mc1 = require('../canonical/mc1.js');
const JC = require('../canonical/j3-compose.js');
const P3 = require('../canonical/j3-policy.js');
const D3 = require('../canonical/j3-diagnostics.js');
const F = require('./j1-state-fixture.cjs');

const CSID = 'cs_' + 'c'.repeat(32);
const C = (f = {}) => mc1.validateClassification({ scope: 'appliance', ...f });
const WM = { identity: { appliance: { value: 'washing-machine', basis: 'stated' } }, problem: { journey: 'leaking', faultDomain: 'water' } };
const ALL = { schema: 'cs/1', mode: 'control', control: { journeys: ['wm-not-draining', 'wm-not-spinning', 'wm-leaking'] }, sessionId: CSID, version: 0, state: null, degraded: null };
const J12 = { ...ALL, control: { journeys: ['wm-not-draining', 'wm-not-spinning'] } };
function transportFor(cs) {
  let s = emptyState(CSID);
  for (const c of cs) s = merge(s, c, { turn: s.version + 1 }).state;
  return { schema: 'cs/1', mode: 'control', sessionId: CSID, priorVersion: s.version - 1, version: s.version, state: s, classification: cs[cs.length - 1], rulesFired: [], requestOutcome: null, degraded: null };
}
const fake = (text) => ({ infer: async (req, { onDelta }) => { fake.last = req; onDelta(text); } });
afterEach(() => { delete process.env.CANONICAL_J3_CONTROL; });
const opener = C({ ...WM });
const atDoor = C({ observations: [{ key: 'leakAtDoor', value: true }] });
const torn = C({ checks: [{ check: 'door-seal', status: 'done', result: 'fault_seen' }] });
const hotpoint = C({ identity: { model: { value: 'NSWM1043CW', basis: 'stated' }, make: { value: 'hotpoint', basis: 'stated' } } });
const PARTS = [{ title: 'Door Seal', partNo: 'S1', price: 40 }, { title: 'Door Lock', partNo: 'L1' }, { title: '2.05mtr Drain Hose', partNo: 'H1' },
  { title: 'Copreci Pump Filter Kit', partNo: 'F1' }, { title: 'Drain Pump', partNo: 'P1' }];

describe('understand: journey routing and gate', () => {
  it('leak opener -> Journey 3 controls (L6 where first); J1 / J2 do not apply', async () => {
    const t = await L.canonicalJourneys(transportFor([opener]), ALL);
    expect(t.journey.key).not.toBe('wm-not-draining');
    expect(t.journey).toMatchObject({ key: 'wm-leaking', applies: true, control: true });
    expect(t.journey.nextAction).toMatchObject({ kind: 'ask_observation', target: 'leakLocation', rule: 'L6' });
    expect(t.issuedRequest).toMatchObject({ target: 'leakLocation', journey: 'wm-leaking' });
    expect(L.canonicalControls(t)).toBe(true);
  });
  it('wm-leaking not allow-listed -> trace only (shadow), no request', async () => {
    const t = await L.canonicalJourneys(transportFor([opener]), J12);
    expect(t.journey).toMatchObject({ key: 'wm-leaking', applies: true, control: false });
    expect(t.issuedRequest).toBe(null);
    expect(L.canonicalControls(t)).toBe(false);
  });
  it('kill switch CANONICAL_J3_CONTROL=0 forces shadow', async () => {
    process.env.CANONICAL_J3_CONTROL = '0';
    const t = await L.canonicalJourneys(transportFor([opener]), ALL);
    expect(t.journey.control).toBe(false);
  });
  it('Journeys 1 and 2 still own their faults with J3 allow-listed', async () => {
    const j1 = await L.canonicalJourneys(transportFor([C({ identity: WM.identity, problem: { journey: 'not-draining' }, observations: [{ key: 'waterRemaining', value: true }] })]), ALL);
    expect(j1.journey.key).toBe('wm-not-draining');
    const j2 = await L.canonicalJourneys(transportFor([C({ identity: WM.identity, problem: { journey: 'not-spinning', faultDomain: 'motion' }, observations: [{ key: 'waterRemaining', value: false }, { key: 'drumTurns', value: true }] })]), ALL);
    expect(j2.journey).toMatchObject({ key: 'wm-not-spinning', control: true });
  });
  it('unrelated journeys stay legacy (dishwasher leak / dryer)', async () => {
    const dw = await L.canonicalJourneys(transportFor([C({ identity: { appliance: { value: 'dishwasher', basis: 'stated' } }, problem: { journey: 'leaking', faultDomain: 'water' } })]), ALL);
    expect(L.canonicalControls(dw)).toBe(false);
    const dryer = await L.canonicalJourneys(transportFor([C({ identity: { appliance: { value: 'tumble-dryer', basis: 'stated' } }, problem: { journey: 'not-heating' } })]), ALL);
    expect(L.canonicalControls(dryer)).toBe(false);
  });
  it('sink / waste backs up -> household plumbing, no machine part, backflow media', async () => {
    const t = await L.canonicalJourneys(transportFor([C({ ...WM, observations: [{ key: 'waterReturnsAfterDrain', value: true }, { key: 'leaksOnDrain', value: true }] })]), ALL);
    expect(t.journey.nextAction).toMatchObject({ kind: 'conclude', target: 'household-backflow', rule: 'L5' });
    expect(t.journey.nextAction.conclusion).toMatchObject({ handoff: 'plumbing', noPart: true });
    expect(t.journey.media).toMatchObject({ ids: ['wm-backflow-sink-waste-pipe'] });
  });
  it('torn seal + confirmed model -> part list fetched once; door seal only (never the door lock)', async () => {
    const asked = [];
    const lookupFn = async (m) => { asked.push(m); return { parts: PARTS }; };
    const t = await L.canonicalJourneys(transportFor([opener, atDoor, torn, hotpoint]), ALL, { lookupFn });
    expect(asked).toEqual(['NSWM1043CW']);
    expect(t.journey.nextAction).toMatchObject({ kind: 'recommend_part', target: 'door-seal', rule: 'L17' });
    expect(t.journey.partLookup.parts.map((p) => p.partNo)).toEqual(['S1']);
  });
  it('torn seal, make only -> model ask, no lookup, no part', async () => {
    const asked = [];
    const t = await L.canonicalJourneys(transportFor([opener, atDoor, torn, C({ identity: { make: { value: 'hotpoint', basis: 'stated' } } })]), ALL,
      { lookupFn: async (m) => { asked.push(m); return { parts: PARTS }; } });
    expect(asked).toEqual([]);
    expect(t.journey.nextAction).toMatchObject({ kind: 'ask_identity', target: 'model', rule: 'L16' });
  });
  it('torn seal, model has no seal listed -> no part (conclude)', async () => {
    const t = await L.canonicalJourneys(transportFor([opener, atDoor, torn, hotpoint]), ALL, { lookupFn: async () => ({ parts: [{ title: 'Door Lock' }] }) });
    expect(t.journey.nextAction.kind).not.toBe('recommend_part');
  });
  it('door check carries the door-seal media by action key', async () => {
    const t = await L.canonicalJourneys(transportFor([opener, atDoor]), ALL);
    expect(t.journey.nextAction).toMatchObject({ target: 'door-seal', rule: 'L8' });
    expect(t.journey.media).toMatchObject({ key: 'door-seal', ids: ['wm-door-seal'] });
  });
});

async function respond(cs, text, opts = {}) {
  const t = await L.canonicalJourneys(transportFor(cs), ALL, opts);
  return { t, r: await L.canonicalRespond({ canonical: t, messages: [], requestId: 'r' }, { provider: fake(text), ensureMedia: false }) };
}
describe('diagnose: COMPOSE wording only (Journey 3)', () => {
  it('location ask: wording kept, J3 understood facts', async () => {
    const txt = 'Sorry to hear it\'s leaking. Where do you see the water first — around the door, the detergent drawer, at the back, at the filter flap, or underneath?';
    const { r } = await respond([opener], txt);
    expect(r.reply).toBe(txt);
    expect(r.done.understood).toMatchObject({ faultId: 'leak-drain', fault: 'leaking' });
    expect(r.done.canonicalControl).toMatchObject({ journey: 'wm-leaking', compose: { source: 'compose' } });
  });
  it('door-seal check: missing isolation / look-only safety is added from fixed copy', async () => {
    const { r } = await respond([opener, atDoor], 'Have a look round the door seal. Is it intact, is something trapped, or is it torn?');
    expect(r.reply).toContain(JC.REQUIREMENT.isolate_mains.copy);
    expect(r.reply).toContain(JC.REQUIREMENT.look_and_feel_only.copy);
  });
  it('invented part / door lock / purchase language before the gate -> template', async () => {
    for (const bad of ['It is probably the door lock, you should buy a new door lock. Is the seal intact?',
      'You need a replacement door seal. Is the seal intact, trapped item, or torn?']) {
      const { r } = await respond([opener, atDoor], bad);
      expect(r.done.canonicalControl.compose.source).toBe('template');
      expect(r.reply).toContain(JC.TASK['ask_check:door-seal'].ask);
    }
  });
  it('a second question -> template (exactly the one decided question)', async () => {
    const { r } = await respond([opener], 'Where is the water coming from? And what is the model number?');
    expect(r.done.canonicalControl.compose.source).toBe('template');
    expect((r.reply.match(/\?/g) || []).length).toBe(1);
  });
  it('water near the socket -> fixed safety copy, no LLM', async () => {
    const { r } = await respond([opener, C({ safety: { hazard: 'electrical_water' } })], 'IGNORED');
    expect(r.reply).toBe(JC.SAFETY_COPY.electrical_water);
    expect(r.done.safetyStop).toBeTruthy();
  });
  it('major leak stated this turn -> fixed major-leak copy (water off, power only if dry)', async () => {
    const { t, r } = await respond([C({ ...WM, observations: [{ key: 'majorLeak', value: true }] })], 'IGNORED');
    expect(t.journey.nextAction).toMatchObject({ kind: 'safety_stop', target: 'major-leak' });
    expect(r.reply).toBe(JC.SAFETY_COPY['major-leak']);
    expect(r.reply).toMatch(/tap/i);
  });
  it('recommend_part (door seal) may name the part', async () => {
    const txt = 'The split in the door seal explains the leak. The matching door seal for your NSWM1043CW is shown below.';
    const { r } = await respond([opener, atDoor, torn, hotpoint], txt, { lookupFn: async () => ({ parts: PARTS }) });
    expect(r.done.canonicalControl.compose.source).toBe('compose');
    expect(r.reply).toContain('door seal');
  });
});

describe('typed part-family matchers over real catalogue titles', () => {
  const J3 = require('../canonical/j3-pipeline.js');
  const pick = (titles, comp) => J3.partLookupFrom(titles.map((title) => ({ title })), comp).parts.map((p) => p.title);
  it('door seal: seal / boot gasket, never door lock or tub gasket', () => {
    expect(pick(['Door Lock', 'Door Seal', 'Door Interlock'], 'door-seal')).toEqual(['Door Seal']);
    expect(pick(['Door Boot Gasket', 'Tub Gasket Seal', 'Oil Seal Bearing'], 'door-seal')).toEqual(['Door Boot Gasket']);
  });
  it('pump filter: pump filter kit, never a mains filter suppressor', () => {
    expect(pick(['Copreci Pump Filter Kit', 'Askoll Drain Pump'], 'pump-filter')).toEqual(['Copreci Pump Filter Kit']);
    expect(pick(['Mains Filter Suppressor'], 'pump-filter')).toEqual([]);
  });
  it('drain hose / dispenser drawer', () => {
    expect(pick(["2.05mtr Drain Hose 17mm With Right Angle End 31mm Dia.S'", 'Genuine Washing Machine Drainage Pump'], 'drain-hose')).toHaveLength(1);
    expect(pick(['Dispenser Drawer', 'Handle'], 'detergent-drawer')).toEqual(['Dispenser Drawer']);
    expect(pick(['Fill Valve', 'Solenoid Cold 2 Way'], 'inlet-hose')).toEqual([]);
  });
});

describe('COMPOSE contract', () => {
  const B = () => { const s = F.base(); s.problems[0].journey = newFact('leaking', 'stated', 1); F.delObs(s, 'waterRemaining'); return s; };
  const o = (s, k, v = true, t = 1) => F.obs(s, k, v, t);
  const c = (s, k, r, t = 2) => F.check(s, k, 'done', r, t);
  const decide = (s) => P3.policy(s, D3.diagnose(s), {});
  it('every J3 action template is non-empty, ≤1 question, no purchase language unless recommend_part', () => {
    const states = [B(), o(B(), 'leakAtDoor'), o(B(), 'leakAtRear'), o(o(B(), 'leakAtRear'), 'leaksOnFill'), o(o(B(), 'leakAtRear'), 'leaksOnDrain'),
      o(B(), 'drawerOverflowing'), o(o(B(), 'leakAtFilter'), 'recentFilterAccess'), c(o(B(), 'leakAtDoor'), 'door-seal', 'fault_seen'),
      c(o(B(), 'leakAtDoor'), 'door-seal', 'found_and_cleared'), o(c(o(B(), 'leakAtDoor'), 'door-seal', 'found_and_cleared'), 'leakRecurs', false, 3),
      o(o(B(), 'waterReturnsAfterDrain'), 'leaksOnDrain'), F.hazard(B(), 'electrical_water'), o(B(), 'majorLeak', true, 0)];
    const kinds = new Set();
    for (const s of states) {
      const a = decide(s); kinds.add(a.kind);
      const txt = JC.template(JC.brief(s, a, null, {}));
      expect(txt.length).toBeGreaterThan(20);
      expect((txt.match(/\?/g) || []).length).toBeLessThanOrEqual(1);
      expect(/\b(buy|order|purchase)\b/i.test(txt)).toBe(false);
      expect(/door (lock|interlock)/i.test(txt)).toBe(false);
    }
    expect([...kinds]).toEqual(expect.arrayContaining(['ask_observation', 'ask_check', 'ask_identity', 'conclude', 'safety_stop']));
  });
  it('(live c11/c03) internal conclusions only claim the checks that actually came back clear', () => {
    const u = o(B(), 'leakUnderneath'); F.request(u, 'leakTiming', 'ask', 'cannot_answer', 1, 'OBSERVATION');
    const a = decide(u);
    expect(a).toMatchObject({ kind: 'conclude', rule: 'L18' });
    const tu = JC.template(JC.brief(u, a, null, {}));
    expect(tu).not.toMatch(/ruled out|checked and fine/i);
    expect(tu).toMatch(/engineer/);
    const p = c(c(o(o(B(), 'leakUnderneath'), 'leaksOnDrain'), 'filter-seal', 'clear', 2), 'drain-connection', 'clear', 3);
    const tp = JC.template(JC.brief(p, decide(p), null, {}));
    expect(tp).toMatch(/the filter cap and the drain hose checked and fine/);
    expect(tp).not.toMatch(/door seal/);
    const d = o(c(c(o(o(B(), 'leakAtDrawer'), 'drawerOverflowing'), 'detergent-drawer', 'found_and_cleared', 2), 'detergent-dose', 'clear', 4), 'leakRecurs', true, 3);
    const ad = decide(d);
    expect(ad).toMatchObject({ kind: 'conclude', target: 'inlet-valve-or-fill' });
    const td = JC.template(JC.brief(d, ad, null, {}));
    expect(td).toMatch(/drawer that still overflows/);
    expect(td).not.toMatch(/hose connections are sound/);
  });
  it('backflow conclusion says plumbing and no machine part', () => {
    const s = o(o(B(), 'waterReturnsAfterDrain'), 'leaksOnDrain');
    expect(JC.template(JC.brief(s, decide(s), null, {}))).toMatch(/plumb.*no machine part/is);
  });
  it('the prompt carries no transcript and no legacy prompt rules', () => {
    const s = o(B(), 'leakAtDoor');
    const msgs = JC.prompt(JC.brief(s, decide(s), null, {}));
    expect(msgs.map((m) => m.role)).toEqual(['system', 'user']);
    expect(msgs.map((m) => m.content).join('\n')).not.toMatch(/STANDING WATER|make and model/i);
  });
  it('unsafe instructions never appear in fixed copy (no live leak tracing, no panels off, no tilting)', () => {
    const all = JSON.stringify(JC.TASK) + JSON.stringify(Object.values(JC.REQUIREMENT).map((r) => r.copy)) + JSON.stringify(JC.SAFETY_COPY);
    expect(all).not.toMatch(/multimeter|remove the (back|top) panel|with the panels? off|tilt the machine|lay it on its|while (it'?s )?plugged in and/i);
  });
});
