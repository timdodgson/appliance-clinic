/**
 * Phase 8: every environment variable a runtime reads is documented in docs/architecture/configuration.md, so no
 * runtime grows hidden configuration.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const doc = readFileSync(join(ROOT, 'docs', 'architecture', 'configuration.md'), 'utf8');
const documented = new Set([...doc.matchAll(/`([A-Z][A-Z0-9_]{2,})`/g)].map((m) => m[1]));

function files(dir, ext) {
  const out = [];
  for (const name of readdirSync(dir)) {
    if (['test', 'tests', 'node_modules', 'scripts', '.venv', '__pycache__'].includes(name)) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...files(p, ext));
    else if (ext.some((e) => name.endsWith(e))) out.push(p);
  }
  return out;
}
const JS = [/process\.env\.([A-Z][A-Z0-9_]{2,})/g, /\benv\.([A-Z][A-Z0-9_]{2,})/g, /\benv\[['"]([A-Z][A-Z0-9_]{2,})['"]\]/g,
  /numEnv\('([A-Z][A-Z0-9_]{2,})'/g, /\be\.([A-Z][A-Z0-9_]{2,})/g];
const PY = [/os\.environ(?:\.get)?\(?\[?["']([A-Z][A-Z0-9_]{2,})["']/g];
function read(dir, ext, patterns) {
  const names = new Set();
  for (const f of files(join(ROOT, dir), ext)) {
    if (/knowledge\/build|benchmark\/gold-v2\/run-|\.test\./.test(f)) continue;
    const src = readFileSync(f, 'utf8');
    for (const re of patterns) for (const m of src.matchAll(re)) names.add(m[1]);
  }
  return [...names].sort();
}

describe('configuration.md', () => {
  it.each([
    ['services/part-finder', ['.js', '.cjs'], JS],
    ['services/whichpart-api', ['.js', '.cjs'], JS],
    ['orchestration', ['.py'], PY],
    ['error-codes/mcp', ['.py'], PY],
  ])('documents every variable %s reads', (dir, ext, patterns) => {
    const read_ = read(dir, ext, patterns);
    expect(read_.length).toBeGreaterThan(0);
    expect(read_.filter((n) => !documented.has(n))).toEqual([]);
  });
});
