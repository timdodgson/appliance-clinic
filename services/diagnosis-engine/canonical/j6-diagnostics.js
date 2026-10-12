'use strict';
/**
 * Journey 6 diagnostics — washing machine · door (won't open / won't lock / won't close / handle / clicking). PURE.
 * Design: docs/diagnostics/wm-batch-2-evidence.md §3. Retained water keeping the door locked is Journey 1 (the
 * policy entry hands it over); here: normal release delay, child lock, handle / catch, door lock, level sensing / control.
 */
const engine = require('./evidence-engine.js');
const { codeFaultFor } = require('./j2-diagnostics.js');
const { SS, S, A, SA } = engine;

const FAMILY = { DY: 'normal-release-delay', CL: 'child-lock', CH: 'handle-or-catch', DL: 'door-lock', PS: 'level-sensing-or-control' };
const PRIOR = ['DY', 'CL', 'CH', 'DL', 'PS'];
const SIGNALS = {
  DY: { opensAfterWait: SS, wontOpen: S, stillLockedAfterWait: SA, handleBroken: SA, noLock: SA, wontClose: SA },
  CL: { childLockOff: SS, restoredAfterChildLockFix: SS, failsAfterChildLockFix: SA, childLockOk: SA, wontOpen: S, handleBroken: A, wontClose: SA },
  CH: { handleBroken: SS, catchBroken: SS, catchCleared: SS, restoredAfterCatchFix: SS, failsAfterCatchFix: SA, wontClose: S, wontOpen: S, clicking: S, catchOk: SA, opensAfterWait: SA },
  DL: { noLockChecked: SS, clicking: SS, codeDoor: SS, noLock: S, stillLockedAfterWait: S, catchOk: S, childLockOk: S, opensAfterWait: SA, handleBroken: A, wontClose: A },
  PS: { stillLockedAfterWait: S, noWaterIn: S, childLockOk: S, codePressure: SS, opensAfterWait: SA, noLock: SA, wontClose: SA, handleBroken: A },
};
const FACT_LABEL = {
  wontOpen: 'door will not open', opens: 'door opens', noLock: 'door does not lock', locks: 'door locks', wontClose: 'door will not close / latch',
  handleBroken: 'handle broken', clicking: 'lock keeps clicking', noWaterIn: 'no water in the drum', opensAfterWait: 'opened after waiting / power off',
  stillLockedAfterWait: 'still locked after waiting and switching off', childLockOff: 'child lock was on (turned off)', childLockOk: 'child lock not on',
  noLockChecked: 'closed firmly and still does not lock', catchOk: 'catch and alignment fine', catchCleared: 'catch obstruction cleared', catchBroken: 'catch broken / door dropped',
  codeDoor: 'door-lock error code', codePressure: 'pressure / level error code',
};
const SPEC = {
  schema: 'j6-diag/1', FAMILY, PRIOR, SIGNALS, FACT_LABEL,
  obs: { wontOpen: ['doorOpens', false], opens: ['doorOpens', true], noLock: ['doorLocks', false], locks: ['doorLocks', true], wontClose: ['doorCloses', false],
    handleBroken: ['handleBroken', true], clicking: ['lockClicking', true], noWaterIn: ['waterRemaining', false] },
  checks: { 'child-lock': { clear: 'childLockOk', found: 'childLockOff' }, 'door-catch': { clear: 'catchOk', found: 'catchCleared', fault: 'catchBroken' } },
  FIX_CHECK: { CL: ['child-lock', 'ChildLock'], CH: ['door-catch', 'Catch'] },
  DECISIVE_PART: { CH: { handleBroken: 'door-handle', catchBroken: 'door-handle' }, DL: { noLockChecked: 'door-lock' } },
  extra(s, ctx, on) {
    const waited = engine.checkDone(s, 'door-release-wait');
    on('opensAfterWait', waited && engine.obsVal(s, 'doorOpens') === true);
    on('stillLockedAfterWait', waited && engine.obsVal(s, 'doorOpens') === false);
    on('noLockChecked', engine.checkDone(s, 'door-closed-latched') && engine.obsVal(s, 'doorLocks') === false);
    on('codeDoor', ctx.codeFault === 'door-lock');
    on('codePressure', ctx.codeFault === 'pressure-switch');
  },
  eligible(key, has) {
    if (key === 'DY') return has('wontOpen') || has('opensAfterWait');
    if (key === 'CL') return has('wontOpen') || has('childLockOff') || has('childLockOk');
    if (key === 'PS') return has('wontOpen') || has('stillLockedAfterWait');
    return true;
  },
};
function diagnose(state, ctx = {}) {
  const codeFault = ctx.codeFault !== undefined ? ctx.codeFault : codeFaultFor(state, ctx.errorCodes || null);
  return engine.diagnoseSpec(SPEC, state, { ...ctx, codeFault });
}
module.exports = { SPEC, FAMILY, diagnose };
