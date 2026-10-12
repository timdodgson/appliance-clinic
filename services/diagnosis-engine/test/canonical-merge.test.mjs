/**
 * Layer B — Stage B cs/1 pure merge (canonical-semantic-state.md §12, M0–M21).
 * Exact typed assertions on state fields. No prose. Classifications are built with the mc/1
 * validator so every input has the fixed mc/1 shape.
 */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { merge, replay } = require('../canonical/merge.js');
const { emptyState, activeProblem } = require('../canonical/cs1.js');
const rq = require('../canonical/requests.js');
const mc1 = require('../canonical/mc1.js');

const C = (fields = {}) => mc1.validateClassification({ scope: 'appliance', ...fields });
const id = (o) => ({ identity: o });
const fold = (...cs) => cs.reduce((s, c) => merge(s, c).state, emptyState('s1'));
const step = (s, c) => merge(s, c);
const ask = (s, slot, target) => rq.issueRequest(s, { slot, target, purpose: 'DIAGNOSIS' }, s.version).state;

// ---------------------------------------------------------------- M0
describe('M0 prompt attack / unrelated', () => {
  const base = fold(C({ ...id({ appliance: { value: 'washing-machine', basis: 'stated' } }), problem: { journey: 'not-draining' } }));
  it('prompt attack: no facts merged, refusal counted, version advances', () => {
    const r = step(base, C({ scope: 'prompt_attack', ...id({ make: { value: 'bosch', basis: 'stated' } }), safety: { hazard: 'gas_smell' } }));
    expect(r.trace.rules).toEqual(['M0']);
    expect(r.state.identity.make.value).toBe(null);
    expect(r.state.safety.hazards).toEqual([]);
    expect(r.state.scope.refusals).toBe(1);
    expect(r.state.version).toBe(2);
  });
  it('unrelated: problems untouched', () => {
    const r = step(base, C({ scope: 'unrelated' }));
    expect(r.state.problems).toEqual(base.problems);
  });
  it('M0 leaves a pending request pending', () => {
    const s = ask(base, 'CHECK', 'drain-filter');
    const r = step(s, C({ scope: 'prompt_attack' }));
    expect(r.state.pendingRequest).toBe('q1');
    expect(r.state.requests[0].outcome).toBe('pending');
  });
});

