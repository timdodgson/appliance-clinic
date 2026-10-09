'use strict';

/** Admin: health and dashboard. */
const aiConfig = require('../ai-config.js');
const transcripts = require('../transcripts');
const conversationState = require('../conversation-state');
const transcriptReview = require('../transcript-review');
const { ORCHESTRATOR_URL, MCP_HEALTH_URL } = require('../config.js');
const { log } = require('../log.js');
const { queryParam, fetchHealth, respond } = require('../http-io.js');
const { requireAdmin } = require('../session.js');
const { routingOverrideStatusSafe } = require('../benchmark-state.js');
const { transcriptStore } = require('../transcript-store.js');
const { loadOverlayCached } = require('./content.js');
const { recallStore } = require('./recalls.js');

async function gatherHealthServices() {
  const orchUrl = ORCHESTRATOR_URL.replace(/\/$/, '') + '/health';
  const results = { whichpartApi: { ok: true, service: 'whichpart-api' } };
  const [orch, mcp] = await Promise.all([
    fetchHealth(orchUrl, 5000),
    MCP_HEALTH_URL ? fetchHealth(MCP_HEALTH_URL, 5000) : Promise.resolve(null),
  ]);
  results.orchestrator = orch.json ? { ok: orch.ok, ...orch.json } : { ok: false, error: orch.error || ('http ' + orch.status) };
  if (mcp) results.mcp = mcp.json ? { ok: mcp.ok, ...mcp.json } : { ok: false, error: mcp.error || ('http ' + mcp.status) };
  results.rag = { ok: !!(orch.json && orch.json.diagnosticRag), reportedBy: 'orchestrator',
    state: (orch.json && orch.json.diagnosticRag) || 'unknown' };
  return results;
}

// Admin dashboard health — SERVER-SIDE guarded (401 without a valid Cognito session). Aggregates
// only status/version data ALREADY exposed by the services; invents nothing.
async function adminHealth(event) {
  if (!(await requireAdmin(event))) return respond(401, { error: 'Unauthorized' });
  const results = await gatherHealthServices();
  // Best-effort activity overlay. A transcript-store failure must not fail health.
  try {
    results.activity = await transcriptStore().stats(new Date());
  } catch (e) {
    results.activity = { unavailable: true, error: 'transcript-store' };
    log({ evt: 'transcript-stats-failed', error: String(e && e.message || e) });
  }
  return respond(200, { ok: true, generatedAt: new Date().toISOString(), services: results,
    transcriptPolicy: transcripts.policy() });
}

async function adminDashboard(event) {
  if (!(await requireAdmin(event))) return respond(401, { error: 'Unauthorized' });
  const period = queryParam(event, 'period') || '7d';
  let services;
  try {
    services = await gatherHealthServices();
  } catch (e) {
    services = { whichpartApi: { ok: true, service: 'whichpart-api' }, orchestrator: { ok: false, error: String(e && e.message || e) }, rag: { ok: false, state: 'unknown' } };
  }
  let production;
  try {
    production = await transcriptReview.dashboardFromStore(transcriptStore(), { period: period, now: new Date() });
  } catch (e) {
    log({ evt: 'dashboard-summary-failed', error: String(e && e.message || e) });
    production = { unavailable: true, error: 'transcript-store' };
  }
  return respond(200, {
    ok: true,
    generatedAt: new Date().toISOString(),
    health: transcriptReview.compactHealth(services),
    production: production,
    state: await dashboardState(services),
  });
}

/**
 * Dashboard "Production state": read-only facts from sources the BFF already reads elsewhere —
 * canonical mode (this Lambda's env), the stored AI routing (Settings' document), the batch routing
 * override lease, the Error Code MCP health already fetched above, the media overlay (cached loader the
 * customer path uses) and the recall site counts recorded by the last publish. Each part fails on its
 * own as { unavailable: true }; nothing here writes, and no secret or id is returned.
 */
async function dashboardState(services) {
  const part = async (fn) => { try { return await fn(); } catch (e) { return { unavailable: true }; } };
  const [routing, override, media, recalls] = await Promise.all([
    part(async () => {
      const cfg = await aiConfig.loadConfig();
      const frontier = cfg.routing && cfg.routing.compose === 'frontier';
      return { understand: 'TypeSafe Jev', compose: frontier ? 'OpenAI' : 'Private AI', composeModel: (frontier ? cfg.frontier && cfg.frontier.model : cfg.local && cfg.local.model) || null, version: cfg.version || 1 };
    }),
    part(async () => {
      const s = await routingOverrideStatusSafe();
      if (s && s.error) return { unavailable: true };
      return { active: Boolean(s && s.active), blocked: Boolean(s && s.blocked), state: (s && s.state) || 'none', runId: (s && (s.active || s.blocked) && s.runId) || null };
    }),
    part(async () => {
      const st = await loadOverlayCached();
      const n = st && st.identities ? Object.keys(st.identities).length : 0;
      return { overlay: n || (st && st.updatedAt) ? 'present' : 'absent', records: n, updatedAt: (st && st.updatedAt) || null };
    }),
    part(async () => {
      const m = await recallStore().getMeta();
      const site = (m && m.site) || {};
      return { listed: Number.isFinite(site.records) ? site.records : null, lastSuccessAt: (m && m.lastSuccessAt) || null };
    }),
  ]);
  const cm = conversationState.resolveMode();
  const mcp = services && services.mcp;
  return {
    canonical: { mode: cm.mode, journeys: (cm.journeys || []).length, demoted: Boolean(cm.demoted) },
    routing, override, media, recalls,
    errorCodes: mcp ? { ok: Boolean(mcp.ok), active: Number.isFinite(mcp.effectiveActiveCount) ? mcp.effectiveActiveCount : null, overlay: (mcp.overlay && mcp.overlay.state) || null } : { unavailable: true },
  };
}

module.exports = { adminHealth, adminDashboard };
