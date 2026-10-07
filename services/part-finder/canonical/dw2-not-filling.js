'use strict';
/**
 * Dishwasher journey 2 — not filling (rules B1–B22). PURE, deterministic. Diagnostics + policy + pipeline + COMPOSE.
 * Design: docs/diagnostics/dw-batch-1-evidence.md §2. Supply → flood protection (water in the base: dw-leaking owns it,
 * once) → door recognised → tap / hose / AquaStop → inlet mesh. The inlet valve is part-eligible only with every
 * accessible cause cleared, a dry base AND a fill error code — never from "no water" alone.
 */
const engine = require('./evidence-engine.js');
const kit = require('./policy-kit.js');
const JP = require('./journey-pipeline.js');
const F = require('./dw-family.js');
const ck = require('./compose-kit.js');
const { SS, S, A, SA } = engine;

const FAMILY = { SU: 'household-supply', TH: 'tap-hose-or-aquastop', MF: 'inlet-mesh-filter', DI: 'door-not-recognised', IV: 'inlet-valve', PC: 'fill-sensing-or-control' };
const SIGNALS = {
  SU: { supplyBad: SS, noWater: S, slow: S, supplyOk: SA },
  TH: { tapHoseFixed: SS, hoseDamaged: SS, restoredAfterSupplyFix: SS, failsAfterSupplyFix: SA, noWater: S, slow: S, supplyOk: S, tapHoseOk: SA, supplyBad: A },
  MF: { meshCleaned: SS, restoredAfterMeshFix: SS, failsAfterMeshFix: SA, slow: SS, noWater: S, supplyOk: S, meshOk: SA, tapHoseFixed: A, hoseDamaged: A, supplyBad: A },
  DI: { doorNotRecognisedChecked: SS, doorNotRecognised: S, noWater: S, doorRecognised: SA, slow: SA },
  IV: { valvePathFail: SS, noWater: S, supplyOk: S, tapHoseOk: S, meshOk: S, doorRecognised: S, baseDry: S, codeFill: S, slow: A, tapHoseFixed: A, meshCleaned: A, hoseDamaged: SA,
    doorNotRecognised: A, supplyBad: A },
  PC: { codeFlow: SS, codePressure: SS, noWater: S, supplyOk: S, tapHoseOk: S, meshOk: S, doorRecognised: S, tapHoseFixed: A, meshCleaned: A, hoseDamaged: SA, doorNotRecognised: A, supplyBad: A },
};
const FACT_LABEL = {
  noWater: 'no water comes in', slow: 'only a little / slow fill', supplyOk: 'supply fine', supplyBad: 'household supply off / low', tapHoseOk: 'tap on, hose not kinked, AquaStop clear',
  tapHoseFixed: 'tap off / hose kinked (fixed)', hoseDamaged: 'inlet hose damaged / AquaStop tripped', meshOk: 'inlet mesh clean', meshCleaned: 'inlet mesh blocked (cleaned)',
  doorRecognised: 'door recognised as shut', doorNotRecognised: 'says door open', doorNotRecognisedChecked: 'shut firmly and still says door open', baseDry: 'base dry',
  valvePathFail: 'everything accessible clear, base dry, fill error code', codeFill: 'fill error code', codeFlow: 'flow-meter error code', codePressure: 'level error code',
};
const SPEC = {
  schema: 'dw2-diag/1', FAMILY, PRIOR: ['SU', 'TH', 'MF', 'DI', 'IV', 'PC'], SIGNALS, FACT_LABEL,
  obs: { noWater: ['waterEntering', false], slow: ['fillsSlowly', true], supplyOk: ['supplyOk', true], supplyBad: ['supplyOk', false],
    doorRecognised: ['doorRecognised', true], doorNotRecognised: ['doorRecognised', false], baseDry: ['waterInBase', false] },
  checks: { 'inlet-hose-tap': { clear: 'tapHoseOk', found: 'tapHoseFixed', fault: 'hoseDamaged' }, 'inlet-filter': { clear: 'meshOk', found: 'meshCleaned' } },
  FIX_CHECK: { TH: ['inlet-hose-tap', 'Supply'], MF: ['inlet-filter', 'Mesh'] },
  DECISIVE_PART: { TH: { hoseDamaged: 'inlet-hose' }, DI: { doorNotRecognisedChecked: 'door-lock' }, IV: { valvePathFail: 'inlet-valve' } },
  extra(s, ctx, on) {
    const v = (k, x) => engine.obsVal(s, k) === x; const r = (c) => engine.checkResult(s, c);
    on('doorNotRecognisedChecked', v('doorRecognised', false) && engine.checkDone(s, 'door-start-test'));
    on('codeFill', ctx.codeFault === 'fill'); on('codeFlow', ctx.codeFault === 'flow-meter'); on('codePressure', ctx.codeFault === 'pressure-switch');
    on('valvePathFail', ctx.codeFault === 'fill' && v('waterEntering', false) && v('supplyOk', true) && v('waterInBase', false) && !v('doorRecognised', false)
      && r('inlet-hose-tap') === 'clear' && r('inlet-filter') === 'clear');
  },
  eligible: (k, has) => (k === 'SU' ? has('supplyBad') : k === 'DI' ? has('doorNotRecognised') : true),
};
function diagnose(state, ctx = {}) {
  const codeFault = ctx.codeFault !== undefined ? ctx.codeFault : F.dwCodeFault(state, ctx.errorCodes || null);
  return engine.diagnoseSpec(SPEC, state, { ...ctx, codeFault });
}

