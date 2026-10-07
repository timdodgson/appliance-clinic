/**
 * canonical-audit/1 — the bounded per-turn canonical snapshot stored on transcript turns.
 * Built from REAL part-finder merge / journey / COMPOSE output (canonical-audit-fixtures.cjs), then stored through the
 * real transcript module (memory store). No network.
 */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const A = require('../canonical-audit.js');
const tx = require('../transcripts.js');
const F = require('./canonical-audit-fixtures.cjs');

const RESULT_OK = { written: true, recordWritten: true, degraded: null };
const build = (ctx, out, result = RESULT_OK, trace = null) => A.buildCanonicalTranscriptAudit({ ctx, out, result, trace });
async function controlledOpen() {
  const blk = F.block();
  const t = await F.runTurn(F.TURNS.wmOpen, blk);
  return { blk, t, audit: build(F.ctxFor(blk), t.out, RESULT_OK, t.trace) };
}

describe('controlled canonical turn', () => {
  it('records owner, version, classification, delta, diagnostics, policy, NextAction, pending, part gate, COMPOSE, persistence', async () => {
    const { audit } = await controlledOpen();
    expect(audit).toMatchObject({ schemaVersion: 'canonical-audit/1', path: 'control', mode: 'control', controlled: true, owner: 'wm-not-draining',
      appliance: 'washing-machine', version: { before: 0, after: 1 } });
    expect(audit.version.stateDigest).toMatch(/^[0-9a-f]{16}$/);
    // same digest STATETURN#/STATE# carry (conversation-state.digest), so a transcript turn can be matched to its record
    const { t: tt } = await controlledOpen();
    expect(audit.version.stateDigest).toBe(require('../conversation-state.js').digest(tt.out.state).slice(0, 16));
    expect(audit.classification).toMatchObject({ scope: 'appliance', appliance: { value: 'washing-machine', basis: 'stated' },
      make: { value: 'hotpoint', basis: 'stated' }, intent: 'report_fault', faultDomain: 'water', journey: 'not-draining',
      observations: [{ key: 'waterRemaining', value: true }] });
    expect(Object.values(audit.classification)).not.toContain(null);           // nulls pruned
    const fields = audit.stateDelta.map((d) => `${d.op}:${d.field}`);
    expect(fields).toEqual(expect.arrayContaining(['add:appliance', 'add:make', 'add:journey', 'add:observation.waterRemaining', 'add:problem', 'add:pendingRequest']));
    expect(audit.diagnostics.leader).toMatchObject({ cause: 'filter-blockage', committed: false });
    expect(audit.diagnostics.ranked[0]).toMatchObject({ cause: 'filter-blockage', for: ['water left in the drum'] });
    expect(audit.policy).toMatchObject({ rule: 'R7', kind: 'ask_check', target: 'drain-filter', label: 'first-safe-high-value-check' });
    expect(audit.nextAction).toMatchObject({ kind: 'ask_check', target: 'drain-filter', rule: 'R7', purpose: 'DIAGNOSIS',
      pending: { slot: 'CHECK', target: 'drain-filter' } });
    expect(audit.nextAction.requiredSafety).toContain('isolate_mains');
    expect(audit.pendingRequest).toMatchObject({ change: 'issued', after: { slot: 'CHECK', target: 'drain-filter', kind: 'ask', askedTurn: 1, rule: 'R7' } });
    expect(audit.partGate).toMatchObject({ eligible: false });
    expect(audit.partGate.blockers).toEqual(expect.arrayContaining(['P1-model-not-known']));
    expect(audit.compose).toMatchObject({ mode: 'llm', valid: true });
    expect(audit.persistence).toMatchObject({ written: true, recordWritten: true });
    expect(audit.rulesFired).toEqual(expect.arrayContaining(['M1']));
  });

  it('second turn: the delta shows the check result, the answered request and the next request', async () => {
    const { t } = await controlledOpen();
    const blk2 = F.block(F.REG.KEYS, t.out.version, t.out.state);
    const t2 = await F.runTurn(F.TURNS.wmFilterClear, blk2, { reply: 'Thanks. Can you run a drain and spin?' });
    const audit = build(F.ctxFor(blk2), t2.out, RESULT_OK, t2.trace);
    expect(audit.version).toMatchObject({ before: 1, after: 2 });
    expect(audit.stateDelta).toEqual(expect.arrayContaining([
      { op: 'add', field: 'check.drain-filter', to: 'done / clear' },
      { op: 'change', field: 'request.drain-filter', from: 'pending', to: 'answered' },
      { op: 'add', field: 'pendingRequest', to: 'issued CHECK:drain-command' }]));
    expect(audit.stateDelta.find((d) => d.field === 'appliance')).toBeUndefined();   // unchanged facts are not repeated
    expect(audit.pendingRequest).toMatchObject({ change: 'replaced', before: { target: 'drain-filter' }, after: { target: 'drain-command' } });
    expect(audit.diagnostics.ruledOut).toContain('filter-blockage');
    expect(audit.policy.rule).toBe('R8');
  });

  it('safety stop: SAFETY STOP policy, fixed safety copy, hazard in the delta', async () => {
    const blk = F.block();
    const t = await F.runTurn(F.TURNS.wmShock, blk);
    const audit = build(F.ctxFor(blk), t.out, RESULT_OK, t.trace);
    expect(audit.nextAction.kind).toBe('safety_stop');
    expect(audit.policy.safetyStop).toBe('electrical_water');
    expect(audit.compose).toMatchObject({ mode: 'fixed_safety', valid: false });
    expect(audit.stateDelta).toEqual(expect.arrayContaining([{ op: 'add', field: 'hazard.electrical_water', to: 'active' }]));
  });

  it('COMPOSE contract failure: fixed fallback with the violation as the reason', async () => {
    const blk = F.block();
    const t = await F.runTurn(F.TURNS.wmOpen, blk, { reply: 'Is it clear? Is it blocked? Have you bought a new pump?' });
    const audit = build(F.ctxFor(blk), t.out, RESULT_OK, t.trace);
    expect(audit.compose.mode).toBe('fixed_fallback');
    expect(audit.compose.violations.length).toBeGreaterThan(0);
    expect(audit.compose.fallbackReason).toBe(audit.compose.violations[0]);
  });

  it('policy wanted control but the orchestrator answered legacy (no control stage) → not controlled, flagged', async () => {
    const blk = F.block();
    const t = await F.runTurn(F.TURNS.wmOpen, blk);
    const audit = build(F.ctxFor(blk), t.out, RESULT_OK, { stages: [] });
    expect(audit).toMatchObject({ path: 'shadow', controlled: false, gateNotTaken: true, owner: 'wm-not-draining' });
    expect(audit.compose).toBeUndefined();
  });
});

