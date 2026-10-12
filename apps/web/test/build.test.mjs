// The build is reproducible, busts caches by content, handles the WebMCP token safely and refuses broken references.
import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build } from '../scripts/build.mjs';

async function buildInto(dir, token) {
  const manifest = build({ token, outDir: dir });
  return { manifest, read: (k) => readFileSync(join(dir, k), 'utf8') };
}
const tmp = () => join(mkdtempSync(join(tmpdir(), 'acweb-')), 'dist');

describe('build', () => {
  it('is deterministic', async () => {
    const a = await buildInto(tmp(), ''); const b = await buildInto(tmp(), '');
    expect(a.manifest).toEqual(b.manifest);
    expect(a.manifest.length).toBeGreaterThan(40);
  });
  it('versions local scripts and styles by content hash, in the pages and the service worker', async () => {
    const { manifest, read } = await buildInto(tmp(), '');
    const app = manifest.find((f) => f.key === 'app.js');
    expect(read('index.html')).toContain(`src="app.js?v=${app.sha256.slice(0, 10)}"`);
    expect(read('sw.js')).toContain(`'/app.js?v=${app.sha256.slice(0, 10)}'`);
    expect(read('sw.js')).toMatch(/var VERSION = '[0-9a-f]{10}';/);
  });
  it('removes the WebMCP origin-trial tag without a token, and inserts a given one', async () => {
    const none = await buildInto(tmp(), '');
    expect(none.read('index.html')).not.toMatch(/http-equiv="origin-trial"/);
    const withToken = await buildInto(tmp(), 'AbC123+/=');
    expect(withToken.read('index.html')).toContain('<meta http-equiv="origin-trial" content="AbC123+/=" />');
  });
  it('gives every file the cache policy the live site serves', async () => {
    const { manifest } = await buildInto(tmp(), '');
    const by = Object.fromEntries(manifest.map((f) => [f.key, f]));
    expect(by['index.html']).toMatchObject({ contentType: 'text/html; charset=utf-8', cacheControl: 'max-age=60, must-revalidate' });
    expect(by['app.js']).toMatchObject({ contentType: 'text/javascript; charset=utf-8', cacheControl: 'max-age=300' });
    expect(by['sw.js'].cacheControl).toBe('max-age=0, must-revalidate');
    expect(by['assets/admin-icons.svg']).toMatchObject({ contentType: 'image/svg+xml', cacheControl: 'max-age=86400' });
  });
  it('never contains runtime-written content (media, recall pages)', async () => {
    const { manifest } = await buildInto(tmp(), '');
    expect(manifest.filter((f) => f.key.startsWith('media/') || (f.key.startsWith('recalls/') && f.key !== 'recalls/recalls.js'))).toEqual([]);
  });
});
