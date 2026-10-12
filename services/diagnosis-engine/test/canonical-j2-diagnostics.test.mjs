/**
 * Layer C — Journey 2 diagnostics fixtures X01–X27 (docs/diagnostics/wm-not-spinning-evidence.md §6).
 * Expectations were written into the evidence doc before the engine was run.
 */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const D = require('../canonical/j2-diagnostics.js');
const F = require('./j2-state-fixture.cjs');
const EC = require('../faults-catalogue.json').errorCodes;

const run = (s, ctx = {}) => D.diagnose(s, { errorCodes: EC, ...ctx });
const scores = (d) => d.rank.map((r) => [r.family, r.score]);
const fam = (d, f) => d.rank.find((r) => r.family === f);
const contra = (d) => d.contradicted.map((c) => c.family).sort();
const B = () => F.base();
const X14 = () => { const s = F.obs(F.obs(F.obs(B(), 'drumTurns', false, 2), 'motorAudible', true, 2), 'drumUnusuallyFree', true, 3); return s; };
const X16 = () => F.check(F.obs(F.obs(B(), 'drumTurns', false, 2), 'motorAudible', false, 2), 'drum-by-hand', 'done', 'clear', 3);

describe('X01–X27', () => {
  it('X01 drains, will not spin: LB/BT/MB/MD all 0, LB leads (prior), not committed', () => {
    const d = run(B());
    expect(scores(d)).toEqual([['load-imbalance', 0], ['drive-belt', 0], ['motor-brushes', 0], ['motor-drive', 0]]);
    expect(d.leader).toMatchObject({ family: 'load-imbalance', committed: false });
    expect(d.partEvidence.sufficient).toBe(false);
  });
  it('X02 retained water: drain suspected, no drainsOk', () => {
    const d = run(F.obs(B(), 'waterRemaining', true, 1));
    expect(d.drainSuspected).toBe(true);
    expect(d.facts).not.toContain('drainsOk');
  });
  it('X03 spins empty: LB 2, PG 1; drive families contradicted', () => {
    const d = run(F.obs(B(), 'spinsEmpty', true, 2));
    expect(scores(d)).toEqual([['load-imbalance', 2], ['programme-setting', 1]]);
    expect(contra(d)).toEqual(['drive-belt', 'motor-brushes', 'motor-drive']);
    expect(d.leader).toMatchObject({ family: 'load-imbalance', committed: false, margin: 1 });
  });
  it('X04 + keeps redistributing: LB 3 committed (cause_family), no part', () => {
    const d = run(F.obs(F.obs(B(), 'spinsEmpty', true, 2), 'repeatedRedistribution', true, 1));
    expect(scores(d).slice(0, 2)).toEqual([['load-imbalance', 3], ['programme-setting', 0]]);
    expect(d.leader).toMatchObject({ family: 'load-imbalance', committed: true, level: 'cause_family' });
    expect(d.partEvidence.sufficient).toBe(false);
  });
  it('X05 heavy item, load corrected, spins: LB 6 committed, likelyResolved', () => {
    const s = F.obs(F.check(F.obs(B(), 'loadDependent', true, 1), 'load-check', 'done', 'found_and_cleared', 2), 'commandedSpin', true, 3);
    const d = run(s);
    expect(fam(d, 'load-imbalance').score).toBe(6);
    expect(d.leader).toMatchObject({ family: 'load-imbalance', committed: true });
    expect(d.likelyResolved).toBe(true);
  });
  it('X06 load corrected but still fails: LB contradicted', () => {
    const d = run(F.obs(F.check(B(), 'load-check', 'done', 'found_and_cleared', 2), 'commandedSpin', false, 3));
    expect(contra(d)).toContain('load-imbalance');
    expect(d.leader).toMatchObject({ family: 'drive-belt', committed: false });
  });
  it('X07 violent shaking with a normal load: SU 2 leads, not committed', () => {
    const d = run(F.check(F.obs(B(), 'excessiveVibration', true, 1), 'load-check', 'done', 'clear', 2));
    expect(d.leader).toMatchObject({ family: 'suspension-or-movement', committed: false });
    expect(fam(d, 'suspension-or-movement').score).toBe(2);
    expect(fam(d, 'load-imbalance').score).toBe(0);
  });
  it('X08 spin setting corrected, spins: PG 4 committed, likelyResolved', () => {
    const d = run(F.obs(F.check(B(), 'programme-setting', 'done', 'found_and_cleared', 2), 'commandedSpin', true, 3));
    expect(fam(d, 'programme-setting').score).toBe(4);
    expect(d.leader).toMatchObject({ family: 'programme-setting', committed: true });
    expect(d.likelyResolved).toBe(true);
  });
  it('X09 dedicated spin works: LB 1 = PG 1 (prior LB); drive families contradicted', () => {
    const d = run(F.obs(B(), 'commandedSpin', true, 2));
    expect(scores(d)).toEqual([['load-imbalance', 1], ['programme-setting', 1]]);
    expect(contra(d)).toEqual(['drive-belt', 'motor-brushes', 'motor-drive']);
  });
  it('X10 + programme normal: PG contradicted, LB leads', () => {
    const d = run(F.check(F.obs(B(), 'commandedSpin', true, 2), 'programme-setting', 'done', 'clear', 3));
    expect(contra(d)).toContain('programme-setting');
    expect(d.leader.family).toBe('load-imbalance');
  });
  it('X11 drum never turns, door does not lock: DL 3 committed cause_family, no part yet', () => {
    const d = run(F.obs(F.obs(B(), 'drumTurns', false, 1), 'doorLocks', false, 1));
    expect(fam(d, 'door-lock').score).toBe(3);
    expect(d.leader).toMatchObject({ family: 'door-lock', committed: true, level: 'cause_family' });
    expect(d.partEvidence.sufficient).toBe(false);
  });
  it('X12 + door checked (closed firmly): DL 5 committed component door-lock, part evidence', () => {
    const d = run(F.check(F.obs(F.obs(B(), 'drumTurns', false, 1), 'doorLocks', false, 2), 'door-closed-latched', 'done', null, 2));
    expect(fam(d, 'door-lock').score).toBe(5);
    expect(d.leader).toMatchObject({ family: 'door-lock', committed: true, level: 'component', component: 'door-lock' });
    expect(d.partEvidence).toEqual({ sufficient: true, component: 'door-lock', reasons: [] });
  });
  it('X13 washes but door "does not lock": DL contradicted', () => {
    expect(contra(run(F.obs(F.obs(B(), 'drumTurns', true, 1), 'doorLocks', false, 1)))).toContain('door-lock');
  });
  it('X14 belt off: BT 6 committed component drive-belt, part evidence', () => {
    const d = run(X14());
    expect(fam(d, 'drive-belt').score).toBe(6);
    expect(d.leader).toMatchObject({ family: 'drive-belt', committed: true, level: 'component', component: 'drive-belt', decisive: 'beltOffComposite' });
    expect(d.partEvidence.sufficient).toBe(true);
    expect(d.rank.map((r) => r.family)).not.toContain('mechanical-resistance'); // ineligible: no resistance evidence
  });
  it('X15 X14 on an LG (direct drive, brushless): BT and MB impossible, MD leads, no part', () => {
    const d = run(F.make(X14(), 'lg'));
    expect(d.architecture).toMatchObject({ drive: 'direct', motor: 'brushless' });
    expect(contra(d)).toEqual(expect.arrayContaining(['drive-belt', 'motor-brushes']));
    expect(d.leader).toMatchObject({ family: 'motor-drive', committed: false });
    expect(d.partEvidence.sufficient).toBe(false);
  });
  it('X16 nothing drives, drum normal by hand: MD 3, MB 2, CT 1, BT -1; not committed', () => {
    const d = run(X16());
    expect(scores(d)).toEqual([['motor-drive', 3], ['motor-brushes', 2], ['control', 1], ['drive-belt', -1]]);
    expect(d.rank.map((r) => r.family)).not.toContain('mechanical-resistance'); // ineligible
    expect(d.leader).toMatchObject({ family: 'motor-drive', committed: false, level: 'cause_family' });
  });
  it('X17 + model part list shows carbon brushes (brushed motor): MB 3 = MD 3, MB first', () => {
    const d = run(X16(), { modelParts: [{ title: 'Carbon Brushes Pack of 2' }, { title: 'Drain Pump' }] });
    expect(d.architecture.motor).toBe('brushed');
    expect(scores(d).slice(0, 2)).toEqual([['motor-brushes', 3], ['motor-drive', 3]]);
    expect(d.leader.committed).toBe(false);
  });
  it('X18 + customer saw worn carbon brushes: MB 5 committed component carbon-brushes', () => {
    const d = run(F.check(X16(), 'carbon-brushes', 'done', 'fault_seen', 4));
    expect(fam(d, 'motor-brushes').score).toBe(5);
    expect(fam(d, 'motor-drive').score).toBe(2);
    expect(d.leader).toMatchObject({ family: 'motor-brushes', committed: true, level: 'component', component: 'carbon-brushes' });
    expect(d.partEvidence.sufficient).toBe(true);
  });
  it('X19 X18 on a Samsung (brushless platform): MB impossible, no part', () => {
    const d = run(F.make(F.check(X16(), 'carbon-brushes', 'done', 'fault_seen', 4), 'samsung'));
    expect(d.architecture.motor).toBe('brushless');
    expect(contra(d)).toContain('motor-brushes');
    expect(d.partEvidence.sufficient).toBe(false);
  });
  it('X20 stiff / grinding by hand: ME 3 committed, no part', () => {
    const d = run(F.obs(F.check(F.obs(B(), 'drumTurns', true, 1), 'drum-by-hand', 'done', 'fault_seen', 2), 'grindingNoise', true, 1));
    expect(fam(d, 'mechanical-resistance').score).toBe(3);
    expect(d.leader).toMatchObject({ family: 'mechanical-resistance', committed: true, level: 'cause_family' });
    expect(d.partEvidence.sufficient).toBe(false);
  });
  it('X21 seized: ME 3 committed', () => {
    const d = run(F.obs(F.obs(B(), 'drumTurns', false, 1), 'drumTurnsByHand', false, 2));
    expect(d.leader).toMatchObject({ family: 'mechanical-resistance', committed: true });
  });
  it('X22 weak spin, fails empty: MB 2 = MD 2 (MB first), BT 1; PL + LB contradicted; no part', () => {
    const d = run(F.obs(F.obs(B(), 'spinsSlowly', true, 1), 'spinsEmpty', false, 2));
    expect(scores(d)).toEqual([['motor-brushes', 2], ['motor-drive', 2], ['drive-belt', 1]]);
    expect(contra(d)).toEqual(expect.arrayContaining(['load-imbalance', 'pressure-or-level']));
    expect(d.partEvidence.sufficient).toBe(false);
  });
  it('X23 turns on wash, never spins, fails empty: PL 2, MB 1, MD 1; not committed', () => {
    const d = run(F.obs(F.obs(B(), 'drumTurns', true, 1), 'spinsEmpty', false, 2));
    expect(scores(d).slice(0, 3)).toEqual([['pressure-or-level', 2], ['motor-brushes', 1], ['motor-drive', 1]]);
    expect(d.leader.committed).toBe(false);
  });
  it('X24 jerky + motor/tacho code: MB 2 = MD 2; no part, code support only', () => {
    const d = run(F.obs(B(), 'jerkyAcceleration', true, 1), { codeFault: 'tacho' });
    expect(scores(d).slice(0, 2)).toEqual([['motor-brushes', 2], ['motor-drive', 2]]);
    expect(d.partEvidence.reasons).toContain('code-is-support-only');
  });
  it('X25 X16 + control code: MD 3, MB 2, CT 2', () => {
    const d = run(X16(), { codeFault: 'main-pcb' });
    expect(fam(d, 'control').score).toBe(2);
    expect(d.leader).toMatchObject({ family: 'motor-drive', committed: false });
  });
  it('X26 safety independence: X14 + burning hazard identical', () => {
    expect(run(F.hazard(X14(), 'burning'))).toEqual(run(X14()));
  });
  it('X27 brushes seen worn but spins empty: MB contradicted, LB leads', () => {
    const d = run(F.obs(F.check(B(), 'carbon-brushes', 'done', 'fault_seen', 2), 'spinsEmpty', true, 3));
    expect(contra(d)).toContain('motor-brushes');
    expect(d.leader.family).toBe('load-imbalance');
  });
});

