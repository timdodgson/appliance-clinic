/**
 * Catalogue API client: parts for a model, catalogue search, and the HTTP helpers they use.
 */
const https = require('https');
const http = require('http');
const { SEARCH_API, PARTS_FOR_MODEL_API } = require('./config.js');

// ---------------------------------------------------------------------------
// RETRIEVAL (code just runs what the LLM asked for)
// ---------------------------------------------------------------------------

/** All compatible parts for a model number. */
// Primary product image URL from the legacy S3 naming convention (cgd{padded}.jpg).
// Derived purely from partId, so we don't depend on the search/parts API to
// return an image field. May 404 for parts without artwork — the client drops
// those gracefully (img.onerror).
function partImageUrl(partId) {
  if (partId === undefined || partId === null || partId === '') return null;
  const padded = String(partId).padStart(4, '0');
  return `https://s3.eu-west-2.amazonaws.com/spares-images/cgd${padded}.jpg`;
}

async function getPartsForModel(modelNumber) {
  try {
    const url = `${PARTS_FOR_MODEL_API}?model=${encodeURIComponent(modelNumber)}`;
    const res = await withRetries(() => httpRequest(url, 'GET', null, 10000), {
      attempts: 2,
      baseDelayMs: 300,
      label: 'parts-for-model',
    });
    if (res.status === 200) {
      const data = JSON.parse(res.body);
      const parts = (data.parts || []).map((p) => ({ ...p, image: p.image || partImageUrl(p.partId) }));
      return { parts, model: data.model || null };
    }
    // 5xx here is a real DB failure signal (route returns 500 on error).
    console.error('[part-finder] parts-for-model status:', res.status);
  } catch (err) {
    console.error('[part-finder] parts-for-model error:', err.message);
  }
  return { parts: [], model: null };
}

/** Catalogue search using the LLM-provided query (no keyword juggling).
 *  When `make` is given, results are restricted to that brand server-side. */
async function searchCatalogue(query, make) {
  const run = async (m) => {
    let url = `${SEARCH_API}?q=${encodeURIComponent(query)}`;
    if (m) url += `&make=${encodeURIComponent(m)}`;
    const res = await withRetries(
      () => httpRequest(url, 'GET', null, 5000),
      { attempts: 2, baseDelayMs: 300, label: 'search' },
    );
    if (res.status === 200) {
      const data = JSON.parse(res.body);
      if (data.results && data.results.length > 0) {
        return data.results.slice(0, 20).map((r) => ({
          title: r.t,
          partNo: r.p,
          partId: r.partId,
          price: r.price,
          link: r.l,
          image: r.img || partImageUrl(r.partId),
        }));
      }
    }
    return [];
  };
  try {
    const branded = await run(make);
    if (branded.length > 0 || !make) return branded;
    // The brand filter over-narrowed a thin category (e.g. hob/vacuum parts are
    // often not brand-tagged in the feed): a branded search returns nothing even
    // though the part exists unbranded. Retry without the brand and flag the
    // results verify-fit so the reply stays honest about exact-model fit.
    return (await run(null)).map((p) => ({ ...p, _brandOnly: true }));
  } catch (err) {
    console.error('[part-finder] search error:', err.message);
  }
  return [];
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** Retry a promise-returning fn with linear backoff on thrown errors. */
async function withRetries(fn, { attempts = 3, baseDelayMs = 500, label = 'request' } = {}) {
  let lastErr;
  for (let i = 1; i <= attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (i < attempts) {
        const delay = baseDelayMs * i;
        console.error(
          `[part-finder] ${label} attempt ${i}/${attempts} failed: ${err.message}; retrying in ${delay}ms`,
        );
        await sleep(delay);
      }
    }
  }
  throw lastErr;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function httpRequest(urlStr, method, payload, timeout) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlStr);
    const mod = url.protocol === 'https:' ? https : http;
    const headers = {};
    if (payload) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(payload);
    }
    const req = mod.request(url, { method, headers, timeout }, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Request timeout'));
    });
    if (payload) req.write(payload);
    req.end();
  });
}

module.exports = { getPartsForModel, searchCatalogue, sleep };
