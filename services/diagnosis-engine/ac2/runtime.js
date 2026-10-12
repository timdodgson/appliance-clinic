'use strict';
/**
 * Wires the ac2 turn (turn.js) to the engine's real dependencies: the admin-configured inference provider, the
 * external S4R parts catalogue (parts-for-model), and the media join (shipped catalogue + admin overlay).
 */
const { getProviders } = require('../engine/config.js');
const { getPartsForModel } = require('../engine/parts-client.js');
const { previouslyShownMedia } = require('../engine/conversation.js');
const media = require('../media.js');
const { runTurn, ProviderUnavailableError } = require('./turn.js');

async function mediaFor(knowledgeIds, { make, model, messages }) {
  try {
    await media.ensureMediaOverlay();
    const join = media.getEffectiveMediaJoin().byKnowledgeId || {};
    const pool = knowledgeIds.flatMap((k) => join[k] || []);
    if (!pool.length) return [];
    return media.selectMedia(pool, { make: make || null, model: model || null, errorCode: null, concepts: [], alreadyShown: previouslyShownMedia(messages) })
      .slice(0, 2)
      .map((m) => (m.type === 'VIDEO'
        ? { id: m.id || null, type: 'VIDEO', title: m.title, caption: m.caption || m.description || '', provider: m.provider || null, videoId: m.videoId || null,
          embedUrl: m.embedUrl || null, sourcePageUrl: m.sourcePageUrl || null, attribution: m.attribution || null, intent: 'SAFE_CHECK' }
        : { id: m.id || null, type: m.type, title: m.title, description: m.description, url: m.asset, alt: m.alt, intent: 'SAFE_CHECK' }));
  } catch {
    return [];
  }
}

async function turn({ messages, state, image, tools }) {
  let providers;
  try {
    providers = await getProviders();
  } catch (e) {
    throw new ProviderUnavailableError('inference provider not configured', e);
  }
  // One provider serves reasoning and claim extraction: the admin AI configuration's COMPOSE route.
  const p = providers.compose;
  return runTurn({ messages, state, image, tools }, { reasoner: p, extractor: p, lookupParts: (model) => getPartsForModel(model), mediaFor });
}

module.exports = { turn, ProviderUnavailableError };
