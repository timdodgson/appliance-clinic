#!/usr/bin/env node
/**
 * Synthetic data for the Phase 4 sandbox (#34). Generated, deterministic, and shaped like production records,
 * with no production content: no conversations, no customer data, no real models or recalls.
 *
 *   node synthetic-data.mjs seed-tables <dir>    DynamoDB batch-write files, 25 items each
 *   node synthetic-data.mjs seed-objects <dir>   files for the web and learning buckets
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const [command, dir] = process.argv.slice(2);
const S = (v) => ({ S: String(v) });
const N = (v) => ({ N: String(v) });
const day = (i) => new Date(Date.UTC(2026, 9, 1, 0, 0, 0) + i * 3600_000).toISOString();

export const transcript = (i) => ({
  pk: S(`sbx-transcript-${String(i).padStart(4, '0')}`), gsiPk: S('transcript'), lastActivityAt: S(day(i)),
  expiresAt: N(1_900_000_000 + i), turns: N(i % 7), synthetic: { BOOL: true },
});
export const recall = (i) => ({
  pk: S(`sbx-recall-${String(i).padStart(4, '0')}`), gsiPk: S('recall'), gsiSk: S(day(i)),
  title: S(`Synthetic recall ${i}`), synthetic: { BOOL: true },
});

if (command === 'seed-tables') {
  mkdirSync(dir, { recursive: true });
  const batches = [['whichpart-transcripts-sbx', transcript], ['whichpart-recalls-sbx', recall]];
  for (const [table, make] of batches) {
    for (let b = 0; b < 4; b += 1) {
      const items = Array.from({ length: 25 }, (_, k) => ({ PutRequest: { Item: make(b * 25 + k) } }));
      writeFileSync(join(dir, `${table}-${b}.json`), JSON.stringify({ [table]: items }));
    }
  }
} else if (command === 'seed-objects') {
  for (let i = 0; i < 20; i += 1) {
    const f = join(dir, 'learning', 'learning', 'dt=2026-10-07', `sbx-${String(i).padStart(3, '0')}.json`);
    mkdirSync(join(f, '..'), { recursive: true });
    writeFileSync(f, JSON.stringify({ synthetic: true, i, note: 'Phase 4 sandbox learning record' }));
  }
  mkdirSync(join(dir, 'web', 'recalls'), { recursive: true });
  writeFileSync(join(dir, 'web', 'index.html'), '<!doctype html><title>Appliance Clinic sandbox</title><p>Phase 4 sandbox (synthetic).</p>\n');
  for (let i = 0; i < 5; i += 1) writeFileSync(join(dir, 'web', 'recalls', `sbx-${i}.html`), `<p>Synthetic recall page ${i}</p>\n`);
} else if (command) {
  console.error('Usage: synthetic-data.mjs seed-tables|seed-objects <dir>');
  process.exit(2);
}
