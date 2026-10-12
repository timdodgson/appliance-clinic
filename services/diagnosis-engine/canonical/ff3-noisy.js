'use strict';
/**
 * Fridge / freezer journey 3 — noisy (rules FN1–FN22). PURE, deterministic.
 * Design: docs/diagnostics/ff-td-batch-evidence.md §FF3. The noise is typed by SOUND (gurgle / crack / click / hum vs
 * squeal / grind / scrape vs rattle / buzz), SOURCE (inside a compartment vs back / bottom), DOOR-OPEN EFFECT (the
 * internal fan stops when the door switch is pressed) and the RUNNING CYCLE (never switches off):
 *   gurgling / cracking / ticking at the start or end of a cycle → normal (no part, early)
 *   inside + stops with the door open + squeal / grind → internal (evaporator) fan (part only with model AND that evidence)
 *   back / bottom rattle / buzz → something touching, loose drip tray, not level (owner fix)
 *   back / bottom loud hum / grind with everything clear → condenser fan / compressor area (engineer, no part)
 *   runs constantly → coils / clearance (owner fix) else engineer.
 * Clicking without ever starting → ff-not-running-dead; heavy ice (ice hitting the fan) → ff-ice-frost-build-up.
 */
const engine = require('./evidence-engine.js');
const kit = require('./policy-kit.js');
const JP = require('./journey-pipeline.js');
const F = require('./ff-family.js');
const ck = require('./compose-kit.js');
const { SS, S, A, SA } = engine;

