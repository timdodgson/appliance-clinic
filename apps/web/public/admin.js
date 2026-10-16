/* global Si, St */
/* Appliance Clinic Admin console. Access is gated SERVER-SIDE: every data call (/api/admin/*) is rejected
 * with 401 unless a valid Cognito session cookie is present. This page reveals the shell only after
 * /api/auth/me confirms an admin session — but even if the markup were forced open, the health data
 * endpoint returns 401 without a verified session, so nothing sensitive is exposed. The token is an
 * httpOnly cookie and is never read by this JS. */
(function () {
  'use strict';
  var API_BASE = window.WHICHPART_API_BASE || '/api';
  var $ = function (id) { return document.getElementById(id); };

  var gate = $('gate');
  var shell = $('shell');
  var userMenu = $('userMenu');
  var userName = $('userName');
  var avatar = $('avatar');

  function initials(name, email) {
    var src = (name || '').trim();
    if (src) { var p = src.split(/\s+/); return (p[0][0] + (p[1] ? p[1][0] : '')).toUpperCase(); }
    return ((email || '?')[0] || '?').toUpperCase();
  }

  function showGate(msg) {
    if (gate) gate.hidden = false;
    if (shell) shell.hidden = true;
    if (userMenu) userMenu.hidden = true;
    if (msg && $('gateSub')) $('gateSub').textContent = msg;
  }
  function showShell(user) {
    if (gate) gate.hidden = true;
    if (shell) shell.hidden = false;
    if (userMenu) userMenu.hidden = false;
    if (userName) userName.textContent = user.name || user.email || 'Account';
    if (avatar) avatar.textContent = initials(user.name, user.email);
    applyHashRoute();
  }

  function checkSession() {
    fetch(API_BASE + '/auth/me', { credentials: 'same-origin', headers: { accept: 'application/json' } })
      .then(function (r) { return r.ok ? r.json() : { authenticated: false }; })
      .then(function (s) {
        if (s && s.authenticated && s.user && s.user.isAdmin) showShell(s.user);
        else if (s && s.authenticated) showGate('Your account does not have admin access.');
        else showGate('Please sign in with your staff account to continue.');
      })
      .catch(function () { showGate('Please sign in with your staff account to continue.'); });
  }

  // ---- gate login ----------------------------------------------------------
  var gateForm = $('gateForm');
  if (gateForm) {
    gateForm.addEventListener('submit', function (e) {
      e.preventDefault();
      var email = ($('gEmail').value || '').trim();
      var password = $('gPassword').value || '';
      var err = $('gError'); var submit = $('gSubmit');
      if (!email || !password) return;
      if (err) err.hidden = true;
      if (submit) { submit.disabled = true; submit.textContent = 'Logging in…'; }
      fetch(API_BASE + '/auth/login', {
        method: 'POST', credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: email, password: password }),
      })
        .then(function (r) { return r.json().then(function (b) { return { ok: r.ok, body: b }; }); })
        .then(function (res) {
          if (!res.ok) throw new Error((res.body && res.body.error) || 'Invalid email or password');
          $('gPassword').value = '';
          checkSession();
        })
        .catch(function (e2) { if (err) { err.textContent = e2.message || 'Login failed'; err.hidden = false; } })
        .finally(function () { if (submit) { submit.disabled = false; submit.textContent = 'Log in'; } });
    });
  }

  // ---- logout + user menu --------------------------------------------------
  if ($('logoutBtn')) $('logoutBtn').addEventListener('click', function () {
    fetch(API_BASE + '/auth/logout', { method: 'POST', credentials: 'same-origin' })
      .catch(function () {}).finally(function () { showGate('Signed out. Log in to continue.'); });
  });
  var userBtn = $('userBtn'); var userDropdown = $('userDropdown');
  if (userBtn) userBtn.addEventListener('click', function (e) {
    e.stopPropagation();
    var open = userDropdown.hidden; userDropdown.hidden = !open;
    userBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
  });
  document.addEventListener('click', function (e) {
    if (userMenu && !userMenu.contains(e.target) && userDropdown) {
      userDropdown.hidden = true; if (userBtn) userBtn.setAttribute('aria-expanded', 'false');
    }
  });

  // ---- mobile nav drawer (burger + scrim) ----------------------------------
  var shellEl = $('shell');
  var burger = $('adminBurger');
  var scrim = $('adminScrim');
  function setNav(open) {
    if (!shellEl) return;
    shellEl.classList.toggle('nav-open', open);
    document.body.classList.toggle('nav-locked', open); // lock background scroll
    if (burger) burger.setAttribute('aria-expanded', open ? 'true' : 'false');
    // Focus the active nav item when opening; return focus to the burger on close.
    if (open) { var a = document.querySelector('.admin__navitem.is-active') || document.querySelector('.admin__navitem'); if (a) { try { a.focus(); } catch (e) {} } }
    else if (burger) { try { burger.focus(); } catch (e) {} }
  }
  if (burger) burger.addEventListener('click', function () { setNav(!shellEl.classList.contains('nav-open')); });
  if (scrim) scrim.addEventListener('click', function () { setNav(false); });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') setNav(false); });

  // ---- section nav + hash routing -----------------------------------------
  var navItems = document.querySelectorAll('.admin__navitem');
  var sections = document.querySelectorAll('.admin__section');
  var _hashFromNav = false;

  function parseHash() {
    var raw = String(location.hash || '').replace(/^#/, '');
    var i = raw.indexOf('?');
    var head = i === -1 ? raw : raw.slice(0, i);
    // '#transcripts/<sessionId>?<list params>' = the transcript detail page (sub-route).
    var slash = head.indexOf('/');
    var sub = '';
    if (slash !== -1) {
      try { sub = decodeURIComponent(head.slice(slash + 1)); } catch (e) { sub = ''; }
      head = head.slice(0, slash);
    }
    var section = (head || 'dashboard').replace(/[^a-z0-9-]/gi, '') || 'dashboard';
    var qs = i === -1 ? '' : raw.slice(i + 1);
    var params = {};
    if (qs) {
      qs.split('&').forEach(function (part) {
        if (!part) return;
        var kv = part.split('=');
        var k = decodeURIComponent(kv[0] || '');
        if (!k) return;
        params[k] = decodeURIComponent((kv[1] || '').replace(/\+/g, ' '));
      });
    }
    return { section: section, sub: sub, params: params };
  }
  function hashString(section, params) {
    var q = [];
    Object.keys(params || {}).forEach(function (k) {
      if (params[k] == null || params[k] === '') return;
      q.push(encodeURIComponent(k) + '=' + encodeURIComponent(params[k]));
    });
    return '#' + section + (q.length ? '?' + q.join('&') : '');
  }
  // The hash most recently written by navGo/period buttons for a page they ALREADY loaded themselves
  // (Dashboard, Conversations list). Its asynchronous hashchange must not load the page a second time.
  var _selfLoadedHash = null;
  function writeHash(section, params, selfLoaded) {
    var next = hashString(section, params);
    if (location.hash === next) return;
    _selfLoadedHash = selfLoaded ? next : null;
    _hashFromNav = true;
    location.hash = next;
    _hashFromNav = false;
  }
  function showSection(target) {
    Array.prototype.forEach.call(navItems, function (n) {
      var on = n.getAttribute('data-section') === target;
      n.classList.toggle('is-active', on);
      if (on) n.setAttribute('aria-current', 'page'); else n.removeAttribute('aria-current');
    });
    Array.prototype.forEach.call(sections, function (s) {
      s.hidden = s.getAttribute('data-section') !== target;
    });
    setNav(false);
  }
  Array.prototype.forEach.call(navItems, function (item) {
    item.addEventListener('click', function () {
      // Unsaved Knowledge edits: ask first (Stay keeps the editor exactly as it is). Clean → as before.
      knLeaveGuard().leave(function () { navGo(item); });
    });
  });
  // Section loaders that would replace an open editor wait for the unsaved-changes answer: they run only
  // after "Leave without saving" (from navGo), never while the dialog is open or after "Stay".
  var pendingNavLoad = null;
  function navLoader(fn) {
    return function () {
      if (knLeaveGuard().isAsking()) { pendingNavLoad = fn; return; }
      fn();
    };
  }
  function navGo(item) {
    {
      var target = item.getAttribute('data-section');
      showSection(target);
      if (pendingNavLoad) { var load = pendingNavLoad; pendingNavLoad = null; setTimeout(load, 0); }
      if (target === 'dashboard') {
        writeHash('dashboard', {}, true);
        loadDashboard();
      } else if (target === 'transcripts') {
        resetTranscriptFilters();
        writeHash('transcripts', {}, true);
        showTranscriptList({});
      }
      else writeHash(target === 'mcp' ? 'error-codes' : target, {});
    }
  }

  // ---- dashboard -----------------------------------------------------------
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]; }); }
  function kvRow(k, v) { return '<dt>' + esc(k) + '</dt><dd>' + esc(v == null ? '—' : v) + '</dd>'; }
  // Shared result reader for the remaining direct fetch() calls: 401 → the login gate; a non-JSON body
  // (e.g. a gateway 502) is an HTTP failure with its status, never a "network error" or a success.
  function readJson(r) {
    if (r.status === 401) { showGate('Your session has expired. Please log in again.'); return Promise.resolve({ ok: false, status: 401, body: { error: 'Your session has expired. Please log in again.' } }); }
    return r.json().catch(function () { return {}; }).then(function (b) { return { ok: r.ok, status: r.status, body: b || {} }; });
  }
  function apiErrorText(res, fallback) {
    var b = (res && res.body) || {};
    var msg = b.message || (typeof b.error === 'string' ? b.error : '');
    if (msg) return msg;
    if (res && res.status === 409) return fallback + ' It changed since you opened it — reload to review the current state.';
    if (res && res.status === 429) return fallback + ' Too many requests — wait a moment and try again.';
    return fallback + (res && res.status ? ' (HTTP ' + res.status + ')' : '');
  }
  function countRow(href, label, count) {
    return '<a class="dash-row" href="' + esc(href) + '"><span>' + esc(label) + '</span><span class="dash-row__count">' + esc(count) + '</span></a>';
  }
  function emptyLine(text) {
    return '<p class="dash-empty">' + esc(text) + '</p>';
  }

  function renderHealth(h) {
    if (!h) return '<div class="health__loading">Could not load system health.</div>';
    var cls = h.ok ? 'dash-health is-ok' : 'dash-health is-bad';
    var pill = h.ok ? 'pill pill--ok' : 'pill pill--bad';
    var html = '<div class="' + cls + '"><div class="dash-health__row">'
      + '<div><div class="dash-health__label">System health</div>'
      + '<div class="dash-health__parts">' + esc(h.summaryLine || 'API · Diagnosis engine · Error codes') + '</div></div>'
      + '<span class="' + pill + '">' + esc(h.label || (h.ok ? 'Healthy' : 'Problem')) + '</span></div>';
    if (!h.ok && h.failed && h.failed.length) {
      html += '<ul class="dash-health__fail">';
      h.failed.forEach(function (p) {
        html += '<li><strong>' + esc(p.name) + '</strong> is unavailable';
        if (p.detail) html += '<div class="dash-health__detail">' + esc(p.detail) + '</div>';
        html += '</li>';
      });
      html += '</ul>';
    }
    html += '</div>';
    return html;
  }

  // Read-only production state (server: dashboardState). Every value has words, not colour alone; each
  // row links to the section where it is changed. A part that could not be read says so.
  function renderState(s) {
    if (!s) return emptyLine('Production state is not available.');
    var rows = [];
    function row(label, value, tone, href, linkText) {
      rows.push('<div class="dash-state__row' + (tone ? ' dash-state__row--' + tone : '') + '"><dt>' + esc(label) + '</dt><dd>'
        + (tone === 'bad' ? '<span class="pill pill--bad">Action needed</span> ' : '')
        + esc(value) + (href ? ' <a class="dash-link" href="' + esc(href) + '">' + esc(linkText) + '</a>' : '') + '</dd></div>');
    }
    var na = function (x) { return !x || x.unavailable; };
    var dz = s.diagnosis || {};
    row('Diagnosis', dz.architecture === 'ac2' ? 'ac2 · the advisor inside the guardrail kernel' : 'Not reported', null, '#diagnostics', 'Diagnostics');
    var a = s.advisor;
    if (na(a)) row('Advisor model', 'Could not be read', null, '#settings', 'Settings');
    else if (!a.model) row('Advisor model', 'Not set · the advisor cannot answer until a model is saved', 'bad', '#settings', 'Settings');
    else row('Advisor model', (a.provider ? a.provider + ' · ' : '') + a.model + (a.credentialConfigured ? '' : ' · credential missing') + ' · version ' + (a.version || 1), a.credentialConfigured ? null : 'bad', '#settings', 'Settings');
    var e = s.errorCodes;
    row('Error Codes', na(e) ? 'Could not be read' : (e.active != null ? e.active + ' active' : 'Count unavailable') + ' · ' + (e.overlay && e.overlay !== 'none' ? 'Admin overlay ' + e.overlay : 'no Admin overlay'), na(e) || e.ok ? null : 'bad', '#error-codes', 'Error Codes');
    var m = s.media;
    row('Media', na(m) ? 'Could not be read' : (m.overlay === 'present' ? 'Admin overlay in use · ' + m.records + ' record' + (m.records === 1 ? '' : 's') : 'No Admin overlay (shipped catalogue)'), null, '#media', 'Media');
    var rc = s.recalls;
    row('Recall notices', na(rc) || rc.listed == null ? 'Could not be read' : rc.listed + ' listed' + (rc.lastSuccessAt ? ' · last ingest ' + fmtWhen(rc.lastSuccessAt) : ''), null, '#safety?tab=notices', 'Safety');
    return '<dl class="dash-state">' + rows.join('') + '</dl>';
  }

  function kpi(label, value, href) {
    var inner = '<div class="dash-kpi__val">' + esc(value) + '</div><div class="dash-kpi__label">' + esc(label) + '</div>';
    if (href) return '<a class="dash-kpi dash-kpi--link" href="' + esc(href) + '">' + inner + '</a>';
    return '<div class="dash-kpi">' + inner + '</div>';
  }

  // Today's activity from the transcript store (server: transcripts.statsFromRows). Exact counts of
  // conversations with activity today; each links to the Conversations view that lists them.
  function renderActivity(act) {
    if (!act || act.unavailable) return emptyLine('Production activity is unavailable right now. System health above is still live.');
    var today = String(act.generatedAt || '').slice(0, 10);
    var href = function (extra) { var p = { from: today, to: today }; Object.keys(extra || {}).forEach(function (k) { p[k] = extra[k]; }); return hashString('transcripts', p); };
    var sessions = act.sessionsToday || 0;
    if (!sessions) return emptyLine('No customer conversations today.');
    var html = '<div class="dash-kpis">'
      + kpi('Conversations', sessions, href({}))
      + kpi('Turns', act.turnsToday || 0)
      + kpi('Part recommended', act.partSessionsToday || 0, href({ partRecommended: '1' }))
      + kpi('Safety stops', act.safetySessionsToday || 0, href({ safety: '1' }))
      + kpi('API errors', act.errorSessionsToday || 0, href({ errors: '1' }))
      + '</div>';
    var fams = act.familyDistribution || {};
    var keys = Object.keys(fams).filter(function (k) { return fams[k]; }).sort(function (a, b) { return fams[b] - fams[a]; });
    if (keys.length) {
      html += '<div class="dash-group"><div class="dash-group__title">Appliances</div><div class="dash-rows">';
      keys.forEach(function (k) { html += countRow(href({ family: k }), familyLabel(k) || k, fams[k]); });
      html += '</div></div>';
    }
    html += '<p class="dash-note">Exact counts of conversations with activity today (UTC).</p>';
    return html;
  }

  function loadDashboard() {
    var healthEl = $('dashHealth');
    var actEl = $('dashActivityBody');
    var stateEl = $('dashStateBody');
    if (healthEl) healthEl.innerHTML = '<div class="health__loading">Checking system health…</div>';
    if (actEl) actEl.innerHTML = '<div class="tac__muted">Loading…</div>';
    if (stateEl) stateEl.innerHTML = '<div class="tac__muted">Loading…</div>';
    fetch(API_BASE + '/admin/dashboard', { credentials: 'same-origin', headers: { accept: 'application/json' } })
      .then(readJson)
      .then(function (res) {
        if (res.status === 401) return;
        if (!res.ok) {
          // A failed load is never shown as "nothing happened" (empty counts).
          var why = apiErrorText(res, 'Could not load the dashboard.');
          if (healthEl) healthEl.innerHTML = '<div class="health__loading">' + esc(why) + '</div>';
          [stateEl, actEl].forEach(function (el) { if (el) el.innerHTML = emptyLine(why); });
          return;
        }
        var data = res.body;
        if (stateEl) stateEl.innerHTML = renderState(data.state);
        if (healthEl) healthEl.innerHTML = renderHealth(data.health);
        if (actEl) actEl.innerHTML = renderActivity(data.activity);
      })
      .catch(function () {
        if (stateEl) stateEl.innerHTML = emptyLine('Could not load the production state.');
        if (healthEl) healthEl.innerHTML = '<div class="health__loading">Could not load system health.</div>';
        if (actEl) actEl.innerHTML = emptyLine('Could not load today’s activity.');
      });
  }

  function applyHashRoute() {
    var route = parseHash();
    var target = route.section || 'dashboard';
    // Back-compat: the old Test ApplianceClinic (#benchmark) and Test Scenarios (#library) links land on the
    // Live test (the Test area is the live workbench only, ADR 0023).
    if (target === 'benchmark' || target === 'library') target = 'test';
    // Operator-facing names map to the unchanged internal section ids.
    else if (target === 'conversations') target = 'transcripts';
    else if (target === 'error-codes' || target === 'errorcodes') target = 'mcp';
    var known = false;
    Array.prototype.forEach.call(sections, function (s) {
      if (s.getAttribute('data-section') === target) known = true;
    });
    if (!known) {
      // An unknown/removed section never leaves a misleading hash in the address bar.
      if (location.hash && location.hash !== '#dashboard') { location.replace('#dashboard'); return; }
      target = 'dashboard';
    }
    showSection(target);
    if (target === 'dashboard') loadDashboard();
    else if (target === 'transcripts') {
      if (route.sub) showTranscriptDetail(route.sub, route.params);
      else showTranscriptList(route.params);
    } else if (target === 'test') {
      ensureTestPage();
    } else if (target === 'knowledge') {
      if (!route.sub && route.params.id) {
        // Back-compat: old '#knowledge?id=X' links (e.g. from Media) → the dedicated detail route.
        var legacy = {}; Object.keys(route.params).forEach(function (k) { if (k !== 'id') legacy[k] = route.params[k]; });
        location.replace(knDetailHref(route.params.id, legacy));
        return;
      }
      if (route.sub) knShowDetail(route.sub, route.params);
      else knShowList(route.params);
    } else if (target === 'media') {
      if (!route.sub && route.params.id) {
        // Back-compat: old '#media?id=X' links (e.g. from Knowledge) → the dedicated detail route.
        var mdLegacy = {}; Object.keys(route.params).forEach(function (k) { if (k !== 'id') mdLegacy[k] = route.params[k]; });
        location.replace('#media/' + encodeURIComponent(route.params.id) + hashString('', mdLegacy).slice(1));
        return;
      }
      if (route.sub) mdShowDetail(route.sub, route.params);
      else loadMedia();
    } else if (target === 'diagnostics') {
      loadDiagnostics();
    } else if (target === 'mcp') {
      if (!route.sub && route.params.id) {
        // Back-compat: old '#mcp?id=X' / '#error-codes?id=X' links → the dedicated detail route.
        var ecLegacy = {}; Object.keys(route.params).forEach(function (k) { if (k !== 'id') ecLegacy[k] = route.params[k]; });
        location.replace('#error-codes/' + encodeURIComponent(route.params.id) + hashString('', ecLegacy).slice(1));
        return;
      }
      if (route.sub) ecShowDetail(route.sub, route.params);
      else loadErrorCodes();
    } else if (target === 'settings') {
      loadSettings();
    } else if (target === 'safety') {
      if (route.sub) rcShowDetail(route.sub, route.params);
      else siShowTab(route.params.tab === 'notices' ? 'notices' : 'ingest', route.params);
    }
  }
  window.addEventListener('hashchange', function () {
    if (_hashFromNav) return;
    // Our own write for a page that already loaded (Dashboard / Conversations from the sidebar or the
    // period buttons): nothing to do. Any later change (Back, links) routes normally.
    if (_selfLoadedHash && location.hash === _selfLoadedHash) { _selfLoadedHash = null; return; }
    _selfLoadedHash = null;
    if (knGuardHashChange()) return;
    applyHashRoute();
  });
  function fmtWhen(iso) {
    if (!iso) return '—';
    try {
      var d = new Date(iso);
      return d.toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
    } catch (e) { return iso; }
  }
  var txCursorStack = [null];
  var txPage = 0;
  var txOpenId = null;
  // The advisor's stored outcome for a conversation (services/whichpart-api/transcripts.js OUTCOMES).
  var TX_OUTCOME_LABELS = {
    diagnosing: 'Diagnosing', part_needed: 'Part needed', engineer: 'Engineer needed', normal: 'Normal behaviour',
    fixed: 'Fixed', out_of_scope: 'Out of scope', safety_stop: 'Safety stop',
  };
  var TX_CHIP_LABELS = {
    from: 'From', to: 'To', family: 'Appliance', make: 'Make', lifecycle: 'Lifecycle', outcome: 'Outcome',
    safety: 'Safety stops', errors: 'Sessions with API errors', degraded: 'Advisor errors', partRecommended: 'Part recommended', q: 'Search',
  };
  // Chip values that already read as a full phrase — show the value alone, no key prefix.
  var TX_CHIP_SELFDESC = { family: 1 };
  var TX_FAMILY_LABELS = {
    'washing machine': 'Washing machine', 'washer-dryer': 'Washer dryer',
    'tumble-dryer': 'Tumble dryer', dishwasher: 'Dishwasher',
    'fridge-freezer': 'Fridge freezer', 'oven-cooker': 'Oven / cooker',
    hobs: 'Hob', microwave: 'Microwave', vacuum: 'Vacuum',
  };
  // Query parameter → form control. Values and checkboxes are the whole filter vocabulary the API accepts.
  var TX_FIELDS = { from: 'txFrom', to: 'txTo', family: 'txFamily', make: 'txMake', lifecycle: 'txLifecycle', outcome: 'txOutcome', partRecommended: 'txPartRecommended', q: 'txSearch' };
  var TX_CHECKS = { safety: 'txSafety', errors: 'txErrors', degraded: 'txDegraded' };

  function resetTranscriptFilters() {
    Object.keys(TX_FIELDS).forEach(function (k) { if ($(TX_FIELDS[k])) $(TX_FIELDS[k]).value = ''; });
    Object.keys(TX_CHECKS).forEach(function (k) { if ($(TX_CHECKS[k])) $(TX_CHECKS[k]).checked = false; });
  }
  function transcriptParamsFromForm() {
    var params = {};
    Object.keys(TX_FIELDS).forEach(function (k) {
      var el = $(TX_FIELDS[k]);
      var v = el ? String(el.value || '').trim() : '';
      if (v) params[k] = k === 'make' ? v.toLowerCase() : v;
    });
    Object.keys(TX_CHECKS).forEach(function (k) { if ($(TX_CHECKS[k]) && $(TX_CHECKS[k]).checked) params[k] = '1'; });
    return params;
  }
  function applyTranscriptParams(params) {
    resetTranscriptFilters();
    params = params || {};
    Object.keys(TX_FIELDS).forEach(function (k) {
      if (params[k] == null || params[k] === '' || !$(TX_FIELDS[k])) return;
      $(TX_FIELDS[k]).value = (k === 'from' || k === 'to') ? String(params[k]).slice(0, 10) : String(params[k]);
    });
    Object.keys(TX_CHECKS).forEach(function (k) {
      if ((params[k] === '1' || params[k] === 'true') && $(TX_CHECKS[k])) $(TX_CHECKS[k]).checked = true;
    });
    txCursorStack = [null];
    txPage = 0;
    syncTranscriptChrome();
  }
  function txQuery() {
    var p = transcriptParamsFromForm();
    var q = [];
    if (p.from) q.push('from=' + encodeURIComponent(p.from + 'T00:00:00.000Z'));
    if (p.to) q.push('to=' + encodeURIComponent(p.to + 'T23:59:59.999Z'));
    ['family', 'make', 'lifecycle', 'outcome', 'partRecommended', 'safety', 'errors', 'degraded'].forEach(function (k) {
      if (p[k]) q.push(k + '=' + encodeURIComponent(p[k]));
    });
    if (p.q && p.q.length >= 3) q.push('q=' + encodeURIComponent(p.q));
    q.push('limit=25');
    var cur = txCursorStack[txPage];
    if (cur) q.push('cursor=' + encodeURIComponent(cur));
    return q.join('&');
  }
  function prettyEnum(v) {
    return String(v || '').replace(/_/g, ' ');
  }
  function titleEnum(v) {
    var s = prettyEnum(v);
    if (!s) return '';
    return s.replace(/\b\w/g, function (c) { return c.toUpperCase(); });
  }
  function familyLabel(f) {
    if (!f) return '';
    return TX_FAMILY_LABELS[f] || String(f).replace(/-/g, ' ');
  }
  function applianceLine(r) {
    var fam = familyLabel(r.family);
    var ident = [r.make, r.model].filter(Boolean).join(' ');
    if (fam && ident) return fam + ' · ' + ident;
    return fam || ident || 'Appliance not identified';
  }
  function outcomeLabel(v) { return (v && TX_OUTCOME_LABELS[v]) || titleEnum(v); }
  function lifeLabel(life) {
    var map = { active: 'Recent', ended: 'Ended', inactive: 'Inactive', error: 'Error' };
    return map[life] || life || '';
  }
  // Quick views back the three stored facts the list counts: safety stops, API errors, part recommended.
  var TX_VIEWS = { safety: { check: 'txSafety' }, errors: { check: 'txErrors' }, parts: { field: 'txPartRecommended', value: '1' } };
  function activeQuickView() {
    var safety = $('txSafety') && $('txSafety').checked;
    var errors = $('txErrors') && $('txErrors').checked;
    var part = ($('txPartRecommended') && $('txPartRecommended').value) || '';
    if (safety && !errors && !part) return 'safety';
    if (!safety && errors && !part) return 'errors';
    if (!safety && !errors && part === '1') return 'parts';
    if (!safety && !errors && !part) return 'all';
    return 'custom';
  }
  function clearViewFilters() {
    if ($('txSafety')) $('txSafety').checked = false;
    if ($('txErrors')) $('txErrors').checked = false;
    if ($('txPartRecommended')) $('txPartRecommended').value = '';
  }
  function applyQuickView(view) {
    clearViewFilters();
    var v = TX_VIEWS[view];
    if (v && v.check && $(v.check)) $(v.check).checked = true;
    else if (v && v.field && $(v.field)) $(v.field).value = v.value;
    txCursorStack = [null];
    txPage = 0;
    writeHash('transcripts', transcriptParamsFromForm());
    loadTranscripts();
  }
  function chipValueLabel(key, value) {
    if (key === 'family') return familyLabel(value) || value;
    if (key === 'safety' || key === 'errors' || key === 'degraded') return '';
    if (key === 'partRecommended') return value === '1' ? 'yes' : 'no';
    if (key === 'lifecycle') return lifeLabel(value);
    if (key === 'outcome') return outcomeLabel(value);
    return titleEnum(value) || value;
  }
  function shortDate(d) {
    if (!d) return '';
    try { return new Date(String(d).slice(0, 10) + 'T00:00:00Z').toLocaleDateString('en-GB', { day: '2-digit', month: 'short' }); }
    catch (e) { return String(d).slice(0, 10); }
  }
  function dateChipText(from, to) {
    if (from && to) return shortDate(from) + ' – ' + shortDate(to);
    if (from) return 'From ' + shortDate(from);
    return 'Until ' + shortDate(to);
  }
  // The quick views and the specialist filters share backing inputs. To avoid duplicate
  // chips we render ONE distinct quick-view chip and suppress the param(s) that back it.
  var TX_VIEW_CHIP_LABELS = { safety: 'Safety stops', errors: 'API errors', parts: 'Part recommended' };
  function renderFilterChips(params) {
    var el = $('txFilterChips');
    if (!el) return;
    params = params || {};
    var view = activeQuickView();
    var chips = [];
    var suppress = {};
    if (TX_VIEW_CHIP_LABELS[view]) {
      chips.push({ cls: 'tx-chip tx-chip--view', key: '__view', text: TX_VIEW_CHIP_LABELS[view], aria: TX_VIEW_CHIP_LABELS[view] + ' view' });
      if (view === 'safety') suppress.safety = 1;
      else if (view === 'errors') suppress.errors = 1;
      else if (view === 'parts') suppress.partRecommended = 1;
    }
    if (params.from || params.to) {
      chips.push({ cls: 'tx-chip', key: 'dateRange', text: dateChipText(params.from, params.to), aria: 'date range' });
    }
    Object.keys(params).forEach(function (k) {
      if (k === 'from' || k === 'to' || suppress[k]) return;
      var label = TX_CHIP_LABELS[k] || k;
      var val = chipValueLabel(k, params[k]);
      var text = !val ? label : (TX_CHIP_SELFDESC[k] ? val : (label + ': ' + val));
      chips.push({ cls: 'tx-chip', key: k, text: text, aria: label });
    });
    if (!chips.length) { el.hidden = true; el.innerHTML = ''; return; }
    el.hidden = false;
    el.innerHTML = chips.map(function (c) {
      return '<span class="' + c.cls + '"><span class="tx-chip__label">' + esc(c.text)
        + '</span><button type="button" class="tx-chip__x" data-clear="' + esc(c.key)
        + '" aria-label="Remove ' + esc(c.aria) + '">×</button></span>';
    }).join('')
      + '<button type="button" class="btn btn--ghost tx-chip__clearall" id="txClearChips">Clear all</button>';
    Array.prototype.forEach.call(el.querySelectorAll('[data-clear]'), function (btn) {
      btn.addEventListener('click', function () {
        clearOneFilter(btn.getAttribute('data-clear'));
      });
    });
    if ($('txClearChips')) {
      $('txClearChips').addEventListener('click', function () {
        resetTranscriptFilters();
        txCursorStack = [null]; txPage = 0;
        writeHash('transcripts', {});
        loadTranscripts();
      });
    }
  }
  function clearOneFilter(key) {
    if (key === '__view') clearViewFilters();
    else if (key === 'dateRange') { if ($('txFrom')) $('txFrom').value = ''; if ($('txTo')) $('txTo').value = ''; }
    else if (TX_CHECKS[key] && $(TX_CHECKS[key])) $(TX_CHECKS[key]).checked = false;
    else if (TX_FIELDS[key] && $(TX_FIELDS[key])) $(TX_FIELDS[key]).value = '';
    txCursorStack = [null]; txPage = 0;
    writeHash('transcripts', transcriptParamsFromForm());
    loadTranscripts();
  }
  function contextCopy(view, params) {
    var head;
    if (view === 'safety') head = 'Showing conversations with a safety stop';
    else if (view === 'errors') head = 'Showing conversations that recorded an API error';
    else if (view === 'parts') head = 'Showing conversations where a part was recommended';
    else if (view === 'custom') head = 'Showing filtered conversations';
    else head = 'Showing all retained conversations';
    if (params.from || params.to) {
      head += ' · ' + (params.from || 'start') + (params.to ? ' to ' + params.to : ' onwards');
    }
    return head + '.';
  }
  // Specialist = lives in the More filters drawer. Excludes the primary-row controls (search/date/appliance)
  // and the param backing the active quick view, so the "More filters · N active" count reflects only
  // genuinely extra refinement.
  var TX_SPECIALIST_KEYS = ['make', 'lifecycle', 'outcome', 'degraded', 'errors', 'safety', 'partRecommended'];
  function specialistActiveKeys(params) {
    var view = activeQuickView();
    var exclude = view === 'safety' ? 'safety' : (view === 'errors' ? 'errors' : (view === 'parts' ? 'partRecommended' : null));
    return TX_SPECIALIST_KEYS.filter(function (k) {
      return params[k] != null && params[k] !== '' && k !== exclude;
    });
  }
  function syncTranscriptChrome(viewCounts) {
    var params = transcriptParamsFromForm();
    var view = activeQuickView();
    Array.prototype.forEach.call(document.querySelectorAll('.tx-view'), function (btn) {
      var on = view !== 'custom' && btn.getAttribute('data-view') === view;
      btn.classList.toggle('is-on', on);
      btn.setAttribute('aria-checked', on ? 'true' : 'false');
    });
    var ctx = $('txActiveContext');
    if (ctx) {
      var showCtx = view !== 'all' || params.from || params.to || Object.keys(params).length;
      ctx.hidden = !showCtx;
      ctx.textContent = contextCopy(view, params);
    }
    renderFilterChips(params);
    var specialist = specialistActiveKeys(params);
    var more = $('txMore');
    if (more && specialist.length) more.open = true;
    var moreCount = $('txMoreCount');
    if (moreCount) {
      moreCount.hidden = specialist.length === 0;
      moreCount.textContent = specialist.length ? ('· ' + specialist.length + ' active') : '';
    }
    function setCount(id, n) {
      var el = $(id);
      if (!el) return;
      var num = Number(n) || 0;
      el.hidden = num <= 0;
      el.textContent = num > 0 ? String(num) : '';
    }
    if (viewCounts) {
      setCount('txCountSafety', viewCounts.safety);
      setCount('txCountErrors', viewCounts.errors);
      setCount('txCountParts', viewCounts.parts);
    }
  }
  // Compact triage badges from stored facts only: the advisor's outcome, a safety stop, an API error, an
  // advisor error, a part recommendation, and a non-active lifecycle. Nothing is inferred from the prose.
  function rowFlags(r) {
    var bits = [];
    var s = r.ac2 || {};
    if (r.safetyStop) bits.push('<span class="tx__flag tx__flag--safety">Safety stop</span>');
    if (r.outcome === 'SAFETY_STOP' && !r.safetyStop) bits.push('<span class="tx__flag tx__flag--safety">Safety stop</span>');
    if (s.outcome) bits.push('<span class="tx__flag tx__flag--muted">' + esc(outcomeLabel(s.outcome)) + '</span>');
    if (s.escalation) bits.push('<span class="tx__flag tx__flag--attn">Escalate · ' + esc(s.escalation) + '</span>');
    if (r.partRecommended) bits.push('<span class="tx__flag tx__flag--ok">Part recommended</span>');
    if (r.hasError) bits.push('<span class="tx__flag tx__flag--safety">API error</span>');
    if (s.errors) bits.push('<span class="tx__flag tx__flag--warn">' + esc(s.errors + ' advisor error' + (s.errors === 1 ? '' : 's')) + '</span>');
    if (r.lifecycle && r.lifecycle !== 'active') bits.push('<span class="tx__flag tx__flag--muted">' + esc(lifeLabel(r.lifecycle)) + '</span>');
    return bits.join('');
  }
  // The detail route for one transcript, carrying the current list filters so Back / the back link return to them.
  function txDetailHref(sid) {
    var list = hashString('transcripts', transcriptParamsFromForm());
    var qi = list.indexOf('?');
    return '#transcripts/' + encodeURIComponent(sid) + (qi === -1 ? '' : list.slice(qi));
  }
  function durationLabel(r) {
    var a = Date.parse(r.createdAt || ''); var b = Date.parse(r.lastActivityAt || '');
    if (!a || !b || b < a) return '';
    var m = Math.round((b - a) / 60000);
    return m < 1 ? '<1 min' : (m < 120 ? m + ' min' : Math.round(m / 60) + ' h');
  }
  function conversationRowHtml(r) {
    var preview = r.openingPreview || '';
    var previewClass = preview ? 'tx-row__preview' : 'tx-row__preview tx-row__preview--empty';
    var openCls = txOpenId === r.sessionId ? ' is-open' : '';
    var dur = durationLabel(r);
    var turns = (r.turnCount || 0) + ((r.turnCount === 1) ? ' turn' : ' turns');
    return '<a class="tx-row' + openCls + '" data-sid="' + esc(r.sessionId) + '" href="' + esc(txDetailHref(r.sessionId)) + '">'
      + '<div class="tx-row__main">'
      + '<div class="tx-row__when">' + esc(fmtWhen(r.lastActivityAt)) + ' · <span class="tx-row__ref">' + esc(r.shortId || '') + '</span></div>'
      + '<div class="tx-row__id">' + esc(applianceLine(r)) + '</div>'
      + '<p class="' + previewClass + '"></p>'
      + '<div class="tx-row__flags">' + rowFlags(r) + '</div>'
      + '</div>'
      + '<div class="tx-row__side"><span class="tx-row__turns">' + esc(turns)
      + (dur ? '<br><span class="tx-row__dur">' + esc(dur) + '</span>' : '')
      + '</span><span class="tx-row__go" aria-hidden="true">›</span></div>'
      + '</a>';
  }
  // The last rendered list page (route key + response + pager position + scroll), so returning from a detail
  // page restores the same page instantly instead of refetching page 1.
  var txListCache = null;
  function txListKey() { return hashString('transcripts', transcriptParamsFromForm()); }
  function showTranscriptList(params) {
    if ($('txDetailPage')) $('txDetailPage').hidden = true;
    if ($('txListView')) $('txListView').hidden = false;
    applyTranscriptParams(params);
    if (txListCache && txListCache.key === txListKey()) {
      txCursorStack = txListCache.stack.slice();
      txPage = txListCache.page;
      renderTranscriptList(txListCache.data);
      var y = txListCache.scrollY || 0;
      setTimeout(function () { window.scrollTo(0, y); }, 0);
      return;
    }
    loadTranscripts();
  }
  var txCameFromList = false;
  function showTranscriptDetail(id, params) {
    var listVisible = $('txListView') && !$('txListView').hidden && $('txTableWrap') && $('txTableWrap').querySelector('.tx-row');
    if (listVisible && txListCache) txListCache.scrollY = window.scrollY || 0;
    txCameFromList = Boolean(listVisible);
    applyTranscriptParams(params);
    if ($('txListView')) $('txListView').hidden = true;
    if ($('txDetailPage')) $('txDetailPage').hidden = false;
    var back = $('txBack');
    if (back) back.setAttribute('href', hashString('transcripts', params || {}));
    window.scrollTo(0, 0);
    openTranscript(id);
  }
  function loadTranscripts() {
    var wrap = $('txTableWrap');
    if (wrap) wrap.innerHTML = '<div class="tac__muted" id="txEmpty">Loading…</div>';
    txOpenId = null;
    syncTranscriptChrome();
    fetch(API_BASE + '/admin/transcripts?' + txQuery(), { credentials: 'same-origin', headers: { accept: 'application/json' } })
      .then(function (r) {
        if (r.status === 401) { showGate('Your session has expired. Please log in again.'); return null; }
        // Any other non-2xx is an API failure, not an empty result. Never let it
        // fall through to items=[] and masquerade as "No conversations match this view".
        if (!r.ok) {
          if (wrap) wrap.innerHTML = '<div class="tac__muted">Could not load conversations.</div>';
          if ($('txPager')) $('txPager').hidden = true;
          return null;
        }
        return r.json();
      })
      .then(function (data) {
        if (!data) return;
        txListCache = { key: txListKey(), data: data, stack: txCursorStack.slice(), page: txPage, scrollY: 0 };
        renderTranscriptList(data);
      })
      .catch(function () {
        if (wrap) wrap.innerHTML = '<div class="tac__muted">Could not load conversations.</div>';
      });
  }
  function renderTranscriptList(data) {
    var wrap = $('txTableWrap');
    if (data.retention && $('txPolicy')) {
      var days = data.retention.retentionDays || 90;
      $('txPolicy').textContent = 'Kept for ' + days + ' days, then deleted automatically.';
    }
    syncTranscriptChrome(data.viewCounts || null);
    var items = data.items || [];
    if (!items.length) {
      var activeParams = transcriptParamsFromForm();
      var isFiltered = Object.keys(activeParams).length > 0 || activeQuickView() !== 'all';
      if (isFiltered) {
        wrap.innerHTML = '<div class="admin__placeholder tx-empty" id="txEmpty">'
          + '<p>No conversations match these filters.</p>'
          + '<button type="button" class="btn btn--ghost" id="txEmptyClear">Clear filters</button></div>';
        if ($('txEmptyClear')) $('txEmptyClear').addEventListener('click', function () {
          resetTranscriptFilters();
          txCursorStack = [null]; txPage = 0;
          writeHash('transcripts', {});
          loadTranscripts();
        });
      } else {
        wrap.innerHTML = '<div class="admin__placeholder" id="txEmpty"><p>No conversations recorded yet.</p></div>';
      }
      $('txPager').hidden = true;
      return;
    }
    // Rows are links to '#transcripts/<id>': the browser navigates (Back works, middle-click opens a tab).
    wrap.innerHTML = items.map(conversationRowHtml).join('');
    var rows = wrap.querySelectorAll('.tx-row');
    Array.prototype.forEach.call(rows, function (btn, i) {
      var preview = btn.querySelector('.tx-row__preview');
      if (preview) preview.textContent = items[i].openingPreview
        ? ('“' + items[i].openingPreview + '”')
        : 'No customer opening stored';
    });
    var pager = $('txPager');
    pager.hidden = false;
    $('txPrev').disabled = txPage <= 0;
    $('txNext').disabled = !data.nextCursor;
    $('txPageInfo').textContent = 'Page ' + (txPage + 1) + (items.length ? ' · ' + items.length + ' this page' : '');
    pager._next = data.nextCursor || null;
  }

  // ---- Per-turn AC2 decision panel (ac2-transcript-audit, stored as turn.ac2) ------------------------------
  // The turn's bounded decision audit from the diagnosis engine: provider, timings, token usage, the tools the
  // advisor called, safety gates, the part gate, escalation and what the engine knows about the appliance.
  // Structured fields only — the audit holds no model reasoning text. Every value goes through esc().
  var AC2_SCHEMAS = { 'ac2-transcript-audit/1': 1, 'ac2-transcript-audit/2': 1 };
  var AC2_PART = {
    verified: { text: 'PART VERIFIED', cls: 'tx-badge tx-badge--ok' },
    model_needed: { text: 'MODEL NEEDED', cls: 'tx-badge tx-badge--warn' },
    no_catalogue_part: { text: 'NO CATALOGUE PART', cls: 'tx-badge tx-badge--muted' },
    none: { text: 'NO PART DECISION', cls: 'tx-badge tx-badge--muted' },
  };
  function tpBadge(text, cls) { return '<span class="' + esc(cls || 'tx-badge') + '">' + esc(text) + '</span>'; }
  function tpUpper(v) { return String(v == null ? '' : v).replace(/[_-]+/g, ' ').toUpperCase(); }
  function tpVal(v) {
    if (v == null || v === '') return '—';
    if (v === true) return 'yes';
    if (v === false) return 'no';
    if (Array.isArray(v)) return v.length ? v.map(tpVal).join(', ') : '—';
    if (typeof v === 'object') return JSON.stringify(v);
    return String(v);
  }
  function tpRow(label, value) {
    if (value == null || value === '' || (Array.isArray(value) && !value.length)) return '';
    return '<div class="tx-tp__kv"><span>' + esc(label) + '</span><span>' + esc(tpVal(value)) + '</span></div>';
  }
  function ac2Of(t) { return t && t.ac2 && AC2_SCHEMAS[t.ac2.schemaVersion] ? t.ac2 : null; }
  // The advisor's outcome: the current audit stores `outcome`; the earlier schema stored `status`.
  function ac2Outcome(a) { return a.outcome || (a.status && typeof a.status === 'object' ? a.status.value : a.status) || null; }
  function ac2Customer(a) {
    var c = a.customer || a.ledger || {};
    var v = function (x) { return x && typeof x === 'object' ? x.value : x; };
    return { appliance: v(c.appliance) || null, brand: v(c.brand) || null, model: v(c.model) || null };
  }
  function ac2Hazards(a) {
    if (Array.isArray(a.hazards) && a.hazards.length) return a.hazards.map(function (h) { return h && typeof h === 'object' ? h.type : h; });
    return (a.safety && a.safety.hazards) || [];
  }
  function ac2Chips(a) {
    var bits = [tpBadge('AC2', 'tx-badge tx-badge--control')];
    if (a.error) { bits.push(tpBadge('ERROR · ' + a.error, 'tx-badge tx-badge--warn')); return bits.join(''); }
    var outcome = ac2Outcome(a);
    if (outcome) bits.push(tpBadge(tpUpper(outcome), 'tx-badge'));
    var hz = ac2Hazards(a);
    if (hz.length) bits.push(tpBadge('HAZARD · ' + hz.join(', '), 'tx-badge tx-badge--safety'));
    var pg = a.partGate;
    if (pg && pg.outcome) { var pp = AC2_PART[pg.outcome] || { text: 'PART · ' + tpUpper(pg.outcome), cls: 'tx-badge tx-badge--muted' }; bits.push(tpBadge(pp.text, pp.cls)); }
    if (a.escalation && (a.escalation.to || a.escalation.reason)) bits.push(tpBadge('ESCALATE' + (a.escalation.to ? ' · ' + a.escalation.to : ''), 'tx-badge tx-badge--safety'));
    if (a.slim) bits.push(tpBadge('SUMMARY ONLY', 'tx-badge tx-badge--muted'));
    return bits.join('');
  }
  function ac2List(items) {
    return items && items.length ? '<ul class="tx-evlist">' + items.map(function (x) { return '<li>' + esc(x) + '</li>'; }).join('') + '</ul>' : '<p class="tac__muted">none</p>';
  }
  function ac2Timings(tm) {
    if (!tm) return '';
    return Object.keys(tm).map(function (k) { return k.replace(/Ms$/, '') + ' ' + tm[k] + ' ms'; }).join(' · ');
  }
  function ac2DecisionHtml(a) {
    if (a.error) return tpRow('Path', 'AC2') + tpRow('Error', a.error) + tpRow('Elapsed ms', a.ms)
      + '<p class="tx-tp__note">The engine could not answer this turn; the customer saw the temporarily-unavailable reply and the conversation state was not advanced.</p>';
    var pv = a.provider || {}; var pg = a.partGate || null; var es = a.escalation || null; var c = ac2Customer(a);
    return tpRow('Path', 'AC2 (the advisor inside the guardrail kernel)')
      + tpRow('Advisor', pv.name ? pv.name + (pv.model ? ' · ' + pv.model : '') : null)
      + tpRow('Engine turn', a.turn)
      + tpRow('Latency', ac2Timings(a.timings) || null)
      + tpRow('BFF round trip ms', a.ms)
      + tpRow('Tokens', a.usage ? Object.keys(a.usage).map(function (k) { return k + ' ' + a.usage[k]; }).join(' · ') : null)
      + tpRow('Outcome', outcomeLabel(ac2Outcome(a)) || null)
      + tpRow('Appliance', c.appliance) + tpRow('Brand', c.brand) + tpRow('Model', c.model)
      + '<div class="tx-tp__sub">Part gate</div>'
      + (pg ? tpRow('Outcome', pg.outcome) + tpRow('Component', pg.component) + tpRow('Reason', pg.reason)
        : '<p class="tac__muted">No part decision this turn.</p>')
      + '<div class="tx-tp__sub">Escalation</div>'
      + (es && (es.to || es.reason) ? tpRow('To', es.to) + tpRow('Reason', es.reason) + tpRow('Forced by hazard', es.forced) : '<p class="tac__muted">none</p>')
      + (a.slim ? '<p class="tx-tp__note">Older turn: only the summary is retained to keep the transcript record bounded.</p>' : '');
  }
  function ac2SafetyHtml(a) {
    var sf = a.safety || {};
    var gates = (sf.gates || []).map(function (g) { return [g.gate, g.rule, g.type, g.key, g.why, g.removed != null ? 'removed ' + g.removed : null].filter(Boolean).join(' · '); });
    return tpRow('Hazards', ac2Hazards(a)) + tpRow('Terminated by', sf.terminated)
      + '<div class="tx-tp__sub">Gates fired</div>' + ac2List(gates);
  }
  function ac2ToolsHtml(a) {
    var calls = (a.toolCalls || []).map(function (c) { return c && typeof c === 'object' ? c.tool : c; }).filter(Boolean);
    var en = (a.tags && a.tags.enrichment) || null;
    var html = calls.length ? '<div class="tx-tp__sub">Tools the advisor called</div>' + ac2List(calls)
      : '<p class="tac__muted">' + (a.slim ? 'Not retained for this older turn.' : 'No tool calls this turn.') + '</p>';
    if (en) {
      html += '<div class="tx-tp__sub">Enrichment</div>'
        + tpRow('Knowledge', en.knowledgeIds) + tpRow('Error codes', (en.codes || []).map(function (c) { return c && typeof c === 'object' ? c.code + (c.status ? ' (' + c.status + ')' : '') : c; }))
        + tpRow('Recall notices', en.recalls) + tpRow('Catalogue parts', en.parts);
    }
    if (a.tags && a.tags.media) html += tpRow('Media shown', a.tags.media);
    return html;
  }
  function tpRuntimeHtml(t) {
    var rt = t.runtime || {};
    return tpRow('Route', rt.route) + tpRow('Outcome', rt.outcome) + tpRow('Safety stop', rt.safetyStop || null) + tpRow('Safety class', rt.safetyClass)
      + tpRow('API error', rt.apiError || null) + tpRow('Request id', rt.requestId)
      + (ac2Of(t) ? '' : '<p class="tx-tp__note">No engine audit was recorded for this turn.</p>');
  }
  // Summary chips: always visible on the collapsed panel, so a turn can be scanned without opening it.
  function turnChips(t) {
    var a = ac2Of(t);
    if (a) return ac2Chips(a);
    var rt = t.runtime || {};
    var bits = [tpBadge('NO AUDIT', 'tx-badge tx-badge--muted')];
    if (rt.route) bits.push(tpBadge(rt.route, 'tx-badge'));
    if (rt.safetyStop) bits.push(tpBadge('SAFETY STOP', 'tx-badge tx-badge--safety'));
    if (rt.apiError) bits.push(tpBadge('API ERROR', 'tx-badge tx-badge--warn'));
    return bits.join('');
  }
  function turnPanelHtml(t, ti) {
    var tabs = [];
    var a2 = ac2Of(t);
    if (a2) {
      tabs.push(['ac2', 'AC2 decision', ac2DecisionHtml(a2)]);
      if (!a2.error) {
        tabs.push(['ac2safety', 'Safety', ac2SafetyHtml(a2)]);
        tabs.push(['ac2tools', 'Tools & enrichment', ac2ToolsHtml(a2)]);
      }
    }
    tabs.push(['runtime', 'Runtime', tpRuntimeHtml(t)]);
    var seq = t.seq != null ? t.seq : (ti + 1);
    var head = '<div class="tx-tp__tabs" role="tablist" aria-label="Turn ' + esc(String(seq)) + ' technical details">' + tabs.map(function (x, i) {
      return '<button type="button" role="tab" class="tx-tp__tab' + (i === 0 ? ' is-active' : '') + '" data-tptab="' + x[0] + '" aria-selected="' + (i === 0 ? 'true' : 'false') + '">' + esc(x[1]) + '</button>';
    }).join('') + '</div>';
    var panels = tabs.map(function (x, i) {
      return '<div class="tx-tp__panel" data-tppanel="' + x[0] + '" role="tabpanel"' + (i === 0 ? '' : ' hidden') + '>' + x[2] + '</div>';
    }).join('');
    var raw = a2 ? '<details class="tx-tp__raw"><summary>Raw audit JSON (developer)</summary><pre>' + esc(JSON.stringify(a2, null, 2)) + '</pre></details>' : '';
    return '<details class="tx-tp" data-seq="' + esc(String(seq)) + '"><summary class="tx-tp__sum"><span class="tx-tp__label">Technical · turn ' + esc(String(seq)) + '</span>'
      + '<span class="tx-tp__chips">' + turnChips(t) + '</span></summary>'
      + '<div class="tx-tp__body">' + head + panels + raw + '</div></details>';
  }
  // Session header badges (detail page) share the list's vocabulary.
  function sessionBadges(ov) {
    var s = ov.ac2 || {};
    var bits = [tpBadge(s.turns ? 'AC2' : 'NO AUDIT', s.turns ? 'tx-badge tx-badge--control' : 'tx-badge tx-badge--muted')];
    if (s.appliance) bits.push(tpBadge(s.appliance, 'tx-badge tx-badge--journey'));
    if (s.outcome) bits.push(tpBadge(tpUpper(s.outcome), 'tx-badge'));
    if (ov.partRecommended) bits.push(tpBadge('PART RECOMMENDED', 'tx-badge tx-badge--ok'));
    if (s.hazards && s.hazards.length) bits.push(tpBadge('HAZARD · ' + s.hazards.join(', '), 'tx-badge tx-badge--safety'));
    if (s.escalation) bits.push(tpBadge('ESCALATE · ' + s.escalation, 'tx-badge tx-badge--safety'));
    if (s.errors) bits.push(tpBadge(s.errors + ' ADVISOR ERROR' + (s.errors === 1 ? '' : 'S'), 'tx-badge tx-badge--warn'));
    if (ov.safetyStop) bits.push(tpBadge('SAFETY STOP', 'tx-badge tx-badge--safety'));
    if (ov.hasError) bits.push(tpBadge('API ERROR', 'tx-badge tx-badge--warn'));
    if (ov.lifecycle) bits.push(tpBadge(tpUpper(lifeLabel(ov.lifecycle)), 'tx-badge tx-badge--muted'));
    return bits.join('');
  }
  function technicalHtml(metaRows) {
    return '<p class="tx__sub">Raw identifiers and session metadata. Per-turn engine audits sit under each turn in the Conversation tab.</p>'
      + '<h4 class="tx__h4">Session metadata</h4><div class="tx-techmeta">' + metaRows + '</div>';
  }
  // Conversation layer: clean bubbles, with the turn's technical panel directly under the turn it belongs to.
  function conversationHtml(turns) {
    if (!turns.length) return '<p class="tac__muted">No turns recorded.</p>';
    return turns.map(function (t, ti) {
      var seq = t.seq != null ? t.seq : (ti + 1);
      var user = '<div class="tx__bubble tx__bubble--user"><div class="tx__who">Customer</div><div class="tx__text"></div>'
        + (t.customer && t.customer.photo ? '<div class="tx__photo">Photo attached (bytes not stored)</div>' : '') + '</div>';
      var vis = t.applianceClinic || {};
      var botInner = '<div class="tx__text"></div>';
      if (vis.safetyText) botInner += '<div class="tx__safety"></div>';
      if (vis.parts && vis.parts.length) botInner += '<div class="tx__chips">' + vis.parts.map(function (p) {
        return '<span class="tx__chip">' + esc(p.name) + (p.fitStatus ? ' · ' + esc(p.fitStatus) : '') + '</span>';
      }).join('') + '</div>';
      if (vis.media && vis.media.length) botInner += '<div class="tx__chips">' + vis.media.map(function (m) {
        return '<span class="tx__chip">' + esc(m.type || 'MEDIA') + ' · ' + esc(m.title || m.id || '') + '</span>';
      }).join('') + '</div>';
      var bot = '<div class="tx__bubble tx__bubble--bot"><div class="tx__who">ApplianceClinic</div>' + botInner + '</div>';
      return '<div class="tx__turn" id="txturn-' + esc(String(seq)) + '">' + user + bot + turnPanelHtml(t, ti) + '</div>';
    }).join('');
  }

  function switchTxTab(name) {
    Array.prototype.forEach.call(document.querySelectorAll('.tx-tab'), function (b) {
      var on = b.getAttribute('data-txtab') === name;
      b.classList.toggle('is-active', on);
      b.setAttribute('aria-selected', on ? 'true' : 'false');
      b.tabIndex = on ? 0 : -1;
    });
    Array.prototype.forEach.call(document.querySelectorAll('.tx-panel'), function (p) {
      p.hidden = p.getAttribute('data-txpanel') !== name;
    });
  }
  function bindTxTabs(detail) {
    if (!detail._tpBound) {
      detail._tpBound = true;
      detail.addEventListener('click', function (e) {
        var b = e.target && e.target.closest ? e.target.closest('[data-tptab]') : null;
        if (!b) return;
        var tp = b.closest('.tx-tp');
        var name = b.getAttribute('data-tptab');
        Array.prototype.forEach.call(tp.querySelectorAll('[data-tptab]'), function (x) {
          var on = x.getAttribute('data-tptab') === name;
          x.classList.toggle('is-active', on);
          x.setAttribute('aria-selected', on ? 'true' : 'false');
        });
        Array.prototype.forEach.call(tp.querySelectorAll('[data-tppanel]'), function (p) { p.hidden = p.getAttribute('data-tppanel') !== name; });
      });
    }
    Array.prototype.forEach.call(detail.querySelectorAll('.tx-tab'), function (b) {
      b.addEventListener('click', function () { switchTxTab(b.getAttribute('data-txtab')); });
    });
  }

  function openTranscript(id) {
    var detail = $('txDetail');
    if (!detail) return;
    txOpenId = id;
    Array.prototype.forEach.call(document.querySelectorAll('.tx-row'), function (row) {
      row.classList.toggle('is-open', row.getAttribute('data-sid') === id);
    });
    detail.hidden = false;
    detail.innerHTML = '<div class="tac__muted">Loading conversation…</div>';
    fetch(API_BASE + '/admin/transcripts/session?id=' + encodeURIComponent(id), { credentials: 'same-origin', headers: { accept: 'application/json' } })
      .then(function (r) {
        if (r.status === 401) { showGate('Your session has expired. Please log in again.'); return null; }
        if (r.status === 404) { detail.innerHTML = '<p class="tac__muted">That session is not in the store (it may have expired).</p>'; return null; }
        return r.json();
      })
      .then(function (d) {
        if (!d) return;
        var ov = d.overview || {};
        var turns = (d.customerVisible && d.customerVisible.turns) || [];
        var md = d.diagnosticMetadata || {};
        var metaRows = [
          ['Lifecycle', ov.lifecycle],
          ['Created', ov.createdAt],
          ['Last activity', ov.lastActivityAt],
          ['Ended (New Chat)', ov.endedAt || '—'],
          ['Family', md.family],
          ['Make', md.make],
          ['Model', md.model],
          ['Error code', md.errorCode],
          ['Internal outcome', md.outcome],
          ['Advisor outcome', ov.ac2 && ov.ac2.outcome ? outcomeLabel(ov.ac2.outcome) : null],
          ['Safety stop', md.safetyStop ? 'yes' : 'no'],
          ['Safety class', md.safetyClass],
          ['API error', md.hasError ? 'yes' : 'no'],
          ['Request id', md.lastRequestId],
        ].map(function (row) {
          return '<div class="health__row"><span>' + esc(row[0]) + '</span><span>' + esc(row[1] == null || row[1] === '' ? '—' : row[1]) + '</span></div>';
        }).join('');
        var refLine = '<span class="tx__sub">Session <code class="tx__sid">' + esc(ov.sessionId || id) + '</code></span>';
        var errBanner = ov.hasError
          ? '<div class="tx-errbanner" role="status">This conversation recorded an API error. The turns below are still what the customer saw.</div>'
          : '';
        var tabs = '<div class="tx-tabs" role="tablist" aria-label="Transcript layers">'
          + '<button type="button" role="tab" class="tx-tab is-active" data-txtab="conversation" aria-selected="true" tabindex="0">Conversation</button>'
          + '<button type="button" role="tab" class="tx-tab" data-txtab="technical" aria-selected="false" tabindex="-1">Technical</button>'
          + '</div>';
        var panels = '<div class="tx-panel" data-txpanel="conversation" role="tabpanel">'
          + '<div class="tx__chat" id="txChat">' + conversationHtml(turns) + '</div></div>'
          + '<div class="tx-panel" data-txpanel="technical" role="tabpanel" hidden>'
          + technicalHtml(metaRows) + '</div>';
        detail.innerHTML =
          '<div class="tx__detailhead"><h2 class="admin__h2">' + esc(applianceLine(ov)) + '</h2>'
          + '<span class="tx__sub">' + esc(fmtWhen(ov.lastActivityAt)) + ' · '
          + esc((ov.turnCount || 0) + ((ov.turnCount === 1) ? ' turn' : ' turns')) + '</span></div>'
          + '<div class="tx-detailmeta">' + sessionBadges(ov) + '</div>'
          + '<div class="tx-detailref">' + refLine + '</div>'
          + errBanner
          + tabs
          + panels;
        var chatEl = $('txChat');
        var nodes = chatEl ? chatEl.querySelectorAll('.tx__bubble') : [];
        turns.forEach(function (t, i) {
          var userEl = nodes[i * 2];
          var botEl = nodes[i * 2 + 1];
          if (userEl) {
            var text = userEl.querySelector('.tx__text');
            if (text) text.textContent = (t.customer && t.customer.text) || '';
          }
          if (botEl) {
            var vis = t.applianceClinic || {};
            var reply = botEl.querySelector('.tx__text');
            if (reply) reply.textContent = vis.reply || '';
            var saf = botEl.querySelector('.tx__safety');
            if (saf) saf.textContent = vis.safetyText || '';
          }
        });
        bindTxTabs(detail);
      })
      .catch(function () { detail.innerHTML = '<p class="tac__muted">Could not load that transcript.</p>'; });
  }
  Array.prototype.forEach.call(document.querySelectorAll('.tx-view'), function (btn) {
    btn.addEventListener('click', function () {
      applyQuickView(btn.getAttribute('data-view') || 'all');
    });
  });
  function txApplyFilters() {
    txCursorStack = [null]; txPage = 0;
    writeHash('transcripts', transcriptParamsFromForm());
    loadTranscripts();
  }
  function txClearFilters() {
    resetTranscriptFilters();
    txCursorStack = [null]; txPage = 0;
    writeHash('transcripts', {});
    loadTranscripts();
  }
  if ($('txBack')) $('txBack').addEventListener('click', function (e) {
    if (txCameFromList && window.history.length > 1) { e.preventDefault(); window.history.back(); }
  });
  if ($('txApply')) $('txApply').addEventListener('click', txApplyFilters);
  if ($('txReset')) $('txReset').addEventListener('click', txClearFilters);
  if ($('txApplyMore')) $('txApplyMore').addEventListener('click', txApplyFilters);
  if ($('txResetMore')) $('txResetMore').addEventListener('click', txClearFilters);
  if ($('txNext')) $('txNext').addEventListener('click', function () {
    var pager = $('txPager');
    if (!pager || !pager._next) return;
    txPage += 1;
    txCursorStack[txPage] = pager._next;
    loadTranscripts();
  });
  if ($('txPrev')) $('txPrev').addEventListener('click', function () {
    if (txPage <= 0) return;
    txPage -= 1;
    loadTranscripts();
  });
  var knCache = null;
  var knWired = false;
  var knOpenId = null;
  var Kn = window.KnLogic || {};

  function knParams() {
    return {
      q: ($('knSearch') && $('knSearch').value) || '',
      family: ($('knFamily') && $('knFamily').value) || '',
    };
  }
  // The dedicated detail route for one record, carrying the list filters so Back returns to the same list.
  function knDetailHref(id, params) {
    var list = hashString('knowledge', params || knParams());
    var qi = list.indexOf('?');
    return '#knowledge/' + encodeURIComponent(id) + (qi === -1 ? '' : list.slice(qi));
  }
  function knWriteRoute() {
    writeHash('knowledge', knParams());
  }
  function knApplyParams(params) {
    params = params || {};
    if ($('knSearch') && params.q != null) $('knSearch').value = params.q;
    if ($('knFamily') && params.family != null) {
      // Family options are filled after fetch; stash until then.
      $('knFamily').setAttribute('data-pending', params.family);
      if ([].some.call($('knFamily').options, function (o) { return o.value === params.family; })) {
        $('knFamily').value = params.family;
      }
    }
  }
  function knFiltered() {
    if (!knCache) return [];
    return (Kn.filterRecords || function (r) { return r; })(knCache.records, {
      q: ($('knSearch') && $('knSearch').value) || '',
      family: ($('knFamily') && $('knFamily').value) || '',
    });
  }
  function knFillFamilies() {
    var sel = $('knFamily');
    if (!sel || !knCache) return;
    var pending = sel.getAttribute('data-pending') || sel.value || '';
    var current = sel.value;
    sel.innerHTML = '<option value="">All appliances</option>' + (knCache.families || []).map(function (f) {
      return '<option value="' + esc(f.family) + '">' + esc(f.label) + ' (' + f.count + ')</option>';
    }).join('');
    var want = pending || current;
    if (want && [].some.call(sel.options, function (o) { return o.value === want; })) sel.value = want;
    sel.removeAttribute('data-pending');
  }
  function knFillHubs() {
    var ul = $('knHubs');
    if (!ul || !knCache) return;
    ul.innerHTML = (knCache.helpHubs || []).map(function (h) {
      return '<li><a href="/' + esc(h.slug) + '/" target="_blank" rel="noopener">' + esc(h.title) + '</a>'
        + '<div class="tx__sub">Public Help Hub · ' + esc(h.family) + '</div></li>';
    }).join('');
  }
  function knUpdateClear() {
    var btn = $('knClear');
    if (!btn) return;
    var q = ($('knSearch') && $('knSearch').value) || '';
    var fam = ($('knFamily') && $('knFamily').value) || '';
    btn.hidden = !q && !fam;
  }
  function knStatusText(rows) {
    var total = (knCache && knCache.total) || 0;
    var q = (($('knSearch') && $('knSearch').value) || '').trim();
    var fam = ($('knFamily') && $('knFamily').value) || '';
    var famLabel = fam && Kn.familyLabel ? Kn.familyLabel(fam) : fam;
    var bits = ['Showing ' + rows.length + ' of ' + total + ' diagnostic topics'];
    if (famLabel) bits.push(famLabel);
    if (q) bits.push('matching “' + q + '”');
    var sc = (knCache && knCache.stateCounts) || {};
    var extra = [];
    if (sc.draft) extra.push(sc.draft + ' draft' + (sc.draft === 1 ? '' : 's'));
    if (sc.draftPending) extra.push(sc.draftPending + ' with draft changes pending');
    if (sc.archived) extra.push(sc.archived + ' archived');
    if (extra.length) bits.push(extra.join(', '));
    return bits.join(' · ');
  }
  function knCard(rec) {
    var fam = Kn.familyLabel ? Kn.familyLabel(rec.applianceFamily) : rec.applianceFamily;
    var symptoms = (rec.symptomPreview || []).length
      ? rec.symptomPreview.join(' · ')
      : 'No customer symptoms recorded';
    var comps = (rec.likelyComponents || []).length
      ? 'Likely components: ' + rec.likelyComponents.join(' · ')
      : 'No components recorded';
    var flags = [knStateChipHtml(rec)];
    if (rec.provenanceLabel) flags.push('<span class="kn-flag">' + esc(rec.provenanceLabel) + '</span>');
    else flags.push('<span class="kn-flag kn-flag--gap">No provenance recorded</span>');
    if (rec.hasSafety) {
      var sLab = (Kn.safetyLabel && Kn.safetyLabel(rec.safetyClassification)) || rec.safetyClassification || 'Safety';
      flags.push('<span class="kn-flag kn-flag--safety">Safety: ' + esc(sLab) + '</span>');
    }
    if (rec.hasMedia) flags.push('<span class="kn-flag">' + rec.mediaCount + ' linked media</span>');
    if (rec.archivedMediaCount) flags.push('<span class="kn-flag kn-flag--gap">' + rec.archivedMediaCount + ' archived media attached</span>');
    if (!rec.hasDiscriminators) flags.push('<span class="kn-flag kn-flag--gap">No discriminator recorded</span>');
    return '<a class="kn-card" data-kn-id="' + esc(rec.knowledgeId) + '" href="' + esc(knDetailHref(rec.knowledgeId)) + '">'
      + '<span class="kn-card__main">'
      + '<span class="kn-card__fam">' + esc(fam) + '</span>'
      + '<span class="kn-card__title">' + esc(rec.label || rec.faultId) + '</span>'
      + '<span class="kn-card__id">' + esc(rec.knowledgeId) + '</span>'
      + '<span class="kn-card__symptoms">Customer symptoms: ' + esc(symptoms) + '</span>'
      + '<span class="kn-card__components">' + esc(comps) + '</span>'
      + '<span class="kn-card__flags">' + flags.join('') + '</span>'
      + '</span><span class="kn-card__go" aria-hidden="true">›</span></a>';
  }
  function knRenderList() {
    var list = $('knList');
    var status = $('knStatus');
    if (!list) return;
    var rows = knFiltered();
    if (status) status.textContent = knStatusText(rows);
    knUpdateClear();
    if (!rows.length) {
      list.innerHTML = '<div class="kn__empty">No diagnostic knowledge matches this search.</div>';
      return;
    }
    var groups = Kn.groupByFamily ? Kn.groupByFamily(rows) : [{ family: '', label: 'Topics', records: rows }];
    list.innerHTML = groups.map(function (g) {
      return '<section class="kn-family">'
        + '<h2 class="kn-family__h">' + esc(g.label) + ' <span class="kn-family__count">(' + g.records.length + ')</span></h2>'
        + '<div class="kn-family__cards">' + g.records.map(knCard).join('') + '</div></section>';
    }).join('');
  }
  function knEmpty(label) {
    return '<p class="kn-sec__empty">' + esc(label) + '</p>';
  }
  function knListOrEmpty(items, missing) {
    if (!items || !items.length) return knEmpty(missing);
    return '<ul class="kn-dlist">' + items.map(function (x) { return '<li>' + esc(x) + '</li>'; }).join('') + '</ul>';
  }
  function knChips(items, missing) {
    if (!items || !items.length) return knEmpty(missing);
    return '<ul class="kn-chips">' + items.map(function (x) { return '<li>' + esc(x) + '</li>'; }).join('') + '</ul>';
  }
  function knEvidenceBlock(c) {
    var forItems = c.supports || [];
    var against = c.against || [];
    var forHtml = forItems.length
      ? '<ul class="kn-dlist">' + forItems.map(function (x) { return '<li>' + esc(x) + '</li>'; }).join('') + '</ul>'
      : knEmpty('No FOR evidence recorded');
    var againstHtml = against.length
      ? '<ul class="kn-dlist">' + against.map(function (x) { return '<li>' + esc(x) + '</li>'; }).join('') + '</ul>'
      : knEmpty('No AGAINST evidence recorded');
    var meta = [];
    if (c.rank) meta.push('Rank ' + c.rank);
    if (c.type) meta.push(c.type === 'check' ? 'Check, not a part' : (c.type === 'part' ? 'Part' : c.type));
    if (c.partName && c.partName !== c.name) meta.push(c.partName);
    return '<article class="kn-comp">'
      + '<h3 class="kn-comp__h">' + (c.rank ? esc(c.rank + '. ') : '') + esc(c.name || c.partName) + '</h3>'
      + (meta.length ? '<p class="kn-comp__meta">' + esc(meta.join(' · ')) + '</p>' : '')
      + '<div class="kn-ev"><div><h4>FOR</h4>' + forHtml + '</div><div><h4>AGAINST</h4>' + againstHtml + '</div></div>'
      + '</article>';
  }
  function knRenderDetail(rec) {
    var panel = $('knDetail');
    if (!panel) return;
    if (!rec) { panel.hidden = true; panel.innerHTML = ''; return; }
    var fam = rec.familyLabel || (Kn.familyLabel && Kn.familyLabel(rec.applianceFamily)) || rec.applianceFamily;
    var ordered = Kn.orderComponents ? Kn.orderComponents(rec) : (rec.components || []);
    var safetyHtml = rec.safety
      ? '<div class="kn-safety"><p class="kn-safety__class">Safety: ' + esc((Kn.safetyLabel && Kn.safetyLabel(rec.safety.classification)) || rec.safety.classification || 'recorded') + '</p>'
        + (rec.safety.text ? '<p>' + esc(rec.safety.text) + '</p>' : '')
        + (rec.safety.hazard ? '<p>' + esc(rec.safety.hazard) + '</p>' : '')
        + (rec.safety.applicability ? '<p class="tx__sub">' + esc(rec.safety.applicability) + '</p>' : '')
        + ((rec.safety.provenance || []).length
          ? '<ul class="kn-dlist">' + rec.safety.provenance.map(function (p) {
            var line = [p.publisher, p.title, p.retrieved].filter(Boolean).join(' — ');
            if (p.url) return '<li><a href="' + esc(p.url) + '" target="_blank" rel="noopener">' + esc(line || p.url) + '</a></li>';
            return '<li>' + esc(line || 'Source recorded') + '</li>';
          }).join('') + '</ul>' : '')
        + '</div>'
      : knEmpty('No safety information recorded');
    var mediaHtml;
    // Effective Media (same merge as live diagnosis). Archived items that are still attached stay visible
    // and flagged — never silently dropped, never presented as live.
    if (rec.media && rec.media.length) {
      mediaHtml = (rec.mediaOverlayUnavailable ? '<p class="kn-banner kn-banner--info">Media changes could not be loaded just now. Showing shipped media.</p>' : '')
        + '<div class="kn-media">' + rec.media.map(function (m) {
        var archived = m.liveForDiagnosis === false;
        var bits = [m.type, m.relatedCheck, (m.makes || []).join(', ')].filter(Boolean);
        var codes = (m.errorCodes || []).length ? '<p class="tx__sub">Referenced error codes: ' + esc(m.errorCodes.join(', ')) + '</p>' : '';
        return '<div class="kn-media__item' + (archived ? ' is-archived' : '') + '"><b>' + esc(m.title || m.id) + '</b> '
          + (archived ? '<span class="kn-state kn-state--archived">Archived media</span>' : '<span class="kn-state kn-state--published">Live</span>')
          + (archived ? '<p class="tx__sub">Unavailable for live diagnosis. Still attached to this record; restore it in Media to show it again.</p>' : '')
          + (bits.length ? '<p class="tx__sub">' + esc(bits.join(' · ')) + '</p>' : '')
          + (m.caption ? '<p>' + esc(m.caption) + '</p>' : '')
          + (m.asset ? '<p class="tx__sub">File: ' + esc(m.asset) + '</p>' : '')
          + (m.attribution ? '<p class="tx__sub">' + esc(m.attribution) + '</p>' : '')
          + codes
          + '<p class="tx__sub">Media id: ' + esc(m.id || '') + '</p>'
          + '<p><a class="btn btn--ghost" href="#media/' + encodeURIComponent(m.id || '') + '">View in Media</a> '
          + '<a class="btn btn--ghost" href="#media/' + encodeURIComponent(m.id || '') + '">Manage media</a></p>'
          + '</div>';
      }).join('') + '</div>';
    } else mediaHtml = knEmpty('No media linked');
    var relatedHtml = (rec.relatedTopics || []).length
      ? '<ul class="kn-related">' + rec.relatedTopics.map(function (t) {
        if (t.available) return '<li><a href="' + esc(knDetailHref(t.knowledgeId)) + '" data-kn-related="' + esc(t.knowledgeId) + '">' + esc(t.label) + '</a> <span class="tx__sub">' + esc(t.knowledgeId) + '</span></li>';
        return '<li>' + esc(t.label) + ' <span class="tx__sub">' + esc(t.knowledgeId) + '</span></li>';
      }).join('') + '</ul>'
      : knEmpty('No related diagnostic topics recorded');
    var confusionHtml = (rec.commonConfusion || []).length
      ? rec.commonConfusion.map(function (c) {
        return '<article class="kn-comp"><h3 class="kn-comp__h">' + esc(c.name) + '</h3>'
          + (c.note ? '<p>' + esc(c.note) + '</p>' : '')
          + knListOrEmpty(c.wouldApplyIf, 'No “would apply if” recorded')
          + '</article>';
      }).join('')
      : knEmpty('No common confusion recorded');
    var questions = [];
    if (rec.clarifyingQuestion) questions.push(rec.clarifyingQuestion);
    if (rec.secondaryQuestion) questions.push(rec.secondaryQuestion);
    var tech = rec.technical || {};
    var techRows = '<dl class="kn-ov">'
      + '<dt>Canonical id</dt><dd>' + esc(tech.knowledgeId || rec.knowledgeId) + '</dd>'
      + '<dt>Record version</dt><dd>' + esc(tech.version || rec.version || 'No version recorded') + '</dd>'
      + '<dt>Docs version</dt><dd>' + esc(tech.docsVersion || 'No docs version recorded') + '</dd>'
      + '<dt>Indexed</dt><dd>' + (tech.indexed === true ? 'Yes' : (tech.indexed === false ? 'Not indexed' : 'Index state not recorded')) + '</dd>'
      + '<dt>Embedding model</dt><dd>' + esc(tech.embedModel || 'No embedding model recorded') + '</dd>'
      + '<dt>Index built</dt><dd>' + esc(tech.indexBuiltAt || 'No index timestamp recorded') + '</dd>'
      + '</dl>'
      + (tech.text ? '<h3 class="kn-sec__h">Indexed text</h3><pre>' + esc(tech.text) + '</pre>' : knEmpty('No indexed text recorded'))
      + '<h3 class="kn-sec__h">Raw knowledge record</h3><pre>' + esc(JSON.stringify({
        knowledgeId: rec.knowledgeId, version: rec.version, applianceFamily: rec.applianceFamily,
        faultId: rec.faultId, label: rec.label, outcome: rec.outcome, provenance: rec.provenance,
        symptoms: rec.symptoms, likelyComponents: rec.likelyComponents, componentFamilies: rec.componentFamilies,
        components: rec.components, discriminators: rec.discriminators, clarifyingQuestion: rec.clarifyingQuestion,
        secondaryQuestion: rec.secondaryQuestion, adviceBeforeReplacement: rec.adviceBeforeReplacement,
        commonConfusion: rec.commonConfusion, alternatives: rec.alternatives, make: rec.make, platform: rec.platform,
        indexed: rec.indexed, gaps: rec.gaps,
      }, null, 2)) + '</pre>';

    panel.hidden = false;
    panel.innerHTML = '<div class="kn-detail__head"><div>'
      + '<p class="kn-detail__fam">' + esc(fam) + '</p>'
      + '<h2 class="kn-detail__title">' + esc(rec.label || rec.faultId) + '</h2>'
      + '<p class="kn-detail__id">' + esc(rec.knowledgeId) + '</p>'
      + '</div></div>'
      + '<div class="kn-actions"><p class="tx__sub">Read-only: knowledge records ship with the diagnosis engine and change only through a release.</p></div>'
      + '<section class="kn-sec"><h3 class="kn-sec__h">Overview</h3><dl class="kn-ov">'
      + '<dt>Appliance</dt><dd>' + esc(fam) + '</dd>'
      + '<dt>Problem</dt><dd>' + esc(rec.label || 'No topic label recorded') + '</dd>'
      + '<dt>faultId</dt><dd>' + esc(rec.faultId || 'No faultId recorded') + '</dd>'
      + '<dt>Provenance</dt><dd>' + esc(rec.provenanceLabel || 'No provenance recorded') + '</dd>'
      + '</dl></section>'
      + '<section class="kn-sec"><h3 class="kn-sec__h">Customer symptoms</h3>' + knChips(rec.symptoms, 'No customer symptoms recorded') + '</section>'
      + '<section class="kn-sec"><h3 class="kn-sec__h">Likely causes / components</h3>'
      + (ordered.length ? ordered.map(knEvidenceBlock).join('') : knEmpty('No components recorded'))
      + '</section>'
      + '<section class="kn-sec"><h3 class="kn-sec__h">Discriminators / questions</h3>'
      + knListOrEmpty(rec.discriminators, 'No discriminator recorded')
      + (questions.length ? '<h4 class="kn-sec__h">Questions</h4>' + knListOrEmpty(questions, 'No question recorded') : knEmpty('No clarifying question recorded'))
      + '</section>'
      + '<section class="kn-sec"><h3 class="kn-sec__h">Advice before replacement</h3>'
      + knListOrEmpty(rec.adviceBeforeReplacement, 'No advice-before-replacement recorded') + '</section>'
      + '<section class="kn-sec"><h3 class="kn-sec__h">Common confusion</h3>' + confusionHtml + '</section>'
      + '<section class="kn-sec"><h3 class="kn-sec__h">Safety</h3>' + safetyHtml + '</section>'
      + '<section class="kn-sec"><h3 class="kn-sec__h">Media references</h3>' + mediaHtml + '</section>'
      + '<section class="kn-sec"><h3 class="kn-sec__h">Related diagnostic topics</h3>' + relatedHtml + '</section>'
      + '<section class="kn-sec"><h3 class="kn-sec__h">Provenance</h3>'
      + '<p>' + esc(rec.provenanceLabel || 'No provenance recorded') + '</p></section>'
      + '<details class="kn-tech"><summary>Technical details</summary>' + techRows + '</details>';
  }
  // ---- Knowledge (read-only) helpers ----------------------------------------------------------
  // Knowledge records ship with the diagnosis engine and are read-only in the Admin (ADR 0019 removed the draft and
  // publish workflow and its API routes). The icon and state-chip helpers are shared with the Media, Error Codes and Safety pages.
  // Decorative button icon from the local Admin sprite (the visible label carries the meaning).
  function knIco(name) {
    return '<svg class="ac-btnicon" aria-hidden="true" focusable="false"><use href="assets/admin-icons.svg?v=1#ai-' + name + '"/></svg>';
  }
  function knStateChipHtml(rec) {
    var c = (Kn.stateChip || function () { return { label: 'Live', cls: 'kn-state' }; })(rec);
    return '<span class="' + esc(c.cls) + '">' + esc(c.label) + '</span>';
  }
  // ---- THE unsaved-changes guard for the whole Admin (sidebar, in-page links/Back/Cancel, browser
  // Back, tab close). Editors: Error Codes (ecEd), Media (mdEd), Safety listing
  // decisions (rcEd), Test → Scenarios (edState), Settings inference (stEd), plus small forms
  // registered with guardForm() (the Settings credential dialog).
  var _knGuard = null;
  var guardForms = [];
  // A small form outside the big editors: { el, isDirty(), discard(), leave } — dirty only while its
  // element is still on the page. Registered when the form is rendered; replaced by a re-render.
  function guardForm(key, spec) {
    guardForms = guardForms.filter(function (f) { return f.key !== key; });
    // hash = the page the form lives on (Stay returns there). Forms wired once at start-up pass it explicitly.
    var f = { key: key, hash: spec.hash || location.hash, leave: spec.leave || null, discard: spec.discard || null };
    Object.defineProperty(f, 'dirty', { get: function () { return Boolean(spec.el && document.body.contains(spec.el) && spec.isDirty()); } });
    guardForms.push(f);
    return f;
  }
  function dirtyForm() { for (var i = 0; i < guardForms.length; i++) if (guardForms[i].dirty) return guardForms[i]; return null; }
  // Each form's discard() makes it clean again (it stays registered: a re-render replaces it).
  function discardForms() { guardForms.forEach(function (f) { if (f.discard) { try { f.discard(); } catch (e) { /* form already gone */ } } }); }
  function knLeaveGuard() {
    if (_knGuard) return _knGuard;
    _knGuard = Kn.createLeaveGuard({
      isDirty: function () { return !!((ecEd && ecEd.dirty) || (mdEd && mdEd.dirty) || (rcEd && rcEd.dirty) || (stEd && stEd.dirty) || dirtyForm()); },
      ask: knAskLeave,
      discard: function () { discardForms(); ecEd = null; mdEd = null; rcEd = null; stDiscardEditor(); },
    });
    return _knGuard;
  }
  function dirtyEditor() {
    if (ecEd && ecEd.dirty) return ecEd;
    if (mdEd && mdEd.dirty) return mdEd;
    if (rcEd && rcEd.dirty) return rcEd;
    if (stEd && stEd.dirty) return stEd;
    return dirtyForm();
  }
  // In-page Cancel buttons: the same guard (and the same dialog) as the sidebar and browser Back.
  function guardThen(proceed) { knLeaveGuard().leave(proceed); }
  // In-page "← Back" links: guard first; a record page opened from its list goes back in history
  // (restores filters + scroll), an editor/history sub-page links to its record.
  function guardedBack(e, link, cameFromList, clear) {
    e.preventDefault();
    knLeaveGuard().leave(function () {
      clear();
      if (!link.getAttribute('data-sub') && cameFromList() && window.history.length > 1) { window.history.back(); return; }
      var href = link.getAttribute('href');
      if (href && location.hash !== href) location.hash = href;
    });
  }
  function knAskLeave(answer) {
    var done = function (ok) { if (!ok) pendingNavLoad = null; answer(ok); };
    var T = Kn.LEAVE_TEXT;
    var bodyEl = $('knLeaveBody');
    var dirtyEd = dirtyEditor();
    var bodyText = dirtyEd && dirtyEd === ecEd ? EC_TEXT.leave : (dirtyEd && dirtyEd === mdEd ? MD_TEXT.leave : (dirtyEd && dirtyEd === rcEd ? RC_TEXT.leave : (dirtyEd && dirtyEd === stEd ? ST_TEXT.leave : (dirtyEd && dirtyEd.leave ? dirtyEd.leave : T.body))));
    if (bodyEl) bodyEl.textContent = bodyText;
    T = Object.assign({}, T, { body: bodyText });
    var dlg = $('knLeaveDlg');
    var stay = $('knLeaveStay');
    var go = $('knLeaveGo');
    if (!dlg || !stay || !go || typeof dlg.showModal !== 'function') {
      done(window.confirm(T.title + '\n\n' + T.body + '\n\nOK = ' + T.leave + '. Cancel = ' + T.stay + '.'));
      return;
    }
    var returnFocus = document.activeElement;
    var finished = false;
    function finish(ok) {
      if (finished) return;
      finished = true;
      stay.removeEventListener('click', onStay);
      go.removeEventListener('click', onGo);
      dlg.removeEventListener('cancel', onCancel);
      if (dlg.open) dlg.close();
      if (!ok && returnFocus && returnFocus.focus) { try { returnFocus.focus(); } catch (e) { /* element gone */ } }
      done(ok);
    }
    function onStay() { finish(false); }
    function onGo() { finish(true); }
    function onCancel(e) { e.preventDefault(); finish(false); } // Escape = Stay
    stay.addEventListener('click', onStay);
    go.addEventListener('click', onGo);
    dlg.addEventListener('cancel', onCancel);
    dlg.showModal();
    stay.focus();
  }
  // A hash change away from a dirty editor (in-page link or browser Back). The URL has already changed,
  // so Stay puts the editor URL back without re-rendering (form state is untouched).
  function knGuardHashChange() {
    var ed = dirtyEditor();
    if (!ed || !ed.hash || location.hash === ed.hash) return false;
    var back = ed.hash;
    knLeaveGuard().leave(function () { applyHashRoute(); }, function () {
      try { history.pushState(null, '', back); } catch (e) { _hashFromNav = true; location.hash = back; _hashFromNav = false; }
    });
    return true;
  }
  window.addEventListener('beforeunload', function (e) {
    if (dirtyEditor()) { e.preventDefault(); e.returnValue = ''; }
  });
  // ---- pages: list (#knowledge?q&family) and detail (#knowledge/<id>?q&family) ----
  var knListScrollY = null;
  var knCameFromList = false;
  function knShowList(params) {
    knApplyParams(params);
    knOpenId = null;
    loadKnowledge();
    if (knListScrollY != null) {
      var y = knListScrollY; knListScrollY = null;
      setTimeout(function () { window.scrollTo(0, y); }, 0);
    }
  }
  function knShowDetail(id, params) {
    var listView = $('knListView');
    var listVisible = Boolean(listView && !listView.hidden && $('knList') && $('knList').querySelector('.kn-card'));
    if (listVisible) knListScrollY = window.scrollY || 0;
    knCameFromList = listVisible;
    knWire();
    knApplyParams(params);
    if (listView) listView.hidden = true;
    if ($('knDetailPage')) $('knDetailPage').hidden = false;
    var back = $('knBackLink');
    var listHref = hashString('knowledge', { q: (params && params.q) || '', family: (params && params.family) || '' });
    if (back) {
      back.setAttribute('href', listHref);
      back.textContent = '← Back to Knowledge';
      back.setAttribute('data-sub', '');
    }
    window.scrollTo(0, 0);
    knOpen(id);
  }
  function knOpen(id) {
    if (!id) return;
    knOpenId = id;
    var loading = $('knDetail');
    if (loading) { loading.hidden = false; loading.innerHTML = '<div class="tac__muted">Loading knowledge record…</div>'; }
    fetch(API_BASE + '/admin/knowledge/record?id=' + encodeURIComponent(id), { credentials: 'same-origin' })
      .then(function (r) {
        if (r.status === 401) { showGate('Your session has expired. Please log in again.'); return null; }
        return r.json();
      })
      .then(function (d) {
        if (knOpenId !== id) return;          // a newer navigation won
        if (!d || !d.knowledgeId) {
          var panel = $('knDetail');
          if (panel) { panel.hidden = false; panel.innerHTML = knEmpty('This knowledge record was not found.'); }
          return;
        }
        knRenderDetail(d);
      })
      .catch(function () {
        knRenderDetail(null);
        var panel = $('knDetail');
        if (panel) { panel.hidden = false; panel.innerHTML = knEmpty('Could not load this knowledge record.'); }
      });
  }
  function knOnFilter() {
    knRenderList();
    knWriteRoute();
  }
  function knWire() {
    if (knWired) return;
    knWired = true;
    if ($('knSearch')) $('knSearch').addEventListener('input', knOnFilter);
    if ($('knFamily')) $('knFamily').addEventListener('change', knOnFilter);
    if ($('knClear')) $('knClear').addEventListener('click', function () {
      if ($('knSearch')) $('knSearch').value = '';
      if ($('knFamily')) $('knFamily').value = '';
      knOnFilter();
    });
    if ($('knBackLink')) $('knBackLink').addEventListener('click', function (e) {
      // editor/history → the record page; record → back to the list it came from (filters + scroll).
      guardedBack(e, $('knBackLink'), function () { return knCameFromList; }, function () {});
    });
  }
  // The list page. Always shows the list view (also when reached from the nav while a record was open).
  function loadKnowledge() {
    knWire();
    var list = $('knList');
    if (!list) return;
    if ($('knDetailPage')) $('knDetailPage').hidden = true;
    if ($('knListView')) $('knListView').hidden = false;
    knOpenId = null;
    var route = parseHash();
    if (route.section === 'knowledge' && !route.sub) knApplyParams(route.params);
    if (knCache) {
      knFillFamilies();
      knFillHubs();
      knRenderList();
      return;
    }
    fetch(API_BASE + '/admin/knowledge', { credentials: 'same-origin' })
      .then(function (r) { return r.status === 401 ? null : r.json(); })
      .then(function (d) {
        if (!d) return;
        knCache = d;
        knFillFamilies();
        knFillHubs();
        knRenderList();
      })
      .catch(function () {
        list.innerHTML = '<div class="kn__empty">Could not load diagnostic knowledge.</div>';
      });
  }
  // ==== Media: list (browse only) → dedicated detail page → draft editor / history =================
  // Routes: #media?q&family&type&usage                   list
  //         #media/<id>?<list params>                    detail      (&review=1 opens the publish review)
  //         #media/<id>?view=edit | view=history[&v=N]
  //         #media/new                                   add media
  //         #media?id=<id>                               legacy → redirected to #media/<id>
  // Live boundary (enforced by the BFF store): Save draft (text or a replacement file) never changes what
  // customers see. Publish, Rollback, Archive, Restore and diagnostic attach/detach do. Every change to an
  // existing item sends the revision it was made from.
  var mdCache = null;
  var mdWired = false;
  var mdOpenId = null;
  var mdEd = null;            // editor state { id, isNew, base, dirty, hash, saving, revision, ... }
  var mdPendingReview = null;
  var mdListScrollY = null;
  var mdCameFromList = false;
  var Md = window.MdLogic || {};
  var MD_TEXT = {
    leave: 'You have unsaved Media changes. If you leave now they will be lost. Your saved draft and the live media are not affected.',
  };

  function mdListParams() {
    return {
      q: ($('mdSearch') && $('mdSearch').value) || '',
      family: ($('mdFamily') && ($('mdFamily').value || $('mdFamily').getAttribute('data-pending'))) || '',
      type: ($('mdType') && $('mdType').value) || '',
      usage: ($('mdUsage') && $('mdUsage').value) || '',
    };
  }
  function mdListHref(params) { return hashString('media', params || mdListParams()); }
  function mdDetailHref(id, extra) {
    var list = mdListHref();
    var qi = list.indexOf('?');
    var qs = qi === -1 ? '' : list.slice(qi + 1);
    var more = [];
    Object.keys(extra || {}).forEach(function (k) {
      if (extra[k] != null && extra[k] !== '') more.push(encodeURIComponent(k) + '=' + encodeURIComponent(extra[k]));
    });
    var all = [qs].concat(more).filter(Boolean).join('&');
    return '#media/' + encodeURIComponent(id) + (all ? '?' + all : '');
  }
  function mdWriteRoute() { writeHash('media', mdListParams()); }
  function mdApplyParams(params) {
    params = params || {};
    if ($('mdSearch') && params.q != null) $('mdSearch').value = params.q;
    if ($('mdFamily') && params.family != null) {
      $('mdFamily').setAttribute('data-pending', params.family);
      if ([].some.call($('mdFamily').options, function (o) { return o.value === params.family; })) {
        $('mdFamily').value = params.family;
      }
    }
    if ($('mdType') && params.type != null) $('mdType').value = params.type;
    if ($('mdUsage') && params.usage != null) $('mdUsage').value = params.usage;
  }
  function mdApi(path, opts) {
    opts = opts || {};
    return fetch(API_BASE + path, {
      method: opts.method || 'GET',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    }).then(function (r) {
      if (r.status === 401) showGate('Your session has expired. Please log in again.');
      return r.json().catch(function () { return {}; }).then(function (b) { return { ok: r.ok, status: r.status, body: b || {} }; });
    });
  }
  function mdErrText(res, fallback) {
    var b = (res && res.body) || {};
    if (res && res.status === 409 && b.code === 'conflict') return 'Someone else changed this media item. Reload to see the latest version, then try again.';
    var msg = b.error || fallback || 'That did not work.';
    if (b.extra && b.extra.fields && b.extra.fields.length) msg += ' Check: ' + b.extra.fields.join(', ') + '.';
    return msg;
  }
  function mdShowErr(id, res) {
    var el = $(id);
    if (!el) return;
    el.hidden = false;
    el.textContent = mdErrText(res, 'Could not save.');
  }
  function mdReadFile(file) {
    return new Promise(function (resolve, reject) {
      if (!file) return resolve(null);
      var r = new FileReader();
      r.onload = function () { resolve(r.result); };
      r.onerror = reject;
      r.readAsDataURL(file);
    });
  }
  function mdStateChip(rec) {
    var c = (Md.stateChip || function () { return { label: 'Live', cls: 'kn-state' }; })(rec, rec.admin);
    return '<span class="' + esc(c.cls) + '">' + esc(c.label) + '</span>';
  }

  // ---- list --------------------------------------------------------------------------------------
  function mdFiltered() {
    if (!mdCache) return [];
    return (Md.filterRecords || function (r) { return r; })(mdCache.records, mdListParams());
  }
  function mdFillFamilies() {
    var sel = $('mdFamily');
    if (!sel || !mdCache) return;
    var pending = sel.getAttribute('data-pending') || sel.value || '';
    var current = sel.value;
    sel.innerHTML = '<option value="">All appliances</option>' + (mdCache.families || []).map(function (f) {
      return '<option value="' + esc(f.family) + '">' + esc(f.label) + ' (' + f.count + ')</option>';
    }).join('');
    var want = pending || current;
    if (want && [].some.call(sel.options, function (o) { return o.value === want; })) sel.value = want;
    sel.removeAttribute('data-pending');
  }
  function mdUpdateClear() {
    var btn = $('mdClear');
    if (!btn) return;
    var p = mdListParams();
    btn.hidden = !p.q && !p.family && !p.type && !p.usage;
  }
  function mdStatusText(rows) {
    var total = (mdCache && mdCache.total) || 0;
    var p = mdListParams();
    var q = String(p.q || '').trim();
    var famLabel = p.family && Md.familyLabel ? Md.familyLabel(p.family) : p.family;
    var bits = ['Showing ' + rows.length + ' of ' + total + ' customer-help assets'];
    if (famLabel) bits.push(famLabel);
    if (p.type) bits.push(Md.typeLabel ? Md.typeLabel(p.type) : p.type);
    if (p.usage === 'used') bits.push('used by diagnostic knowledge');
    if (p.usage === 'unused') bits.push('not linked to diagnostic knowledge');
    if (p.usage === 'unavailable') bits.push('referenced file unavailable');
    if (p.usage === 'retired') bits.push('archived');
    if (p.usage === 'draft') bits.push('with unpublished drafts');
    if (q) bits.push('matching “' + q + '”');
    if (mdCache && mdCache.draftCount) bits.push(mdCache.draftCount + ' with unpublished drafts');
    return bits.join(' · ');
  }
  function mdCardPreview(rec) {
    if (!rec.available) {
      return '<span class="md-card__preview md-card__preview--missing">Media unavailable</span>';
    }
    if (rec.previewKind === 'video') {
      return '<span class="md-card__preview md-card__preview--video">Video preview</span>';
    }
    if (rec.previewUrl) {
      return '<span class="md-card__preview"><img src="' + esc(rec.previewUrl) + '" alt="" loading="lazy" /></span>';
    }
    return '<span class="md-card__preview md-card__preview--none">No preview recorded</span>';
  }
  function mdCard(rec) {
    var fam = rec.familyLabel || (rec.families && rec.families[0] && Md.familyLabel ? Md.familyLabel(rec.families[0]) : 'No appliance family recorded');
    var typeLab = rec.typeLabel || (Md.typeLabel && Md.typeLabel(rec.type)) || rec.type;
    var usage = Md.usageLabel ? Md.usageLabel(rec) : (rec.used ? ('Used by ' + rec.knowledgeCount + ' diagnostic topics') : 'Not currently linked to diagnostic knowledge');
    var topics = (rec.knowledgePreview || []).map(function (k) { return k.label || k.knowledgeId; }).join(' · ');
    var flags = [mdStateChip(rec)];
    flags.push('<span class="md-flag">' + esc(typeLab) + '</span>');
    if (!rec.used) flags.push('<span class="md-flag md-flag--gap">Not currently linked to diagnostic knowledge</span>');
    else flags.push('<span class="md-flag">' + esc(usage) + '</span>');
    if (rec.origin === 'admin') flags.push('<span class="md-flag">Admin-created</span>');
    if (rec.currentVersion) flags.push('<span class="md-flag">v' + esc(String(rec.currentVersion)) + '</span>');
    if (!rec.available) flags.push('<span class="md-flag md-flag--missing">Referenced file unavailable</span>');
    (rec.gaps || []).forEach(function (g) {
      if (g === 'Not linked to diagnostic knowledge' || g === 'Referenced file unavailable') return;
      flags.push('<span class="md-flag md-flag--gap">' + esc(g) + '</span>');
    });
    var name = (rec.title || rec.id) + ', ' + typeLab + ', ' + fam;
    return '<a class="md-card" data-md-id="' + esc(rec.id) + '" href="' + esc(mdDetailHref(rec.id)) + '" aria-label="' + esc(name) + '">'
      + mdCardPreview(rec)
      + '<span class="md-card__main">'
      + '<span class="md-card__fam">' + esc(fam) + '</span>'
      + '<span class="md-card__title">' + esc(rec.title || rec.id) + '</span>'
      + '<span class="md-card__meta">' + esc(typeLab) + (rec.used ? ' · ' + esc(usage) : '') + '</span>'
      + (topics ? '<span class="md-card__usage">Used by: ' + esc(topics) + '</span>' : '<span class="md-card__usage">Not currently linked to diagnostic knowledge</span>')
      + '<span class="md-card__flags">' + flags.join('') + '</span>'
      + '</span><span class="md-card__go" aria-hidden="true">›</span></a>';
  }
  function mdRenderList() {
    var list = $('mdList');
    var status = $('mdStatus');
    if (!list || !mdCache) return;
    var rows = mdFiltered();
    if (status) status.textContent = mdStatusText(rows);
    mdUpdateClear();
    if (!rows.length) {
      list.innerHTML = '<div class="kn__empty">No customer-help media matches this search.</div>';
      return;
    }
    var groups = Md.groupByFamily ? Md.groupByFamily(rows) : [{ family: '', label: 'Media', records: rows }];
    list.innerHTML = groups.map(function (g) {
      return '<section class="md-family">'
        + '<h2 class="md-family__h">' + esc(g.label) + ' <span class="md-family__count">(' + g.records.length + ')</span></h2>'
        + '<div class="md-family__cards">' + g.records.map(mdCard).join('') + '</div></section>';
    }).join('');
  }
  function mdOnFilter() {
    mdWriteRoute();
    mdRenderList();
  }
  function mdRestoreScroll() {
    if (mdListScrollY == null) return;
    var y = mdListScrollY; mdListScrollY = null;
    setTimeout(function () { window.scrollTo(0, y); }, 0);
  }
  function mdWire() {
    if (mdWired) return;
    mdWired = true;
    if ($('mdSearch')) $('mdSearch').addEventListener('input', mdOnFilter);
    ['mdFamily', 'mdType', 'mdUsage'].forEach(function (id) { if ($(id)) $(id).addEventListener('change', mdOnFilter); });
    if ($('mdClear')) $('mdClear').addEventListener('click', function () {
      ['mdSearch', 'mdFamily', 'mdType', 'mdUsage'].forEach(function (id) { if ($(id)) $(id).value = ''; });
      mdOnFilter();
    });
    if ($('mdBackLink')) $('mdBackLink').addEventListener('click', function (e) {
      guardedBack(e, $('mdBackLink'), function () { return mdCameFromList; }, function () { mdEd = null; });
    });
  }
  function mdFetchList() {
    return fetch(API_BASE + '/admin/media', { credentials: 'same-origin' })
      .then(function (r) { return r.status === 401 ? null : r.json(); })
      .then(function (d) {
        if (!d) return null;
        mdCache = d;
        return d;
      });
  }
  // The list page. Always shows the list view (also when reached from the nav while a record was open).
  function loadMedia() {
    mdWire();
    var list = $('mdList');
    if (!list) return;
    if ($('mdDetailPage')) $('mdDetailPage').hidden = true;
    if ($('mdListView')) $('mdListView').hidden = false;
    mdOpenId = null;
    var route = parseHash();
    if (route.section === 'media' && !route.sub) mdApplyParams(route.params);
    if (mdCache) {
      mdFillFamilies();
      mdRenderList();
      mdRestoreScroll();
      return;
    }
    list.innerHTML = '<div class="tac__muted">Loading…</div>';
    mdFetchList().then(function (d) {
      if (!d) return;
      mdFillFamilies();
      mdRenderList();
      mdRestoreScroll();
    }).catch(function () {
      list.innerHTML = '<div class="kn__empty">Could not load customer-help media.</div>';
    });
  }

  // ---- detail page ---------------------------------------------------------------------------------
  function mdShowDetail(id, params) {
    params = params || {};
    var listView = $('mdListView');
    var listVisible = Boolean(listView && !listView.hidden && $('mdList') && $('mdList').querySelector('.md-card'));
    if (listVisible) mdListScrollY = window.scrollY || 0;
    mdCameFromList = listVisible;
    mdWire();
    mdApplyParams(params);
    if (listView) listView.hidden = true;
    if ($('mdDetailPage')) $('mdDetailPage').hidden = false;
    var view = params.view || '';
    var sub = id !== 'new' && (view === 'edit' || view === 'history');
    var back = $('mdBackLink');
    var listParams = { q: params.q || '', family: params.family || '', type: params.type || '', usage: params.usage || '' };
    if (back) {
      back.setAttribute('href', sub ? mdDetailHref(id) : mdListHref(listParams));
      back.textContent = sub ? '← Back to media item' : '← Back to Media';
      back.setAttribute('data-sub', sub ? '1' : '');
    }
    window.scrollTo(0, 0);
    if (mdEd && !((view === 'edit' && mdEd.id === id) || (id === 'new' && mdEd.isNew))) mdEd = null;
    if (id === 'new') { mdRenderEditor(null); return; }
    if (view === 'edit') { mdShowEditor(id); return; }
    if (view === 'history') { mdShowHistory(id, params.v); return; }
    mdPendingReview = params.review ? id : null;
    mdOpen(id);
  }
  function mdOpen(id, okMsg, badMsg) {
    if (!id) return;
    mdOpenId = id;
    var panel = $('mdDetail');
    if (panel) { panel.hidden = false; panel.innerHTML = '<p class="tac__muted">Loading media…</p>'; }
    mdApi('/admin/media/record?id=' + encodeURIComponent(id)).then(function (res) {
      if (mdOpenId !== id || res.status === 401) return;
      if (!res.ok || !res.body.id) {
        if (panel) { panel.hidden = false; panel.innerHTML = mdEmpty(res.status === 404 ? 'This media record was not found.' : mdErrText(res, 'Could not load this media record.')); }
        return;
      }
      mdRenderDetail(res.body);
      if (mdPendingReview === id) { mdPendingReview = null; if (res.body.admin && res.body.admin.canPublish) mdOpenReview(res.body); }
      if (okMsg) mdNotice('ok', okMsg);
      if (badMsg) mdNotice('bad', badMsg);
    }).catch(function () {
      if (panel) { panel.hidden = false; panel.innerHTML = mdEmpty('Could not load this media record.'); }
    });
  }
  function mdNotice(kind, msg) {
    var el = $('mdNotice');
    if (!el) return;
    el.hidden = !msg;
    el.className = 'kn-notice' + (kind ? ' kn-notice--' + kind : '');
    el.textContent = msg || '';
    if (msg) el.focus();
  }
  function mdEmpty(label) {
    return '<p class="md-sec__empty">' + esc(label) + '</p>';
  }
  function mdUnavailable(note) {
    return '<div class="md-unavailable" role="status"><strong>Media unavailable</strong><p>'
      + esc(note || 'Referenced asset could not be loaded.') + '</p></div>';
  }
  function mdPreviewHtml(rec) {
    if (!rec.available) return mdUnavailable(rec.availabilityNote);
    if (rec.previewKind === 'video') {
      var embed = (Md.safeEmbedUrl && rec.embedUrl) ? Md.safeEmbedUrl(rec.embedUrl) : null;
      if (embed) {
        return '<div class="md-video"><iframe src="' + esc(embed) + '" title="' + esc(rec.title || 'Instructional video')
          + '" loading="lazy" allow="fullscreen; picture-in-picture; encrypted-media" allowfullscreen referrerpolicy="strict-origin-when-cross-origin"></iframe></div>'
          + (rec.attribution ? '<p class="tx__sub">' + esc(rec.attribution) + '</p>' : '')
          + '<p class="tx__sub">External provider: YouTube (privacy-enhanced embed). Playback starts only if you press play.</p>';
      }
      return mdUnavailable(rec.availabilityNote || 'Referenced asset could not be loaded. External embed host is not on the trusted list.');
    }
    if (rec.previewUrl) {
      return '<figure class="md-preview"><button type="button" class="md-preview__zoom" id="mdZoom" aria-label="Open a larger view of ' + esc(rec.title || 'this media') + '">'
        + '<img src="' + esc(rec.previewUrl) + '" alt="Admin preview of ' + esc(rec.title || rec.id) + '" id="mdPreviewImg" />'
        + '</button></figure>';
    }
    return mdUnavailable('Referenced asset could not be loaded.');
  }
  function mdBindPreview(rec) {
    var img = $('mdPreviewImg');
    if (img) {
      img.addEventListener('error', function () {
        var fig = img.closest ? img.closest('.md-preview') : img.parentNode;
        if (fig) fig.outerHTML = mdUnavailable('Referenced asset could not be loaded.');
      });
    }
    var zoom = $('mdZoom');
    if (zoom && rec.previewUrl) {
      zoom.addEventListener('click', function () {
        var dlg = document.createElement('dialog');
        dlg.className = 'md-lightbox';
        dlg.setAttribute('aria-label', 'Larger view of ' + (rec.title || rec.id));
        dlg.innerHTML = '<div class="md-lightbox__bar"><p>' + esc(rec.title || rec.id) + '</p>'
          + '<button type="button" class="btn btn--ghost" id="mdLightClose">Close</button></div>'
          + '<img src="' + esc(rec.previewUrl) + '" alt="Admin preview of ' + esc(rec.title || rec.id) + '" />';
        document.body.appendChild(dlg);
        function close() { try { dlg.close(); } catch (e) { /* ignore */ } dlg.remove(); }
        dlg.addEventListener('click', function (ev) { if (ev.target === dlg) close(); });
        if ($('mdLightClose')) $('mdLightClose').addEventListener('click', close);
        try { dlg.showModal(); } catch (e) { window.open(rec.previewUrl, '_blank', 'noopener'); dlg.remove(); }
      });
    }
  }
  function mdCustomerPreviewHtml(rec) {
    var desc = rec.description && String(rec.description).trim();
    var alt = rec.alt && String(rec.alt).trim();
    var customerAsset = rec.available && rec.previewKind === 'video'
      ? mdPreviewHtml(rec)
      : (rec.available && rec.previewUrl
        ? '<figure class="md-preview"><img src="' + esc(rec.previewUrl) + '" alt="Customer preview of ' + esc(rec.title || rec.id) + '" /></figure>'
        : mdPreviewHtml(rec));
    return '<div class="md-preview-box" id="mdCustomerPreview"><p class="md-preview-box__h">This is what the ApplianceClinic customer will see</p>'
      + customerAsset
      + '<p><strong>' + esc(rec.title || rec.id) + '</strong></p>'
      + (desc ? '<p>' + esc(desc) + '</p>' : '')
      + (alt && rec.type !== 'VIDEO' ? '<p class="tx__sub">Alt text: ' + esc(alt) + '</p>' : '')
      + (rec.type === 'VIDEO' ? '<p class="tx__sub">Playback starts only if the customer presses play.</p>' : '')
      + ((rec.knowledge || []).length
        ? '<p class="tx__sub">Knowledge topics that can surface this: ' + esc(rec.knowledge.map(function (k) { return k.label || k.knowledgeId; }).join(' · ')) + '</p>'
        : '<p class="tx__sub">Not currently mapped to a diagnostic Knowledge topic.</p>')
      + (rec.status === 'retired' ? '<p class="tx__sub">Archived — withheld from customer presentation at the ApplianceClinic boundary.</p>' : '')
      + '</div>';
  }
  function mdUsageHtml(a) {
    var u = (a && a.usage) || {};
    var canon = u.canonical || [];
    var rows = [];
    rows.push('<dt>Knowledge records</dt><dd>' + esc((u.knowledge || []).map(function (k) { return k.label || k.knowledgeId; }).join(' · ') || 'None') + '</dd>');
    rows.push('<dt>Component mappings</dt><dd>' + esc((u.components || []).map(function (c) { return c.componentKey; }).join(' · ') || 'None') + '</dd>');
    rows.push('<dt>Canonical journeys</dt><dd>' + (canon.length
      ? '<ul class="md-hubs">' + canon.map(function (c) { return '<li>' + esc(c.journey) + ' · ' + esc(c.actionKey) + ' <span class="tx__sub">via ' + esc(c.knowledgeId) + '</span></li>'; }).join('') + '</ul>'
      : 'None') + '</dd>');
    rows.push('<dt>Public Help Hubs</dt><dd>' + esc((u.helpHubs || []).map(function (h) { return h.title; }).join(' · ') || 'None') + '</dd>');
    return '<dl class="md-ov">' + rows.join('') + '</dl>'
      + '<p class="tx__sub">Usage is matched by media id (structured references), never by title or text.'
      + (canon.length ? ' Canonical journeys show this media only while its Knowledge mapping is attached and the item is not archived.' : '') + '</p>';
  }
  function mdActionsHtml(rec) {
    var a = rec.admin || {};
    var id = rec.id;
    var b = [];
    if (a.status !== 'retired') {
      b.push('<a class="btn btn--primary" id="mdEdit" href="' + esc(mdDetailHref(id, { view: 'edit' })) + '">' + knIco('edit') + (a.draftPending ? 'Edit draft' : 'Edit presentation') + '</a>');
    }
    if (a.canPublish) b.push('<button class="btn btn--primary" type="button" data-md-act="publish">' + knIco('publish') + 'Review &amp; publish…</button>');
    b.push('<a class="btn btn--ghost" href="' + esc(mdDetailHref(id, { view: 'history' })) + '">' + knIco('history') + 'View version history</a>');
    if (a.canRestore) b.push('<button class="btn btn--primary" type="button" id="mdRestore" data-md-act="restore">' + knIco('rollback') + 'Restore</button>');
    var risky = [];
    if (a.canDiscard) risky.push('<button class="btn btn--ghost" type="button" data-md-act="discard">Discard draft</button>');
    if (a.canDelete) risky.push('<button class="btn btn--ghost kn-danger" type="button" id="mdDelete" data-md-act="delete">Delete unused</button>');
    if (a.canArchive) risky.push('<button class="btn btn--ghost kn-danger" type="button" id="mdRetire" data-md-act="archive">' + knIco('archive') + 'Archive</button>');
    if (risky.length) b.push('<span class="kn-actions__risky">' + risky.join('') + '</span>');
    var meta = [];
    meta.push('Live: ' + (a.status === 'retired' ? 'withheld (archived)' : (a.liveVersionLabel || 'live')));
    if (a.draftPending) meta.push('Draft saved ' + fmtWhen(a.draftSavedAt) + (a.draftSavedBy ? ' by ' + a.draftSavedBy : ''));
    if (a.status === 'retired' && a.retiredAt) meta.push('Archived ' + fmtWhen(a.retiredAt) + (a.retiredBy ? ' by ' + a.retiredBy : ''));
    meta.push(a.origin === 'admin' ? 'Admin-created' : 'Shipped catalogue');
    var pending = (a.pendingChanges || []).length
      ? '<p class="kn-actions__pending">Draft changes not yet live: ' + esc((Md.changeLabels ? Md.changeLabels(a.pendingChanges) : a.pendingChanges).join(', ')) + '</p>' : '';
    var delNote = !a.canDelete && a.origin === 'admin' && a.deleteBlockedReason ? '<p class="tx__sub">' + esc(a.deleteBlockedReason) + '</p>' : '';
    return '<div class="kn-actions"><div class="kn-actions__state">' + mdStateChip(rec) + '<span class="tx__sub">' + esc(meta.join(' · ')) + '</span></div>'
      + pending + '<div class="kn-actions__btns">' + b.join('') + '</div>' + delNote
      + '<p class="kn-notice" id="mdNotice" tabindex="-1" role="status" aria-live="polite" hidden></p></div>';
  }
  function mdRenderDetail(rec) {
    var panel = $('mdDetail');
    if (!panel) return;
    if (!rec) { panel.hidden = true; panel.innerHTML = ''; return; }
    var a = rec.admin || {};
    var fam = rec.familyLabel || 'No appliance family recorded';
    var typeLab = rec.typeLabel || rec.type;
    var desc = rec.description && String(rec.description).trim();
    var alt = rec.alt && String(rec.alt).trim();
    var caption = rec.caption && String(rec.caption).trim();
    var retired = rec.status === 'retired';
    var knowledgeHtml;
    if (rec.knowledge && rec.knowledge.length) {
      knowledgeHtml = rec.knowledge.map(function (k) {
        return '<article class="md-use">'
          + '<h3 class="md-use__h">' + esc(k.label || k.knowledgeId) + '</h3>'
          + '<p class="md-use__meta">' + esc(k.familyLabel || k.applianceFamily || '') + ' · faultId ' + esc(k.faultId || 'not recorded')
          + ' · ' + esc(k.knowledgeId) + '</p>'
          + (k.relatedCheck ? '<p>Shown for: ' + esc(k.relatedCheck) + '</p>' : mdEmpty('No customer-context check recorded for this mapping'))
          + (k.description ? '<p>' + esc(k.description) + '</p>' : '')
          + ((k.descriptions || []).length > 1 ? '<ul class="md-hubs">' + k.descriptions.map(function (d) { return '<li>' + esc(d) + '</li>'; }).join('') + '</ul>' : '')
          + '<p><a href="#knowledge?id=' + encodeURIComponent(k.knowledgeId) + '">Open in Knowledge</a></p>'
          + (retired ? '' : '<div class="md-use__actions">'
            + '<button class="btn btn--ghost" type="button" data-md-detach="' + esc(k.knowledgeId) + '">Detach from this Knowledge record</button></div>')
          + '</article>';
      }).join('');
    } else knowledgeHtml = mdEmpty('Not currently linked to diagnostic knowledge');
    var componentHtml = (rec.components || []).length
      ? '<ul class="md-hubs">' + rec.components.map(function (c) {
        return '<li>' + esc(c.componentKey) + (c.relatedCheck ? ' — ' + esc(c.relatedCheck) : '')
          + (retired ? '' : ' <button type="button" class="btn btn--ghost" data-md-detach-comp="' + esc(c.componentKey) + '">Detach</button>')
          + '</li>';
      }).join('') + '</ul>'
      : '';
    var hubHtml = (rec.helpHubs || []).length
      ? '<p>Also used in public help:</p><ul class="md-hubs">' + rec.helpHubs.map(function (h) {
        return '<li><a href="/' + esc(h.slug) + '/" target="_blank" rel="noopener">' + esc(h.title) + '</a></li>';
      }).join('') + '</ul>'
      : mdEmpty('Not recorded on a public Help Hub');
    var codeHtml = (rec.errorCodes || []).length
      ? '<ul class="md-codes">' + rec.errorCodes.map(function (c) { return '<li>' + esc(c) + '</li>'; }).join('') + '</ul>'
        + '<p class="tx__sub">These codes are stored on this media mapping. The Error Codes page owns the MCP catalogue.</p>'
      : mdEmpty('No error-code relationship recorded on this asset');
    var safetyHtml = rec.safetyClass
      ? '<p>Recorded safety class: ' + esc(String(rec.safetyClass).replace(/_/g, ' ')) + '</p>'
      : mdEmpty('No safety class recorded');
    var aliasHtml = (rec.sameFileAs || []).length
      ? '<ul class="md-aliases">' + rec.sameFileAs.map(function (x) {
        return '<li><a href="' + esc(mdDetailHref(x.id)) + '">' + esc(x.title || x.id) + '</a> <span class="tx__sub">' + esc(x.id) + '</span></li>';
      }).join('') + '</ul>'
      : mdEmpty('No other media identity shares this file');
    var banner = retired
      ? '<p class="kn-banner" role="status">Archived — withheld from customer presentation and from diagnosis' + (a.retiredReason ? ' (' + esc(a.retiredReason) + ')' : '') + '. Files and history are kept. Restore to bring it back.</p>'
      : (a.draftPending ? '<p class="kn-banner kn-banner--info">Showing the live version. A draft with unpublished changes exists — customers do not see it until it is published.</p>' : '');
    var mapForm = retired ? '' : '<form class="md-form" id="mdMapForm">'
      + '<p class="md-banner">Diagnostic usage. Attaching or detaching changes which customer diagnoses can show this media. Live ApplianceClinic diagnosis uses these mappings.</p>'
      + '<label for="mdMapQ">Existing Knowledge record</label><input id="mdMapQ" type="search" placeholder="Search topic, faultId, or knowledge id" autocomplete="off" />'
      + '<div id="mdMapHits"></div>'
      + '<label for="mdMapDesc">Mapping description</label><textarea id="mdMapDesc" aria-describedby="mdMapDescHelp">' + esc(desc || '') + '</textarea><span class="md-form__hint" id="mdMapDescHelp">Shown with this mapping. Optional related check below.</span>'
      + '<label for="mdMapCheck">Related check</label><input id="mdMapCheck" value="' + esc(rec.relatedCheck || '') + '" />'
      + '<label class="md-form__checks"><input type="checkbox" id="mdMapConfirm"> I understand this changes which customer diagnoses can show this media</label>'
      + '<div class="md-form__row"><button class="btn btn--primary" type="submit" id="mdMapSubmit" disabled>Attach to Knowledge</button></div>'
      + '<p class="md-form__err" id="mdMapErr" role="alert" hidden></p></form>';
    var componentForm = retired ? '' : '<form class="md-form" id="mdCompForm">'
      + '<p class="md-form__hint">byComponent is an active diagnostic join (family:canonical-component). Do not invent new component names.</p>'
      + '<label for="mdCompKey">Component key</label><input id="mdCompKey" placeholder="oven-cooker:fan-oven-element" />'
      + '<label class="md-form__checks"><input type="checkbox" id="mdCompConfirm"> I understand this can surface this asset during diagnosis</label>'
      + '<div class="md-form__row"><button class="btn btn--primary" type="submit" id="mdCompSubmit" disabled>Attach to component</button></div>'
      + '<p class="md-form__err" id="mdCompErr" role="alert" hidden></p></form>';
    var tech = rec.technical || {};
    var files = (rec.files || []).map(function (f) {
      return [f.file, f.url, f.type, f.bytes != null ? f.bytes + ' bytes' : null, f.videoId].filter(Boolean).join(' · ');
    });
    var techRows = '<dl class="md-ov">'
      + '<dt>Media id</dt><dd>' + esc(tech.id || rec.id) + '</dd>'
      + '<dt>Content type</dt><dd>' + esc(typeLab) + '</dd>'
      + '<dt>Path</dt><dd>' + esc(tech.previewUrl || ((rec.files && rec.files[0] && rec.files[0].url) || 'No path recorded')) + '</dd>'
      + '<dt>Video id</dt><dd>' + esc(tech.videoId || 'No video id recorded') + '</dd>'
      + '<dt>Embed URL</dt><dd>' + esc(tech.embedUrl || 'No embed URL recorded') + '</dd>'
      + '<dt>Trusted embed</dt><dd>' + (tech.embedTrusted ? 'Yes' : 'No') + '</dd>'
      + '<dt>Catalogue rows</dt><dd>' + esc(tech.catalogueRows) + '</dd>'
      + '<dt>Mapping count</dt><dd>' + esc(tech.mappingCount) + '</dd>'
      + '<dt>Revision</dt><dd>' + esc(String(a.revision || 0)) + '</dd>'
      + '</dl>'
      + (files.length ? '<h3 class="md-sec__h">Files</h3><ul class="md-hubs">' + files.map(function (x) { return '<li>' + esc(x) + '</li>'; }).join('') + '</ul>' : '')
      + '<h3 class="md-sec__h">Raw mapping record</h3><pre>' + esc(JSON.stringify(rec.raw || rec, null, 2)) + '</pre>';

    panel.hidden = false;
    panel.innerHTML = '<div class="kn-detail__head"><div>'
      + '<p class="kn-detail__fam">' + esc(fam) + '</p>'
      + '<h2 class="kn-detail__title md-detail__title">' + esc(rec.title || rec.id) + '</h2>'
      + '<p class="kn-detail__id md-detail__id">' + esc(typeLab) + ' · ' + esc(rec.id) + '</p>'
      + '</div></div>'
      + mdActionsHtml(rec) + banner
      + '<section class="md-sec"><h3 class="md-sec__h">Overview</h3><dl class="md-ov">'
      + '<dt>Title</dt><dd>' + esc(rec.title || 'No title recorded') + '</dd>'
      + '<dt>Type</dt><dd>' + esc(typeLab) + '</dd>'
      + '<dt>Appliance</dt><dd>' + esc(fam) + '</dd>'
      + '<dt>When it is shown</dt><dd>' + esc(rec.relatedCheck || 'No customer-context check recorded') + '</dd>'
      + '</dl></section>'
      + '<section class="md-sec"><h3 class="md-sec__h">Preview</h3>' + mdPreviewHtml(rec) + '</section>'
      + '<section class="md-sec md-sec--present"><h3 class="md-sec__h">Customer-facing text</h3><p class="tx__sub">Customer presentation — not diagnostic mappings. Edits are saved as a draft and only reach customers when published.</p><dl class="md-ov">'
      + '<dt>Description</dt><dd>' + esc(desc || 'No customer description recorded') + '</dd>'
      + '<dt>Caption</dt><dd>' + esc(caption || 'No customer description recorded') + '</dd>'
      + '<dt>Alt text</dt><dd>' + esc(alt || 'No alt text recorded') + '</dd>'
      + '</dl></section>'
      + '<section class="md-sec"><h3 class="md-sec__h">Customer preview</h3>' + mdCustomerPreviewHtml(rec) + '</section>'
      + '<section class="md-sec md-sec--usage"><h3 class="md-sec__h">Diagnostic usage</h3>' + knowledgeHtml + componentHtml
      + mapForm + componentForm + '</section>'
      + '<section class="md-sec"><h3 class="md-sec__h">Where this is used</h3>' + mdUsageHtml(a) + '</section>'
      + '<section class="md-sec"><h3 class="md-sec__h">Related public help</h3>' + hubHtml + '</section>'
      + '<section class="md-sec"><h3 class="md-sec__h">Related error codes</h3>' + codeHtml + '</section>'
      + '<section class="md-sec"><h3 class="md-sec__h">Safety</h3>' + safetyHtml + '</section>'
      + '<section class="md-sec"><h3 class="md-sec__h">Same file, other identity</h3>' + aliasHtml + '</section>'
      + '<details class="md-tech"><summary>Technical details</summary>' + techRows + '</details>';
    Array.prototype.forEach.call(panel.querySelectorAll('[data-md-act]'), function (btn) {
      btn.addEventListener('click', function () { mdDoAction(btn.getAttribute('data-md-act'), rec, btn); });
    });
    mdBindPreview(rec);
    mdBindMappings(rec);
  }
  function mdBusy(btn, label) {
    var panel = $('mdDetail');
    Array.prototype.forEach.call((panel && panel.querySelectorAll('[data-md-act], .kn-actions .btn')) || [], function (x) { x.disabled = true; x.setAttribute('aria-disabled', 'true'); });
    if (btn) btn.textContent = label;
  }
  function mdUsageSummary(a) {
    var u = (a && a.usage) || {};
    var lines = [];
    lines.push('Diagnostic usage: ' + ((u.knowledge || []).map(function (k) { return k.label || k.knowledgeId; }).join(', ') || 'no diagnostic Knowledge mappings'));
    if ((u.components || []).length) lines.push('Component mappings: ' + u.components.map(function (c) { return c.componentKey; }).join(', '));
    if ((u.canonical || []).length) lines.push('Canonical journeys: ' + u.canonical.map(function (c) { return c.journey; }).filter(function (x, i, arr) { return arr.indexOf(x) === i; }).join(', '));
    lines.push('Help Hubs: ' + ((u.helpHubs || []).map(function (h) { return h.title; }).join(', ') || 'no Help Hub pages'));
    return lines.join('\n');
  }
  function mdDoAction(act, rec, btn) {
    var a = rec.admin || {};
    var id = rec.id;
    var q = '?id=' + encodeURIComponent(id);
    var label = rec.title || id;
    var req = null;
    var ok = '';
    if (act === 'publish') { mdOpenReview(rec); return; }
    if (act === 'discard') {
      if (!window.confirm('Discard the unpublished draft of “' + label + '”?\n\nThe live media is not affected.')) return;
      mdBusy(btn, 'Discarding…'); ok = 'Draft discarded.';
      req = mdApi('/admin/media/record/discard' + q, { method: 'POST', body: { expectedRevision: a.revision } });
    } else if (act === 'archive') {
      var reason = window.prompt('Archive “' + label + '”?\n\n' + mdUsageSummary(a) + '\n\nCustomers stop seeing it in diagnosis (the Knowledge records and journeys above). Public Help Hub pages are static and keep showing the file. Files, mappings and history are kept, and Restore brings it back.\n\nOptional reason:', '');
      if (reason === null) return;
      mdBusy(btn, 'Archiving…'); ok = 'Archived. Customers no longer see this media.';
      req = mdApi('/admin/media/record/retire' + q, { method: 'POST', body: { expectedRevision: a.revision, confirm: true, reason: reason } });
    } else if (act === 'restore') {
      if (!window.confirm('Restore “' + label + '”?\n\n' + mdUsageSummary(a) + '\n\nCustomers will see it again wherever it is attached.')) return;
      mdBusy(btn, 'Restoring…'); ok = 'Restored. Customers see it again wherever it is attached.';
      req = mdApi('/admin/media/record/restore' + q, { method: 'POST', body: { expectedRevision: a.revision } });
    } else if (act === 'delete') {
      if (!window.confirm('Permanently remove “' + label + '”?\n\nIt has never been attached to diagnosis, so no customer has seen it. The stored file is kept. This cannot be undone.')) return;
      mdBusy(btn, 'Deleting…');
      req = mdApi('/admin/media/record' + q, { method: 'DELETE', body: { expectedRevision: a.revision, confirm: true } }).then(function (res) {
        if (res.ok && res.body.deleted) { mdCache = null; location.hash = mdListHref(); return null; }
        return res;
      });
    }
    if (!req) return;
    req.then(function (res) {
      if (!res) return;
      mdCache = null;
      if (res.ok) { mdOpen(id, ok); return; }
      mdOpen(id, null, mdErrText(res, 'That action failed. Nothing was changed.'));
    }).catch(function () { mdOpen(id, null, 'Could not reach the server. Nothing was changed.'); });
  }
  function mdBindMappings(rec) {
    var a = rec.admin || {};
    var selectedKid = null;
    function renderHits(records) {
      var box = $('mdMapHits');
      if (!box) return;
      box.innerHTML = (records || []).slice(0, 8).map(function (r) {
        return '<button type="button" class="btn btn--ghost" data-md-kid="' + esc(r.knowledgeId) + '">'
          + esc(r.label) + ' <span class="tx__sub">' + esc(r.knowledgeId) + '</span></button>';
      }).join('') || '<p class="tx__sub">Type to search existing Knowledge records.</p>';
      box.querySelectorAll('[data-md-kid]').forEach(function (btn) {
        btn.addEventListener('click', function () {
          selectedKid = btn.getAttribute('data-md-kid');
          if ($('mdMapQ')) $('mdMapQ').value = selectedKid;
        });
      });
    }
    if ($('mdMapQ')) {
      var t = null;
      $('mdMapQ').addEventListener('input', function () {
        var q = $('mdMapQ').value;
        selectedKid = q;
        clearTimeout(t);
        t = setTimeout(function () {
          mdApi('/admin/media/knowledge?q=' + encodeURIComponent(q)).then(function (res) {
            if (res.ok) renderHits(res.body.records);
          });
        }, 200);
      });
    }
    if ($('mdMapConfirm') && $('mdMapSubmit')) {
      $('mdMapConfirm').addEventListener('change', function () { $('mdMapSubmit').disabled = !$('mdMapConfirm').checked; });
    }
    if ($('mdMapForm')) $('mdMapForm').addEventListener('submit', function (e) {
      e.preventDefault();
      var kid = selectedKid || ($('mdMapQ') && $('mdMapQ').value);
      mdApi('/admin/media/record/map?id=' + encodeURIComponent(rec.id), {
        method: 'POST',
        body: {
          expectedRevision: a.revision,
          knowledgeId: kid,
          confirmDiagnostic: true,
          description: $('mdMapDesc') && $('mdMapDesc').value,
          relatedCheck: $('mdMapCheck') && $('mdMapCheck').value,
        },
      }).then(function (res) {
        if (!res.ok) return mdShowErr('mdMapErr', res);
        mdCache = null;
        mdOpen(rec.id, 'Attached. Live diagnosis for ' + kid + ' can now show this media.');
      });
    });
    var host = $('mdDetail');
    if (host) host.querySelectorAll('[data-md-detach]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var kid = btn.getAttribute('data-md-detach');
        if (!window.confirm('Detach from ' + kid + '?\n\nThis changes which customer diagnoses can show this media.')) return;
        mdApi('/admin/media/record/map?id=' + encodeURIComponent(rec.id), {
          method: 'DELETE',
          body: { expectedRevision: a.revision, knowledgeId: kid, confirmDiagnostic: true },
        }).then(function (res) {
          mdCache = null;
          if (!res.ok) return mdOpen(rec.id, null, mdErrText(res, 'Could not detach.'));
          mdOpen(rec.id, 'Detached from ' + kid + '.');
        });
      });
    });
    if ($('mdCompConfirm') && $('mdCompSubmit')) {
      $('mdCompConfirm').addEventListener('change', function () { $('mdCompSubmit').disabled = !$('mdCompConfirm').checked; });
    }
    if ($('mdCompForm')) $('mdCompForm').addEventListener('submit', function (e) {
      e.preventDefault();
      mdApi('/admin/media/record/component?id=' + encodeURIComponent(rec.id), {
        method: 'POST',
        body: { expectedRevision: a.revision, componentKey: $('mdCompKey') && $('mdCompKey').value, confirmDiagnostic: true },
      }).then(function (res) {
        if (!res.ok) return mdShowErr('mdCompErr', res);
        mdCache = null;
        mdOpen(rec.id, 'Attached to component.');
      });
    });
    if (host) host.querySelectorAll('[data-md-detach-comp]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var ck = btn.getAttribute('data-md-detach-comp');
        if (!window.confirm('Detach component mapping ' + ck + '?\n\nThis can change diagnosis presentation.')) return;
        mdApi('/admin/media/record/component?id=' + encodeURIComponent(rec.id), {
          method: 'DELETE',
          body: { expectedRevision: a.revision, componentKey: ck, confirmDiagnostic: true },
        }).then(function (res) {
          mdCache = null;
          if (!res.ok) return mdOpen(rec.id, null, mdErrText(res, 'Could not detach.'));
          mdOpen(rec.id, 'Component mapping detached.');
        });
      });
    });
  }

  // ---- publish review ----------------------------------------------------------------------------
  function mdOpenReview(rec) {
    var a = rec.admin || {};
    var draft = a.draft || rec;
    var dlg = $('mdReviewDlg');
    if (!dlg) {
      dlg = document.createElement('dialog');
      dlg.id = 'mdReviewDlg';
      dlg.className = 'st-dlg kn-review-dlg';
      dlg.setAttribute('aria-labelledby', 'mdReviewTitle');
      document.body.appendChild(dlg);
    }
    var next = (a.versions || []).reduce(function (m, v) { return Math.max(m, v.version || 0); }, 0) + 1;
    var row = function (k, v) { return '<dt>' + esc(k) + '</dt><dd>' + esc(v) + '</dd>'; };
    var used = (a.usage && a.usage.knowledge && a.usage.knowledge.length) || (a.usage && a.usage.components && a.usage.components.length);
    var changed = (a.pendingChanges || []).length ? (Md.changeLabels ? Md.changeLabels(a.pendingChanges) : a.pendingChanges).join(', ') : 'No field changes';
    dlg.innerHTML = '<div class="st-dlg__form"><h2 class="admin__h2" id="mdReviewTitle">Review before publishing</h2>'
      + '<dl class="kn-ov kn-ov--compact">'
      + row('Title', draft.title || '') + row('Publishes as', 'v' + next + ' (replaces the live presentation)')
      + row('Changed', changed)
      + row('Customer description', draft.caption || draft.description || '')
      + (draft.type !== 'VIDEO' ? row('Alt text', draft.alt || '') : '')
      + row('Live effect', used ? 'Customers see this in: ' + ((a.usage.knowledge || []).map(function (k) { return k.label || k.knowledgeId; }).concat((a.usage.components || []).map(function (c) { return c.componentKey; })).join(', ')) : 'Not attached to diagnosis yet — no customer sees it until it is attached.')
      + '</dl>'
      + (draft.previewUrl && draft.type !== 'VIDEO' ? '<figure class="md-preview"><img src="' + esc(draft.previewUrl) + '" alt="Draft preview of ' + esc(draft.title || rec.id) + '" /></figure>' : '')
      + '<p class="kn-help">The server checks the draft again. Earlier versions and their files stay in history and can be rolled back to.</p>'
      + '<div class="kn-ed__field"><label for="mdPublishNote">Change note (optional)</label><input id="mdPublishNote" type="text" maxlength="300" autocomplete="off" placeholder="What changed and why" /></div>'
      + '<div class="st-dlg__actions"><button class="btn btn--ghost" type="button" id="mdReviewCancel">Cancel</button>'
      + '<button class="btn btn--primary" type="button" id="mdReviewGo">Publish v' + next + '…</button></div></div>';
    var close = function () { if (dlg.open) dlg.close(); };
    $('mdReviewCancel').addEventListener('click', close);
    $('mdReviewGo').addEventListener('click', function () {
      if (!window.confirm('Publish “' + (draft.title || rec.id) + '” as v' + next + '?\n\n' + (used ? 'Customers will see the new version in live diagnosis.' : 'It is not attached to diagnosis, so customers do not see it yet.') + ' Earlier versions stay in history.')) return;
      var note = ($('mdPublishNote') && $('mdPublishNote').value) || '';
      close();
      var btn = $('mdDetail') && $('mdDetail').querySelector('[data-md-act="publish"]');
      mdBusy(btn, 'Publishing…');
      mdApi('/admin/media/record/publish?id=' + encodeURIComponent(rec.id), { method: 'POST', body: { expectedRevision: a.revision, note: note || null } })
        .then(function (res) {
          mdCache = null;
          if (res.ok) { mdOpen(rec.id, 'Published v' + ((res.body.published && res.body.published.version) || next) + '.'); return; }
          mdOpen(rec.id, null, mdErrText(res, 'Publish failed. The live version is unchanged.'));
        });
    });
    if (typeof dlg.showModal === 'function') dlg.showModal(); else dlg.setAttribute('open', '');
    $('mdReviewCancel').focus();
  }

  // ---- version history ---------------------------------------------------------------------------
  function mdShowHistory(id, v) {
    var panel = $('mdDetail');
    if (panel) { panel.hidden = false; panel.innerHTML = '<p class="tac__muted">Loading version history…</p>'; }
    mdOpenId = id;
    mdApi('/admin/media/record?id=' + encodeURIComponent(id)).then(function (res) {
      if (mdOpenId !== id || res.status === 401) return;
      if (!res.ok) { panel.innerHTML = mdEmpty(mdErrText(res, 'Could not load version history.')); return; }
      var rec = res.body;
      var a = rec.admin || {};
      var cur = a.currentVersion || 0;
      var next = (a.versions || []).reduce(function (m, x) { return Math.max(m, x.version || 0); }, 0) + 1;
      var rows = (a.versions || []).map(function (x) {
        var live = rec.status !== 'retired' && x.version === cur && !(x.version === 0 && a.liveVersionLabel !== 'Shipped baseline');
        var bits = [];
        if (x.publishedAt) bits.push(fmtWhen(x.publishedAt) + (x.publishedBy ? ' by ' + x.publishedBy : ''));
        if (x.note) bits.push('“' + x.note + '”');
        if ((x.changed || []).length) bits.push('Changed: ' + (Md.changeLabels ? Md.changeLabels(x.changed) : x.changed).join(', '));
        var label = x.version === 0 ? 'Shipped baseline' : ('v' + x.version + (x.source === 'rollback' ? ' · rollback to ' + (x.rolledBackFrom === 0 ? 'baseline' : 'v' + x.rolledBackFrom) : (x.source === 'legacy' ? ' · live before version history' : (x.source === 'create' ? ' · created' : ''))));
        var canRb = !live && a.canRollback;
        return '<li class="kn-ver' + (live ? ' is-live' : '') + '"><div class="kn-ver__main"><b>' + esc(label) + '</b>' + (live ? ' <span class="kn-state kn-state--published">Live</span>' : '')
          + (bits.length ? '<p class="tx__sub">' + esc(bits.join(' · ')) + '</p>' : '') + '</div>'
          + '<div class="kn-ver__btns"><a class="btn btn--ghost" href="' + esc(mdDetailHref(id, { view: 'history', v: String(x.version) })) + '">View</a>'
          + (canRb ? '<button class="btn btn--ghost kn-rollbackbtn" type="button" data-md-rollback="' + x.version + '">' + knIco('rollback') + 'Roll back to this</button>' : '')
          + '</div></li>';
      }).join('');
      var note = a.draftPending ? '<p class="tx__sub">Rollback is unavailable while a draft is pending. Publish or discard it first.</p>'
        : (rec.status === 'retired' ? '<p class="tx__sub">Restore this media to roll back.</p>' : '');
      panel.innerHTML = '<div class="kn-detail__head"><div><p class="kn-detail__fam">Version history</p>'
        + '<h2 class="kn-detail__title md-detail__title">' + esc(rec.title || id) + '</h2><p class="kn-detail__id md-detail__id">' + esc(id) + '</p>'
        + '<p class="tx__sub">' + mdStateChip(rec) + ' Live: ' + esc(rec.status === 'retired' ? 'withheld (archived)' : (a.liveVersionLabel || 'live')) + '</p></div></div>'
        + '<p class="kn-notice" id="mdNotice" tabindex="-1" role="status" aria-live="polite" hidden></p>' + note
        + (rows ? '<ol class="kn-vers">' + rows + '</ol>' : mdEmpty('Nothing has been published yet.'))
        + '<p class="tx__sub">Each version points at its own immutable file, so rolling back restores the earlier file too.</p>'
        + '<div id="mdVerDetail"></div>';
      Array.prototype.forEach.call(panel.querySelectorAll('[data-md-rollback]'), function (b) {
        b.addEventListener('click', function () {
          var to = Number(b.getAttribute('data-md-rollback'));
          var from = to === 0 ? 'the shipped baseline' : 'v' + to;
          if (!window.confirm('Roll back “' + (rec.title || id) + '” to ' + from + '?\n\nThis creates v' + next + ' with the content of ' + from + ' and makes it live. All earlier versions stay in history.')) return;
          Array.prototype.forEach.call(panel.querySelectorAll('button'), function (x) { x.disabled = true; });
          b.textContent = 'Rolling back…';
          mdApi('/admin/media/record/rollback?id=' + encodeURIComponent(id), { method: 'POST', body: { expectedRevision: a.revision, toVersion: to } }).then(function (r2) {
            mdCache = null;
            mdShowHistory(id);
            setTimeout(function () { mdNotice(r2.ok ? 'ok' : 'bad', r2.ok ? 'Rolled back. v' + next + ' is live with the content of ' + from + '.' : mdErrText(r2, 'Rollback failed. The live version is unchanged.')); }, 60);
          });
        });
      });
      if (v != null && v !== '') mdShowVersion(id, v);
    });
  }
  function mdShowVersion(id, v) {
    var host = $('mdVerDetail');
    if (!host) return;
    host.innerHTML = '<p class="tac__muted">Loading version…</p>';
    mdApi('/admin/media/record/version?id=' + encodeURIComponent(id) + '&v=' + encodeURIComponent(v)).then(function (res) {
      if (!res.ok) { host.innerHTML = mdEmpty(mdErrText(res, 'Version not found.')); return; }
      var x = res.body.version || {};
      var r = x.record || {};
      host.innerHTML = '<section class="md-sec md-verview"><h3 class="md-sec__h">' + esc(x.version === 0 ? 'Shipped baseline' : 'v' + x.version) + '</h3>'
        + '<dl class="md-ov"><dt>Title</dt><dd>' + esc(r.title || '') + '</dd><dt>Customer description</dt><dd>' + esc(r.caption || r.description || 'No customer description recorded') + '</dd>'
        + '<dt>Alt text</dt><dd>' + esc(r.alt || 'No alt text recorded') + '</dd><dt>File</dt><dd>' + esc(r.previewUrl || 'No path recorded') + '</dd></dl>'
        + (r.previewUrl && r.type !== 'VIDEO' ? '<figure class="md-preview"><img src="' + esc(r.previewUrl) + '" alt="Version preview of ' + esc(r.title || id) + '" /></figure>' : '')
        + '</section>';
    });
  }

  // ---- editor (add media / edit presentation as a draft) ------------------------------------------
  function mdShowEditor(id) {
    var panel = $('mdDetail');
    if (panel) { panel.hidden = false; panel.innerHTML = '<p class="tac__muted">Loading editor…</p>'; }
    mdOpenId = id;
    mdApi('/admin/media/record?id=' + encodeURIComponent(id)).then(function (res) {
      if (mdOpenId !== id || res.status === 401) return;
      if (!res.ok) { panel.innerHTML = mdEmpty(mdErrText(res, 'This media item cannot be edited right now.')); return; }
      if (res.body.status === 'retired') { panel.innerHTML = mdEmpty('Restore this archived media before editing it.'); return; }
      mdRenderEditor(res.body);
    });
  }
  function mdField(id, label, value, opts) {
    opts = opts || {};
    var help = opts.help ? '<span class="kn-help" id="' + id + '-help">' + esc(opts.help) + '</span>' : '';
    var attrs = ' id="' + id + '"' + (help ? ' aria-describedby="' + id + '-help"' : '') + (opts.placeholder ? ' placeholder="' + esc(opts.placeholder) + '"' : '');
    var input = opts.multiline
      ? '<textarea' + attrs + ' rows="' + (opts.rows || 3) + '">' + esc(value || '') + '</textarea>'
      : '<input type="text"' + attrs + ' value="' + esc(value || '') + '" autocomplete="off" />';
    return '<div class="kn-ed__field"' + (opts.wrap ? ' id="' + opts.wrap + '"' : '') + '><label for="' + id + '">' + esc(label) + '</label>' + help + input
      + '<span class="kn-ed__err" data-err-for="' + id + '" hidden></span></div>';
  }
  function mdFormState() {
    var v = function (id) { return $(id) ? $(id).value : ''; };
    var fams = [];
    if ($('mdEditFams')) $('mdEditFams').querySelectorAll('input:checked').forEach(function (c) { fams.push(c.value); });
    var file = $('mdEditFile') && $('mdEditFile').files && $('mdEditFile').files[0];
    var st = { title: v('mdEditTitle'), caption: v('mdEditCaption'), alt: v('mdEditAlt'), families: fams, file: file ? file.name + ':' + file.size : '' };
    if (mdEd && mdEd.isNew) { st.type = v('mdEditType'); st.videoId = v('mdEditVideoId'); st.embedUrl = v('mdEditEmbed'); }
    return st;
  }
  function mdEdStatus() {
    if (!mdEd) return;
    mdEd.dirty = JSON.stringify(mdFormState()) !== mdEd.base;
    var last = mdEd.lastSavedAt ? 'Last saved ' + fmtWhen(mdEd.lastSavedAt) + (mdEd.lastSavedBy ? ' by ' + mdEd.lastSavedBy : '') : '';
    var t = mdEd.saving ? 'Saving…' : (mdEd.dirty ? 'Unsaved changes' + (last ? ' · ' + last : '')
      : (mdEd.justSaved ? 'Saved' + (last ? ' · ' + last : '') : (mdEd.isNew ? 'Not saved yet' : (mdEd.hasDraft ? (last || 'Draft saved') : 'Showing the live version. Saving creates a draft.'))));
    if ($('mdEdDirty')) $('mdEdDirty').textContent = t;
    if ($('mdEdReview')) $('mdEdReview').hidden = !(mdEd.hasDraft && !mdEd.dirty && !mdEd.saving);
  }
  function mdRenderEditor(rec) {
    var panel = $('mdDetail');
    if (!panel) return;
    var isNew = !rec;
    var a = (rec && rec.admin) || {};
    var src = isNew ? { families: [] } : (a.draft || rec);
    var isVideo = !isNew && rec.type === 'VIDEO';
    var keepScroll = window.scrollY;
    var famChecks = '<fieldset class="kn-ed__field md-form__checks" id="mdEditFams"><legend>Appliance family</legend>' + Md.FAMILIES.map(function (f) {
      var on = (src.families || []).indexOf(f) !== -1;
      return '<label><input type="checkbox" value="' + esc(f) + '"' + (on ? ' checked' : '') + '> ' + esc(Md.familyLabel(f)) + '</label>';
    }).join('') + '</fieldset>';
    var typeSec = isNew
      ? '<section class="kn-ed__sec"><h3 class="kn-ed__sech"><span class="kn-ed__secno" aria-hidden="true">1</span>Type</h3>'
        + '<div class="kn-ed__field"><label for="mdEditType">Type</label><select id="mdEditType"><option value="IMAGE">Image</option><option value="DIAGRAM">Diagram</option><option value="VIDEO">Video</option></select></div>'
        + '<p class="kn-help">Creates a stable media id. It is not shown to any customer until you attach it to a diagnostic Knowledge record.</p></section>'
      : '<dl class="kn-ov kn-ov--compact"><dt>Type</dt><dd>' + esc(rec.typeLabel || rec.type) + '</dd><dt>Media id</dt><dd>' + esc(rec.id) + '</dd>'
        + '<dt>Live file</dt><dd>' + esc(rec.previewUrl || (isVideo ? 'YouTube embed' : 'No path recorded')) + '</dd></dl>';
    var fileSec = isVideo ? '' : '<section class="kn-ed__sec" id="mdEditFileSec"><h3 class="kn-ed__sech"><span class="kn-ed__secno" aria-hidden="true">3</span>' + (isNew ? 'File' : 'Replace file') + '</h3>'
      + '<div class="kn-ed__field"><label for="mdEditFile">' + (isNew ? 'Image or diagram' : 'New image or diagram (optional)') + '</label>'
      + '<span class="kn-help" id="mdEditFile-help">PNG, JPEG, WebP, GIF or plain SVG. Up to 4 MB and 8000 px. The file is checked by its content, stored under a new immutable name, and '
      + (isNew ? 'is not shown to customers until attached.' : 'only replaces the live file when this draft is published. The current file is kept in history.') + '</span>'
      + '<input id="mdEditFile" type="file" accept="image/png,image/svg+xml,image/jpeg,image/webp,image/gif" aria-describedby="mdEditFile-help" />'
      + '<span class="kn-ed__err" data-err-for="mdEditFile" hidden></span></div></section>';
    var videoSec = isNew ? '<section class="kn-ed__sec" id="mdEditVideoSec" hidden><h3 class="kn-ed__sech"><span class="kn-ed__secno" aria-hidden="true">3</span>Video</h3>'
      + mdField('mdEditVideoId', 'YouTube video id', '', { help: '11 characters, e.g. from youtube.com/watch?v=…' })
      + mdField('mdEditEmbed', 'Embed URL (optional)', '', { placeholder: 'https://www.youtube-nocookie.com/embed/…', help: 'Privacy-enhanced youtube-nocookie only. Autoplay is not allowed.' })
      + '</section>' : '';
    panel.hidden = false;
    panel.innerHTML = '<form class="kn-ed" id="mdEditForm" novalidate>'
      + '<div class="kn-ed__head"><div><p class="kn-detail__fam">' + esc(isNew ? 'Add media' : (a.draftPending ? 'Editing draft' : 'New draft from the live version')) + '</p>'
      + '<h2 class="kn-detail__title md-detail__title">' + esc(isNew ? 'Add media' : (rec.title || rec.id)) + '</h2>'
      + '<p class="tx__sub">' + esc(isNew ? 'Diagnostic mappings are added afterwards, on purpose.' : 'Customer presentation only. Saving a draft does not change what customers see or any diagnostic mapping. Publish from the media page when it is ready.') + '</p></div></div>'
      + '<p class="kn-notice" id="mdEdNotice" tabindex="-1" role="alert" hidden></p>'
      + typeSec
      + '<section class="kn-ed__sec"><h3 class="kn-ed__sech"><span class="kn-ed__secno" aria-hidden="true">2</span>Customer-facing text</h3>'
      + mdField('mdEditTitle', 'Customer-facing title', src.title, { help: 'Required.' })
      + mdField('mdEditCaption', 'Customer description', src.caption || src.description, { multiline: true, help: 'Shown to customers with the media. Required.' })
      + (isVideo ? '' : mdField('mdEditAlt', 'Alt text', src.alt, { wrap: 'mdEditAltWrap', help: 'Describe what the image shows for people using screen readers. Required for images and diagrams.' }))
      + famChecks + '</section>'
      + fileSec + videoSec
      + '<div class="md-preview-box" id="mdAddPreview" hidden><p class="md-preview-box__h">This is what the ApplianceClinic customer will see</p><div id="mdAddPreviewBody"></div></div>'
      + '<div class="kn-ed__bar"><span class="kn-ed__dirty" id="mdEdDirty" role="status" aria-live="polite"></span>'
      + (isNew ? '<button class="btn btn--ghost" type="button" id="mdAddPreviewBtn">Preview</button>' : '<a class="btn btn--ghost" id="mdEdReview" href="' + esc(mdDetailHref(rec.id, { review: '1' })) + '" hidden>Review &amp; publish…</a>')
      + '<button class="btn btn--ghost" type="button" id="mdEditCancel">Cancel</button>'
      + '<button class="btn btn--primary" type="submit" id="mdEdSave">' + (isNew ? 'Save media' : 'Save draft') + '</button></div></form>';
    var prev = mdEd;
    mdEd = {
      id: isNew ? null : rec.id, isNew: isNew, revision: a.revision || 0, hasDraft: !!a.draftPending,
      lastSavedAt: a.draftPending ? a.draftSavedAt : null, lastSavedBy: a.draftPending ? a.draftSavedBy : null,
      hash: location.hash, justSaved: !!(prev && prev.justSaved && rec && prev.id === rec.id),
    };
    mdEd.base = JSON.stringify(mdFormState());
    var form = $('mdEditForm');
    form.addEventListener('input', mdEdStatus);
    form.addEventListener('change', mdEdStatus);
    form.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && e.target && e.target.tagName === 'INPUT' && e.target.type !== 'checkbox' && e.target.type !== 'file') e.preventDefault();
    });
    form.addEventListener('submit', function (e) { e.preventDefault(); mdEdSave(); });
    if ($('mdEditType')) {
      var toggleType = function () {
        var video = $('mdEditType').value === 'VIDEO';
        if ($('mdEditFileSec')) $('mdEditFileSec').hidden = video;
        if ($('mdEditVideoSec')) $('mdEditVideoSec').hidden = !video;
        if ($('mdEditAltWrap')) $('mdEditAltWrap').hidden = video;
      };
      $('mdEditType').addEventListener('change', toggleType);
      toggleType();
    }
    if ($('mdAddPreviewBtn')) $('mdAddPreviewBtn').addEventListener('click', function () {
      mdEdPayload().then(function (body) {
        return mdApi('/admin/media/preview', { method: 'POST', body: body });
      }).then(function (res) {
        if (!res.ok) { mdEdErrors(res); return mdEdNotice('bad', mdErrText(res, 'Preview failed.')); }
        var box = $('mdAddPreview');
        var p = res.body || {};
        var m = (p.media && p.media[0]) || {};
        box.hidden = false;
        $('mdAddPreviewBody').innerHTML = '<p><strong>' + esc(m.title || '') + '</strong></p>'
          + (m.description || m.caption ? '<p>' + esc(m.description || m.caption) + '</p>' : '')
          + (m.embedUrl ? '<p class="tx__sub">Trusted video embed (no autoplay).</p>' : '')
          + (p.file ? '<p class="tx__sub">Will be stored as /media/' + esc(p.file) + (p.dimensions ? ' · ' + esc(p.dimensions.width + '×' + p.dimensions.height) : '') + '</p>' : '')
          + '<p class="tx__sub">' + esc(p.note || '') + '</p>';
      });
    });
    $('mdEditCancel').addEventListener('click', function () {
      var wasNew = mdEd.isNew;
      var mid = mdEd.id;
      guardThen(function () { mdEd = null; location.hash = wasNew ? mdListHref() : mdDetailHref(mid); });
    });
    mdEdStatus();
    if (prev && prev.justSaved) { window.scrollTo(0, keepScroll); setTimeout(function () { if (mdEd) { mdEd.justSaved = false; mdEdStatus(); } }, 4000); }
    else window.scrollTo(0, 0);
  }
  function mdEdPayload() {
    var st = mdFormState();
    var body = { title: st.title, caption: st.caption, description: st.caption, families: st.families };
    if ($('mdEditAlt') && !($('mdEditAltWrap') && $('mdEditAltWrap').hidden)) body.alt = st.alt;
    if (mdEd && mdEd.isNew) { body.type = st.type; body.videoId = st.videoId; body.embedUrl = st.embedUrl; }
    var file = $('mdEditFile') && $('mdEditFile').files && $('mdEditFile').files[0];
    if (!file || (mdEd && mdEd.isNew && st.type === 'VIDEO')) return Promise.resolve(body);
    body.fileName = file.name;
    return mdReadFile(file).then(function (data) { body.dataBase64 = data; return body; });
  }
  function mdEdNotice(kind, msg) {
    var el = $('mdEdNotice');
    if (!el) return;
    el.hidden = !msg;
    el.className = 'kn-notice' + (kind ? ' kn-notice--' + kind : '');
    el.textContent = msg || '';
    if (msg) el.focus();
  }
  function mdEdErrors(res) {
    var form = $('mdEditForm');
    if (!form) return;
    Array.prototype.forEach.call(form.querySelectorAll('[data-err-for]'), function (el) { el.hidden = true; el.textContent = ''; });
    Array.prototype.forEach.call(form.querySelectorAll('[aria-invalid]'), function (el) { el.removeAttribute('aria-invalid'); });
    var target = (Md.errorField || function () { return null; })((res && res.body) || {});
    if (!target || !$(target)) return;
    var slot = form.querySelector('[data-err-for="' + target + '"]');
    if (slot) { slot.hidden = false; slot.textContent = (res.body && res.body.error) || 'Check this field.'; }
    $(target).setAttribute('aria-invalid', 'true');
  }
  function mdEdSave() {
    if (!mdEd || mdEd.saving) return;
    var ed = mdEd;
    ed.saving = true;
    mdEdStatus();
    var btn = $('mdEdSave');
    if (btn) btn.disabled = true;
    mdEdPayload().then(function (body) {
      return ed.isNew
        ? mdApi('/admin/media', { method: 'POST', body: body })
        : mdApi('/admin/media/record?id=' + encodeURIComponent(ed.id), { method: 'PATCH', body: Object.assign({ expectedRevision: ed.revision }, body) });
    }).then(function (res) {
      ed.saving = false;
      if (btn) btn.disabled = false;
      if (mdEd !== ed) return;
      if (res.ok && res.body.id) {
        mdCache = null;
        if (ed.isNew) { mdEd = null; location.replace(mdDetailHref(res.body.id)); return; }
        ed.justSaved = true;
        mdRenderEditor(res.body);
        return;
      }
      mdEdStatus();
      if (res.status === 401) return;
      mdEdErrors(res);
      mdEdNotice('bad', 'Not saved. ' + mdErrText(res, 'The media could not be saved.'));
    }).catch(function () {
      ed.saving = false;
      if (btn) btn.disabled = false;
      mdEdStatus();
      mdEdNotice('bad', 'Could not reach the server. Your changes are still in this form.');
    });
  }

  function loadDiagnostics() {
    var Dg = window.DgLogic || {};
    var comps = $('dgComponents');
    var status = $('dgStatus');
    if (!comps) return;
    if (status) status.textContent = 'Checking deployed components…';
    comps.setAttribute('aria-busy', 'true');
    fetch(API_BASE + '/admin/diagnostics', { credentials: 'same-origin' })
      .then(function (r) { return r.status === 401 ? null : r.json(); })
      .then(function (d) {
        if (!d) {
          if (status) status.textContent = 'Sign in required.';
          comps.removeAttribute('aria-busy');
          return;
        }
        dgRender(d, Dg);
      })
      .catch(function () {
        if (status) status.textContent = 'Could not load diagnostics.';
        comps.innerHTML = '<div class="kn__empty">Could not load diagnostics.</div>';
        comps.removeAttribute('aria-busy');
      });
  }

  var dgWired = false;
  function dgEnsureWired() {
    if (dgWired) return;
    dgWired = true;
    var btn = $('dgRefresh');
    if (btn) btn.addEventListener('click', function () { loadDiagnostics(); });
  }

  function dgPill(c, Dg) {
    var health = (c && c.health) || 'unknown';
    var label = (Dg.healthLabel && Dg.healthLabel(health)) || (c && c.healthLabel) || 'Unknown';
    var lat = Dg.latencyText && c ? Dg.latencyText(c.latencyMs) : null;
    var cls = (Dg.healthClass && Dg.healthClass(health)) || 'dg-pill dg-pill--unknown';
    return '<span class="' + cls + '">' + esc(label) + (lat ? ' · ' + esc(lat) : '') + '</span>';
  }

  function dgFactList(facts) {
    if (!facts || !facts.length) return '';
    return '<dl class="dg-facts">' + facts.map(function (f) {
      return '<div class="dg-facts__row"><dt>' + esc(f.label) + '</dt><dd class="dg-wrap">' + esc(f.value == null || f.value === '' ? 'Version not exposed by runtime' : f.value) + '</dd></div>';
    }).join('') + '</dl>';
  }

  function dgLinks(links) {
    if (!links || !links.length) return '';
    return '<p class="dg-links">' + links.map(function (l) {
      return '<a href="' + esc(l.href) + '">' + esc(l.label) + '</a>';
    }).join(' · ') + '</p>';
  }

  function dgCard(c, Dg) {
    if (!c) return '';
    var html = '<article class="admin__panel dg-card" data-health="' + esc(c.health || 'unknown') + '">';
    html += '<div class="dg-card__head">';
    html += '<div><h3 class="dg-card__title">' + esc(c.name) + '</h3>';
    html += '<p class="dg-card__role">' + esc(c.role || '') + '</p></div>';
    html += dgPill(c, Dg);
    html += '</div>';
    html += '<p class="dg-card__reason">' + esc(c.healthReason || 'No reliable health probe available') + '</p>';
    html += dgFactList(c.facts);
    html += dgLinks(c.links);
    if (c.probedAt) {
      html += '<p class="dg-card__when">Last checked ' + esc((Dg.formatWhen && Dg.formatWhen(c.probedAt)) || c.probedAt) + '</p>';
    } else if (c.health === 'unknown') {
      html += '<p class="dg-card__when">Last probe unavailable</p>';
    }
    if (c.technical) {
      html += '<details class="dg-card__more"><summary>View details</summary><pre class="dg-pre">' + esc(JSON.stringify(c.technical, null, 2)) + '</pre></details>';
    }
    html += '</article>';
    return html;
  }

  function dgKv(label, value) {
    return '<div class="dg-facts__row"><dt>' + esc(label) + '</dt><dd class="dg-wrap">' + esc(value == null || value === '' ? 'Version not exposed by runtime' : value) + '</dd></div>';
  }

  function dgRender(d, Dg) {
    dgEnsureWired();
    var comps = $('dgComponents');
    var status = $('dgStatus');
    var runtimeEl = $('dgRuntime');
    var techEl = $('dgTechnical');
    if (!comps) return;
    var list = (d && d.components) || [];
    comps.innerHTML = list.map(function (c) { return dgCard(c, Dg); }).join('') || '<div class="kn__empty">No deployed components were reported.</div>';
    comps.removeAttribute('aria-busy');

    var n = list.length;
    var generated = d && d.generatedAt ? ((Dg.formatWhen && Dg.formatWhen(d.generatedAt)) || d.generatedAt) : 'just now';
    if (status) {
      status.textContent = n
        ? ('Checked ' + n + ' deployed components at ' + generated + '.')
        : ('Diagnostics loaded at ' + generated + '.');
      if (d && d.collectorError) status.textContent = d.collectorError;
    }

    if (runtimeEl) {
      var rt = (d && d.runtime) || {};
      var models = rt.models || {};
      var html = '<dl class="dg-facts">';
      html += dgKv('Conversation window', rt.conversationWindowTurns != null ? rt.conversationWindowTurns + ' turns' : null);
      html += dgKv('Media overlay cache TTL', rt.mediaOverlayCacheTtlMs != null ? Math.round(rt.mediaOverlayCacheTtlMs / 1000) + ' seconds' : null);
      html += dgKv('Supported appliance families', (rt.supportedFamilies && rt.supportedFamilies.length) ? rt.supportedFamilies.join(', ') : null);
      if (models.advisor) {
        html += dgKv('Advisor model', (models.advisor.providerLabel || models.advisor.provider || '') + ' · ' + (models.advisor.modelLabel || models.advisor.model || 'Model not set')
          + (models.advisor.credentialConfigured ? '' : ' · credential missing'));
      }
      if (rt.diagnosis) {
        // Read-only: ac2 is the only diagnosis architecture (ADR 0020); there is nothing to configure.
        html += dgKv('Diagnosis architecture', rt.diagnosis.label || rt.diagnosis.architecture);
      }
      html += '</dl>';
      if (rt.note) html += '<p class="dg-path__note">' + esc(rt.note) + '</p>';
      runtimeEl.innerHTML = html;
    }

    if (techEl) {
      var t = (d && d.technical) || {};
      var ev = (d && d.evidence) || {};
      var htmlT = '<dl class="dg-facts">';
      var ids = t.identifiers || {};
      Object.keys(ids).forEach(function (k) {
        htmlT += dgKv(k, ids[k]);
      });
      htmlT += '</dl>';
      if (t.notExposed && t.notExposed.length) {
        htmlT += '<p class="dg-path__note">Not exposed by this runtime: ' + esc(t.notExposed.join(', ')) + '.</p>';
      }
      if (ev.lastSuccessfulProbes && ev.lastSuccessfulProbes.length) {
        htmlT += '<h3 class="dg-subh">Last successful probes</h3><ul class="dg-ev">';
        ev.lastSuccessfulProbes.forEach(function (p) {
          htmlT += '<li class="dg-wrap">' + esc(p.name) + ' — ' + esc((Dg.formatWhen && Dg.formatWhen(p.at)) || p.at || 'Last probe unavailable');
          if (p.latencyMs != null) htmlT += ' · ' + esc(String(p.latencyMs) + ' ms');
          htmlT += '</li>';
        });
        htmlT += '</ul>';
      }
      if (ev.lastFailedProbes && ev.lastFailedProbes.length) {
        htmlT += '<h3 class="dg-subh">Last failed probes</h3><ul class="dg-ev">';
        ev.lastFailedProbes.forEach(function (p) {
          htmlT += '<li class="dg-wrap">' + esc(p.name) + ' — ' + esc(p.reason || 'Probe failed') + ' · ' + esc((Dg.formatWhen && Dg.formatWhen(p.at)) || p.at || 'Last probe unavailable') + '</li>';
        });
        htmlT += '</ul>';
      }
      techEl.innerHTML = htmlT;
    }
  }
  // ==== Error Codes: list (browse only) → dedicated detail page → draft editor / history =========
  // Routes: #error-codes?q&family&brand&status&source        list
  //         #error-codes/<mappingId>?<list params>           detail          (&review=1 opens publish review)
  //         #error-codes/<mappingId>?view=edit | view=history[&v=N]
  //         #error-codes/new                                 create a draft
  // Live boundary (enforced by the Error Code MCP): Save draft never changes live lookup; Publish,
  // Rollback, Archive and Restore do. Every mutation sends the record revision it was edited from.
  var ecCache = null;
  var ecOpenId = null;
  var ecWired = false;
  var ecEd = null;            // editor state { id, isNew, base, dirty, hash, saving, revision, ... }
  var ecPendingReview = null;
  var ecListScrollY = null;
  var ecCameFromList = false;
  var EC_TEXT = {
    leave: 'You have unsaved Error Code changes. If you leave now they will be lost. Your saved draft and the live error code are not affected.',
  };
  function ecLogic() { return window.EcLogic || {}; }
  function ecListParams() {
    return {
      q: $('ecSearch') ? $('ecSearch').value : '',
      family: $('ecFamily') ? $('ecFamily').value : '',
      brand: $('ecBrand') ? $('ecBrand').value : '',
      status: $('ecStatus') ? $('ecStatus').value : '',
      source: $('ecSource') ? $('ecSource').value : '',
    };
  }
  function ecListHref(params) { return hashString('error-codes', params || ecListParams()); }
  function ecDetailHref(id, extra) {
    var list = ecListHref();
    var qi = list.indexOf('?');
    var qs = qi === -1 ? '' : list.slice(qi + 1);
    var more = [];
    Object.keys(extra || {}).forEach(function (k) {
      if (extra[k] != null && extra[k] !== '') more.push(encodeURIComponent(k) + '=' + encodeURIComponent(extra[k]));
    });
    var all = [qs].concat(more).filter(Boolean).join('&');
    return '#error-codes/' + encodeURIComponent(id) + (all ? '?' + all : '');
  }
  function ecApi(path, opts) {
    opts = opts || {};
    return fetch(API_BASE + path, {
      method: opts.method || 'GET',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    }).then(function (r) {
      if (r.status === 401) { showGate('Your session has expired. Please log in again.'); }
      return r.json().catch(function () { return {}; }).then(function (b) { return { ok: r.ok, status: r.status, body: b || {} }; });
    });
  }
  function ecErrText(res, fallback) {
    var b = (res && res.body) || {};
    if (res && res.status === 409 && b.error === 'conflict') return 'Someone else changed this error code. Reload to see the latest version, then try again.';
    var msg = b.message || b.error || fallback || 'That did not work.';
    if (b.conflicts && b.conflicts[0]) msg += ' Conflicts with ' + (b.conflicts[0].code || b.conflicts[0].mappingId) + '.';
    if (b.fields && b.fields.length) msg += ' Check: ' + b.fields.join(', ') + '.';
    return msg;
  }
  function ecIco(name) { return knIco(name); }
  function ecStateChip(rec, admin) {
    var Ec = ecLogic();
    var st = (admin && admin.status) || rec.status;
    var c = Ec.stateChip ? Ec.stateChip(st, admin ? admin.draftPending : rec.draftPending) : { label: st, cls: 'kn-state' };
    return '<span class="' + esc(c.cls) + '">' + esc(c.label) + '</span>';
  }

  // ---- list ------------------------------------------------------------------------------
  function loadErrorCodes() {
    var list = $('ecList');
    if (!list) return;
    ecWire();
    if ($('ecDetailPage')) $('ecDetailPage').hidden = true;
    if ($('ecListView')) $('ecListView').hidden = false;
    ecOpenId = null;
    var route = parseHash();
    if (/^(mcp|error-?codes)$/.test(route.section) && !route.sub) ecApplyParams(route.params);
    if (ecCache) {
      ecFillFilters();
      ecRenderList();
      ecRestoreScroll();
      return;
    }
    list.innerHTML = '<div class="tac__muted">Loading error-code catalogue…</div>';
    fetch(API_BASE + '/admin/error-codes', { credentials: 'same-origin' })
      .then(function (r) { return r.status === 401 ? null : r.json(); })
      .then(function (d) {
        if (!d) return;
        ecCache = d;
        ecFillFilters();
        if (!parseHash().sub) ecApplyParams(parseHash().params);
        ecRenderList();
        ecRestoreScroll();
      })
      .catch(function () {
        list.innerHTML = '<div class="kn__empty">Could not load the error-code catalogue.</div>';
      });
  }
  function ecRestoreScroll() {
    if (ecListScrollY == null) return;
    var y = ecListScrollY; ecListScrollY = null;
    setTimeout(function () { window.scrollTo(0, y); }, 0);
  }
  function ecApplyParams(params) {
    params = params || {};
    if ($('ecSearch') && params.q != null) $('ecSearch').value = params.q;
    if ($('ecFamily') && params.family != null) $('ecFamily').value = params.family;
    if ($('ecBrand') && params.brand != null) $('ecBrand').value = params.brand;
    if ($('ecStatus') && params.status != null) $('ecStatus').value = params.status;
    if ($('ecSource') && params.source != null) $('ecSource').value = params.source;
  }
  function ecWriteRoute() { writeHash('error-codes', ecListParams()); }
  function ecOnFilter() {
    ecWriteRoute();
    ecRenderList();
  }
  function ecWire() {
    if (ecWired) return;
    ecWired = true;
    ['ecSearch', 'ecFamily', 'ecBrand', 'ecStatus', 'ecSource'].forEach(function (id) {
      if ($(id)) $(id).addEventListener('input', ecOnFilter);
      if ($(id)) $(id).addEventListener('change', ecOnFilter);
    });
    if ($('ecClear')) $('ecClear').addEventListener('click', function () {
      ['ecSearch', 'ecFamily', 'ecBrand', 'ecStatus', 'ecSource'].forEach(function (id) { if ($(id)) $(id).value = ''; });
      ecOnFilter();
    });
    if ($('ecBackLink')) $('ecBackLink').addEventListener('click', function (e) {
      guardedBack(e, $('ecBackLink'), function () { return ecCameFromList; }, function () { ecEd = null; });
    });
  }
  function ecFillFilters() {
    var Ec = ecLogic();
    var d = ecCache || {};
    function fill(sel, values, labels) {
      if (!sel) return;
      var cur = sel.value;
      var keep = sel.querySelector('option[value=""]');
      sel.innerHTML = '';
      sel.appendChild(keep || new Option(sel.id === 'ecFamily' ? 'All appliances' : (sel.id === 'ecBrand' ? 'All brands' : 'All sources'), ''));
      (values || []).forEach(function (v) { sel.appendChild(new Option((labels && labels(v)) || v, v)); });
      if (cur) sel.value = cur;
    }
    fill($('ecFamily'), d.appliances, Ec.familyLabel);
    fill($('ecBrand'), d.brands, Ec.brandLabel);
    var srcSel = $('ecSource');
    if (srcSel) {
      var cur = srcSel.value;
      srcSel.innerHTML = '<option value="">All sources</option><option value="not-recorded">Not recorded</option>';
      (d.sourceTypes || []).forEach(function (t) { srcSel.appendChild(new Option(String(t).replace(/_/g, ' '), t)); });
      if (cur) srcSel.value = cur;
    }
  }
  function ecFiltered() {
    var Ec = ecLogic();
    return (Ec.filterRecords || function (r) { return r; })((ecCache && ecCache.records) || [], ecListParams());
  }
  function ecHasFilters() {
    var p = ecListParams();
    return Boolean(p.q || p.family || p.brand || p.status || p.source);
  }
  function ecRenderList() {
    var Ec = ecLogic();
    var list = $('ecList');
    var counts = $('ecCounts');
    var status = $('ecStatusLine');
    var clear = $('ecClear');
    if (!list || !ecCache) return;
    if (clear) clear.hidden = !ecHasFilters();
    var d = ecCache;
    var src = d.sourceCodeRecordCount != null ? d.sourceCodeRecordCount : d.mappingCount;
    var uniq = d.uniqueLookupCount != null ? d.uniqueLookupCount : ((d.records || []).length);
    var active = d.effectiveActiveCount;
    var tokens = d.uniqueDisplayTokens;
    if (counts) {
      counts.textContent = (src != null ? src + ' shipped source-code records' : '')
        + (uniq != null ? ' · ' + uniq + ' unique mapping keys used for lookup' : '')
        + (active != null ? ' · ' + active + ' active lookup keys' : '')
        + (tokens != null ? ' · ' + tokens + ' distinct displayed codes' : '')
        + (d.overlay && d.overlay.present ? ' · admin overlay ' + (d.overlay.records || 0) + ' records' + (d.overlay.drafts ? ' (' + d.overlay.drafts + ' with drafts)' : '') : ' · no admin overlay')
        + (d.datasetV1Hash ? ' · Dataset V1 hash ' + d.datasetV1Hash : '');
    }
    var rows = ecFiltered();
    if (status) status.textContent = rows.length + ' mapping' + (rows.length === 1 ? '' : 's') + ' shown.';
    if (!rows.length) {
      list.innerHTML = '<div class="kn__empty">No error-code mappings match these filters.</div>';
      return;
    }
    var groups = Ec.groupByFamilyBrand ? Ec.groupByFamilyBrand(rows) : [{ family: '', label: 'Error codes', brands: [{ brand: '', label: '', records: rows }], count: rows.length }];
    list.innerHTML = groups.map(function (g) {
      return '<section class="ec-family"><h2 class="ec-family__h">' + esc(g.label) + ' <span class="ec-family__count">' + esc(String(g.count)) + '</span></h2>'
        + g.brands.map(function (b) {
          return '<div class="ec-brand"><h3 class="ec-brand__h">' + esc(b.label) + '</h3><div class="ec-brand__cards">'
            + b.records.map(ecCardHtml).join('') + '</div></div>';
        }).join('') + '</section>';
    }).join('');
  }
  function ecCardHtml(r) {
    var meaning = r.meaning || 'No stored meaning';
    if (meaning.length > 140) meaning = meaning.slice(0, 137) + '…';
    var appNote = r.applicabilityNote ? ' · ' + r.applicabilityNote : '';
    var flags = ecStateChip(r, null)
      + (r.origin === 'admin' ? '<span class="ec-flag ec-flag--admin">Admin-created</span>' : '')
      + (r.currentVersion ? '<span class="ec-flag">v' + esc(String(r.currentVersion)) + '</span>' : '');
    return '<a class="ec-card" data-ec-id="' + esc(r.mappingId) + '" href="' + esc(ecDetailHref(r.mappingId)) + '">'
      + '<span class="ec-card__main"><span class="ec-card__code">' + esc(r.code || '—') + '</span>'
      + '<span class="ec-card__meaning">' + esc(meaning) + '</span>'
      + '<span class="ec-card__meta">' + esc((r.shown || []).filter(function (s) { return s !== r.code; }).join(', ')) + esc(appNote) + '</span>'
      + '<span class="ec-card__flags">' + flags + '</span></span><span class="ec-card__go" aria-hidden="true">›</span></a>';
  }

  // ---- detail page ---------------------------------------------------------------------------
  function ecShowDetail(id, params) {
    params = params || {};
    var listView = $('ecListView');
    var listVisible = Boolean(listView && !listView.hidden && $('ecList') && $('ecList').querySelector('.ec-card'));
    if (listVisible) ecListScrollY = window.scrollY || 0;
    ecCameFromList = listVisible;
    ecWire();
    ecApplyParams(params);
    if (listView) listView.hidden = true;
    if ($('ecDetailPage')) $('ecDetailPage').hidden = false;
    var view = params.view || '';
    var sub = id !== 'new' && (view === 'edit' || view === 'history');
    var back = $('ecBackLink');
    var listParams = { q: params.q || '', family: params.family || '', brand: params.brand || '', status: params.status || '', source: params.source || '' };
    if (back) {
      back.setAttribute('href', sub ? ecDetailHref(id) : ecListHref(listParams));
      back.textContent = sub ? '← Back to error code' : '← Back to Error Codes';
      back.setAttribute('data-sub', sub ? '1' : '');
    }
    window.scrollTo(0, 0);
    if (ecEd && !((view === 'edit' && ecEd.id === id) || (id === 'new' && ecEd.isNew))) ecEd = null;
    if (id === 'new') { ecShowEditor(null); return; }
    if (view === 'edit') { ecShowEditor(id); return; }
    if (view === 'history') { ecShowHistory(id, params.v); return; }
    ecPendingReview = params.review ? id : null;
    ecOpen(id);
  }
  function ecOpen(id, okMsg, badMsg) {
    if (!id) return;
    ecOpenId = id;
    var panel = $('ecDetail');
    if (panel) { panel.hidden = false; panel.innerHTML = '<p class="tac__muted">Loading error code…</p>'; }
    ecApi('/admin/error-codes/record?id=' + encodeURIComponent(id)).then(function (res) {
      if (ecOpenId !== id || res.status === 401) return;
      if (!res.ok || !res.body.record) { if (panel) panel.innerHTML = '<p class="kn__empty">' + esc(res.status === 404 ? 'Error-code record not found.' : ecErrText(res, 'Could not load this error code.')) + '</p>'; return; }
      ecRenderDetail(res.body);
      if (ecPendingReview === id) { ecPendingReview = null; if (res.body.admin && res.body.admin.canPublish) ecOpenReview(res.body); }
      if (okMsg) ecNotice('ok', okMsg);
      if (badMsg) ecNotice('bad', badMsg);
    }).catch(function () { if (panel) panel.innerHTML = '<p class="kn__empty">Could not load this error code.</p>'; });
  }
  function ecNotice(kind, msg) {
    var el = $('ecNotice');
    if (!el) return;
    el.hidden = !msg;
    el.className = 'kn-notice' + (kind ? ' kn-notice--' + kind : '');
    el.textContent = msg || '';
    if (msg) el.focus();
  }
  function ecEmpty(text) { return '<p class="kn-sec__empty">' + esc(text) + '</p>'; }
  function ecList(arr, none) {
    if (!arr || !arr.length) return ecEmpty(none);
    return '<ul class="kn-dlist">' + arr.map(function (x) { return '<li>' + esc(x) + '</li>'; }).join('') + '</ul>';
  }
  function ecContentHtml(rec) {
    var Ec = ecLogic();
    var fam = (rec.appliances || []).map(Ec.familyLabel).join(', ') || 'No appliance recorded';
    var brands = (rec.brands || []).map(Ec.brandLabel).join(', ') || 'No brand recorded';
    var aliases = (rec.shown || []).filter(function (s) { return s && s !== rec.code; });
    var prov = rec.provenance || {};
    var provUrl = Ec.safeUrl ? Ec.safeUrl(prov.url) : null;
    var hints = rec.diagnosticHints || {};
    var safety = rec.safety;
    var srcHtml = (rec.sources || []).length
      ? '<ul class="ec-chips">' + rec.sources.map(function (s) {
        var url = Ec.safeUrl ? Ec.safeUrl(s.url) : null;
        return '<li>' + esc(s.sourceTypeLabel || s.sourceType || s.sourceId)
          + (s.publisher ? ' · ' + esc(s.publisher) : '') + (s.reference ? ' · ' + esc(s.reference) : '')
          + (url ? ' · <a class="ec-link" href="' + esc(url) + '" rel="noopener noreferrer" target="_blank">Source</a>' : '') + '</li>';
      }).join('') + '</ul>'
      : ecEmpty('No source records attached to this mapping.');
    var safetyHtml = safety && safety.class
      ? '<div class="kn-safety"><p class="kn-safety__class">Safety: ' + esc(String(safety.class).replace(/_/g, ' ')) + (safety.stopUse ? ' · stop use' : '') + '</p>'
        + (safety.reason ? '<p>' + esc(safety.reason) + '</p>' : '') + '</div>'
      : ecEmpty('No stored safety fields on this mapping. Safety is not inferred from the code or title.');
    return '<section class="kn-sec"><h3 class="kn-sec__h">Overview</h3><dl class="kn-ov">'
      + '<dt>Appliance</dt><dd>' + esc(fam) + '</dd>'
      + '<dt>Make / brand</dt><dd>' + esc(brands) + '</dd>'
      + '<dt>Code</dt><dd>' + esc(rec.code || '—') + '</dd>'
      + '<dt>Aliases</dt><dd>' + esc(aliases.length ? aliases.join(', ') : 'No aliases stored') + '</dd>'
      + '<dt>Record type</dt><dd>' + esc(rec.recordType || 'Not recorded') + '</dd>'
      + '<dt>Applicability</dt><dd>' + esc(rec.applicabilityNote || 'No model/range note stored') + '</dd>'
      + '<dt>System</dt><dd>' + esc(rec.system || 'Not recorded') + '</dd>'
      + '</dl></section>'
      + '<section class="kn-sec"><h3 class="kn-sec__h">What it means</h3><p>' + esc(rec.meaning || 'No stored meaning') + '</p></section>'
      + '<section class="kn-sec"><h3 class="kn-sec__h">Diagnostic information</h3>'
      + '<p class="kn-help">Stored enrichment only. Nothing is inferred from the code shape.</p>'
      + '<h4 class="kn-sec__h">Components</h4>' + ecList(hints.components, 'No stored components')
      + '<h4 class="kn-sec__h">Likely causes</h4>' + ecList(hints.likelyCauses, 'No stored likely causes')
      + '<h4 class="kn-sec__h">Recommended checks</h4>' + ecList(hints.checks, 'No stored checks')
      + '</section>'
      + '<section class="kn-sec"><h3 class="kn-sec__h">Safety guidance</h3>' + safetyHtml + '</section>'
      + '<section class="kn-sec"><h3 class="kn-sec__h">Source / provenance</h3><dl class="kn-ov">'
      + '<dt>Source types</dt><dd>' + esc((rec.sourceTypeLabels || []).join(' · ') || 'Not recorded') + '</dd>'
      + '<dt>Canonical code</dt><dd>' + esc(prov.canonicalCode || 'Not recorded') + '</dd>'
      + '<dt>Source file</dt><dd>' + esc(prov.sourceFile || 'Not recorded') + '</dd>'
      + '<dt>Publisher</dt><dd>' + esc(prov.publisher || 'Not recorded') + '</dd>'
      + '<dt>Reference</dt><dd>' + esc(prov.reference || 'Not recorded') + '</dd>'
      + '<dt>URL</dt><dd>' + (provUrl ? '<a class="ec-link" href="' + esc(provUrl) + '" rel="noopener noreferrer" target="_blank">' + esc(provUrl) + '</a>' : 'No stored URL') + '</dd>'
      + '<dt>Confidence</dt><dd>' + esc(rec.confidence || 'Not recorded') + '</dd>'
      + '</dl>' + srcHtml + '</section>';
  }
  function ecTechHtml(rec) {
    return '<details class="kn-tech"><summary>Technical details</summary><dl class="kn-ov">'
      + '<dt>Mapping id</dt><dd>' + esc(rec.mappingId) + '</dd>'
      + '<dt>Scheme</dt><dd>' + esc(rec.schemeId || '—') + '</dd>'
      + '<dt>Variant</dt><dd>' + esc(rec.variantId || '—') + '</dd>'
      + '<dt>Normalised token</dt><dd>' + esc(rec.code || '—') + '</dd>'
      + '<dt>Notation</dt><dd>' + esc(rec.notation || '—') + '</dd>'
      + '<dt>Fault id</dt><dd>' + esc(rec.faultId || '—') + '</dd>'
      + '<dt>Dataset V1 hash</dt><dd>' + esc((ecCache && ecCache.datasetV1Hash) || 'not reported') + '</dd>'
      + '<dt>Enrichment V1 hash</dt><dd>' + esc((ecCache && ecCache.enrichmentV1Hash) || 'not reported') + '</dd>'
      + '</dl><h3 class="kn-sec__h">Raw structured record</h3><pre>' + esc(JSON.stringify(rec.raw || rec, null, 2)) + '</pre></details>';
  }
  function ecActionsHtml(d) {
    var a = d.admin || {};
    var id = d.record.mappingId;
    var b = [];
    var Ec = ecLogic();
    if (a.status !== 'retired') {
      b.push('<a class="btn btn--primary" href="' + esc(ecDetailHref(id, { view: 'edit' })) + '">' + ecIco('edit') + (a.draftPending ? 'Edit draft' : 'Edit') + '</a>');
    }
    if (a.canPublish) b.push('<button class="btn btn--primary" type="button" data-ec-act="publish">' + ecIco('publish') + 'Review &amp; publish…</button>');
    b.push('<a class="btn btn--ghost" href="' + esc(ecDetailHref(id, { view: 'history' })) + '">' + ecIco('history') + 'View version history</a>');
    if (a.status !== 'draft') b.push('<button class="btn btn--ghost" type="button" data-ec-act="preview">Preview live result</button>');
    if (a.canRestore) b.push('<button class="btn btn--ghost" type="button" data-ec-act="restore">' + ecIco('rollback') + 'Restore</button>');
    var risky = [];
    if (a.canDiscard) risky.push('<button class="btn btn--ghost" type="button" data-ec-act="discard">Discard draft</button>');
    if (a.canDelete) risky.push('<button class="btn btn--ghost kn-danger" type="button" data-ec-act="delete">Delete draft</button>');
    if (a.canArchive) risky.push('<button class="btn btn--ghost kn-danger" type="button" data-ec-act="archive">' + ecIco('archive') + 'Archive</button>');
    if (risky.length) b.push('<span class="kn-actions__risky">' + risky.join('') + '</span>');
    var meta = [];
    meta.push('Live: ' + (a.status === 'draft' ? 'not published' : (a.status === 'retired' ? 'not returned (archived)' : (a.liveVersionLabel || 'active'))));
    if (a.draftPending) meta.push('Draft saved ' + fmtWhen(a.draftSavedAt) + (a.draftSavedBy ? ' by ' + a.draftSavedBy : ''));
    if (a.status === 'retired' && a.retiredAt) meta.push('Archived ' + fmtWhen(a.retiredAt) + (a.retiredBy ? ' by ' + a.retiredBy : ''));
    meta.push(Ec.originLabel ? Ec.originLabel(a.origin) : a.origin);
    var pending = (a.pendingChanges || []).length && a.status !== 'draft'
      ? '<p class="kn-actions__pending">Draft changes not yet live: ' + esc((Ec.changeLabels ? Ec.changeLabels(a.pendingChanges) : a.pendingChanges).join(', ')) + '</p>' : '';
    return '<div class="kn-actions"><div class="kn-actions__state">' + ecStateChip(d.record, a) + '<span class="tx__sub">' + esc(meta.join(' · ')) + '</span></div>'
      + pending + '<div class="kn-actions__btns">' + b.join('') + '</div>'
      + '<p class="kn-notice" id="ecNotice" tabindex="-1" role="status" aria-live="polite" hidden></p></div>';
  }
  function ecRenderDetail(d) {
    var panel = $('ecDetail');
    if (!panel) return;
    if (!d) { panel.hidden = true; panel.innerHTML = ''; return; }
    var Ec = ecLogic();
    var rec = d.record;
    var a = d.admin || {};
    var fam = (rec.appliances || []).map(Ec.familyLabel).join(', ') || 'No appliance recorded';
    var brands = (rec.brands || []).map(Ec.brandLabel).join(', ') || 'No brand recorded';
    var banner = a.status === 'draft'
      ? '<p class="kn-banner">Draft — never published. The live Error Code engine does not return it.</p>'
      : (a.status === 'retired' ? '<p class="kn-banner">Archived — not returned by the live Error Code engine' + (a.retiredReason ? ' (' + esc(a.retiredReason) + ')' : '') + '. History is kept.</p>'
        : (a.draftPending ? '<p class="kn-banner kn-banner--info">Showing the live version. A draft with unpublished changes exists.</p>' : ''));
    panel.hidden = false;
    panel.innerHTML = '<div class="kn-detail__head"><div>'
      + '<p class="kn-detail__fam">' + esc(fam) + ' · ' + esc(brands) + '</p>'
      + '<h2 class="kn-detail__title">' + esc(rec.code || '—') + '</h2>'
      + '<p class="kn-detail__id">' + esc(rec.mappingId) + '</p></div></div>'
      + ecActionsHtml(d) + banner
      + ecContentHtml(rec)
      + '<section class="kn-sec"><h3 class="kn-sec__h">Live engine output</h3><div id="ecPreviewBox">'
      + ecEmpty(a.status === 'draft' ? 'A draft is not resolvable until it is published.' : 'Preview runs the live Error Code MCP resolve for this make + appliance + code. It does not start a customer conversation.') + '</div></section>'
      + ecTechHtml(rec);
    Array.prototype.forEach.call(panel.querySelectorAll('[data-ec-act]'), function (btn) {
      btn.addEventListener('click', function () { ecDoAction(btn.getAttribute('data-ec-act'), d, btn); });
    });
  }
  function ecBusy(btn, label) {
    var panel = $('ecDetail');
    Array.prototype.forEach.call((panel && panel.querySelectorAll('[data-ec-act], .kn-actions .btn')) || [], function (x) { x.disabled = true; x.setAttribute('aria-disabled', 'true'); });
    if (btn) btn.textContent = label;
  }
  function ecDoAction(act, d, btn) {
    var a = d.admin || {};
    var rec = d.record;
    var id = rec.mappingId;
    var q = '?id=' + encodeURIComponent(id);
    var label = rec.code || id;
    var req = null;
    var ok = '';
    if (act === 'preview') { ecRunPreview(rec); return; }
    if (act === 'publish') { ecOpenReview(d); return; }
    if (act === 'discard') {
      if (!window.confirm('Discard the unpublished draft of ' + label + '?\n\nThe live error code is not affected.')) return;
      ecBusy(btn, 'Discarding…'); ok = 'Draft discarded.';
      req = ecApi('/admin/error-codes/record' + q, { method: 'DELETE', body: { expectedRevision: a.revision } });
    } else if (act === 'delete') {
      if (!window.confirm('Permanently delete the draft ' + label + '?\n\nIt has never been published, so live diagnosis is not affected. This cannot be undone.')) return;
      ecBusy(btn, 'Deleting…');
      req = ecApi('/admin/error-codes/record' + q, { method: 'DELETE', body: { expectedRevision: a.revision } }).then(function (res) {
        if (res.ok && res.body.deleted) { ecCache = null; location.hash = ecListHref(); return null; }
        return res;
      });
    } else if (act === 'archive') {
      var reason = window.prompt('Archive ' + label + '?\n\nThe live Error Code engine stops returning it. History is kept and it can be restored.\n\nOptional reason:', '');
      if (reason === null) return;
      ecBusy(btn, 'Archiving…'); ok = 'Archived. The live engine no longer returns it.';
      req = ecApi('/admin/error-codes/record/retire' + q, { method: 'POST', body: { expectedRevision: a.revision, reason: reason } });
    } else if (act === 'restore') {
      ecBusy(btn, 'Restoring…'); ok = 'Restored. The live engine returns it again.';
      req = ecApi('/admin/error-codes/record/restore' + q, { method: 'POST', body: { expectedRevision: a.revision } });
    }
    if (!req) return;
    req.then(function (res) {
      if (!res) return;
      ecCache = null;
      if (res.ok) { ecOpen(id, ok); return; }
      ecOpen(id, null, ecErrText(res, 'That action failed. Nothing was changed.'));
    }).catch(function () { ecOpen(id, null, 'Could not reach the server. Nothing was changed.'); });
  }
  function ecRunPreview(rec) {
    var box = $('ecPreviewBox');
    if (box) box.innerHTML = '<p class="tac__muted">Resolving via the live Error Code MCP…</p>';
    ecApi('/admin/error-codes/preview', {
      method: 'POST',
      body: { make: (rec.brands && rec.brands[0]) || '', appliance: (rec.appliances && rec.appliances[0]) || '', code: rec.code },
    }).then(function (res) {
      if (!box) return;
      if (!res.ok) { box.innerHTML = '<p class="kn-notice kn-notice--bad">' + esc(ecErrText(res, 'Preview failed')) + '</p>'; return; }
      var r = res.body.result || {};
      box.innerHTML = '<div class="ec-preview"><p><span class="kn-state">' + esc(r.status || '—') + '</span> ' + esc((r.code && r.code.displayed) || rec.code) + '</p>'
        + '<p>' + esc(r.meaning || r.reason || 'No meaning in this MCP result.') + '</p>'
        + '<details class="kn-tech"><summary>Raw MCP result</summary><pre>' + esc(JSON.stringify(r, null, 2)) + '</pre></details></div>';
    });
  }

  // ---- publish review ------------------------------------------------------------------------
  function ecOpenReview(d) {
    var a = d.admin || {};
    var draft = a.draft || d.record;
    var Ec = ecLogic();
    var dlg = $('ecReviewDlg');
    if (!dlg) {
      dlg = document.createElement('dialog');
      dlg.id = 'ecReviewDlg';
      dlg.className = 'st-dlg kn-review-dlg';
      dlg.setAttribute('aria-labelledby', 'ecReviewTitle');
      document.body.appendChild(dlg);
    }
    var next = (a.versions && a.versions.length ? Math.max.apply(null, a.versions.map(function (v) { return v.version || 0; })) : 0) + 1;
    var hints = draft.diagnosticHints || {};
    var row = function (k, v) { return '<dt>' + esc(k) + '</dt><dd>' + esc(v) + '</dd>'; };
    var isNew = a.status === 'draft';
    dlg.innerHTML = '<div class="st-dlg__form"><h2 class="admin__h2" id="ecReviewTitle">Review before publishing</h2>'
      + '<dl class="kn-ov kn-ov--compact">'
      + row('Code', draft.code || '') + row('Appliance / make', ((draft.appliances || []).map(Ec.familyLabel).join(', ')) + ' · ' + ((draft.brands || []).map(Ec.brandLabel).join(', ')))
      + row('Publishes as', 'v' + next + (isNew ? ' (adds a new live code)' : ' (replaces the live version)'))
      + row('Meaning', draft.meaning || '')
      + row('Aliases', String((draft.shown || []).filter(function (s) { return s !== draft.code; }).length))
      + row('Components / causes / checks', [(hints.components || []).length, (hints.likelyCauses || []).length, (hints.checks || []).length].join(' / '))
      + row('Safety', draft.safety && draft.safety.class ? String(draft.safety.class).replace(/_/g, ' ') : 'None stored')
      + row('Changed', (a.pendingChanges || []).length ? (Ec.changeLabels ? Ec.changeLabels(a.pendingChanges) : a.pendingChanges).join(', ') : (isNew ? 'New code' : 'No field changes'))
      + '</dl>'
      + '<p class="kn-help">The server validates the draft again and rejects it if it would collide with another live code.</p>'
      + '<div class="kn-ed__field"><label for="ecPublishNote">Change note (optional)</label><input id="ecPublishNote" type="text" maxlength="300" autocomplete="off" placeholder="What changed and why" /></div>'
      + '<div class="st-dlg__actions"><button class="btn btn--ghost" type="button" id="ecReviewCancel">Cancel</button>'
      + '<button class="btn btn--primary" type="button" id="ecReviewGo">Publish v' + next + '…</button></div></div>';
    var close = function () { if (dlg.open) dlg.close(); };
    $('ecReviewCancel').addEventListener('click', close);
    $('ecReviewGo').addEventListener('click', function () {
      if (!window.confirm('Publish ' + (draft.code || '') + ' as v' + next + '?\n\n' + (isNew ? 'This adds a new code to live diagnosis.' : 'This replaces the live version in diagnosis.') + ' Earlier versions stay in history.')) return;
      var note = ($('ecPublishNote') && $('ecPublishNote').value) || '';
      close();
      var btn = $('ecDetail') && $('ecDetail').querySelector('[data-ec-act="publish"]');
      ecBusy(btn, 'Publishing…');
      ecApi('/admin/error-codes/record/publish?id=' + encodeURIComponent(d.record.mappingId), { method: 'POST', body: { expectedRevision: a.revision, note: note || null } })
        .then(function (res) {
          ecCache = null;
          if (res.ok) { ecOpen(d.record.mappingId, 'Published v' + ((res.body.published && res.body.published.version) || next) + '. The live engine now returns it.'); return; }
          ecOpen(d.record.mappingId, null, ecErrText(res, 'Publish failed. The live version is unchanged.'));
        });
    });
    if (typeof dlg.showModal === 'function') dlg.showModal(); else dlg.setAttribute('open', '');
    $('ecReviewCancel').focus();
  }

  // ---- version history -----------------------------------------------------------------------
  function ecShowHistory(id, v) {
    var panel = $('ecDetail');
    if (panel) { panel.hidden = false; panel.innerHTML = '<p class="tac__muted">Loading version history…</p>'; }
    ecOpenId = id;
    ecApi('/admin/error-codes/record?id=' + encodeURIComponent(id)).then(function (res) {
      if (ecOpenId !== id || res.status === 401) return;
      if (!res.ok) { panel.innerHTML = '<p class="kn__empty">' + esc(ecErrText(res, 'Could not load version history.')) + '</p>'; return; }
      var a = res.body.admin || {};
      var rec = res.body.record;
      var cur = a.currentVersion || 0;
      var next = (a.versions || []).reduce(function (m, x) { return Math.max(m, x.version || 0); }, 0) + 1;
      var rows = (a.versions || []).map(function (x) {
        var live = a.status === 'active' && x.version === cur;
        var bits = [];
        if (x.publishedAt) bits.push(fmtWhen(x.publishedAt) + (x.publishedBy ? ' by ' + x.publishedBy : ''));
        if (x.note) bits.push('“' + x.note + '”');
        if ((x.changed || []).length) bits.push('Changed: ' + ((ecLogic().changeLabels ? ecLogic().changeLabels(x.changed) : x.changed).join(', ')));
        var label = x.version === 0 ? 'Shipped baseline' : ('v' + x.version + (x.source === 'rollback' ? ' · rollback to ' + (x.rolledBackFrom === 0 ? 'baseline' : 'v' + x.rolledBackFrom) : (x.source === 'legacy' ? ' · live before version history' : '')));
        var canRb = !live && a.canRollback;
        return '<li class="kn-ver' + (live ? ' is-live' : '') + '"><div class="kn-ver__main"><b>' + esc(label) + '</b>' + (live ? ' <span class="kn-state kn-state--published">Live</span>' : '')
          + (bits.length ? '<p class="tx__sub">' + esc(bits.join(' · ')) + '</p>' : '') + '</div>'
          + '<div class="kn-ver__btns"><a class="btn btn--ghost" href="' + esc(ecDetailHref(id, { view: 'history', v: String(x.version) })) + '">View</a>'
          + (canRb ? '<button class="btn btn--ghost kn-rollbackbtn" type="button" data-ec-rollback="' + x.version + '">' + ecIco('rollback') + 'Roll back to this</button>' : '')
          + '</div></li>';
      }).join('');
      var note = a.draftPending ? '<p class="tx__sub">Rollback is unavailable while a draft is pending. Publish or discard it first.</p>'
        : (a.status === 'retired' ? '<p class="tx__sub">Restore this error code to roll back.</p>' : '');
      panel.innerHTML = '<div class="kn-detail__head"><div><p class="kn-detail__fam">Version history</p>'
        + '<h2 class="kn-detail__title">' + esc(rec.code || id) + '</h2><p class="kn-detail__id">' + esc(id) + '</p>'
        + '<p class="tx__sub">' + ecStateChip(rec, a) + ' Live: ' + esc(a.status === 'draft' ? 'not published' : (a.status === 'retired' ? 'archived' : (a.liveVersionLabel || 'active'))) + '</p></div></div>'
        + '<p class="kn-notice" id="ecNotice" tabindex="-1" role="status" aria-live="polite" hidden></p>' + note
        + (rows ? '<ol class="kn-vers">' + rows + '</ol>' : ecEmpty('Nothing has been published yet.'))
        + '<div id="ecVerDetail"></div>';
      Array.prototype.forEach.call(panel.querySelectorAll('[data-ec-rollback]'), function (b) {
        b.addEventListener('click', function () {
          var to = Number(b.getAttribute('data-ec-rollback'));
          var from = to === 0 ? 'the shipped baseline' : 'v' + to;
          if (!window.confirm('Roll back ' + (rec.code || id) + ' to ' + from + '?\n\nThis creates v' + next + ' with the content of ' + from + ' and makes it live. All earlier versions stay in history.')) return;
          Array.prototype.forEach.call(panel.querySelectorAll('button'), function (x) { x.disabled = true; });
          b.textContent = 'Rolling back…';
          ecApi('/admin/error-codes/record/rollback?id=' + encodeURIComponent(id), { method: 'POST', body: { expectedRevision: a.revision, toVersion: to } }).then(function (r2) {
            ecCache = null;
            ecShowHistory(id);
            setTimeout(function () { ecNotice(r2.ok ? 'ok' : 'bad', r2.ok ? 'Rolled back. v' + next + ' is live with the content of ' + from + '.' : ecErrText(r2, 'Rollback failed. The live version is unchanged.')); }, 60);
          });
        });
      });
      if (v != null && v !== '') ecShowVersion(id, v);
    });
  }
  function ecShowVersion(id, v) {
    var host = $('ecVerDetail');
    if (!host) return;
    host.innerHTML = '<p class="tac__muted">Loading version…</p>';
    ecApi('/admin/error-codes/record/version?id=' + encodeURIComponent(id) + '&v=' + encodeURIComponent(v)).then(function (res) {
      if (!res.ok) { host.innerHTML = ecEmpty(ecErrText(res, 'Version not found.')); return; }
      var x = res.body.version || {};
      host.innerHTML = '<section class="kn-sec kn-verview"><h3 class="kn-sec__h">' + esc(x.version === 0 ? 'Shipped baseline' : 'v' + x.version) + '</h3>'
        + ecContentHtml(x.record || {}) + ecTechHtml(x.record || {}) + '</section>';
    });
  }

  // ---- editor (create draft / save draft) ----------------------------------------------------
  var EC_RECORD_TYPES = ['FAULT', 'WARNING', 'STATUS', 'MAINTENANCE', 'INFORMATION'];
  var EC_SAFETY = [['', 'No stored safety'], ['NORMAL_DIAGNOSTIC', 'Normal diagnostic'], ['STATUS_ONLY', 'Status only'], ['SERVICE_REQUIRED', 'Service required'], ['STOP_USE', 'Stop use']];
  function ecField(id, label, value, opts) {
    opts = opts || {};
    var help = opts.help ? '<span class="kn-help" id="' + id + '-help">' + esc(opts.help) + '</span>' : '';
    var attrs = ' id="' + id + '"' + (help ? ' aria-describedby="' + id + '-help"' : '') + (opts.placeholder ? ' placeholder="' + esc(opts.placeholder) + '"' : '') + (opts.readonly ? ' readonly' : '');
    var input = opts.multiline
      ? '<textarea' + attrs + ' rows="' + (opts.rows || 3) + '">' + esc(value || '') + '</textarea>'
      : '<input type="text"' + attrs + ' value="' + esc(value || '') + '" autocomplete="off" />';
    return '<div class="kn-ed__field"><label for="' + id + '">' + esc(label) + '</label>' + help + input
      + '<span class="kn-ed__err" data-err-for="' + id + '" hidden></span></div>';
  }
  function ecSelect(id, label, value, options, help) {
    return '<div class="kn-ed__field"><label for="' + id + '">' + esc(label) + '</label>'
      + (help ? '<span class="kn-help" id="' + id + '-help">' + esc(help) + '</span>' : '')
      + '<select id="' + id + '"' + (help ? ' aria-describedby="' + id + '-help"' : '') + '>'
      + options.map(function (o) { return '<option value="' + esc(o[0]) + '"' + (String(value || '') === o[0] ? ' selected' : '') + '>' + esc(o[1]) + '</option>'; }).join('')
      + '</select><span class="kn-ed__err" data-err-for="' + id + '" hidden></span></div>';
  }
  function ecLinesOf(id) {
    var el = $(id);
    return String((el && el.value) || '').split(/\n/).map(function (s) { return s.trim(); }).filter(Boolean);
  }
  function ecFormState() {
    var v = function (id) { return $(id) ? $(id).value : ''; };
    var st = {
      meaning: v('ecfMeaning'), aliases: ecLinesOf('ecfAliases'), applicabilityNote: v('ecfApply'), system: v('ecfSystem'),
      recordType: v('ecfType'),
      diagnosticHints: { components: ecLinesOf('ecfComp'), likelyCauses: ecLinesOf('ecfCauses'), checks: ecLinesOf('ecfChecks') },
      safety: { class: v('ecfSafety'), stopUse: !!($('ecfStop') && $('ecfStop').checked), reason: v('ecfSafetyReason') },
      provenance: { sourceType: v('ecfSrcType'), publisher: v('ecfPub'), reference: v('ecfRef'), url: v('ecfUrl') },
    };
    if (ecEd && ecEd.isNew) { st.appliance = v('ecfAppliance'); st.brand = v('ecfBrand'); st.code = v('ecfCode'); }
    return st;
  }
  // Body for the server: only fields with values, so blank optional controls never overwrite stored data.
  function ecPatchBody(st) {
    var b = { meaning: st.meaning, aliases: st.aliases, diagnosticHints: st.diagnosticHints, provenance: st.provenance };
    if (st.applicabilityNote || (ecEd && ecEd.had.applicabilityNote)) b.applicabilityNote = st.applicabilityNote;
    if (st.system || (ecEd && ecEd.had.system)) b.system = st.system;
    if (st.recordType) b.recordType = st.recordType;
    if (st.safety.class) b.safety = st.safety;
    if (ecEd && ecEd.isNew) { b.appliance = st.appliance; b.brand = st.brand; b.code = st.code; }
    return b;
  }
  function ecEdStatus() {
    if (!ecEd) return;
    ecEd.dirty = JSON.stringify(ecFormState()) !== ecEd.base;
    var last = ecEd.lastSavedAt ? 'Last saved ' + fmtWhen(ecEd.lastSavedAt) + (ecEd.lastSavedBy ? ' by ' + ecEd.lastSavedBy : '') : '';
    var t = ecEd.saving ? 'Saving…' : (ecEd.dirty ? 'Unsaved changes' + (last ? ' · ' + last : '')
      : (ecEd.justSaved ? 'Saved' + (last ? ' · ' + last : '') : (ecEd.isNew ? 'Not saved yet' : (ecEd.hasDraft ? (last || 'Draft saved') : 'Showing the live version. Saving creates a draft.'))));
    if ($('ecEdDirty')) $('ecEdDirty').textContent = t;
    if ($('ecEdReview')) $('ecEdReview').hidden = !(ecEd.hasDraft && !ecEd.dirty && !ecEd.saving);
    if ($('ecEdJson')) $('ecEdJson').textContent = JSON.stringify(ecPatchBody(ecFormState()), null, 2);
  }
  function ecShowEditor(id) {
    var panel = $('ecDetail');
    if (panel) { panel.hidden = false; panel.innerHTML = '<p class="tac__muted">Loading editor…</p>'; }
    if (!id) {
      var go = function () { ecRenderEditor(null, null); };
      if (ecCache) go(); else fetch(API_BASE + '/admin/error-codes', { credentials: 'same-origin' }).then(function (r) { return r.json(); }).then(function (d) { ecCache = d; go(); }).catch(go);
      return;
    }
    ecOpenId = id;
    ecApi('/admin/error-codes/record?id=' + encodeURIComponent(id)).then(function (res) {
      if (ecOpenId !== id || res.status === 401) return;
      if (!res.ok) { panel.innerHTML = '<p class="kn__empty">' + esc(ecErrText(res, 'This error code cannot be edited right now.')) + '</p>'; return; }
      if (res.body.admin && res.body.admin.status === 'retired') { panel.innerHTML = ecEmpty('Restore this archived error code before editing it.'); return; }
      ecRenderEditor(res.body.record, res.body.admin);
    });
  }
  function ecRenderEditor(live, admin) {
    var panel = $('ecDetail');
    var Ec = ecLogic();
    var isNew = !live;
    var src = isNew ? {} : ((admin && admin.draft) || live);
    var hints = src.diagnosticHints || {};
    var prov = src.provenance || {};
    var saf = src.safety || {};
    var aliases = (src.shown || []).filter(function (s) { return s && s !== src.code; });
    var keepScroll = window.scrollY;
    var identity;
    if (isNew) {
      var apps = (ecCache && ecCache.appliances) || [];
      var brands = (ecCache && ecCache.brands) || [];
      identity = '<div class="kn-ed__grid">'
        + ecSelect('ecfAppliance', 'Appliance', '', [['', 'Choose an appliance']].concat(apps.map(function (x) { return [x, Ec.familyLabel ? Ec.familyLabel(x) : x]; })))
        + ecSelect('ecfBrand', 'Make / brand', '', [['', 'Choose a brand']].concat(brands.map(function (x) { return [x, Ec.brandLabel ? Ec.brandLabel(x) : x]; })))
        + ecField('ecfCode', 'Code as displayed', '', { placeholder: 'e.g. F05' })
        + '</div><p class="kn-help">Identity (appliance, make, code) is fixed once created. A new code starts as a draft and is not live until you publish it.</p>';
    } else {
      identity = '<dl class="kn-ov kn-ov--compact"><dt>Appliance</dt><dd>' + esc((live.appliances || []).map(Ec.familyLabel).join(', ')) + '</dd>'
        + '<dt>Make / brand</dt><dd>' + esc((live.brands || []).map(Ec.brandLabel).join(', ')) + '</dd>'
        + '<dt>Code</dt><dd>' + esc(live.code) + '</dd><dt>Mapping id</dt><dd>' + esc(live.mappingId) + '</dd></dl>'
        + '<p class="kn-help">' + esc(admin && admin.origin === 'admin' ? 'Identity cannot be changed. Create a replacement and archive this record to change it.' : 'Shipped identity cannot be edited. Create a replacement and archive this record to change it.') + '</p>';
    }
    var head = isNew ? 'New error code (draft)' : (admin && admin.draftPending ? 'Editing draft' : 'New draft from the live version');
    panel.hidden = false;
    panel.innerHTML = '<form class="kn-ed" id="ecEdForm" novalidate>'
      + '<div class="kn-ed__head"><div><p class="kn-detail__fam">' + esc(head) + '</p>'
      + '<h2 class="kn-detail__title">' + esc(isNew ? 'Add an error code' : (live.code || live.mappingId)) + '</h2>'
      + '<p class="tx__sub">Saving a draft does not change live diagnosis. Publish from the error code page when it is ready.</p></div></div>'
      + '<p class="kn-notice" id="ecEdNotice" tabindex="-1" role="alert" hidden></p>'
      + '<section class="kn-ed__sec"><h3 class="kn-ed__sech"><span class="kn-ed__secno" aria-hidden="true">1</span>Identity</h3>' + identity + '</section>'
      + '<section class="kn-ed__sec"><h3 class="kn-ed__sech"><span class="kn-ed__secno" aria-hidden="true">2</span>What it means</h3>'
      + ecField('ecfMeaning', 'Meaning', src.meaning, { multiline: true, help: 'What the code means, in plain words. Required.' })
      + ecField('ecfAliases', 'Aliases / variants', aliases.join('\n'), { multiline: true, help: 'One per line. Uses the same token/fold lookup rules as live resolve; F05 and F5 are not globally equivalent.' })
      + '<div class="kn-ed__grid">'
      + ecSelect('ecfType', 'Record type', src.recordType || '', [['', 'Not recorded']].concat(EC_RECORD_TYPES.map(function (t) { return [t, t.charAt(0) + t.slice(1).toLowerCase()]; })))
      + ecField('ecfSystem', 'System', src.system)
      + '</div>'
      + ecField('ecfApply', 'Applicability note', src.applicabilityNote, { help: 'Model / range limits, if any.' })
      + '</section>'
      + '<section class="kn-ed__sec"><h3 class="kn-ed__sech"><span class="kn-ed__secno" aria-hidden="true">3</span>Diagnostic information</h3>'
      + '<p class="kn-help">Stored enrichment only. One item per line.</p>'
      + ecField('ecfComp', 'Components', (hints.components || []).join('\n'), { multiline: true })
      + ecField('ecfCauses', 'Likely causes', (hints.likelyCauses || []).join('\n'), { multiline: true })
      + ecField('ecfChecks', 'Recommended checks', (hints.checks || []).join('\n'), { multiline: true })
      + '</section>'
      + '<section class="kn-ed__sec"><h3 class="kn-ed__sech"><span class="kn-ed__secno" aria-hidden="true">4</span>Safety guidance</h3>'
      + '<p class="kn-help">Stored safety only — never inferred from the code. Stop use needs a stored reason.</p>'
      + '<div class="kn-ed__grid">' + ecSelect('ecfSafety', 'Safety class', saf.class || '', EC_SAFETY) + '</div>'
      + '<label class="kn-ed__check"><input type="checkbox" id="ecfStop"' + (saf.stopUse ? ' checked' : '') + ' /> Stop use</label>'
      + ecField('ecfSafetyReason', 'Safety reason', saf.reason, { multiline: true, rows: 2 })
      + '</section>'
      + '<section class="kn-ed__sec"><h3 class="kn-ed__sech"><span class="kn-ed__secno" aria-hidden="true">5</span>Source / provenance</h3><div class="kn-ed__grid">'
      + ecField('ecfSrcType', 'Source type', prov.sourceType || (isNew ? 'ADMIN_CURATED' : ''), { placeholder: 'e.g. MANUFACTURER, ADMIN_CURATED' })
      + ecField('ecfPub', 'Publisher', prov.publisher)
      + ecField('ecfRef', 'Reference', prov.reference)
      + ecField('ecfUrl', 'Source URL', prov.url, { placeholder: 'https://' })
      + '</div></section>'
      + '<details class="kn-ed__sec kn-ed__sec--fold" id="ecSecAdvanced"><summary><h3 class="kn-ed__sech"><span class="kn-ed__secno" aria-hidden="true">6</span>Advanced</h3></summary>'
      + '<details class="kn-tech"><summary>Draft request JSON (read-only)</summary><pre id="ecEdJson"></pre></details></details>'
      + '<div class="kn-ed__bar"><span class="kn-ed__dirty" id="ecEdDirty" role="status" aria-live="polite"></span>'
      + (isNew ? '' : '<a class="btn btn--ghost" id="ecEdReview" href="' + esc(ecDetailHref(live.mappingId, { review: '1' })) + '" hidden>Review &amp; publish…</a>')
      + '<button class="btn btn--ghost" type="button" id="ecEdCancel">Cancel</button>'
      + '<button class="btn btn--primary" type="submit" id="ecEdSave">' + (isNew ? 'Create draft' : 'Save draft') + '</button></div></form>';
    var prev = ecEd;
    ecEd = {
      id: isNew ? null : live.mappingId, isNew: isNew, revision: admin ? admin.revision : 0, hasDraft: !!(admin && admin.draftPending),
      lastSavedAt: admin && admin.draftPending ? admin.draftSavedAt : null, lastSavedBy: admin && admin.draftPending ? admin.draftSavedBy : null,
      had: { applicabilityNote: !!src.applicabilityNote, system: !!src.system }, hash: location.hash,
      justSaved: !!(prev && prev.justSaved && prev.id === (live && live.mappingId)),
    };
    ecEd.base = JSON.stringify(ecFormState());
    var form = $('ecEdForm');
    form.addEventListener('input', ecEdStatus);
    form.addEventListener('change', ecEdStatus);
    form.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && e.target && e.target.tagName === 'INPUT' && e.target.type !== 'checkbox') e.preventDefault();
    });
    form.addEventListener('submit', function (e) { e.preventDefault(); ecEdSave(); });
    $('ecEdCancel').addEventListener('click', function () {
      var wasNew = ecEd.isNew;
      var mid = ecEd.id;
      guardThen(function () { ecEd = null; location.hash = wasNew ? ecListHref() : ecDetailHref(mid); });
    });
    ecEdStatus();
    if (prev && prev.justSaved) { window.scrollTo(0, keepScroll); setTimeout(function () { if (ecEd) { ecEd.justSaved = false; ecEdStatus(); } }, 4000); }
    else window.scrollTo(0, 0);
  }
  function ecEdErrors(res) {
    var form = $('ecEdForm');
    if (!form) return;
    Array.prototype.forEach.call(form.querySelectorAll('[data-err-for]'), function (el) { el.hidden = true; el.textContent = ''; });
    Array.prototype.forEach.call(form.querySelectorAll('[aria-invalid]'), function (el) { el.removeAttribute('aria-invalid'); });
    var target = (ecLogic().errorField || function () { return null; })((res && res.body) || {}, ecEd && ecEd.isNew);
    if (!target || !$(target)) return;
    var slot = form.querySelector('[data-err-for="' + target + '"]');
    if (slot) { slot.hidden = false; slot.textContent = (res.body && res.body.message) || 'Check this field.'; }
    $(target).setAttribute('aria-invalid', 'true');
  }
  function ecEdNotice(kind, msg) {
    var el = $('ecEdNotice');
    if (!el) return;
    el.hidden = !msg;
    el.className = 'kn-notice' + (kind ? ' kn-notice--' + kind : '');
    el.textContent = msg || '';
    if (msg) el.focus();
  }
  function ecEdSave() {
    if (!ecEd || ecEd.saving) return;
    var st = ecFormState();
    var body = ecPatchBody(st);
    ecEd.saving = true;
    ecEdStatus();
    var btn = $('ecEdSave');
    if (btn) btn.disabled = true;
    var ed = ecEd;
    var req = ed.isNew
      ? ecApi('/admin/error-codes', { method: 'POST', body: body })
      : ecApi('/admin/error-codes/record?id=' + encodeURIComponent(ed.id), { method: 'PATCH', body: Object.assign({ expectedRevision: ed.revision }, body) });
    req.then(function (res) {
      ed.saving = false;
      if (btn) btn.disabled = false;
      if (ecEd !== ed) return;
      if (res.ok && res.body.record) {
        ecCache = null;
        if (ed.isNew) { ecEd = null; location.replace(ecDetailHref(res.body.record.mappingId, { view: 'edit' })); return; }
        ed.justSaved = true;
        ecRenderEditor(res.body.record, res.body.admin);
        return;
      }
      ecEdStatus();
      if (res.status === 401) return;
      ecEdErrors(res);
      ecEdNotice('bad', 'Not saved. ' + ecErrText(res, 'The draft could not be saved.'));
    }).catch(function () {
      ed.saving = false;
      if (btn) btn.disabled = false;
      ecEdStatus();
      ecEdNotice('bad', 'Could not reach the server. Your changes are still in this form.');
    });
  }
  function fillRetention(d) {
    var body = $('txRetentionBody');
    if (!body || !d) return;
    body.innerHTML = '<p>' + esc(d.summary) + '</p><dl class="kv">'
      + kvRow('Retention (days)', d.retentionDays)
      + kvRow('Inactive after (minutes)', d.inactiveAfterMinutes)
      + kvRow('TTL attribute', d.ttlAttribute)
      + '</dl><h3 class="admin__h2">Stored</h3><ul>' + (d.stored || []).map(function (x) { return '<li>' + esc(x) + '</li>'; }).join('')
      + '</ul><h3 class="admin__h2">Not stored as fields</h3><ul>' + (d.notStored || []).map(function (x) { return '<li>' + esc(x) + '</li>'; }).join('') + '</ul>';
  }

  Array.prototype.forEach.call(navItems, function (item) {
    var sec = item.getAttribute('data-section');
    if (sec === 'transcripts') item.addEventListener('click', function () { loadTranscripts(); });
    if (sec === 'knowledge') item.addEventListener('click', navLoader(loadKnowledge));
    if (sec === 'media') item.addEventListener('click', navLoader(loadMedia));
    if (sec === 'diagnostics') item.addEventListener('click', loadDiagnostics);
    if (sec === 'mcp') item.addEventListener('click', navLoader(loadErrorCodes));
    if (sec === 'settings') item.addEventListener('click', loadSettings);
    if (sec === 'safety') item.addEventListener('click', navLoader(function () { siShowTab('ingest', {}); }));
  });

  var siView = null;
  var siWired = false;
  var siPoll = null;
  function siApi(path, opts) {
    opts = opts || {};
    return fetch(API_BASE + path, {
      method: opts.method || 'GET',
      credentials: 'same-origin',
      headers: Object.assign({ accept: 'application/json' }, opts.body ? { 'content-type': 'application/json' } : {}),
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    }).then(function (r) {
      if (r.status === 401) { showGate('Your session has expired. Please log in again.'); return { ok: false, status: 401, body: null }; }
      return r.json().then(function (b) { return { ok: r.ok, status: r.status, body: b }; }).catch(function () { return { ok: false, status: r.status, body: null }; });
    });
  }
  function siSetBusy(on) {
    var btn = $('siRun');
    if (!btn) return;
    btn.disabled = !!on;
    btn.textContent = on ? 'Ingest running…' : 'Run ingest';
    btn.setAttribute('aria-busy', on ? 'true' : 'false');
  }
  function siApply(d) {
    siView = d;
    if (!d || !window.Si) {
      $('siLive').textContent = 'Could not load ingest status.';
      return;
    }
    var st = d.status || { code: 'unknown', label: 'Unknown', detail: '' };
    $('siLive').textContent = st.label + ' — ' + (st.detail || '');
    var ago = Si.relativeAgo(d.published && d.published.lastSuccessfulIngestAt);
    var sched = d.schedule || {};
    var pub = d.published || {};
    $('siStatusBody').innerHTML = '<p><span class="si-status ' + Si.statusClass(st.code) + '">' + Si.esc(st.label) + '</span></p>'
      + '<p class="si-note">' + Si.esc(st.detail) + '</p>'
      + '<dl class="si-dl">'
      + '<div><dt>Published dataset</dt><dd>' + Si.esc(pub.count) + ' notices</dd></div>'
      + '<div><dt>Last successful ingest</dt><dd>' + Si.esc(Si.fmtWhen(pub.lastSuccessfulIngestAt)) + (ago ? ' · ' + Si.esc(ago) : '') + '</dd></div>'
      + '<div><dt>Source</dt><dd>' + Si.esc((d.source && d.source.authority) || '—') + ' via ' + Si.esc((d.source && d.source.via) || '—') + '</dd></div>'
      + '<div><dt>Automatic ingest</dt><dd>' + Si.esc(sched.label) + ' at ' + Si.esc(sched.time) + '</dd></div>'
      + '<div><dt>Next expected run</dt><dd>' + Si.esc(Si.fmtWhen(sched.nextExpectedAt)) + '</dd></div>'
      + '</dl>'
      + '<p class="si-note">' + Si.esc((d.lastGood && d.lastGood.note) || '') + '</p>';
    $('siSourceBody').innerHTML = Si.sourceHtml(d.source);
    var latest = d.latestRun;
    if (!latest) {
      $('siLatestBody').innerHTML = '<p class="si-note">No ingest run is recorded yet.</p>';
    } else {
      $('siLatestBody').innerHTML = '<dl class="si-dl">'
        + '<div><dt>Run id</dt><dd class="si-wrap">' + Si.esc(latest.runId) + '</dd></div>'
        + '<div><dt>Trigger</dt><dd>' + Si.esc(latest.trigger) + (latest.mode ? ' · ' + Si.esc(latest.mode) : '') + '</dd></div>'
        + '<div><dt>Started</dt><dd>' + Si.esc(Si.fmtWhen(latest.startedAt)) + '</dd></div>'
        + '<div><dt>Completed</dt><dd>' + Si.esc(Si.fmtWhen(latest.completedAt)) + '</dd></div>'
        + '<div><dt>Duration</dt><dd>' + Si.esc(Si.duration(latest.durationMs)) + '</dd></div>'
        + '<div><dt>Status</dt><dd>' + Si.esc(latest.status) + (latest.reconstructed ? ' · reconstructed' : '') + '</dd></div>'
        + '<div><dt>Fetched</dt><dd>' + Si.esc(Si.countOrDash(latest.fetched)) + '</dd></div>'
        + '<div><dt>Accepted this run</dt><dd>' + Si.esc(Si.countOrDash(latest.publishedThisRun)) + '</dd></div>'
        + '<div><dt>Published after run</dt><dd>' + Si.esc(Si.countOrDash(latest.livePublished)) + '</dd></div>'
        + (latest.error ? '<div><dt>Result</dt><dd>' + Si.esc(latest.error) + '</dd></div>' : '')
        + (latest.note ? '<div><dt>Note</dt><dd>' + Si.esc(latest.note) + '</dd></div>' : '')
        + '</dl>';
    }
    $('siPipeBody').innerHTML = Si.pipelineHtml(d.pipeline);
    $('siRejBody').innerHTML = Si.rejectionHtml(d.rejections, latest && latest.reconstructed);
    $('siPubBody').innerHTML = '<dl class="si-dl">'
      + '<div><dt>Notices</dt><dd>' + Si.esc(pub.count) + '</dd></div>'
      + '<div><dt>Dataset id</dt><dd class="si-wrap">' + Si.esc(pub.datasetId) + '</dd></div>'
      + '<div><dt>Exact-model records</dt><dd>' + Si.esc(pub.exactModelCapable) + '</dd></div>'
      + '<div><dt>Brands</dt><dd>' + Si.esc(pub.uniqueBrands) + '</dd></div>'
      + '<div><dt>Identity range needed</dt><dd>' + Si.esc(pub.identityRangeNeeded) + '</dd></div>'
      + '<div><dt>Customer hub</dt><dd><a href="' + Si.esc(pub.publicHub || '/recalls/') + '">' + Si.esc(pub.publicHub || '/recalls/') + '</a></dd></div>'
      + '</dl>' + Si.familyHtml(pub.byFamily);
    $('siMatchBody').innerHTML = Si.matchingHtml(d.matching && d.matching.policy);
    $('siHistBody').innerHTML = Si.historyHtml(d.history);
    $('siTechBody').innerHTML = Si.technicalHtml(d.technical);
    siSetBusy(st.code === 'running');
    if (st.code === 'running') siStartPoll();
    else siStopPoll();
  }
  function siStopPoll() {
    if (siPoll) { clearInterval(siPoll); siPoll = null; }
  }
  function siStartPoll() {
    if (siPoll) return;
    siPoll = setInterval(function () { loadSafetyIngest(); }, 4000);
  }
  function loadSafetyIngest() {
    if (!$('siStatusBody')) return;
    siApi('/admin/safety-ingest').then(function (res) {
      if (!res.ok || !res.body) {
        $('siLive').textContent = (res.body && res.body.error) || 'Could not load ingest status.';
        return;
      }
      siApply(res.body);
    }).catch(function () { $('siLive').textContent = 'Could not load ingest status.'; });
  }
  function siDoRun() {
    siSetBusy(true);
    $('siLive').textContent = 'Ingest running. This is the production GOV.UK / OPSS path.';
    siApi('/admin/safety-ingest/run', { method: 'POST', body: {} }).then(function (res) {
      var body = res.body || {};
      if (res.status === 409 || body.running) {
        $('siLive').textContent = (body.error || 'Ingest already running.') + ' The last-good published dataset remains active.';
        siStartPoll();
        return;
      }
      if (body.view) siApply(body.view);
      else loadSafetyIngest();
      if (!res.ok) {
        $('siLive').textContent = (body.error || 'Ingest did not finish. The existing published dataset remains active.');
      } else if (body.historyWritten === false) {
        $('siLive').textContent = body.error || 'Ingest finished but history could not be saved. The existing published dataset remains active.';
      } else {
        var counts = body.counts || {};
        $('siLive').textContent = 'Ingest finished. Fetched ' + Si.countOrDash(counts.fetched)
          + ', accepted this run ' + Si.countOrDash(counts.published)
          + ', currently published ' + Si.countOrDash(counts.livePublished) + '.';
      }
    }).catch(function () {
      $('siLive').textContent = 'Ingest did not finish. The existing published dataset remains active.';
    }).finally(function () {
      if (!(siView && siView.status && siView.status.code === 'running')) siSetBusy(false);
    });
  }
  function siWire() {
    if (siWired) return;
    siWired = true;
    if ($('siRefresh')) $('siRefresh').addEventListener('click', loadSafetyIngest);
    if ($('siRun')) $('siRun').addEventListener('click', function () {
      var dlg = $('siConfirmDlg');
      $('siConfirmBody').textContent = window.Si ? Si.confirmCopy() : '';
      if (dlg && dlg.showModal) dlg.showModal();
      else if (window.confirm(Si.confirmCopy())) siDoRun();
    });
    if ($('siConfirmYes')) $('siConfirmYes').addEventListener('click', function () {
      var dlg = $('siConfirmDlg');
      if (dlg && dlg.close) dlg.close();
      siDoRun();
    });
  }
  siWire();

  // ==== Safety: recall notices (list → dedicated detail → listing-decision editor / history) ==========
  // Routes: #safety                         ingest operations (unchanged default)
  //         #safety?tab=notices&q&state&family&sourceType   notice list (browse/filter only)
  //         #safety/<contentId>?<list params>              notice detail   (&review=1 opens publish review)
  //         #safety/<contentId>?view=edit | view=history[&v=N]
  // Official OPSS notice content is never edited. Admin decides only whether a notice is LISTED and under
  // which appliance family. Save draft never reaches customers; Publish / Archive / Restore / Rollback do.
  var rcCache = null;
  var rcWired = false;
  var rcOpenId = null;
  var rcEd = null;            // editor state { id, base, dirty, hash, saving, revision, ... }
  var rcPendingReview = null;
  var rcListScrollY = null;
  var rcCameFromList = false;
  var RC_TEXT = {
    leave: 'You have an unsaved listing decision. If you leave now it will be lost. The saved draft and the live recall notice are not affected.',
  };
  var RC_STATE_CLS = { published: 'kn-state kn-state--published', review: 'kn-state kn-state--draft', archived: 'kn-state kn-state--archived', withdrawn: 'kn-state kn-state--archived', excluded: 'kn-state' };
  var RC_TYPE_LABELS = { recall: 'Product recall', safety_report: 'Product safety report', safety_alert: 'Product safety alert' };
  function rcChip(state, label, draftPending) {
    return '<span class="' + esc(RC_STATE_CLS[state] || 'kn-state') + '">' + esc(label || state) + '</span>'
      + (draftPending ? ' <span class="kn-state kn-state--pending">Draft decision pending</span>' : '');
  }
  function rcListParams() {
    return {
      tab: 'notices',
      q: $('rcSearch') ? $('rcSearch').value : '',
      state: $('rcState') ? $('rcState').value : 'published',
      // Before the family options load, the deep-linked value is held in data-pending.
      family: $('rcFamily') ? ($('rcFamily').value || $('rcFamily').getAttribute('data-pending') || '') : '',
      sourceType: $('rcSourceType') ? $('rcSourceType').value : '',
    };
  }
  function rcListHref(params) { return hashString('safety', params || rcListParams()); }
  function rcDetailHref(id, extra) {
    var p = rcListParams();
    delete p.tab;
    Object.keys(extra || {}).forEach(function (k) { p[k] = extra[k]; });
    return '#safety/' + encodeURIComponent(id) + hashString('', p).slice(1);
  }
  function rcApplyParams(params) {
    params = params || {};
    if ($('rcSearch') && params.q != null) $('rcSearch').value = params.q;
    if ($('rcState') && params.state) $('rcState').value = params.state;
    if ($('rcFamily') && params.family != null) { $('rcFamily').setAttribute('data-pending', params.family); $('rcFamily').value = params.family; }
    if ($('rcSourceType') && params.sourceType != null) $('rcSourceType').value = params.sourceType;
  }
  function rcErrText(res, fallback) {
    var b = (res && res.body) || {};
    if (res && res.status === 409 && b.code === 'conflict') return 'Someone else changed this notice. Reload to see the latest version, then try again.';
    if (res && res.status === 409 && b.code === 'source_changed') return 'The official notice was updated since you opened it. Reload and review the new content before publishing.';
    var msg = b.error || fallback || 'That did not work.';
    if (b.fields && b.fields.length) msg += ' Check: ' + b.fields.join(', ') + '.';
    return msg;
  }
  function siShowTab(tab, params) {
    var notices = tab === 'notices';
    if ($('siListView')) $('siListView').hidden = false;
    if ($('siDetailPage')) $('siDetailPage').hidden = true;
    rcOpenId = null;
    Array.prototype.forEach.call(document.querySelectorAll('[data-sitab]'), function (b) {
      var on = b.getAttribute('data-sitab') === (notices ? 'notices' : 'ingest');
      b.classList.toggle('is-active', on);
      b.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    if ($('siIngestTab')) $('siIngestTab').hidden = notices;
    if ($('siNoticesTab')) $('siNoticesTab').hidden = !notices;
    rcWire();
    if (notices) { rcApplyParams(params); rcLoadList(); }
    else loadSafetyIngest();
  }
  function rcWire() {
    if (rcWired) return;
    rcWired = true;
    Array.prototype.forEach.call(document.querySelectorAll('[data-sitab]'), function (b) {
      b.addEventListener('click', function () {
        var t = b.getAttribute('data-sitab');
        writeHash('safety', t === 'notices' ? rcListParams() : {});
        siShowTab(t, t === 'notices' ? rcListParams() : {});
      });
    });
    var onFilter = function () { writeHash('safety', rcListParams()); rcRenderList(); };
    if ($('rcSearch')) $('rcSearch').addEventListener('input', onFilter);
    ['rcState', 'rcFamily', 'rcSourceType'].forEach(function (id) {
      if ($(id)) $(id).addEventListener('change', function () { writeHash('safety', rcListParams()); rcCache = null; rcLoadList(); });
    });
    if ($('rcClear')) $('rcClear').addEventListener('click', function () {
      if ($('rcSearch')) $('rcSearch').value = '';
      if ($('rcState')) $('rcState').value = 'published';
      if ($('rcFamily')) $('rcFamily').value = '';
      if ($('rcSourceType')) $('rcSourceType').value = '';
      writeHash('safety', rcListParams()); rcCache = null; rcLoadList();
    });
    if ($('siBackLink')) $('siBackLink').addEventListener('click', function (e) {
      guardedBack(e, $('siBackLink'), function () { return rcCameFromList; }, function () { rcEd = null; });
    });
  }

  // ---- list ----------------------------------------------------------------------------------------
  function rcLoadList() {
    var list = $('rcList');
    if (!list) return;
    var p = rcListParams();
    var key = [p.state, p.family, p.sourceType].join('|');
    if (rcCache && rcCache.key === key) { rcRenderList(); rcRestoreScroll(); return; }
    list.innerHTML = '<div class="tac__muted">Loading recall notices…</div>';
    var qs = '?state=' + encodeURIComponent(p.state === 'all' ? '' : p.state) + '&family=' + encodeURIComponent(p.family) + '&sourceType=' + encodeURIComponent(p.sourceType);
    siApi('/admin/recalls/records' + qs).then(function (res) {
      if (!res.ok || !res.body) { list.innerHTML = '<div class="kn__empty">' + esc(rcErrText(res, 'Could not load recall notices.')) + '</div>'; return; }
      rcCache = { key: key, data: res.body };
      var fam = $('rcFamily');
      if (fam && fam.options.length <= 1) {
        var want = fam.getAttribute('data-pending') || fam.value;
        (res.body.families || []).forEach(function (f) { fam.appendChild(new Option(f.name, f.id)); });
        if (want) fam.value = want;
      }
      if (fam) fam.removeAttribute('data-pending');
      rcRenderList();
      rcRestoreScroll();
    }).catch(function () { list.innerHTML = '<div class="kn__empty">Could not load recall notices.</div>'; });
  }
  function rcRestoreScroll() {
    if (rcListScrollY == null) return;
    var y = rcListScrollY; rcListScrollY = null;
    setTimeout(function () { window.scrollTo(0, y); }, 0);
  }
  function rcRenderList() {
    var list = $('rcList');
    if (!list || !rcCache) return;
    var d = rcCache.data;
    var q = String(($('rcSearch') && $('rcSearch').value) || '').trim().toLowerCase();
    var rows = (d.records || []).filter(function (r) {
      if (!q) return true;
      return [r.title, r.brand, r.productName, r.psdNumber, r.slug, r.id, (r.models || []).join(' ')].join(' ').toLowerCase().indexOf(q) !== -1;
    });
    var p = rcListParams();
    if ($('rcClear')) $('rcClear').hidden = !(p.q || p.family || p.sourceType || p.state !== 'published');
    var c = d.counts || {};
    if ($('rcStatusLine')) {
      $('rcStatusLine').textContent = rows.length + ' shown · ' + (c.published || 0) + ' listed · ' + (c.review || 0) + ' held · '
        + (c.archived || 0) + ' archived · ' + (c.withdrawn || 0) + ' withdrawn · ' + (c.excluded || 0) + ' out of scope'
        + (d.draftCount ? ' · ' + d.draftCount + ' with draft decisions' : '') + (d.truncated ? ' · first 200 shown; narrow the filters' : '');
    }
    if (!rows.length) { list.innerHTML = '<div class="kn__empty">No recall notices match these filters.</div>'; return; }
    list.innerHTML = rows.map(function (r) {
      var models = (r.models || []).join(', ') + (r.modelCount > (r.models || []).length ? ' +' + (r.modelCount - r.models.length) + ' more' : '');
      return '<a class="si-card" data-rc-id="' + esc(r.id) + '" href="' + esc(rcDetailHref(r.id)) + '">'
        + '<span class="si-card__main"><span class="si-card__title">' + esc(r.title) + '</span>'
        + '<span class="si-card__meta">' + esc([r.brand, r.productName].filter(Boolean).join(' · ') || 'No brand or product name in the notice') + '</span>'
        + (models ? '<span class="si-card__meta">Models: ' + esc(models) + '</span>' : '<span class="si-card__meta">No model numbers in the notice</span>')
        + '<span class="si-card__flags">' + rcChip(r.state, r.stateLabel, r.draftPending)
        + ' <span class="kn-flag">' + esc(RC_TYPE_LABELS[r.sourceType] || r.sourceType) + '</span>'
        + (r.familyName ? ' <span class="kn-flag">' + esc(r.familyName) + '</span>' : '')
        + (r.riskLevel ? ' <span class="kn-flag">Risk: ' + esc(r.riskLevel) + '</span>' : '')
        + (r.sourceRevisionCount ? ' <span class="kn-flag">Updated by OPSS ×' + esc(String(r.sourceRevisionCount)) + '</span>' : '')
        + '</span>'
        + '<span class="si-card__meta">OPSS via GOV.UK · alert ' + esc(r.alertDate || '—') + ' · last checked ' + esc(fmtWhen(r.lastCheckedAt)) + '</span>'
        + '</span><span class="si-card__go" aria-hidden="true">›</span></a>';
    }).join('');
  }

  // ---- detail page ---------------------------------------------------------------------------------
  function rcShowDetail(id, params) {
    params = params || {};
    var listView = $('siListView');
    var listVisible = Boolean(listView && !listView.hidden && $('siNoticesTab') && !$('siNoticesTab').hidden && $('rcList') && $('rcList').querySelector('.si-card'));
    if (listVisible) rcListScrollY = window.scrollY || 0;
    rcCameFromList = listVisible;
    rcWire();
    rcApplyParams(params);
    if (listView) listView.hidden = true;
    if ($('siDetailPage')) $('siDetailPage').hidden = false;
    var view = params.view || '';
    var sub = view === 'edit' || view === 'history';
    var back = $('siBackLink');
    var lp = { tab: 'notices', q: params.q || '', state: params.state || 'published', family: params.family || '', sourceType: params.sourceType || '' };
    if (back) {
      back.setAttribute('href', sub ? rcDetailHref(id) : rcListHref(lp));
      back.textContent = sub ? '← Back to notice' : '← Back to recall notices';
      back.setAttribute('data-sub', sub ? '1' : '');
    }
    window.scrollTo(0, 0);
    if (rcEd && !(view === 'edit' && rcEd.id === id)) rcEd = null;
    if (view === 'edit') { rcShowEditor(id); return; }
    if (view === 'history') { rcShowHistory(id, params.v); return; }
    rcPendingReview = params.review ? id : null;
    rcOpen(id);
  }
  function rcFetch(id) { return siApi('/admin/recalls/record?id=' + encodeURIComponent(id)); }
  function rcOpen(id, okMsg, badMsg) {
    rcOpenId = id;
    var panel = $('siDetail');
    if (panel) { panel.hidden = false; panel.innerHTML = '<p class="tac__muted">Loading notice…</p>'; }
    rcFetch(id).then(function (res) {
      if (rcOpenId !== id || res.status === 401) return;
      if (!res.ok || !res.body) { panel.innerHTML = '<p class="kn__empty">' + esc(res.status === 404 ? 'Recall notice not found.' : rcErrText(res, 'Could not load this notice.')) + '</p>'; return; }
      rcRenderDetail(res.body);
      if (rcPendingReview === id) { rcPendingReview = null; if (res.body.admin && res.body.admin.canPublish) rcOpenReview(res.body); }
      if (okMsg) rcNotice('ok', okMsg);
      if (badMsg) rcNotice('bad', badMsg);
    }).catch(function () { panel.innerHTML = '<p class="kn__empty">Could not load this notice.</p>'; });
  }
  function rcNotice(kind, msg) {
    var el = $('rcNotice');
    if (!el) return;
    el.hidden = !msg;
    el.className = 'kn-notice' + (kind ? ' kn-notice--' + kind : '');
    el.textContent = msg || '';
    if (msg) el.focus();
  }
  function rcRow(k, v) { return '<dt>' + esc(k) + '</dt><dd>' + (v == null || v === '' ? '<span class="tx__sub">Not given in the notice</span>' : esc(v)) + '</dd>'; }
  function rcDecisionText(dec, d) {
    if (!dec) return 'Classifier decision (' + ((d.classification && d.classification.reason) || 'no reason recorded') + ')';
    if (dec.status === 'archived') return 'Archived' + (dec.note ? ' — ' + dec.note : '');
    return 'List under ' + rcFamilyName(dec.family) + (dec.note ? ' — ' + dec.note : '');
  }
  var RC_FAMILY_NAMES = {};
  function rcFamilyName(id) { return RC_FAMILY_NAMES[id] || id; }
  function rcActionsHtml(d) {
    var a = d.admin || {};
    var id = d.id;
    var b = [];
    if (a.canEdit) b.push('<a class="btn btn--primary" href="' + esc(rcDetailHref(id, { view: 'edit' })) + '">' + knIco('edit') + (a.draft ? 'Edit draft decision' : 'Change listing decision') + '</a>');
    if (a.canPublish) b.push('<button class="btn btn--primary" type="button" data-rc-act="publish">' + knIco('publish') + 'Review &amp; publish…</button>');
    b.push('<a class="btn btn--ghost" href="' + esc(rcDetailHref(id, { view: 'history' })) + '">' + knIco('history') + 'View version history</a>');
    if (a.canRestore) b.push('<button class="btn btn--ghost" type="button" data-rc-act="restore">' + knIco('rollback') + 'Restore listing</button>');
    var risky = [];
    if (a.canDiscard) risky.push('<button class="btn btn--ghost" type="button" data-rc-act="discard">Discard draft</button>');
    if (a.canArchive) risky.push('<button class="btn btn--ghost kn-danger" type="button" data-rc-act="archive">' + knIco('archive') + 'Archive</button>');
    if (risky.length) b.push('<span class="kn-actions__risky">' + risky.join('') + '</span>');
    var meta = ['Live: ' + (a.currentVersion ? 'v' + a.currentVersion : 'as ingested'), 'Decided by ' + (d.effective && d.effective.by === 'admin' ? 'Admin' : (d.effective && d.effective.by === 'source' ? 'OPSS (withdrawn)' : (d.effective && d.effective.by === 'validation' ? 'validation hold' : 'classifier')))];
    if (a.draft) meta.push('Draft saved ' + fmtWhen(a.draft.savedAt) + (a.draft.savedBy ? ' by ' + a.draft.savedBy : ''));
    return '<div class="kn-actions"><div class="kn-actions__state">' + rcChip(d.state, d.stateLabel, !!a.draft) + '<span class="tx__sub">' + esc(meta.join(' · ')) + '</span></div>'
      + (a.draft && a.draftEffect ? '<p class="kn-actions__pending">Draft decision not yet live: ' + esc(a.draftEffect.listed ? 'list under ' + rcFamilyName(a.draftEffect.family) : 'not listed') + '. Customers see no change until it is published.</p>' : '')
      + '<div class="kn-actions__btns">' + b.join('') + '</div>'
      + '<p class="tx__sub">' + esc(a.deleteNote || '') + '</p>'
      + '<p class="kn-notice" id="rcNotice" tabindex="-1" role="status" aria-live="polite" hidden></p></div>';
  }
  function rcRenderDetail(d) {
    var panel = $('siDetail');
    if (!panel) return;
    (d.families || (rcCache && rcCache.data && rcCache.data.families) || []).forEach(function (f) { RC_FAMILY_NAMES[f.id] = f.name; });
    var n = d.notice || {};
    var s = d.source || {};
    var ci = d.customerImpact || {};
    var a = d.admin || {};
    var banner = d.state === 'withdrawn' ? '<p class="kn-banner">Withdrawn by OPSS' + (s.withdrawn && s.withdrawn.explanation ? ': ' + esc(s.withdrawn.explanation) : '') + '. It is never listed as a current notice and cannot be relisted. It is kept as evidence.</p>'
      : (d.state === 'archived' ? '<p class="kn-banner">Archived — not listed for customers. The official notice, its source revisions and the decision history are kept. Restore to list it again.</p>'
        : (d.state === 'review' ? '<p class="kn-banner kn-banner--info">Held for review — not listed. ' + esc(d.validation && d.validation.ok === false ? 'The source record failed validation (' + (d.validation.fields || []).join(', ') + ').' : 'The classifier could not assign one appliance family.') + '</p>' : ''));
    var srcRevs = (d.sourceRevisions || []).length
      ? '<ol class="kn-vers">' + d.sourceRevisions.map(function (r) {
        return '<li class="kn-ver"><div class="kn-ver__main"><b>Superseded ' + esc(fmtWhen(r.supersededAt)) + '</b><p class="tx__sub">' + esc([r.title, 'alert ' + (r.alertDate || '—'), (r.models || []).length + ' models'].join(' · ')) + '</p>'
          + (r.hazard ? '<p class="tx__sub">Hazard then: ' + esc(r.hazard) + '</p>' : '') + '</div></li>';
      }).join('') + '</ol>'
      : '<p class="kn-sec__empty">No earlier source revision recorded. This is the notice as first ingested' + (s.lastChangedAt ? ' (last changed ' + esc(fmtWhen(s.lastChangedAt)) + ')' : '') + '.</p>';
    panel.hidden = false;
    panel.innerHTML = '<div class="kn-detail__head"><div>'
      + '<p class="kn-detail__fam">' + esc(RC_TYPE_LABELS[d.sourceType] || d.sourceType) + (d.familyName ? ' · ' + esc(d.familyName) : '') + '</p>'
      + '<h2 class="kn-detail__title">' + esc(d.title) + '</h2>'
      + '<p class="kn-detail__id">' + esc(d.id) + (d.psdNumber ? ' · PSD ' + esc(d.psdNumber) : '') + '</p></div></div>'
      + rcActionsHtml(d) + banner
      + '<section class="kn-sec"><h3 class="kn-sec__h">Customer impact</h3><p>' + esc(ci.note || '') + '</p>'
      + (ci.publicPage ? '<p><a class="btn btn--ghost" href="' + esc(ci.publicPage) + '" target="_blank" rel="noopener">Open the public notice page</a></p>' : '') + '</section>'
      + '<section class="kn-sec"><h3 class="kn-sec__h">Official notice</h3><p class="kn-help">Content from the UK Office for Product Safety and Standards. ApplianceClinic does not edit it.</p><dl class="kn-ov">'
      + rcRow('Product', n.productName) + rcRow('Brand', n.brand) + rcRow('Product type', n.productType)
      + rcRow('Models', (n.models || []).join(', ')) + rcRow('Model text', n.modelText) + rcRow('Batch', n.batchText) + rcRow('Serial', n.serialText)
      + rcRow('Risk level', n.riskLevel) + rcRow('Measures', (n.measureTypes || []).join(', '))
      + rcRow('Hazard', n.hazard) + rcRow('What to do', n.correctiveAction)
      + rcRow('Stop use indicated by the source', n.stopUseIndicatedBySource ? 'Yes' : 'No')
      + rcRow('Serial / batch range needed to confirm', n.identityRangeNeeded ? 'Yes' : 'No')
      + '</dl></section>'
      + '<section class="kn-sec"><h3 class="kn-sec__h">Source / provenance</h3><dl class="kn-ov">'
      + rcRow('Organisation', s.organisation) + rcRow('Via', s.via) + rcRow('Notice id', s.noticeId) + rcRow('PSD number', s.psdNumber)
      + '<dt>Official record</dt><dd><a href="' + esc(s.sourceUrl) + '" target="_blank" rel="noopener noreferrer">' + esc(s.sourceUrl) + '</a></dd>'
      + rcRow('Alert date', s.alertDate) + rcRow('First published', s.firstPublishedAt) + rcRow('Source last updated', s.publicUpdatedAt)
      + rcRow('First ingested', fmtWhen(s.firstSeenAt)) + rcRow('Last checked', fmtWhen(s.lastCheckedAt)) + rcRow('Last changed', fmtWhen(s.lastChangedAt))
      + '</dl><p class="tx__sub">' + esc(s.attribution || '') + '</p></section>'
      + '<section class="kn-sec"><h3 class="kn-sec__h">Listing decision</h3><dl class="kn-ov">'
      + rcRow('Classifier', (d.classification.state || '') + (d.classification.family ? ' · ' + rcFamilyName(d.classification.family) : '') + ' · ' + (d.classification.reason || ''))
      + rcRow('Live decision', rcDecisionText(a.liveDecision, d))
      + rcRow('Draft decision', a.draft ? rcDecisionText(a.draft, d) : 'None')
      + '</dl></section>'
      + '<section class="kn-sec"><h3 class="kn-sec__h">Source revisions</h3><p class="kn-help">When OPSS updates a notice, the earlier official content is kept here, unchanged.</p>' + srcRevs + '</section>'
      + '<details class="kn-tech"><summary>Technical details</summary><dl class="kn-ov">' + rcRow('Body hash', s.bodyHash) + rcRow('Revision', String(a.revision || 0))
      + '</dl><pre>' + esc(JSON.stringify({ classification: d.classification, effective: d.effective, validation: d.validation, hashRevisions: d.hashRevisions }, null, 2)) + '</pre></details>';
    Array.prototype.forEach.call(panel.querySelectorAll('[data-rc-act]'), function (btn) {
      btn.addEventListener('click', function () { rcDoAction(btn.getAttribute('data-rc-act'), d, btn); });
    });
  }
  function rcBusy(btn, label) {
    var panel = $('siDetail');
    Array.prototype.forEach.call((panel && panel.querySelectorAll('[data-rc-act], .kn-actions .btn')) || [], function (x) { x.disabled = true; x.setAttribute('aria-disabled', 'true'); });
    if (btn) btn.textContent = label;
  }
  function rcPagesNote(res) {
    var p = res && res.body && res.body.publicPages;
    return p && p.error ? ' The public Recall Centre pages could not be refreshed (' + p.error + '); the recall lookup and WebMCP already reflect the change. Run ingest to refresh the pages.' : '';
  }
  function rcDoAction(act, d, btn) {
    var a = d.admin || {};
    var id = d.id;
    var q = '?id=' + encodeURIComponent(id);
    var req = null;
    var ok = '';
    if (act === 'publish') { rcOpenReview(d); return; }
    if (act === 'discard') {
      if (!window.confirm('Discard the draft listing decision for “' + d.title + '”?\n\nThe live notice is not affected.')) return;
      rcBusy(btn, 'Discarding…'); ok = 'Draft discarded.';
      req = siApi('/admin/recalls/record/discard' + q, { method: 'POST', body: { expectedRevision: a.revision } });
    } else if (act === 'archive') {
      var reason = window.prompt('Archive “' + d.title + '”?\n\nThis notice will stop being treated as active: it leaves the Recall Centre, the recall lookup and the WebMCP checkRecall tool, so customers who search for this product will no longer be told about it. Historical evidence (the official notice, its source revisions and this decision history) will remain, and Restore lists it again.\n\nReason (required):', '');
      if (reason === null) return;
      rcBusy(btn, 'Archiving…'); ok = 'Archived. Customers no longer see this notice.';
      req = siApi('/admin/recalls/record/archive' + q, { method: 'POST', body: { expectedRevision: a.revision, reason: reason } });
    } else if (act === 'restore') {
      if (!window.confirm('Restore the listing for “' + d.title + '”?\n\nThis can change customer-facing safety advice: the notice is listed again in the Recall Centre, the recall lookup and WebMCP.')) return;
      rcBusy(btn, 'Restoring…'); ok = 'Restored. Customers can find this notice again.';
      req = siApi('/admin/recalls/record/restore' + q, { method: 'POST', body: { expectedRevision: a.revision } });
    }
    if (!req) return;
    req.then(function (res) {
      rcCache = null;
      if (res.ok) { rcOpen(id, ok + rcPagesNote(res)); return; }
      rcOpen(id, null, rcErrText(res, 'That action failed. Nothing was changed.'));
    }).catch(function () { rcOpen(id, null, 'Could not reach the server. Nothing was changed.'); });
  }

  // ---- publish review ------------------------------------------------------------------------------
  function rcOpenReview(d) {
    var a = d.admin || {};
    var dr = a.draft || {};
    var eff = a.draftEffect || {};
    var dlg = $('rcReviewDlg');
    if (!dlg) {
      dlg = document.createElement('dialog');
      dlg.id = 'rcReviewDlg';
      dlg.className = 'st-dlg kn-review-dlg';
      dlg.setAttribute('aria-labelledby', 'rcReviewTitle');
      document.body.appendChild(dlg);
    }
    var next = (a.versions || []).reduce(function (m, v) { return Math.max(m, v.version || 0); }, 0) + 1;
    var row = function (k, v) { return '<dt>' + esc(k) + '</dt><dd>' + esc(v) + '</dd>'; };
    var becomesListed = eff.listed && d.state !== 'published';
    dlg.innerHTML = '<div class="st-dlg__form"><h2 class="admin__h2" id="rcReviewTitle">Review before publishing</h2>'
      + '<p class="kn-banner">This can change customer-facing safety advice.</p>'
      + '<dl class="kn-ov kn-ov--compact">'
      + row('Notice', d.title) + row('Official record', (d.source && d.source.sourceUrl) || '')
      + row('Now', d.stateLabel + (d.familyName ? ' · ' + d.familyName : ''))
      + row('After publishing', eff.listed ? 'Listed under ' + rcFamilyName(eff.family) : 'Not listed')
      + row('Customer effect', becomesListed ? 'Customers will find this notice in the Recall Centre, the recall lookup and WebMCP checkRecall.' : (eff.listed ? 'The notice moves to the ' + rcFamilyName(eff.family) + ' section of the Recall Centre.' : 'Customers stop seeing this notice.'))
      + row('Reason', dr.note || '') + row('Publishes as', 'v' + next)
      + '</dl><p class="kn-help">Recall notices never change diagnosis, STOP behaviour or parts. The server re-checks that the official notice has not changed since you opened it.</p>'
      + '<div class="st-dlg__actions"><button class="btn btn--ghost" type="button" id="rcReviewCancel">Cancel</button>'
      + '<button class="btn btn--primary" type="button" id="rcReviewGo">Publish v' + next + '…</button></div></div>';
    var close = function () { if (dlg.open) dlg.close(); };
    $('rcReviewCancel').addEventListener('click', close);
    $('rcReviewGo').addEventListener('click', function () {
      if (!window.confirm('Publish this listing decision as v' + next + '?\n\nThis can change customer-facing safety advice. Earlier versions stay in history.')) return;
      close();
      var btn = $('siDetail') && $('siDetail').querySelector('[data-rc-act="publish"]');
      rcBusy(btn, 'Publishing…');
      siApi('/admin/recalls/record/publish?id=' + encodeURIComponent(d.id), { method: 'POST', body: { expectedRevision: a.revision, expectedSourceHash: d.source && d.source.bodyHash } })
        .then(function (res) {
          rcCache = null;
          if (res.ok) { rcOpen(d.id, 'Published v' + ((res.body.applied && res.body.applied.version) || next) + '.' + rcPagesNote(res)); return; }
          rcOpen(d.id, null, rcErrText(res, 'Publish failed. The live notice is unchanged.'));
        });
    });
    if (typeof dlg.showModal === 'function') dlg.showModal(); else dlg.setAttribute('open', '');
    $('rcReviewCancel').focus();
  }

  // ---- version history -----------------------------------------------------------------------------
  function rcShowHistory(id, v) {
    var panel = $('siDetail');
    if (panel) { panel.hidden = false; panel.innerHTML = '<p class="tac__muted">Loading version history…</p>'; }
    rcOpenId = id;
    rcFetch(id).then(function (res) {
      if (rcOpenId !== id || res.status === 401) return;
      if (!res.ok) { panel.innerHTML = '<p class="kn__empty">' + esc(rcErrText(res, 'Could not load version history.')) + '</p>'; return; }
      var d = res.body;
      var a = d.admin || {};
      var cur = a.currentVersion || 0;
      var next = (a.versions || []).reduce(function (m, x) { return Math.max(m, x.version || 0); }, 0) + 1;
      var rows = (a.versions || []).map(function (x) {
        var live = x.version === cur;
        var bits = [];
        if (x.at) bits.push(fmtWhen(x.at) + (x.by ? ' by ' + x.by : ''));
        if (x.note) bits.push('“' + x.note + '”');
        if ((x.changed || []).length) bits.push('Changed: ' + x.changed.join(', '));
        if (x.effectiveState) bits.push('Result: ' + ((d.stateLabels || {})[x.effectiveState] || x.effectiveState));
        if (x.previousRevision != null) bits.push('revision ' + x.previousRevision + ' → ' + x.newRevision);
        var label = x.version === 0 ? 'As ingested (classifier decision)' : ('v' + x.version + ' · ' + x.action + (x.action === 'rollback' ? ' to ' + (x.rolledBackFrom === 0 ? 'as ingested' : 'v' + x.rolledBackFrom) : ''));
        var canRb = !live && a.canRollback;
        return '<li class="kn-ver' + (live ? ' is-live' : '') + '"><div class="kn-ver__main"><b>' + esc(label) + '</b>' + (live ? ' <span class="kn-state kn-state--published">Live</span>' : '')
          + (bits.length ? '<p class="tx__sub">' + esc(bits.join(' · ')) + '</p>' : '') + '</div>'
          + '<div class="kn-ver__btns"><a class="btn btn--ghost" href="' + esc(rcDetailHref(id, { view: 'history', v: String(x.version) })) + '">View</a>'
          + (canRb ? '<button class="btn btn--ghost kn-rollbackbtn" type="button" data-rc-rollback="' + x.version + '">' + knIco('rollback') + 'Roll back to this</button>' : '')
          + '</div></li>';
      }).join('');
      var note = a.draft ? '<p class="tx__sub">Rollback is unavailable while a draft decision is pending. Publish or discard it first.</p>'
        : (d.state === 'withdrawn' ? '<p class="tx__sub">OPSS has withdrawn this notice; it cannot be listed again.</p>' : '');
      panel.innerHTML = '<div class="kn-detail__head"><div><p class="kn-detail__fam">Version history</p>'
        + '<h2 class="kn-detail__title">' + esc(d.title) + '</h2><p class="kn-detail__id">' + esc(id) + '</p>'
        + '<p class="tx__sub">' + rcChip(d.state, d.stateLabel, !!a.draft) + ' Live: ' + esc(cur ? 'v' + cur : 'as ingested') + '</p></div></div>'
        + '<p class="kn-notice" id="rcNotice" tabindex="-1" role="status" aria-live="polite" hidden></p>' + note
        + '<ol class="kn-vers">' + rows + '</ol>'
        + '<p class="tx__sub">Versions record ApplianceClinic listing decisions. The official notice content is versioned separately under Source revisions.</p>'
        + '<div id="rcVerDetail"></div>';
      Array.prototype.forEach.call(panel.querySelectorAll('[data-rc-rollback]'), function (b) {
        b.addEventListener('click', function () {
          var to = Number(b.getAttribute('data-rc-rollback'));
          var from = to === 0 ? 'the as-ingested classifier decision' : 'v' + to;
          if (!window.confirm('Roll back “' + d.title + '” to ' + from + '?\n\nThis creates a new live version (v' + next + ') using older content, and can change customer-facing safety advice: the notice may be listed, moved or stop being listed. All earlier versions stay in history.')) return;
          Array.prototype.forEach.call(panel.querySelectorAll('button'), function (x) { x.disabled = true; });
          b.textContent = 'Rolling back…';
          siApi('/admin/recalls/record/rollback?id=' + encodeURIComponent(id), { method: 'POST', body: { expectedRevision: a.revision, toVersion: to } }).then(function (r2) {
            rcCache = null;
            rcShowHistory(id);
            setTimeout(function () { rcNotice(r2.ok ? 'ok' : 'bad', r2.ok ? 'Rolled back. v' + next + ' is live with the decision from ' + from + '.' + rcPagesNote(r2) : rcErrText(r2, 'Rollback failed. The live notice is unchanged.')); }, 60);
          });
        });
      });
      if (v != null && v !== '') rcShowVersion(id, v);
    });
  }
  function rcShowVersion(id, v) {
    var host = $('rcVerDetail');
    if (!host) return;
    host.innerHTML = '<p class="tac__muted">Loading version…</p>';
    siApi('/admin/recalls/record/version?id=' + encodeURIComponent(id) + '&v=' + encodeURIComponent(v)).then(function (res) {
      if (!res.ok) { host.innerHTML = '<p class="kn-sec__empty">' + esc(rcErrText(res, 'Version not found.')) + '</p>'; return; }
      var x = res.body.version || {};
      var e = x.effectWithCurrentSource || {};
      var src = x.sourceAtThatTime;
      host.innerHTML = '<section class="kn-sec si-verview"><h3 class="kn-sec__h">' + esc(x.version === 0 ? 'As ingested' : 'v' + x.version) + '</h3><dl class="kn-ov">'
        + rcRow('Decision', x.decision ? (x.decision.status === 'archived' ? 'Archived' : 'List under ' + rcFamilyName(x.decision.family)) : 'Classifier decision')
        + rcRow('Reason', x.note) + rcRow('By', x.by) + rcRow('At', x.at ? fmtWhen(x.at) : '')
        + rcRow('Effect with the current notice', e.listed ? 'Listed under ' + rcFamilyName(e.family) : 'Not listed')
        + rcRow('Made on the current official content', x.sameSourceAsCurrent ? 'Yes' : 'No — the notice has since been updated by OPSS')
        + '</dl>' + (src ? '<p class="tx__sub">Official content at that time: ' + esc(src.title + ' · alert ' + (src.alertDate || '—')) + '</p>' : '') + '</section>';
    });
  }

  // ---- editor: the listing decision only (draft) -----------------------------------------------------
  function rcShowEditor(id) {
    var panel = $('siDetail');
    if (panel) { panel.hidden = false; panel.innerHTML = '<p class="tac__muted">Loading editor…</p>'; }
    rcOpenId = id;
    rcFetch(id).then(function (res) {
      if (rcOpenId !== id || res.status === 401) return;
      if (!res.ok) { panel.innerHTML = '<p class="kn__empty">' + esc(rcErrText(res, 'This notice cannot be edited right now.')) + '</p>'; return; }
      if (!(res.body.admin && res.body.admin.canEdit)) { panel.innerHTML = '<p class="kn-sec__empty">OPSS has withdrawn this notice. Its listing cannot be changed.</p>'; return; }
      rcRenderEditor(res.body);
    });
  }
  function rcFormState() {
    return { family: $('rcEdFamily') ? $('rcEdFamily').value : '', note: $('rcEdNote') ? $('rcEdNote').value : '' };
  }
  function rcEdStatus() {
    if (!rcEd) return;
    rcEd.dirty = JSON.stringify(rcFormState()) !== rcEd.base;
    var t = rcEd.saving ? 'Saving…' : (rcEd.dirty ? 'Unsaved changes' : (rcEd.justSaved ? 'Draft saved' : (rcEd.hasDraft ? 'Draft saved' : 'Not saved yet')));
    if ($('rcEdDirty')) $('rcEdDirty').textContent = t;
    if ($('rcEdReview')) $('rcEdReview').hidden = !(rcEd.hasDraft && !rcEd.dirty && !rcEd.saving);
  }
  function rcRenderEditor(d) {
    var panel = $('siDetail');
    var a = d.admin || {};
    var dr = a.draft || {};
    var fams = (d.families || (rcCache && rcCache.data && rcCache.data.families) || []);
    if (!fams.length) fams = Object.keys(RC_FAMILY_NAMES).map(function (k) { return { id: k, name: RC_FAMILY_NAMES[k] }; });
    var cur = dr.family || (a.liveDecision && a.liveDecision.status === 'published' ? a.liveDecision.family : '') || d.family || '';
    panel.hidden = false;
    panel.innerHTML = '<form class="kn-ed" id="rcEdForm" novalidate>'
      + '<div class="kn-ed__head"><div><p class="kn-detail__fam">' + esc(a.draft ? 'Editing draft listing decision' : 'New draft listing decision') + '</p>'
      + '<h2 class="kn-detail__title">' + esc(d.title) + '</h2>'
      + '<p class="tx__sub">Saving a draft does not change what customers see. Publish from the notice page when it is ready. The official notice text cannot be edited.</p></div></div>'
      + '<p class="kn-notice" id="rcEdNotice" tabindex="-1" role="alert" hidden></p>'
      + '<section class="kn-ed__sec"><h3 class="kn-ed__sech"><span class="kn-ed__secno" aria-hidden="true">1</span>Source (read-only)</h3><dl class="kn-ov kn-ov--compact">'
      + rcRow('Organisation', d.source && d.source.organisation) + rcRow('Notice id', d.id) + rcRow('PSD number', d.psdNumber)
      + '<dt>Official record</dt><dd><a href="' + esc(d.sourceUrl) + '" target="_blank" rel="noopener noreferrer">' + esc(d.sourceUrl) + '</a></dd>'
      + rcRow('Product', [d.brand, d.productName].filter(Boolean).join(' · ')) + rcRow('Models', (d.notice && d.notice.models || []).join(', '))
      + rcRow('Now', d.stateLabel + (d.familyName ? ' · ' + d.familyName : '')) + '</dl></section>'
      + '<section class="kn-ed__sec"><h3 class="kn-ed__sech"><span class="kn-ed__secno" aria-hidden="true">2</span>Listing decision</h3>'
      + '<div class="kn-ed__field"><label for="rcEdFamily">List this notice under</label><span class="kn-help" id="rcEdFamily-help">The ApplianceClinic appliance family customers will find it under. Required.</span>'
      + '<select id="rcEdFamily" aria-describedby="rcEdFamily-help"><option value="">Choose an appliance family</option>'
      + fams.map(function (f) { return '<option value="' + esc(f.id) + '"' + (f.id === cur ? ' selected' : '') + '>' + esc(f.name) + '</option>'; }).join('')
      + '</select><span class="kn-ed__err" data-err-for="rcEdFamily" hidden></span></div>'
      + '<div class="kn-ed__field"><label for="rcEdNote">Reason</label><span class="kn-help" id="rcEdNote-help">Why this listing is correct (5–300 characters). Recorded in the version history; never shown to customers.</span>'
      + '<textarea id="rcEdNote" rows="3" maxlength="300" aria-describedby="rcEdNote-help">' + esc(dr.note || '') + '</textarea><span class="kn-ed__err" data-err-for="rcEdNote" hidden></span></div>'
      + '<p class="kn-help">To stop listing a notice, use Archive on the notice page instead.</p></section>'
      + '<div class="kn-ed__bar"><span class="kn-ed__dirty" id="rcEdDirty" role="status" aria-live="polite"></span>'
      + '<a class="btn btn--ghost" id="rcEdReview" href="' + esc(rcDetailHref(d.id, { review: '1' })) + '" hidden>Review &amp; publish…</a>'
      + '<button class="btn btn--ghost" type="button" id="rcEdCancel">Cancel</button>'
      + '<button class="btn btn--primary" type="submit" id="rcEdSave">Save draft</button></div></form>';
    var prev = rcEd;
    rcEd = { id: d.id, revision: a.revision || 0, hasDraft: !!a.draft, hash: location.hash, justSaved: !!(prev && prev.justSaved && prev.id === d.id) };
    rcEd.base = JSON.stringify(rcFormState());
    var form = $('rcEdForm');
    form.addEventListener('input', rcEdStatus);
    form.addEventListener('change', rcEdStatus);
    form.addEventListener('submit', function (e) { e.preventDefault(); rcEdSave(); });
    $('rcEdCancel').addEventListener('click', function () {
      var mid = rcEd.id;
      guardThen(function () { rcEd = null; location.hash = rcDetailHref(mid); });
    });
    rcEdStatus();
  }
  function rcEdSave() {
    if (!rcEd || rcEd.saving) return;
    var ed = rcEd;
    ed.saving = true;
    rcEdStatus();
    var st = rcFormState();
    siApi('/admin/recalls/record?id=' + encodeURIComponent(ed.id), { method: 'PATCH', body: { expectedRevision: ed.revision, family: st.family, note: st.note } }).then(function (res) {
      ed.saving = false;
      if (rcEd !== ed) return;
      var form = $('rcEdForm');
      Array.prototype.forEach.call(form.querySelectorAll('[data-err-for]'), function (el) { el.hidden = true; el.textContent = ''; });
      Array.prototype.forEach.call(form.querySelectorAll('[aria-invalid]'), function (el) { el.removeAttribute('aria-invalid'); });
      if (res.ok && res.body) {
        rcCache = null;
        ed.justSaved = true;
        rcRenderEditor(res.body);
        return;
      }
      rcEdStatus();
      if (res.status === 401) return;
      ((res.body && res.body.fields) || []).forEach(function (f) {
        var target = f === 'family' ? 'rcEdFamily' : (f === 'note' ? 'rcEdNote' : null);
        if (!target || !$(target)) return;
        $(target).setAttribute('aria-invalid', 'true');
        var slot = form.querySelector('[data-err-for="' + target + '"]');
        if (slot) { slot.hidden = false; slot.textContent = (res.body && res.body.error) || 'Check this field.'; }
      });
      var el = $('rcEdNotice');
      if (el) { el.hidden = false; el.className = 'kn-notice kn-notice--bad'; el.textContent = 'Not saved. ' + rcErrText(res, 'The draft could not be saved.'); el.focus(); }
    }).catch(function () {
      ed.saving = false;
      rcEdStatus();
      var el = $('rcEdNotice');
      if (el) { el.hidden = false; el.className = 'kn-notice kn-notice--bad'; el.textContent = 'Could not reach the server. Your changes are still in this form.'; }
    });
  }

  // ---- Settings -----------------------------------------------------------
  // Read-only view of the configuration ApplianceClinic uses, plus one staged edit flow for the advisor's model:
  // edit locally → review the change, impact and timing → reason → Apply → server validation + revision check →
  // single whole-document write → read-back confirmation. The credential is write-only and never shown.
  var stView = null;
  var stWired = false;
  // The open model editor for the shared unsaved-changes guard. `dirty` is computed from the dialog field
  // against the value it was opened with (no per-keystroke listeners, no autosave).
  var stEd = null;
  var ST_TEXT = {
    leave: 'You have an unapplied advisor model change. If you leave now it will be discarded. The live configuration is not affected.',
  };
  // Shared-guard discard: close the Settings dialogs so the page beneath matches the discarded state.
  function stDiscardEditor() { if (stEd) stCloseDialogs(); }
  function stApi(path, opts) {
    opts = opts || {};
    return fetch(API_BASE + path, {
      method: opts.method || 'GET',
      credentials: 'same-origin',
      headers: Object.assign({ accept: 'application/json' }, opts.body ? { 'content-type': 'application/json' } : {}),
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    }).then(function (r) {
      if (r.status === 401) { showGate('Your session has expired. Please log in again.'); return { ok: false, status: 401, body: null }; }
      return r.json().then(function (b) { return { ok: r.ok, status: r.status, body: b }; }).catch(function () { return { ok: false, status: r.status, body: null }; });
    }).catch(function () { return { ok: false, status: 0, body: { error: 'Could not reach the server. Nothing was applied.' } }; });
  }
  function stNotice(kind, text) {
    var el = $('stApplyNotice');
    if (!el) return;
    el.hidden = !text;
    el.className = 'kn-notice' + (kind === 'bad' ? ' kn-notice--bad' : (kind === 'ok' ? ' kn-notice--ok' : ''));
    el.textContent = text || '';
    if (text) { try { el.focus({ preventScroll: false }); } catch (e) { el.focus(); } }
  }
  function applySettingsView(d) {
    stView = d;
    var adv = d.advisor || {};
    if ($('stAdvisorCard')) $('stAdvisorCard').innerHTML = St.advisorCardHtml(adv);
    if ($('stAdvisorMeta')) $('stAdvisorMeta').textContent = St.metaLine(adv) + ' · ' + ((adv.propagation && adv.propagation.note) || '');
    var store = adv.store || {};
    if ($('stAdvisorStore')) { $('stAdvisorStore').hidden = !store.note; $('stAdvisorStore').textContent = store.note || ''; }
    if ($('stRuntimeStatus')) $('stRuntimeStatus').innerHTML = St.runtimeStatusHtml(d.runtimeStatus);
    if ($('stHistoryBody')) $('stHistoryBody').innerHTML = St.historyHtml(adv.history);
    var cred = adv.credential || {};
    if ($('stKeyHistoryBody')) $('stKeyHistoryBody').innerHTML = St.historyHtml(cred.history, 'No credential replacements recorded yet.');
    fillRetention(d.transcripts);
    var conv = d.conversation || {};
    if ($('stConversationBody')) $('stConversationBody').innerHTML = St.readOnlyRowHtml('Conversation window', String(conv.windowTurns) + ' recent turns', conv.source, conv.note);
    if ($('stElsewhere')) $('stElsewhere').innerHTML = St.elsewhereHtml(d.elsewhere);
    if ($('stTechnical')) $('stTechnical').innerHTML = St.technicalHtml(d.technical);
    var keyBtn = $('stOpenKey');
    if (keyBtn) keyBtn.textContent = cred.configured ? 'Replace model credential' : 'Add model credential';
    if ($('stKeyImpact')) $('stKeyImpact').textContent = 'Used by: ' + (cred.usedBy || 'the diagnosis engine on every customer turn.')
      + (cred.updatedAt ? ' Last replaced ' + new Date(cred.updatedAt).toLocaleString('en-GB') + (cred.updatedByEmail ? ' by ' + cred.updatedByEmail : '') + '.' : '');
  }
  function loadSettings() {
    var status = $('stStatus');
    if (status) status.textContent = 'Loading configuration…';
    // GET only: viewing Settings never writes anything.
    return stApi('/admin/settings').then(function (res) {
      if (!res.ok || !res.body) { if (status) status.textContent = 'Could not load settings.'; return; }
      applySettingsView(res.body);
      if (status) status.textContent = 'Showing the stored configuration (revision ' + ((res.body.advisor && res.body.advisor.revision) || '—') + ') and what the diagnosis engine reports it is running.';
    });
  }
  function stLoadModelList() {
    var dl = $('stModelsList');
    if (!dl) return;
    stApi('/admin/ai-config/models').then(function (m) {
      if (!m.ok || !m.body || !m.body.models) return;
      dl.innerHTML = '';
      m.body.models.forEach(function (id) { var o = document.createElement('option'); o.value = id; dl.appendChild(o); });
    });
  }
  function stFillEditor() {
    var adv = (stView && stView.advisor) || {};
    if ($('stModel')) $('stModel').value = (adv.configured && adv.configured.model) || '';
    if ($('stEditErr')) $('stEditErr').textContent = '';
  }
  function stProposed() {
    var adv = (stView && stView.advisor) || {};
    return {
      expectedVersion: adv.version || 1,
      expectedRevision: adv.revision || undefined,
      model: (($('stModel') && $('stModel').value) || '').trim(),
    };
  }
  function stWithNote(p) { p.note = ($('stChangeNote') && $('stChangeNote').value.trim()) || undefined; return p; }
  function stEditorOpen() {
    var base = JSON.stringify(stProposed());
    stEd = { hash: location.hash, base: base };
    Object.defineProperty(stEd, 'dirty', { get: function () { var dlg = $('stEditDlg'); return Boolean(dlg && dlg.open && JSON.stringify(stProposed()) !== base); } });
  }
  function stCloseDialogs() {
    ['stConfirmDlg', 'stEditDlg'].forEach(function (id) { var d = $(id); if (d && d.open) d.close(); });
    stEd = null;
  }
  function stSaveProposed(payload) {
    var err = $('stConfirmErr');
    var yes = $('stConfirmYes');
    if (err) { err.textContent = 'Applying…'; err.className = 'st-result'; }
    if (yes) yes.disabled = true;
    return stApi('/admin/settings/model', { method: 'PATCH', body: payload }).then(function (res) {
      if (yes) yes.disabled = false;
      if (res.ok && res.body) {
        var apply = res.body.apply || {};
        applySettingsView(res.body);
        stCloseDialogs();
        if (!apply.written) { stNotice('ok', 'No changes — nothing was written. The live configuration is unchanged.'); return; }
        stNotice(apply.verified ? 'ok' : 'bad', (apply.verified
          ? 'Applied and confirmed stored (version ' + apply.version + '). '
          : (apply.verificationNote ? 'Written. ' + apply.verificationNote + ' ' : 'Written, but the stored configuration could not be re-read to confirm it. Reload Settings to check what is stored. '))
          + (apply.propagation || '') + ' (Running values are from the diagnosis engine health.)');
        var status = $('stStatus'); if (status) status.textContent = 'Change applied. The diagnosis engine takes up to about 2 minutes to use it.';
        return;
      }
      var b = res.body || {};
      if (err) { err.textContent = St.errorText(res, 'Not applied.') + (res.status === 409 ? '' : ' Nothing was changed.'); err.className = 'st-result is-bad'; }
      var reload = $('stConflictReload');
      if (reload) reload.hidden = res.status !== 409;
      if (b.code === 'reason_required' && $('stChangeNote')) { $('stChangeNote').setAttribute('aria-invalid', 'true'); $('stChangeNote').focus(); }
      else if (err) err.focus && err.setAttribute('tabindex', '-1');
    });
  }
  function stOpenReview() {
    var adv = (stView && stView.advisor) || {};
    var payload = stProposed();
    var changes = St.reviewChanges(adv, payload);
    var body = $('stConfirmBody');
    if (body) body.innerHTML = St.reviewHtml(changes, adv.propagation && adv.propagation.note);
    if ($('stChangeNote')) { $('stChangeNote').value = ''; $('stChangeNote').removeAttribute('aria-invalid'); }
    if ($('stConfirmErr')) { $('stConfirmErr').textContent = ''; $('stConfirmErr').className = 'st-result'; }
    if ($('stConflictReload')) $('stConflictReload').hidden = true;
    if ($('stConfirmYes')) $('stConfirmYes').disabled = !changes.length;
    var dlg = $('stConfirmDlg');
    if (dlg && dlg.showModal) dlg.showModal();
    if ($('stChangeNote') && changes.length) $('stChangeNote').focus();
  }
  function wireSettings() {
    if (stWired) return;
    stWired = true;
    if ($('stRefresh')) $('stRefresh').addEventListener('click', loadSettings);
    if ($('stEditModel')) $('stEditModel').addEventListener('click', function () {
      stFillEditor();
      stLoadModelList();
      var dlg = $('stEditDlg');
      if (dlg && dlg.showModal) dlg.showModal();
      stEditorOpen();
      if ($('stModel')) $('stModel').focus();
    });
    // Escape / Cancel on a changed editor asks first; closing always clears the editor state.
    var editDlg = $('stEditDlg');
    if (editDlg) {
      editDlg.addEventListener('cancel', function (e) {
        if (stEd && stEd.dirty && !window.confirm('Discard this unapplied change? The live configuration is not affected.')) e.preventDefault();
      });
      editDlg.addEventListener('close', function () { stEd = null; });
    }
    if ($('stEditCancel')) $('stEditCancel').addEventListener('click', function (e) {
      if (stEd && stEd.dirty && !window.confirm('Discard this unapplied change? The live configuration is not affected.')) e.preventDefault();
    });
    // Review step: the change + impact + timing are shown BEFORE anything is written.
    if ($('stEditSave')) $('stEditSave').addEventListener('click', function () {
      var dlg = $('stConfirmDlg');
      if (dlg && dlg.showModal) stOpenReview();
    });
    if ($('stConfirmYes')) $('stConfirmYes').addEventListener('click', function () { stSaveProposed(stWithNote(stProposed())); });
    if ($('stConflictReload')) $('stConflictReload').addEventListener('click', function () {
      stCloseDialogs();
      loadSettings().then(function () { stNotice('bad', 'Settings were reloaded because they changed since you opened the page. Review the current values, then make your change again.'); });
    });
    if ($('stOpenKey')) $('stOpenKey').addEventListener('click', function () {
      var kdlg = $('stKeyDlg');
      if (kdlg && kdlg.showModal) kdlg.showModal();
      if ($('stApiKey')) $('stApiKey').focus();
    });
    var stVal = function (id) { return ($(id) && $(id).value.trim()) || ''; };
    // The credential dialog is guarded like the model editor (browser Back / tab close).
    guardForm('stKeyDlg', { el: $('stKeyDlg'), hash: '#settings',
      isDirty: function () { var d = $('stKeyDlg'); return Boolean(d && d.open && stVal('stApiKey')); },
      discard: function () { var d = $('stKeyDlg'); if ($('stApiKey')) $('stApiKey').value = ''; if (d && d.open) d.close(); },
      leave: 'You have typed a credential that has not been stored. If you leave now it will be cleared. The stored credential is not affected.' });
    if ($('stSaveKey')) $('stSaveKey').addEventListener('click', function () {
      var key = stVal('stApiKey');
      var out = $('stKeyResult');
      if (!key) { if (out) { out.textContent = 'Enter a key to store. Blank does not delete the existing credential.'; out.className = 'st-result is-bad'; } return; }
      if (!window.confirm('Replacing the credential changes the key the diagnosis engine uses for live customer replies within about 2 minutes. Continue?')) return;
      if (out) { out.textContent = 'Saving…'; out.className = 'st-result'; }
      stApi('/admin/ai-config/key', { method: 'POST', body: { apiKey: key } }).then(function (res) {
        if (res.ok) {
          if ($('stApiKey')) $('stApiKey').value = '';
          if (out) { out.textContent = 'Credential stored. It is never shown again.'; out.className = 'st-result is-ok'; }
          loadSettings();
        } else if (out) { out.textContent = (res.body && res.body.error) || 'Could not store the credential.'; out.className = 'st-result is-bad'; }
      });
    });
    if ($('stTestConnection')) $('stTestConnection').addEventListener('click', function () {
      var out = $('stTestResult');
      if (out) { out.textContent = 'Checking…'; out.className = 'st-result'; }
      stApi('/admin/ai-config/test', { method: 'POST', body: {} }).then(function (res) {
        var r = res.body || {};
        var ok = r.status === 'ONLINE';
        var labels = { ONLINE: 'Reachable', OFFLINE: 'Could not reach it', CONFIG_ERROR: 'Setup problem', MODEL_ERROR: 'Model problem' };
        var txt = (labels[r.status] || r.status || 'Could not check') + (r.detail ? ' — ' + r.detail : '');
        if (ok && r.latencyMs != null) txt += ' (' + r.latencyMs + ' ms)';
        if (out) { out.textContent = txt; out.className = 'st-result ' + (ok ? 'is-ok' : 'is-bad'); }
      });
    });
  }
  wireSettings();


  // ===== Test area: the live diagnostic workbench ==========================
  var wbPageWired = false;
  function ensureTestPage() {
    if (!wbPageWired) { wbPageWired = true; wbWire(); }
  }

  // ===== Live diagnostic workbench (primary Test ApplianceClinic) ===========
  // Posts { messages } to the same /api diagnose path as the customer product.
  // Never sends observability, never persists to customer localStorage, never
  // invents an assistant reply on failure.
  var Session = window.ACChatSession;
  var Workbench = window.TacWorkbench;
  // One Live Test conversation (tac-workbench.js): the customer client's message window + the opaque
  // canonical state token from the last response, echoed back verbatim. In memory only — never
  // persisted, never shown. wbMessages is the conversation's message list.
  var wbConv = Workbench && Workbench.createLiveConversation ? Workbench.createLiveConversation() : { messages: [], turns: [], stateToken: null, stateProblem: null };
  var wbMessages = wbConv.messages;
  var wbBusy = false;
  var wbPendingImage = null;
  var wbLastError = null;
  var wbLastView = null;
  var wbLastDurationMs = null;
  var wbWired = false;
  var WB_MAX_IMAGE_WIDTH = 800;
  var WB_JPEG_QUALITY = 0.7;

  function wbEl(id) { return document.getElementById(id); }
  function wbNode(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }
  function wbFormatPrice(pence, currency) {
    var pounds = (pence / 100).toFixed(2);
    return (currency === 'GBP' || !currency ? '£' : '') + pounds;
  }
  function wbFitBadge(status) {
    if (status === 'MODEL_CONFIRMED') return wbNode('span', 'fit fit--confirmed', 'Confirmed fit for your model');
    return wbNode('span', 'fit fit--verify', 'Likely fit — please check');
  }
  function wbOfferNote(status) {
    return status === 'MODEL_CONFIRMED'
      ? 'Matched to your model number.'
      : 'Brand-compatible — check it suits your exact model before buying.';
  }
  function wbSafeEmbedUrl(u) {
    try {
      var url = new URL(String(u));
      if (url.protocol !== 'https:') return null;
      var h = url.hostname.toLowerCase();
      return (h === 'www.youtube-nocookie.com' || h === 'youtube-nocookie.com') ? url.href : null;
    } catch (e) { return null; }
  }
  function wbOpenMediaLightbox(src, alt) {
    var ov = wbNode('div', 'media-lightbox');
    ov.setAttribute('role', 'dialog');
    ov.setAttribute('aria-modal', 'true');
    var big = document.createElement('img');
    big.src = src; big.alt = alt || '';
    var close = wbNode('button', 'media-lightbox__close');
    close.type = 'button';
    close.setAttribute('aria-label', 'Close larger view');
    close.textContent = '×';
    function shut() { if (ov.parentNode) ov.parentNode.removeChild(ov); document.removeEventListener('keydown', onKey); }
    function onKey(e) { if (e.key === 'Escape') shut(); }
    ov.addEventListener('click', function (e) { if (e.target === ov) shut(); });
    close.addEventListener('click', shut);
    document.addEventListener('keydown', onKey);
    ov.appendChild(big);
    ov.appendChild(close);
    document.body.appendChild(ov);
  }
  function wbAlreadyShownSafety(text) {
    var t = String(text || '').trim();
    if (!t) return false;
    return wbMessages.some(function (m) {
      if (!m || m.role !== 'assistant' || !m.safetyInformation) return false;
      var shown = m.safetyInformation;
      var shownText = typeof shown === 'string' ? shown : shown.text;
      return String(shownText || '').trim() === t;
    });
  }
  function wbRenderSafety(si) {
    var cls = String(si.classification || '').toLowerCase().replace(/_/g, '-');
    var wrap = wbNode('div', 'safety-info' + (cls ? ' safety-info--' + cls : ''));
    var head = wbNode('div', 'safety-info__head');
    head.appendChild(wbNode('span', 'safety-info__icon', '⚠'));
    head.appendChild(wbNode('span', 'safety-info__title', 'Safety information'));
    wrap.appendChild(head);
    wrap.appendChild(wbNode('p', 'safety-info__text', si.text));
    return wrap;
  }
  function wbRenderMedia(items) {
    var wrap = wbNode('div', 'media');
    wrap.appendChild(wbNode('div', 'media__head', 'Helpful to see'));
    items.slice(0, 4).forEach(function (m) {
      var about = (m.intent === 'ABOUT');
      var card = wbNode('div', 'media__item media__item--' + (m.type === 'VIDEO' ? 'video' : 'image')
        + ' media__item--' + (about ? 'about' : 'check'));
      if (about) card.appendChild(wbNode('div', 'media__intent', 'About this part · helpful to identify'));
      card.appendChild(wbNode('div', 'media__title', m.title || (about ? 'About this part' : 'How-to')));
      if (m.type === 'VIDEO') {
        var embed = wbSafeEmbedUrl(m.embedUrl);
        if (embed) {
          var frame = wbNode('div', 'media__video');
          var ifr = document.createElement('iframe');
          ifr.src = embed;
          ifr.title = m.title || 'Instructional video';
          ifr.loading = 'lazy';
          ifr.setAttribute('allow', 'fullscreen; picture-in-picture; encrypted-media');
          ifr.setAttribute('allowfullscreen', '');
          ifr.setAttribute('referrerpolicy', 'strict-origin-when-cross-origin');
          ifr.setAttribute('frameborder', '0');
          frame.appendChild(ifr);
          card.appendChild(frame);
        }
        if (m.caption) card.appendChild(wbNode('div', 'media__caption', m.caption));
        var attrib = wbNode('div', 'media__attrib');
        if (m.attribution) attrib.appendChild(wbNode('span', 'media__by', m.attribution));
        if (!about && m.sourcePageUrl && /^https:\/\//i.test(m.sourcePageUrl)) {
          var link = document.createElement('a');
          link.className = 'media__guide';
          link.href = m.sourcePageUrl; link.target = '_blank'; link.rel = 'noopener noreferrer';
          link.textContent = 'View full repair guide';
          attrib.appendChild(link);
        }
        if (attrib.childNodes.length) card.appendChild(attrib);
      } else if (m.url) {
        var zoom = wbNode('button', 'media__zoom');
        zoom.type = 'button';
        zoom.setAttribute('aria-label', 'Open a larger view of ' + (m.title || 'the diagram'));
        var im = document.createElement('img');
        im.className = 'media__img';
        im.src = m.url;
        im.alt = m.alt || m.title || 'Instructional diagram';
        im.loading = 'lazy';
        im.onerror = function () { card.style.display = 'none'; };
        zoom.appendChild(im);
        zoom.addEventListener('click', function () { wbOpenMediaLightbox(m.url, im.alt); });
        card.appendChild(zoom);
        if (m.description) card.appendChild(wbNode('div', 'media__caption', m.description));
      }
      wrap.appendChild(card);
    });
    return wrap;
  }
  function wbRenderParts(parts) {
    var wrap = wbNode('div', 'parts');
    parts.forEach(function (p) {
      var card = wbNode('div', 'part');
      if (p.imageUrl) {
        var im = document.createElement('img');
        im.className = 'part__img';
        im.src = p.imageUrl;
        im.alt = p.name || 'Part';
        im.loading = 'lazy';
        im.onerror = function () { im.remove(); };
        card.appendChild(im);
      }
      var partBody = wbNode('div', 'part__body');
      partBody.appendChild(wbNode('div', 'part__name', p.name || 'Part'));
      var row = wbNode('div', 'part__row');
      var offer = (p.offers && p.offers[0]) || null;
      if (offer && typeof offer.price === 'number') {
        row.appendChild(wbNode('div', 'part__price', wbFormatPrice(offer.price, offer.currency)));
      }
      row.appendChild(wbFitBadge(p.fitStatus));
      partBody.appendChild(row);
      if (offer && offer.url) {
        var a = document.createElement('a');
        a.className = 'part__cta';
        a.href = offer.url;
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
        a.textContent = 'View at ' + (offer.retailer || 'retailer') + ' →';
        partBody.appendChild(a);
        partBody.appendChild(wbNode('div', 'offer-note', wbOfferNote(p.fitStatus)));
      }
      card.appendChild(partBody);
      wrap.appendChild(card);
    });
    return wrap;
  }
  function wbAddUserTurn(thread, text, image) {
    var wrap = wbNode('div', 'wb-turn wb-turn--user');
    wrap.appendChild(wbNode('div', 'wb-speaker', 'You / test customer'));
    var turn = wbNode('div', 'turn turn--user');
    if (image) {
      var im = document.createElement('img');
      im.className = 'bubble__img';
      im.src = image;
      im.alt = 'Uploaded photo';
      turn.appendChild(im);
    }
    var label = text || (Session && Session.PHOTO_ONLY_LABEL) || 'Photo of rating plate';
    turn.appendChild(wbNode('div', 'bubble', label));
    wrap.appendChild(turn);
    thread.appendChild(wrap);
  }
  function wbAddBotTurn(thread, view, turnMeta) {
    var wrap = wbNode('div', 'wb-turn wb-turn--bot');
    wrap.appendChild(wbNode('div', 'wb-speaker', 'ApplianceClinic'));
    var meta = wbTurnMetaText(view, turnMeta);
    if (meta) wrap.appendChild(wbNode('p', 'wb-turnmeta' + (meta.problem ? ' wb-turnmeta--problem' : ''), meta.text));
    var turn = wbNode('div', 'turn turn--bot');
    var resp = wbNode('div', 'response');
    var reply = view.reply || '';
    var summary = (view.diagnosis && view.diagnosis.summary) || '';
    var lead = reply;
    var bodyText = '';
    if (summary && reply.indexOf(summary) === 0 && reply.length > summary.length) {
      lead = summary;
      bodyText = reply.slice(summary.length).replace(/^\s+/, '');
    }
    if (lead) {
      var leadEl = wbNode('p', 'response__lead');
      leadEl.textContent = lead;
      resp.appendChild(leadEl);
    }
    if (bodyText) {
      var bodyEl = wbNode('div', 'response__body');
      bodyEl.textContent = bodyText;
      resp.appendChild(bodyEl);
    }
    turn.appendChild(resp);
    if (view.safetyInformation && view.safetyInformation.text && !wbAlreadyShownSafety(view.safetyInformation.text)) {
      turn.appendChild(wbRenderSafety(view.safetyInformation));
    }
    if (Array.isArray(view.media) && view.media.length) turn.appendChild(wbRenderMedia(view.media));
    if (Array.isArray(view.parts) && view.parts.length) {
      turn.appendChild(wbNode('div', 'parts__head', view.parts.length > 1 ? 'Parts you may need' : 'The part you may need'));
      turn.appendChild(wbRenderParts(view.parts));
    }
    wrap.appendChild(turn);
    thread.appendChild(wrap);
  }
  function wbRenderEmpty(thread) {
    thread.innerHTML = '';
    var empty = wbNode('div', 'wb-empty');
    empty.innerHTML = '<strong>Start a test conversation.</strong> Type a realistic customer problem and send it through the live diagnostic system.<br><code>my bosch washer wont drain</code>';
    thread.appendChild(empty);
  }
  function wbReplayThread() {
    var thread = wbEl('wbThread');
    if (!thread) return;
    thread.innerHTML = '';
    if (!wbMessages.length) { wbRenderEmpty(thread); return; }
    wbMessages.forEach(function (m) {
      if (!m) return;
      if (m.role === 'user') wbAddUserTurn(thread, m.display || m.content, m.image);
      else if (m.role === 'assistant' && m.view) wbAddBotTurn(thread, m.view, m.turn);
    });
    thread.scrollTop = thread.scrollHeight;
  }
  function wbAddThinking() {
    var thread = wbEl('wbThread');
    if (!thread) return { remove: function () {} };
    var empty = thread.querySelector('.wb-empty');
    if (empty) empty.remove();
    var wrap = wbNode('div', 'wb-turn wb-turn--bot wb-waiting');
    wrap.setAttribute('aria-live', 'polite');
    wrap.appendChild(wbNode('div', 'wb-speaker', 'ApplianceClinic'));
    var turn = wbNode('div', 'turn turn--bot turn--thinking');
    var t = wbNode('div', 'thinking');
    t.innerHTML = '<span></span><span></span><span></span>';
    var status = wbNode('div', 'thinking__status', 'Reading what you’ve told me…');
    turn.appendChild(t);
    turn.appendChild(status);
    wrap.appendChild(turn);
    thread.appendChild(wrap);
    thread.scrollTop = thread.scrollHeight;
    var stages = [
      'Reading what you’ve told me…',
      'Diagnosing the most likely fault…',
      'Checking the engineering knowledge…',
      'Finding the right part…',
    ];
    var i = 0;
    var timer = setInterval(function () {
      i = Math.min(i + 1, stages.length - 1);
      status.textContent = stages[i];
    }, 7000);
    return {
      remove: function () {
        clearInterval(timer);
        wrap.remove();
      },
    };
  }
  function wbSetBusy(v) {
    wbBusy = v;
    var send = wbEl('wbSend');
    var photo = wbEl('wbPhoto');
    var thread = wbEl('wbThread');
    if (send) {
      // Also held while a conversation-state problem waits for the admin's explicit choice.
      send.disabled = v || Boolean(wbConv && wbConv.stateProblem);
      send.setAttribute('aria-busy', v ? 'true' : 'false');
    }
    if (photo) photo.disabled = v;
    if (thread) thread.setAttribute('aria-busy', v ? 'true' : 'false');
  }
  function wbHideError() {
    wbLastError = null;
    var box = wbEl('wbError');
    if (box) box.hidden = true;
  }
  function wbShowError(err, extra) {
    wbLastError = err;
    var box = wbEl('wbError');
    if (!box) return;
    box.hidden = false;
    var text = wbEl('wbErrorText');
    var tech = wbEl('wbErrorTech');
    if (text) text.textContent = 'The conversation is unchanged. No ApplianceClinic answer was added.';
    if (tech) tech.textContent = [err && err.message, extra].filter(Boolean).join(' · ');
  }
  // One line under each ApplianceClinic turn: turn number, continuity, diagnostic status, time.
  function wbTurnMetaText(view, turnMeta) {
    var st = view && view.liveTest;
    if (!st && !turnMeta) return null;
    var bits = [];
    if (turnMeta && turnMeta.index) bits.push('Turn ' + turnMeta.index);
    if (st) {
      bits.push('State: ' + (Workbench ? Workbench.continuityLabel(st) : st.continuity));
      if (st.audit && st.audit.outcome) bits.push(String(st.audit.outcome).replace(/_/g, ' '));
    }
    if (turnMeta && typeof turnMeta.durationMs === 'number') bits.push((Math.round(turnMeta.durationMs / 100) / 10) + ' s');
    var problem = Boolean(st && (st.continuity === 'restarted' || st.continuity === 'unavailable' || st.continuity === 'failed'));
    return { text: bits.join(' \u00b7 '), problem: problem };
  }
  // Conversation state strip + the rejected/not-renewed alert. Status only: never the token.
  function wbRenderState() {
    var el = wbEl('wbState');
    var box = wbEl('wbStateProblem');
    if (!Workbench || !Workbench.stateSummary) return;
    var sum = Workbench.stateSummary(wbConv);
    if (el) {
      var parts = ['Conversation state: ' + sum.label];
      if (sum.turns) parts.push(sum.turns + ' customer turn' + (sum.turns === 1 ? '' : 's'));
      parts.push('state token ' + (sum.tokenPresent ? 'held' : 'none'));
      el.textContent = parts.join(' \u00b7 ');
      el.setAttribute('data-state', sum.kind);
    }
    var send = wbEl('wbSend');
    if (box) {
      var p = wbConv.stateProblem;
      box.hidden = !p;
      var msgEl = wbEl('wbStateProblemText');
      if (msgEl) msgEl.textContent = p ? Workbench.problemMessage(p) : '';
      var cont = wbEl('wbStateContinue');
      if (cont) cont.hidden = !(p && p.kind === 'restarted');
    }
    if (send && !wbBusy) send.disabled = Boolean(wbConv.stateProblem);
  }
  function wbRenderSummary(view) {
    var el = wbEl('wbSummary');
    if (!el || !Workbench) return;
    if (!view) { el.hidden = true; el.innerHTML = ''; return; }
    var s = Workbench.compactSummary(view);
    el.hidden = false;
    el.innerHTML =
      '<span class="wb-chip' + (s.safetyStop ? ' wb-chip--stop' : (s.safetyKind === 'info' ? ' wb-chip--info' : '')) + '">Safety: ' + esc(s.safety) + '</span>' +
      '<span class="wb-chip">Parts: ' + esc(String(s.parts)) + '</span>' +
      '<span class="wb-chip">Media: ' + esc(String(s.media)) + '</span>';
  }
  function wbRenderInspect(view, meta) {
    var el = wbEl('wbInspectBody');
    if (!el || !Workbench) return;
    if (!view) {
      el.innerHTML = '<p class="tac__muted">Send a message to inspect what the live system returned.</p>';
      return;
    }
    var inspected = Workbench.inspectView(view, meta);
    // Conversation-state continuity first (booleans / safe ref only; the token itself is never shown).
    if (view.liveTest && Workbench.continuityRows) {
      var cRows = Workbench.continuityRows(view.liveTest, meta && meta.turn).filter(Boolean);
      if (cRows.length) inspected.sections.unshift({ id: 'continuity', title: 'Conversation state', rows: cRows });
    }
    if (!inspected.sections.length) {
      el.innerHTML = '<p class="tac__muted">This response did not include extra diagnostic fields.</p>';
      return;
    }
    el.innerHTML = inspected.sections.map(function (sec) {
      return '<section class="wb-inspect__section" data-inspect="' + esc(sec.id) + '">' +
        '<h3 class="wb-inspect__h">' + esc(sec.title) + '</h3>' +
        '<dl>' + sec.rows.map(function (r) {
          return '<div class="wb-inspect__row"><dt>' + esc(r.label) + '</dt><dd>' + esc(r.value) + '</dd></div>';
        }).join('') + '</dl></section>';
    }).join('');
  }
  function wbRenderRaw(requestBody, view, error) {
    var el = wbEl('wbRawBody');
    if (!el || !Workbench) return;
    if (!requestBody && !view && !error) {
      el.innerHTML = '<p class="tac__muted">Request and response payloads appear here after a turn. Image bytes are redacted.</p>';
      return;
    }
    var payload = Workbench.rawPayload(requestBody, view, error);
    el.innerHTML = '<pre>' + esc(JSON.stringify(payload, null, 2)) + '</pre>';
  }
  function wbClearPendingImage() {
    wbPendingImage = null;
    var preview = wbEl('wbPreview');
    var img = wbEl('wbPreviewImg');
    if (preview) preview.hidden = true;
    if (img) img.removeAttribute('src');
  }
  function wbSetPendingImage(dataUrl) {
    wbPendingImage = dataUrl;
    var preview = wbEl('wbPreview');
    var img = wbEl('wbPreviewImg');
    if (img) img.src = dataUrl;
    if (preview) preview.hidden = false;
  }
  function wbCompressImage(dataUrl) {
    return new Promise(function (resolve) {
      var img = new Image();
      img.onload = function () {
        var w = img.width, h = img.height;
        if (w > WB_MAX_IMAGE_WIDTH) { h = Math.round((h * WB_MAX_IMAGE_WIDTH) / w); w = WB_MAX_IMAGE_WIDTH; }
        var canvas = document.createElement('canvas');
        canvas.width = w; canvas.height = h;
        canvas.getContext('2d').drawImage(img, 0, 0, w, h);
        resolve(canvas.toDataURL('image/jpeg', WB_JPEG_QUALITY));
      };
      img.onerror = function () { resolve(dataUrl); };
      img.src = dataUrl;
    });
  }
  function wbProcessImageFile(file) {
    if (!file || !file.type || file.type.indexOf('image/') !== 0) return;
    if (file.size > 20 * 1024 * 1024) return;
    var reader = new FileReader();
    reader.onload = function () { wbCompressImage(reader.result).then(wbSetPendingImage); };
    reader.readAsDataURL(file);
  }
  function wbReset(opts) {
    opts = opts || {};
    // Reset = a new Live Test conversation: messages, state token, session key and per-turn metadata
    // are all dropped, so the next message can never carry the previous conversation's state.
    if (Workbench && Workbench.resetLiveConversation) Workbench.resetLiveConversation(wbConv);
    else { wbConv.messages = []; wbConv.turns = []; wbConv.stateToken = null; wbConv.stateProblem = null; }
    wbMessages = wbConv.messages;
    wbLastError = null;
    wbLastView = null;
    wbLastDurationMs = null;
    wbClearPendingImage();
    var input = wbEl('wbInput');
    if (input && !opts.keepDraft) input.value = '';
    wbHideError();
    wbRenderSummary(null);
    wbRenderInspect(null);
    wbRenderRaw(null, null, null);
    wbRenderState();
    wbReplayThread();
  }
  function wbDiagnose() {
    if (!Session || !Workbench) {
      wbShowError(new Error('Workbench session helpers failed to load.'));
      return;
    }
    // Same body as the customer client (messages window + last stateToken) plus the admin-only liveTest keys.
    var body = Workbench.buildDiagnoseBody(wbMessages, Session, wbConv);
    if (Workbench.usesObservability(body)) {
      wbShowError(new Error('Refusing to send observability on a test conversation.'));
      return;
    }
    var started = Date.now();
    var thinking = wbAddThinking();
    wbSetBusy(true);
    fetch(API_BASE, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }).then(function (r) {
      return r.text().then(function (raw) {
        var parsed;
        try { parsed = raw ? JSON.parse(raw) : null; } catch (e) { parsed = null; }
        return { ok: r.ok, status: r.status, body: parsed, raw: raw };
      });
    }).then(function (res) {
      thinking.remove();
      wbLastDurationMs = Date.now() - started;
      var turnRec = Workbench.currentTurn ? Workbench.currentTurn(wbConv) : null;
      if (turnRec) turnRec.durationMs = wbLastDurationMs;
      if (!res.ok || !res.body || typeof res.body.reply !== 'string') {
        var msg = res.status === 401 ? 'Your admin session has expired — log in again to continue this test.' : ((res.body && (res.body.error || res.body.message)) || ('HTTP ' + res.status));
        if (turnRec) turnRec.error = msg;
        wbShowError(new Error(msg), 'status ' + res.status);
        wbRenderRaw(body, res.body, msg);
        wbRenderInspect(wbLastView, {
          durationMs: wbLastDurationMs,
          windowCount: (body.messages || []).length,
          windowCap: Session.MAX_API_MESSAGES,
        });
        return;
      }
      var view = res.body;
      wbHideError();
      // Store the replacement token exactly as the customer client does; flag rejected/missing state.
      Workbench.acceptResponse(wbConv, view, Session);
      var stored = wbMessages[wbMessages.length - 1];
      if (stored && stored.role === 'assistant') stored.turn = turnRec ? { index: turnRec.index, durationMs: turnRec.durationMs } : null;
      wbLastView = stored && stored.view ? stored.view : view;
      var thread = wbEl('wbThread');
      if (thread) {
        var empty = thread.querySelector('.wb-empty');
        if (empty) empty.remove();
        wbAddBotTurn(thread, wbLastView, stored && stored.turn);
        thread.scrollTop = thread.scrollHeight;
      }
      var meta = {
        requestId: view.requestId,
        durationMs: wbLastDurationMs,
        windowCount: (body.messages || []).length,
        windowCap: Session.MAX_API_MESSAGES,
      };
      meta.turn = turnRec;
      wbRenderSummary(view);
      wbRenderInspect(wbLastView, meta);
      wbRenderRaw(body, view, null);
      wbRenderState();
    }).catch(function (err) {
      thinking.remove();
      wbLastDurationMs = Date.now() - started;
      wbShowError(err || new Error('Network error'));
      wbRenderRaw(body, null, err && err.message);
    }).finally(function () {
      wbSetBusy(false);
      var input = wbEl('wbInput');
      if (input) input.focus();
    });
  }
  function wbSubmit() {
    if (wbBusy) return;
    if (Workbench && Workbench.canSend && !Workbench.canSend(wbConv)) { wbRenderState(); var pb = wbEl('wbStateProblem'); if (pb) pb.focus(); return; }
    var input = wbEl('wbInput');
    var text = input ? String(input.value || '').trim() : '';
    if (!text && !wbPendingImage) return;
    wbHideError();
    var image = wbPendingImage;
    var prompt = (Session && Session.PHOTO_PROMPT) || '';
    var display = text || ((Session && Session.PHOTO_ONLY_LABEL) || 'Photo of rating plate');
    var content = text || prompt;
    var thread = wbEl('wbThread');
    if (thread) {
      var empty = thread.querySelector('.wb-empty');
      if (empty) empty.remove();
      wbAddUserTurn(thread, display, image);
      thread.scrollTop = thread.scrollHeight;
    }
    Workbench.addUserTurn(wbConv, content, { display: display, image: image });
    if (input) input.value = '';
    wbClearPendingImage();
    wbDiagnose();
  }
  function wbRetry() {
    if (wbBusy) return;
    if (!Workbench || !Workbench.canRetry(wbMessages, wbLastError || true)) return;
    wbHideError();
    wbDiagnose();
  }
  function wbNewTest() {
    if (wbBusy) return;
    if (wbMessages.length) {
      var ok = window.confirm('Start a new conversation? This resets the Live Test conversation and its conversation state. It does not change production conversations or knowledge.');
      if (!ok) return;
    }
    wbReset();
    var input = wbEl('wbInput');
    if (input) input.focus();
  }
  function wbWire() {
    if (wbWired) return;
    wbWired = true;
    wbRenderEmpty(wbEl('wbThread'));
    var form = wbEl('wbForm');
    if (form) form.addEventListener('submit', function (e) { e.preventDefault(); wbSubmit(); });
    var input = wbEl('wbInput');
    if (input) input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); if (!wbBusy) wbSubmit(); }
    });
    if (wbEl('wbNewTest')) wbEl('wbNewTest').addEventListener('click', wbNewTest);
    if (wbEl('wbStateNew')) wbEl('wbStateNew').addEventListener('click', function () { wbReset(); var i = wbEl('wbInput'); if (i) i.focus(); });
    if (wbEl('wbStateContinue')) wbEl('wbStateContinue').addEventListener('click', function () {
      // Explicit choice: carry on with the session the API issued, as a customer's browser would.
      if (Workbench && Workbench.acknowledgeStateProblem) Workbench.acknowledgeStateProblem(wbConv);
      wbRenderState();
      var i = wbEl('wbInput'); if (i) i.focus();
    });
    wbRenderState();
    if (wbEl('wbRetry')) wbEl('wbRetry').addEventListener('click', wbRetry);
    if (wbEl('wbPhoto')) wbEl('wbPhoto').addEventListener('click', function () { var f = wbEl('wbFile'); if (f) f.click(); });
    if (wbEl('wbFile')) wbEl('wbFile').addEventListener('change', function () {
      var f = wbEl('wbFile');
      if (f && f.files && f.files[0]) wbProcessImageFile(f.files[0]);
      if (f) f.value = '';
    });
    if (wbEl('wbPreviewRemove')) wbEl('wbPreviewRemove').addEventListener('click', wbClearPendingImage);
  }

  checkSession();
})();
