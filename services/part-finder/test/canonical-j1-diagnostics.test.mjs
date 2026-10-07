/**
 * Layer D — Journey 1 diagnostics fixtures D01–D23 (evidence doc §15), exact scores.
 * Each fixture is a delta over BASE (washing machine, active not-draining, waterRemaining=TRUE t1).
 *
 * Note D05: the doc table lists FB 5, IO 1, HR 1 and omits PL. PL scores 1 from waterRemaining (S) and
 * nothing contradicts it (commandedDrainWorks is false after a clearance), so PL 1 is asserted here.
 */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
globalThis.awslambda = globalThis.awslambda || { streamifyResponse: (f) => f, HttpResponseStream: { from: (s) => s } };
const D = require('../canonical/j1-diagnostics.js');
const F = require('./j1-state-fixture.cjs');
const L = require('../part-finder-lambda.js')._internal;

const run = (s, ctx) => D.diagnose(s, ctx);
const scores = (d) => d.rank.map((r) => [r.family, r.score]);
const contra = (d) => d.contradicted.map((c) => c.family).sort();
const fc = (s) => F.check(s, 'drain-filter', 'done', 'clear', 2);
const D03 = () => F.check(F.base(), 'drain-filter', 'done', 'found_and_cleared', 2);
const D06 = () => {
  const s = fc(F.base());
  F.check(s, 'pump-impeller', 'done', 'clear', 2);
  F.obs(s, 'commandedDrain', false, 3); F.obs(s, 'pumpHumming', true, 3);
  return s;
};
const D08 = () => F.check(D06(), 'drain-hose', 'done', 'clear', 4);