const P = kit.makeStepPolicy({
  JOURNEY: 'dw-not-filling', P: 'B', appliance: 'dishwasher', journeys: ['not-filling'], codeFaults: ['fill', 'flow-meter'],
  claims: (h, journey) => journey === 'poor-results' && F.fillIssue(h) && !F.flood(h),
  ownedElsewhere: (h) => F.flood(h),
  CHECKS: ['inlet-hose-tap', 'inlet-filter', 'door-start-test'],
  OBS_TARGETS: { fillState: ['waterEntering', 'fillsSlowly'], supplyOk: ['supplyOk'], waterInBase: ['waterInBase'], doorRecognised: ['doorRecognised'] },
  outcomeObs: { 'door-start-test': 'doorRecognised' },
  REQUIRES: {
    'inlet-hose-tap': ['tap_hose_from_outside'], 'inlet-filter': ['isolate_mains', 'water_off_at_tap', 'contain_water', 'mesh_rinse_only'],
    'door-start-test': ['do_not_force_door', 'never_bypass_interlock'], waterInBase: ['no_tilting'], retest: [],
  },
  FIX_CHECKS: ['inlet-hose-tap', 'inlet-filter'],
  early(h) { return h.has('supplyBad') ? { target: 'household-supply', reason: 'household-supply-off-or-low', rule: 'B5', handoff: 'plumbing' } : null; },
  steps: [
    { n: 10, target: 'fillState', reason: 'none-vs-little', when: (h) => !h.has('noWater') && !h.has('slow') },
    { n: 11, target: 'supplyOk', reason: 'household-supply-first', when: () => true },
    { n: 12, target: 'waterInBase', reason: 'flood-protection-stops-fill', when: () => true },
    { n: 13, target: 'doorRecognised', reason: 'no-fill-until-door-recognised', when: (h) => h.has('noWater') },
    { n: 14, target: 'door-start-test', reason: 'door-shut-firmly', when: (h) => h.has('doorNotRecognised') },
    { n: 15, target: 'inlet-hose-tap', reason: 'tap-hose-aquastop', when: (h) => !h.has('doorNotRecognisedChecked') },
    { n: 16, target: 'inlet-filter', reason: 'mesh-before-valve', when: (h) => !h.has('doorNotRecognisedChecked') && !h.has('hoseDamaged') },
  ],
  PART_FAMILIES: new Set(['TH', 'DI', 'IV']),
  HANDOFF: { SU: 'plumbing', TH: 'engineer', MF: 'none', DI: 'engineer', IV: 'engineer', PC: 'engineer' },
});

const pipeline = JP.makeModelPartPipeline({
  D: { diagnose }, P, schema: 'dw2/1', codeFaultFor: F.dwCodeFault,
  PART_MATCH: {
    'inlet-hose': { re: /(inlet|fill|supply|aqua\s*-?stop)\s*hose|aqua\s*-?stop/i, not: /drain/i },
    'inlet-valve': { re: /(inlet|fill|water)\s+valve|\bsol[ei]noid\b|\bsolinoid\b/i, not: /drain|non[- ]?return|diverter/i },
    'door-lock': { re: /door\s+(lock|latch|interlock)|\binterlock\b/i, not: /seal|hinge|gasket|spring/i },
  },
  MEDIA_BY_KEY: {},
});

