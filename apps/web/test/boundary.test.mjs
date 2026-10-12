// The browser talks only to Appliance Clinic: every request is same-origin /api (or the site's own static files).
// The only way off the site toward a shop is a product URL the API returns, rendered as a link (customer.test.mjs).
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const PUBLIC = new URL('../public/', import.meta.url).pathname;
const files = (d) => readdirSync(d).flatMap((n) => (statSync(join(d, n)).isDirectory() ? files(join(d, n)) : [join(d, n)]));
const code = files(PUBLIC).filter((f) => /\.(js|html)$/.test(f)).map((f) => ({ f: f.slice(PUBLIC.length), src: readFileSync(f, 'utf8') }));
// Comments are documentation, not requests.
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"])\/\/[^\n]*/g, '$1').replace(/<!--[\s\S]*?-->/g, '');

describe('API boundary', () => {
  it('no hard-coded S4R host or diagnosis endpoint anywhere in the site', () => {
    for (const { f, src } of code) expect(`${f}: ${strip(src)}`).not.toMatch(/spares4repairs|sparesite|part-finder|65vnizdmk4|mUWucohuX|lambda-url\.|execute-api\./i);
  });
  it('every fetch() goes to the same-origin API base or a site-relative path', () => {
    for (const { f, src } of code.filter((x) => x.f.endsWith('.js'))) {
      for (const m of strip(src).matchAll(/fetch\(\s*([^,)]+)/g)) {
        const target = m[1].trim();
        expect(`${f}: ${target}`).toMatch(/^[^:]+: (API_BASE|API|['"]\/(?!\/)|url\b|path\b|req|request|event\.request|e\.request|base|webmcpOriginBase\(\)|apiUrl|[a-z]+Url\b)/);
      }
    }
  });
  it('absolute URLs in code are limited to the site itself and privacy-enhanced YouTube embeds', () => {
    const allowed = /^https:\/\/(applianceclinic\.ai|www\.youtube-nocookie\.com|schema\.org)(\/|$)/;
    const seen = new Set();
    for (const { src } of code) for (const m of strip(src).matchAll(/https?:\/\/[A-Za-z0-9.-]+/g)) seen.add(m[0]);
    expect([...seen].filter((u) => !allowed.test(`${u}/`))).toEqual([]);
  });
  it('the API base is same-origin /api unless a developer overrides it locally', () => {
    for (const f of ['app.js', 'admin.js']) expect(readFileSync(join(PUBLIC, f), 'utf8')).toMatch(/var API_BASE = window\.WHICHPART_API_BASE \|\| '\/api';/);
  });
});
