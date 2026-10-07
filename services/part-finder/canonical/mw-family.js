'use strict';
/**
 * Microwave family — the ONE ownership function for the six microwave journeys, plus the shared HV boundary (PURE).
 * HV boundary: never live HT measurement, capacitor probing, magnetron / transformer testing, or running with the casing
 * off — the HV capacitor can hold a lethal charge after unplugging. Internal HV diagnosis → engineer.
 *   1. starts by itself when the door closes (abnormal, unsafe operation)  → mw-starts-when-door-closes
 *   2. sparking / arcing (any report) or a noise                             → mw-noisy-sparking
 *   3. door: door journey, or "says door open" / only works if pushed        → mw-door
 *   4. turntable                                                             → mw-turntable
 *   5. not heating / stops early                                             → mw-not-heating
 *   6. won't start / controls (door recognised or unknown)                   → mw-not-starting
 *   error-code-only: door codes → door, not-heating codes → not-heating; PCB codes stay legacy.
 */
const { codeFaultFor } = require('./j2-diagnostics.js');

const MW_JOURNEYS = ['no-heat', 'cuts-out', 'wont-start', 'controls-unresponsive', 'door-problem', 'turntable-not-turning', 'sparking', 'noisy', 'error-code-only', 'trips-electrics'];
const mwCodeFault = (state, errorCodes) => codeFaultFor(state, errorCodes, 'microwave');
const UNSAFE = ['hv_microwave_work', 'live_electrical_test', 'open_while_powered', 'bypass_safety_device'];
const arcing = (s) => ((s.safety && s.safety.hazards) || []).some((x) => x.hazard === 'microwave_arcing');
const CODE_OWNER = { door: 'mw-door', 'not-heating': 'mw-not-heating' };
function mwOwner(h, journey) {
  if (!MW_JOURNEYS.includes(journey)) return null;
  if (h.obs('startsWhenDoorCloses') === true) return 'mw-starts-when-door-closes';
  if (journey === 'sparking' || journey === 'noisy' || arcing(h.s)) return 'mw-noisy-sparking';
  if (journey === 'door-problem' || h.obs('doorRecognised') === false || h.obs('startsWhenPushed') === true) return 'mw-door';
  if (journey === 'turntable-not-turning') return 'mw-turntable';
  if (['no-heat', 'cuts-out'].includes(journey)) return 'mw-not-heating';
  if (['wont-start', 'controls-unresponsive', 'trips-electrics'].includes(journey)) return 'mw-not-starting'; // a trip alone: sticky safety stop
  if (journey === 'error-code-only') return CODE_OWNER[h.d && h.d.codeFault] || null;
  return null;
}
const owns = (KEY) => ({
  claims: (h, journey) => mwOwner(h, journey) === KEY,
  ownedElsewhere: (h, journey) => { const o = mwOwner(h, journey); return o != null && o !== KEY; },
});
const HV = 'Please don\'t take the outer casing off or try to test anything inside — the high-voltage parts can hold a lethal charge even when it is unplugged.';
const MW_MODEL_ASK = { say: 'To match the right part for your microwave I need its exact model.', ask: 'Could you send me the model number? It\'s on the label on the back, or inside the door frame — a photo is fine.' };
const MW_APPLIANCE_ASK = { say: '', ask: 'Is it a microwave, or a built-in combination microwave oven?' };
module.exports = { MW_JOURNEYS, mwOwner, owns, mwCodeFault, UNSAFE, HV, MW_MODEL_ASK, MW_APPLIANCE_ASK, CODE_OWNER };
