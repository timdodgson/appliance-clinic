'use strict';
/**
 * Dishwasher journey 1 — not draining (rules A1–A22). PURE, deterministic. Diagnostics + policy + pipeline in one pack.
 * Design: services/whichpart-api/docs/diagnostics/dw-batch-1-evidence.md §1.
 * Safe blockage checks (filter / sump → pump cover / impeller → drain hose → sink waste / spigot) precede any pump.
 * Household waste backing up → plumbing, no dishwasher part. Pump silence alone never proves the pump.
 */
const engine = require('./evidence-engine.js');
const kit = require('./policy-kit.js');
const JP = require('./journey-pipeline.js');
const F = require('./dw-family.js');
const { SS, S, A, SA } = engine;

const FAMILY = { FB: 'filter-or-sump-blockage', PO: 'pump-obstruction', DH: 'drain-hose-restriction', WS: 'household-waste-or-spigot', DP: 'drain-pump', CT: 'level-or-control' };
const SIGNALS = {
  FB: { filterBlocked: SS, restoredAfterFilterFix: SS, failsAfterFilterFix: SA, standing: S, filterClear: SA },
  PO: { impellerCleared: SS, restoredAfterImpellerFix: SS, failsAfterImpellerFix: SA, standing: S, pumpHum: S, filterClear: S, impellerOk: SA, filterBlocked: A, impellerDamaged: SA },
  DH: { hoseFixed: SS, restoredAfterHoseFix: SS, failsAfterHoseFix: SA, standing: S, recentInstall: S, hoseOk: SA, filterBlocked: A },
  WS: { backflow: SS, spigotFixed: SS, restoredAfterSpigotFix: SS, failsAfterSpigotFix: SA, recentInstall: S, standing: S, spigotOk: SA, filterBlocked: A },
  DP: { impellerDamaged: SS, pumpPathFail: SS, pumpHum: S, filterClear: S, impellerOk: S, hoseOk: S, spigotOk: S, cmdFail: S, codeDrain: S,
    filterBlocked: A, hoseFixed: A, backflow: SA, cmdEmpties: SA, pumpSilent: A },
  CT: { pumpSilent: S, filterClear: S, impellerOk: S, hoseOk: S, cmdFail: S, codeControl: SS, pumpHum: A, backflow: SA, cmdEmpties: SA },
};
const FACT_LABEL = {
  standing: 'water left in the bottom', pumpHum: 'pump hums', pumpSilent: 'pump silent', backflow: 'sink / waste backs up', recentInstall: 'recently installed / plumbing work',
  filterBlocked: 'filter / sump blocked (cleaned)', filterClear: 'filter clean', impellerCleared: 'debris / glass at the pump (removed)', impellerOk: 'impeller turns freely',
  impellerDamaged: 'impeller broken', hoseFixed: 'drain hose kinked / blocked (fixed)', hoseOk: 'drain hose clear', spigotFixed: 'blanking plug / trap blocked (cleared)',
  spigotOk: 'sink waste connection fine', cmdFail: 'still will not pump out on a drain / cancel', cmdEmpties: 'empties on a drain / cancel',
  pumpPathFail: 'pump hums, path clear, still will not pump out', codeDrain: 'drain error code', codeControl: 'control error code',
};
const SPEC = {
  schema: 'dw1-diag/1', FAMILY, PRIOR: ['FB', 'PO', 'DH', 'WS', 'DP', 'CT'], SIGNALS, FACT_LABEL,
  obs: { standing: ['waterRemaining', true], pumpHum: ['pumpHumming', true], pumpSilent: ['pumpHumming', false], backflow: ['waterReturnsAfterDrain', true],
    recentInstall: ['recentInstallation', true], cmdFail: ['commandedDrain', false], cmdEmpties: ['commandedDrain', true] },
  checks: { 'dishwasher-filter': { clear: 'filterClear', found: 'filterBlocked' }, 'pump-impeller': { clear: 'impellerOk', found: 'impellerCleared', fault: 'impellerDamaged' },
    'drain-hose': { clear: 'hoseOk', found: 'hoseFixed' }, 'waste-spigot': { clear: 'spigotOk', found: 'spigotFixed' } },
  FIX_CHECK: { FB: ['dishwasher-filter', 'Filter'], PO: ['pump-impeller', 'Impeller'], DH: ['drain-hose', 'Hose'], WS: ['waste-spigot', 'Spigot'] },
  retestObs: 'faultPersists',
  DECISIVE_PART: { DP: { impellerDamaged: 'drain-pump', pumpPathFail: 'drain-pump' } },
  extra(s, ctx, on) {
    const has = (k, v) => engine.obsVal(s, k) === v; const res = (c) => engine.checkResult(s, c);
    on('pumpPathFail', has('pumpHumming', true) && has('commandedDrain', false) && res('dishwasher-filter') === 'clear' && res('pump-impeller') === 'clear'
      && res('drain-hose') === 'clear' && !has('waterReturnsAfterDrain', true));
    on('codeDrain', ['not-draining', 'drain-pump'].includes(ctx.codeFault)); on('codeControl', ctx.codeFault === 'main-pcb');
  },
  partBlockers: (has) => (has('backflow') ? ['household-waste-evidence'] : []),
  eligible: (k, has) => (k === 'WS' ? ['backflow', 'spigotFixed', 'spigotOk', 'recentInstall'].some(has) : true),
};
function diagnose(state, ctx = {}) {
  const codeFault = ctx.codeFault !== undefined ? ctx.codeFault : F.dwCodeFault(state, ctx.errorCodes || null);
  return engine.diagnoseSpec(SPEC, state, { ...ctx, codeFault });
}

