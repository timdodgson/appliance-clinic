'use strict';
/** Small helpers shared by the turn steps. */

function textOf(content) {
  if (!Array.isArray(content)) return String(content || '');
  return content.filter((p) => p && p.type === 'text').map((p) => p.text).join(' ') + (content.some((p) => p && p.type === 'image_url') ? ' [photo attached]' : '');
}

/** A provider failure that ends the turn with "temporarily unavailable" (no fallback answer). */
class ProviderUnavailableError extends Error {
  constructor(message, cause) {
    super(message);
    this.name = 'ProviderUnavailableError';
    this.category = (cause && (cause.category || cause.name)) || 'UNAVAILABLE';
    this.status = (cause && cause.status) || null;
    this.detail = cause && cause.detail ? String(cause.detail).slice(0, 300) : null;
  }
}

module.exports = { textOf, ProviderUnavailableError };
