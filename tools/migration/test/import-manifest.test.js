import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { REPO_ROOT } from '../src/util/files.js';

// Phase 2 imports (#24, #27): every imported file must stay byte-for-byte its recorded source until
// Phase 3 changes it deliberately.
const load = (name) => JSON.parse(readFileSync(join(REPO_ROOT, 'docs', 'migration', name), 'utf8'));
const runtime = load('import-manifest.json');
const followUp = load('import-manifest-phase-2b.json');
// Phase 7 onwards: deliberate runtime changes. A modified imported file is checked against its latest recorded change.
const changes = load('runtime-changes.json');
const modified = new Map(changes.modified.map((f) => [f.path, f]));
const sha256 = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');

describe('Phase 2 import manifests', () => {
  it('list each file once across both manifests', () => {
    const paths = [...runtime.files, ...followUp.files].map((f) => f.path);
    expect(new Set(paths).size).toBe(paths.length);
  });

  it('take only whichpart-api/index.js from the Phase 1 hotfix, and the rest from 13b7a50', () => {
    const hotfix = [...runtime.files, ...followUp.files].filter((f) => !f.source.startsWith('spares4repairs@13b7a50:'));
    expect(hotfix.map((f) => f.path)).toEqual(['services/whichpart-api/index.js']);
  });

  it.each([...runtime.files, ...followUp.files].map((f) => [f.path, f]))('%s matches its recorded SHA-256', (path, f) => {
    const full = join(REPO_ROOT, path);
    expect(existsSync(full)).toBe(true);
    expect(sha256(full)).toBe(modified.has(path) ? modified.get(path).sha256 : f.sha256);
  });
});

describe('Phase 7 runtime changes (runtime-changes.json)', () => {
  const imported = new Set([...runtime.files, ...followUp.files].map((f) => f.path));
  it('modify only imported files, and add only files that were not imported, each once, each with its change', () => {
    for (const f of changes.modified) expect(imported.has(f.path), f.path).toBe(true);
    for (const f of changes.added) expect(imported.has(f.path), f.path).toBe(false);
    const paths = [...changes.modified, ...changes.added].map((f) => f.path);
    expect(new Set(paths).size).toBe(paths.length);
    for (const f of [...changes.modified, ...changes.added]) expect(f.changes.length, f.path).toBeGreaterThan(0);
    for (const f of changes.added) expect(['runtime', 'test'], f.path).toContain(f.role);
  });
  it.each(changes.added.map((f) => [f.path, f]))('%s matches its recorded SHA-256', (path, f) => {
    expect(sha256(join(REPO_ROOT, path))).toBe(f.sha256);
  });
});
