/**
 * The engine's module structure (ADR 0019, 0020): the engine/ modules form an acyclic graph below the handler, the
 * handler's `_internal` test surface is only the provider seam, and none of the deleted pipelines' modules exists: the
 * legacy pipeline (ADR 0019) and the journey controller (ADR 0020: ac2 is the only diagnose path).
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ENGINE = join(ROOT, 'engine');
const modules = readdirSync(ENGINE).filter((f) => f.endsWith('.js')).sort();
const requires = Object.fromEntries(modules.map((f) => {
  const src = readFileSync(join(ENGINE, f), 'utf8');
  return [f, [...src.matchAll(/require\('(\.{1,2}\/[^']+)'\)/g)].map((m) => m[1])];
}));

// The handler's `_internal` test surface: the inference provider seam only.
const INTERNAL = ['_setProviderForTest'];

const DELETED = [
  // The legacy diagnosis pipeline, deleted with ADR 0019.
  'part-finder-lambda.js', 'retrieval.js', 'fit-evidence.js', 'deploy.sh', 'engine/compose.js', 'engine/evidence.js',
  'engine/progression.js', 'engine/presentation.js', 'engine/safety.js', 'engine/intent-vocabulary.js',
  'engine/error-codes.js', 'engine/media-concepts.js', 'knowledge/normal-behaviour.json',
  // The journey controller (Jev UNDERSTAND, mc/1, cs/1, the canonical journeys and COMPOSE), retired with ADR 0020.
  'canonical', 'canonical-runtime.js', 'jev-mc1.js', 'jev-understand.js', 'identity.js', 'security.js',
  'engine/understand.js', 'engine/reply-filters.js', 'engine/catalogue.js', 'ac2/build-journey-knowledge.cjs',
  // The ADR 0021 pipeline (Qwen, Jev, the claim verifier) retired by the advisor (ADR 0023, change 23.1), and the
  // leftovers removed in change 23.3: Jev, the in-process copy of the error-code data, the ablation.
  'ac2/understand.js', 'ac2/labels.js', 'ac2/reasoner.js', 'ac2/verifier.js', 'ac2/reply.js', 'ac2/compose.js', 'ac2/evidence.js',
  'ac2/parts.js', 'ac2/models.js', 'jev-client.js', 'ac2/errorcodes.js', 'ac2/data',
];

describe('engine modules', () => {
  it('never require the handler', () => {
    for (const [f, deps] of Object.entries(requires)) expect(deps.filter((d) => d.includes('handler')), f).toEqual([]);
  });

  it('form an acyclic graph', () => {
    const state = {};
    const visit = (f, path) => {
      if (state[f] === 'done') return;
      expect(state[f], `cycle: ${[...path, f].join(' -> ')}`).not.toBe('active');
      state[f] = 'active';
      for (const d of requires[f]) if (d.startsWith('./')) visit(d.slice(2), [...path, f]);
      state[f] = 'done';
    };
    for (const f of modules) visit(f, []);
  });

  it('each load on their own', () => {
    for (const f of modules) expect(() => require(join(ENGINE, f)), f).not.toThrow();
  });
});

describe('handler _internal', () => {
  it('is exactly the provider seam', () => {
    const internal = require('../handler.js')._internal;
    expect(Object.keys(internal).sort()).toEqual([...INTERNAL].sort());
    for (const k of INTERNAL) expect(internal[k], k).not.toBeUndefined();
  });
});

describe('retired pipelines', () => {
  it('none of its modules exists', () => {
    for (const f of DELETED) expect(existsSync(join(ROOT, f)), f).toBe(false);
  });
});
