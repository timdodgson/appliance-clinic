'use strict';
/**
 * Journey 4 diagnostics — washing machine · water · not filling. PURE, deterministic.
 * Design: services/whichpart-api/docs/diagnostics/wm-batch-2-evidence.md §1.
 * Reads cs/1 only (+ the displayed-code faultId). No prose. Shared engine: evidence-engine.diagnoseSpec.
 */
const engine = require('./evidence-engine.js');
const { codeFaultFor } = require('./j2-diagnostics.js');
const { SS, S, A, SA } = engine;

const FAMILY = { SU: 'household-supply', TH: 'tap-or-fill-hose', MF: 'inlet-mesh-filter', DI: 'door-interlock', IV: 'inlet-valve', PC: 'pressure-or-control' };
const PRIOR = ['SU', 'TH', 'MF', 'DI', 'IV', 'PC'];
const SIGNALS = {
  SU: { supplyBad: SS, noWater: S, slow: S, supplyOk: SA, tapHoseFixed: A, oneProgramme: SA },
  TH: { supplyOk: S, tapHoseFixed: SS, fillHoseDamaged: SS, restoredAfterSupplyFix: SS, failsAfterSupplyFix: SA, noWater: S, slow: S, tapHoseOk: SA, oneProgramme: SA, supplyBad: A },
  MF: { supplyOk: S, meshCleaned: SS, restoredAfterMeshFix: SS, failsAfterMeshFix: SA, slow: SS, noWater: S, meshOk: SA, oneProgramme: SA, supplyBad: A, fillHoseDamaged: A, tapHoseFixed: A },
  DI: { doorNoLockChecked: SS, doorNoLock: S, noWater: S, doorLockOk: SA, slow: SA, oneProgramme: SA, fills: SA },
  IV: { oneProgramme: SS, noWater: S, supplyOk: S, tapHoseOk: S, meshOk: S, doorLockOk: S, codeFill: S, slow: A, supplyBad: A, doorNoLock: A, fillHoseDamaged: A, tapHoseFixed: A, meshCleaned: A },
  PC: { codePressure: SS, noWater: S, supplyOk: S, tapHoseOk: S, meshOk: S, doorLockOk: S, oneProgramme: A, supplyBad: A, doorNoLock: A, fillHoseDamaged: A, tapHoseFixed: A, meshCleaned: A },
};
const FACT_LABEL = {
  noWater: 'no water comes in', slow: 'fills only very slowly', fills: 'water comes in', supplyOk: 'household supply fine', supplyBad: 'household supply off / low',
  doorNoLock: 'door does not lock', doorNoLockChecked: 'door closed firmly and still does not lock', doorLockOk: 'door locks', oneProgramme: 'only some programmes fill',
  tapHoseOk: 'tap fully on and fill hose not kinked', tapHoseFixed: 'tap was off / hose kinked (fixed)', fillHoseDamaged: 'fill hose damaged',
  meshOk: 'inlet mesh clean', meshCleaned: 'inlet mesh blocked (cleaned)', codeFill: 'fill / inlet-valve error code', codePressure: 'pressure / level error code',
};
const SPEC = {
  schema: 'j4-diag/1', FAMILY, PRIOR, SIGNALS, FACT_LABEL,
  obs: { noWater: ['waterEntering', false], fills: ['waterEntering', true], slow: ['fillsSlowly', true], supplyOk: ['supplyOk', true], supplyBad: ['supplyOk', false],
    doorNoLock: ['doorLocks', false], doorLockOk: ['doorLocks', true] },
  checks: { 'inlet-hose-tap': { clear: 'tapHoseOk', found: 'tapHoseFixed', fault: 'fillHoseDamaged' }, 'inlet-filter': { clear: 'meshOk', found: 'meshCleaned' },
    'door-closed-latched': { done: 'doorClosedChecked' } },
  FIX_CHECK: { TH: ['inlet-hose-tap', 'Supply'], MF: ['inlet-filter', 'Mesh'] },
  DECISIVE_PART: { TH: { fillHoseDamaged: 'inlet-hose' }, DI: { doorNoLockChecked: 'door-lock' }, IV: { oneProgramme: 'inlet-valve' } },
  extra(s, ctx, on) {
    const p = (s.problems || []).filter((x) => x.status === 'active').pop();
    on('oneProgramme', Boolean(p && p.scope && p.scope.value === 'one_programme'));
    const lockOff = engine.obsVal(s, 'doorLocks') === false;
    on('doorNoLockChecked', lockOff && engine.checkDone(s, 'door-closed-latched'));
    on('codeFill', ['inlet-valve', 'flow-meter'].includes(ctx.codeFault));
    on('codePressure', ctx.codeFault === 'pressure-switch');
  },
  eligible(key, has) {
    if (key === 'SU') return has('supplyBad');
    if (key === 'DI') return has('doorNoLock') || has('doorClosedChecked');
    return true;
  },
};
function diagnose(state, ctx = {}) {
  const codeFault = ctx.codeFault !== undefined ? ctx.codeFault : codeFaultFor(state, ctx.errorCodes || null);
  return engine.diagnoseSpec(SPEC, state, { ...ctx, codeFault });
}
module.exports = { SPEC, FAMILY, diagnose };
