'use strict';

/** Admin: settings and AI provider configuration routes. */
const aiConfig = require('../ai-config.js');
const settingsAdmin = require('../settings-admin.js');
const { ENGINE_URL, ACQ_JUDGE_MODEL } = require('../config.js');
const { log } = require('../log.js');
const { readJson, authPath, respond } = require('../http-io.js');
const { requireSession, requireAdmin } = require('../session.js');
const { routingOverrideStatusSafe } = require('../benchmark-state.js');
const { diagnosticsCanonicalMode } = require('./diagnostics.js');

let _settingsTestDeps = null;
function setSettingsDepsForTests(deps) { _settingsTestDeps = deps; }

const SETTINGS_MAX_BODY = 16 * 1024;
async function settingsAdminRoute(event, method, handlers) {
  const handler = Object.prototype.hasOwnProperty.call(handlers, method) ? handlers[method] : null;
  if (!handler) return respond(405, { error: Object.keys(handlers).join(' or ') + ' only' });
  if (!(await requireAdmin(event))) return respond(401, { error: 'Unauthorized' });
  if (method !== 'GET' && String((event && event.body) || '').length > SETTINGS_MAX_BODY) return respond(413, { error: 'request body too large' });
  try {
    return await handler(event);
  } catch (e) {
    // Never echo the error: secrets-store errors can quote the request.
    log({ evt: 'settings-admin-error', path: String(authPath(event) || '').split('?')[0].slice(0, 120), error: String((e && e.name) || 'Error').slice(0, 60) });
    return respond(500, { error: 'The settings service could not complete this request. Reload to confirm the current values.' });
  }
}
/** One concise audit line per applied Settings change: actor, fields, revision. No secret values. */
function settingsChangeLog(kind, session, apply) {
  try {
    log({ evt: 'settings-change', kind, by: (session && (session.email || session.username)) || 'admin',
      fields: kind === 'jev' ? ['jev.credential'] : ((apply && apply.changed) || []).map((c) => c.field), version: apply && apply.version, revision: apply && apply.revision,
      verified: apply ? apply.verified : undefined });
  } catch { /* logging never affects the response */ }
}
async function aiConfigGet(event) {
  const session = await requireSession(event);
  if (!session || !session.isAdmin) return respond(401, { error: 'Unauthorized' });
  const [cfg, keyConfigured, jevLoaded] = await Promise.all([
    aiConfig.loadConfig(),
    aiConfig.isKeyConfigured(),
    aiConfig.loadJevWithStatus(),
  ]);
  // Settings consumes the SAME anti-masquerade `setup` the Test ApplianceClinic
  // page uses, so the "What's running right now" panel can never surface the
  // judge/frontier model as the Private AI model. UNDERSTAND is TypeSafe Jev.
  return respond(200, Object.assign({}, aiConfig.toClientView(cfg, keyConfigured), {
    setup: aiConfig.describeSetup({
      cfg,
      judgeModel: ACQ_JUDGE_MODEL,
      keyConfigured,
      jevConfigured: Boolean(jevLoaded.public && jevLoaded.public.credentialConfigured),
    }),
  }));
}

async function aiConfigSaveKey(event) {
  const session = await requireSession(event);
  if (!session || !session.isAdmin) return respond(401, { error: 'Unauthorized' });
  const body = readJson(event);
  if (body === null) return respond(400, { error: 'invalid JSON' });
  const apiKey = typeof body.apiKey === 'string' ? body.apiKey.trim() : '';
  // A blank value must NOT delete the existing secret — deletion is a separate,
  // deliberate action. Reject and keep whatever is stored.
  if (!apiKey) {
    return respond(400, { error: 'No API key provided. Leave blank to keep the existing key, or enter a new key to replace it.' });
  }
  if (apiKey.length > 400 || /\s/.test(apiKey)) return respond(400, { error: 'That does not look like an API key (no spaces, up to 400 characters).' });
  const saved = await aiConfig.saveKey(apiKey, session.email || session.username || 'admin');
  log({ evt: 'settings-change', kind: 'openai-credential', by: session.email || session.username || 'admin', fields: ['openai.credential'] });
  return respond(200, { configured: true, updatedAt: saved.at }); // never echo the key
}

