'use strict';
/**
 * Oven journey 5 — dead / no power (rules OD1–OD22). PURE, deterministic.
 * Design: docs/diagnostics/final-migration-evidence.md §OV5. Separate states:
 *   DISPLAY DEAD     → cooker switch (isolator) / fuse / supply (look only, no electrical testing) → mains input or control (engineer)
 *   CLOCK WORKS, NO HEAT / NO RESPONSE → clock / auto mode or a key lock → selector / control (engineer)
 *   a BREAKER / RCD trip → oven-tripping (ov-family; the safety journey).
 */
const engine = require('./evidence-engine.js');
const kit = require('./policy-kit.js');
const JP = require('./journey-pipeline.js');
const F = require('./ov-family.js');
const ck = require('./compose-kit.js');
const { SS, S, A, SA } = engine;

const KEY = 'oven-dead-no-power';
const FAMILY = { PW: 'supply-or-cooker-switch', MP: 'mains-input-or-control', CM: 'clock-or-auto-mode', LK: 'key-or-child-lock', SC: 'selector-or-control' };
const SIGNALS = {
  PW: { dead: SS, powerFixed: SS, restoredAfterPowerFix: SS, failsAfterPowerFix: SA, socketOk: A, powered: SA },
  MP: { dead: S, socketOk: SS, powered: SA, powerFixed: A },
  CM: { clockFix: SS, restoredAfterClockFix: SS, failsAfterClockFix: SA, powered: S, clockOk: SA, dead: SA },
  LK: { lockOff: SS, restoredAfterLockFix: SS, failsAfterLockFix: SA, powered: S, lockOk: SA, dead: SA },
  SC: { powered: S, clockOk: S, lockOk: S, dead: SA, restoredAfterClockFix: SA, restoredAfterLockFix: SA },
};
const FACT_LABEL = { dead: 'display / lights completely dead', powered: 'display / clock works', socketOk: 'cooker switch and fuse fine', powerFixed: 'cooker switch / fuse was off (sorted)',
  clockFix: 'clock / auto mode set', clockOk: 'clock set, manual mode', lockOff: 'key / child lock was on (off now)', lockOk: 'no lock on' };
const SPEC = {
  schema: 'ov5-diag/1', FAMILY, PRIOR: ['PW', 'MP', 'CM', 'LK', 'SC'], SIGNALS, FACT_LABEL,
  obs: { dead: ['noPower', true], powered: ['noPower', false] },
  checks: { 'power-supply': { clear: 'socketOk', found: 'powerFixed' }, 'oven-clock-mode': { clear: 'clockOk', found: 'clockFix' }, 'child-lock': { clear: 'lockOk', found: 'lockOff' } },
  FIX_CHECK: { PW: ['power-supply', 'Power'], CM: ['oven-clock-mode', 'Clock'], LK: ['child-lock', 'Lock'] },
  DECISIVE_PART: {},
  eligible: (k, has) => (k === 'PW' || k === 'MP' ? has('dead') || has('powerFixed') : true),
};
function diagnose(state, ctx = {}) {
  const codeFault = ctx.codeFault !== undefined ? ctx.codeFault : F.ovCodeFault(state, ctx.errorCodes || null);
  return engine.diagnoseSpec(SPEC, state, { ...ctx, codeFault });
}
const P = kit.makeStepPolicy({
  JOURNEY: KEY, P: 'OD', appliance: 'oven-cooker', journeys: ['wont-start', 'controls-unresponsive'], ...F.owns(KEY), declineUnsafe: F.UNSAFE,
  CHECKS: ['power-supply', 'oven-clock-mode', 'child-lock'],
  OBS_TARGETS: { noPower: ['noPower'] },
  REQUIRES: { noPower: [], 'power-supply': ['no_live_electrical_checks'], 'oven-clock-mode': [], 'child-lock': [], retest: [] },
  FIX_CHECKS: ['power-supply', 'oven-clock-mode', 'child-lock'],
  steps: [
    { n: 10, target: 'noPower', reason: 'display-dead-or-working', when: (h) => !h.has('dead') && !h.has('powered') },
    { n: 11, target: 'power-supply', reason: 'cooker-switch-and-fuse', when: (h) => h.has('dead') },
    { n: 12, target: 'oven-clock-mode', reason: 'clock-auto-mode', when: (h) => h.has('powered') },
    { n: 13, target: 'child-lock', reason: 'key-lock', when: (h) => h.has('powered') },
  ],
  PART_FAMILIES: new Set(),
  HANDOFF: { PW: 'none', MP: 'engineer', CM: 'none', LK: 'none', SC: 'engineer' },
});
const pipeline = JP.makeModelPartPipeline({ D: { diagnose }, P, schema: 'ov5/1', codeFaultFor: F.ovCodeFault, PART_MATCH: {}, MEDIA_BY_KEY: {} });

