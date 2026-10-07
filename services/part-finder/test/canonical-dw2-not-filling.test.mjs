/** Dishwasher journey 2 (dw-not-filling): diagnostics, policy, part gate, COMPOSE contract, routing / handoffs. */
import { describe, it, expect, afterEach } from 'vitest';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
globalThis.awslambda = globalThis.awslambda || { streamifyResponse: (f) => f, HttpResponseStream: { from: (s) => s } };
const H = require('./helpers/b2-journey.cjs');
const J = require('../canonical/dw2-not-filling.js');
const L = require('../part-finder-lambda.js')._internal;
const { C, O, K } = H;

const op = (obs = [], id = {}) => H.dwOpener('not-filling', 'water', [O('waterEntering', false), ...obs], {}, id);
const MP = [{ title: 'Single Solinoid Valve' }, { title: 'Door Lock Complete' }];
const m = () => H.model('HFE1B19', 'hotpoint');
const clear = [C({ observations: [O('supplyOk')] }), C({ observations: [O('waterInBase', false)] }), C({ observations: [O('doorRecognised')] }),
  C({ checks: [K('inlet-hose-tap', 'done', 'clear')] }), C({ checks: [K('inlet-filter', 'done', 'clear')] })];
const SEQ = {
  allClear: [op(), ...clear, m()],
  code: [op([], { make: { value: 'hotpoint', basis: 'stated' }, displayedCode: 'F02' }), ...clear, m()],
  codeNoModel: [op([], { make: { value: 'hotpoint', basis: 'stated' }, displayedCode: 'F02' }), ...clear, H.noModel()],
  supply: [op(), C({ observations: [O('supplyOk', false)] })],
  kink: [op(), C({ observations: [O('supplyOk')] }), C({ observations: [O('waterInBase', false)] }), C({ observations: [O('doorRecognised')] }), C({ checks: [K('inlet-hose-tap', 'done', 'found_and_cleared')] }), C({ observations: [O('faultPersists', false)] })],
  mesh: [H.dwOpener('not-filling', 'water', [O('fillsSlowly')]), C({ observations: [O('supplyOk')] }), C({ observations: [O('waterInBase', false)] }), C({ checks: [K('inlet-hose-tap', 'done', 'clear')] }), C({ checks: [K('inlet-filter', 'done', 'found_and_cleared')] }), C({ observations: [O('faultPersists', false)] })],
  door: [op(), C({ observations: [O('supplyOk')] }), C({ observations: [O('waterInBase', false)] }), C({ observations: [O('doorRecognised', false)] }), C({ observations: [O('doorRecognised', false)] }), H.model('HFC3C26W', 'hotpoint')],
  aquastop: [op(), C({ observations: [O('supplyOk')] }), C({ observations: [O('waterInBase', false)] }), C({ observations: [O('doorRecognised')] }), C({ checks: [K('inlet-hose-tap', 'done', 'fault_seen')] }), m()],
  flood: [op(), C({ observations: [O('supplyOk')] }), C({ observations: [O('waterInBase')] })],
  cannot: [op(), C({ reply: { toPending: 'cannot_answer' } }), C({ reply: { toPending: 'cannot_answer' } }), C({ reply: { toPending: 'cannot_answer' } }), C({ reply: { toPending: 'cannot_answer' } }), C({ reply: { toPending: 'cannot_answer' } })],
};
const run = (k) => H.play(J, SEQ[k], { modelParts: MP });

