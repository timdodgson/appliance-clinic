import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { REPO_ROOT } from '../src/util/files.js';

// Phase 2 (#24): the imported runtime must stay byte-for-byte what production runs until Phase 3.
const manifest = JSON.parse(readFileSync(join(REPO_ROOT, 'docs', 'migration', 'import-manifest.json'), 'utf8'));
const sha256 = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');

describe('Phase 2 import manifest', () => {
  it('lists each file once', () => {
    const paths = manifest.files.map((f) => f.path);
    expect(new Set(paths).size).toBe(paths.length);
  });

  it('takes only whichpart-api/index.js from the Phase 1 hotfix, and the rest from 13b7a50', () => {
    const hotfix = manifest.files.filter((f) => !f.source.startsWith('spares4repairs@13b7a50:'));
    expect(hotfix.map((f) => f.path)).toEqual(['services/whichpart-api/index.js']);
  });

  it.each(manifest.files.map((f) => [f.path, f]))('%s matches its recorded SHA-256', (path, f) => {
    const full = join(REPO_ROOT, path);
    expect(existsSync(full)).toBe(true);
    expect(sha256(full)).toBe(f.sha256);
  });
});
