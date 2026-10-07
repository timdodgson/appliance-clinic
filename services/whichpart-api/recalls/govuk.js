'use strict';

/**
 * Official GOV.UK Search + Content API client.
 * Only https://www.gov.uk/api/search.json and https://www.gov.uk/api/content/...
 * No HTML listing scrape. No arbitrary URL fetch (SSRF).
 */

const { SOURCE_CATEGORIES } = require('./classify');
const { ALLOWED_CONTENT_PREFIX } = require('./parse');

const SEARCH_URL = 'https://www.gov.uk/api/search.json';
const CONTENT_URL = 'https://www.gov.uk/api/content';
const UA = 'ApplianceClinicRecallCentre/1.0 (+https://applianceclinic.ai/recalls/)';

function assertGovHost(u) {
  const url = new URL(u);
  if (url.protocol !== 'https:') throw new Error('govuk-https-only');
  if (url.hostname !== 'www.gov.uk') throw new Error('govuk-host');
  return url;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function getJson(url, fetchFn) {
  assertGovHost(url);
  const fn = fetchFn || globalThis.fetch;
  let last = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fn(url, {
        method: 'GET',
        headers: { accept: 'application/json', 'user-agent': UA },
      });
      const text = await res.text();
      let json = null;
      try { json = text ? JSON.parse(text) : {}; } catch {
        throw new Error('govuk-invalid-json');
      }
      if (res.ok) return json;
      const err = new Error('govuk-http-' + res.status);
      err.status = res.status;
      err.body = json;
      last = err;
      if (res.status === 429 || res.status >= 500) {
        await sleep(400 * (attempt + 1));
        continue;
      }
      throw err;
    } catch (e) {
      last = e;
      if (attempt < 2 && (!e.status || e.status === 429 || e.status >= 500)) {
        await sleep(400 * (attempt + 1));
        continue;
      }
      throw e;
    }
  }
  throw last || new Error('govuk-fetch');
}

function searchUrl(params) {
  const u = new URL(SEARCH_URL);
  Object.keys(params).forEach((k) => {
    const v = params[k];
    if (v == null || v === '') return;
    u.searchParams.set(k, String(v));
  });
  return u.toString();
}

async function searchPage(opts) {
  const params = {
    filter_format: 'product_safety_alert_report_recall',
    count: String(Math.min(100, opts.count || 100)),
    start: String(opts.start || 0),
    order: opts.order || '-public_timestamp',
    fields: 'title,link,description,public_timestamp',
  };
  if (opts.category) params.filter_product_category = opts.category;
  if (opts.q) params.q = opts.q;
  if (opts.from) params.filter_public_timestamp = 'from:' + opts.from;
  return getJson(searchUrl(params), opts.fetch);
}

async function listIndex(opts) {
  const fetchFn = opts && opts.fetch;
  const from = opts && opts.from;
  const cats = (opts && opts.categories) || SOURCE_CATEGORIES;
  const out = [];
  const seen = Object.create(null);
  for (const category of cats) {
    let start = 0;
    for (;;) {
      const page = await searchPage({ category, start, count: 100, from, fetch: fetchFn });
      const results = page.results || [];
      for (const r of results) {
        const link = r.link;
        if (!link || seen[link]) continue;
        if (String(link).indexOf(ALLOWED_CONTENT_PREFIX) !== 0) continue;
        seen[link] = true;
        out.push({
          basePath: link,
          title: r.title || '',
          description: r.description || '',
          publicTimestamp: r.public_timestamp || null,
          sourceCategory: category,
        });
      }
      start += results.length;
      if (!results.length || start >= (page.total || 0) || start >= 5000) break;
    }
  }
  return out;
}

function contentUrl(basePath) {
  if (!basePath || basePath.indexOf(ALLOWED_CONTENT_PREFIX) !== 0) {
    throw new Error('govuk-path');
  }
  if (basePath.indexOf('..') !== -1) throw new Error('govuk-path');
  return CONTENT_URL + basePath;
}

async function getContent(basePath, fetchFn) {
  return getJson(contentUrl(basePath), fetchFn);
}

async function mapPool(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  async function worker() {
    for (;;) {
      const idx = i++;
      if (idx >= items.length) return;
      out[idx] = await fn(items[idx], idx);
    }
  }
  const n = Math.min(limit, items.length) || 1;
  await Promise.all(Array.from({ length: n }, () => worker()));
  return out;
}

module.exports = {
  listIndex,
  getContent,
  searchPage,
  SEARCH_URL,
  CONTENT_URL,
  mapPool,
};
