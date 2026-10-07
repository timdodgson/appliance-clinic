'use strict';
/**
 * Journey 7 diagnostics — washing machine · excessive vibration (it spins, but shakes / walks / bangs). PURE.
 * Design: docs/diagnostics/wm-batch-2-evidence.md §4. No-part outcomes first (transit bolts, levelling / floor, load);
 * suspension only when the machine still shakes EMPTY with bolts out and level; a shock absorber is a part only when
 * one was actually seen broken. Drum support / bearings → engineer.
 */
const engine = require('./evidence-engine.js');
const { codeFaultFor } = require('./j2-diagnostics.js');
const { SS, S, A, SA } = engine;

const FAMILY = { TR: 'transit-bolts', LV: 'levelling-or-floor', LD: 'load-imbalance', SU: 'suspension-dampers', BR: 'drum-support-or-bearings' };
const PRIOR = ['TR', 'LV', 'LD', 'SU', 'BR'];
const SIGNALS = {
  TR: { boltsRemoved: SS, restoredAfterBoltsFix: SS, failsAfterBoltsFix: SA, recentInstall: S, emptyShakes: S, knock: S, boltsOut: SA, notRecent: A, loadIssue: A },
  LV: { levelFixed: SS, restoredAfterLevelFix: SS, failsAfterLevelFix: SA, recentInstall: S, emptyShakes: S, levelOk: SA, loadIssue: A },
  LD: { loadIssue: SS, loadFixed: SS, restoredAfterLoadFix: SS, failsAfterLoadFix: SA, emptySmooth: SS, codeImbalance: S, loadNormal: A, emptyShakes: SA },
  SU: { damperBroken: SS, emptyShakes: S, levelOk: S, boltsOut: S, loadNormal: S, knock: S, loose: S, emptySmooth: SA, levelFixed: A, boltsRemoved: A, loadIssue: A },
  BR: { grinding: SS, loose: S, emptyShakes: S, emptySmooth: A, damperBroken: A, boltsRemoved: A, loadIssue: A },
};
const FACT_LABEL = {
  recentInstall: 'recently installed / moved', notRecent: 'not recently moved', loadIssue: 'only with certain loads (single heavy item / small load)',
  emptyShakes: 'still shakes with the drum empty', emptySmooth: 'smooth with the drum empty', loose: 'drum loose / drops / knocks', knock: 'knocking / banging',
  grinding: 'grinding / rumbling', boltsOut: 'transit bolts removed', boltsRemoved: 'transit bolts were still fitted (removed)', levelOk: 'level and firm',
  levelFixed: 'not level / foot loose (adjusted)', loadNormal: 'normal mixed load', loadFixed: 'load problem (corrected)', damperBroken: 'shock absorber seen broken',
  codeImbalance: 'imbalance error code',
};
const SPEC = {
  schema: 'j7-diag/1', FAMILY, PRIOR, SIGNALS, FACT_LABEL,
  obs: { recentInstall: ['recentInstallation', true], notRecent: ['recentInstallation', false], loadIssue: ['loadDependent', true], emptyShakes: ['shakesWhenEmpty', true],
    emptySmooth: ['shakesWhenEmpty', false], loose: ['drumPlay', true], firm: ['drumPlay', false], grinding: ['grindingNoise', true], knock: ['knockingNoise', true] },
  checks: { 'transit-bolts': { clear: 'boltsOut', found: 'boltsRemoved' }, levelling: { clear: 'levelOk', found: 'levelFixed' },
    'load-check': { clear: 'loadNormal', found: 'loadFixed' }, 'shock-absorbers': { fault: 'damperBroken' } },
  FIX_CHECK: { TR: ['transit-bolts', 'Bolts'], LV: ['levelling', 'Level'], LD: ['load-check', 'Load'] },
  DECISIVE_PART: { SU: { damperBroken: 'shock-absorber' } },
  extra(s, ctx, on) { on('codeImbalance', ['unbalanced-load', 'excessive-vibration', 'mems-sensor'].includes(ctx.codeFault)); },
  eligible(key, has) {
    if (key === 'BR') return has('grinding') || has('loose');
    return true;
  },
};
function diagnose(state, ctx = {}) {
  const codeFault = ctx.codeFault !== undefined ? ctx.codeFault : codeFaultFor(state, ctx.errorCodes || null);
  return engine.diagnoseSpec(SPEC, state, { ...ctx, codeFault });
}
module.exports = { SPEC, FAMILY, diagnose };
