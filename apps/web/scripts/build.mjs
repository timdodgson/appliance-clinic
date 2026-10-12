// Build the static site: public/ -> dist/, plus dist.manifest.json (path, bytes, sha256, content type, cache policy).
//
//   node scripts/build.mjs            (WEBMCP_ORIGIN_TRIAL_TOKEN=<token> to keep the WebMCP origin-trial meta tag)
//
// There is no bundler: files are copied as they are, with these deterministic steps.
//   1. Local script, stylesheet and icon references written `file?v=…` in HTML and in sw.js are rewritten to
//      `file?v=<first 10 hex of the file's sha256>`, so a changed file is a new CloudFront cache key and nobody
//      has to bump version numbers by hand. References with a #fragment (SVG sprites) are left alone. The service
//      worker's cache name is derived from its (rewritten) precache list.
//   2. The WebMCP origin-trial placeholder in index.html is replaced with WEBMCP_ORIGIN_TRIAL_TOKEN, or the meta
//      tag is removed when no token is given (an invalid token must never be served).
//   3. Every local src/href in the HTML must resolve to a file in dist/, or the build fails.
// The same input always gives byte-identical output (the manifest records the hashes).
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, posix, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cachePolicy } from './site-files.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'public');
const DEFAULT_OUT = join(ROOT, 'dist');
const TOKEN_PLACEHOLDER = '__WEBMCP_ORIGIN_TRIAL_TOKEN__';
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

function walk(dir) {
  return readdirSync(dir).sort().flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}
/** Build into `outDir` (default dist/); returns the manifest. */
export function build({ token = process.env.WEBMCP_ORIGIN_TRIAL_TOKEN || '', outDir = DEFAULT_OUT } = {}) {
  const OUT = outDir;
  const keyOf = (abs) => relative(OUT, abs).split(sep).join('/');
  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });
  cpSync(SRC, OUT, { recursive: true });
  const files = walk(OUT);
  const keys = new Set(files.map(keyOf));

  // 1. content-hash cache busting (assets first: their hashes must not depend on the HTML)
  const hashOf = new Map(files.map((f) => [keyOf(f), sha256(readFileSync(f)).slice(0, 10)]));
  const resolve = (fromKey, ref) => (ref.startsWith('/') ? ref.slice(1) : posix.join(posix.dirname(fromKey), ref));
  const VERSIONED = /((?:src|href)=["']|['"])((?:\/|\.\.?\/)?[A-Za-z0-9_./-]+\.(?:js|css|svg|png|webmanifest|json))\?v=[^"'#\s]*(?=["'])/g;
  for (const f of files) {
    const k = keyOf(f);
    if (!/\.html$/.test(k) && k !== 'sw.js') continue;
    const src = readFileSync(f, 'utf8');
    const out = src.replace(VERSIONED, (m, pre, ref) => {
      const target = resolve(k, ref);
      if (!hashOf.has(target)) {
        // a runtime-written file (e.g. /recalls/recalls.js is ours, /media/* is not): leave the reference as written
        return m;
      }
      return `${pre}${ref}?v=${hashOf.get(target)}`;
    });
    if (out !== src) writeFileSync(f, out);
  }

  // The service worker's cache name follows its precache list, so a deploy that changes any precached file
  // replaces the old cache instead of adding to it.
  const swPath = join(OUT, 'sw.js');
  const sw = readFileSync(swPath, 'utf8');
  if (!/var VERSION = '[^']*';/.test(sw)) throw new Error('sw.js: VERSION line missing');
  writeFileSync(swPath, sw.replace(/var VERSION = '[^']*';/, `var VERSION = '${sha256(sw.replace(/var VERSION = '[^']*';/, '')).slice(0, 10)}';`));

  // 2. WebMCP origin-trial token
  const indexPath = join(OUT, 'index.html');
  let index = readFileSync(indexPath, 'utf8');
  if (!index.includes(TOKEN_PLACEHOLDER)) throw new Error('index.html: WebMCP token placeholder missing');
  index = token
    ? index.replace(TOKEN_PLACEHOLDER, token.replace(/[^A-Za-z0-9+/=]/g, ''))
    : index.replace(/\n[ \t]*<meta http-equiv="origin-trial" content="__WEBMCP_ORIGIN_TRIAL_TOKEN__" \/>/, '');
  writeFileSync(indexPath, index);

  // 3. every local reference resolves
  const missing = [];
  for (const f of files.filter((x) => x.endsWith('.html'))) {
    const k = keyOf(f);
    for (const m of readFileSync(f, 'utf8').matchAll(/(?:src|href)="([^"]+)"/g)) {
      const ref = m[1].split('#')[0].split('?')[0];
      if (!ref || /^(?:[a-z]+:|\/\/|#|mailto:)/i.test(m[1]) || ref.startsWith('/api')) continue;
      let target = resolve(k, ref);
      if (target === '' || target.endsWith('/')) target += 'index.html';
      if (target.startsWith('media/') || target.startsWith('recalls/') && !keys.has(target)) continue; // written at runtime by the API
      if (!keys.has(target) && !keys.has(`${target}/index.html`)) missing.push(`${k}: ${m[1]}`);
    }
  }
  if (missing.length) throw new Error(`unresolved local references:\n  ${missing.join('\n  ')}`);

  const manifest = walk(OUT).map((f) => {
    const k = keyOf(f); const buf = readFileSync(f);
    return { key: k, bytes: buf.length, sha256: sha256(buf), ...cachePolicy(k) };
  });
  writeFileSync(`${OUT}.manifest.json`, `${JSON.stringify({ files: manifest }, null, 1)}\n`);
  return manifest;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const m = build();
  const total = m.reduce((a, f) => a + f.bytes, 0);
  console.log(`built ${m.length} files (${(total / 1024).toFixed(0)} KiB) into ${relative(process.cwd(), DEFAULT_OUT) || '.'}; manifest ${relative(process.cwd(), `${DEFAULT_OUT}.manifest.json`)}`);
  if (!existsSync(join(DEFAULT_OUT, 'index.html'))) process.exit(1);
}
