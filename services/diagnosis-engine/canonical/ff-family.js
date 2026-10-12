'use strict';
/**
 * Fridge / freezer family — the ONE ownership function for the seven fridge-freezer journeys (PURE). Every journey's
 * claims(h, journey) / ownedElsewhere(h, journey) are derived from ffOwner, so exactly one journey owns a turn and a
 * handoff happens once and never bounces. Reads typed cs/1 (via the step-policy helpers) and the displayed-code faultId.
 *
 * Precedence (first match wins):
 *   1. not running / dead   : no power, clicks-but-never-starts, or a silent compressor on a not-cooling / cut-out
 *                             report (a click-start on a noise report too)                       → ff-not-running-dead
 *   2. door                 : the door will not close / seal on a not-cooling report             → ff-door-seal-door
 *   3. frost / ice          : heavy ice (or ice on the back wall / in the base) on a not-cooling, noisy or leaking
 *                             report (unless the water is from the plumbed supply line)          → ff-ice-frost-build-up
 *   4. the typed journey    : not-cooling / over-cooling / noisy / leaking / ice-build-up / door-problem / wont-start, cuts-out
 *   5. error-code-only      : only codes that map cleanly (defrost-system → frost, evaporator-fan / not-cooling → cooling,
 *                             door-seal → door); sensor / PCB / comms / compressor / ice-maker codes are not owned.
 */
const { codeFaultFor } = require('./j2-diagnostics.js');

const FF_JOURNEYS = ['not-cooling', 'over-cooling', 'noisy', 'leaking', 'ice-build-up', 'door-problem', 'wont-start', 'cuts-out', 'trips-electrics', 'error-code-only'];
const ffCodeFault = (state, errorCodes) => codeFaultFor(state, errorCodes, 'fridge-freezer');
const CODE_OWNER = { 'defrost-system': 'ff-ice-frost-build-up', 'evaporator-fan': 'ff-not-cooling', 'not-cooling': 'ff-not-cooling', 'door-seal': 'ff-door-seal-door' };
const JOURNEY_OWNER = {
  'not-cooling': 'ff-not-cooling', 'over-cooling': 'ff-too-cold-freezing', noisy: 'ff-noisy', leaking: 'ff-leaking-water',
  'ice-build-up': 'ff-ice-frost-build-up', 'door-problem': 'ff-door-seal-door', 'wont-start': 'ff-not-running-dead', 'cuts-out': 'ff-not-running-dead',
  // a trip of the house electrics alone (derived journey) is owned by not-running so the sticky safety stop applies
  'trips-electrics': 'ff-not-running-dead',
};
const notRunning = (h) => h.obs('noPower') === true || h.obs('clicksNoStart') === true || h.obs('compressorRuns') === false;
const heavyIce = (h) => h.obs('heavyIce') === true || h.obs('frostOnBackWall') === true || h.obs('iceInBase') === true;

function ffOwner(h, journey) {
  if (!FF_JOURNEYS.includes(journey)) return null;
  if ((['not-cooling', 'cuts-out'].includes(journey) && notRunning(h)) || (journey === 'noisy' && h.obs('clicksNoStart') === true)) return 'ff-not-running-dead';
  if (journey === 'not-cooling' && (h.obs('doorNotSeating') === true || h.obs('doorCloses') === false)) return 'ff-door-seal-door';
  if (['not-cooling', 'noisy'].includes(journey) && heavyIce(h)) return 'ff-ice-frost-build-up';
  if (journey === 'leaking' && heavyIce(h) && h.obs('leakFromSupplyLine') !== true) return 'ff-ice-frost-build-up';
  if (journey === 'error-code-only') return CODE_OWNER[h.d && h.d.codeFault] || null;
  return JOURNEY_OWNER[journey] || null;
}
/** Step-policy ownership hooks for journey KEY. */
const owns = (KEY) => ({
  claims: (h, journey) => ffOwner(h, journey) === KEY,
  ownedElsewhere: (h, journey) => { const o = ffOwner(h, journey); return o != null && o !== KEY; },
});

// unsafe requests every journey in the family declines (policy P8)
const UNSAFE = ['refrigerant_work', 'bypass_safety_device', 'live_electrical_test', 'open_while_powered', 'repeated_reset_after_trip'];

module.exports = { UNSAFE, FF_JOURNEYS, ffOwner, owns, ffCodeFault, notRunning, heavyIce, CODE_OWNER };
