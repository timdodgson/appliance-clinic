import { join } from 'node:path';
import { readJson, TOOL_ROOT } from './util/files.js';

export function loadResourceConfig(path = join(TOOL_ROOT, 'config', 'resources.json')) {
  return readJson(path);
}

export function loadKnownS4R(path = join(TOOL_ROOT, 'config', 's4r-known.json')) {
  return readJson(path).entries;
}

/** Replace {account} placeholders in resource names. */
export function withAccount(name, accountId) {
  return String(name).replaceAll('{account}', accountId);
}
