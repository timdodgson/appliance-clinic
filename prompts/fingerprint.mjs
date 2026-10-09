#!/usr/bin/env node
// @ts-check
/**
 * Prompt fingerprints for the registry (prompts/registry.json).
 *
 *   node prompts/fingerprint.mjs            print each prompt's current fingerprint and whether it matches its version
 *
 * A prompt's source is either named top-level declarations of a file (their exact source text, found by parsing the
 * file), or a whole file that holds only that prompt.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseAst } from 'rollup/parseAst';

/** @typedef {import('../types/prompts.js').PromptRegistry} PromptRegistry */
/** @typedef {import('../types/prompts.js').PromptEntry} PromptEntry */

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
/** @returns {PromptRegistry} */
export const registry = () => JSON.parse(readFileSync(join(ROOT, 'prompts', 'registry.json'), 'utf8'));

/**
 * The exact source text of a top-level declaration.
 * @param {string} src @param {string} name @param {string} file
 * @returns {string}
 */
export function declaration(src, name, file) {
  const node = parseAst(src).body.find((n) => (n.type === 'FunctionDeclaration' && n.id.name === name)
    || (n.type === 'VariableDeclaration' && n.declarations.some((d) => d.id.type === 'Identifier' && d.id.name === name)));
  if (!node) throw new Error(`${file}: no top-level declaration ${name}`);
  const { start, end } = /** @type {{ start: number, end: number }} */ (/** @type {unknown} */ (node));
  return src.slice(start, end);
}

/** @param {PromptEntry} entry @returns {string} */
export function promptSource(entry) {
  return entry.source.map((s) => {
    const src = readFileSync(join(ROOT, s.file), 'utf8');
    return s.declarations ? s.declarations.map((d) => declaration(src, d, s.file)).join('\n') : src;
  }).join('\n');
}

/** @param {PromptEntry} entry */
export const fingerprint = (entry) => createHash('sha256').update(promptSource(entry)).digest('hex');

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  for (const e of registry().prompts) {
    const now = fingerprint(e);
    const last = e.changelog[e.changelog.length - 1];
    console.log(`${now === last?.fingerprint ? 'ok     ' : 'CHANGED'} ${e.id} v${e.version} ${now}`);
  }
}
