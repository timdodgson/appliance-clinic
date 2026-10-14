/**
 * Knowledge retrieval (change 21.22, deep-dive Phase 3): the whole note reaches the reasoner (D5), BM25 ranking with
 * negations, typo tolerance and error-code-led note choice (D8), and the data fixes (D9). Hob part matching stays empty:
 * the four hob journeys hold no part rules, so mapping their appliance name `hob` to `hobs` alone adds none.
 */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const K = require('../ac2/knowledge.js');
const { resolveErrorCode } = require('../ac2/mcp.js');
const ids = (r) => r.map((x) => x.knowledgeId);

describe('retrieve: the whole note (D5)', () => {
  const [note] = K.retrieve({ appliance: 'washing-machine', text: 'water left in the drum, wont drain' });
  it('carries the questions, component evidence and checks before replacing, untruncated', () => {
    expect(note.knowledgeId).toBe('washing-machine:not-draining');
    expect(note.clarifyingQuestion).toMatch(/water/);
    expect(note.componentEvidence.length).toBeGreaterThan(0);
    expect(note.componentEvidence[0].supports.length).toBeGreaterThan(0);
    expect(note.beforeReplacingAPart.length).toBeGreaterThanOrEqual(4);
    expect(note.discriminators.some((d) => d.length > 260)).toBe(true);
    expect(note.commonConfusion[0]).toHaveProperty('appliesIf');
  });
});

describe('retrieve: ranking (D8)', () => {
  it('appliance names do not rank a note ("washing machine won\'t spin" is not the odour note)', () => {
    expect(ids(K.retrieve({ appliance: 'washing-machine', text: "washing machine won't spin" }))).not.toContain('washing-machine:odour');
  });
  it('tolerates a one-letter typo', () => {
    expect(ids(K.retrieve({ appliance: 'washing-machine', text: 'wont spinn' }))[0]).toBe(ids(K.retrieve({ appliance: 'washing-machine', text: 'wont spin' }))[0]);
  });
  it('a resolved error code chooses the note (Samsung dishwasher 4C is a fill fault)', () => {
    expect(ids(K.retrieve({ appliance: 'dishwasher', text: 'keeps showing 4C and beeping, wont do anything', faultIds: ['fill'] }))[0]).toBe('dishwasher:fill');
  });
});

describe('data fixes (D9)', () => {
  it('a washer-dryer reaches the washing-machine odour note', () => {
    expect(ids(K.retrieve({ appliance: 'washer-dryer', text: 'everything smells damp and musty after washing' }))).toContain('washing-machine:odour');
  });
  it('the error-code client retries O/0 swaps when the code is not found (EO3 -> E03)', async () => {
    const asked = [];
    const fetchFn = async (_u, o) => {
      const { code } = JSON.parse(o.body).params.arguments;
      asked.push(code);
      const structuredContent = code === 'E03' ? { status: 'RESOLVED', meaning: 'Drain fault', faultId: 'drain' } : { status: 'NOT_FOUND' };
      return { ok: true, json: async () => ({ result: { structuredContent } }) };
    };
    const r = await resolveErrorCode({ make: 'hoover', appliance: 'washer-dryer', code: 'EO3' }, { url: 'https://x', token: 't', fetchFn });
    expect(asked).toEqual(['EO3', 'E03']);
    expect(r).toMatchObject({ code: 'EO3', status: 'RESOLVED', matchedAs: 'E03', faultId: 'drain' });
  });
});

describe('choose (experiment: Jev picks the cause and the next check from the notes)', () => {
  const J = require('../ac2/labels.js');
  const notes = K.retrieve({ appliance: 'washing-machine', text: 'water left in the drum, wont drain, pump hums' });
  it('offers the notes\' causes and checks, never a check already given', () => {
    const given = [notes[0].ownerSafeChecks[0]];
    const req = J.buildChooseRequest({ texts: ['wont drain, pump hums'], known: {}, notes, given });
    expect(Object.keys(req.questions)).toEqual(['cause', 'check']);
    expect(req.plan.causes.length).toBeGreaterThan(0);
    expect(req.plan.checks.map((c) => c.full)).not.toContain(given[0]);
    expect(req.state.guidance[0].discriminators.length).toBeGreaterThan(0);
  });
  it('returns the chosen cause and the full text of the chosen check', async () => {
    const jev = { evaluate: async () => ({ answers: { cause: { type: 'choice', choice: 't1', confidence: 0.9 }, check: { type: 'choice', choice: 'k1', confidence: 0.8 } } }) };
    const r = await J.chooseNext(jev, { texts: ['wont drain'], known: {}, notes, given: [] });
    const req = J.buildChooseRequest({ texts: ['wont drain'], known: {}, notes, given: [] });
    expect(r.cause).toBe(req.plan.causes[0].value);
    expect(r.check).toBe(req.plan.checks[0].full);
  });
});
