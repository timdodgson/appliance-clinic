/**
 * Layer C — Journey 1 policy fixtures J01–J29 (journey doc §16) + part gate P1–P7 (§14).
 * `inferred` is NOT hand-set: it is computed by j1-diagnostics from the same state.
 */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const D = require('../canonical/j1-diagnostics.js');
const P = require('../canonical/j1-policy.js');
const F = require('./j1-state-fixture.cjs');
const EC = require('../faults-catalogue.json').errorCodes;

const decide = (s, partLookup = null) => {
  const diag = D.diagnose(s, { codeArea: D.codeAreaFor(s, EC) });
  return P.policy(s, diag, { partLookup });
};
const J06 = () => F.check(F.base(), 'drain-filter', 'done', 'clear', 2);
const J07 = () => F.check(F.base(), 'drain-filter', 'done', 'found_and_cleared', 2);
const J12 = () => F.obs(F.obs(J06(), 'commandedDrain', true, 3), 'pumpHumming', true, 3);
const J15 = () => F.check(F.obs(F.obs(J06(), 'commandedDrain', false, 3), 'pumpHumming', true, 3), 'pump-impeller', 'done', 'clear', 4);
const J17 = () => F.check(J15(), 'drain-hose', 'done', 'clear', 5);
const J18 = () => F.model(J17(), 'WAN28281GB', 'bosch');
const J21 = () => F.hazard(F.base(), 'electrical_water');
const J23 = () => F.obs(F.base(), 'excessiveFoam', true, 1);
const AVAILABLE = { available: true, component: 'drain-pump' };
const FILTER_REQ = ['isolate_mains', 'let_hot_water_cool', 'contain_water', 'open_slowly', 'do_not_force'];

