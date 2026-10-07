'use strict';
/**
 * Oven / cooker family — the ONE ownership function for the eight oven / cooker journeys (PURE). Fuel is kept
 * (electric / gas / dual / unknown): a dual-fuel cooker has an electric oven and a gas hob.
 *
 * Precedence (first match wins; a handoff happens once):
 *   1. tripping    : the house electrics trip (a trip-only report, or a trip during any oven journey)  → oven-tripping
 *   2. gas         : a burner / gas oven that won't light or stay lit, or a not-heating GAS (not dual) oven → cooker-ignition-gas
 *   3. dead        : no power / no display on any oven journey, or a won't-start / controls report      → oven-dead-no-power
 *   4. not heating : the oven fan does NOT turn (and the main oven isn't heating) → oven-fan-not-working;
 *                    the grill fails and the main oven is not known to be cold → oven-grill-not-working; else → oven-not-heating
 *   5. the typed journey (overheating / cuts-out → overheating, noisy → fan, door → door)
 *   6. error-code-only: element → not-heating, door-lock → door; probe / thermostat / control / PCB codes stay legacy.
 */
const { codeFaultFor } = require('./j2-diagnostics.js');

const OV_JOURNEYS = ['no-heat', 'overheating', 'cuts-out', 'noisy', 'wont-start', 'controls-unresponsive', 'door-problem', 'trips-electrics', 'wont-light', 'error-code-only'];
const ovCodeFault = (state, errorCodes) => codeFaultFor(state, errorCodes, 'oven-cooker');
const CODE_OWNER = { element: 'oven-not-heating', 'door-lock': 'oven-door' };
const UNSAFE = ['live_electrical_test', 'gas_work', 'open_while_powered', 'bypass_safety_device', 'repeated_reset_after_trip'];
const tripActive = (s) => ((s.safety && s.safety.hazards) || []).some((x) => x.hazard === 'supply_trip' && x.status === 'active');
const fuel = (s) => (s.identity && s.identity.fuel && s.identity.fuel.value) || null;
const HEAT_TRIO = ['oven-not-heating', 'oven-fan-not-working', 'oven-grill-not-working'];

function ovOwner(h, journey) {
  if (!OV_JOURNEYS.includes(journey)) return null;
  if (journey === 'trips-electrics' || tripActive(h.s)) return 'oven-tripping';
  if (journey === 'wont-light' || (journey === 'no-heat' && fuel(h.s) === 'gas')) return 'cooker-ignition-gas';
  if (h.obs('noPower') === true || ['wont-start', 'controls-unresponsive'].includes(journey)) return 'oven-dead-no-power';
  if (journey === 'no-heat') {
    // once the fault is fixed ("it heats now", "the grill works now") the observations change — the heating journey that
    // was running keeps the conversation instead of re-routing on the fixed state (a handoff happens once, never on the fix)
    if (h.s.resolution === 'resolved' || h.obs('faultPersists') === false) {
      const last = [...(h.s.requests || [])].reverse().find((r) => HEAT_TRIO.includes(r.journey));
      if (last) return last.journey;
    }
    if (h.obs('ovenFanTurns') === false && h.obs('mainOvenWorks') !== true) return 'oven-fan-not-working';
    const p = h.s.problems && h.s.problems.find((x) => x.status === 'active');
    const grillScope = p && p.scope && p.scope.value === 'grill_only';
    // a grill report: the grill journey owns it unless the main oven is ALSO cold (then it is not heating overall)
    if ((h.obs('grillWorks') === false || grillScope) && h.obs('mainOvenWorks') !== false) return 'oven-grill-not-working';
    return 'oven-not-heating';
  }
  if (['overheating', 'cuts-out'].includes(journey)) return 'oven-overheating';
  if (journey === 'noisy') return 'oven-fan-not-working';
  if (journey === 'door-problem') return 'oven-door';
  if (journey === 'error-code-only') return CODE_OWNER[h.d && h.d.codeFault] || null;
  return null;
}
const owns = (KEY) => ({
  claims: (h, journey) => ovOwner(h, journey) === KEY,
  ownedElsewhere: (h, journey) => { const o = ovOwner(h, journey); return o != null && o !== KEY; },
});
const OVEN_MODEL_ASK = { say: 'To match the right part for your oven I need its exact model.', ask: 'Could you send me the model number? It\'s usually on a label around the oven door opening or on the back / underside of the door — a photo is fine.' };
const OVEN_APPLIANCE_ASK = { say: '', ask: 'Is it a built-in oven, a freestanding cooker, or a hob?' };

module.exports = { OV_JOURNEYS, ovOwner, owns, ovCodeFault, UNSAFE, CODE_OWNER, fuel, OVEN_MODEL_ASK, OVEN_APPLIANCE_ASK };