// ---------------------------------------------------------------- identity
describe('identity (M1–M5, M8, M9, M19)', () => {
  it('M1 new appliance (stated) → established', () => {
    const s = fold(C(id({ appliance: { value: 'washing-machine', basis: 'stated' } })));
    expect(s.identity.appliance.value).toBe('washing-machine');
    expect(s.identity.appliance.basis).toBe('stated');
    expect(s.identity.appliance.turn).toBe(1);
    expect(s.identity.applianceEstablishment).toBe('established');
  });
  it('inferred appliance → working; null basis is treated as inferred (never stated)', () => {
    expect(fold(C(id({ appliance: { value: 'vacuum', basis: 'inferred' } }))).identity.applianceEstablishment).toBe('working');
    const s = fold(C(id({ appliance: { value: 'vacuum', basis: null } })));
    expect(s.identity.appliance.basis).toBe('inferred');
  });
  it('M2 Dyson inferred vacuum, later "it\'s a vacuum" → basis upgrades to stated, first turn kept', () => {
    const s = fold(
      C(id({ appliance: { value: 'vacuum', basis: 'inferred' }, make: { value: 'dyson', basis: 'stated' } })),
      C(id({ appliance: { value: 'vacuum', basis: 'stated' } })),
    );
    expect(s.identity.appliance).toMatchObject({ value: 'vacuum', basis: 'stated', turn: 1 });
    expect(s.identity.make).toMatchObject({ value: 'dyson', basis: 'stated' });
    expect(s.identity.applianceEstablishment).toBe('established');
  });
  it('M4 inferred value replaced by a different stated value (history kept)', () => {
    const s = fold(C(id({ appliance: { value: 'tumble-dryer', basis: 'inferred' } })), C(id({ appliance: { value: 'washer-dryer', basis: 'stated' } })));
    expect(s.identity.appliance.value).toBe('washer-dryer');
    expect(s.identity.appliance.history).toEqual([{ value: 'tumble-dryer', basis: 'inferred', turn: 1, supersededBy: 'update' }]);
  });
  it('M5 stated contradiction without correction → old kept, conflict recorded', () => {
    const s = fold(C(id({ appliance: { value: 'washing-machine', basis: 'stated' } })), C(id({ appliance: { value: 'dishwasher', basis: 'stated' } })));
    expect(s.identity.appliance.value).toBe('washing-machine');
    expect(s.identity.appliance.conflict).toEqual({ value: 'dishwasher', basis: 'stated', turn: 2 });
  });
  it('M3 explicit appliance correction supersedes and clears the conflict', () => {
    const s = fold(
      C(id({ appliance: { value: 'washing-machine', basis: 'stated' } })),
      C(id({ appliance: { value: 'dishwasher', basis: 'stated' } })),
      C({ ...id({ appliance: { value: 'dishwasher', basis: 'stated' } }), reply: { correction: ['identity.appliance'] } }),
    );
    expect(s.identity.appliance.value).toBe('dishwasher');
    expect(s.identity.appliance.conflict).toBe(undefined);
    expect(s.identity.appliance.history[0]).toMatchObject({ value: 'washing-machine', supersededBy: 'correction' });
  });
  it('M3 make correction', () => {
    const s = fold(C(id({ make: { value: 'hotpoint', basis: 'stated' } })),
      C({ ...id({ make: { value: 'indesit', basis: 'stated' } }), reply: { correction: ['identity.make'] } }));
    expect(s.identity.make.value).toBe('indesit');
    expect(s.identity.make.history[0]).toMatchObject({ value: 'hotpoint', supersededBy: 'correction' });
  });
  it('M9 model unavailable → modelStatus unavailable', () => {
    expect(fold(C(id({ modelStatus: 'unavailable' }))).identity.modelStatus).toBe('unavailable');
  });
  it('M9 will_look → pending_lookup, but never overrides unavailable', () => {
    expect(fold(C(id({ modelStatus: 'will_look' }))).identity.modelStatus).toBe('pending_lookup');
    expect(fold(C(id({ modelStatus: 'unavailable' })), C(id({ modelStatus: 'will_look' }))).identity.modelStatus).toBe('unavailable');
  });
  it('M8 model later known overrides unavailable (confirmed, known)', () => {
    const s = fold(C(id({ modelStatus: 'unavailable' })), C(id({ model: { value: 'WMUD962P', basis: 'stated' } })));
    expect(s.identity.model).toMatchObject({ value: 'WMUD962P', basis: 'stated', confirmed: true });
    expect(s.identity.modelStatus).toBe('known');
  });
  it('M8 image-read model stays unconfirmed; a later stated repeat confirms it (M2)', () => {
    const s1 = fold(C(id({ model: { value: 'WAN28281GB', basis: 'read_from_image' } })));
    expect(s1.identity.model.confirmed).toBe(false);
    expect(s1.identity.modelStatus).toBe(null);
    const s2 = merge(s1, C(id({ model: { value: 'WAN28281GB', basis: 'stated' } }))).state;
    expect(s2.identity.model).toMatchObject({ basis: 'stated', confirmed: true, turn: 1 });
    expect(s2.identity.modelStatus).toBe('known');
  });
  it('fuel conflict: two different stated fuels → value null, conflict true', () => {
    const s = fold(C(id({ fuel: 'gas' })), C(id({ fuel: 'electric' })));
    expect(s.identity.fuel.value).toBe(null);
    expect(s.identity.fuel.conflict).toBe(true);
  });
  it('fuel correction resolves the conflict', () => {
    const s = fold(C(id({ fuel: 'gas' })), C(id({ fuel: 'electric' })),
      C({ ...id({ fuel: 'electric' }), reply: { correction: ['identity.fuel'] } }));
    expect(s.identity.fuel).toMatchObject({ value: 'electric', conflict: false });
  });
});