describe('J01–J29 (journey doc §16)', () => {
  it('J01 opener -> ask drain-filter R7 with containment requires', () => {
    const a = decide(F.base());
    expect(a).toMatchObject({ kind: 'ask_check', target: 'drain-filter', rule: 'R7', reason: 'first-safe-high-value-check', requestKind: 'ask' });
    expect(a.requires).toEqual(FILTER_REQ);
    expect(a.pending).toEqual({ slot: 'CHECK', target: 'drain-filter', purpose: 'DIAGNOSIS' });
  });
  it('J02 model volunteered -> still filter first', () => {
    expect(decide(F.model(F.base(), 'WMUD962P', 'hotpoint'))).toMatchObject({ kind: 'ask_check', target: 'drain-filter', rule: 'R7' });
  });
  it('J03 error-code entry (Hotpoint F05) -> filter', () => {
    const s = F.code(F.make(F.journey(F.delObs(F.base(), 'waterRemaining'), 'error-code-only'), 'hotpoint'), 'F05');
    expect(P.entry(s, D.diagnose(s, { codeArea: D.codeAreaFor(s, EC) })).applies).toBe(true);
    expect(decide(s)).toMatchObject({ kind: 'ask_check', target: 'drain-filter', rule: 'R7' });
  });
  it('J04 appliance unknown -> ask appliance R4', () => {
    const s = F.base(); s.identity.appliance = { value: null, basis: null, turn: null, status: 'active', history: [] }; s.identity.applianceEstablishment = 'unknown';
    expect(decide(s)).toMatchObject({ kind: 'ask_identity', target: 'appliance', rule: 'R4' });
  });
  it('J05 won\'t spin, water unknown -> ask waterRemaining R5', () => {
    const s = F.delObs(F.journey(F.base(), 'not-spinning'), 'waterRemaining');
    expect(decide(s)).toMatchObject({ kind: 'ask_observation', target: 'waterRemaining', rule: 'R5' });
  });
  it('J06 filter clear -> drain-command R8 (commanded-drain-informs)', () => {
    const a = decide(J06());
    expect(a).toMatchObject({ kind: 'ask_check', target: 'drain-command', rule: 'R8', reason: 'commanded-drain-informs-pump-and-path', requestKind: 'ask' });
    expect(a.requires).toEqual(['keep_clear_of_socket_if_water_near', 'door_stays_locked_until_empty']);
  });
  it('J07 cleared, not yet tested -> drain-command R8 retest', () => {
    expect(decide(J07())).toMatchObject({ kind: 'ask_check', target: 'drain-command', rule: 'R8', reason: 'retest-after-clearance', requestKind: 'retest' });
  });
  it('J08 cleared + resolved -> close_resolved filter-blockage R2', () => {
    const s = J07(); s.resolution = 'resolved'; s.problems[0].status = 'resolved';
    expect(decide(s)).toMatchObject({ kind: 'close_resolved', target: 'filter-blockage', rule: 'R2' });
  });
  it('J09 cleared, then drain works -> conclude filter-blockage likely none R9 + CONFIRM pending', () => {
    const a = decide(F.obs(J07(), 'commandedDrain', true, 3));
    expect(a).toMatchObject({ kind: 'conclude', target: 'filter-blockage', rule: 'R9' });
    expect(a.conclusion).toMatchObject({ cause: 'filter-blockage', level: 'cause_family', confidence: 'likely', handoff: 'none' });
    expect(a.pending).toEqual({ slot: 'OBSERVATION', target: 'resolution', purpose: 'CONFIRM' });
  });
  it('J10 cleared but still faulty, hums -> pump-impeller R11', () => {
    expect(decide(F.obs(F.obs(J07(), 'commandedDrain', false, 3), 'pumpHumming', true, 3))).toMatchObject({ kind: 'ask_check', target: 'pump-impeller', rule: 'R11' });
  });
  it('J11 cannot access filter -> drain-command R8', () => {
    expect(decide(F.check(F.base(), 'drain-filter', 'unable', null, 2))).toMatchObject({ kind: 'ask_check', target: 'drain-command', rule: 'R8' });
  });
  it('J12 drains on command, not in programme -> ask model R13', () => {
    expect(decide(J12())).toMatchObject({ kind: 'ask_identity', target: 'model', rule: 'R13', reason: 'model-required-for-remaining-causes' });
  });
  it('J13 as J12, model unavailable -> conclude pressure-or-level cause_family likely engineer R15', () => {
    const s = J12(); s.identity.modelStatus = 'unavailable';
    const a = decide(s);
    expect(a).toMatchObject({ kind: 'conclude', target: 'pressure-or-level', rule: 'R15' });
    expect(a.conclusion).toMatchObject({ level: 'cause_family', confidence: 'likely', handoff: 'engineer' });
  });
  it('J14 commanded drain fails, sound unknown -> pumpHumming R10', () => {
    expect(decide(F.obs(J06(), 'commandedDrain', false, 3))).toMatchObject({ kind: 'ask_observation', target: 'pumpHumming', rule: 'R10' });
  });
  it('J15 hums, impeller clear, hose unchecked -> drain-hose R12', () => {
    const a = decide(J15());
    expect(a).toMatchObject({ kind: 'ask_check', target: 'drain-hose', rule: 'R12' });
    expect(a.requires).toEqual(['isolate_mains', 'machine_heavy_may_hold_water', 'contain_water', 'do_not_disconnect_under_load']);
  });
  it('J16 impeller jammed -> conclude obstruction-beyond-reach engineer R6', () => {
    const a = decide(F.check(J06(), 'pump-impeller', 'done', 'found_not_cleared', 3));
    expect(a).toMatchObject({ kind: 'conclude', target: 'obstruction-beyond-reach', rule: 'R6' });
    expect(a.conclusion.handoff).toBe('engineer');
  });
  it('J17 path exhausted, model missing -> ask model R13', () => {
    expect(decide(J17())).toMatchObject({ kind: 'ask_identity', target: 'model', rule: 'R13' });
  });
  it('J18 part justified -> recommend_part drain-pump R14', () => {
    expect(decide(J18(), AVAILABLE)).toMatchObject({ kind: 'recommend_part', target: 'drain-pump', rule: 'R14', reason: 'part-gate-met' });
  });
  it('J19 no compatible part -> conclude drain-pump component likely engineer R15', () => {
    const a = decide(J18(), { available: false, component: 'drain-pump' });
    expect(a).toMatchObject({ kind: 'conclude', target: 'drain-pump', rule: 'R15' });
    expect(a.conclusion).toMatchObject({ level: 'component', confidence: 'likely', handoff: 'engineer' });
  });
  it('J20 pump silent, impeller clear -> ask model R13 (hose not worth asking)', () => {
    const s = F.check(F.obs(F.obs(J06(), 'commandedDrain', false, 3), 'pumpHumming', false, 3), 'pump-impeller', 'done', 'clear', 4);
    expect(decide(s)).toMatchObject({ kind: 'ask_identity', target: 'model', rule: 'R13' });
  });
  it('J21 water at socket -> safety_stop electrical_water R1', () => {
    expect(decide(J21())).toMatchObject({ kind: 'safety_stop', target: 'electrical_water', rule: 'R1' });
  });
  it('J22 sticky after correction -> still safety_stop R1', () => {
    const s = F.hazard(F.base(), 'electrical_water', 'corrected');
    expect(s.safety.activeLevel).toBe('NORMAL_DIAGNOSTIC');
    expect(decide(s)).toMatchObject({ kind: 'safety_stop', target: 'electrical_water', rule: 'R1' });
  });
  it('J23 excess foam, water retained -> filter R7 (no exit)', () => {
    expect(decide(J23())).toMatchObject({ kind: 'ask_check', target: 'drain-filter', rule: 'R7' });
  });
  it('J24 filter not done after a re-offer -> drain-command R8 (no third filter request)', () => {
    const s = F.check(F.base(), 'drain-filter', 'not_done', null, 3);
    F.request(s, 'drain-filter', 'ask', 'not_done', 1); F.request(s, 'drain-filter', 'reoffer', 'not_done', 2);
    expect(decide(s)).toMatchObject({ kind: 'ask_check', target: 'drain-command', rule: 'R8' });
  });
  it('J25 cannot or will not do anything -> conclude filter-blockage possible engineer R15', () => {
    const s = F.check(F.base(), 'drain-filter', 'declined', null, 2);
    F.check(s, 'drain-command', 'declined', null, 3); F.declined(s, 'pumpHumming', 'declined', 4);
    F.check(s, 'drain-hose', 'unable', null, 5); s.identity.modelStatus = 'unavailable';
    const a = decide(s);
    expect(a).toMatchObject({ kind: 'conclude', target: 'filter-blockage', rule: 'R15' });
    expect(a.conclusion).toMatchObject({ level: 'cause_family', confidence: 'possible', handoff: 'engineer' });
  });
  it('J26 water returns -> conclude household-waste-backflow plumbing R6a', () => {
    const a = decide(F.obs(F.base(), 'waterReturnsAfterDrain', true, 1));
    expect(a).toMatchObject({ kind: 'conclude', target: 'household-waste-backflow', rule: 'R6a' });
    expect(a.conclusion).toMatchObject({ level: 'cause_family', confidence: 'likely', handoff: 'plumbing' });
  });
  it('J27 foam, rinse/spin then drains -> conclude excess-suds none R9a + CONFIRM', () => {
    const a = decide(F.obs(F.check(J23(), 'drain-filter', 'done', 'clear', 2), 'commandedDrain', true, 3));
    expect(a).toMatchObject({ kind: 'conclude', target: 'excess-suds', rule: 'R9a' });
    expect(a.conclusion.handoff).toBe('none');
    expect(a.pending).toMatchObject({ purpose: 'CONFIRM' });
  });
  it('J28 not done once -> filter re-offer R7', () => {
    const s = F.check(F.base(), 'drain-filter', 'not_done', null, 2); F.request(s, 'drain-filter', 'ask', 'not_done', 1);
    expect(decide(s)).toMatchObject({ kind: 'ask_check', target: 'drain-filter', rule: 'R7', requestKind: 'reoffer' });
  });
  it('J29 clearance then retest due -> drain-command retest R8', () => {
    const s = J07(); F.request(s, 'drain-filter', 'ask', 'answered', 1);
    expect(decide(s)).toMatchObject({ kind: 'ask_check', target: 'drain-command', rule: 'R8', requestKind: 'retest' });
  });
});