describe('D01–D23 (evidence doc §15)', () => {
  it('D01 opener: FB IO HR DP PL all 1, tie -> prior FB, not committed', () => {
    const d = run(F.base());
    expect(scores(d)).toEqual([['filter-blockage', 1], ['impeller-obstruction', 1], ['hose-or-waste-restriction', 1], ['drain-pump', 1], ['pressure-or-level', 1]]);
    expect(d.leader).toMatchObject({ family: 'filter-blockage', committed: false, level: 'cause_family' });
    expect(d.partEvidence.sufficient).toBe(false);
  });
  it('D02 filter clear: FB contradicted, IO leads', () => {
    const d = run(fc(F.base()));
    expect(scores(d)).toEqual([['impeller-obstruction', 1], ['hose-or-waste-restriction', 1], ['drain-pump', 1], ['pressure-or-level', 1]]);
    expect(contra(d)).toEqual(['filter-blockage']);
    expect(d.leader).toMatchObject({ family: 'impeller-obstruction', committed: false });
  });
  it('D03 blockage found, not retested: FB 3 committed (margin 2)', () => {
    const d = run(D03());
    expect(scores(d)).toEqual([['filter-blockage', 3], ['impeller-obstruction', 1], ['hose-or-waste-restriction', 1], ['drain-pump', 1], ['pressure-or-level', 1]]);
    expect(d.rank[0].strongSupport).toBe(1);
    expect(d.leader).toMatchObject({ family: 'filter-blockage', committed: true, level: 'cause_family', margin: 2 });
    expect(d.likelyResolved).toBe(false);
    expect(d.partEvidence.sufficient).toBe(false);
  });
  it('D04 cleared, still not draining: IO HR DP 2; FB (failsAfter) and PL contradicted', () => {
    const d = run(F.obs(D03(), 'commandedDrain', false, 3));
    expect(scores(d)).toEqual([['impeller-obstruction', 2], ['hose-or-waste-restriction', 2], ['drain-pump', 2]]);
    expect(contra(d)).toEqual(['filter-blockage', 'pressure-or-level']);
    expect(d.leader).toMatchObject({ family: 'impeller-obstruction', committed: false });
  });
  it('D05 cleared, drains: FB 5 (ss2) committed, likelyResolved, DP contradicted', () => {
    const d = run(F.obs(D03(), 'commandedDrain', true, 3));
    expect(scores(d)).toEqual([['filter-blockage', 5], ['impeller-obstruction', 1], ['hose-or-waste-restriction', 1], ['pressure-or-level', 1]]);
    expect(d.rank[0].strongSupport).toBe(2);
    expect(contra(d)).toEqual(['drain-pump']);
    expect(d.leader).toMatchObject({ family: 'filter-blockage', committed: true });
    expect(d.likelyResolved).toBe(true);
    expect(d.partEvidence.sufficient).toBe(false);
  });
  it('D06 impeller clear, hums, hose unknown: HR 3, DP 3 (tie -> HR)', () => {
    const d = run(D06());
    expect(scores(d)).toEqual([['hose-or-waste-restriction', 3], ['drain-pump', 3]]);
    expect(contra(d)).toEqual(['filter-blockage', 'impeller-obstruction', 'pressure-or-level']);
    expect(d.leader).toMatchObject({ family: 'hose-or-waste-restriction', committed: false });
  });
  it('D07 impeller jammed: IO 3 committed', () => {
    const d = run(F.check(fc(F.base()), 'pump-impeller', 'done', 'found_not_cleared', 3));
    expect(scores(d)).toEqual([['impeller-obstruction', 3], ['hose-or-waste-restriction', 1], ['drain-pump', 1], ['pressure-or-level', 1]]);
    expect(contra(d)).toEqual(['filter-blockage']);
    expect(d.leader).toMatchObject({ family: 'impeller-obstruction', committed: true, level: 'cause_family' });
  });
  it('D08 hose clear + hums + commanded drain fails: DP 5 committed, component, part evidence', () => {
    const d = run(D08());
    expect(scores(d)).toEqual([['drain-pump', 5]]);
    expect(contra(d)).toEqual(['filter-blockage', 'hose-or-waste-restriction', 'impeller-obstruction', 'pressure-or-level']);
    expect(d.leader).toMatchObject({ family: 'drain-pump', committed: true, level: 'component', component: 'drain-pump', margin: 5 });
    expect(d.partEvidence).toEqual({ sufficient: true, component: 'drain-pump', reasons: [] });
  });
  it('D09 hose blocked, cannot clear: HR 3 committed', () => {
    const d = run(F.check(fc(F.base()), 'drain-hose', 'done', 'found_not_cleared', 3));
    expect(scores(d)).toEqual([['hose-or-waste-restriction', 3], ['impeller-obstruction', 1], ['drain-pump', 1], ['pressure-or-level', 1]]);
    expect(d.leader).toMatchObject({ family: 'hose-or-waste-restriction', committed: true, level: 'cause_family' });
  });
  it('D10 water returns: HW 2 committed; DP contradicted', () => {
    const d = run(F.obs(F.base(), 'waterReturnsAfterDrain', true, 1));
    expect(scores(d)).toEqual([['household-waste-backflow', 2], ['filter-blockage', 0], ['impeller-obstruction', 0], ['hose-or-waste-restriction', 0], ['pressure-or-level', 0]]);
    expect(contra(d)).toEqual(['drain-pump']);
    expect(d.leader).toMatchObject({ family: 'household-waste-backflow', committed: true, level: 'cause_family' });
    expect(d.partEvidence.sufficient).toBe(false);
  });
  it('D11 drain command works, no clearance: PL 3 committed', () => {
    const d = run(F.obs(fc(F.base()), 'commandedDrain', true, 3));
    expect(scores(d)).toEqual([['pressure-or-level', 3], ['hose-or-waste-restriction', 0], ['drain-pump', 0]]);
    expect(contra(d)).toEqual(['filter-blockage', 'impeller-obstruction']);
    expect(d.leader).toMatchObject({ family: 'pressure-or-level', committed: true, level: 'cause_family' });
  });
  it('D12 drain command fails, hum unknown: IO HR DP 2', () => {
    const d = run(F.obs(fc(F.base()), 'commandedDrain', false, 3));
    expect(scores(d)).toEqual([['impeller-obstruction', 2], ['hose-or-waste-restriction', 2], ['drain-pump', 2]]);
    expect(contra(d)).toEqual(['filter-blockage', 'pressure-or-level']);
  });
  it('D13 pump silent, path clear: DP 3 not committed, HR 1, CT 1 runner-up eligible', () => {
    const s = fc(F.base());
    F.check(s, 'pump-impeller', 'done', 'clear', 3); F.obs(s, 'commandedDrain', false, 3); F.obs(s, 'pumpHumming', false, 3);
    const d = run(s);
    expect(scores(d)).toEqual([['drain-pump', 3], ['hose-or-waste-restriction', 1], ['control', 1]]);
    expect(contra(d)).toEqual(['filter-blockage', 'impeller-obstruction', 'pressure-or-level']);
    expect(d.leader).toMatchObject({ family: 'drain-pump', committed: false, level: 'cause_family' });
    expect(d.partEvidence.sufficient).toBe(false);
    expect(d.partEvidence.reasons).toContain('silent-pump-pump-or-control');
  });
  it('D14 pump code (Hotpoint F11), no checks: DP 2 leads, not committed; code is not permission', () => {
    const s = F.code(F.make(F.base(), 'hotpoint'), 'F11');
    const codeArea = D.codeAreaFor(s, require('../faults-catalogue.json').errorCodes);
    expect(codeArea).toBe('drain-pump');
    const d = run(s, { codeArea });
    expect(scores(d)).toEqual([['drain-pump', 2], ['filter-blockage', 1], ['impeller-obstruction', 1], ['hose-or-waste-restriction', 1], ['pressure-or-level', 1], ['control', 1]]);
    expect(d.leader).toMatchObject({ family: 'drain-pump', committed: false, margin: 1 });
    expect(d.partEvidence.sufficient).toBe(false);
    expect(d.partEvidence.reasons).toContain('code-is-support-only');
  });
  it('D15 model unavailable + strong pump evidence: diagnostics unchanged from D08', () => {
    const s = D08(); s.identity.modelStatus = 'unavailable';
    expect(run(s)).toEqual(run(D08()));
  });
  it('D16 part justified: model known, diagnostics as D08', () => {
    const d = run(F.model(D08(), 'WAN28281GB', 'bosch'));
    expect(d.leader).toMatchObject({ family: 'drain-pump', committed: true, level: 'component' });
    expect(d.partEvidence.sufficient).toBe(true);
  });
  it('D17 hums, impeller + hose unchecked: IO HR DP 3, IO leads, no part', () => {
    const s = fc(F.base()); F.obs(s, 'commandedDrain', false, 3); F.obs(s, 'pumpHumming', true, 3);
    const d = run(s);
    expect(scores(d)).toEqual([['impeller-obstruction', 3], ['hose-or-waste-restriction', 3], ['drain-pump', 3]]);
    expect(contra(d)).toEqual(['filter-blockage', 'pressure-or-level']);
    expect(d.partEvidence.sufficient).toBe(false);
  });
  it('D18 safety independence: identical to D08 with an active electrical_water hazard', () => {
    expect(run(F.hazard(D08(), 'electrical_water'))).toEqual(run(D08()));
  });
  it('D19 now drains normally: everything contradicted, noViableCause', () => {
    const s = F.obs(F.obs(F.base(), 'drainsNormally', true, 2), 'waterRemaining', false, 2);
    const d = run(s);
    expect(d.rank).toEqual([]);
    expect(contra(d)).toEqual(['drain-pump', 'filter-blockage', 'hose-or-waste-restriction', 'impeller-obstruction', 'pressure-or-level']);
    expect(d.leader).toBe(null);
    expect(d.noViableCause).toBe(true);
    expect(d.partEvidence.sufficient).toBe(false);
  });
  it('D20 excess foam, water retained: ES 2 leads, not committed (margin 1)', () => {
    const d = run(F.obs(F.base(), 'excessiveFoam', true, 1));
    expect(scores(d)).toEqual([['excess-suds', 2], ['filter-blockage', 1], ['impeller-obstruction', 1], ['hose-or-waste-restriction', 1], ['drain-pump', 1], ['pressure-or-level', 1]]);
    expect(d.leader).toMatchObject({ family: 'excess-suds', committed: false, margin: 1 });
  });
  it('D21 foam, rinse/spin drains: ES 3, PL 3 (tie -> ES), IO contradicted', () => {
    const d = run(F.obs(F.obs(F.base(), 'excessiveFoam', true, 1), 'commandedDrain', true, 2));
    expect(scores(d)).toEqual([['excess-suds', 3], ['pressure-or-level', 3], ['filter-blockage', 0], ['hose-or-waste-restriction', 0], ['drain-pump', 0]]);
    expect(contra(d)).toEqual(['impeller-obstruction']);
    expect(d.leader).toMatchObject({ family: 'excess-suds', committed: false });
  });
  it('D22 (A1) hose unreachable, hums, fails: DP 4 not committed, HR 3 live, no part', () => {
    const s = fc(F.base());
    F.check(s, 'pump-impeller', 'done', 'clear', 2); F.check(s, 'drain-hose', 'unable', null, 4);
    F.obs(s, 'commandedDrain', false, 3); F.obs(s, 'pumpHumming', true, 3);
    const d = run(s);
    expect(scores(d)).toEqual([['drain-pump', 4], ['hose-or-waste-restriction', 3]]);
    expect(d.rank[0].strongSupport).toBe(0);
    expect(contra(d)).toEqual(['filter-blockage', 'impeller-obstruction', 'pressure-or-level']);
    expect(d.leader).toMatchObject({ family: 'drain-pump', committed: false, level: 'cause_family', margin: 1 });
    expect(d.partEvidence.sufficient).toBe(false);
    expect(d.partEvidence.reasons).toContain('hose-unverified-alternative-live');
    expect(d.facts).not.toContain('hoseClear'); // unreachable is NOT clear
  });
  it('D23 (A1) hose unreachable, impeller damaged: DP 5 committed component (decisive impellerDamaged)', () => {
    const s = fc(F.base());
    F.check(s, 'pump-impeller', 'done', 'fault_seen', 2); F.check(s, 'drain-hose', 'unable', null, 4);
    F.obs(s, 'commandedDrain', false, 3); F.obs(s, 'pumpHumming', true, 3);
    const d = run(s);
    expect(scores(d)).toEqual([['drain-pump', 5], ['impeller-obstruction', 3], ['hose-or-waste-restriction', 3]]);
    expect(contra(d)).toEqual(['filter-blockage', 'pressure-or-level']);
    expect(d.leader).toMatchObject({ family: 'drain-pump', committed: true, level: 'component', margin: 2, decisive: 'impellerDamaged' });
    expect(d.partEvidence).toEqual({ sufficient: true, component: 'drain-pump', reasons: [] });
  });
});