describe('shadow, legacy, degraded, off', () => {
  it('shadow: the journey applies but is not allow-listed → SHADOW, decisions kept for debugging, no COMPOSE', async () => {
    const blk = F.block(['wm-leaking']);
    const t = await F.runTurn(F.TURNS.wmOpen, blk);
    const audit = build(F.ctxFor(blk), t.out, RESULT_OK, t.trace);
    expect(audit).toMatchObject({ path: 'shadow', controlled: false, owner: 'wm-not-draining', journey: { control: false } });
    expect(audit.policy.rule).toBe('R7');
    expect(audit.pendingRequest.change).toBe('none');        // shadow never issues a request
    expect(audit.compose).toBeUndefined();
  });
  it('legacy: canonical ran but no journey owns the turn → LEGACY, classification only', async () => {
    const blk = F.block();
    const t = await F.runTurn(F.TURNS.unrelated, blk);
    const audit = build(F.ctxFor(blk), t.out, RESULT_OK, t.trace);
    expect(audit).toMatchObject({ path: 'legacy', controlled: false, classification: { scope: 'unrelated' } });
    expect(audit.owner).toBeUndefined();
    expect(audit.policy).toBeUndefined();
  });
  it('degraded: classifier degraded → DEGRADED, nothing merged, reason recorded', async () => {
    const blk = F.block();
    const t = await F.runTurn(F.TURNS.wmOpen, blk, { degraded: true });
    const audit = build(F.ctxFor(blk), t.out, { written: false, recordWritten: false, degraded: 'classification_degraded' }, t.trace);
    expect(audit).toMatchObject({ path: 'degraded', controlled: false, version: { before: 0, after: 0 },
      persistence: { written: false, degraded: 'classification_degraded' } });
    expect(audit.classification).toBeUndefined();
    expect(audit.stateDelta).toBeUndefined();
  });
  it('conflict and replay recovery are visible in persistence', async () => {
    const { blk, t } = await controlledOpen();
    const audit = build(F.ctxFor(blk, { recovered: true }), t.out, { written: false, recordWritten: false, degraded: 'conflict' }, t.trace);
    expect(audit.persistence).toMatchObject({ written: false, conflict: true, degraded: 'conflict', recovered: true });
    expect(audit.version.after).toBe(0);
  });
  it('canonical off → no audit (legacy-only BFF); an orchestrator failure is a degraded audit', () => {
    expect(build({ mode: 'off' }, null)).toBeNull();
    const a = A.buildCanonicalTranscriptAudit({ ctx: F.ctxFor(F.block()), out: null, result: { written: false }, error: 'orchestrator_unavailable' });
    expect(a).toMatchObject({ path: 'degraded', persistence: { degraded: 'orchestrator_unavailable' } });
  });
});

