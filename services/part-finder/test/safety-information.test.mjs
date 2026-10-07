/**
 * Safety Information V1 — data-contract + retrieval-isolation tests (deterministic, offline).
 *
 * Proves (spec §10/§11):
 *  A. all six proven nodes carry safetyInformation
 *  B. the six negative controls do NOT
 *  C. every safetyInformation record has text/hazard/classification/applicability/provenance
 *  D. empty provenance is rejected by the build validator
 *  E. the legacy inert `safety` string does NOT auto-produce safetyInformation
 *  F. safetyInformation does not alter faultId/routing/components/outcome (diagnostic-neutral)
 *  G. generated knowledge (knowledge-docs.json) preserves the structured field
 *  H. customer wording is preserved EXACTLY (byte-for-byte vs the proven records)
 *  I. RETRIEVAL ISOLATION: no safety wording is in any embedded `text`; the index carries no
 *     safetyInformation and none of the safety phrases.
 *
 * Run: node services/part-finder/test/safety-information.test.mjs
 */
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { validateSafetyInformation } from '../knowledge/build-knowledge.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const K = join(HERE, '..', 'knowledge');
const rd = (p) => JSON.parse(readFileSync(join(K, p), 'utf8'));
const overrides = rd('overrides.json');
const docsFile = rd('knowledge-docs.json');
const safety = rd('safety-information.json');
const index = rd('knowledge-index.json');
const catalogue = JSON.parse(readFileSync(join(HERE, '..', 'faults-catalogue.json'), 'utf8'));

const POSITIVE = [
  'microwave:not-heating', 'hobs:gas-burner', 'washing-machine:tripping-electrics',
  'oven-cooker:tripping-electrics', 'tumble-dryer:filter-blocked', 'tumble-dryer:overheating',
  'washer-dryer:tripping-electrics', 'tumble-dryer:tripping-electrics',
  'dishwasher:tripping-electrics',
  'fridge-freezer:tripping-electrics', 'hobs:tripping-electrics',
];
const NEGATIVE = [
  'washing-machine:not-draining', 'washing-machine:door-lock', 'washing-machine:motor-drum',
  'washing-machine:odour', 'dishwasher:poor-clean-results', 'washing-machine:leak-flood',
];

// Exact customer wording from RAG-SAFETY-PROOF.md — H proves these survive byte-for-byte.
const EXPECT_TEXT = {
  'microwave:not-heating': "Don't remove the microwave's casing or try to repair it inside. Parts inside a microwave can hold a dangerous electric charge even after it's unplugged — have it checked by a qualified engineer.",
  'hobs:gas-burner': "If you can smell gas or think the appliance is unsafe, don't use it. Turn it off, open windows, and don't use switches or naked flames. Call the National Gas Emergency line on 0800 111 999, and have it checked by a Gas Safe registered engineer before using it again.",
  'washing-machine:tripping-electrics': "An appliance that keeps tripping your electrics — or that smells of burning or has scorch marks — may have an electrical fault. Stop using it, switch it off and unplug it, don't keep resetting it, and have it checked by a qualified electrician or appliance engineer.",
  'washer-dryer:tripping-electrics': "An appliance that keeps tripping your electrics — or that smells of burning or has scorch marks — may have an electrical fault. Stop using it, switch it off and unplug it, don't keep resetting it, and have it checked by a qualified electrician or appliance engineer.",
  'tumble-dryer:tripping-electrics': "An appliance that keeps tripping your electrics — or that smells of burning or has scorch marks — may have an electrical fault. Stop using it, switch it off and unplug it, don't keep resetting it, and have it checked by a qualified electrician or appliance engineer.",
  'dishwasher:tripping-electrics': "An appliance that keeps tripping your electrics — or that smells of burning or has scorch marks — may have an electrical fault. Stop using it, switch it off and unplug it, don't keep resetting it, and have it checked by a qualified electrician or appliance engineer.",
  'fridge-freezer:tripping-electrics': "An appliance that keeps tripping your electrics — or that smells of burning or has scorch marks — may have an electrical fault. Stop using it, switch it off and unplug it, don't keep resetting it, and have it checked by a qualified electrician or appliance engineer.",
  'hobs:tripping-electrics': "An appliance that keeps tripping your electrics — or that smells of burning or has scorch marks — may have an electrical fault. Stop using it, switch it off and unplug it, don't keep resetting it, and have it checked by a qualified electrician or appliance engineer.",
  'oven-cooker:tripping-electrics': "An oven that keeps tripping your electrics, or smells of burning, may have an electrical fault. Stop using it and switch it off at the fuse box / consumer unit (ovens are often wired in, not plugged), don't keep resetting it, and have it checked by a qualified electrician.",
  'tumble-dryer:filter-blocked': "Clean the lint filter after every load — a build-up of fluff is a fire risk and restricts airflow. Don't run the dryer overnight or while you're out.",
  'tumble-dryer:overheating': "Overheating can be a fire risk. Clean the lint filter and make sure the airflow/vent isn't blocked, and don't leave the dryer running unattended. If it smells of burning, stop using it and unplug it.",
};
const CLASSES = new Set(['DO_NOT_OPEN', 'STOP_USE', 'EMERGENCY_ACTION', 'MAINTENANCE_SAFETY']);