describe('part gate P1–P7 (§14) + never-sufficient-alone', () => {
  const gate = (s, pl = AVAILABLE) => P.partGate(s, D.diagnose(s, { codeArea: D.codeAreaFor(s, EC) }), pl);
  it('J18 state passes every condition', () => {
    expect(gate(J18())).toEqual({ eligible: true, component: 'drain-pump', failed: [] });
  });
  it('P1 make only (no model) -> no part', () => {
    const s = F.make(J17(), 'bosch');
    expect(gate(s).failed).toContain('P1-model-not-known');
    expect(decide(s, AVAILABLE).kind).not.toBe('recommend_part');
  });
  it('P1 unconfirmed image-read model -> no part', () => {
    const s = J18(); s.identity.model.confirmed = false;
    expect(gate(s).failed).toContain('P1-model-not-known');
  });
  it('model unavailable -> no part, conclude at component level (L2)', () => {
    const s = J17(); s.identity.modelStatus = 'unavailable';
    const a = decide(s, AVAILABLE);
    expect(a).toMatchObject({ kind: 'conclude', target: 'drain-pump', rule: 'R15' });
  });
  it('P2 resolved / likely resolved -> no part', () => {
    const s = J18(); s.resolution = 'resolved';
    expect(gate(s).failed).toContain('P2-resolved-or-likely');
  });
  it('P3 hums + hose unchecked -> no part', () => {
    const s = F.model(J15(), 'WAN28281GB', 'bosch');
    expect(gate(s).failed).toContain('P3-accessible-path-not-settled');
  });
  it('A1: pump hums + hose unreachable -> no pump part; conclude with hose live', () => {
    const s = F.model(F.check(J15(), 'drain-hose', 'unable', null, 5), 'WAN28281GB', 'bosch');
    const g = gate(s);
    expect(g.eligible).toBe(false);
    expect(g.failed).toContain('P5-evidence-insufficient');
    const a = decide(s, AVAILABLE);
    expect(a).toMatchObject({ kind: 'conclude', target: 'drain-pump', rule: 'R15' });
    expect(a.conclusion).toMatchObject({ level: 'cause_family', confidence: 'possible', handoff: 'engineer' });
    expect(a.conclusion.alternatives).toContain('hose-or-waste-restriction');
  });
  it('silent pump with path clear -> no part; pump OR control', () => {
    const s = F.model(F.check(F.obs(F.obs(J06(), 'commandedDrain', false, 3), 'pumpHumming', false, 3), 'pump-impeller', 'done', 'clear', 4), 'WAN28281GB', 'bosch');
    expect(gate(s).eligible).toBe(false);
    const a = decide(s, AVAILABLE);
    expect(a).toMatchObject({ kind: 'conclude', target: 'drain-pump', rule: 'R15' });
    expect(a.conclusion.level).toBe('cause_family');
    expect(a.conclusion.alternatives).toContain('control');
  });
  it('error code alone (F11) never justifies a part and never skips the filter', () => {
    const s = F.model(F.code(F.base(), 'F11'), 'WMUD962P', 'hotpoint');
    expect(gate(s).eligible).toBe(false);
    expect(decide(s, AVAILABLE)).toMatchObject({ kind: 'ask_check', target: 'drain-filter', rule: 'R7' });
  });
  it('P6 no compatible part -> no recommendation', () => {
    expect(gate(J18(), { available: false }).failed).toContain('P6-no-compatible-part');
    expect(gate(J18(), null).failed).toContain('P6-no-compatible-part');
  });
  it('P7 active safety -> R1 wins, gate also fails', () => {
    const s = F.hazard(J18(), 'electrical_water');
    expect(gate(s).failed).toContain('P7-active-safety');
    expect(decide(s, AVAILABLE).kind).toBe('safety_stop');
  });
  it('impeller visibly damaged with hose unreachable -> part via decisive impellerDamaged (D23)', () => {
    const s = F.check(F.obs(F.obs(J06(), 'commandedDrain', false, 3), 'pumpHumming', true, 3), 'pump-impeller', 'done', 'fault_seen', 4);
    F.check(s, 'drain-hose', 'unable', null, 5); F.model(s, 'WAN28281GB', 'bosch');
    expect(decide(s, AVAILABLE)).toMatchObject({ kind: 'recommend_part', target: 'drain-pump', rule: 'R14' });
  });
});

