'use strict';
/**
 * Microwave journey 5 — sparking / noisy (rules MN1–MN22). PURE, deterministic. SAFETY-CRITICAL.
 * Design: docs/diagnostics/final-migration-evidence.md §MW5. Sparking / arcing: the turn it is reported → STOP USE (fixed
 * copy) with one safe question (unplugged, door open: metal / foil? cover panel burnt? paint burnt?), then without use:
 *   metal / foil only, nothing damaged → remove it; it can be used again (if it sparks again, stop)
 *   waveguide cover burnt / damaged → that cover (part with a model; don't use until fitted)
 *   cavity paint burnt / bare metal, or sparking with nothing visible → engineer (stop use)
 * Noise without sparking: turntable rumble / rattle → the turntable parts (owner) · a hum while it heats normally, with no
 * sparks, burning or smoke → the normal running hum (magnetron, transformer and fan; no part) · a hum or buzz from inside
 * with no heat → the HV side → engineer (a hum with the heat unknown asks about the heat first). Never inside the casing.
 */
const engine = require('./evidence-engine.js');
const kit = require('./policy-kit.js');
const JP = require('./journey-pipeline.js');
const F = require('./mw-family.js');
const ck = require('./compose-kit.js');
const { SS, S, A, SA } = engine;

const KEY = 'mw-noisy-sparking';
const FAMILY = { ME: 'metal-or-foil-inside', WG: 'waveguide-cover', CB: 'cavity-paint-burnt', HS: 'arcing-high-voltage-side', TN: 'turntable-noise', HN: 'high-voltage-noise' };
const SIGNALS = {
  ME: { metal: SS, metalRemoved: S, coverDamaged: SA, cavity: SA },
  WG: { coverDamaged: SS, coverSeen: SS, arcing: S, cavity: A },
  CB: { cavity: SS, cavitySeen: S, arcing: S },
  HS: { arcing: S, cavityOk: S, coverDamaged: A, metal: A, cavity: A },
  TN: { partsFixed: SS, restoredAfterPartsFix: SS, failsAfterPartsFix: SA, rattle: S, grind: S, scrape: S, arcing: SA },
  HN: { hum: S, buzz: S, partsOk: S, failsAfterPartsFix: S, arcing: A, heats: A, restoredAfterPartsFix: SA },
};
const FACT_LABEL = { arcing: 'sparking / arcing inside', metal: 'metal / foil was inside', metalRemoved: 'metal removed', coverDamaged: 'waveguide cover burnt / damaged', coverSeen: 'cover panel burnt',
  cavity: 'inside paint burnt / chipped', cavitySeen: 'inside paint burnt', cavityOk: 'nothing visible inside', rattle: 'rattling', grind: 'grinding', scrape: 'scraping', hum: 'loud hum', buzz: 'buzzing',
  partsFixed: 'turntable parts sorted', partsOk: 'turntable parts fine' };
