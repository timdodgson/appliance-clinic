/**
 * WASHING-MACHINE ENGINEER CHALLENGE SUITE (deterministic, offline, permanent).
 *
 * Tests ENGINEERING SEMANTICS of the washing-machine knowledge (priors, suspect ordering, ranking-
 * flip evidence, guarded LLM-confusions, safe-first checks, error-code!=component, HV/electrical
 * safety) across ALL 30 nodes — not LLM prose. Operates on canonical source (faults-catalogue.json +
 * overrides.json). Any knowledge regression or unsafe edit flips it RED. Deployed reply quality is
 * verified separately by the production E2E.
 *
 * Run: node services/part-finder/test/washing-machine-engineer-challenge.test.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const K = join(HERE, '..', 'knowledge');
const CAT = JSON.parse(readFileSync(join(HERE, '..', 'faults-catalogue.json'), 'utf8'));
const OV = JSON.parse(readFileSync(process.env.WME_OVERRIDES || join(K, 'overrides.json'), 'utf8'));
const WM = CAT.faults['washing-machine'] || {};
const NODES = Object.keys(WM);

let pass = 0, fail = 0; const fails = [];
const ok = (n, c) => { if (c) pass++; else { fail++; fails.push(n); console.log('  FAIL-', n); } };

const doc = (id) => OV.docs[`washing-machine:${id}`] || {};
// ordered finding/suspect names: structured components[].name if present, else legacy likelyComponents
const names = (id) => {
  const d = doc(id);
  if (Array.isArray(d.components) && d.components.length) return d.components.map((c) => (typeof c === 'string' ? c : c.name).toLowerCase());
  return (d.likelyComponents || []).map((s) => String(s).toLowerCase());
};
const first = (id) => names(id)[0] || '';
const idx = (id, sub) => names(id).findIndex((c) => c.includes(sub));
const before = (id, a, b) => { const x = idx(id, a), y = idx(id, b); return x !== -1 && y !== -1 && x < y; };
const discr = (id) => (doc(id).discriminators || []).join(' \n ').toLowerCase();
const conf = (id) => JSON.stringify(doc(id).commonConfusion || []).toLowerCase();
const advice = (id) => (doc(id).adviceBeforeReplacement || []).join(' \n ').toLowerCase();
const secondary = (id) => String(doc(id).secondaryQuestion || '').toLowerCase();
const syn = (id) => [...(WM[id]?.synonyms || []), ...(doc(id).symptoms || [])].join(' ').toLowerCase();
const allText = (id) => `${JSON.stringify(doc(id))}`.toLowerCase();

// ---- 0. COVERAGE: every one of the 30 nodes reviewed + has an override ----------------------
ok('exactly 30 washing-machine nodes', NODES.length === 30);
for (const n of NODES) {
  ok(`${n}: has an override + ordered suspects`, Boolean(OV.docs[`washing-machine:${n}`]) && names(n).length >= 1);
}

// ---- 1. GLOBAL SAFETY (hard): no node instructs the customer to live-test / bypass / dismantle
const UNSAFE = /(insulation.test|megger|live.{0,14}test|test.{0,14}live|bypass.{0,10}(interlock|protection)|discharge.{0,10}(capacitor|cap\b)|probe.{0,10}(live|mains))/;
const NEGATED = /\b(no|not|never|don't|do not|avoid|without|qualified|engineer|leave|isn't|professional)\b/;
for (const n of NODES) {
  const t = `${advice(n)} \n ${discr(n)} \n ${String(doc(n).safety || '').toLowerCase()}`;
  // Split into clauses; flag ONLY an unsafe pattern that appears as a positive INSTRUCTION (its
  // clause carries no negation). A prohibition like "no live electrical testing" / "live testing is
  // a job for a qualified engineer" is safe and must NOT trip the guard.
  const clauses = t.split(/[.\n;:]/);
  const unsafeInstruction = clauses.some((c) => UNSAFE.test(c) && !NEGATED.test(c));
  ok(`${n}: no live-mains/insulation-test/bypass instruction to the customer`, !unsafeInstruction);
}

// ---- 2. DRAINAGE CLUSTER (req 6) ------------------------------------------------------------
ok('not-draining: blockage/filter check LEADS (not the pump)', /filter|blockage|foreign object/.test(first('not-draining')));
ok('not-draining: pump filter precedes the drain pump', before('not-draining', 'filter', 'drain pump') || before('not-draining', 'filter', 'pump'));
ok('not-draining: household waste / backflow finding represented', /waste plumbing|backs up|standpipe|household/.test(discr('not-draining') + JSON.stringify(doc('not-draining').symptoms || []).toLowerCase()));
ok('not-draining: guards "not-draining = replace pump"', /drain pump|pump/.test(conf('not-draining')) && /(automatic|replace|blockage|exclude)/.test(conf('not-draining')));
ok('drain-pump: blockage cleared before condemning the pump (discriminator + guard)', /clear|blocked|jam/.test(discr('drain-pump')) && /replace the drain pump|clear/.test(conf('drain-pump')));

// ---- 3. DOOR-LOCK CLUSTER (req 7) -----------------------------------------------------------
ok('door-lock: retained-water / not-drained lockout is a leading CHECK (not a failed lock)', /retained water|not drained|unlock delay/.test(first('door-lock')) || idx('door-lock', 'retained water') !== -1 && idx('door-lock', 'retained water') < idx('door-lock', 'door interlock'));
ok('door-lock: mechanical (handle/catch/hinge) distinguished from electrical interlock', idx('door-lock', 'handle') !== -1 && idx('door-lock', 'interlock') !== -1);
ok('door-lock: interlock is NOT the first suspect', !first('door-lock').includes('interlock'));
ok('door-lock: retained-water lockout precedes the electrical interlock', before('door-lock', 'retained water', 'interlock'));

// ---- 4. FILL CLUSTER (req 8) ----------------------------------------------------------------
ok('inlet-valve: supply/tap/hose/filter checks LEAD (not the valve)', /supply|tap|hose|filter/.test(first('inlet-valve')));
ok('inlet-valve: supply/filter precede the inlet valve', before('inlet-valve', 'supply', 'inlet valve') || before('inlet-valve', 'filter', 'inlet valve'));
ok('inlet-valve: guards "won\'t fill = inlet valve"', /inlet valve|supply|filter/.test(conf('inlet-valve')));
ok('flow-meter: rule out tap/hose/filter first + guard', /tap|hose|filter|supply/.test(first('flow-meter') + discr('flow-meter')) && /flow meter|filter/.test(conf('flow-meter')));

// ---- 5. SPIN / DRUM / MOTOR CLUSTER (req 9,10) ----------------------------------------------
ok('motor-drum: retained-water/unbalanced/obstruction checks lead (not the motor)', /retained water|unbalanced|obstruction|foreign/.test(first('motor-drum')));
ok('motor-drum: architecture-gated belt/brushes present', /belt/.test(names('motor-drum').join(' ')) && /brush/.test(names('motor-drum').join(' ')));
ok('motor-drum: bearings distinguished from belt from motor', idx('motor-drum', 'bearing') !== -1 && idx('motor-drum', 'belt') !== -1 && (idx('motor-drum', 'motor') !== -1));
ok('motor-drum: guards "won\'t spin = motor"', /motor|belt|bearing|retained|drain/.test(conf('motor-drum')));
ok('excessive-vibration: load/transit-bolts/levelling checks lead (not a part)', /load|transit|level/.test(first('excessive-vibration')));
ok('excessive-vibration: transit bolts represented (installation condition)', idx('excessive-vibration', 'transit') !== -1);
ok('excessive-vibration: guards "vibrating = shock absorbers"', /shock absorber|imbalance|transit|load/.test(conf('excessive-vibration')));
ok('unbalanced-load: load condition LEADS; shock absorber is last', /unbalanc|load/.test(first('unbalanced-load')) && idx('unbalanced-load', 'shock') === names('unbalanced-load').length - 1);
ok('motor-current: mechanical jam checked before condemning the motor + guard', /jam|hand|mechanical/.test(discr('motor-current')) && /failed motor|jam/.test(conf('motor-current')));
ok('tacho: jammed motor/drum checked before the tacho', /jam|motor|drum/.test(first('tacho')));
ok('hall-sensor: overload/imbalance/jam/retained-water checked first (direct-drive)', /overload|imbalance|jam|retained/.test(first('hall-sensor')));

// ---- 6. LEAK CLUSTER (req 11) ---------------------------------------------------------------
ok('leak-flood: leak LOCATION/timing established first', /location|stage|appearance/.test(first('leak-flood')));
ok('leak-flood: guards "leaking = door seal"', /door seal|location|where/.test(conf('leak-flood')));
ok('leak-flood: door seal is one suspect among location-based causes', idx('leak-flood', 'door seal') !== -1 && names('leak-flood').length >= 6);

// ---- 7. HYGIENE / POOR-WASH CLUSTER (req 12) ------------------------------------------------
ok('odour: musty-hygiene vs drain/sewage-plumbing distinguished', /musty|biofilm/.test(names('odour').join(' ')) && /sewage|drain|plumbing/.test(names('odour').join(' ')));
ok('odour: drain smell routed to waste plumbing (not just hygiene)', /waste plumbing|standpipe|sewage/.test(discr('odour')));
ok('odour: burning smell treated as SAFETY, not hygiene', /burning|electrical|safety/.test(discr('odour') + names('odour').join(' ')));
ok('foam-suds: detergent dose/type condition LEADS (not a part)', /detergent|dose|suds|foam/.test(first('foam-suds')));
ok('foam-suds: false-suds sensor is the LAST suspect', idx('foam-suds', 'pressure') === names('foam-suds').length - 1 || idx('foam-suds', 'sensor') === names('foam-suds').length - 1 || /sensor|pressure/.test(names('foam-suds').slice(-1)[0] || ''));
ok('poor-wash-results: usage/detergent/loading condition (advice, not a part)', WM['poor-wash-results'].outcome === 'ADVICE_ONLY' && /detergent|overload|programme/.test(first('poor-wash-results')));

// ---- 8. HEATING / TEMPERATURE (req 13) ------------------------------------------------------
ok('heater: upstream checks (programme/water level) before the element', /programme|temperature selection|water level|fill/.test(first('heater')));
ok('overheating: sensing/switching (NTC/relay) leads, not the element', /ntc|temperature sensor/.test(first('overheating')) && /overheating = heating element/.test(conf('overheating')));
ok('temperature-sensor: NTC is feedback not heat; element ruled out first', /feedback|not heat/.test(discr('temperature-sensor')) && /ntc heats/.test(conf('temperature-sensor')));

// ---- 9. PRESSURE / LEVEL / FLOW (req 14) ----------------------------------------------------
ok('pressure-switch: sensing PATH (chamber/hose) before condemning the switch', idx('pressure-switch', 'hose') !== -1 && idx('pressure-switch', 'hose') < idx('pressure-switch', 'pressure switch'));
ok('pressure-switch: inlet-valve-passing considered (overfill) not just the sensor', idx('pressure-switch', 'inlet valve') !== -1);
ok('mems-sensor: unbalanced load / levelling ruled out before the sensor + guard', /unbalanc|level/.test(first('mems-sensor') + discr('mems-sensor')) && /replace the sensor|unbalanc/.test(conf('mems-sensor')));

// ---- 10. PCB / CONTROL (req 15) — PCB not a dumping ground -----------------------------------
ok('main-pcb: wiring/connectors considered (not blind board condemnation)', /wiring|connector/.test(names('main-pcb').join(' ')));
ok('comms: power-cycle/reset + wiring precede board replacement', /power-cycle|reset|wiring/.test(first('comms')));
ok('control-panel: control/child lock + reset checked before the board', /lock|reset|power/.test(first('control-panel')));
ok('cycle-not-progressing: routed by STAGE (drain/fill/heat/foam), not blind PCB', /stage|drain|fill|heat|foam/.test(first('cycle-not-progressing')));
ok('motor-triac: separate motor from board + guard', /motor|board|triac/.test(discr('motor-triac')) && /control board has failed|separate the motor/.test(conf('motor-triac')));

// ---- 11. TRIPPING ELECTRICS — SAFETY absolute (req 16) --------------------------------------
ok('tripping-electrics: has customer safety information', Boolean(doc('tripping-electrics').safetyInformation));
ok('tripping-electrics: no unsafe live-test / insulation-test instruction', !/(insulation.test|megger|live.test|test .*live)/.test(advice('tripping-electrics') + discr('tripping-electrics')));

// ---- 12. PAIRED / NEAR-NEIGHBOUR (req 26) — one fact flips the engineering ------------------
const PAIRS = [
  ['full-of-water-wont-drain vs drains-then-returns (backflow)', () => /filter|blockage/.test(first('not-draining')) && /waste plumbing|backs up|standpipe/.test(discr('not-draining'))],
  ['retained-water-locked vs empty-but-locked', () => before('door-lock', 'retained water', 'interlock')],
  ['new-machine-vibration (transit bolts) vs old-machine-rumble (bearings)', () => idx('excessive-vibration', 'transit') !== -1 && idx('excessive-vibration', 'bearing') !== -1 && idx('excessive-vibration', 'transit') < idx('excessive-vibration', 'bearing')],
  ['no-fill (supply/valve) vs slow-fill (restriction/flow)', () => /supply|tap|hose|filter/.test(first('inlet-valve')) && /slow|restrict|filter/.test(discr('inlet-valve') + discr('flow-meter'))],
  ['drum-turns-by-hand (electronic/drive) vs rumble-by-hand (bearing)', () => /bearing/.test(names('motor-drum').join(' ')) && /free|hand|turn/.test(discr('motor-drum') + advice('motor-drum'))],
  ['motor-audible-drum-stationary (drive/triac) vs seized (over-current)', () => /jam|hand/.test(discr('motor-current')) && /motor|board/.test(discr('motor-triac'))],
  ['trips-immediately vs trips-when-heating', () => /trip/.test(syn('tripping-electrics'))],
  ['unbalanced-load (usage) vs failed-suspension (part)', () => /unbalanc|load/.test(first('unbalanced-load')) && idx('unbalanced-load', 'shock') > 0],
];
for (const [name, fn] of PAIRS) ok(`PAIR: ${name}`, fn());

// ---- 13. ERROR-CODE != COMPONENT (req 17) — the code-surfaced nodes carry the guard ----------
for (const n of ['drain-pump', 'motor-triac', 'motor-current', 'flow-meter', 'mems-sensor']) {
  ok(`${n}: error-code/symptom != proven component (confusion guard present)`, (doc(n).commonConfusion || []).length >= 1);
}

console.log(`\nwashing-machine engineer challenge: ${pass} passed, ${fail} failed  (nodes=${NODES.length}, paired cases=${PAIRS.length})`);
if (fail) { console.log('FAILURES:', fails.join(' | ')); process.exit(1); }
process.exit(0);
