/**
 * Journey 8 (wm-noisy): diagnostics, policy, part gate, COMPOSE contract, routing / gate, and the Journey 1 / 2
 * overlaps. Expectations from wm-batch-2-evidence.md §5 ("noise" alone never reaches bearings).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
globalThis.awslambda = globalThis.awslambda || { streamifyResponse: (f) => f, HttpResponseStream: { from: (s) => s } };
const H = require('./helpers/b2-journey.cjs');
const J = require('../canonical/j8-pipeline.js');
const J1 = require('../canonical/j1-pipeline.js');
const P = require('../canonical/j8-policy.js');
const JC = require('../canonical/j8-compose.js');
const L = require('../part-finder-lambda.js')._internal;
const { C, O, K } = H;

const op = (obs = [], identity = {}) => H.opener('noisy', 'noise', obs, {}, identity);
const MP = [{ title: 'Askoll Drain Pump' }, { title: 'Copreci Pump Filter Kit' }, { title: 'Elastic Poly-Vee Belt 1270 J5' }];
const SEQ = {
  coin: [op([O('noiseOnDrain'), O('rattlingNoise')]), C({ checks: [K('drain-filter', 'done', 'found_and_cleared')] }), C({ observations: [O('faultPersists', false)] })],
  impeller: [op([O('noiseOnDrain'), O('grindingNoise')]), C({ checks: [K('drain-filter', 'done', 'clear')] }), C({ checks: [K('pump-impeller', 'done', 'fault_seen')] }), H.model()],
  braStuck: [op([O('scrapingNoise'), O('noiseOnWash')]), C({ checks: [K('drum-foreign-object', 'done', 'found_not_cleared')] })],
  braRemoved: [op([O('scrapingNoise'), O('noiseOnWash')]), C({ checks: [K('drum-foreign-object', 'done', 'found_and_cleared')] }), C({ observations: [O('faultPersists', false)] })],
  bearing: [op([O('grindingNoise'), O('noiseOnSpin')]), C({ checks: [K('drum-by-hand', 'done', 'fault_seen')] }), C({ observations: [O('drumPlay')] }), H.model()],
  grindOnly: [op([O('grindingNoise'), O('noiseOnSpin')]), C({ checks: [K('drum-by-hand', 'done', 'clear')] }), C({ observations: [O('drumPlay', false)] })],
  knockNew: [op([O('knockingNoise'), O('noiseOnSpin')]), C({ observations: [O('recentInstallation')] }), C({ checks: [K('transit-bolts', 'done', 'found_and_cleared')] }), C({ observations: [O('faultPersists', false)] })],
  fillHum: [op([O('humNoise'), O('noiseOnFill')])],
  vague: [op(), C({ reply: { toPending: 'cannot_answer' } }), C({ reply: { toPending: 'cannot_answer' } })],
  squealLg: [op([O('squealNoise'), O('noiseOnSpin')], { make: { value: 'lg', basis: 'stated' } }), C({ checks: [K('drum-by-hand', 'done', 'clear')] }), C({ checks: [K('drive-belt', 'done', 'fault_seen')] })],
  beltSeen: [op([O('squealNoise'), O('noiseOnSpin')]), C({ checks: [K('drum-by-hand', 'done', 'clear'), K('drive-belt', 'done', 'fault_seen')] }), C({}), H.model('WMB81445LW', 'beko')],
  drainWater: [op([O('noiseOnDrain'), O('waterRemaining')])],
};
const run = (k) => H.play(J, SEQ[k], { modelParts: MP });

describe('diagnostics', () => {
  it('"noise" with no typed evidence → no leader (never bearings)', () => { expect(H.play(J, [op()]).prep.diag.leader).toBe(null); });
  it('grinding on spin, smooth by hand, firm drum → no bearing commit', () => {
    const d = run('grindOnly').prep.diag;
    expect(d.leader === null || d.leader.family !== 'drum-bearings' || d.leader.committed === false).toBe(true);
  });
  it('rough by hand + loose drum + grinding on spin → bearings committed (cause family, no part)', () => {
    expect(run('bearing').prep.diag.leader).toMatchObject({ family: 'drum-bearings', committed: true, level: 'cause_family' });
  });
  it('drain noise + impeller broken → drain pump component; direct drive makes the belt impossible', () => {
    expect(run('impeller').prep.diag.leader).toMatchObject({ family: 'drain-pump-worn', component: 'drain-pump' });
    const d = run('squealLg').prep.diag;
    expect(d.architecture.drive).toBe('direct');
    expect(d.rank.map((r) => r.family)).not.toContain('belt-pulley-or-motor');
  });
});

describe('policy', () => {
  it('drain rattle → pump filter → coin cleared → retest → likely fixed', () => { expect(run('coin').rules).toEqual(['N12:drain-filter', 'N6:retest', 'N7:pump-obstruction']); });
  it('drain grind → filter clear → impeller broken → model → drain pump part', () => { expect(run('impeller').rules).toEqual(['N12:drain-filter', 'N13:pump-impeller', 'N20:model', 'N21:drain-pump']); });
  it('scrape → drum object check → stuck → engineer (no retest, no part); removed → retest → likely fixed', () => {
    const s = run('braStuck');
    expect(s.rules).toEqual(['N14:drum-foreign-object', 'N22:foreign-object']);
    expect(s.last.conclusion).toMatchObject({ handoff: 'engineer', noPart: true });
    expect(run('braRemoved').rules).toEqual(['N14:drum-foreign-object', 'N6:retest', 'N7:foreign-object']);
  });
  it('bearing path → hand rotation → drum play → engineer conclusion, never a part', () => {
    const r = run('bearing');
    expect(r.rules).toEqual(['N18:drum-by-hand', 'N19:drum-play', 'N22:drum-bearings', 'N22:drum-bearings']);
    expect(r.last.conclusion).toMatchObject({ noPart: true, handoff: 'engineer' });
  });
  it('knock on spin on a new machine → installed? → transit bolts → retest → likely fixed', () => {
    expect(run('knockNew').rules).toEqual(['N15:recentInstallation', 'N16:transit-bolts', 'N6:retest', 'N7:load-or-installation']);
  });
  it('hum only while filling → normal operating noise, no part', () => { expect(run('fillHum').last).toMatchObject({ kind: 'conclude', target: 'normal-operating-noise', conclusion: { noPart: true } }); });
  // GOLD v2 remediation: "not sure" twice ends with the usual causes, most likely first (engineer), not a bare "unconfirmed"
  it('vague → WHEN → TYPE → usual causes, engineer (no loop)', () => { expect(run('vague').rules).toEqual(['N10:noiseTiming', 'N11:noiseType', 'N22:likely-causes']); expect(run('vague').last.conclusion.handoff).toBe('engineer'); });
  it('drain noise with water left in the drum → Journey 1 owns it', () => {
    expect(run('drainWater').prep.entry).toMatchObject({ applies: false, drainOwned: true });
    expect(H.play(J1, SEQ.drainWater).last.rule).toMatch(/^R/);
  });
});

describe('part gate', () => {
  it('belt seen on a belt-drive model → belt part; on a direct-drive (LG) → never', () => {
    expect(run('beltSeen').last).toMatchObject({ kind: 'recommend_part', target: 'drive-belt' });
    expect(run('squealLg').last.kind).not.toBe('recommend_part');
  });
  it('drain-pump matcher never takes the pump FILTER', () => {
    expect(J.partLookupFrom(MP, 'drain-pump').parts.map((p) => p.title)).toEqual(['Askoll Drain Pump']);
  });
});

describe('COMPOSE contract', () => {
  it('every action reached obeys the contract', () => {
    const seen = Object.keys(SEQ).flatMap((k) => run(k).actions);
    expect(H.composeProblems(JC, P, seen)).toEqual([]);
  });
});

afterEach(() => { delete process.env.CANONICAL_J8_CONTROL; });
describe('routing / gate', () => {
  const { emptyState } = require('../canonical/cs1.js'); const { merge } = require('../canonical/merge.js');
  const T = (cs) => { let s = emptyState('cs_' + 'b'.repeat(32)); for (const c of cs) s = merge(s, c, { turn: s.version + 1 }).state; return { schema: 'cs/1', mode: 'control', sessionId: s.sessionId, priorVersion: s.version - 1, version: s.version, state: s, classification: cs[cs.length - 1], rulesFired: [], requestOutcome: null, degraded: null }; };
  const B = (journeys) => ({ schema: 'cs/1', mode: 'control', control: { journeys }, sessionId: 'x', version: 0, state: null, degraded: null });
  it('own gate key; retained water → Journey 1; kill switch', async () => {
    expect((await L.canonicalJourneys(T([op([O('noiseOnSpin')])]), B(['wm-noisy']))).journey).toMatchObject({ key: 'wm-noisy', control: true });
    expect((await L.canonicalJourneys(T(SEQ.drainWater), B(['wm-not-draining', 'wm-noisy']))).journey.key).toBe('wm-not-draining');
    process.env.CANONICAL_J8_CONTROL = '0';
    expect((await L.canonicalJourneys(T([op([O('noiseOnSpin')])]), B(['wm-noisy']))).journey.control).toBe(false);
  });
});