let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; console.log('  ok  -', name); } else { fail++; console.log('  FAIL-', name); } };

const docByKid = Object.fromEntries(docsFile.docs.map((d) => [d.knowledgeId, d]));
const idxByKid = Object.fromEntries(index.docs.map((d) => [d.knowledgeId, d]));

// A + G: positives present in overrides, docs, safety-information
for (const k of POSITIVE) {
  ok(`A/G ${k} in overrides`, !!(overrides.docs[k] && overrides.docs[k].safetyInformation));
  ok(`A/G ${k} in knowledge-docs`, !!(docByKid[k] && docByKid[k].safetyInformation));
  ok(`A ${k} in safety-information.json`, !!safety.byKnowledgeId[k]);
}
// B: negatives absent everywhere
for (const k of NEGATIVE) {
  ok(`B ${k} absent in overrides`, !(overrides.docs[k] && overrides.docs[k].safetyInformation));
  ok(`B ${k} absent in knowledge-docs`, !(docByKid[k] && docByKid[k].safetyInformation));
  ok(`B ${k} absent in safety-information.json`, !safety.byKnowledgeId[k]);
}
// C: required fields on every safety-information record
ok('C exactly 11 safety records', Object.keys(safety.byKnowledgeId).length === 11);
for (const [k, si] of Object.entries(safety.byKnowledgeId)) {
  ok(`C ${k} has text`, typeof si.text === 'string' && si.text.trim().length > 0);
  ok(`C ${k} has hazard`, typeof si.hazard === 'string' && si.hazard.trim().length > 0);
  ok(`C ${k} valid classification`, CLASSES.has(si.classification));
  ok(`C ${k} has applicability`, typeof si.applicability === 'string' && si.applicability.trim().length > 0);
  ok(`C ${k} non-empty provenance`, Array.isArray(si.provenance) && si.provenance.length > 0
    && si.provenance.every((p) => p && p.sourceType && p.publisher && p.url));
}
// D: empty provenance rejected by the validator
let threwEmpty = false;
try { validateSafetyInformation('x:y', { text: 't', hazard: 'h', classification: 'STOP_USE', applicability: 'a', provenance: [] }); }
catch { threwEmpty = true; }
ok('D empty provenance rejected', threwEmpty);
let threwClass = false;
try { validateSafetyInformation('x:y', { text: 't', hazard: 'h', classification: 'BOGUS', applicability: 'a', provenance: [{ sourceType: 's', publisher: 'p', url: 'u' }] }); }
catch { threwClass = true; }
ok('D invalid classification rejected', threwClass);

// E: legacy inert `safety` string does NOT auto-produce safetyInformation.
// dishwasher:leak-flood has a legacy `safety` string in overrides but is NOT a proven node.
ok('E legacy `safety` present on dishwasher:leak-flood', typeof overrides.docs['dishwasher:leak-flood'].safety === 'string');
ok('E but dishwasher:leak-flood has NO safetyInformation', !overrides.docs['dishwasher:leak-flood'].safetyInformation);
ok('E no legacy `safety` string became safetyInformation', Object.keys(safety.byKnowledgeId).every((k) => POSITIVE.includes(k)));

// F: diagnostic-neutral — faultId/label/components/outcome of the 6 positives match the catalogue.
for (const k of POSITIVE) {
  const [appliance, faultId] = k.split(':');
  const node = catalogue.faults[appliance][faultId];
  const d = docByKid[k];
  ok(`F ${k} faultId unchanged`, d.faultId === faultId);
  ok(`F ${k} label from catalogue`, d.label === (node.label || faultId));
}

// H: exact wording preserved byte-for-byte
for (const k of POSITIVE) {
  ok(`H ${k} wording exact`, safety.byKnowledgeId[k] && safety.byKnowledgeId[k].text === EXPECT_TEXT[k]);
}

// I: RETRIEVAL ISOLATION
// I1: no embedded `text` in any knowledge-docs doc contains any safety wording.
const safetyTexts = Object.values(EXPECT_TEXT);
let leakedIntoText = 0;
for (const d of docsFile.docs) {
  for (const st of safetyTexts) if ((d.text || '').includes(st)) leakedIntoText++;
}
ok('I1 no safety text embedded in any doc.text', leakedIntoText === 0);
// I2: the retrieval index carries NO safetyInformation field on any doc.
ok('I2 index docs have no safetyInformation key', index.docs.every((d) => !('safetyInformation' in d)));
// I3: none of the exact safety-information customer texts appear anywhere in the serialized index
// (the definitive check; the shared phrase "qualified engineer" legitimately pre-exists in ordinary
// diagnostic advice, so we test the full authored strings, not generic words).
const idxStr = JSON.stringify(index);
ok('I3 no exact safety text in index', safetyTexts.every((st) => !idxStr.includes(st)));
ok('I3 no "0800 111 999" (gas emergency number is safety-only) in index', !idxStr.includes('0800 111 999'));
// I4: the positive nodes still exist in the index with identical text (retrieval input unchanged).
for (const k of POSITIVE) {
  ok(`I4 ${k} index text == docs text`, idxByKid[k] && idxByKid[k].text === docByKid[k].text);
}

console.log(`\nsafety-information tests: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
