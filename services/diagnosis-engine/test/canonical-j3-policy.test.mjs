/**
 * Layer C — Journey 3 policy fixtures W01–W30 (evidence doc §6), part gate K1–K6 (§7), multi-turn sequences
 * through the real merge (group targets, re-offer once, correction of location, no loops).
 */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const D = require('../canonical/j3-diagnostics.js');
const P = require('../canonical/j3-policy.js');
const F = require('./j1-state-fixture.cjs');
const { newFact, emptyState } = require('../canonical/cs1.js');
const { merge } = require('../canonical/merge.js');
const mc1 = require('../canonical/mc1.js');
const rq = require('../canonical/requests.js');
const EC = require('../faults-catalogue.json').errorCodes;

const B = () => { const s = F.base(); s.problems[0].journey = newFact('leaking', 'stated', 1); F.delObs(s, 'waterRemaining'); return s; };
const decide = (s, partLookup = null) => P.policy(s, D.diagnose(s, { errorCodes: EC }), { partLookup });
const o = (s, k, v = true, t = 1) => F.obs(s, k, v, t);
const c = (s, k, r, t = 2, st = 'done') => F.check(s, k, st, r, t);
const SEAL = { available: true, component: 'door-seal' };

describe('W01–W30', () => {
  it('W01 opener -> where first (L6)', () => { expect(decide(B())).toMatchObject({ kind: 'ask_observation', target: 'leakLocation', rule: 'L6' }); });
  it('W02 door -> door seal check (machine off, look only)', () => {
    const a = decide(o(B(), 'leakAtDoor'));
    expect(a).toMatchObject({ kind: 'ask_check', target: 'door-seal', rule: 'L8' });
    expect(a.requires).toEqual(['isolate_mains', 'wait_drum_stopped_door_unlocked', 'look_and_feel_only']);
  });
  it('W03 torn seal, model unknown -> model (L16)', () => {
    expect(decide(c(o(B(), 'leakAtDoor'), 'door-seal', 'fault_seen'))).toMatchObject({ kind: 'ask_identity', target: 'model', rule: 'L16' });
  });
  it('W04 torn seal + model + seal listed -> recommend door seal', () => {
    expect(decide(F.model(c(o(B(), 'leakAtDoor'), 'door-seal', 'fault_seen'), 'NSWM1043CW', 'hotpoint'), SEAL)).toMatchObject({ kind: 'recommend_part', target: 'door-seal', rule: 'L17' });
  });
  it('W05 torn seal, model unavailable -> conclude door seal component, no part', () => {
    const s = c(o(B(), 'leakAtDoor'), 'door-seal', 'fault_seen'); s.identity.modelStatus = 'unavailable';
    const a = decide(s, SEAL);
    expect(a).toMatchObject({ kind: 'conclude', target: 'door-seal', rule: 'L18' });
    expect(a.conclusion).toMatchObject({ level: 'component', component: 'door-seal' });
  });
  it('W06 trapped item removed -> leak retest', () => {
    expect(decide(c(o(B(), 'leakAtDoor'), 'door-seal', 'found_and_cleared'))).toMatchObject({ target: 'leak-retest', rule: 'L14', requestKind: 'retest' });
  });
  it('W07 + stays dry -> likely fixed, no part, CONFIRM', () => {
    const a = decide(o(c(o(B(), 'leakAtDoor'), 'door-seal', 'found_and_cleared', 2), 'leakRecurs', false, 3));
    expect(a).toMatchObject({ kind: 'conclude', target: 'door-seal', rule: 'L15' });
    expect(a.conclusion.noPart).toBe(true);
    expect(a.pending).toMatchObject({ purpose: 'CONFIRM' });
  });
  it('W08 drawer overflowing -> drawer check (no location question needed)', () => {
    expect(decide(o(B(), 'drawerOverflowing'))).toMatchObject({ target: 'detergent-drawer', rule: 'L9' });
  });
  it('W09 drawer cleaned but still overflows -> dose check', () => {
    const s = o(c(o(o(B(), 'leakAtDrawer'), 'drawerOverflowing'), 'detergent-drawer', 'found_and_cleared', 2), 'leakRecurs', true, 3);
    expect(decide(s)).toMatchObject({ target: 'detergent-dose', rule: 'L10' });
  });
  it('W10 foam + drawer -> drawer first, then dose', () => {
    const s = o(o(B(), 'leakAtDrawer'), 'excessiveFoam');
    expect(decide(s)).toMatchObject({ target: 'detergent-drawer', rule: 'L9' });
    expect(decide(c(s, 'detergent-drawer', 'clear'))).toMatchObject({ target: 'detergent-dose', rule: 'L10' });
  });
  it('W11 rear, timing unknown -> when (L7)', () => { expect(decide(o(B(), 'leakAtRear'))).toMatchObject({ target: 'leakTiming', rule: 'L7' }); });
  it('W12 rear while filling -> inlet connection (water off at the tap, hand-tight)', () => {
    const a = decide(o(o(B(), 'leakAtRear'), 'leaksOnFill'));
    expect(a).toMatchObject({ target: 'inlet-connection', rule: 'L12' });
    expect(a.requires).toEqual(expect.arrayContaining(['water_off_at_tap', 'hand_tight_only']));
  });
  it('W13 rear while draining -> drain connection', () => { expect(decide(o(o(B(), 'leakAtRear'), 'leaksOnDrain'))).toMatchObject({ target: 'drain-connection', rule: 'L13' }); });
  it('W14 waste backs up -> plumber, no machine part', () => {
    const a = decide(o(o(B(), 'waterReturnsAfterDrain'), 'leaksOnDrain'));
    expect(a).toMatchObject({ kind: 'conclude', target: 'household-backflow', rule: 'L5' });
    expect(a.conclusion).toMatchObject({ handoff: 'plumbing', noPart: true });
  });
  it('W15 filter-area leak after cleaning -> filter cap seating first (not the pump)', () => {
    expect(decide(o(o(B(), 'leakAtFilter'), 'recentFilterAccess'))).toMatchObject({ target: 'filter-seal', rule: 'L11' });
  });
  it('W16 underneath, timing unknown -> when', () => { expect(decide(o(B(), 'leakUnderneath'))).toMatchObject({ target: 'leakTiming', rule: 'L7' }); });
  it('W17 underneath on drain -> filter cap first', () => { expect(decide(o(o(B(), 'leakUnderneath'), 'leaksOnDrain'))).toMatchObject({ target: 'filter-seal', rule: 'L11' }); });
  it('W18 + filter fine -> drain connection', () => {
    expect(decide(c(o(o(B(), 'leakUnderneath'), 'leaksOnDrain'), 'filter-seal', 'clear'))).toMatchObject({ target: 'drain-connection', rule: 'L13' });
  });
  it('W19 + drain hose fine -> conclude internal (pump body / hose) possible, engineer, no part, no model ask', () => {
    const a = decide(c(c(o(o(B(), 'leakUnderneath'), 'leaksOnDrain'), 'filter-seal', 'clear', 2), 'drain-connection', 'clear', 3));
    expect(a).toMatchObject({ kind: 'conclude', rule: 'L18' });
    expect(['pump-body', 'internal-hose']).toContain(a.target);
    expect(a.conclusion).toMatchObject({ confidence: 'possible', handoff: 'engineer', noPart: true });
  });
  it('W20 leaks when off, location known at rear -> inlet connection', () => {
    expect(decide(o(o(B(), 'leaksWhenOff'), 'leakAtRear'))).toMatchObject({ target: 'inlet-connection', rule: 'L12' });
  });
  it('W21 large leak reported now -> contain first (safety_stop major-leak); next turn continues', () => {
    const s = o(o(B(), 'leakUnderneath'), 'majorLeak', true, 1);
    expect(decide(s)).toMatchObject({ kind: 'safety_stop', target: 'major-leak', rule: 'L1' });
    s.version = 2;
    expect(decide(s).kind).not.toBe('safety_stop');
  });
  it('W21b (live c03) a restated large leak does not stop again (containment once)', () => {
    const s = o(o(B(), 'leakAtDrawer'), 'majorLeak', true, 1);
    s.evidence.observations.majorLeak.lastTurn = 3; s.version = 3;
    expect(decide(s).kind).not.toBe('safety_stop');
  });
  it('W21c (live c02) an owner fix is retested before narrowing timing', () => {
    expect(decide(c(o(B(), 'leakUnderneath'), 'door-seal', 'found_and_cleared'))).toMatchObject({ target: 'leak-retest', rule: 'L14' });
  });
  it('W22 water at the socket -> safety stop (sticky)', () => {
    expect(decide(F.hazard(o(B(), 'leakUnderneath'), 'electrical_water'))).toMatchObject({ kind: 'safety_stop', target: 'electrical_water' });
    expect(decide(F.hazard(o(B(), 'leakUnderneath'), 'electrical_water', 'corrected')).kind).toBe('safety_stop');
  });
  it('W23 cannot say where -> ask when instead (no stall)', () => {
    const s = B(); F.request(s, 'leakLocation', 'ask', 'cannot_answer', 1, 'OBSERVATION');
    expect(decide(s)).toMatchObject({ target: 'leakTiming', rule: 'L7' });
  });
  it('W24 seal check not done -> one re-offer, then conclude (no loop)', () => {
    const s = c(o(B(), 'leakAtDoor'), 'door-seal', null, 2, 'not_done'); F.request(s, 'door-seal', 'ask', 'not_done', 1);
    expect(decide(s)).toMatchObject({ target: 'door-seal', requestKind: 'reoffer' });
    F.request(s, 'door-seal', 'reoffer', 'not_done', 2);
    expect(decide(s)).toMatchObject({ kind: 'conclude', rule: 'L18' });
  });
  it('W25 inlet tightened but still leaks on fill -> internal fill side, engineer', () => {
    const a = decide(o(c(o(o(B(), 'leakAtRear'), 'leaksOnFill'), 'inlet-connection', 'found_and_cleared', 2), 'leakRecurs', true, 3));
    expect(a).toMatchObject({ kind: 'conclude', target: 'inlet-valve-or-fill' });
    expect(a.conclusion.handoff).toBe('engineer');
  });
  it('W26 make only + torn seal -> no part', () => {
    const s = F.make(c(o(B(), 'leakAtDoor'), 'door-seal', 'fault_seen'), 'hotpoint');
    expect(P.partGate(s, D.diagnose(s), SEAL).failed).toContain('K1-model-not-known');
  });
  it('W27 split fill hose + model + hose listed -> recommend inlet hose', () => {
    const s = F.model(c(o(o(B(), 'leakAtRear'), 'leaksOnFill'), 'inlet-connection', 'fault_seen'), 'X1', 'beko');
    expect(decide(s, { available: true, component: 'inlet-hose' })).toMatchObject({ kind: 'recommend_part', target: 'inlet-hose' });
  });
  it('W28 resolved -> close', () => {
    const s = o(c(o(B(), 'leakAtDoor'), 'door-seal', 'found_and_cleared', 2), 'leakRecurs', false, 3); s.resolution = 'resolved'; s.problems[0].status = 'resolved';
    expect(decide(s)).toMatchObject({ kind: 'close_resolved', target: 'door-seal', rule: 'L2' });
  });
  it('W29 recently installed, rear -> when first', () => { expect(decide(o(o(B(), 'leakAtRear'), 'recentInstallation'))).toMatchObject({ target: 'leakTiming' }); });
  it('W30 vague underside leak never yields a part', () => {
    const s = F.model(o(o(B(), 'leakUnderneath'), 'leaksOnWash'), 'NSWM1043CW', 'hotpoint');
    const a = decide(s, { available: true, component: 'drain-hose' });
    expect(a.kind).not.toBe('recommend_part');
  });
});

