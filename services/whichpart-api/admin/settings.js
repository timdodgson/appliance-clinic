'use strict';

/** Admin: settings and the advisor model configuration routes. */
const aiConfig = require('../ai-config.js');
const settingsAdmin = require('../settings-admin.js');
const { ENGINE_URL } = require('../config.js');
const { log } = require('../log.js');
const { readJson, authPath, respond } = require('../http-io.js');
const { requireSession, requireAdmin } = require('../session.js');

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
      fields: ((apply && apply.changed) || []).map((c) => c.field), version: apply && apply.version, revision: apply && apply.revision, verified: apply ? apply.verified : undefined });
  } catch { /* logging never affects the response */ }
}

function viewOpts(testDeps) {
  return {
    fetch: testDeps.fetch,
    engineHealthUrl: testDeps.engineHealthUrl !== undefined ? testDeps.engineHealthUrl : ENGINE_URL,
    timeoutMs: testDeps.timeoutMs || 5000,
    loadConfigWithStatus: testDeps.loadConfigWithStatus,
    isKeyConfigured: testDeps.isKeyConfigured,
    saveConfig: testDeps.saveConfig,
    runningModels: testDeps.runningModels,
    transcriptPolicy: testDeps.transcriptPolicy,
    loadKeyMeta: testDeps.loadKeyMeta,
    readBack: testDeps.readBack,
  };
}

async function adminSettingsGet(event) {
  const session = await requireSession(event);
  if (!session || !session.isAdmin) return respond(401, { error: 'Unauthorized' });
  return respond(200, await settingsAdmin.buildView(viewOpts(_settingsTestDeps || {})));
}

async function adminSettingsModelPatch(event) {
  const session = await requireSession(event);
  if (!session || !session.isAdmin) return respond(401, { error: 'Unauthorized' });
  const body = readJson(event);
  if (body === null) return respond(400, { error: 'invalid JSON' });
  const result = await settingsAdmin.saveModelPatch(Object.assign({ body, byEmail: session.email || session.username || 'admin' }, viewOpts(_settingsTestDeps || {})));
  if (!result.ok) {
    return respond(result.status || 400, { error: result.error, code: result.code || undefined, details: result.details || undefined, currentVersion: result.currentVersion, currentRevision: result.currentRevision });
  }
  if (result.apply && result.apply.written) settingsChangeLog('model', session, result.apply);
  return respond(200, Object.assign({}, result.view, { apply: result.apply || null }));
}

async function aiConfigSaveKey(event) {
  const session = await requireSession(event);
  if (!session || !session.isAdmin) return respond(401, { error: 'Unauthorized' });
  const body = readJson(event);
  if (body === null) return respond(400, { error: 'invalid JSON' });
  const apiKey = typeof body.apiKey === 'string' ? body.apiKey.trim() : '';
  // A blank value must NOT delete the existing secret — deletion is a separate, deliberate action.
  if (!apiKey) return respond(400, { error: 'No API key provided. Leave blank to keep the existing key, or enter a new key to replace it.' });
  if (apiKey.length > 400 || /\s/.test(apiKey)) return respond(400, { error: 'That does not look like an API key (no spaces, up to 400 characters).' });
  const testDeps = _settingsTestDeps || {};
  const saved = await (testDeps.saveKey || aiConfig.saveKey)(apiKey, session.email || session.username || 'admin');
  log({ evt: 'settings-change', kind: 'model-credential', by: session.email || session.username || 'admin', fields: ['credential'] });
  return respond(200, { configured: true, updatedAt: saved.at }); // never echo the key
}

async function aiConfigTest(event) {
  const session = await requireSession(event);
  if (!session || !session.isAdmin) return respond(401, { error: 'Unauthorized' });
  const testDeps = _settingsTestDeps || {};
  // The request body is ignored: a connection check never targets a caller-supplied model or key.
  return respond(200, await settingsAdmin.testConnection({ loadConfig: testDeps.loadConfig, getKey: testDeps.getKey, probeModel: testDeps.probeModel, fetch: testDeps.fetch, timeoutMs: testDeps.probeTimeoutMs }));
}

async function aiConfigModels(event) {
  const session = await requireSession(event);
  if (!session || !session.isAdmin) return respond(401, { error: 'Unauthorized' });
  const testDeps = _settingsTestDeps || {};
  const key = await (testDeps.getKey || aiConfig.getKey)();
  return respond(200, await (testDeps.listModels || aiConfig.listModels)({ key, fetch: testDeps.fetch }));
}

module.exports = { setSettingsDepsForTests, settingsAdminRoute, adminSettingsGet, adminSettingsModelPatch, aiConfigSaveKey, aiConfigTest, aiConfigModels };
