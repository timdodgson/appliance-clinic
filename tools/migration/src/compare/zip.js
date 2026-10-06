import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import AdmZip from 'adm-zip';

export function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

/** Lambda's CodeSha256 is the base64 SHA-256 of the zip file bytes. */
export function lambdaCodeSha256OfFile(path) {
  return createHash('sha256').update(readFileSync(path)).digest('base64');
}

/** Map of path -> { sha256, size, mode } for every file in a zip. */
export function readZipEntries(path) {
  const zip = new AdmZip(path);
  const files = {};
  for (const e of zip.getEntries()) {
    if (e.isDirectory) continue;
    const data = e.getData();
    const mode = (e.attr >>> 16) & 0o777;
    files[e.entryName] = { sha256: sha256(data), size: data.length, mode: mode || null };
  }
  return files;
}

/** Same shape for a directory tree. */
export function readDirEntries(root, { ignore = ['.git'] } = {}) {
  const files = {};
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      if (ignore.includes(name)) continue;
      const full = join(dir, name);
      const st = statSync(full);
      if (st.isDirectory()) walk(full);
      else files[relative(root, full).split(sep).join('/')] = { sha256: sha256(readFileSync(full)), size: st.size, mode: st.mode & 0o777 };
    }
  };
  walk(root);
  return files;
}

export function readEntries(path) {
  return statSync(path).isDirectory() ? readDirEntries(path) : readZipEntries(path);
}
