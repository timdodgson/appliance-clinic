/**
 * ac2 transcript observability: the ac2-transcript-audit/1 object is stored on the turn as `ac2` (never `canonical`),
 * bounded, and the session summary reports path 'ac2' with appliance / status / part-gate outcome so the
 * Admin → Conversations list filters and badges work. Old transcripts keep their summary unchanged.
 */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const tx = require('../transcripts.js');
const dg = require('../diagnostics-inspect.js');

const now = new Date('2026-10-12T10:00:00.000Z');
const SID = 's-ac2-observe-01';

function audit(over = {}) {
  return {
    schemaVersion: 'ac2-transcript-audit/1', path: 'ac2', turn: 2,
    provider: { name: 'bedrock', model: 'test-model' },
    timings: { reasonMs: 900, verifyMs: 120, totalMs: 1100 },
    usage: { inputTokens: 1200, outputTokens: 300 },
    toolCalls: [{ tool: 'error-codes', results: [{ code: 'F05', status: 'RESOLVED' }] }, { tool: 'knowledge', results: ['washing-machine:not-draining'] }],
    safety: { hazards: [], gates: [{ gate: 'repeated-question', key: 'model', why: 'asked twice' }] },
    claimsRejected: [{ claim: 'The pump motor is burnt out', source: 'reply' }],
    claimsChecked: 4,
    regenerated: true,
    partGate: { outcome: 'model_needed', component: 'drain pump', failed: ['model_confirmed'], matcher: null, cited: ['f1'] },
    escalation: null,
    status: 'narrowing',
    candidates: [{ cause: 'Blocked pump filter', likelihood: 'high', evidence: ['f1', 'f2'] }],
    scope: { status: 'in', appliance: 'washing-machine' },
    ledger: {
      appliance: { value: 'washing-machine', status: 'stated', quote: 'my washing machine', turn: 1 },
      brand: { value: 'Hotpoint', status: 'stated', quote: 'hotpoint', turn: 1 }, model: null,
      codes: [{ code: 'F05', quote: 'F05', turn: 1 }],
      facts: [
        { id: 'f1', field: 'water_left_in_drum', value: true, source: 'customer', status: 'observed', turn: 1, quote: 'water left in the drum' },
        { id: 'f2', field: 'pump_noise', value: 'none', source: 'customer', status: 'contradicted', turn: 2, quote: 'no hum' },
      ],
      asked: [{ key: 'model', text: 'What is the model?', turn: 2, times: 2, resolution: 'open' }],
      hazards: [],
    },
    ms: 1300,
    ...over,
  };
}
const view = { requestId: 'rid-ac2', reply: 'Check the pump filter first.', parts: [], media: [] };
const orch = { route: 'AC2', outcome: 'ANSWER' };
const msgs = [{ role: 'user', content: 'my hotpoint washing machine shows F05' }];

describe('slimAc2Audit', () => {
  it('keeps the decision fields and caps facts, quotes and lists', () => {
    const big = audit({
      ledger: { ...audit().ledger, facts: Array.from({ length: 55 }, (_, i) => ({ id: 'f' + i, field: 'x', value: 'v', source: 'customer', status: 'observed', turn: 1, quote: 'q'.repeat(400) })) },
      toolCalls: Array.from({ length: 30 }, () => ({ tool: 'knowledge', results: [] })),
      claimsRejected: Array.from({ length: 25 }, () => ({ claim: 'c', source: 's' })),
      safety: { hazards: [], gates: Array.from({ length: 25 }, () => ({ gate: 'g' })) },
    });
    const s = tx.slimAc2Audit(big);
    expect(s.ledger.facts).toHaveLength(40);
    expect(s.ledger.factsTotal).toBe(55);
    expect(s.ledger.facts[0].id).toBe('f15'); // the latest 40
    expect(s.ledger.facts.every((f) => f.quote.length === 160)).toBe(true);
    expect(s.toolCalls).toHaveLength(20);
    expect(s.claimsRejected).toHaveLength(20);
    expect(s.safety.gates).toHaveLength(20);
  });
  it('returns null for anything that is not an ac2 audit, and a summary form on request', () => {
    expect(tx.slimAc2Audit({ schemaVersion: 'canonical-audit/1' })).toBeNull();
    expect(tx.slimAc2Audit(null)).toBeNull();
    const s = tx.slimAc2Audit(audit(), { summary: true });
    expect(s).toMatchObject({ slim: true, status: 'narrowing', appliance: 'washing-machine', claimsRejectedCount: 1, partGate: { outcome: 'model_needed' } });
    expect(s.ledger).toBeUndefined();
    expect(s.candidates).toBeUndefined();
  });
});