// ---------------------------------------------------------------- M16 codes
describe('displayed codes (M16)', () => {
  it('append; newer code active, older superseded', () => {
    const s = fold(C(id({ displayedCode: 'F05' })), C(id({ displayedCode: 'F11' })));
    expect(s.identity.displayedCodes.map((f) => [f.value, f.status])).toEqual([['F05', 'superseded'], ['F11', 'active']]);
  });
  it('same code repeated is not duplicated', () => {
    expect(fold(C(id({ displayedCode: 'E18' })), C(id({ displayedCode: 'E18' }))).identity.displayedCodes.length).toBe(1);
  });
  it('a token later typed as the model supersedes the code', () => {
    const s = fold(C(id({ displayedCode: 'V11' })), C(id({ model: { value: 'V11', basis: 'stated' } })));
    expect(s.identity.displayedCodes[0].status).toBe('superseded');
    expect(s.identity.model.value).toBe('V11');
  });
});

// ---------------------------------------------------------------- M17 intent
describe('intent (M17)', () => {
  it('new intent replaces active; null retains; history kept', () => {
    const s = fold(C({ intent: 'report_fault' }), C({}), C({ intent: 'buy_part' }), C({}));
    expect(s.intent.active).toBe('buy_part');
    expect(s.intent.history).toEqual([{ intent: 'report_fault', turn: 1 }, { intent: 'buy_part', turn: 3 }]);
  });
});

// ---------------------------------------------------------------- problems
describe('problems (M1–M5 on problem facts, M11, M12, M13)', () => {
  const opener = C({ ...id({ appliance: { value: 'washing-machine', basis: 'stated' } }), problem: { journey: 'not-draining' } });
  it('opens a problem', () => {
    const s = fold(opener);
    expect(s.problems.length).toBe(1);
    expect(s.problems[0]).toMatchObject({ id: 'p1', status: 'active', origin: 'stated', openedTurn: 1 });
    expect(s.problems[0].journey).toMatchObject({ value: 'not-draining', basis: 'stated' });
  });
  it('same problem update: scope added to the active problem', () => {
    const s = fold(opener, C({ problem: { scope: 'one_programme', relation: 'same' } }));
    expect(s.problems.length).toBe(1);
    expect(s.problems[0].scope.value).toBe('one_programme');
  });
  it('different journey without relation/correction → conflict recorded, journey kept', () => {
    const s = fold(opener, C({ problem: { journey: 'leaking' } }));
    expect(s.problems.length).toBe(1);
    expect(s.problems[0].journey.value).toBe('not-draining');
    expect(s.problems[0].journey.conflict).toMatchObject({ value: 'leaking' });
  });
  it('journey correction supersedes', () => {
    const s = fold(opener, C({ problem: { journey: 'not-spinning' }, reply: { correction: ['problem.journey'] } }));
    expect(s.problems[0].journey.value).toBe('not-spinning');
    expect(s.problems[0].journey.history[0]).toMatchObject({ value: 'not-draining', supersededBy: 'correction' });
  });
  it('additional problem → second active problem', () => {
    const s = fold(opener, C({ problem: { journey: 'noisy', relation: 'additional' } }));
    expect(s.problems.map((p) => [p.id, p.status, p.journey.value])).toEqual([['p1', 'active', 'not-draining'], ['p2', 'active', 'noisy']]);
  });
  it('different problem, same appliance → old superseded, new opened, evidence kept', () => {
    const s = fold(opener, C({ observations: [{ key: 'waterRemaining', value: true }] }),
      C({ problem: { journey: 'leaking', relation: 'different' } }));
    expect(s.problems.map((p) => [p.status, p.journey.value])).toEqual([['superseded', 'not-draining'], ['active', 'leaking']]);
    expect(s.evidence.observations.waterRemaining.value).toBe(true);
    expect(s.problems[0].archive).toBe(null);
  });
  it('different problem, different appliance → new job: identity + evidence archived and reset', () => {
    const s = fold(
      C({ ...id({ appliance: { value: 'washing-machine', basis: 'stated' }, make: { value: 'hotpoint', basis: 'stated' }, model: { value: 'WMUD962P', basis: 'stated' } }), problem: { journey: 'not-draining' } }),
      C({ observations: [{ key: 'waterRemaining', value: true }] }),
      C({ ...id({ appliance: { value: 'dishwasher', basis: 'stated' } }), problem: { journey: 'not-draining', relation: 'different' } }),
    );
    expect(s.identity.appliance.value).toBe('dishwasher');
    expect(s.identity.make.value).toBe(null);
    expect(s.identity.model.value).toBe(null);
    expect(s.evidence.observations).toEqual({});
    expect(s.problems[0].archive.identity.make.value).toBe('hotpoint');
    expect(s.problems[0].archive.evidence.observations.waterRemaining.value).toBe(true);
    expect(activeProblem(s).id).toBe('p2');
  });
  it('M12 resolved → problem resolved, resolution resolved, checks kept', () => {
    const s = fold(opener, C({ checks: [{ check: 'drain-filter', status: 'done', result: 'found_and_cleared' }] }),
      C({ reply: { outcome: 'resolved' } }));
    expect(s.problems[0]).toMatchObject({ status: 'resolved', resolvedTurn: 3 });
    expect(s.resolution).toBe('resolved');
    expect(s.evidence.checks['drain-filter'].result).toBe('found_and_cleared');
  });
  it('M12 temporary → resolution temporary, problem stays active', () => {
    const s = fold(opener, C({ reply: { outcome: 'temporary' } }));
    expect(s.resolution).toBe('temporary');
    expect(s.problems[0].status).toBe('active');
  });
  it('M12 unresolved → resolution unresolved', () => {
    expect(fold(opener, C({ reply: { outcome: 'unresolved' } })).resolution).toBe('unresolved');
  });
  it('M13 recurrence: same journey after resolved → re-opened, recurrence recorded', () => {
    const s = fold(opener, C({ reply: { outcome: 'resolved' } }), C({ problem: { journey: 'not-draining' } }));
    expect(s.problems.length).toBe(1);
    expect(s.problems[0]).toMatchObject({ status: 'active', resolvedTurn: null, recurrences: [3] });
    expect(s.resolution).toBe('unresolved');
  });
});

