/* Appliance Clinic — customer chat client.
 * Depends ONLY on the Appliance Clinic contract returned by /api (the whichpart-api BFF in services/whichpart-api).
 * Diagnosis happens server-side; this file renders the reply, safety, media and any part cards the API returns.
 *
 * Chat session lifecycle (persist / restore / New chat) lives here and in
 * chat-session.js. Visible transcript history and the bounded diagnostic
 * request window are different concerns — do not enlarge /api context
 * merely because the browser retained more turns.
 */
(function () {
  'use strict';

  // Same-origin API via the CloudFront /api behaviour. Override for local dev
  // with:  window.WHICHPART_API_BASE = 'https://<lambda-furl>'
  var API_BASE = window.WHICHPART_API_BASE || '/api';
  var Session = window.ACChatSession;
  var WebMCP = window.ACWebMCP; // optional: WebMCP integration (additive, feature-detected)
  var storage = (function () {
    try { return window.localStorage; } catch (e) { return null; }
  })();

  // Rating-plate photos are downscaled client-side before upload to stay well
  // within request limits — the engine only needs to read the text, not print it.
  var MAX_IMAGE_WIDTH = 800;
  var JPEG_QUALITY = 0.7;
  var PHOTO_ONLY_LABEL = Session.PHOTO_ONLY_LABEL;
  var PHOTO_PROMPT = Session.PHOTO_PROMPT;
  var LANDING_PLACEHOLDER = 'What’s wrong with your appliance?';

  var body = document.body;
  var form = document.getElementById('ask');
  var input = /** @type {HTMLTextAreaElement} */ (document.getElementById('input'));
  var send = /** @type {HTMLButtonElement} */ (document.getElementById('send'));
  var thread = document.getElementById('thread');
  var camBtn = /** @type {HTMLButtonElement} */ (document.getElementById('cam'));
  var fileInput = /** @type {HTMLInputElement} */ (document.getElementById('file'));
  var preview = document.getElementById('preview');
  var previewImg = /** @type {HTMLImageElement} */ (document.getElementById('previewImg'));
  var previewRemove = document.getElementById('previewRemove');
  var askStatus = document.getElementById('askStatus');
  var retryBtn = document.getElementById('retryBtn');
  var newChatBtn = document.getElementById('newChatBtn');
  var mNewChat = document.getElementById('mNewChat');
  var newChatModal = document.getElementById('newChatModal');
  var hubIntentModal = document.getElementById('hubIntentModal');
  var HUB_INTENT_KEY = 'ac.hub.intent.v1';
  var pendingHubIntent = null;

  // Full diagnostic conversation ({ role, content, image? }). The VISIBLE
  // transcript may be longer; /api still receives only conversationWindow().
  var messages = [];
  var session = Session.createSession();
  var lastView = null; // latest assistant BFF view (customer-visible); read by the WebMCP state tool
  var pendingImage = null; // compressed data URL awaiting the next send
  var busy = false;
  var threadPinned = true;
  var hydrating = false;
  var DEFAULT_ASK_STATUS = 'Couldn’t reach the diagnosis service. Your conversation is unchanged.';
  var OFFLINE_ASK_STATUS = 'You’re offline. Diagnosis needs an internet connection. Your conversation is unchanged — try again when you’re back online.';
  var askStatusText = document.getElementById('askStatusText');

  // Feedback thumb icons — proper inline SVG (coloured via CSS, sage), not emoji.
  var THUMB_UP_SVG =
    '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M7 10v11H4a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1zM7 10l5-8a2.5 2.5 0 0 1 2.5 2.5V8h4.6a2 2 0 0 1 2 2.32l-1.3 8A2 2 0 0 1 17.8 20H7z"/></svg>';
  var THUMB_DOWN_SVG =
    '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 14V3h3a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1zM17 14l-5 8a2.5 2.5 0 0 1-2.5-2.5V16H4.9a2 2 0 0 1-2-2.32l1.3-8A2 2 0 0 1 6.2 4H17z"/></svg>';

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    submit();
  });

  input.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (!busy) submit();
    }
  });
  input.addEventListener('input', function () {
    autosizeInput();
    scheduleDraftPersist();
  });

  // --- image capture / upload ----------------------------------------------

  camBtn.addEventListener('click', function () {
    if (!busy) fileInput.click();
  });
  fileInput.addEventListener('change', function () {
    var file = fileInput.files && fileInput.files[0];
    if (file) processImageFile(file);
    fileInput.value = '';
  });
  previewRemove.addEventListener('click', clearPendingImage);

  // Landing entry cards — wired to REAL features only (no fake functionality):
  //  • "Scan rating plate" opens the same rating-plate camera/file picker as the composer button.
  //  • "Search by model" focuses the diagnostic input (the engine accepts a model/part number there).
  var scanCard = document.getElementById('scanCard');
  var modelCard = document.getElementById('modelCard');
  if (scanCard) scanCard.addEventListener('click', function () { if (!busy) fileInput.click(); });
  if (modelCard) modelCard.addEventListener('click', function () {
    if (busy) return;
    input.placeholder = 'Enter your model or part number\u2026';
    input.focus();
  });

  // Drag & drop anywhere on the page.
  ['dragover', 'drop'].forEach(function (evt) {
    document.addEventListener(evt, function (e) {
      e.preventDefault();
      if (evt === 'drop' && !busy) {
        var dt = /** @type {DragEvent} */ (e).dataTransfer;
        var file = dt && dt.files && dt.files[0];
        if (file) processImageFile(file);
      }
    });
  });

  // Paste an image straight from the clipboard.
  document.addEventListener('paste', function (e) {
    if (busy) return;
    var items = e.clipboardData && e.clipboardData.items;
    if (!items) return;
    for (var i = 0; i < items.length; i++) {
      if (items[i].type.indexOf('image/') === 0) {
        var file = items[i].getAsFile();
        if (file) { e.preventDefault(); processImageFile(file); }
        return;
      }
    }
  });

  function processImageFile(file) {
    if (!file.type || file.type.indexOf('image/') !== 0) return;
    if (file.size > 20 * 1024 * 1024) return; // 20MB guard
    var reader = new FileReader();
    reader.onload = function () {
      compressImage(reader.result).then(setPendingImage);
    };
    reader.readAsDataURL(file);
  }

  function compressImage(dataUrl) {
    return new Promise(function (resolve) {
      var img = new Image();
      img.onload = function () {
        var w = img.width, h = img.height;
        if (w > MAX_IMAGE_WIDTH) { h = Math.round((h * MAX_IMAGE_WIDTH) / w); w = MAX_IMAGE_WIDTH; }
        var canvas = document.createElement('canvas');
        canvas.width = w; canvas.height = h;
        canvas.getContext('2d').drawImage(img, 0, 0, w, h);
        resolve(canvas.toDataURL('image/jpeg', JPEG_QUALITY));
      };
      img.onerror = function () { resolve(dataUrl); };
      img.src = dataUrl;
    });
  }

  function setPendingImage(dataUrl) {
    pendingImage = dataUrl;
    previewImg.src = dataUrl;
    preview.hidden = false;
    input.focus();
  }

  function clearPendingImage() {
    pendingImage = null;
    previewImg.removeAttribute('src');
    preview.hidden = true;
  }

  // --- send / receive -------------------------------------------------------

  function submit() {
    var text = input.value.trim();
    if ((!text && !pendingImage) || busy) return;

    enterStarted();
    hideAskStatus();

    var image = pendingImage;
    addUserTurn(text, image);
    // Store a meaningful instruction so follow-up turns keep context even though
    // we don't resend the (heavy) image on later turns.
    messages.push({ role: 'user', content: text || PHOTO_PROMPT, image: image });
    session.turns.push(Session.userTurnRecord(text, image));
    session.draft = '';
    persistSession();

    input.value = '';
    autosizeInput();
    clearPendingImage();
    setBusy(true);
    requestDiagnosis();
  }

  function requestDiagnosis() {
    var thinking = addThinking();
    // Returns a promise resolving to the BFF view (or null on failure). The normal UI callers ignore
    // the return; the WebMCP bridge awaits it. Error handling/behaviour is unchanged (swallowed here,
    // surfaced via the ask-status banner) so no caller ever sees an unhandled rejection.
    return ask(Session.buildApiMessages(messages))
      .then(function (view) {
        thinking.remove();
        lastView = view || null;
        if (view && typeof view.stateToken === 'string') session.stateToken = view.stateToken;
        renderView(view);
        if (view && view.reply) {
          messages.push({
            role: 'assistant',
            content: view.reply,
            media: compactShownMedia(view.media),
            safetyInformation: compactShownSafety(view.safetyInformation),
          });
          session.turns.push(Session.assistantTurnRecord(view));
          persistSession();
        }
        adjustPlaceholder(view);
        return view || null;
      })
      .catch(function (err) {
        thinking.remove();
        // Leave the transcript intact. Do not invent an assistant turn.
        var msg = String((err && err.message) || '');
        var offline = !navigator.onLine || /Failed to fetch|NetworkError/i.test(msg);
        showAskStatus(offline ? 'offline' : 'network');
        return null;
      })
      .finally(function () {
        setBusy(false);
        input.focus();
      });
  }

  // WebMCP entry point: behaves exactly like the customer typing `text` and pressing send — same
  // engine, same session, same safety path, reply rendered in the SAME conversation. Resolves with
  // the customer-visible reply + structured safety flag + projected state. Additive; the normal UI
  // submit() path is unchanged.
  function webmcpSubmitMessage(text) {
    var clean = String(text == null ? '' : text).trim();
    if (!clean) return Promise.reject(new Error('message is required'));
    if (busy) return Promise.reject(new Error('ApplianceClinic is busy with another turn; try again shortly.'));
    enterStarted();
    hideAskStatus();
    addUserTurn(clean, null);
    messages.push({ role: 'user', content: clean });
    session.turns.push(Session.userTurnRecord(clean, null));
    session.draft = '';
    persistSession();
    input.value = '';
    autosizeInput();
    setBusy(true);
    return requestDiagnosis().then(function (view) {
      var safe = WebMCP ? WebMCP.viewSafetyStop(view) : false;
      var state = WebMCP ? WebMCP.projectState({ messages: messages, lastView: lastView, busy: busy }) : null;
      return { reply: (view && view.reply) || '', safetyStopActive: safe, state: state };
    });
  }

  function webmcpOriginBase() {
    try { return window.location.origin || ''; } catch (e) { return ''; }
  }

  // WebMCP recall tool backend: reuses the EXISTING public Recall Centre API (GET /api/recalls/lookup),
  // the same endpoint apps/whichpart/recalls/recalls.js uses. Returns customer-facing recall info only.
  function webmcpCheckRecall(args) {
    var q = WebMCP ? WebMCP.recallQuery(args) : '';
    var fam = WebMCP ? WebMCP.normalizeFamily(args && args.applianceFamily) : null;
    var url = API_BASE + '/recalls/lookup?q=' + encodeURIComponent(q);
    if (fam) url += '&family=' + encodeURIComponent(fam.id);
    return fetch(url, { headers: { accept: 'application/json' } })
      .then(function (r) { if (!r.ok) throw new Error('recall lookup http ' + r.status); return r.json(); })
      .then(function (j) { return WebMCP.formatRecallResult(j, args, webmcpOriginBase()); });
  }

  // WebMCP appliance-information tool backend: reuses the EXISTING Help Hub content, serialised to a
  // static same-origin JSON (hubs/appliance-info.json, generated from hub-content.cjs). Family-level
  // customer-facing guidance only.
  function webmcpApplianceInformation(args) {
    return fetch('/hubs/appliance-info.json', { headers: { accept: 'application/json' } })
      .then(function (r) { if (!r.ok) throw new Error('appliance info http ' + r.status); return r.json(); })
      .then(function (j) { return WebMCP.formatApplianceInfo(j, args, webmcpOriginBase()); });
  }

  function retryLast() {
    if (busy) return;
    if (!messages.length || messages[messages.length - 1].role !== 'user') return;
    hideAskStatus();
    setBusy(true);
    requestDiagnosis();
  }

  function lastUserTurnId() {
    var turns = (session && session.turns) || [];
    for (var i = turns.length - 1; i >= 0; i--) {
      if (turns[i] && turns[i].role === 'user') return turns[i].turnId || null;
    }
    return null;
  }

  // Bot check (change 21.38): an invisible Cloudflare Turnstile token on the first message of a conversation (one
  // without a state token); the API checks it. Later messages carry the state token instead. Best-effort: if
  // Turnstile cannot load, the message is sent without a token and the API decides.
  var TURNSTILE_SITE_KEY = '0x4AAAAAAFYE0xtNR0AYIP4C';
  var turnstileWidget = null;
  var turnstileWaiter = null;
  function turnstileToken() {
    var ts = window.turnstile;
    if (!ts || typeof ts.render !== 'function') return Promise.resolve(null);
    return new Promise(function (resolve) {
      var done = false;
      function finish(token) {
        if (done) return;
        done = true;
        turnstileWaiter = null;
        resolve(token || null);
      }
      var timer = setTimeout(function () { finish(null); }, 15000);
      turnstileWaiter = function (token) { clearTimeout(timer); finish(token); };
      try {
        if (turnstileWidget === null) {
          var box = document.getElementById('turnstileBox');
          if (!box) {
            box = el('div', 'turnstile-box');
            box.id = 'turnstileBox';
            document.body.appendChild(box);
          }
          turnstileWidget = ts.render(box, {
            sitekey: TURNSTILE_SITE_KEY,
            action: 'chat',
            appearance: 'interaction-only',
            execution: 'execute',
            callback: function (t) { if (turnstileWaiter) turnstileWaiter(t); },
            'error-callback': function () { if (turnstileWaiter) turnstileWaiter(null); },
            'expired-callback': function () { /* a fresh token is requested per conversation */ },
          });
        } else {
          ts.reset(turnstileWidget);
        }
        ts.execute(turnstileWidget);
      } catch (e) {
        clearTimeout(timer);
        finish(null);
      }
    });
  }

  function post(payload) {
    return fetch(API_BASE, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
  }

  function ask(msgs) {
    var payload = { messages: msgs };
    // Opaque BFF-signed canonical-session token: echoed back verbatim, never inspected here.
    var hasState = Boolean(session && typeof session.stateToken === 'string' && session.stateToken);
    if (hasState) payload.stateToken = session.stateToken;
    if (session && session.id) {
      payload.observability = {
        sessionId: session.id,
        clientTurnId: lastUserTurnId(),
        event: 'turn',
      };
    }
    var first = hasState ? Promise.resolve(null) : turnstileToken();
    return first.then(function (t) {
      if (t) payload.turnstile = t;
      return post(payload);
    }).then(function (r) {
      // A state token the API no longer accepts (e.g. expired) makes this a new conversation: retry once with a check.
      // The API answers 428 (bot_check_failed); 403 is rewritten to the site's 404 page by CloudFront.
      if ((r.status === 428 || r.status === 403) && !payload.turnstile) {
        return turnstileToken().then(function (t) {
          if (!t) return r;
          payload.turnstile = t;
          return post(payload);
        });
      }
      return r;
    }).then(function (r) {
      if (!r.ok) throw new Error('http ' + r.status);
      return r.json();
    });
  }

  function notifySessionEnded(id) {
    if (!id) return;
    try {
      fetch(API_BASE, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ observability: { sessionId: id, event: 'end' } }),
        keepalive: true,
      }).catch(function () { /* end-event is best-effort; never block New chat */ });
    } catch (e) { /* ignore */ }
  }

  // --- session lifecycle ----------------------------------------------------

  function persistSession() {
    session.placeholder = input.placeholder || '';
    session.updatedAt = new Date().toISOString();
    Session.persist(storage, session);
  }

  var draftTimer = 0; // debounces saving the unsent draft (declared: this file is strict mode)
  function scheduleDraftPersist() {
    session.draft = input.value || '';
    if (draftTimer) clearTimeout(draftTimer);
    draftTimer = setTimeout(function () {
      draftTimer = 0;
      if (session.turns && session.turns.length) persistSession();
    }, 300);
  }

  function enterStarted() {
    if (!body.classList.contains('started')) body.classList.add('started');
    showSessionControls(true);
  }

  function showSessionControls(on) {
    if (newChatBtn) newChatBtn.hidden = !on;
    if (mNewChat) mNewChat.hidden = !on;
  }

  function showAskStatus(kind) {
    if (!askStatus) return;
    if (askStatusText) {
      askStatusText.textContent = (kind === 'offline' || !navigator.onLine)
        ? OFFLINE_ASK_STATUS
        : DEFAULT_ASK_STATUS;
    }
    askStatus.hidden = false;
    if (retryBtn) retryBtn.hidden = !(messages.length && messages[messages.length - 1].role === 'user');
  }

  function hideAskStatus() {
    if (askStatus) askStatus.hidden = true;
  }

  function hydrateFromStorage() {
    var stored = Session.load(storage);
    if (!stored) return;
    hydrating = true;
    thread.setAttribute('aria-live', 'off');
    session = stored;
    messages = [];
    enterStarted();
    stored.turns.forEach(function (t) {
      if (t.role === 'user') {
        addUserTurn(t.display || (t.photo ? PHOTO_ONLY_LABEL : t.content), null);
        messages.push({ role: 'user', content: t.content });
      } else if (t.role === 'assistant') {
        addBotTurn(t.view || { reply: t.content });
        var rec = { role: 'assistant', content: t.content || (t.view && t.view.reply) || '' };
        if (t.view && Array.isArray(t.view.media) && t.view.media.length) rec.media = t.view.media;
        if (t.view && t.view.safetyInformation) rec.safetyInformation = compactShownSafety(t.view.safetyInformation);
        messages.push(rec);
      }
    });
    if (stored.placeholder) input.placeholder = stored.placeholder;
    if (stored.draft) {
      input.value = stored.draft;
      autosizeInput();
    }
    thread.setAttribute('aria-live', 'polite');
    hydrating = false;
    threadPinned = true;
    scrollThread(true);
  }

  function resetToNewChat() {
    var endedId = session && session.turns && session.turns.length ? session.id : null;
    notifySessionEnded(endedId);
    Session.clear(storage);
    session = Session.createSession();
    messages = [];
    pendingImage = null;
    busy = false;
    threadPinned = true;
    hideAskStatus();
    clearPendingImage();
    thread.innerHTML = '';
    body.classList.remove('started');
    showSessionControls(false);
    input.value = '';
    input.placeholder = LANDING_PLACEHOLDER;
    input.disabled = false;
    autosizeInput();
    setBusy(false);
    closeNewChatModal();
    input.focus();
  }

  function requestNewChat() {
    if (!Session.shouldConfirmNewChat(session)) {
      resetToNewChat();
      return;
    }
    openNewChatModal();
  }

  function openNewChatModal() {
    if (!newChatModal) {
      if (window.confirm('Start a new chat? This conversation will be cleared from this browser.')) resetToNewChat();
      return;
    }
    newChatModal.hidden = false;
    var confirmBtn = document.getElementById('newChatConfirm');
    setTimeout(function () { if (confirmBtn) confirmBtn.focus(); }, 30);
  }

  function closeNewChatModal() {
    if (newChatModal) newChatModal.hidden = true;
  }

  if (newChatBtn) newChatBtn.addEventListener('click', requestNewChat);
  if (mNewChat) mNewChat.addEventListener('click', function () {
    var menu = document.getElementById('mobileMenu');
    if (menu) menu.hidden = true;
    requestNewChat();
  });
  if (retryBtn) retryBtn.addEventListener('click', retryLast);
  ['newChatCancel', 'newChatClose', 'newChatBackdrop'].forEach(function (id) {
    var n = document.getElementById(id);
    if (n) n.addEventListener('click', closeNewChatModal);
  });
  var newChatConfirm = document.getElementById('newChatConfirm');
  if (newChatConfirm) newChatConfirm.addEventListener('click', resetToNewChat);
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && newChatModal && !newChatModal.hidden) {
      e.preventDefault();
      closeNewChatModal();
      if (newChatBtn) newChatBtn.focus();
    }
  });

  if (thread) {
    thread.addEventListener('scroll', function () {
      var slack = 96;
      threadPinned = (thread.scrollHeight - thread.scrollTop - thread.clientHeight) < slack;
    });
  }

  function syncKeyboardInset() {
    var vv = window.visualViewport;
    if (!vv) {
      document.documentElement.style.setProperty('--keyboard-inset', '0px');
      return;
    }
    var inset = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
    document.documentElement.style.setProperty('--keyboard-inset', inset + 'px');
    if (threadPinned) scrollThread(true);
  }
  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', syncKeyboardInset);
    window.visualViewport.addEventListener('scroll', syncKeyboardInset);
  }
  window.addEventListener('resize', syncKeyboardInset);
  syncKeyboardInset();

  // --- rendering ------------------------------------------------------------

  function addUserTurn(text, image, opts) {
    opts = opts || {};
    var turn = el('div', 'turn turn--user');
    turn.appendChild(el('div', 'turn__who', 'You'));
    if (image) {
      var im = document.createElement('img');
      im.className = 'bubble__img';
      im.src = image;
      im.alt = 'Uploaded photo';
      turn.appendChild(im);
    }
    var label = text || PHOTO_ONLY_LABEL;
    if (opts.photoMarker && !text) label = PHOTO_ONLY_LABEL;
    turn.appendChild(el('div', 'bubble', label));
    thread.appendChild(turn);
    scrollThread();
  }

  // Diagnosis takes ~30-50s (two LLM passes). Rather than a blank bouncing-dots
  // wait, walk through the pipeline stages so the wait feels purposeful. Returns
  // { remove } which also clears the stage timer.
  function addThinking() {
    var turn = el('div', 'turn turn--bot turn--thinking');
    turn.setAttribute('aria-live', 'polite');
    turn.appendChild(el('div', 'turn__who', 'ApplianceClinic'));
    var t = el('div', 'thinking');
    t.innerHTML = '<span></span><span></span><span></span>';
    var status = el('div', 'thinking__status', 'Reading what you\u2019ve told me\u2026');
    turn.appendChild(t);
    turn.appendChild(status);
    thread.appendChild(turn);
    scrollThread(true);

    var stages = [
      'Reading what you\u2019ve told me\u2026',
      'Diagnosing the most likely fault\u2026',
      'Checking the engineering knowledge\u2026',
      'Considering whether a component is involved\u2026',
    ];
    var i = 0;
    var timer = setInterval(function () {
      i = Math.min(i + 1, stages.length - 1);
      status.textContent = stages[i];
    }, 7000);

    return {
      remove: function () {
        clearInterval(timer);
        turn.remove();
      },
    };
  }

  function renderView(view) {
    addBotTurn(view || {});
  }

  function addBotTurn(view) {
    var advice = !!view.advisory;
    // SAFETY_STOP is a structured payload flag (view.safety). Presentation only — never inferred
    // from reply wording. safetyInformation is a separate node-attached panel on ordinary replies.
    var safetyStop = !!view.safety;
    var turn = el('div', 'turn turn--bot' + (advice ? ' turn--advice' : '') + (safetyStop ? ' turn--safety-stop' : ''));
    turn.appendChild(el('div', 'turn__who', 'ApplianceClinic'));

    // ENGINEER-LED RESPONSE. Presentation only: we render the STRUCTURED fields the diagnosis engine
    // already sends (diagnosis.label, diagnosis.summary, reply) — we NEVER parse the prose for
    // phrases or re-interpret it, and never render via innerHTML. The reply/summary are the engine's
    // own words shown verbatim via textContent.
    var resp = el('div', safetyStop ? 'response safety-info safety-info--stop-use' : 'response');
    if (safetyStop) {
      resp.setAttribute('role', 'status');
      var stopHead = el('div', 'safety-info__head');
      var stopIcon = el('span', 'safety-info__icon', '\u26A0');
      stopIcon.setAttribute('aria-hidden', 'true');
      stopHead.appendChild(stopIcon);
      stopHead.appendChild(el('span', 'safety-info__title', safetyTitle('stop-use')));
      resp.appendChild(stopHead);
    }
    // Overline: a maintenance tip, else the grounded fault label (structured, not derived from prose).
    // On a safety-stop the structured heading above is the primary label, so skip the fault overline.
    if (!safetyStop) {
      if (advice) {
        resp.appendChild(el('h3', 'response__diag', 'Maintenance tip'));
      } else if (view.diagnosis && view.diagnosis.label) {
        resp.appendChild(el('h3', 'response__diag', view.diagnosis.label));
      }
    }
    // Lead = the engine's provided primary-finding sentence (diagnosis.summary). Body = the remainder
    // of the engine's reply. If summary is a genuine prefix of reply we split for hierarchy; otherwise
    // the whole reply is the lead (never duplicated, never re-ordered, never phrase-matched).
    var reply = view.reply || '';
    var summary = (view.diagnosis && view.diagnosis.summary) || '';
    var lead = reply;
    var bodyText = '';
    if (summary && reply.indexOf(summary) === 0 && reply.length > summary.length) {
      lead = summary;
      bodyText = reply.slice(summary.length).replace(/^\s+/, '');
    }
    if (lead) {
      var leadEl = el('p', 'response__lead');
      leadEl.textContent = lead; // verbatim engine text; never innerHTML
      resp.appendChild(leadEl);
    }
    if (bodyText) {
      var bodyEl = el('div', 'response__body');
      bodyEl.textContent = bodyText; // verbatim engine text; never innerHTML
      resp.appendChild(bodyEl);
    }
    turn.appendChild(resp);

    // HIERARCHY (unchanged precedence): SAFETY (authoritative, must dominate) -> helpful media ->
    // parts / model request. Safety text is rendered VERBATIM (never generated/edited here).
    if (view.safetyInformation && view.safetyInformation.text && !alreadyShownSafety(view.safetyInformation.text)) {
      turn.appendChild(renderSafetyInformation(view.safetyInformation));
    }

    // Instructional media supporting a customer-safe check — "Helpful to see", visually secondary to
    // the diagnosis and to any safety information.
    if (Array.isArray(view.media) && view.media.length) {
      turn.appendChild(renderMedia(view.media));
    }

    // Parts are the SECONDARY next step after diagnosis (labelled), not the headline. When we still
    // need the model to confirm a part, show a restrained model prompt instead of an error.
    if (Array.isArray(view.parts) && view.parts.length) {
      turn.appendChild(el('div', 'parts__head', view.parts.length > 1 ? 'Likely components involved' : 'Likely component involved'));
      turn.appendChild(renderParts(view.parts));
    } else if (view.needsModel && !view.extractedModel) {
      turn.appendChild(renderModelRequest());
    }

    // 👍/👎 feedback — the right/wrong label that turns the trace corpus into a
    // learning signal. Only shown once we have a real reply + a trace to link to.
    // Restored sessions omit traceId on purpose (internal, not persisted).
    if (view.reply && view.traceId) {
      turn.appendChild(renderFeedback(view.traceId));
    }

    thread.appendChild(turn);
    scrollThread();
  }

  // Restrained model prompt shown when the engine needs the model to confirm a part (needsModel) and
  // no parts are shown yet. Presentation only — model-first behaviour is unchanged server-side.
  function renderModelRequest() {
    var wrap = el('div', 'model-req');
    wrap.appendChild(el('div', 'model-req__label', 'To check a suitable replacement'));
    wrap.appendChild(el('p', 'model-req__text',
      'Enter your model number below. Once we have the model I can check whether a suitable replacement is available. It\u2019s usually on a sticker inside the door or around the frame, or on the back of the appliance.'));
    return wrap;
  }

  function safetyTitle(cls) {
    if (cls === 'stop-use') return 'Stop using this appliance';
    if (cls === 'emergency-action') return 'Emergency \u2014 get help now';
    if (cls === 'do-not-open') return 'Do not open this appliance';
    if (cls === 'maintenance-safety') return 'Caution';
    return 'Caution';
  }

  // Distinct, non-alarmist safety panel. The text is inserted with textContent (never innerHTML,
  // never via the model) so it is displayed exactly as authored. classification only tweaks styling.
  function renderSafetyInformation(si) {
    var cls = String(si.classification || '').toLowerCase().replace(/_/g, '-');
    var wrap = el('div', 'safety-info' + (cls ? ' safety-info--' + cls : ''));
    wrap.setAttribute('role', 'status');
    var head = el('div', 'safety-info__head');
    var icon = el('span', 'safety-info__icon', '\u26A0');
    icon.setAttribute('aria-hidden', 'true');
    head.appendChild(icon);
    head.appendChild(el('span', 'safety-info__title', safetyTitle(cls)));
    wrap.appendChild(head);
    wrap.appendChild(el('p', 'safety-info__text', si.text));
    return wrap;
  }

  // Instructional media (image/diagram = shown inline; video = titled thumbnail link, no autoplay).
  // Content is authored server-side; the client only presents it. Never innerHTML for text.
  // Only embed players from the trusted, privacy-enhanced YouTube host (defence-in-depth: the
  // server already restricts this, the client validates again before creating any iframe).
  function safeEmbedUrl(u) {
    try {
      var url = new URL(String(u));
      if (url.protocol !== 'https:') return null;
      var h = url.hostname.toLowerCase();
      return (h === 'www.youtube-nocookie.com' || h === 'youtube-nocookie.com') ? url.href : null;
    } catch (e) { return null; }
  }

  function openMediaLightbox(src, alt) {
    var ov = el('div', 'media-lightbox');
    ov.setAttribute('role', 'dialog');
    ov.setAttribute('aria-modal', 'true');
    var big = document.createElement('img');
    big.src = src; big.alt = alt || '';
    var close = el('button', 'media-lightbox__close');
    close.type = 'button';
    close.setAttribute('aria-label', 'Close larger view');
    close.innerHTML = '&times;';
    function shut() { if (ov.parentNode) ov.parentNode.removeChild(ov); document.removeEventListener('keydown', onKey); }
    function onKey(e) { if (e.key === 'Escape') shut(); }
    ov.addEventListener('click', function (e) { if (e.target === ov) shut(); });
    close.addEventListener('click', shut);
    document.addEventListener('keydown', onKey);
    ov.appendChild(big);
    ov.appendChild(close);
    document.body.appendChild(ov);
  }

  function compactShownMedia(items) {
    return Session.compactShownMedia(items);
  }

  function compactShownSafety(si) {
    return Session.compactShownSafety(si);
  }

  function alreadyShownSafety(text) {
    var t = String(text || '').trim();
    if (!t) return false;
    return messages.some(function (m) {
      if (!m || m.role !== 'assistant' || !m.safetyInformation) return false;
      var shown = m.safetyInformation;
      var shownText = typeof shown === 'string' ? shown : shown.text;
      return String(shownText || '').trim() === t;
    });
  }

  function renderMedia(items) {
    var wrap = el('div', 'media');
    wrap.appendChild(el('div', 'media__head', 'Helpful to see'));
    items.slice(0, 4).forEach(function (m) {
      // Explanatory intent decides the framing. SAFE_CHECK keeps the existing helpful/instructional
      // presentation; ABOUT is identification/explanation ONLY ("this is the part / where it is") and
      // must never read as a DIY repair instruction.
      var about = (m.intent === 'ABOUT');
      var card = el('div', 'media__item media__item--' + (m.type === 'VIDEO' ? 'video' : 'image')
        + ' media__item--' + (about ? 'about' : 'check'));
      if (about) card.appendChild(el('div', 'media__intent', 'About this part \u00b7 helpful to identify'));
      card.appendChild(el('div', 'media__title', m.title || (about ? 'About this part' : 'How-to')));
      if (m.type === 'VIDEO') {
        var embed = safeEmbedUrl(m.embedUrl);
        if (embed) {
          var frame = el('div', 'media__video');           // responsive 16:9 wrapper (see CSS)
          var ifr = document.createElement('iframe');
          ifr.src = embed;                                  // no autoplay param; player waits for a click
          ifr.title = m.title || 'Instructional video';
          ifr.loading = 'lazy';
          ifr.setAttribute('allow', 'fullscreen; picture-in-picture; encrypted-media'); // NO autoplay
          ifr.setAttribute('allowfullscreen', '');
          ifr.setAttribute('referrerpolicy', 'strict-origin-when-cross-origin');
          ifr.setAttribute('frameborder', '0');
          frame.appendChild(ifr);
          card.appendChild(frame);
        }
        if (m.caption) card.appendChild(el('div', 'media__caption', m.caption));
        var attrib = el('div', 'media__attrib');
        if (m.attribution) attrib.appendChild(el('span', 'media__by', m.attribution));
        // Instructional "full repair guide" link is SAFE_CHECK only — never on ABOUT identification
        // media (that would frame identification content as a repair instruction).
        if (!about && m.sourcePageUrl && /^https:\/\//i.test(m.sourcePageUrl)) {
          var link = document.createElement('a');
          link.className = 'media__guide';
          link.href = m.sourcePageUrl; link.target = '_blank'; link.rel = 'noopener noreferrer';
          link.textContent = 'View full repair guide';
          attrib.appendChild(link);
        }
        if (attrib.childNodes.length) card.appendChild(attrib);
      } else {
        var zoom = el('button', 'media__zoom');
        zoom.type = 'button';
        zoom.setAttribute('aria-label', 'Open a larger view of ' + (m.title || 'the diagram'));
        var im = document.createElement('img');
        im.className = 'media__img';
        im.src = m.url;
        im.alt = m.alt || m.title || 'Instructional diagram';
        im.loading = 'lazy';
        im.onerror = function () { card.style.display = 'none'; };
        zoom.appendChild(im);
        zoom.addEventListener('click', function () { openMediaLightbox(m.url, im.alt); });
        card.appendChild(zoom);
        if (m.description) card.appendChild(el('div', 'media__caption', m.description));
      }
      wrap.appendChild(card);
    });
    return wrap;
  }

  function renderFeedback(traceId) {
    var wrap = el('div', 'feedback');
    wrap.appendChild(el('span', 'feedback__q', 'Was this helpful?'));
    wrap.appendChild(feedbackBtn('up', traceId, wrap));
    wrap.appendChild(feedbackBtn('down', traceId, wrap));
    return wrap;
  }

  function feedbackBtn(rating, traceId, wrap) {
    var b = el('button', 'feedback__btn feedback__btn--' + rating);
    b.type = 'button';
    b.setAttribute('aria-label', rating === 'up' ? 'Helpful' : 'Not helpful');
    b.innerHTML = rating === 'up' ? THUMB_UP_SVG : THUMB_DOWN_SVG;
    b.addEventListener('click', function () {
      sendFeedback(traceId, rating);
      wrap.innerHTML = '';
      wrap.appendChild(el('span', 'feedback__thanks', 'Thanks — that helps us improve.'));
    });
    return b;
  }

  function sendFeedback(traceId, rating) {
    return fetch(API_BASE, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ feedback: { traceId: traceId, rating: rating } }),
    }).catch(function () { /* best-effort; never block the UI */ });
  }

  function renderParts(parts) {
    var wrap = el('div', 'parts');
    parts.forEach(function (p) {
      var card = el('div', 'part');
      // Optional product image (shown only when the contract provides one).
      if (p.imageUrl) {
        var im = document.createElement('img');
        im.className = 'part__img';
        im.src = p.imageUrl;
        im.alt = p.name || 'Part';
        im.loading = 'lazy';
        im.onerror = function () { im.remove(); };
        card.appendChild(im);
      }
      // Text content lives in its own block so it can sit to the RIGHT of the image on wide screens
      // (image-left layout) while stacking below the image on narrow screens.
      var partBody = el('div', 'part__body');
      partBody.appendChild(el('div', 'part__name', p.name || 'Part'));

      var row = el('div', 'part__row');
      var offer = (p.offers && p.offers[0]) || null;
      if (offer && typeof offer.price === 'number') {
        row.appendChild(el('div', 'part__price', formatPrice(offer.price, offer.currency)));
      }
      row.appendChild(fitBadge(p.fitStatus));
      partBody.appendChild(row);

      if (offer && offer.url) {
        var a = document.createElement('a');
        a.className = 'part__cta';
        a.href = offer.url;
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
        a.textContent = 'View at ' + (offer.retailer || 'retailer') + ' →';
        partBody.appendChild(a);
        partBody.appendChild(el('div', 'offer-note', offerNote(p.fitStatus)));
      }
      card.appendChild(partBody);
      wrap.appendChild(card);
    });
    return wrap;
  }

  function fitBadge(status) {
    if (status === 'MODEL_CONFIRMED') {
      return el('span', 'fit fit--confirmed', 'Confirmed fit for your model');
    }
    return el('span', 'fit fit--verify', 'Likely fit — please check');
  }

  function offerNote(status) {
    return status === 'MODEL_CONFIRMED'
      ? 'Matched to your model number.'
      : 'Brand-compatible — check it suits your exact model before buying.';
  }

  function adjustPlaceholder(view) {
    if (view && view.needsModel && !view.extractedModel) {
      input.placeholder = 'Enter your model number…';
    } else {
      input.placeholder = 'Describe what else you’ve noticed…';
    }
    persistSession();
  }

  // --- helpers --------------------------------------------------------------

  function setBusy(v) {
    busy = v;
    send.disabled = v;
    camBtn.disabled = v;
    send.setAttribute('aria-busy', v ? 'true' : 'false');
    if (thread) thread.setAttribute('aria-busy', v ? 'true' : 'false');
    // Keep the text field enabled so a typed follow-up is not lost while waiting.
  }

  function autosizeInput() {
    if (!input || input.tagName !== 'TEXTAREA') return;
    input.style.height = 'auto';
    var next = Math.min(Math.max(input.scrollHeight, 24), 120);
    input.style.height = next + 'px';
  }

  function formatPrice(pence, currency) {
    var pounds = (pence / 100).toFixed(2);
    return (currency === 'GBP' || !currency ? '£' : '') + pounds;
  }

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function scrollThread(force) {
    if (hydrating) return;
    if (!force && !threadPinned) return;
    requestAnimationFrame(function () {
      if (!thread) return;
      thread.scrollTop = thread.scrollHeight;
    });
  }

  hydrateFromStorage();
  autosizeInput();

  // WebMCP (additive, feature-detected). On a browser without document.modelContext this is a
  // complete no-op; the normal ApplianceClinic chat is unaffected. When available (origin trial),
  // it exposes two typed tools that are thin wrappers over this SAME conversation — a read-only
  // state tool and a message tool that behaves exactly like the customer typing. NOT a second engine.
  (function initWebMcp() {
    if (!WebMCP) return;
    try {
      var bridge = {
        getState: function () {
          return WebMCP.projectState({ messages: messages, lastView: lastView, busy: busy });
        },
        submitMessage: function (message) { return webmcpSubmitMessage(message); },
        checkRecall: function (args) { return webmcpCheckRecall(args); },
        getApplianceInformation: function (args) { return webmcpApplianceInformation(args); },
      };
      var reg = WebMCP.registerWhichPartTools(bridge);
      if (reg && reg.supported) { try { console.info('[webmcp] ApplianceClinic tools registered'); } catch (e) {} }
    } catch (e) { /* additive; never break the page */ }
  })();

  function focusAskFromHash() {
    if (location.hash === '#ask' || location.hash === '#assistant') {
      if (input) input.focus();
    }
  }
  window.addEventListener('hashchange', focusAskFromHash);
  focusAskFromHash();

  // Help Hub handoff: one-shot sessionStorage intent (never a public URL).
  // Does not auto-submit. Does not replace an active diagnosis without confirmation.
  function readHubIntent() {
    try {
      var raw = sessionStorage.getItem(HUB_INTENT_KEY);
      if (!raw) return null;
      var data = JSON.parse(raw);
      if (!data || data.v !== 1 || typeof data.draft !== 'string') return null;
      return data;
    } catch (e) {
      return null;
    }
  }
  function clearHubIntent() {
    try { sessionStorage.removeItem(HUB_INTENT_KEY); } catch (e) {}
  }
  function applyHubDraft(draft) {
    if (!input || !draft) return;
    input.value = draft;
    autosizeInput();
    scheduleDraftPersist();
    input.focus();
    try {
      var v = input.value;
      input.setSelectionRange(v.length, v.length);
    } catch (e) {}
  }
  function openHubIntentModal() {
    if (!hubIntentModal) {
      if (window.confirm('Replace this conversation? Starting from the help page will clear it.')) {
        confirmHubIntent();
      } else {
        cancelHubIntent();
      }
      return;
    }
    hubIntentModal.hidden = false;
    var confirmBtn = document.getElementById('hubIntentConfirm');
    setTimeout(function () { if (confirmBtn) confirmBtn.focus(); }, 30);
  }
  function closeHubIntentModal() {
    if (hubIntentModal) hubIntentModal.hidden = true;
  }
  function cancelHubIntent() {
    pendingHubIntent = null;
    clearHubIntent();
    closeHubIntentModal();
  }
  function confirmHubIntent() {
    var intent = pendingHubIntent;
    pendingHubIntent = null;
    closeHubIntentModal();
    clearHubIntent();
    resetToNewChat();
    if (intent && intent.draft) applyHubDraft(intent.draft);
  }
  function consumeHubIntent() {
    var intent = readHubIntent();
    if (!intent) return;
    if (!intent.draft) {
      clearHubIntent();
      focusAskFromHash();
      return;
    }
    if (Session.shouldConfirmNewChat(session)) {
      pendingHubIntent = intent;
      openHubIntentModal();
      return;
    }
    clearHubIntent();
    applyHubDraft(intent.draft);
  }
  ['hubIntentCancel', 'hubIntentClose', 'hubIntentBackdrop'].forEach(function (id) {
    var n = document.getElementById(id);
    if (n) n.addEventListener('click', cancelHubIntent);
  });
  var hubIntentConfirm = document.getElementById('hubIntentConfirm');
  if (hubIntentConfirm) hubIntentConfirm.addEventListener('click', confirmHubIntent);
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && hubIntentModal && !hubIntentModal.hidden) {
      e.preventDefault();
      cancelHubIntent();
    }
  });
  consumeHubIntent();

  // --- PWA: install, offline banner, service worker updates -----------------
  (function setupPwa() {
    var installBtn = document.getElementById('installAppBtn');
    var mInstall = document.getElementById('mInstallApp');
    var appUpdate = document.getElementById('appUpdate');
    var appUpdateBtn = document.getElementById('appUpdateBtn');
    var appOffline = document.getElementById('appOffline');
    var deferredPrompt = null;
    var awaitingUpdateReload = false;
    var waitingWorker = null;

    function isStandalone() {
      return (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches)
        || window.navigator.standalone === true;
    }

    function setInstallVisible(on) {
      if (isStandalone()) on = false;
      if (installBtn) installBtn.hidden = !on;
      if (mInstall) mInstall.hidden = !on;
    }

    function syncOfflineBanner() {
      if (appOffline) appOffline.hidden = !!navigator.onLine;
    }

    window.addEventListener('offline', syncOfflineBanner);
    window.addEventListener('online', syncOfflineBanner);
    syncOfflineBanner();

    window.addEventListener('beforeinstallprompt', function (e) {
      e.preventDefault();
      deferredPrompt = e;
      setInstallVisible(true);
    });
    window.addEventListener('appinstalled', function () {
      deferredPrompt = null;
      setInstallVisible(false);
    });

    function promptInstall() {
      if (!deferredPrompt) return;
      deferredPrompt.prompt();
      var choice = deferredPrompt.userChoice;
      deferredPrompt = null;
      if (choice && typeof choice.then === 'function') {
        choice.then(function () { setInstallVisible(false); }).catch(function () { setInstallVisible(false); });
      } else {
        setInstallVisible(false);
      }
    }
    if (installBtn) installBtn.addEventListener('click', promptInstall);
    if (mInstall) mInstall.addEventListener('click', function () {
      var menu = document.getElementById('mobileMenu');
      if (menu) menu.hidden = true;
      promptInstall();
    });

    function showUpdateBar() {
      if (appUpdate) appUpdate.hidden = false;
    }
    if (appUpdateBtn) {
      appUpdateBtn.addEventListener('click', function () {
        if (!waitingWorker) return;
        awaitingUpdateReload = true;
        waitingWorker.postMessage('SKIP_WAITING');
      });
    }

    if (!('serviceWorker' in navigator)) return;
    if (window.location.protocol !== 'https:' && window.location.hostname !== 'localhost' && window.location.hostname !== '127.0.0.1') return;

    navigator.serviceWorker.addEventListener('controllerchange', function () {
      if (!awaitingUpdateReload) return;
      window.location.reload();
    });

    function watchRegistration(reg) {
      if (reg.waiting) {
        waitingWorker = reg.waiting;
        showUpdateBar();
      }
      reg.addEventListener('updatefound', function () {
        var installing = reg.installing;
        if (!installing) return;
        installing.addEventListener('statechange', function () {
          if (installing.state === 'installed' && navigator.serviceWorker.controller) {
            waitingWorker = installing;
            showUpdateBar();
          }
        });
      });
    }

    var ready = navigator.serviceWorker.register('/sw.js', { scope: '/' });
    ready.then(watchRegistration).catch(function () { /* registration is best-effort */ });
  })();
})();


