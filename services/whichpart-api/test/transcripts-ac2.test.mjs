/**
 * ac2 transcript observability: the engine's bounded audit (ac2-transcript-audit/2) is stored on the turn as `ac2`,
 * bounded and secret-free, and the session summary reports the advisor's outcome, hazards and part decision so the
 * Admin → Conversations list filters and badges work. Records written by the earlier audit schema (/1) stay readable.
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
    schemaVersion: 'ac2-transcript-audit/2', path: 'ac2', turn: 2,
    provider: { name: 'anthropic', model: 'test-model' },
    timings: { adviseMs: 900, totalMs: 1100 },
    usage: { inputTokens: 1200, outputTokens: 300 },
    toolCalls: ['lookup_error_code', 'find_parts', 'send_reply'],
    safety: { hazards: [], gates: [{ gate: 'unverified-identifier', why: 'part number not in catalogue' }] },
    partGate: { outcome: 'model_needed', component: 'drain pump' },
    escalation: null,
    outcome: 'diagnosing',
    customer: { appliance: 'washing-machine', brand: 'Hotpoint', model: null },
    hazards: [],
    tags: { outcome: 'diagnosing', media: null, enrichment: { knowledgeIds: ['washing-machine:not-draining'], codes: [{ code: 'F05' }], recalls: 0, parts: 0 } },
    ms: 1300,
    ...over,
  };
}
const view = { requestId: 'rid-ac2', reply: 'Check the pump filter first.', parts: [], media: [] };
const orch = { route: 'AC2', outcome: 'ANSWER' };
const msgs = [{ role: 'user', content: 'my hotpoint washing machine shows F05' }];

describe('slimAc2Audit', () => {
  it('keeps the decision fields, caps the lists and drops anything that is not in the contract', () => {
    const big = audit({
      toolCalls: Array.from({ length: 30 }, () => 'find_parts'),
      safety: { hazards: [], gates: Array.from({ length: 25 }, () => ({ gate: 'g' })) },
      reasoning: 'never stored', apiKey: 'sk-never', ledger: { facts: [] },
    });
    const s = tx.slimAc2Audit(big);
    expect(s.toolCalls).toHaveLength(12);
    expect(s.safety.gates).toHaveLength(20);
    expect(s.customer).toEqual({ appliance: 'washing-machine', brand: 'Hotpoint', model: null });
    expect(s.tags.enrichment.codes).toMatchObject([{ code: 'F05' }]);
    expect(JSON.stringify(s)).not.toMatch(/reasoning|sk-never|ledger/);
  });
  it('returns null for anything that is not an ac2 audit, and a summary form on request', () => {
    expect(tx.slimAc2Audit({ schemaVersion: 'canonical-audit/1' })).toBeNull();
    expect(tx.slimAc2Audit(null)).toBeNull();
    const s = tx.slimAc2Audit(audit(), { summary: true });
    expect(s).toMatchObject({ slim: true, outcome: 'diagnosing', customer: { appliance: 'washing-machine' }, partGate: { outcome: 'model_needed' } });
    expect(s.toolCalls).toBeUndefined();
    expect(s.tags).toBeUndefined();
  });
  it('reads the earlier audit schema (/1) so older records stay visible', () => {
    const s = tx.slimAc2Audit({ schemaVersion: 'ac2-transcript-audit/1', path: 'ac2', turn: 1, status: 'narrowing', ledger: { appliance: { value: 'oven' } } });
    expect(s).toMatchObject({ schemaVersion: 'ac2-transcript-audit/2', turn: 1, outcome: 'narrowing' });
  });
});

describe('persisted ac2 turns', () => {
  it('stores the audit under turn.ac2 and the detail returns it', async () => {
    const store = tx.createMemoryStore();
    await tx.persistTurn(store, { sessionId: SID, clientTurnId: 'ct-ac2-1' }, { messages: msgs, view, orch, requestId: 'rid-ac2', now, ac2: audit() });
    const rec = await store.get(SID);
    expect(rec.turns[0]).not.toHaveProperty('canonical');
    expect(rec.turns[0].ac2).toMatchObject({ schemaVersion: 'ac2-transcript-audit/2', outcome: 'diagnosing', provider: { model: 'test-model' }, toolCalls: ['lookup_error_code', 'find_parts', 'send_reply'] });
    expect(rec).toMatchObject({ family: 'washing-machine', make: 'Hotpoint', errorCode: 'F05' });
    const d = tx.drillDown(rec, now);
    expect(d.customerVisible.turns[0].ac2.partGate).toEqual({ outcome: 'model_needed', component: 'drain pump' });
    expect(d.overview.ac2).toMatchObject({ turns: 1, outcome: 'diagnosing', partRecommended: false, errors: 0, appliance: 'washing-machine' });
  });

  it('summary: part recommended on a verified gate, errors count as degraded, hazards collected', () => {
    const rec = { turns: [
      tx.buildTurn({ messages: msgs, view, orch, ac2: audit({ partGate: { outcome: 'verified', component: 'drain pump' }, outcome: 'part_needed', safety: { hazards: ['burning'], gates: [] } }) }),
      tx.buildTurn({ messages: msgs, view: { ...view, error: true }, orch: null, ac2: { schemaVersion: 'ac2-transcript-audit/2', path: 'ac2', error: 'engine_unreachable' } }),
    ] };
    const s = tx.ac2Summary(rec);
    expect(s).toMatchObject({ turns: 2, errors: 1, outcome: 'part_needed', partRecommended: true, hazards: ['burning'] });
    expect(tx.matchesFilters(rec, { partRecommended: true }, now)).toBe(true);
    expect(tx.matchesFilters(rec, { degraded: true }, now)).toBe(true);
    expect(tx.matchesFilters(rec, { outcome: 'engineer' }, now)).toBe(false);
    expect(tx.parseListQuery({ outcome: 'part_needed', partRecommended: '1' }).filters).toMatchObject({ outcome: 'part_needed', partRecommended: true });
    expect(tx.parseListQuery({ outcome: 'not-an-outcome' }).filters.outcome).toBe('');
  });

  it('a turn without an audit (an error before the engine answered) has no ac2 field', () => {
    const t = tx.buildTurn({ messages: msgs, view, orch });
    expect('ac2' in t).toBe(false);
    expect(tx.ac2Summary({ turns: [t] })).toMatchObject({ turns: 0, errors: 0, outcome: null });
  });

  it('older turns are slimmed to the summary form by the audit-history bound', () => {
    const turns = Array.from({ length: 3 }, () => tx.buildTurn({ messages: msgs, view, orch, ac2: audit() }));
    tx.boundAuditHistory(turns, 1);
    expect(turns[0].ac2.slim).toBe(true);
    expect(turns[0].ac2.toolCalls).toBeUndefined();
    expect(turns[2].ac2.toolCalls).toHaveLength(3);
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