describe('part gate K1–K6', () => {
  const torn = () => F.model(c(o(B(), 'leakAtDoor'), 'door-seal', 'fault_seen'), 'NSWM1043CW', 'hotpoint');
  const gate = (s, pl) => P.partGate(s, D.diagnose(s), pl);
  it('passes for a torn seal with a confirmed model and a listed seal', () => { expect(gate(torn(), SEAL)).toEqual({ eligible: true, component: 'door-seal', failed: [] }); });
  it('K5 no compatible part / K6 safety / K2 resolved / K4 backflow', () => {
    expect(gate(torn(), { available: false }).failed).toContain('K5-no-compatible-part');
    expect(gate(F.hazard(torn(), 'electrical_water'), SEAL).failed).toContain('K6-active-safety');
    const r = torn(); r.resolution = 'resolved'; expect(gate(r, SEAL).failed).toContain('K2-resolved-or-likely');
    const b = F.model(c(o(o(B(), 'waterReturnsAfterDrain'), 'leaksOnDrain'), 'drain-connection', 'fault_seen'), 'X', 'beko');
    expect(gate(b, { available: true, component: 'drain-hose' }).failed).toContain('K4-evidence-insufficient');
  });
  it('a trapped item (no damage) never yields a seal part', () => {
    const s = F.model(c(o(B(), 'leakAtDoor'), 'door-seal', 'found_and_cleared'), 'NSWM1043CW', 'hotpoint');
    expect(gate(s, SEAL).eligible).toBe(false);
  });
});

