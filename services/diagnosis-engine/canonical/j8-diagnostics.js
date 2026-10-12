'use strict';
/**
 * Journey 8 diagnostics — washing machine · noisy (it works, but makes a noise). PURE, deterministic.
 * Design: docs/diagnostics/wm-batch-2-evidence.md §5. Typed dimensions WHEN (fill / wash / drain / spin / all the
 * time) × TYPE (grind / hum / scrape / knock / rattle / squeal / click) + owner checks reused from Journeys 1 and 2
 * (drain-filter, pump-impeller, drum-by-hand, load-check) with their existing semantics.
 * "Noise" alone never reaches bearings: a bearing commit needs rough-by-hand, or grinding on spin with a loose drum.
 * Belt is impossible on a direct-drive platform (shared Journey 2 architecture).
 */
const engine = require('./evidence-engine.js');
const { codeFaultFor, architectureOf } = require('./j2-diagnostics.js');
const { SS, S, A, SA } = engine;

const FAMILY = { NO: 'normal-operating-noise', PO: 'pump-obstruction', FO: 'foreign-object', SL: 'load-or-installation', PW: 'drain-pump-worn',
  BT: 'belt-pulley-or-motor', BE: 'drum-bearings' };
const PRIOR = ['NO', 'PO', 'FO', 'SL', 'PW', 'BT', 'BE'];
const SIGNALS = {
  NO: { fillHum: SS, click: S, onFill: S, grind: SA, scrape: SA, knock: SA, rattle: SA, squeal: A, onSpin: A, roughByHand: SA },
  PO: { filterDebris: SS, impellerCleared: SS, restoredAfterFilterFix: SS, failsAfterFilterFix: SA, restoredAfterImpellerFix: SS, failsAfterImpellerFix: SA, onDrain: S, rattle: S, grind: S, hum: S,
    filterClear: SA, onWash: A, scrape: A, onFill: A },
  FO: { objectRemoved: SS, objectStuck: SS, restoredAfterObjectFix: SS, failsAfterObjectFix: SA, scrape: SS, rattle: S, click: S, onWash: S, onSpin: S,
    noObject: SA, onDrain: A, onFill: A, fillHum: SA, grind: A, squeal: A },
  SL: { loadIssue: SS, loadFixed: SS, restoredAfterLoadFix: SS, failsAfterLoadFix: SA, boltsRemoved: SS, restoredAfterBoltsFix: SS, failsAfterBoltsFix: SA,
    knock: S, onSpin: S, recentInstall: S, loadNormal: A, boltsOut: A, scrape: A, onFill: SA, onDrain: A },
  PW: { impellerDamaged: SS, onDrain: S, grind: S, hum: S, filterClear: S, impellerOk: A, onWash: A, onSpin: A, onFill: SA },
  BT: { beltDamaged: SS, squeal: S, onSpin: S, onWash: S, directDrive: SA, onFill: SA, onDrain: A, scrape: A },
  BE: { roughByHand: SS, bearingPattern: SS, grind: S, onSpin: S, loose: S, always: S, smoothByHand: A, firm: A, onFill: SA, onDrain: A, scrape: A, click: A },
};
const FACT_LABEL = {
  onFill: 'noise while filling', onWash: 'noise during the wash', onDrain: 'noise while draining', onSpin: 'noise on spin', always: 'noise all the time',
  grind: 'grinding / rumbling', hum: 'humming', scrape: 'metallic scraping', knock: 'knocking / banging', rattle: 'rattling', squeal: 'squealing', click: 'clicking',
  fillHum: 'hum only while filling', filterDebris: 'debris in the pump filter (cleared)', filterClear: 'pump filter clear', impellerCleared: 'impeller obstruction cleared',
  impellerDamaged: 'impeller damaged / rough', impellerOk: 'impeller turns freely', objectRemoved: 'object found in the drum (removed)', objectStuck: 'object stuck between drum and tub',
  noObject: 'nothing loose in the drum', roughByHand: 'rough / grinding when turned by hand', smoothByHand: 'smooth by hand', loose: 'drum loose / drops', firm: 'drum firm',
  bearingPattern: 'grinding on spin with a loose drum', loadIssue: 'only with certain loads', loadFixed: 'load problem (corrected)', loadNormal: 'normal load',
  boltsRemoved: 'transit bolts were still in (removed)', boltsOut: 'transit bolts removed', recentInstall: 'recently installed / moved', beltDamaged: 'belt seen worn / damaged',
  directDrive: 'direct-drive machine (no belt)',
};
const SPEC = {
  schema: 'j8-diag/1', FAMILY, PRIOR, SIGNALS, FACT_LABEL,
  obs: { onFill: ['noiseOnFill', true], onWash: ['noiseOnWash', true], onDrain: ['noiseOnDrain', true], onSpin: ['noiseOnSpin', true], always: ['noiseThroughout', true],
    grind: ['grindingNoise', true], hum: ['humNoise', true], scrape: ['scrapingNoise', true], knock: ['knockingNoise', true], rattle: ['rattlingNoise', true],
    squeal: ['squealNoise', true], click: ['clickingNoise', true], loose: ['drumPlay', true], firm: ['drumPlay', false], recentInstall: ['recentInstallation', true],
    loadIssue: ['loadDependent', true] },
  checks: {
    'drain-filter': { clear: 'filterClear', found: 'filterDebris' }, 'pump-impeller': { clear: 'impellerOk', found: 'impellerCleared', fault: 'impellerDamaged' },
    'drum-foreign-object': { clear: 'noObject', cleared: 'objectRemoved', notCleared: 'objectStuck' }, 'drum-by-hand': { clear: 'smoothByHand', fault: 'roughByHand' },
    'load-check': { clear: 'loadNormal', found: 'loadFixed' }, 'transit-bolts': { clear: 'boltsOut', found: 'boltsRemoved' }, 'drive-belt': { fault: 'beltDamaged' },
  },
  // The object fix counts only when removed (a stuck object is not an owner fix).
  FIX_CHECK: { PO: ['drain-filter', 'Filter'], POi: ['pump-impeller', 'Impeller'], FO: ['drum-foreign-object', 'Object'], SL: ['load-check', 'Load'], SLb: ['transit-bolts', 'Bolts'] },
  DECISIVE_PART: { PW: { impellerDamaged: 'drain-pump' }, BT: { beltDamaged: 'drive-belt' } },
  architecture: (s, ctx) => architectureOf(s, { modelParts: ctx.modelParts || null, errorCodes: ctx.errorCodes || null }),
  extra(s, ctx, on) {
    const v = (k) => engine.obsVal(s, k) === true;
    on('fillHum', v('noiseOnFill') && v('humNoise') && !v('noiseOnSpin') && !v('noiseOnWash'));
    on('bearingPattern', v('grindingNoise') && v('noiseOnSpin') && v('drumPlay'));
    on('directDrive', Boolean(ctx.architecture && ctx.architecture.drive === 'direct'));
  },
  partBlockers: (has, { component }) => (component === 'drive-belt' && has('directDrive') ? ['architecture-has-no-belt'] : []),
  eligible(key, has) {
    if (key === 'NO') return has('onFill') || has('click') || has('fillHum');
    if (key === 'PO' || key === 'PW') return has('onDrain') || has('filterDebris') || has('impellerDamaged') || has('impellerCleared');
    if (key === 'SL') return ['knock', 'loadIssue', 'recentInstall', 'boltsRemoved', 'loadFixed'].some(has);
    if (key === 'BT') return !has('directDrive') && (has('squeal') || has('beltDamaged'));
    return true;
  },
};
function diagnose(state, ctx = {}) {
  const codeFault = ctx.codeFault !== undefined ? ctx.codeFault : codeFaultFor(state, ctx.errorCodes || null);
  return engine.diagnoseSpec(SPEC, state, { ...ctx, codeFault });
}
module.exports = { SPEC, FAMILY, diagnose };
