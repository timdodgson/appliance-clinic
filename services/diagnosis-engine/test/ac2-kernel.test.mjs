/**
 * ac2 guardrail kernel: the deterministic parts of an LLM-led turn. The reasoner is a stub here; what is tested is what
 * the kernel lets through: the evidence ledger, contradictions, claim verification, the safety kernel, the repeated
 * question guard, scope, the part gate and provider-failure behaviour.
 */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const L = require('../ac2/ledger.js');
const S = require('../ac2/safety.js');
const V = require('../ac2/verifier.js');
const P = require('../ac2/parts.js');
const { runTurn, ProviderUnavailableError } = require('../ac2/turn.js');

const ctx = (texts, turn = 1) => ({ turn, customerTexts: texts });
const user = (content) => ({ role: 'user', content });
const asst = (content) => ({ role: 'assistant', content });

function proposal(over = {}) {
  return {
    understanding: { appliance: { value: 'dishwasher', quote: 'dishwasher', basis: 'stated' }, brand: null, model: null, codes: [], newFacts: [],
      lastQuestionAnswer: 'not_applicable', customerQuestion: null, outOfScope: { is: false, what: null }, ...(over.understanding || {}) },
    assessment: { status: 'gathering', candidates: [], confidence: 'low', knowledgeIds: [], summary: null, ...(over.assessment || {}) },
    next: over.next === undefined ? { key: 'filter_checked', question: 'Have you been able to check the filter?' } : over.next,
    part: over.part || null,
    escalation: over.escalation || null,
    reply: over.reply || 'Let\'s start with the filter. Have you been able to check the filter?',
  };
}
/** A stub provider: reasoning calls return the queued proposals in order; extraction calls return `claims`. */
function stub(proposals, claims = []) {
  const queue = [...proposals];
  const calls = { reason: 0, extract: 0 };
  return {
    calls,
    name: 'stub',
    model: 'stub-model',
    async infer(req) {
      if (req.messages[0].content.startsWith('You check')) { calls.extract += 1; return { status: 200, text: JSON.stringify({ claims: typeof claims === 'function' ? claims(req) : claims }) }; }
      calls.reason += 1;
      const p = queue.length > 1 ? queue.shift() : queue[0];
      return { status: 200, text: JSON.stringify(p) };
    },
  };
}
const deps = (p, extra = {}) => ({ reasoner: p, extractor: p, lookupParts: async () => ({ parts: [], model: null }), mediaFor: async () => [], ...extra });

describe('evidence ledger', () => {
  it('records a customer fact only with the customer\'s own words; otherwise it is an inference', () => {
    const s = L.empty();
    const c = ctx(['My dishwasher has water left in the bottom']);
    const a = L.recordFact(s, { field: 'water_remaining', value: 'yes', quote: 'water left in the bottom' }, c);
    const b = L.recordFact(s, { field: 'filter_clean', value: 'yes', quote: 'the filter is clean' }, c);
    expect(a).toMatchObject({ source: 'customer', status: 'stated', quote: 'water left in the bottom' });
    expect(b).toMatchObject({ source: 'inference', status: 'inferred', quote: null });
    expect(L.supportingFacts(s).map((f) => f.field)).toEqual(['water_remaining']);
  });

  it('keeps both values when the customer contradicts an earlier answer, and marks the earlier one', () => {
    const s = L.empty();
    L.recordFact(s, { field: 'pump_humming', value: 'yes', quote: 'I can hear it humming' }, ctx(['I can hear it humming']));
    L.recordFact(s, { field: 'pump_humming', value: 'no', quote: 'actually it is silent' }, ctx(['I can hear it humming', 'actually it is silent'], 2));
    expect(s.facts.map((f) => [f.value, f.status])).toEqual([['yes', 'contradicted'], ['no', 'stated']]);
    expect(L.contradictions(s)).toHaveLength(1);
  });

  it('never lets an inference override what the customer said', () => {
    const s = L.empty();
    L.recordFact(s, { field: 'door_locked', value: 'yes', quote: 'the door is locked' }, ctx(['the door is locked']));
    expect(L.recordFact(s, { field: 'door_locked', value: 'no', source: 'inference' }, ctx(['the door is locked']))).toBeNull();
  });

  it('only records a brand, model or code the customer actually wrote', () => {
    const s = L.empty();
    const c = ctx(['Bosch SMS46 shows E24']);
    L.setIdentity(s, 'brand', { value: 'Bosch', quote: 'Bosch' }, c);
    L.setIdentity(s, 'model', { value: 'SMS4HVI33E', quote: 'SMS4HVI33E' }, c);
    L.addCode(s, 'E24', 'E24', c);
    L.addCode(s, 'E15', 'E15', c);
    expect([s.brand && s.brand.value, s.model, s.codes.map((x) => x.code)]).toEqual(['Bosch', null, ['E24']]);
  });
});

