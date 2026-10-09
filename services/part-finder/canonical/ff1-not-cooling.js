'use strict';
/**
 * Fridge / freezer journey 1 — not cooling (rules FC1–FC22). PURE, deterministic.
 * Design: docs/diagnostics/ff-td-batch-evidence.md §FF1. Compartment scope is kept (fridge only / freezer only / both / unknown):
 *   door left open / warm food → keep it shut 24 h (retest) · water pooling INSIDE as well → the defrost drain (an iced /
 *   blocked drain both wets the fridge and chokes the cold-air path: one fault, not two) · settings / modes · vents / over-packing · door seal ·
 *   condenser coils + clearance and room temperature (both / freezer) · fridge warm + freezer cold → fan / airflow (engineer;
 *   a fan part only with a fan code AND the fan silent) · running with everything fine → sealed system (engineer).
 * Never: claiming the compressor from "not cooling" alone; a gasket because it is warm (only a seal the owner saw torn);
 * refrigerant / sealed-system DIY; live compressor or mains testing. Dead / clicking / silent → ff-not-running-dead (once).
 */
const engine = require('./evidence-engine.js');
const kit = require('./policy-kit.js');
const JP = require('./journey-pipeline.js');
const F = require('./ff-family.js');
const ck = require('./compose-kit.js');
const { SS, S, A, SA } = engine;

const KEY = 'ff-not-cooling';
const FAMILY = { DL: 'door-left-open', TS: 'temperature-setting', VB: 'blocked-vents-or-overpacking', DS: 'door-seal', CC: 'condenser-coils-or-clearance',
  LO: 'room-temperature-location', EF: 'internal-fan-or-airflow', SY: 'sealed-system-or-compressor', DD: 'blocked-defrost-drain' };
