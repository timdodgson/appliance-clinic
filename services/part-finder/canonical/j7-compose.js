'use strict';
/** Journey 7 COMPOSE pack — washing machine · excessive vibration. WORDING ONLY. PURE. */
const ck = require('./compose-kit.js');

const FAMILY_LABEL = {
  'transit-bolts': 'the transit bolts still being fitted', 'levelling-or-floor': 'the levelling or the floor', 'load-imbalance': 'the load being out of balance',
  'suspension-dampers': 'the suspension (shock absorbers / springs)', 'drum-support-or-bearings': 'the drum support or bearings',
};
const COMPONENT_LABEL = { 'shock-absorber': 'shock absorber' };
const TASK = {
  'ask_observation:recentInstallation': { say: 'A new or recently moved machine is the most common reason for violent shaking.', ask: 'Was the machine recently installed, delivered or moved?' },
  'ask_check:transit-bolts': { say: 'New machines come with transit (shipping) bolts in the back panel that lock the drum for delivery — usually three or four large bolts with plastic spacers. If they\'re still in, the drum can\'t move freely and the whole machine shakes.', ask: 'Are any transit bolts still fitted (and have you taken them out), or were they already removed?' },
  'ask_check:load-check': { say: 'A single heavy item (a bath mat, rug, duvet or pair of jeans) or a very small load can throw the drum off balance.', ask: 'Was it one heavy item or a small load (and have you evened it out), or a normal mixed load?' },
  'ask_check:levelling': { say: 'Check it stands level and firm: press on each top corner — it shouldn\'t rock — and make sure all four feet touch a solid floor with their lock nuts tight.', ask: 'Did it rock or was a foot loose (and have you adjusted it), or was it already level and firm?' },
  'ask_check:empty-vibration-test': { say: 'Take the washing out and run a spin-only programme with the drum empty.', ask: 'Does it still shake or bang violently with the drum empty, or is it smooth?' },
  'ask_check:drum-play': { say: 'With the machine unplugged and the door open, push the drum firmly down and lift it up, then rock it side to side.', ask: 'Does the drum feel loose — dropping, knocking or clunking — or firm with just a slight springy movement?' },
  'ask_check:retest': { say: 'Now run a normal load with a spin.', ask: 'Is it spinning smoothly now, or does it still shake badly?' },
  'ask_identity:model': { say: 'To match the right part for your machine I need its exact model.', ask: 'Could you send me the model number? It\'s on the rating plate — usually around the door opening or on the back — and a photo of the label is fine.' },
  'ask_identity:appliance': { say: '', ask: 'Is it a washing machine, a washer-dryer or a dishwasher?' },
};
const CONCLUSION = {
  'V7:transit-bolts': 'The transit bolts were very likely the cause, so no part is needed. Keep them in case you move the machine again.',
  'V7:levelling-or-floor': 'Levelling it was very likely the fix, so no part is needed. Re-check the feet now and then — they can work loose.',
  'V7:load-imbalance': 'That was the load being out of balance, so no part is needed. Wash heavy items with a few towels to even them out.',
  'transit-bolts': 'If the machine was recently installed, transit bolts still being fitted would explain this — please check the back panel before anything else. No part is needed for that.',
  'levelling-or-floor': 'This points to how the machine stands: it needs to be level, with all four feet locked, on a solid floor (suspended wooden floors can bounce). That\'s an installation fix rather than a part.',
  'load-imbalance': 'This points to the load being out of balance. Wash heavy single items with a few towels and avoid very small loads — no part is needed.',
  'suspension-dampers': 'With the bolts out, the machine level and the drum still shaking when empty, the suspension (shock absorbers or springs) is the most likely area. That needs an appliance engineer to check with the panels off — I\'m not recommending a part from this.',
  'drum-support-or-bearings': 'A loose or rumbling drum points to the drum support or bearings. Please stop using it on fast spins and have an appliance engineer check it — I\'m not recommending a part from this.',
};
const OBS_COPY = {
  excessiveVibration: ['shakes / bangs on spin', null], recentInstallation: ['recently installed / moved', 'not recently moved'], loadDependent: ['only with certain loads', null],
  shakesWhenEmpty: ['still shakes with the drum empty', 'smooth with the drum empty'], drumPlay: ['drum feels loose', 'drum feels firm'],
  grindingNoise: ['grinding / rumbling noise', null], knockingNoise: ['knocking / banging', null], faultPersists: ['still shakes after the fix', 'smooth after the fix'],
};
const CHECK_RESULT_COPY = {
  'transit-bolts': { clear: 'transit bolts already removed', found_and_cleared: 'transit bolts were still in (removed)' },
  levelling: { clear: 'level and firm', found_and_cleared: 'not level / foot loose (adjusted)' },
  'load-check': { clear: 'normal mixed load', found_and_cleared: 'load problem (corrected)' },
  'shock-absorbers': { fault_seen: 'shock absorber broken' },
};
const compose = ck.createCompose({
  TASK, OBS_COPY, CHECK_RESULT_COPY, CONFIRM_ASK: 'Is it spinning smoothly now?',
  statusChecks: [['empty-vibration-test', 'empty spin test'], ['drum-play', 'drum play check'], ['retest', 'retest']],
  conclusionCopy: ck.makeConclusionCopy({ FAMILY_LABEL, COMPONENT_LABEL, CONCLUSION }),
  PURCHASE_RE: /\b(buy|order|purchase|price|£\s?\d)|\b(new|replacement|replace the)\s+(shock absorbers?|dampers?|springs?|suspension|bearings?|drum|spider|counterweight|motor)\b/i,
});
module.exports = { FAMILY_LABEL, COMPONENT_LABEL, TASK, REQUIREMENT: ck.REQUIREMENT, SAFETY_COPY: ck.SAFETY_COPY, ...compose };
