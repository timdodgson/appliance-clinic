/**
 * Layer D — Journey 2 policy fixtures Y01–Y30 (evidence doc §7) + part gate Q1–Q7 (§8) + multi-turn
 * sequences through the real merge. `inferred` is computed by j2-diagnostics, never hand-set.
 */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const D = require('../canonical/j2-diagnostics.js');
const P = require('../canonical/j2-policy.js');
const F = require('./j2-state-fixture.cjs');
const EC = require('../faults-catalogue.json').errorCodes;
const { merge } = require('../canonical/merge.js');
const { emptyState } = require('../canonical/cs1.js');
const mc1 = require('../canonical/mc1.js');
const rq = require('../canonical/requests.js');

const BELT = [{ title: 'Elastic Poly-Vee Belt 1270 J5' }];
const decide = (s, { partLookup = null, modelParts = null } = {}) => P.policy(s, D.diagnose(s, { errorCodes: EC, modelParts }), { partLookup });
const B = () => F.base();
const turns = (s) => F.obs(s, 'drumTurns', true, 1);
const still = (s) => F.obs(s, 'drumTurns', false, 1);

describe('Y01–Y30 single-state fixtures', () => {
  it('Y01 opener with drainage unknown -> drain first (S5 waterRemaining)', () => {
    const s = F.delObs(B(), 'waterRemaining');
    expect(decide(s)).toMatchObject({ kind: 'ask_observation', target: 'waterRemaining', rule: 'S5' });
  });
  it('Y02 retained water -> Journey 1 owns it (exit drain-first); entry does not apply', () => {
    const s = F.obs(B(), 'waterRemaining', true, 1);
    expect(P.entry(s, D.diagnose(s)).applies).toBe(false);
    expect(decide(s)).toMatchObject({ kind: 'exit_journey', target: 'wm-not-draining', rule: 'S3' });
  });
  it('Y03 drains, drum movement unknown -> S10 drumTurns', () => {
    expect(decide(B())).toMatchObject({ kind: 'ask_observation', target: 'drumTurns', rule: 'S10' });
  });
  it('Y04a spin-only already failed with the motor silent -> no empty-spin test; drum-by-hand reported counts as done', () => {
    const s = F.obs(F.obs(turns(B()), 'commandedSpin', false, 2), 'motorAudible', false, 3);
    expect(decide(s)).not.toMatchObject({ target: 'empty-spin-test' });
    F.obs(s, 'drumTurnsByHand', true, 3);
    const a = decide(s);
    expect(a.target).not.toBe('empty-spin-test');
    expect(a.target).not.toBe('drum-by-hand');
  });
  it('Y04 turns on wash, nothing else -> S12 empty-spin test with door/shaking requires', () => {
    const a = decide(turns(B()));
    expect(a).toMatchObject({ kind: 'ask_check', target: 'empty-spin-test', rule: 'S12' });
    expect(a.requires).toEqual(['pause_wait_door_unlock', 'stop_if_violent_shaking']);
  });
  it('Y05 keeps redistributing -> S11 load-check first', () => {
    expect(decide(F.obs(B(), 'repeatedRedistribution', true, 1))).toMatchObject({ kind: 'ask_check', target: 'load-check', rule: 'S11' });
  });
  it('Y06 spins empty -> S13 load-check', () => {
    expect(decide(F.obs(turns(B()), 'spinsEmpty', true, 2))).toMatchObject({ target: 'load-check', rule: 'S13' });
  });
  it('Y07 spins empty, load normal -> S13 programme-setting', () => {
    expect(decide(F.check(F.obs(turns(B()), 'spinsEmpty', true, 2), 'load-check', 'done', 'clear', 3))).toMatchObject({ target: 'programme-setting', rule: 'S13' });
  });
  it('Y08 spins empty, load + programme normal -> conclude load-imbalance possible, no part, no model ask', () => {
    const s = F.check(F.check(F.obs(turns(B()), 'spinsEmpty', true, 2), 'load-check', 'done', 'clear', 3), 'programme-setting', 'done', 'clear', 4);
    const a = decide(s);
    expect(a).toMatchObject({ kind: 'conclude', rule: 'S19' });
    expect(a.conclusion).toMatchObject({ cause: 'load-imbalance', handoff: 'none', noPart: true });
  });
  it('Y09 load corrected -> S8 spin retest', () => {
    expect(decide(F.check(F.obs(turns(B()), 'spinsEmpty', true, 2), 'load-check', 'done', 'found_and_cleared', 3)))
      .toMatchObject({ kind: 'ask_check', target: 'spin-command', rule: 'S8', requestKind: 'retest' });
  });
  it('Y10 load corrected + spins -> S9 likely fixed, no part, CONFIRM pending', () => {
    const a = decide(F.obs(F.check(F.obs(turns(B()), 'spinsEmpty', true, 2), 'load-check', 'done', 'found_and_cleared', 3), 'commandedSpin', true, 4));
    expect(a).toMatchObject({ kind: 'conclude', target: 'load-imbalance', rule: 'S9' });
    expect(a.conclusion.handoff).toBe('none');
    expect(a.pending).toMatchObject({ purpose: 'CONFIRM' });
  });
  it('Y11 spin setting corrected + spins -> S9 programme-setting (no fault)', () => {
    const s = F.obs(F.check(F.obs(turns(B()), 'commandedSpin', true, 2), 'programme-setting', 'done', 'found_and_cleared', 3), 'commandedSpin', true, 4);
    s.evidence.observations.commandedSpin.lastTurn = 4;
    expect(decide(s)).toMatchObject({ kind: 'conclude', target: 'programme-setting', rule: 'S9' });
  });
  it('Y12 resolved -> S2 close', () => {
    const s = F.check(turns(B()), 'load-check', 'done', 'found_and_cleared', 2); s.resolution = 'resolved'; s.problems[0].status = 'resolved';
    expect(decide(s)).toMatchObject({ kind: 'close_resolved', target: 'load-imbalance', rule: 'S2' });
  });
  it('Y13 fails empty -> S14 drum-by-hand with isolation requires', () => {
    const a = decide(F.obs(turns(B()), 'spinsEmpty', false, 2));
    expect(a).toMatchObject({ kind: 'ask_check', target: 'drum-by-hand', rule: 'S14' });
    expect(a.requires).toEqual(['isolate_mains', 'wait_drum_stopped_door_unlocked', 'turn_by_hand_only', 'no_panel_removal']);
  });
  it('Y14 drum never turns -> S15 drum-by-hand', () => {
    expect(decide(still(B()))).toMatchObject({ target: 'drum-by-hand', rule: 'S15' });
  });
  it('Y15 never turns, normal by hand -> S16 motor sound', () => {
    expect(decide(F.check(still(B()), 'drum-by-hand', 'done', 'clear', 2))).toMatchObject({ kind: 'ask_observation', target: 'motorAudible', rule: 'S16' });
  });
  it('Y16 belt-off evidence, model unknown -> S17 model', () => {
    const s = F.obs(F.obs(F.check(still(B()), 'drum-by-hand', 'done', null, 2), 'drumUnusuallyFree', true, 2), 'motorAudible', true, 3);
    expect(decide(s)).toMatchObject({ kind: 'ask_identity', target: 'model', rule: 'S17' });
  });
  it('Y17 belt-off + belt-drive model + compatible belt -> S18 recommend drive-belt', () => {
    const s = F.model(F.obs(F.obs(F.check(still(B()), 'drum-by-hand', 'done', null, 2), 'drumUnusuallyFree', true, 2), 'motorAudible', true, 3), 'WMB81445LW', 'beko');
    expect(decide(s, { modelParts: BELT, partLookup: { available: true, component: 'drive-belt' } })).toMatchObject({ kind: 'recommend_part', target: 'drive-belt', rule: 'S18' });
  });
  it('Y18 belt-off on an LG (direct drive) -> no belt; conclude motor/drive area', () => {
    const s = F.model(F.obs(F.obs(F.check(still(B()), 'drum-by-hand', 'done', null, 2), 'drumUnusuallyFree', true, 2), 'motorAudible', true, 3), 'F4V5VYP0W', 'lg');
    const a = decide(s, { partLookup: { available: true, component: 'drive-belt' } });
    expect(a.kind).toBe('conclude');
    expect(a.target).not.toBe('drive-belt');
    expect(a.conclusion.architecture).toMatchObject({ drive: 'direct', motor: 'brushless' });
  });
  it('Y19 door does not lock -> S7 door check (never bypass)', () => {
    const a = decide(F.obs(still(B()), 'doorLocks', false, 1));
    expect(a).toMatchObject({ kind: 'ask_check', target: 'door-closed-latched', rule: 'S7' });
    expect(a.requires).toContain('never_bypass_interlock');
  });
  it('Y20 door still does not lock after the check, model known, door lock listed -> S18 door-lock', () => {
    const s = F.model(F.check(F.obs(still(B()), 'doorLocks', false, 2), 'door-closed-latched', 'done', null, 2), 'WAN28282GB', 'bosch');
    const a = decide(s, { partLookup: { available: true, component: 'door-lock' } });
    expect(a).toMatchObject({ kind: 'recommend_part', target: 'door-lock', rule: 'S18' });
  });
  it('Y21 stiff / grinding by hand -> S6 conclude mechanical (engineer, no model ask)', () => {
    const a = decide(F.obs(F.check(turns(B()), 'drum-by-hand', 'done', 'fault_seen', 2), 'grindingNoise', true, 1));
    expect(a).toMatchObject({ kind: 'conclude', target: 'mechanical-resistance', rule: 'S6' });
    expect(a.conclusion.handoff).toBe('engineer');
  });
  it('Y22 nothing drives, hand normal, motor silent -> S17 model (architecture decides brushes/belt)', () => {
    const s = F.obs(F.check(still(B()), 'drum-by-hand', 'done', 'clear', 2), 'motorAudible', false, 3);
    expect(decide(s)).toMatchObject({ kind: 'ask_identity', target: 'model', rule: 'S17' });
  });
  it('Y23 same, model unavailable -> conclude motor area possible, alternatives, engineer, no part', () => {
    const s = F.obs(F.check(still(B()), 'drum-by-hand', 'done', 'clear', 2), 'motorAudible', false, 3); s.identity.modelStatus = 'unavailable';
    const a = decide(s);
    expect(a).toMatchObject({ kind: 'conclude', target: 'motor-drive', rule: 'S19' });
    expect(a.conclusion).toMatchObject({ confidence: 'possible', handoff: 'engineer' });
    expect(a.conclusion.alternatives).toContain('motor-brushes');
  });
  it('Y24 customer saw worn brushes on a brushed model with brushes listed -> S18 carbon-brushes', () => {
    const s = F.model(F.check(F.obs(F.check(still(B()), 'drum-by-hand', 'done', 'clear', 2), 'motorAudible', false, 3), 'carbon-brushes', 'done', 'fault_seen', 4), 'WMB81445LW', 'beko');
    expect(decide(s, { partLookup: { available: true, component: 'carbon-brushes' } })).toMatchObject({ kind: 'recommend_part', target: 'carbon-brushes' });
  });
  it('Y25 brushes "worn" on a Samsung (brushless) -> never brushes', () => {
    const s = F.model(F.check(F.obs(F.check(still(B()), 'drum-by-hand', 'done', 'clear', 2), 'motorAudible', false, 3), 'carbon-brushes', 'done', 'fault_seen', 4), 'WF70F5E2W4W', 'samsung');
    const a = decide(s, { partLookup: { available: true, component: 'carbon-brushes' } });
    expect(a.kind).not.toBe('recommend_part');
    expect(a.target).not.toBe('motor-brushes');
  });
  it('Y26 spins empty but not loaded, model known -> never a motor part (load evidence strong)', () => {
    const s = F.model(F.check(F.check(F.obs(turns(B()), 'spinsEmpty', true, 2), 'load-check', 'done', 'clear', 3), 'programme-setting', 'done', 'clear', 4), 'WMB81445LW', 'beko');
    const a = decide(s, { partLookup: { available: true, component: 'carbon-brushes' } });
    expect(a.kind).toBe('conclude');
    expect(a.conclusion.noPart).toBe(true);
  });
  it('Y27 burning smell mid-journey -> S1 safety stop', () => {
    expect(decide(F.hazard(turns(B()), 'burning'))).toMatchObject({ kind: 'safety_stop', target: 'burning', rule: 'S1' });
  });
  it('Y28 empty-spin not done -> re-offer once, then move on (drum-by-hand)', () => {
    const s = turns(B()); F.check(s, 'empty-spin-test', 'not_done', null, 2); F.request(s, 'empty-spin-test', 'ask', 'not_done', 1);
    expect(decide(s)).toMatchObject({ target: 'empty-spin-test', requestKind: 'reoffer' });
    F.request(s, 'empty-spin-test', 'reoffer', 'not_done', 2);
    expect(decide(s)).toMatchObject({ target: 'drum-by-hand', rule: 'S14' });
  });
  it('Y29 cannot answer drum movement -> proceeds on the wash branch (no stall)', () => {
    const s = B(); F.request(s, 'drumTurns', 'ask', 'cannot_answer', 1, 'OBSERVATION');
    expect(decide(s)).toMatchObject({ target: 'empty-spin-test', rule: 'S12' });
  });
  it('Y30 make only never yields a part', () => {
    const s = F.make(F.obs(F.obs(F.check(still(B()), 'drum-by-hand', 'done', null, 2), 'drumUnusuallyFree', true, 2), 'motorAudible', true, 3), 'beko');
    const g = P.partGate(s, D.diagnose(s, { errorCodes: EC, modelParts: BELT }), { available: true, component: 'drive-belt' });
    expect(g.failed).toContain('Q1-model-not-known');
  });
});