const SPEC = {
  schema: 'mw5-diag/1', FAMILY, PRIOR: ['ME', 'WG', 'CB', 'HS', 'TN', 'HN'], SIGNALS, FACT_LABEL,
  obs: { metal: ['metalInside', true], coverDamaged: ['waveguideCoverDamaged', true], cavity: ['cavityBurnt', true], rattle: ['rattlingNoise', true], grind: ['grindingNoise', true],
    scrape: ['scrapingNoise', true], hum: ['humNoise', true] },
  checks: { 'mw-cavity-check': { clear: 'cavityOk', cleared: 'metalRemoved', fault: 'coverSeen' }, 'turntable-parts': { clear: 'partsOk', found: 'partsFixed' } },
  FIX_CHECK: { TN: ['turntable-parts', 'Parts'] },
  DECISIVE_PART: { WG: { coverDamaged: 'waveguide-cover', coverSeen: 'waveguide-cover' } },
  extra(s, ctx, on) {
    // a sparking report is arcing even when the classifier typed no hazard (safety alters the path either way)
    on('arcing', ((s.safety && s.safety.hazards) || []).some((x) => x.hazard === 'microwave_arcing') || sparkingReport(s));
    // a hum / buzz from inside is HV evidence only when it does not heat; one that heats normally is the normal running hum
    on('buzz', engine.obsVal(s, 'humNoise') === true && engine.obsVal(s, 'noHeat') === true);
    on('heats', engine.obsVal(s, 'heatPresent') === true && engine.obsVal(s, 'noHeat') !== true);
  },
  eligible: (k, has) => (['ME', 'WG', 'CB', 'HS'].includes(k) ? has('arcing') || has('metal') || has('coverDamaged') || has('cavity') : true),
};
function diagnose(state, ctx = {}) {
  const codeFault = ctx.codeFault !== undefined ? ctx.codeFault : F.mwCodeFault(state, ctx.errorCodes || null);
  return engine.diagnoseSpec(SPEC, state, { ...ctx, codeFault });
}
const SPARK = (h) => h.has('arcing') || h.has('metal') || h.has('coverDamaged') || h.has('cavity');
function sparkingReport(s) {
  const p = (s.problems || []).find((x) => x.status === 'active');
  return Boolean(p && p.journey && p.journey.value === 'sparking');
}
/** A sparking report with NO typed arcing hazard: the same stop-use on the turn it is reported (once), then carry on. */
function sparkContainment(s) {
  if (((s.safety && s.safety.hazards) || []).some((x) => x.hazard === 'microwave_arcing')) return null;
  const p = (s.problems || []).find((x) => x.status === 'active');
  if (!sparkingReport(s) || !p.journey || p.journey.turn !== s.version) return null;
  return { target: 'mw-arcing', reason: 'sparking-report-stop-use', requires: ['stop_use'], pending: { slot: 'OBSERVATION', target: 'mwSparkCause', purpose: 'DIAGNOSIS' } };
}
const BURNING = ['burning', 'smoke', 'microwave_arcing'];
const burningReported = (s) => ((s.safety && s.safety.hazards) || []).some((x) => BURNING.includes(x.hazard));
const HARSH = ['grindingNoise', 'scrapingNoise', 'knockingNoise', 'rattlingNoise', 'squealNoise'];
/** A hum while it heats normally, with no sparking, burning, smoke or harsher noise: the normal running hum. */
const normalHum = (h) => h.obs('humNoise') === true && h.has('heats') && !SPARK(h) && !burningReported(h.s) && !HARSH.some((k) => h.obs(k) === true);
const NOISE = ['grindingNoise', 'humNoise', 'scrapingNoise', 'knockingNoise', 'rattlingNoise', 'squealNoise', 'clickingNoise'];
const P = kit.makeStepPolicy({
  JOURNEY: KEY, P: 'MN', appliance: 'microwave', journeys: ['sparking', 'noisy'], ...F.owns(KEY), declineUnsafe: F.UNSAFE,
  continueAfterHazard: { microwave_arcing: { stop: 'mw-arcing', pending: 'mwSparkCause', partOk: true } },
  containment: (s) => sparkContainment(s),
  CHECKS: ['mw-cavity-check', 'turntable-parts'],
  OBS_TARGETS: { mwSparkCause: ['metalInside', 'waveguideCoverDamaged', 'cavityBurnt'], noiseType: NOISE, heatState: ['noHeat', 'heatPresent'] },
  REQUIRES: { mwSparkCause: ['mw_no_casing'], 'mw-cavity-check': ['mw_no_casing'], noiseType: [], heatState: [], 'turntable-parts': ['mw_no_casing'], retest: [] },
  early(h) { return normalHum(h) ? { target: 'normal-operating-hum', reason: 'hums-while-heating-normally', rule: 'MN5', handoff: 'none' } : null; },
  FIX_CHECKS: ['turntable-parts'],
  steps: [
    { n: 10, target: 'mwSparkCause', reason: 'metal-cover-or-paint', when: (h) => h.has('arcing') && !h.has('metal') && !h.has('coverDamaged') && !h.has('cavity') },
    { n: 11, target: 'mw-cavity-check', reason: 'look-inside-unplugged', when: (h) => SPARK(h) && !h.has('coverDamaged') && !h.has('cavity') },
    { n: 12, target: 'noiseType', reason: 'type-the-noise', when: (h) => !SPARK(h) && !NOISE.some((k) => h.obs(k) === true) },
    { n: 13, target: 'turntable-parts', reason: 'turntable-rumble-rattle', when: (h) => !SPARK(h) && (h.has('rattle') || h.has('grind') || h.has('scrape')) },
    { n: 14, target: 'heatState', reason: 'hum-normal-if-it-heats', when: (h) => !SPARK(h) && h.has('hum') && h.obs('noHeat') == null && h.obs('heatPresent') == null },
  ],
  PART_FAMILIES: new Set(['WG']),
  HANDOFF: { ME: 'none', WG: 'engineer', CB: 'engineer', HS: 'engineer', TN: 'none', HN: 'engineer' },
});
const pipeline = JP.makeModelPartPipeline({
  D: { diagnose }, P, schema: 'mw5/1', codeFaultFor: F.mwCodeFault,
  PART_MATCH: { 'waveguide-cover': { re: /waveguide|mica\s+(cover|sheet|plate)|fat\s+shield/i, not: /motor|magnetron|diode|capacitor/i } },
  MEDIA_BY_KEY: {},
});

// ---- COMPOSE (wording only) ----
const FAMILY_LABEL = { 'metal-or-foil-inside': 'metal or foil inside', 'waveguide-cover': 'a burnt waveguide cover', 'cavity-paint-burnt': 'burnt / chipped paint inside', 'arcing-high-voltage-side': 'the high-voltage side',
  'turntable-noise': 'the turntable parts', 'high-voltage-noise': 'the high-voltage parts', 'normal-operating-hum': 'the normal running hum' };
