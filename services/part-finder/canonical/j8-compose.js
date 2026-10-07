'use strict';
/** Journey 8 COMPOSE pack — washing machine · noisy. WORDING ONLY. PURE. */
const ck = require('./compose-kit.js');

const FAMILY_LABEL = {
  'normal-operating-noise': 'normal operating noise', 'pump-obstruction': 'something caught in the drain pump', 'foreign-object': 'an object loose in the drum or between the drum and tub',
  'load-or-installation': 'the load or how the machine is installed', 'drain-pump-worn': 'the drain pump', 'belt-pulley-or-motor': 'the drive belt, pulley or motor',
  'drum-bearings': 'the drum bearings',
};
const COMPONENT_LABEL = { 'drain-pump': 'drain pump', 'drive-belt': 'drive belt' };
const TASK = {
  'ask_observation:noiseTiming': { say: 'When the noise happens tells us a lot.', ask: 'Do you hear it while it fills, during the wash, while it drains, on the spin, or all the time?' },
  'ask_observation:noiseType': { say: 'Next, what it sounds like.', ask: 'Is it more of a grinding or rumbling, a hum, a metallic scraping, a knock or bang, a rattle, a squeal, or a click?' },
  'ask_observation:recentInstallation': { say: 'A new or recently moved machine can knock if it wasn\'t set up fully.', ask: 'Was the machine recently installed, delivered or moved?' },
  'ask_check:drain-filter': { say: 'A noise while draining is often a coin, button or hair grip caught at the pump. Open the small flap at the bottom front and slowly unscrew the pump filter.', ask: 'Did you find anything caught in the filter (and clear it), or was it clear?' },
  'ask_check:pump-impeller': { say: 'With the filter still out, shine a torch into the opening and gently turn the small plastic impeller with a finger.', ask: 'Does it turn freely with nothing caught, did you find and clear something, or is it broken or rough?' },
  'ask_check:drum-foreign-object': { say: 'Look all round the inside of the drum, under the paddles and in the folds of the door seal for a coin, bra wire or other object. Turn the drum slowly by hand and listen for anything sliding or catching.', ask: 'Did you find something and remove it, can you see or hear something stuck that you can\'t get out, or is there nothing there?' },
  'ask_check:transit-bolts': { say: 'New machines come with transit (shipping) bolts in the back panel that lock the drum for delivery. If they\'re still in, it bangs on the spin.', ask: 'Are any transit bolts still fitted (and have you taken them out), or were they already removed?' },
  'ask_check:load-check': { say: 'A single heavy item or a very small load can knock and bang as it spins.', ask: 'Was it one heavy item or a small load (and have you evened it out), or a normal mixed load?' },
  'ask_check:drum-by-hand': { say: 'With the machine unplugged, turn the drum slowly by hand a few times and listen.', ask: 'Does it turn smoothly and quietly, or does it feel rough or grind as it turns?' },
  'ask_check:drum-play': { say: 'With the machine unplugged and the door open, push the drum firmly down and lift it up, then rock it side to side.', ask: 'Does the drum feel loose — dropping, knocking or clunking — or firm with just a slight springy movement?' },
  'ask_check:retest': { say: 'Now run a normal programme again.', ask: 'Has the noise gone, or can you still hear it?' },
  'ask_identity:model': { say: 'To match the right part for your machine I need its exact model.', ask: 'Could you send me the model number? It\'s on the rating plate — usually around the door opening or on the back — and a photo of the label is fine.' },
  'ask_identity:appliance': { say: '', ask: 'Is it a washing machine, a washer-dryer or a dishwasher?' },
};
const CONCLUSION = {
  'N7:pump-obstruction': 'Whatever was caught at the pump was very likely making the noise, so no part is needed.',
  'N7:foreign-object': 'The object you removed was very likely the noise, so no part is needed. Checking pockets and using a wash bag for underwired bras helps stop it happening again.',
  'N7:load-or-installation': 'That was the load or the set-up rather than a fault, so no part is needed.',
  'normal-operating-noise': 'A hum while it fills (the water valve and water flowing in) or a click as the door locks and unlocks is normal operating noise — no part is needed. If it changes to a grind, scrape or bang, let me know.',
  'foreign-object': (state) => {
    const k = state.evidence && state.evidence.checks && state.evidence.checks['drum-foreign-object'];
    return k && k.result === 'found_not_cleared'
      ? 'Something stuck through the drum or trapped between the drum and the outer tub needs the machine opening up to remove. Please don\'t use it until then; an appliance engineer can take it out safely — no new part is usually needed.'
      : 'This sounds like something loose in the drum or between the drum and the tub (often a coin or bra wire). An appliance engineer can find and remove it safely — I\'m not recommending a part from this.';
  },
  'drum-bearings': 'A rough, grinding drum points to worn drum bearings. On most machines that\'s a major repair, so please have an appliance engineer confirm it before deciding whether repair is worthwhile — I\'m not recommending a part from this.',
};
const OBS_COPY = {
  noiseOnFill: ['noise while filling', null], noiseOnWash: ['noise during the wash', null], noiseOnDrain: ['noise while draining', null], noiseOnSpin: ['noise on spin', null],
  noiseThroughout: ['noise all the time', null], grindingNoise: ['grinding / rumbling', null], humNoise: ['humming', null], scrapingNoise: ['metallic scraping', null],
  knockingNoise: ['knocking / banging', null], rattlingNoise: ['rattling', null], squealNoise: ['squealing', null], clickingNoise: ['clicking', null],
  recentInstallation: ['recently installed / moved', 'not recently moved'], drumPlay: ['drum feels loose', 'drum feels firm'], faultPersists: ['noise still there after the fix', 'noise gone after the fix'],
};
const CHECK_RESULT_COPY = {
  'drain-filter': { clear: 'pump filter clear', found_and_cleared: 'something in the pump filter (cleared)', found_not_cleared: 'something stuck in the pump filter' },
  'pump-impeller': { clear: 'impeller turns freely', found_and_cleared: 'impeller obstruction cleared', fault_seen: 'impeller broken / rough' },
  'drum-foreign-object': { clear: 'nothing loose in the drum', found_and_cleared: 'object found in the drum (removed)', found_not_cleared: 'object stuck that cannot be removed' },
  'transit-bolts': { clear: 'transit bolts already removed', found_and_cleared: 'transit bolts were still in (removed)' },
  'load-check': { clear: 'normal mixed load', found_and_cleared: 'load problem (corrected)' },
  'drum-by-hand': { clear: 'drum turns smoothly by hand', fault_seen: 'drum rough / grinding by hand' },
  'drive-belt': { fault_seen: 'drive belt worn / damaged' },
};
const compose = ck.createCompose({
  TASK, OBS_COPY, CHECK_RESULT_COPY, CONFIRM_ASK: 'Has the noise gone now?',
  statusChecks: [['drum-play', 'drum play check'], ['retest', 'retest']],
  conclusionCopy: ck.makeConclusionCopy({ FAMILY_LABEL, COMPONENT_LABEL, CONCLUSION }),
  PURCHASE_RE: /\b(buy|order|purchase|price|£\s?\d)|\b(new|replacement|replace the)\s+(drain\s+)?(pump|bearings?|belt|motor|pulley|shock absorbers?|drum|spider|carbon brushes)\b/i,
});
module.exports = { FAMILY_LABEL, COMPONENT_LABEL, TASK, REQUIREMENT: ck.REQUIREMENT, SAFETY_COPY: ck.SAFETY_COPY, ...compose };
