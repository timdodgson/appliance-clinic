/**
 * The customer turn (ADR 0023): Claude (the advisor) reads the chat and our notes, looks up error codes and parts, and
 * writes the reply; the code keeps the fixed safety rules and only shows parts the catalogue returned and pictures from
 * our notes.
 */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { runTurn, ProviderUnavailableError } = require('../ac2/turn.js');
const A = require('../ac2/advisor.js');
const Rec = require('../ac2/record.js');
const S = require('../ac2/safety.js');
const { resolveErrorCode } = require('../ac2/mcp.js');

const user = (content) => ({ role: 'user', content });
const said = (content) => ({ role: 'assistant', content });
const send = (input, id = 'r1') => ({ type: 'tool_use', id, name: 'send_reply', input: { appliance: null, brand: null, model: null, partIds: [], mediaId: null, outcome: 'diagnosing', ...input } });
/** A scripted model: each call returns the next list of content blocks; the requests are kept. */
function model(...rounds) {
  return { name: 'anthropic', model: 'claude-opus-5-5', calls: [], async converse(req) {
    this.calls.push(JSON.parse(JSON.stringify(req)));
    const content = rounds[Math.min(this.calls.length - 1, rounds.length - 1)];
    return { status: 200, stopReason: content.some((b) => b.type === 'tool_use') ? 'tool_use' : 'end_turn', content, usage: { promptTokens: 100, completionTokens: 20 } };
  } };
}
const V6 = { model: { modelNumber: 'V6', make: 'Dyson' }, parts: [
  { partId: 1, partNo: '96566101', title: 'Pre Filter Assembly', price: '19.0000', link: '/96566101', image: 'x' },
  { partId: 2, partNo: '96674101', title: 'Hepa Post Motor Filter Non Genuine', price: '15.0000', link: '/96674101', image: 'y' },
] };
const PICTURE = { id: 'vac-lost-suction', type: 'IMAGE', title: 'Poor suction - what to check first', description: 'Filters and blockages', url: '/media/a.png' };
const deps = (provider, extra = {}) => ({ provider, resolveCode: async (q) => ({ code: q.code, status: 'RESOLVED', meaning: 'Drain fault' }), lookupParts: async () => V6, mediaCandidates: async () => [PICTURE], ...extra });

