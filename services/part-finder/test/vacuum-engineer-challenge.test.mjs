/**
 * VACUUM ENGINEER CHALLENGE SUITE (deterministic, offline, permanent).
 *
 * Protects the classic vacuum traps: LOST SUCTION is an AIRFLOW problem (bin/filter/blockage) — the
 * motor is NOT a lead suspect; CUTS OUT is thermal protection from restricted airflow (clean before
 * condemning the motor); BRUSH-BAR not turning is hair/belt first (not the motor). Guards
 * poor-pickup-vs-low-suction and thermal-protection-as-symptom, and no unsafe "keep running it to
 * find the burning smell" guidance.
 *
 * Env override for mutation harness: VAC_OVERRIDES=/path/to/mutated-overrides.json
 * Run: node services/part-finder/test/vacuum-engineer-challenge.test.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const K = join(HERE, '..', 'knowledge');
const CAT = JSON.parse(readFileSync(join(HERE, '..', 'faults-catalogue.json'), 'utf8'));
const OV = JSON.parse(readFileSync(process.env.VAC_OVERRIDES || join(K, 'overrides.json'), 'utf8'));
const FAM = 'vacuum';
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
const bareIdx = (id, sub, ...excl) => names(id).findIndex((c) => c.includes(sub) && !excl.some((e) => c.includes(e)));
// Precise "this suspect IS the motor part" — excludes descriptive mentions (pre/post-motor filters,
// "overheats the motor", "thermal cut-out ... motor") so we test genuine motor-replacement ranking.
const motorIdx = (id) => names(id).findIndex((c) => /(^|[\s/])motor(\s*\(|\s*$|\s*\[)/.test(c) && !/pre-motor|post-motor|overheats the motor|thermal|cut-?out/.test(c));
const discr = (id) => (doc(id).discriminators || []).concat(CAT.faults[FAM][id]?.discriminators || []).join(' \n ').toLowerCase();
const nodeText = (id) => (JSON.stringify(doc(id)) + JSON.stringify(CAT.faults[FAM][id] || {})).toLowerCase();

// ---- 0. COVERAGE ------------------------------------------------------------------------------
ok('vacuum family present (3 nodes)', NODES.length >= 3);
for (const n of NODES) ok(`${n}: override + >=1 suspect`, Boolean(OV.docs[`${FAM}:${n}`]) && names(n).length >= 1);

// ---- 1. SAFETY --------------------------------------------------------------------------------
const UNSAFE = /(keep running|keep using|carry on using|continue running|run it until|repeatedly run).{0,80}(smell|burn|hot|overheat)/;
for (const n of NODES) ok(`${n}: does not tell customer to keep running a burning/overheating vacuum`, !UNSAFE.test(nodeText(n)));

// ---- 2. LOST SUCTION = AIRFLOW, not the motor ------------------------------------------------
ok('lost-suction: leads with bin/bag (airflow), not the motor', /bin|bag|empty/.test(first('lost-suction')));
ok('lost-suction: MOTOR is NOT a listed suspect (airflow-only journey)', motorIdx('lost-suction') === -1);
ok('lost-suction: filters + blockage + brush hair all present', idx('lost-suction', 'filter') !== -1 && idx('lost-suction', 'blockage') !== -1 && idx('lost-suction', 'brush') !== -1);
ok('lost-suction: "most lost suction is full bin / dirty filter / blockage" before any part', /full bin|dirty filter|blockage/.test(discr('lost-suction')) && /before any part|check those/.test(discr('lost-suction')));

// ---- 3. CUTS OUT = thermal protection from airflow restriction -------------------------------
ok('motor: clean filters / clear blockage / let cutout reset BEFORE the motor', /filter|blockage|cut-?out|thermal/.test(first('motor')));
ok('motor: the actual motor is NOT the first suspect', !/^motor \(|^motor$/.test(first('motor')) || /clean|blockage|cut/.test(first('motor')));
ok('motor: cutting out with a smell = overheating from dirty filter/blockage (clean first)', /overheat/.test(discr('motor')) && /(filter|blockage|clean)/.test(discr('motor')));
ok('motor (bare) ranked AFTER the airflow/thermal checks', motorIdx('motor') > 0);

// ---- 4. BRUSH-BAR = hair/belt first, not the motor -------------------------------------------
ok('brush-bar: hair/thread wrapped round the roller checked first', /hair|thread/.test(first('brush-bar')));
ok('brush-bar: belt considered before the brush motor', (() => { const b = idx('brush-bar', 'belt'), m = bareIdx('brush-bar', 'motor'); return b !== -1 && (m === -1 || b < m); })());
ok('brush-bar: not-spinning is usually broken belt or hair (not auto motor)', /belt|hair/.test(discr('brush-bar')));

// ---- 5. POOR PICKUP vs LOW SUCTION (brush-bar vs lost-suction distinction) --------------------
ok('poor-pickup path (brush-bar) is DISTINCT from low-suction path (lost-suction)', first('brush-bar') !== first('lost-suction') && motorIdx('lost-suction') === -1);

// ---- 6. BRAND NEUTRALITY ---------------------------------------------------------------------
for (const n of NODES) {
  const overclaim = /common (fault|problem|failure) (on|with) (dyson|shark|henry|numatic|miele|bosch|vax|hoover)\b/.test(discr(n) + nodeText(n));
  ok(`${n}: no unsupported brand-prevalence claim`, !overclaim);
}

// ---- 7. PAIRED / NEAR-NEIGHBOUR --------------------------------------------------------------
const PAIRS = [
  ['weak-suction-everywhere(airflow) vs strong-hose/poor-floor-pickup(brush-bar)', () => motorIdx('lost-suction') === -1 && /hair|belt/.test(first('brush-bar'))],
  ['cuts-out-hot-then-restarts(thermal/airflow) vs dead-permanently(motor/cord)', () => /overheat|thermal|cut/.test(first('motor')) && (idx('motor', 'cord') !== -1 || idx('motor', 'switch') !== -1)],
  ['blocked-filter(airflow) vs clean-airflow+weak-motor-evidence', () => /filter/.test(first('motor')) && motorIdx('motor') > 0],
  ['brushroll-jammed(hair) vs belt/head-drive failure', () => /hair|thread/.test(first('brush-bar')) && idx('brush-bar', 'belt') !== -1],
  ['lost-suction airflow-only vs motor-node thermal-first (no motor-first anywhere)', () => motorIdx('lost-suction') === -1 && motorIdx('motor') > 0],
];
for (const [name, fn] of PAIRS) ok(`PAIR: ${name}`, fn());

console.log(`\nvacuum engineer challenge: ${pass} passed, ${fail} failed  (nodes=${NODES.length}, paired cases=${PAIRS.length})`);
if (fail) { console.log('FAILURES:', fails.join(' | ')); process.exit(1); }
process.exit(0);