describe('part gate Q1–Q7', () => {
  const beltState = () => F.model(F.obs(F.obs(F.check(still(B()), 'drum-by-hand', 'done', null, 2), 'drumUnusuallyFree', true, 2), 'motorAudible', true, 3), 'WMB81445LW', 'beko');
  const gate = (s, pl, modelParts = BELT) => P.partGate(s, D.diagnose(s, { errorCodes: EC, modelParts }), pl);
  it('passes for a belt-drive model with a listed belt', () => {
    expect(gate(beltState(), { available: true, component: 'drive-belt' })).toEqual({ eligible: true, component: 'drive-belt', failed: [] });
  });
  it('Q4 direct drive -> belt impossible', () => {
    const s = beltState(); s.identity.make.value = 'lg';
    expect(gate(s, { available: true, component: 'drive-belt' }).eligible).toBe(false);
  });
  it('Q4 brushes need a brushed motor (unknown architecture is not enough)', () => {
    const s = F.model(F.check(F.obs(F.check(still(B()), 'drum-by-hand', 'done', 'clear', 2), 'motorAudible', false, 3), 'carbon-brushes', 'done', 'clear', 4), 'X1', 'hotpoint');
    const g = gate(s, { available: true, component: 'carbon-brushes' }, []);
    expect(g.eligible).toBe(false);
  });
  it('Q6 no compatible part / Q7 safety / Q2 resolved', () => {
    expect(gate(beltState(), { available: false }).failed).toContain('Q6-no-compatible-part');
    expect(gate(F.hazard(beltState(), 'burning'), { available: true, component: 'drive-belt' }).failed).toContain('Q7-active-safety');
    const r = beltState(); r.resolution = 'resolved';
    expect(gate(r, { available: true, component: 'drive-belt' }).failed).toContain('Q2-resolved-or-likely');
  });
  it('motor / inverter / tacho / PCB are never part-eligible in Journey 2', () => {
    const s = F.model(F.obs(F.check(still(B()), 'drum-by-hand', 'done', 'clear', 2), 'motorAudible', false, 3), 'X1', 'hotpoint');
    const d = D.diagnose(s, { errorCodes: EC, codeFault: 'main-pcb' });
    expect(d.partEvidence.sufficient).toBe(false);
  });
});

