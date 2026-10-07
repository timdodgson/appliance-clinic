'use strict';
/**
 * Journey 5 diagnostics — washing machine · water · overfilling. PURE, deterministic.
 * Design: docs/diagnostics/wm-batch-2-evidence.md §2. The pivotal split: water still enters with the machine OFF
 * (inlet valve stuck open — clean water) vs only while running (level sensing / control), and siphoning / waste
 * back-siphon through a badly installed drain hose (level stays normal, or DIRTY water appears).
 */
const engine = require('./evidence-engine.js');
const { codeFaultFor } = require('./j2-diagnostics.js');
const { SS, S, A, SA } = engine;

const FAMILY = { IV: 'inlet-valve-stuck-open', SI: 'drain-hose-siphon', WB: 'waste-backflow', FL: 'foam-level', LS: 'level-sensing-or-control' };
const PRIOR = ['IV', 'SI', 'WB', 'FL', 'LS'];
const SIGNALS = {
  IV: { whenOff: SS, offTestFills: SS, clean: S, codeValve: S, stopsWhenOff: SA, dirty: SA, levelNormal: A },
  SI: { levelNormal: SS, dirty: SS, hoseRefitted: SS, restoredAfterHoseFix: SS, failsAfterHoseFix: SA, hoseHeightOk: SA, levelHigh: SA, clean: A, offTestFills: A },
  // Dirty water with the drain hose correctly fitted: the household waste is backing up into the machine (plumbing).
  WB: { dirty: SS, hoseHeightOk: S, whenOff: S, clean: SA, levelHigh: A },
  FL: { foam: SS, codeFoam: SS, levelHigh: S, stopsWhenOff: S, whenOff: SA, levelNormal: A },
  LS: { stopsWhenOff: SS, levelHigh: S, codePressure: SS, hoseHeightOk: S, whenOff: SA, offTestFills: SA, levelNormal: SA, dirty: A, foam: A },
};
const FACT_LABEL = {
  whenOff: 'water enters with the machine off', offTestFills: 'still fills with the machine switched off (tested)', stopsWhenOff: 'stops when switched off',
  levelHigh: 'water level too high', levelNormal: 'keeps taking water but the level stays normal', dirty: 'dirty water appears', clean: 'clean water',
  foam: 'excess foam', hoseRefitted: 'drain hose too low / pushed in too far (refitted)', hoseHeightOk: 'drain hose installed correctly',
  codePressure: 'pressure / level error code', codeFoam: 'foam error code', codeValve: 'inlet-valve error code',
};
const SPEC = {
  schema: 'j5-diag/1', FAMILY, PRIOR, SIGNALS, FACT_LABEL,
  obs: { whenOff: ['fillsWhenOff', true], stopsWhenOff: ['fillsWhenOff', false], levelHigh: ['waterLevelHigh', true], levelNormal: ['waterLevelHigh', false],
    dirty: ['waterIsDirty', true], clean: ['waterIsDirty', false], foam: ['excessiveFoam', true] },
  checks: { 'drain-hose-height': { clear: 'hoseHeightOk', found: 'hoseRefitted' } },
  FIX_CHECK: { SI: ['drain-hose-height', 'Hose'] },
  DECISIVE_PART: { IV: { offTestFills: 'inlet-valve', whenOff: 'inlet-valve' } },
  extra(s, ctx, on) {
    on('offTestFills', engine.checkDone(s, 'power-off-fill-test') && engine.obsVal(s, 'fillsWhenOff') === true);
    on('codePressure', ctx.codeFault === 'pressure-switch');
    on('codeFoam', ctx.codeFault === 'foam-suds');
    on('codeValve', ctx.codeFault === 'inlet-valve');
  },
  // Dirty water entering is never valve evidence; no part while it is the household waste.
  partBlockers: (has) => (has('dirty') ? ['dirty-water-backflow-evidence'] : []),
  eligible(key, has) {
    if (key === 'FL') return has('foam') || has('codeFoam');
    if (key === 'WB') return has('dirty');
    return true;
  },
};
function diagnose(state, ctx = {}) {
  const codeFault = ctx.codeFault !== undefined ? ctx.codeFault : codeFaultFor(state, ctx.errorCodes || null);
  return engine.diagnoseSpec(SPEC, state, { ...ctx, codeFault });
}
module.exports = { SPEC, FAMILY, diagnose };