const SIGNALS = {
  DL: { doorLeft: S, restoredAfterDoorClosed: SS, failsAfterDoorClosed: SA },
  DD: { waterInside: S, drainFixed: SS, drainStuck: SS, restoredAfterDrainFix: SS, failsAfterDrainFix: SA, drainOk: SA },
  TS: { setFixed: SS, restoredAfterSetFix: SS, failsAfterSetFix: SA, setOk: SA },
  VB: { ventsFixed: SS, restoredAfterVentsFix: SS, failsAfterVentsFix: SA, ventsOk: SA, ventsObs: S, scopeFridge: S },
  DS: { sealTorn: SS, sealFixed: SS, restoredAfterSealFix: SS, failsAfterSealFix: SA, sealOk: SA },
  CC: { coilsFixed: SS, restoredAfterCoilsFix: SS, failsAfterCoilsFix: SA, coilsOk: SA, both: S, constant: S, scopeFridge: A, sealTorn: A },
  LO: { location: SS, scopeFreezer: S, both: S },
  EF: { codeFan: SS, fanSilent: S, scopeFridge: S, setOk: S, ventsOk: S, fanRuns: A, both: A, scopeFreezer: A, restoredAfterSetFix: SA, restoredAfterVentsFix: SA, restoredAfterSealFix: SA },
  SY: { compressorOn: S, both: S, coilsOk: S, setOk: S, sealOk: S, constant: S, scopeFridge: A, scopeFreezer: A, sealTorn: SA, restoredAfterSetFix: SA, restoredAfterVentsFix: SA, restoredAfterCoilsFix: SA, restoredAfterSealFix: SA },
};
const FACT_LABEL = {
  both: 'fridge and freezer both warm', scopeFridge: 'fridge warm, freezer cold', scopeFreezer: 'freezer warm, fridge fine', doorLeft: 'door left open / warm food added',
  restoredAfterDoorClosed: 'recovered with the door kept shut', failsAfterDoorClosed: 'still warm after a day shut', setFixed: 'setting / mode was wrong (corrected)', setOk: 'settings normal',
  ventsFixed: 'vents blocked / over-packed (cleared)', ventsOk: 'vents clear', ventsObs: 'vents blocked / over-packed', sealTorn: 'door seal torn / come away', sealFixed: 'seal dirty / folded (sorted)',
  sealOk: 'door seal fine', coilsFixed: 'coils dusty / no gap to the wall (sorted)', coilsOk: 'coils clean with space', constant: 'runs all the time', location: 'in a very cold or hot spot',
  waterInside: 'water pooling inside the fridge', drainFixed: 'defrost drain blocked (cleared)', drainStuck: 'defrost drain blocked / frozen (could not clear)', drainOk: 'defrost drain clear',
  codeFan: 'fan error code', fanSilent: 'fan silent', fanRuns: 'fan running', compressorOn: 'compressor can be heard running', fanCode: 'fan code with the fan silent',
};
const SPEC = {
  schema: 'ff1-diag/1', FAMILY, PRIOR: ['DL', 'DD', 'TS', 'VB', 'DS', 'CC', 'LO', 'EF', 'SY'], SIGNALS, FACT_LABEL,
  obs: { both: ['bothCompartmentsWarm', true], fanSilent: ['fanAudible', false], fanRuns: ['fanAudible', true], doorLeft: ['doorLeftOpen', true],
    location: ['inColdOrHotLocation', true], ventsObs: ['ventsBlocked', true], compressorOn: ['compressorRuns', true], constant: ['runsConstantly', true],
    waterInside: ['waterInsideFridge', true] },
  checks: { 'temp-setting': { clear: 'setOk', found: 'setFixed' }, 'vents-clear': { clear: 'ventsOk', found: 'ventsFixed' },
    'condenser-coil-clear': { clear: 'coilsOk', found: 'coilsFixed' }, 'door-seal': { clear: 'sealOk', found: 'sealFixed', fault: 'sealTorn' },
    'defrost-drain': { clear: 'drainOk', cleared: 'drainFixed', notCleared: 'drainStuck' } },
  FIX_CHECK: { DD: ['defrost-drain', 'Drain'], TS: ['temp-setting', 'Set'], VB: ['vents-clear', 'Vents'], CC: ['condenser-coil-clear', 'Coils'], DS: ['door-seal', 'Seal'] },
  DECISIVE_PART: { DS: { sealTorn: 'door-seal' }, EF: { fanCode: 'evaporator-fan' } },
  extra(s, ctx, on) {
    const p = kit.problemOf(s); const scope = p && p.scope ? p.scope.value : null;
    on('scopeFridge', scope === 'fridge_only'); on('scopeFreezer', scope === 'freezer_only');
    on('codeFan', ctx.codeFault === 'evaporator-fan');
    on('fanCode', ctx.codeFault === 'evaporator-fan' && engine.obsVal(s, 'fanAudible') === false);
    // the "keep it shut for a day" retest after a door left open
    const left = engine.obsVal(s, 'doorLeftOpen') === true; const fp = engine.obsVal(s, 'faultPersists');
    on('restoredAfterDoorClosed', left && (fp === false || s.resolution === 'resolved')); on('failsAfterDoorClosed', left && fp === true);
  },
  eligible: (k, has) => (k === 'LO' ? has('location') : k === 'EF' ? !has('both') : k === 'DL' ? has('doorLeft')
    : k === 'DD' ? ['waterInside', 'drainFixed', 'drainStuck'].some(has) : true),
};
function diagnose(state, ctx = {}) {
  const codeFault = ctx.codeFault !== undefined ? ctx.codeFault : F.ffCodeFault(state, ctx.errorCodes || null);
  return engine.diagnoseSpec(SPEC, state, { ...ctx, codeFault });
}
const fridgeOnly = (h) => h.has('scopeFridge') || h.obs('bothCompartmentsWarm') === false;
const P = kit.makeStepPolicy({
  JOURNEY: KEY, P: 'FC', appliance: 'fridge-freezer', journeys: ['not-cooling'], ...F.owns(KEY), declineUnsafe: F.UNSAFE,
  CHECKS: ['defrost-drain', 'temp-setting', 'vents-clear', 'door-seal', 'condenser-coil-clear'],
  OBS_TARGETS: { ffCompartment: ['bothCompartmentsWarm'], doorLeftOpen: ['doorLeftOpen'], inColdOrHotLocation: ['inColdOrHotLocation'], fanAudible: ['fanAudible'],
    ffCompressorState: ['compressorRuns', 'clicksNoStart'] },
  REQUIRES: {
    ffCompartment: ['ff_food_safety'], doorLeftOpen: [], 'defrost-drain': ['unplug_fridge', 'no_sharp_tools_on_ice'], 'temp-setting': [], 'vents-clear': [], 'door-seal': ['look_and_feel_only'],
    'condenser-coil-clear': ['unplug_fridge', 'no_refrigerant_work'], inColdOrHotLocation: [], fanAudible: ['ff_listen_only'], ffCompressorState: ['ff_listen_only'], retest: [],
  },
  FIX_CHECKS: ['defrost-drain', 'temp-setting', 'vents-clear', 'condenser-coil-clear', 'door-seal'],
  fixResults: { 'defrost-drain': ['found_and_cleared'] },
  steps: [
    { n: 10, target: 'ffCompartment', reason: 'compartment-scope', when: (h) => !h.scope() && h.obs('bothCompartmentsWarm') == null },
    { n: 11, target: 'doorLeftOpen', reason: 'door-left-open-or-warm-food', when: (h) => h.obs('doorLeftOpen') == null },
    { n: 12, target: 'retest', reason: 'keep-shut-24h', when: (h) => h.has('doorLeft') && h.obs('faultPersists') == null },
    { n: 23, target: 'defrost-drain', reason: 'water-inside-links-defrost-drain', when: (h) => h.has('waterInside') },
    { n: 13, target: 'temp-setting', reason: 'settings-and-modes', when: () => true },
    { n: 14, target: 'vents-clear', reason: 'vents-and-overpacking', when: () => true },
    { n: 15, target: 'door-seal', reason: 'seal-lets-warm-air-in', when: () => true },
    { n: 16, target: 'condenser-coil-clear', reason: 'heat-rejection-coils-clearance', when: (h) => !fridgeOnly(h) && !h.has('sealTorn') },
    { n: 17, target: 'inColdOrHotLocation', reason: 'room-temperature', when: (h) => !fridgeOnly(h) && !h.has('sealTorn') },
    { n: 18, target: 'fanAudible', reason: 'fridge-warm-freezer-cold-airflow', when: (h) => fridgeOnly(h) && !h.has('sealTorn') },
    { n: 19, target: 'ffCompressorState', reason: 'running-or-not', when: (h) => !fridgeOnly(h) && !h.has('sealTorn') && !h.has('coilsFixed') && !h.has('location') },
  ],
  PART_FAMILIES: new Set(['DS', 'EF']),
  HANDOFF: { DL: 'none', DD: 'engineer', TS: 'none', VB: 'none', DS: 'engineer', CC: 'none', LO: 'install', EF: 'engineer', SY: 'engineer' },
});

