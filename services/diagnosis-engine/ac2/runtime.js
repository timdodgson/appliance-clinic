'use strict';
/**
 * Wires the turn (turn.js) to the engine's real dependencies: Qwen (the admin-configured inference provider), Jev
 * (TypeSafe Jev on Workers AI), the error-code service (MCP), the external S4R parts catalogue (parts-for-model) and
 * the media join (shipped catalogue + admin overlay).
 */
const { getProviders } = require('../engine/config.js');
const { getPartsForModel } = require('../engine/parts-client.js');
const { previouslyShownMedia } = require('../engine/conversation.js');
const { loadAdminInference } = require('../admin-config.js');
const { evaluateJevWithRetries } = require('../jev-client.js');
const media = require('../media.js');
const { resolveErrorCode } = require('./mcp.js');
const { runTurn } = require('./turn.js');
const { ProviderUnavailableError } = require('./util.js');

const JEV_TIMEOUT_MS = Number(process.env.AC3_JEV_TIMEOUT_MS || 12000);

/** Candidate media for the knowledge nodes in play; Jev picks the one that matches the reply's check. */
async function mediaCandidates(knowledgeIds, { make, model, messages }) {
  try {
    await media.ensureMediaOverlay();
    const join = media.getEffectiveMediaJoin().byKnowledgeId || {};
    const pool = knowledgeIds.flatMap((k) => join[k] || []);
    if (!pool.length) return [];
    return media.selectMedia(pool, { make: make || null, model: model || null, errorCode: null, concepts: [], alreadyShown: previouslyShownMedia(messages) })
      .slice(0, 8)
      .map((m) => (m.type === 'VIDEO'
        ? { id: m.id || null, type: 'VIDEO', title: m.title, caption: m.caption || m.description || '', provider: m.provider || null, videoId: m.videoId || null,
          embedUrl: m.embedUrl || null, sourcePageUrl: m.sourcePageUrl || null, attribution: m.attribution || null, intent: 'SAFE_CHECK' }
        : { id: m.id || null, type: m.type, title: m.title, description: m.description, url: m.asset, alt: m.alt, intent: 'SAFE_CHECK' }));
  } catch {
    return [];
  }
}

/** A dependency that could not be set up: the turn fails explicitly when (and only when) it is used. */
const unavailable = (what, cause) => {
  const fail = async () => { throw new ProviderUnavailableError(`${what} unavailable`, cause); };
  return { name: null, model: null, infer: fail, evaluate: fail };
};

async function turn({ messages, state, tools }) {
  // Set-up failures are deferred to first use, so a gas or fire stop (no model needed) still answers.
  let qwen;
  try { qwen = (await getProviders()).compose; } catch (e) { qwen = unavailable('inference provider', e); }
  let jev;
  try {
    const creds = (await loadAdminInference()).jev;
    if (!creds || !creds.accountId || !creds.apiToken) throw Object.assign(new Error('Jev not configured'), { category: 'CONFIG' });
    jev = { evaluate: ({ state: s, questions }) => evaluateJevWithRetries({ accountId: creds.accountId, apiToken: creds.apiToken, gatewayId: creds.gatewayId, state: s, questions, timeoutMs: JEV_TIMEOUT_MS, attempts: 2 }) };
  } catch (e) {
    jev = unavailable('Jev', e);
  }
  const mcp = { url: process.env.MCP_URL || null, token: process.env.MCP_BEARER_TOKEN || null };
  return runTurn({ messages, state, tools }, {
    qwen,
    jev,
    resolveCode: (q) => resolveErrorCode(q, mcp),
    lookupParts: (model) => getPartsForModel(model),
    mediaCandidates,
  });
}

module.exports = { turn, ProviderUnavailableError };