const COMPONENT_LABEL = { 'waveguide-cover': 'waveguide cover' };
const TASK = {
  'ask_observation:mwSparkCause': { say: 'With it unplugged and the door open, have a look inside.', ask: 'Was there any metal, foil or a dish with a metal rim inside, is the small cover panel on the inside wall burnt or damaged, or is the paint inside burnt or chipped?' },
  'ask_check:mw-cavity-check': { say: 'With it unplugged and the door open, take out anything metal or foil, then look closely at the small flat cover panel on the inside wall (usually on the right) and the paint inside — wipe off any food splatter on the panel.', ask: 'Did you find metal / food splatter and remove it, is the cover panel burnt or holed, or does everything look clean and undamaged?' },
  'ask_observation:noiseType': { say: 'The sound tells us where it\'s coming from.', ask: 'Is it a rattle or grinding as the turntable goes round, or a loud buzz / hum from inside?' },
  'ask_check:turntable-parts': { say: 'Lift the glass tray out, clean the roller ring and the floor under it, check the coupler in the middle isn\'t cracked, and refit the tray on the coupler.', ask: 'Was the tray off the coupler or the ring dirty (and is it sorted), is a part broken, or was it all fine?' },
  'ask_observation:heatState': { say: 'A microwave normally hums while it runs — the magnetron, transformer and fan all make a steady hum.', ask: 'Does it still heat food normally, or has it stopped heating?' },
  'ask_check:retest': { say: 'Try it with a cup of water for a minute.', ask: 'Has the noise gone, or is it still there?' },
  'ask_identity:model': F.MW_MODEL_ASK, 'ask_identity:appliance': F.MW_APPLIANCE_ASK,
};
const CONCLUSION = {
  'metal-or-foil-inside': 'The sparks came from the metal / foil — microwaves bounce off metal and arc. With it removed and nothing inside burnt or damaged, it\'s fine to use again; if it ever sparks with nothing metal inside, stop and tell me. No part is needed.',
  'cavity-paint-burnt': `Burnt or chipped paint inside can keep arcing. Please don't use it again — ${F.HV} An appliance engineer is the next step (for a low-cost microwave, replacing it is often more economical); I'm not recommending a part from this.`,
  'arcing-high-voltage-side': `Sparking with no metal inside and nothing visibly burnt points to the high-voltage side. Please don't use it again. ${F.HV} An appliance engineer is the next step; I'm not recommending a part from this.`,
  'waveguide-cover': 'A burnt or holed waveguide cover is a common cause of sparking. Please don\'t use the microwave until it\'s replaced. With your model number I can check for the cover; I\'m not recommending a part without it.',
  'MN7:turntable-noise': 'That was the turntable parts, so no part is needed.',
  'normal-operating-hum': 'A steady hum while it runs is normal — it\'s the magnetron, transformer and cooling fan working. As it heats food normally with no sparks, burning smell or smoke, nothing needs fixing and no part is needed. If the hum turns into a loud buzz, it stops heating, or you see sparks or smell burning, stop using it and let me know.',
  'high-voltage-noise': `A loud buzz or hum from inside (rather than the turntable) points to the high-voltage parts. Please don't keep using it. ${F.HV} An appliance engineer is the next step; I'm not recommending a part from this.`,
};
const compose = ck.createCompose({
  ASK_GUARD: true, TASK, CONFIRM_ASK: 'Is that clear?',
  OBS_COPY: { metalInside: ['metal / foil inside', null], waveguideCoverDamaged: ['cover panel burnt', null], cavityBurnt: ['inside paint burnt', null], rattlingNoise: ['rattling', null],
    grindingNoise: ['grinding', null], humNoise: ['loud hum / buzz', null], faultPersists: ['still noisy', 'quiet now'] },
  CHECK_RESULT_COPY: { 'mw-cavity-check': { clear: 'nothing inside, all undamaged', found_and_cleared: 'metal / splatter removed', fault_seen: 'cover panel burnt / holed' },
    'turntable-parts': { clear: 'turntable parts fine', found_and_cleared: 'turntable parts sorted' } },
  statusChecks: [['retest', 'retest']],
  conclusionCopy: ck.makeConclusionCopy({ FAMILY_LABEL, COMPONENT_LABEL, CONCLUSION, fitNote: 'Unplug the microwave first; the cover clips or screws onto the inside wall (no casing removal). Don\'t use it until the new cover is fitted.' }),
  PURCHASE_RE: /\b(buy|order|purchase|price|£\s?\d)|\b(new|replacement|replace the)\s+(magnetron|diode|capacitor|transformer|waveguide|cover|stirrer|pcb|control board)\b/i,
});
module.exports = { SPEC, FAMILY, diagnose, P, ...pipeline, FAMILY_LABEL, COMPONENT_LABEL, TASK, REQUIREMENT: ck.REQUIREMENT, SAFETY_COPY: ck.SAFETY_COPY, ...compose };
