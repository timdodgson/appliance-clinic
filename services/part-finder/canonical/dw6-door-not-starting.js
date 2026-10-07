'use strict';
/**
 * Dishwasher journey 6 — door / not starting (rules G1–G22). PURE, deterministic.
 * Design: docs/diagnostics/dw-batch-1-evidence.md §6. Four distinct states:
 *   POWER DEAD (no lights) → supply / spur / fuse (no electrical testing) → appliance mains / control (engineer)
 *   POWERED, DOOR NOT RECOGNISED → shut firmly → latch / strike / alignment → door latch (part with model)
 *   POWERED, DOOR RECOGNISED → child / control lock → delay start / programme → control (engineer); never re-asks the latch
 *   FLOOD PROTECTION → dw-leaking owns it (ownedElsewhere), once.
 * Never: bypassing the door switch.
 */
const engine = require('./evidence-engine.js');
const kit = require('./policy-kit.js');
const JP = require('./journey-pipeline.js');
const F = require('./dw-family.js');
const ck = require('./compose-kit.js');
const { SS, S, A, SA } = engine;

const FAMILY = { PW: 'power-supply', MP: 'mains-or-control-dead', CL: 'child-or-control-lock', DY: 'delay-start-or-programme', AL: 'door-obstruction-or-alignment', DL: 'door-latch', CT: 'start-control' };
const SIGNALS = {
  PW: { dead: SS, powerFixed: SS, restoredAfterPowerFix: SS, failsAfterPowerFix: SA, socketOk: A, powered: SA },
  MP: { dead: S, socketOk: SS, powered: SA, powerFixed: A },
  CL: { childLockOff: SS, restoredAfterChildFix: SS, failsAfterChildFix: SA, recognised: S, powered: S, childLockOk: SA, dead: SA },
  DY: { progFixed: SS, restoredAfterProgFix: SS, failsAfterProgFix: SA, recognised: S, powered: S, progOk: SA, dead: SA },
  AL: { catchCleared: SS, restoredAfterCatchFix: SS, failsAfterCatchFix: SA, noLatch: S, notRecog: S, catchOk: SA, recognised: SA, dead: SA },
  DL: { notRecogChecked: SS, pushed: SS, catchBroken: SS, notRecog: S, noLatch: S, catchOk: S, recognised: SA, dead: SA },
  CT: { codeControl: SS, recognised: S, powered: S, childLockOk: S, progOk: S, notRecog: A, dead: SA },
};
const FACT_LABEL = {
  dead: 'no lights / completely dead', powered: 'lights come on', socketOk: 'socket and switch fine', powerFixed: 'switch / fuse / plug was off (sorted)',
  recognised: 'door recognised as shut', notRecog: 'says door open', notRecogChecked: 'shut firmly and still says door open', noLatch: 'door will not latch',
  pushed: 'only starts if the door is pushed', catchOk: 'latch and strike look fine', catchCleared: 'something stopping the door (cleared)', catchBroken: 'latch / catch broken',
  childLockOff: 'child / control lock was on (off now)', childLockOk: 'child lock off', progFixed: 'delay start / programme setting was the cause', progOk: 'no delay start set',
  codeControl: 'control error code', codeDoor: 'door error code',
};
const SPEC = {
  schema: 'dw6-diag/1', FAMILY, PRIOR: ['PW', 'MP', 'CL', 'DY', 'AL', 'DL', 'CT'], SIGNALS, FACT_LABEL,
  obs: { dead: ['noPower', true], powered: ['noPower', false], recognised: ['doorRecognised', true], notRecog: ['doorRecognised', false], noLatch: ['doorCloses', false],
    pushed: ['startsWhenPushed', true] },
  checks: { 'power-supply': { clear: 'socketOk', found: 'powerFixed' }, 'door-catch': { clear: 'catchOk', found: 'catchCleared', fault: 'catchBroken' },
    'child-lock': { clear: 'childLockOk', found: 'childLockOff' }, 'programme-setting': { clear: 'progOk', found: 'progFixed' } },
  FIX_CHECK: { PW: ['power-supply', 'Power'], AL: ['door-catch', 'Catch'], CL: ['child-lock', 'Child'], DY: ['programme-setting', 'Prog'] },
  DECISIVE_PART: { DL: { notRecogChecked: 'door-lock', pushed: 'door-lock', catchBroken: 'door-lock' } },
  extra(s, ctx, on) {
    on('notRecogChecked', engine.obsVal(s, 'doorRecognised') === false && engine.checkDone(s, 'door-start-test'));
    on('codeControl', ctx.codeFault === 'main-pcb');
    if (ctx.codeFault === 'door') on('notRecog', true);
  },
  eligible: (k, has) => (k === 'PW' || k === 'MP' ? has('dead') || has('powerFixed') : true),
};
function diagnose(state, ctx = {}) {
  const codeFault = ctx.codeFault !== undefined ? ctx.codeFault : F.dwCodeFault(state, ctx.errorCodes || null);
  return engine.diagnoseSpec(SPEC, state, { ...ctx, codeFault });
}
const DOOR = ['notRecog', 'noLatch', 'pushed'];
const P = kit.makeStepPolicy({
  JOURNEY: 'dw-door-not-starting', P: 'G', appliance: 'dishwasher', journeys: ['door-problem', 'wont-start', 'controls-unresponsive'], codeFaults: ['door'],
  ownedElsewhere: (h) => F.flood(h),
  CHECKS: ['power-supply', 'door-start-test', 'door-catch', 'child-lock', 'programme-setting'],
  OBS_TARGETS: { noPower: ['noPower'], doorRecognised: ['doorRecognised'] },
  outcomeObs: { 'door-start-test': 'doorRecognised' },
  REQUIRES: {
    'power-supply': ['no_live_electrical_checks'], 'door-start-test': ['do_not_force_door', 'never_bypass_interlock'],
    'door-catch': ['isolate_mains', 'look_only_no_tools'], 'child-lock': [], 'programme-setting': [], retest: [],
  },
  FIX_CHECKS: ['power-supply', 'door-catch', 'child-lock', 'programme-setting'],
  steps: [
    { n: 10, target: 'noPower', reason: 'dead-vs-powered', when: (h) => !h.has('dead') && !h.has('powered') && !DOOR.some(h.has) && !h.has('recognised') },
    { n: 11, target: 'power-supply', reason: 'supply-before-machine', when: (h) => h.has('dead') },
    { n: 12, target: 'doorRecognised', reason: 'door-recognised-splits', when: (h) => !h.has('dead') && !DOOR.some(h.has) },
    { n: 13, target: 'door-start-test', reason: 'shut-firmly', when: (h) => !h.has('dead') && (h.has('notRecog') || h.has('noLatch') || h.has('pushed')) },
    { n: 14, target: 'door-catch', reason: 'latch-strike-alignment', when: (h) => !h.has('dead') && (h.has('notRecogChecked') || h.has('noLatch') || h.has('pushed')) },
    { n: 15, target: 'child-lock', reason: 'control-lock', when: (h) => h.has('recognised') || (h.has('powered') && !DOOR.some(h.has)) },
    { n: 16, target: 'programme-setting', reason: 'delay-start-programme', when: (h) => h.has('recognised') || (h.has('powered') && !DOOR.some(h.has)) },
  ],
  PART_FAMILIES: new Set(['DL']),
  HANDOFF: { PW: 'none', MP: 'engineer', CL: 'none', DY: 'none', AL: 'none', DL: 'engineer', CT: 'engineer' },
});