const KEY = 'ff-noisy';
const FAMILY = { NN: 'normal-operating-noise', EF: 'internal-fan', RC: 'touching-or-loose-at-back', CC: 'runs-constantly-coils', CF: 'condenser-fan-or-compressor-area' };
const SIGNALS = {
  NN: { gurgle: SS, click: S, softHum: S, squeal: SA, grind: SA, scrape: SA, rattle: A, constant: A },
  EF: { fanConfirmed: SS, doorStops: S, inside: S, squeal: S, grind: S, scrape: S, back: SA, doorNoChange: A, gurgle: A },
  RC: { clearFixed: SS, restoredAfterClearFix: SS, failsAfterClearFix: SA, clearOk: SA, rattle: S, back: S, buzz: S, inside: A },
  CC: { coilsFixed: SS, restoredAfterCoilsFix: SS, failsAfterCoilsFix: SA, constant: S, coilsOk: A },
  CF: { back: S, grind: S, buzz: S, clearOk: S, coilsOk: S, inside: SA, doorStops: A, restoredAfterClearFix: SA, restoredAfterCoilsFix: SA },
};
const FACT_LABEL = {
  gurgle: 'gurgling / cracking / bubbling', click: 'clicking', softHum: 'a hum', squeal: 'squealing', grind: 'grinding / rumbling', scrape: 'scraping', rattle: 'rattling', buzz: 'buzzing / humming',
  inside: 'from inside a compartment', back: 'from the back / bottom', doorStops: 'stops when the door is opened', doorNoChange: 'same with the door open',
  fanConfirmed: 'internal-fan noise that stops with the door open', constant: 'runs all the time', clearFixed: 'something touching / loose / not level (sorted)', clearOk: 'nothing touching, level',
  coilsFixed: 'coils dusty / no space (sorted)', coilsOk: 'coils clean with space',
};
const SPEC = {
  schema: 'ff3-diag/1', FAMILY, PRIOR: ['NN', 'EF', 'RC', 'CC', 'CF'], SIGNALS, FACT_LABEL,
  obs: { gurgle: ['gurglingNoise', true], click: ['clickingNoise', true], squeal: ['squealNoise', true], grind: ['grindingNoise', true], scrape: ['scrapingNoise', true],
    rattle: ['rattlingNoise', true], inside: ['noiseFromInside', true], back: ['noiseFromInside', false], doorStops: ['noiseStopsWhenDoorOpen', true],
    doorNoChange: ['noiseStopsWhenDoorOpen', false], constant: ['runsConstantly', true] },
  checks: { 'ff-clearance': { clear: 'clearOk', found: 'clearFixed' }, 'condenser-coil-clear': { clear: 'coilsOk', found: 'coilsFixed' } },
  FIX_CHECK: { RC: ['ff-clearance', 'Clear'], CC: ['condenser-coil-clear', 'Coils'] },
  DECISIVE_PART: { EF: { fanConfirmed: 'evaporator-fan' } },
  extra(s, ctx, on) {
    const v = (k) => engine.obsVal(s, k);
    const hum = v('humNoise') === true;
    on('buzz', hum && v('noiseFromInside') === false); on('softHum', hum && v('noiseFromInside') !== false);
    // the internal fan is the source: inside, stops when the door switch is pressed, and a bearing-type sound
    on('fanConfirmed', v('noiseStopsWhenDoorOpen') === true && v('noiseFromInside') !== false && ['squealNoise', 'grindingNoise', 'scrapingNoise'].some((k) => v(k) === true));
  },
  eligible: (k, has) => (k === 'CC' ? has('constant') || has('coilsFixed') : k === 'CF' ? has('buzz') || has('grind') || has('softHum') : true),
};
function diagnose(state, ctx = {}) {
  const codeFault = ctx.codeFault !== undefined ? ctx.codeFault : F.ffCodeFault(state, ctx.errorCodes || null);
  return engine.diagnoseSpec(SPEC, state, { ...ctx, codeFault });
}
const TYPES = ['gurgle', 'click', 'softHum', 'buzz', 'squeal', 'grind', 'scrape', 'rattle'];
const typed = (h) => TYPES.some(h.has) || h.obs('knockingNoise') === true;
const bad = (h) => ['squeal', 'grind', 'scrape', 'rattle', 'buzz'].some(h.has) || h.obs('knockingNoise') === true;
const P = kit.makeStepPolicy({
  JOURNEY: KEY, P: 'FN', appliance: 'fridge-freezer', journeys: ['noisy'], ...F.owns(KEY), declineUnsafe: F.UNSAFE,
  CHECKS: ['ff-clearance', 'condenser-coil-clear'],
  OBS_TARGETS: { noiseType: ['grindingNoise', 'humNoise', 'scrapingNoise', 'knockingNoise', 'rattlingNoise', 'squealNoise', 'clickingNoise', 'gurglingNoise'],
    noiseFromInside: ['noiseFromInside'], noiseStopsWhenDoorOpen: ['noiseStopsWhenDoorOpen'], runsConstantly: ['runsConstantly'] },
  REQUIRES: { noiseType: [], noiseFromInside: [], noiseStopsWhenDoorOpen: [], runsConstantly: [], 'ff-clearance': ['unplug_fridge', 'no_refrigerant_work'],
    'condenser-coil-clear': ['unplug_fridge', 'no_refrigerant_work'], retest: [] },
  FIX_CHECKS: ['ff-clearance', 'condenser-coil-clear'],
  // gurgling / cracking with nothing harsher is the refrigerant and plastics working — normal, said once, no part
  early(h) { return h.has('gurgle') && !bad(h) && !h.has('constant') ? { target: 'normal-operating-noise', reason: 'normal-refrigeration-sounds', rule: 'FN5', handoff: 'none' } : null; },
  steps: [
    { n: 10, target: 'noiseType', reason: 'type-by-sound', when: (h) => !typed(h) },
    { n: 11, target: 'noiseFromInside', reason: 'source-inside-or-back', when: (h) => !h.has('inside') && !h.has('back') },
    { n: 12, target: 'noiseStopsWhenDoorOpen', reason: 'door-switch-stops-internal-fan', when: (h) => h.has('inside') && !h.has('doorStops') && !h.has('doorNoChange') },
    { n: 13, target: 'runsConstantly', reason: 'running-cycle', when: (h) => (h.has('softHum') || h.has('buzz') || h.has('back')) && h.obs('runsConstantly') == null },
    { n: 14, target: 'ff-clearance', reason: 'touching-loose-or-not-level', when: (h) => h.has('back') || h.has('rattle') || h.obs('knockingNoise') === true },
    { n: 15, target: 'condenser-coil-clear', reason: 'coils-and-space', when: (h) => h.has('constant') || (h.has('back') && (h.has('buzz') || h.has('grind'))) },
  ],
  PART_FAMILIES: new Set(['EF']),
  HANDOFF: { NN: 'none', EF: 'engineer', RC: 'none', CC: 'engineer', CF: 'engineer' },
});
const pipeline = JP.makeModelPartPipeline({
  D: { diagnose }, P, schema: 'ff3/1', codeFaultFor: F.ffCodeFault,
  PART_MATCH: { 'evaporator-fan': { re: /(evaporator|freezer|fridge|internal)\s+fan|fan\s+motor/i, not: /condenser|tumble|dryer|oven|cooker|hood/i } },
  MEDIA_BY_KEY: {},
});

// ---- COMPOSE (wording only) ----
const FAMILY_LABEL = { 'normal-operating-noise': 'normal running sounds', 'internal-fan': 'the internal (evaporator) fan', 'touching-or-loose-at-back': 'something touching or loose at the back',
  'runs-constantly-coils': 'it working too hard (coils / space round it)', 'condenser-fan-or-compressor-area': 'the condenser fan or compressor area at the back' };