describe('unit assertions (evidence doc §15)', () => {
  it('projection is pure: same state -> same facts; input not mutated; nothing written back', () => {
    const s = D08(); const snap = JSON.stringify(s);
    expect(D.evidenceFacts(s)).toEqual(D.evidenceFacts(JSON.parse(snap)));
    D.diagnose(s);
    expect(JSON.stringify(s)).toBe(snap);
  });
  it('pumpHumming=TRUE alone never yields strong support on DP', () => {
    const d = run(F.obs(F.base(), 'pumpHumming', true, 2));
    expect(d.rank.find((r) => r.family === 'drain-pump').strongSupport).toBe(0);
  });
  it('every *Clear result contradicts exactly its own family', () => {
    for (const [c, fam] of [['drain-filter', 'filter-blockage'], ['pump-impeller', 'impeller-obstruction'], ['drain-hose', 'hose-or-waste-restriction']]) {
      expect(contra(run(F.check(F.base(), c, 'done', 'clear', 2)))).toEqual([fam]);
    }
  });
  it('no family outside §3 ever appears', () => {
    const fams = new Set(Object.values(D.FAMILY));
    for (const s of [F.base(), D08(), D03()]) for (const r of run(s).rank) expect(fams.has(r.family)).toBe(true);
  });
  it('same-turn "cleared it and it drains now" counts as restored (not commanded-works/PL)', () => {
    const s = F.obs(F.check(F.base(), 'drain-filter', 'done', 'found_and_cleared', 2), 'commandedDrain', true, 2);
    const d = run(s);
    expect(d.likelyResolved).toBe(true);
    expect(d.facts).not.toContain('commandedDrainWorks');
  });
  it('drainsNormally after a clearance is restoration, not noViableCause', () => {
    const d = run(F.obs(D03(), 'drainsNormally', true, 3));
    expect(d.noViableCause).toBe(false);
    expect(d.likelyResolved).toBe(true);
  });
  it('re-stated failure after a later clearance orders after it (merge lastTurn)', () => {
    const s = F.obs(F.check(fc(F.base()), 'pump-impeller', 'done', 'found_and_cleared', 5), 'commandedDrain', false, 3);
    expect(run(s).facts).not.toContain('failsAfterImpellerClear');
    s.evidence.observations.commandedDrain.lastTurn = 6;
    expect(run(s).facts).toContain('failsAfterImpellerClear');
  });
  it('codeArea: drain-timeout codes vs pump-circuit codes; unknown make degrades', () => {
    const ec = require('../faults-catalogue.json').errorCodes;
    const at = (mk, c) => D.codeAreaFor(F.code(mk ? F.make(F.base(), mk) : F.base(), c), ec);
    expect(at('hotpoint', 'F05')).toBe('not-draining');
    expect(at('bosch', 'E23')).toBe('drain-pump');
    expect(at('lg', 'OE')).toBe('not-draining');
    expect(at('beko', 'H5')).toBe('drain-pump');
    expect(at('hotpoint', 'F06')).toBe(null);
    expect(at(null, 'F11')).toBe('not-draining'); // hotpoint pump vs miele drain -> weaker drain area
    expect(at(null, 'XYZ')).toBe(null);
  });
});

