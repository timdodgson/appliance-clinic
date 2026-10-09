/**
 * Phase 8: the prompt registry (prompts/registry.json). Every prompt has a stable id, a version and a changelog, and its
 * current source matches its latest version. Changing a prompt therefore means adding a version: bump `version`, append
 * a changelog entry with the new fingerprint (`node prompts/fingerprint.mjs` prints it) and what changed, and evaluate
 * the change before release.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, registry, fingerprint, declaration } from './fingerprint.mjs';

const { prompts } = registry();

describe('prompt registry', () => {
  it('has unique, stable ids', () => {
    const ids = prompts.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^[a-z0-9-]+(\.[a-z0-9-]+)+$/);
  });

  it.each(prompts.map((p) => [p.id, p]))('%s is documented and versioned', (_, p) => {
    for (const k of ['purpose', 'owner', 'input', 'output']) expect(typeof p[k] === 'string' && p[k].length > 10, k).toBe(true);
    expect(p.consumers.length).toBeGreaterThan(0);
    expect(p.changelog.map((c) => c.version)).toEqual(p.changelog.map((_, i) => i + 1));
    expect(p.version).toBe(p.changelog.length);
    for (const c of p.changelog) expect(c.date).toMatch(/^\d{4}-\d\d-\d\d$/);
    for (const s of p.source) expect(existsSync(join(ROOT, s.file)), s.file).toBe(true);
  });

  it.each(prompts.map((p) => [p.id, p]))('%s matches its latest version', (_, p) => {
    const latest = p.changelog[p.changelog.length - 1];
    expect(fingerprint(p), `${p.id} changed since v${p.version}: add a version (see prompts/README.md)`).toBe(latest.fingerprint);
  });

  it.each(prompts.filter((p) => p.runtimeVersion).map((p) => [p.id, p]))('%s records the runtime version the code reports', (_, p) => {
    const { file, constant, value } = p.runtimeVersion;
    expect(declaration(readFileSync(join(ROOT, file), 'utf8'), constant, file)).toContain(`'${value}'`);
  });
});