const C = (f = {}) => mc1.validateClassification({ scope: 'appliance', ...f });
const WM = { identity: { appliance: { value: 'washing-machine', basis: 'stated' } }, problem: { journey: 'leaking', faultDomain: 'water' } };
function play(cs) {
  let s = emptyState('cs_t'); const rules = [];
  for (const m of cs) {
    s = merge(s, m, { turn: s.version + 1 }).state;
    const a = decide(s);
    rules.push(`${a.rule}:${a.target}`);
    if (a.pending) s = rq.issueRequest(s, { ...a.pending, kind: a.requestKind || undefined, journey: a.journey, rule: a.rule }, s.version).state;
  }
  return { s, rules };
}
describe('sequences', () => {
  it('opener -> sparse "from the front" binds to the location request -> seal -> item removed -> dry -> confirmed', () => {
    const { s, rules } = play([
      C({ ...WM }),
      C({ observations: [{ key: 'leakAtDoor', value: true }], reply: { toPending: 'answered' } }),
      C({ checks: [{ check: 'door-seal', status: 'done', result: 'found_and_cleared' }] }),
      C({ observations: [{ key: 'leakRecurs', value: false }] }),
      C({ reply: { toPending: 'answered', outcome: 'resolved' } }),
    ]);
    expect(rules).toEqual(['L6:leakLocation', 'L8:door-seal', 'L14:leak-retest', 'L15:door-seal', 'L2:door-seal']);
    expect(s.requests.find((r) => r.target === 'leakLocation').outcome).toBe('answered');
  });
  it('location correction: door -> "actually it is at the back" supersedes the door location', () => {
    const { s, rules } = play([
      C({ ...WM, observations: [{ key: 'leakAtDoor', value: true }] }),
      C({ observations: [{ key: 'leakAtRear', value: true }], reply: { correction: ['observations.leakAtDoor'] } }),
    ]);
    expect(s.evidence.observations.leakAtDoor.value).toBe(false);
    expect(rules).toEqual(['L8:door-seal', 'L7:leakTiming']);
  });
  it('all-ignored session: no target asked more than twice; ends in a conclusion', () => {
    const cs = [C({ ...WM })]; for (let i = 0; i < 10; i += 1) cs.push(C({ reply: { toPending: 'ignored' } }));
    const { s, rules } = play(cs);
    const n = {}; for (const r of s.requests) if (r.kind !== 'retest') n[r.target] = (n[r.target] || 0) + 1;
    for (const v of Object.values(n)) expect(v).toBeLessThanOrEqual(2);
    expect(rules[rules.length - 1]).toMatch(/^L18:/);
  });
});
