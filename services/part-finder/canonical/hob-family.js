'use strict';
/**
 * Hob family — the ONE ownership function for the four hob journeys (PURE). Hob type is kept (induction / ceramic /
 * solid plate / gas / unknown).
 *   gas      : a burner that won't light / stay lit, or a not-heating GAS hob            → hob-ignition-gas
 *   control  : stuck on full / won't turn down, overheating / switches off when hot       → hob-overheating-control
 *   no power : whole hob dead (no lights), won't-start / controls reports, a trip report   → hob-no-power
 *   zone     : a zone / ring not heating                                                   → hob-zone-not-heating
 *   error-code-only: overheating codes → control; power-module / comms / low-voltage codes stay legacy.
 */
const { codeFaultFor } = require('./j2-diagnostics.js');

const HOB_JOURNEYS = ['no-heat', 'wont-start', 'controls-unresponsive', 'overheating', 'cuts-out', 'wont-light', 'trips-electrics', 'error-code-only'];
const hobCodeFault = (state, errorCodes) => codeFaultFor(state, errorCodes, 'hobs');
const UNSAFE = ['live_electrical_test', 'gas_work', 'open_while_powered', 'bypass_safety_device', 'repeated_reset_after_trip'];
function hobOwner(h, journey) {
  if (!HOB_JOURNEYS.includes(journey)) return null;
  if (journey === 'wont-light' || (journey === 'no-heat' && h.obs('gasHob') === true)) return 'hob-ignition-gas';
  if (h.obs('stuckOnHigh') === true || ['overheating', 'cuts-out'].includes(journey)) return 'hob-overheating-control';
  if (h.obs('noPower') === true || ['wont-start', 'controls-unresponsive', 'trips-electrics'].includes(journey)) return 'hob-no-power';
  if (journey === 'no-heat') return 'hob-zone-not-heating';
  if (journey === 'error-code-only') return (h.d && h.d.codeFault) === 'overheating' ? 'hob-overheating-control' : null;
  return null;
}
const owns = (KEY) => ({
  claims: (h, journey) => hobOwner(h, journey) === KEY,
  ownedElsewhere: (h, journey) => { const o = hobOwner(h, journey); return o != null && o !== KEY; },
});
const HOB_APPLIANCE_ASK = { say: '', ask: 'Is it a hob on its own, or the hob on top of a cooker?' };
module.exports = { HOB_JOURNEYS, hobOwner, owns, hobCodeFault, UNSAFE, HOB_APPLIANCE_ASK };
