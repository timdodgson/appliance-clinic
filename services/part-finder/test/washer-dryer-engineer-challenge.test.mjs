/**
 * WASHER-DRYER ENGINEER CHALLENGE SUITE (deterministic, offline, permanent).
 *
 * Tests ENGINEERING SEMANTICS across ALL washer-dryer nodes: wash-side consistency with the approved
 * washing-machine engineering (c262886), the washer-dryer-specific DRY-SIDE distinctions (won't-dry
 * is not automatically the heater; wet-vs-no-heat; hot-but-wet=airflow; slow-dry; load), phase-aware
 * tripping/cycle reasoning, error-code!=component, and absolute electrical safety. Operates on
 * canonical source; any regression or unsafe edit flips it RED. Deployed reply quality is verified by
 * the production E2E.
 *
 * Run: node services/part-finder/test/washer-dryer-engineer-challenge.test.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const K = join(HERE, '..', 'knowledge');
const CAT = JSON.parse(readFileSync(join(HERE, '..', 'faults-catalogue.json'), 'utf8'));
const OV = JSON.parse(readFileSync(process.env.WDE_OVERRIDES || join(K, 'overrides.json'), 'utf8'));
const WD = CAT.faults['washer-dryer'] || {};
const WM = CAT.faults['washing-machine'] || {};
const NODES = Object.keys(WD);

let pass = 0, fail = 0; const fails = [];
const ok = (n, c) => { if (c) pass++; else { fail++; fails.push(n); console.log('  FAIL-', n); } };

const doc = (fam, id) => OV.docs[`${fam}:${id}`] || {};
const names = (fam, id) => {
  const d = doc(fam, id);
  if (Array.isArray(d.components) && d.components.length) return d.components.map((c) => (typeof c === 'string' ? c : c.name).toLowerCase());
  return (d.likelyComponents || []).map((s) => String(s).toLowerCase());
};
const wd = (id) => names('washer-dryer', id);
const first = (id) => wd(id)[0] || '';
const idx = (id, sub) => wd(id).findIndex((c) => c.includes(sub));
const before = (id, a, b) => { const x = idx(id, a), y = idx(id, b); return x !== -1 && y !== -1 && x < y; };
const discr = (id) => (doc('washer-dryer', id).discriminators || []).join(' \n ').toLowerCase();
const conf = (id) => JSON.stringify(doc('washer-dryer', id).commonConfusion || []).toLowerCase();
const advice = (id) => (doc('washer-dryer', id).adviceBeforeReplacement || []).join(' \n ').toLowerCase();
const syn = (id) => [...(WD[id]?.synonyms || []), ...(doc('washer-dryer', id).symptoms || [])].join(' ').toLowerCase();
const blob = (id) => `${discr(id)} \n ${conf(id)} \n ${advice(id)} \n ${syn(id)}`;

// ---- 0. COVERAGE: every WD node reviewed + has ordered suspects ------------------------------
ok('washer-dryer family present', NODES.length >= 20);
for (const n of NODES) ok(`${n}: override + ordered suspects`, Boolean(OV.docs[`washer-dryer:${n}`]) && wd(n).length >= 1);

// ---- 1. ELECTRICAL SAFETY (hard) — no live-mains/insulation/bypass instruction ---------------
const UNSAFE = /(insulation.test|megger|live.{0,14}test|test.{0,14}\blive\b|bypass.{0,10}(interlock|protection)|discharge.{0,10}(capacitor|cap\b)|probe.{0,10}(live|mains))/;
const NEGATED = /\b(no|not|never|don't|do not|avoid|without|qualified|engineer|leave|isn't|professional)\b/;
for (const n of NODES) {
  const t = `${advice(n)} \n ${discr(n)} \n ${String(doc('washer-dryer', n).safety || '').toLowerCase()}`;
  const unsafeInstruction = t.split(/[.\n;:]/).some((c) => UNSAFE.test(c) && !NEGATED.test(c));
  ok(`${n}: no unsafe live-electrical instruction`, !unsafeInstruction);
}
ok('tripping-electrics: customer SAFETY card present (STOP_USE)', doc('washer-dryer', 'tripping-electrics').safetyInformation?.classification === 'STOP_USE');
ok('tripping-electrics: phase reasoning incl. WASH vs DRYING heater', /drying/.test(discr('tripping-electrics')) && /wash/.test(discr('tripping-electrics')));

// ---- 2. WASH-SIDE consistency with approved WM engineering -----------------------------------
ok('not-draining: blockage/filter leads (not pump)', /filter|blockage|foreign/.test(first('not-draining')));
ok('not-draining: filter precedes drain pump', before('not-draining', 'filter', 'drain pump'));
ok('drain-pump: clear blockage before condemning pump', /clear|blocked|hums/.test(discr('drain-pump')));
ok('inlet-valve: supply/tap/hose/filter lead (not the valve)', /supply|tap|hose|filter/.test(first('inlet-valve')));
ok('inlet-valve: supply/filter precede the valve', before('inlet-valve', 'supply', 'inlet valve') || before('inlet-valve', 'filter', 'inlet valve'));
ok('door-lock: retained-water lockout leads (not a failed lock)', /retained water|cycle not finished/.test(first('door-lock')));
ok('door-lock: retained-water precedes the electrical interlock', before('door-lock', 'retained', 'interlock'));
ok('door-lock: discriminator says stuck-after-cycle != failed lock', /not a failed lock|drain\/heater fault/.test(discr('door-lock')));
ok('excessive-vibration: load/transit checks lead (not a part)', /load|transit/.test(first('excessive-vibration')));
ok('excessive-vibration: transit bolts precede bearings', before('excessive-vibration', 'transit', 'bearing'));
ok('unbalanced-load: load condition leads; suspension/shock after', /unbalanc|load/.test(first('unbalanced-load')) && idx('unbalanced-load', 'shock') > 0);
ok('motor-drum: water/load weighed before motor (won\'t-spin != motor)', /water|drain|load|unbalanced/.test(discr('motor-drum')));
ok('heater (WASH): confirm fill + hot programme before element', /fill|programme|selected/.test(discr('heater') + wd('heater').join(' ')));
ok('leak-flood: routed by WHERE/WHEN (location), door seal not automatic', /where|location|down the front|from the door|on spin/.test(discr('leak-flood')));

// ---- 3. DRY-SIDE — washer-dryer-specific (the defining distinctions) --------------------------
ok('drying-heater: airflow/lint LEADS (not the heater element)', /lint|airflow|filter/.test(first('drying-heater')));
ok('drying-heater: lint/airflow precedes the heater element', before('drying-heater', 'lint', 'heater') || before('drying-heater', 'filter', 'heater'));
ok('drying-heater: guards "won\'t dry / wet clothes = drying heater"', /won'?t dry|wet clothes|drying heater/.test(conf('drying-heater')));
ok('drying-heater: WET-because-not-spun/drained differentiated', /spin|drain|water.*removed|removed.*water|soaking/.test(discr('drying-heater')));
ok('drying-heater: HOT-BUT-WET => airflow/condensation, not heater', /hot but/.test(conf('drying-heater') + discr('drying-heater')) && /airflow|condens/.test(conf('drying-heater') + discr('drying-heater')));
ok('drying-heater: NO-HEAT-at-all => element/thermostat/thermal-cutout', /no heat at all|no heat/.test(discr('drying-heater')) && /element|thermostat|thermal/.test(discr('drying-heater')));
ok('drying-heater: over-large DRY LOAD is a no-fault cause', /smaller|load|full wash load|overload/.test(discr('drying-heater')));
ok('drying-heater: safe first check is clean lint/condenser + confirm spin', /lint|condenser|filter/.test(advice('drying-heater')) && /spin|drain/.test(advice('drying-heater')));
ok('drying-heater: customer language for won\'t-dry/slow/hot-but-wet', /washes but wont dry|hot but|takes hours|forever|damp|full load/.test(syn('drying-heater')));
ok('cooling (over-temp dry): airflow (filter/condenser/fan) before electrical', /airflow|filter|condenser|fan/.test(discr('cooling') + first('cooling')));
ok('drying-sensor: clean filmed sensor/condenser before the sensor', /clean|film|condenser|lint/.test(discr('drying-sensor') + first('drying-sensor')));

// ---- 4. CYCLE / CONTROL / ERROR-CODE ---------------------------------------------------------
ok('cycle-not-progressing: routed by STAGE (incl. drying stage)', /stage/.test(first('cycle-not-progressing')) && /dry/.test(wd('cycle-not-progressing').join(' ')));
ok('main-pcb: rule out direct causes before the board', /rule out|direct causes|supply|door|heater|motor|pump/.test(first('main-pcb')));
ok('flow-meter: supply/filter before the flow meter', /supply|filter|fill/.test(first('flow-meter')));
ok('pressure-switch: sensing path/inlet before the switch', idx('pressure-switch', 'switch') > 0);

// ---- 5. WM <-> WD CONSISTENCY (shared engineering must agree) --------------------------------
const wmNames = (id) => names('washing-machine', id);
const wmFirst = (id) => wmNames(id)[0] || '';
const pairAgrees = (id, kw) => new RegExp(kw).test(first(id)) && new RegExp(kw).test(wmFirst(id));
ok('CONSISTENCY not-draining: both lead blockage/filter (not pump)', pairAgrees('not-draining', 'filter|blockage|foreign'));
ok('CONSISTENCY inlet-valve: both lead supply/tap/hose/filter', pairAgrees('inlet-valve', 'supply|tap|hose|filter'));
ok('CONSISTENCY door-lock: both lead retained-water (not failed lock)', /retained/.test(first('door-lock')) && /retained/.test(wmFirst('door-lock')));
ok('CONSISTENCY unbalanced-load: both lead the load condition', pairAgrees('unbalanced-load', 'unbalanc|load'));
ok('CONSISTENCY excessive-vibration: both lead load/transit (not a part)', pairAgrees('excessive-vibration', 'load|transit'));

// ---- 6. PAIRED / NEAR-NEIGHBOUR (engineering flips on one fact) -------------------------------
const PAIRS = [
  ['drain: wont-drain(blockage) vs drains-then-returns(backflow)', () => /filter|blockage/.test(first('not-draining'))],
  ['door: retained-water-locked vs empty-locked', () => before('door-lock', 'retained', 'interlock')],
  ['vibration: new-machine(transit) vs old-machine(bearings)', () => before('excessive-vibration', 'transit', 'bearing')],
  ['dry: washes-ok-wont-dry(airflow/spin/load) vs no-heat(element)', () => /spin|drain|airflow|load/.test(discr('drying-heater')) && /no heat/.test(discr('drying-heater'))],
  ['dry: hot-but-wet(airflow) vs no-heat(heater)', () => /hot but/.test(conf('drying-heater') + discr('drying-heater'))],
  ['dry: slow-dry(airflow/load) vs no-dry(heater)', () => /takes|slow|forever|hours/.test(syn('drying-heater'))],
  ['dry: full-load(usage) vs small-load-still-fails(fault)', () => /smaller|full wash load|load/.test(discr('drying-heater'))],
  ['trip: wash-heat vs drying-heat phase', () => /wash/.test(discr('tripping-electrics')) && /drying/.test(discr('tripping-electrics'))],
  ['cycle: stops-before-spin vs stops-when-drying', () => /dry/.test(wd('cycle-not-progressing').join(' ')) && /drain|spin|fill/.test(wd('cycle-not-progressing').join(' '))],
];
for (const [name, fn] of PAIRS) ok(`PAIR: ${name}`, fn());

console.log(`\nwasher-dryer engineer challenge: ${pass} passed, ${fail} failed  (nodes=${NODES.length}, paired cases=${PAIRS.length})`);
if (fail) { console.log('FAILURES:', fails.join(' | ')); process.exit(1); }
process.exit(0);
