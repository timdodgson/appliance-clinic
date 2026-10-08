import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { REPO_ROOT } from '../src/util/files.js';

// Phase 7: AcRuntimeStack = the live capture + infra/cdk/config/runtime-overrides.json (reviewed changes).
const require = createRequire(import.meta.url);
const { applyOverrides } = require(join(REPO_ROOT, 'infra', 'cdk', 'lib', 'overrides.js'));
const live = () => ({
  functions: { f: { configuration: { Environment: { Variables: { A: '1', B: '2' } } } } },
  roles: { r: { inline: { p: { Version: '2012-10-17', Statement: [] } } } },
});

describe('runtime overrides', () => {
  it('sets and unsets environment variables, and replaces code and inline policies', () => {
    const doc = { Version: '2012-10-17', Statement: [{ Effect: 'Allow', Action: ['x:Y'], Resource: '*' }] };
    const out = applyOverrides(live(), { functions: { f: { env: { set: { B: '3', C: '4' }, unset: ['A'] }, code: { s3Bucket: 'b', s3Key: 'k' } } }, rolePolicies: { 'r/p': doc } });
    expect(out.functions.f.configuration.Environment.Variables).toEqual({ B: '3', C: '4' });
    expect(out.functions.f.codeOverride).toEqual({ s3Bucket: 'b', s3Key: 'k' });
    expect(out.roles.r.inline.p).toEqual(doc);
  });
  it('is the desired state: applying it to an already-changed capture changes nothing more', () => {
    const o = { functions: { f: { env: { set: { B: '3' }, unset: ['A'] } } } };
    const once = applyOverrides(live(), o);
    expect(applyOverrides(once, o)).toEqual(once);
  });
  it('never mutates the capture, and refuses unknown functions or roles', () => {
    const l = live();
    applyOverrides(l, { functions: { f: { env: { set: { A: 'x' } } } } });
    expect(l.functions.f.configuration.Environment.Variables.A).toBe('1');
    expect(() => applyOverrides(live(), { functions: { nope: {} } })).toThrow(/unknown function/);
    expect(() => applyOverrides(live(), { rolePolicies: { 'nope/p': {} } })).toThrow(/unknown role/);
  });
  it('the committed overrides name only AC functions and AC roles', () => {
    const o = JSON.parse(readFileSync(join(REPO_ROOT, 'infra', 'cdk', 'config', 'runtime-overrides.json'), 'utf8'));
    const AC_FUNCTIONS = ['whichpart-api', 'spares4repairs-diag-orchestrator', 'spares4repairs-error-code-mcp'];
    for (const f of Object.keys(o.functions)) expect(AC_FUNCTIONS, f).toContain(f);
    for (const k of Object.keys(o.rolePolicies)) expect(['whichpart-api-role', 'diag-orchestrator-role', 'error-code-mcp-role'], k).toContain(k.split('/')[0]);
  });
});
