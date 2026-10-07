/**
 * TUMBLE-DRYER ENGINEER CHALLENGE SUITE (deterministic, offline, permanent).
 *
 * Tests ENGINEERING SEMANTICS across ALL tumble-dryer nodes: dryer-TECHNOLOGY awareness
 * (vented / condenser / heat-pump), the drying priors (not-drying != heater; hot-but-wet / slow =>
 * airflow; heat-pump normal-behaviour boundary; heat-pump has NO conventional element), the
 * thermal-cutout-is-an-effect-of-airflow trap, water-collection causal path, drum-drive
 * (belt/pulley/capacitor before motor), moisture-sensor discipline, error-code!=component, and
 * absolute electrical/fire safety. Operates on canonical source; regressions/unsafe edits flip RED.
 * Deployed reply quality is verified by the production E2E.
 *
 * Run: node services/part-finder/test/tumble-dryer-engineer-challenge.test.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const K = join(HERE, '..', 'knowledge');
const CAT = JSON.parse(readFileSync(join(HERE, '..', 'faults-catalogue.json'), 'utf8'));
const OV = JSON.parse(readFileSync(process.env.TDE_OVERRIDES || join(K, 'overrides.json'), 'utf8'));
const TD = CAT.faults['tumble-dryer'] || {};
const WD = CAT.faults['washer-dryer'] || {};
const NODES = Object.keys(TD);

let pass = 0, fail = 0; const fails = [];
const ok = (n, c) => { if (c) pass++; else { fail++; fails.push(n); console.log('  FAIL-', n); } };

const doc = (fam, id) => OV.docs[`${fam}:${id}`] || {};
const names = (fam, id) => {
  const d = doc(fam, id);
  if (Array.isArray(d.components) && d.components.length) return d.components.map((c) => (typeof c === 'string' ? c : c.name).toLowerCase());
  return (d.likelyComponents || []).map((s) => String(s).toLowerCase());
};
const td = (id) => names('tumble-dryer', id);
const first = (id) => td(id)[0] || '';
const idx = (id, sub) => td(id).findIndex((c) => c.includes(sub));
const before = (id, a, b) => { const x = idx(id, a), y = idx(id, b); return x !== -1 && y !== -1 && x < y; };
const discr = (id) => (doc('tumble-dryer', id).discriminators || []).join(' \n ').toLowerCase();
const conf = (id) => JSON.stringify(doc('tumble-dryer', id).commonConfusion || []).toLowerCase();
const advice = (id) => (doc('tumble-dryer', id).adviceBeforeReplacement || []).join(' \n ').toLowerCase();
const clarify = (id) => String(doc('tumble-dryer', id).clarifyingQuestion || '').toLowerCase();
const blob = (id) => `${discr(id)} \n ${conf(id)} \n ${advice(id)} \n ${clarify(id)}`;

// ---- 0. COVERAGE: every TD node reviewed + has ordered suspects ------------------------------
ok('tumble-dryer family present', NODES.length >= 12);
for (const n of NODES) ok(`${n}: override + ordered suspects`, Boolean(OV.docs[`tumble-dryer:${n}`]) && td(n).length >= 1);

// ---- 1. SAFETY (hard) — no unsafe live-electrical/refrigeration instruction -------------------
const UNSAFE = /(insulation.?test|megger|live.{0,14}test|test.{0,14}\blive\b|bypass.{0,10}(interlock|protection|rcd)|discharge.{0,10}(capacitor|cap\b)|probe.{0,10}(live|mains)|recharge.{0,10}refrigerant|regas)/;
const NEGATED = /\b(no|not|never|don't|do not|avoid|without|qualified|engineer|specialist|leave|isn't|professional|stop use)\b/;
for (const n of NODES) {
  const t = `${advice(n)} \n ${discr(n)} \n ${String(doc('tumble-dryer', n).safety || '').toLowerCase()}`;
  const unsafeInstruction = t.split(/[.\n;:]/).some((c) => UNSAFE.test(c) && !NEGATED.test(c));
  ok(`${n}: no unsafe live-electrical / refrigeration instruction`, !unsafeInstruction);
}
ok('tripping-electrics: STOP_USE safety card present', doc('tumble-dryer', 'tripping-electrics').safetyInformation?.classification === 'STOP_USE');
ok('overheating: fire-risk safety card present', Boolean(doc('tumble-dryer', 'overheating').safetyInformation) || /fire risk|stop us/.test(discr('overheating') + advice('overheating')));
ok('filter-blocked: fire-risk safety card present', Boolean(doc('tumble-dryer', 'filter-blocked').safetyInformation));

// ---- 2. DRYER TECHNOLOGY AWARENESS -----------------------------------------------------------
ok('not-heating: heat-pump has NO conventional element (do not recommend element/TOC)', /heat-?pump/.test(discr('not-heating')) && /no conventional|no .*element|refrigerant/.test(discr('not-heating')));
ok('not-heating: establishes vented/condenser/heat-pump before a heater part', /vented.*condenser.*heat-?pump|heat-?pump.*dryer|establish/.test(discr('not-heating') + clarify('not-heating')));
ok('not-heating: airflow/filter LEADS before the heater element', /filter|airflow|lint/.test(first('not-heating')));
ok('not-heating: filter check precedes the heater element', before('not-heating', 'filter', 'heater') || before('not-heating', 'lint', 'heater') || before('not-heating', 'airflow', 'heater'));
ok('poor-drying: check-first (filter/condenser/vent/fan/load/spin) before heater', /filter|condenser|vent|airflow|lint/.test(first('poor-drying')));
ok('poor-drying: heat-pump longer cycle can be NORMAL', /heat-?pump/.test(discr('poor-drying')) && /normal|longer/.test(discr('poor-drying')));
ok('heat-pump node: NORMAL-BEHAVIOUR boundary (lower temp/longer = not a fault)', /normal/.test(discr('heat-pump')) && /(lower|warm|longer|cooler)/.test(discr('heat-pump')));
ok('heat-pump node: refrigerant circuit is last resort, clean filters first', /filter/.test(first('heat-pump')) && /last resort|specialist|refriger/.test(discr('heat-pump')));
ok('heat-pump node: never recommend a conventional heater element', /no conventional|never recommend a .*heater|no .*heating element/.test(discr('heat-pump')));

// ---- 3. THERMAL-CUTOUT / OVERHEATING root-cause trap -----------------------------------------
ok('overheating: airflow leads, TOC is the EFFECT not the root cause', /airflow|filter|fan|air path/.test(first('overheating')) && /effect|root cause|trip again|airflow/.test(discr('overheating')));
ok('overheating: "changed the TOC and it went again" => airflow/fan', /changed the (thermal|toc)|again/.test(discr('overheating')));
ok('not-heating: TOC/thermostat considered after airflow, with element (fails open, not earth)', /open/.test(discr('not-heating')) && /oven|earth/.test(discr('not-heating')));

// ---- 4. WATER COLLECTION (condenser/heat-pump) -----------------------------------------------
ok('not-emptying-condensate: causal water path (sump->pump->container), not pump-first', /path|sump|container/.test(first('not-emptying-condensate')));
ok('not-emptying-condensate: container warning != pump proven', /warning/.test(discr('not-emptying-condensate')) && /(not.*prove|does not.*pump|seated|float|blockage)/.test(discr('not-emptying-condensate')));

// ---- 5. DRUM DRIVE + NOISE -------------------------------------------------------------------
ok('motor: belt leads (not the motor) for drum-not-turning', /belt/.test(first('motor')));
ok('motor: belt/pulley/capacitor before the drive motor', before('motor', 'belt', 'motor') && idx('motor', 'capacitor') !== -1);
ok('motor: motor-hums => capacitor, motor-runs-drum-still => belt (discriminator)', /capacitor/.test(discr('motor')) && /belt/.test(discr('motor')));
ok('motor: seized bearing is RARE (not the default)', /rare|not.*default|do not make.*bearing/.test(discr('motor')));
ok('noisy: routed by character; bearings not the automatic default', /(pulley|belt|roller|fan|bearing)/.test(first('noisy')));

// ---- 6. MOISTURE SENSOR discipline -----------------------------------------------------------
ok('sensor: programme/load + wipe contacts before the sensor', /programme|load|wipe|contact/.test(first('sensor')));
ok('sensor: ends-early != sensor; never-ends usually genuinely wet (heat/airflow first)', /ends? too early|early/.test(discr('sensor')) && /never ends|genuinely (still )?wet|heat|airflow/.test(discr('sensor')));
ok('sensor: PCB is last', idx('sensor', 'pcb') === td('sensor').length - 1 || /pcb last/.test(discr('sensor')));

// ---- 7. FILTER / FAN / AIRFLOW ---------------------------------------------------------------
ok('filter-blocked: all customer-accessible airflow checks (filter/condenser/vent)', td('filter-blocked').every((c) => /filter|condenser|vent|lint|heat exchanger|clean|clear/.test(c)));
ok('fan: check fan spins/clear before replacing the fan/motor', /spin|clear|check/.test(first('fan')));

// ---- 8. DOOR + CONTROL + ERROR-CODE ----------------------------------------------------------
ok('door: mechanical catch vs electrical interlock distinguished', idx('door', 'catch') !== -1 && idx('door', 'interlock') !== -1);
ok('main-pcb: rule out direct causes before the board', /rule out|direct causes/.test(first('main-pcb')));

// ---- 9. TRIPPING — phase + technology + safety -----------------------------------------------
ok('tripping-electrics: conventional heater-to-earth vs heat-pump compressor by PHASE', /heat-?pump/.test(discr('tripping-electrics')) && /compressor/.test(discr('tripping-electrics')) && /heating stage|once it reaches/.test(discr('tripping-electrics')));
ok('tripping-electrics: heat-pump has no conventional element (no heater part for HP)', /no conventional element|do not recommend a conventional heater/.test(discr('tripping-electrics')));

// ---- 10. WD <-> TD CONSISTENCY (drying principle shared, technology extends it) --------------
const wdDisc = (id) => (doc('washer-dryer', id).discriminators || []).join(' ').toLowerCase();
ok('CONSISTENCY: both WD & TD lead airflow before the drying heater', /airflow|lint|filter/.test(first('not-heating')) && /airflow|lint|filter|spin/.test(wdDisc('drying-heater')));
ok('CONSISTENCY: both treat hot-but-wet / poor-dry as airflow/condition not auto-heater', /airflow|filter|condenser/.test(discr('poor-drying')) && /airflow|condens|spin|load/.test(wdDisc('drying-heater')));
ok('TD-SPECIFIC: heat-pump refrigeration engineering has no WD-baseline equivalent', /refriger|compressor|evaporator/.test(discr('heat-pump')));

// ---- 11. PAIRED / NEAR-NEIGHBOUR -------------------------------------------------------------
const PAIRS = [
  ['no-heat vs hot-but-wet', () => /open|element/.test(discr('not-heating')) && /airflow|filter|condenser/.test(discr('poor-drying'))],
  ['no-heat conventional vs heat-pump low-temp NORMAL', () => /no conventional|refrigerant/.test(discr('not-heating')) && /normal/.test(discr('heat-pump'))],
  ['slow-dry dirty-filter vs clean-airflow', () => /filter|condenser|vent/.test(first('poor-drying'))],
  ['vented restricted-vent vs condenser blocked-condenser', () => /vent/.test(discr('not-heating') + discr('poor-drying') + JSON.stringify(td('filter-blocked'))) && /condenser/.test(JSON.stringify(td('filter-blocked')))],
  ['tank-full vs tank-empty-warning-on', () => /warning/.test(discr('not-emptying-condensate')) && /seated|float|empty|blockage/.test(discr('not-emptying-condensate'))],
  ['motor-hums(capacitor) vs motor-runs(belt)', () => /capacitor/.test(discr('motor')) && /belt/.test(discr('motor'))],
  ['stops-early(load/programme) vs runs-forever(wet/airflow)', () => /early/.test(discr('sensor')) && /never ends|genuinely/.test(discr('sensor'))],
  ['trips-immediately(wiring) vs trips-on-heat(element)/on-compressor(HP)', () => /instant|switch on/.test(discr('tripping-electrics')) && /heating stage|compressor/.test(discr('tripping-electrics'))],
  ['thermal-cutout-open vs root airflow restriction', () => /effect|root cause|again/.test(discr('overheating'))],
];
for (const [name, fn] of PAIRS) ok(`PAIR: ${name}`, fn());

console.log(`\ntumble-dryer engineer challenge: ${pass} passed, ${fail} failed  (nodes=${NODES.length}, paired cases=${PAIRS.length})`);
if (fail) { console.log('FAILURES:', fails.join(' | ')); process.exit(1); }
process.exit(0);
