'use strict';
/**
 * Admin BFF proxy for the Error-Code MCP catalogue.
 *
 * The MCP owns baseline + overlay merge and lookup. This module does not reimplement
 * catalogue semantics. Admin Cognito gates every call; the MCP bearer stays on the server.
 */

function mcpBaseFromHealth(url) {
  return String(url || '').replace(/\/health\/?$/i, '').replace(/\/$/, '');
}

function err(code, message, extra) {
  const e = new Error(message);
  e.code = code;
  e.status = code === 'unauthorized' ? 401 : (code === 'not_found' ? 404 : (code === 'mcp' ? 503 : 400));
  if (extra) e.extra = extra;
  return e;
}

async function readJson(res) {
  const text = await res.text();
  if (!text) return {};
  try { return JSON.parse(text); } catch {
    throw err('mcp', 'Error Code MCP returned a non-JSON response.', { status: res.status });
  }
}

function createClient(opts) {
  opts = opts || {};
  const fetchFn = opts.fetch || fetch;
  const mcpUrl = String(opts.mcpUrl || process.env.MCP_URL || mcpBaseFromHealth(process.env.MCP_HEALTH_URL) || '').replace(/\/$/, '');
  const token = opts.token != null ? opts.token : (process.env.MCP_BEARER_TOKEN || '');
  const timeoutMs = opts.timeoutMs || 20000;

  async function mcpFetch(path, method, body) {
    if (!mcpUrl) throw err('mcp', 'Error Code MCP URL is not configured.');
    if (!token) throw err('mcp', 'Error Code MCP bearer is not configured.');
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetchFn(mcpUrl + path, {
        method: method || 'GET',
        headers: {
          authorization: 'Bearer ' + token,
          accept: 'application/json',
          'content-type': 'application/json',
        },
        body: body != null ? JSON.stringify(body) : undefined,
        signal: ctrl.signal,
      });
      const json = await readJson(res);
      if (res.status === 401) {
        throw err('mcp', 'Error Code MCP rejected the server credential.', { status: 401 });
      }
      if (!res.ok) {
        const e = err(json.error || 'mcp', json.message || json.error || ('Error Code MCP HTTP ' + res.status), json);
        e.status = res.status;
        e.body = json;
        throw e;
      }
      return json;
    } catch (e) {
      if (e && e.code) throw e;
      if (String(e && e.name) === 'AbortError') throw err('mcp', 'Error Code MCP timed out.');
      throw err('mcp', 'Error Code MCP is unavailable.', { detail: String(e && e.message || e) });
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    mcpUrl,
    list: () => mcpFetch('/catalogue', 'GET'),
    item: (id, preview) => mcpFetch(
      '/catalogue/item?id=' + encodeURIComponent(id) + (preview ? '&preview=1' : ''),
      'GET',
    ),
    create: (body) => mcpFetch('/catalogue', 'POST', body),
    patch: (id, body) => mcpFetch('/catalogue/item?id=' + encodeURIComponent(id), 'PATCH', body),
    retire: (id, body) => mcpFetch('/catalogue/item/retire?id=' + encodeURIComponent(id), 'POST', body || {}),
    restore: (id, body) => mcpFetch('/catalogue/item/restore?id=' + encodeURIComponent(id), 'POST', body || {}),
    // DELETE = discard the pending draft; hard delete only for a never-published Admin draft (MCP decides).
    delete: (id, body) => mcpFetch('/catalogue/item?id=' + encodeURIComponent(id), 'DELETE', body || {}),
    publish: (id, body) => mcpFetch('/catalogue/item/publish?id=' + encodeURIComponent(id), 'POST', body || {}),
    rollback: (id, body) => mcpFetch('/catalogue/item/rollback?id=' + encodeURIComponent(id), 'POST', body || {}),
    version: (id, v) => mcpFetch('/catalogue/item/version?id=' + encodeURIComponent(id) + '&v=' + encodeURIComponent(v), 'GET'),
    preview: (body) => mcpFetch('/catalogue/preview', 'POST', body),
  };
}

// Author for audit metadata: always the verified Admin session, never a client-supplied value.
function withActor(body, session) {
  const out = Object.assign({}, (body && typeof body === 'object' && !Array.isArray(body)) ? body : {});
  delete out.actor;
  out.actor = (session && (session.email || session.username)) || 'admin';
  return out;
}

function httpError(e) {
  const status = e && e.status ? e.status : 503;
  const body = Object.assign({
    ok: false,
    error: (e && e.code) || 'mcp',
    message: (e && e.message) || 'Error Code MCP unavailable',
  }, (e && e.body) || (e && e.extra) || {});
  delete body.status;
  return { status, body };
}

module.exports = {
  createClient,
  mcpBaseFromHealth,
  withActor,
  err,
  httpError,
};
