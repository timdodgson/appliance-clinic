'use strict';
/**
 * Wires the turn (turn.js) to the engine's real dependencies: the advisor's model (Claude, with tool use), the
 * error-code service (MCP), the Spares4Repairs parts catalogue (parts-for-model) and the media join (shipped catalogue
 * + admin overlay).
 */
const { getAdvisorProvider } = require('../engine/config.js');
const { getPartsForModel } = require('../engine/parts-client.js');
const { previouslyShownMedia } = require('../engine/conversation.js');
const media = require('../media.js');
const { resolveErrorCode } = require('./mcp.js');
const { runTurn } = require('./turn.js');
const { ProviderUnavailableError } = require('./util.js');

/** Candidate media for the knowledge nodes in play; the advisor picks the one that shows its step. */
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
  return { name: null, model: null, converse: fail };
};

async function turn({ messages, state, tools }) {
  // Set-up failures are deferred to first use, so a gas or fire stop (no model needed) still answers.
  let provider;
  try { provider = await getAdvisorProvider(); } catch (e) { provider = unavailable('advisor model', e); }
  const mcp = { url: process.env.MCP_URL || null, token: process.env.MCP_BEARER_TOKEN || null };
  return runTurn({ messages, state, tools }, {
    provider,
    resolveCode: (q) => resolveErrorCode(q, mcp),
    lookupParts: (model) => getPartsForModel(model),
    mediaCandidates,
  });
}

module.exports = { turn, ProviderUnavailableError, mediaCandidates };
