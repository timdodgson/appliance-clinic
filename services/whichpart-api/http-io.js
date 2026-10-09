'use strict';

/**
 * HTTP plumbing shared by every route: JSON responses, the CORS default headers, request path, body and query
 * parsing, and the outbound health probe.
 */
const mediaAdmin = require('./media-admin');

async function parseJsonBody(event) {
  try { return JSON.parse(event.body || '{}'); }
  catch { const e = mediaAdmin.err('json', 'invalid JSON'); throw e; }
}

function queryParam(event, name) {
  const qs = (event && event.queryStringParameters) || {};
  if (qs[name] != null) return qs[name];
  const raw = (event && event.rawQueryString) || '';
  const m = new RegExp('(?:^|&)' + name + '=([^&]*)').exec(raw);
  return m ? decodeURIComponent(m[1]) : null;
}

function readJson(event) {
  try { return JSON.parse(event.body || '{}'); } catch { return null; }
}

async function fetchHealth(url, ms) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms || 5000);
  try {
    const r = await fetch(url, { signal: ctrl.signal });
    const text = await r.text();
    let json = null; try { json = JSON.parse(text); } catch { /* non-JSON */ }
    return { ok: r.ok, status: r.status, json };
  } catch (e) { return { ok: false, error: String(e && e.message || e) }; }
  finally { clearTimeout(timer); }
}

function authPath(event) {
  return event.rawPath ||
    (event.requestContext && event.requestContext.http && event.requestContext.http.path) ||
    event.path || '/';
}

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'content-type',
  'access-control-allow-methods': 'GET,POST,OPTIONS',
  'content-type': 'application/json',
};

function respond(statusCode, obj) {
  return { statusCode, headers: CORS, body: JSON.stringify(obj) };
}

module.exports = { parseJsonBody, queryParam, readJson, fetchHealth, authPath, CORS, respond };