describe('persisted ac2 turns', () => {
  it('stores the audit under turn.ac2 (never a canonical block) and the detail returns it', async () => {
    const store = tx.createMemoryStore();
    await tx.persistTurn(store, { sessionId: SID, clientTurnId: 'ct-ac2-1' }, { messages: msgs, view, orch, requestId: 'rid-ac2', now, ac2: audit() });
    const rec = await store.get(SID);
    expect(rec.turns[0]).not.toHaveProperty('canonical');
    expect(rec.turns[0].ac2).toMatchObject({ schemaVersion: 'ac2-transcript-audit/1', status: 'narrowing', provider: { model: 'test-model' }, regenerated: true });
    expect(rec.turns[0].ac2.ledger.facts.map((f) => f.status)).toEqual(['observed', 'contradicted']);
    const d = tx.drillDown(rec, now);
    expect(d.customerVisible.turns[0].ac2.candidates[0]).toEqual({ cause: 'Blocked pump filter', likelihood: 'high', evidence: ['f1', 'f2'] });
    expect(d.overview.canonical).toMatchObject({ path: 'ac2', appliance: 'washing-machine', ac2: { turns: 1, status: 'narrowing', partGate: 'model_needed', errors: 0 } });
  });

  it('summary: path ac2, part recommended on a verified gate, errors count as degraded', () => {
    const rec = { turns: [
      tx.buildTurn({ messages: msgs, view, orch, ac2: audit({ partGate: { outcome: 'verified', component: 'drain pump', failed: [], cited: ['f1'] } }) }),
      tx.buildTurn({ messages: msgs, view: { ...view, error: true }, orch: null, ac2: { schemaVersion: 'ac2-transcript-audit/1', path: 'ac2', error: 'engine_unreachable' } }),
    ] };
    const s = tx.canonicalSummary(rec);
    expect(s.path).toBe('ac2');
    expect(s.partRecommended).toBe(true);
    expect(s.degraded).toBe(true);
    expect(s.ac2).toMatchObject({ turns: 2, errors: 1, partGate: 'verified' });
    expect(tx.matchesFilters(rec, { canonical: 'ac2' }, now)).toBe(true);
    expect(tx.matchesFilters(rec, { canonical: 'legacy' }, now)).toBe(false);
    expect(tx.parseListQuery({ canonical: 'ac2' }).filters.canonical).toBe('ac2');
  });

  it('old transcripts are unchanged: no ac2 field, legacy / canonical summaries as before', () => {
    const legacy = tx.buildTurn({ messages: msgs, view, orch });
    expect('ac2' in legacy).toBe(false);
    const s = tx.canonicalSummary({ turns: [legacy] });
    expect(s).toMatchObject({ path: 'legacy', ac2: null, counts: { legacy: 1, ac2: 0 } });
    const canon = { ...legacy, canonical: { schemaVersion: 'canonical-audit/1', path: 'control', owner: 'wm-not-draining' } };
    expect(tx.canonicalSummary({ turns: [canon] }).path).toBe('control');
  });

  it('older turns are slimmed to the summary form by the trace-history bound', () => {
    const turns = Array.from({ length: 3 }, () => tx.buildTurn({ messages: msgs, view, orch, ac2: audit() }));
    tx.boundTraceHistory(turns, 1);
    expect(turns[0].ac2.slim).toBe(true);
    expect(turns[0].ac2.ledger).toBeUndefined();
    expect(turns[2].ac2.ledger.facts).toHaveLength(2);
  });
});

describe('Diagnostics: the diagnosis architecture (read-only)', () => {
  it('is ac2, with no mode to configure', () => {
    const snap = dg.buildSnapshot({ now, runtime: {} });
    expect(snap.runtime.diagnosis).toMatchObject({ architecture: 'ac2' });
    expect(snap.runtime).not.toHaveProperty('ac2');
    expect(snap.runtime).not.toHaveProperty('canonical');
    expect(snap.components.map((c) => c.id)).not.toContain('orchestrator');
  });
});
