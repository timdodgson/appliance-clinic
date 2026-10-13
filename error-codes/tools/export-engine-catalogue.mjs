#!/usr/bin/env node
/**
 * Export the compact error-code catalogue the diagnosis engine reads in-process
 * (services/diagnosis-engine/ac2/data/error-codes.json) from the banked runtime artefacts
 * (error-codes/runtime-model/generated/runtime/mappings.json). Deterministic: same input, same bytes.
 *
 *   node error-codes/tools/export-engine-catalogue.mjs           write the file
 *   node error-codes/tools/export-engine-catalogue.mjs --check   exit 1 if the file is stale
 *
 * services/diagnosis-engine/test/ac2-errorcodes.test.mjs checks the file is in sync.
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const MAPPINGS_PATH = join(ROOT, 'error-codes/runtime-model/generated/runtime/mappings.json');
export const MANIFEST_PATH = join(ROOT, 'error-codes/runtime-model/generated/runtime/manifest.json');
export const OUT_PATH = join(ROOT, 'services/diagnosis-engine/ac2/data/error-codes.json');

/** One compact record per mapping. Applicability other than brand/appliance is kept as otherConditions. */
export function engineRecord(m) {
  const conds = m.applicability?.conditions || [];
  const values = (k) => [...(conds.find((c) => c.k === k)?.v || [])];
  const other = conds.filter((c) => c.k !== 'brand' && c.k !== 'appliance').map((c) => ({ k: c.k, op: c.op, v: c.v }));
  const rec = {
    id: m.mappingId,
    token: m.token,
    shown: [...(m.shown || [])],
    canonicalCode: m.provenance?.canonicalCode || null,
    brands: values('brand'),
    appliances: values('appliance'),
    otherConditions: other,
    meaning: m.meaning,
    recordType: m.recordType,
    faultId: m.faultId,
    confidence: m.confidence,
    schemeId: m.schemeId,
  };
  if (m.ambiguity?.unresolved) rec.disputed = true;
  return rec;
}

export function buildEngineCatalogue(mappings, manifest) {
  const ids = new Set();
  for (const m of mappings) {
    if (ids.has(m.mappingId)) throw new Error(`duplicate mappingId ${m.mappingId}`);
    ids.add(m.mappingId);
  }
  const records = mappings.map(engineRecord);
  return {
    generatedFrom: 'error-codes/runtime-model/generated/runtime/mappings.json',
    generator: 'error-codes/tools/export-engine-catalogue.mjs',
    datasetContentHash: manifest?.contentHash || null,
    mappingsSha256: createHash('sha256').update(JSON.stringify(mappings)).digest('hex'),
    count: records.length,
    records,
  };
}

/** Stable text: header fields pretty, one record per line (small diffs, compact file). */
export function serialise(cat) {
  const { records, ...head } = cat;
  const headText = JSON.stringify(head, null, 2).replace(/\n}$/, '');
  return `${headText},\n  "records": [\n${records.map((r) => `    ${JSON.stringify(r)}`).join(',\n')}\n  ]\n}\n`;
}

export function expectedText() {
  const mappings = JSON.parse(readFileSync(MAPPINGS_PATH, 'utf8'));
  const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'));
  return serialise(buildEngineCatalogue(mappings, manifest));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const text = expectedText();
  if (process.argv.includes('--check')) {
    let current = '';
    try { current = readFileSync(OUT_PATH, 'utf8'); } catch { /* missing */ }
    if (current !== text) { console.error(`stale: ${OUT_PATH}`); process.exitCode = 1; } else console.log('in sync');
  } else {
    writeFileSync(OUT_PATH, text);
    console.log(`wrote ${OUT_PATH}`);
  }
}
