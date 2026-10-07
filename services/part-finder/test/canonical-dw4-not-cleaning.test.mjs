/** Dishwasher journey 4 (dw-not-cleaning): diagnostics, policy, part gate, COMPOSE contract, routing / handoffs. */
import { describe, it, expect, afterEach } from 'vitest';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
globalThis.awslambda = globalThis.awslambda || { streamifyResponse: (f) => f, HttpResponseStream: { from: (s) => s } };
const H = require('./helpers/b2-journey.cjs');
const J = require('../canonical/dw4-not-cleaning.js');
const L = require('../part-finder-lambda.js')._internal;
const { C, O, K } = H;

const op = (obs = []) => H.dwOpener('poor-results', 'results', obs);
const MP = [{ title: 'Lower Spray Arm' }, { title: 'Detergent Dispenser' }, { title: 'UPPER SPRAY ARM FEED PIPE' }];
const m = () => H.model('DW1TEST', 'hotpoint');
const allClear = [C({ checks: [K('dishwasher-filter', 'done', 'clear')] }), C({ checks: [K('spray-arms', 'done', 'clear')] }), C({ checks: [K('loading-clearance', 'done', 'clear')] }),
  C({ observations: [O('tabletUndissolved', false)] })];
const SEQ = {
  jets: [op([O('poorUpperRack')]), C({ checks: [K('dishwasher-filter', 'done', 'clear')] }), C({ checks: [K('spray-arms', 'done', 'found_and_cleared')] }), C({ observations: [O('faultPersists', false)] })],
  filter: [op([O('poorAllRacks')]), C({ checks: [K('dishwasher-filter', 'done', 'found_and_cleared')] }), C({ observations: [O('faultPersists', false)] }), C({ reply: { toPending: 'answered', outcome: 'resolved' } })],
  loading: [op([O('poorLowerRack')]), C({ checks: [K('dishwasher-filter', 'done', 'clear')] }), C({ checks: [K('spray-arms', 'done', 'clear')] }), C({ checks: [K('loading-clearance', 'done', 'found_and_cleared')] }), C({ observations: [O('faultPersists', false)] })],
  circulation: [op([O('poorAllRacks')]), ...allClear, C({ observations: [O('heatPresent')] }), C({ observations: [O('waterEntering')] }), C({ checks: [K('programme-setting', 'done', 'clear')] }), m()],
  noHeat: [op([O('poorAllRacks')]), ...allClear, C({ observations: [O('noHeat')] })],
  lowFill: [op([O('poorAllRacks')]), ...allClear, C({ observations: [O('heatPresent')] }), C({ observations: [O('fillsSlowly')] })],
  dispenser: [op([O('poorAllRacks'), O('tabletUndissolved')]), C({ checks: [K('dishwasher-filter', 'done', 'clear')] }), C({ checks: [K('spray-arms', 'done', 'clear')] }), C({ checks: [K('loading-clearance', 'done', 'clear')] }), C({ checks: [K('dw-dispenser', 'done', 'fault_seen')] }), m()],
  armBroken: [op([O('poorLowerRack')]), C({ checks: [K('dishwasher-filter', 'done', 'clear')] }), C({ checks: [K('spray-arms', 'done', 'fault_seen')] }), m()],
  programme: [op([O('poorAllRacks')]), ...allClear, C({ observations: [O('heatPresent')] }), C({ observations: [O('waterEntering')] }), C({ checks: [K('programme-setting', 'done', 'found_and_cleared')] }), C({ observations: [O('faultPersists', false)] })],
  sparse: [op(), C({ reply: { toPending: 'cannot_answer' } }), C({ checks: [K('dishwasher-filter', 'unable')] }), C({ reply: { toPending: 'cannot_answer' } }), C({ reply: { toPending: 'cannot_answer' } }),
    C({ reply: { toPending: 'cannot_answer' } }), C({ reply: { toPending: 'cannot_answer' } }), C({ reply: { toPending: 'cannot_answer' } }), C({ reply: { toPending: 'cannot_answer' } })],
};
const run = (k) => H.play(J, SEQ[k], { modelParts: MP });

