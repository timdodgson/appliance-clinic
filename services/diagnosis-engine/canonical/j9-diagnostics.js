'use strict';
/**
 * Journey 9 diagnostics — washing machine · not heating. PURE, deterministic.
 * Design: docs/diagnostics/wm-batch-2-evidence.md §6. A cool door glass is not evidence of a failed heater; cold
 * washing on a programme that should heat (or a supervised 60°C test) is. The heater is part-decisive only with a
 * heater-specific error code; NTC / control / wiring are never guessed (engineer). A trip during heating is a safety
 * stop (shared kit), never a part.
 */
const engine = require('./evidence-engine.js');
const rq = require('./requests.js');
const { codeFaultFor } = require('./j2-diagnostics.js');
const { SS, S, A, SA } = engine;

const FAMILY = { NB: 'normal-low-temperature', PG: 'programme-setting', HE: 'heater-element', TS: 'temperature-sensor', PL: 'fill-or-level', CT: 'heating-control' };
const PRIOR = ['NB', 'PG', 'HE', 'TS', 'PL', 'CT'];
const SIGNALS = {
  NB: { warmOnHotTest: SS, lowProg: SS, hotProg: A, coldOnHot: SA, codeHeater: SA, codeNtc: SA, long: A },
  PG: { settingFixed: SS, restoredAfterSettingFix: SS, failsAfterSettingFix: SA, lowProg: S, settingOk: SA, coldOnHot: A },
  HE: { codeHeater: SS, coldOnHot: S, long: S, hotProg: S, cold: S, warmOnHotTest: SA, lowProg: A, codeNtc: A, codePressure: A },
  TS: { codeNtc: SS, coldOnHot: S, long: S, warmOnHotTest: A, codeHeater: A },
  PL: { codePressure: SS, noFill: S, slowFill: S, long: S, warmOnHotTest: A, codeHeater: A },
  CT: { codeControl: SS, coldOnHot: S, long: S, warmOnHotTest: SA, lowProg: A, codeHeater: A },
};
const FACT_LABEL = {
  cold: 'washes cold', warm: 'gets warm', long: 'programme takes much longer than usual', hotProg: 'a hot (40°C+) programme was used', lowProg: 'a cold / eco / quick programme was used',
  coldOnHot: 'cold on a programme that should heat', warmOnHotTest: 'warm on the 60°C test', settingFixed: 'temperature setting was the cause (changed)', settingOk: 'temperature setting fine',
  noFill: 'not filling', slowFill: 'fills slowly', codeHeater: 'heater error code', codeNtc: 'temperature-sensor error code', codePressure: 'pressure / level error code', codeControl: 'control error code',
};
function testAskTurn(s) { const r = rq.requestsFor(s, 'hot-wash-test'); return r.length ? r[0].askedTurn : null; }
const SPEC = {
  schema: 'j9-diag/1', FAMILY, PRIOR, SIGNALS, FACT_LABEL,
  obs: { cold: ['noHeat', true], warm: ['heatPresent', true], long: ['longCycle', true], hotProg: ['hotProgrammeUsed', true], lowProg: ['hotProgrammeUsed', false],
    noFill: ['waterEntering', false], slowFill: ['fillsSlowly', true] },
  checks: { 'programme-setting': { clear: 'settingOk', found: 'settingFixed' } },
  FIX_CHECK: { PG: ['programme-setting', 'Setting'] },
  DECISIVE_PART: { HE: { codeHeater: 'heater' } },
  extra(s, ctx, on) {
    const t = testAskTurn(s);
    // stated (TRUE) after the test was asked; a derived / sibling FALSE never counts as a test result
    const after = (k) => t != null && engine.obsVal(s, k) != null && (engine.obsTurnOf(s, k) || 0) > t;
    const tested = engine.checkDone(s, 'hot-wash-test') || after('noHeat') || (after('heatPresent') && engine.obsVal(s, 'heatPresent') === true);
    const warmTest = tested && (engine.obsVal(s, 'noHeat') === false || (engine.obsVal(s, 'heatPresent') === true && after('heatPresent')));
    const coldTest = tested && !warmTest && engine.obsVal(s, 'noHeat') === true;
    on('warmOnHotTest', warmTest);
    on('coldOnHot', coldTest || (engine.obsVal(s, 'hotProgrammeUsed') === true && engine.obsVal(s, 'noHeat') === true && !warmTest));
    on('codeHeater', ctx.codeFault === 'heater');
    on('codeNtc', ctx.codeFault === 'temperature-sensor');
    on('codePressure', ctx.codeFault === 'pressure-switch');
    on('codeControl', ctx.codeFault === 'main-pcb');
  },
  eligible(key, has) {
    if (key === 'PL') return has('noFill') || has('slowFill') || has('codePressure');
    if (key === 'PG') return has('settingFixed') || has('settingOk') || has('lowProg');
    return true;
  },
};
function diagnose(state, ctx = {}) {
  const codeFault = ctx.codeFault !== undefined ? ctx.codeFault : codeFaultFor(state, ctx.errorCodes || null);
  return engine.diagnoseSpec(SPEC, state, { ...ctx, codeFault });
}
module.exports = { SPEC, FAMILY, diagnose };
