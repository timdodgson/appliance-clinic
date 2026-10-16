/*
 * Test ApplianceClinic workbench — pure logic (no DOM).
 *
 * Builds the SAME diagnose payload the customer product sends, minus
 * production transcript observability. Used by admin.js and unit tests.
 */
(/** @param {any} root @param {() => any} factory */ function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.TacWorkbench = api;
})(typeof window !== 'undefined' ? window : typeof global !== 'undefined' ? global : this, function () {
  'use strict';

  function cloneJson(value) {
    try { return JSON.parse(JSON.stringify(value)); } catch (e) { return null; }
  }

  function humanize(value) {
    if (value == null || value === '') return '';
    return String(value).replace(/_/g, ' ').replace(/\s+/g, ' ').trim();
  }

  function partsCount(view) {
    return (view && Array.isArray(view.parts)) ? view.parts.length : 0;
  }

  function mediaCount(view) {
    return (view && Array.isArray(view.media)) ? view.media.length : 0;
  }

  function safetySummary(view) {
    if (!view) return { label: 'Unknown', kind: 'unknown', stop: false };
    if (view.safety) return { label: 'Stop', kind: 'stop', stop: true };
    var si = view.safetyInformation;
    if (si && si.text) {
      var cls = humanize(si.classification || 'Safety information');
      return { label: cls || 'Safety information', kind: 'info', stop: false };
    }
    return { label: 'Normal', kind: 'normal', stop: false };
  }

  function compactSummary(view) {
    var safety = safetySummary(view);
    return {
      safety: safety.label,
      safetyKind: safety.kind,
      safetyStop: safety.stop,
      parts: partsCount(view),
      media: mediaCount(view),
    };
  }

  function row(label, value) {
    if (value == null || value === '') return null;
    if (Array.isArray(value) && !value.length) return null;
    return { label: label, value: value };
  }

  function section(id, title, rows) {
    var present = (rows || []).filter(Boolean);
    if (!present.length) return null;
    return { id: id, title: title, rows: present };
  }

  function inspectView(view, meta) {
    view = view || {};
    meta = meta || {};
    var diagnosis = section('diagnosis', 'Diagnosis', [
      row('Lead sentence', view.diagnosis && view.diagnosis.summary),
      row('Components', Array.isArray(view.components) && view.components.length
        ? view.components.map(function (c) {
          if (!c) return '';
          return c.name ? (c.rank ? c.name + ' (' + c.rank + ')' : c.name) : '';
        }).filter(Boolean).join(', ')
        : null),
      row('Safety stop', view.safety ? 'Yes' : 'No'),
    ]);
    var partRows = (Array.isArray(view.parts) ? view.parts : []).map(function (p, i) {
      if (!p) return null;
      var bits = [p.name || 'Part'];
      if (p.canonicalPartId) bits.push(p.canonicalPartId);
      if (p.fitStatus) bits.push(p.fitStatus);
      return row('Part ' + (i + 1), bits.join(' · '));
    });
    var parts = section('parts', 'Parts', partRows);
    var mediaRows = (Array.isArray(view.media) ? view.media : []).map(function (m, i) {
      if (!m) return null;
      var bits = [m.title || m.id || 'Media'];
      if (m.type) bits.push(m.type);
      if (m.intent) bits.push(m.intent);
      if (m.id) bits.push(m.id);
      return row('Media ' + (i + 1), bits.join(' · '));
    });
    var media = section('media', 'Media', mediaRows);
    var si = view.safetyInformation;
    var safety = section('safety', 'Safety', [
      row('State', view.safety ? 'Stop' : (si && si.text ? 'Information shown' : 'Normal')),
      row('Classification', si && si.classification),
      row('Customer text', si && si.text),
    ]);
    var request = section('request', 'Request', [
      row('Request ID', view.requestId || meta.requestId || null),
      row('Trace ID', view.traceId || meta.traceId || null),
      row('Client time', typeof meta.durationMs === 'number' ? String(Math.round(meta.durationMs)) + ' ms' : null),
      row('Conversation window', typeof meta.windowCount === 'number'
        ? String(meta.windowCount) + ' message' + (meta.windowCount === 1 ? '' : 's') + ' (cap ' + (meta.windowCap || 12) + ')'
        : null),
    ]);
    return {
      sections: [diagnosis, parts, media, safety, request].filter(Boolean),
    };
  }

  function redactImages(value) {
    if (Array.isArray(value)) return value.map(redactImages);
    if (!value || typeof value !== 'object') return value;
    if (value.image_url && typeof value.image_url === 'object') {
      return { type: value.type || 'image_url', image_url: { url: '[image]' } };
    }
    var out = Array.isArray(value) ? [] : {};
    Object.keys(value).forEach(function (k) {
      if (k === 'image' && typeof value[k] === 'string') out[k] = '[image]';
      else out[k] = redactImages(value[k]);
    });
    return out;
  }

  // The state token is a bearer credential for the conversation's server-side evidence ledger:
  // the technical payload shows only whether one was present.
  function redactToken(obj) {
    if (obj && typeof obj === 'object' && Object.prototype.hasOwnProperty.call(obj, 'stateToken')) {
      obj.stateToken = obj.stateToken ? '[state token — redacted]' : obj.stateToken;
    }
    return obj;
  }
  function rawPayload(requestBody, view, error) {
    return {
      request: redactToken(redactImages(cloneJson(requestBody) || {})),
      response: view ? redactToken(redactImages(cloneJson(view) || {})) : null,
      error: error ? String(error) : null,
    };
  }

  // ---- Live Test conversation (one per "New conversation"; never persisted) -------------------
  // Mirrors the customer client (app.js): the same ACChatSession message window, and the opaque
  // `stateToken` from the last response echoed back verbatim on the next turn. The token
  // is never parsed, displayed or stored anywhere but this in-memory object.
  var TOKEN_RE = /^[A-Za-z0-9._-]+$/;
  function safeToken(t) { return (typeof t === 'string' && t.length > 0 && t.length <= 200 && TOKEN_RE.test(t)) ? t : null; }
  function randomPart() {
    try {
      if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID().replace(/-/g, '');
    } catch (e) { /* fall through */ }
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 12);
  }
  function createLiveConversation() {
    return {
      sessionId: 'lt-' + randomPart(),   // the test conversation's id in the API logs (never a customer transcript)
      messages: [],                      // the same shape the customer client keeps
      turns: [],                         // per-turn record: continuity status, timings
      stateToken: null,                  // opaque; echoed back, never inspected
      stateProblem: null,                // { kind, reason, turn } when the API rejected / did not renew state
      lastStatus: null,
      startedAt: new Date().toISOString(),
    };
  }
  function resetLiveConversation(c) {
    var fresh = createLiveConversation();
    Object.keys(c).forEach(function (k) { delete c[k]; });
    Object.keys(fresh).forEach(function (k) { c[k] = fresh[k]; });
    return c;
  }
  function addUserTurn(c, content, opts) {
    opts = opts || {};
    var msg = { role: 'user', content: content };
    if (opts.display && opts.display !== content) msg.display = opts.display;
    if (opts.image) msg.image = opts.image;
    c.messages.push(msg);
    var turn = { index: c.turns.length + 1, sentAt: null, durationMs: null, status: null, error: null, tokenSent: false };
    c.turns.push(turn);
    return turn;
  }
  function currentTurn(c) { return c && c.turns.length ? c.turns[c.turns.length - 1] : null; }

  // conv/turn omitted → the original messages-only body (kept for the existing callers/tests).
  function buildDiagnoseBody(hist, Session, conv, turn) {
    if (!Session || typeof Session.buildApiMessages !== 'function') {
      throw new Error('ACChatSession required');
    }
    var body = { messages: Session.buildApiMessages(hist) };
    if (!conv) return body;
    var t = turn || currentTurn(conv);
    // Exactly what app.js ask() does: send the last token we were given, if any.
    if (conv.stateToken) body.stateToken = conv.stateToken;
    body.liveTest = { sessionId: conv.sessionId };
    if (t) t.tokenSent = Boolean(conv.stateToken);
    return body;
  }

  /**
   * Take a successful response: store the replacement token exactly as the customer client does
   * (replace when one is returned, otherwise keep the previous one), record the continuity status,
   * and flag — never hide — a rejected / missing state.
   */
  function acceptResponse(c, view, Session) {
    var turn = currentTurn(c);
    var status = (view && view.liveTest && typeof view.liveTest === 'object') ? view.liveTest : null;
    var hadToken = Boolean(c.stateToken);
    var next = safeToken(view && view.stateToken);
    if (next) c.stateToken = next;
    c.lastStatus = status;
    if (turn) turn.status = status;
    /** @type {{ kind: string, reason: any, turn?: number | null } | null} */
    var problem = null;
    if (status && status.continuity === 'restarted') problem = { kind: 'restarted', reason: status.reason || null };
    else if (status && (status.continuity === 'unavailable' || status.stateOut === 'none')) problem = { kind: 'unavailable', reason: status.reason || null };
    else if (!status) problem = { kind: 'no_status', reason: null };
    else if (hadToken && !next) problem = { kind: 'unavailable', reason: 'no_token_issued' };
    if (problem) { problem.turn = turn ? turn.index : null; c.stateProblem = problem; }
    if (view && typeof view.reply === 'string') {
      var stored = {};
      Object.keys(view).forEach(function (k) { if (k !== 'stateToken') stored[k] = view[k]; });
      c.messages.push({
        role: 'assistant',
        content: view.reply,
        view: stored,
        media: Session && Session.compactShownMedia ? Session.compactShownMedia(view.media) : undefined,
        safetyInformation: Session && Session.compactShownSafety ? Session.compactShownSafety(view.safetyInformation) : undefined,
      });
    }
    return problem;
  }
  // A turn cannot be sent while a state problem is unacknowledged: the admin chooses explicitly.
  function canSend(c) { return !(c && c.stateProblem); }
  // "Continue as a customer would": keep the replacement token the API issued and go on.
  function acknowledgeStateProblem(c) { if (c) c.stateProblem = null; }

  var CONTINUITY_LABELS = {
    'new': 'New conversation state issued',
    continued: 'Continued',
    restarted: 'Rejected — the API started a new conversation state',
    failed: 'Failed — this turn was not answered; the conversation state was not advanced',
    unavailable: 'Not renewed — no state token was returned',
  };
  var REASON_LABELS = {
    expired: 'the state token had expired',
    bad_signature: 'the state token signature was not valid',
    malformed: 'the state token was malformed',
    no_secret: 'the API has no signing secret',
    no_signing_secret: 'the API has no signing secret',
    no_token_issued: 'no replacement token was returned',
    state_load_failed: 'the saved state could not be read',
    state_secret_unavailable: 'the API has no signing secret',
    advisor_unavailable: 'the advisor model was unavailable',
    reasoner_unavailable: 'the diagnosis reasoner was unavailable',
    engine_unreachable: 'the diagnosis engine could not be reached',
  };
  function continuityLabel(status) {
    if (!status) return 'No continuity status returned';
    return CONTINUITY_LABELS[status.continuity] || humanize(status.continuity);
  }
  function reasonLabel(reason) { return reason ? (REASON_LABELS[reason] || humanize(reason)) : ''; }
  // Safe, token-free summary for the UI.
  function stateSummary(c) {
    if (!c || !c.turns.length) return { label: 'Not started', kind: 'idle', tokenPresent: false, turns: 0 };
    if (c.stateProblem) return { label: c.stateProblem.kind === 'restarted' ? 'Rejected' : 'Not renewed', kind: 'problem', tokenPresent: Boolean(c.stateToken), turns: c.turns.length };
    return { label: c.stateToken ? 'Active' : 'No state token', kind: c.stateToken ? 'active' : 'none', tokenPresent: Boolean(c.stateToken), turns: c.turns.length };
  }
  function problemMessage(p) {
    if (!p) return '';
    if (p.kind === 'restarted') {
      return 'Conversation state was rejected' + (p.reason ? ' (' + reasonLabel(p.reason) + ')' : '') + '. This turn ran without the earlier state and the API issued a new session — exactly what a customer would get. Start a new conversation, or continue on the new session.';
    }
    if (p.kind === 'no_status') return 'The API did not return a Live Test continuity status, so continuity cannot be confirmed. Start a new conversation to continue.';
    return 'Conversation state was not renewed' + (p.reason ? ' (' + reasonLabel(p.reason) + ')' : '') + '. The next turn would not carry this conversation\u2019s state. Start a new conversation to continue.';
  }

  /** Inspect rows for the continuity status and the turn's ac2 audit (booleans, counts and safe labels; never the token). */
  function continuityRows(status, turn) {
    if (!status) return [];
    var a = status.audit || null;
    var customer = (a && a.customer) || {};
    var safety = (a && a.safety) || {};
    var hazards = (a && Array.isArray(a.hazards) && a.hazards.length) ? a.hazards : (safety.hazards || []);
    return [
      row('State in', status.stateIn === 'present' ? 'Prior state token sent' : 'No prior state token'),
      row('State out', status.stateOut === 'refreshed' ? 'Refreshed (same session)' : (status.stateOut === 'issued' ? 'New session token issued' : 'None returned')),
      row('Continuity', continuityLabel(status) + (status.reason ? ' — ' + reasonLabel(status.reason) : '')),
      row('Engine', status.engine || null),
      row('Engine turn', a && a.turn != null ? String(a.turn) : null),
      row('Advisor', a && a.provider ? [a.provider.name, a.provider.model].filter(Boolean).join(' · ') : null),
      row('Outcome', a && a.outcome),
      row('Appliance', [customer.appliance, customer.brand, customer.model].filter(Boolean).join(' · ') || null),
      row('Tools called', a && Array.isArray(a.toolCalls) && a.toolCalls.length ? a.toolCalls.join(', ') : null),
      row('Hazards', hazards.length ? hazards.join(', ') : null),
      row('Guardrail gates', safety.gates && safety.gates.length ? safety.gates.map(function (g) { return g && g.gate; }).filter(Boolean).join(', ') : null),
      row('Part gate', a && a.partGate && a.partGate.outcome),
      row('Escalation', a && a.escalation && a.escalation.reason ? a.escalation.reason : null),
      row('Turn time', turn && typeof turn.durationMs === 'number' ? Math.round(turn.durationMs) + ' ms' : null),
    ];
  }

  function usesObservability(body) {
    return !!(body && Object.prototype.hasOwnProperty.call(body, 'observability'));
  }

  function canRetry(messages, error) {
    if (!error) return false;
    if (!Array.isArray(messages) || !messages.length) return false;
    return messages[messages.length - 1].role === 'user';
  }

  function emptyState() {
    return {
      messages: [],
      lastView: null,
      lastError: null,
      lastRequest: null,
      lastDurationMs: null,
      scenarioId: null,
      scenarioTitle: null,
      pendingImage: null,
    };
  }

  return {
    createLiveConversation: createLiveConversation,
    resetLiveConversation: resetLiveConversation,
    addUserTurn: addUserTurn,
    currentTurn: currentTurn,
    acceptResponse: acceptResponse,
    canSend: canSend,
    acknowledgeStateProblem: acknowledgeStateProblem,
    continuityLabel: continuityLabel,
    reasonLabel: reasonLabel,
    stateSummary: stateSummary,
    problemMessage: problemMessage,
    continuityRows: continuityRows,
    redactToken: redactToken,
    buildDiagnoseBody: buildDiagnoseBody,
    usesObservability: usesObservability,
    compactSummary: compactSummary,
    safetySummary: safetySummary,
    inspectView: inspectView,
    rawPayload: rawPayload,
    redactImages: redactImages,
    canRetry: canRetry,
    emptyState: emptyState,
    partsCount: partsCount,
    mediaCount: mediaCount,
  };
});
