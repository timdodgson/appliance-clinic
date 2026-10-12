/* ApplianceClinic chat session — browser-side conversation lifecycle.
 *
 * Visible transcript (session.turns) and diagnostic API context
 * (buildApiMessages / conversationWindow, last 12) are different concerns.
 * This module does not call /api and does not change diagnostic meaning.
 *
 * Works in the browser (window.ACChatSession) and in Node tests (module.exports).
 */
(/** @param {any} root @param {() => any} factory */ function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.ACChatSession = api;
})(typeof window !== 'undefined' ? window : typeof global !== 'undefined' ? global : this, function () {
  'use strict';

  var SCHEMA_VERSION = 1;
  var STORAGE_KEY = 'ac.chat.session.v1';
  var MAX_API_MESSAGES = 12;
  var MAX_VISIBLE_TURNS = 80;
  var MAX_JSON_CHARS = 400000;
  var PHOTO_ONLY_LABEL = '\uD83D\uDCF7 Photo of rating plate';
  var PHOTO_PROMPT =
    'Please read the rating plate in this image and identify the appliance brand, model number and any other useful details for finding spare parts.';

  function newId() {
    try {
      if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
    } catch (e) { /* ignore */ }
    return 's-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
  }

  function nowIso() {
    return new Date().toISOString();
  }

  function createSession() {
    var ts = nowIso();
    return {
      v: SCHEMA_VERSION,
      id: newId(),
      startedAt: ts,
      updatedAt: ts,
      placeholder: '',
      draft: '',
      turns: [],
    };
  }

  // Keep the latest turns, but never start the payload on an assistant message.
  // The BFF accepts 12 turns; a shorter window that starts on an assistant
  // turn is invalid for the UNDERSTAND LM (system + assistant) and also drops
  // the customer's opening report.
  function conversationWindow(hist, cap) {
    cap = cap || MAX_API_MESSAGES;
    if (!hist || !hist.length) return [];
    var firstUser = -1;
    for (var i = 0; i < hist.length; i++) {
      if (hist[i] && hist[i].role === 'user') { firstUser = i; break; }
    }
    if (firstUser < 0) return [];
    var start = Math.max(0, hist.length - cap);
    if (start < firstUser) start = firstUser;
    if (hist[start] && hist[start].role !== 'user') {
      var opening = hist[firstUser];
      var tail = hist.slice(-(cap - 1));
      var out = [opening];
      for (var j = 0; j < tail.length; j++) {
        if (tail[j] !== opening) out.push(tail[j]);
      }
      return out;
    }
    return hist.slice(start);
  }

  function compactShownMedia(items) {
    if (!Array.isArray(items) || !items.length) return [];
    return items.map(function (m) {
      if (!m) return null;
      return {
        id: m.id || null,
        type: m.type || null,
        intent: m.intent || null,
        title: m.title || '',
        url: m.url || null,
        alt: m.alt || '',
        description: m.description || '',
        caption: m.caption || '',
        embedUrl: m.embedUrl || null,
        videoId: m.videoId || null,
        attribution: m.attribution || '',
        sourcePageUrl: m.sourcePageUrl || null,
      };
    }).filter(function (m) { return m && (m.id || m.title || m.url || m.videoId || m.embedUrl); });
  }

  function compactShownSafety(si) {
    if (!si) return undefined;
    var text = typeof si === 'string' ? si : si.text;
    if (!text) return undefined;
    return { text: String(text) };
  }

  function compactParts(parts) {
    if (!Array.isArray(parts) || !parts.length) return [];
    return parts.map(function (p) {
      if (!p) return null;
      var offers = Array.isArray(p.offers) ? p.offers.slice(0, 2).map(function (o) {
        if (!o) return null;
        return {
          price: typeof o.price === 'number' ? o.price : null,
          currency: o.currency || null,
          url: o.url || null,
          retailer: o.retailer || null,
        };
      }).filter(Boolean) : [];
      return {
        name: p.name || 'Part',
        imageUrl: p.imageUrl || null,
        fitStatus: p.fitStatus || null,
        offers: offers,
      };
    }).filter(Boolean);
  }

  function compactDiagnosis(d) {
    if (!d || typeof d !== 'object') return undefined;
    var out = {};
    if (d.label) out.label = String(d.label);
    if (d.summary) out.summary = String(d.summary);
    return (out.label || out.summary) ? out : undefined;
  }

  // UI-facing assistant payload only. Drops trace/debug/internal fields.
  function compactView(view) {
    if (!view || typeof view !== 'object') return {};
    var out = {};
    if (view.reply) out.reply = String(view.reply);
    if (view.advisory) out.advisory = true;
    if (view.safety) out.safety = true;
    var diag = compactDiagnosis(view.diagnosis);
    if (diag) out.diagnosis = diag;
    if (view.needsModel) out.needsModel = true;
    if (view.extractedModel) out.extractedModel = view.extractedModel;
    var safety = compactShownSafety(view.safetyInformation);
    if (safety) {
      out.safetyInformation = safety;
      if (view.safetyInformation && typeof view.safetyInformation === 'object' && view.safetyInformation.classification) {
        out.safetyInformation = { text: safety.text, classification: String(view.safetyInformation.classification) };
      }
    }
    var media = compactShownMedia(view.media);
    if (media.length) out.media = media;
    var parts = compactParts(view.parts);
    if (parts.length) out.parts = parts;
    return out;
  }

  function userTurnRecord(text, image) {
    var content = text || PHOTO_PROMPT;
    var display = text || PHOTO_ONLY_LABEL;
    return {
      role: 'user',
      content: content,
      display: display === content ? undefined : display,
      photo: !!image,
      turnId: newId(),
      ts: nowIso(),
    };
  }

  function assistantTurnRecord(view) {
    var compact = compactView(view || {});
    return {
      role: 'assistant',
      content: compact.reply || '',
      view: compact,
      ts: nowIso(),
    };
  }

  function diagnosticMessagesFromTurns(turns) {
    if (!Array.isArray(turns)) return [];
    var out = [];
    for (var i = 0; i < turns.length; i++) {
      var t = turns[i];
      if (!t || (t.role !== 'user' && t.role !== 'assistant')) continue;
      if (typeof t.content !== 'string') continue;
      var rec = { role: t.role, content: t.content };
      if (t.role === 'assistant' && t.view) {
        if (Array.isArray(t.view.media) && t.view.media.length) rec.media = t.view.media;
        if (t.view.safetyInformation) rec.safetyInformation = compactShownSafety(t.view.safetyInformation);
      }
      // Restored sessions never resend photo bytes (not persisted). The text
      // marker / PHOTO_PROMPT already in `content` is what later API turns use.
      out.push(rec);
    }
    return out;
  }

  // Build the payload: send the photo only on the latest turn (as OpenAI-style
  // multimodal content); earlier photo turns collapse to a text marker so we
  // never resend large image blobs.
  function buildApiMessages(hist) {
    var recent = conversationWindow(hist, MAX_API_MESSAGES);
    return recent.map(function (m, i) {
      var isLatest = i === recent.length - 1;
      if (m.image && isLatest) {
        return {
          role: m.role,
          content: [
            { type: 'text', text: m.content || PHOTO_PROMPT },
            { type: 'image_url', image_url: { url: m.image } },
          ],
        };
      }
      var rec = { role: m.role, content: m.image && !isLatest ? '[Sent a photo] ' + (m.content || '') : m.content };
      if (m.role === 'assistant' && Array.isArray(m.media) && m.media.length) rec.media = m.media;
      if (m.role === 'assistant' && m.safetyInformation) rec.safetyInformation = compactShownSafety(m.safetyInformation);
      return rec;
    });
  }

  function sanitiseTurn(raw) {
    if (!raw || typeof raw !== 'object') return null;
    if (raw.role !== 'user' && raw.role !== 'assistant') return null;
    if (typeof raw.content !== 'string') return null;
    var t = {
      role: raw.role,
      content: raw.content,
      ts: typeof raw.ts === 'string' ? raw.ts : nowIso(),
    };
    if (typeof raw.display === 'string' && raw.display) t.display = raw.display;
    if (raw.photo) t.photo = true;
    if (typeof raw.turnId === 'string' && raw.turnId) t.turnId = raw.turnId;
    if (raw.role === 'assistant') t.view = compactView(raw.view || { reply: raw.content });
    return t;
  }

  function sanitiseSession(raw) {
    if (!raw || typeof raw !== 'object') return null;
    if (raw.v !== SCHEMA_VERSION) return null;
    if (typeof raw.id !== 'string' || !raw.id) return null;
    if (!Array.isArray(raw.turns)) return null;
    var turns = [];
    for (var i = 0; i < raw.turns.length && turns.length < MAX_VISIBLE_TURNS; i++) {
      var t = sanitiseTurn(raw.turns[i]);
      if (t) turns.push(t);
    }
    // An "active conversation" must contain at least one customer turn.
    // Empty / assistant-only blobs are treated as stale.
    var hasUser = turns.some(function (t) { return t.role === 'user'; });
    if (!hasUser) return null;
    return {
      v: SCHEMA_VERSION,
      id: raw.id,
      startedAt: typeof raw.startedAt === 'string' ? raw.startedAt : nowIso(),
      updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : nowIso(),
      placeholder: typeof raw.placeholder === 'string' ? raw.placeholder : '',
      draft: typeof raw.draft === 'string' ? raw.draft : '',
      turns: turns,
      stateToken: safeStateToken(raw.stateToken),
    };
  }

  // Opaque canonical-session token issued by the BFF. Stored and echoed only; never parsed.
  function safeStateToken(t) {
    return (typeof t === 'string' && t.length <= 200 && /^[A-Za-z0-9._-]+$/.test(t)) ? t : undefined;
  }

  function stripHeavyMedia(session) {
    var copy = JSON.parse(JSON.stringify(session));
    (copy.turns || []).forEach(function (t) {
      if (!t || !t.view) return;
      if (Array.isArray(t.view.media)) {
        t.view.media = t.view.media.map(function (m) {
          if (!m) return m;
          m.url = null;
          m.embedUrl = null;
          return m;
        });
      }
      if (Array.isArray(t.view.parts)) {
        t.view.parts.forEach(function (p) { if (p) p.imageUrl = null; });
      }
    });
    return copy;
  }

  function serialise(session) {
    var payload = {
      v: SCHEMA_VERSION,
      id: session.id,
      startedAt: session.startedAt,
      updatedAt: nowIso(),
      placeholder: session.placeholder || '',
      draft: typeof session.draft === 'string' ? session.draft.slice(0, 4000) : '',
      turns: (session.turns || []).slice(-MAX_VISIBLE_TURNS).map(function (t) {
        return sanitiseTurn(t);
      }).filter(Boolean),
      stateToken: safeStateToken(session.stateToken),
    };
    var json = JSON.stringify(payload);
    if (json.length > MAX_JSON_CHARS) {
      payload = stripHeavyMedia(payload);
      payload.turns = payload.turns.slice(-40);
      json = JSON.stringify(payload);
    }
    if (json.length > MAX_JSON_CHARS) {
      payload.turns = payload.turns.slice(-20);
      payload.draft = '';
      json = JSON.stringify(payload);
    }
    return json;
  }

  function persist(storage, session) {
    if (!storage || !session) return false;
    try {
      storage.setItem(STORAGE_KEY, serialise(session));
      return true;
    } catch (e) {
      try {
        var slim = stripHeavyMedia(session);
        slim.draft = '';
        slim.turns = (slim.turns || []).slice(-20);
        storage.setItem(STORAGE_KEY, serialise(slim));
        return true;
      } catch (e2) {
        try { storage.removeItem(STORAGE_KEY); } catch (e3) { /* ignore */ }
        return false;
      }
    }
  }

  function load(storage) {
    if (!storage) return null;
    var raw;
    try {
      raw = storage.getItem(STORAGE_KEY);
    } catch (e) {
      return null;
    }
    if (!raw) return null;
    try {
      var parsed = JSON.parse(raw);
      var session = sanitiseSession(parsed);
      if (!session) {
        try { storage.removeItem(STORAGE_KEY); } catch (e2) { /* ignore */ }
        return null;
      }
      return session;
    } catch (e) {
      try { storage.removeItem(STORAGE_KEY); } catch (e2) { /* ignore */ }
      return null;
    }
  }

  function clear(storage) {
    if (!storage) return;
    try { storage.removeItem(STORAGE_KEY); } catch (e) { /* ignore */ }
  }

  function shouldConfirmNewChat(session) {
    return !!(session && Array.isArray(session.turns) && session.turns.length);
  }

  return {
    SCHEMA_VERSION: SCHEMA_VERSION,
    STORAGE_KEY: STORAGE_KEY,
    MAX_API_MESSAGES: MAX_API_MESSAGES,
    MAX_VISIBLE_TURNS: MAX_VISIBLE_TURNS,
    PHOTO_ONLY_LABEL: PHOTO_ONLY_LABEL,
    PHOTO_PROMPT: PHOTO_PROMPT,
    createSession: createSession,
    conversationWindow: conversationWindow,
    buildApiMessages: buildApiMessages,
    compactShownMedia: compactShownMedia,
    compactShownSafety: compactShownSafety,
    compactView: compactView,
    userTurnRecord: userTurnRecord,
    assistantTurnRecord: assistantTurnRecord,
    diagnosticMessagesFromTurns: diagnosticMessagesFromTurns,
    sanitiseSession: sanitiseSession,
    persist: persist,
    load: load,
    clear: clear,
    serialise: serialise,
    shouldConfirmNewChat: shouldConfirmNewChat,
  };
});