describe('diagnostics', () => {
  it('no water + everything accessible clear, no code → inlet valve only possible (no component)', () => {
    expect(run('allClear').prep.diag.leader).toMatchObject({ family: 'inlet-valve', level: 'cause_family' });
  });
  it('+ fill error code + dry base → inlet valve component (decisive)', () => { expect(run('code').prep.diag.leader).toMatchObject({ family: 'inlet-valve', component: 'inlet-valve' }); });
  it('AquaStop red → tap-hose-or-aquastop component inlet-hose; door not recognised after shutting firmly → door-lock', () => {
    expect(run('aquastop').prep.diag.leader).toMatchObject({ family: 'tap-hose-or-aquastop', component: 'inlet-hose' });
    expect(run('door').prep.diag.leader).toMatchObject({ family: 'door-not-recognised', component: 'door-lock' });
  });
});
describe('policy', () => {
  it('supply → flood check → door → tap / hose / AquaStop → mesh → possible valve, engineer, no part', () => {
    const r = run('allClear');
    expect(r.rules).toEqual(['B11:supplyOk', 'B12:waterInBase', 'B13:doorRecognised', 'B15:inlet-hose-tap', 'B16:inlet-filter', 'B22:inlet-valve', 'B22:inlet-valve']);
    expect(r.last.conclusion).toMatchObject({ handoff: 'engineer', noPart: true });
  });
  it('household supply → plumbing; kinked hose / blocked mesh → retest → likely fixed', () => {
    expect(run('supply').last).toMatchObject({ rule: 'B5', conclusion: { handoff: 'plumbing', noPart: true } });
    expect(run('kink').last.rule).toBe('B7');
    expect(run('mesh').last).toMatchObject({ rule: 'B7', target: 'inlet-mesh-filter' });
  });
  it('anti-flood: water in the base → this journey stops applying; dw-leaking owns it', () => {
    const r = run('flood');
    expect(r.prep.entry).toMatchObject({ applies: false, drainOwned: true });
  });
  it('cannot answer anything → concludes (no loop, nothing asked twice)', () => {
    const r = run('cannot');
    expect(r.rules.slice(-1)[0]).toMatch(/^B22:/);
    const n = {}; for (const q of r.state.requests) n[q.target] = (n[q.target] || 0) + 1;
    for (const v of Object.values(n)) expect(v).toBeLessThanOrEqual(2);
  });
});
describe('part gate', () => {
  it('fill code path + model + valve listed → inlet valve; model unavailable → no part; no code → never', () => {
    expect(run('code').last).toMatchObject({ kind: 'recommend_part', target: 'inlet-valve', rule: 'B21' });
    expect(run('codeNoModel').last.kind).toBe('conclude');
    expect(run('allClear').last.kind).toBe('conclude');
  });
  it('door not recognised + model + door lock listed → door lock; AquaStop red + no hose listed → conclude component', () => {
    expect(run('door').last).toMatchObject({ kind: 'recommend_part', target: 'door-lock' });
    expect(run('aquastop').last).toMatchObject({ kind: 'conclude', conclusion: { component: 'inlet-hose' } });
  });
  it('valve matcher accepts the catalogue spelling "Solinoid", not a drain item', () => {
    expect(J.partLookupFrom([{ title: 'Single Solinoid Valve' }, { title: 'Drain Hose' }], 'inlet-valve').parts.map((p) => p.title)).toEqual(['Single Solinoid Valve']);
  });
});
describe('COMPOSE contract', () => {
  it('every action reached obeys the contract', () => {
    const seen = Object.keys(SEQ).flatMap((k) => run(k).actions);
    expect(H.composeProblems(J, J.P, seen)).toEqual([]);
  });
});
afterEach(() => { delete process.env.CANONICAL_DW2_CONTROL; });
describe('routing / handoffs', () => {
  it('own gate; not filling + water in base → dw-leaking; poor cleaning + low fill → dw-not-filling; kill switch', async () => {
    const all = ['dw-not-filling', 'dw-leaking', 'dw-not-cleaning'];
    expect((await H.routeWith(L, [op()], all)).journey).toMatchObject({ key: 'dw-not-filling', control: true });
    expect((await H.routeWith(L, [op([O('waterInBase')])], all)).journey).toMatchObject({ key: 'dw-leaking', control: true });
    expect((await H.routeWith(L, [H.dwOpener('poor-results', 'results', [O('poorAllRacks'), O('fillsSlowly')])], all)).journey.key).toBe('dw-not-filling');
    process.env.CANONICAL_DW2_CONTROL = '0';
    expect((await H.routeWith(L, [op()], all)).journey.control).toBe(false);
  });
});
