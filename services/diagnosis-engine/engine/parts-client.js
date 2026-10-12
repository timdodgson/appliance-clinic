/**
 * S4R Parts Catalogue client (external service): the compatible parts for a confirmed model, used by the canonical
 * part gate. The only S4R dependency of the diagnosis engine.
 */
const https = require('https');
const http = require('http');
const { PARTS_FOR_MODEL_API } = require('./config.js');

// Product image URL from the catalogue's image naming convention (cgd{padded}.jpg), derived from partId when the parts
// API returns no image field. May 404 for parts without artwork; the client drops those (img.onerror).
function partImageUrl(partId) {
  if (partId === undefined || partId === null || partId === '') return null;
  const padded = String(partId).padStart(4, '0');
  return `https://s3.eu-west-2.amazonaws.com/spares-images/cgd${padded}.jpg`;
}

/** All compatible parts for a model number. */
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
    console.error('[parts-catalogue] parts-for-model status:', res.status);
  } catch (err) {
    console.error('[parts-catalogue] parts-for-model error:', err.message);
  }
  return { parts: [], model: null };
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
          `[parts-catalogue] ${label} attempt ${i}/${attempts} failed: ${err.message}; retrying in ${delay}ms`,
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

module.exports = {
  getPartsForModel,
};