const pipeline = JP.makeModelPartPipeline({
  D: { diagnose }, P, schema: 'dw6/1', codeFaultFor: F.dwCodeFault,
  PART_MATCH: { 'door-lock': { re: /door\s+(lock|latch|interlock|switch)|\binterlock\b/i, not: /seal|hinge|gasket|spring|cable|rope/i } },
  MEDIA_BY_KEY: {},
});

// ---- COMPOSE (wording only) ----
const FAMILY_LABEL = {
  'power-supply': 'the power supply (plug, switch or fuse)', 'mains-or-control-dead': 'the dishwasher\'s mains input or control board', 'child-or-control-lock': 'the child / control lock',
  'delay-start-or-programme': 'a delay start or programme setting', 'door-obstruction-or-alignment': 'something stopping the door shutting fully', 'door-latch': 'the door latch / door switch',
  'start-control': 'the start control side',
};
const COMPONENT_LABEL = { 'door-lock': 'door latch / lock assembly' };
const TASK = {
  'ask_observation:noPower': { say: 'First, whether it has power at all.', ask: 'When you press the power button, do any lights or the display come on?' },
  'ask_check:power-supply': { say: 'Check the dishwasher\'s plug is fully in and its socket or the switched spur (often a switch above the worktop) is on, and try another appliance in that socket. If the electrics have tripped, don\'t keep resetting it.', ask: 'Was a switch, plug or fuse off (and is it sorted), or does the socket work fine with something else?' },
  'ask_observation:doorRecognised': { say: 'Next, whether it knows the door is shut.', ask: 'When the door is closed and you press start, does it show the door is open (or a door light stays on)?' },
  'ask_check:door-start-test': { say: 'Open the door, check nothing in the racks or the cutlery basket sticks out, then shut it firmly until it clicks and press start.', ask: 'Does it still show the door as open?' },
  'ask_check:door-catch': { say: 'With the dishwasher switched off at the socket, look at the latch at the top of the door and the slot it clicks into on the tub, and check the door lines up squarely when you close it.', ask: 'Is the latch or catch broken, was something stopping it (now cleared), or does it all look fine?' },
  'ask_check:child-lock': { say: 'Many dishwashers have a child or control lock (often a key or padlock symbol) that stops the buttons working — the manual shows which buttons to hold to turn it off.', ask: 'Was the child / control lock on (and is it off now), or was it already off?' },
  'ask_check:programme-setting': { say: 'A delay start (often shown as a countdown like "3h") or a programme that hasn\'t been confirmed can look like it won\'t start.', ask: 'Was a delay start set or the programme not selected (and is it sorted), or was nothing like that set?' },
  'ask_check:retest': { say: 'Now choose a programme and press start.', ask: 'Does it start normally now, or still not?' },
  'ask_identity:model': { say: 'To match the right part for your dishwasher I need its exact model.', ask: 'Could you send me the model number? It\'s on the rating plate along the edge of the door or the side of the tub — a photo of the label is fine.' },
  'ask_identity:appliance': { say: '', ask: 'Is it a dishwasher, a washing machine or a washer-dryer?' },
};
const CONCLUSION = {
  'mains-or-control-dead': 'With the socket and switch working but no lights at all, the fault is in the dishwasher\'s mains input or control board. Please don\'t open it up — an appliance engineer is the best next step. I\'m not recommending a part from this.',
  'G7:power-supply': 'That was the power supply, so no part is needed.', 'G7:child-or-control-lock': 'The control lock was on, so no part is needed.',
  'G7:delay-start-or-programme': 'That was the delay start / programme setting, so no part is needed.', 'G7:door-obstruction-or-alignment': 'Clearing what was stopping the door very likely fixed it, so no part is needed.',
  'start-control': 'It has power and knows the door is shut, with no lock or delay set, so the fault is on the start control side. That needs an appliance engineer — I\'m not recommending a part from this.',
  'door-latch': 'This points to the door latch or its door switch. Please don\'t try to force or bypass it — an appliance engineer can confirm it safely; I\'m not recommending a part from this.',
};
const compose = ck.createCompose({
  TASK, CONFIRM_ASK: 'Is it starting normally now?',
  OBS_COPY: { noPower: ['no lights at all', 'lights come on'], doorRecognised: ['door recognised', 'says door open'], doorCloses: [null, 'door won\'t latch'],
    startsWhenPushed: ['only starts when the door is pushed', null], faultPersists: ['still won\'t start', 'starts now'] },
  CHECK_RESULT_COPY: {
    'power-supply': { clear: 'socket and switch fine', found_and_cleared: 'switch / fuse / plug was off (sorted)' },
    'door-catch': { clear: 'latch and strike fine', found_and_cleared: 'something stopping the door (cleared)', fault_seen: 'latch / catch broken' },
    'child-lock': { clear: 'child lock off', found_and_cleared: 'child lock was on (off now)' },
    'programme-setting': { clear: 'no delay start', found_and_cleared: 'delay start / programme sorted' },
  },
  statusChecks: [['door-start-test', 'door test'], ['retest', 'retest']],
  conclusionCopy: ck.makeConclusionCopy({ FAMILY_LABEL, COMPONENT_LABEL, CONCLUSION, fitNote: 'Switch the dishwasher off at the socket before fitting it; if you\'d rather not, an appliance engineer can fit it.' }),
  PURCHASE_RE: /\b(buy|order|purchase|price|£\s?\d)|\b(new|replacement|replace the)\s+(door lock|latch|door switch|interlock|pcb|control board|hinge|fuse)\b/i,
});
module.exports = { SPEC, FAMILY, diagnose, P, ...pipeline, FAMILY_LABEL, COMPONENT_LABEL, TASK, REQUIREMENT: ck.REQUIREMENT, SAFETY_COPY: ck.SAFETY_COPY, ...compose };
