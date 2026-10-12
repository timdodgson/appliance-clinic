'use strict';
/**
 * Transcript helpers for the ac2 turn: the media the advisor has already shown in this conversation.
 */

function previouslyShownMedia(messages) {
  const out = [];
  for (const m of messages || []) {
    if (!m || m.role !== 'assistant' || !Array.isArray(m.media)) continue;
    for (const item of m.media) {
      if (item && typeof item === 'object') out.push(item);
    }
  }
  return out;
}

module.exports = { previouslyShownMedia };
