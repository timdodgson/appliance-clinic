/** Dishwasher journey 1 (dw-not-draining): diagnostics, policy, part gate, COMPOSE contract, routing / gate. */
import { describe, it, expect, afterEach } from 'vitest';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
globalThis.awslambda = globalThis.awslambda || { streamifyResponse: (f) => f, HttpResponseStream: { from: (s) => s } };
const H = require('./helpers/b2-journey.cjs');
const J = require('../canonical/dw1-not-draining.js');
const L = require('../part-finder-lambda.js')._internal;
const { C, O, K } = H;

const op = (obs = [], id = {}) => H.dwOpener('not-draining', 'water', [O('waterRemaining'), ...obs], {}, id);
const MP = [{ title: 'Askoll Drain Pump' }, { title: 'Dishwasher Central Filter' }];
const m = () => H.model('DIF16B1', 'indesit');
const clearPath = [C({ checks: [K('dishwasher-filter', 'done', 'clear')] }), C({ checks: [K('pump-impeller', 'done', 'clear')] }), C({ checks: [K('drain-hose', 'done', 'clear')] }),
  C({ checks: [K('waste-spigot', 'done', 'clear')] }), C({ observations: [O('commandedDrain', false)] })];
const SEQ = {
  filter: [op(), C({ checks: [K('dishwasher-filter', 'done', 'found_and_cleared')] }), C({ observations: [O('faultPersists', false)] }), C({ reply: { toPending: 'answered', outcome: 'resolved' } })],
  glass: [op(), C({ checks: [K('dishwasher-filter', 'done', 'clear')] }), C({ checks: [K('pump-impeller', 'done', 'found_and_cleared')] }), C({ observations: [O('faultPersists', false)] })],
  impellerBroken: [op(), C({ checks: [K('dishwasher-filter', 'done', 'clear')] }), C({ checks: [K('pump-impeller', 'done', 'fault_seen')] }), m()],
  hose: [op(), C({ checks: [K('dishwasher-filter', 'done', 'clear')] }), C({ checks: [K('pump-impeller', 'done', 'clear')] }), C({ checks: [K('drain-hose', 'done', 'found_and_cleared')] }), C({ observations: [O('faultPersists', false)] })],
  backflow: [op([O('waterReturnsAfterDrain')])],
  spigot: [op([O('recentInstallation')]), C({ checks: [K('dishwasher-filter', 'done', 'clear')] }), C({ checks: [K('pump-impeller', 'done', 'clear')] }), C({ checks: [K('drain-hose', 'done', 'clear')] }),
    C({ checks: [K('waste-spigot', 'done', 'found_and_cleared')] }), C({ observations: [O('faultPersists', false)] })],
  pumpHum: [op(), ...clearPath, C({ observations: [O('pumpHumming')] }), m()],
  pumpHumNoModel: [op(), ...clearPath, C({ observations: [O('pumpHumming')] }), H.noModel()],
  silent: [op(), ...clearPath, C({ observations: [O('pumpHumming', false)] }), m()],
  safety: [op(), C({ safety: { hazard: 'electrical_water' } }), C({})],
  cannot: [op(), C({ checks: [K('dishwasher-filter', 'unable')] }), C({ reply: { toPending: 'cannot_answer' } }), C({ reply: { toPending: 'cannot_answer' } })],
  flood: [op([O('waterInBase')])],
};
const run = (k) => H.play(J, SEQ[k], { modelParts: MP });

