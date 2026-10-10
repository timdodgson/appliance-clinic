/**
 * Phase 10 regressions derived from real production transcripts (docs/evaluation/phase-10-transcript-findings.md).
 * Each case reproduces the SHAPE of a real failure with synthetic typed turns; no customer text is copied.
 *   F1  COMPOSE repeated the prompt's own instruction to the customer
 *   F2  a recorded check category ("torn") was quoted back as the customer's words
 *   F3  the template said its safety lines twice
 *   F4  a COMPOSE provider failure left no reason in the trace
 *   F5  a bare "yes" to an either/or check was taken as an answer and the journey concluded on nothing
 */
import { describe, it, expect, afterEach } from 'vitest';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
globalThis.awslambda = globalThis.awslambda || { streamifyResponse: (f) => f, HttpResponseStream: { from: (s) => s } };
const L = require('../part-finder-lambda.js')._internal;
const H = require('./helpers/b2-journey.cjs');
const { merge } = require('../canonical/merge.js');
const { emptyState } = require('../canonical/cs1.js');
const mc1 = require('../canonical/mc1.js');
const rq = require('../canonical/requests.js');
const JV = require('../canonical/vac2-pulsing.js');
const J8 = require('../canonical/j8-pipeline.js');
const J8C = require('../canonical/j8-compose.js');

const { C, O, K } = H;
const CSID = 'cs_' + 'b'.repeat(32);
const VAC = { identity: { appliance: { value: 'vacuum', basis: 'stated' }, make: { value: 'dyson', basis: 'stated' } }, intent: 'report_fault', problem: { journey: 'pulsing', faultDomain: 'airflow' } };
const CONTROL = { schema: 'cs/1', mode: 'control', control: { journeys: ['vacuum-pulsing-cutting-out'] }, sessionId: CSID, version: 0, state: null, degraded: null };
function transportFor(cs) {
  let s = emptyState(CSID);
  for (const c of cs) s = merge(s, mc1.validateClassification({ scope: 'appliance', ...c }), { turn: s.version + 1 }).state;
  return { schema: 'cs/1', mode: 'control', sessionId: CSID, priorVersion: s.version - 1, version: s.version, state: s, classification: cs[cs.length - 1], rulesFired: [], requestOutcome: null, degraded: null };
}
const provider = (text) => ({ infer: async (req, { onDelta }) => { provider.last = req; onDelta(text); } });
async function vacRespond(cs, providerOrText) {
  const t = await L.canonicalJourney(transportFor(cs), CONTROL, 'vacuum-pulsing-cutting-out', {});
  const p = typeof providerOrText === 'string' ? provider(providerOrText) : providerOrText;
  return { t, r: await L.canonicalRespond({ canonical: t, messages: [{ role: 'user', content: 'x' }], requestId: 'r1' }, { provider: p, ensureMedia: false }) };
}
afterEach(() => { delete process.env.CANONICAL_VAC2_CONTROL; });

describe('F1: a reply never shows the customer our instructions', () => {
  const ASK = 'Switch it off and unplug it first. Empty the bin and wash the filters, then let them dry for 24 hours. Was a filter clogged or damp, is a filter torn or damaged, or were they clean and dry already?';
  it('a reply that repeats the media instruction seen in production is replaced by the template', async () => {
    const { r } = await vacRespond([VAC], ASK.replace('Was a filter', 'A picture is shown below the reply; you may mention it once. Was a filter'));
    expect(r.done.canonicalControl.compose.source).toBe('template');
    expect(r.done.canonicalControl.compose.violations).toContain('prompt-echo');
    expect(r.reply).not.toMatch(/mention it once|shown below the reply/i);
  });
  it('any other sentence of the prompt\'s rules is an echo too', async () => {
    const { r } = await vacRespond([VAC], ASK.replace('Was a filter', 'Never invent a diagnosis, a test result, a part or a model number. Was a filter'));
    expect(r.done.canonicalControl.compose.violations).toContain('prompt-echo');
  });
  it('the current media line never reaches the customer', async () => {
    const { r } = await vacRespond([VAC], ASK.replace('Was a filter', 'You may point the customer to it once in your own words; never copy this line. Was a filter'));
    expect(r.reply).not.toMatch(/never copy this line|point the customer/i);
  });
  it('a prompt section label in the reply is an echo too', async () => {
    const { r } = await vacRespond([VAC], `CONTENT to convey: ${ASK}`);
    expect(r.done.canonicalControl.compose.violations).toContain('prompt-echo');
  });
  it('an ordinary reply that refers to the picture in its own words is kept', async () => {
    const own = ASK.replace('Was a filter', 'The picture below shows where the filters are. Was a filter');
    const { r } = await vacRespond([VAC], own);
    expect(r.done.canonicalControl.compose.source).toBe('compose');
    expect(r.reply).toBe(own);
  });
});

