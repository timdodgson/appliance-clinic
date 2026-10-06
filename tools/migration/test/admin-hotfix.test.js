import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import vm from 'node:vm';
import AdmZip from 'adm-zip';
import { describe, expect, it } from 'vitest';
import { compareArtifacts } from '../src/compare/build-equivalence.js';
import { lambdaCodeSha256OfFile, readZipEntries } from '../src/compare/zip.js';
import { HotfixRefused, mergeEnvironment, ORIGINAL, parseSubs, patchSource, planHotfix, REPLACEMENT } from '../src/hotfix/admin-allowlist.js';

const ADMIN_SUB = '11111111-2222-4333-8444-555555555555';
const OTHER_SUB = '99999999-2222-4333-8444-555555555555';
const token = (claims) => `h.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.sig`;

// Run a version of isAdminFromAccessToken with the helper it depends on, as it runs in index.js.
function load(fnSource, env = {}) {
  const context = { process: { env }, Buffer, String, Array, JSON };
  vm.createContext(context);
  vm.runInContext(`function b64urlJson(seg) {
    try { const s = seg.replace(/-/g, '+').replace(/_/g, '/'); return JSON.parse(Buffer.from(s, 'base64').toString('utf8')); } catch { return {}; }
  }\n${fnSource}`, context);
  return context.isAdminFromAccessToken;
}

describe('the bug being fixed', () => {
  it('the original check makes any user without groups an admin', () => {
    const isAdmin = load(ORIGINAL);
    expect(isAdmin(token({ sub: OTHER_SUB }))).toBe(true);
  });
});

describe('the patched check', () => {
  const isAdmin = load(REPLACEMENT, { AC_ADMIN_SUBS: `${ADMIN_SUB}, 00000000-0000-4000-8000-000000000000` });

  it('admits an allowlisted sub', () => {
    expect(isAdmin(token({ sub: ADMIN_SUB }))).toBe(true);
  });

  it('denies everyone else, including users claiming an admin group', () => {
    expect(isAdmin(token({ sub: OTHER_SUB }))).toBe(false);
    expect(isAdmin(token({ sub: OTHER_SUB, 'cognito:groups': ['admin'] }))).toBe(false);
    expect(isAdmin(token({}))).toBe(false);
    expect(isAdmin('not-a-token')).toBe(false);
    expect(isAdmin(undefined)).toBe(false);
  });

  it('denies everyone when the allowlist is missing or empty', () => {
    expect(load(REPLACEMENT, {})(token({ sub: ADMIN_SUB }))).toBe(false);
    expect(load(REPLACEMENT, { AC_ADMIN_SUBS: ' , ' })(token({ sub: ADMIN_SUB }))).toBe(false);
  });
});

describe('patchSource', () => {
  const file = `'use strict';\nconst x = 1;\n${ORIGINAL}\nfunction other() {}\n`;

  it('replaces only the admin check', () => {
    const out = patchSource(file);
    expect(out).toContain(REPLACEMENT);
    expect(out).not.toContain("['cognito:groups']");
    expect(out.replace(REPLACEMENT, ORIGINAL)).toBe(file);
  });

  it('preserves CRLF line endings', () => {
    const crlf = file.replace(/\n/g, '\r\n');
    const out = patchSource(crlf);
    expect(out.includes('\r\n')).toBe(true);
    expect(out.replace(/\r\n/g, '\n')).toContain(REPLACEMENT);
  });

  it('refuses code that differs from 13b7a50, duplicates, and repeat patching', () => {
    expect(() => patchSource(file.replace('groups.length ?', 'groups.length > 0 ?'))).toThrow(HotfixRefused);
    expect(() => patchSource(`${file}${ORIGINAL}`)).toThrow(/exactly once/);
    expect(() => patchSource(patchSource(file))).toThrow(/already patched/);
  });
});

describe('patch command on a zip', () => {
  it('changes index.js and nothing else', () => {
    const dir = mkdtempSync(join(tmpdir(), 'achf-'));
    const zip = new AdmZip();
    zip.addFile('index.js', Buffer.from(`const a = 1;\n${ORIGINAL}\n`));
    zip.addFile('cs1.js', Buffer.from('module.exports = {};\n'));
    zip.addFile('knowledge/index.json', Buffer.from('{"k":1}'));
    const original = join(dir, 'original.zip');
    const patched = join(dir, 'patched.zip');
    zip.writeZip(original);
    execFileSync(process.execPath, ['bin/patch-admin-allowlist.mjs', '--in', original, '--out', patched]);
    const r = compareArtifacts(readZipEntries(original), readZipEntries(patched), { allowedDifferences: ['index.js'] });
    expect(r.equivalent).toBe(true);
    expect(r.differing).toEqual(['index.js']);
    expect(lambdaCodeSha256OfFile(original)).not.toBe(lambdaCodeSha256OfFile(patched));
  });
});

describe('inputs', () => {
  it('accepts Cognito subs and rejects anything else, including an empty list', () => {
    expect(parseSubs(` ${ADMIN_SUB} ,${ADMIN_SUB}`)).toEqual([ADMIN_SUB]);
    expect(() => parseSubs('')).toThrow(/locks every admin out/);
    expect(() => parseSubs('tim@example.com')).toThrow(HotfixRefused);
  });

  it('adds the allowlist without touching any other variable', () => {
    const current = { ORCHESTRATOR_TOKEN: 'secret', CANONICAL_MODE: 'off' };
    expect(mergeEnvironment(current, [ADMIN_SUB])).toEqual({ ...current, AC_ADMIN_SUBS: ADMIN_SUB });
    expect(current).toEqual({ ORCHESTRATOR_TOKEN: 'secret', CANONICAL_MODE: 'off' });
  });
});

describe('planHotfix', () => {
  const good = {
    functionName: 'whichpart-api',
    liveCodeSha256: 'abc=',
    expectedCodeSha256: 'abc=',
    originalZipCodeSha256: 'abc=',
    comparison: { equivalent: true, differing: ['index.js'] },
    patchedHasMarker: true,
    subs: [ADMIN_SUB],
  };

  it('plans snapshot, configuration, code, verify in that order', () => {
    expect(planHotfix(good).map((s) => s.step)).toEqual(['PublishVersion', 'UpdateFunctionConfiguration', 'UpdateFunctionCode', 'Verify']);
  });

  it.each([
    ['another function', { functionName: 'spares4repairs-part-finder' }, /only applies/],
    ['a live function changed since the inventory', { liveCodeSha256: 'zzz=' }, /changed since/],
    ['a wrong original zip', { originalZipCodeSha256: 'zzz=' }, /does not match/],
    ['extra differences', { comparison: { equivalent: false, differing: ['index.js', 'cs1.js'] } }, /index.js only/],
    ['an unpatched zip', { patchedHasMarker: false }, /allowlist check/],
  ])('refuses %s', (_label, change, message) => {
    expect(() => planHotfix({ ...good, ...change })).toThrow(message);
  });
});