const P = kit.makeStepPolicy({
  JOURNEY: 'dw-not-draining', P: 'A', appliance: 'dishwasher', journeys: ['not-draining'], codeFaults: ['not-draining', 'drain-pump'],
  ownedElsewhere: (h) => F.flood(h),
  CHECKS: ['dishwasher-filter', 'pump-impeller', 'drain-hose', 'waste-spigot', 'drain-command'],
  OBS_TARGETS: { waterRemaining: ['waterRemaining'], pumpHumming: ['pumpHumming'] },
  outcomeObs: { 'drain-command': 'commandedDrain' },
  REQUIRES: {
    'dishwasher-filter': ['isolate_mains', 'contain_water', 'gloves_for_glass'],
    'pump-impeller': ['isolate_mains', 'filter_already_removed', 'gloves_for_glass', 'no_tools_beyond_housing'],
    'drain-hose': ['isolate_mains', 'water_off_at_tap', 'contain_water'],
    'waste-spigot': ['isolate_mains', 'contain_water'],
    'drain-command': ['keep_clear_of_socket_if_water_near'],
    retest: [],
  },
  FIX_CHECKS: ['dishwasher-filter', 'pump-impeller', 'drain-hose', 'waste-spigot'],
  fixResults: { 'pump-impeller': ['found_and_cleared'] },
  early(h) { return h.has('backflow') ? { target: 'household-waste-or-spigot', reason: 'household-waste-backs-up', rule: 'A5', handoff: 'plumbing' } : null; },
  steps: [
    { n: 10, target: 'waterRemaining', reason: 'standing-water-confirms', when: (h) => !h.has('standing') && !h.has('cmdFail') },
    { n: 11, target: 'dishwasher-filter', reason: 'filter-sump-first', when: () => true },
    { n: 12, target: 'pump-impeller', reason: 'pump-cover-after-filter', when: (h) => h.has('filterClear') },
    { n: 13, target: 'drain-hose', reason: 'hose-before-pump', when: (h) => h.has('filterClear') && !h.has('impellerDamaged') },
    { n: 14, target: 'waste-spigot', reason: 'sink-waste-spigot', when: (h) => h.has('filterClear') && !h.has('impellerDamaged') && (h.has('hoseOk') || h.has('recentInstall')) },
    { n: 15, target: 'drain-command', reason: 'commanded-drain-after-checks', when: (h) => h.has('filterClear') && !h.has('impellerDamaged') && !h.has('cmdFail') && !h.has('cmdEmpties') },
    { n: 16, target: 'pumpHumming', reason: 'hum-vs-silent', when: (h) => h.has('cmdFail') },
  ],
  PART_FAMILIES: new Set(['DP']),
  HANDOFF: { FB: 'none', PO: 'none', DH: 'install', WS: 'plumbing', DP: 'engineer', CT: 'engineer' },
});

const pipeline = JP.makeModelPartPipeline({
  D: { diagnose }, P, schema: 'dw1/1', codeFaultFor: F.dwCodeFault,
  PART_MATCH: { 'drain-pump': { re: /drain(age)?\s+pump|\bpump\b/i, not: /filter|circulation|wash\s+pump|heat/i } },
  MEDIA_BY_KEY: { 'dishwasher-filter': { knowledgeId: 'dishwasher:not-draining', ids: ['dishwasher-filter'], concepts: [] } },
});
module.exports = { SPEC, FAMILY, diagnose, P, ...pipeline };