describe('regressions: requests, loops, determinism', () => {
  it('never asks the same target a third time; declined/unable/cannot_answer never re-asked', () => {
    for (const out of ['declined', 'unable', 'cannot_answer']) {
      const s = F.base(); F.request(s, 'drain-filter', 'ask', out, 1);
      expect(decide(s).target).not.toBe('drain-filter');
    }
  });
  it('model asked at most twice; pending_lookup allows one re-ask', () => {
    const s = J17(); F.request(s, 'model', 'ask', 'answered', 5, 'IDENTITY'); s.identity.modelStatus = 'pending_lookup';
    expect(decide(s)).toMatchObject({ kind: 'ask_identity', target: 'model', requestKind: 'reoffer' });
    F.request(s, 'model', 'reoffer', 'ignored', 6, 'IDENTITY');
    expect(decide(s).kind).toBe('conclude');
  });
  it('retest happens once per clearance; a not-done retest is re-offered once then moves on', () => {
    const s = J07(); F.request(s, 'drain-command', 'retest', 'not_done', 2);
    expect(decide(s)).toMatchObject({ target: 'drain-command', requestKind: 'reoffer' });
    F.request(s, 'drain-command', 'reoffer', 'not_done', 3);
    expect(decide(s).target).not.toBe('drain-command');
  });
  it('cleared + "drains fine now" (drainsNormally) -> R9 likely fixed, no retest ask', () => {
    expect(decide(F.obs(J07(), 'drainsNormally', true, 3))).toMatchObject({ kind: 'conclude', rule: 'R9', target: 'filter-blockage' });
  });
  it('R9 CONFIRM pending is offered at most twice; then concludes without a pending request', () => {
    const s = F.obs(J07(), 'commandedDrain', true, 3);
    F.request(s, 'resolution', 'ask', 'ignored', 3, 'OBSERVATION');
    expect(decide(s).pending).toMatchObject({ purpose: 'CONFIRM' });
    F.request(s, 'resolution', 'reoffer', 'ignored', 4, 'OBSERVATION');
    const a = decide(s);
    expect(a.rule).toBe('R9'); expect(a.pending).toBe(null);
  });
  it('every NextAction carries the contract fields; byte-stable for the same state', () => {
    for (const s of [F.base(), J06(), J07(), J12(), J17(), J18(), J21()]) {
      const a = decide(s, AVAILABLE);
      for (const k of ['kind', 'target', 'reason', 'requires', 'expects', 'pending', 'conclusion', 'journey', 'rule']) expect(a).toHaveProperty(k);
      expect(a.journey).toBe('wm-not-draining');
      expect(JSON.stringify(decide(JSON.parse(JSON.stringify(s)), AVAILABLE))).toBe(JSON.stringify(a));
    }
  });
  it('entry: washer-dryer / dishwasher / not-spinning with empty drum do not apply', () => {
    const wd = F.base(); wd.identity.appliance.value = 'washer-dryer';
    expect(P.entry(wd, D.diagnose(wd)).applies).toBe(false);
    expect(decide(wd)).toMatchObject({ kind: 'exit_journey', target: 'washer-dryer' });
    const ns = F.obs(F.journey(F.base(), 'not-spinning'), 'waterRemaining', false, 1);
    expect(P.entry(ns, D.diagnose(ns)).applies).toBe(false);
    const leak = F.journey(F.base(), 'leaking');
    expect(P.entry(leak, D.diagnose(leak)).applies).toBe(false);
  });
  it('now drains normally (no clearance) -> exit_journey (noViableCause)', () => {
    const s = F.obs(F.obs(F.base(), 'drainsNormally', true, 2), 'waterRemaining', false, 2);
    expect(decide(s)).toMatchObject({ kind: 'exit_journey', rule: 'R3' });
  });
  it('live defect: hazard typed as an additional `leaking` problem mid-journey still gets R1 under Journey 1', () => {
    const s = F.hazard(F.base(), 'electrical_water');
    s.problems.push({ ...JSON.parse(JSON.stringify(s.problems[0])), id: 'p2', journey: { value: 'leaking', basis: 'stated', turn: 2, status: 'active', history: [] } });
    const d = D.diagnose(s);
    expect(P.entry(s, d)).toMatchObject({ applies: true, safetyCarry: true });
    expect(P.policy(s, d, {})).toMatchObject({ kind: 'safety_stop', rule: 'R1' });
    const noHazard = JSON.parse(JSON.stringify(s)); noHazard.safety.hazards = []; noHazard.safety.activeLevel = 'NORMAL_DIAGNOSTIC';
    expect(P.entry(noHazard, D.diagnose(noHazard)).applies).toBe(false); // an additional leak alone is not Journey 1
  });
  it('burning hazard is releasable by correction; electric_shock is sticky', () => {
    expect(decide(F.hazard(F.base(), 'burning', 'corrected')).kind).toBe('ask_check');
    expect(decide(F.hazard(F.base(), 'electric_shock', 'corrected')).kind).toBe('safety_stop');
  });
});