describe('security and size', () => {
  it('never contains the csid, the token, the state body, prompts or prose', async () => {
    const { audit, t } = await controlledOpen();
    const dump = JSON.stringify(audit);
    expect(dump).not.toContain(F.CSID);
    expect(dump).not.toContain('cst1.');
    expect(dump).not.toMatch(/"requests"|"history"|"schemaVersion":"cs\/1"|"identity"|"problems"/);   // no cs/1 body
    expect(dump).not.toMatch(/prompt|system|Switch the machine off/i);                                    // no prompt, no reply text
    expect(audit.ref).toMatch(/^[0-9a-f]{12}$/);
    expect(dump.length).toBeLessThan(JSON.stringify(t.out.state).length + 4000);
  });
  it('is bounded: a pathological turn stays under MAX_AUDIT_BYTES', async () => {
    const { blk, t } = await controlledOpen();
    const out = JSON.parse(JSON.stringify(t.out));
    out.classification.observations = Array.from({ length: 200 }, (_, i) => ({ key: `k${i}`.repeat(30), value: 'v'.repeat(500) }));
    out.rulesFired = Array.from({ length: 500 }, (_, i) => `M${i}`);
    out.journey.diagnostics.rank = Array.from({ length: 60 }, (_, i) => [`cause-${i}`.repeat(10), i, 0]);
    out.journey.diagnostics.evidence = out.journey.diagnostics.rank.map(([f]) => ({ family: f, for: Array(50).fill('x'.repeat(200)), against: Array(50).fill('y'.repeat(200)) }));
    for (let i = 0; i < 300; i++) out.state.evidence.observations[`obs${i}`] = { value: 'z'.repeat(300), status: 'active' };
    const audit = build(F.ctxFor(blk), out, RESULT_OK, t.trace);
    expect(Buffer.byteLength(JSON.stringify(audit))).toBeLessThanOrEqual(A.MAX_AUDIT_BYTES);
    expect(audit.truncated).toBe(true);                       // reduced, flagged, never silently dropped
    expect(audit).toMatchObject({ owner: 'wm-not-draining', path: 'control', policy: { rule: 'R7' }, nextAction: { kind: 'ask_check' } });
  });
});