describe('F2: a recorded category is not presented as the customer\'s words', () => {
  it('a damaged filter is recorded as damaged (torn or broken), never as "torn" alone', () => {
    const t = transportFor([VAC, { checks: [K('vacuum-bin-filters', 'done', 'fault_seen')] }]);
    const b = JV.brief(t.state, { kind: 'recommend_part', target: 'vacuum-filter', rule: 'VP21', conclusion: { component: 'vacuum-filter' } }, null, {});
    const said = [...b.evidence, ...b.latest].join(' | ');
    expect(said).toMatch(/filter damaged \(torn or broken\)/);
    expect(said).not.toMatch(/filter torn(?! or)/);
  });
  it('the prompt frames reported items as recorded categories', async () => {
    await vacRespond([VAC, { checks: [K('vacuum-bin-filters', 'done', 'fault_seen')] }], 'What you found points to the filter. I have shown the matching filter below.');
    const user = provider.last.messages[1].content;
    expect(user).toContain('recorded as categories, not their exact words');
  });
});

describe('F3: a template says each safety line once', () => {
  it('the pulsing check template does not repeat the switch-off or the drying line its own step already gives', async () => {
    const { r } = await vacRespond([VAC], { infer: async () => { throw new Error('stream LM status 400 suspended'); } });
    const text = r.reply;
    expect((text.match(/battery/gi) || []).length).toBe(1);
    expect((text.match(/24 hours/gi) || []).length).toBe(1);
    expect(text).toMatch(/\?$/);
  });
});

describe('F4: a COMPOSE failure records why', () => {
  it('provider HTTP status is kept as the error class (no provider body)', async () => {
    const { r } = await vacRespond([VAC], { infer: async () => { throw new Error('lmstudio stream failed: stream LM status 400 account suspended'); } });
    expect(r.done.canonicalControl.compose.violations).toEqual(['compose_failed']);
    expect(r.done.diagnosticTrace.stages[0].detail.compose.error).toBe('http_400');
    expect(r.metric.composeError).toBe('http_400');
    expect(JSON.stringify(r.done)).not.toMatch(/suspended/);
  });
  it('a timeout is classed as timeout', async () => {
    const { r } = await vacRespond([VAC], { infer: async () => { const e = new Error('The operation was aborted'); e.name = 'AbortError'; throw e; } });
    expect(r.metric.composeError).toBe('timeout');
  });
});

describe('F5: a bare yes to an either/or check settles nothing', () => {
  const noisy = H.opener('noisy', 'noise', [], {}, { make: { value: 'hotpoint', basis: 'stated' } });
  const turns = [noisy, C({ observations: [O('noiseOnSpin')], reply: { toPending: 'answered' } }), C({ observations: [O('grindingNoise')], reply: { toPending: 'answered' } })];
  it('"answered" with no result for the check is recorded as partial', () => {
    const r = H.play(J8, turns);
    expect(r.last).toMatchObject({ kind: 'ask_check', target: 'drum-by-hand' });
    const yes = H.play(J8, [...turns, C({ reply: { toPending: 'answered' } })]);
    expect(rq.requestsFor(yes.state, 'drum-by-hand').map((r) => [r.kind, r.outcome])).toEqual([['ask', 'partial'], ['reoffer', 'pending']]);
  });
  it('the check is offered once more instead of a conclusion on no evidence', () => {
    const yes = H.play(J8, [...turns, C({ reply: { toPending: 'answered' } })]);
    expect(yes.last).toMatchObject({ kind: 'ask_check', target: 'drum-by-hand' });
    const t = J8C.template(J8C.brief(yes.state, yes.last, null, {}));
    expect((t.match(/\?/g) || []).length).toBe(1);
  });
  it('a real result still answers it and the journey moves on', () => {
    const done = H.play(J8, [...turns, C({ checks: [K('drum-by-hand', 'done', 'clear')], reply: { toPending: 'answered' } })]);
    expect(rq.lastOutcome(done.state, 'drum-by-hand')).toBe('answered');
    expect(done.last.target).not.toBe('drum-by-hand');
  });
  it('a typed answer that carries a different new fact supersedes the check rather than counting as partial', () => {
    const moved = H.play(J8, [...turns, C({ observations: [O('noiseOnDrain')], reply: { toPending: 'answered' } })]);
    expect(rq.lastOutcome(moved.state, 'drum-by-hand')).toBe('superseded');
  });
});
