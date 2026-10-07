/**
 * FRIDGE-FREEZER ENGINEER CHALLENGE SUITE (deterministic, offline, permanent).
 *
 * Protects the engineering reasoning across ALL fridge-freezer nodes: the airflow/defrost system,
 * the compressor start-relay-first discipline, the noisy fan-vs-ice distinction, blocked-drain-first
 * for internal water, over-diagnosed-thermostat guard, normal-behaviour (transport-on-side, gurgles),
 * error-code=system, and — added by this audit — the electrical-trip STOP_USE safety node.
 * Key traps guarded: not-cooling != compressor; warm-fridge/cold-freezer = AIRFLOW; frost != auto
 * defrost-heater; noisy != fan motor; running-constantly != compressor; tripping != re-gas; and no
 * unsafe live-electrical / sealed-refrigeration guidance.
 *
 * Env override for mutation harness: FFE_OVERRIDES=/path/to/mutated-overrides.json
 * Run: node services/part-finder/test/fridge-freezer-engineer-challenge.test.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const K = join(HERE, '..', 'knowledge');
const CAT = JSON.parse(readFileSync(join(HERE, '..', 'faults-catalogue.json'), 'utf8'));
const OV = JSON.parse(readFileSync(process.env.FFE_OVERRIDES || join(K, 'overrides.json'), 'utf8'));
const FAM = 'fridge-freezer';
const NODES = Object.keys(CAT.faults[FAM] || {});

let pass = 0, fail = 0; const fails = [];
const ok = (n, c) => { if (c) pass++; else { fail++; fails.push(n); console.log('  FAIL-', n); } };

const doc = (id) => OV.docs[`${FAM}:${id}`] || {};
const comps = (id) => {
  const d = doc(id);
  if (Array.isArray(d.components) && d.components.length) return d.components.map((c) => (typeof c === 'string' ? c : c.name));
  if (Array.isArray(d.likelyComponents) && d.likelyComponents.length) return d.likelyComponents;
  return CAT.faults[FAM][id]?.components || []; // catalogue fallback for nodes with no override component list
};
const names = (id) => comps(id).map((c) => String(c).toLowerCase());
const first = (id) => names(id)[0] || '';
const idx = (id, sub) => names(id).findIndex((c) => c.includes(sub));
// index of a suspect that INCLUDES `sub` but NONE of `excl` (e.g. bare "compressor", not "compressor relay")
const bareIdx = (id, sub, ...excl) => names(id).findIndex((c) => c.includes(sub) && !excl.some((e) => c.includes(e)));
const before = (id, a, b) => { const x = idx(id, a), y = idx(id, b); return x !== -1 && y !== -1 && x < y; };
const discr = (id) => (doc(id).discriminators || []).concat(CAT.faults[FAM][id]?.discriminators || []).join(' \n ').toLowerCase();
const conf = (id) => JSON.stringify(doc(id).commonConfusion || []).toLowerCase();
const clarify = (id) => String(doc(id).clarifyingQuestion || '').toLowerCase();
const safety = (id) => String(doc(id).safety || '').toLowerCase();
const nodeText = (id) => (JSON.stringify(doc(id)) + JSON.stringify(CAT.faults[FAM][id] || {})).toLowerCase();
const blob = (id) => `${discr(id)} \n ${conf(id)} \n ${clarify(id)}`;

// ---- 0. COVERAGE ------------------------------------------------------------------------------
ok('fridge-freezer family present (>=20 nodes incl new safety node)', NODES.length >= 20);
for (const n of NODES) ok(`${n}: override + >=1 suspect`, Boolean(OV.docs[`${FAM}:${n}`]) && names(n).length >= 1);

// ---- 1. SAFETY (hard) -------------------------------------------------------------------------
const UNSAFE = /(insulation.?test|megger|live.{0,14}test|test.{0,14}\blive\b|bypass.{0,10}(interlock|protection|rcd|earth)|probe.{0,10}(live|mains)|recharge.{0,10}refrigerant|\bregas\b|re-?gas the|open the sealed|compressor terminal)/;
const NEGATED = /\b(no|not|never|don't|do not|avoid|without|qualified|engineer|specialist|leave|isn't|professional|stop use|only)\b/;
for (const n of NODES) {
  const t = `${blob(n)} \n ${safety(n)}`;
  const unsafe = t.split(/[.\n;:]/).some((c) => UNSAFE.test(c) && !NEGATED.test(c));
  ok(`${n}: no unsafe live-electrical / refrigerant instruction`, !unsafe);
}
ok('tripping-electrics: STOP_USE safety card present', doc('tripping-electrics').safetyInformation?.classification === 'STOP_USE');
ok('tripping-electrics: names burning/scorching + stop-and-unplug', /burning|scorch/.test(nodeText('tripping-electrics')) && /unplug|stop using|isolate|switch it off/.test(nodeText('tripping-electrics')));
ok('tripping-electrics: no sealed-system / live / RCD-bypass instruction to customer', /insulation-?test|open the sealed|bypass the earth|bypass the rcd|compressor terminal/.test(discr('tripping-electrics') + safety('tripping-electrics')));

// ---- 2. NOT-COOLING — airflow/defrost first, compressor NOT the lead --------------------------
ok('not-cooling: compressor is NOT the first suspect', !/compressor/.test(first('not-cooling')));
ok('not-cooling: defrost/fan/airflow leads', /defrost|fan|airflow/.test(first('not-cooling')));
ok('not-cooling: WARM-FRIDGE/COLD-FREEZER = AIRFLOW (not compressor/gas)', /warm fridge.*cold freezer|warm.*freezer.*cold|airflow/.test(discr('not-cooling')) && /airflow/.test(discr('not-cooling')));
ok('not-cooling: does NOT auto-blame compressor or re-gas', /not the (thermostat|compressor)|not a low gas|airflow failure/.test(discr('not-cooling')));
ok('not-cooling: compressor ranked below defrost/fan', before('not-cooling', 'defrost', 'compressor') || before('not-cooling', 'fan', 'compressor'));
ok('not-cooling: transport-on-side NORMAL-behaviour guard', /transport|laid flat|on its side|stood upright|just delivered|just moved/.test(discr('not-cooling')));
ok('not-cooling: running-constantly => condenser coils / door seal (not thermostat)', /run.{0,12}constant|constantly/.test(discr('not-cooling')) && /coil|seal/.test(discr('not-cooling')));

// ---- 3. DEFROST + EVAP FAN + FROST -----------------------------------------------------------
ok('defrost-system: three defrost parts (heater/thermostat/timer)', idx('defrost-system', 'heater') !== -1 && idx('defrost-system', 'thermostat') !== -1 && idx('defrost-system', 'timer') !== -1);
ok('defrost-system: "defrosted it and it worked" is NOT the repair', /ice up again|will ice up|not.*the repair|temporarily/.test(discr('defrost-system')));
ok('evaporator-fan: noisy/fouling-ice vs silent-motor distinction', /ice/.test(discr('evaporator-fan')) && /(seiz|silent|dead|clear)/.test(discr('evaporator-fan')));
ok('evaporator-fan: fan fouling ice points back to DEFROST (not auto fan-motor)', /defrost/.test(discr('evaporator-fan')));

// ---- 4. COMPRESSOR — start relay first -------------------------------------------------------
ok('compressor: START RELAY / overload checked before the compressor', (() => { const r = idx('compressor', 'relay'), o = idx('compressor', 'overload'), c = bareIdx('compressor', 'compressor', 'relay', 'overload'); const start = (r === -1 ? Infinity : r); const startO = (o === -1 ? Infinity : o); return c !== -1 && Math.min(start, startO) < c; })());
ok('compressor: clicking/humming => relay first, compressor only if relay sound + seized', /relay/.test(discr('compressor')) && /(seiz|windings|mechanical)/.test(discr('compressor')));
ok('compressor: does not jump to a new compressor on a click alone', /click/.test(discr('compressor')) && /relay/.test(discr('compressor')));

// ---- 5. DRAINAGE / WATER INSIDE --------------------------------------------------------------
ok('drainage-blocked: blocked DEFROST DRAIN leads (clean, not a part)', /drain/.test(first('drainage-blocked')) && /clear|clean|drain hole|drain/.test(discr('drainage-blocked')));
ok('drainage-blocked: clean/level/seal fix, not a costly part', /clean|level|seal/.test(discr('drainage-blocked')) && /not a (costly )?part|clear the drain/.test(discr('drainage-blocked')));

// ---- 6. NOISE + NORMAL BEHAVIOUR -------------------------------------------------------------
ok('noisy: split by CHARACTER (fan-ice vs compressor vs pipework rattle)', /fan/.test(discr('noisy')) && /compressor/.test(discr('noisy')) && /(rattle|pipe|vibrat)/.test(discr('noisy')));
ok('noisy: general rattle/vibration is a FREE fix (level/pipes/tray), not a part', /free fix|level|not a part|dampens?/.test(discr('noisy')));
ok('noisy: fan-hitting-ice verified by opening the freezer door (door switch)', /door/.test(discr('noisy')) && /stops?/.test(discr('noisy')));

// ---- 7. THERMOSTAT over-diagnosis + DAMPER ---------------------------------------------------
ok('thermostat: over-diagnosed — rule out defrost/relay/damper/coils/seal first', /over-?diagnos|rule out|before blaming/.test(discr('thermostat')) && /(defrost|relay|damper|coil|seal)/.test(discr('thermostat')));
ok('air-damper: one-compartment-wrong-temp => damper', /one compartment|fresh-food warm|one side/.test(discr('air-damper') + nodeText('air-damper')) && /damper/.test(nodeText('air-damper')));

// ---- 8. LIGHT NODES lead with a CHECK/condition, not an internal part -------------------------
ok('condenser-fan: dust/blockage cleaned first', /dust|blockage|clean/.test(first('condenser-fan')));
ok('over-cooling: setting/dial checked first', /setting|dial/.test(first('over-cooling')));
ok('alarm: door-open / genuinely-warm checked before a part', /door/.test(first('alarm')) || /genuinely warm|actual.*temperature/.test(nodeText('alarm')));
ok('door-seal: check the seal (paper test) before a part', /seal/.test(first('door-seal')) || /paper|check it seals/.test(nodeText('door-seal')));
ok('water-inlet-valve: supply/filter/hose before the valve', /supply|filter|hose|pressure/.test(first('water-inlet-valve')));
ok('ice-maker: supply/fill path before the module', /supply|filter|fill/.test(first('ice-maker')));
ok('control-pcb: supply/power checked before the board', /supply|power/.test(first('control-pcb')));
ok('lighting: bulb/LED before the board', /bulb|led/.test(first('lighting')));
ok('comms: power-cycle before the boards', /power-?cycle|reset/.test(first('comms')));
ok('low-voltage: property supply/socket before internal parts', /supply|socket|plug/.test(first('low-voltage')));
ok('temperature-sensor: sensor/thermistor then wiring then PCB', /sensor|thermistor/.test(first('temperature-sensor')));

// ---- 9. ERROR CODE = a detected SYSTEM/CONDITION (existing node) ------------------------------
const codeMaps = Object.entries(CAT.errorCodes).flatMap(([, plat]) => plat[FAM] ? Object.entries(plat[FAM]) : []);
ok('fridge-freezer error codes exist across brands', codeMaps.length >= 40);
ok('every fridge-freezer error code resolves to an EXISTING node', codeMaps.every(([, node]) => NODES.includes(node)));

// ---- 10. BRAND NEUTRALITY --------------------------------------------------------------------
for (const n of NODES) {
  const overclaim = /common (fault|problem|failure) (on|with) (bosch|siemens|neff|beko|hotpoint|indesit|whirlpool|candy|hoover|aeg|electrolux|miele|samsung|lg)\b/.test(discr(n) + conf(n));
  ok(`${n}: no unsupported brand-prevalence claim`, !overclaim);
}

// ---- 11. PAIRED / NEAR-NEIGHBOUR -------------------------------------------------------------
const PAIRS = [
  ['fridge-warm/freezer-cold(airflow) vs both-warm(compressor/system)', () => /airflow/.test(discr('not-cooling')) && idx('not-cooling', 'compressor') !== -1],
  ['fan-noisy/hitting-ice(defrost) vs fan-silent(motor)', () => /ice/.test(discr('evaporator-fan')) && /(silent|dead|seiz)/.test(discr('evaporator-fan'))],
  ['heavy-frost(defrost) vs normal-frost/behaviour', () => /ice|frost/.test(discr('defrost-system')) && /transport|just delivered|stood/.test(discr('not-cooling'))],
  ['running-constantly+large-load(condition) vs +poor-cooling(coils/seal)', () => /coil|seal/.test(discr('not-cooling')) && /constant/.test(discr('not-cooling'))],
  ['normal-gurgle/click(no fault) vs abnormal-fan-grinding', () => /(rattle|vibrat|pipe)/.test(discr('noisy')) && /fan/.test(discr('noisy'))],
  ['clicking-compressor(relay first) vs seized(compressor)', () => idx('compressor', 'relay') < bareIdx('compressor', 'compressor', 'relay', 'overload') && /(seiz|windings)/.test(discr('compressor'))],
  ['tripping(electrical STOP_USE) vs not-cooling(diagnostic)', () => doc('tripping-electrics').safetyInformation?.classification === 'STOP_USE' && !/compressor/.test(first('not-cooling'))],
];
for (const [name, fn] of PAIRS) ok(`PAIR: ${name}`, fn());

console.log(`\nfridge-freezer engineer challenge: ${pass} passed, ${fail} failed  (nodes=${NODES.length}, paired cases=${PAIRS.length})`);
if (fail) { console.log('FAILURES:', fails.join(' | ')); process.exit(1); }
process.exit(0);
