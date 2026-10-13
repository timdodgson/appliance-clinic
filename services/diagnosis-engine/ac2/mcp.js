'use strict';
/**
 * Error-code MCP client (the deployed error-code service: Streamable HTTP, stateless JSON mode, bearer).
 * One JSON-RPC tools/call per code. The service is the single source of code meanings, including admin edits.
 */

async function resolveErrorCode({ make, appliance, code, model }, { url, token, fetchFn = fetch, timeoutMs = 8000 } = {}) {
  if (!url || !token) return { code, status: 'UNAVAILABLE', reason: 'error-code service not configured' };
  if (!make || !appliance || !code) return { code, status: 'NEEDS_CONTEXT', reason: !make ? 'make unknown' : 'appliance unknown' };
  const args = { make, appliance, code };
  if (model) args.observed = [{ type: 'MODEL', value: String(model) }];
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetchFn(`${String(url).replace(/\/+$/, '')}/mcp`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, accept: 'application/json, text/event-stream', 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'resolve-error-code', arguments: args } }),
      signal: ctrl.signal,
    });
    if (!res.ok) return { code, status: 'UNAVAILABLE', reason: `http ${res.status}` };
    const body = await res.json();
    const r = body && body.result;
    let out = r && r.structuredContent;
    if (!out && r && Array.isArray(r.content) && r.content[0] && r.content[0].text) {
      try { out = JSON.parse(r.content[0].text); } catch { out = null; }
    }
    if (!out || typeof out !== 'object') return { code, status: 'UNAVAILABLE', reason: 'malformed response' };
    return { code, ...compact(out) };
  } catch (e) {
    return { code, status: 'UNAVAILABLE', reason: String(e && e.name === 'AbortError' ? 'timeout' : (e && e.message) || e).slice(0, 80) };
  } finally {
    clearTimeout(timer);
  }
}

/** Keep what the reply needs: status, meaning(s), likely areas and owner-safe guidance where the service has them. */
function compact(r) {
  if (r.status === 'RESOLVED') {
    const e = r.enrichment || null;
    return {
      status: 'RESOLVED',
      meaning: r.meaning || null,
      confidence: r.confidence || null,
      components: e ? e.components || [] : [],
      likelyCauses: e ? e.likelyCauses || [] : [],
      checks: e ? e.checks || [] : [],
      safety: e && e.safety && e.safety.stopUse ? { stopUse: true, reason: e.safety.reason || null } : null,
    };
  }
  const list = Array.isArray(r.candidates) ? r.candidates : [];
  return {
    status: r.status || null,
    reason: r.reason || null,
    possibleMeanings: list.slice(0, 3).map((c) => c.meaning || null).filter(Boolean),
    needs: Array.isArray(r.needs) ? r.needs.map((n) => n.attribute) : undefined,
  };
}

module.exports = { resolveErrorCode, compact };
