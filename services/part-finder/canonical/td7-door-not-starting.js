'use strict';
/**
 * Tumble dryer journey 7 — door / not starting (rules DG1–DG22). PURE, deterministic.
 * Design: docs/diagnostics/ff-td-batch-evidence.md §TD7. Also owns a drum-not-turning report where the door is not
 * recognised (td-family). A container-full warning that stops it → td-water-container-drain (once). Four states:
 *   POWER DEAD (no lights)        → supply / fuse (no electrical testing) → mains / control (engineer)
 *   DOOR NOT RECOGNISED           → shut firmly → catch / strike / fluff → door latch / switch (part with model + evidence)
 *   DOOR RECOGNISED, NO START     → child lock → delay start / programme → start control (engineer); never re-asks the latch
 * Never: bypassing the door interlock.
 */
const engine = require('./evidence-engine.js');
const kit = require('./policy-kit.js');
const JP = require('./journey-pipeline.js');
const F = require('./td-family.js');
const ck = require('./compose-kit.js');
const { SS, S, A, SA } = engine;

const KEY = 'td-door-not-starting';
const FAMILY = { PW: 'power-supply', MP: 'mains-or-control-dead', CL: 'child-lock', DY: 'delay-start-or-programme', AL: 'door-obstruction-or-alignment', DL: 'door-latch', CT: 'start-control' };
const SIGNALS = {
  PW: { dead: SS, powerFixed: SS, restoredAfterPowerFix: SS, failsAfterPowerFix: SA, socketOk: A, powered: SA },
  MP: { dead: S, socketOk: SS, powered: SA, powerFixed: A },
  CL: { childLockOff: SS, restoredAfterChildFix: SS, failsAfterChildFix: SA, recognised: S, powered: S, childLockOk: SA, dead: SA },
  DY: { progFixed: SS, restoredAfterProgFix: SS, failsAfterProgFix: SA, recognised: S, powered: S, progOk: SA, dead: SA },
  AL: { catchCleared: SS, restoredAfterCatchFix: SS, failsAfterCatchFix: SA, noLatch: S, notRecog: S, catchOk: SA, recognised: SA, dead: SA },
  DL: { notRecogChecked: SS, pushed: SS, catchBroken: SS, notRecog: S, noLatch: S, catchOk: S, recognised: SA, dead: SA, restoredAfterCatchFix: SA },
  CT: { recognised: S, powered: S, childLockOk: S, progOk: S, notRecog: A, dead: SA, restoredAfterChildFix: SA, restoredAfterProgFix: SA, restoredAfterCatchFix: SA },
};
const FACT_LABEL = {
  dead: 'no lights / completely dead', powered: 'lights come on', socketOk: 'socket and plug fine', powerFixed: 'plug / switch / fuse was off (sorted)',
  recognised: 'door recognised as shut', notRecog: 'says door open', notRecogChecked: 'shut firmly and still says door open', noLatch: 'door will not latch',
  pushed: 'only starts if the door is pushed', catchOk: 'catch and strike look fine', catchCleared: 'fluff / something in the catch (cleared)', catchBroken: 'door catch broken',
  childLockOff: 'child lock was on (off now)', childLockOk: 'child lock off', progFixed: 'delay start / programme was the cause', progOk: 'no delay start set',
};
const SPEC = {
  schema: 'td7-diag/1', FAMILY, PRIOR: ['PW', 'MP', 'CL', 'DY', 'AL', 'DL', 'CT'], SIGNALS, FACT_LABEL,
  obs: { dead: ['noPower', true], powered: ['noPower', false], recognised: ['doorRecognised', true], notRecog: ['doorRecognised', false], noLatch: ['doorCloses', false],
    pushed: ['startsWhenPushed', true] },
  checks: { 'power-supply': { clear: 'socketOk', found: 'powerFixed' }, 'door-catch': { clear: 'catchOk', found: 'catchCleared', fault: 'catchBroken' },
    'child-lock': { clear: 'childLockOk', found: 'childLockOff' }, 'programme-setting': { clear: 'progOk', found: 'progFixed' } },
  FIX_CHECK: { PW: ['power-supply', 'Power'], AL: ['door-catch', 'Catch'], CL: ['child-lock', 'Child'], DY: ['programme-setting', 'Prog'] },
  DECISIVE_PART: { DL: { notRecogChecked: 'door-latch', pushed: 'door-latch', catchBroken: 'door-latch' } },
  architecture: (s, ctx) => F.tdArchitecture(s, ctx),
  extra(s, ctx, on) {
    on('notRecogChecked', engine.obsVal(s, 'doorRecognised') === false && engine.checkDone(s, 'door-start-test'));
    if (ctx.codeFault === 'door') on('notRecog', true);
  },
  eligible: (k, has) => (k === 'PW' || k === 'MP' ? has('dead') || has('powerFixed') : true),
};
function diagnose(state, ctx = {}) {
  const codeFault = ctx.codeFault !== undefined ? ctx.codeFault : F.tdCodeFault(state, ctx.errorCodes || null);
  return engine.diagnoseSpec(SPEC, state, { ...ctx, codeFault });
}
const DOOR = ['notRecog', 'noLatch', 'pushed'];
const P = kit.makeStepPolicy({
  JOURNEY: KEY, P: 'DG', appliance: 'tumble-dryer', journeys: ['door-problem', 'wont-start', 'controls-unresponsive'], ...F.owns(KEY), declineUnsafe: F.UNSAFE,
  CHECKS: ['power-supply', 'door-start-test', 'door-catch', 'child-lock', 'programme-setting'],
  OBS_TARGETS: { noPower: ['noPower'], doorRecognised: ['doorRecognised'] },
  outcomeObs: { 'door-start-test': 'doorRecognised' },
  REQUIRES: {
    'power-supply': ['no_live_electrical_checks'], 'door-start-test': ['do_not_force_door', 'never_bypass_interlock'],
    'door-catch': ['td_unplug_cool', 'look_only_no_tools'], 'child-lock': [], 'programme-setting': [], retest: [],
  },
  FIX_CHECKS: ['power-supply', 'door-catch', 'child-lock', 'programme-setting'],
  steps: [
    { n: 10, target: 'noPower', reason: 'dead-vs-powered', when: (h) => !h.has('dead') && !h.has('powered') && !DOOR.some(h.has) && !h.has('recognised') },
    { n: 11, target: 'power-supply', reason: 'supply-before-machine', when: (h) => h.has('dead') },
    { n: 12, target: 'doorRecognised', reason: 'door-recognised-splits', when: (h) => !h.has('dead') && !DOOR.some(h.has) },
    { n: 13, target: 'door-start-test', reason: 'shut-firmly', when: (h) => !h.has('dead') && (h.has('notRecog') || h.has('noLatch') || h.has('pushed')) },
    { n: 14, target: 'door-catch', reason: 'catch-strike-fluff', when: (h) => !h.has('dead') && (h.has('notRecogChecked') || h.has('noLatch') || h.has('pushed')) },
    { n: 15, target: 'child-lock', reason: 'child-lock', when: (h) => h.has('recognised') || (h.has('powered') && !DOOR.some(h.has)) },
    { n: 16, target: 'programme-setting', reason: 'delay-start-programme', when: (h) => h.has('recognised') || (h.has('powered') && !DOOR.some(h.has)) },
  ],
  PART_FAMILIES: new Set(['DL']),
  HANDOFF: { PW: 'none', MP: 'engineer', CL: 'none', DY: 'none', AL: 'none', DL: 'engineer', CT: 'engineer' },
});
const pipeline = JP.makeModelPartPipeline({
  D: { diagnose }, P, schema: 'td7/1', codeFaultFor: F.tdCodeFault,
  PART_MATCH: { 'door-latch': { re: /door\s+(lock|latch|catch|interlock|switch)|\binterlock\b|door\s+catch/i, not: /plinth|seal|gasket|hinge|handle|filter|washing|dishwasher/i } },
  MEDIA_BY_KEY: {},
});