// ---- multi-turn through the real merge + request issue (control) --------------------------------------
const C = (f = {}) => mc1.validateClassification({ scope: 'appliance', ...f });
const WM = { identity: { appliance: { value: 'washing-machine', basis: 'stated' } }, problem: { journey: 'not-spinning', faultDomain: 'motion' } };
function play(cs) {
  let s = emptyState('cs_t'); const rules = [];
  for (const c of cs) {
    s = merge(s, c, { turn: s.version + 1 }).state;
    const a = decide(s);
    rules.push(`${a.rule}:${a.target}`);
    if (a.pending) s = rq.issueRequest(s, { ...a.pending, kind: a.requestKind || undefined, journey: a.journey, rule: a.rule }, s.version).state;
  }
  return { s, rules };
}
describe('sequences', () => {
  it('merge G3: a pending door check answered only through doorLocks records the check as done', () => {
    const { s } = play([
      C({ ...WM, observations: [{ key: 'waterRemaining', value: false }, { key: 'drumTurns', value: false }, { key: 'doorLocks', value: false }] }),
      C({ observations: [{ key: 'doorLocks', value: false }], reply: { toPending: 'answered' } }),
    ]);
    expect(s.evidence.checks['door-closed-latched']).toMatchObject({ status: 'done', result: null });
    expect(D.diagnose(s).facts).toContain('doorNoLockConfirmed');
  });
  it('no spin, drains -> drum turns -> spins empty -> heavy item corrected -> spins -> confirmed', () => {
    const { rules } = play([
      C({ ...WM, observations: [{ key: 'waterRemaining', value: false }] }),
      C({ observations: [{ key: 'drumTurns', value: true }] }),
      C({ observations: [{ key: 'spinsEmpty', value: true }], checks: [{ check: 'empty-spin-test', status: 'done' }] }),
      C({ checks: [{ check: 'load-check', status: 'done', result: 'found_and_cleared' }] }),
      C({ observations: [{ key: 'commandedSpin', value: true }], checks: [{ check: 'spin-command', status: 'done' }] }),
      C({ reply: { toPending: 'answered', outcome: 'resolved' } }),
    ]);
    expect(rules).toEqual(['S10:drumTurns', 'S12:empty-spin-test', 'S13:load-check', 'S8:spin-command', 'S9:load-imbalance', 'S2:load-imbalance']);
  });
  it('retained water on the opener -> exit to Journey 1 (no Journey 2 request)', () => {
    const { s, rules } = play([C({ ...WM, observations: [{ key: 'waterRemaining', value: true }] })]);
    expect(rules).toEqual(['S3:wm-not-draining']);
    expect(s.requests).toEqual([]);
  });
  it('sparse pending answer: door check -> "never clicks" via pending observation keeps the door path', () => {
    const { rules } = play([
      C({ ...WM, observations: [{ key: 'waterRemaining', value: false }, { key: 'drumTurns', value: false }, { key: 'doorLocks', value: false }] }),
      C({ observations: [{ key: 'doorLocks', value: false }], checks: [{ check: 'door-closed-latched', status: 'done' }], reply: { toPending: 'answered' } }),
    ]);
    expect(rules).toEqual(['S7:door-closed-latched', 'S17:model']);
  });
  it('all-ignored session never loops and ends in a conclusion', () => {
    const cs = [C({ ...WM })]; for (let i = 0; i < 12; i += 1) cs.push(C({ reply: { toPending: 'ignored' } }));
    const { s, rules } = play(cs);
    const n = {}; for (const r of s.requests) if (r.kind !== 'retest') n[r.target] = (n[r.target] || 0) + 1;
    for (const v of Object.values(n)) expect(v).toBeLessThanOrEqual(2);
    expect(rules[rules.length - 1]).toMatch(/^S19:/);
  });
});
