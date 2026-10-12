'use strict';
/**
 * Tumble dryer family — the ONE ownership function for the seven tumble-dryer journeys, plus the dryer technology
 * (vented / condenser / heat pump / unknown) shared by them (PURE). washer-dryer is never this family.
 *
 * Ownership precedence (first match wins; a handoff happens once and never bounces):
 *   1. door / start   : door / wont-start / controls journeys, or a drum-not-turning report where the door is not recognised
 *                       → td-door-not-starting (a container-full warning that stops it starting → td-water-container-drain)
 *   2. water          : a container-full / empty-tank warning on a stops / won't-start report, or any dryer leak → td-water-container-drain
 *   3. heating        : a not-drying report with no heat at all                               → td-not-heating
 *   4. the typed journey (no-heat / not-drying / drum-not-turning / noisy / cuts-out, cycle-not-completing, overheating)
 *   5. error-code-only: only codes that map cleanly (not-heating → heating, not-emptying-condensate → water,
 *                       filter-blocked → drying, door → door, overheating → stops); motor / PCB / sensor / heat-pump /
 *                       low-voltage codes are not owned.
 */
const { codeFaultFor } = require('./j2-diagnostics.js');
const engine = require('./evidence-engine.js');

const TD_JOURNEYS = ['no-heat', 'not-drying', 'drum-not-turning', 'noisy', 'cuts-out', 'cycle-not-completing', 'overheating', 'leaking', 'not-draining',
  'door-problem', 'wont-start', 'controls-unresponsive', 'trips-electrics', 'error-code-only'];
const tdCodeFault = (state, errorCodes) => codeFaultFor(state, errorCodes, 'tumble-dryer');
const CODE_OWNER = { 'not-heating': 'td-not-heating', 'not-emptying-condensate': 'td-water-container-drain', 'filter-blocked': 'td-not-drying',
  door: 'td-door-not-starting', overheating: 'td-stops-mid-cycle' };
const JOURNEY_OWNER = {
  'no-heat': 'td-not-heating', 'not-drying': 'td-not-drying', 'drum-not-turning': 'td-drum-not-turning', noisy: 'td-noisy',
  'cuts-out': 'td-stops-mid-cycle', 'cycle-not-completing': 'td-stops-mid-cycle', overheating: 'td-stops-mid-cycle', leaking: 'td-water-container-drain',
  'not-draining': 'td-water-container-drain', // condensate not reaching the container / drain
  'door-problem': 'td-door-not-starting', 'wont-start': 'td-door-not-starting', 'controls-unresponsive': 'td-door-not-starting',
  // a trip of the house electrics alone (derived journey) → stops / cuts out, so the sticky safety stop applies
  'trips-electrics': 'td-stops-mid-cycle',
};
const STOPS = ['cuts-out', 'cycle-not-completing', 'overheating', 'wont-start', 'door-problem', 'controls-unresponsive'];

function tdOwner(h, journey) {
  if (!TD_JOURNEYS.includes(journey)) return null;
  if (STOPS.includes(journey) && h.obs('tankWarning') === true) return 'td-water-container-drain';
  if (journey === 'drum-not-turning' && h.obs('doorRecognised') === false) return 'td-door-not-starting';
  if (journey === 'not-drying' && heatState(h.s) === 'cold') return 'td-not-heating';
  if (journey === 'error-code-only') return CODE_OWNER[h.d && h.d.codeFault] || null;
  return JOURNEY_OWNER[journey] || null;
}
const owns = (KEY) => ({
  claims: (h, journey) => tdOwner(h, journey) === KEY,
  ownedElsewhere: (h, journey) => { const o = tdOwner(h, journey); return o != null && o !== KEY; },
});

/**
 * Dryer technology: the latest stated type wins (a correction replaces it); otherwise the confirmed model's part list
 * (heat pump / compressor parts → heat-pump; vented heater or vent parts → vented; a water tank / condenser → condenser).
 */
const ARCH_KEYS = [['dryerVented', 'vented'], ['dryerCondenser', 'condenser'], ['dryerHeatPump', 'heat-pump']];
function tdArchitecture(state, ctx = {}) {
  let best = null;
  for (const [k, v] of ARCH_KEYS) {
    if (engine.obsVal(state, k) !== true) continue;
    const t = engine.obsTurnOf(state, k);
    if (!best || t >= best.t) best = { v, t };
  }
  if (best) return { type: best.v, source: 'stated' };
  const titles = Array.isArray(ctx.modelParts) ? ctx.modelParts.map((p) => String((p && p.title) || '')) : [];
  if (titles.some((t) => /heat\s*-?\s*pump|\bcompressor\b/i.test(t))) return { type: 'heat-pump', source: 'model-parts' };
  if (titles.some((t) => /\bvented\b|vent\s+(hose|kit)|exhaust/i.test(t))) return { type: 'vented', source: 'model-parts' };
  if (titles.some((t) => /water\s+(tank|container)|condenser|pump\s+to\s+container|\bfloat\b/i.test(t))) return { type: 'condenser', source: 'model-parts' };
  return { type: 'unknown', source: null };
}
/** Heat state by the LATEST statement (noHeat / heatPresent can both be stated across turns): 'cold' | 'warm' | null. */
function heatState(state) {
  const nh = engine.obsVal(state, 'noHeat'); const hp = engine.obsVal(state, 'heatPresent');
  const tn = nh != null ? engine.obsTurnOf(state, 'noHeat') : -1; const th = hp != null ? engine.obsTurnOf(state, 'heatPresent') : -1;
  if (nh === true && (hp !== true || tn >= th)) return 'cold';
  if (hp === true || nh === false) return 'warm';
  return null;
}
const archFacts = (on, arch) => { on('vented', arch.type === 'vented'); on('condenser', arch.type === 'condenser'); on('heatPump', arch.type === 'heat-pump'); };

// unsafe requests every journey in the family declines (policy P8)
const UNSAFE = ['refrigerant_work', 'bypass_safety_device', 'live_electrical_test', 'open_while_powered', 'repeated_reset_after_trip'];

module.exports = { heatState, UNSAFE, TD_JOURNEYS, tdOwner, owns, tdCodeFault, tdArchitecture, archFacts, CODE_OWNER };
