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
  var dashPeriod = '7d';

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
        writeHash('dashboard', { period: dashPeriod || '7d' }, true);
        loadDashboard(dashPeriod || '7d');
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
  function isoDate(iso) { return String(iso || '').slice(0, 10); }
  function dashDates(prod) {
    var w = (prod && prod.period) || {};
    return { from: isoDate(w.from), to: isoDate(w.to) };
  }
  function transcriptsHref(extra, prod) {
    var dates = dashDates(prod);
    var params = { from: dates.from, to: dates.to };
    Object.keys(extra || {}).forEach(function (k) { params[k] = extra[k]; });
    return hashString('transcripts', params);
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
      + '<div class="dash-health__parts">' + esc(h.summaryLine || 'API · Diagnostics · RAG · Error codes') + '</div></div>'
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
        + (tone === 'bad' ? '<span class="pill pill--bad">Action needed</span> ' : (tone === 'warn' ? '<span class="pill pill--warn">Temporary</span> ' : ''))
        + esc(value) + (href ? ' <a class="dash-link" href="' + esc(href) + '">' + esc(linkText) + '</a>' : '') + '</dd></div>');
    }
    var na = function (x) { return !x || x.unavailable; };
    var c = s.canonical || {};
    row('Canonical journeys', c.mode === 'control' ? 'Control · ' + c.journeys + ' journeys' : (c.mode === 'shadow' ? 'Shadow (not customer-facing)' + (c.demoted ? ' · control allow-list empty' : '') : 'Off'), null, '#diagnostics', 'Diagnostics');
    var r = s.routing;
    row('AI routing', na(r) ? 'Could not be read' : 'UNDERSTAND ' + r.understand + ' · COMPOSE ' + r.compose + (r.composeModel ? ' (' + r.composeModel + ')' : ''), null, '#settings', 'Settings');
    var o = s.override;
    if (na(o)) row('Batch routing override', 'Could not be read', null, '#test?tab=batch', 'Test');
    else if (o.blocked || o.state === 'restore_failed') row('Batch routing override', (o.blocked ? 'Restore conflict' : 'Restore failed') + ' · run ' + (o.runId || '—'), 'bad', '#test?tab=batch', 'Resolve in Test');
    else if (o.active) row('Batch routing override', 'Active · run ' + (o.runId || '—') + ' · live routing is temporary until it ends', 'warn', '#test?tab=batch', 'Test');
    else row('Batch routing override', 'None active', null, '#test?tab=batch', 'Test');
    var e = s.errorCodes;
    row('Error Codes', na(e) ? 'Could not be read' : (e.active != null ? e.active + ' active' : 'Count unavailable') + ' · ' + (e.overlay && e.overlay !== 'none' ? 'Admin overlay ' + e.overlay : 'no Admin overlay'), na(e) || e.ok ? null : 'bad', '#error-codes', 'Error Codes');
    var m = s.media;
    row('Media', na(m) ? 'Could not be read' : (m.overlay === 'present' ? 'Admin overlay in use · ' + m.records + ' record' + (m.records === 1 ? '' : 's') : 'No Admin overlay (shipped catalogue)'), null, '#media', 'Media');
    var rc = s.recalls;
    row('Recall notices', na(rc) || rc.listed == null ? 'Could not be read' : rc.listed + ' listed' + (rc.lastSuccessAt ? ' · last ingest ' + fmtWhen(rc.lastSuccessAt) : ''), null, '#safety?tab=notices', 'Safety');
    return '<dl class="dash-state">' + rows.join('') + '</dl>';
  }

  function renderAttention(prod) {
    var att = (prod && prod.attention) || {};
    var n = att.conversations || 0;
    if (!n) return emptyLine('Nothing in this period needs attention.');
    var html = '<p class="dash-attn__total">' + n + ' conversation' + (n === 1 ? '' : 's') + ' need' + (n === 1 ? 's' : '') + ' attention '
      + '<a class="dash-link" href="' + esc(transcriptsHref({ attention: '1' }, prod)) + '">View conversations</a></p>';
    html += '<div class="dash-rows">';
    if (att.important) html += countRow(transcriptsHref({ priority: 'important' }, prod), 'Important', att.important);
    if (att.worthReviewing) html += countRow(transcriptsHref({ priority: 'worth_reviewing' }, prod), 'Worth reviewing', att.worthReviewing);
    if (att.poor) html += countRow(transcriptsHref({ overall: 'poor' }, prod), 'Poor', att.poor);
    if (att.safetyConcern) html += countRow(transcriptsHref({ safetyHandling: 'concern' }, prod), 'Safety concern', att.safetyConcern);
    if (att.significantLooping) html += countRow(transcriptsHref({ looping: 'significant' }, prod), 'Significant conversation-flow issue', att.significantLooping);
    html += '</div>';
    html += '<p class="dash-note">Each conversation is counted once. The rows below are reasons, not extra incidents.</p>';
    return html;
  }

  function kpi(label, value, href) {
    var inner = '<div class="dash-kpi__val">' + esc(value) + '</div><div class="dash-kpi__label">' + esc(label) + '</div>';
    if (href) return '<a class="dash-kpi dash-kpi--link" href="' + esc(href) + '">' + inner + '</a>';
    return '<div class="dash-kpi">' + inner + '</div>';
  }

  function renderProduction(prod) {
    if (!prod || prod.unavailable) {
      return emptyLine('Production activity is unavailable right now. System health above is still live.');
    }
    var sessions = prod.sessions || 0;
    if (!sessions) {
      return emptyLine(prod.period && prod.period.key === 'today'
        ? 'No customer conversations today.'
        : 'No customer conversations in this period.');
    }
    var html = '<div class="dash-kpis">'
      + kpi('Sessions', sessions, transcriptsHref({}, prod))
      + kpi('Reviewed', prod.reviewed || 0, transcriptsHref({ reviewStatus: 'reviewed' }, prod))
      + '</div>';
    if (!prod.reviewed) {
      html += emptyLine('No reviewed conversations in this period.');
      return html;
    }
    var overall = [
      ['good', 'Good'], ['mixed', 'Mixed'], ['poor', 'Poor'], ['insufficient_evidence', 'Insufficient evidence']
    ];
    var outcome = [
      ['useful_outcome', 'Useful'], ['partial_outcome', 'Partial'], ['no_useful_outcome', 'No useful outcome'],
      ['abandoned', 'Abandoned'], ['insufficient_evidence', 'Insufficient evidence']
    ];
    html += '<div class="dash-group"><div class="dash-group__title">Quality</div><div class="dash-rows">';
    overall.forEach(function (pair) {
      var n = (prod.overall && prod.overall[pair[0]]) || 0;
      if (pair[0] === 'insufficient_evidence' && !n) return;
      html += countRow(transcriptsHref({ overall: pair[0] }, prod), pair[1], n);
    });
    html += '</div></div>';
    html += '<div class="dash-group"><div class="dash-group__title">Outcomes</div><div class="dash-rows">';
    outcome.forEach(function (pair) {
      var n = (prod.outcome && prod.outcome[pair[0]]) || 0;
      if (pair[0] === 'insufficient_evidence' && !n) return;
      html += countRow(transcriptsHref({ reviewOutcome: pair[0] }, prod), pair[1], n);
    });
    html += '</div></div>';
    html += '<p class="dash-note">' + esc(prod.sampleNote || 'Exact counts of conversations in this period. Not statistical significance.') + '</p>';
    return html;
  }

  function renderAreas(prod) {
    var areas = (prod && prod.productAreas) || [];
    if (!areas.length) return emptyLine('No recurring product issues identified in this period.');
    var html = '<div class="dash-rows">';
    areas.forEach(function (a) {
      html += countRow(transcriptsHref({ productArea: a.area }, prod), a.label || a.area, a.count);
    });
    html += '</div>';
    html += '<p class="dash-note">Stored semantic classifications for conversations in this period.</p>';
    return html;
  }

  function setPeriodButtons(period) {
    dashPeriod = period || '7d';
    Array.prototype.forEach.call(document.querySelectorAll('.dash-period'), function (btn) {
      var on = btn.getAttribute('data-period') === dashPeriod;
      btn.classList.toggle('is-on', on);
      btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
  }

  function loadDashboard(period) {
    var p = period || dashPeriod || '7d';
    if (p !== 'today' && p !== '7d' && p !== '30d') p = '7d';
    setPeriodButtons(p);
    var healthEl = $('dashHealth');
    var attEl = $('dashAttentionBody');
    var prodEl = $('dashProductionBody');
    var areasEl = $('dashAreasBody');
    if (healthEl) healthEl.innerHTML = '<div class="health__loading">Checking system health…</div>';
    if (attEl) attEl.innerHTML = '<div class="tac__muted">Loading…</div>';
    if (prodEl) prodEl.innerHTML = '<div class="tac__muted">Loading…</div>';
    if (areasEl) areasEl.innerHTML = '<div class="tac__muted">Loading…</div>';
    var stateEl = $('dashStateBody');
    if (stateEl) stateEl.innerHTML = '<div class="tac__muted">Loading…</div>';
    fetch(API_BASE + '/admin/dashboard?period=' + encodeURIComponent(p), { credentials: 'same-origin', headers: { accept: 'application/json' } })
      .then(readJson)
      .then(function (res) {
        if (res.status === 401) return;
        if (!res.ok) {
          // A failed load is never shown as "nothing happened" (empty counts).
          var why = apiErrorText(res, 'Could not load the dashboard.');
          if (healthEl) healthEl.innerHTML = '<div class="health__loading">' + esc(why) + '</div>';
          [stateEl, attEl, prodEl, areasEl].forEach(function (el) { if (el) el.innerHTML = emptyLine(why); });
          return;
        }
        var data = res.body;
        var prod = data.production || {};
        if (stateEl) stateEl.innerHTML = renderState(data.state);
        if (healthEl) healthEl.innerHTML = renderHealth(data.health);
        if (attEl) attEl.innerHTML = renderAttention(prod);
        if (prodEl) prodEl.innerHTML = renderProduction(prod);
        if (areasEl) areasEl.innerHTML = renderAreas(prod);
        var title = document.querySelector('#dashProduction .admin__h2');
        if (title) title.textContent = 'Production — ' + ((prod.period && prod.period.label) || 'Last 7 days');
        if ($('dashPeriodNote')) {
          $('dashPeriodNote').textContent = (prod.period && prod.period.note)
            || 'Counts are for conversations in this period, not when they were reviewed.';
        }
      })
      .catch(function () {
        if (stateEl) stateEl.innerHTML = emptyLine('Could not load the production state.');
        if (healthEl) healthEl.innerHTML = '<div class="health__loading">Could not load system health.</div>';
        if (attEl) attEl.innerHTML = emptyLine('Could not load attention items.');
        if (prodEl) prodEl.innerHTML = emptyLine('Could not load production activity.');
        if (areasEl) areasEl.innerHTML = emptyLine('Could not load recurring areas.');
      });
  }
  Array.prototype.forEach.call(document.querySelectorAll('.dash-period'), function (btn) {
    btn.addEventListener('click', function () {
      var period = btn.getAttribute('data-period') || '7d';
      setPeriodButtons(period);
      writeHash('dashboard', { period: period }, true);
      loadDashboard(period);
    });
  });

  function applyHashRoute() {
    var route = parseHash();
    var target = route.section || 'dashboard';
    // Back-compat: the old Test ApplianceClinic (#benchmark) and Test Scenarios
    // (#library) are now tabs inside one Test area. Land old links on the right tab.
    var aliasTab = null;
    if (target === 'benchmark') { aliasTab = 'live'; target = 'test'; }
    else if (target === 'library') { aliasTab = 'scenarios'; target = 'test'; }
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
    if (target === 'dashboard') loadDashboard(route.params.period || dashPeriod || '7d');
    else if (target === 'transcripts') {
      if (route.sub) showTranscriptDetail(route.sub, route.params);
      else showTranscriptList(route.params);
    } else if (target === 'test') {
      ensureTestPage();
      // '#test/scenario/<id>' (?view=edit), '#test/scenario/new' and '#test/run/<runId>' (?journey=)
      // are dedicated pages inside their tab; a bare '#test?tab=…' is the tab's list.
      var testSub = route.sub || '';
      var tab = aliasTab || route.params.tab || 'live';
      if (testSub.indexOf('scenario/') === 0) tab = 'scenarios';
      else if (testSub.indexOf('run/') === 0) tab = 'batch';
      if (['live', 'scenarios', 'batch'].indexOf(tab) === -1) tab = 'live';
      showTestTab(tab);
      testShowRoute(tab, testSub, route.params);
      if (tab === 'live' && route.params.scenario) wbPickScenario(route.params.scenario);
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
  function routeLabel(r) {
    if (r === 'SYMPTOMS') return 'Symptom';
    if (r === 'ERROR_CODE') return 'Error code';
    if (r === 'ERROR_CODE_AND_SYMPTOMS') return 'Code + symptom';
    return r || '—';
  }

  var txCursorStack = [null];
  var txPage = 0;
  var txOpenId = null;
  var TX_CHIP_LABELS = {
    from: 'From', to: 'To', family: 'Appliance', make: 'Make', route: 'Route',
    lifecycle: 'Lifecycle', safety: 'Safety cases', errors: 'Sessions with API errors',
    attention: 'Needs attention', looping: 'Conversation flow', stateProgression: 'Progression',
    safetyHandling: 'Safety handling',
    reviewStatus: 'Review status', overall: 'Overall', priority: 'Priority',
    reviewOutcome: 'Outcome', productArea: 'Product area', q: 'Search',
    journey: 'Journey', canonical: 'Path', degraded: 'Degraded turns', partRecommended: 'Part recommended'
  };
  var TX_REVIEWSTATUS_LABELS = {
    awaiting: 'Awaiting review', reviewed: 'Reviewed', failed: 'Review failed', none: 'Not eligible yet'
  };
  // Chip values that already read as a full phrase — show the value alone, no key prefix.
  var TX_CHIP_SELFDESC = { family: 1, safetyHandling: 1, reviewStatus: 1, productArea: 1 };
  var TX_AREA_LABELS = {
    understanding: 'Understanding', clarification: 'Clarification',
    diagnostic_reasoning: 'Diagnostic reasoning', knowledge: 'Knowledge',
    parts: 'Parts', media: 'Media', safety: 'Safety',
    conversation_flow: 'Conversation flow', identification: 'Identification', other: 'Other'
  };
  var TX_FAMILY_LABELS = {
    'washing machine': 'Washing machine', 'washer-dryer': 'Washer dryer',
    'tumble-dryer': 'Tumble dryer', dishwasher: 'Dishwasher',
    'fridge-freezer': 'Fridge freezer', 'oven-cooker': 'Oven / cooker',
    hobs: 'Hob', microwave: 'Microwave', vacuum: 'Vacuum'
  };

  function resetTranscriptFilters() {
    ['txFrom', 'txTo', 'txFamily', 'txMake', 'txRoute', 'txLifecycle', 'txSearch', 'txReviewStatus', 'txOverall', 'txPriority', 'txReviewOutcome', 'txProductArea', 'txLooping', 'txStateProgression', 'txSafetyHandling', 'txJourney', 'txCanonical', 'txPartRecommended'].forEach(function (id) { if ($(id)) $(id).value = ''; });
    if ($('txDegraded')) $('txDegraded').checked = false;
    if ($('txSafety')) $('txSafety').checked = false;
    if ($('txErrors')) $('txErrors').checked = false;
    if ($('txAttention')) $('txAttention').checked = false;
  }
  function transcriptParamsFromForm() {
    var params = {};
    function val(id) { return ($(id) && $(id).value) || ''; }
    if (val('txFrom')) params.from = val('txFrom');
    if (val('txTo')) params.to = val('txTo');
    if (val('txFamily')) params.family = val('txFamily');
    if (val('txMake').trim()) params.make = val('txMake').trim();
    if (val('txRoute')) params.route = val('txRoute');
    if (val('txLifecycle')) params.lifecycle = val('txLifecycle');
    if ($('txSafety') && $('txSafety').checked) params.safety = '1';
    if ($('txErrors') && $('txErrors').checked) params.errors = '1';
    if ($('txAttention') && $('txAttention').checked) params.attention = '1';
    if (val('txLooping')) params.looping = val('txLooping');
    if (val('txStateProgression')) params.stateProgression = val('txStateProgression');
    if (val('txSafetyHandling')) params.safetyHandling = val('txSafetyHandling');
    if (val('txReviewStatus')) params.reviewStatus = val('txReviewStatus');
    if (val('txOverall')) params.overall = val('txOverall');
    if (val('txPriority')) params.priority = val('txPriority');
    if (val('txReviewOutcome')) params.reviewOutcome = val('txReviewOutcome');
    if (val('txProductArea')) params.productArea = val('txProductArea');
    if (val('txJourney').trim()) params.journey = val('txJourney').trim().toLowerCase();
    if (val('txCanonical')) params.canonical = val('txCanonical');
    if ($('txDegraded') && $('txDegraded').checked) params.degraded = '1';
    if (val('txPartRecommended')) params.partRecommended = val('txPartRecommended');
    if (val('txSearch').trim()) params.q = val('txSearch').trim();
    return params;
  }
  function applyTranscriptParams(params) {
    resetTranscriptFilters();
    params = params || {};
    if (params.from && $('txFrom')) $('txFrom').value = String(params.from).slice(0, 10);
    if (params.to && $('txTo')) $('txTo').value = String(params.to).slice(0, 10);
    if (params.family && $('txFamily')) $('txFamily').value = params.family;
    if (params.make && $('txMake')) $('txMake').value = params.make;
    if (params.route && $('txRoute')) $('txRoute').value = params.route;
    if (params.lifecycle && $('txLifecycle')) $('txLifecycle').value = params.lifecycle;
    if ((params.safety === '1' || params.safety === 'true') && $('txSafety')) $('txSafety').checked = true;
    if ((params.errors === '1' || params.errors === 'true') && $('txErrors')) $('txErrors').checked = true;
    if ((params.attention === '1' || params.attention === 'true') && $('txAttention')) $('txAttention').checked = true;
    if (params.looping && $('txLooping')) $('txLooping').value = params.looping;
    if (params.stateProgression && $('txStateProgression')) $('txStateProgression').value = params.stateProgression;
    if (params.safetyHandling && $('txSafetyHandling')) $('txSafetyHandling').value = params.safetyHandling;
    if (params.reviewStatus && $('txReviewStatus')) $('txReviewStatus').value = params.reviewStatus;
    if (params.overall && $('txOverall')) $('txOverall').value = params.overall;
    if (params.priority && $('txPriority')) $('txPriority').value = params.priority;
    if (params.reviewOutcome && $('txReviewOutcome')) $('txReviewOutcome').value = params.reviewOutcome;
    if (params.productArea && $('txProductArea')) $('txProductArea').value = params.productArea;
    if (params.q && $('txSearch')) $('txSearch').value = params.q;
    if (params.journey && $('txJourney')) $('txJourney').value = params.journey;
    if (params.canonical && $('txCanonical')) $('txCanonical').value = params.canonical;
    if ((params.degraded === '1' || params.degraded === 'true') && $('txDegraded')) $('txDegraded').checked = true;
    if (params.partRecommended && $('txPartRecommended')) $('txPartRecommended').value = params.partRecommended;
    txCursorStack = [null];
    txPage = 0;
    syncTranscriptChrome();
  }
  function txQuery() {
    var q = [];
    var from = ($('txFrom') && $('txFrom').value) || '';
    var to = ($('txTo') && $('txTo').value) || '';
    if (from) q.push('from=' + encodeURIComponent(from + 'T00:00:00.000Z'));
    if (to) q.push('to=' + encodeURIComponent(to + 'T23:59:59.999Z'));
    var fam = ($('txFamily') && $('txFamily').value) || '';
    var make = ($('txMake') && $('txMake').value.trim()) || '';
    var route = ($('txRoute') && $('txRoute').value) || '';
    var life = ($('txLifecycle') && $('txLifecycle').value) || '';
    var search = ($('txSearch') && $('txSearch').value.trim()) || '';
    if (fam) q.push('family=' + encodeURIComponent(fam));
    if (make) q.push('make=' + encodeURIComponent(make.toLowerCase()));
    if (route) q.push('route=' + encodeURIComponent(route));
    if (life) q.push('lifecycle=' + encodeURIComponent(life));
    if ($('txSafety') && $('txSafety').checked) q.push('safety=1');
    if ($('txErrors') && $('txErrors').checked) q.push('errors=1');
    if ($('txAttention') && $('txAttention').checked) q.push('attention=1');
    var looping = ($('txLooping') && $('txLooping').value) || '';
    var stateProgression = ($('txStateProgression') && $('txStateProgression').value) || '';
    var safetyHandling = ($('txSafetyHandling') && $('txSafetyHandling').value) || '';
    if (looping) q.push('looping=' + encodeURIComponent(looping));
    if (stateProgression) q.push('stateProgression=' + encodeURIComponent(stateProgression));
    if (safetyHandling) q.push('safetyHandling=' + encodeURIComponent(safetyHandling));
    var rs = ($('txReviewStatus') && $('txReviewStatus').value) || '';
    var overall = ($('txOverall') && $('txOverall').value) || '';
    var pri = ($('txPriority') && $('txPriority').value) || '';
    var rout = ($('txReviewOutcome') && $('txReviewOutcome').value) || '';
    var area = ($('txProductArea') && $('txProductArea').value) || '';
    if (rs) q.push('reviewStatus=' + encodeURIComponent(rs));
    if (overall) q.push('overall=' + encodeURIComponent(overall));
    if (pri) q.push('priority=' + encodeURIComponent(pri));
    if (rout) q.push('reviewOutcome=' + encodeURIComponent(rout));
    if (area) q.push('productArea=' + encodeURIComponent(area));
    var journey = ($('txJourney') && $('txJourney').value.trim().toLowerCase()) || '';
    var canon = ($('txCanonical') && $('txCanonical').value) || '';
    var partRec = ($('txPartRecommended') && $('txPartRecommended').value) || '';
    if (journey) q.push('journey=' + encodeURIComponent(journey));
    if (canon) q.push('canonical=' + encodeURIComponent(canon));
    if ($('txDegraded') && $('txDegraded').checked) q.push('degraded=1');
    if (partRec) q.push('partRecommended=' + encodeURIComponent(partRec));
    if (search.length >= 3) q.push('q=' + encodeURIComponent(search));
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
  function assessmentFlagClass(v) {
    if (v === 'poor') return 'tx__flag tx__flag--warn';
    if (v === 'good') return 'tx__flag tx__flag--ok';
    if (v === 'insufficient_evidence') return 'tx__flag tx__flag--muted';
    return 'tx__flag';
  }
  function lifeLabel(life) {
    var map = { active: 'Recent', ended: 'Ended', inactive: 'Inactive', error: 'Error' };
    return map[life] || life || '';
  }
  function activeQuickView() {
    var attention = $('txAttention') && $('txAttention').checked;
    var overall = ($('txOverall') && $('txOverall').value) || '';
    var looping = ($('txLooping') && $('txLooping').value) || '';
    var safety = ($('txSafetyHandling') && $('txSafetyHandling').value) || '';
    if (attention && !overall && !looping && !safety) return 'attention';
    if (!attention && overall === 'poor' && !looping && !safety) return 'poor';
    if (!attention && !overall && looping === 'significant' && !safety) return 'loops';
    if (!attention && !overall && !looping && safety === 'concern') return 'safety';
    if (!attention && !overall && !looping && !safety) return 'all';
    return 'custom';
  }
  function clearViewFilters() {
    if ($('txAttention')) $('txAttention').checked = false;
    if ($('txOverall')) $('txOverall').value = '';
    if ($('txLooping')) $('txLooping').value = '';
    if ($('txSafetyHandling')) $('txSafetyHandling').value = '';
  }
  function applyQuickView(view) {
    clearViewFilters();
    if (view === 'attention' && $('txAttention')) $('txAttention').checked = true;
    else if (view === 'poor' && $('txOverall')) $('txOverall').value = 'poor';
    else if (view === 'safety' && $('txSafetyHandling')) $('txSafetyHandling').value = 'concern';
    else if (view === 'loops' && $('txLooping')) $('txLooping').value = 'significant';
    txCursorStack = [null];
    txPage = 0;
    writeHash('transcripts', transcriptParamsFromForm());
    loadTranscripts();
  }
  function chipValueLabel(key, value) {
    if (key === 'family') return familyLabel(value) || value;
    if (key === 'productArea') return TX_AREA_LABELS[value] || titleEnum(value);
    if (key === 'attention' || key === 'safety' || key === 'errors' || key === 'degraded') return '';
    if (key === 'canonical') return ({ control: 'Canonical control', shadow: 'Shadow', legacy: 'Legacy', mixed: 'Mixed', degraded: 'Degraded' })[value] || value;
    if (key === 'partRecommended') return value === '1' ? 'yes' : 'no';
    if (key === 'journey') return value;
    if (key === 'route') return routeLabel(value);
    if (key === 'lifecycle') return lifeLabel(value);
    if (key === 'overall') return txLabel(TX_OVERALL_LABELS, value);
    if (key === 'stateProgression') return txLabel(TX_PROGRESSION_LABELS, value);
    if (key === 'safetyHandling') return txLabel(TX_SAFETY_LABELS, value);
    if (key === 'priority') return txLabel(TX_PRIORITY_LABELS, value);
    if (key === 'reviewOutcome') return txLabel(TX_OUTCOME_LABELS, value);
    if (key === 'looping') return txLabel(TX_LOOPING_LABELS, value);
    if (key === 'reviewStatus') return TX_REVIEWSTATUS_LABELS[value] || titleEnum(value);
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
  var TX_VIEW_CHIP_LABELS = { attention: 'Needs attention', poor: 'Poor', safety: 'Safety concern', loops: 'Repeated questions' };
  function renderFilterChips(params) {
    var el = $('txFilterChips');
    if (!el) return;
    params = params || {};
    var view = activeQuickView();
    var chips = [];
    var suppress = {};
    if (TX_VIEW_CHIP_LABELS[view]) {
      chips.push({ cls: 'tx-chip tx-chip--view', key: '__view', text: TX_VIEW_CHIP_LABELS[view], aria: TX_VIEW_CHIP_LABELS[view] + ' view' });
      if (view === 'attention') suppress.attention = 1;
      else if (view === 'poor') suppress.overall = 1;
      else if (view === 'safety') suppress.safetyHandling = 1;
      else if (view === 'loops') suppress.looping = 1;
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
    var map = {
      from: 'txFrom', to: 'txTo', family: 'txFamily', make: 'txMake', route: 'txRoute',
      lifecycle: 'txLifecycle', looping: 'txLooping', stateProgression: 'txStateProgression',
      safetyHandling: 'txSafetyHandling',
      reviewStatus: 'txReviewStatus', overall: 'txOverall', priority: 'txPriority',
      reviewOutcome: 'txReviewOutcome', productArea: 'txProductArea', q: 'txSearch',
      journey: 'txJourney', canonical: 'txCanonical', partRecommended: 'txPartRecommended'
    };
    if (key === '__view') clearViewFilters();
    else if (key === 'dateRange') { if ($('txFrom')) $('txFrom').value = ''; if ($('txTo')) $('txTo').value = ''; }
    else if (key === 'attention' && $('txAttention')) $('txAttention').checked = false;
    else if (key === 'safety' && $('txSafety')) $('txSafety').checked = false;
    else if (key === 'errors' && $('txErrors')) $('txErrors').checked = false;
    else if (key === 'degraded' && $('txDegraded')) $('txDegraded').checked = false;
    else if (map[key] && $(map[key])) $(map[key]).value = '';
    txCursorStack = [null]; txPage = 0;
    writeHash('transcripts', transcriptParamsFromForm());
    loadTranscripts();
  }
  function contextCopy(view, params) {
    var head;
    if (view === 'attention') head = 'Showing conversations that need attention';
    else if (view === 'poor') head = 'Showing conversations assessed as Poor';
    else if (view === 'safety') head = 'Showing conversations with a stored safety concern';
    else if (view === 'loops') head = 'Showing conversations with significant looping';
    else if (view === 'custom') head = 'Showing filtered conversations';
    else head = 'Showing all retained conversations';
    if (params.from || params.to) {
      head += ' · ' + (params.from || 'start') + (params.to ? ' to ' + params.to : ' onwards');
    }
    return head + '.';
  }
  // Specialist = lives in the More filters drawer. Excludes the primary-row controls
  // (search/date/appliance/review status) and the param backing the active quick view,
  // so the "More filters · N active" count reflects only genuinely extra refinement.
  var TX_SPECIALIST_KEYS = ['make', 'route', 'lifecycle', 'looping', 'stateProgression',
    'safetyHandling', 'overall', 'priority', 'reviewOutcome', 'productArea', 'errors', 'safety',
    'journey', 'canonical', 'degraded', 'partRecommended'];
  function specialistActiveKeys(params) {
    var view = activeQuickView();
    var exclude = view === 'poor' ? 'overall' : (view === 'loops' ? 'looping' : (view === 'safety' ? 'safetyHandling' : null));
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
      setCount('txCountAttention', viewCounts.attention);
      setCount('txCountPoor', viewCounts.poor);
      setCount('txCountSafety', viewCounts.safety);
      setCount('txCountLoops', viewCounts.loops);
    }
  }
  // Compact triage badges. The explanatory one-liner (reviewLine) now carries the "why",
  // so the badge set is trimmed to the primary triage signals and does not duplicate it:
  // Needs attention, Safety concern, API error, and non-active lifecycle.
  function rowFlags(r) {
    var bits = [];
    if (r.needsAttention) bits.push('<span class="tx__flag tx__flag--attn">Needs attention</span>');
    if (r.reviewStatus === 'reviewed' && r.reviewSafetyHandling === 'concern') {
      bits.push('<span class="tx__flag tx__flag--safety">Safety concern</span>');
    }
    if (r.hasError) bits.push('<span class="tx__flag tx__flag--safety">API error</span>');
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
    var canon = (typeof canonicalRowBadges === 'function') ? canonicalRowBadges(r.canonical) : '';
    var outcome = r.outcome ? '<span class="tx__flag ' + (r.outcome === 'SAFETY_STOP' ? 'tx__flag--safety' : 'tx__flag--muted') + '">' + esc(prettyEnum(r.outcome)) + '</span>' : '';
    var part = r.partRecommended ? '<span class="tx__flag tx__flag--ok">Part recommended</span>' : '';
    var dur = durationLabel(r);
    var turns = (r.turnCount || 0) + ((r.turnCount === 1) ? ' turn' : ' turns');
    // Deterministic reviewer one-liner from stored review enums (no new text generated).
    var line = reviewLine(r);
    var lineHtml = line
      ? '<p class="tx-row__review tx-row__review--' + line.tone + '"><span class="tx-row__reviewdot" aria-hidden="true"></span>'
        + '<span class="tx-row__reviewtext">' + esc(line.text) + '</span></p>'
      : '';
    return '<a class="tx-row' + openCls + '" data-sid="' + esc(r.sessionId) + '" href="' + esc(txDetailHref(r.sessionId)) + '">'
      + '<div class="tx-row__main">'
      + '<div class="tx-row__when">' + esc(fmtWhen(r.lastActivityAt)) + ' · <span class="tx-row__ref">' + esc(r.shortId || '') + '</span></div>'
      + '<div class="tx-row__id">' + esc(applianceLine(r)) + '</div>'
      + '<p class="' + previewClass + '"></p>'
      + lineHtml
      + '<div class="tx-row__flags">' + canon + outcome + part + rowFlags(r) + '</div>'
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
    (function () {
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
    })();
  }
  function dimRow(label, value) {
    return '<div class="health__row"><span>' + esc(label) + '</span><span>' + esc(value ? titleEnum(value) : '—') + '</span></div>';
  }
  function traceValue(v) {
    if (v == null || v === '') return '—';
    if (Array.isArray(v)) return v.length ? v.map(function (x) { return typeof x === 'object' ? JSON.stringify(x) : String(x); }).join(', ') : '—';
    if (typeof v === 'object') return Object.keys(v).sort().map(function (k) {
      return '<div class="tx-trace__kv"><span>' + esc(k) + '</span><code>' + esc(traceValue(v[k])) + '</code></div>';
    }).join('');
    return esc(String(v));
  }
  // Read a stage's structured detail object by id (returns {} when absent/slimmed to null).
  function traceDetail(trace, id) {
    if (!trace || !Array.isArray(trace.stages)) return {};
    for (var i = 0; i < trace.stages.length; i++) {
      var s = trace.stages[i];
      if (s && s.id === id) return (s.detail && typeof s.detail === 'object') ? s.detail : {};
    }
    return {};
  }
  // The at-a-glance diagnostic state after this turn, drawn only from already-captured stages.
  function traceKeyState(trace) {
    var ds = traceDetail(trace, 'diagnostic-state');
    var jd = traceDetail(trace, 'jev-understand').decisions || {};
    var routing = traceDetail(trace, 'routing');
    var pm = traceDetail(trace, 'parts-media');
    var safety = traceDetail(trace, 'safety');
    return {
      family: ds.applianceFamily || jd.applianceFamily || null,
      make: ds.make || null,
      model: ds.model || null,
      faultId: ds.faultId || null,
      grounded: ds.grounded === true,
      partReadiness: ds.partReadiness || jd.partReadiness || null,
      nextAction: ds.nextAction || null,
      route: routing.route || null,
      purchaseAppropriate: pm.purchaseAppropriate === true,
      safetyStop: safety.stopReason || null,
    };
  }
  // NEW / UPDATED / RETAINED / REMOVED for one key-state field vs the previous turn.
  function stateChange(cur, prev, key) {
    var has = cur[key] != null && cur[key] !== '';
    if (!prev) return has ? 'new' : null;
    var had = prev[key] != null && prev[key] !== '';
    if (!had && has) return 'new';
    if (had && !has) return 'removed';
    if (had && has && String(prev[key]) !== String(cur[key])) return 'updated';
    if (had && has) return 'retained';
    return null;
  }
  function stateChip(label, value, change) {
    if (value == null || value === '') return '';
    var tag = change ? '<i class="tx-kchip__chg tx-kchip__chg--' + esc(change) + '">' + esc(change) + '</i>' : '';
    return '<span class="tx-kchip"><b>' + esc(label) + '</b> ' + esc(String(value)) + tag + '</span>';
  }
  function keyStateRow(cur, prev) {
    var chips = [
      stateChip('Family', cur.family, stateChange(cur, prev, 'family')),
      stateChip('Make', cur.make, stateChange(cur, prev, 'make')),
      stateChip('Model', cur.model, stateChange(cur, prev, 'model')),
      stateChip('Fault', cur.faultId ? (cur.faultId + (cur.grounded ? ' · grounded' : '')) : null, stateChange(cur, prev, 'faultId')),
      stateChip('Part readiness', cur.partReadiness, stateChange(cur, prev, 'partReadiness')),
      stateChip('Next action', cur.nextAction, stateChange(cur, prev, 'nextAction'))
    ];
    if (cur.purchaseAppropriate) {
      var pc = !prev ? 'new' : (prev.purchaseAppropriate === cur.purchaseAppropriate ? 'retained' : 'updated');
      chips.push(stateChip('Purchase', 'appropriate', pc));
    }
    if (cur.safetyStop) chips.push(stateChip('Safety', 'STOP-USE · ' + cur.safetyStop, stateChange(cur, prev, 'safetyStop')));
    chips = chips.filter(Boolean);
    return chips.length ? '<div class="tx-kstate">' + chips.join('') + '</div>' : '';
  }
  // Human-readable one-line highlight for a stage, so admins scan without opening raw detail.
  function traceHighlight(stage, vis) {
    var d = (stage && stage.detail && typeof stage.detail === 'object') ? stage.detail : null;
    var id = stage && stage.id;
    if (!d) return esc(stage && stage.summary || '');
    var bits = [];
    function kv(label, val) { if (val != null && val !== '') bits.push('<span><i>' + esc(label) + '</i> ' + esc(String(val)) + '</span>'); }
    function flag(label, on) { bits.push('<span><i>' + esc(label) + '</i> ' + (on ? 'yes' : 'no') + '</span>'); }
    if (id === 'routing') {
      kv('route', d.route); flag('MCP', d.mcpInvoked); flag('RAG', d.ragInvoked);
    } else if (id === 'error-code-mcp') {
      if (d.status != null) { kv('status', d.status); kv('code', d.displayed || d.code); kv('fault', d.faultId); }
      else return esc(stage.summary || '');
    } else if (id === 'jev-understand') {
      var jd = d.decisions || {}; var ad = d.adapter || {};
      kv('model', d.model); kv('family', jd.applianceFamily); kv('intent', jd.userIntent);
      kv('token', ad.tokenMeaning || jd.candidateTokenMeaning); kv('identity', ad.identitySufficiency || jd.identitySufficiency);
      kv('symptom', jd.symptomFamily); kv('prev-answer', jd.answeredPrevious); kv('part-readiness', jd.partReadiness);
      if (jd.cannotAnswer || ad.cannotAnswer) bits.push('<span class="tx-hl--danger"><i>cannot-answer</i> yes</span>');
    } else if (id === 'rag-retrieval') {
      var ids = d.knowledgeIds || []; kv('mode', d.mode); kv('records', ids.length);
      if (ids.length) kv('top', ids.slice(0, 3).join(', '));
    } else if (id === 'diagnostic-state') {
      flag('grounded', d.grounded); kv('fault', d.faultId || d.fault); kv('next', d.nextAction); kv('part-readiness', d.partReadiness);
      if (d.cannotAnswer) bits.push('<span class="tx-hl--danger"><i>cannot-answer</i> yes</span>');
    } else if (id === 'safety') {
      if (d.stopReason) bits.push('<span class="tx-hl--danger"><i>STOP-USE</i> ' + esc(d.stopReason) + '</span>');
      else bits.push('<span><i>stop-use</i> none</span>');
      kv('diagnose-stop', d.diagnoseStop); kv('class', d.classification);
      if (d.unsafeIntent) kv('unsafe-intent', 'yes');
    } else if (id === 'parts-media') {
      var parts = d.parts || []; bits.push('<span><i>parts</i> ' + parts.length + '</span>');
      bits.push('<span><i>media</i> ' + ((d.media || []).length) + '</span>');
      bits.push('<span><i>purchase</i> ' + (d.purchaseAppropriate ? 'appropriate' : 'no') + '</span>');
      kv('mention', d.componentMention);
      var vp = (vis && vis.parts) || [];
      if (vp.length) kv('fit', vp.map(function (p) { return p.name + (p.fitStatus ? ' (' + p.fitStatus + ')' : ''); }).join('; '));
      else if (parts.length) kv('surfaced', parts.map(function (p) { return p.title || p.partNo; }).join('; '));
    } else if (id === 'orchestrator-state') {
      var inf = d.inferred || {}; kv('fault', inf.faultId); if (inf.grounded != null) flag('grounded', inf.grounded);
      if (inf.candidateComponents && inf.candidateComponents.length) kv('candidates', inf.candidateComponents.slice(0, 6).join(', '));
    } else if (id === 'compose') {
      bits.push('<span><i>' + (d.tripwireBlocked ? 'blocked (tripwire)' : 'composed') + '</i></span>');
      kv('chars', d.outputChars); kv('ms', d.latencyMs);
    } else if (id === 'customer-response') {
      kv('outcome', d.outcome); kv('parts', d.partsCount); kv('media', d.mediaCount);
      if (d.pendingRequest) kv('pending', 'yes');
    }
    return bits.length ? bits.join('') : esc(stage.summary || '');
  }
  // Plain-English labels for the reviewer's named progression flags. The server stores
  // these as camelCase booleans; we never show the raw key as the primary label.
  var TX_FLAG_LABELS = {
    forgotEstablishedState: 'Forgot information the customer had already established',
    repeatedResolvedModelRequest: 'Re-asked for the model after it was already given',
    ignoredNegativeEvidence: 'Ignored evidence that should have changed the diagnosis',
    restartedAfterAnswer: 'Restarted the journey after the customer answered',
    unresolvedCorrection: 'Left a customer correction unresolved',
    repeatedQuestionNoProgress: 'Repeated a question without progressing',
    legitimateCorrection: 'Correctly handled a customer correction',
    advancedAfterCheck: 'Advanced appropriately after the customer completed a check',
  };
  // Positive flags are good behaviour and must not read like errors.
  var TX_FLAG_POSITIVE = { legitimateCorrection: true, advancedAfterCheck: true };

  // ---- Stage 2: shared, display-only terminology --------------------------
  // Single source of truth so the list one-liner, the Review tab and the quick-view
  // badges all read the same. These map STORED enum values to human labels; they never
  // rename server-side enums and never introduce a second summariser.
  var TX_OVERALL_LABELS = { good: 'Good', mixed: 'Mixed', poor: 'Poor', insufficient_evidence: 'Insufficient evidence' };
  var TX_OUTCOME_LABELS = {
    useful_outcome: 'Useful outcome', partial_outcome: 'Partial outcome',
    no_useful_outcome: 'No useful outcome', abandoned: 'Abandoned', insufficient_evidence: 'Insufficient evidence',
  };
  var TX_SAFETY_LABELS = { appropriate: 'Appropriate', concern: 'Safety concern', not_applicable: 'Not applicable', insufficient_evidence: 'Insufficient evidence' };
  var TX_PROGRESSION_LABELS = { good: 'Good progression', mixed: 'Mixed progression', poor: 'Poor progression', insufficient_evidence: 'Insufficient evidence' };
  var TX_PRIORITY_LABELS = { normal: 'Normal', worth_reviewing: 'Worth reviewing', important: 'Important' };
  var TX_LOOPING_LABELS = { none: 'No looping', minor: 'Minor looping', significant: 'Significant looping' };
  function txLabel(map, v) { return (v && map[v]) ? map[v] : (v ? titleEnum(v) : '—'); }
  // Tone for a dimension value: ok (good), warn (concern), safety (safety concern),
  // attn (needs a look), muted (not assessable / neutral-low), neutral (otherwise).
  function txTone(dim, v) {
    if (v == null) return 'muted';
    if (dim === 'overall' || dim === 'progression') {
      return v === 'poor' ? 'warn' : (v === 'good' ? 'ok' : (v === 'insufficient_evidence' ? 'muted' : 'neutral'));
    }
    if (dim === 'safety') return v === 'concern' ? 'safety' : (v === 'appropriate' ? 'ok' : 'muted');
    if (dim === 'priority') return v === 'important' ? 'warn' : (v === 'worth_reviewing' ? 'attn' : 'muted');
    if (dim === 'outcome') return v === 'useful_outcome' ? 'ok' : (v === 'no_useful_outcome' ? 'warn' : (v === 'abandoned' ? 'muted' : 'neutral'));
    return 'neutral';
  }

  // Deterministic reviewer one-liner for a LIST row, built only from the coarse review
  // enums the list payload carries (no flags/summary are available per row). Priority:
  // strongest concern first, then a positive signal if genuinely useful, else null (no line).
  function reviewLine(r) {
    if (!r) return null;
    if (r.reviewStatus === 'failed') return { tone: 'muted', text: 'Review didn’t complete' };
    if (r.reviewStatus !== 'reviewed') return null;
    if (r.reviewSafetyHandling === 'concern') return { tone: 'safety', text: 'Safety handling needs review' };
    if (r.reviewStateProgression === 'poor') return { tone: 'warn', text: 'Poor progression across turns' };
    if (r.reviewLooping === 'significant') return { tone: 'warn', text: 'Repeated questions without progressing' };
    if (r.reviewOverall === 'poor') return { tone: 'warn', text: 'Overall quality marked poor' };
    if (r.reviewOutcome === 'no_useful_outcome') return { tone: 'warn', text: 'No useful outcome reached' };
    if (r.reviewOutcome === 'abandoned') return { tone: 'muted', text: 'Customer abandoned the chat' };
    if (r.reviewPriority === 'important') return { tone: 'warn', text: 'Flagged important to review' };
    if (r.reviewPriority === 'worth_reviewing') return { tone: 'attn', text: 'Worth reviewing' };
    if (r.reviewOverall === 'good' && r.reviewStateProgression === 'good') return { tone: 'ok', text: 'Good progression, resolved cleanly' };
    if (r.reviewOverall === 'good') return { tone: 'ok', text: 'Handled well' };
    if (r.reviewOutcome === 'useful_outcome') return { tone: 'ok', text: 'Reached a useful outcome' };
    if (r.reviewOverall === 'insufficient_evidence') return { tone: 'muted', text: 'Too short to assess' };
    return null;
  }

  // Progression flag chips, split by polarity so concerns stay visually primary and
  // positives read as supporting signal. Flags have no turn attribution, so no turn links.
  function flagChipsFor(flags, positive) {
    if (!flags || typeof flags !== 'object') return '';
    var keys = Object.keys(flags).filter(function (k) { return flags[k] && (!!TX_FLAG_POSITIVE[k] === positive); });
    if (!keys.length) return '';
    var chips = keys.map(function (k) {
      var label = TX_FLAG_LABELS[k] || titleEnum(k);
      var cls = positive ? 'tx-flagchip tx-flagchip--ok' : 'tx-flagchip tx-flagchip--warn';
      return '<li class="' + cls + '"><span class="tx-flagchip__icon" aria-hidden="true">' + (positive ? '✓' : '⚠') + '</span>'
        + '<span>' + esc(label) + '</span></li>';
    }).join('');
    return '<ul class="tx-flaglist">' + chips + '</ul>';
  }
  function concernFlagChips(flags) { return flagChipsFor(flags, false); }
  function positiveFlagChips(flags) { return flagChipsFor(flags, true); }

  // Turn-attributed "where it happened" links, drawn ONLY from stateEvidence drops, which
  // genuinely carry a turn seq. This is the sole defensible issue→turn bridge; we never
  // attribute a reviewer flag to a turn it doesn't name.
  function dropTurnLinks(stateEvidence) {
    if (!stateEvidence || !Array.isArray(stateEvidence.drops) || !stateEvidence.drops.length) return '';
    var bySeq = {};
    stateEvidence.drops.forEach(function (d) {
      if (!d || d.seq == null) return;
      (bySeq[d.seq] = bySeq[d.seq] || []).push(d.field);
    });
    var seqs = Object.keys(bySeq).sort(function (a, b) { return Number(a) - Number(b); });
    if (!seqs.length) return '';
    var items = seqs.map(function (seq) {
      var fields = bySeq[seq].filter(Boolean);
      return '<li class="tx-issueturn"><button type="button" class="tx-turnlink" data-txturn="' + esc(seq) + '">Turn ' + esc(seq) + '</button> '
        + 'established ' + (fields.length ? esc(fields.join(', ')) : 'information') + ' was dropped or contradicted</li>';
    }).join('');
    return '<p class="tx__sub">Where the evidence shows it — select a turn to jump to it in the Conversation:</p>'
      + '<ul class="tx-issueturns">' + items + '</ul>';
  }

  // Honest, turn-attributed markers for the Conversation layer: taken only from the
  // state-evidence drops, which carry a real turn seq. We do not attach flags to turns.
  function turnMarkerMap(stateEvidence) {
    var map = {};
    if (stateEvidence && Array.isArray(stateEvidence.drops)) {
      stateEvidence.drops.forEach(function (d) {
        if (d == null || d.seq == null) return;
        (map[d.seq] = map[d.seq] || []).push(d);
      });
    }
    return map;
  }

  // One stage, human-readable only (no raw detail) — used by the Diagnostic journey layer.
  function journeyStageHtml(stage, vis) {
    var ev = stage.evidence || 'NOT_CAPTURED';
    var evClass = esc(ev.toLowerCase().replace('_', '-'));
    return '<li class="tx-trace__node tx-trace__node--' + evClass + '">'
      + '<div class="tx-trace__head"><span class="tx-trace__badge tx-trace__badge--' + evClass + '">' + esc(ev.replace('_', ' ')) + '</span>'
      + '<span class="tx-trace__name">' + esc(stage.label || stage.id) + '</span></div>'
      + '<div class="tx-trace__hl">' + traceHighlight(stage, vis) + '</div></li>';
  }

  function journeyTurnHtml(t, ti, turns) {
    var trace = t.diagnosticTrace;
    var seq = t.seq != null ? t.seq : (ti + 1);
    var head = '<div class="tx-jturn__head">Turn ' + esc(String(seq)) + '</div>';
    if (!trace || !trace.stages) {
      return '<section class="tx-jturn">' + head
        + '<div class="tx-trace tx-trace--empty"><span>NOT CAPTURED — this transcript predates trace capture or capture was unavailable.</span></div></section>';
    }
    var prevTrace = ti > 0 ? turns[ti - 1].diagnosticTrace : null;
    var kstate = keyStateRow(traceKeyState(trace), prevTrace ? traceKeyState(prevTrace) : null);
    var vis = t.applianceClinic || {};
    var stages = trace.stages.map(function (s) { return journeyStageHtml(s, vis); }).join('');
    var progression = (trace.stateProgression || []).map(function (p) {
      return '<li class="tx-state tx-state--' + esc(String(p.change || '').toLowerCase()) + '"><b>' + esc(p.change) + '</b> '
        + '<code>' + esc(p.path) + '</code>' + (p.value == null ? '' : ' = ' + esc(String(p.value))) + '</li>';
    }).join('');
    return '<section class="tx-jturn">' + head + kstate
      + '<ol class="tx-trace__flow">' + stages + '</ol>'
      + (progression ? '<details class="tx-trace__progress"><summary>State changes vs previous turn</summary><ul>' + progression + '</ul></details>' : '')
      + '</section>';
  }


  // ---- Per-turn canonical technical panel (canonical-audit/1) ------------------------------------------
  // Rendered directly under the turn it belongs to, collapsed by default. Consumes ONLY the stored
  // transcript audit contract (turn.canonical) and the legacy trace; it never infers decisions from the
  // assistant text. Every value goes through esc().
  var TP_PATH = {
    control: { text: 'CONTROL', cls: 'tx-badge tx-badge--control' },
    shadow: { text: 'SHADOW / NOT CONTROLLED', cls: 'tx-badge tx-badge--shadow' },
    legacy: { text: 'LEGACY PATH', cls: 'tx-badge tx-badge--legacy' },
    degraded: { text: 'DEGRADED', cls: 'tx-badge tx-badge--warn' },
    mixed: { text: 'MIXED', cls: 'tx-badge tx-badge--shadow' }
  };
  var TP_COMPOSE = {
    llm: { text: 'LLM COMPOSE', cls: 'tx-badge tx-badge--ok' },
    fixed_fallback: { text: 'FIXED FALLBACK', cls: 'tx-badge tx-badge--warn' },
    fixed_safety: { text: 'FIXED SAFETY COPY', cls: 'tx-badge tx-badge--safety' },
    fixed_decline: { text: 'FIXED SAFETY DECLINE', cls: 'tx-badge tx-badge--safety' }
  };
  // Runtime pipeline stages for the turn (legacy + canonical), with the evidence legend.
  var TP_TRACE_LEGEND = '<div class="tx-trace__top"><span class="tx-trace__legend">'
    + '<span class="tx-trace__badge tx-trace__badge--observed">observed</span>'
    + '<span class="tx-trace__badge tx-trace__badge--derived">derived</span>'
    + '<span class="tx-trace__badge tx-trace__badge--not-captured">not captured</span></span></div>';
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
  function tpReq(r) { return r ? [r.slot, r.target].filter(Boolean).join(':') + (r.kind ? ' (' + r.kind + ')' : '') + (r.askedTurn != null ? ' · asked v' + r.askedTurn : '') : null; }
  function tpPathOf(c) { return c && c.schemaVersion === 'canonical-audit/1' ? (c.path || 'legacy') : 'legacy'; }
  // Summary chips: always visible on the collapsed panel, so a turn can be scanned without opening it.
  function turnChips(t) {
    var c = t.canonical;
    var p = TP_PATH[tpPathOf(c)] || TP_PATH.legacy;
    var degradedPath = tpPathOf(c) === 'degraded';
    var reason = c && c.persistence && c.persistence.degraded;
    var bits = [tpBadge(degradedPath && reason ? p.text + ' · ' + reason : p.text, p.cls)];
    if (!c) {
      var rt = t.runtime || {};
      if (rt.route) bits.push(tpBadge(rt.route, 'tx-badge'));
      if (rt.safetyStop) bits.push(tpBadge('SAFETY STOP', 'tx-badge tx-badge--safety'));
      return bits.join('');
    }
    if (c.owner) bits.push(tpBadge(c.owner, 'tx-badge tx-badge--journey'));
    var na = c.nextAction || {};
    if (na.rule) bits.push(tpBadge(na.rule, 'tx-badge tx-badge--rule'));
    if (na.kind) bits.push(tpBadge(tpUpper(na.kind), na.kind === 'safety_stop' ? 'tx-badge tx-badge--safety' : 'tx-badge'));
    if (na.target) bits.push(tpBadge(na.target, 'tx-badge tx-badge--target'));
    if (c.partGate) bits.push(c.partGate.eligible ? tpBadge('PART ELIGIBLE', 'tx-badge tx-badge--ok') : tpBadge('PART BLOCKED', 'tx-badge tx-badge--muted'));
    if (c.compose && TP_COMPOSE[c.compose.mode]) bits.push(tpBadge(TP_COMPOSE[c.compose.mode].text, TP_COMPOSE[c.compose.mode].cls));
    var ps = c.persistence || {};
    if (ps.degraded && !degradedPath) bits.push(tpBadge('DEGRADED · ' + ps.degraded, 'tx-badge tx-badge--warn'));
    if (ps.conflict) bits.push(tpBadge('CONFLICT', 'tx-badge tx-badge--warn'));
    if (ps.recovered) bits.push(tpBadge('REPLAY RECOVERY', 'tx-badge tx-badge--warn'));
    if (ps.idempotentReplay) bits.push(tpBadge('IDEMPOTENT REPLAY ×' + ps.idempotentReplay.count, 'tx-badge tx-badge--muted'));
    if (c.gateNotTaken) bits.push(tpBadge('GATE NOT TAKEN', 'tx-badge tx-badge--warn'));
    if (c.version && c.version.after != null) bits.push(tpBadge('v' + (c.version.before == null ? '—' : c.version.before) + ' → v' + c.version.after, 'tx-badge tx-badge--muted'));
    if (c.slim) bits.push(tpBadge('SUMMARY ONLY', 'tx-badge tx-badge--muted'));
    return bits.join('');
  }
  function tpSummaryHtml(c) {
    var na = c.nextAction || {}; var pr = c.pendingRequest || {}; var pg = c.partGate || null;
    return tpRow('Path', (TP_PATH[tpPathOf(c)] || TP_PATH.legacy).text)
      + tpRow('Appliance', c.appliance)
      + tpRow('Journey', c.owner ? c.owner + (c.journey && c.journey.schema ? ' (' + c.journey.schema + ')' : '') : null)
      + tpRow('State version', c.version ? (c.version.before == null ? '—' : 'v' + c.version.before) + ' → ' + (c.version.after == null ? '—' : 'v' + c.version.after) : null)
      + tpRow('Policy rule', c.policy && c.policy.rule)
      + tpRow('NextAction', na.kind ? tpUpper(na.kind) + (na.target ? ' · ' + na.target : '') : null)
      + tpRow('Pending request', pr.after ? tpReq(pr.after) : (pr.change === 'cleared' ? 'cleared' : (pr.change ? 'none' : null)))
      + tpRow('Part gate', pg ? (pg.eligible ? 'eligible' + (pg.component ? ' · ' + pg.component : '') : 'blocked · ' + (pg.blockers || []).slice(0, 3).join(', ')) : null)
      + tpRow('COMPOSE', c.compose ? (TP_COMPOSE[c.compose.mode] || {}).text || c.compose.mode : null)
      + (c.gateNotTaken ? '<p class="tx-tp__note">Policy decided this journey owns the turn, but the orchestrator answered on the legacy path.</p>' : '')
      + (c.slim ? '<p class="tx-tp__note">Older turn: only the summary is retained to keep the transcript record bounded.</p>' : '');
  }
  function tpClassificationHtml(k) {
    if (!k) return '<p class="tac__muted">No classification this turn.</p>';
    var obs = (k.observations || []).map(function (o) { return o.key + ' = ' + tpVal(o.value); });
    var chk = (k.checks || []).map(function (x) { return x.check + ': ' + [x.status, x.result].filter(Boolean).join(' / '); });
    var r = k.reply || {};
    return tpRow('Scope', k.scope)
      + tpRow('Appliance', k.appliance ? k.appliance.value + ' (' + k.appliance.basis + ')' : null)
      + tpRow('Make', k.make ? k.make.value + ' (' + k.make.basis + ')' : null)
      + tpRow('Model', k.model ? k.model.value + ' (' + k.model.basis + ')' : null)
      + tpRow('Model status', k.modelStatus) + tpRow('Fuel', k.fuel) + tpRow('Displayed code', k.displayedCode)
      + tpRow('Intent', k.intent) + tpRow('Fault domain', k.faultDomain) + tpRow('Journey', k.journey)
      + tpRow('Symptom scope', k.symptomScope) + tpRow('Relation', k.relation)
      + tpRow('Hazard', k.hazard) + tpRow('Unsafe action', k.unsafeAction)
      + tpRow('Reply to pending', r.toPending) + tpRow('Reply outcome', r.outcome) + tpRow('Correction', r.correction)
      + tpRow('Observations', obs) + tpRow('Checks', chk)
      + tpRow('Replaced parts', k.mentions && k.mentions.replacedParts) + tpRow('Customer theories', k.mentions && k.mentions.customerTheories);
  }
  function tpDeltaLine(d) {
    if (d.op === 'change') return '<li class="tx-delta tx-delta--change"><b>CHANGED</b> <code>' + esc(d.field) + '</code>: ' + esc(tpVal(d.from)) + ' → ' + esc(tpVal(d.to)) + '</li>';
    if (d.op === 'remove') return '<li class="tx-delta tx-delta--remove"><b>REMOVED</b> <code>' + esc(d.field) + '</code>' + (d.from != null ? ' (was ' + esc(tpVal(d.from)) + ')' : '') + '</li>';
    return '<li class="tx-delta tx-delta--add"><b>ADDED</b> <code>' + esc(d.field) + '</code> = ' + esc(tpVal(d.to)) + '</li>';
  }
  function tpStateHtml(c) {
    var d = c.stateDelta || [];
    var pr = c.pendingRequest || {};
    var pend = pr.change ? '<div class="tx-tp__sub">Pending request</div>'
      + tpRow('Before', pr.before ? tpReq(pr.before) : 'none') + tpRow('After', pr.after ? tpReq(pr.after) : (pr.change === 'cleared' ? 'cleared' : 'none'))
      + tpRow('Change', pr.change) + tpRow('Outcome recorded', pr.outcome) : '';
    var list = d.length ? '<ul class="tx-deltalist">' + d.map(tpDeltaLine).join('') + '</ul>'
      : '<p class="tac__muted">' + (c.path === 'degraded' ? 'Nothing merged this turn (degraded).' : 'No canonical state change this turn.') + '</p>';
    return list + pend + tpRow('Merge rules fired', c.rulesFired);
  }
  function tpDiagnosticsHtml(g) {
    if (!g) return '<p class="tac__muted">No diagnostics this turn.</p>';
    var lead = g.leader || {};
    var ranked = (g.ranked || []).map(function (r, i) {
      return '<li class="tx-rank' + (r.cause === lead.cause ? ' tx-rank--lead' : '') + '"><span class="tx-rank__n">' + (i + 1) + '.</span>'
        + '<span class="tx-rank__cause">' + esc(r.cause) + '</span><span class="tx-rank__score">' + esc(String(r.score)) + '</span></li>';
    }).join('');
    var top = (g.ranked || [])[0] || {};
    function evList(title, items) {
      return '<div class="tx-tp__sub">' + esc(title) + '</div>' + ((items && items.length)
        ? '<ul class="tx-evlist">' + items.map(function (x) { return '<li>' + esc(x) + '</li>'; }).join('') + '</ul>'
        : '<p class="tac__muted">none</p>');
    }
    var alts = (g.ranked || []).slice(1).filter(function (r) { return (r.for && r.for.length) || (r.against && r.against.length); });
    var altHtml = alts.length ? '<details class="tx-tp__more"><summary>Evidence for alternatives</summary>' + alts.map(function (r) {
      return '<div class="tx-tp__sub">' + esc(r.cause) + '</div>' + tpRow('For', r.for) + tpRow('Against', r.against);
    }).join('') + '</details>' : '';
    return tpRow('Leader', lead.cause ? lead.cause + (lead.committed ? ' (committed)' : ' (not committed)') + (lead.level ? ' · ' + lead.level : '') : null)
      + tpRow('Margin', lead.margin)
      + (ranked ? '<ol class="tx-ranklist">' + ranked + '</ol>' : '')
      + evList('Evidence for ' + (top.cause || 'the leader'), top.for) + evList('Evidence against', top.against)
      + altHtml
      + tpRow('Ruled out', g.ruledOut) + tpRow('Next discriminating check', g.pivotal ? g.pivotal.target + (g.pivotal.separates ? ' (separates ' + g.pivotal.separates.join(' / ') + ')' : '') : null)
      + tpRow('Likely resolved', g.likelyResolved) + tpRow('No viable cause', g.noViableCause)
      + tpRow('Part evidence', g.partEvidence ? (g.partEvidence.sufficient ? 'sufficient' : 'insufficient') + (g.partEvidence.reasons ? ' · ' + g.partEvidence.reasons.join(', ') : '') : null);
  }
  function tpPolicyHtml(c) {
    var p = c.policy || {}; var na = c.nextAction || {}; var cc = na.conclusion || {};
    if (!c.policy && !c.nextAction) return '<p class="tac__muted">No policy decision this turn.</p>';
    return tpRow('Rule', p.rule) + tpRow('Rule reason', p.label) + tpRow('Action', p.kind ? tpUpper(p.kind) : null) + tpRow('Target', p.target)
      + tpRow('Request kind', p.requestKind) + tpRow('Conclusion', p.conclusion) + tpRow('Outcome', p.outcome) + tpRow('Handoff', p.handoff)
      + tpRow('Safety stop', p.safetyStop)
      + '<div class="tx-tp__sub">NextAction</div>'
      + tpRow('Type', na.kind) + tpRow('Target', na.target) + tpRow('Purpose', na.purpose)
      + tpRow('Required safety', na.requiredSafety) + tpRow('Requires model', na.requiresModel)
      + tpRow('Conclusion', na.conclusion ? [cc.cause, cc.level, cc.confidence].filter(Boolean).join(' · ') + (cc.handoff && cc.handoff !== 'none' ? ' · handoff ' + cc.handoff : '') + (cc.noPart ? ' · no part' : '') : null)
      + tpRow('Approved part', na.part ? [na.part.partNo, na.part.title].filter(Boolean).join(' · ') : null);
  }
  function tpPartHtml(g) {
    if (!g) return '<p class="tac__muted">No part decision this turn.</p>';
    var l = g.lookup || {};
    return tpRow('Eligible', g.eligible) + tpRow('Component', g.component)
      + ((g.blockers || []).length ? '<div class="tx-tp__sub">Blocking reasons</div><ul class="tx-evlist">' + g.blockers.map(function (b) { return '<li>' + esc(b) + '</li>'; }).join('') + '</ul>' : '')
      + tpRow('Catalogue lookup', g.lookup ? (l.available ? 'compatible part found' : 'no compatible part') + (l.reason ? ' · ' + l.reason : '') : null)
      + tpRow('Matched', (l.matched || []).map(function (m) { return [m.partNo, m.title].filter(Boolean).join(' · '); }))
      + tpRow('Model part list size', g.modelParts);
  }
  function tpRuntimeHtml(t) {
    var c = t.canonical || {}; var ps = c.persistence || {}; var cm = c.compose || {}; var rt = t.runtime || {};
    return tpRow('Route', rt.route) + tpRow('Outcome', rt.outcome) + tpRow('Safety stop', rt.safetyStop || null) + tpRow('Safety class', rt.safetyClass)
      + tpRow('API error', rt.apiError || null) + tpRow('Request id', rt.requestId)
      + (t.canonical ? '<div class="tx-tp__sub">Canonical runtime</div>'
        + tpRow('Mode', c.mode) + tpRow('Controlled', c.controlled) + tpRow('Owner', c.owner) + tpRow('Session ref', c.ref)
        + tpRow('State digest', c.version && c.version.stateDigest)
        + tpRow('Persisted', ps.written) + tpRow('Turn record written', ps.recordWritten) + tpRow('Idempotent duplicate', ps.duplicate)
        + tpRow('Idempotent replay', ps.idempotentReplay ? ps.idempotentReplay.count + '× (last ' + ps.idempotentReplay.lastAt + ')' : null)
        + tpRow('Conflict', ps.conflict) + tpRow('Degraded', ps.degraded) + tpRow('Replay recovery', ps.recovered) + tpRow('Demoted to shadow', ps.demoted)
        + tpRow('Classifier', c.classifier ? [c.classifier.source, c.classifier.degraded ? 'degraded' : null, c.classifier.reason].filter(Boolean).join(' · ') : null)
        + (c.compose ? '<div class="tx-tp__sub">COMPOSE</div>' + tpRow('Mode', (TP_COMPOSE[cm.mode] || {}).text || cm.mode)
          + tpRow('Contract valid', cm.valid) + tpRow('Violations', cm.violations) + tpRow('Fallback reason', cm.fallbackReason)
          + tpRow('Latency ms', cm.latencyMs) + tpRow('Output chars', cm.outputChars) : '')
        : '<p class="tx-tp__note">LEGACY PATH — no canonical audit was recorded for this turn' + (t.diagnosticTrace ? '; see the Trace tab.' : '.') + '</p>');
  }
  function turnPanelHtml(t, ti, turns) {
    var c = t.canonical && t.canonical.schemaVersion === 'canonical-audit/1' ? t.canonical : null;
    var tabs = [];
    if (c) {
      tabs.push(['summary', 'Summary', tpSummaryHtml(c)]);
      if (c.classification) tabs.push(['classification', 'Classification', tpClassificationHtml(c.classification)]);
      if (c.stateDelta || c.pendingRequest) tabs.push(['state', 'State changes', tpStateHtml(c)]);
      if (c.diagnostics) tabs.push(['diagnostics', 'Diagnostics', tpDiagnosticsHtml(c.diagnostics)]);
      if (c.policy || c.nextAction) tabs.push(['policy', 'Policy', tpPolicyHtml(c)]);
      if (c.partGate) tabs.push(['part', 'Part', tpPartHtml(c.partGate)]);
    }
    tabs.push(['runtime', 'Runtime', tpRuntimeHtml(t)]);
    if (t.diagnosticTrace) tabs.push(['trace', 'Trace', TP_TRACE_LEGEND + journeyTurnHtml(t, ti, turns)]);
    var seq = t.seq != null ? t.seq : (ti + 1);
    var head = '<div class="tx-tp__tabs" role="tablist" aria-label="Turn ' + esc(String(seq)) + ' technical details">' + tabs.map(function (x, i) {
      return '<button type="button" role="tab" class="tx-tp__tab' + (i === 0 ? ' is-active' : '') + '" data-tptab="' + x[0] + '" aria-selected="' + (i === 0 ? 'true' : 'false') + '">' + esc(x[1]) + '</button>';
    }).join('') + '</div>';
    var panels = tabs.map(function (x, i) {
      return '<div class="tx-tp__panel" data-tppanel="' + x[0] + '" role="tabpanel"' + (i === 0 ? '' : ' hidden') + '>' + x[2] + '</div>';
    }).join('');
    var raw = c ? '<details class="tx-tp__raw"><summary>Raw audit JSON (developer)</summary><pre>' + esc(JSON.stringify(c, null, 2)) + '</pre></details>' : '';
    return '<details class="tx-tp" data-seq="' + esc(String(seq)) + '"><summary class="tx-tp__sum"><span class="tx-tp__label">Technical · turn ' + esc(String(seq)) + '</span>'
      + '<span class="tx-tp__chips">' + turnChips(t) + '</span></summary>'
      + '<div class="tx-tp__body">' + head + panels + raw + '</div></details>';
  }
  // Session header badges (detail page) and row badges (list) share the same vocabulary.
  function canonicalRowBadges(cs) {
    if (!cs) return tpBadge('LEGACY PATH', 'tx-badge tx-badge--legacy');
    var p = TP_PATH[cs.path] || TP_PATH.legacy;
    var bits = [tpBadge(p.text === 'SHADOW / NOT CONTROLLED' ? 'SHADOW' : p.text, p.cls)];
    if (cs.journey) bits.push(tpBadge(cs.journey, 'tx-badge tx-badge--journey'));
    if (cs.degraded) bits.push(tpBadge('DEGRADED', 'tx-badge tx-badge--warn'));
    return bits.join('');
  }

  // Technical layer: raw captured stage detail per turn, deliberately deep.
  function technicalTurnHtml(t, ti) {
    var trace = t.diagnosticTrace;
    var seq = t.seq != null ? t.seq : (ti + 1);
    if (!trace || !trace.stages) {
      return '<details class="tx-tech__turn"><summary>Turn ' + esc(String(seq)) + ' · no trace</summary>'
        + '<p class="tac__muted">NOT CAPTURED.</p></details>';
    }
    var stages = trace.stages.map(function (s) {
      var detail = s.detail == null ? '<span class="tac__muted">—</span>'
        : '<div class="tx-trace__detail">' + traceValue(s.detail) + '</div>';
      var ev = (s.evidence || 'NOT_CAPTURED').replace('_', ' ').toLowerCase();
      return '<div class="tx-tech__stage"><div class="tx-tech__stagehd">' + esc(s.label || s.id)
        + ' <i>(' + esc(ev) + ')</i></div>' + detail + '</div>';
    }).join('');
    return '<details class="tx-tech__turn"><summary>Turn ' + esc(String(seq)) + '</summary>' + stages + '</details>';
  }

  function technicalHtml(turns, metaRows) {
    var meta = '<h4 class="tx__h4">Session metadata</h4><div class="tx-techmeta">' + metaRows + '</div>';
    var raw = turns.length
      ? '<h4 class="tx__h4">Raw per-turn trace</h4>' + turns.map(technicalTurnHtml).join('')
      : '';
    return '<p class="tx__sub">Raw identifiers, timings and captured stage detail. For debugging.</p>' + meta + raw;
  }

  // Conversation layer: clean bubbles only. No inline diagnostic trace. A small, honest
  // per-turn marker appears only where state-evidence recorded a dropped/changed fact.
  function conversationHtml(turns, stateEvidence) {
    if (!turns.length) return '<p class="tac__muted">No turns recorded.</p>';
    var markers = turnMarkerMap(stateEvidence);
    return turns.map(function (t, ti) {
      var seq = t.seq != null ? t.seq : (ti + 1);
      var user = '<div class="tx__bubble tx__bubble--user"><div class="tx__who">Customer</div><div class="tx__text"></div>'
        + (t.customer && t.customer.photo ? '<div class="tx__photo">Photo attached (bytes not stored)</div>' : '') + '</div>';
      var vis = t.applianceClinic || {};
      var botInner = '';
      if (vis.diagnosisLabel) botInner += '<div class="tx__label"></div>';
      botInner += '<div class="tx__text"></div>';
      if (vis.safetyText) botInner += '<div class="tx__safety"></div>';
      if (vis.parts && vis.parts.length) botInner += '<div class="tx__chips">' + vis.parts.map(function (p) {
        return '<span class="tx__chip">' + esc(p.name) + (p.fitStatus ? ' · ' + esc(p.fitStatus) : '') + '</span>';
      }).join('') + '</div>';
      if (vis.media && vis.media.length) botInner += '<div class="tx__chips">' + vis.media.map(function (m) {
        return '<span class="tx__chip">' + esc(m.type || 'MEDIA') + ' · ' + esc(m.title || m.id || '') + '</span>';
      }).join('') + '</div>';
      var bot = '<div class="tx__bubble tx__bubble--bot"><div class="tx__who">ApplianceClinic</div>' + botInner + '</div>';
      var mk = markers[seq];
      var marker = '';
      if (mk && mk.length) {
        var fields = mk.map(function (d) { return d.field; }).filter(Boolean);
        marker = '<button type="button" class="tx__turnmark tx__turnmark--warn" data-txgoto="review">'
          + '<span aria-hidden="true">⚠</span> Established fact dropped here'
          + (fields.length ? ' (' + esc(fields.join(', ')) + ')' : '')
          + ' · see review</button>';
      }
      // The turn's technical panel sits directly under the turn it belongs to (collapsed by default).
      var panel = typeof turnPanelHtml === 'function' ? turnPanelHtml(t, ti, turns) : '';
      return '<div class="tx__turn" id="txturn-' + esc(String(seq)) + '">' + user + bot + marker + panel + '</div>';
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

  function focusTurn(seq) {
    switchTxTab('conversation');
    var el = $('txturn-' + seq);
    if (!el) return;
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    el.classList.add('is-focus');
    setTimeout(function () { el.classList.remove('is-focus'); }, 2000);
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
    Array.prototype.forEach.call(detail.querySelectorAll('.tx-turnlink'), function (b) {
      b.addEventListener('click', function () { focusTurn(b.getAttribute('data-txturn')); });
    });
    Array.prototype.forEach.call(detail.querySelectorAll('[data-txgoto]'), function (b) {
      b.addEventListener('click', function () { switchTxTab(b.getAttribute('data-txgoto')); });
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
          ['Model (resolved)', md.model],
          ['Extracted model (unconfirmed)', md.extractedModel],
          ['Error code', md.errorCode],
          ['Route', md.route],
          ['Internal outcome', md.outcome],
          ['Safety stop', md.safetyStop ? 'yes' : 'no'],
          ['Safety class', md.safetyClass],
          ['API error', md.hasError ? 'yes' : 'no'],
          ['Needs model', md.needsModel ? 'yes' : 'no'],
          ['Request id', md.lastRequestId],
          ['Trace id', md.lastTraceId],
        ].map(function (row) {
          return '<div class="health__row"><span>' + esc(row[0]) + '</span><span>' + esc(row[1] == null || row[1] === '' ? '—' : row[1]) + '</span></div>';
        }).join('');
        var headFlags = '';
        if (ov.reviewOverall) headFlags += '<span class="' + assessmentFlagClass(ov.reviewOverall) + '">' + esc(txLabel(TX_OVERALL_LABELS, ov.reviewOverall)) + '</span>';
        if (ov.reviewOutcome) headFlags += '<span class="tx__flag">' + esc(txLabel(TX_OUTCOME_LABELS, ov.reviewOutcome)) + '</span>';
        if (ov.needsAttention) headFlags += '<span class="tx__flag tx__flag--attn">Needs attention</span>';
        if (ov.reviewSafetyHandling === 'concern') headFlags += '<span class="tx__flag tx__flag--safety">Safety concern</span>';
        if (ov.lifecycle) headFlags += '<span class="tx__flag tx__flag--muted">' + esc(lifeLabel(ov.lifecycle)) + '</span>';
        var cs = ov.canonical || null;
        var headCanon = canonicalRowBadges(cs)
          + (ov.outcome && !(ov.safetyStop && ov.outcome === 'SAFETY_STOP') ? '<span class="tx__flag tx__flag--muted">' + esc(prettyEnum(ov.outcome)) + '</span>' : '')
          + (ov.partRecommended ? '<span class="tx__flag tx__flag--ok">Part recommended</span>' : '')
          + (ov.safetyStop ? '<span class="tx__flag tx__flag--safety">Safety stop</span>' : '');
        var anyConflict = turns.some(function (t) { return t.canonical && t.canonical.persistence && t.canonical.persistence.conflict; });
        if (anyConflict) headCanon += '<span class="tx__flag tx__flag--warn">Conflict</span>';
        var refLine = '<span class="tx__sub">Session <code class="tx__sid">' + esc(ov.sessionId || id) + '</code>'
          + (cs && cs.ref ? ' · canonical ref <code class="tx__sid">' + esc(cs.ref) + '</code>' : '')
          + (cs && cs.appliance ? ' · ' + esc(cs.appliance) : '') + '</span>';
        var errBanner = ov.hasError
          ? '<div class="tx-errbanner" role="status">This conversation recorded an API error. The turns below are still what the customer saw.</div>'
          : '';
        var sr = d.semanticReview || {};
        var a = sr.assessment || null;
        var reviewAttn = !!(a && (a.reviewPriority === 'important' || a.reviewPriority === 'worth_reviewing'
          || a.stateProgression === 'poor' || (a.concerns && a.concerns.length)));
        var reviewDot = reviewAttn ? '<span class="tx-tab__dot" aria-hidden="true"></span>' : '';
        var tabs = '<div class="tx-tabs" role="tablist" aria-label="Transcript layers">'
          + '<button type="button" role="tab" class="tx-tab is-active" data-txtab="conversation" aria-selected="true" tabindex="0">Conversation</button>'
          + '<button type="button" role="tab" class="tx-tab" data-txtab="review" aria-selected="false" tabindex="-1">Review' + reviewDot + '</button>'
          + '<button type="button" role="tab" class="tx-tab" data-txtab="technical" aria-selected="false" tabindex="-1">Technical</button>'
          + '</div>';
        var panels = '<div class="tx-panel" data-txpanel="conversation" role="tabpanel">'
          + '<div class="tx__chat" id="txChat">' + conversationHtml(turns, d.stateEvidence) + '</div></div>'
          + '<div class="tx-panel" data-txpanel="review" role="tabpanel" hidden>'
          + reviewPanelHtml(sr, ov.sessionId || id, d.stateEvidence) + '</div>'
          + '<div class="tx-panel" data-txpanel="technical" role="tabpanel" hidden>'
          + technicalHtml(turns, metaRows) + '</div>';
        detail.innerHTML =
          '<div class="tx__detailhead"><h2 class="admin__h2">' + esc(applianceLine(ov)) + '</h2>'
          + '<span class="tx__sub">' + esc(fmtWhen(ov.lastActivityAt)) + ' · '
          + esc((ov.turnCount || 0) + ((ov.turnCount === 1) ? ' turn' : ' turns')) + '</span></div>'
          + '<div class="tx-detailmeta">' + headCanon + headFlags + '</div>'
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
            var lab = botEl.querySelector('.tx__label');
            if (lab) lab.textContent = vis.diagnosisLabel || '';
            var reply = botEl.querySelector('.tx__text');
            if (reply) reply.textContent = vis.reply || '';
            var saf = botEl.querySelector('.tx__safety');
            if (saf) saf.textContent = vis.safetyText || '';
          }
        });
        fillReviewTexts(d.semanticReview);
        bindRereview(ov.sessionId || id, d.semanticReview);
        bindTxTabs(detail);
      })
      .catch(function () { detail.innerHTML = '<p class="tac__muted">Could not load that transcript.</p>'; });
  }
  function stateEvidenceHtml(ev) {
    if (!ev || !Array.isArray(ev.timeline) || !ev.timeline.length) return '';
    var rows = ev.timeline.map(function (t) {
      var changes = (t.changes || []).map(function (c) {
        var warn = /REMOVED_OR_CONTRADICTED/.test(c);
        return '<span class="tx__chip' + (warn ? ' tx__chip--warn' : '') + '">' + esc(c) + '</span>';
      }).join('');
      return '<li class="tx__evrow"><button type="button" class="tx__evseq tx-turnlink" data-txturn="' + esc(String(t.seq)) + '">Turn ' + esc(String(t.seq)) + '</button>' + changes + '</li>';
    }).join('');
    var dropNote = '';
    if (ev.droppedGroups && (ev.droppedGroups.identity || ev.droppedGroups.problem || ev.droppedGroups.evidence)) {
      var dg = [];
      if (ev.droppedGroups.identity) dg.push('identity');
      if (ev.droppedGroups.problem) dg.push('problem');
      if (ev.droppedGroups.evidence) dg.push('evidence');
      dropNote = '<p class="tx__sub">A previously established fact was dropped or contradicted ('
        + esc(dg.join(', ')) + '). This may be a legitimate customer correction or a lost fact — the review judges which.</p>';
    }
    return '<div class="tx-revblock"><h4 class="tx__h4">State progression evidence</h4>'
      + '<p class="tx__sub">' + esc(ev.note || '') + ' Select a turn to jump to it in the Conversation.</p>'
      + dropNote
      + '<ul class="tx__evlist">' + rows + '</ul>'
      + '</div>';
  }
  // The Review layer. Stage 2: a scannable "At a glance" verdict first, then What happened,
  // then Issues (concerns primary) and Strengths (supporting), with the reviewer dimensions
  // demoted into a collapsed "Detailed assessment". Turn attribution comes only from the
  // turn-linked state evidence, never from the (unattributed) reviewer flags.
  function glanceItem(label, dim, value) {
    var map = dim === 'overall' ? TX_OVERALL_LABELS
      : dim === 'outcome' ? TX_OUTCOME_LABELS
        : dim === 'safety' ? TX_SAFETY_LABELS
          : dim === 'progression' ? TX_PROGRESSION_LABELS
            : TX_PRIORITY_LABELS;
    return '<div class="tx-glance__item"><span class="tx-glance__k">' + esc(label) + '</span>'
      + '<span class="tx-glance__v tx-glance__v--' + txTone(dim, value) + '">' + esc(txLabel(map, value)) + '</span></div>';
  }
  function reviewPanelHtml(sr, sessionId, stateEvidence) {
    sr = sr || {};
    var a = sr.assessment || null;
    var status = sr.status || 'none';
    var overall = a && a.overallAssessment;
    var insuf = overall === 'insufficient_evidence';
    var failed = status === 'failed';
    var awaiting = status === 'awaiting';

    // At a glance — the five triage dimensions, scannable in one read.
    var glance;
    if (a) {
      glance = '<div class="tx-glance">'
        + glanceItem('Overall', 'overall', overall)
        + glanceItem('Outcome', 'outcome', a.outcome)
        + glanceItem('Safety', 'safety', a.safetyHandling)
        + glanceItem('Progression', 'progression', a.stateProgression || 'insufficient_evidence')
        + glanceItem('Priority', 'priority', a.reviewPriority)
        + '</div>';
    } else {
      var stateLabel = failed ? 'Review failed' : (awaiting ? 'Awaiting review' : 'Not reviewed yet');
      glance = '<div class="tx-glance tx-glance--empty"><span class="tx__flag tx__flag--muted">' + esc(stateLabel) + '</span></div>';
    }

    var insufNote = insuf
      ? '<div class="tx-insuf">There was not enough conversation to assess product quality. This is not a failure — the customer may have sent one message and left.</div>'
      : '';

    // Issues (concerns primary): named concern flags + turn-attributed drop evidence +
    // the reviewer's free-text concerns. Suppressed when evidence is insufficient.
    var concernChips = (a && !insuf) ? concernFlagChips(a.progressionFlags) : '';
    var dropLinks = insuf ? '' : dropTurnLinks(stateEvidence);
    var issuesBody = concernChips + dropLinks + '<ul id="txReviewConcerns" class="tx__revlist"></ul>';

    // Strengths (supporting): positive flags + the reviewer's free-text strengths.
    var positiveChips = a ? positiveFlagChips(a.progressionFlags) : '';
    var strengthsBody = positiveChips + '<ul id="txReviewStrengths" class="tx__revlist"></ul>';

    // Detailed assessment (demoted): the per-dimension grid + suggested product areas.
    var dims = '';
    if (a) {
      dims = dimRow('Understanding', a.understanding)
        + dimRow('Diagnostic reasoning', a.diagnosticReasoning)
        + dimRow('Conversation quality', a.conversationQuality)
        + dimRow('Safety handling', a.safetyHandling)
        + dimRow('Parts handling', a.partsHandling)
        + dimRow('Media handling', a.mediaHandling)
        + dimRow('Looping', a.looping)
        + dimRow('State progression', a.stateProgression || 'insufficient_evidence')
        + dimRow('Priority', a.reviewPriority);
    }
    var areas = (a && a.suggestedProductAreas && a.suggestedProductAreas.length)
      ? '<div class="tx-revblock"><h4 class="tx__h4">Suggested product areas</h4><div class="tx__chips">'
        + a.suggestedProductAreas.map(function (x) {
          return '<span class="tx__chip">' + esc(TX_AREA_LABELS[x] || titleEnum(x)) + '</span>';
        }).join('') + '</div></div>'
      : '';
    var detailed = '<details class="tx-dims"><summary>Detailed assessment</summary>'
      + (dims || '<p class="tac__muted">No assessment stored yet.</p>') + areas + '</details>';

    var action;
    if (sr.canRereview) {
      action = '<button type="button" class="btn btn--ghost" id="txRereview" data-sid="' + esc(sessionId) + '">Re-review</button>'
        + '<span class="tx__sub" id="txRereviewMsg"></span>';
    } else {
      action = '<p class="tac__muted">Review runs after the conversation ends (New Chat) or becomes inactive. Active chats are not judged mid-flight.</p>';
    }
    return '<div class="tx__review" id="txReview">'
      + '<p class="tx__reviewnotice">' + esc(sr.notice || 'LLM assessment of this conversation. Not what the customer saw, and not a change to the transcript.') + '</p>'
      + '<h4 class="tx__h4">At a glance</h4>'
      + glance
      + '<p class="tx__sub tx__reviewmeta" id="txReviewMeta">Version ' + esc(sr.version || sr.promptVersion || '—')
      + (sr.reviewedAt ? ' · ' + esc(fmtWhen(sr.reviewedAt)) : '')
      + (sr.provider || sr.model ? ' · ' + esc([sr.provider, sr.model].filter(Boolean).join(' / ')) : '')
      + ' · status ' + esc(status)
      + '</p>'
      + (sr.error ? '<p class="tx__reviewerr">Last error: ' + esc(sr.error) + '</p>' : '')
      + insufNote
      + '<div class="tx-revblock"><h4 class="tx__h4">What happened</h4><p class="tx__reviewlead" id="txReviewSummary"></p></div>'
      + '<div class="tx-revblock tx-revblock--issues"><h4 class="tx__h4">Issues</h4>' + issuesBody + '</div>'
      + '<div class="tx-revblock tx-revblock--strengths"><h4 class="tx__h4">Strengths</h4>' + strengthsBody + '</div>'
      + stateEvidenceHtml(stateEvidence)
      + detailed
      + '<div class="tx__reviewacts">' + action + '</div>'
      + '</div>';
  }
  function fillReviewTexts(sr) {
    var a = sr && sr.assessment;
    var sum = $('txReviewSummary');
    if (sum) {
      if (a && a.summary) sum.textContent = a.summary;
      else if (sr && sr.status === 'failed') sum.textContent = 'Review failed. The original transcript is unchanged.';
      else if (sr && sr.status === 'awaiting') sum.textContent = 'This conversation is waiting for an LLM assessment.';
      else sum.textContent = 'No LLM assessment stored yet.';
    }
    function fillList(id, items) {
      var ul = $(id);
      if (!ul) return;
      ul.innerHTML = '';
      (items || []).forEach(function (item) {
        var li = document.createElement('li');
        li.textContent = item;
        ul.appendChild(li);
      });
      if (!items || !items.length) {
        var empty = document.createElement('li');
        empty.className = 'tac__muted';
        empty.textContent = 'None recorded.';
        ul.appendChild(empty);
      }
    }
    fillList('txReviewStrengths', a && a.strengths);
    fillList('txReviewConcerns', a && a.concerns);
  }
  function bindRereview(sessionId, sr) {
    var btn = $('txRereview');
    if (!btn) return;
    btn.addEventListener('click', function () {
      if (btn.disabled) return;
      var msg = $('txRereviewMsg');
      btn.disabled = true;
      btn.setAttribute('aria-busy', 'true');
      btn.textContent = 'Reviewing…';
      if (msg) msg.textContent = 'This can take a short while. The original transcript is not changed.';
      fetch(API_BASE + '/admin/transcripts/session/review?id=' + encodeURIComponent(sessionId), {
        method: 'POST',
        credentials: 'same-origin',
        headers: { accept: 'application/json' }
      })
        .then(readJson)
        .then(function (res) {
          if (res.status === 401) return; // readJson showed the login gate
          if (res.status === 429) {
            if (msg) msg.textContent = 'Please wait a few seconds before requesting another review.';
            btn.disabled = false;
            btn.removeAttribute('aria-busy');
            btn.textContent = 'Re-review';
            return;
          }
          if (!res.ok) {
            if (msg) msg.textContent = (res.body && res.body.error) ? String(res.body.error) : 'Review could not run.';
            btn.disabled = false;
            btn.removeAttribute('aria-busy');
            btn.textContent = 'Re-review';
            openTranscript(sessionId);
            return;
          }
          openTranscript(sessionId);
        })
        .catch(function () {
          if (msg) msg.textContent = 'Review request failed.';
          btn.disabled = false;
          btn.removeAttribute('aria-busy');
          btn.textContent = 'Re-review';
        });
    });
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
  // registered with guardForm() (batch review note, override decision reason, Settings Jev / key dialogs).
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
      isDirty: function () { return !!((ecEd && ecEd.dirty) || (mdEd && mdEd.dirty) || (rcEd && rcEd.dirty) || (edState && edState.dirty) || (stEd && stEd.dirty) || dirtyForm()); },
      ask: knAskLeave,
      discard: function () { discardForms(); ecEd = null; mdEd = null; rcEd = null; edState = null; stDiscardEditor(); },
    });
    return _knGuard;
  }
  function dirtyEditor() {
    if (ecEd && ecEd.dirty) return ecEd;
    if (mdEd && mdEd.dirty) return mdEd;
    if (rcEd && rcEd.dirty) return rcEd;
    if (edState && edState.dirty) return edState;
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
    var bodyText = dirtyEd && dirtyEd === ecEd ? EC_TEXT.leave : (dirtyEd && dirtyEd === mdEd ? MD_TEXT.leave : (dirtyEd && dirtyEd === rcEd ? RC_TEXT.leave : (dirtyEd && dirtyEd === edState ? LIB_TEXT.leave : (dirtyEd && dirtyEd === stEd ? ST_TEXT.leave : (dirtyEd && dirtyEd.leave ? dirtyEd.leave : T.body)))));
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
      html += dgKv('Orchestrator timeout', rt.orchestratorTimeoutMs != null ? rt.orchestratorTimeoutMs + ' ms' : null);
      html += dgKv('Media overlay cache TTL', rt.mediaOverlayCacheTtlMs != null ? Math.round(rt.mediaOverlayCacheTtlMs / 1000) + ' seconds' : null);
      html += dgKv('Supported appliance families', (rt.supportedFamilies && rt.supportedFamilies.length) ? rt.supportedFamilies.join(', ') : null);
      if (models.understand) {
        html += dgKv('UNDERSTAND', (models.understand.providerLabel || models.understand.provider || '') + ' · ' + (models.understand.modelLabel || models.understand.model || 'Version not exposed by runtime'));
      }
      if (models.compose) {
        html += dgKv('COMPOSE', (models.compose.providerLabel || models.compose.provider || '') + ' · ' + (models.compose.modelLabel || models.compose.model || 'Version not exposed by runtime'));
      }
      if (rt.canonical) {
        // Read-only: the canonical mode is deploy configuration, never changed from Admin.
        var cm = rt.canonical;
        html += dgKv('Canonical conversation mode', (cm.modeLabel || cm.mode) + (cm.demoted ? ' — demoted to shadow (empty allow-list)' : '') + (cm.invalid ? ' — invalid setting, treated as off' : ''));
        if (cm.mode === 'control') html += dgKv('Canonical control journeys', cm.controlJourneyCount != null ? String(cm.controlJourneyCount) + ' enabled' : null);
        if (cm.unknownKeyCount) html += dgKv('Ignored allow-list keys', String(cm.unknownKeyCount) + ' not in the journey registry');
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
      if (t.models && t.models.judge) {
        htmlT += '<h3 class="dg-subh">Quality review model</h3><p class="dg-wrap">' + esc((t.models.judge.providerLabel || '') + ' · ' + (t.models.judge.modelLabel || 'Reviewer not set')) + '. ' + esc(t.models.judge.note || '') + '</p>';
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
  // Read-only view of every setting (traced to its runtime consumer) + one staged edit flow for live
  // diagnostic inference: edit locally → review the exact changes, impact and timing → reason →
  // Apply → server validation + revision check → single whole-document write → read-back confirmation.
  var stView = null;
  var stWired = false;
  // The open inference editor for the shared unsaved-changes guard. `dirty` is computed from the
  // dialog fields against the values it was opened with (no per-keystroke listeners, no autosave).
  var stEd = null;
  var ST_TEXT = {
    leave: 'You have an unapplied diagnostic inference change. If you leave now it will be discarded. The live configuration is not affected.',
  };
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
  function stSetRoute(name, value) {
    Array.prototype.forEach.call(document.querySelectorAll('input[name="' + name + '"]'), function (r) { r.checked = r.value === value; });
  }
  function stGetRoute(name) {
    var r = document.querySelector('input[name="' + name + '"]:checked');
    return r ? r.value : 'local';
  }
  function stLockFrontier(on) {
    Array.prototype.forEach.call(document.querySelectorAll('input[name="stCompose"][value="frontier"]'), function (r) {
      r.disabled = !on;
      if (r.closest('label')) r.closest('label').classList.toggle('is-disabled', !on);
    });
    var lock = $('stFrontierLock');
    if (lock) lock.hidden = !!on;
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
    var inf = d.diagnosticInference || {};
    // inf.setup is the same anti-masquerade describeSetup object TAC consumes.
    if (!inf.setup || !inf.setup.understand || !inf.setup.compose) {
      $('stInfCards').innerHTML = '<p class="st-note">Could not describe the current diagnostic setup.</p>';
    } else {
      $('stInfCards').innerHTML = St.inferenceCardHtml(inf.understand) + St.inferenceCardHtml(inf.compose);
    }
    $('stInfMeta').textContent = St.metaLine(inf) + ' · ' + ((inf.propagation && inf.propagation.note) || '');
    var store = inf.store || {};
    $('stInfStore').hidden = !store.note;
    $('stInfStore').textContent = store.note || '';
    var extras = [];
    extras.push('<div><dt>OpenAI credential</dt><dd>' + St.esc(St.credentialLabel(inf.frontier && inf.frontier.credential)) + '</dd></div>');
    extras.push('<div><dt>Private AI endpoint</dt><dd>' + (inf.local && inf.local.endpointOverrideSet ? 'Custom override set' : 'Deployed default') + '</dd></div>');
    extras.push('<div><dt>Takes effect</dt><dd>Within about ' + Math.round(((inf.propagation && inf.propagation.maxMs) || 120000) / 60000) + ' minutes</dd></div>');
    $('stInfExtras').innerHTML = extras.join('');
    if ($('stRuntimeStatus')) $('stRuntimeStatus').innerHTML = St.runtimeStatusHtml(d.runtimeStatus);
    // A batch run that owns live routing: the values shown are TEMPORARY, and Apply is blocked.
    var bo = d.batchOverride;
    var boOn = Boolean(bo && (bo.active || bo.blocked));
    if ($('stOverride')) { $('stOverride').hidden = !boOn; $('stOverride').innerHTML = boOn ? St.batchOverrideHtml(bo) : ''; }
    if ($('stEditInference')) {
      $('stEditInference').disabled = boOn;
      $('stEditInference').setAttribute('aria-describedby', boOn ? 'stOverride' : 'stInfMeta');
    }
    if ($('stInventory')) $('stInventory').innerHTML = St.inventoryHtml(inf.settings);
    if ($('stHistoryBody')) $('stHistoryBody').innerHTML = St.historyHtml(inf.history);
    if ($('stUnaudited')) $('stUnaudited').textContent = inf.unauditedWriteNote || '';
    if ($('stKeyHistoryBody')) $('stKeyHistoryBody').innerHTML = St.historyHtml(inf.frontier && inf.frontier.credentialHistory, 'No credential replacements recorded yet.');
    var rev = d.productionReview || {};
    var tr = rev.transcriptReview || {};
    var qr = rev.qualityReviewer || {};
    $('stReviewBody').innerHTML =
      St.readOnlyRowHtml('Transcript semantic review', (tr.providerLabel || '—') + ' — ' + (tr.modelLabel || '—'), tr.source,
        (tr.enabled ? 'Enabled' : 'Disabled') + (tr.customEndpoint ? '. Custom endpoint configured.' : '.') + ' Cadence is deployment-managed.')
      + St.readOnlyRowHtml('Quality reviewer', (qr.providerLabel || '—') + ' — ' + (qr.modelLabel || '—'), qr.source, qr.note);
    fillRetention(d.transcripts);
    var conv = d.conversation || {};
    $('stConversationBody').innerHTML = St.readOnlyRowHtml('Conversation window', String(conv.windowTurns) + ' recent turns', conv.source, conv.note);
    $('stElsewhere').innerHTML = St.elsewhereHtml(d.elsewhere);
    $('stTechnical').innerHTML = St.technicalHtml(d.technical);
    stLockFrontier(inf.frontier && inf.frontier.credential === 'configured');
    var keyBtn = $('stOpenKey');
    if (keyBtn) {
      keyBtn.textContent = (inf.frontier && inf.frontier.credential === 'configured') ? 'Replace OpenAI credential' : 'Add OpenAI credential';
    }
    if ($('stKeyImpact')) $('stKeyImpact').textContent = 'Used by: ' + ((inf.frontier && inf.frontier.usedBy) || 'COMPOSE when routed to OpenAI, batch frontier experiments and the quality reviewer.')
      + (inf.frontier && inf.frontier.credentialUpdatedAt ? ' Last replaced ' + new Date(inf.frontier.credentialUpdatedAt).toLocaleString('en-GB') + (inf.frontier.credentialUpdatedByEmail ? ' by ' + inf.frontier.credentialUpdatedByEmail : '') + '.' : '');
    var jev = d.jev || {};
    var jevStore = jev.store || {};
    if ($('stJevStore')) {
      $('stJevStore').hidden = !jevStore.note;
      $('stJevStore').textContent = jevStore.note || '';
    }
    if ($('stJevBody')) $('stJevBody').innerHTML = St.jevSectionHtml(jev);
    if ($('stJevHistoryBody')) $('stJevHistoryBody').innerHTML = St.historyHtml(jev.history, 'No Jev changes recorded through Settings yet.');
    var jevBtn = $('stEditJev');
    if (jevBtn) jevBtn.textContent = jev.credentialConfigured ? 'Update Jev configuration' : 'Configure Jev';
  }
  function loadSettings() {
    var status = $('stStatus');
    if (status) status.textContent = 'Loading configuration…';
    // GET only: viewing Settings never writes anything.
    return stApi('/admin/settings').then(function (res) {
      if (!res.ok || !res.body) { if (status) status.textContent = 'Could not load settings.'; return; }
      applySettingsView(res.body);
      if (status) status.textContent = 'Showing the stored configuration (revision ' + ((res.body.diagnosticInference && res.body.diagnosticInference.revision) || '—') + ') and what Part Finder reports it is running.';
      stApi('/admin/ai-config/local-models').then(function (m) {
        var dl = $('stLocalModelsList');
        if (!dl || !m.body) return;
        dl.innerHTML = '';
        (m.body.all || []).forEach(function (id) { var o = document.createElement('option'); o.value = id; dl.appendChild(o); });
      });
      if (stView && stView.diagnosticInference && stView.diagnosticInference.frontier && stView.diagnosticInference.frontier.credential === 'configured') {
        stApi('/admin/ai-config/frontier-models').then(function (m) {
          var dl = $('stFrontierModelsList');
          if (!dl || !m.body || !m.body.models) return;
          dl.innerHTML = '';
          m.body.models.forEach(function (id) { var o = document.createElement('option'); o.value = id; dl.appendChild(o); });
        });
      }
    });
  }
  function stFillEditor() {
    var inf = (stView && stView.diagnosticInference) || {};
    stSetRoute('stCompose', (inf.compose && inf.compose.configured && inf.compose.configured.route) || 'local');
    $('stLocalModel').value = (inf.local && inf.local.model) || '';
    $('stFrontierModel').value = (inf.frontier && inf.frontier.model) || '';
    $('stLocalEndpoint').value = '';
    if (inf.local && inf.local.endpointOverrideSet) $('stLocalEndpoint').placeholder = 'A custom address is saved — leave blank to keep it, or type a new one';
    $('stEditErr').textContent = '';
    stLockFrontier(inf.frontier && inf.frontier.credential === 'configured');
  }
  function stProposed() {
    var inf = (stView && stView.diagnosticInference) || {};
    var endpoint = $('stLocalEndpoint').value.trim();
    return {
      expectedVersion: inf.version || 1,
      expectedRevision: inf.revision || undefined,
      routing: { compose: stGetRoute('stCompose') },
      local: { enabled: true, model: $('stLocalModel').value.trim(), endpoint: endpoint || undefined },
      frontier: { model: $('stFrontierModel').value.trim() },
    };
  }
  function stWithNote(p) { p.note = ($('stChangeNote') && $('stChangeNote').value.trim()) || undefined; return p; }
  function stEditorOpen() {
    var base = JSON.stringify(stProposed());
    stEd = { hash: location.hash, base: base };
    Object.defineProperty(stEd, 'dirty', { get: function () { var dlg = $('stEditDlg'); return Boolean(dlg && dlg.open && JSON.stringify(stProposed()) !== base); } });
  }
  // Shared-guard discard: close the Settings dialogs so the page beneath matches the discarded state.
  function stDiscardEditor() { if (stEd) stCloseDialogs(); }
  function stCloseDialogs() {
    ['stConfirmDlg', 'stEditDlg'].forEach(function (id) { var d = $(id); if (d && d.open) d.close(); });
    stEd = null;
  }
  function stSaveProposed(payload) {
    var err = $('stConfirmErr');
    var yes = $('stConfirmYes');
    if (err) { err.textContent = 'Applying…'; err.className = 'st-result'; }
    if (yes) yes.disabled = true;
    return stApi('/admin/settings/diagnostic-inference', { method: 'PATCH', body: payload }).then(function (res) {
      if (yes) yes.disabled = false;
      if (res.ok && res.body) {
        var apply = res.body.apply || {};
        applySettingsView(res.body);
        stCloseDialogs();
        if (!apply.written) { stNotice('ok', 'No changes — nothing was written. The live configuration is unchanged.'); return; }
        stNotice(apply.verified ? 'ok' : 'bad', (apply.verified
          ? 'Applied and confirmed stored (version ' + apply.version + '). '
          : (apply.verificationNote ? 'Written. ' + apply.verificationNote + ' ' : 'Written, but the stored configuration could not be re-read to confirm it. Reload Settings to check what is stored. '))
          + (apply.propagation || '') + ' (Running values are from Part Finder health.)');
        var status = $('stStatus'); if (status) status.textContent = 'Change applied. Part Finder takes up to about 2 minutes to use it.';
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
    var inf = (stView && stView.diagnosticInference) || {};
    var payload = stProposed();
    var changes = St.reviewChanges(inf, payload);
    var live = changes.some(function (c) { return c.live; });
    var body = $('stConfirmBody');
    if (body) body.innerHTML = St.reviewHtml(changes, inf.propagation && inf.propagation.note);
    if ($('stChangeNoteReq')) $('stChangeNoteReq').textContent = live ? '(required — this changes live diagnosis)' : '(optional)';
    if ($('stChangeNote')) { $('stChangeNote').value = ''; $('stChangeNote').removeAttribute('aria-invalid'); }
    if ($('stConfirmErr')) { $('stConfirmErr').textContent = ''; $('stConfirmErr').className = 'st-result'; }
    if ($('stConflictReload')) $('stConflictReload').hidden = true;
    if ($('stConfirmYes')) { $('stConfirmYes').disabled = !changes.length; $('stConfirmYes').textContent = live ? 'Apply live change' : 'Apply change'; }
    var dlg = $('stConfirmDlg');
    if (dlg && dlg.showModal) dlg.showModal();
    if ($('stChangeNote') && changes.length) $('stChangeNote').focus();
  }
  function wireSettings() {
    if (stWired) return;
    stWired = true;
    if ($('stRefresh')) $('stRefresh').addEventListener('click', loadSettings);
    if ($('stEditInference')) $('stEditInference').addEventListener('click', function () {
      stFillEditor();
      var dlg = $('stEditDlg');
      if (dlg && dlg.showModal) dlg.showModal();
      stEditorOpen();
      if ($('stEditSave')) $('stEditSave').focus();
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
    // Review step: the change list + impact + timing are shown BEFORE anything is written.
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
      if ($('stFrontierKey')) $('stFrontierKey').focus();
    });
    if ($('stSaveKey')) $('stSaveKey').addEventListener('click', function () {
      var key = ($('stFrontierKey') && $('stFrontierKey').value.trim()) || '';
      var out = $('stKeyResult');
      if (!key) { if (out) { out.textContent = 'Enter a key to store. Blank does not delete the existing credential.'; out.className = 'st-result is-bad'; } return; }
      var inf = (stView && stView.diagnosticInference) || {};
      var liveRoute = inf.compose && inf.compose.configured && inf.compose.configured.route === 'frontier';
      if (liveRoute && !window.confirm('COMPOSE is routed to OpenAI. Replacing the key changes the credential used for live customer replies within about 1 minute. Continue?')) return;
      if (out) { out.textContent = 'Saving…'; out.className = 'st-result'; }
      stApi('/admin/ai-config/key', { method: 'POST', body: { apiKey: key } }).then(function (res) {
        if (res.ok) {
          if ($('stFrontierKey')) $('stFrontierKey').value = '';
          if (out) { out.textContent = 'Credential stored. It is never shown again.'; out.className = 'st-result is-ok'; }
          loadSettings();
        } else if (out) { out.textContent = (res.body && res.body.error) || 'Could not store the credential.'; out.className = 'st-result is-bad'; }
      });
    });
    function stFillJevEditor() {
      var jev = (stView && stView.jev) || {};
      if ($('stJevAccountId')) $('stJevAccountId').value = jev.accountId || '';
      if ($('stJevGatewayId')) $('stJevGatewayId').value = jev.gatewayId || '';
      if ($('stJevToken')) $('stJevToken').value = '';
      if ($('stJevNote')) $('stJevNote').value = '';
      if ($('stJevSaveResult')) { $('stJevSaveResult').textContent = ''; $('stJevSaveResult').className = 'st-result'; }
    }
    if ($('stEditJev')) $('stEditJev').addEventListener('click', function () {
      stFillJevEditor();
      var dlg = $('stJevDlg');
      if (dlg && dlg.showModal) dlg.showModal();
      if ($('stJevAccountId')) $('stJevAccountId').focus();
    });
    // The Jev and OpenAI-key dialogs are guarded like the inference editor (browser Back / tab close).
    var stVal = function (id) { return ($(id) && $(id).value.trim()) || ''; };
    guardForm('stJevDlg', { el: $('stJevDlg'), hash: '#settings',
      isDirty: function () { var d = $('stJevDlg'); var jev = (stView && stView.jev) || {}; return Boolean(d && d.open && (stVal('stJevToken') || stVal('stJevNote') || stVal('stJevAccountId') !== (jev.accountId || '') || stVal('stJevGatewayId') !== (jev.gatewayId || ''))); },
      discard: function () { var d = $('stJevDlg'); if ($('stJevToken')) $('stJevToken').value = ''; if (d && d.open) d.close(); },
      leave: 'You have unsaved Jev changes. If you leave now they will be lost. The live Jev configuration is not affected.' });
    guardForm('stKeyDlg', { el: $('stKeyDlg'), hash: '#settings',
      isDirty: function () { var d = $('stKeyDlg'); return Boolean(d && d.open && stVal('stFrontierKey')); },
      discard: function () { var d = $('stKeyDlg'); if ($('stFrontierKey')) $('stFrontierKey').value = ''; if (d && d.open) d.close(); },
      leave: 'You have typed an OpenAI key that has not been stored. If you leave now it will be cleared. The stored credential is not affected.' });
    if ($('stSaveJev')) $('stSaveJev').addEventListener('click', function () {
      var jev = (stView && stView.jev) || {};
      var out = $('stJevSaveResult');
      var payload = {
        expectedVersion: jev.version || 1,
        accountId: ($('stJevAccountId') && $('stJevAccountId').value.trim()) || '',
        gatewayId: ($('stJevGatewayId') && $('stJevGatewayId').value.trim()) || '',
        apiToken: ($('stJevToken') && $('stJevToken').value.trim()) || '',
        note: ($('stJevNote') && $('stJevNote').value.trim()) || undefined,
      };
      if (out) { out.textContent = 'Saving…'; out.className = 'st-result'; }
      stApi('/admin/settings/jev', { method: 'PATCH', body: payload }).then(function (res) {
        if (res.ok) {
          var apply = res.body.apply || {};
          if ($('stJevToken')) $('stJevToken').value = '';
          applySettingsView(res.body);
          var dlg = $('stJevDlg'); if (dlg && dlg.open) dlg.close();
          stNotice(apply.written === false ? 'ok' : (apply.verified ? 'ok' : 'bad'), apply.written === false ? 'No Jev changes — nothing was written.'
            : (apply.verified ? 'Jev configuration stored and confirmed (version ' + apply.version + '). ' : 'Jev configuration written but could not be re-read to confirm. Reload to check. ') + (apply.propagation || '') + ' The token is never shown again.');
          return;
        }
        var msg = St.errorText(res, 'Could not save Jev configuration.') + (res.status === 409 ? ' Close this dialog and press Refresh.' : ' Nothing was changed.');
        if (out) { out.textContent = msg; out.className = 'st-result is-bad'; }
        if (res.body && res.body.code === 'reason_required' && $('stJevNote')) $('stJevNote').focus();
      });
    });
    function probe(path, payload) {
      var out = $('stTestResult');
      if (out) { out.textContent = 'Checking…'; out.className = 'st-result'; }
      stApi(path, { method: 'POST', body: payload || {} }).then(function (res) {
        var r = res.body || {};
        var ok = r.status === 'ONLINE';
        var labels = { ONLINE: 'Reachable', OFFLINE: 'Could not reach it', CONFIG_ERROR: 'Setup problem', MODEL_ERROR: 'Model problem' };
        var txt = (labels[r.status] || r.status || 'Could not check') + (r.detail ? ' — ' + r.detail : '');
        if (ok && r.latencyMs != null) txt += ' (' + r.latencyMs + ' ms)';
        if (out) { out.textContent = txt; out.className = 'st-result ' + (ok ? 'is-ok' : 'is-bad'); }
      });
    }
    if ($('stTestLocal')) $('stTestLocal').addEventListener('click', function () { probe('/admin/ai-config/test-local', {}); });
    if ($('stTestFrontier')) $('stTestFrontier').addEventListener('click', function () { probe('/admin/ai-config/test-frontier', {}); });
    if ($('stTestJev')) $('stTestJev').addEventListener('click', function () {
      var out = $('stJevTestResult');
      if (out) { out.textContent = 'Checking…'; out.className = 'st-result'; }
      stApi('/admin/settings/jev/test', { method: 'POST', body: {} }).then(function (res) {
        var r = res.body || {};
        var ok = r.connected === true || r.status === 'ONLINE';
        var txt = ok ? 'Connected' : 'Failed';
        if (ok && r.model) txt += ' — ' + r.model;
        if (r.latencyMs != null) txt += ' (' + r.latencyMs + ' ms)';
        if (!ok && r.errorCategory) txt += ' — ' + r.errorCategory;
        if (out) { out.textContent = txt; out.className = 'st-result ' + (ok ? 'is-ok' : 'is-bad'); }
      });
    });
  }
  wireSettings();

  // ---- Quality Benchmark (ACQ-100) ----------------------------------------
  var acqLoaded = false;
  var acqActivePoll = null;
  var acqSelected = [];
  function acqEl(id) { return document.getElementById(id); }
  function ms(v) { return (v == null) ? 'n/a' : (v >= 1000 ? (Math.round(v / 100) / 10) + 's' : Math.round(v) + 'ms'); }

  function ensureTacPage() {
    tacWire();
    wbWire();
    if (!acqLoaded) { acqLoaded = true; tacLoad(); tacLoadHistory(); libLoadOptions(); }
    else tacLoad();
  }

  // ===== Unified Test area: Live test / Scenarios / Batch tabs ==============
  function showTestTab(name) {
    Array.prototype.forEach.call(document.querySelectorAll('.test-tab'), function (b) {
      var on = b.getAttribute('data-testtab') === name;
      b.classList.toggle('is-active', on);
      b.setAttribute('aria-selected', on ? 'true' : 'false');
      b.tabIndex = on ? 0 : -1;
    });
    Array.prototype.forEach.call(document.querySelectorAll('.test-panel'), function (p) {
      p.hidden = p.getAttribute('data-testtab') !== name;
    });
  }
  var testTabsBound = false;
  function bindTestTabs() {
    if (testTabsBound) return;
    testTabsBound = true;
    Array.prototype.forEach.call(document.querySelectorAll('.test-tab'), function (b) {
      b.addEventListener('click', function () {
        var tab = b.getAttribute('data-testtab');
        // Switching tab leaves an open scenario editor: ask first if it has unsaved changes.
        knLeaveGuard().leave(function () {
          showTestTab(tab);
          var params = tab === 'scenarios' ? libListParams() : (tab === 'live' ? {} : { tab: tab });
          writeHash('test', params);
          testShowRoute(tab, '', params);
        });
      });
    });
  }
  // One router for the Test tabs' own pages. Lists keep their filters in the URL; the dedicated
  // pages carry the id as a path segment so Back, refresh and shared links all land correctly.
  function testShowRoute(tab, sub, params) {
    params = params || {};
    if (tab === 'scenarios') {
      if (sub.indexOf('scenario/') === 0) {
        var sid = sub.slice('scenario/'.length);
        if (sid === 'new') libShowPage('create', null, params);
        else libShowPage(params.view === 'edit' ? 'edit' : 'detail', sid, params);
      } else libShowList(params);
    } else if (tab === 'batch') {
      if (sub.indexOf('run/') === 0) tacShowRunPage(sub.slice('run/'.length), params);
      else tacShowList();
    } else {
      edState = null;
    }
  }
  // One entry point for the whole Test page: wires the live workbench, loads the
  // batch runner config/history + scenario library, and binds the tabs.
  function ensureTestPage() {
    ensureTacPage();
    ensureLibPage();
    bindTestTabs();
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
  var wbScenarioTitle = null;
  var wbLaterTurns = [];
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
  function wbRenderModelRequest() {
    var wrap = wbNode('div', 'model-req');
    wrap.appendChild(wbNode('div', 'model-req__label', 'To check a suitable replacement'));
    wrap.appendChild(wbNode('p', 'model-req__text',
      'Enter your model number below. Once we have the model I can check whether a suitable replacement is available. It’s usually on a sticker inside the door or around the frame, or on the back of the appliance.'));
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
    var advice = !!view.advisory;
    var turn = wbNode('div', 'turn turn--bot' + (advice ? ' turn--advice' : ''));
    var resp = wbNode('div', 'response');
    if (advice) resp.appendChild(wbNode('h3', 'response__diag', 'Maintenance tip'));
    else if (view.diagnosis && view.diagnosis.label) resp.appendChild(wbNode('h3', 'response__diag', view.diagnosis.label));
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
    } else if (view.needsModel && !view.extractedModel) {
      turn.appendChild(wbRenderModelRequest());
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
  // One line under each ApplianceClinic turn: turn number, continuity, state version, journey, time.
  function wbTurnMetaText(view, turnMeta) {
    var st = view && view.liveTest;
    if (!st && !turnMeta) return null;
    var bits = [];
    if (turnMeta && turnMeta.index) bits.push('Turn ' + turnMeta.index);
    if (st) {
      bits.push('State: ' + (Workbench ? Workbench.continuityLabel(st) : st.continuity));
      var c = st.canonical || {};
      if (c.resultVersion != null) bits.push('v' + (c.priorVersion == null ? '\u2014' : c.priorVersion) + ' \u2192 v' + c.resultVersion);
      if (c.journey && c.journey.key) bits.push(c.journey.key);
    }
    if (turnMeta && typeof turnMeta.durationMs === 'number') bits.push((Math.round(turnMeta.durationMs / 100) / 10) + ' s');
    var problem = Boolean(st && (st.continuity === 'restarted' || st.continuity === 'unavailable' || st.continuity === 'degraded'));
    return { text: bits.join(' \u00b7 '), problem: problem };
  }
  // Conversation state strip + the rejected/not-renewed alert. Status only: never the token.
  function wbRenderState() {
    var el = wbEl('wbState');
    var box = wbEl('wbStateProblem');
    if (!Workbench || !Workbench.stateSummary) return;
    var sum = Workbench.stateSummary(wbConv);
    if (el) {
      var last = wbConv.lastStatus;
      var parts = ['Conversation state: ' + sum.label];
      if (sum.turns) parts.push(sum.turns + ' customer turn' + (sum.turns === 1 ? '' : 's'));
      parts.push('state token ' + (sum.tokenPresent ? 'held' : 'none'));
      if (last && last.canonical && last.canonical.ref) parts.push('session ref ' + last.canonical.ref);
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
    if (!opts.keepScenario) {
      wbScenarioTitle = null;
      wbLaterTurns = [];
    }
    wbClearPendingImage();
    var input = wbEl('wbInput');
    if (input && !opts.keepDraft) input.value = '';
    var chip = wbEl('wbScenarioChip');
    if (chip) {
      if (wbScenarioTitle) {
        chip.hidden = false;
        chip.textContent = 'Loaded scenario: ' + wbScenarioTitle + ' — edit if you want, then Send.';
      } else {
        chip.hidden = true;
        chip.textContent = '';
      }
    }
    wbRenderNextTurns();
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
        traceId: view.traceId,
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
      var ok = window.confirm('Start a new conversation? This resets the Live Test conversation and its conversation state. It does not change production conversations, scenarios, or knowledge.');
      if (!ok) return;
    }
    wbReset();
    var input = wbEl('wbInput');
    if (input) input.focus();
  }
  function wbCloseScenarioDlg() {
    var dlg = wbEl('wbScenarioDlg');
    if (dlg) dlg.hidden = true;
  }
  function wbOpenScenarioDlg() {
    var dlg = wbEl('wbScenarioDlg');
    if (!dlg) return;
    dlg.hidden = false;
    var q = wbEl('wbScenarioQ');
    if (q) { q.value = ''; q.focus(); }
    wbLoadScenarioList('');
  }
  function wbLoadScenarioList(query) {
    var list = wbEl('wbScenarioList');
    if (!list) return;
    list.innerHTML = '<div class="tac__muted">Loading…</div>';
    var qs = 'includeArchived=false';
    if (query) qs += '&q=' + encodeURIComponent(query);
    fetch(API_BASE + '/admin/library?' + qs, { credentials: 'same-origin' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) {
        var journeys = (d && d.journeys) || [];
        if (!journeys.length) { list.innerHTML = '<div class="tac__muted">No scenarios match.</div>'; return; }
        list.innerHTML = journeys.slice(0, 40).map(function (j) {
          return '<button class="wb-scenariorow" type="button" data-id="' + esc(j.journeyId) + '">' +
            '<b>' + esc(j.title) + '</b><span>' + esc(j.journeyId) + (j.family ? ' · ' + esc(j.family) : '') + '</span></button>';
        }).join('');
        Array.prototype.forEach.call(list.querySelectorAll('.wb-scenariorow'), function (btn) {
          btn.addEventListener('click', function () { wbPickScenario(btn.getAttribute('data-id')); });
        });
      })
      .catch(function () { list.innerHTML = '<div class="tac__muted">Could not load scenarios.</div>'; });
  }
  function wbRenderNextTurns() {
    var host = wbEl('wbNextTurns');
    if (!host) return;
    var remaining = (wbLaterTurns || []).filter(function (t) { return String(t || '').trim(); });
    if (!remaining.length) { host.hidden = true; host.innerHTML = ''; return; }
    host.hidden = false;
    host.innerHTML = '<p class="wb-nextturns__label" id="wbNextTurnsLabel">Suggested next customer turns</p>' +
      remaining.map(function (t, i) {
        return '<button type="button" class="wb-nextturn" data-i="' + i + '">' + esc(t) + '</button>';
      }).join('');
    Array.prototype.forEach.call(host.querySelectorAll('.wb-nextturn'), function (btn) {
      btn.addEventListener('click', function () {
        var i = parseInt(btn.getAttribute('data-i'), 10);
        var input = wbEl('wbInput');
        if (input) { input.value = remaining[i]; input.focus(); }
        wbLaterTurns.splice(i, 1);
        wbRenderNextTurns();
      });
    });
  }
  function wbPickScenario(id) {
    fetch(API_BASE + '/admin/library/journey?id=' + encodeURIComponent(id), { credentials: 'same-origin' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) {
        if (!d || !d.journey) return;
        if (wbMessages.length) {
          var okLoad = window.confirm('Load this scenario into a new test? The current workbench conversation will be cleared.');
          if (!okLoad) return;
        }
        var j = d.journey;
        var v = (j.versions && j.versions[j.versions.length - 1]) || {};
        var Cts = window.CtsLogic;
        var journey = Cts ? Cts.customerJourney(v) : { opener: v.opening || (v.turns && v.turns[0]) || '', later: (v.turns || []).slice(1) };
        var later = Cts ? Cts.suggestedLaterTurns(v) : journey.later;
        wbReset();
        wbScenarioTitle = j.title;
        wbLaterTurns = later.slice();
        var input = wbEl('wbInput');
        if (input) input.value = journey.opener || '';
        var chip = wbEl('wbScenarioChip');
        if (chip) {
          chip.hidden = false;
          chip.textContent = 'Loaded scenario: ' + j.title + ' — edit if you want, then Send.';
        }
        wbRenderNextTurns();
        wbCloseScenarioDlg();
        if (input) input.focus();
      })
      .catch(function () {});
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
    if (wbEl('wbLoadScenario')) wbEl('wbLoadScenario').addEventListener('click', wbOpenScenarioDlg);
    if (wbEl('wbScenarioCancel')) wbEl('wbScenarioCancel').addEventListener('click', wbCloseScenarioDlg);
    var q = wbEl('wbScenarioQ');
    var qTimer = 0;
    if (q) q.addEventListener('input', function () {
      if (qTimer) clearTimeout(qTimer);
      qTimer = setTimeout(function () { wbLoadScenarioList(q.value.trim()); }, 200);
    });
  }

  // ===== Test ApplianceClinic controller (task-based, mobile-first) =========
  var tacConfig = null; var tacWired = false; var tacSpec = null;
  var libSelected = []; // scenarioIds ticked in Test Scenarios (for MANUAL / run-these runs)
  var TAC_AREAS = ['All', 'Safety', 'Error Code', 'Normal Behaviour', 'Ambiguous Symptom', 'Multi-turn', 'Model / Fit', 'Media', 'Already Replaced', 'Near Neighbour'];
  var TAC_FAMILIES = ['washing-machine', 'washer-dryer', 'tumble-dryer', 'dishwasher', 'oven-cooker', 'hobs', 'fridge-freezer', 'microwave', 'vacuum'];
  function famLabel(f) { return String(f || '').replace(/-/g, ' ').replace(/\b\w/g, function (c) { return c.toUpperCase(); }); }

  function tacLoad() {
    fetch(API_BASE + '/admin/benchmark/config', { credentials: 'same-origin' })
      .then(function (r) { if (r.status === 401) { showGate('Your session has expired. Please log in again.'); return null; } return r.json(); })
      .then(function (c) {
        if (!c) return; tacConfig = c;
        tacRenderOverride(c.routingOverride || null);
        renderSetup(c.setup || null);
        renderReady(c.worker || {});
        renderTechDetails(c);
      })
      .catch(function () { var e = acqEl('tacSetupRows'); if (e) e.innerHTML = '<div class="tac__muted">Could not load the current AI setup.</div>'; });
  }
  function identRow(label, ident, note) {
    var prov = ident ? ident.providerLabel : '\u2014';
    var model = ident ? ident.modelLabel : '\u2014';
    return '<div class="tac__setuprow"><span class="tac__setuplbl">' + esc(label) + '</span>' +
      '<span class="tac__setupval"><b>' + esc(prov) + '</b><small>' + esc(model) + '</small>' +
      (note ? '<em class="tac__setupnote">' + esc(note) + '</em>' : '') + '</span></div>';
  }
  function renderSetup(setup) {
    var el = acqEl('tacSetupRows'); if (!el) return;
    if (!setup) { el.innerHTML = '<div class="tac__muted">Unavailable.</div>'; return; }
    el.innerHTML =
      identRow('Understanding', setup.understand) +
      identRow('Answer writing', setup.compose) +
      identRow('Quality review', setup.judge, setup.judge && setup.judge.note);
  }
  // User-facing readiness. Deliberately NOT worker-led: a stopped runner does
  // not mean ApplianceClinic is broken, and a first-time admin shouldn't need to
  // understand the runner to choose a test. Worker/heartbeat detail lives under
  // Advanced & technical (renderTechDetails) and the run-time gate (tacLaunch).
  function renderReady(w) {
    var title = acqEl('tacReadyTitle'); var msg = acqEl('tacReadyMsg');
    if (!title || !msg) return;
    title.textContent = 'Ready to test';
    // A subtle positive nudge only when we positively know the runner is up;
    // never surface "not running" as a dominant/alarming state here.
    if (w && w.online) {
      msg.textContent = w.currentRunId
        ? 'Private AI is configured. A test is running now — you can queue another.'
        : 'Private AI is configured. Choose a test below to get started.';
    } else {
      msg.textContent = 'Private AI is configured. Choose a test below to get started.';
    }
  }
  function renderTechDetails(c) {
    var el = acqEl('tacTechDetails'); if (!el) return; var w = c.worker || {};
    // Test-runner status is troubleshooting detail — it belongs here, not in the
    // primary flow. Terms like worker/heartbeat/poll stay inside Advanced.
    var runnerState = w.online ? 'Online' : 'Stopped';
    var qb = c.qualityBenchmark || {};
    var activeQb = qb.active || null;
    var legacyQb = qb.legacy || null;
    el.innerHTML = '<div class="tac__tech">' +
      '<div><span>Test runner</span><b>' + esc(runnerState) + (w.online && w.currentRunId ? ' · running' : '') + '</b></div>' +
      '<div><span>Runner heartbeat</span><b>' + (w.lastHeartbeat ? esc(new Date(w.lastHeartbeat).toLocaleString()) : 'never') + '</b></div>' +
      (activeQb ? '<div><span>Active quality benchmark</span><b>' + esc(activeQb.label || activeQb.id) + ' · ' + esc(activeQb.id) + (activeQb.recommended ? ' · recommended' : '') + '</b></div>' : '') +
      '<div><span>Legacy suite' + (legacyQb ? '' : '') + '</span><b>' + esc(c.benchmarkVersion || '\u2014') + (legacyQb ? ' · legacy (not authoritative)' : '') + '</b></div>' +
      '<div><span>Scenarios available</span><b>' + esc(String(c.journeyCount)) + ' (concurrency ' + esc(String(c.concurrency)) + ')</b></div>' +
      '<div><span>Quality reviewer</span><b>' + esc(c.judge ? c.judge.model : '\u2014') + (c.judge && !c.judge.configured ? ' · needs key' : '') + '</b></div>' +
      '</div>' +
      '<details class="tac__how"><summary>How to start the test runner</summary><code class="tac__code">node services/whichpart-api/benchmark/acq-worker.mjs --poll 5000</code></details>';
  }

  // ----- task specs -> human summary -> run -----
  // Preset specs live in TacLogic (unit-tested, no DOM).
  function tacSpecFor(kind) { return (window.TacLogic && window.TacLogic.specFor(kind)) || null; }
  function tacReducedMotion() { return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches); }
  // Bring a revealed panel into view AND move keyboard focus to it, so selecting
  // a test has an unmistakable, accessible result. Reduced-motion => no smooth
  // animation. preventScroll on focus so the browser doesn't double-jump.
  function tacReveal(el) {
    if (!el) return;
    try { el.scrollIntoView({ behavior: tacReducedMotion() ? 'auto' : 'smooth', block: 'start' }); } catch (e) { el.scrollIntoView(); }
    if (!el.hasAttribute('tabindex')) el.setAttribute('tabindex', '-1');
    try { el.focus({ preventScroll: true }); } catch (e2) { /* older browsers */ }
  }
  // Only reveals/moves focus as a DIRECT consequence of a user action (never on
  // initial load): callers pass an id when a panel should become the focus.
  // In-list steps only (builder → summary → running, compare). A run result and a scenario
  // conversation are their own page (#test/run/<runId>), shown by tacShowRunPage.
  function tacShow(id) { ['tacBuilder', 'tacSummary', 'tacRunning', 'tacCompare'].forEach(function (x) { var e = acqEl(x); if (e) e.hidden = (x !== id); }); if (id) { tacReveal(acqEl(id)); } }
  var TAC_IMPACT_SHORT = 'While it runs, the test runner switches the live AI routing to this setup (customers in that window use it too), then restores the exact configuration that was live before the run (verified).';
  function tacStatus(msg, bad, elId) {
    var el = acqEl(elId || 'tacStatusMsg'); if (!el) return;
    el.hidden = !msg; el.textContent = msg || '';
    el.className = 'test-status' + (msg ? (bad ? ' is-bad' : ' is-ok') : '');
  }
  // ---- production routing override (benchmark/routing-override.js) -----------------------------
  function tacRestoreLine(rec) {
    var ro = rec && rec.routingOverride;
    if (!ro || ro.state === 'not_required') return 'This run used the live configuration as it was; no routing change was needed.';
    if (ro.state === 'released') return 'The exact pre-run AI routing was restored and verified.';
    return 'Production AI routing was NOT restored (' + (ro.state || 'unknown') + '). See the routing override banner.';
  }
  function tacRoutingLabel(r) { return r ? (r.composeLabel || r.compose) + (r.model ? ' / ' + r.model : '') : '\u2014'; }
  function tacRenderOverride(ro) {
    var el = acqEl('tacOverride'); if (!el) return;
    if (!ro || (!ro.active && !ro.blocked)) { el.hidden = true; el.innerHTML = ''; el.className = 'tac-override'; return; }
    var conflict = ro.blocked || ro.state === 'restore_failed';
    el.hidden = false;
    el.className = 'tac-override' + (conflict ? ' tac-override--conflict' : '');
    el.setAttribute('role', conflict ? 'alert' : 'status');
    var when = function (x) { return x ? new Date(x).toLocaleString('en-GB') : '\u2014'; };
    var restore = ro.restore || {};
    el.innerHTML = '<p class="tac-override__title">' + esc(conflict ? (ro.blocked ? 'Restore conflict — production AI routing needs a decision' : 'Restore failed — production AI routing may still be temporary') : 'Production routing override active') + '</p>'
      + '<dl class="tac-override__dl">'
      + '<div><dt>Run</dt><dd><a href="' + esc(tacRunHref(ro.runId)) + '">' + esc(ro.runId) + '</a></dd></div>'
      + '<div><dt>Requested by</dt><dd>' + esc(ro.requestedBy || '\u2014') + '</dd></div>'
      + '<div><dt>Started</dt><dd>' + esc(when(ro.appliedAt || ro.acquiredAt)) + '</dd></div>'
      + '<div><dt>Temporary routing</dt><dd class="st-id">' + esc(tacRoutingLabel(ro.temporary && ro.temporary.routing)) + '</dd></div>'
      + '<div><dt>Pre-run routing</dt><dd class="st-id">' + esc(tacRoutingLabel(ro.preRun && ro.preRun.routing)) + '</dd></div>'
      + '<div><dt>Restore status</dt><dd>' + esc(conflict ? (restore.status || ro.state) : 'Pending — restored and verified when the run ends') + '</dd></div>'
      + '<div><dt>Worker heartbeat</dt><dd>' + esc(when(ro.heartbeatAt)) + '</dd></div>'
      + '</dl>'
      + (restore.detail ? '<p class="tac-override__detail">' + esc(restore.detail) + '</p>' : '')
      + (conflict ? '<p class="tac-override__detail">No other routing-changing batch can start until this is resolved. Settings blocks diagnostic-inference changes meanwhile.</p>'
        + (ro.blocked ? '<label class="st-field" for="tacOvNote">Reason for your decision (required)<textarea id="tacOvNote" rows="2" maxlength="300"></textarea></label>'
          + '<div class="tac-override__actions"><button class="btn btn--ghost" id="tacOvKeep" type="button">Keep the current live configuration</button>'
          + '<button class="btn btn--primary" id="tacOvRestore" type="button">Restore the pre-run configuration</button></div>'
          : '<div class="tac-override__actions"><button class="btn btn--primary" id="tacOvRecover" type="button">Retry restore now</button></div>')
        + '<p class="test-status" id="tacOvResult" role="status" hidden></p>' : '');
    function act(path, body, okMsg) {
      var out = acqEl('tacOvResult');
      fetch(API_BASE + path, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
        .then(function (r) { return r.json().catch(function () { return {}; }).then(function (b) { return { ok: r.ok, body: b }; }); })
        .then(function (res) {
          if (out) { out.hidden = false; out.className = 'test-status ' + (res.ok ? 'is-ok' : 'is-bad'); out.textContent = res.ok ? okMsg : ((res.body && (res.body.message || res.body.error)) || 'Not applied.'); }
          tacLoad();
        }).catch(function () { if (out) { out.hidden = false; out.className = 'test-status is-bad'; out.textContent = 'Network error — nothing was changed.'; } });
    }
    var note = function () { return (acqEl('tacOvNote') && acqEl('tacOvNote').value.trim()) || ''; };
    if (acqEl('tacOvKeep')) acqEl('tacOvKeep').addEventListener('click', function () {
      if (!confirm('Keep the current live AI configuration and release the batch override? The pre-run configuration will NOT be restored.')) return;
      act('/admin/benchmark/routing-override/resolve', { runId: ro.runId, decision: 'keep-current', note: note() }, 'Override released; the current live configuration was kept.');
    });
    if (acqEl('tacOvRestore')) acqEl('tacOvRestore').addEventListener('click', function () {
      if (!confirm('Restore the exact pre-run AI configuration (' + tacRoutingLabel(ro.preRun && ro.preRun.routing) + ')? This replaces the current live configuration for every new customer diagnosis within about 2 minutes.')) return;
      act('/admin/benchmark/routing-override/resolve', { runId: ro.runId, decision: 'restore-pre-run', note: note(), expectedRevision: restore.currentRevision || undefined }, 'Pre-run configuration restored and verified.');
    });
    if (acqEl('tacOvRecover')) acqEl('tacOvRecover').addEventListener('click', function () {
      // Live change: recovery writes the exact pre-run configuration back, but only if the live
      // configuration is still the one the batch wrote (anything else becomes a conflict, never overwritten).
      if (!confirm('Retry restoring the exact pre-run AI configuration (' + tacRoutingLabel(ro.preRun && ro.preRun.routing) + ')?\n\nThis is a live change: it applies to every new customer diagnosis within about 2 minutes. It only writes if the live configuration is still the one this batch run wrote.')) return;
      act('/admin/benchmark/routing-override/recover', {}, 'Recovery ran. See the status above.');
    });
    if (acqEl('tacOvNote')) guardForm('tacOvNote', { el: acqEl('tacOvNote'), isDirty: function () { return Boolean(acqEl('tacOvNote') && acqEl('tacOvNote').value.trim()); },
      discard: function () { if (acqEl('tacOvNote')) acqEl('tacOvNote').value = ''; },
      leave: 'You have started writing a reason for the routing-override decision. If you leave now it will be lost. Nothing has been applied.' });
  }
  function tacRunHref(runId, extra) { return hashString('test/run/' + encodeURIComponent(runId), extra || {}); }
  var tacListScrollY = null; var tacCameFromList = false; var tacDetailPoll = null; var tacPageRunId = null;
  function tacStopDetailPoll() { if (tacDetailPoll) { clearInterval(tacDetailPoll); tacDetailPoll = null; } }
  function tacShowList() {
    tacStopDetailPoll(); tacPageRunId = null;
    if (acqEl('tacDetailPage')) acqEl('tacDetailPage').hidden = true;
    if (acqEl('tacListView')) acqEl('tacListView').hidden = false;
    if (tacListScrollY != null) { var y = tacListScrollY; tacListScrollY = null; setTimeout(function () { window.scrollTo(0, y); }, 0); }
  }
  // '#test/run/<runId>' = the run result page; '?journey=<id>' = one scenario conversation in it;
  // '?review=' keeps the result list filter; '?from=<scenarioId>' = opened from a scenario page.
  function tacShowRunPage(runId, params) {
    params = params || {};
    var listView = acqEl('tacListView');
    var listVisible = Boolean(listView && !listView.hidden && acqEl('tacDetailPage') && acqEl('tacDetailPage').hidden);
    if (listVisible) tacListScrollY = window.scrollY || 0;
    tacCameFromList = listVisible;
    if (listView) listView.hidden = true;
    if (acqEl('tacDetailPage')) acqEl('tacDetailPage').hidden = false;
    tacStatus('', false, 'tacDetailStatus');
    tacReviewFilter = ['all', 'not_reviewed', 'looks_good', 'needs_improvement'].indexOf(params.review) !== -1 ? params.review : 'all';
    var back = acqEl('tacBackLink');
    var journey = params.journey || '';
    if (back) {
      if (journey && params.from) { back.setAttribute('href', '#test/scenario/' + encodeURIComponent(params.from)); back.textContent = '← Back to scenario'; back.setAttribute('data-sub', '1'); }
      else if (journey) { back.setAttribute('href', tacRunHref(runId, { review: tacReviewFilter === 'all' ? '' : tacReviewFilter })); back.textContent = '← Back to test result'; back.setAttribute('data-sub', '1'); }
      else { back.setAttribute('href', '#test?tab=batch'); back.textContent = '← Back to batch'; back.setAttribute('data-sub', ''); }
    }
    window.scrollTo(0, 0);
    tacStopDetailPoll();
    tacPageRunId = runId;
    var resEl = acqEl('tacResult'); var convEl = acqEl('tacConversation');
    if (journey) {
      if (resEl) resEl.hidden = true;
      tacOpenConversation(runId, journey, { fromRun: !params.from });
      return;
    }
    if (convEl) convEl.hidden = true;
    if (resEl) { resEl.hidden = false; resEl.innerHTML = '<div class="tac__muted">Loading test result…</div>'; }
    tacLoadRunPage(runId);
  }
  function tacLoadRunPage(runId) {
    var resEl = acqEl('tacResult'); if (!resEl) return;
    fetch(API_BASE + '/admin/benchmark/run?id=' + encodeURIComponent(runId), { credentials: 'same-origin' })
      .then(function (r) {
        if (r.status === 401) { showGate('Your session has expired. Please log in again.'); return null; }
        return r.json().then(function (b) { return { ok: r.ok, status: r.status, body: b }; });
      })
      .then(function (res) {
        if (!res || tacPageRunId !== runId) return;
        if (!res.ok) {
          resEl.innerHTML = '<div class="tac__runhead">Test not found</div><p class="tac__note">' + esc(res.status === 400 ? 'That is not a valid test link.' : ((res.body && res.body.error) || 'This test could not be loaded.')) + '</p>';
          return;
        }
        var rec = res.body;
        if (rec.status === 'QUEUED' || rec.status === 'RUNNING') {
          // Still running: show live progress here and refresh until it finishes.
          resEl.innerHTML = tacRunningHtml(rec);
          var cb = acqEl('tacCancelBtn'); if (cb) cb.addEventListener('click', function () { tacCancel(runId, 'tacDetailStatus'); });
          if (!tacDetailPoll) tacDetailPoll = setInterval(function () { if (tacPageRunId === runId) tacLoadRunPage(runId); else tacStopDetailPoll(); }, 4000);
          return;
        }
        tacStopDetailPoll();
        tacRenderResult(rec);
      })
      .catch(function () { if (tacPageRunId === runId) resEl.innerHTML = '<div class="tac__runhead">Could not load this test</div><p class="tac__note">Check your connection and reload the page.</p>'; });
  }

  function areaChips(sel) { return TAC_AREAS.map(function (a) { return '<label class="tac__chip"><input type="checkbox" class="tac-area" value="' + esc(a) + '"' + (sel && sel.indexOf(a) !== -1 ? ' checked' : (a === 'All' && (!sel || !sel.length) ? ' checked' : '')) + '> ' + esc(a) + '</label>'; }).join(''); }
  function famChips() { return TAC_FAMILIES.map(function (f) { return '<label class="tac__chip"><input type="checkbox" class="tac-fam" value="' + esc(f) + '"> ' + esc(famLabel(f)) + '</label>'; }).join(''); }

  function openBuilder(kind) {
    var el = acqEl('tacBuilder'); if (!el) return;
    var focused = kind === 'focused';
    el.innerHTML =
      '<h2 class="admin__h2">' + (focused ? 'Focused test' : 'Custom test') + '</h2>' +
      '<div class="tac__step"><div class="tac__steph">1 · What do you want to test?</div><div class="tac__chips" id="tacAreas">' + areaChips(null) + '</div></div>' +
      '<div class="tac__step"><div class="tac__steph">2 · Which appliances?</div><label class="tac__chip tac__chip--all"><input type="checkbox" id="tacAllFam" checked> All appliances</label><div class="tac__chips" id="tacFams" hidden>' + famChips() + '</div></div>' +
      '<div class="tac__step"><div class="tac__steph">3 · How many scenarios?</div><div class="tac__seg" id="tacSize">' + [10, 25, 50, 100, 'ALL'].map(function (n) { return '<button type="button" class="tac__segbtn' + (n === (focused ? 25 : 25) ? ' is-on' : '') + '" data-n="' + n + '">' + n + '</button>'; }).join('') + '</div></div>' +
      '<div class="tac__step"><div class="tac__steph">4 · How should they be chosen?</div>' +
        '<label class="tac__radio"><input type="radio" name="tacSel" value="BALANCED" checked> <span><b>Balanced</b><small>Spread tests across the selected areas.</small></span></label>' +
        '<label class="tac__radio"><input type="radio" name="tacSel" value="RANDOM"> <span><b>Random</b><small>Random, reproducible selection.</small></span></label>' +
        '<label class="tac__radio"><input type="radio" name="tacSel" value="MANUAL"> <span><b>Choose scenarios myself</b><small>Pick exact scenarios in Test Scenarios, then run them here.</small></span></label>' +
      '</div>' +
      '<div class="tac__step"><div class="tac__steph">5 · How should results be checked?</div>' +
        '<label class="tac__radio"><input type="radio" name="tacJudge" value="DETERMINISTIC_ONLY" checked> <span><b>Fast Check</b><small>Automatic engineering assertions. No paid quality-review calls.</small></span></label>' +
        '<label class="tac__radio"><input type="radio" name="tacJudge" value="FULL"> <span><b>Full Quality Review</b><small>Automatic checks plus independent AI review of conversation quality. Uses paid OpenAI review calls.</small></span></label>' +
      '</div>' +
      '<details class="tac__advopt"><summary>Advanced options</summary><label class="tac__field">Seed (random / balanced)<input id="tacSeed" type="text" placeholder="auto"></label></details>' +
      '<div class="tac__builderactions"><button class="btn btn--primary" id="tacReview" type="button">Review test</button><button class="btn btn--ghost" id="tacBuilderCancel" type="button">Cancel</button></div>';
    tacShow('tacBuilder');
    // wire
    acqEl('tacAllFam').addEventListener('change', function () { acqEl('tacFams').hidden = acqEl('tacAllFam').checked; });
    Array.prototype.forEach.call(el.querySelectorAll('.tac__segbtn'), function (b) { b.addEventListener('click', function () { Array.prototype.forEach.call(el.querySelectorAll('.tac__segbtn'), function (x) { x.classList.remove('is-on'); }); b.classList.add('is-on'); }); });
    // "All" area unticks the others and vice-versa
    Array.prototype.forEach.call(el.querySelectorAll('.tac-area'), function (cb) { cb.addEventListener('change', function () { if (cb.value === 'All' && cb.checked) { Array.prototype.forEach.call(el.querySelectorAll('.tac-area'), function (o) { if (o.value !== 'All') o.checked = false; }); } else if (cb.value !== 'All' && cb.checked) { var all = el.querySelector('.tac-area[value="All"]'); if (all) all.checked = false; } }); });
    acqEl('tacBuilderCancel').addEventListener('click', function () { tacShow(null); });
    acqEl('tacReview').addEventListener('click', function () {
      var areas = Array.prototype.map.call(el.querySelectorAll('.tac-area:checked'), function (c) { return c.value; }).filter(function (a) { return a !== 'All'; });
      var families = acqEl('tacAllFam').checked ? [] : Array.prototype.map.call(el.querySelectorAll('.tac-fam:checked'), function (c) { return c.value; });
      var sizeBtn = el.querySelector('.tac__segbtn.is-on'); var nv = sizeBtn ? sizeBtn.getAttribute('data-n') : '25';
      var sel = (el.querySelector('input[name="tacSel"]:checked') || {}).value || 'BALANCED';
      var judge = (el.querySelector('input[name="tacJudge"]:checked') || {}).value || 'DETERMINISTIC_ONLY';
      var seed = acqEl('tacSeed') && acqEl('tacSeed').value.trim();
      tacSpec = { title: focused ? 'Focused test' : 'Custom test', mode: sel, n: nv === 'ALL' ? 'ALL' : parseInt(nv, 10), judgeMode: judge, areas: areas, families: families, seed: seed || undefined, frontier: false };
      showSummary(tacSpec);
    });
  }

  function paidCallsLine(spec, count) { return (window.TacLogic && window.TacLogic.paidCalls(spec, count)) || 'None'; }
  function showSummary(spec) {
    tacSpec = spec; var el = acqEl('tacSummary'); if (!el) return;
    var TL = window.TacLogic || {};
    var count = TL.resolveCount ? TL.resolveCount(spec, tacConfig && tacConfig.journeyCount) : spec.n;
    var areasTxt = spec.areas && spec.areas.length ? spec.areas.join(' · ') : 'All areas';
    var famTxt = spec.families && spec.families.length ? spec.families.map(famLabel).join(' · ') : 'All appliance types';
    var uLbl = spec.frontier && spec.understand === 'openai' ? 'OpenAI' : 'Private AI';
    var cLbl = spec.frontier && spec.compose === 'openai' ? 'OpenAI' : 'Private AI';
    var paid = paidCallsLine(spec, count);
    var isPaid = spec.judgeMode === 'FULL' || spec.frontier;
    var runLbl = TL.runLabel ? TL.runLabel(count) : ('Run ' + count);
    el.innerHTML =
      '<div class="tac__ready">Your test</div>' +
      '<div class="tac__yourtestkind">' + esc(spec.title || 'Test') + '</div>' +
      '<div class="tac__sumgrid">' +
        '<div><span>Scenarios</span><b>' + esc(String(count)) + '</b></div>' +
        '<div><span>Areas</span><b>' + esc(areasTxt) + '</b></div>' +
        '<div><span>Appliances</span><b>' + esc(famTxt) + '</b></div>' +
        '<div><span>AI being tested</span><b>' + esc(uLbl + ' \u2192 ' + cLbl) + '</b></div>' +
        '<div><span>Checking</span><b>' + (spec.judgeMode === 'FULL' ? 'Full Quality Review' : 'Fast Check') + '</b></div>' +
        '<div><span>Paid OpenAI calls</span><b class="' + (isPaid ? 'tac__paid' : '') + '">' + esc(paid) + '</b></div>' +
      '</div>' +
      (spec.judgeMode === 'FULL' ? '<p class="tac__note">Exact cost unavailable — one review call is made per scenario.</p>' : '') +
      // Consequence stated before the action: this summary is the confirmation step for a run.
      '<p class="tac__note tac__impactnote"><strong>Production impact:</strong> ' + esc(TAC_IMPACT_SHORT) + ' Scenarios are sent to the production ApplianceClinic API; no customer transcripts are written.</p>' +
      '<div class="tac__builderactions">' +
        '<button class="btn btn--primary" id="tacRunBtn" type="button">' + esc(runLbl) + '</button>' +
        '<button class="btn btn--ghost" id="tacSummaryBack" type="button">Back</button>' +
        '<span class="acqb__result" id="tacRunResult"></span>' +
      '</div>';
    tacShow('tacSummary');
    acqEl('tacSummaryBack').addEventListener('click', function () { tacShow(spec.mode === undefined ? null : (spec.frontier ? null : (spec.title === 'Quick check' || spec.title === 'Full local test' ? null : 'tacBuilder'))); });
    acqEl('tacRunBtn').addEventListener('click', function () { tacLaunch(spec); });
  }

  function specToPayload(spec) {
    var filters = {};
    if (spec.areas && spec.areas.length) filters.categories = spec.areas.slice();
    if (spec.families && spec.families.length) filters.families = spec.families.slice();
    var p = {
      label: spec.title, mode: spec.mode, n: spec.n, filters: filters,
      seed: spec.seed ? (isNaN(+spec.seed) ? spec.seed : +spec.seed) : undefined,
      manualIds: spec.mode === 'MANUAL' ? libSelected.slice() : undefined,
      judgeMode: spec.judgeMode,
      understand: { provider: spec.frontier && spec.understand === 'openai' ? 'openai' : 'lmstudio', model: '' },
      compose: { provider: spec.frontier && spec.compose === 'openai' ? 'openai' : 'lmstudio', model: '' },
    };
    if (spec.frontier) {
      if (p.understand.provider === 'openai') p.understand.model = (tacConfig && tacConfig.setup && tacConfig.setup.judge && tacConfig.setup.judge.model) || '';
      if (p.compose.provider === 'openai') p.compose.model = (tacConfig && tacConfig.setup && tacConfig.setup.judge && tacConfig.setup.judge.model) || '';
      p.experiment = { name: spec.expName || '', hypothesis: spec.expHyp || '' };
    }
    return p;
  }
  function tacRemoveRunnerBlock() { var b = acqEl('tacRunnerBlock'); if (b && b.parentNode) b.parentNode.removeChild(b); }
  // Shown ONLY when the user actually tries to run a Private AI test with the
  // runner stopped. Configuring/reviewing a test is never blocked by this.
  function tacShowRunnerBlock(spec, confirmFrontier) {
    var panel = acqEl('tacSummary'); if (!panel) return;
    tacRemoveRunnerBlock();
    var div = document.createElement('div');
    div.id = 'tacRunnerBlock'; div.className = 'tac__runblock'; div.setAttribute('role', 'alert');
    div.innerHTML =
      '<h3>Start the test runner to continue</h3>' +
      '<p>Tests using Private AI run from the computer hosting Private AI. Start the test runner there, then check again.</p>' +
      '<details class="tac__how"><summary>How to start the test runner</summary><code class="tac__code">node services/whichpart-api/benchmark/acq-worker.mjs --poll 5000</code></details>' +
      '<div class="tac__runblockactions">' +
        '<button class="btn btn--primary" id="tacRunnerRecheck" type="button">Check again</button>' +
        '<button class="btn btn--ghost" id="tacRunnerQueue" type="button">Queue it anyway</button>' +
      '</div>';
    panel.appendChild(div);
    acqEl('tacRunnerRecheck').addEventListener('click', function () {
      fetch(API_BASE + '/admin/benchmark/config', { credentials: 'same-origin' })
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (c) { if (c) { tacConfig = c; renderReady(c.worker || {}); renderTechDetails(c); } tacLaunch(spec, confirmFrontier); })
        .catch(function () { tacLaunch(spec, confirmFrontier); });
    });
    acqEl('tacRunnerQueue').addEventListener('click', function () { tacLaunch(spec, confirmFrontier, true); });
    tacReveal(div);
  }
  function tacLaunch(spec, confirmFrontier, forceQueue) {
    if (spec.mode === 'MANUAL' && (!libSelected || !libSelected.length)) { var r0 = acqEl('tacRunResult'); if (r0) { r0.textContent = 'Pick scenarios in Test Scenarios first (tick them), then run.'; r0.className = 'acqb__result is-bad'; } return; }
    // A frontier (paid) experiment must always pass through the explicit confirmation dialog.
    if (spec.frontier && !confirmFrontier) { tacOpenConfirm(spec); return; }
    // Runner readiness: running a Private AI test needs the local runner. If it's
    // stopped, show a clear actionable state rather than silently queuing for hours.
    var needsRunner = !window.TacLogic || window.TacLogic.needsRunner(spec);
    var runnerOnline = !!(tacConfig && tacConfig.worker && tacConfig.worker.online);
    if (needsRunner && !runnerOnline && !forceQueue) { tacShowRunnerBlock(spec, confirmFrontier); return; }
    tacRemoveRunnerBlock();
    var payload = specToPayload(spec); if (confirmFrontier) payload.confirmFrontier = true;
    var r = acqEl('tacRunResult'); if (r) { r.textContent = 'Starting…'; r.className = 'acqb__result'; }
    fetch(API_BASE + '/admin/benchmark/build-run', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) })
      .then(readJson)
      .then(function (res) {
        if (res.ok) { tacLoadHistory(); tacPollRun(res.body.runId); }
        else if (r) { r.textContent = apiErrorText(res, 'Could not start the test.'); r.className = 'acqb__result is-bad'; }
      }).catch(function () { if (r) { r.textContent = 'Network error — the test was not started.'; r.className = 'acqb__result is-bad'; } });
  }

  function tacPollRun(runId, quiet) {
    if (acqActivePoll) { clearInterval(acqActivePoll); acqActivePoll = null; }
    // quiet: an active run picked up from history on load shows progress without moving scroll/focus.
    if (quiet) { var rp = acqEl('tacRunning'); if (rp) rp.hidden = false; } else tacShow('tacRunning');
    function tick() {
      fetch(API_BASE + '/admin/benchmark/run?id=' + encodeURIComponent(runId), { credentials: 'same-origin' })
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (rec) {
          if (!rec) return;
          if (rec.status === 'COMPLETED' || rec.status === 'CANCELLED' || rec.status === 'FAILED' || rec.status === 'RESTORE_FAILED') {
            clearInterval(acqActivePoll); acqActivePoll = null; tacLoadHistory();
            // The result is its own page; the in-list card just says it finished and links there.
            acqEl('tacRunning').innerHTML = '<div class="tac__runhead">' + esc(rec.status === 'RESTORE_FAILED' ? 'Test ended — production routing NOT restored' : (rec.status === 'COMPLETED' ? 'Test finished' : (rec.status === 'CANCELLED' ? 'Test cancelled' : 'Test failed'))) + '</div>' +
              '<p class="tac__note">' + esc(rec.label || 'Test') + ' · ' + esc(String((rec.progress && rec.progress.done) || 0)) + ' of ' + esc(String((rec.progress && rec.progress.total) || rec.journeyCount || 0)) + ' scenarios. ' + esc(tacRestoreLine(rec)) + '</p>' +
              '<div class="tac__builderactions"><a class="btn btn--primary" href="' + esc(tacRunHref(rec.runId)) + '">View results</a></div>';
          } else {
            if (rec.routingOverride && rec.routingOverride.required) tacLoad(); // keep the override banner current
            acqEl('tacRunning').innerHTML = tacRunningHtml(rec);
            var cb = acqEl('tacCancelBtn'); if (cb) cb.addEventListener('click', function () { tacCancel(runId); });
          }
        }).catch(function () {});
    }
    tick(); acqActivePoll = setInterval(tick, 4000);
  }
  function tacRunningHtml(rec) {
    var p = rec.progress || {}; var pct = p.total ? Math.round((p.done / p.total) * 100) : 0;
    var waiting = rec.status === 'QUEUED';
    var elapsed = rec.claimedAt ? (Date.now() - new Date(rec.claimedAt).getTime()) : 0;
    var eta = (p.done && p.total && elapsed) ? ((elapsed / p.done) * (p.total - p.done)) : null;
    if (waiting) {
      return '<div class="tac__runhead">Waiting for the test runner</div>' +
        '<p class="tac__note">Your test is queued. It will start automatically when the test runner on the LM Studio machine is running.</p>' +
        '<div class="tac__builderactions"><button class="btn btn--ghost" id="tacCancelBtn" type="button">Cancel test</button></div>';
    }
    return '<div class="tac__runhead">Testing ApplianceClinic</div>' +
      '<div class="tac__bignum">' + (p.done || 0) + ' <span>of ' + (p.total || 0) + '</span></div>' +
      '<div class="tac__bar"><span style="width:' + pct + '%"></span></div>' +
      (p.currentJourneyId ? '<div class="tac__current">Now: ' + esc(famLabel(p.currentFamily || '')) + ' · ' + esc(p.currentJourneyId) + '</div>' : '') +
      '<div class="tac__runstats">' +
        '<div><span>Completed</span><b>' + (p.done || 0) + '</b></div>' +
        '<div><span>Hard failures</span><b class="' + ((p.hardViolations || 0) ? 'tac__bad' : '') + '">' + (p.hardViolations || 0) + '</b></div>' +
        '<div><span>Errors</span><b>' + (p.errors || 0) + '</b></div>' +
        '<div><span>Elapsed</span><b>' + ms(elapsed) + '</b></div>' +
        (eta ? '<div><span>~ remaining</span><b>' + ms(eta) + '</b></div>' : '') +
      '</div>' +
      '<div class="tac__builderactions"><button class="btn btn--ghost" id="tacCancelBtn" type="button">Cancel test</button></div>';
  }
  function tacCancel(runId, statusId) {
    if (!confirm('Cancel this test?\n\nThe test runner stops before the next scenario. Scenarios already finished keep their results, and the exact pre-run AI routing is restored and verified before the run is marked cancelled.')) return;
    var btn = acqEl('tacCancelBtn'); if (btn) btn.disabled = true;
    fetch(API_BASE + '/admin/benchmark/run/cancel', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: runId }) })
      .then(readJson)
      .then(function (res) {
        if (!res.ok) { if (btn) btn.disabled = false; tacStatus('Could not cancel: ' + apiErrorText(res, 'the test was not cancelled.'), true, statusId); return; }
        tacStatus('Cancel requested. The runner stops before the next scenario.', false, statusId);
        tacLoadHistory();
      }).catch(function () { if (btn) btn.disabled = false; tacStatus('Network error — the test was not cancelled.', true, statusId); });
  }
  function classifyRun(a) {
    if (!a) return { label: 'UNKNOWN', cls: '' };
    if ((a.hardViolations || 0) > 0) return { label: 'FAILED', cls: 'is-bad' };
    if (a.correctOutcomeRate != null && a.correctOutcomeRate < 90) return { label: 'NEEDS REVIEW', cls: 'is-warn' };
    return { label: 'GOOD', cls: 'is-ok' };
  }
  // The currently-open run record + its per-run engineer reviews + the active
  // review filter — shared by the result list and the conversation Prev/Next.
  var tacRunRec = null; var tacRunReviews = {}; var tacReviewFilter = 'all';
  var REVIEW_LABELS = { not_reviewed: 'Not reviewed', looks_good: 'Looks good', needs_improvement: 'Needs improvement' };
  var REVIEW_CLS = { not_reviewed: '', looks_good: 'is-ok', needs_improvement: 'is-warn' };
  function reviewStateFor(journeyId) { var r = tacRunReviews[journeyId]; return (r && r.state) || 'not_reviewed'; }
  function resultVerdict(r) {
    if ((r.hardViolations || []).length) return { label: 'FAILED', cls: 'is-bad' };
    if (!r.reachedOutcome) return { label: 'NEEDS REVIEW', cls: 'is-warn' };
    return { label: 'GOOD', cls: 'is-ok' };
  }
  // The scenario results that match the active review filter, in run order —
  // this same ordered list drives the conversation Prev/Next workflow.
  function tacFilteredResults() {
    var results = (tacRunRec && tacRunRec.results) || [];
    if (tacReviewFilter === 'all') return results;
    return results.filter(function (r) { return reviewStateFor(r.journeyId) === tacReviewFilter; });
  }
  function tacRenderResult(rec) {
    var a = rec.aggregate; var el = acqEl('tacResult'); if (!el) return;
    tacRunRec = rec;
    el.hidden = false;
    if (!a) { el.innerHTML = '<div class="tac__runhead">' + esc(rec.status) + '</div><p class="tac__note">No summary is available for this test.</p>'; return; }
    var total = (rec.progress && rec.progress.total) || rec.journeyCount || 0;
    var cls = classifyRun(a);
    var correct = (a.correctOutcomeRate != null && total) ? Math.round(a.correctOutcomeRate / 100 * total) : null;
    var full = rec.judgeMode !== 'DETERMINISTIC_ONLY';
    el.innerHTML =
      '<div class="tac__label">Test result</div>' +
      '<div class="tac__verdict ' + cls.cls + '">' + cls.label + '</div>' +
      '<div class="tac__resulthead">' + esc(rec.label || 'Test') + '</div>' +
      '<div class="tac__metrics">' +
        '<div class="tac__metric"><span>Diagnosis</span><b>' + (correct != null ? correct + ' / ' + total + ' correct' : '\u2014') + '</b></div>' +
        '<div class="tac__metric"><span>Safety</span><b class="' + ((a.hardViolations || 0) ? 'tac__bad' : '') + '">' + (a.hardViolations || 0) + ' hard failure' + ((a.hardViolations || 0) === 1 ? '' : 's') + '</b></div>' +
        '<div class="tac__metric"><span>Conversation</span><b>' + (a.meanTurnsToOutcome != null ? 'avg ' + a.meanTurnsToOutcome + ' turns' : '\u2014') + '</b></div>' +
        '<div class="tac__metric"><span>Speed</span><b>' + (a.latency && a.latency.perTurnResponse ? 'avg ' + ms(a.latency.perTurnResponse.mean) : '\u2014') + '</b></div>' +
        (full ? '<div class="tac__metric"><span>Quality</span><b>' + (a.quality != null ? a.quality + ' / 100' : '\u2014') + '</b></div>' : '') +
      '</div>' +
      (full ? '' : '<p class="tac__note">Fast Check: conversation-quality score not calculated (no paid review).</p>') +
      '<div class="tac__conversations" id="tacScenarioList"><div class="tac__muted">Loading conversations…</div></div>' +
      '<details class="tac__convtech"><summary>Technical details</summary><div class="tac__ea-card">' +
        '<div class="tac__ea-row"><span>Run ID</span><b>' + esc(rec.runId) + '</b></div>' +
        '<div class="tac__ea-row"><span>Status</span><b>' + esc(rec.status) + '</b></div>' +
        '<div class="tac__ea-row"><span>Candidate</span><b>' + esc(((rec.config && rec.config.understand && rec.config.understand.provider) || '\u2014') + ' \u2192 ' + ((rec.config && rec.config.compose && rec.config.compose.provider) || '\u2014')) + '</b></div>' +
        '<div class="tac__ea-row"><span>Started by</span><b>' + esc(rec.enqueuedByEmail || '\u2014') + '</b></div>' +
        '<div class="tac__ea-row"><span>Started</span><b>' + esc(whenLong(rec.startedAt)) + '</b></div>' +
        '<div class="tac__ea-row"><span>Finished</span><b>' + esc(whenLong(rec.completedAt)) + '</b></div>' +
      '</div></details>' +
      '<div class="tac__builderactions"><a class="btn btn--ghost" href="#test?tab=batch">Done</a></div>';
    // Load this run's engineer reviews, then render the per-scenario list (filter comes from the URL).
    fetch(API_BASE + '/admin/benchmark/reviews?run=' + encodeURIComponent(rec.runId), { credentials: 'same-origin' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) { tacRunReviews = (d && d.reviews) || {}; tacRenderScenarioList(); })
      .catch(function () { tacRunReviews = {}; tacRenderScenarioList(); });
  }
  function tacRenderScenarioList() {
    var host = acqEl('tacScenarioList'); if (!host) return;
    var results = (tacRunRec && tacRunRec.results) || [];
    if (!results.length) { host.innerHTML = '<p class="tac__muted">This test has no per-scenario conversations recorded (legacy run).</p>'; return; }
    // Count by review state for the filter chips.
    var counts = { all: results.length, not_reviewed: 0, looks_good: 0, needs_improvement: 0 };
    results.forEach(function (r) { counts[reviewStateFor(r.journeyId)]++; });
    var chips = ['all', 'not_reviewed', 'looks_good', 'needs_improvement'].map(function (k) {
      var label = k === 'all' ? 'All' : REVIEW_LABELS[k];
      return '<button type="button" class="tac__filterchip' + (tacReviewFilter === k ? ' is-on' : '') + '" data-filter="' + k + '">' + esc(label) + ' (' + counts[k] + ')</button>';
    }).join('');
    var filtered = tacFilteredResults();
    var rows = filtered.map(function (r) {
      var v = resultVerdict(r);
      var rev = reviewStateFor(r.journeyId);
      var lat = r.totalElapsedMs != null ? ms(r.totalElapsedMs) : '\u2014';
      var sub = (r.reachedOutcome ? 'Diagnosis correct \u2713' : 'Not reached') + ' \u00b7 ' + (r.assistantTurns != null ? r.assistantTurns : (r.transcript || []).length) + ' turns \u00b7 ' + lat;
      return '<div class="tac__resrow">' +
        '<span class="tac__resdot ' + v.cls + '" title="' + esc(v.label) + '" aria-hidden="true"></span>' +
        '<div class="tac__resmain"><div class="tac__resid">' + esc(r.journeyId) + ' \u00b7 ' + esc(famLabel(r.family || '')) + '</div>' +
          '<div class="tac__ressub">' + esc(sub) + '</div></div>' +
        (rev !== 'not_reviewed' ? '<span class="tac__revbadge ' + REVIEW_CLS[rev] + '">' + esc(REVIEW_LABELS[rev]) + '</span>' : '') +
        '<a class="btn btn--primary tac__resview" data-journey="' + esc(r.journeyId) + '" href="' + esc(tacRunHref(tacRunRec.runId, { journey: r.journeyId, review: tacReviewFilter === 'all' ? '' : tacReviewFilter })) + '">View conversation</a>' +
      '</div>';
    }).join('');
    host.innerHTML = '<div class="tac__reviewfilter" role="group" aria-label="Filter by engineer review"><span class="tac__filterlbl">Show</span>' + chips + '</div>' +
      (rows || '<p class="tac__muted">No conversations match this filter.</p>');
    Array.prototype.forEach.call(host.querySelectorAll('.tac__filterchip'), function (b) {
      b.addEventListener('click', function () {
        tacReviewFilter = b.getAttribute('data-filter');
        // Keep the filter in the URL (no re-render via hashchange) so Back from a conversation keeps it.
        writeHash('test/run/' + encodeURIComponent(tacRunRec.runId), { review: tacReviewFilter === 'all' ? '' : tacReviewFilter });
        tacRenderScenarioList();
      });
    });
  }
  function tacLoadHistory() {
    fetch(API_BASE + '/admin/benchmark/runs', { credentials: 'same-origin' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (data) {
        if (!data) return; var list = acqEl('tacHistoryList'); if (!list) return;
        var cards = (data.runs || []).map(function (r) {
          var a = r.aggregate || {}; var canSelect = r.status === 'COMPLETED';
          var checked = acqSelected.indexOf(r.runId) !== -1 ? ' checked' : '';
          var when = r.startedAt ? new Date(r.startedAt) : null;
          var whenTxt = when ? when.toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) + ' · ' + when.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }) : '';
          var verdict = r.status === 'COMPLETED' ? classifyRun(a) : { label: r.status, cls: r.status === 'FAILED' ? 'is-bad' : '' };
          var count = r.journeyCount || (r.manifest && r.manifest.journeyCount) || (a.n) || '';
          return '<div class="tac__runcard">' +
            '<div class="tac__runcardtop"><div><div class="tac__runwhen">' + esc(whenTxt) + '</div><div class="tac__runname">' + esc(r.label || 'Test') + '</div>' +
              '<div class="tac__runsub">' + esc(String(count)) + ' scenarios</div></div>' +
              '<span class="tac__pill ' + verdict.cls + '">' + esc(verdict.label) + '</span></div>' +
            (r.status === 'COMPLETED' ? '<div class="tac__runmetrics">' +
              '<span>Correct <b>' + (a.correctOutcomeRate != null ? a.correctOutcomeRate + '%' : '\u2014') + '</b></span>' +
              '<span>Safety <b class="' + ((a.hardViolations || 0) ? 'tac__bad' : '') + '">' + (a.hardViolations != null ? a.hardViolations + ' fail' : '\u2014') + '</b></span>' +
              '<span>Turns <b>' + (a.meanTurnsToOutcome != null ? a.meanTurnsToOutcome : '\u2014') + '</b></span>' +
              (a.quality != null ? '<span>Quality <b>' + a.quality + '</b></span>' : '') +
              '</div>' : '') +
            '<div class="tac__runactions">' +
              '<a class="btn btn--ghost tac__runview" data-id="' + esc(r.runId) + '" href="' + esc(tacRunHref(r.runId)) + '">View</a>' +
              (canSelect ? '<label class="tac__cmpsel"><input type="checkbox" class="tac-sel" data-run="' + esc(r.runId) + '"' + checked + '> Compare</label>' : '') +
              (r.manifest ? '<button class="btn btn--ghost tac-rerun" data-id="' + esc(r.runId) + '" data-label="' + esc(r.label || 'Test') + '" data-count="' + esc(String(count)) + '" type="button">Rerun</button>' : '') +
            '</div>' +
            '<details class="tac__runid"><summary>Details</summary><code>' + esc(r.runId) + '</code></details>' +
          '</div>';
        }).join('');
        list.innerHTML = cards || '<div class="tac__muted">No tests yet. Run a Quick check to get started.</div>';
        Array.prototype.forEach.call(list.querySelectorAll('.tac-sel'), function (cb) {
          cb.addEventListener('change', function () {
            var id = cb.getAttribute('data-run');
            if (cb.checked) { acqSelected.push(id); if (acqSelected.length > 2) { var drop = acqSelected.shift(); var e2 = list.querySelector('.tac-sel[data-run="' + drop + '"]'); if (e2) e2.checked = false; } }
            else acqSelected = acqSelected.filter(function (x) { return x !== id; });
            acqEl('tacCompareBtn').disabled = acqSelected.length !== 2;
          });
        });
        Array.prototype.forEach.call(list.querySelectorAll('.tac-rerun'), function (b) {
          b.addEventListener('click', function () {
            var lbl = b.getAttribute('data-label') || 'this test'; var n = b.getAttribute('data-count') || 'the same';
            if (!confirm('Rerun "' + lbl + '" with Private AI \u2192 Private AI?\n\nThis queues ' + n + ' scenarios again (same questions, same versions). ' + TAC_IMPACT_SHORT)) return;
            b.disabled = true;
            fetch(API_BASE + '/admin/benchmark/rerun', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: b.getAttribute('data-id'), understand: { provider: 'lmstudio', model: '' }, compose: { provider: 'lmstudio', model: '' } }) })
              .then(readJson)
              .then(function (res) {
                b.disabled = false;
                if (res.ok) { tacStatus('Rerun queued: ' + (res.body.label || res.body.runId) + '.'); tacLoadHistory(); tacPollRun(res.body.runId); }
                else tacStatus('Could not rerun: ' + apiErrorText(res, 'the rerun was not queued.'), true);
              })
              .catch(function () { b.disabled = false; tacStatus('Network error — the rerun was not queued.', true); });
          });
        });
        var active = (data.runs || []).filter(function (r) { return r.status === 'RUNNING' || r.status === 'QUEUED'; })[0];
        if (active && !acqActivePoll) tacPollRun(active.runId, true);
      }).catch(function () {});
  }

  // ===== Conversation review =============================================
  var DIM_LABELS = { DIAGNOSTIC_CORRECTNESS: 'Diagnosis', REASONING_DISCRIMINATION: 'Reasoning', QUESTION_QUALITY: 'Questions', CONVERSATION_EFFICIENCY: 'Efficiency', GROUNDING_CLAIM_DISCIPLINE: 'Grounding', CUSTOMER_ANSWER_QUALITY: 'Answer quality', SAFETY: 'Safety' };
  function escNl(s) { return esc(String(s == null ? '' : s)).replace(/\n/g, '<br>'); }
  function whenLong(iso) { if (!iso) return '\u2014'; var d = new Date(iso); return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) + ' \u00b7 ' + d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }); }
  var tacConvCtx = null; // { runId, journeyId, fromRun }

  // Rendered on the run page ('#test/run/<runId>?journey=<id>'). Prev/Next walk the run's filtered
  // result list, so the run record is loaded first when the page was opened directly.
  function tacOpenConversation(runId, journeyId, ctx) {
    tacConvCtx = { runId: runId, journeyId: journeyId, fromRun: !!(ctx && ctx.fromRun) };
    var el = acqEl('tacConversation'); if (!el) return;
    el.hidden = false;
    el.innerHTML = '<div class="tac__muted">Loading conversation…</div>';
    var needRun = tacConvCtx.fromRun && !(tacRunRec && tacRunRec.runId === runId);
    var runP = needRun
      ? fetch(API_BASE + '/admin/benchmark/run?id=' + encodeURIComponent(runId), { credentials: 'same-origin' }).then(function (r) { return r.ok ? r.json() : null; })
        .then(function (rec) {
          if (!rec) return;
          tacRunRec = rec;
          return fetch(API_BASE + '/admin/benchmark/reviews?run=' + encodeURIComponent(runId), { credentials: 'same-origin' })
            .then(function (r) { return r.ok ? r.json() : null; }).then(function (d) { tacRunReviews = (d && d.reviews) || {}; });
        }).catch(function () {})
      : Promise.resolve();
    runP.then(function () {
      return fetch(API_BASE + '/admin/benchmark/transcript?run=' + encodeURIComponent(runId) + '&journey=' + encodeURIComponent(journeyId), { credentials: 'same-origin' });
    })
      .then(function (r) { if (!r.ok) return r.json().then(function (b) { throw new Error((b && b.error) || 'not found'); }); return r.json(); })
      .then(function (d) { if (tacConvCtx && tacConvCtx.journeyId === journeyId && tacConvCtx.runId === runId) tacRenderConversation(d); })
      .catch(function (e) { el.innerHTML = '<div class="tac__runhead">Conversation unavailable</div><p class="tac__note">' + esc(e.message || 'Could not load this conversation.') + '</p>'; });
  }
  function tacConvHref(journeyId) {
    return tacRunHref(tacConvCtx.runId, { journey: journeyId, review: tacReviewFilter === 'all' ? '' : tacReviewFilter });
  }

  function tacProvenanceRow(p) {
    var bits = [];
    bits.push('Scenario ' + esc(p.scenarioId) + (p.journeyVersion != null ? ' \u00b7 v' + esc(String(p.journeyVersion)) : ''));
    if (p.family) bits.push(esc(famLabel(p.family)));
    bits.push(esc(whenLong(p.runDate)));
    bits.push(esc(p.providerPair || ''));
    bits.push(p.judgeMode === 'DETERMINISTIC_ONLY' ? 'Fast Check' : 'Full Quality Review');
    bits.push((p.turns != null ? p.turns : '\u2014') + ' turns');
    if (p.totalElapsedMs != null) bits.push(ms(p.totalElapsedMs));
    return bits.join(' \u00b7 ');
  }
  function tacChatHtml(transcript) {
    if (!transcript || !transcript.length) return '<p class="tac__muted">No conversation was recorded for this scenario.</p>';
    return transcript.map(function (t) {
      var cust = '';
      if (t.user != null && String(t.user).length) {
        cust = '<div class="tac__msg tac__msg--customer"><div class="tac__msghead">Customer <span class="tac__sim">Simulated test response</span></div>' +
          '<div class="tac__bubble">' + escNl(t.user) + '</div></div>';
      }
      var reply = '';
      if (t.reply != null && String(t.reply).length) {
        var checks = (t.suggestedChecks && t.suggestedChecks.length)
          ? '<ul class="tac__checks">' + t.suggestedChecks.map(function (c) { return '<li>' + escNl(typeof c === 'string' ? c : (c && c.name) || JSON.stringify(c)) + '</li>'; }).join('') + '</ul>' : '';
        var lat = t.latencyMs != null ? '<div class="tac__msglat">' + ms(t.latencyMs) + '</div>' : '';
        reply = '<div class="tac__msg tac__msg--clinic"><div class="tac__msghead">ApplianceClinic</div>' +
          '<div class="tac__bubble">' + escNl(t.reply) + checks + '</div>' + lat + '</div>';
      }
      return cust + reply;
    }).join('');
  }
  function tacExpectedActualHtml(expected, actual) {
    function line(label, val) { return '<div class="tac__ea-row"><span>' + esc(label) + '</span><b>' + val + '</b></div>'; }
    var exp;
    if (expected) {
      var e = [];
      if (expected.outcome) e.push(line('Outcome', esc(expected.outcome === 'SAFETY_STOP' ? 'Safety stop (no diagnosis/parts)' : expected.outcome)));
      if (expected.components && expected.components.length) e.push(line('Components', esc(expected.components.join(', '))));
      if (expected.shouldAsk) e.push(line('Should ask', escNl(expected.shouldAsk)));
      if (expected.safety) e.push(line('Safety', esc(expected.safety)));
      if (expected.mustNotDo && expected.mustNotDo.length) e.push(line('Must not', esc(expected.mustNotDo.join(', '))));
      if (expected.turns) e.push(line('Turns', esc('ideal ' + (expected.turns.ideal || '\u2014') + ' / max ' + (expected.turns.max || '\u2014'))));
      if (expected.expectMedia) e.push(line('Media', 'Expected'));
      exp = '<div class="tac__ea-card"><div class="tac__ea-h">Expected</div>' + (e.join('') || '<div class="tac__muted">No gold detail.</div>') + '</div>';
    } else {
      exp = '<div class="tac__ea-card"><div class="tac__ea-h">Expected</div><div class="tac__muted">Scenario gold unavailable.</div></div>';
    }
    var act = '';
    if (actual) {
      var av = [];
      av.push(line('Outcome', esc(actual.reachedOutcome ? 'Diagnosis reached' : 'Not reached')));
      if (actual.suggestedChecks && actual.suggestedChecks.length) av.push(line('Suggested', esc(actual.suggestedChecks.slice(0, 6).join(', '))));
      av.push(line('Safety', esc(actual.safety || '\u2014')));
      if (actual.hardViolations && actual.hardViolations.length) av.push(line('Hard failures', esc(actual.hardViolations.join(', '))));
      av.push(line('Turns', esc(String(actual.turns != null ? actual.turns : '\u2014'))));
      act = '<div class="tac__ea-card"><div class="tac__ea-h">Actual</div>' + av.join('') + '</div>';
    }
    return '<div class="tac__ea">' + exp + act + '</div>';
  }
  function tacResultBlockHtml(result) {
    var v = { GOOD: 'is-ok', 'NEEDS REVIEW': 'is-warn', FAILED: 'is-bad', UNKNOWN: '' }[result.verdict] || '';
    var hvSafe = !(result.hardViolations || []).some(function (h) { return h === 'FAILED_SAFETY_STOP' || h === 'UNSAFE_ADVICE'; });
    var dims = result.dimensions || {}; var nj = result.notJudged || [];
    var why = Object.keys(DIM_LABELS).filter(function (k) { return dims[k] != null; }).map(function (k) {
      var isNj = nj.indexOf(k) !== -1;
      return '<div class="tac__ea-row"><span>' + esc(DIM_LABELS[k]) + '</span><b>' + esc(String(Math.round(dims[k]))) + (isNj ? ' <em class="tac__sim">Not reviewed — Fast Check</em>' : '') + '</b></div>';
    }).join('');
    return '<div class="tac__label">Test result <span class="tac__labelhint">(machine evaluation)</span></div>' +
      '<div class="tac__verdict ' + v + '">' + esc(result.verdict) + '</div>' +
      '<div class="tac__scores">' +
        '<div class="tac__metric"><span>Diagnosis</span><b>' + (dims.DIAGNOSTIC_CORRECTNESS != null ? Math.round(dims.DIAGNOSTIC_CORRECTNESS) : '\u2014') + '</b></div>' +
        '<div class="tac__metric"><span>Safety</span><b class="' + (hvSafe ? '' : 'tac__bad') + '">' + (hvSafe ? 'Pass' : 'Fail') + '</b></div>' +
        '<div class="tac__metric"><span>Conversation</span><b>' + (result.turnsToOutcome != null ? result.turnsToOutcome + ' turns' : '\u2014') + '</b></div>' +
        '<div class="tac__metric"><span>Speed</span><b>' + (result.latencyMs != null ? ms(result.latencyMs) : '\u2014') + '</b></div>' +
        (result.judged ? '<div class="tac__metric"><span>Quality</span><b>' + (result.quality != null ? result.quality + ' / 100' : '\u2014') + '</b></div>' : '') +
      '</div>' +
      (result.judged ? '' : '<p class="tac__note">Fast Check — subjective conversation-quality dimensions were not reviewed (no paid judge).</p>') +
      '<details class="tac__why"><summary>Why did it score this way?</summary><div class="tac__ea-card">' + (why || '<div class="tac__muted">No per-dimension detail.</div>') + '</div></details>';
  }
  function tacReviewControlsHtml(review) {
    var state = (review && review.state) || 'not_reviewed';
    var opts = ['not_reviewed', 'looks_good', 'needs_improvement'].map(function (k) {
      return '<button type="button" class="tac__revbtn ' + REVIEW_CLS[k] + (state === k ? ' is-on' : '') + '" data-state="' + k + '" aria-pressed="' + (state === k ? 'true' : 'false') + '">' + esc(REVIEW_LABELS[k]) + '</button>';
    }).join('');
    var meta = (review && review.reviewedAt) ? '<div class="tac__revmeta">Last reviewed ' + esc(whenLong(review.reviewedAt)) + (review.reviewer ? ' by ' + esc(review.reviewer) : '') + '</div>' : '';
    return '<div class="tac__label">Engineer review <span class="tac__labelhint">(your assessment — does not change the score)</span></div>' +
      '<div class="tac__revstates" role="group" aria-label="Engineer review state">' + opts + '</div>' +
      '<label class="tac__revnotelbl" for="tacRevNote">Engineer note</label>' +
      '<textarea id="tacRevNote" class="tac__revnote" rows="3" maxlength="4000" placeholder="Optional: what was good or what should improve">' + esc((review && review.note) || '') + '</textarea>' +
      '<div class="tac__builderactions"><button class="btn btn--primary" id="tacRevSave" type="button">Save review</button><span class="tac__revresult" id="tacRevResult" role="status"></span></div>' + meta;
  }
  function tacRenderConversation(d) {
    var el = acqEl('tacConversation'); if (!el) return;
    var p = d.provenance || {};
    // Prev/Next within the current filtered run list (only when opened from a run).
    var navHtml = '';
    if (tacConvCtx.fromRun) {
      var list = tacFilteredResults(); var idx = -1;
      for (var i = 0; i < list.length; i++) { if (list[i].journeyId === d.journeyId) { idx = i; break; } }
      var prevId = idx > 0 ? list[idx - 1].journeyId : null;
      var nextId = (idx >= 0 && idx < list.length - 1) ? list[idx + 1].journeyId : null;
      // Real links: each conversation has its own URL, so Back/refresh/share all work.
      navHtml = '<nav class="tac__convnav" aria-label="Conversations in this test">' +
        (prevId ? '<a class="btn btn--ghost" id="tacConvPrev" href="' + esc(tacConvHref(prevId)) + '">\u2190 Previous</a>' : '<span class="btn btn--ghost is-disabled" aria-disabled="true">\u2190 Previous</span>') +
        '<span class="tac__convpos">' + (idx >= 0 ? (idx + 1) + ' of ' + list.length : '') + '</span>' +
        (nextId ? '<a class="btn btn--ghost" id="tacConvNext" href="' + esc(tacConvHref(nextId)) + '">Next \u2192</a>' : '<span class="btn btn--ghost is-disabled" aria-disabled="true">Next \u2192</span>') +
      '</nav>';
    }
    var rev = d.review || { state: 'not_reviewed', note: '' };
    var badge = rev.state && rev.state !== 'not_reviewed' ? '<span class="tac__revbadge ' + REVIEW_CLS[rev.state] + '">' + esc(REVIEW_LABELS[rev.state]) + '</span>' : '';
    el.innerHTML =
      (navHtml ? '<div class="tac__convtop">' + navHtml + '</div>' : '') +
      '<h2 class="tac__convtitle">' + esc(p.scenarioTitle || d.journeyId) + ' ' + badge + '</h2>' +
      '<div class="tac__convprov">' + tacProvenanceRow(p) + '</div>' +
      '<div class="tac__chat">' + tacChatHtml(d.transcript) + '</div>' +
      tacExpectedActualHtml(d.expected, d.actual) +
      tacResultBlockHtml(d.result || {}) +
      '<div class="tac__reviewbox">' + tacReviewControlsHtml(rev) + '</div>' +
      '<details class="tac__convtech"><summary>Technical details</summary><div class="tac__ea-card">' +
        '<div class="tac__ea-row"><span>Run ID</span><b>' + esc(d.runId) + '</b></div>' +
        '<div class="tac__ea-row"><span>Scenario</span><b>' + esc(d.journeyId) + (p.journeyVersion != null ? ' v' + esc(String(p.journeyVersion)) : '') + '</b></div>' +
        '<div class="tac__ea-row"><span>Candidate</span><b>' + esc(p.providerPair || '') + '</b></div>' +
      '</div></details>';
    el.hidden = false;
    // Engineer review wiring
    var chosen = rev.state || 'not_reviewed';
    Array.prototype.forEach.call(el.querySelectorAll('.tac__revbtn'), function (b) {
      b.addEventListener('click', function () {
        chosen = b.getAttribute('data-state');
        Array.prototype.forEach.call(el.querySelectorAll('.tac__revbtn'), function (x) { var on = x === b; x.classList.toggle('is-on', on); x.setAttribute('aria-pressed', on ? 'true' : 'false'); });
      });
    });
    // An unsaved engineer note / review choice is guarded like every other Admin form.
    var savedNote = rev.note || ''; var savedState = chosen;
    guardForm('tacReview', { el: acqEl('tacRevNote'), isDirty: function () { return (acqEl('tacRevNote').value || '') !== savedNote || chosen !== savedState; },
      discard: function () { var t = acqEl('tacRevNote'); if (t) t.value = savedNote; chosen = savedState; },
      leave: 'You have an unsaved engineer review on this test conversation. If you leave now it will be lost. Saved reviews and test results are not affected.' });
    acqEl('tacRevSave').addEventListener('click', function () {
      var note = acqEl('tacRevNote').value || '';
      var res = acqEl('tacRevResult'); if (res) { res.textContent = 'Saving…'; res.className = 'tac__revresult'; }
      fetch(API_BASE + '/admin/benchmark/review', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ run: d.runId, journey: d.journeyId, state: chosen, note: note }) })
        .then(readJson)
        .then(function (r) {
          if (!r.ok) { if (res) { res.textContent = apiErrorText(r, 'Could not save the review.'); res.className = 'tac__revresult is-bad'; } return; }
          savedNote = note; savedState = chosen;
          if (res) { res.textContent = 'Saved.'; res.className = 'tac__revresult is-ok'; }
          tacRunReviews[d.journeyId] = r.body; // keep the run list badges/filter in sync
        }).catch(function () { if (res) { res.textContent = 'Network error — the review was not saved.'; res.className = 'tac__revresult is-bad'; } });
    });
  }

  function tacCompare() {
    if (acqSelected.length !== 2) return;
    var panel = acqEl('tacCompare'); if (!panel) return;
    fetch(API_BASE + '/admin/benchmark/compare?a=' + encodeURIComponent(acqSelected[0]) + '&b=' + encodeURIComponent(acqSelected[1]), { credentials: 'same-origin' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) {
        if (!d) return;
        var c = d.comparison || {}; var dec = c._decision || {}; var msf = d.manifestSafety || {};
        function delta(label, obj, unit) {
          if (!obj || obj.verdict === 'N/A' || obj.a == null || obj.b == null) return '';
          var av = unit === 'ms' ? ms(obj.a) : obj.a; var bv = unit === 'ms' ? ms(obj.b) : obj.b;
          var cls = obj.verdict === 'BETTER' ? 'is-ok' : obj.verdict === 'WORSE' ? 'is-bad' : '';
          var arrow = obj.b > obj.a ? '\u2191' : obj.b < obj.a ? '\u2193' : '\u2192';
          return '<div class="tac__cmprow"><span class="tac__cmplbl">' + esc(label) + '</span><span class="tac__cmpvals">' + esc(String(av)) + ' <em>' + arrow + '</em> ' + esc(String(bv)) + '</span><span class="tac__cmpv ' + cls + '">' + esc(obj.verdict) + '</span></div>';
        }
        // Overall verdict — NEVER "better" when hard failures exist on B.
        var bHard = (c.hardViolations && c.hardViolations.b) || 0;
        var overall, ocls;
        if (bHard > 0) { overall = 'WORSE — B has hard safety/trust failures'; ocls = 'is-bad'; }
        else if (dec.candidateIsImprovement) { overall = 'BETTER — B is a production improvement'; ocls = 'is-ok'; }
        else if (dec.noNewHardViolations && dec.correctnessOk && !dec.qualityUp && !dec.efficiencyUp) { overall = 'SIMILAR — no clear difference'; ocls = ''; }
        else { overall = 'MIXED — some metrics better, some not'; ocls = 'is-warn'; }
        var warn = msf.warning
          ? '<div class="tac__cmpwarn is-warn">Not a like-for-like comparison: ' + esc(msf.warning) + (msf.commonCount != null ? ' Common scenarios: ' + msf.commonCount : '') + '</div>'
          : '<div class="tac__cmpwarn is-ok">Identical scenario set (version-pinned) — clean A/B comparison.</div>';
        panel.innerHTML = '<h2 class="admin__h2">Comparison</h2>' + warn +
          '<div class="tac__cmphead"><div><small>A</small>' + esc(d.a.label) + '</div><div><small>B</small>' + esc(d.b.label) + '</div></div>' +
          '<div class="tac__cmprows">' +
            delta('Quality', c.quality) + delta('Correct %', c.correctOutcomeRate) +
            delta('Avg turns', c.meanTurnsToOutcome) + delta('Response', c.responseLatencyMean, 'ms') +
            delta('Safety (hard failures)', c.hardViolations) +
          '</div>' +
          '<div class="tac__verdict ' + ocls + '">' + esc(overall) + '</div>' +
          (msf.warning ? '<div class="tac__builderactions"><button class="btn btn--ghost" id="tacCmpCommon" type="button">Compare common scenarios</button></div>' : '');
        panel.hidden = false; panel.scrollIntoView({ behavior: 'smooth' });
      }).catch(function () {});
  }

  // ----- frontier (paid) experiment, behind Advanced -----
  function tacOpenFrontier() {
    var el = acqEl('tacFrontier'); if (!el) return;
    var jm = (tacConfig && tacConfig.setup && tacConfig.setup.judge && tacConfig.setup.judge.model) || 'the configured OpenAI model';
    el.hidden = false;
    el.innerHTML =
      '<h3 class="tac__frontierh">New frontier experiment</h3>' +
      '<p class="tac__note">Compare a frontier (OpenAI) customer AI against Private AI. This makes paid OpenAI calls, and while it runs the live AI routing uses OpenAI for the steps you choose — real customers in that window get the same routing. The exact pre-run configuration is restored when the run ends.</p>' +
      '<p class="test-status is-bad" id="tacFrontierErr" role="alert" hidden></p>' +
      '<label class="tac__field">Experiment name<input id="tacExpName" type="text" placeholder="e.g. Frontier understanding on ambiguous cases"></label>' +
      '<label class="tac__field">What are you trying to learn?<input id="tacExpHyp" type="text" placeholder="Does it improve ambiguous diagnosis enough to justify the cost?"></label>' +
      '<div class="tac__step"><div class="tac__steph">Understanding</div>' +
        '<label class="tac__radio"><input type="radio" name="tacFU" value="lmstudio" checked> <span>Private AI</span></label>' +
        '<label class="tac__radio"><input type="radio" name="tacFU" value="openai"> <span>OpenAI (' + esc(jm) + ')</span></label></div>' +
      '<div class="tac__step"><div class="tac__steph">Answer writing</div>' +
        '<label class="tac__radio"><input type="radio" name="tacFC" value="lmstudio" checked> <span>Private AI</span></label>' +
        '<label class="tac__radio"><input type="radio" name="tacFC" value="openai"> <span>OpenAI (' + esc(jm) + ')</span></label></div>' +
      '<div class="tac__step"><div class="tac__steph">How many scenarios?</div><div class="tac__seg" id="tacFSize">' + [10, 25, 50].map(function (n) { return '<button type="button" class="tac__segbtn' + (n === 25 ? ' is-on' : '') + '" data-n="' + n + '">' + n + '</button>'; }).join('') + '</div></div>' +
      '<div class="tac__builderactions"><button class="btn btn--primary" id="tacFReview" type="button">Review experiment</button></div>';
    Array.prototype.forEach.call(el.querySelectorAll('.tac__segbtn'), function (b) { b.addEventListener('click', function () { Array.prototype.forEach.call(el.querySelectorAll('.tac__segbtn'), function (x) { x.classList.remove('is-on'); }); b.classList.add('is-on'); }); });
    acqEl('tacFReview').addEventListener('click', function () {
      var u = (el.querySelector('input[name="tacFU"]:checked') || {}).value || 'lmstudio';
      var cc = (el.querySelector('input[name="tacFC"]:checked') || {}).value || 'lmstudio';
      var szb = el.querySelector('#tacFSize .tac__segbtn.is-on'); var n = szb ? parseInt(szb.getAttribute('data-n'), 10) : 25;
      var ferr = acqEl('tacFrontierErr');
      if (u !== 'openai' && cc !== 'openai') { if (ferr) { ferr.hidden = false; ferr.textContent = 'Choose OpenAI for at least one step, or use a normal local test.'; } return; }
      if (ferr) ferr.hidden = true;
      tacSpec = { title: acqEl('tacExpName').value.trim() || 'Frontier experiment', mode: 'BALANCED', n: n, judgeMode: 'DETERMINISTIC_ONLY', areas: [], families: [], frontier: true, understand: u, compose: cc, expName: acqEl('tacExpName').value.trim(), expHyp: acqEl('tacExpHyp').value.trim() };
      showSummary(tacSpec);
    });
  }
  function tacOpenConfirm(spec) {
    var body = acqEl('tacConfirmBody'); if (!body) return;
    var count = (spec.n === 'ALL') ? ((tacConfig && tacConfig.journeyCount) || 'all') : spec.n;
    body.innerHTML =
      '<div class="tac__sumgrid">' +
        '<div><span>Experiment</span><b>' + esc(spec.expName || '(unnamed)') + '</b></div>' +
        '<div><span>Learning</span><b>' + esc(spec.expHyp || '(none)') + '</b></div>' +
        '<div><span>Understanding</span><b>' + (spec.understand === 'openai' ? 'OpenAI' : 'Private AI') + '</b></div>' +
        '<div><span>Answer writing</span><b>' + (spec.compose === 'openai' ? 'OpenAI' : 'Private AI') + '</b></div>' +
        '<div><span>Scenarios</span><b>' + esc(String(count)) + '</b></div>' +
      '</div>' +
      '<p class="tac__note tac__paid">This experiment will make paid OpenAI calls for the customer AI.</p>' +
      '<p class="tac__note tac__paid"><strong>Production is affected while it runs:</strong> the test runner switches the live AI routing to ' +
        esc((spec.understand === 'openai' ? 'OpenAI' : 'Private AI') + ' \u2192 ' + (spec.compose === 'openai' ? 'OpenAI' : 'Private AI')) +
        ' for the whole run, so real customer conversations in that window use OpenAI too. When the run ends or is cancelled, the exact pre-run configuration is restored and verified.</p>';
    acqEl('tacConfirm')._spec = spec; acqEl('tacConfirm').hidden = false;
  }

  function tacWire() {
    if (tacWired) return; tacWired = true;
    if (acqEl('taskQuick')) acqEl('taskQuick').addEventListener('click', function () { showSummary(tacSpecFor('quick')); });
    if (acqEl('taskFull')) acqEl('taskFull').addEventListener('click', function () { showSummary(tacSpecFor('full')); });
    if (acqEl('taskFocused')) acqEl('taskFocused').addEventListener('click', function () { openBuilder('focused'); });
    if (acqEl('taskCustom')) acqEl('taskCustom').addEventListener('click', function () { openBuilder('custom'); });
    if (acqEl('tacFrontierStart')) acqEl('tacFrontierStart').addEventListener('click', tacOpenFrontier);
    if (acqEl('tacConfirmCancel')) acqEl('tacConfirmCancel').addEventListener('click', function () { acqEl('tacConfirm').hidden = true; });
    if (acqEl('tacConfirmGo')) acqEl('tacConfirmGo').addEventListener('click', function () { var s = acqEl('tacConfirm')._spec; acqEl('tacConfirm').hidden = true; if (s) tacLaunch(s, true); });
    if (acqEl('tacCompareBtn')) acqEl('tacCompareBtn').addEventListener('click', tacCompare);
    // Back to batch: history.back() when we came from the list (restores its scroll), else the link.
    if (acqEl('tacBackLink')) acqEl('tacBackLink').addEventListener('click', function (e) {
      if (acqEl('tacBackLink').getAttribute('data-sub')) return;
      if (tacCameFromList && window.history.length > 1) { e.preventDefault(); window.history.back(); }
    });
    wbWire();
  }

  Array.prototype.forEach.call(navItems, function (item) {
    if (item.getAttribute('data-section') === 'test') {
      // Waits for the unsaved-changes answer like the other section loaders (Stay keeps the editor).
      item.addEventListener('click', navLoader(function () { ensureTestPage(); showTestTab('live'); edState = null; }));
    }
  });

  // ---- Test Scenarios (curated customer-situation library) -----------------
  var libLoaded = false; var libData = null;
  var Cts = window.CtsLogic;
  function fillSelect(id, values, keep) { var el = acqEl(id); if (!el) return; var cur = el.value; el.innerHTML = (keep || '') + values.map(function (v) { return '<option>' + esc(v) + '</option>'; }).join(''); el.value = cur; }
  function fillFamilySelect(id, families) { var el = acqEl(id); if (!el) return; var cur = el.value; el.innerHTML = '<option value="">All appliances</option>' + families.map(function (f) { return '<option value="' + esc(f) + '">' + esc(famLabel(f)) + '</option>'; }).join(''); el.value = cur; }
  function libVal(id) { var el = acqEl(id); return el ? el.value : ''; }
  function libChk(id) { var el = acqEl(id); return !!(el && el.checked); }
  // The scenario list loads when its tab/page is shown (libShowList), not on every Test route.
  function ensureLibPage() {
    if (libLoaded) return;
    libLoaded = true;
    libWire();
  }
  var LIB_TEXT = {
    leave: 'You have unsaved scenario changes. If you leave now they will be lost. The saved scenario and past batch runs are not affected.',
  };
  var libListScrollY = null; var libCameFromList = false; var libFlash = null; var libOpenId = null;
  // ---- list / detail routes: '#test?tab=scenarios&q&family&category&archived' and
  //      '#test/scenario/<id>?<list params>' (+ view=edit), '#test/scenario/new' ----
  function libFilterVal(id) { var el = acqEl(id); if (!el) return ''; return el.value || el.getAttribute('data-pending') || ''; }
  function libListParams() {
    return { tab: 'scenarios', q: libVal('libSearch'), family: libFilterVal('libFamily'), category: libFilterVal('libCategory'), archived: libChk('libArchived') ? '1' : '' };
  }
  function libListHref(params) { return hashString('test', params || libListParams()); }
  function libDetailHref(id, extra) {
    var p = libListParams();
    delete p.tab;
    Object.keys(extra || {}).forEach(function (k) { p[k] = extra[k]; });
    return '#test/scenario/' + encodeURIComponent(id) + hashString('', p).slice(1);
  }
  function libApplyParams(params) {
    params = params || {};
    if (acqEl('libSearch') && params.q != null) acqEl('libSearch').value = params.q;
    // Before the option lists load, the deep-linked value is held in data-pending.
    [['libFamily', 'family'], ['libCategory', 'category']].forEach(function (pair) {
      var el = acqEl(pair[0]); var v = params[pair[1]];
      if (!el || v == null) return;
      el.setAttribute('data-pending', v); el.value = v;
    });
    if (acqEl('libArchived') && params.archived != null) acqEl('libArchived').checked = params.archived === '1';
  }
  function libSettlePending(id) {
    var el = acqEl(id); if (!el) return;
    var want = el.getAttribute('data-pending');
    if (want != null) { el.value = want; el.removeAttribute('data-pending'); }
  }
  function libSetStatus(elId, msg, bad) {
    var el = acqEl(elId); if (!el) return;
    el.hidden = !msg; el.textContent = msg || '';
    el.className = 'test-status' + (msg ? (bad ? ' is-bad' : ' is-ok') : '');
  }
  // A one-shot message shown on the next page (e.g. "Saved" after returning to the detail page).
  function libShowFlash(elId) { var f = libFlash; libFlash = null; libSetStatus(elId, f ? f.msg : '', f && f.bad); }
  function libApiPost(path, body) {
    return fetch(API_BASE + path, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
      .then(function (r) {
        if (r.status === 401) { showGate('Your session has expired. Please log in again.'); return { ok: false, status: 401, body: { error: 'Session expired.' } }; }
        return r.json().catch(function () { return {}; }).then(function (b) { return { ok: r.ok, status: r.status, body: b || {} }; });
      })
      .catch(function () { return { ok: false, status: 0, body: { error: 'Network error — nothing was changed.' } }; });
  }
  function libErrText(res, fallback) {
    var b = (res && res.body) || {};
    if (res && res.status === 409) return b.message || 'This scenario changed since you opened it. Reload it, then make your change again.';
    if (res && res.status === 404) return 'This scenario no longer exists.';
    return (b.message || b.error || fallback || 'That did not work.') + ((b.problems && b.problems.length) ? ' (' + b.problems.join('; ') + ')' : '');
  }
  function libShowList(params) {
    edState = null; libOpenId = null;
    if (params && Object.keys(params).length) libApplyParams(params);
    if (acqEl('libDetailPage')) acqEl('libDetailPage').hidden = true;
    if (acqEl('libListView')) acqEl('libListView').hidden = false;
    libShowFlash('libStatus');
    libLoad();
  }
  function libShowPage(mode, id, params) {
    params = params || {};
    // A dirty editor already showing this exact page (e.g. after "Stay") keeps its form untouched.
    if (mode === 'edit' && edState && edState.dirty && edState.id === id && acqEl('libDetailPage') && !acqEl('libDetailPage').hidden) return;
    var listView = acqEl('libListView');
    var listVisible = Boolean(listView && !listView.hidden && acqEl('libTableBody') && acqEl('libTableBody').querySelector('.cts__card'));
    if (listVisible) libListScrollY = window.scrollY || 0;
    libCameFromList = listVisible;
    libApplyParams(params);
    if (listView) listView.hidden = true;
    if (acqEl('libDetailPage')) acqEl('libDetailPage').hidden = false;
    var sub = mode === 'edit';
    var lp = { tab: 'scenarios', q: params.q || '', family: params.family || '', category: params.category || '', archived: params.archived || '' };
    var back = acqEl('libBackLink');
    if (back) {
      back.setAttribute('href', sub ? libDetailHref(id) : libListHref(lp));
      back.textContent = sub ? '\u2190 Back to scenario' : '\u2190 Back to scenarios';
      back.setAttribute('data-sub', sub ? '1' : '');
    }
    window.scrollTo(0, 0);
    libShowFlash('libDetailStatus');
    libOpenId = id;
    edState = null;
    if (mode === 'create') { libEditorOpen('create'); return; }
    if (mode === 'edit') { libEditorOpen('edit', id); return; }
    libDetail(id);
  }
  function libWire() {
    ['libSearch', 'libFamily', 'libCategory'].forEach(function (id) {
      var el = acqEl(id);
      if (el) el.addEventListener(id === 'libSearch' ? 'input' : 'change', function () {
        if (id !== 'libSearch') el.removeAttribute('data-pending');
        writeHash('test', libListParams()); libLoad();
      });
    });
    if (acqEl('libArchived')) acqEl('libArchived').addEventListener('change', function () { writeHash('test', libListParams()); libLoad(); });
    if (acqEl('libNew')) acqEl('libNew').addEventListener('click', function () {
      var p = libListParams(); delete p.tab;
      location.hash = '#test/scenario/new' + hashString('', p).slice(1);
    });
    if (acqEl('libRunSelected')) acqEl('libRunSelected').addEventListener('click', libRunSelected);
    // Back to scenarios: history.back() when we came from the list (restores filters + scroll).
    // A dirty editor is caught by the shared guard on the resulting hash change.
    if (acqEl('libBackLink')) acqEl('libBackLink').addEventListener('click', function (e) {
      if (acqEl('libBackLink').getAttribute('data-sub')) return;
      if (libCameFromList && window.history.length > 1 && !(edState && edState.dirty)) { e.preventDefault(); window.history.back(); }
    });
  }
  function libLoadOptions() {
    fetch(API_BASE + '/admin/library', { credentials: 'same-origin' }).then(function (r) { return r.ok ? r.json() : null; }).then(function (d) {
      if (!d) return;
      fillFamilySelect('libFamily', d.families || []);
      fillSelect('libCategory', d.categories || [], '<option value="">All coverage</option>');
      libSettlePending('libFamily'); libSettlePending('libCategory');
    }).catch(function () {});
  }
  function libUpdateBatchCount() {
    var el = acqEl('libBatchCount');
    if (!el) return;
    el.textContent = libSelected.length
      ? (libSelected.length + ' scenario' + (libSelected.length === 1 ? '' : 's') + ' selected.')
      : 'No scenarios selected.';
  }
  function libCardHtml(j) {
    var checked = libSelected.indexOf(j.journeyId) !== -1 ? ' checked' : '';
    var life = Cts ? Cts.lifecycle(j) : { key: j.archived ? 'retired' : 'active', label: j.archived ? 'Retired' : 'Active' };
    var opener = Cts ? Cts.openerPreview(j.opening) : String(j.opening || '');
    var turnCount = j.turnCount || (j.multiTurn ? 2 : 1);
    var labels = (j.categories || []).slice(0, 3);
    if (j.mustSafetyStop && labels.indexOf('Safety') === -1) labels.push('Safety');
    if (j.expectMedia && labels.indexOf('Media') === -1) labels.push('Media');
    if (j.mustNotPart && labels.indexOf('No Part') === -1 && labels.indexOf('No part yet') === -1) labels.push('No part yet');
    var tags = labels.map(function (c) { return '<span class="cts__tag">' + esc(c) + '</span>'; }).join('');
    return '<article class="cts__card" data-id="' + esc(j.journeyId) + '">' +
      '<label class="cts__pick"><input type="checkbox" class="lib-sel" data-id="' + esc(j.journeyId) + '"' + checked + '><span class="cts__picklbl">Select<span class="visually-hidden"> ' + esc(j.title) + ' for a batch run</span></span></label>' +
      '<div class="cts__cardmain">' +
        '<div class="cts__fam">' + esc(famLabel(j.family)) + '</div>' +
        '<h2 class="cts__title"><a class="cts__titlelink" href="' + esc(libDetailHref(j.journeyId)) + '">' + esc(j.title) + '</a></h2>' +
        (opener ? '<p class="cts__opener"><q>' + esc(opener) + '</q></p>' : '') +
        '<div class="cts__meta">' +
          '<span>' + turnCount + ' customer turn' + (turnCount === 1 ? '' : 's') + '</span>' +
          '<span class="cts__life ' + esc(life.key) + '">' + esc(life.label) + '</span>' +
          '<span>v' + esc(String(j.currentVersion || 1)) + '</span>' +
        '</div>' +
        (tags ? '<div class="cts__tags">' + tags + '</div>' : '') +
        '<div class="cts__id">' + esc(j.journeyId) + '</div>' +
      '</div>' +
      '<div class="cts__cardactions">' +
        '<button class="btn btn--primary cts__open" data-act="workbench" data-id="' + esc(j.journeyId) + '" type="button">Open in Live test</button>' +
        '<a class="btn btn--ghost" href="' + esc(libDetailHref(j.journeyId)) + '" aria-label="Open ' + esc(j.title) + '">Open</a>' +
        '<button class="cts__more" data-act="more" data-id="' + esc(j.journeyId) + '" type="button" aria-label="More actions for ' + esc(j.title) + '" aria-haspopup="true" aria-expanded="false">\u22ef</button>' +
        '<div class="cts__menu" data-menu="' + esc(j.journeyId) + '" hidden>' +
          '<a href="' + esc(libDetailHref(j.journeyId, { view: 'edit' })) + '">Edit</a>' +
          '<button data-act="dup" data-id="' + esc(j.journeyId) + '" type="button">Duplicate</button>' +
          '<button data-act="retire" data-id="' + esc(j.journeyId) + '" type="button">' + (j.archived ? 'Restore' : 'Retire') + '</button>' +
        '</div>' +
      '</div>' +
    '</article>';
  }
  function libLoad() {
    var qs = [];
    if (libVal('libSearch')) qs.push('q=' + encodeURIComponent(libVal('libSearch')));
    if (libFilterVal('libFamily')) qs.push('family=' + encodeURIComponent(libFilterVal('libFamily')));
    if (libFilterVal('libCategory')) qs.push('category=' + encodeURIComponent(libFilterVal('libCategory')));
    if (libChk('libArchived')) qs.push('includeArchived=true');
    var body = acqEl('libTableBody');
    if (body && !body.querySelector('.cts__card')) body.setAttribute('aria-busy', 'true');
    fetch(API_BASE + '/admin/library?' + qs.join('&'), { credentials: 'same-origin' })
      .then(function (r) { if (r.status === 401) { showGate('Session expired.'); return null; } return r.ok ? r.json() : Promise.reject(new Error('HTTP ' + r.status)); })
      .then(function (d) {
        if (!d) return; libData = d;
        fillFamilySelect('libFamily', d.families || []);
        fillSelect('libCategory', d.categories || [], '<option value="">All coverage</option>');
        libSettlePending('libFamily'); libSettlePending('libCategory');
        var list = d.journeys || [];
        if (!body) return;
        body.removeAttribute('aria-busy');
        if (acqEl('libCount')) acqEl('libCount').textContent = list.length + ' scenario' + (list.length === 1 ? '' : 's') + (libChk('libArchived') ? ' (including retired)' : '');
        if (!list.length) {
          body.innerHTML = '<div class="cts__empty">No scenarios match these filters. Try another appliance or search the customer opener.</div>';
        } else {
          body.innerHTML = list.map(libCardHtml).join('');
        }
        wireLibRows();
        libUpdateBatchCount();
        if (libListScrollY != null) { var y = libListScrollY; libListScrollY = null; setTimeout(function () { window.scrollTo(0, y); }, 0); }
      }).catch(function () { if (body) { body.removeAttribute('aria-busy'); body.innerHTML = '<div class="cts__empty">Could not load scenarios. Check your connection and try again.</div>'; } });
  }
  function libOpenInWorkbench(id) {
    showSection('test');
    ensureTestPage();
    showTestTab('live');
    writeHash('test', { tab: 'live', scenario: id });
    wbPickScenario(id);
  }
  function wireLibRows() {
    var host = acqEl('libTableBody'); if (!host) return;
    Array.prototype.forEach.call(host.querySelectorAll('.lib-sel'), function (cb) {
      cb.addEventListener('change', function () {
        var id = cb.getAttribute('data-id');
        if (cb.checked) { if (libSelected.indexOf(id) === -1) libSelected.push(id); }
        else libSelected = libSelected.filter(function (x) { return x !== id; });
        libUpdateBatchCount();
      });
    });
    Array.prototype.forEach.call(host.querySelectorAll('.cts__more'), function (btn) {
      btn.addEventListener('click', function (e) {
        e.stopPropagation();
        var id = btn.getAttribute('data-id');
        var menu = host.querySelector('.cts__menu[data-menu="' + id + '"]');
        if (!menu) return;
        var wasHidden = menu.hidden;
        libCloseMenus();
        menu.hidden = !wasHidden;
        btn.setAttribute('aria-expanded', wasHidden ? 'true' : 'false');
      });
    });
    Array.prototype.forEach.call(host.querySelectorAll('[data-act]'), function (btn) {
      if (btn.classList.contains('cts__more')) return;
      btn.addEventListener('click', function () {
        var id = btn.getAttribute('data-id'); var act = btn.getAttribute('data-act'); libCloseMenus();
        if (act === 'workbench') libOpenInWorkbench(id);
        else if (act === 'dup') libEditorDuplicate(id);
        else if (act === 'retire') libRetire(id);
      });
    });
  }
  function libCloseMenus() {
    Array.prototype.forEach.call(document.querySelectorAll('.cts__menu'), function (m) { m.hidden = true; });
    Array.prototype.forEach.call(document.querySelectorAll('.cts__more'), function (b) { b.setAttribute('aria-expanded', 'false'); });
  }
  document.addEventListener('click', function (e) { if (!e.target.closest || !e.target.closest('.cts__cardactions')) libCloseMenus(); });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') libCloseMenus(); });
  // Starting a batch run is production-impacting (live AI routing switches for the run): confirm first.
  function libConfirmRun(count) {
    return confirm('Run ' + count + ' scenario' + (count === 1 ? '' : 's') + ' with Private AI \u2192 Private AI (Fast Check)?\n\n' + TAC_IMPACT_SHORT);
  }
  function libStartManualRun(ids, label, statusId) {
    var payload = { label: label, mode: 'MANUAL', manualIds: ids, judgeMode: 'DETERMINISTIC_ONLY', understand: { provider: 'lmstudio', model: '' }, compose: { provider: 'lmstudio', model: '' } };
    tacStatus('Starting\u2026', false, statusId);
    return libApiPost('/admin/benchmark/build-run', payload).then(function (res) {
      if (!res.ok) { tacStatus('Could not start the run: ' + libErrText(res, 'failed'), true, statusId); return; }
      tacStatus('Run queued: ' + (res.body.label || res.body.runId) + '.', false, 'tacStatusMsg');
      showTestTab('batch');
      writeHash('test', { tab: 'batch' });
      tacShowList();
      tacLoadHistory();
      tacPollRun(res.body.runId);
    });
  }
  function runOneScenario(id) {
    if (!libConfirmRun(1)) return;
    libStartManualRun([id], 'Scenario ' + id, 'libDetailStatus');
  }
  function libRunSelected() {
    if (!libSelected.length) { tacStatus('Select at least one scenario in the Scenarios tab first.', true); return; }
    if (!libConfirmRun(libSelected.length)) return;
    libStartManualRun(libSelected.slice(), 'Selected scenarios (' + libSelected.length + ')', 'tacStatusMsg');
  }
  function libRetire(id, j, after) {
    j = j || (libData && libData.journeys || []).find(function (x) { return x.journeyId === id; });
    var retiring = !(j && j.archived);
    var msg = retiring
      ? 'Retire ' + id + '? It stays in the library when Include retired is on, and historical runs are preserved.'
      : 'Restore ' + id + ' to the active library?';
    if (!confirm(msg)) return;
    var statusId = (acqEl('libDetailPage') && !acqEl('libDetailPage').hidden) ? 'libDetailStatus' : 'libStatus';
    libApiPost('/admin/library/journey/flags', { id: id, expectedUpdatedAt: (j && j.updatedAt) || undefined, changes: { archived: retiring } })
      .then(function (res) {
        if (!res.ok) { libSetStatus(statusId, (retiring ? 'Could not retire ' : 'Could not restore ') + id + ': ' + libErrText(res), true); return; }
        libFlash = { msg: id + (retiring ? ' retired. Past runs keep their results.' : ' restored to the active library.') };
        if (after) after(res.body); else { libShowFlash(statusId); libLoad(); }
      });
  }
  function detailBlock(title, body) { if (body == null || body === '' || (Array.isArray(body) && !body.length)) return ''; var txt = Array.isArray(body) ? body.join(', ') : body; return '<div class="cts__d"><div class="cts__dh">' + esc(title) + '</div><div class="cts__dv">' + esc(txt) + '</div></div>'; }
  function libDetail(id) {
    var el = acqEl('libDetail'); if (!el) return;
    acqEl('libEditor').hidden = true;
    el.hidden = false;
    el.innerHTML = '<div class="tac__muted">Loading scenario\u2026</div>';
    fetch(API_BASE + '/admin/library/journey?id=' + encodeURIComponent(id), { credentials: 'same-origin' })
      .then(function (r) {
        if (r.status === 401) { showGate('Your session has expired. Please log in again.'); return null; }
        return r.json().catch(function () { return {}; }).then(function (b) { return { ok: r.ok, status: r.status, body: b }; });
      })
      .then(function (res) {
        if (!res || libOpenId !== id) return;
        if (!res.ok) {
          el.innerHTML = '<h2 class="cts__detailtitle">Scenario not found</h2><p class="tac__note">' + esc(res.status === 400 ? 'That is not a valid scenario link.' : (res.status === 404 ? 'No scenario has the id ' + id + '. It may have been deleted.' : libErrText(res))) + '</p>';
          return;
        }
        libRenderDetail(id, res.body);
      })
      .catch(function () { if (libOpenId === id) el.innerHTML = '<h2 class="cts__detailtitle">Could not load this scenario</h2><p class="tac__note">Check your connection and reload the page.</p>'; });
  }
  function libRenderDetail(id, d) {
    var el = acqEl('libDetail');
    var j = d.journey; var v = j.versions[j.versions.length - 1]; var g = v.gold || {};
    var journey = Cts ? Cts.customerJourney(v) : { turns: (v.turns && v.turns.length ? v.turns : [v.opening]).filter(Boolean) };
    var life = Cts ? Cts.lifecycle(j) : { key: j.archived ? 'retired' : 'active', label: j.archived ? 'Retired' : 'Active' };
    var journeyHtml = '<ol class="cts__journey">' + journey.turns.map(function (t, i) {
      return '<li><b>Customer ' + (i + 1) + '</b><span>' + esc(t) + '</span></li>';
    }).join('') + '</ol>';
    var provenance = [j.sourceType, j.sourceReference, j.transcriptReference].filter(Boolean).join(' · ');
    el.innerHTML =
      '<div class="cts__detailhead"><div><div class="cts__detailfam">' + esc(famLabel(j.family)) + (j.make ? ' · ' + esc(j.make) : '') + '</div><h2 class="cts__detailtitle">' + esc(j.title) + '</h2></div>' +
        '<span class="cts__life ' + esc(life.key) + '">' + esc(life.label) + '</span></div>' +
      '<div class="cts__d"><div class="cts__dh">Customer journey</div>' + journeyHtml + '</div>' +
      detailBlock('What this scenario covers', (j.categories || []).join(' · ')) +
      detailBlock('Expected behaviour', Cts ? Cts.outcomeLabel(g.expectedOutcome) : g.expectedOutcome) +
      detailBlock('Leading components', (g.goldSuspects || []).join(', ')) +
      detailBlock('Safety expectation', Cts ? Cts.safetyExpectation(g) : (g.mustSafetyStop ? 'Should stop use' : 'Normal consumer checks')) +
      detailBlock('Parts expectation', Cts ? Cts.partsExpectation(g) : '') +
      detailBlock('Media expectation', Cts ? Cts.mediaExpectation(g) : '') +
      detailBlock('Identification / model', g.lateModel || j.model || '') +
      (provenance ? detailBlock('Provenance', provenance) : '') +
      '<div class="cts__detailactions">' +
        '<button class="btn btn--primary" id="libDetailWorkbench" type="button">Open in Live test</button>' +
        '<a class="btn btn--ghost" id="libDetailEdit" href="' + esc(libDetailHref(id, { view: 'edit' })) + '">Edit</a>' +
        '<button class="btn btn--ghost" id="libDetailDup" type="button">Duplicate</button>' +
        '<button class="btn btn--ghost" id="libDetailRun" type="button"' + (j.archived ? ' disabled' : '') + '>Run as batch</button>' +
      '</div>' +
      '<details class="cts__advdetail"><summary>Advanced / history</summary>' +
        '<div class="cts__techrows">' +
          '<div><span>Scenario ID</span><b>' + esc(j.journeyId) + '</b></div>' +
          '<div><span>Current version</span><b>v' + j.currentVersion + '</b></div>' +
          '<div><span>Review status</span><b>' + esc(j.reviewStatus || '\u2014') + '</b></div>' +
          '<div><span>Source</span><b>' + esc(j.sourceType) + (j.sourceReference ? ' (' + esc(j.sourceReference) + ')' : '') + '</b></div>' +
          '<div><span>Created</span><b>' + esc(whenLong(j.createdAt)) + (j.createdBy ? ' · ' + esc(j.createdBy) : '') + '</b></div>' +
          '<div><span>Last changed</span><b>' + esc(whenLong(j.updatedAt)) + (j.updatedBy ? ' · ' + esc(j.updatedBy) : '') + '</b></div>' +
        '</div>' +
        '<div class="cts__dh">Version history</div>' +
        '<ul class="lib__ed-vers">' + (j.versions || []).slice().reverse().map(function (x) { return '<li><b>v' + esc(String(x.version)) + '</b> \u2014 ' + esc(x.note || '') + ' <span class="lib__ed-when">' + esc(String(x.createdAt || '').slice(0, 10)) + (x.byEmail ? ' · ' + esc(x.byEmail) : '') + '</span></li>'; }).join('') + '</ul>' +
        '<div class="cts__pastconvos" id="libPastConvos"><div class="cts__dh">Past batch conversations</div><div class="cts__muted">Loading\u2026</div></div>' +
        '<div class="cts__lifecycle">' +
          '<button class="btn btn--ghost lib__rev" data-s="ARCHIVED" type="button">' + (j.archived ? 'Restore' : 'Retire') + '</button>' +
        '</div>' +
      '</details>';
    acqEl('libDetailWorkbench').addEventListener('click', function () { libOpenInWorkbench(id); });
    acqEl('libDetailDup').addEventListener('click', function () { libEditorDuplicate(id); });
    acqEl('libDetailRun').addEventListener('click', function () { runOneScenario(id); });
    Array.prototype.forEach.call(el.querySelectorAll('.lib__rev'), function (b) {
      b.addEventListener('click', function () { libRetire(id, j, function () { libShowFlash('libDetailStatus'); libDetail(id); }); });
    });
    libLoadPastConversations(id);
  }
  function libLoadPastConversations(journeyId) {
    var host = acqEl('libPastConvos'); if (!host) return;
    fetch(API_BASE + '/admin/benchmark/scenario-conversations?journey=' + encodeURIComponent(journeyId), { credentials: 'same-origin' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) {
        var list = (d && d.conversations) || [];
        if (!list.length) { host.innerHTML = '<div class="cts__dh">Past batch conversations</div><div class="cts__muted">No batch conversations recorded for this scenario yet.</div>'; return; }
        var rows = list.map(function (c) {
          var vcls = { GOOD: 'is-ok', 'NEEDS REVIEW': 'is-warn', FAILED: 'is-bad' }[c.verdict] || '';
          var rev = c.reviewState && c.reviewState !== 'not_reviewed' ? '<span class="tac__revbadge ' + (REVIEW_CLS[c.reviewState] || '') + '">' + esc(REVIEW_LABELS[c.reviewState] || c.reviewState) + '</span>' : '';
          return '<div class="cts__pastrow">' +
            '<div class="cts__pastmain"><div class="cts__pastwhen">' + esc(whenLong(c.date)) + (c.journeyVersion != null ? ' \u00b7 v' + esc(String(c.journeyVersion)) : '') + '</div>' +
              '<div class="cts__pastsub">' + esc(c.providerPair || '') + ' \u00b7 <span class="tac__pill ' + vcls + '">' + esc(c.verdict) + '</span>' + (c.quality != null ? ' \u00b7 Score ' + esc(String(c.quality)) : '') + '</div></div>' +
            rev +
            '<a class="btn btn--ghost cts__pastview" href="' + esc(tacRunHref(c.runId, { journey: journeyId, from: journeyId })) + '">View</a>' +
          '</div>';
        }).join('');
        host.innerHTML = '<div class="cts__dh">Past batch conversations</div>' + rows;
      })
      .catch(function () { host.innerHTML = '<div class="cts__dh">Past batch conversations</div><div class="cts__muted">Could not load past conversations.</div>'; });
  }

  var LIB_FAMILIES = ['washing-machine', 'washer-dryer', 'tumble-dryer', 'dishwasher', 'oven-cooker', 'hobs', 'fridge-freezer', 'microwave', 'vacuum'];
  var LIB_CATEGORIES = ['Straightforward Diagnosis', 'Ambiguous Symptom', 'Multi-turn', 'Error Code', 'Safety', 'Normal Behaviour', 'No Part', 'Customer Correction', 'Already Replaced', 'Model / Fit', 'Media', 'Near Neighbour', 'Messy Customer Language', 'Conflicting Evidence', 'Hard / Edge Case'];
  var LIB_SOURCES = ['AUTHORED', 'EXISTING_REGRESSION', 'ACQ', 'CUSTOMER_TRANSCRIPT', 'ENGINEER_REVIEW'];
  var LIB_REVIEW = ['DRAFT', 'REVIEWED', 'APPROVED', 'ARCHIVED'];
  var LIB_OUTCOMES = ['DIAGNOSIS', 'NORMAL', 'NO_PART', 'EXTERNAL', 'SAFETY_STOP'];
  var LIB_FACTKEYS = ['model', 'error_code', 'drum_turns', 'drains', 'fills', 'noise_stage', 'heat', 'leak_location', 'age_use', 'already_tried', 'power', 'smell_burning', 'spins_slowly'];
  var edState = null;
  var edCustomerTurns = [];
  var edTurnsData = [];

  function csvList(s) { return String(s == null ? '' : s).split(',').map(function (x) { return x.trim(); }).filter(Boolean); }
  function uniqList(a) { var seen = {}; var out = []; a.forEach(function (x) { var k = x.toLowerCase(); if (!seen[k]) { seen[k] = 1; out.push(x); } }); return out; }
  function edVal(id) { var e = acqEl(id); return e ? e.value : ''; }
  function edChk(id) { var e = acqEl(id); return !!(e && e.checked); }
  function optList(list, sel) { return list.map(function (v) { return '<option' + (v === sel ? ' selected' : '') + '>' + esc(v) + '</option>'; }).join(''); }

  // Duplicate creates a new DRAFT copy (a library write) and opens the copy's editor page.
  function libEditorDuplicate(id) {
    var statusId = (acqEl('libDetailPage') && !acqEl('libDetailPage').hidden) ? 'libDetailStatus' : 'libStatus';
    libApiPost('/admin/library/journey/duplicate', { id: id, overrides: {} }).then(function (res) {
      if (!res.ok) { libSetStatus(statusId, 'Could not duplicate ' + id + ': ' + libErrText(res), true); return; }
      libFlash = { msg: 'Created ' + res.body.journeyId + ' as a DRAFT copy of ' + id + '.' };
      location.hash = libDetailHref(res.body.journeyId, { view: 'edit' });
    });
  }

  function libEditorOpen(mode, id) {
    var el = acqEl('libEditor'); var det = acqEl('libDetail');
    if (det) det.hidden = true;
    if (mode === 'create') { libEditorRender('create', null, []); return; }
    if (el) { el.hidden = false; el.innerHTML = '<div class="tac__muted">Loading scenario\u2026</div>'; }
    fetch(API_BASE + '/admin/library/journey?id=' + encodeURIComponent(id), { credentials: 'same-origin' })
      .then(function (r) {
        if (r.status === 401) { showGate('Your session has expired. Please log in again.'); return null; }
        return r.json().catch(function () { return {}; }).then(function (b) { return { ok: r.ok, status: r.status, body: b }; });
      })
      .then(function (res) {
        if (!res || libOpenId !== id) return;
        if (!res.ok) { if (el) el.innerHTML = '<h2 class="cts__detailtitle">Scenario not found</h2><p class="tac__note">' + esc(res.status === 404 ? 'No scenario has the id ' + id + '.' : libErrText(res)) + '</p>'; return; }
        libEditorRender('edit', res.body.journey, res.body.recentResults || []);
      })
      .catch(function () { if (el && libOpenId === id) el.innerHTML = '<h2 class="cts__detailtitle">Could not load this scenario</h2><p class="tac__note">Check your connection and reload the page.</p>'; });
  }
  // Any edit marks the open editor dirty so the shared guard asks before leaving.
  var libEditorWired = false;
  function edTouch() { if (edState) edState.dirty = true; }

  function libEditorRender(mode, j, recentResults) {
    var v = j ? j.versions[j.versions.length - 1] : null;
    var g = (v && v.gold) || {};
    var el = acqEl('libEditor'); if (!el) return;
    acqEl('libDetail').hidden = true;
    var catSet = {}; ((j && j.categories) || []).forEach(function (c) { catSet[c] = 1; });
    var isEdit = mode === 'edit';
    var journey = Cts && v ? Cts.customerJourney(v) : { turns: v ? ((v.turns && v.turns.length ? v.turns : [v.opening]).filter(Boolean)) : [''] };
    el.hidden = false;
    el.innerHTML =
      '<div class="lib__ed-head"><strong>' + (isEdit ? ('Edit scenario') : 'New scenario') + '</strong>' +
      (isEdit ? ' <span class="cts__life ' + (j.archived ? 'retired' : 'active') + '">' + (j.archived ? 'Retired' : 'Active') + '</span>' : '') +
      '</div>' +
      '<div class="lib__ed-banner" id="edBanner" hidden></div>' +
      '<div class="lib__ed-grid">' +
      '<fieldset class="lib__ed-fs"><legend>Scenario</legend>' +
        '<label class="lib__ed-f"><span>Name</span><input id="ed_title" type="text" required value="' + esc((j && j.title) || '') + '" placeholder="Dyson V6 pulsing" aria-describedby="edErrors"></label>' +
        '<label class="lib__ed-f"><span>Appliance</span><select id="ed_family" required>' + optList(LIB_FAMILIES, (j && j.family) || 'washing-machine') + '</select></label>' +
        '<label class="lib__ed-f"><span>Make <em>(optional)</em></span><input id="ed_make" type="text" value="' + esc((j && j.make) || '') + '" placeholder="Bosch"></label>' +
        '<label class="lib__ed-f"><span>Model <em>(optional)</em></span><input id="ed_model" type="text" value="' + esc((j && j.model) || '') + '"></label>' +
        (isEdit ? '<p class="tac__note">ID <code>' + esc(j.journeyId) + '</code> stays the same when you save.</p>' : '') +
      '</fieldset>' +
      '<fieldset class="lib__ed-fs lib__ed-f--wide"><legend>Customer journey</legend>' +
        '<p class="tac__note">What the customer supplies, in order. Do not script ApplianceClinic replies.</p>' +
        '<div id="ed_customerTurns" class="lib__cj"></div>' +
        '<button type="button" class="btn btn--ghost lib__turn-add" id="ed_addCustomerTurn">+ Add customer turn</button>' +
      '</fieldset>' +
      '<fieldset class="lib__ed-fs"><legend>What this scenario covers</legend>' +
        '<label class="lib__ed-f"><span>Expected behaviour</span><select id="ed_outcome">' + optList(LIB_OUTCOMES, g.expectedOutcome || 'DIAGNOSIS') + '</select></label>' +
        '<label class="lib__ed-f"><span>Leading components / diagnostic behaviour</span><input id="ed_suspects" type="text" value="' + esc((g.goldSuspects || []).join(', ')) + '" placeholder="filter, drain pump"></label>' +
        '<label class="lib__ed-f"><span>Useful follow-up, if any</span><input id="ed_followTarget" type="text" list="ed_factlist" value="' + esc(g.followUpTargetFact || '') + '" placeholder="model identification before compatibility-specific advice"></label>' +
        '<label class="lib__ed-f lib__ed-cbx"><input type="checkbox" id="ed_followAppropriate"' + (g.followUpAppropriate ? ' checked' : '') + '> <span>A follow-up question is appropriate before diagnosis</span></label>' +
        '<div class="lib__ed-f lib__ed-f--wide"><span class="lib__ed-lbl">Coverage</span><div class="lib__ed-cats">' +
          LIB_CATEGORIES.map(function (c) { return '<label class="lib__ed-cat"><input type="checkbox" class="ed_cat" value="' + esc(c) + '"' + (catSet[c] ? ' checked' : '') + '> ' + esc(c) + '</label>'; }).join('') +
        '</div></div>' +
      '</fieldset>' +
      '<fieldset class="lib__ed-fs"><legend>Safety, parts and media</legend>' +
        '<label class="lib__ed-cbx"><input type="checkbox" id="ed_mustSafetyStop"' + (g.mustSafetyStop ? ' checked' : '') + '> <span>Should stop use / professional-only</span></label>' +
        '<label class="lib__ed-cbx"><input type="checkbox" id="ed_mustNotPart"' + (g.mustNotPart ? ' checked' : '') + '> <span>No part should be recommended yet</span></label>' +
        '<label class="lib__ed-cbx"><input type="checkbox" id="ed_expectMedia"' + (g.expectMedia ? ' checked' : '') + '> <span>Helpful media is expected</span></label>' +
      '</fieldset>' +
      '<fieldset class="lib__ed-fs lib__ed-f--wide"><legend>Notes / provenance</legend>' +
        '<label class="lib__ed-f"><span>Source type</span><select id="ed_sourceType">' + optList(LIB_SOURCES, (j && j.sourceType) || 'AUTHORED') + '</select></label>' +
        '<label class="lib__ed-f"><span>Source reference</span><input id="ed_sourceRef" type="text" value="' + esc((j && j.sourceReference) || '') + '" placeholder="Only if already known"></label>' +
        '<label class="lib__ed-f"><span>Transcript reference</span><input id="ed_transcriptRef" type="text" value="' + esc((j && j.transcriptReference) || '') + '"></label>' +
        (isEdit ? '<label class="lib__ed-f"><span>Review status</span><select id="ed_review">' + optList(LIB_REVIEW, j.reviewStatus) + '</select></label>' : '') +
        '<label class="lib__ed-f lib__ed-cbx"><input type="checkbox" id="ed_enabled"' + ((!j || j.enabled) ? ' checked' : '') + '> <span>Active in the curated library</span></label>' +
      '</fieldset>' +
      '</div>' +
      '<details class="cts__advdetail"><summary>Advanced batch fields</summary>' +
        '<p class="tac__note">Kept for the existing runner. Do not treat phrase lists as the product expectation.</p>' +
        '<label class="lib__ed-f"><span>Must include phrases <em>(batch only)</em></span><input id="ed_mustInclude" type="text" value="' + esc((g.mustInclude || []).join(', ')) + '"></label>' +
        '<label class="lib__ed-f"><span>Acceptable alternatives</span><input id="ed_alts" type="text" value="' + esc((g.acceptableAlternatives || []).join(', ')) + '"></label>' +
        '<label class="lib__ed-f"><span>Forbidden outcomes</span><input id="ed_forbidden" type="text" value="' + esc((g.forbiddenOutcomes || []).join(', ')) + '"></label>' +
        '<label class="lib__ed-f"><span>Ideal turns</span><input id="ed_idealTurns" type="number" min="1" max="8" value="' + esc(g.idealTurns || 1) + '"></label>' +
        '<label class="lib__ed-f"><span>Max turns</span><input id="ed_maxTurns" type="number" min="1" max="8" value="' + esc(g.maxTurns || 4) + '"></label>' +
        '<label class="lib__ed-f"><span>Difficulty</span><select id="ed_difficulty">' + optList(['EASY', 'MEDIUM', 'HARD'], (j && j.difficulty) || 'MEDIUM') + '</select></label>' +
        '<label class="lib__ed-f"><span>Model supplied later</span><input id="ed_lateModel" type="text" value="' + esc(g.lateModel || '') + '"></label>' +
        '<label class="lib__ed-f"><span>Already-known facts</span><input id="ed_alreadyKnown" type="text" value="' + esc((g.alreadyKnownFacts || []).join(', ')) + '"></label>' +
        '<label class="lib__ed-f lib__ed-cbx"><input type="checkbox" id="ed_immediate"' + (g.immediateDiagnosis !== false ? ' checked' : '') + '> <span>Immediate diagnosis may be appropriate</span></label>' +
        '<label class="lib__ed-f lib__ed-f--wide"><span>Scripted follow-ups <em>(one per line, customer text for the batch runner)</em></span><textarea id="ed_scripted" rows="2">' + esc(((g.scriptedFollowups) || []).join('\n')) + '</textarea></label>' +
        '<div class="lib__ed-f lib__ed-f--wide"><span class="lib__ed-lbl">Simulated answers for batch facts</span>' +
          '<div id="ed_turns" class="lib__turns"></div>' +
          '<button type="button" class="btn btn--ghost lib__turn-add" id="ed_addTurn">+ Add simulated answer</button>' +
        '</div>' +
      '</details>' +
      (isEdit ? '<label class="lib__ed-f lib__ed-f--wide"><span>Version note</span><input id="ed_versionNote" type="text" placeholder="what changed and why"></label>' : '') +
      '<div class="lib__ed-errors" id="edErrors" hidden role="alert"></div>' +
      '<div class="lib__ed-actions">' +
        '<button type="button" class="btn btn--primary" id="edSave">' + (isEdit ? 'Save' : 'Save scenario') + '</button>' +
        (isEdit ? '<button type="button" class="btn btn--ghost" id="edWorkbench">Open in Live test</button>' : '') +
        '<button type="button" class="btn btn--ghost" id="edCancel">Cancel</button>' +
        (isEdit ? '<span class="lib__ed-spacer"></span><button type="button" class="btn btn--ghost" id="edDuplicate">Duplicate</button><button type="button" class="btn btn--ghost lib__ed-danger" id="edArchive">Retire</button><button type="button" class="btn btn--ghost lib__ed-danger" id="edDelete">Delete</button>' : '') +
      '</div>' +
      (isEdit ? libEditorSidebar(j, recentResults) : '') +
      '<datalist id="ed_factlist">' + LIB_FACTKEYS.map(function (k) { return '<option value="' + esc(k) + '">'; }).join('') + '</datalist>';

    // hash + dirty: the shared unsaved-changes guard (sidebar, Back, in-page links, tab close).
    // updatedAt: the optimistic-concurrency token sent with Save / Retire / Delete.
    edState = { mode: mode, id: isEdit ? j.journeyId : null, baseVersion: isEdit ? j.currentVersion : 0, baseSemantic: null, updatedAt: isEdit ? (j.updatedAt || null) : null, hash: location.hash, dirty: false };
    if (!libEditorWired) {
      libEditorWired = true;
      el.addEventListener('input', edTouch);
      el.addEventListener('change', edTouch);
    }
    edCustomerTurns = journey.turns.length ? journey.turns.slice() : [''];
    var answers = (g.simulatedAnswers) || {};
    edTurnsData = Object.keys(answers).map(function (k) { return { fact: k, response: answers[k] }; });
    renderCustomerTurns();
    renderTurns();
    if (isEdit) edState.baseSemantic = canonSemantic(edCustomerTurns[0] || '', readGold(), edCustomerTurns);
    acqEl('ed_addCustomerTurn').addEventListener('click', function () { edCustomerTurns.push(''); edTouch(); renderCustomerTurns(); recomputeBanner(); });
    acqEl('ed_addTurn').addEventListener('click', function () { edTurnsData.push({ fact: '', response: '' }); edTouch(); renderTurns(); recomputeBanner(); });
    acqEl('edSave').addEventListener('click', libEditorSave);
    // Cancel = leave the editor page (the guard asks first when there are unsaved changes).
    acqEl('edCancel').addEventListener('click', function () {
      var p = libListParams(); var lp = Object.assign({}, p);
      location.hash = isEdit ? libDetailHref(j.journeyId) : libListHref(lp);
    });
    if (isEdit) {
      acqEl('edWorkbench').addEventListener('click', function () { knLeaveGuard().leave(function () { edState = null; libOpenInWorkbench(j.journeyId); }); });
      acqEl('edDuplicate').addEventListener('click', function () { knLeaveGuard().leave(function () { edState = null; libEditorDuplicate(j.journeyId); }); });
      acqEl('edArchive').addEventListener('click', function () {
        if (!confirm('Retire ' + j.journeyId + '? It stays in history and can be shown with Include retired.' + (edState && edState.dirty ? '\n\nYour unsaved edits in this form will be discarded.' : ''))) return;
        libApiPost('/admin/library/journey/flags', { id: j.journeyId, expectedUpdatedAt: edState && edState.updatedAt, changes: { archived: true } }).then(function (res) {
          if (!res.ok) { libEditorServerErrors({ error: libErrText(res) }); return; }
          edState = null;
          libFlash = { msg: j.journeyId + ' retired. Past runs keep their results.' };
          location.hash = libDetailHref(j.journeyId);
        });
      });
      acqEl('edDelete').addEventListener('click', function () { libEditorDelete(j.journeyId, recentResults); });
    }
    ['ed_title', 'ed_followTarget', 'ed_followAppropriate', 'ed_lateModel', 'ed_scripted', 'ed_alreadyKnown', 'ed_outcome', 'ed_suspects', 'ed_alts', 'ed_mustInclude', 'ed_forbidden', 'ed_idealTurns', 'ed_maxTurns', 'ed_mustSafetyStop', 'ed_mustNotPart', 'ed_expectMedia', 'ed_immediate'].forEach(function (id) { var e = acqEl(id); if (e) e.addEventListener('change', recomputeBanner); if (e) e.addEventListener('input', recomputeBanner); });
    recomputeBanner();
    var first = acqEl('ed_title'); if (first && !isEdit) { try { first.focus({ preventScroll: true }); } catch (e) { first.focus(); } }
  }

  function libEditorSidebar(j, recentResults) {
    return '<div class="lib__ed-side">' +
      '<div class="lib__ed-side-h">Version history</div>' +
      '<ul class="lib__ed-vers">' + (j.versions || []).map(function (x) { return '<li><b>v' + x.version + '</b> — ' + esc(x.note || '') + ' <span class="lib__ed-when">' + esc(String(x.createdAt || '').slice(0, 10)) + (x.byEmail ? ' · ' + esc(x.byEmail) : '') + '</span></li>'; }).join('') + '</ul>' +
      '<div class="lib__ed-side-h">Recent batch runs</div>' +
      '<ul class="lib__ed-runs">' + ((recentResults || []).slice(0, 6).map(function (x) { return '<li>' + esc(x.label) + ' <span class="acqb__badge ' + String(x.status).toLowerCase() + '">' + esc(x.status) + '</span></li>'; }).join('') || '<li class="lib__ed-when">No runs yet</li>') + '</ul>' +
      '</div>';
  }

  function renderCustomerTurns() {
    var box = acqEl('ed_customerTurns'); if (!box) return;
    if (!edCustomerTurns.length) edCustomerTurns = [''];
    box.innerHTML = edCustomerTurns.map(function (t, i) {
      return '<div class="lib__cj-row" data-i="' + i + '">' +
        '<label><span class="lib__cj-lbl" for="ed_cj_' + i + '">Customer turn ' + (i + 1) + (i === 0 ? ' (opener)' : '') + '</span>' +
        '<textarea id="ed_cj_' + i + '" rows="2" placeholder="' + (i === 0 ? 'my bosch washer wont drain' : 'I\'m not sure') + '">' + esc(t) + '</textarea></label>' +
        '<div class="lib__turn-btns">' +
          '<button type="button" class="lib__turn-b" data-act="up" data-i="' + i + '" ' + (i === 0 ? 'disabled' : '') + ' aria-label="Move turn ' + (i + 1) + ' up">&uarr;</button>' +
          '<button type="button" class="lib__turn-b" data-act="down" data-i="' + i + '" ' + (i === edCustomerTurns.length - 1 ? 'disabled' : '') + ' aria-label="Move turn ' + (i + 1) + ' down">&darr;</button>' +
          '<button type="button" class="lib__turn-b lib__turn-x" data-act="rm" data-i="' + i + '" ' + (edCustomerTurns.length === 1 ? 'disabled' : '') + ' aria-label="Remove turn ' + (i + 1) + '">&times;</button>' +
        '</div>' +
      '</div>';
    }).join('');
    Array.prototype.forEach.call(box.querySelectorAll('.lib__cj-row'), function (rowEl) {
      var i = parseInt(rowEl.getAttribute('data-i'), 10);
      var ta = rowEl.querySelector('textarea');
      if (ta) ta.addEventListener('input', function (e) { edCustomerTurns[i] = e.target.value; recomputeBanner(); });
    });
    Array.prototype.forEach.call(box.querySelectorAll('.lib__turn-b'), function (btn) {
      btn.addEventListener('click', function () {
        var i = parseInt(btn.getAttribute('data-i'), 10); var act = btn.getAttribute('data-act');
        if (act === 'rm' && edCustomerTurns.length > 1) edCustomerTurns.splice(i, 1);
        else if (act === 'up' && i > 0) { var a = edCustomerTurns[i - 1]; edCustomerTurns[i - 1] = edCustomerTurns[i]; edCustomerTurns[i] = a; }
        else if (act === 'down' && i < edCustomerTurns.length - 1) { var b = edCustomerTurns[i + 1]; edCustomerTurns[i + 1] = edCustomerTurns[i]; edCustomerTurns[i] = b; }
        edTouch(); renderCustomerTurns(); recomputeBanner();
      });
    });
  }

  function renderTurns() {
    var box = acqEl('ed_turns'); if (!box) return;
    if (!edTurnsData.length) { box.innerHTML = '<div class="lib__turn-empty">No simulated batch answers.</div>'; }
    else {
      box.innerHTML = edTurnsData.map(function (t, i) {
        return '<div class="lib__turn" data-i="' + i + '">' +
          '<input class="lib__turn-fact" list="ed_factlist" placeholder="fact / question intent" value="' + esc(t.fact) + '">' +
          '<input class="lib__turn-resp" placeholder="what the customer replies" value="' + esc(t.response) + '">' +
          '<div class="lib__turn-btns">' +
            '<button type="button" class="lib__turn-b" data-act="up" data-i="' + i + '" ' + (i === 0 ? 'disabled' : '') + '>&uarr;</button>' +
            '<button type="button" class="lib__turn-b" data-act="down" data-i="' + i + '" ' + (i === edTurnsData.length - 1 ? 'disabled' : '') + '>&darr;</button>' +
            '<button type="button" class="lib__turn-b lib__turn-x" data-act="rm" data-i="' + i + '">&times;</button>' +
          '</div>' +
        '</div>';
      }).join('');
    }
    Array.prototype.forEach.call(box.querySelectorAll('.lib__turn'), function (rowEl) {
      var i = parseInt(rowEl.getAttribute('data-i'), 10);
      rowEl.querySelector('.lib__turn-fact').addEventListener('input', function (e) { edTurnsData[i].fact = e.target.value; recomputeBanner(); });
      rowEl.querySelector('.lib__turn-resp').addEventListener('input', function (e) { edTurnsData[i].response = e.target.value; recomputeBanner(); });
    });
    Array.prototype.forEach.call(box.querySelectorAll('.lib__turn-b'), function (btn) {
      btn.addEventListener('click', function () {
        var i = parseInt(btn.getAttribute('data-i'), 10); var act = btn.getAttribute('data-act');
        if (act === 'rm') edTurnsData.splice(i, 1);
        else if (act === 'up' && i > 0) { var a = edTurnsData[i - 1]; edTurnsData[i - 1] = edTurnsData[i]; edTurnsData[i] = a; }
        else if (act === 'down' && i < edTurnsData.length - 1) { var b = edTurnsData[i + 1]; edTurnsData[i + 1] = edTurnsData[i]; edTurnsData[i] = b; }
        edTouch(); renderTurns(); recomputeBanner();
      });
    });
  }

  function readSimulatedAnswers() { var o = {}; edTurnsData.forEach(function (t) { if (t.fact.trim() && t.response.trim()) o[t.fact.trim()] = t.response.trim(); }); return o; }
  function readCustomerTurns() { return (Cts ? Cts.cleanTurns(edCustomerTurns) : edCustomerTurns.map(function (t) { return String(t || '').trim(); }).filter(Boolean)); }

  function readGold() {
    return {
      expectedOutcome: edVal('ed_outcome'),
      goldSuspects: uniqList(csvList(edVal('ed_suspects'))),
      acceptableAlternatives: uniqList(csvList(edVal('ed_alts'))),
      expectedComponents: uniqList(csvList(edVal('ed_suspects'))),
      mustInclude: uniqList(csvList(edVal('ed_mustInclude'))),
      forbiddenOutcomes: uniqList(csvList(edVal('ed_forbidden'))),
      followUpAppropriate: edChk('ed_followAppropriate'),
      followUpTargetFact: edVal('ed_followTarget').trim() || null,
      immediateDiagnosis: edChk('ed_immediate'),
      simulatedAnswers: readSimulatedAnswers(),
      scriptedFollowups: String(edVal('ed_scripted') || '').split('\n').map(function (s) { return s.trim(); }).filter(Boolean),
      lateModel: edVal('ed_lateModel').trim() || null,
      alreadyKnownFacts: uniqList(csvList(edVal('ed_alreadyKnown'))),
      mustSafetyStop: edChk('ed_mustSafetyStop'),
      mustNotPart: edChk('ed_mustNotPart'),
      expectMedia: edChk('ed_expectMedia'),
      idealTurns: parseInt(edVal('ed_idealTurns'), 10) || 1,
      maxTurns: parseInt(edVal('ed_maxTurns'), 10) || 4,
    };
  }
  function readCategories() { return uniqList(Array.prototype.map.call(document.querySelectorAll('.ed_cat:checked'), function (c) { return c.value; })); }
  function canonSemantic(opening, gold, turns) {
    var keys = ['expectedOutcome', 'goldSuspects', 'acceptableAlternatives', 'expectedComponents', 'mustInclude', 'forbiddenOutcomes', 'followUpAppropriate', 'followUpTargetFact', 'immediateDiagnosis', 'simulatedAnswers', 'scriptedFollowups', 'lateModel', 'alreadyKnownFacts', 'mustSafetyStop', 'mustNotPart', 'expectMedia', 'idealTurns', 'maxTurns'];
    var g = gold || {}; var norm = {};
    keys.forEach(function (k) {
      var val = g[k];
      if (Array.isArray(val)) norm[k] = val.slice();
      else if (val && typeof val === 'object') { var o = {}; Object.keys(val).sort().forEach(function (kk) { o[kk] = val[kk]; }); norm[k] = o; }
      else norm[k] = (val === undefined ? null : val);
    });
    return JSON.stringify([String(opening || '').trim(), (turns || []).map(function (t) { return String(t || '').trim(); }), norm]);
  }

  function editorValidate(gold) {
    var turns = edCustomerTurns.slice();
    var input = {
      title: edVal('ed_title'),
      family: edVal('ed_family'),
      turns: turns,
      gold: gold,
    };
    if (Cts) return Cts.validateScenario(input).map(function (e) { return e.message; });
    var errs = [];
    if (!edVal('ed_title').trim()) errs.push('Name is required.');
    if (!readCustomerTurns().length) errs.push('Add at least one customer opener.');
    if (gold.expectedOutcome === 'DIAGNOSIS' && !gold.goldSuspects.length) errs.push('Describe the leading diagnostic behaviour or component.');
    if (gold.followUpAppropriate && !gold.followUpTargetFact) errs.push('Say what a useful follow-up should establish.');
    return errs;
  }

  function recomputeBanner() {
    var b = acqEl('edBanner'); if (!b || !edState) return;
    if (edState.mode === 'create') { b.hidden = false; b.className = 'lib__ed-banner lib__ed-banner--info'; b.innerHTML = 'Will be created as a <b>DRAFT</b> in the ' + esc(acqEl('ed_family').value) + ' library.'; return; }
    var nowKey = canonSemantic(edCustomerTurns[0] || '', readGold(), edCustomerTurns);
    if (nowKey !== edState.baseSemantic) {
      b.hidden = false; b.className = 'lib__ed-banner lib__ed-banner--warn';
      b.innerHTML = 'Saving will create <b>' + esc(edState.id) + ' v' + (edState.baseVersion + 1) + '</b>. Historical runs stay pinned to v' + edState.baseVersion + '.';
    } else {
      b.hidden = false; b.className = 'lib__ed-banner lib__ed-banner--info';
      b.innerHTML = 'Metadata-only change — stays on <b>v' + edState.baseVersion + '</b>.';
    }
  }

  function libEditorSave() {
    var gold = readGold();
    var errs = editorValidate(gold);
    var ebox = acqEl('edErrors');
    var titleEl = acqEl('ed_title');
    if (errs.length) {
      ebox.hidden = false;
      ebox.innerHTML = '<b>Fix these:</b><ul>' + errs.map(function (e) { return '<li>' + esc(e) + '</li>'; }).join('') + '</ul>';
      if (titleEl) titleEl.setAttribute('aria-invalid', errs.some(function (e) { return /Name is required/.test(e); }) ? 'true' : 'false');
      ebox.scrollIntoView({ behavior: 'smooth' });
      return;
    }
    if (titleEl) titleEl.removeAttribute('aria-invalid');
    ebox.hidden = true;
    var turns = readCustomerTurns();
    var opening = turns[0];
    var meta = { title: edVal('ed_title').trim(), family: edVal('ed_family'), make: edVal('ed_make').trim() || null, model: edVal('ed_model').trim() || null, difficulty: edVal('ed_difficulty'), categories: readCategories(), sourceType: edVal('ed_sourceType'), sourceReference: edVal('ed_sourceRef').trim() || null, transcriptReference: edVal('ed_transcriptRef').trim() || null, enabled: edChk('ed_enabled') };
    acqEl('edSave').disabled = true;
    var st = edState;
    function saved(rec, msg) {
      // Saved: the form is clean, so leaving is not guarded; land on the saved scenario's page.
      st.dirty = false; edState = null;
      libFlash = { msg: msg };
      location.hash = libDetailHref(rec.journeyId);
    }
    if (st.mode === 'create') {
      var body = Object.assign({}, meta, { opening: opening, turns: turns, gold: gold });
      libApiPost('/admin/library/journey', body).then(function (res) {
        acqEl('edSave').disabled = false;
        if (res.ok) saved(res.body, 'Created ' + res.body.journeyId + ' as a DRAFT.');
        else libEditorServerErrors({ error: libErrText(res), problems: null });
      });
      return;
    }
    var changes = { title: meta.title, make: meta.make, model: meta.model, difficulty: meta.difficulty, categories: meta.categories, sourceType: meta.sourceType, sourceReference: meta.sourceReference, transcriptReference: meta.transcriptReference, enabled: meta.enabled, reviewStatus: edVal('ed_review') };
    var nowKey = canonSemantic(opening, gold, turns);
    if (nowKey !== st.baseSemantic) { changes.opening = opening; changes.turns = turns; changes.gold = gold; changes.versionNote = edVal('ed_versionNote').trim() || 'edited'; }
    libApiPost('/admin/library/journey/edit', { id: st.id, expectedUpdatedAt: st.updatedAt || undefined, changes: changes }).then(function (res) {
      acqEl('edSave').disabled = false;
      if (res.ok) saved(res.body, 'Saved ' + res.body.journeyId + (res.body.currentVersion !== st.baseVersion ? ' as v' + res.body.currentVersion + '. Past runs stay pinned to v' + st.baseVersion + '.' : ' (metadata only, still v' + st.baseVersion + ').'));
      // 409: someone else saved first. Keep the form (and the dirty state) so nothing typed is lost.
      else libEditorServerErrors({ error: libErrText(res), problems: null });
    });
  }
  function libEditorServerErrors(body) { var ebox = acqEl('edErrors'); ebox.hidden = false; ebox.innerHTML = '<b>Not saved:</b> ' + esc(body.error || 'error') + ((body.problems && body.problems.length) ? '<ul>' + body.problems.map(function (p) { return '<li>' + esc(p) + '</li>'; }).join('') + '</ul>' : ''); }

  function libEditorDelete(id, recentResults) {
    var hasRuns = (recentResults || []).length > 0;
    var msg = hasRuns
      ? 'This scenario has run history, so it CANNOT be destroyed — it will be RETIRED instead to preserve historical evidence. Continue?'
      : 'This scenario has no run history and will be permanently deleted. This cannot be undone. Continue?';
    if (!confirm(msg)) return;
    libApiPost('/admin/library/journey/delete', { id: id, expectedUpdatedAt: (edState && edState.updatedAt) || undefined }).then(function (res) {
      if (!res.ok) { libEditorServerErrors({ error: libErrText(res) }); return; }
      edState = null;
      libFlash = { msg: res.body.archived ? (id + ' was retired (history preserved).') : (res.body.deleted ? (id + ' was deleted.') : 'Done.') };
      location.hash = res.body.archived ? libDetailHref(id) : libListHref();
    });
  }
  checkSession();
})();