// ---- COMPOSE pack (wording only) ----
const ck = require('./compose-kit.js');
const FAMILY_LABEL = {
  'filter-or-sump-blockage': 'a blocked filter / sump', 'pump-obstruction': 'something caught at the drain pump', 'drain-hose-restriction': 'a kinked or blocked drain hose',
  'household-waste-or-spigot': 'the sink waste / plumbing connection', 'drain-pump': 'the drain pump', 'level-or-control': 'the drain control side',
};
const COMPONENT_LABEL = { 'drain-pump': 'drain pump' };
const TASK = {
  'ask_observation:waterRemaining': { say: 'Let\'s check what\'s left after the programme.', ask: 'Is there still dirty water sitting in the bottom of the tub (inside, under the lower rack)?' },
  'ask_check:dishwasher-filter': { say: 'Take out the lower rack, then twist and lift out the filter in the bottom of the tub. Rinse it under the tap and clear any food, grease or glass from the sump underneath.', ask: 'Was the filter or sump blocked (and is it clean now), or was it already clean?' },
  'ask_check:pump-impeller': { say: 'With the filter out, bail out any water with a cup and sponge. There\'s a small pump cover in the sump — lift its clip and look underneath with a torch for glass, stones or bones, then gently turn the little impeller with a finger.', ask: 'Did you find something caught (and remove it), is the impeller broken, or does it turn freely with nothing there?' },
  'ask_check:drain-hose': { say: 'Check the grey drain hose from the back of the dishwasher to the sink waste isn\'t kinked or squashed — especially where it runs behind the plinth or under the sink.', ask: 'Was the hose kinked or blocked (and is it clear now), or is it running freely?' },
  'ask_check:waste-spigot': { say: 'Under the sink, look where the drain hose joins the waste. On a newly fitted sink waste the little blanking plug inside the spigot has to be cut out, and the sink trap mustn\'t be blocked — run the sink tap and check it drains freely.', ask: 'Was the blanking plug still in or the trap blocked (and is it cleared now), or is the connection fine?' },
  'ask_check:drain-command': { say: 'With the filter back in, close the door, choose cancel or a drain / rinse programme and let it run for a couple of minutes, listening near the bottom of the machine.', ask: 'Did the water pump away this time?' },
  'ask_observation:pumpHumming': { say: 'One more thing that helps.', ask: 'While it tried to drain, could you hear the pump humming or running, or was it silent?' },
  'ask_check:retest': ck.RETEST_TASK,
  'ask_identity:model': { say: 'To match the right part for your dishwasher I need its exact model.', ask: 'Could you send me the model number? It\'s on the rating plate along the edge of the door or the side of the tub — a photo of the label is fine.' },
  'ask_identity:appliance': { say: '', ask: 'Is it a dishwasher, a washing machine or a washer-dryer?' },
};
const CONCLUSION = {
  'household-waste-or-spigot': 'If the sink or waste backs up when the dishwasher drains, the blockage is in the household waste (the sink trap, waste pipe or spigot), not the dishwasher. Clearing that, or a plumber, is the next step — no dishwasher part is needed.',
  'A7:filter-or-sump-blockage': 'The blocked filter was very likely the cause, so no part is needed. Rinsing it every week or two stops it happening again.',
  'A7:pump-obstruction': 'Whatever was caught at the pump was very likely the cause, so no part is needed.',
  'A7:drain-hose-restriction': 'The kinked or blocked hose was very likely the cause, so no part is needed. Keep it free of kinks when the machine is pushed back.',
  'A7:household-waste-or-spigot': 'The sink waste connection was very likely the cause, so no dishwasher part is needed.',
  'drain-pump': 'With the filter, pump cover and hoses clear but the water still not pumping away, the drain pump is the likely area. An appliance engineer can confirm it safely — I\'m not recommending a part from this.',
  'level-or-control': 'With the filter, pump cover and hoses clear and no sound from the pump, the fault is on the drain control side (the pump\'s supply, wiring or control). That needs an appliance engineer to test safely — I\'m not recommending a part from this.',
};
const compose = ck.createCompose({
  TASK, CONFIRM_ASK: 'Is it draining normally now?',
  OBS_COPY: { waterRemaining: ['water left in the bottom', 'no water left'], pumpHumming: ['pump hums', 'pump silent'], waterReturnsAfterDrain: ['sink / waste backs up', null],
    commandedDrain: ['empties on a drain / cancel', 'still will not pump out'], faultPersists: ['still not draining after the fix', 'drains after the fix'] },
  CHECK_RESULT_COPY: {
    'dishwasher-filter': { clear: 'filter clean', found_and_cleared: 'filter / sump blocked (cleaned)' },
    'pump-impeller': { clear: 'impeller turns freely', found_and_cleared: 'debris at the pump (removed)', fault_seen: 'impeller broken' },
    'drain-hose': { clear: 'drain hose clear', found_and_cleared: 'drain hose kinked / blocked (fixed)' },
    'waste-spigot': { clear: 'sink waste fine', found_and_cleared: 'blanking plug / trap blocked (cleared)' },
  },
  statusChecks: [['drain-command', 'drain test'], ['retest', 'retest']],
  conclusionCopy: ck.makeConclusionCopy({ FAMILY_LABEL, COMPONENT_LABEL, CONCLUSION, fitNote: 'Switch the dishwasher off at the socket and turn the water off before fitting it; if you\'d rather not, an appliance engineer can fit it.' }),
  PURCHASE_RE: /\b(buy|order|purchase|price|£\s?\d)|\b(new|replacement|replace the)\s+(drain\s+)?(pump|pcb|control board|valve|non[- ]return valve)\b/i,
});
Object.assign(module.exports, { FAMILY_LABEL, COMPONENT_LABEL, TASK, REQUIREMENT: ck.REQUIREMENT, SAFETY_COPY: ck.SAFETY_COPY, ...compose });