// ---------------------------------------------------------------- observations
describe('observations', () => {
  it('new true / new false', () => {
    const s = fold(C({ observations: [{ key: 'waterRemaining', value: true }, { key: 'waterEntering', value: false }] }));
    expect(s.evidence.observations.waterRemaining).toMatchObject({ value: true, basis: 'stated', turn: 1 });
    expect(s.evidence.observations.waterEntering).toMatchObject({ value: false, basis: 'stated' });
  });
  it('repeated observation keeps first turn', () => {
    const s = fold(C({ observations: [{ key: 'pumpHumming', value: true }] }), C({ observations: [{ key: 'pumpHumming', value: true }] }));
    expect(s.evidence.observations.pumpHumming.turn).toBe(1);
  });
  it('latest stated observation wins without correction (supersededBy update)', () => {
    const s = fold(C({ observations: [{ key: 'waterEntering', value: false }] }), C({ observations: [{ key: 'waterEntering', value: true }] }));
    expect(s.evidence.observations.waterEntering.value).toBe(true);
    expect(s.evidence.observations.waterEntering.history[0]).toMatchObject({ value: false, supersededBy: 'update' });
  });
  it('explicit observation correction (supersededBy correction)', () => {
    const s = fold(C({ observations: [{ key: 'pumpHumming', value: true }] }),
      C({ observations: [{ key: 'pumpHumming', value: false }], reply: { correction: ['observations.pumpHumming'] } }));
    expect(s.evidence.observations.pumpHumming.history[0].supersededBy).toBe('correction');
  });
  it('waterReturnsAfterDrain merges as a stated observation (G1)', () => {
    const s = fold(C({ observations: [{ key: 'waterReturnsAfterDrain', value: true }] }));
    expect(s.evidence.observations.waterReturnsAfterDrain).toMatchObject({ value: true, basis: 'stated' });
  });
  it('M18 exclusivity: a TRUE member makes siblings FALSE with basis derived', () => {
    const s = fold(C({ observations: [{ key: 'gasHob', value: true }] }));
    expect(s.evidence.observations.inductionHob).toMatchObject({ value: false, basis: 'derived', derivedBy: 'D2' });
    expect(s.evidence.observations.ceramicHob).toMatchObject({ value: false, basis: 'derived' });
  });
  it('derived never overwrites a stated value', () => {
    const s = fold(C({ observations: [{ key: 'inductionHob', value: true }, { key: 'gasHob', value: true }] }));
    expect(s.evidence.observations.gasHob).toMatchObject({ value: true, basis: 'stated' });
  });
  it('derived values are recomputed: they disappear when the source is superseded', () => {
    const s = fold(C({ observations: [{ key: 'noHeat', value: true }] }), C({ observations: [{ key: 'noHeat', value: false }] }));
    expect(s.evidence.observations.heatPresent).toBe(undefined);
  });
  it('a stated value later replaces a derived one', () => {
    const s = fold(C({ observations: [{ key: 'gasHob', value: true }] }), C({ observations: [{ key: 'inductionHob', value: false }] }));
    expect(s.evidence.observations.inductionHob).toMatchObject({ value: false, basis: 'stated' });
  });
  it('D1 fridge_only scope → fridgeOnlyWarm derived (and bothCompartmentsWarm derived false)', () => {
    const s = fold(C({ problem: { journey: 'not-cooling', scope: 'fridge_only' } }));
    expect(s.evidence.observations.fridgeOnlyWarm).toMatchObject({ value: true, basis: 'derived', derivedBy: 'D1' });
    expect(s.evidence.observations.bothCompartmentsWarm).toMatchObject({ value: false, basis: 'derived' });
  });
});