// ---- COMPOSE (wording only) ----
const FAMILY_LABEL = {
  'household-supply': 'the household water supply', 'tap-hose-or-aquastop': 'the tap, inlet hose or its AquaStop safety valve', 'inlet-mesh-filter': 'a blocked inlet mesh filter',
  'door-not-recognised': 'the door latch / switch (it won\'t fill until the door is recognised as shut)', 'inlet-valve': 'the inlet (fill) valve', 'fill-sensing-or-control': 'the fill sensing or the control side',
};
const COMPONENT_LABEL = { 'inlet-hose': 'inlet (AquaStop) hose', 'inlet-valve': 'inlet (fill) valve', 'door-lock': 'door latch / lock' };
const TASK = {
  'ask_observation:fillState': { say: 'Let\'s narrow down the fill problem.', ask: 'After it starts, does no water come in at all, or only a little?' },
  'ask_observation:supplyOk': { say: 'First, the supply to the house.', ask: 'Do your other taps (for example the kitchen cold tap) run at normal pressure right now?' },
  'ask_observation:waterInBase': { say: 'Many dishwashers have a flood-protection float in the base: if any water collects there, they stop filling (and often keep pumping) on purpose.', ask: 'Can you see any water in the base under the front kick plate, or a flood / tap warning symbol on the display?' },
  'ask_observation:doorRecognised': { say: 'It won\'t let water in until it knows the door is shut.', ask: 'When you close the door and press start, does it show the door is open (or a door light stay on)?' },
  'ask_check:door-start-test': { say: 'Open the door, make sure nothing in the racks is sticking out, then shut it firmly until it clicks and press start.', ask: 'Does it still show the door as open?' },
  'ask_check:inlet-hose-tap': { say: 'Check the tap the dishwasher hose connects to is fully on, the hose isn\'t kinked behind the machine, and if the hose has an AquaStop box at the tap end, whether its little window shows red.', ask: 'Was the tap off or the hose kinked (and is it sorted), does the AquaStop window show red or the hose look damaged, or is it all fine?' },
  'ask_check:inlet-filter': { say: 'Where the inlet hose screws onto the dishwasher there\'s a small mesh filter that can block with grit or scale. Unscrew the hose at the machine end and look into the inlet.', ask: 'Was the mesh blocked (and is it clean now), or was it already clean?' },
  'ask_check:retest': { say: 'Now turn the tap back on and start a programme.', ask: 'Does it fill normally now, or is it still not taking water?' },
  'ask_identity:model': { say: 'To match the right part for your dishwasher I need its exact model.', ask: 'Could you send me the model number? It\'s on the rating plate along the edge of the door or the side of the tub — a photo of the label is fine.' },
  'ask_identity:appliance': { say: '', ask: 'Is it a dishwasher, a washing machine or a washer-dryer?' },
};
const CONCLUSION = {
  'household-supply': 'If your other taps are weak or off too, the problem is the household water supply rather than the dishwasher. Check the stopcock and whether your water supplier has reported an outage; a plumber can help if it\'s a house problem. No dishwasher part is needed.',
  'B7:tap-hose-or-aquastop': 'The tap or a kinked hose was very likely stopping the water, so no part is needed.',
  'B7:inlet-mesh-filter': 'The blocked inlet mesh was very likely the cause, so no part is needed.',
  'inlet-valve': 'With the supply, hose and mesh fine but no water coming in, the fill side inside the dishwasher (the inlet valve or its control) is the most likely area. That needs an appliance engineer to confirm safely — I\'m not recommending a part from this.',
  'fill-sensing-or-control': 'With the supply, tap, hose and mesh all fine, the fault is inside the dishwasher — the fill valve, the fill sensing or the control side. An appliance engineer is the best next step; I\'m not recommending a part from this.',
  'tap-hose-or-aquastop': 'A red AquaStop window means its safety valve has shut off the water, usually after a leak in the hose. The inlet hose needs replacing — with the tap off until then.',
};
const compose = ck.createCompose({
  TASK, CONFIRM_ASK: 'Is it filling normally now?',
  OBS_COPY: { waterEntering: ['water comes in', 'no water comes in'], fillsSlowly: ['only a little water', null], supplyOk: ['other taps run normally', 'household supply off / low'],
    waterInBase: ['water in the base / flood warning', 'base dry'], doorRecognised: ['door recognised', 'says door open'], faultPersists: ['still not filling', 'fills after the fix'] },
  CHECK_RESULT_COPY: {
    'inlet-hose-tap': { clear: 'tap on, hose clear, AquaStop fine', found_and_cleared: 'tap off / hose kinked (sorted)', fault_seen: 'hose damaged / AquaStop red' },
    'inlet-filter': { clear: 'inlet mesh clean', found_and_cleared: 'inlet mesh blocked (cleaned)' },
  },
  statusChecks: [['door-start-test', 'door test'], ['retest', 'retest']],
  conclusionCopy: ck.makeConclusionCopy({ FAMILY_LABEL, COMPONENT_LABEL, CONCLUSION, fitNote: 'Turn the water off at the tap and switch the dishwasher off at the socket before fitting it; if you\'d rather not, an appliance engineer can fit it.' }),
  PURCHASE_RE: /\b(buy|order|purchase|price|£\s?\d)|\b(new|replacement|replace the)\s+(inlet valve|fill valve|valve|solenoid|hose|aquastop|door lock|latch|interlock|pcb|control board|float)\b/i,
});
module.exports = { SPEC, FAMILY, diagnose, P, ...pipeline, FAMILY_LABEL, COMPONENT_LABEL, TASK, REQUIREMENT: ck.REQUIREMENT, SAFETY_COPY: ck.SAFETY_COPY, ...compose };