describe('advisor: the conversation and the notes', () => {
  it('sends the chat as turns, the latest photo as an image, and our notes marked as not from the customer', () => {
    const msgs = A.toApiMessages([user('dyson v6 pulsing'), said('Check the filter.'), user([{ type: 'text', text: 'here is the filter' }, { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,QUJD' } }])], 'FAULT NOTES: ...');
    expect(msgs.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
    expect(msgs[2].content[1]).toEqual({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'QUJD' } });
    expect(msgs[2].content[2].text).toMatch(/^\[Notes from Appliance Clinic's tools - not from the customer\]/);
  });
  it('the system prompt asks for the likely cause first, one step, short replies and the part when broken', () => {
    expect(A.SYSTEM).toMatch(/most likely cause/);
    expect(A.SYSTEM).toMatch(/ONE next step/);
    expect(A.SYSTEM).toMatch(/under 120 words/);
    expect(A.SYSTEM).toMatch(/call find_parts/);
  });
});

describe('turn: the Dyson chat that went wrong live', () => {
  it('turn 1: likely cause and one step, with the picture the advisor chose; paragraph breaks kept', async () => {
    const reply = 'A V6 that pulses is almost always restricted airflow: a blocked or damp filter.\n\nWash the filter in cold water and let it dry for 24 hours. Did it help?';
    const m = model([send({ reply, appliance: 'vacuum', brand: 'Dyson', model: 'V6', mediaId: 'vac-lost-suction' })]);
    const out = await runTurn({ messages: [user('Dyson V6 Pulising')] }, deps(m));
    expect(out.response.message).toContain('airflow: a blocked or damp filter.\n\nWash the filter');
    expect(out.response.message.startsWith('Switch it off and unplug it (or take the battery off) first.')).toBe(true);
    expect(out.response.media).toEqual([PICTURE]);
    expect(out.response).not.toHaveProperty('diagnosis');
    expect(out.audit.tags).toEqual({ outcome: 'diagnosing', media: 'vac-lost-suction', enrichment: { knowledgeIds: out.audit.tags.enrichment.knowledgeIds, codes: [], recalls: 0, parts: 'none' } });
    expect(out.state.customer).toEqual({ appliance: 'vacuum', brand: 'Dyson', model: 'V6' });
    // Our notes went to the model: the vacuum fault notes and the picture it may show.
    const notes = m.calls[0].messages[0].content.find((b) => /Notes from Appliance Clinic/.test(b.text)).text;
    expect(notes).toMatch(/FAULT NOTES/);
    expect(notes).toMatch(/vac-lost-suction/);
  });
  it('turn 3: "filter is damaged" -> the advisor looks up V6 parts and the filter is shown from the catalogue', async () => {
    const m = model([{ type: 'tool_use', id: 't1', name: 'find_parts', input: { model: 'V6' } }],
      [send({ reply: 'A damaged filter needs replacing. Here is the V6 pre filter.', appliance: 'vacuum', brand: 'Dyson', model: 'V6', partIds: ['96566101', 'NOT-IN-CATALOGUE'], outcome: 'part_needed' })]);
    const out = await runTurn({ messages: [user('Dyson V6 Pulising'), said('Wash the filter.'), user('filter is blocked'), said('Dry it for 24 hours.'), user('the filter is actually damaged')] }, deps(m));
    expect(out.response.parts.map((p) => p.partNo)).toEqual(['96566101']);
    expect(out.response.resolvedModel).toBe('V6');
    expect(out.audit.partGate.outcome).toBe('verified');
    // The catalogue result went back to the model as a tool result, after its own content unchanged.
    expect(m.calls[1].messages.at(-2)).toEqual({ role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'find_parts', input: { model: 'V6' } }] });
    expect(m.calls[1].messages.at(-1).content[0]).toMatchObject({ type: 'tool_result', tool_use_id: 't1' });
    expect(m.calls[1].messages.at(-1).content[0].content).toMatch(/Pre Filter Assembly/);
  });
  it('a picture or part the notes and the catalogue did not offer is never shown', async () => {
    const m = model([send({ reply: 'Wash the filter.', mediaId: 'made-up', partIds: ['96566101'] })]);
    const out = await runTurn({ messages: [user('dyson v6 pulsing')] }, deps(m));
    expect(out.response.media).toBeNull();
    expect(out.response.parts).toBeNull(); // find_parts was not called this turn
  });
});

describe('turn: error codes and prices', () => {
  it('the advisor looks the code up; the result goes back to it', async () => {
    let asked = null;
    const m = model([{ type: 'tool_use', id: 'c1', name: 'lookup_error_code', input: { code: 'E18', make: 'Bosch', appliance: 'washing-machine', model: null } }], [send({ reply: 'E18 on a Bosch means a drain fault. Clean the pump filter first.' })]);
    const out = await runTurn({ messages: [user('Bosch washing machine showing E18, water in the drum')] }, deps(m, { resolveCode: async (q) => { asked = q; return { code: q.code, status: 'RESOLVED', meaning: 'Drain fault' }; } }));
    expect(asked).toEqual({ make: 'Bosch', appliance: 'washing-machine', code: 'E18', model: null });
    expect(out.audit.tags.enrichment.codes).toEqual([{ code: 'E18', status: 'RESOLVED' }]);
    expect(out.response.message).toMatch(/drain fault/);
  });
  it('a part number or price not from the customer or the catalogue is removed; catalogue prices stay', async () => {
    const m = model([{ type: 'tool_use', id: 't1', name: 'find_parts', input: { model: 'V6' } }], [send({ reply: 'The pre filter is £19.00 in our shop. Or order part ZX998877 for £9.', partIds: ['96566101'] })]);
    const out = await runTurn({ messages: [user('dyson v6 filter is torn')] }, deps(m));
    expect(out.response.message).toMatch(/£19\.00/);
    expect(out.response.message).not.toMatch(/ZX998877|£9\b/);
  });
});

describe('turn: safety', () => {
  it('gas in the latest message: the fixed emergency wording, no model call', async () => {
    const m = model([send({ reply: 'x' })]);
    const out = await runTurn({ messages: [user('I can smell gas near the cooker')] }, deps(m));
    expect(out.response.outcome).toBe('SAFETY_STOP');
    expect(out.response.message).toMatch(/0800 111 999/);
    expect(m.calls.length).toBe(0);
  });
  it('a burning smell: fixed warning first (once), stop-use flag, no part, no picture', async () => {
    const m = model([{ type: 'tool_use', id: 't1', name: 'find_parts', input: { model: 'V6' } }], [send({ reply: 'Unplug it and leave it unplugged.', partIds: ['96566101'], mediaId: 'vac-lost-suction' })]);
    const out = await runTurn({ messages: [user('my dyson v6 smells of burning plastic')] }, deps(m));
    expect(out.response.message.startsWith(S.copyFor('burning'))).toBe(true);
    expect(out.response.safety).toMatchObject({ class: 'burning', stopUse: true });
    expect(out.response.parts).toBeNull();
    expect(out.response.media).toBeNull();
    const again = await runTurn({ messages: [user('my dyson v6 smells of burning plastic'), said(out.response.message), user('ok what next')], state: out.state }, deps(model([send({ reply: 'An engineer should check it.' })])));
    expect(again.response.message).not.toContain(S.copyFor('burning'));
  });
  it('water near the socket: the fixed warning once, and no second isolation line', async () => {
    const out = await runTurn({ messages: [user('washing machine leaking at the front, water spreading towards the socket')] }, deps(model([send({ reply: 'Once the power is off, pull back the door seal and look for a split.', appliance: 'washing-machine' })])));
    expect(out.response.message.startsWith(S.copyFor('electrical_water'))).toBe(true);
    expect(out.response.message).not.toMatch(/First switch the circuit off/);
  });
  it('no extra isolation line when the reply already has the switch turned off', async () => {
    const m = model([send({ reply: 'Check the switch above the worktop. Once that switch is off, remove the fuse holder and fit a new 13A fuse.', appliance: 'washing-machine' })]);
    const out = await runTurn({ messages: [user('built in washing machine dead, no lights')] }, deps(m));
    expect(out.response.message).not.toMatch(/switch it off and unplug it/i);
  });
  it('banned advice is removed whatever the model says', async () => {
    const m = model([send({ reply: 'Discharge the capacitor with a screwdriver.\n\nNever remove the outer casing yourself; book an engineer.', appliance: 'microwave' })]);
    const out = await runTurn({ messages: [user('my microwave hums but does not heat')] }, deps(m));
    expect(out.response.message).not.toMatch(/capacitor/);
    expect(out.response.message).toMatch(/Never remove the outer casing/);
  });
  it('an unsafe request gets its fixed wording', async () => {
    const m = model([send({ reply: 'A refrigeration engineer can find the leak.', appliance: 'fridge-freezer' })]);
    const out = await runTurn({ messages: [user('can I regas my fridge freezer myself with a kit?')] }, deps(m));
    expect(out.response.message).toContain(S.copyFor('refrigerant'));
  });
});

describe('turn: failures and the record', () => {
  it('a model that cannot run, or a model without tool use, is an explicit error', async () => {
    const down = { name: 'x', async converse() { throw new Error('ECONNRESET'); } };
    await expect(runTurn({ messages: [user('dishwasher wont drain')] }, deps(down))).rejects.toBeInstanceOf(ProviderUnavailableError);
    await expect(runTurn({ messages: [user('dishwasher wont drain')] }, deps({ name: 'lmstudio', async infer() { return {}; } }))).rejects.toBeInstanceOf(ProviderUnavailableError);
  });
  it('plain text instead of send_reply is used as the reply', async () => {
    const out = await runTurn({ messages: [user('dishwasher wont drain')] }, deps(model([{ type: 'text', text: 'Clean the filter at the bottom first.' }])));
    expect(out.response.message).toMatch(/Clean the filter/);
  });
  it('an earlier record (old shape) loads; the advisor\'s appliance, make and model are kept', () => {
    const old = { schema: 'ac3/1', turn: 2, customer: { appliance: { value: 'vacuum', confidence: 1 }, brand: { value: 'Dyson' }, model: null, checks: [{ check: 'x' }] }, hazards: [{ type: 'burning', shown: true }], stage: 2, narrowed: { component: 'battery' } };
    const r = Rec.load(old);
    expect(r).toEqual({ schema: 'ac3/1', turn: 2, customer: { appliance: 'vacuum', brand: 'Dyson', model: null }, hazards: [{ type: 'burning', shown: true }], outcome: null });
    Rec.learn(r, { appliance: 'other', brand: null, model: 'V6' });
    expect(r.customer).toEqual({ appliance: 'vacuum', brand: 'Dyson', model: 'V6' });
  });
});

describe('error-code service (MCP)', () => {
  it('retries a code with O and 0 swapped when the service has no mapping as typed', async () => {
    const { o0Variants } = require('../ac2/mcp.js');
    expect(o0Variants('EO3').map((v) => v.code)).toEqual(['E03']);
    expect(o0Variants('E18')).toEqual([]);
    const asked = [];
    const fetchFn = async (url, init) => { const code = JSON.parse(init.body).params.arguments.code; asked.push(code); return { ok: true, json: async () => ({ result: { structuredContent: code === 'E03' ? { status: 'RESOLVED', meaning: 'Drain fault' } : { status: 'NOT_FOUND' } } }) }; };
    const r = await resolveErrorCode({ make: 'Bosch', appliance: 'washing-machine', code: 'EO3' }, { url: 'https://mcp.example', token: 't', fetchFn });
    expect(asked).toEqual(['EO3', 'E03']);
    expect(r).toMatchObject({ code: 'EO3', matchedAs: 'E03', status: 'RESOLVED' });
  });
  it('calls resolve-error-code over JSON-RPC with the bearer and keeps the meaning and hints', async () => {
    let sent;
    const fetchFn = async (url, init) => { sent = { url, init }; return { ok: true, json: async () => ({ jsonrpc: '2.0', id: 1, result: { structuredContent: { status: 'RESOLVED', meaning: 'Drain fault', confidence: 'HIGH', enrichment: { components: ['drain pump'], likelyCauses: ['blocked filter'], checks: ['clean the pump filter'], safety: { stopUse: false } } } } }) }; };
    const r = await resolveErrorCode({ make: 'Bosch', appliance: 'washing-machine', code: 'E18', model: 'WAT28371GB' }, { url: 'https://mcp.example/', token: 'tok', fetchFn });
    expect(sent.url).toBe('https://mcp.example/mcp');
    expect(sent.init.headers.authorization).toBe('Bearer tok');
    expect(r).toMatchObject({ code: 'E18', status: 'RESOLVED', meaning: 'Drain fault', components: ['drain pump'] });
  });
  it('needs the make and appliance; a service failure is reported, not invented', async () => {
    expect((await resolveErrorCode({ appliance: 'washing-machine', code: 'E18' }, { url: 'u', token: 't' })).status).toBe('NEEDS_CONTEXT');
    const r = await resolveErrorCode({ make: 'Bosch', appliance: 'washing-machine', code: 'E18' }, { url: 'u', token: 't', fetchFn: async () => ({ ok: false, status: 502 }) });
    expect(r.status).toBe('UNAVAILABLE');
  });
});

describe('safety kernel (shared)', () => {
  it('detects hazards in the customer\'s words, respecting negation and questions', () => {
    expect(S.detectHazards([user('There is a burning smell from the back')]).map((h) => h.type)).toEqual(['burning']);
    expect(S.detectHazards([user('No burning smell, it just stopped')])).toEqual([]);
    expect(S.detectHazards([user('is there any sign of melting I should check for?')])).toEqual([]);
  });
  it('removes prohibited advice, keeps warnings not to do it, and keeps paragraphs', () => {
    const g = S.gateReply('Discharge the capacitor with a screwdriver. Never remove the outer casing yourself.\n\nAsk an engineer.', { appliance: 'microwave' });
    expect(g.text).toBe('Never remove the outer casing yourself.\n\nAsk an engineer.');
  });
});
