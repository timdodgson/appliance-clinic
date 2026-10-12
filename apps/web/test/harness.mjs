// Loads a page from public/ into jsdom, runs its scripts in order (as the browser would, no bundler) and routes
// fetch() to a test double. Nothing leaves the process.
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

const PUBLIC = new URL('../public/', import.meta.url);
const read = (p) => readFileSync(new URL(p, PUBLIC), 'utf8');

/**
 * @param {string} page  e.g. 'index.html'
 * @param {string[]} scripts  files under public/, in load order
 * @param {(url: string, init: any) => any} api  returns { status, body } | Promise thereof, or throws (network error)
 * @param {{ hash?: string }} [opts]  initial location hash (admin routes)
 */
export function loadPage(page, scripts, api, { hash = '' } = {}) {
  const html = read(page).replace(/<script\b[^>]*\bsrc=[^>]*><\/script>/g, '');
  const dom = new JSDOM(html, { url: 'https://applianceclinic.ai/' + (page === 'index.html' ? '' : page) + hash, runScripts: 'outside-only', pretendToBeVisual: true });
  const { window } = dom;
  const calls = [];
  // jsdom has no fetch: Node's Response stands in (the scripts only use ok, status and json()).
  window.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init, body: init.body ? JSON.parse(init.body) : null });
    const r = await api(String(url), init);
    return new Response(JSON.stringify(r.body ?? {}), { status: r.status ?? 200, headers: { 'content-type': 'application/json' } });
  };
  window.scrollTo = () => {};
  window.HTMLElement.prototype.scrollIntoView = () => {};
  if (!window.matchMedia) window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
  const errors = [];
  window.addEventListener('error', (e) => errors.push(e.error || e.message));
  for (const s of scripts) window.eval(read(s));
  window.document.dispatchEvent(new window.Event('DOMContentLoaded'));
  return { window, document: window.document, calls, errors };
}

/** Let pending promises and timers (setTimeout 0) run. */
export async function settle(window, rounds = 8) {
  for (let i = 0; i < rounds; i += 1) await new Promise((r) => window.setTimeout(r, 0));
}
