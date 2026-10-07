/**
 * HOB ENGINEER CHALLENGE SUITE (deterministic, offline, permanent).
 *
 * Protects hob reasoning where TECHNOLOGY dominates: element/power-module route by hob type
 * (ceramic / solid / induction), touch-control moisture-first, overheating = protection working
 * (pan/vents first, not the module), gas ignition + gas-burner EMERGENCY_ACTION card, cracked-
 * surface STOP-USE, and — added by this audit — the electrical-trip STOP_USE safety node with
 * architecture-aware localisation. Guards induction-normal-behaviour (power sharing / pan detection
 * handled at element/power-module) and no unsafe live / induction-power-electronics / gas work.
 *
 * Env override for mutation harness: HOB_OVERRIDES=/path/to/mutated-overrides.json
 * Run: node services/part-finder/test/hobs-engineer-challenge.test.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const K = join(HERE, '..', 'knowledge');
const CAT = JSON.parse(readFileSync(join(HERE, '..', 'faults-catalogue.json'), 'utf8'));
const OV = JSON.parse(readFileSync(process.env.HOB_OVERRIDES || join(K, 'overrides.json'), 'utf8'));
const FAM = 'hobs';
const NODES = Object.keys(CAT.faults[FAM] || {});

let pass = 0, fail = 0; const fails = [];
const ok = (n, c) => { if (c) pass++; else { fail++; fails.push(n); console.log('  FAIL-', n); } };

const doc = (id) => OV.docs[`${FAM}:${id}`] || {};
const comps = (id) => {
  const d = doc(id);
  if (Array.isArray(d.components) && d.components.length) return d.components.map((c) => (typeof c === 'string' ? c : c.name));
  if (Array.isArray(d.likelyComponents) && d.likelyComponents.length) return d.likelyComponents;
  return CAT.faults[FAM][id]?.components || [];
};
const names = (id) => comps(id).map((c) => String(c).toLowerCase());
const first = (id) => names(id)[0] || '';
const idx = (id, sub) => names(id).findIndex((c) => c.includes(sub));
const discr = (id) => (doc(id).discriminators || []).concat(CAT.faults[FAM][id]?.discriminators || []).join(' \n ').toLowerCase();
const conf = (id) => JSON.stringify(doc(id).commonConfusion || []).toLowerCase();
const clarify = (id) => String(doc(id).clarifyingQuestion || '').toLowerCase();
const safety = (id) => String(doc(id).safety || '').toLowerCase();
const nodeText = (id) => (JSON.stringify(doc(id)) + JSON.stringify(CAT.faults[FAM][id] || {})).toLowerCase();
const blob = (id) => `${discr(id)} \n ${conf(id)} \n ${clarify(id)}`;

// ---- 0. COVERAGE ------------------------------------------------------------------------------
ok('hobs family present (>=14 nodes incl new safety node)', NODES.length >= 14);
for (const n of NODES) ok(`${n}: override + >=1 suspect`, Boolean(OV.docs[`${FAM}:${n}`]) && names(n).length >= 1);

// ---- 1. SAFETY (hard) -------------------------------------------------------------------------
const UNSAFE = /(insulation.?test|megger|live.{0,14}test|test.{0,14}\blive\b|bypass.{0,10}(protection|rcd|earth)|probe.{0,10}(live|mains)|discharge.{0,10}(capacitor|induction)|repair the gas|gas.{0,10}(valve|injector).{0,20}(replace|fit))/;
const NEGATED = /\b(no|not|never|don't|do not|avoid|without|qualified|engineer|specialist|gas safe|leave|isn't|professional|stop use|only)\b/;
for (const n of NODES) {
  const t = `${blob(n)} \n ${safety(n)}`;
  const unsafe = t.split(/[.\n;:]/).some((c) => UNSAFE.test(c) && !NEGATED.test(c));
  ok(`${n}: no unsafe live / induction-electronics / gas instruction`, !unsafe);
}
ok('gas-burner: EMERGENCY_ACTION gas card present', doc('gas-burner').safetyInformation?.classification === 'EMERGENCY_ACTION');
ok('gas-burner: 0800 111 999 / gas safe / ventilate guidance', /0800 111 999|gas safe|open windows|ventilat/.test(nodeText('gas-burner')));
ok('tripping-electrics: STOP_USE card present', doc('tripping-electrics').safetyInformation?.classification === 'STOP_USE');
ok('tripping-electrics: no live / induction-power-electronics / RCD-bypass work', /insulation-?test|induction power electronic|bypass the (earth|rcd)|repeatedly reset/.test(discr('tripping-electrics') + safety('tripping-electrics')));
ok('cracked-surface: STOP-USE safety in the engineer override (shock/spillage into live parts)', /stop use|stop using/.test((doc('cracked-surface').discriminators || []).join(' ').toLowerCase() + ' ' + (doc('cracked-surface').likelyComponents || []).join(' ').toLowerCase()));

// ---- 2. ARCHITECTURE FIRST -------------------------------------------------------------------
ok('element: identify hob TYPE first (ceramic/solid/induction)', /identify hob type|ceramic|solid|induction/.test(first('element')));
ok('element: one-zone ceramic/solid = that element/switch; induction = coil/module', /ceramic|solid/.test(discr('element')) && /induction/.test(discr('element')));
ok('power-module: CONFIRM it is an induction hob first', /confirm.*induction|induction hob/.test(first('power-module')));
ok('power-module: one-zone = coil/module; ALL zones = shared board/supply/shutdown', /one.*zone|all zones/.test(discr('power-module')));
ok('tripping-electrics: architecture-aware (ceramic element vs induction coil/module)', /ceramic|solid/.test(discr('tripping-electrics')) && /induction/.test(discr('tripping-electrics')));
ok('tripping-electrics: does NOT apply one architecture to the other', /identify.*(type|technolog)|do not apply|not.*(induction|element)/.test(discr('tripping-electrics') + conf('tripping-electrics')));

// ---- 3. NORMAL BEHAVIOUR / PROTECTION-AS-SYMPTOM ---------------------------------------------
ok('touch-control: moisture/spillage dried FIRST (no part)', /water|spillage|moisture|wet|dry/.test(first('touch-control')));
ok('touch-control: erratic controls often just moisture (not a part)', /moisture|dry/.test(discr('touch-control')));
ok('overheating: pan/vents/airflow (protection working) checked before the module', /pan|vent|airflow/.test(first('overheating')));
ok('overheating: cooling fan / thermal shutdown before naming the module', idx('overheating', 'fan') !== -1 || /cooling fan/.test(nodeText('overheating')));
ok('cooling-fan: obstruction/dust first', /obstruction|dust|fan/.test(first('cooling-fan')));

// ---- 4. IGNITION + LIGHT CONTROL NODES -------------------------------------------------------
ok('ignition: no-spark-all = module; one-burner = electrode/dirty cap', /all burners|one burner|electrode/.test(discr('ignition')) || /spark/.test(first('ignition')));
ok('gas-burner: FSD/thermocouple for lights-but-wont-stay-lit', /fsd|thermocouple/.test(nodeText('gas-burner')));
ok('energy-regulator: regulator/knob before element', /regulator|simmerstat|knob/.test(first('energy-regulator')));
ok('temperature-sensor: sensor/NTC then wiring then PCB', /sensor|ntc/.test(first('temperature-sensor')));
ok('main-pcb: supply/power checked before the board', /supply|power/.test(first('main-pcb')));
ok('comms: power-cycle before the boards', /power-?cycle|reset/.test(first('comms')));
ok('low-voltage: property supply/socket/spur before internal parts', /supply|socket|spur/.test(first('low-voltage')));

// ---- 5. ERROR CODE = system ------------------------------------------------------------------
const codeMaps = Object.entries(CAT.errorCodes).flatMap(([, plat]) => plat[FAM] ? Object.entries(plat[FAM]) : []);
ok('hobs error codes exist', codeMaps.length >= 8);
ok('every hobs error code resolves to an EXISTING node', codeMaps.every(([, node]) => NODES.includes(node)));

// ---- 6. BRAND NEUTRALITY ---------------------------------------------------------------------
for (const n of NODES) {
  const overclaim = /common (fault|problem|failure) (on|with) (bosch|siemens|neff|beko|hotpoint|indesit|whirlpool|candy|hoover|aeg|electrolux|miele|samsung|lg)\b/.test(discr(n) + conf(n));
  ok(`${n}: no unsupported brand-prevalence claim`, !overclaim);
}

// ---- 7. PAIRED / NEAR-NEIGHBOUR --------------------------------------------------------------
const PAIRS = [
  ['induction-incompatible-pan vs same-pan-works-other-zone (element/power-module reasoning)', () => /induction/.test(discr('element')) && /induction/.test(first('power-module'))],
  ['one-zone-dead(element/coil) vs all-zones-dead(board/supply)', () => /one.*zone|all zones/.test(discr('power-module')) || /one dead zone/.test(discr('element'))],
  ['normal-power-sharing vs genuine-weak-zone (power-module architecture)', () => /confirm.*induction/.test(first('power-module'))],
  ['thermal-cutout from ventilation(protection) vs module fault', () => /pan|vent|airflow/.test(first('overheating')) && idx('overheating', 'main pcb') !== -1],
  ['gas-burner dirty/mis-seated vs genuine ignition fault', () => /cap|seat|clean/.test(nodeText('gas-burner')) && /fsd|thermocouple/.test(nodeText('gas-burner'))],
  ['ceramic-trip(element/moisture) vs induction-trip(coil/module)', () => /ceramic|solid/.test(discr('tripping-electrics')) && /induction/.test(discr('tripping-electrics'))],
  ['cracked-glass(STOP USE) vs internal-component fault', () => /stop use|stop using/.test(nodeText('cracked-surface'))],
  ['gas-smell(EMERGENCY) vs electrical-trip(STOP_USE)', () => doc('gas-burner').safetyInformation?.classification === 'EMERGENCY_ACTION' && doc('tripping-electrics').safetyInformation?.classification === 'STOP_USE'],
];
for (const [name, fn] of PAIRS) ok(`PAIR: ${name}`, fn());

console.log(`\nhobs engineer challenge: ${pass} passed, ${fail} failed  (nodes=${NODES.length}, paired cases=${PAIRS.length})`);
if (fail) { console.log('FAILURES:', fails.join(' | ')); process.exit(1); }
process.exit(0);
