/** Dishwasher journey 3 (dw-leaking, incl. anti-flood): diagnostics, policy, part gate, COMPOSE contract, routing / ownership. */
import { describe, it, expect, afterEach } from 'vitest';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
globalThis.awslambda = globalThis.awslambda || { streamifyResponse: (f) => f, HttpResponseStream: { from: (s) => s } };
const H = require('./helpers/b2-journey.cjs');
const J = require('../canonical/dw3-leaking.js');
const L = require('../part-finder-lambda.js')._internal;
const { C, O, K } = H;

const op = (obs = [], journey = 'leaking') => H.dwOpener(journey, 'water', obs);
const MP = [{ title: 'Door Seal' }, { title: 'Drain Hose' }];
const m = () => H.model('DW1TEST', 'hotpoint');
const SEQ = {
  seal: [op([O('leakAtDoor')]), C({ observations: [O('wrongDetergent', false)] }), C({ checks: [K('door-seal', 'done', 'fault_seen')] }), m()],
  foam: [op([O('leakAtDoor'), O('excessiveFoam')]), C({ observations: [O('wrongDetergent')] })],
  inlet: [op([O('leakAtRear'), O('leaksOnFill')]), C({ checks: [K('inlet-connection', 'done', 'found_and_cleared')] }), C({ observations: [O('faultPersists', false)] })],
  drainSplit: [op([O('leakAtRear'), O('leaksOnDrain')]), C({ checks: [K('drain-connection', 'done', 'fault_seen')] }), m()],
  base: [op([O('leakUnderneath')]), C({ observations: [O('leaksOnWash')] }), C({ observations: [O('waterInBase')] }), C({ checks: [K('inlet-connection', 'done', 'clear')] }), C({ checks: [K('drain-connection', 'done', 'clear')] }), m()],
  nfFlood: [op([O('waterEntering', false), O('waterInBase')], 'not-filling'), C({ checks: [K('inlet-connection', 'done', 'clear')] }), C({ checks: [K('drain-connection', 'done', 'clear')] })],
  pumping: [op([O('pumpRunsContinuously')], 'wont-start'), C({ checks: [K('inlet-connection', 'done', 'clear')] }), C({ checks: [K('drain-connection', 'done', 'clear')] })],
  major: [op([O('leakUnderneath'), O('majorLeak')]), C({ observations: [O('leaksOnFill')] })],
  socket: [op([O('leakUnderneath')]), C({ safety: { hazard: 'electrical_water' } }), C({})],
  loading: [op([O('leakAtDoor'), O('leaksOnWash')]), C({ observations: [O('wrongDetergent', false)] }), C({ checks: [K('door-seal', 'done', 'clear')] }), C({ checks: [K('loading-clearance', 'done', 'found_and_cleared')] }), C({ observations: [O('faultPersists', false)] })],
  sparse: [op(), C({ reply: { toPending: 'cannot_answer' } }), C({ reply: { toPending: 'cannot_answer' } })],
};
const run = (k) => H.play(J, SEQ[k], { modelParts: MP });