// ---------------------------------------------------------------- checks + declined
describe('checks (M10) and declined (M6/M7)', () => {
  it('not_done → done/clear (latest supersedes, history kept)', () => {
    const s = fold(C({ checks: [{ check: 'drain-filter', status: 'not_done' }] }),
      C({ checks: [{ check: 'drain-filter', status: 'done', result: 'clear' }] }));
    expect(s.evidence.checks['drain-filter']).toMatchObject({ status: 'done', result: 'clear', turn: 2 });
    expect(s.evidence.checks['drain-filter'].history[0]).toMatchObject({ status: 'not_done', supersededBy: 'update' });
  });
  it('found_and_cleared recorded', () => {
    expect(fold(C({ checks: [{ check: 'drain-filter', status: 'done', result: 'found_and_cleared' }] }))
      .evidence.checks['drain-filter'].result).toBe('found_and_cleared');
  });
  it('clear → found_and_cleared correction', () => {
    const s = fold(C({ checks: [{ check: 'drain-filter', status: 'done', result: 'clear' }] }),
      C({ checks: [{ check: 'drain-filter', status: 'done', result: 'found_and_cleared' }], reply: { correction: ['checks.drain-filter'] } }));
    expect(s.evidence.checks['drain-filter'].history[0]).toMatchObject({ result: 'clear', supersededBy: 'correction' });
  });
  it('unable → check status + declined{kind:unable}', () => {
    const s = fold(C({ checks: [{ check: 'drain-filter', status: 'unable' }] }));
    expect(s.evidence.checks['drain-filter'].status).toBe('unable');
    expect(s.declined).toEqual([{ target: 'drain-filter', kind: 'unable', turn: 1, resolvedTurn: null }]);
  });
  it('declined (refusal) → declined{kind:declined}', () => {
    expect(fold(C({ checks: [{ check: 'drain-hose', status: 'declined' }] })).declined[0].kind).toBe('declined');
  });
  it('later completed check resolves the earlier decline (M7)', () => {
    const s = fold(C({ checks: [{ check: 'drain-filter', status: 'unable' }] }),
      C({ checks: [{ check: 'drain-filter', status: 'done', result: 'clear' }] }));
    expect(s.declined[0].resolvedTurn).toBe(2);
  });
  it('cannot answer the pending request → declined{target, kind:cannot_answer}, target stays null', () => {
    const s0 = ask(fold(C({})), 'OBSERVATION', 'pumpHumming');
    const s = merge(s0, C({ reply: { toPending: 'cannot_answer' } })).state;
    expect(s.declined).toEqual([{ target: 'pumpHumming', kind: 'cannot_answer', turn: 2, resolvedTurn: null }]);
    expect(s.evidence.observations.pumpHumming).toBe(undefined);
  });
  it('cannot answer a MODEL request → modelStatus unavailable (replaces the orchestrator latch)', () => {
    const s0 = ask(fold(C({})), 'IDENTITY', 'model');
    expect(merge(s0, C({ reply: { toPending: 'cannot_answer' } })).state.identity.modelStatus).toBe('unavailable');
  });
  it('later answer resolves a cannot-answer decline (M7)', () => {
    const s0 = ask(fold(C({})), 'OBSERVATION', 'pumpHumming');
    const s1 = merge(s0, C({ reply: { toPending: 'cannot_answer' } })).state;
    const s2 = merge(s1, C({ observations: [{ key: 'pumpHumming', value: true }] })).state;
    expect(s2.declined[0].resolvedTurn).toBe(3);
    expect(s2.evidence.observations.pumpHumming.value).toBe(true);
  });
  it('refusal of the pending request (toPending declined) → declined{kind:declined}', () => {
    const s0 = ask(fold(C({})), 'CHECK', 'drain-hose');
    expect(merge(s0, C({ reply: { toPending: 'declined' } })).state.declined[0]).toMatchObject({ target: 'drain-hose', kind: 'declined' });
  });
});

