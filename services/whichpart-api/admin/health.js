'use strict';

/** Admin: health and dashboard. */
const aiConfig = require('../ai-config.js');
const transcripts = require('../transcripts');
const { ENGINE_URL, MCP_HEALTH_URL } = require('../config.js');
const { engineGetHeaders } = require('../engine-signature.js');
const { log } = require('../log.js');
const { fetchHealth, respond } = require('../http-io.js');
const { requireAdmin } = require('../session.js');
const { transcriptStore } = require('../transcript-store.js');
const { loadOverlayCached } = require('./content.js');
const { recallStore } = require('./recalls.js');

/** The diagnosis engine is probed directly (GET /health, SigV4-signed: its Function URL is AWS_IAM). */
async function gatherHealthServices() {
  const engineUrl = ENGINE_URL.replace(/\/$/, '') + '/health';
  const results = { whichpartApi: { ok: true, service: 'whichpart-api' } };
  const [engine, mcp] = await Promise.all([
    fetchHealth(engineUrl, 5000, engineGetHeaders(engineUrl)),
    MCP_HEALTH_URL ? fetchHealth(MCP_HEALTH_URL, 5000) : Promise.resolve(null),
  ]);
  results.diagnosisEngine = engine.json
    ? { ok: Boolean(engine.ok && engine.json.status === 'ok'), state: engine.json.health || engine.json.status || 'unknown',
      reason: engine.json.healthReason || null, architecture: (engine.json.diagnosis && engine.json.diagnosis.architecture) || null }
    : { ok: false, error: engine.error || ('http ' + engine.status), state: 'unknown' };
  if (mcp) results.mcp = mcp.json ? { ok: mcp.ok, ...mcp.json } : { ok: false, error: mcp.error || ('http ' + mcp.status) };
  return results;
}

/** The dashboard's one-line health: ok, a label, and which service failed and why (no secrets, no ids). */
function compactHealth(services) {
  const s = services || {};
  const parts = [
    { name: 'API', ok: Boolean(s.whichpartApi && s.whichpartApi.ok), detail: null },
    { name: 'Diagnosis engine', ok: Boolean(s.diagnosisEngine && s.diagnosisEngine.ok), detail: s.diagnosisEngine ? (s.diagnosisEngine.reason || s.diagnosisEngine.error || (s.diagnosisEngine.state && s.diagnosisEngine.state !== 'healthy' ? 'reported ' + s.diagnosisEngine.state : null)) : 'not probed' },
  ];
  if (s.mcp) parts.push({ name: 'Error codes', ok: Boolean(s.mcp.ok), detail: s.mcp.ok ? null : (s.mcp.error || 'not healthy') });
  const failed = parts.filter((p) => !p.ok).map((p) => ({ name: p.name, detail: p.detail ? String(p.detail).slice(0, 200) : null }));
  return { ok: failed.length === 0, label: failed.length ? 'Problem' : 'Healthy', summaryLine: parts.map((p) => p.name).join(' · '), failed };
}

// Admin dashboard health — SERVER-SIDE guarded (401 without a valid Cognito session). Aggregates only status/version
// data ALREADY exposed by the services; invents nothing.
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
  return respond(200, { ok: true, generatedAt: new Date().toISOString(), services: results, transcriptPolicy: transcripts.policy() });
}

async function adminDashboard(event) {
  if (!(await requireAdmin(event))) return respond(401, { error: 'Unauthorized' });
  let services;
  try {
    services = await gatherHealthServices();
  } catch (e) {
    services = { whichpartApi: { ok: true, service: 'whichpart-api' }, diagnosisEngine: { ok: false, error: String(e && e.message || e), state: 'unknown' } };
  }
  let activity;
  try {
    activity = await transcriptStore().stats(new Date());
  } catch (e) {
    log({ evt: 'dashboard-activity-failed', error: String(e && e.message || e) });
    activity = { unavailable: true, error: 'transcript-store' };
  }
  return respond(200, { ok: true, generatedAt: new Date().toISOString(), health: compactHealth(services), activity, state: await dashboardState(services) });
}

/**
 * Dashboard "Production state": read-only facts from sources the BFF already reads elsewhere: the diagnosis
 * architecture, the stored advisor model (Settings' document), the Error Code MCP health already fetched above, the
 * media overlay and the recall site counts. Each part fails on its own as { unavailable: true }; nothing here writes,
 * and no secret or id is returned.
 */
async function dashboardState(services) {
  const part = async (fn) => { try { return await fn(); } catch (e) { return { unavailable: true }; } };
  const [advisor, media, recalls] = await Promise.all([
    part(async () => {
      const [cfg, keyConfigured] = await Promise.all([aiConfig.loadConfig(), aiConfig.isKeyConfigured()]);
      const v = aiConfig.advisorView(cfg, keyConfigured);
      return { provider: v.providerLabel, model: v.model, credentialConfigured: v.credentialConfigured, version: cfg.version || 1 };
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
  const mcp = services && services.mcp;
  return {
    diagnosis: { architecture: 'ac2' },
    advisor, media, recalls,
    errorCodes: mcp ? { ok: Boolean(mcp.ok), active: Number.isFinite(mcp.effectiveActiveCount) ? mcp.effectiveActiveCount : null, overlay: (mcp.overlay && mcp.overlay.state) || null } : { unavailable: true },
  };
}

module.exports = { adminHealth, adminDashboard };