async function aiConfigTestLocal(event) {
  const session = await requireSession(event);
  if (!session || !session.isAdmin) return respond(401, { error: 'Unauthorized' });
  const cfg = await aiConfig.loadConfig();
  // Same resolution order the runtime uses: saved override -> the deployed default (LM_STUDIO_URL).
  // The request body is ignored: a connection check never targets a caller-supplied address.
  const endpoint = String(cfg.local.endpoint || process.env.LM_STUDIO_URL || '').trim();
  const model = String(cfg.local.model || '').trim();
  if (!endpoint) {
    return respond(200, { status: 'CONFIG_ERROR', detail: 'No private AI address is configured.', latencyMs: null });
  }
  const url = endpoint.replace(/\/$/, '') + '/v1/chat/completions';
  const result = await aiConfig.probeChat({ url, model: model || undefined, timeoutMs: 12000 });
  return respond(200, result);
}

async function aiConfigTestFrontier(event) {
  const session = await requireSession(event);
  if (!session || !session.isAdmin) return respond(401, { error: 'Unauthorized' });
  const [cfg, apiKey] = await Promise.all([aiConfig.loadConfig(), aiConfig.getKey()]);
  const model = String(cfg.frontier.model || '').trim();
  if (!apiKey) return respond(200, { status: 'CONFIG_ERROR', detail: 'No API key configured', latencyMs: null });
  if (!model) return respond(200, { status: 'MODEL_ERROR', detail: 'No model configured', latencyMs: null });
  const base = (process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, '');
  const result = await aiConfig.probeChat({
    url: base + '/chat/completions',
    headers: { Authorization: 'Bearer ' + apiKey },
    model,
    timeoutMs: 20000,
    openai: true,
  });
  // Read-only check. It used to write `lastFrontierTest` back into the live config (a stale
  // read-modify-write that could undo a concurrent routing change); nothing ever read that field.
  return respond(200, result);
}

async function aiConfigLocalModels(event) {
  const session = await requireSession(event);
  if (!session || !session.isAdmin) return respond(401, { error: 'Unauthorized' });
  const cfg = await aiConfig.loadConfig();
  const endpoint = String(cfg.local.endpoint || process.env.LM_STUDIO_URL || '').trim();
  return respond(200, await aiConfig.listLocalModels(endpoint));
}

async function aiConfigFrontierModels(event) {
  const session = await requireSession(event);
  if (!session || !session.isAdmin) return respond(401, { error: 'Unauthorized' });
  const key = await aiConfig.getKey();
  return respond(200, await aiConfig.listFrontierModels(key));
}

async function adminSettingsGet(event) {
  const session = await requireSession(event);
  if (!session || !session.isAdmin) return respond(401, { error: 'Unauthorized' });
  const testDeps = _settingsTestDeps || {};
  const view = await settingsAdmin.buildView({
    fetch: testDeps.fetch,
    partFinderHealthUrl: testDeps.partFinderHealthUrl !== undefined ? testDeps.partFinderHealthUrl : ENGINE_URL,
    timeoutMs: testDeps.timeoutMs || 5000,
    judgeModel: ACQ_JUDGE_MODEL,
    loadConfigWithStatus: testDeps.loadConfigWithStatus,
    isKeyConfigured: testDeps.isKeyConfigured,
    loadJevWithStatus: testDeps.loadJevWithStatus,
    runningModels: testDeps.runningModels,
    env: testDeps.env,
    transcriptPolicy: testDeps.transcriptPolicy,
    loadKeyMeta: testDeps.loadKeyMeta,
    canonical: diagnosticsCanonicalMode(),
    batchOverride: await routingOverrideStatusSafe(),
    getBatchOverride: routingOverrideStatusSafe,
  });
  return respond(200, view);
}

