/**
 * ENGINEERING FINDING architecture — cross-family challenge suite (deterministic, offline, permanent).
 *
 * Protects the finding-before-part separation:
 *   A. CONTRACT: `primaryFinding` is a first-class additive field on the UNDERSTAND output, plumbed
 *      through normaliseIntent (evidence text, length-capped) and present (null) on the degraded path;
 *      COMPOSE is instructed to LEAD with it; the brand-overclaim / evidence-attribution guard exists.
 *   B. KNOWLEDGE SEMANTICS: for representative nodes across EVERY family where the best engineering
 *      finding is NOT a replacement component (blockage, contamination, external/installation, usage,
 *      restricted airflow), the structured knowledge actually CONTAINS that condition — so UNDERSTAND
 *      has the material to produce a condition-level primaryFinding rather than being forced to a part.
 *   C. COMPONENT CASES: where a genuine component fault should still lead, the component is present.
 *
 * Behavioural proof (the deployed reply actually leads with the finding) is the production E2E.
 * Run: node services/part-finder/test/engineering-finding.test.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';

const HERE = dirname(fileURLToPath(import.meta.url));
const K = join(HERE, '..', 'knowledge');
const require = createRequire(import.meta.url);
globalThis.awslambda = globalThis.awslambda || { streamifyResponse: (f) => f, HttpResponseStream: { from: (s) => s } };
const { normaliseIntent } = require('../part-finder-lambda.js')._internal;
// Source/docs paths are override-able (EF_SRC / EF_DOCS) so the mutation harness can point the SAME
// suite at a mutated copy without touching the real files. Default to canonical source.
const SRC = (process.env.EF_SRC ? readFileSync(process.env.EF_SRC, 'utf8') : require('./engine-source.cjs')());
const DOCS = JSON.parse(readFileSync(process.env.EF_DOCS || join(K, 'knowledge-docs.json'), 'utf8')).docs;
const byId = Object.fromEntries(DOCS.map((d) => [d.knowledgeId, d]));
const text = (id) => (byId[id]?.text || '').toLowerCase();

let pass = 0, fail = 0; const fails = [];
const ok = (n, c) => { if (c) pass++; else { fail++; fails.push(n); console.log('  FAIL-', n); } };

// ---- A. CONTRACT ----------------------------------------------------------------------------
{
  // schema: primaryFinding declared + required
  ok('A schema declares primaryFinding', /primaryFinding:\s*\{\s*type:\s*\['string',\s*'null'\]\s*\}/.test(SRC));
  ok('A primaryFinding is a required field', /required:\s*\[[^\]]*'primaryFinding'/.test(SRC.replace(/\n/g, ' ')));
  // normaliseIntent passes an evidence sentence through (length-capped)
  const finding = 'Dirty water is backing up from the household waste plumbing rather than an appliance fault.';
  ok('A normaliseIntent passes primaryFinding through', normaliseIntent({ primaryFinding: finding }).primaryFinding === finding);
  ok('A normaliseIntent caps an over-long finding', (normaliseIntent({ primaryFinding: 'x '.repeat(400) }).primaryFinding || '').length <= 222);
  ok('A missing primaryFinding -> null', normaliseIntent({}).primaryFinding === null);
  ok('A degraded path carries primaryFinding: null', 'primaryFinding' in normaliseIntent({}));
  // COMPOSE leads with the finding + does not force a part for a non-component finding
  ok('A COMPOSE injects PRIMARY ENGINEERING FINDING and says LEAD WITH THIS', /PRIMARY ENGINEERING FINDING \(LEAD WITH THIS\)/.test(SRC));
  ok('A COMPOSE forbids forcing a part headline for a condition finding', /do NOT force a part as the headline/i.test(SRC));
  ok('A COMPOSE parts list is subordinated to the finding ("AFTER the primary finding")', /AFTER the primary finding/i.test(SRC));
  // brand-overclaim / evidence-attribution guard (generic, derived — not a per-brand list)
  ok('A evidence-attribution KNOWLEDGE BASIS guard present', /KNOWLEDGE BASIS/.test(SRC));
  ok('A generic knowledge must not become brand-specific', /GENERIC appliance engineering, not \$\{intent\.make\}/.test(SRC));
}

// ---- B. KNOWLEDGE SEMANTICS — the condition finding exists in the knowledge (per family) ----
// Each entry: node -> at least one regex marker proving the non-component condition is represented.
const CONDITION_NODES = [
  ['washing-machine:not-draining', /waste plumbing|backs up|standpipe|household waste/, 'household-waste backflow'],
  ['washing-machine:not-draining', /blocked pump filter|clean the .*filter|foreign object/, 'blocked filter (check-first)'],
  ['washing-machine:excessive-vibration', /transit|shipping bolt/, 'transit bolts (installation)'],
  ['washing-machine:unbalanced-load', /unbalanc|redistribut|bunched|single (heavy|large) item|load/, 'unbalanced load (usage)'],
  ['washing-machine:foam-suds', /suds|foam|too much detergent|excess detergent/, 'excess suds (usage)'],
  ['washing-machine:odour', /waste plumbing|standpipe|biofilm|maintenance wash|mould/, 'hygiene/plumbing condition'],
  ['dishwasher:not-draining', /filter|blockage|sump|drain hose/, 'blockage/filter (check-first)'],
  ['dishwasher:poor-clean-results', /filter|spray arm|detergent|salt|rinse aid|blocked/, 'maintenance condition'],
  ['tumble-dryer:not-emptying-condensate', /condenser|condensate|empty the .*tank|water container/, 'condensate/airflow condition'],
  ['tumble-dryer:filter-blocked', /fluff|lint|filter/, 'blocked filter (maintenance)'],
  ['fridge-freezer:not-cooling', /door seal|ventilation|condenser|coil|setting|airflow|air/, 'airflow/door/coil condition'],
  ['vacuum:lost-suction', /bin|filter|blockage|hose|clog/, 'blockage/filter (check-first)'],
  ['microwave:sparking-arcing', /metal|foil|contamination|carbon/, 'user/contamination cause'],
];
for (const [id, re, what] of CONDITION_NODES) {
  if (!byId[id]) { ok(`B node exists: ${id}`, false); continue; }
  ok(`B ${id}: condition finding represented (${what})`, re.test(text(id)));
}

// vacuum lost-suction: blockage/filter must be discussed BEFORE the motor (finding before component)
if (byId['vacuum:lost-suction']) {
  const t = text('vacuum:lost-suction');
  const mIdx = t.indexOf('motor');
  const bIdx = Math.min(...['filter', 'bin', 'blockage', 'hose'].map((w) => { const i = t.indexOf(w); return i === -1 ? 1e9 : i; }));
  ok('B vacuum: blockage/filter appears before the motor', bIdx < mIdx || mIdx === -1);
}

// ---- C. COMPONENT CASES — a genuine component fault can still lead --------------------------
const COMPONENT_NODES = [
  ['oven-cooker:element', /element/, 'oven element'],
  ['washing-machine:drain-pump', /drain pump/, 'drain pump'],
  ['microwave:not-heating', /magnetron|diode|inverter/, 'magnetron/HV'],
];
for (const [id, re, what] of COMPONENT_NODES) {
  if (!byId[id]) { ok(`C node exists: ${id}`, false); continue; }
  ok(`C ${id}: component lead available (${what})`, re.test(text(id)));
}

console.log(`\nengineering-finding suite: ${pass} passed, ${fail} failed`);
if (fail) { console.log('FAILURES:', fails.join(' | ')); process.exit(1); }
process.exit(0);
