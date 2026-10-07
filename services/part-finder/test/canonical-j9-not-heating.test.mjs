/**
 * Journey 9 (wm-not-heating): diagnostics, policy, part gate, COMPOSE contract, routing / gate.
 * Expectations from wm-batch-2-evidence.md §6 (cool glass / eco is normal; heater part only with a heater code).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
globalThis.awslambda = globalThis.awslambda || { streamifyResponse: (f) => f, HttpResponseStream: { from: (s) => s } };
const H = require('./helpers/b2-journey.cjs');
const J = require('../canonical/j9-pipeline.js');
const P = require('../canonical/j9-policy.js');
const JC = require('../canonical/j9-compose.js');
const L = require('../part-finder-lambda.js')._internal;
const { C, O, K } = H;

const op = (obs = [], identity = {}) => H.opener('no-heat', 'heat', [O('noHeat'), ...obs], {}, identity);
const MP = [{ title: 'Heater' }, { title: 'Door Seal' }];
const hotpointCode = (code) => op([O('hotProgrammeUsed')], { make: { value: 'hotpoint', basis: 'stated' }, displayedCode: code });
const SEQ = {
  eco: [op(), C({ observations: [O('hotProgrammeUsed', false)] }), C({ observations: [O('heatPresent')], reply: { toPending: 'answered' } })],
  ecoCold: [op(), C({ observations: [O('hotProgrammeUsed', false)] }), C({ observations: [O('noHeat')], reply: { toPending: 'answered' } }), C({ observations: [O('longCycle')] }), H.model()],
  hotLong: [op([O('hotProgrammeUsed')]), C({ observations: [O('longCycle')] }), H.model()],
  heaterCode: [hotpointCode('F08'), C({ observations: [O('longCycle')] }), H.model()],
  heaterCodeNoModel: [hotpointCode('F08'), C({ observations: [O('longCycle')] }), H.noModel()],
  ntcCode: [hotpointCode('F03'), C({ observations: [O('longCycle', false)] }), H.model()],
  trips: [op(), C({ safety: { hazard: 'supply_trip' } }), C({})],
  burning: [op([O('hotProgrammeUsed')]), C({ safety: { hazard: 'burning' } })],
  notDone: [op([O('hotProgrammeUsed', false)]), C({ checks: [K('hot-wash-test', 'not_done')] }), C({ checks: [K('hot-wash-test', 'not_done')] })],
  cannot: [op(), C({ reply: { toPending: 'cannot_answer' } }), C({ reply: { toPending: 'cannot_answer' } }), C({ reply: { toPending: 'cannot_answer' } })],
};
const run = (k) => H.play(J, SEQ[k], { modelParts: MP });

describe('diagnostics', () => {
  it('cool washing on eco + warm on the 60°C test → normal behaviour (heater contradicted)', () => {
    const d = run('eco').prep.diag;
    expect(d.leader.family).toBe('normal-low-temperature');
    expect(d.contradicted.map((c) => c.family)).toContain('heater-element');
  });
  it('cold on a hot programme + long cycle → heater only POSSIBLE (cause family; no code → no part)', () => {
    const d = run('hotLong').prep.diag;
    expect(d.leader).toMatchObject({ family: 'heater-element', level: 'cause_family' });
    expect(d.partEvidence.sufficient).toBe(false);
  });
  it('heater-specific code → heater component; NTC code → temperature sensor, never a part', () => {
    expect(run('heaterCode').prep.diag.leader).toMatchObject({ family: 'heater-element', component: 'heater' });
    expect(run('ntcCode').prep.diag.leader).toMatchObject({ family: 'temperature-sensor', level: 'cause_family' });
  });
});

describe('policy', () => {
  it('programme? → eco → 60°C test → warm → normal, no part', () => {
    const r = run('eco');
    expect(r.rules).toEqual(['H10:hotProgrammeUsed', 'H11:hot-wash-test', 'H22:normal-low-temperature']);
    expect(r.last.conclusion).toMatchObject({ noPart: true });
  });
  it('60°C test cold → long cycle? → heating-side engineer conclusion, no part', () => {
    const r = run('ecoCold');
    expect(r.rules).toEqual(['H10:hotProgrammeUsed', 'H11:hot-wash-test', 'H12:longCycle', 'H22:heater-element', 'H22:heater-element']);
    expect(r.last.conclusion).toMatchObject({ handoff: 'engineer', noPart: true });
  });
  it('trips when heating / burning → safety stop every turn (fixed copy), never a part', () => {
    expect(run('trips').rules).toEqual(['H10:hotProgrammeUsed', 'H1:supply_trip', 'H1:supply_trip']);
    expect(run('burning').last).toMatchObject({ kind: 'safety_stop', target: 'burning' });
  });
  it('test not done → re-offered once → conclusion (no loop); cannot answer → progresses', () => {
    expect(run('notDone').rules).toEqual(['H11:hot-wash-test', 'H11:hot-wash-test', 'H22:normal-low-temperature']);
    expect(run('notDone').actions[1].action.requestKind).toBe('reoffer');
    expect(run('cannot').rules.slice(-1)[0]).toMatch(/^H22:/);
  });
});

describe('part gate', () => {
  it('heater code + model + heater listed → heater; model unavailable → conclude, no part; no code → never', () => {
    expect(run('heaterCode').rules).toEqual(['H12:longCycle', 'H20:model', 'H21:heater']);
    expect(run('heaterCodeNoModel').last).toMatchObject({ kind: 'conclude', conclusion: { component: 'heater' } });
    expect(run('hotLong').last.kind).toBe('conclude');
  });
  it('heater matcher: heater / wash element, never a dryer heater or sensor', () => {
    const pick = (titles) => J.partLookupFrom(titles.map((title) => ({ title })), 'heater').parts.map((p) => p.title);
    expect(pick(['Heater', '2000W Wash Element', 'Tumble Dryer Heater', 'NTC Temperature Sensor'])).toEqual(['Heater', '2000W Wash Element']);
  });
});

describe('COMPOSE contract', () => {
  it('every action reached obeys the contract; no live electrical testing anywhere', () => {
    const seen = Object.keys(SEQ).flatMap((k) => run(k).actions);
    expect(H.composeProblems(JC, P, seen)).toEqual([]);
    expect(JSON.stringify(JC.TASK)).not.toMatch(/multimeter|continuity|resistance|voltage|ohm/i);
  });
  it('the 60°C test carries the trip / burning stop and the hot-glass caution', () => {
    expect(run('eco').actions[1].action.requires).toEqual(['stop_if_trips_or_burning', 'hot_glass_wait_unlock']);
  });
});

afterEach(() => { delete process.env.CANONICAL_J9_CONTROL; });
describe('routing / gate', () => {
  const { emptyState } = require('../canonical/cs1.js'); const { merge } = require('../canonical/merge.js');
  const T = (cs) => { let s = emptyState('cs_' + 'c'.repeat(32)); for (const c of cs) s = merge(s, c, { turn: s.version + 1 }).state; return { schema: 'cs/1', mode: 'control', sessionId: s.sessionId, priorVersion: s.version - 1, version: s.version, state: s, classification: cs[cs.length - 1], rulesFired: [], requestOutcome: null, degraded: null }; };
  const B = (journeys) => ({ schema: 'cs/1', mode: 'control', control: { journeys }, sessionId: 'x', version: 0, state: null, degraded: null });
  it('own gate key; kill switch; a washer-dryer not heating stays legacy', async () => {
    expect((await L.canonicalJourneys(T([op()]), B(['wm-not-heating']))).journey).toMatchObject({ key: 'wm-not-heating', control: true });
    const wd = await L.canonicalJourneys(T([C({ identity: { appliance: { value: 'washer-dryer', basis: 'stated' } }, problem: { journey: 'no-heat' }, observations: [O('noHeat')] })]), B(['wm-not-heating']));
    expect(L.canonicalControls(wd)).toBe(false);
    process.env.CANONICAL_J9_CONTROL = '0';
    expect((await L.canonicalJourneys(T([op()]), B(['wm-not-heating']))).journey.control).toBe(false);
  });
});