describe('claim verifier', () => {
  const state = () => {
    const s = L.empty();
    L.recordFact(s, { field: 'water_remaining', value: 'yes', quote: 'water left in the bottom' }, ctx(['water left in the bottom']));
    return s;
  };
  it('rejects an attributed claim the customer never made, even without the extractor', async () => {
    const v = await V.verify('As you said, the filter is clean. Next, check the hose.', state(), ['water left in the bottom']);
    expect(v.ok).toBe(false);
    expect(V.neutralise(v)).toBe('Next, check the hose.');
  });
  it('accepts a claim backed by a recorded customer fact', async () => {
    const extract = async () => ({ json: { claims: [{ sentence: 1, claim: 'there is water left in the bottom', supportedBy: ['f1'] }] } });
    const v = await V.verify('There is water left in the bottom. Check the filter next.', state(), ['water left in the bottom'], { extract });
    expect(v.ok).toBe(true);
  });
  it('rejects an extracted claim citing nothing, and is not excused by a hedge elsewhere in the sentence', async () => {
    const extract = async () => ({ json: { claims: [{ sentence: 1, claim: 'your filter is clean', supportedBy: ['f1'] }] } });
    const v = await V.verify('Your filter is clean, so it could be the pump.', state(), ['water left in the bottom'], { extract });
    expect(v.rejected.map((r) => r.claim)).toEqual(['your filter is clean']);
  });
});

describe('safety kernel', () => {
  it('detects hazards in the customer\'s words, respecting negation', () => {
    expect(S.detectHazards([user('There is a burning smell from the back')]).map((h) => h.type)).toEqual(['burning']);
    expect(S.detectHazards([user('No burning smell, it just stopped')])).toEqual([]);
    expect(S.detectHazards([user('I can smell gas near the hob')]).map((h) => h.type)).toEqual(['gas']);
    expect(S.detectHazards([user('The battery is swollen and really hot')]).map((h) => h.type)).toContain('battery');
    expect(S.detectHazards([user('it sparked inside')], 'microwave').map((h) => h.type)).toEqual(['microwave_arcing']);
    expect(S.detectHazards([user('the water is only inside the fridge by the way, nowhere near the plug')])).toEqual([]);
    expect(S.detectHazards([user('There\'s water all over the floor and its gone under the units to where the plug is')]).map((h) => h.type)).toEqual(['electrical_water']);
    expect(S.detectHazards([user('my fridge freezer tripped the electrics')]).map((h) => h.type)).toEqual(['supply_trip']);
  });
  it('removes prohibited advice and keeps warnings not to do it', () => {
    const g = S.gateReply('Discharge the capacitor with a screwdriver. Never remove the outer casing yourself.', { appliance: 'microwave' });
    expect(g.text).toBe('Never remove the outer casing yourself.');
    expect(g.violations.map((v) => v.rule)).toEqual(['hv-microwave']);
    const b = S.gateReply('Run it again on an empty cycle to see if the smell returns.', { hazards: [{ type: 'burning' }] });
    expect(b.violations.map((v) => v.rule)).toEqual(['run-after-burning']);
  });
  it('recognises unsafe requests', () => {
    expect(S.detectUnsafeRequest('how do I discharge the capacitor', 'microwave')).toBe('microwave_hv');
    expect(S.detectUnsafeRequest('can I bypass the thermal fuse')).toBe('bypass');
  });
});