describe('diagnostics', () => {
  it('blocked filter / glass at the pump / kinked hose / blanking plug are no-part families (likely fixed after retest)', () => {
    expect(run('filter').actions[2].prep.diag).toMatchObject({ likelyResolved: true, leader: { family: 'filter-or-sump-blockage' } });
    expect(run('glass').prep.diag).toMatchObject({ likelyResolved: true, leader: { family: 'pump-obstruction' } });
    expect(run('hose').prep.diag.leader.family).toBe('drain-hose-restriction');
    expect(run('spigot').prep.diag.leader.family).toBe('household-waste-or-spigot');
  });
  it('pump: humming + whole accessible path clear + no pump-out → component; silent pump → control area, never the pump', () => {
    expect(run('pumpHum').prep.diag.leader).toMatchObject({ family: 'drain-pump', component: 'drain-pump' });
    const d = run('silent').prep.diag;
    expect(d.leader.family).toBe('level-or-control');
    expect(d.partEvidence.sufficient).toBe(false);
  });
});
describe('policy', () => {
  it('filter → retest → likely fixed + CONFIRM → close', () => { expect(run('filter').rules).toEqual(['A11:dishwasher-filter', 'A6:retest', 'A7:filter-or-sump-blockage', 'A2:filter-or-sump-blockage']); });
  it('filter clear → pump cover (glass) → retest → likely fixed; carries gloves', () => {
    const r = run('glass');
    expect(r.rules).toEqual(['A11:dishwasher-filter', 'A12:pump-impeller', 'A6:retest', 'A7:pump-obstruction']);
    expect(r.actions[1].action.requires).toContain('gloves_for_glass');
  });
  it('sink backs up → household waste, plumbing, no part', () => {
    expect(run('backflow').last).toMatchObject({ rule: 'A5', target: 'household-waste-or-spigot', conclusion: { handoff: 'plumbing', noPart: true } });
  });
  it('safe checks precede the pump: filter → pump cover → hose → sink waste → drain test → hum → model → pump', () => {
    expect(run('pumpHum').rules).toEqual(['A11:dishwasher-filter', 'A12:pump-impeller', 'A13:drain-hose', 'A14:waste-spigot', 'A15:drain-command', 'A16:pumpHumming', 'A20:model', 'A21:drain-pump']);
  });
  it('new sink waste spigot → blanking plug cleared → likely fixed (no part)', () => { expect(run('spigot').last).toMatchObject({ rule: 'A7', conclusion: { noPart: true } }); });
  it('safety stop; unable / cannot answer progresses to a conclusion (no loop)', () => {
    expect(run('safety').last).toMatchObject({ kind: 'safety_stop', rule: 'A1' });
    expect(run('cannot').rules.slice(-1)[0]).toMatch(/^A22:/);
  });
  it('water in the base → dw-leaking owns it (this journey does not apply)', () => { expect(run('flood').prep.entry).toMatchObject({ applies: false, drainOwned: true }); });
});
describe('part gate', () => {
  it('broken impeller + model + pump listed → drain pump; model unavailable → conclude, no part; silent never', () => {
    expect(run('impellerBroken').rules).toEqual(['A11:dishwasher-filter', 'A12:pump-impeller', 'A20:model', 'A21:drain-pump']);
    expect(run('pumpHumNoModel').last).toMatchObject({ kind: 'conclude', conclusion: { component: 'drain-pump' } });
    expect(run('silent').last.kind).toBe('conclude');
    expect(J.partLookupFrom(MP, 'drain-pump').parts.map((p) => p.title)).toEqual(['Askoll Drain Pump']);
  });
});
describe('COMPOSE contract', () => {
  it('every action reached obeys the contract; fact line says dishwasher', () => {
    const seen = Object.keys(SEQ).flatMap((k) => run(k).actions);
    expect(H.composeProblems(J, J.P, seen)).toEqual([]);
    const a = seen[0]; expect(J.brief(a.state, a.action, null, {}).facts[0]).toBe('Appliance: dishwasher');
  });
});
afterEach(() => { delete process.env.CANONICAL_DW1_CONTROL; });
describe('routing / gate', () => {
  it('own gate; washing-machine not-draining stays Journey 1; kill switch', async () => {
    expect((await H.routeWith(L, [op()], ['dw-not-draining'])).journey).toMatchObject({ key: 'dw-not-draining', control: true, nextAction: { rule: 'A11' } });
    expect((await H.routeWith(L, [op()], ['wm-not-draining'])).journey).toMatchObject({ key: 'dw-not-draining', control: false });
    const wm = await H.routeWith(L, [H.opener('not-draining', 'water', [O('waterRemaining')])], ['wm-not-draining', 'dw-not-draining']);
    expect(wm.journey.key).toBe('wm-not-draining');
    process.env.CANONICAL_DW1_CONTROL = '0';
    expect((await H.routeWith(L, [op()], ['dw-not-draining'])).journey.control).toBe(false);
  });
});