const pipeline = JP.makeModelPartPipeline({
  D: { diagnose }, P, schema: 'ff1/1', codeFaultFor: F.ffCodeFault,
  PART_MATCH: {
    'door-seal': { re: /door\s+(seal|gasket)|\bgasket\b/i, not: /hinge|handle|shelf|drawer|tumble|dryer|washing|dishwasher|oven/i },
    'evaporator-fan': { re: /(evaporator|freezer|fridge|internal)\s+fan|fan\s+motor/i, not: /condenser|tumble|dryer|oven|cooker|hood|blade only/i },
  },
  MEDIA_BY_KEY: { 'temp-setting': { knowledgeId: 'fridge-freezer:not-cooling', ids: ['fridge-not-cooling'], concepts: [] } },
});

// ---- COMPOSE (wording only) ----
const FAMILY_LABEL = {
  'door-left-open': 'the door being left open / warm food going in', 'temperature-setting': 'the temperature setting or a mode left on', 'blocked-vents-or-overpacking': 'blocked vents or over-packing',
  'door-seal': 'the door seal', 'condenser-coils-or-clearance': 'dusty coils or too little space round it', 'room-temperature-location': 'the room it is in (too cold or too hot)',
  'internal-fan-or-airflow': 'the fan or air channel that moves cold air into the fridge', 'blocked-defrost-drain': 'a blocked or iced-up defrost drain', 'sealed-system-or-compressor': 'the sealed cooling system or its controls',
};
const COMPONENT_LABEL = { 'door-seal': 'door seal (gasket)', 'evaporator-fan': 'internal (evaporator) fan' };
const FOOD = 'In the meantime keep the doors shut; chilled food that has been warmer than 8°C for more than about four hours is safest thrown away, and thawed food shouldn\'t be refrozen unless it\'s cooked first.';
const TASK = {
  'ask_observation:ffCompartment': { say: 'Let\'s narrow it down.', ask: 'Is it just the fridge that\'s warm, just the freezer, or both?' },
  'ask_observation:doorLeftOpen': { say: 'A door left ajar or a big shop of warm food can take a fridge freezer a day to recover.', ask: 'Has a door been left open or not shut properly recently, or has a lot of warm food gone in?' },
  'ask_check:retest': { say: 'Keep both doors shut for about 24 hours (only open them briefly) and let it recover.', ask: 'After a day with the doors shut, is it back to cold, or still warm?' },
  'ask_check:defrost-drain': { say: 'Water inside plus poor cooling usually has one cause: the defrost drain. At the bottom of the back wall inside the fridge there\'s a small drain hole or channel. If it blocks or ices up, defrost water collects inside and ice can build up behind the back panel and choke the cold air. Clear the hole gently with warm water (a turkey baster or squeezy bottle) or a soft pipe cleaner — nothing sharp.', ask: 'Was the drain hole blocked (and is it clear now), is it blocked or frozen and you couldn\'t clear it, or was it already clear?' },
  'ask_check:temp-setting': { say: 'Check the temperature dial or display: the fridge should be about 3–5°C and the freezer -18°C, and make sure no holiday / eco mode is on.', ask: 'Was a setting wrong or a mode left on (and have you corrected it), or was it all set normally?' },
  'ask_check:vents-clear': { say: 'Cold air comes in through vents, often on the back wall inside. Make sure food isn\'t pressed against them and the shelves aren\'t packed so tight air can\'t move.', ask: 'Were the vents blocked or was it over-packed (and have you moved things), or was everything clear?' },
  'ask_check:door-seal': { say: 'Run your fingers round the rubber door seal on each door and look for splits, gaps or a section that has come away, or anything stopping it closing flat.', ask: 'Is the seal torn or come away, was it dirty or folded (and is that sorted), or does it look fine?' },
  'ask_check:condenser-coil-clear': { say: 'Fridge freezers lose their heat through a coil or grille at the back or underneath. Gently dust or vacuum it, and leave a few centimetres of space between it and the wall or cupboards.', ask: 'Was it dusty or pushed against the wall (and have you sorted it), or was it already clean with space round it?' },
  'ask_observation:inColdOrHotLocation': { say: 'Room temperature matters more than people think.', ask: 'Is it in a garage, outbuilding or very cold room, or next to an oven, radiator or in direct sun?' },
  'ask_observation:fanAudible': { say: 'On most frost-free models a fan pushes cold air from the freezer into the fridge. Open the freezer and press in the little door switch (or light button) — you should hear a fan whirr at the back.', ask: 'Can you hear the fan running when you do that, or is it silent?' },
  'ask_observation:ffCompressorState': { say: 'Next, whether it\'s actually running. Listen near the bottom at the back for a few minutes.', ask: 'Can you hear it humming / running, does it just click every few minutes without starting, or is it silent?' },
  'ask_identity:model': { say: 'To match the right part for your fridge freezer I need its exact model.', ask: 'Could you send me the model number? It\'s on the rating label inside the fridge, usually on a side wall near the salad drawer — a photo is fine.' },
  'ask_identity:appliance': { say: '', ask: 'Is it a fridge freezer, a fridge or a freezer?' },
};
const CONCLUSION = {
  'FC7:door-left-open': 'Keeping the doors shut let it recover, so no part is needed. Try to keep the doors closed and let warm food cool before it goes in.',
  'door-left-open': `A door left open or a lot of warm food can take up to a day to recover from. Keep the doors shut for 24 hours, and if it's still warm after that, let me know. ${FOOD}`,
  'FC7:blocked-defrost-drain': 'Clearing the defrost drain very likely fixed both the water and the cooling, so no part is needed. Give it a day to recover, and flush the drain with a little warm water every few months.',
  'blocked-defrost-drain': `Water inside together with poor cooling points to the defrost drain being blocked or iced up — one fault, not two. As it won't clear from the front, please don't poke anything sharp into it; an appliance engineer can clear it and check the defrost system safely. I'm not recommending a part from this. ${FOOD}`,
  'FC7:temperature-setting': 'That was the setting, so no part is needed. Give it a few hours to reach temperature.',
  'FC7:blocked-vents-or-overpacking': 'Freeing the vents very likely fixed it, so no part is needed. Keep food a little away from the back wall.',
  'FC7:door-seal': 'Sorting the seal very likely fixed it, so no part is needed.',
  'FC7:condenser-coils-or-clearance': 'Cleaning the coils and giving it space very likely fixed it, so no part is needed.',
  'room-temperature-location': 'The room is the likely cause: most fridge freezers are designed for roughly 10–32°C (the climate class on the rating label says exactly). In a cold garage the fridge thermostat rarely calls for cooling, so the freezer warms; in a very hot spot it can\'t keep up. Moving it to a normal room is the fix — no part is needed.',
  'internal-fan-or-airflow': `With the freezer cold but the fridge warm, cold air isn't getting from the freezer into the fridge — usually the fan, the air damper or an iced-up air channel. That needs an appliance engineer to check safely; I'm not recommending a part from this. ${FOOD}`,
  'sealed-system-or-compressor': `With the settings, vents, seal and coils all fine and it still running, the fault is most likely in the sealed cooling system or its controls — I can't say it's the compressor from this alone. Please don't open any pipes or covers; a refrigeration engineer is the next step, and I'm not recommending a part from this. ${FOOD}`,
};
const compose = ck.createCompose({
  TASK, CONFIRM_ASK: 'Is it staying cold now?',
  OBS_COPY: { bothCompartmentsWarm: ['fridge and freezer both warm', 'only one compartment warm'], doorLeftOpen: ['door left open / warm food went in', 'doors kept shut'],
    inColdOrHotLocation: ['in a very cold or hot spot', null], fanAudible: ['fan running', 'fan silent'], compressorRuns: ['can hear it running', 'silent at the back'],
    clicksNoStart: ['clicks but never starts', null], waterInsideFridge: ['water pooling inside', null], runsConstantly: ['runs all the time', null], ventsBlocked: ['vents blocked / over-packed', null], faultPersists: ['still warm', 'cold again'] },
  CHECK_RESULT_COPY: {
    'defrost-drain': { clear: 'defrost drain clear', found_and_cleared: 'defrost drain cleared', found_not_cleared: 'defrost drain blocked (could not clear)' },
    'temp-setting': { clear: 'settings normal', found_and_cleared: 'setting / mode corrected' }, 'vents-clear': { clear: 'vents clear', found_and_cleared: 'vents cleared' },
    'door-seal': { clear: 'door seal fine', found_and_cleared: 'seal sorted', fault_seen: 'door seal torn / come away' },
    'condenser-coil-clear': { clear: 'coils clean with space', found_and_cleared: 'coils cleaned / space made' },
  },
  statusChecks: [['retest', 'retest']],
  conclusionCopy: ck.makeConclusionCopy({ FAMILY_LABEL, COMPONENT_LABEL, CONCLUSION, fitNote: 'Switch the fridge freezer off at the socket before fitting it; if you\'d rather not, an appliance engineer can fit it.' }),
  PURCHASE_RE: /\b(buy|order|purchase|price|£\s?\d)|\b(new|replacement|replace the)\s+(door seal|seal|gasket|fan|compressor|thermostat|sensor|pcb|control board|relay|damper)\b/i,
});
module.exports = { SPEC, FAMILY, diagnose, P, ...pipeline, FAMILY_LABEL, COMPONENT_LABEL, TASK, REQUIREMENT: ck.REQUIREMENT, SAFETY_COPY: ck.SAFETY_COPY, ...compose };
