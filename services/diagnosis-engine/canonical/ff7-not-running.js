'use strict';
/**
 * Fridge / freezer journey 7 — not running / dead (rules FP1–FP22). PURE, deterministic.
 * Design: docs/diagnostics/ff-td-batch-evidence.md §FF7. Also owns a not-cooling / cut-out report that turns out to be not
 * running, and a noise report that is a click-start attempt (ff-family precedence). Four separate states:
 *   NO POWER (no lights)            → socket / plug / fuse (no electrical testing) → appliance mains / control (engineer)
 *   LIGHTS BUT NO COOLING (silent)  → the compressor isn't being started: control / start device / compressor (engineer)
 *   CLICK-START ATTEMPT             → coils / space / room heat (owner) → start relay or compressor (engineer; never a part —
 *                                     the two can't be told apart without live testing)
 *   RUNNING BUT NOT COOLING         → sealed system / airflow (refrigeration engineer)
 * A trip or burning smell is a sticky safety stop. Never live compressor or mains testing, never refrigerant work.
 */
const engine = require('./evidence-engine.js');
const kit = require('./policy-kit.js');
const JP = require('./journey-pipeline.js');
const F = require('./ff-family.js');
const ck = require('./compose-kit.js');
const { SS, S, A, SA } = engine;

const KEY = 'ff-not-running-dead';
const FAMILY = { PW: 'power-supply', MP: 'mains-or-control-dead', LN: 'lights-on-not-running', CK: 'click-start-relay-or-compressor', CC: 'condenser-coils-or-clearance', RN: 'running-not-cooling' };
const SIGNALS = {
  PW: { dead: SS, powerFixed: SS, restoredAfterPowerFix: SS, failsAfterPowerFix: SA, socketOk: A, powered: SA },
  MP: { dead: S, socketOk: SS, powered: SA, powerFixed: A, restoredAfterPowerFix: SA },
  LN: { silent: SS, powered: S, dead: SA, clicks: SA, running: SA },
  CK: { clicks: SS, coilsOk: S, powered: S, running: SA, dead: SA, restoredAfterCoilsFix: SA },
  CC: { coilsFixed: SS, restoredAfterCoilsFix: SS, failsAfterCoilsFix: SA, clicks: S, coilsOk: SA },
  RN: { running: SS, powered: S, dead: SA, clicks: A },
};
const FACT_LABEL = { dead: 'no lights / completely dead', powered: 'lights come on', socketOk: 'socket and plug fine', powerFixed: 'plug / switch / fuse was off (sorted)',
  silent: 'silent — never runs', clicks: 'clicks but never starts', running: 'runs but doesn\'t cool', coilsFixed: 'coils dusty / no space (sorted)', coilsOk: 'coils clean with space' };
const SPEC = {
  schema: 'ff7-diag/1', FAMILY, PRIOR: ['PW', 'MP', 'CC', 'CK', 'LN', 'RN'], SIGNALS, FACT_LABEL,
  obs: { dead: ['noPower', true], powered: ['noPower', false], silent: ['compressorRuns', false], running: ['compressorRuns', true], clicks: ['clicksNoStart', true] },
  checks: { 'power-supply': { clear: 'socketOk', found: 'powerFixed' }, 'condenser-coil-clear': { clear: 'coilsOk', found: 'coilsFixed' } },
  FIX_CHECK: { PW: ['power-supply', 'Power'], CC: ['condenser-coil-clear', 'Coils'] },
  DECISIVE_PART: {},
  extra(s, ctx, on) {
    // a stated compressor state means it has power (lights / clicks / running)
    const v = (k) => engine.obsVal(s, k);
    if (v('noPower') == null && (v('clicksNoStart') === true || v('compressorRuns') === true)) on('powered', true);
  },
  eligible: (k, has) => (k === 'PW' || k === 'MP' ? has('dead') || has('powerFixed') : k === 'CC' ? has('clicks') || has('coilsFixed') : true),
};
function diagnose(state, ctx = {}) {
  const codeFault = ctx.codeFault !== undefined ? ctx.codeFault : F.ffCodeFault(state, ctx.errorCodes || null);
  return engine.diagnoseSpec(SPEC, state, { ...ctx, codeFault });
}
const STATE = ['silent', 'running', 'clicks'];
const P = kit.makeStepPolicy({
  JOURNEY: KEY, P: 'FP', appliance: 'fridge-freezer', journeys: ['wont-start', 'cuts-out'], ...F.owns(KEY), declineUnsafe: F.UNSAFE,
  CHECKS: ['power-supply', 'condenser-coil-clear'],
  OBS_TARGETS: { noPower: ['noPower'], ffCompressorState: ['compressorRuns', 'clicksNoStart'] },
  REQUIRES: { noPower: ['ff_food_safety'], 'power-supply': ['no_live_electrical_checks'], ffCompressorState: ['ff_listen_only'],
    'condenser-coil-clear': ['unplug_fridge', 'no_refrigerant_work'], retest: [] },
  FIX_CHECKS: ['power-supply', 'condenser-coil-clear'],
  steps: [
    { n: 10, target: 'noPower', reason: 'dead-vs-powered', when: (h) => !h.has('dead') && !h.has('powered') },
    { n: 11, target: 'power-supply', reason: 'supply-before-appliance', when: (h) => h.has('dead') },
    { n: 12, target: 'ffCompressorState', reason: 'running-clicking-or-silent', when: (h) => h.has('powered') && !STATE.some(h.has) },
    { n: 13, target: 'condenser-coil-clear', reason: 'overheating-start-attempt', when: (h) => h.has('clicks') },
  ],
  PART_FAMILIES: new Set(),
  HANDOFF: { PW: 'none', MP: 'engineer', LN: 'engineer', CK: 'engineer', CC: 'none', RN: 'engineer' },
});
const pipeline = JP.makeModelPartPipeline({ D: { diagnose }, P, schema: 'ff7/1', codeFaultFor: F.ffCodeFault, PART_MATCH: {}, MEDIA_BY_KEY: {} });