const COMPONENT_LABEL = { 'evaporator-fan': 'internal (evaporator) fan' };
const TASK = {
  'ask_observation:noiseType': { say: 'Most fridge freezer sounds are normal, so the type of sound matters.', ask: 'What does it sound like — gurgling or cracking, clicking, a hum or buzz, squealing or grinding, or rattling?' },
  'ask_observation:noiseFromInside': { say: 'Next, where it\'s coming from.', ask: 'Is the noise from inside the fridge or freezer, or from the back / bottom outside?' },
  'ask_observation:noiseStopsWhenDoorOpen': { say: 'The fan inside stops when the door is opened (or when you press the little door switch).', ask: 'When you open the door while it\'s making the noise, does the noise stop, or carry on the same?' },
  'ask_observation:runsConstantly': { say: 'A fridge freezer normally runs, then goes quiet for a while.', ask: 'Does it ever go quiet, or does it seem to run all the time?' },
  'ask_check:ff-clearance': { say: 'Ease it out from the wall and check nothing at the back is touching the wall, cupboards or the pipes, the drip tray on top of the motor is sitting properly, and it stands level and firm.', ask: 'Was something touching, loose or not level (and have you sorted it), or was it all clear?' },
  'ask_check:condenser-coil-clear': { say: 'If the coil or grille at the back or underneath is dusty, or it\'s pushed against the wall, it works harder and louder. Gently dust or vacuum it and leave a few centimetres of space.', ask: 'Was it dusty or tight against the wall (and have you sorted it), or was it already clean with space?' },
  'ask_check:retest': { say: 'Let it run as normal for a few hours.', ask: 'Has the noise gone, or is it still there?' },
  'ask_identity:model': { say: 'To match the right part for your fridge freezer I need its exact model.', ask: 'Could you send me the model number? It\'s on the rating label inside the fridge, usually on a side wall near the salad drawer — a photo is fine.' },
  'ask_identity:appliance': { say: '', ask: 'Is it a fridge freezer, a fridge or a freezer?' },
};
const CONCLUSION = {
  'normal-operating-noise': 'Gurgling, bubbling, cracking and the odd click are normal: it\'s the refrigerant moving round and the plastics expanding as it cools and defrosts. Nothing needs fixing and no part is needed — if it changes to squealing, grinding or loud rattling, let me know.',
  'FN7:touching-or-loose-at-back': 'That was something touching or loose at the back, so no part is needed.',
  'FN7:runs-constantly-coils': 'Cleaning the coils and giving it space very likely fixed it, so no part is needed.',
  'internal-fan': 'A squeal or grind from inside that stops when the door opens points to the internal fan. An appliance engineer can confirm it safely — I\'m not recommending a part from this.',
  'condenser-fan-or-compressor-area': 'With nothing touching and the coils clear, the noise is from the condenser fan or compressor area at the back. Please don\'t take any covers off; an appliance engineer is the next step — I\'m not recommending a part from this.',
  'runs-constantly-coils': 'Running all the time with clean coils and space round it needs an appliance engineer to check — I\'m not recommending a part from this.',
};
const compose = ck.createCompose({
  TASK, CONFIRM_ASK: 'Has the noise gone now?',
  OBS_COPY: { gurglingNoise: ['gurgling / cracking', null], clickingNoise: ['clicking', null], humNoise: ['humming / buzzing', null], squealNoise: ['squealing', null], grindingNoise: ['grinding', null],
    scrapingNoise: ['scraping', null], rattlingNoise: ['rattling', null], knockingNoise: ['knocking', null], noiseFromInside: ['from inside', 'from the back / bottom'],
    noiseStopsWhenDoorOpen: ['stops with the door open', 'same with the door open'], runsConstantly: ['runs all the time', null], faultPersists: ['still noisy', 'noise gone'] },
  CHECK_RESULT_COPY: { 'ff-clearance': { clear: 'nothing touching, level', found_and_cleared: 'something touching / loose sorted' }, 'condenser-coil-clear': { clear: 'coils clean with space', found_and_cleared: 'coils cleaned / space made' } },
  statusChecks: [['retest', 'retest']],
  conclusionCopy: ck.makeConclusionCopy({ FAMILY_LABEL, COMPONENT_LABEL, CONCLUSION, fitNote: 'Switch the fridge freezer off at the socket before fitting it; if you\'d rather not, an appliance engineer can fit it.' }),
  PURCHASE_RE: /\b(buy|order|purchase|price|£\s?\d)|\b(new|replacement|replace the)\s+(fan|fan motor|compressor|relay|pcb|control board)\b/i,
});
module.exports = { SPEC, FAMILY, diagnose, P, ...pipeline, FAMILY_LABEL, COMPONENT_LABEL, TASK, REQUIREMENT: ck.REQUIREMENT, SAFETY_COPY: ck.SAFETY_COPY, ...compose };