describe('diagnostics', () => {
  it('torn door seal → door-seal component; split drain hose → drain-hose component', () => {
    expect(run('seal').prep.diag.leader).toMatchObject({ family: 'door-seal', component: 'door-seal' });
    expect(run('drainSplit').prep.diag.leader).toMatchObject({ family: 'drain-connection', component: 'drain-hose' });
  });
  it('water in the base with hoses / door fine → internal leak area (no component; never the inlet valve)', () => {
    const d = run('base').prep.diag;
    expect(d.leader).toMatchObject({ family: 'internal-leak', level: 'cause_family' });
    expect(d.partEvidence.sufficient).toBe(false);
  });
});
describe('policy', () => {
  it('door leak → detergent? → seal torn → model → door seal part', () => { expect(run('seal').rules).toEqual(['K12:wrongDetergent', 'K13:door-seal', 'K20:model', 'K21:door-seal']); });
  it('washing-up liquid → foam conclusion, no part', () => { expect(run('foam').last).toMatchObject({ rule: 'K5', conclusion: { noPart: true } }); });
  it('loose inlet connection → retest → likely fixed (installation, no part); loading deflects spray → likely fixed', () => {
    expect(run('inlet').rules).toEqual(['K16:inlet-connection', 'K6:retest', 'K7:inlet-connection']);
    expect(run('loading').last).toMatchObject({ rule: 'K7', target: 'loading-or-spray-escape' });
  });
  it('base tray → hoses → internal leak, engineer, no part (even with a model)', () => {
    const r = run('base');
    expect(r.rules).toEqual(['K11:leakTiming', 'K15:waterInBase', 'K16:inlet-connection', 'K17:drain-connection', 'K22:internal-leak', 'K22:internal-leak']);
    expect(r.last.conclusion).toMatchObject({ handoff: 'engineer', noPart: true });
  });
  it('anti-flood presenting as NOT FILLING or NOT STARTING (continuous pump) is owned here once', () => {
    expect(run('nfFlood').actions[0].prep.entry.applies).toBe(true);
    expect(run('nfFlood').last).toMatchObject({ target: 'internal-leak' });
    expect(run('pumping').rules).toEqual(['K16:inlet-connection', 'K17:drain-connection', 'K22:internal-leak']);
  });
  it('large leak → containment once; water at the socket → sticky safety stop', () => {
    const r = run('major');
    expect(r.rules[0]).toBe('K1:major-leak');
    expect(r.rules[1]).not.toMatch(/^K1:/);
    expect(run('socket').rules.slice(1)).toEqual(['K1:electrical_water', 'K1:electrical_water']);
  });
  // GOLD v2 remediation: "not sure" twice ends with the usual causes, most likely first (engineer), not a bare "unconfirmed"
  it('sparse → location → base tray → usual causes, engineer', () => { expect(run('sparse').rules).toEqual(['K10:dwLeakLocation', 'K15:waterInBase', 'K22:likely-causes']); expect(run('sparse').last.conclusion.handoff).toBe('engineer'); });
});
describe('part gate', () => {
  it('internal / flood never yields a part; drain hose split + model + listed → drain hose', () => {
    expect(J.P.partGate(run('base').state, run('base').prep.diag, { available: true, component: 'inlet-valve' }).failed).toContain('K4-evidence-insufficient');
    expect(run('drainSplit').last).toMatchObject({ kind: 'recommend_part', target: 'drain-hose' });
  });
});
describe('COMPOSE contract', () => {
  it('every action reached obeys the contract; flood copy explains the float and says no tilting / no inlet valve', () => {
    const seen = Object.keys(SEQ).flatMap((k) => run(k).actions);
    expect(H.composeProblems(J, J.P, seen)).toEqual([]);
    const r = run('base');
    expect(J.template(J.brief(r.state, r.last, null, {}))).toMatch(/flood protection[\s\S]*don't tip[\s\S]*inlet valve won't fix/);
  });
});
afterEach(() => { delete process.env.CANONICAL_DW3_CONTROL; });
describe('routing / ownership', () => {
  it('owns flood from any dishwasher journey; a washing-machine leak stays Journey 3; kill switch', async () => {
    const dw = ['dw-leaking', 'dw-not-filling', 'dw-door-not-starting', 'dw-not-draining'];
    for (const j of ['not-filling', 'wont-start', 'door-problem', 'not-draining']) {
      expect((await H.routeWith(L, [op([O('waterInBase')], j)], dw)).journey).toMatchObject({ key: 'dw-leaking', control: true });
    }
    expect((await H.routeWith(L, [H.opener('leaking', 'water', [O('leakAtDoor')])], ['wm-leaking', 'dw-leaking'])).journey.key).toBe('wm-leaking');
    process.env.CANONICAL_DW3_CONTROL = '0';
    expect((await H.routeWith(L, [op([O('leakAtDoor')])], dw)).journey.control).toBe(false);
  });
});