describe('engine equivalence with part-finder-lambda (_internal)', () => {
  it('scoreNodeEvidence and factConflict.contradicted match for every family over the D fixtures', () => {
    const states = [F.base(), D03(), D06(), D08(), F.obs(F.base(), 'waterReturnsAfterDrain', true, 1),
      F.obs(fc(F.base()), 'commandedDrain', true, 3), F.obs(F.base(), 'excessiveFoam', true, 1)];
    for (const s of states) {
      const facts = D.evidenceFacts(s);
      for (const key of Object.keys(D.SIGNALS)) {
        const node = { signals: Object.entries(D.SIGNALS[key]).map(([fact, effect]) => ({ fact, effect })) };
        expect(D.scoreNodeEvidence(node, facts)).toEqual(L.scoreNodeEvidence(node, facts));
        expect(D.factConflict(node, facts).contradicted).toBe(L.factConflict(node, facts).contradicted);
      }
    }
  });
  it('FALSE semantics match too (SS FALSE -2, SA FALSE +2)', () => {
    const node = { signals: [{ fact: 'a', effect: 'STRONG_SUPPORT' }, { fact: 'b', effect: 'STRONG_AGAINST' }] };
    const facts = [{ name: 'a', value: 'FALSE' }, { name: 'b', value: 'FALSE' }];
    expect(D.scoreNodeEvidence(node, facts)).toEqual(L.scoreNodeEvidence(node, facts));
    expect(D.factConflict(node, facts).contradicted).toBe(L.factConflict(node, facts).contradicted);
  });
});