describe('turn (stub reasoner)', () => {
  it('a gas smell stops with the fixed emergency wording and does not call the reasoner', async () => {
    const p = stub([proposal()]);
    const out = await runTurn({ messages: [user('I can smell gas when I turn the hob on')] }, deps(p));
    expect(out.response.outcome).toBe('SAFETY_STOP');
    expect(out.response.message).toMatch(/0800 111 999/);
    expect(p.calls.reason).toBe(0);
  });

  it('a burning smell shows the fixed wording once, keeps helping, and blocks advice to run it', async () => {
    const p = stub([proposal({ reply: 'Run a short test cycle to see if it happens again. Is the smell coming from the back?' })]);
    const out = await runTurn({ messages: [user('My tumble dryer smelt of burning yesterday')] }, deps(p));
    expect(out.response.message.startsWith(S.COPY.burning)).toBe(true);
    expect(out.response.message).not.toMatch(/test cycle/);
    expect(out.response.safety).toMatchObject({ stopUse: true, class: 'burning' });
    expect(out.audit.regenerated).toBe(true);
    const next = await runTurn({ messages: [user('My tumble dryer smelt of burning yesterday'), asst(out.response.message), user('It came from the back')], state: out.state },
      deps(stub([proposal({ next: null, reply: 'That points to the heater area; please leave it unplugged and have an engineer look.' })])));
    expect(next.response.message.includes(S.COPY.burning)).toBe(false);
  });

  it('an unsupported claim is regenerated away; the ledger keeps grounded facts', async () => {
    const bad = proposal({ reply: 'You\'ve already cleaned the filter, so it is probably the pump.', understanding: { newFacts: [{ field: 'water_remaining', value: 'yes', quote: 'water in the bottom', status: 'stated' }] } });
    const good = proposal({ reply: 'If the filter has not been cleaned yet, that is the first thing to check. Have you been able to check the filter?' });
    const p = stub([bad, good]);
    const out = await runTurn({ messages: [user('dishwasher has water in the bottom')] }, deps(p));
    expect(out.response.message).toMatch(/^If the filter/);
    expect(out.audit.claims.rejected.length).toBeGreaterThan(0);
    expect(out.state.facts[0]).toMatchObject({ field: 'water_remaining', source: 'customer' });
  });

  it('does not ask again a question the customer could not answer', async () => {
    const ask = proposal({ next: { key: 'pump_noise', question: 'Can you hear the pump humming when it tries to drain?' }, reply: 'Can you hear the pump humming when it tries to drain?' });
    const t1 = await runTurn({ messages: [user('dishwasher won\'t drain')] }, deps(stub([ask])));
    const unknown = proposal({ ...ask, understanding: { lastQuestionAnswer: 'unknown' } });
    const msgs = [user('dishwasher won\'t drain'), asst(t1.response.message), user('I don\'t know, I can\'t tell')];
    const t2 = await runTurn({ messages: msgs, state: t1.state }, deps(stub([unknown, proposal({ next: { key: 'filter_checked', question: 'Have you been able to check the filter?' } })])));
    const msgs3 = [...msgs, asst(t2.response.message), user('no idea')];
    const t3 = await runTurn({ messages: msgs3, state: t2.state }, deps(stub([ask, ask])));
    expect(t3.audit.safety.gates.map((g) => g.gate)).toContain('repeated-question');
    expect(t3.response.message).not.toMatch(/pump humming/);
  });

  it('adds the isolation step to a physical check that lacks it, once', async () => {
    const p = stub([proposal({ next: null, reply: 'Open the flap at the bottom and unscrew the pump filter to look for a coin.' })]);
    const out = await runTurn({ messages: [user('dishwasher won\'t drain')] }, deps(p));
    expect(out.response.message).toMatch(/^Before you start, switch it off and unplug it\./);
    const already = await runTurn({ messages: [user('it is unplugged and the dishwasher won\'t drain')] }, deps(stub([proposal({ next: null, reply: 'Unscrew the pump filter to look for a coin.' })])));
    expect(already.response.message).not.toMatch(/Before you start/);
  });

  it('answers out-of-scope appliances with the scope reply instead of intake questions', async () => {
    const p = stub([proposal({ understanding: { appliance: { value: 'other', quote: 'boiler', basis: 'stated' }, outOfScope: { is: true, what: 'boiler' } } })]);
    const out = await runTurn({ messages: [user('My boiler keeps losing pressure')] }, deps(p));
    expect(out.response.message).toMatch(/can't diagnose that one/);
    expect(out.response.message).toMatch(/Gas Safe/);
  });

  it('fails explicitly when the provider cannot run: no fallback answer', async () => {
    const dead = { name: 'x', async infer() { const e = new Error('timeout'); e.category = 'TIMEOUT'; throw e; } };
    await expect(runTurn({ messages: [user('washing machine won\'t spin')] }, deps(dead))).rejects.toBeInstanceOf(ProviderUnavailableError);
  });
});

describe('part gate', () => {
  const st = () => {
    const s = L.empty();
    L.recordFact(s, { field: 'pump_humming_no_drain', value: 'yes', quote: 'it hums but nothing drains' }, ctx(['it hums but nothing drains, filter is clear']));
    L.recordFact(s, { field: 'filter_clear', value: 'yes', quote: 'filter is clear' }, ctx(['it hums but nothing drains, filter is clear']));
    return s;
  };
  const narrowed = (over = {}) => proposal({ assessment: { status: 'narrowed', confidence: 'high', candidates: [{ cause: 'drain pump', likelihood: 'high', evidence: ['f1', 'f2'] }] }, part: { component: 'drain pump', evidence: ['f1', 'f2'] }, ...over });
  const lookup = async () => ({ model: 'SMS46GI01G', parts: [{ partNo: '1', title: 'Drain Pump 30W' }, { partNo: '2', title: 'Wash Pump Heater' }] });

  it('needs the model before naming a buyable part', async () => {
    const d = await P.gate(narrowed(), st(), null, { lookup, appliance: 'dishwasher' });
    expect(d.outcome).toBe('model_needed');
  });
  it('verifies a catalogue part for a known model', async () => {
    const s = st();
    L.setIdentity(s, 'model', { value: 'SMS46GI01G', quote: 'SMS46GI01G' }, ctx(['model SMS46GI01G']));
    const d = await P.gate(narrowed(), s, null, { lookup, appliance: 'dishwasher' });
    expect(d.outcome).toBe('verified');
    expect(d.parts.map((p) => p.title)).toEqual(['Drain Pump 30W']);
  });
  it('refuses a part with no recorded evidence or under an active hazard', async () => {
    const noEv = narrowed({ part: { component: 'drain pump', evidence: ['f9'] } });
    expect((await P.gate(noEv, st(), null, { lookup, appliance: 'dishwasher' })).failed).toContain('G1-no-recorded-evidence');
    const hz = { type: 'burning', policy: S.POLICY.burning };
    expect((await P.gate(narrowed(), st(), hz, { lookup, appliance: 'dishwasher' })).failed).toContain('G3-active-hazard');
  });
});