// ---- COMPOSE (wording only) ----
const FOOD = 'Meanwhile keep the doors shut: a full freezer usually stays frozen for about a day if it isn\'t opened. Chilled food that has been warmer than 8°C for more than about four hours is safest thrown away, and thawed food shouldn\'t be refrozen unless it\'s cooked first.';
const FAMILY_LABEL = { 'power-supply': 'the power supply (plug, socket or fuse)', 'mains-or-control-dead': 'the fridge freezer\'s mains input or control', 'lights-on-not-running': 'the control or start side not starting the compressor',
  'click-start-relay-or-compressor': 'the compressor start device or the compressor', 'condenser-coils-or-clearance': 'dusty coils or too little space round it', 'running-not-cooling': 'the sealed cooling system' };
const TASK = {
  'ask_observation:noPower': { say: 'First, whether it has power at all.', ask: 'When you open the fridge door, does the inside light or the display come on, or is it completely dead?' },
  'ask_check:power-supply': { say: 'Check the plug is pushed fully in and the socket is switched on, and try something else (like a lamp) in that socket. If the house electrics have tripped, don\'t keep resetting it.', ask: 'Was the plug, switch or fuse off (and is it sorted), or does the socket work fine with something else?' },
  'ask_observation:ffCompressorState': { say: 'Now listen near the bottom at the back for a few minutes.', ask: 'Can you hear it humming / running, does it just click every few minutes without starting, or is it silent?' },
  'ask_check:condenser-coil-clear': { say: 'Clicking without starting can happen when it overheats. Gently dust or vacuum the coil or grille at the back or underneath, and leave a few centimetres of space round it, then give it a couple of hours.', ask: 'Was it dusty or pushed against the wall (and have you sorted it), or was it already clean with space?' },
  'ask_check:retest': { say: 'Leave it running with the doors shut for a few hours.', ask: 'Is it running and getting cold now, or still not?' },
  'ask_identity:appliance': { say: '', ask: 'Is it a fridge freezer, a fridge or a freezer?' },
};
const CONCLUSION = {
  'FP7:power-supply': 'That was the power supply, so no part is needed. Give it a few hours to get cold again.',
  'FP7:condenser-coils-or-clearance': 'Cleaning the coils and giving it space very likely fixed it, so no part is needed.',
  'mains-or-control-dead': `With the socket working but no lights at all, the fault is in the fridge freezer's mains input or control. Please don't open it up — an appliance engineer is the next step, and I'm not recommending a part from this. ${FOOD}`,
  'lights-on-not-running': `It has power but the motor at the back never runs, so the control or start side isn't starting the compressor. That needs an appliance engineer to test safely — please don't take covers off at the back. I'm not recommending a part from this. ${FOOD}`,
  'click-start-relay-or-compressor': `Clicking every few minutes without starting is the compressor trying to start and its protector cutting it out — usually the start device (relay) or the compressor itself. Only live testing tells them apart, so this needs a refrigeration engineer; please don't take the cover off at the back. I'm not recommending a part from this. ${FOOD}`,
  'running-not-cooling': `It runs but doesn't get cold, so the fault is most likely in the sealed cooling system (or the airflow inside). Please don't open any pipes; a refrigeration engineer is the next step — I'm not recommending a part from this. ${FOOD}`,
};
const compose = ck.createCompose({
  TASK, CONFIRM_ASK: 'Is it running and getting cold now?',
  OBS_COPY: { noPower: ['completely dead', 'lights come on'], compressorRuns: ['can hear it running', 'silent at the back'], clicksNoStart: ['clicks but never starts', null], faultPersists: ['still not working', 'working again'] },
  CHECK_RESULT_COPY: { 'power-supply': { clear: 'socket and plug fine', found_and_cleared: 'plug / switch / fuse sorted' }, 'condenser-coil-clear': { clear: 'coils clean with space', found_and_cleared: 'coils cleaned / space made' } },
  statusChecks: [['retest', 'retest']],
  conclusionCopy: ck.makeConclusionCopy({ FAMILY_LABEL, COMPONENT_LABEL: {}, CONCLUSION }),
  PURCHASE_RE: /\b(buy|order|purchase|price|£\s?\d)|\b(new|replacement|replace the)\s+(compressor|relay|start relay|thermostat|pcb|control board|fuse)\b/i,
});
module.exports = { SPEC, FAMILY, diagnose, P, ...pipeline, FAMILY_LABEL, COMPONENT_LABEL: {}, TASK, REQUIREMENT: ck.REQUIREMENT, SAFETY_COPY: ck.SAFETY_COPY, ...compose };
