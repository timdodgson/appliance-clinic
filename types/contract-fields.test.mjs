/**
 * Phase 8: the declared /part-finder contract (types/part-finder.d.ts) covers every field the S4R page reads
 * (tools/migration/config/baseline.json, partFinderContract), so the declaration cannot drift from what S4R relies on.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const dts = readFileSync(join(ROOT, 'types', 'part-finder.d.ts'), 'utf8');
const contract = JSON.parse(readFileSync(join(ROOT, 'tools', 'migration', 'config', 'baseline.json'), 'utf8')).partFinderContract;

/** The required (non-optional) members of an exported interface. */
function required(name) {
  const body = dts.match(new RegExp(`export interface ${name}\\b[^{]*\\{([\\s\\S]*?)\\n\\}`));
  if (!body) throw new Error(`no interface ${name}`);
  return [...body[1].matchAll(/^\s{2}(\w+):/gm)].map((m) => m[1]);
}

describe('declared /part-finder contract', () => {
  it('declares every done-frame field the S4R page reads as required', () => {
    expect(required('DoneFrame')).toEqual(expect.arrayContaining(contract.doneEventFieldsReadByS4R));
  });
  it('declares every part field the S4R page reads as required', () => {
    expect(required('Part')).toEqual(expect.arrayContaining(contract.partFieldsReadByS4R));
  });
  it('declares every understood field the S4R page reads as required', () => {
    expect(required('Understood')).toEqual(expect.arrayContaining(contract.understoodFieldsReadByS4R));
  });
  it('declares the request the S4R page sends', () => {
    expect(required('PartFinderRequest')).toEqual(Object.keys(contract.request));
  });
});