describe('diagnostics', () => {
  it('blocked jets / dirty filter / loading / programme are no-part families', () => {
    expect(run('jets').prep.diag).toMatchObject({ likelyResolved: true, leader: { family: 'spray-arm-jets' } });
    expect(run('loading').prep.diag.leader.family).toBe('loading');
    expect(run('programme').prep.diag.leader.family).toBe('programme-choice');
  });
  it('everything accessible clear + hot + fills → circulation / distribution AREA, no component', () => {
    const d = run('circulation').prep.diag;
    expect(d.leader).toMatchObject({ family: 'circulation-or-distribution', level: 'cause_family' });
    expect(d.partEvidence.sufficient).toBe(false);
  });
});
describe('policy', () => {
  it('top rack → filter → arms → jets cleared → retest → likely fixed', () => { expect(run('jets').rules).toEqual(['C11:dishwasher-filter', 'C12:spray-arms', 'C6:retest', 'C7:spray-arm-jets']); });
  it('dirty filter → retest → likely fixed → confirmed', () => { expect(run('filter').rules).toEqual(['C11:dishwasher-filter', 'C6:retest', 'C7:dirty-filter', 'C2:dirty-filter']); });
  it('full path → circulation area conclusion (engineer, no part) even with a model', () => {
    const r = run('circulation');
    expect(r.rules).toEqual(['C11:dishwasher-filter', 'C12:spray-arms', 'C13:loading-clearance', 'C14:tabletUndissolved', 'C16:heatState', 'C17:fillState', 'C18:programme-setting',
      'C22:circulation-or-distribution', 'C22:circulation-or-distribution']);
    expect(r.last.conclusion).toMatchObject({ handoff: 'engineer', noPart: true });
  });
  it('cold water hands the problem to heating; a poor fill hands it to filling (this journey stops applying)', () => {
    expect(run('noHeat').prep.entry).toMatchObject({ applies: false, drainOwned: true });
    expect(run('lowFill').prep.entry).toMatchObject({ applies: false, drainOwned: true });
  });
  it('cannot / unable throughout → concludes (no loop)', () => { expect(run('sparse').rules.slice(-1)[0]).toMatch(/^C22:/); });
});
describe('part gate', () => {
  it('broken arm / dispenser flap → part only when listed; feed pipe never matches a spray arm', () => {
    expect(run('armBroken').last).toMatchObject({ kind: 'recommend_part', target: 'spray-arm' });
    expect(run('dispenser').last).toMatchObject({ kind: 'recommend_part', target: 'dispenser' });
    expect(J.partLookupFrom(MP, 'spray-arm').parts.map((p) => p.title)).toEqual(['Lower Spray Arm']);
    expect(J.P.partGate(run('circulation').state, run('circulation').prep.diag, { available: true, component: 'circulation-pump' }).eligible).toBe(false);
  });
});
describe('COMPOSE contract', () => {
  it('every action reached obeys the contract; filter / spray-arm steps carry media', () => {
    const seen = Object.keys(SEQ).flatMap((k) => run(k).actions);
    expect(H.composeProblems(J, J.P, seen)).toEqual([]);
    expect(J.mediaFor(run('jets').actions[1].action)).toMatchObject({ ids: ['dishwasher-spray-arm'] });
  });
});
afterEach(() => { delete process.env.CANONICAL_DW4_CONTROL; });
describe('routing / handoffs', () => {
  it('own gate; poor cleaning + cold → dw-not-heating-drying (once); kill switch', async () => {
    const all = ['dw-not-cleaning', 'dw-not-heating-drying', 'dw-not-filling', 'dw-leaking'];
    expect((await H.routeWith(L, [op([O('poorUpperRack')])], all)).journey).toMatchObject({ key: 'dw-not-cleaning', control: true, nextAction: { rule: 'C11' } });
    expect((await H.routeWith(L, SEQ.noHeat, all)).journey).toMatchObject({ key: 'dw-not-heating-drying', control: true });
    process.env.CANONICAL_DW4_CONTROL = '0';
    expect((await H.routeWith(L, [op([O('poorUpperRack')])], all)).journey.control).toBe(false);
  });
});
