/**
 * OVEN / COOKER ENGINEER CHALLENGE SUITE (deterministic, offline, permanent).
 *
 * Protects the engineering reasoning across ALL oven/cooker nodes: no-heat by WHICH FUNCTION works
 * (fan-turning proves the motor => fan/ring ELEMENT), the clock/timer AUTO free-fix, temperature-
 * wrong = not-regulating (mechanical thermostat vs electronic sensor architecture), the tripping
 * LINKED-NEUTRALS insight + STOP_USE card, terminal-block burning STOP-USE, cooling-fan causal
 * chain (fan fails -> overheat -> cutout), fan-motor noise-by-character, PCB-last discipline, gas-
 * gas-only ignition (FFD/FSD flame-failure device, not an electric element), and error-code=system.
 *
 * Env override for mutation harness: OVE_OVERRIDES=/path/to/mutated-overrides.json
 * Run: node services/part-finder/test/oven-cooker-engineer-challenge.test.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const K = join(HERE, '..', 'knowledge');
const CAT = JSON.parse(readFileSync(join(HERE, '..', 'faults-catalogue.json'), 'utf8'));
const OV = JSON.parse(readFileSync(process.env.OVE_OVERRIDES || join(K, 'overrides.json'), 'utf8'));
const FAM = 'oven-cooker';
const NODES = Object.keys(CAT.faults[FAM] || {});

let pass = 0, fail = 0; const fails = [];
const ok = (n, c) => { if (c) pass++; else { fail++; fails.push(n); console.log('  FAIL-', n); } };

const doc = (id) => OV.docs[`${FAM}:${id}`] || {};
const comps = (id) => {
  const d = doc(id);
  if (Array.isArray(d.components) && d.components.length) return d.components;
  return (d.likelyComponents || CAT.faults[FAM][id]?.components || []).map((s) => ({ name: String(s), type: 'check' }));
};
const names = (id) => comps(id).map((c) => (typeof c === 'string' ? c : c.name).toLowerCase());
const first = (id) => names(id)[0] || '';
const firstType = (id) => { const c = comps(id)[0]; return c && typeof c === 'object' ? String(c.type || '').toLowerCase() : ''; };
const idx = (id, sub) => names(id).findIndex((c) => c.includes(sub));
const last = (id, sub) => { const a = names(id); return a.length > 0 && a[a.length - 1].includes(sub); };
const discr = (id) => (doc(id).discriminators || []).concat(CAT.faults[FAM][id]?.discriminators || []).join(' \n ').toLowerCase();
const conf = (id) => JSON.stringify(doc(id).commonConfusion || []).toLowerCase();
const clarify = (id) => String(doc(id).clarifyingQuestion || '').toLowerCase();
const safety = (id) => String(doc(id).safety || '').toLowerCase();
const nodeText = (id) => (JSON.stringify(doc(id)) + JSON.stringify(CAT.faults[FAM][id] || {})).toLowerCase();
const blob = (id) => `${discr(id)} \n ${conf(id)} \n ${clarify(id)}`;

// ---- 0. COVERAGE ------------------------------------------------------------------------------
ok('oven-cooker family present (18 nodes)', NODES.length >= 18);
for (const n of NODES) {
  const adviceOnly = CAT.faults[FAM][n]?.outcome === 'ADVICE_ONLY';
  ok(`${n}: override + >=1 suspect (advice-only may have no part)`,
    adviceOnly || (Boolean(OV.docs[`${FAM}:${n}`]) && names(n).length >= 1));
}

// ---- 1. SAFETY (hard) -------------------------------------------------------------------------
const UNSAFE = /(insulation.?test|megger|live.{0,14}test|test.{0,14}\blive\b|bypass.{0,10}(interlock|protection|rcd|earth)|probe.{0,10}(live|mains)|gas.{0,10}(valve|injector).{0,20}(replace|fit)|repair the gas)/;
const NEGATED = /\b(no|not|never|don't|do not|avoid|without|qualified|engineer|specialist|gas safe|leave|isn't|professional|stop use|only)\b/;
for (const n of NODES) {
  const t = `${blob(n)} \n ${safety(n)}`;
  const unsafe = t.split(/[.\n;:]/).some((c) => UNSAFE.test(c) && !NEGATED.test(c));
  ok(`${n}: no unsafe live-electrical / gas-repair instruction`, !unsafe);
}
ok('tripping-electrics: STOP_USE card present', doc('tripping-electrics').safetyInformation?.classification === 'STOP_USE');
ok('tripping-electrics: no insulation test / RCD bypass / repeated reset', /insulation.?resistance|insulation-?test|bypass the (rcd|earth)|repeatedly reset|disconnect earth/.test(discr('tripping-electrics') + safety('tripping-electrics')));
ok('terminal-block: burning/melting => STOP USE and isolate', /burning|melt|scorch/.test(nodeText('terminal-block')) && /stop use|isolate/.test(nodeText('terminal-block')));

// ---- 2. NO-HEAT by WHICH FUNCTION (fan-turning proves motor => element) -----------------------
ok('element: leads with WHICH FUNCTION (identify first), not a blind element sale', firstType('element') === 'check' || /which function|identify/.test(first('element')));
ok('element: fan-turning + no-heat proves MOTOR, element is a candidate not a proven purchase', /fan (is )?(running|turning)/.test(discr('element')) && /candidate|not proven|not automatically/i.test(discr('element')));
ok('element: power-cut + clock flashing = clock AUTO free-fix (no part)', /clock|timer|programmer/.test(discr('element')) && /auto|manual|power/.test(discr('element')));
ok('element: PCB down-ranked for no-heat', /down-rank the pcb|pcb/.test(conf('element')));
ok('element: does NOT diagnose GAS ignition without a gas cue', /gas/.test(discr('element')) && /explicit|only|not ignition|electric/.test(discr('element')));

// ---- 3. TEMPERATURE regulation (thermostat vs sensor architecture) ---------------------------
ok('thermostat: too-hot/burns = NOT regulating (not an over-powerful element)', /not.*regulat|too hot/.test(discr('thermostat')) && /(thermostat|sensor)/.test(discr('thermostat')));
ok('thermostat: mechanical dial vs electronic sensor architecture', /mechanical/.test(discr('thermostat')) && /(electronic|sensor)/.test(discr('thermostat')));
ok('thermostat: cuts-out-hot => cooling fan / thermal cutout (not just thermostat)', /cooling fan|thermal cutout|cuts out/.test(discr('thermostat')));
ok('temperature-probe: electronic sensor is the regulator on electronic ovens (not a dial stat)', /electronic/.test(discr('temperature-probe')) && /sensor/.test(discr('temperature-probe')));

// ---- 4. CLOCK/TIMER free-fix -----------------------------------------------------------------
ok('clock-timer: flashing programmer is ADVICE_ONLY (no-part use-condition)', CAT.faults[FAM]['clock-timer']?.outcome === 'ADVICE_ONLY');
ok('clock-timer: almost never a part — AUTO -> MANUAL free fix leads', /almost never a (faulty )?part|auto|control-state|use-condition/.test(discr('clock-timer')) && /manual/.test(discr('clock-timer')));
ok('clock-timer: leads with the AUTO/MANUAL check, not a programmer sale', firstType('clock-timer') === 'check' || /auto|manual/.test(first('clock-timer')));

// ---- 5. FAN MOTOR + COOLING FAN --------------------------------------------------------------
ok('fan-motor: fan-turning-no-heat = motor proven; heating/supply path in play (not automatic element purchase)', /turning.*no heat|no heat/.test(discr('fan-motor')) && /element|heating|supply/.test(discr('fan-motor')));
ok('fan-motor: noise routed by CHARACTER (scrape/rumble/rattle)', /scrap|rumbl|rattle|bearing/.test(discr('fan-motor')));
ok('fan-motor: cavity/cooking fan distinguished from COOLING fan', /cooling fan/.test(discr('fan-motor')));
ok('cooling-fan: causal chain fan-fails -> overheat -> cutout', /overheat/.test(discr('cooling-fan')) && /cut(s)? out|cutout|thermal/.test(discr('cooling-fan')));
ok('cooling-fan: airflow/vents obstruction checked first', /airflow|vent|obstruction/.test(first('cooling-fan')));
ok('cooling-fan: cooling fan != cooking fan', /cooling fan/.test(discr('cooling-fan')) && /cooking|cavity/.test(discr('cooling-fan')));

// ---- 6. PCB LAST + terminal-block + selector ------------------------------------------------
ok('main-pcb: PCB is the LAST candidate (supply/terminal-block/clock first)', /last/.test(discr('main-pcb')) && /(supply|terminal block|clock)/.test(discr('main-pcb')));
ok('main-pcb: completely-dead => supply/isolator/terminal-block first', /completely dead/.test(discr('main-pcb')) && /(supply|isolator|terminal block)/.test(discr('main-pcb')));
ok('terminal-block: burnt connection is a supply-connection failure, NOT the PCB', /burnt|terminal block/.test(conf('terminal-block')) && /not.*(control board|pcb)/.test(conf('terminal-block')));
ok('selector-switch: cross-mode evidence keeps control/supply path AND element (not a deterministic selector rule)', /top-oven|another mode|mode-specific/.test(discr('selector-switch')) && /not.*deterministic|do not conclude|not automatically/.test(discr('selector-switch')));

// ---- 7. UNEVEN HEATING + DOORS (condition/visible before part) -------------------------------
ok('uneven-heating: loading/airflow/fan/seal check-first (not thermostat)', /loading|airflow|tray/.test(first('uneven-heating')) || /loading|airflow|fan|seal/.test(discr('uneven-heating')));
ok('uneven-heating: not-thermostat guard', /uneven.*thermostat|not.*thermostat|circulation|door seal/.test(conf('uneven-heating') + discr('uneven-heating')));
ok('door-seal: visible/obvious grounds the seal (heat escaping)', /visible|split|hanging|obvious/.test(discr('door-seal')));
ok('door-hinge: dropped/sagging door = hinge/alignment (visible)', /drop|sag|hinge|align/.test(discr('door-hinge')));
ok('door-glass: shattered glass = part identification, not a fault diagnosis', /part|replace|identif/.test(discr('door-glass')) && /glass/.test(nodeText('door-glass')));
ok('lighting: only-lamp-out => lamp/holder, not the PCB', /lamp|bulb/.test(first('lighting')) && /not.*(pcb|board)/.test(conf('lighting')));
ok('control-panel: partial keypad => membrane/touch, PCB last (child-lock first)', /membrane|touch|lock/.test(discr('control-panel')) && /pcb (is )?last|last/.test(discr('control-panel') + conf('control-panel')));
ok('door-lock: door-not-closed/obstruction checked before the lock motor', /not.*closed|obstruction/.test(first('door-lock')));

// ---- 8. GAS ignition (architecture) ----------------------------------------------------------
ok('ignition: only diagnosed when GAS (electric no-heat = element)', /only.*gas|explicit.*gas|electric.*element/.test(discr('ignition')));
ok('ignition: FFD/FSD flame-failure device leads the gas fault', /ffd|fsd|flame failure/.test(discr('ignition') + JSON.stringify(names('ignition'))));

// ---- 9. ERROR CODE = system ------------------------------------------------------------------
const codeMaps = Object.entries(CAT.errorCodes).flatMap(([, plat]) => plat[FAM] ? Object.entries(plat[FAM]) : []);
ok('oven-cooker error codes exist across brands', codeMaps.length >= 30);
ok('every oven-cooker error code resolves to an EXISTING node', codeMaps.every(([, node]) => NODES.includes(node)));

// ---- 10. BRAND NEUTRALITY --------------------------------------------------------------------
for (const n of NODES) {
  const overclaim = /common (fault|problem|failure) (on|with) (bosch|siemens|neff|beko|hotpoint|indesit|whirlpool|candy|hoover|aeg|electrolux|miele|samsung|lg|stoves|belling)\b/.test(discr(n) + conf(n));
  ok(`${n}: no unsupported brand-prevalence claim`, !overclaim);
}

// ---- 11. PAIRED / NEAR-NEIGHBOUR -------------------------------------------------------------
const PAIRS = [
  ['fan-runs/no-heat(element) vs completely-dead(supply/terminal)', () => /fan (is )?(running|turning)/.test(discr('element')) && /completely dead/.test(discr('main-pcb'))],
  ['oven-no-heat/grill-works(element by mode) vs both-dead(supply)', () => /grill/.test(discr('element')) && /completely dead/.test(discr('main-pcb'))],
  ['clock-flashing-after-power-cut(free-fix) vs clock-set-but-no-heat(element)', () => /auto|manual/.test(discr('clock-timer')) && /element/.test(discr('element'))],
  ['trips-immediately vs trips-when-heating(element earth) — both STOP_USE', () => /immediat|straight away|instant/.test(discr('tripping-electrics')) && doc('tripping-electrics').safetyInformation?.classification === 'STOP_USE'],
  ['food-residue-smoke vs electrical/terminal burning(STOP USE)', () => /burning|melt|scorch/.test(nodeText('terminal-block')) && /stop use/.test(nodeText('terminal-block'))],
  ['cuts-out-hot(cooling fan/cutout) vs trips-RCD(element earth)', () => /cooling fan|thermal/.test(discr('thermostat')) && /element/.test(discr('tripping-electrics'))],
  ['temperature-wrong electronic(sensor) vs mechanical(thermostat)', () => /electronic/.test(discr('temperature-probe')) && /mechanical/.test(discr('thermostat'))],
  ['gas-ignition(gas only) vs electric-no-heat(heating path)', () => /gas/.test(discr('ignition')) && /function|mode|cavity/.test(discr('element'))],
];
for (const [name, fn] of PAIRS) ok(`PAIR: ${name}`, fn());

console.log(`\noven-cooker engineer challenge: ${pass} passed, ${fail} failed  (nodes=${NODES.length}, paired cases=${PAIRS.length})`);
if (fail) { console.log('FAILURES:', fails.join(' | ')); process.exit(1); }
process.exit(0);
