#!/usr/bin/env node
/**
 * Runs every runtime test: the imported suites (docs/migration/import-manifest-phase-2b.json) and the tests added with
 * later runtime changes (docs/migration/runtime-changes.json). Every test must pass.
 *
 *   node build/test/run-tests.mjs [--only <substring>] [--out <file>]
 *
 * Each test runs in its own process with the runner it was written for: plain Node script,
 * `node --test`, vitest, or Python (pytest or a plain script). Python tests run in the virtualenv of
 * the image they belong to: `.venv-orchestrator` for orchestration/, `.venv-error-code-mcp` for
 * error-codes/ (override with PYTHON_ORCHESTRATOR / PYTHON_ERROR_CODE_MCP).
 *
 * Tests never get real credentials or a proxy: AWS variables are replaced with fake values and proxy
 * variables are removed, so nothing can reach or change production.
 *
 * Exit code 1 if any test fails.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const args = process.argv.slice(2);
const flag = (name) => { const i = args.indexOf(name); return i === -1 ? null : args[i + 1]; };

const manifest = JSON.parse(readFileSync(join(ROOT, 'docs/migration/import-manifest-phase-2b.json'), 'utf8'));
const only = flag('--only');
// Phase 7 onwards: tests added with deliberate runtime changes (docs/migration/runtime-changes.json) run too.
const changes = JSON.parse(readFileSync(join(ROOT, 'docs/migration/runtime-changes.json'), 'utf8'));
// Imported files deliberately removed (dead code, or tests of removed behaviour) are not run.
const removed = new Set((changes.removed || []).map((f) => f.path));
const tests = [...manifest.files, ...changes.added].filter((f) => !removed.has(f.path)).filter((f) => f.role === 'test').map((f) => f.path).filter((p) => !only || p.includes(only));

const python = (path) => (path.startsWith('orchestration/')
  ? process.env.PYTHON_ORCHESTRATOR || join(ROOT, '.venv-orchestrator/bin/python')
  : process.env.PYTHON_ERROR_CODE_MCP || join(ROOT, '.venv-error-code-mcp/bin/python'));

function commandFor(path) {
  const src = readFileSync(join(ROOT, path), 'utf8');
  if (path.endsWith('.py')) return /^def test_/m.test(src) ? [python(path), ['-m', 'pytest', '-q', path]] : [python(path), [path]];
  if (/from ['"]vitest['"]|require\(['"]vitest['"]\)/.test(src)) return [join(ROOT, 'node_modules/.bin/vitest'), ['run', '--config', 'build/test/vitest.config.mjs', path]];
  if (src.includes('node:test')) return [process.execPath, ['--test', path]];
  return [process.execPath, [path]];
}

// error-codes/mcp/deploy/tests/test_auth.py runs the MCP server from error-codes/mcp/.venv, a path it
// hard-codes. Point that path at the MCP test environment (gitignored) instead of editing the test.
const mcpVenv = join(ROOT, 'error-codes/mcp/.venv');
let mcpVenvExists = false;
try { lstatSync(mcpVenv); mcpVenvExists = true; } catch { /* absent */ }
if (!mcpVenvExists && existsSync(join(ROOT, '.venv-error-code-mcp'))) symlinkSync('../../.venv-error-code-mcp', mcpVenv);

const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(AWS_|HTTPS?_PROXY$|NO_PROXY$|GLOBAL_AGENT|NODE_USE_ENV_PROXY)/i.test(k)));
Object.assign(env, {
  AWS_ACCESS_KEY_ID: 'AKIAFAKEFAKEFAKEFAKE', AWS_SECRET_ACCESS_KEY: 'fake', AWS_REGION: 'eu-west-1',
  AWS_EC2_METADATA_DISABLED: 'true', NODE_NO_WARNINGS: '1', PYTHONPATH: `${ROOT}:${join(ROOT, 'error-codes')}`,
});

const results = {};
for (const path of tests) {
  const [cmd, cmdArgs] = commandFor(path);
  const started = Date.now();
  const r = spawnSync(cmd, cmdArgs, { cwd: ROOT, env, encoding: 'utf8', timeout: 180_000, maxBuffer: 64 * 1024 * 1024 });
  const out = `${r.stdout || ''}${r.stderr || ''}`.trim().split('\n');
  const passed = r.status === 0;
  results[path] = { passed, status: r.status, signal: r.signal, ms: Date.now() - started, tail: out.slice(-3).join('\n').slice(0, 400) };
  process.stdout.write(`${passed ? 'pass' : 'FAIL'}  ${path}\n`);
}

const failures = Object.keys(results).filter((p) => !results[p].passed);
const summary = { tests: tests.length, passed: tests.length - failures.length, failed: failures.length, failures };
if (flag('--out')) writeFileSync(flag('--out'), JSON.stringify({ summary, results }, null, 2));
for (const p of failures) console.log(`\nFAILED: ${p}\n${results[p].tail}`);
console.log(failures.length ? `\n${summary.failed} of ${summary.tests} runtime test files FAILED.` : `\nruntime tests: ALL PASS (${summary.tests} of ${summary.tests}).`);
process.exitCode = failures.length ? 1 : 0;