describe('live regressions', () => {
  it('X28 (live c14) turns, fails empty, rough/grinding by hand: ME committed over PL (resistance argues against level sensing)', () => {
    const d = run(F.check(F.obs(F.obs(F.obs(B(), 'drumTurns', true, 1), 'grindingNoise', true, 1), 'spinsEmpty', false, 2), 'drum-by-hand', 'done', 'fault_seen', 3));
    expect(d.leader).toMatchObject({ family: 'mechanical-resistance', committed: true });
    expect(fam(d, 'pressure-or-level').score).toBe(1);
  });
  it('X29 (live c16) a setting FOUND (found_not_cleared) is owner-correctable: PG evidence, retest due', () => {
    const s = F.check(F.obs(F.obs(B(), 'drumTurns', true, 1), 'spinsEmpty', true, 2), 'programme-setting', 'done', 'found_not_cleared', 3);
    expect(run(s).facts).toContain('programmeCorrected');
    expect(require('../canonical/j2-policy.js').policy(s, run(s), {})).toMatchObject({ rule: 'S8', target: 'spin-command', requestKind: 'retest' });
  });
});

describe('architecture typing + codes', () => {
  it('belt from the model part list; direct drive beats a listed belt; customer-seen belt', () => {
    expect(D.architectureOf(B(), { modelParts: [{ title: 'Elastic Poly-Vee Belt 1270 J5' }] }).drive).toBe('belt');
    expect(D.architectureOf(B(), { modelParts: [{ title: 'Tumble Dryer Small Poly V Belt 4PHE285' }] }).drive).toBe('unknown');
    expect(D.architectureOf(F.make(B(), 'lg'), { errorCodes: EC, modelParts: [{ title: 'Poly-Vee Drive Belt' }] }).drive).toBe('direct');
    expect(D.architectureOf(F.check(B(), 'drive-belt', 'done', 'fault_seen', 2), {}).drive).toBe('belt');
  });
  it('make only: unknown architecture for non-platform makes (never assumes brushes)', () => {
    expect(D.architectureOf(F.make(B(), 'hotpoint'), { errorCodes: EC })).toMatchObject({ drive: 'unknown', motor: 'unknown' });
  });
  it('codeFaultFor needs the make (codes are brand-specific)', () => {
    expect(D.codeFaultFor(F.code(B(), 'F05'), EC)).toBe(null);
    expect(D.codeFaultFor(F.code(F.make(B(), 'hotpoint'), 'F05'), EC)).toBe('not-draining');
  });
  it('pure: same state same output; input untouched', () => {
    const s = X14(); const snap = JSON.stringify(s);
    expect(run(s)).toEqual(run(JSON.parse(snap)));
    expect(JSON.stringify(s)).toBe(snap);
  });
});