// ---------------------------------------------------------------- safety
describe('safety (M14, M15)', () => {
  it('hazard added → active + peak raised', () => {
    const s = fold(C({ safety: { hazard: 'burning' } }));
    expect(s.safety.hazards).toEqual([{ hazard: 'burning', turn: 1, status: 'active', correctedTurn: null }]);
    expect(s.safety.activeLevel).toBe('STOP_USE');
    expect(s.safety.peakLevel).toBe('STOP_USE');
  });
  it('stronger hazard raises active and peak', () => {
    const s = fold(C({ safety: { hazard: 'burning' } }), C({ safety: { hazard: 'gas_smell' } }));
    expect(s.safety.activeLevel).toBe('EMERGENCY_ACTION');
    expect(s.safety.peakLevel).toBe('EMERGENCY_ACTION');
  });
  it('correction lowers active but not peak; history retained', () => {
    const s = fold(C({ safety: { hazard: 'burning' } }), C({ reply: { correction: ['safety.hazard'] } }));
    expect(s.safety.hazards).toEqual([{ hazard: 'burning', turn: 1, status: 'corrected', correctedTurn: 2 }]);
    expect(s.safety.activeLevel).toBe('NORMAL_DIAGNOSTIC');
    expect(s.safety.peakLevel).toBe('STOP_USE');
  });
  it('merge does not encode stickiness: electrical_water can be marked corrected (policy decides later)', () => {
    const s = fold(C({ safety: { hazard: 'electrical_water' } }), C({ reply: { correction: ['safety.hazard'] } }));
    expect(s.safety.hazards[0].status).toBe('corrected');
    expect(s.safety.peakLevel).toBe('STOP_USE');
  });
  it('unsafe action appended (M15)', () => {
    const s = fold(C({ safety: { unsafeAction: 'live_electrical_test' } }), C({ safety: { unsafeAction: 'bypass_safety_device' } }));
    expect(s.safety.unsafeActions).toEqual([{ action: 'live_electrical_test', turn: 1 }, { action: 'bypass_safety_device', turn: 2 }]);
  });
  it('D3 supply trip with no other journey → derived trips-electrics problem', () => {
    const s = fold(C({ safety: { hazard: 'supply_trip' } }));
    expect(s.problems.length).toBe(1);
    expect(s.problems[0]).toMatchObject({ origin: 'derived', status: 'active' });
    expect(s.problems[0].journey).toMatchObject({ value: 'trips-electrics', basis: 'derived', derivedBy: 'D3' });
  });
  it('D3 not applied when a stated journey exists', () => {
    const s = fold(C({ problem: { journey: 'leaking' }, safety: { hazard: 'supply_trip' } }));
    expect(s.problems.map((p) => p.journey.value)).toEqual(['leaking']);
  });
  it('D3 derived problem disappears when the trip is corrected', () => {
    const s = fold(C({ safety: { hazard: 'supply_trip' } }), C({ reply: { correction: ['safety.hazard'] } }));
    expect(s.problems).toEqual([]);
  });
  it('D3 derived journey is replaced by a later stated journey (origin becomes stated)', () => {
    const s = fold(C({ safety: { hazard: 'supply_trip' } }), C({ problem: { journey: 'leaking' } }));
    expect(s.problems.length).toBe(1);
    expect(s.problems[0]).toMatchObject({ origin: 'stated' });
    expect(s.problems[0].journey).toMatchObject({ value: 'leaking', basis: 'stated' });
  });
});

