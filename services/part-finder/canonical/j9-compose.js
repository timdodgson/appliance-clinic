'use strict';
/** Journey 9 COMPOSE pack — washing machine · not heating. WORDING ONLY. PURE. */
const ck = require('./compose-kit.js');

const FAMILY_LABEL = {
  'normal-low-temperature': 'normal low-temperature washing', 'programme-setting': 'the temperature setting', 'heater-element': 'the heater element',
  'temperature-sensor': 'the temperature sensor', 'fill-or-level': 'the water level (the heater only runs once it has filled)', 'heating-control': 'the heating control or wiring',
};
const COMPONENT_LABEL = { heater: 'heater element' };
const TASK = {
  'ask_observation:hotProgrammeUsed': { say: 'Modern machines often wash cool on purpose — eco, quick and 20–30°C programmes barely heat, and the door glass can stay cool even when the water is warm.', ask: 'Which programme and temperature were you using — a 40°C or hotter cottons wash, or an eco, quick or low-temperature one?' },
  'ask_check:hot-wash-test': { say: 'To check properly, run a 60°C cottons programme (not eco or quick) with a normal load, and take the washing out as soon as it finishes.', ask: 'Does the washing come out warm, or still cold?' },
  'ask_observation:longCycle': { say: 'One more thing that helps.', ask: 'Does the programme take much longer than usual, or seem to get stuck part way through?' },
  'ask_check:retest': { say: 'Now run a 60°C cottons wash again.', ask: 'Does the washing come out warm now, or still cold?' },
  // washer-dryer only (wd-not-heating-wash asks it first; never asked for a washing machine)
  'ask_observation:wdDrySide': { say: 'A washer-dryer heats in two places — the wash water and the drying air — and they use different heaters.', ask: 'Is it the wash water that stays cold, or does it not heat when it\'s drying?' },
  'ask_identity:model': { say: 'To match the right part for your machine I need its exact model.', ask: 'Could you send me the model number? It\'s on the rating plate — usually around the door opening or on the back — and a photo of the label is fine.' },
  'ask_identity:appliance': { say: '', ask: 'Is it a washing machine, a washer-dryer or a dishwasher?' },
};
const CONCLUSION = {
  'H7:programme-setting': 'The temperature setting was very likely the reason, so no part is needed.',
  'normal-low-temperature': (state) => {
    const o = state.evidence && state.evidence.observations;
    return o && o.hotProgrammeUsed && o.hotProgrammeUsed.value === false && !(o.heatPresent && o.heatPresent.value)
      ? 'Eco, quick and low-temperature programmes heat very little (or not at all), so cool washing on those is normal. If you want to be sure, try a 60°C cottons wash and see whether the washing comes out warm — no part is needed for this.'
      : 'Warm washing on the 60°C test means the heater is working. Eco and low-temperature programmes heating very little — and a cool door glass — are normal. No part is needed.';
  },
  'heater-element': 'Cold washing on a programme that should heat points to the heating side — most often the heater element, but the temperature sensor, wiring or control can do the same. That needs an appliance engineer to test safely; I\'m not recommending a part from this.',
  'temperature-sensor': 'This points to the temperature sensor or its wiring. That needs an appliance engineer to test safely — I\'m not recommending a part from this.',
  'heating-control': 'The heating control or wiring is the most likely area. That needs an appliance engineer to test safely — I\'m not recommending a part from this.',
  'fill-or-level': 'The heater only switches on once the machine has filled to the right level, so a fill or level problem can stop it heating. An appliance engineer is the best next step — I\'m not recommending a part from this.',
};
const OBS_COPY = {
  noHeat: ['washes cold', 'gets warm'], heatPresent: ['gets warm', null], longCycle: ['programme takes much longer than usual', null],
  hotProgrammeUsed: ['a hot programme was used', 'an eco / quick / low-temperature programme was used'], faultPersists: ['still cold after the change', 'warm after the change'],
  wdDrySide: ['the problem is during drying', 'the problem is during washing'],
};
const CHECK_RESULT_COPY = { 'programme-setting': { clear: 'temperature setting fine', found_and_cleared: 'temperature setting changed' } };
const compose = ck.createCompose({
  TASK, OBS_COPY, CHECK_RESULT_COPY, CONFIRM_ASK: 'Is it washing warm again now?',
  statusChecks: [['hot-wash-test', '60°C test'], ['retest', 'retest']],
  conclusionCopy: ck.makeConclusionCopy({ FAMILY_LABEL, COMPONENT_LABEL, CONCLUSION, fitNote: 'Unplug the machine before fitting it — the heater sits behind a panel, so if you\'re not confident, an appliance engineer can fit and test it.' }),
  PURCHASE_RE: /\b(buy|order|purchase|price|£\s?\d)|\b(new|replacement|replace the)\s+(heater|heating element|element|thermistor|ntc|temperature sensor|pcb|control board|relay)\b/i,
});
module.exports = { FAMILY_LABEL, COMPONENT_LABEL, TASK, REQUIREMENT: ck.REQUIREMENT, SAFETY_COPY: ck.SAFETY_COPY, ...compose };
