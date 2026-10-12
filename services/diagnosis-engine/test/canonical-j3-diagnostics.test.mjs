/**
 * Layer B — Journey 3 diagnostics fixtures Z01–Z27 (docs/diagnostics/wm-leaking-evidence.md §5).
 * Expectations were written into the evidence doc before the engine was run.
 */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const D = require('../canonical/j3-diagnostics.js');
const F = require('./j1-state-fixture.cjs');
const { newFact } = require('../canonical/cs1.js');
const EC = require('../faults-catalogue.json').errorCodes;

const B = () => { const s = F.base(); s.problems[0].journey = newFact('leaking', 'stated', 1); F.delObs(s, 'waterRemaining'); return s; };
const run = (s, ctx = {}) => D.diagnose(s, { errorCodes: EC, ...ctx });
const scores = (d) => d.rank.map((r) => [r.family, r.score]);
const fam = (d, f) => d.rank.find((r) => r.family === f);
const contra = (d) => d.contradicted.map((c) => c.family).sort();
const o = (s, k, v = true, t = 1) => F.obs(s, k, v, t);
const c = (s, k, r, t = 2, st = 'done') => F.check(s, k, st, r, t);

describe('Z01–Z27', () => {
  it('Z01 nothing yet: no family ranked', () => { expect(run(B()).rank).toEqual([]); });
  it('Z02 door leak: DS 1 = DR 1 (DS first)', () => {
    const d = run(o(B(), 'leakAtDoor'));
    expect(scores(d)).toEqual([['door-seal', 1], ['dispenser', 1]]);
    expect(d.leader.committed).toBe(false);
  });
  it('Z03 torn seal: DS 3 committed component door-seal; part evidence', () => {
    const d = run(c(o(B(), 'leakAtDoor'), 'door-seal', 'fault_seen'));
    expect(fam(d, 'door-seal').score).toBe(3);
    expect(d.leader).toMatchObject({ family: 'door-seal', committed: true, level: 'component', component: 'door-seal' });
    expect(d.partEvidence).toEqual({ sufficient: true, component: 'door-seal', reasons: [] });
  });
  it('Z04 trapped item removed + dry retest: likely fixed, no part', () => {
    const d = run(o(c(o(B(), 'leakAtDoor'), 'door-seal', 'found_and_cleared', 2), 'leakRecurs', false, 3));
    expect(fam(d, 'door-seal').score).toBe(5);
    expect(d.likelyResolved).toBe(true);
    expect(d.leader.level).toBe('cause_family');
    expect(d.partEvidence.sufficient).toBe(false);
  });
  it('Z05 seal intact: DS contradicted, DR leads', () => {
    const d = run(c(o(B(), 'leakAtDoor'), 'door-seal', 'clear'));
    expect(contra(d)).toContain('door-seal');
    expect(d.leader.family).toBe('dispenser');
  });
  it('Z06 drawer overflowing on fill: DR 4 committed cause_family', () => {
    const d = run(o(o(o(B(), 'leakAtDrawer'), 'drawerOverflowing'), 'leaksOnFill'));
    expect(fam(d, 'dispenser').score).toBe(4);
    expect(d.leader).toMatchObject({ family: 'dispenser', committed: true, level: 'cause_family' });
  });
  it('Z07 drawer cleaned + dry retest: likely fixed', () => {
    const d = run(o(c(o(o(o(B(), 'leakAtDrawer'), 'drawerOverflowing'), 'leaksOnFill'), 'detergent-drawer', 'found_and_cleared', 2), 'leakRecurs', false, 3));
    expect(d.leader.family).toBe('dispenser');
    expect(d.likelyResolved).toBe(true);
  });
  it('Z08 drawer overflow + foam: OS 4, DR 3, not committed', () => {
    const d = run(o(o(o(B(), 'leakAtDrawer'), 'drawerOverflowing'), 'excessiveFoam'));
    expect(scores(d).slice(0, 2)).toEqual([['oversudsing', 4], ['dispenser', 3]]);
    expect(d.leader.committed).toBe(false);
  });
  it('Z09 + dose corrected: OS committed', () => {
    const d = run(c(o(o(o(B(), 'leakAtDrawer'), 'drawerOverflowing'), 'excessiveFoam'), 'detergent-dose', 'found_and_cleared'));
    expect(d.leader).toMatchObject({ family: 'oversudsing', committed: true });
  });
  it('Z10 rear leak while filling: IC 2, IV 1, DC 0', () => {
    const d = run(o(o(B(), 'leakAtRear'), 'leaksOnFill'));
    expect(scores(d)).toEqual([['inlet-connection', 2], ['inlet-valve-or-fill', 1], ['drain-connection', 0]]);
  });
  it('Z11 inlet tightened + dry retest: IC committed, likely fixed, no part', () => {
    const d = run(o(c(o(o(B(), 'leakAtRear'), 'leaksOnFill'), 'inlet-connection', 'found_and_cleared', 2), 'leakRecurs', false, 3));
    expect(d.leader).toMatchObject({ family: 'inlet-connection', committed: true, level: 'cause_family' });
    expect(d.likelyResolved).toBe(true);
  });
  it('Z12 fill hose split: IC committed component inlet-hose', () => {
    const d = run(c(o(o(B(), 'leakAtRear'), 'leaksOnFill'), 'inlet-connection', 'fault_seen'));
    expect(d.leader).toMatchObject({ family: 'inlet-connection', committed: true, level: 'component', component: 'inlet-hose' });
  });
  it('Z13 leaks when off: IC 2 (strong) leads, IV 1, not committed', () => {
    const d = run(o(B(), 'leaksWhenOff'));
    expect(scores(d)).toEqual([['inlet-connection', 2], ['inlet-valve-or-fill', 1]]);
    expect(d.leader.committed).toBe(false);
  });
  it('Z14 + inlet connections tight: IC contradicted, IV leads (internal fill side)', () => {
    const d = run(c(o(B(), 'leaksWhenOff'), 'inlet-connection', 'clear'));
    expect(contra(d)).toContain('inlet-connection');
    expect(d.leader.family).toBe('inlet-valve-or-fill');
  });
  it('Z15 rear leak while draining: DC 2 leads, IC 0', () => {
    const d = run(o(o(B(), 'leakAtRear'), 'leaksOnDrain'));
    expect(scores(d)).toEqual([['drain-connection', 2], ['inlet-connection', 0]]);
  });
  it('Z16 drain hose split: DC committed component drain-hose', () => {
    const d = run(c(o(o(B(), 'leakAtRear'), 'leaksOnDrain'), 'drain-connection', 'fault_seen'));
    expect(d.leader).toMatchObject({ family: 'drain-connection', committed: true, component: 'drain-hose' });
  });
  it('Z17 household waste backs up while draining: HB 3 committed; no part', () => {
    const d = run(o(o(B(), 'waterReturnsAfterDrain'), 'leaksOnDrain'));
    expect(fam(d, 'household-backflow').score).toBe(3);
    expect(d.leader).toMatchObject({ family: 'household-backflow', committed: true });
    expect(fam(d, 'drain-connection').score).toBe(0);
    expect(d.partEvidence.sufficient).toBe(false);
  });
  it('Z18 filter-area leak after filter cleaning: FS 2, PB 0', () => {
    const d = run(o(o(B(), 'leakAtFilter'), 'recentFilterAccess'));
    expect(scores(d)).toEqual([['filter-seal', 2], ['pump-body', 0]]);
  });
  it('Z19 filter cap re-seated + dry retest: likely fixed, no part', () => {
    const d = run(o(c(o(o(B(), 'leakAtFilter'), 'recentFilterAccess'), 'filter-seal', 'found_and_cleared', 2), 'leakRecurs', false, 3));
    expect(d.leader).toMatchObject({ family: 'filter-seal', committed: true });
    expect(d.likelyResolved).toBe(true);
  });
  it('Z20 filter cap damaged: FS committed component pump-filter', () => {
    const d = run(c(o(o(B(), 'leakAtFilter'), 'recentFilterAccess'), 'filter-seal', 'fault_seen'));
    expect(d.leader).toMatchObject({ family: 'filter-seal', committed: true, component: 'pump-filter' });
  });
  it('Z21 puddle underneath, source unknown: PB 1 = SH 1, no part', () => {
    const d = run(o(B(), 'leakUnderneath'));
    expect(scores(d)).toEqual([['pump-body', 1], ['internal-hose', 1]]);
    expect(d.partEvidence.sufficient).toBe(false);
  });
  it('Z22 underneath on drain, filter + drain hose sound: PB 4 = SH 4, TB 3; FS + DC contradicted', () => {
    const d = run(c(c(o(o(B(), 'leakUnderneath'), 'leaksOnDrain'), 'filter-seal', 'clear', 2), 'drain-connection', 'clear', 3));
    expect(scores(d)).toEqual([['pump-body', 4], ['internal-hose', 4], ['tub-or-major-internal', 3]]);
    expect(contra(d)).toEqual(expect.arrayContaining(['filter-seal', 'drain-connection']));
    expect(d.leader.committed).toBe(false);
  });
  it('Z23 major leak underneath during the wash, seal intact: SH 4 = TB 4; DS contradicted', () => {
    const d = run(c(o(o(o(B(), 'leakUnderneath'), 'leaksOnWash'), 'majorLeak'), 'door-seal', 'clear'));
    expect(scores(d).slice(0, 2)).toEqual([['internal-hose', 4], ['tub-or-major-internal', 4]]);
    expect(contra(d)).toContain('door-seal');
  });
  it('Z24 recently installed, rear leak: IC 2 = DC 2', () => {
    const d = run(o(o(B(), 'leakAtRear'), 'recentInstallation'));
    expect(scores(d)).toEqual([['inlet-connection', 2], ['drain-connection', 2]]);
  });
  it('Z25 underneath + flood code (Hotpoint F15): PB 2 = SH 2', () => {
    const s = F.code(F.make(o(B(), 'leakUnderneath'), 'hotpoint'), 'F15');
    const d = run(s);
    expect(d.codeFault).toBe('leak-flood');
    expect(scores(d)).toEqual([['pump-body', 2], ['internal-hose', 2]]);
  });
  it('Z26 safety independence', () => {
    const s = c(o(B(), 'leakAtDoor'), 'door-seal', 'fault_seen');
    expect(run(F.hazard(JSON.parse(JSON.stringify(s)), 'electrical_water'))).toEqual(run(s));
  });
  it('Z27 backflow + split drain hose: no machine part (household-backflow evidence)', () => {
    const d = run(c(o(o(B(), 'waterReturnsAfterDrain'), 'leaksOnDrain'), 'drain-connection', 'fault_seen'));
    expect(d.partEvidence.sufficient).toBe(false);
  });
});