async function adminSettingsInferencePatch(event) {
  const SETTINGS_KIND = 'diagnostic-inference';
  const session = await requireSession(event);
  if (!session || !session.isAdmin) return respond(401, { error: 'Unauthorized' });
  const body = readJson(event);
  if (body === null) return respond(400, { error: 'invalid JSON' });
  const testDeps = _settingsTestDeps || {};
  const result = await settingsAdmin.saveInferencePatch({
    body,
    byEmail: session.email || session.username || 'admin',
    fetch: testDeps.fetch,
    partFinderHealthUrl: testDeps.partFinderHealthUrl !== undefined ? testDeps.partFinderHealthUrl : ENGINE_URL,
    timeoutMs: testDeps.timeoutMs || 5000,
    judgeModel: ACQ_JUDGE_MODEL,
    loadConfigWithStatus: testDeps.loadConfigWithStatus,
    isKeyConfigured: testDeps.isKeyConfigured,
    loadJevWithStatus: testDeps.loadJevWithStatus,
    saveConfig: testDeps.saveConfig,
    runningModels: testDeps.runningModels,
    env: testDeps.env,
    transcriptPolicy: testDeps.transcriptPolicy,
    loadKeyMeta: testDeps.loadKeyMeta,
    canonical: diagnosticsCanonicalMode(),
    batchOverride: await routingOverrideStatusSafe(),
    getBatchOverride: routingOverrideStatusSafe,
  });
  if (!result.ok) {
    return respond(result.status || 400, {
      error: result.error,
      code: result.code || undefined,
      details: result.details || undefined,
      currentVersion: result.currentVersion,
      currentRevision: result.currentRevision,
    });
  }
  if (result.apply && result.apply.written) settingsChangeLog(SETTINGS_KIND, session, result.apply);
  return respond(200, Object.assign({}, result.view, { apply: result.apply || null }));
}

async function adminSettingsJevPatch(event) {
  const SETTINGS_KIND = 'jev';
  const session = await requireSession(event);
  if (!session || !session.isAdmin) return respond(401, { error: 'Unauthorized' });
  const body = readJson(event);
  if (body === null) return respond(400, { error: 'invalid JSON' });
  const testDeps = _settingsTestDeps || {};
  const result = await settingsAdmin.saveJevPatch({
    body,
    byEmail: session.email || session.username || 'admin',
    fetch: testDeps.fetch,
    partFinderHealthUrl: testDeps.partFinderHealthUrl !== undefined ? testDeps.partFinderHealthUrl : ENGINE_URL,
    timeoutMs: testDeps.timeoutMs || 5000,
    judgeModel: ACQ_JUDGE_MODEL,
    loadConfigWithStatus: testDeps.loadConfigWithStatus,
    isKeyConfigured: testDeps.isKeyConfigured,
    loadJevWithStatus: testDeps.loadJevWithStatus,
    saveJevStored: testDeps.saveJevStored,
    runningModels: testDeps.runningModels,
    env: testDeps.env,
    transcriptPolicy: testDeps.transcriptPolicy,
    loadKeyMeta: testDeps.loadKeyMeta,
    canonical: diagnosticsCanonicalMode(),
    batchOverride: await routingOverrideStatusSafe(),
    getBatchOverride: routingOverrideStatusSafe,
  });
  if (!result.ok) {
    return respond(result.status || 400, {
      error: result.error,
      code: result.code || undefined,
      details: result.details || undefined,
      currentVersion: result.currentVersion,
      currentRevision: result.currentRevision,
    });
  }
  if (result.apply && result.apply.written) settingsChangeLog(SETTINGS_KIND, session, result.apply);
  return respond(200, Object.assign({}, result.view, { apply: result.apply || null }));
}

async function adminSettingsJevTest(event) {
  const session = await requireSession(event);
  if (!session || !session.isAdmin) return respond(401, { error: 'Unauthorized' });
  const testDeps = _settingsTestDeps || {};
  const result = await settingsAdmin.testJevConnection({
    getJevCredentials: testDeps.getJevCredentials,
    probeJev: testDeps.probeJev,
    fetch: testDeps.fetch,
    timeoutMs: testDeps.jevTimeoutMs || 12000,
  });
  return respond(200, result);
}

module.exports = {
  setSettingsDepsForTests, settingsAdminRoute, aiConfigGet, aiConfigSaveKey, aiConfigTestLocal,
  aiConfigTestFrontier, aiConfigLocalModels, aiConfigFrontierModels, adminSettingsGet,
  adminSettingsInferencePatch, adminSettingsJevPatch, adminSettingsJevTest,
};
