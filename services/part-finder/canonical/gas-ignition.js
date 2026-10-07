'use strict';
/**
 * Gas ignition — one journey model used twice: cooker-ignition-gas (oven-cooker, rules GC*) and hob-ignition-gas (hob,
 * rules GH*). PURE, deterministic. CONSERVATIVE.
 * Design: docs/diagnostics/final-migration-evidence.md §GAS. A gas smell / escape is the sticky EMERGENCY stop (kit P1:
 * no diagnosis at all). Otherwise: does it click / spark? lights then goes out? one burner or all? → the only owner check:
 * lift and re-seat the cap / crown, dry and clean (cold, knobs off, nothing else removed) → igniter / spark generator or
 * the supply (no click; mains-powered ignition) · goes out when the knob is released → flame-failure device · all burners
 * won't light with clicks → gas supply (meter / emergency control valve / prepayment) · → a Gas Safe engineer. No parts.
 */
const engine = require('./evidence-engine.js');
const kit = require('./policy-kit.js');
const JP = require('./journey-pipeline.js');
const ck = require('./compose-kit.js');
const { codeFaultFor } = require('./j2-diagnostics.js');
const { SS, S, A, SA } = engine;

const FAMILY = { CP: 'burner-cap-wet-or-misaligned', IG: 'igniter-or-spark-unit', FF: 'flame-failure-device', SU: 'gas-supply' };
const SIGNALS = {
  CP: { capsFixed: SS, restoredAfterCapsFix: SS, failsAfterCapsFix: SA, capsOk: SA, wet: S, clicksNoLight: S, one: S, all: A },
  IG: { noClick: SS, capsOk: S, one: S, clicksNoLight: SA, restoredAfterCapsFix: SA },
  FF: { goesOut: SS, capsOk: S, one: S, restoredAfterCapsFix: SA },
  SU: { all: S, clicksNoLight: S, capsOk: S, one: SA, goesOut: A, restoredAfterCapsFix: SA },
};
const FACT_LABEL = { clicksNoLight: 'clicks but won\'t light', noClick: 'no click / spark', goesOut: 'lights then goes out', one: 'one burner only', all: 'all burners',
  capsFixed: 'cap / crown misaligned, wet or dirty (sorted)', capsOk: 'caps seated, dry and clean', wet: 'recently cleaned / wet' };
const SPEC = {
  schema: 'gas-diag/1', FAMILY, PRIOR: ['CP', 'IG', 'FF', 'SU'], SIGNALS, FACT_LABEL,
  obs: { clicksNoLight: ['sparkClicks', true], noClick: ['sparkClicks', false], goesOut: ['flameGoesOut', true], one: ['oneBurnerOnly', true], all: ['oneBurnerOnly', false], wet: ['recentCleaning', true] },
  checks: { 'burner-parts-clean': { clear: 'capsOk', found: 'capsFixed' } },
  FIX_CHECK: { CP: ['burner-parts-clean', 'Caps'] },
  DECISIVE_PART: {},
};
const UNSAFE = ['gas_work', 'live_electrical_test', 'open_while_powered', 'bypass_safety_device'];

