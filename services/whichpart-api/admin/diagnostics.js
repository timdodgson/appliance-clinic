'use strict';

/** Admin: the diagnostics inspector. */
const aiConfig = require('../ai-config.js');
const knowledgeInspect = require('../knowledge-inspect');
const mediaInspect = require('../media-inspect');
const mediaAdmin = require('../media-admin');
const diagnosticsInspect = require('../diagnostics-inspect');
const { ENGINE_URL, S4R_PRODUCT_BASE_URL, MAX_MESSAGES, MCP_HEALTH_URL, ACQ_JUDGE_MODEL } = require('../config.js');
const { log } = require('../log.js');
const { respond } = require('../http-io.js');
const { requireAdmin } = require('../session.js');
const { mediaStore } = require('./content.js');

let _diagnosticsTestDeps = null;
function setDiagnosticsDepsForTests(deps) { _diagnosticsTestDeps = deps; }

async function adminDiagnostics(event) {
  if (!(await requireAdmin(event))) return respond(401, { error: 'Unauthorized' });
  const runtime = {
    maxConversationTurns: MAX_MESSAGES,
    families: knowledgeInspect.FAMILIES,
    s4rProductBaseHost: diagnosticsInspect.hostOf(S4R_PRODUCT_BASE_URL),
    mcpHealthHost: diagnosticsInspect.hostOf(MCP_HEALTH_URL),
    engineHost: diagnosticsInspect.hostOf(ENGINE_URL),
  };
  const testDeps = _diagnosticsTestDeps || {};
  try {
    const snapshot = await diagnosticsInspect.collect({
      fetch: testDeps.fetch || fetch,
      timeoutMs: testDeps.timeoutMs || 5000,
      mcpHealthUrl: testDeps.mcpHealthUrl !== undefined ? testDeps.mcpHealthUrl : (MCP_HEALTH_URL || ''),
      engineHealthUrl: testDeps.engineHealthUrl !== undefined
        ? testDeps.engineHealthUrl
        : (ENGINE_URL.replace(/\/$/, '') + '/health'),
      knowledgeInspect,
      mediaInspect,
      emptyOverlay: mediaAdmin.emptyState(),
      loadOverlay: testDeps.loadOverlay || (async () => mediaStore().loadState()),
      loadModels: testDeps.loadModels || (async () => {
        const cfg = await aiConfig.loadConfig();
        const keyConfigured = await aiConfig.isKeyConfigured();
        const jevLoaded = await aiConfig.loadJevWithStatus();
        return aiConfig.describeSetup({
          cfg, judgeModel: ACQ_JUDGE_MODEL, keyConfigured,
          jevConfigured: Boolean(jevLoaded.public && jevLoaded.public.credentialConfigured),
        });
      }),
      runtime,
      now: testDeps.now || new Date(),
    });
    return respond(200, snapshot);
  } catch (e) {
    log({ evt: 'admin-diagnostics-failed', error: String(e && e.message || e) });
    return respond(200, diagnosticsInspect.failureSnapshot(e, runtime));
  }
}

module.exports = { setDiagnosticsDepsForTests, adminDiagnostics };
