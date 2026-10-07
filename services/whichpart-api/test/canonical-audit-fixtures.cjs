'use strict';
/**
 * Real canonical turns for the transcript-audit tests: the REAL part-finder merge + journey runtime + COMPOSE
 * (fake LM provider, no network), so the audit is built from exactly the structures production produces.
 */
globalThis.awslambda = globalThis.awslambda || { streamifyResponse: (f) => f, HttpResponseStream: { from: (s) => s } };
const L = require('../../part-finder/part-finder-lambda.js')._internal;
const mc1 = require('../../part-finder/canonical/mc1.js');
const REG = require('../../part-finder/canonical/journey-registry.js');

const CSID = 'cs_' + 'A'.repeat(32);
const C = (f = {}) => mc1.validateClassification({ scope: 'appliance', ...f });
const WM = { identity: { appliance: { value: 'washing-machine', basis: 'stated' }, make: { value: 'hotpoint', basis: 'stated' } },
  problem: { journey: 'not-draining', faultDomain: 'water' } };
const TURNS = {
  wmOpen: C({ ...WM, intent: 'report_fault', observations: [{ key: 'waterRemaining', value: true }] }),
  wmFilterClear: C({ checks: [{ check: 'drain-filter', status: 'done', result: 'clear' }], reply: { toPending: 'answered' } }),
  wmShock: C({ ...WM, safety: { hazard: 'electrical_water' } }),
  unrelated: C({ scope: 'unrelated' }),
};
const block = (journeys = REG.KEYS, version = 0, state = null, mode = 'control') => ({ schema: 'cs/1', mode, control: { journeys: [...journeys] },
  sessionId: CSID, version, state, degraded: null });
const fakeProvider = (text) => ({ infer: async (req, { onDelta }) => { onDelta(text); } });

/** understand (merge + route + decide) and, when controlled, diagnose-time COMPOSE → {out, trace}. */
async function runTurn(classification, blk, { reply = 'Switch the machine off at the wall first. Is the drain filter clear?', degraded = false } = {}) {
  const transport = L.canonicalTransportMerge(degraded ? null : classification, blk);
  const out = await L.canonicalJourneys(transport, blk, { lookupFn: async () => ({ parts: [] }) });
  const trace = { schemaVersion: '1.0', stages: [{ id: 'routing', label: 'Routing', evidence: 'OBSERVED', summary: 'SYMPTOMS', detail: { route: 'SYMPTOMS' } }] };
  if (L.canonicalControls(out)) {
    const r = await L.canonicalRespond({ canonical: out, messages: [], requestId: 'r' }, { provider: fakeProvider(reply), ensureMedia: false });
    trace.stages.push(...r.done.diagnosticTrace.stages);
    return { out, trace, reply: r.reply };
  }
  return { out, trace, reply: null };
}
/** The BFF context for a turn (what conversation-state.prepareTurn hands the handler). */
const ctxFor = (blk, extra = {}) => ({ mode: blk.mode, demoted: false, journeys: blk.control.journeys, block: blk, token: 'cst1.secret-token',
  csid: CSID, version: blk.version, priorState: blk.state, degraded: null, recovered: false, clientTurnId: 'ct-1', duplicate: null, ...extra });

module.exports = { L, CSID, C, WM, TURNS, block, runTurn, ctxFor, fakeProvider, REG };