// ---- COMPOSE (wording only) ----
const FAMILY_LABEL = { 'supply-or-cooker-switch': 'the supply (cooker switch, fuse or breaker)', 'mains-input-or-control': 'the oven\'s mains input or control', 'clock-or-auto-mode': 'the clock / auto mode',
  'key-or-child-lock': 'the key / child lock', 'selector-or-control': 'the selector or control' };
const TASK = {
  'ask_observation:noPower': { say: 'First, whether it has any power.', ask: 'Does the clock or display show anything at all, or is it completely blank?' },
  'ask_check:power-supply': { say: 'Check the cooker switch (the large switch on the wall near the oven) is on, and look at the fuse box to see whether a breaker for the cooker has switched off. If a breaker keeps tripping, don\'t keep resetting it.', ask: 'Was the cooker switch or a breaker off (and is it sorted), or were they all on?' },
  'ask_check:oven-clock-mode': { say: 'Many ovens won\'t heat or respond until the clock is set or manual mode is selected after a power cut.', ask: 'Was the clock flashing or an auto mode set (and have you set it to manual), or was it already set?' },
  'ask_check:child-lock': { say: 'Some ovens have a key / child lock (often a key symbol) that stops it working — the manual shows which button to hold.', ask: 'Was a key lock on (and is it off now), or was there no lock on?' },
  'ask_check:retest': { say: 'Now try the oven on a normal setting.', ask: 'Is it working now, or still not?' },
  'ask_identity:appliance': F.OVEN_APPLIANCE_ASK,
};
const CONCLUSION = {
  'OD7:supply-or-cooker-switch': 'That was the supply, so no part is needed.', 'OD7:clock-or-auto-mode': 'That was the clock / auto mode, so no part is needed.',
  'OD7:key-or-child-lock': 'That was the key lock, so no part is needed.',
  'mains-input-or-control': 'With the cooker switch and breaker on but no display at all, the fault is in the oven\'s mains connection or control. Please don\'t open it up or test it live — an appliance engineer (or electrician for the supply) is the next step. I\'m not recommending a part from this.',
  'selector-or-control': 'It has power and nothing is locked, so the selector or control is the likely area. That needs an appliance engineer — I\'m not recommending a part from this.',
};
const compose = ck.createCompose({
  ASK_GUARD: true, TASK, CONFIRM_ASK: 'Is it working now?',
  OBS_COPY: { noPower: ['display blank', 'display works'], faultPersists: ['still not working', 'working now'] },
  CHECK_RESULT_COPY: { 'power-supply': { clear: 'cooker switch and breaker on', found_and_cleared: 'switch / breaker sorted' }, 'oven-clock-mode': { clear: 'clock set', found_and_cleared: 'clock / auto mode sorted' },
    'child-lock': { clear: 'no lock', found_and_cleared: 'lock off now' } },
  statusChecks: [['retest', 'retest']],
  conclusionCopy: ck.makeConclusionCopy({ FAMILY_LABEL, COMPONENT_LABEL: {}, CONCLUSION }),
  PURCHASE_RE: /\b(buy|order|purchase|price|£\s?\d)|\b(new|replacement|replace the)\s+(selector|switch|timer|clock|pcb|control board|terminal block|fuse)\b/i,
});
module.exports = { SPEC, FAMILY, diagnose, P, ...pipeline, FAMILY_LABEL, COMPONENT_LABEL: {}, TASK, REQUIREMENT: ck.REQUIREMENT, SAFETY_COPY: ck.SAFETY_COPY, ...compose };
