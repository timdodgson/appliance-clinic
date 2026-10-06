import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const TOOL_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const REPO_ROOT = resolve(TOOL_ROOT, '..', '..');
export const DEFAULT_OUTPUT_ROOT = join(REPO_ROOT, '.migration-output');

export function ensureDir(path) {
  mkdirSync(path, { recursive: true });
  return path;
}

export function writeJson(path, value) {
  ensureDir(dirname(path));
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
  return path;
}

export function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

export function readJsonIfExists(path, fallback = null) {
  return existsSync(path) ? readJson(path) : fallback;
}

export function timestampDir(root = DEFAULT_OUTPUT_ROOT, label = 'run') {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return ensureDir(join(root, `${label}-${stamp}`));
}