/* Which Part — app shell (header, Cognito auth state, login modal, appliance shortcuts,
 * mobile menu). Kept separate from the conversational client above so the diagnostic flow is
 * untouched. Auth is server-side (Cognito via /api/auth/*); the token lives in an httpOnly
 * cookie and is never read by this JS — we only learn {name,email,isAdmin} from /api/auth/me. */
(function () {
  'use strict';

  var API_BASE = window.WHICHPART_API_BASE || '/api';
  var $ = function (id) { return document.getElementById(id); };

  var loginBtn = $('loginBtn');
  var userMenu = $('userMenu');
  var userBtn = $('userBtn');
  var userName = $('userName');
  var avatar = $('avatar');
  var userDropdown = $('userDropdown');
  var adminLink = $('adminLink');
  var logoutBtn = $('logoutBtn');
  var burger = $('burger');
  var mobileMenu = $('mobileMenu');
  var mLogin = $('mLogin');
  var mLogout = $('mLogout');
  var mAdmin = $('mAdmin');
  var mAcct = $('mAcct');
  var input = /** @type {HTMLTextAreaElement} */ ($('input'));

  // ---- auth state ----------------------------------------------------------
  function initials(name, email) {
    var src = (name || '').trim();
    if (src) {
      var parts = src.split(/\s+/);
      return (parts[0][0] + (parts[1] ? parts[1][0] : '')).toUpperCase();
    }
    return ((email || '?')[0] || '?').toUpperCase();
  }

  function applyAuth(state) {
    var authed = state && state.authenticated;
    if (loginBtn) loginBtn.hidden = !!authed;
    if (userMenu) userMenu.hidden = !authed;
    if (mLogin) mLogin.hidden = !!authed;
    if (mLogout) mLogout.hidden = !authed;
    if (mAcct) mAcct.hidden = !authed;
    var isAdmin = authed && state.user && state.user.isAdmin;
    if (adminLink) adminLink.hidden = !isAdmin;
    if (mAdmin) mAdmin.hidden = !isAdmin;
    if (authed && state.user) {
      var nm = state.user.name || state.user.email || 'Account';
      if (userName) userName.textContent = nm;
      if (avatar) avatar.textContent = initials(state.user.name, state.user.email);
    }
  }

  function refreshAuth() {
    return fetch(API_BASE + '/auth/me', { credentials: 'same-origin', headers: { accept: 'application/json' } })
      .then(function (r) { return r.ok ? r.json() : { authenticated: false }; })
      .then(applyAuth)
      .catch(function () { applyAuth({ authenticated: false }); });
  }

  // ---- login modal ---------------------------------------------------------
  var loginModal = $('loginModal');
  var loginForm = $('loginForm');
  var loginError = $('loginError');
  var loginEmail = /** @type {HTMLInputElement} */ ($('loginEmail'));
  var loginPassword = /** @type {HTMLInputElement} */ ($('loginPassword'));
  var loginSubmit = /** @type {HTMLButtonElement} */ ($('loginSubmit'));

  function openLogin() {
    if (!loginModal) return;
    if (loginError) { loginError.hidden = true; loginError.textContent = ''; }
    loginModal.hidden = false;
    closeMobileMenu();
    setTimeout(function () { if (loginEmail) loginEmail.focus(); }, 30);
  }
  function closeLogin() { if (loginModal) loginModal.hidden = true; }

  if (loginBtn) loginBtn.addEventListener('click', openLogin);
  if (mLogin) mLogin.addEventListener('click', openLogin);
  if ($('loginClose')) $('loginClose').addEventListener('click', closeLogin);
  if ($('loginBackdrop')) $('loginBackdrop').addEventListener('click', closeLogin);

  if (loginForm) {
    loginForm.addEventListener('submit', function (e) {
      e.preventDefault();
      var email = (loginEmail && loginEmail.value || '').trim();
      var password = (loginPassword && loginPassword.value) || '';
      if (!email || !password) return;
      if (loginError) loginError.hidden = true;
      if (loginSubmit) { loginSubmit.disabled = true; loginSubmit.textContent = 'Logging in…'; }
      fetch(API_BASE + '/auth/login', {
        method: 'POST', credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: email, password: password }),
      })
        .then(function (r) { return r.json().then(function (b) { return { ok: r.ok, body: b }; }); })
        .then(function (res) {
          if (!res.ok) { throw new Error((res.body && res.body.error) || 'Invalid email or password'); }
          if (loginPassword) loginPassword.value = '';
          closeLogin();
          return refreshAuth();
        })
        .catch(function (err) {
          if (loginError) { loginError.textContent = err.message || 'Login failed'; loginError.hidden = false; }
        })
        .finally(function () {
          if (loginSubmit) { loginSubmit.disabled = false; loginSubmit.textContent = 'Log in'; }
        });
    });
  }

  // ---- logout --------------------------------------------------------------
  function doLogout() {
    fetch(API_BASE + '/auth/logout', { method: 'POST', credentials: 'same-origin' })
      .catch(function () {})
      .finally(function () { closeUserDropdown(); closeMobileMenu(); refreshAuth(); });
  }
  if (logoutBtn) logoutBtn.addEventListener('click', doLogout);
  if (mLogout) mLogout.addEventListener('click', doLogout);

  // ---- user dropdown -------------------------------------------------------
  function openUserDropdown() {
    if (!userDropdown) return;
    userDropdown.hidden = false;
    if (userBtn) userBtn.setAttribute('aria-expanded', 'true');
  }
  function closeUserDropdown() {
    if (!userDropdown) return;
    userDropdown.hidden = true;
    if (userBtn) userBtn.setAttribute('aria-expanded', 'false');
  }
  if (userBtn) {
    userBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      if (userDropdown.hidden) openUserDropdown(); else closeUserDropdown();
    });
  }
  document.addEventListener('click', function (e) {
    if (userMenu && !userMenu.contains(/** @type {Node} */ (e.target))) closeUserDropdown();
  });

  // ---- mobile menu ---------------------------------------------------------
  function openMobileMenu() { if (mobileMenu) { mobileMenu.hidden = false; if (burger) burger.setAttribute('aria-expanded', 'true'); } }
  function closeMobileMenu() { if (mobileMenu) { mobileMenu.hidden = true; if (burger) burger.setAttribute('aria-expanded', 'false'); } }
  if (burger) burger.addEventListener('click', function (e) { e.stopPropagation(); if (mobileMenu.hidden) openMobileMenu(); else closeMobileMenu(); });
  document.addEventListener('click', function (e) {
    var t = /** @type {Node} */ (e.target);
    if (mobileMenu && !mobileMenu.hidden && !mobileMenu.contains(t) && t !== burger && (!burger || !burger.contains(t))) closeMobileMenu();
  });

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') { closeLogin(); closeUserDropdown(); closeMobileMenu(); }
  });

  // ---- Help ----------------------------------------------------------------
  function openHelp(e) {
    if (e) e.preventDefault();
    closeMobileMenu();
    var m = document.createElement('div');
    m.className = 'modal';
    m.innerHTML = '<div class="modal__backdrop"></div>' +
      '<div class="modal__card" role="dialog" aria-modal="true" aria-label="Help">' +
      '<button class="modal__close" type="button" aria-label="Close">&times;</button>' +
      '<h2 class="modal__title">How ApplianceClinic works</h2>' +
      '<p class="modal__sub">Independent UK appliance fault guidance.</p>' +
      '<ul class="help__list">' +
      '<li>Read a Help Hub for safe checks, or describe the fault in your own words.</li>' +
      '<li>We help narrow the likely cause, the checks worth making, and whether a component may need replacing.</li>' +
      '<li>Not sure of the model? Photograph the rating plate with the camera button.</li>' +
      '<li>We show clear safety guidance where it matters — always follow it.</li>' +
      '</ul>' +
      '<p class="modal__sub">Help hubs: <a href="/washing-machines/">washing machines</a>, <a href="/washer-dryers/">washer dryers</a>, <a href="/tumble-dryers/">tumble dryers</a>, <a href="/dishwashers/">dishwashers</a>, <a href="/fridge-freezers/">fridge-freezers</a>, <a href="/ovens-cookers/">ovens and cookers</a>, <a href="/hobs/">hobs</a>, <a href="/microwaves/">microwaves</a>, <a href="/vacuum-cleaners/">vacuum cleaners</a>.</p>' +
      '</div>';
    document.body.appendChild(m);
    function close() { m.remove(); }
    m.querySelector('.modal__backdrop').addEventListener('click', close);
    m.querySelector('.modal__close').addEventListener('click', close);
  }
  if ($('helpLink')) $('helpLink').addEventListener('click', openHelp);
  if ($('mHelp')) $('mHelp').addEventListener('click', openHelp);

  // ---- appliance shortcuts -------------------------------------------------
  // Clean prefill only — no diagnostic behaviour in the UI. We seed the input with the appliance
  // wording (which the boundary already understands) and focus it so the customer keeps typing.
  var applianceBtns = document.querySelectorAll('.appliance');
  Array.prototype.forEach.call(applianceBtns, function (btn) {
    btn.addEventListener('click', function () {
      var appliance = btn.getAttribute('data-appliance') || '';
      if (input) {
        input.value = 'My ' + appliance + ' ';
        input.focus();
        try { var v = input.value; input.setSelectionRange(v.length, v.length); } catch (e) {}
      }
      Array.prototype.forEach.call(applianceBtns, function (b) { b.removeAttribute('aria-pressed'); });
      btn.setAttribute('aria-pressed', 'true');
    });
  });

  // Kick off auth state on load.
  refreshAuth();
})();
