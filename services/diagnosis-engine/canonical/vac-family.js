'use strict';
/**
 * Vacuum family — the ONE ownership function for the six vacuum journeys, plus the vacuum type
 * (corded / cordless / robot / unknown) shared by them (PURE).
 *
 * Ownership precedence (first match wins; a handoff happens once):
 *   1. battery     : a battery / charging report, a cut-out with short-runtime or won't-charge evidence, or a cordless
 *                    won't-start that won't charge (never a corded vacuum: its cut-out is airflow) → vacuum-battery-runtime
 *   2. not running : won't start / dead                                                       → vacuum-not-running
 *   3. brush       : the brush bar / roller doesn't spin                                      → vacuum-brush-not-turning
 *   4. pulsing     : pulsing / surging / revving, or a cut-out with NO battery evidence      → vacuum-pulsing-cutting-out
 *                    (Dyson pulsing is the airflow-restriction protection first; battery only with runtime / charge evidence)
 *   5. suction     : weak / lost suction                                                      → vacuum-low-suction
 *   6. noisy       : a noise / whistle                                                        → vacuum-noisy
 * Vacuums have no fault-code tables: model-range tokens (V6, V11, DC35) are identity, never codes (mc1 adapter).
 */
const engine = require('./evidence-engine.js');

// trips-electrics: a trip / blown fuse alone (derived journey) → not-running, where the sticky safety stop applies
const VAC_JOURNEYS = ['lost-suction', 'pulsing', 'cuts-out', 'wont-start', 'battery-problem', 'brush-bar-not-spinning', 'noisy', 'trips-electrics'];
const UNSAFE = ['live_electrical_test', 'open_while_powered', 'bypass_safety_device'];

/** Vacuum type: the latest stated type wins; else the model range (Dyson V / SV / cordless DC ranges, robot words). */
const TYPE_KEYS = [['vacuumCordless', 'cordless'], ['vacuumCorded', 'corded'], ['vacuumRobot', 'robot']];
const CORDLESS_MODEL = /^(V\d{1,2}|SV\d{1,2}|DC(3[05]|4[345]|5[89]|6[12]|7[24]))\b/i;
const ROBOT_MODEL = /robot|roomba|\brvc\b|360\s*(eye|heurist|vis)|deebot|roborock/i;
function vacType(state) {
  let best = null;
  for (const [k, v] of TYPE_KEYS) {
    if (engine.obsVal(state, k) !== true) continue;
    const t = engine.obsTurnOf(state, k);
    if (!best || t >= best.t) best = { v, t };
  }
  if (best) return { type: best.v, source: 'stated' };
  const m = state && state.identity && state.identity.model && state.identity.model.value ? String(state.identity.model.value).replace(/\s+/g, '') : '';
  if (m && ROBOT_MODEL.test(m)) return { type: 'robot', source: 'model' };
  if (m && CORDLESS_MODEL.test(m)) return { type: 'cordless', source: 'model' };
  return { type: 'unknown', source: null };
}
const typeFacts = (on, vt) => { on('cordless', vt.type === 'cordless'); on('corded', vt.type === 'corded'); on('robot', vt.type === 'robot'); };
// A corded vacuum has no battery: a short run before it cuts out is the thermal cut-out (airflow), never battery evidence.
const batteryEvidence = (h) => vacType(h.s).type !== 'corded' && (h.obs('shortRuntime') === true || h.obs('wontCharge') === true);

function vacOwner(h, journey) {
  if (!VAC_JOURNEYS.includes(journey)) return null;
  const vt = vacType(h.s).type;
  if (journey === 'battery-problem') return vt === 'corded' ? 'vacuum-pulsing-cutting-out' : 'vacuum-battery-runtime';
  if (journey === 'cuts-out' && batteryEvidence(h)) return 'vacuum-battery-runtime';
  if (journey === 'wont-start') return vt !== 'corded' && h.obs('wontCharge') === true ? 'vacuum-battery-runtime' : 'vacuum-not-running';
  if (journey === 'trips-electrics') return 'vacuum-not-running';
  if (journey === 'brush-bar-not-spinning') return 'vacuum-brush-not-turning';
  if (journey === 'pulsing' || journey === 'cuts-out') return 'vacuum-pulsing-cutting-out';
  if (journey === 'lost-suction') return 'vacuum-low-suction';
  if (journey === 'noisy') return 'vacuum-noisy';
  return null;
}
const owns = (KEY) => ({
  claims: (h, journey) => vacOwner(h, journey) === KEY,
  ownedElsewhere: (h, journey) => { const o = vacOwner(h, journey); return o != null && o !== KEY; },
});
const vacCodeFault = () => null; // no vacuum fault-code tables

const VAC_MODEL_ASK = { say: 'To match the right part for your vacuum I need its exact model.', ask: 'Could you send me the model? It\'s on the label on the main body or under the bin (for a Dyson the label also shows a serial number) — a photo is fine.' };
const VAC_APPLIANCE_ASK = { say: '', ask: 'Is it a vacuum cleaner — corded, cordless or a robot?' };

// Shared part matching (identity + compatibility + evidence: these only run once the gate's evidence is met).
const PART_MATCH = {
  // never an obsolete part with no alternative, a kit / bundle, or bags
  'vacuum-filter': { re: /\bfilter\b/i, not: /hose|brush|battery|charger|motor|belt|head|wand|dust\s*bags?|\bbags?\b|\bkit\b|no alternative/i },
  'vacuum-hose': { re: /\bhose\b/i, not: /filter|brush|battery|charger|clip|cuff|belt|head|valve|\bkit\b|no alternative/i },
  'vacuum-brush-bar': { re: /brush\s*-?\s*bar|brushbar|brush\s*roll(er)?\b/i, not: /belt|motor|hose|battery|filter|head\s+assembly|cleaner\s+head|end\s*cap|clutch|no alternative/i },
  'vacuum-belt': { re: /\bbelt\b/i, not: /brush\s*bar|motor|hose|filter|no alternative/i },
  'vacuum-battery': { re: /\bbattery\b/i, not: /charger|cover|clip|door|filter|hose|main body|motor|no alternative/i },
  'vacuum-charger': { re: /charger|power\s+(supply|adaptor|adapter)|charging\s+(lead|cable)/i, not: /battery\s+pack|filter|hose|no alternative/i },
};

module.exports = { VAC_JOURNEYS, vacOwner, owns, vacType, typeFacts, batteryEvidence, vacCodeFault, UNSAFE, VAC_MODEL_ASK, VAC_APPLIANCE_ASK, PART_MATCH };
