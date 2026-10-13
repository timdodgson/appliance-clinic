import { createRequire } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
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
  it('records an image override (by digest) for an image function', () => {
    const uri = '800960611664.dkr.ecr.eu-west-1.amazonaws.com/repo@sha256:' + 'a'.repeat(64);
    expect(applyOverrides(live(), { functions: { f: { code: { imageUri: uri } } } }).functions.f.codeOverride).toEqual({ imageUri: uri });
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
  it('removes or replaces a Function URL CORS, and records permission overrides (Phase 7)', () => {
    const l = live(); l.functions.f.url = { AuthType: 'NONE', Cors: { AllowOrigins: ['*'] } };
    expect(applyOverrides(l, { functions: { f: { url: { cors: null } } } }).functions.f.url.Cors).toBeNull();
    expect(applyOverrides(l, { functions: { f: { url: { cors: { AllowOrigins: ['https://a.example'] } } } } }).functions.f.url.Cors).toEqual({ AllowOrigins: ['https://a.example'] });
    expect(applyOverrides(l, { functions: { f: {} } }).functions.f.url.Cors).toEqual({ AllowOrigins: ['*'] });
    expect(() => applyOverrides(live(), { functions: { f: { url: { cors: null } } } })).toThrow(/no Function URL/);
    expect(applyOverrides(l, { functions: { f: { permissions: { PublicInvoke: { invokedViaFunctionUrl: true } } } } }).functions.f.permissionOverrides).toEqual({ PublicInvoke: { invokedViaFunctionUrl: true } });
  });
  it('maps a statement CloudFormation created back to its imported id, so logical IDs stay stable', () => {
    const { importedSid } = require(join(REPO_ROOT, 'infra', 'cdk', 'lib', 'overrides.js'));
    expect(importedSid('PublicInvoke', 'AcRuntimeStack', 'whichpartapi')).toBe('PublicInvoke');
    expect(importedSid('AcRuntimeStack-whichpartapiPublicInvoke-Ab12Cd34', 'AcRuntimeStack', 'whichpartapi')).toBe('PublicInvoke');
    expect(importedSid('AcRuntimeStack-otherfnPublicInvoke-Ab12Cd34', 'AcRuntimeStack', 'whichpartapi')).toBe('AcRuntimeStack-otherfnPublicInvoke-Ab12Cd34');
    expect(importedSid('OtherStack-whichpartapiPublicInvoke-Ab12', 'AcRuntimeStack', 'whichpartapi')).toBe('OtherStack-whichpartapiPublicInvoke-Ab12');
  });
  it('replaces the managed policy list of a role exactly, and refuses unknown roles', () => {
    const l = live(); l.roles.r.managed = ['arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole'];
    expect(applyOverrides(l, { roleManagedPolicies: { r: [] } }).roles.r.managed).toEqual([]);
    expect(l.roles.r.managed).toHaveLength(1);
    expect(() => applyOverrides(l, { roleManagedPolicies: { nope: [] } })).toThrow(/unknown role/);
    expect(() => applyOverrides(l, { roleManagedPolicies: { r: 'x' } })).toThrow(/must be a list/);
  });
  it('adds a role the stack creates, and sets a function role', () => {
    const trust = { Version: '2012-10-17', Statement: [] };
    const out = applyOverrides(live(), { roles: { newrole: { trust, managed: [], inline: { a: { Version: '2012-10-17', Statement: [] } } } }, functions: { f: { role: 'arn:aws:iam::1:role/newrole' } } });
    expect(out.roles.newrole).toMatchObject({ trust, managed: [], path: '/', maxSessionDuration: 3600, stackCreated: true });
    expect(Object.keys(out.roles.newrole.inline)).toEqual(['a']);
    expect(out.functions.f.configuration.Role).toBe('arn:aws:iam::1:role/newrole');
    expect(() => applyOverrides(live(), { roles: { bad: { trust } } })).toThrow(/needs trust, managed and inline/);
  });
  it('the committed overrides name only AC functions and AC roles', () => {
    const o = JSON.parse(readFileSync(join(REPO_ROOT, 'infra', 'cdk', 'config', 'runtime-overrides.json'), 'utf8'));
    // The former shared engine spares4repairs-part-finder and its role ac-diagnosis-role are no longer AC's (change 15.3).
    const AC_FUNCTIONS = ['whichpart-api', 'spares4repairs-diag-orchestrator', 'spares4repairs-error-code-mcp',
      'applianceclinic-diagnosis-engine'];
    for (const f of Object.keys(o.functions)) expect(AC_FUNCTIONS, f).toContain(f);
    const AC_ROLES = ['whichpart-api-role', 'diag-orchestrator-role', 'error-code-mcp-role', 'ac-diagnosis-engine-role'];
    for (const k of Object.keys(o.roles || {})) expect(['ac-diagnosis-engine-role'], k).toContain(k);
    for (const k of Object.keys(o.roleManagedPolicies || {})) expect(AC_ROLES, k).toContain(k);
    for (const k of Object.keys(o.rolePolicies)) expect(AC_ROLES, k).toContain(k.split('/')[0]);
    // Never the S4R role, in any form.
    expect(JSON.stringify(o.roles || {}) + JSON.stringify(o.rolePolicies) + JSON.stringify(o.roleManagedPolicies || {})).not.toMatch(/SparesSite/);
  });
  it('builds a function the stack creates from its declaration, carrying a digest-declared value (ADR 0019)', () => {
    const { createHash } = require('node:crypto');
    const h = (v) => `sha256:${createHash('sha256').update(v).digest('hex')}`;
    const l = live(); l.functions.f.configuration.Environment.Variables.PRIVATE = 'tunnel';
    const create = { role: 'arn:aws:iam::1:role/r', runtime: 'nodejs22.x', handler: 'handler.handler', architectures: ['x86_64'],
      memorySize: 256, timeout: 300, url: { authType: 'AWS_IAM', invokeMode: 'BUFFERED' }, carryFrom: 'f' };
    const o = { functions: { g: { create, code: { s3Bucket: 'b', s3Key: 'k' }, env: { set: { A: 'x' }, digests: { PRIVATE: h('tunnel') } } } } };
    const g = applyOverrides(l, o).functions.g;
    expect(g.configuration).toMatchObject({ Role: create.role, Runtime: 'nodejs22.x', Handler: 'handler.handler', PackageType: 'Zip' });
    expect(g.configuration.Environment.Variables).toEqual({ A: 'x', PRIVATE: 'tunnel' });
    expect(g.url).toEqual({ AuthType: 'AWS_IAM', InvokeMode: 'BUFFERED', Cors: null });
    expect(g.statements).toEqual([]);
    expect(g.codeOverride).toEqual({ s3Bucket: 'b', s3Key: 'k' });
    // once it exists, its own live values are carried and undeclared live variables do not survive
    const l2 = applyOverrides(l, o); l2.functions.g.configuration.Environment.Variables.EXTRA = '1';
    expect(applyOverrides(l2, o).functions.g.configuration.Environment.Variables).toEqual({ A: 'x', PRIVATE: 'tunnel' });
    const bad = { functions: { g: { ...o.functions.g, env: { set: {}, digests: { PRIVATE: h('other') } } } } };
    expect(() => applyOverrides(l, bad)).toThrow(/does not match its declared digest/);
    const none = { functions: { g: { ...o.functions.g, create: { ...create, carryFrom: undefined } } } };
    expect(() => applyOverrides(l, none)).toThrow(/no live value to carry/);
    expect(() => applyOverrides(l, { functions: { g: { create: { role: 'r' } } } })).toThrow(/needs runtime/);
  });

  // ADR 0022: applianceclinic-error-code-mcp, a Zip function run by the Lambda Web Adapter layer behind a public URL.
  const LWA = 'arn:aws:lambda:eu-west-1:753240598075:layer:LambdaAdapterLayerArm64:22';
  const urlStatements = [
    { Sid: 'FunctionURLAllowPublicAccess', Effect: 'Allow', Principal: '*', Action: 'lambda:InvokeFunctionUrl',
      Condition: { StringEquals: { 'lambda:FunctionUrlAuthType': 'NONE' } } },
    { Sid: 'FunctionURLInvokeAllowPublicAccess', Effect: 'Allow', Principal: '*', Action: 'lambda:InvokeFunction',
      Condition: { Bool: { 'lambda:InvokedViaFunctionUrl': 'true' } } },
  ];
  const zipCreate = { role: 'arn:aws:iam::800960611664:role/error-code-mcp-role', runtime: 'python3.12', handler: 'run.sh',
    architectures: ['arm64'], memorySize: 1024, timeout: 30, url: { authType: 'NONE', invokeMode: 'BUFFERED' },
    layers: [LWA], statements: urlStatements, resources: ['logs', 'function'] };
  it('builds a created Zip function with layers and its URL statements (ADR 0022)', () => {
    const o = { functions: { g: { create: zipCreate, code: { s3Bucket: 'b', s3Key: 'k' },
      env: { set: { AWS_LAMBDA_EXEC_WRAPPER: '/opt/bootstrap', AWS_LWA_PORT: '8080' } } } } };
    const g = applyOverrides(live(), o).functions.g;
    expect(g.configuration).toMatchObject({ PackageType: 'Zip', Runtime: 'python3.12', Handler: 'run.sh', Architectures: ['arm64'], Layers: [{ Arn: LWA }] });
    expect(g.configuration.Environment.Variables).toEqual({ AWS_LAMBDA_EXEC_WRAPPER: '/opt/bootstrap', AWS_LWA_PORT: '8080' });
    expect(g.url).toEqual({ AuthType: 'NONE', InvokeMode: 'BUFFERED', Cors: null });
    expect(g.statements).toEqual(urlStatements);
    expect(g.statements).not.toBe(urlStatements);
    // without layers or statements, a created function has neither
    const plain = applyOverrides(live(), { functions: { g: { create: { ...zipCreate, layers: undefined, statements: undefined } } } }).functions.g;
    expect(plain.configuration.Layers).toBeUndefined();
    expect(plain.statements).toEqual([]);
    expect(() => applyOverrides(live(), { functions: { g: { create: { ...zipCreate, layers: ['LambdaAdapterLayerArm64'] } } } })).toThrow(/layer version ARNs/);
    expect(() => applyOverrides(live(), { functions: { g: { create: { ...zipCreate, statements: [{ Sid: 'x' }] } } } })).toThrow(/needs Sid, Action and Principal/);
  });
  const cdkLib = join(REPO_ROOT, 'infra', 'cdk', 'node_modules', 'aws-cdk-lib');
  // Synthesis needs infra/cdk's own dependencies (npm ci --prefix infra/cdk); skipped where they are not installed.
  it.skipIf(!existsSync(cdkLib))('synthesizes the created Zip function with its layer, and its statements after it (ADR 0022)', () => {
    const cdk = require(cdkLib);
    const { RuntimeStack } = require(join(REPO_ROOT, 'infra', 'cdk', 'lib', 'runtime-stack.js'));
    const { mkdtempSync, writeFileSync } = require('node:fs');
    const { tmpdir } = require('node:os');
    const role = { trust: { Version: '2012-10-17', Statement: [] }, path: '/', maxSessionDuration: 3600, description: null, boundary: null, tags: [], managed: [], inline: {} };
    const path = join(mkdtempSync(join(tmpdir(), 'ecz-')), 'live.json');
    writeFileSync(path, JSON.stringify({ roles: { 'error-code-mcp-role': role }, functions: {}, rules: {} }));
    const app = new cdk.App({ analyticsReporting: false });
    const overrides = { functions: { 'applianceclinic-error-code-mcp': { create: zipCreate, code: { s3Bucket: 'b', s3Key: 'k' },
      env: { set: { AWS_LAMBDA_EXEC_WRAPPER: '/opt/bootstrap', AWS_LWA_PORT: '8080' } } } } };
    const stack = new RuntimeStack(app, 'AcRuntimeStack', { env: { account: '800960611664', region: 'eu-west-1' },
      synthesizer: new cdk.BootstraplessSynthesizer(), step: '5.10', profile: 'production', live: path, overrides });
    const r = app.synth().getStackByName(stack.stackName).template.Resources;
    const fid = 'applianceclinicerrorcodemcp';
    expect(r[fid].Properties).toMatchObject({ FunctionName: 'applianceclinic-error-code-mcp', PackageType: 'Zip', Runtime: 'python3.12',
      Handler: 'run.sh', Architectures: ['arm64'], Layers: [LWA], Code: { S3Bucket: 'b', S3Key: 'k' } });
    expect(r[fid].DependsOn).toEqual(expect.arrayContaining(['errorcodemcprole', `${fid}Logs`]));
    expect(r[`${fid}Url`].Properties).toMatchObject({ AuthType: 'NONE', InvokeMode: 'BUFFERED' });
    expect(r[`${fid}FunctionURLAllowPublicAccess`].Properties).toEqual({ FunctionName: 'applianceclinic-error-code-mcp',
      Action: 'lambda:InvokeFunctionUrl', Principal: '*', FunctionUrlAuthType: 'NONE' });
    expect(r[`${fid}FunctionURLInvokeAllowPublicAccess`].Properties).toEqual({ FunctionName: 'applianceclinic-error-code-mcp',
      Action: 'lambda:InvokeFunction', Principal: '*', InvokedViaFunctionUrl: true });
    for (const sid of ['FunctionURLAllowPublicAccess', 'FunctionURLInvokeAllowPublicAccess']) {
      expect(r[`${fid}${sid}`].DependsOn).toContain(fid);
      expect(r[`${fid}${sid}`].DeletionPolicy).toBe('Retain');
    }
    // logs and function only: no metric filters or alarms
    expect(Object.keys(r).filter((k) => k.startsWith(fid)).sort()).toEqual([fid, `${fid}FunctionURLAllowPublicAccess`,
      `${fid}FunctionURLInvokeAllowPublicAccess`, `${fid}Logs`, `${fid}Url`].sort());
  });
});
