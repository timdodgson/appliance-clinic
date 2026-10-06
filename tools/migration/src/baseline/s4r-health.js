/** Read-only Spares4Repairs health checks: plain GETs of public pages and the catalogue API. */
export async function s4rHealth(guardedFetch, endpoints) {
  const checks = [];
  for (const url of endpoints.s4rPages) {
    const res = await guardedFetch(url);
    checks.push({ check: 'page', url, status: res.status, ok: res.status === 200, ms: res.ms });
  }
  const search = await guardedFetch(endpoints.s4rCatalogueSearch);
  let parsed = false;
  try { JSON.parse(search.text); parsed = true; } catch { /* not JSON */ }
  checks.push({ check: 'catalogue-search', url: endpoints.s4rCatalogueSearch, status: search.status, ok: search.status === 200 && parsed, ms: search.ms });
  return { ok: checks.every((c) => c.ok), checks };
}
