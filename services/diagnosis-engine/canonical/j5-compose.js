'use strict';
/** Journey 5 COMPOSE pack — washing machine · overfilling. WORDING ONLY. PURE. */
const ck = require('./compose-kit.js');

const FAMILY_LABEL = {
  'inlet-valve-stuck-open': 'the inlet (fill) valve sticking open', 'drain-hose-siphon': 'the drain hose installation (siphoning)',
  'foam-level': 'too much detergent foam upsetting the level sensing', 'waste-backflow': 'waste water backing up from the household plumbing', 'level-sensing-or-control': 'the water-level sensing or the control side',
};
const COMPONENT_LABEL = { 'inlet-valve': 'inlet (fill) valve' };
const TASK = {
  'ask_observation:fillsWhenOff': { say: 'This tells us which part is letting the water in.', ask: 'When the machine is switched off at the socket, does water still keep running in (into the drawer or the drum)?' },
  'ask_check:power-off-fill-test': { say: 'With the machine switched off at the socket, turn the tap back on and watch the detergent drawer and the drum for a minute.', ask: 'Did any water run in while the machine was switched off?' },
  'ask_observation:waterIsDirty': { say: 'The kind of water tells us where it\'s coming from.', ask: 'Is the water that appears clean like tap water, or dirty and smelly like waste water?' },
  'ask_observation:waterLevelHigh': { say: 'Next, how high the water actually gets.', ask: 'While it\'s running, does the water rise above the bottom of the door glass, or does it keep taking water while the level looks normal?' },
  'ask_check:drain-hose-height': { say: 'Check how the grey drain hose is fitted at the back: it should rise high (hooked near the top of the machine or the standpipe) and go no more than a hand\'s width down the standpipe or sink waste. If it hangs low or is pushed far in, water can siphon away as it fills.', ask: 'Was it low or pushed in too far (and have you refitted it), or was it already fitted correctly?' },
  'ask_check:retest': { say: 'Turn the tap back on and start a short programme.', ask: 'Does it fill to a normal level and stop now, or does it still keep taking water?' },
  'ask_identity:model': { say: 'To match the right valve for your machine I need its exact model.', ask: 'Could you send me the model number? It\'s on the rating plate — usually around the door opening or on the back — and a photo of the label is fine.' },
  'ask_identity:appliance': { say: '', ask: 'Is it a washing machine, a washer-dryer or a dishwasher?' },
};
const CONCLUSION = {
  'O7:drain-hose-siphon': 'The drain hose fitting was very likely letting the water siphon away (so it kept refilling), so no part is needed. Keep the hose hooked up high.',
  'drain-hose-siphon': 'This points to the drain hose installation: if it sits too low or too far down the waste, water siphons out as it fills (or dirty water runs back in). Refitting it high is an installation fix, not a part — a plumber or installer can sort it if needed.',
  'foam-level': 'Too much foam can upset the level sensing and make it take extra water. Use the recommended dose of a low-foam (HE) detergent and run a rinse to clear the suds — no part is needed.',
  'level-sensing-or-control': (state) => {
    const f = state.evidence && state.evidence.observations && state.evidence.observations.fillsWhenOff;
    const lead = f && f.value === false ? 'As the water stops once the machine is switched off, the valve is closing properly — the machine is being told to keep filling. That' : 'This';
    return `${lead} points to the water-level (pressure) sensing or the control side, which needs an appliance engineer to diagnose safely. Keep the tap off between washes until then; I'm not recommending a part from this.`;
  },
  'waste-backflow': 'Dirty water appearing in the drum with the drain hose fitted correctly means waste water is backing up from the household plumbing (a blocked sink waste, trap or standpipe). Clearing that, or a plumber, is the next step — no machine part is needed.',
  'inlet-valve-stuck-open': 'Water coming in with the machine switched off points to the inlet valve sticking open. Keep the tap turned off whenever the machine isn\'t in use until it\'s repaired; an appliance engineer can confirm and replace it.',
};
const OBS_COPY = {
  fillsWhenOff: ['water still enters with the machine off', 'water stops when it is switched off'], waterLevelHigh: ['water level too high', 'level stays normal while it keeps taking water'],
  waterIsDirty: ['the water is dirty / smelly', 'the water is clean'], majorLeak: ['a large amount of water', null], excessiveFoam: ['excess foam', null],
  faultPersists: ['still overfills after the fix', 'fills normally after the fix'],
};
const CHECK_RESULT_COPY = { 'drain-hose-height': { clear: 'drain hose fitted correctly', found_and_cleared: 'drain hose too low / too far in (refitted)', found_not_cleared: 'drain hose fitted wrongly' } };
const compose = ck.createCompose({
  TASK, OBS_COPY, CHECK_RESULT_COPY, CONFIRM_ASK: 'Is it filling to a normal level now?',
  statusChecks: [['power-off-fill-test', 'switched-off fill test'], ['retest', 'retest']],
  conclusionCopy: ck.makeConclusionCopy({ FAMILY_LABEL, COMPONENT_LABEL, CONCLUSION, fitNote: 'Keep the tap off and the machine unplugged until it is fitted; if you\'d rather not fit it yourself, an appliance engineer can.' }),
  PURCHASE_RE: /\b(buy|order|purchase|price|£\s?\d)|\b(new|replacement|replace the)\s+(inlet valve|fill valve|valve|solenoid|pressure switch|pcb|control board)\b/i,
});
module.exports = { FAMILY_LABEL, COMPONENT_LABEL, TASK, REQUIREMENT: ck.REQUIREMENT, SAFETY_COPY: ck.SAFETY_COPY, ...compose };