// ---- COMPOSE (wording only) ----
const FAMILY_LABEL = {
  'power-supply': 'the power supply (plug, socket or fuse)', 'mains-or-control-dead': 'the dryer\'s mains input or control board', 'child-lock': 'the child lock',
  'delay-start-or-programme': 'a delay start or programme setting', 'door-obstruction-or-alignment': 'something stopping the door shutting fully', 'door-latch': 'the door catch / door switch',
  'start-control': 'the start control side',
};
const COMPONENT_LABEL = { 'door-latch': 'door catch / interlock' };
const TASK = {
  'ask_observation:noPower': { say: 'First, whether it has power at all.', ask: 'When you press the power or start button, do any lights or the display come on?' },
  'ask_check:power-supply': { say: 'Check the dryer\'s plug is pushed fully in and the socket is on, and try another appliance in that socket. If the house electrics have tripped, don\'t keep resetting it.', ask: 'Was a switch, plug or fuse off (and is it sorted), or does the socket work fine with something else?' },
  'ask_observation:doorRecognised': { say: 'Next, whether it knows the door is shut.', ask: 'With the door shut, when you press start does it show the door as open (or a door light stays on)?' },
  'ask_check:door-start-test': { say: 'Open the door, make sure no clothing is caught in it, then shut it firmly until it clicks and press start.', ask: 'Does it still show the door as open?' },
  'ask_check:door-catch': { say: 'With the dryer unplugged, look at the catch on the door and the slot it clicks into: fluff or a bit of fabric can stop it engaging, and check the door lines up when you close it.', ask: 'Is the catch broken, was something stopping it (now cleared), or does it all look fine?' },
  'ask_check:child-lock': { say: 'Many dryers have a child lock (often a key or padlock symbol) that stops the buttons working — the manual shows which buttons to hold to turn it off.', ask: 'Was the child lock on (and is it off now), or was it already off?' },
  'ask_check:programme-setting': { say: 'A delay start (often a countdown on the display) or a programme that hasn\'t been confirmed can look like it won\'t start.', ask: 'Was a delay start set or the programme not selected (and is it sorted), or was nothing like that set?' },
  'ask_check:retest': { say: 'Now choose a programme and press start.', ask: 'Does it start normally now, or still not?' },
  'ask_identity:model': { say: 'To match the right part for your dryer I need its exact model.', ask: 'Could you send me the model number? It\'s on the rating plate inside the door rim or on the back — a photo is fine.' },
  'ask_identity:appliance': { say: '', ask: 'Is it a tumble dryer or a washer-dryer?' },
};
const CONCLUSION = {
  'mains-or-control-dead': 'With the socket working but no lights at all, the fault is in the dryer\'s mains input or control board. Please don\'t open it up — an appliance engineer is the best next step. I\'m not recommending a part from this.',
  'DG7:power-supply': 'That was the power supply, so no part is needed.', 'DG7:child-lock': 'The child lock was on, so no part is needed.',
  'DG7:delay-start-or-programme': 'That was the delay start / programme setting, so no part is needed.', 'DG7:door-obstruction-or-alignment': 'Clearing what was stopping the door very likely fixed it, so no part is needed.',
  'start-control': 'It has power and knows the door is shut, with no lock or delay set, so the fault is on the start control side. That needs an appliance engineer — I\'m not recommending a part from this.',
  'door-latch': 'This points to the door catch or its door switch. Please don\'t try to force or bypass it — an appliance engineer can confirm it safely; I\'m not recommending a part from this.',
};
const compose = ck.createCompose({
  TASK, CONFIRM_ASK: 'Is it starting normally now?',
  OBS_COPY: { noPower: ['no lights at all', 'lights come on'], doorRecognised: ['door recognised', 'says door open'], doorCloses: [null, 'door won\'t latch'],
    startsWhenPushed: ['only starts when the door is pushed', null], faultPersists: ['still won\'t start', 'starts now'] },
  CHECK_RESULT_COPY: {
    'power-supply': { clear: 'socket and plug fine', found_and_cleared: 'switch / fuse / plug was off (sorted)' },
    'door-catch': { clear: 'catch and strike fine', found_and_cleared: 'something in the catch (cleared)', fault_seen: 'door catch broken' },
    'child-lock': { clear: 'child lock off', found_and_cleared: 'child lock was on (off now)' },
    'programme-setting': { clear: 'no delay start', found_and_cleared: 'delay start / programme sorted' },
  },
  statusChecks: [['door-start-test', 'door test'], ['retest', 'retest']],
  conclusionCopy: ck.makeConclusionCopy({ FAMILY_LABEL, COMPONENT_LABEL, CONCLUSION, fitNote: 'Unplug the dryer before fitting it; if you\'d rather not, an appliance engineer can fit it.' }),
  PURCHASE_RE: /\b(buy|order|purchase|price|£\s?\d)|\b(new|replacement|replace the)\s+(door lock|latch|door catch|catch|door switch|interlock|pcb|control board|hinge|fuse)\b/i,
});
module.exports = { SPEC, FAMILY, diagnose, P, ...pipeline, FAMILY_LABEL, COMPONENT_LABEL, TASK, REQUIREMENT: ck.REQUIREMENT, SAFETY_COPY: ck.SAFETY_COPY, ...compose };
