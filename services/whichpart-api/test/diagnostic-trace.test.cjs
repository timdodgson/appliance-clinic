'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const tx = require('../transcripts.js');

function trace(state, extraStages) {
  return {
    schemaVersion: '1.0',
    stages: [
      { id: 'routing', label: 'Routing', evidence: 'OBSERVED', summary: 'SYMPTOMS', detail: { route: 'SYMPTOMS', mcpInvoked: false, ragInvoked: true } },
      { id: 'error-code-mcp', label: 'Error Code MCP', evidence: 'DERIVED', summary: 'Skipped by route', detail: null },
      { id: 'jev-understand', label: 'Jev UNDERSTAND', evidence: 'OBSERVED', summary: 'captured', detail: {
        model: 'typesafe/jev', decisions: { cannotAnswer: false }, probabilities: { cannotAnswer: { true: 0.1, false: 0.9 } },
      } },
      { id: 'rag-retrieval', label: 'Knowledge retrieval', evidence: 'OBSERVED', summary: 'one', detail: { knowledgeIds: ['vacuum:lost-suction'], scores: [0.91] } },
      { id: 'orchestrator-state', label: 'Diagnostic state', evidence: 'OBSERVED', summary: 'state', detail: state },
      { id: 'safety', label: 'Safety', evidence: 'OBSERVED', summary: 'normal', detail: { stopReason: null } },
      { id: 'parts-media', label: 'Parts and media', evidence: 'OBSERVED', summary: 'selected', detail: { parts: [], media: [] } },
      { id: 'compose', label: 'COMPOSE', evidence: 'OBSERVED', summary: 'composed', detail: { outputChars: 42 } },
    ].concat(extraStages || []),
  };
}

test('normalises observed/derived/not-captured and redacts secrets', () => {
  const out = tx.normaliseDiagnosticTrace({ schemaVersion: '1.0', stages: [
    { id: 'jev', evidence: 'OBSERVED', summary: 'ok', detail: { authorization: 'Bearer secret', apiToken: 'secret', decision: 'model' } },
    { id: 'mcp', evidence: 'DERIVED', summary: 'skipped', detail: null },
    { id: 'old', evidence: 'invented', summary: 'x', detail: null },
  ]});
  assert.deepEqual(out.stages.map((s) => s.evidence), ['OBSERVED', 'DERIVED', 'NOT_CAPTURED']);
  const json = JSON.stringify(out).toLowerCase();
  assert.equal(json.includes('bearer secret'), false);
  assert.equal(json.includes('apitoken'), false);
});

test('structured multi-turn state marks new retained updated and removed', () => {
  const first = trace({ customer: { model: 'V6', appliance: 'vacuum' }, inferred: { faultId: 'lost-suction', confidence: 0.7 } });
  const second = trace({ customer: { model: 'V6', appliance: 'vacuum', cannotAnswer: true }, inferred: { faultId: 'lost-suction', confidence: 0.8 } });
  const delta = tx.stateProgression(first, second);
  assert.ok(delta.some((x) => x.path === 'customer.model' && x.change === 'RETAINED'));
  assert.ok(delta.some((x) => x.path === 'customer.cannotAnswer' && x.change === 'NEW'));
  assert.ok(delta.some((x) => x.path === 'inferred.confidence' && x.change === 'UPDATED'));
  const third = trace({ customer: { appliance: 'vacuum' }, inferred: { faultId: 'lost-suction', confidence: 0.8 } });
  assert.ok(tx.stateProgression(second, third).some((x) => x.path === 'customer.model' && x.change === 'REMOVED_OR_CONTRADICTED'));
});

test('turn correlation persists trace and computes delta without phrase matching', async () => {
  const store = tx.createMemoryStore();
  const obs1 = { sessionId: 'session-trace-001', event: 'turn', clientTurnId: 'turn-001' };
  const obs2 = { sessionId: 'session-trace-001', event: 'turn', clientTurnId: 'turn-002' };
  const base = { messages: [{ role: 'user', content: 'Dyson V6 pulsing' }], view: { reply: 'Check the filter.', parts: [], media: [] }, requestId: 'r1' };
  await tx.persistTurn(store, obs1, { ...base, orch: { route: 'SYMPTOMS', _diagnosticTrace: trace({ customer: { model: 'V6' } }) } });
  await tx.persistTurn(store, obs2, { ...base, messages: [{ role: 'user', content: "I'm not sure" }], orch: { route: 'SYMPTOMS', _diagnosticTrace: trace({ customer: { model: 'V6', cannotAnswer: true } }) } });
  const rec = await store.get(obs1.sessionId);
  assert.equal(rec.turns[1].clientTurnId, 'turn-002');
  assert.ok(rec.turns[1].diagnosticTrace.stateProgression.some((x) => x.path === 'customer.model' && x.change === 'RETAINED'));
});