function build({ KEY, P: prefix, appliance, journeys, owns, codeAppliance, applianceAsk }) {
  const cf = (state, errorCodes) => codeFaultFor(state, errorCodes, codeAppliance);
  function diagnose(state, ctx = {}) {
    const codeFault = ctx.codeFault !== undefined ? ctx.codeFault : cf(state, ctx.errorCodes || null);
    return engine.diagnoseSpec({ ...SPEC, schema: `${prefix.toLowerCase()}-diag/1` }, state, { ...ctx, codeFault });
  }
  const P = kit.makeStepPolicy({
    JOURNEY: KEY, P: prefix, appliance, journeys, ...owns(KEY), declineUnsafe: UNSAFE,
    CHECKS: ['burner-parts-clean'],
    OBS_TARGETS: { ignitionState: ['sparkClicks', 'flameGoesOut'], oneBurnerOnly: ['oneBurnerOnly'] },
    REQUIRES: { ignitionState: [], oneBurnerOnly: [], 'burner-parts-clean': ['gas_knobs_off_cold', 'no_gas_dismantling'], retest: [] },
    FIX_CHECKS: ['burner-parts-clean'],
    steps: [
      { n: 10, target: 'ignitionState', reason: 'clicks-lights-or-goes-out', when: (h) => h.obs('sparkClicks') == null && h.obs('flameGoesOut') == null },
      { n: 11, target: 'oneBurnerOnly', reason: 'one-or-all-burners', when: (h) => h.obs('oneBurnerOnly') == null },
      { n: 12, target: 'burner-parts-clean', reason: 'cap-crown-seated-dry-clean', when: () => true },
    ],
    PART_FAMILIES: new Set(),
    HANDOFF: { CP: 'none', IG: 'gas', FF: 'gas', SU: 'gas' },
  });
  const pipeline = JP.makeModelPartPipeline({ D: { diagnose }, P, schema: `${prefix.toLowerCase()}/1`, codeFaultFor: cf, PART_MATCH: {}, MEDIA_BY_KEY: {} });
  const FAMILY_LABEL = { 'burner-cap-wet-or-misaligned': 'a burner cap that was wet, dirty or not seated', 'igniter-or-spark-unit': 'the igniter / spark unit', 'flame-failure-device': 'the flame-failure safety device',
    'gas-supply': 'the gas supply' };
  const R = (n) => `${prefix}${n}`;
  const TASK = {
    'ask_observation:ignitionState': { say: 'If you smell gas at any point, stop and tell me straight away.', ask: 'When you push and turn the knob, does it click / spark but not light, does it not click at all, or does it light and then go out when you let go of the knob?' },
    'ask_observation:oneBurnerOnly': { say: 'This narrows it down.', ask: 'Is it just one burner, or all of them?' },
    'ask_check:burner-parts-clean': { say: 'The usual cause is a burner cap that isn\'t sitting square, or one that\'s wet or greasy after cleaning. Lift off the cap and crown, dry and clean them (and gently wipe the white igniter tip), then re-seat them so they sit flat.', ask: 'Was a cap out of place, wet or dirty (and is it sorted), or were they all seated, dry and clean?' },
    'ask_check:retest': { say: 'Now try lighting it again as normal.', ask: 'Does it light and stay lit now, or still not?' },
    'ask_identity:appliance': applianceAsk,
  };
  const CONCLUSION = {
    [`${R(7)}:burner-cap-wet-or-misaligned`]: 'That was the burner cap, so no part is needed. After cleaning, let the parts dry fully and make sure the caps sit flat.',
    'igniter-or-spark-unit': 'With no click at all, the igniter or the spark unit is the likely area (on a mains-ignition cooker, check its plug / switch is on). That needs a Gas Safe registered engineer — please don\'t take any gas parts apart. I\'m not recommending a part from this.',
    'flame-failure-device': 'Lighting and then going out when you let go points to the flame-failure safety device (the probe beside the burner). Please never try to bypass or adjust it — a Gas Safe registered engineer is the next step. I\'m not recommending a part from this.',
    'gas-supply': 'If none of the burners will light even though they click, check whether your other gas appliances work and whether a prepayment meter has credit. If gas isn\'t reaching the appliance, contact your gas supplier or a Gas Safe registered engineer — please don\'t touch the gas pipework. I\'m not recommending a part from this.',
  };
  const compose = ck.createCompose({
    ASK_GUARD: true, TASK, CONFIRM_ASK: 'Is it lighting and staying lit now?',
    OBS_COPY: { sparkClicks: ['clicks but won\'t light', 'no click'], flameGoesOut: ['lights then goes out', null], oneBurnerOnly: ['one burner', 'all burners'], faultPersists: ['still won\'t light', 'lights now'] },
    CHECK_RESULT_COPY: { 'burner-parts-clean': { clear: 'caps seated, dry and clean', found_and_cleared: 'cap / crown sorted' } },
    statusChecks: [['retest', 'retest']],
    conclusionCopy: ck.makeConclusionCopy({ FAMILY_LABEL, COMPONENT_LABEL: {}, CONCLUSION }),
    PURCHASE_RE: /\b(buy|order|purchase|price|£\s?\d)|\b(new|replacement|replace the)\s+(igniter|ignition|spark|thermocouple|valve|gas valve|regulator|burner|electrode|switch)\b/i,
  });
  return { SPEC, FAMILY, diagnose, P, ...pipeline, FAMILY_LABEL, COMPONENT_LABEL: {}, TASK, REQUIREMENT: ck.REQUIREMENT, SAFETY_COPY: ck.SAFETY_COPY, ...compose };
}
module.exports = { build, SPEC, FAMILY, UNSAFE };