// ---------------------------------------------------------------- evidence ownership
describe('evidence ownership', () => {
  it('merge never writes diagnostics fields into customer evidence or inferred', () => {
    const s = fold(
      C({ ...id({ appliance: { value: 'washing-machine', basis: 'stated' } }), problem: { journey: 'not-draining' }, observations: [{ key: 'pumpHumming', value: true }] }),
      C({ checks: [{ check: 'drain-filter', status: 'done', result: 'clear' }] }),
    );
    expect(s.inferred).toEqual({});
    const json = JSON.stringify(s.evidence);
    for (const k of ['faultId', 'confidence', 'partReadiness', 'candidateComponents', 'primaryFinding']) {
      expect(json.includes(`"${k}"`)).toBe(false);
    }
  });
  it('input state is never mutated', () => {
    const s0 = fold(C({ problem: { journey: 'not-draining' } }));
    const before = JSON.stringify(s0);
    merge(s0, C({ observations: [{ key: 'waterRemaining', value: true }], reply: { outcome: 'resolved' } }));
    expect(JSON.stringify(s0)).toBe(before);
  });
});

// ---------------------------------------------------------------- properties / replay
describe('properties', () => {
  const seq = [
    C({ ...id({ appliance: { value: 'washing-machine', basis: 'stated' }, make: { value: 'hotpoint', basis: 'stated' } }), intent: 'report_fault', problem: { journey: 'not-draining' }, observations: [{ key: 'waterRemaining', value: true }] }),
    C({ checks: [{ check: 'drain-filter', status: 'done', result: 'clear' }], reply: { toPending: 'answered' } }),
    C({ ...id({ model: { value: 'WMUD962P', basis: 'stated' } }), observations: [{ key: 'pumpHumming', value: true }] }),
  ];
  const sparseKeys = (s) => JSON.stringify({ a: s.identity.appliance.value, m: s.identity.make.value, j: s.problems.map((p) => p.journey.value), o: s.evidence.observations, k: s.evidence.checks });

  it('replay: the same classifications in order produce byte-identical state', () => {
    expect(JSON.stringify(replay(seq, { sessionId: 's1' }))).toBe(JSON.stringify(replay(seq, { sessionId: 's1' })));
    expect(JSON.stringify(fold(...seq))).toBe(JSON.stringify(replay(seq, { sessionId: 's1' })));
  });
  it('empty classification is idempotent except version', () => {
    const s = fold(...seq);
    const r = merge(s, C({})).state;
    expect({ ...r, version: 0 }).toEqual({ ...s, version: 0 });
    expect(r.version).toBe(s.version + 1);
  });
  it('sparse turn loses nothing (cannot-answer / identity-only / empty)', () => {
    const s = fold(...seq);
    for (const sparse of [C({ reply: { toPending: 'cannot_answer' } }), C(id({ fuel: 'electric' })), C({})]) {
      expect(sparseKeys(merge(s, sparse).state)).toBe(sparseKeys(s));
    }
  });
  it('corrections keep history', () => {
    const s = merge(fold(...seq), C({ ...id({ make: { value: 'indesit', basis: 'stated' } }), reply: { correction: ['identity.make'] } })).state;
    expect(s.identity.make.history.length).toBe(1);
  });
  it('version equals the number of merged turns', () => {
    expect(fold(...seq).version).toBe(3);
  });
  it('peakLevel never decreases across any sequence', () => {
    let s = emptyState('s');
    let peak = 0;
    const order = ['NORMAL_DIAGNOSTIC', 'STATUS_ONLY', 'SERVICE_REQUIRED', 'ISOLATE_IF_SAFE', 'STOP_USE', 'EMERGENCY_ACTION'];
    for (const c of [C({ safety: { hazard: 'burning' } }), C({ reply: { correction: ['safety.hazard'] } }), C({ safety: { hazard: 'gas_escape' } }), C({ reply: { correction: ['safety.hazard'] } }), C({})]) {
      s = merge(s, c).state;
      const p = order.indexOf(s.safety.peakLevel);
      expect(p).toBeGreaterThanOrEqual(peak);
      peak = p;
    }
    expect(s.safety.activeLevel).toBe('NORMAL_DIAGNOSTIC');
  });
});
