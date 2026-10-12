/**
 * The engine's module structure (ADR 0019): the engine/ modules form an acyclic graph below the handler, the handler's
 * `_internal` test surface is the canonical runtime as wired, and none of the deleted legacy pipeline modules exists.
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

// The handler's `_internal` test surface: the canonical runtime as the handler wires it.
const INTERNAL = [
  'CANONICAL_JOURNEY_PACKS', '_setProvidersForTest', 'canonicalControls', 'canonicalFinishUnderstand', 'canonicalJourney',
  'canonicalJourneys', 'canonicalModelParts', 'canonicalRespond', 'canonicalTransportMerge', 'canonicalTransportMetric',
  'isCanonicalTransportBlock', 'isCanonicalTransportResult',
];

// The legacy diagnosis pipeline, deleted with ADR 0019.
const DELETED = [
  'part-finder-lambda.js', 'retrieval.js', 'fit-evidence.js', 'deploy.sh', 'engine/compose.js', 'engine/evidence.js',
  'engine/progression.js', 'engine/presentation.js', 'engine/safety.js', 'engine/intent-vocabulary.js',
  'engine/error-codes.js', 'engine/media-concepts.js', 'knowledge/normal-behaviour.json',
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
  it('is exactly the canonical runtime surface', () => {
    const internal = require('../handler.js')._internal;
    expect(Object.keys(internal).sort()).toEqual([...INTERNAL].sort());
    for (const k of INTERNAL) expect(internal[k], k).not.toBeUndefined();
  });
});

describe('legacy pipeline', () => {
  it('none of its modules exists', () => {
    for (const f of DELETED) expect(existsSync(join(ROOT, f)), f).toBe(false);
  });
});
