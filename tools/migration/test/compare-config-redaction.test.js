import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { diffValues, redactEnvironmentDifferences } from '../src/compare/config-diff.js';
import { sha256Hex } from '../src/redact.js';

// Synthetic values only. Each is something compare:config must never print.
const PLAIN_ID = '0b5e7a64-0000-4000-8000-feedfacecafe';
const PLAIN_URL = 'https://example.invalid/plain-endpoint';
const PLAIN_MODE = 'plain-mode-value';
const PLAIN_ADDED = 'value-of-a-new-variable';
const PLAINTEXT = [PLAIN_ID, PLAIN_URL, PLAIN_MODE, PLAIN_ADDED];

const fn = (vars) => [{ name: 'fn', exists: true, configuration: { Runtime: 'nodejs20.x', Environment: { Variables: vars } } }];
const before = fn({ ADMIN_SUBS: PLAIN_ID, SERVICE_URL: PLAIN_URL, MODE: PLAIN_MODE });
const after = fn({ ADMIN_SUBS: `${PLAIN_ID}x`, SERVICE_URL: PLAIN_URL, MODE: 'other', NEW_VAR: PLAIN_ADDED });

describe('compare:config environment redaction', () => {
  it('keeps variable names and change kind but replaces every value with a digest', () => {
    const out = redactEnvironmentDifferences(diffValues(before, after));
    const byPath = Object.fromEntries(out.map((d) => [d.path, d]));
    expect(Object.keys(byPath).sort()).toEqual([
      '[name=fn].configuration.Environment.Variables.ADMIN_SUBS',
      '[name=fn].configuration.Environment.Variables.MODE',
      '[name=fn].configuration.Environment.Variables.NEW_VAR',
    ]);
    expect(byPath['[name=fn].configuration.Environment.Variables.ADMIN_SUBS'].before).toEqual({ redacted: true, sha256: sha256Hex(PLAIN_ID), length: PLAIN_ID.length });
    expect(byPath['[name=fn].configuration.Environment.Variables.NEW_VAR'].before).toBeNull();
    expect(byPath['[name=fn].configuration.Environment.Variables.NEW_VAR'].after).toMatchObject({ redacted: true, length: PLAIN_ADDED.length });
    const text = JSON.stringify(out);
    for (const p of PLAINTEXT) expect(text).not.toContain(p);
  });

  it('redacts a whole Environment object added or removed in one go', () => {
    const out = redactEnvironmentDifferences(diffValues([{ configuration: {} }], [{ configuration: { Environment: { Variables: { A: PLAIN_MODE } } } }]));
    expect(out).toHaveLength(1);
    expect(out[0].after).toEqual({ Variables: { A: { redacted: true, sha256: sha256Hex(PLAIN_MODE), length: PLAIN_MODE.length } } });
  });

  it('redacts Environment nested inside a larger difference, such as a function added', () => {
    const out = redactEnvironmentDifferences(diffValues([], after));
    const text = JSON.stringify(out);
    for (const p of PLAINTEXT) expect(text).not.toContain(p);
    expect(text).toContain('nodejs20.x');
    expect(text).toContain('NEW_VAR');
  });

  it('leaves non-environment differences and already-redacted values untouched', () => {
    const digest = { redacted: true, sha256: 'a'.repeat(64), length: 4 };
    const out = redactEnvironmentDifferences([
      { path: '[0].configuration.Runtime', before: 'nodejs18.x', after: 'nodejs20.x' },
      { path: '[0].configuration.Environment.Variables.TOKEN', before: digest, after: digest },
    ]);
    expect(out[0]).toEqual({ path: '[0].configuration.Runtime', before: 'nodejs18.x', after: 'nodejs20.x' });
    expect(out[1].before).toBe(digest);
  });

  it('never prints or writes an environment value from the CLI', () => {
    const root = mkdtempSync(join(tmpdir(), 'compare-config-'));
    const a = join(root, 'a');
    const b = join(root, 'b');
    mkdirSync(a);
    mkdirSync(b);
    writeFileSync(join(a, 'lambda-functions.json'), JSON.stringify(before));
    writeFileSync(join(b, 'lambda-functions.json'), JSON.stringify(after));
    const out = join(root, 'report.json');
    const bin = fileURLToPath(new URL('../bin/compare-config.mjs', import.meta.url));
    const run = spawnSync(process.execPath, [bin, a, b, '--out', out], { encoding: 'utf8' });
    expect(run.status).toBe(1); // drift found
    const printed = run.stdout + run.stderr;
    const written = readFileSync(out, 'utf8');
    for (const p of PLAINTEXT) {
      expect(printed).not.toContain(p);
      expect(written).not.toContain(p);
    }
    expect(printed).toContain('Environment.Variables.ADMIN_SUBS');
    expect(printed).toContain('Environment.Variables.NEW_VAR');
    expect(printed).toContain('3 configuration difference(s).');
    // Sanity: the same inputs do contain the plaintext, so the assertions above are meaningful.
    expect(readFileSync(join(b, 'lambda-functions.json'), 'utf8')).toContain(PLAIN_ADDED);
  });
});