test('partial and legacy transcripts remain readable', () => {
  const rec = tx.emptyRecord('session-legacy-001', new Date('2026-09-21T12:00:00Z'));
  rec.turns = [{ seq: 1, at: '2026-09-21T12:00:00Z', customer: { text: 'hello', photo: false }, customerVisible: { reply: 'hello' } }];
  rec.turnCount = 1;
  const view = tx.drillDown(rec, new Date('2026-09-21T12:01:00Z'));
  assert.equal(view.customerVisible.turns[0].diagnosticTrace, null);
  const partial = tx.normaliseDiagnosticTrace({ stages: [{ id: 'mcp', evidence: 'OBSERVED', summary: 'invoked' }] });
  assert.equal(partial.stages[0].detail, null);
});

test('trace covers Jev, MCP invoked/skipped, RAG, safety, parts/media and compose metadata', () => {
  const t = trace({}, [{ id: 'error-code-mcp-used', label: 'MCP', evidence: 'OBSERVED', summary: 'RESOLVED', detail: { status: 'RESOLVED' } }]);
  const ids = new Set(t.stages.map((s) => s.id));
  ['routing','error-code-mcp','jev-understand','rag-retrieval','safety','parts-media','compose'].forEach((id) => assert.ok(ids.has(id)));
  const route = t.stages.find((s) => s.id === 'routing').detail;
  assert.equal(route.mcpInvoked, false);
  assert.equal(route.ragInvoked, true);
});

// PUBLIC NON-DISCLOSURE: the customer-facing view must NEVER carry the internal trace,
// even when the orchestrator response includes _diagnosticTrace. Proves the BFF strips it.
test('public customer view never exposes _diagnosticTrace', () => {
  const { toWhichPartView } = require('../index.js');
  const orch = {
    outcome: 'ANSWER',
    message: 'Check the filter and airflow path.',
    parts: [], media: [], suggestedChecks: [],
    _diagnosticTrace: trace({ customer: { model: 'V6', appliance: 'vacuum' } }),
  };
  const view = toWhichPartView(orch, 'req-nondisclosure-1');
  assert.equal(Object.prototype.hasOwnProperty.call(view, '_diagnosticTrace'), false);
  assert.equal(JSON.stringify(view).includes('_diagnosticTrace'), false);
  assert.equal(JSON.stringify(view).includes('schemaVersion'), false);
});

// BOUNDED TRACE-SIZE POLICY: a long conversation keeps full traces only for recent turns and slims
// older ones (drop heavy detail; keep id/evidence/summary), so the record cannot approach the
// DynamoDB item-size limit. Recent turns retain full evidence.
test('bounded trace policy slims old turns and preserves recent full traces', async () => {
  const store = tx.createMemoryStore();
  const sid = 'session-bounded-0001';
  const total = tx.TRACE_FULL_TURNS + 5;
  for (let i = 1; i <= total; i++) {
    await tx.persistTurn(store, { sessionId: sid, event: 'turn', clientTurnId: 'turn-' + String(i).padStart(3, '0') },
      { messages: [{ role: 'user', content: 'turn ' + i }], view: { reply: 'r' + i, parts: [], media: [] },
        orch: { route: 'SYMPTOMS', _diagnosticTrace: trace({ customer: { model: 'V6', appliance: 'vacuum' }, inferred: { confidence: i / 100 } }) } });
  }
  const rec = await store.get(sid);
  const first = rec.turns[0].diagnosticTrace;      // oldest -> slimmed
  const last = rec.turns[rec.turns.length - 1].diagnosticTrace; // newest -> full
  assert.equal(first.bounded, true);
  assert.equal(first.stages.every((s) => s.detail === null), true);
  assert.ok(first.stages.length > 0 && first.stages[0].evidence); // labels preserved
  assert.notEqual(last.bounded, true);
  assert.ok(last.stages.some((s) => s.detail !== null)); // recent detail retained
});
