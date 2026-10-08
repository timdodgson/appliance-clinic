#!/usr/bin/env node
/**
 * The NoEcho token parameters of a runtime template (infra/cdk/lib/runtime-stack.js), filled from the live capture, as
 * a CloudFormation parameters file. The file holds bearer tokens: it is written mode 0600, passed to create-change-set
 * as file://, and deleted by the caller. Nothing is printed.
 *
 *   node token-params.mjs <template.json> <capture.json> production|sandbox <out.json>
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const [templateFile, captureFile, profile, out] = process.argv.slice(2);
const template = JSON.parse(readFileSync(templateFile, 'utf8'));
const live = JSON.parse(readFileSync(captureFile, 'utf8'));
const names = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'cdk', 'lib', 'sandbox-names.json'), 'utf8'));
const reverse = Object.fromEntries(Object.entries(names).map(([p, s]) => [s, p]));
const prod = (n) => (profile === 'sandbox' ? (reverse[n] || n.replace(/-sbx$/, '')) : n);
const logical = (n) => n.replace(/[^A-Za-z0-9]/g, '');

const values = {};
for (const [name, f] of Object.entries(live.functions)) {
  for (const [k, v] of Object.entries(f.configuration.Environment?.Variables || {})) {
    if (/TOKEN$/.test(k)) values[`Env${logical(prod(name))}${k.replace(/_/g, '')}`] = v;
  }
}
const params = [];
for (const key of Object.keys(template.Parameters || {})) {
  if (key === 'BootstrapVersion') continue;
  if (!(key in values)) throw new Error(`no live value for parameter ${key}`);
  params.push({ ParameterKey: key, ParameterValue: values[key] });
}
writeFileSync(out, JSON.stringify(params), { mode: 0o600 });
console.error(`${params.length} token parameter(s) written`);