describe('transcript storage', () => {
  const SID = 's-audit-session-01';
  async function seed(store, n = 1, extra = {}) {
    const { audit } = await controlledOpen();
    for (let i = 1; i <= n; i++) {
      await tx.persistTurn(store, { sessionId: SID, clientTurnId: `ct-${i}`, event: 'turn' }, {
        now: new Date(Date.UTC(2026, 9, 5, 10, i)), messages: [{ role: 'user', content: `turn ${i}` }],
        view: { reply: `reply ${i}`, parts: [], media: [] }, orch: { route: 'SYMPTOMS', outcome: 'ANSWER' }, requestId: `rid-${i}`,
        canonical: extra.canonical === undefined ? audit : extra.canonical,
      });
    }
    return audit;
  }
  it('persists the audit on the turn and surfaces it in the detail payload, per turn, in order', async () => {
    const store = tx.createMemoryStore();
    const audit = await seed(store, 2);
    const d = tx.drillDown(await store.get(SID), new Date());
    expect(d.customerVisible.turns.map((t) => t.seq)).toEqual([1, 2]);
    expect(d.customerVisible.turns[0].canonical).toEqual(audit);
    expect(d.customerVisible.turns[0].runtime).toMatchObject({ route: 'SYMPTOMS', outcome: 'ANSWER', requestId: 'rid-1' });
    expect(d.overview.canonical).toMatchObject({ path: 'control', journey: 'wm-not-draining', appliance: 'washing-machine', degraded: false });
  });
  it('idempotent duplicate: the original audit is kept and marked replayed (twice)', async () => {
    const store = tx.createMemoryStore();
    const audit = await seed(store, 1);
    await tx.persistReplay(store, { sessionId: SID, clientTurnId: 'ct-1' }, new Date('2026-10-05T10:05:00Z'));
    await tx.persistReplay(store, { sessionId: SID, clientTurnId: 'ct-1' }, new Date('2026-10-05T10:06:00Z'));
    const t = (await store.get(SID)).turns[0];
    expect(t.canonical.persistence.idempotentReplay).toEqual({ count: 2, lastAt: '2026-10-05T10:06:00.000Z' });
    expect(t.canonical.policy).toEqual(audit.policy);
    expect((await store.get(SID)).turnCount).toBe(1);
    expect(await tx.persistReplay(store, { sessionId: SID, clientTurnId: 'ct-nope' })).toMatchObject({ skipped: true });
  });
  it('a shadow-mode duplicate turn (re-processed as legacy) keeps the original canonical decision', async () => {
    const store = tx.createMemoryStore();
    const audit = await seed(store, 1);
    const dupAudit = A.buildCanonicalTranscriptAudit({ ctx: { ...F.ctxFor(F.block()), block: null, duplicate: { source: 'marker', version: 1 } }, out: null, result: { written: false } });
    await tx.persistTurn(store, { sessionId: SID, clientTurnId: 'ct-1', event: 'turn' }, { messages: [{ role: 'user', content: 'turn 1' }],
      view: { reply: 'again' }, orch: { route: 'SYMPTOMS' }, canonical: dupAudit });
    const t = (await store.get(SID)).turns[0];
    expect(t.canonical.owner).toBe(audit.owner);
    expect(t.canonical.persistence.idempotentReplay.count).toBe(1);
  });
  it('old transcripts (no audit) stay readable and list as legacy', async () => {
    const store = tx.createMemoryStore();
    const old = tx.emptyRecord('s-old-legacy-001', new Date('2026-09-01T10:00:00Z'));
    old.turns = [{ seq: 1, at: old.createdAt, customer: { text: 'old' }, customerVisible: { reply: 'old reply' }, metadata: { route: 'SYMPTOMS' }, diagnosticTrace: null }];
    old.turnCount = 1;
    await store.put(old);
    const d = tx.drillDown(await store.get('s-old-legacy-001'), new Date());
    expect(d.customerVisible.turns[0].canonical).toBeNull();
    expect(d.overview.canonical).toMatchObject({ path: 'legacy', journey: null, degraded: false });
  });
  it('long sessions stay inside the item budget: older audits are slimmed, newest kept in full', async () => {
    const store = tx.createMemoryStore();
    const { blk, t } = await controlledOpen();
    const big = JSON.parse(JSON.stringify(t.out));
    for (let i = 0; i < 300; i++) big.state.evidence.observations[`obs${i}`] = { value: 'z'.repeat(300), status: 'active' };
    const fat = build(F.ctxFor(blk), big, RESULT_OK, t.trace);
    await seed(store, 80, { canonical: fat });
    const rec = await store.get(SID);
    expect(rec.turnCount).toBe(80);
    expect(rec.turns[0].canonical.slim).toBe(true);
    expect(rec.turns[79].canonical.slim).toBeUndefined();
    expect(rec.turns[0].canonical.policy.rule).toBe('R7');                       // the summary survives slimming
    expect(Buffer.byteLength(JSON.stringify(rec.turns))).toBeLessThanOrEqual(tx.PAYLOAD_BUDGET_BYTES);
  });
  it('list filters: journey, canonical path, degraded, part recommended (same page query, no scan)', async () => {
    const store = tx.createMemoryStore();
    await seed(store, 1);
    const legacy = tx.emptyRecord('s-legacy-0000001', new Date());
    legacy.turns = [{ seq: 1, customer: { text: 'x' }, customerVisible: { reply: 'y', parts: [{ name: 'Pump' }] } }]; legacy.turnCount = 1;
    await store.put(legacy);
    const ids = async (q) => (await store.list(q, new Date())).items.map((r) => r.sessionId).sort();
    expect(await ids({ journey: 'wm-not-draining' })).toEqual([SID]);
    expect(await ids({ canonical: 'control' })).toEqual([SID]);
    expect(await ids({ canonical: 'legacy' })).toEqual(['s-legacy-0000001']);
    expect(await ids({ partRecommended: '1' })).toEqual(['s-legacy-0000001']);
    expect(await ids({ partRecommended: '0' })).toEqual([SID]);
    expect(await ids({ degraded: '1' })).toEqual([]);
    expect(await ids({ journey: 'Robert"); drop' })).toHaveLength(2);           // invalid filter value ignored
    const row = (await store.list({}, new Date())).items.find((r) => r.sessionId === SID);
    expect(row.canonical).toMatchObject({ path: 'control', journey: 'wm-not-draining' });
    expect(JSON.stringify(row)).not.toMatch(/stateDelta|diagnostics|nextAction/);     // the list stays compact
  });
});
