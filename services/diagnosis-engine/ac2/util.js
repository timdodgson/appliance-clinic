'use strict';
/** Small helpers shared by the turn steps. */

function textOf(content) {
  if (!Array.isArray(content)) return String(content || '');
  return content.filter((p) => p && p.type === 'text').map((p) => p.text).join(' ') + (content.some((p) => p && p.type === 'image_url') ? ' [photo attached]' : '');
}

function stripThinking(text) {
  return String(text || '').replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
}

function parseJson(text) {
  const t = stripThinking(text).replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  const start = t.indexOf('{');
  const end = t.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try { return JSON.parse(t.slice(start, end + 1)); } catch { return null; }
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

const clean = (s, n = 200) => (typeof s === 'string' && s.trim() ? s.trim().slice(0, n) : null);

module.exports = { textOf, stripThinking, parseJson, ProviderUnavailableError, clean };
