/* ApplianceClinic Recall Centre — public search/filter. GET /api/recalls only. */
(function () {
  'use strict';
  var API = '/api/recalls';
  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c];
    });
  }
  var offline = $('recallOffline');
  function syncOffline() {
    if (offline) offline.hidden = !(typeof navigator !== 'undefined' && navigator.onLine === false);
  }
  window.addEventListener('offline', syncOffline);
  window.addEventListener('online', syncOffline);
  syncOffline();

  var form = $('recallSearch');
  var results = $('recallResults');
  if (!form || !results) return;

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    var qEl = /** @type {HTMLInputElement | null} */ ($('recallQ'));
    var q = ((qEl && qEl.value) || '').trim();
    if (q.length < 2) {
      results.hidden = true;
      results.innerHTML = '';
      if (window.history && window.history.replaceState) window.history.replaceState({}, '', '/recalls/');
      return;
    }
    results.hidden = false;
    results.setAttribute('aria-busy', 'true');
    results.innerHTML = '<p class="hub-lead">Checking official notices…</p>';
    fetch(API + '/lookup?q=' + encodeURIComponent(q), { headers: { accept: 'application/json' } })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        results.removeAttribute('aria-busy');
        var items = (data && data.items) || [];
        if (!items.length) {
          results.innerHTML = '<p>No matching appliance notices. That is not a certificate of safety — it means nothing in our OPSS-derived set matched this wording.</p>';
          return;
        }
        results.innerHTML = '<p class="hub-lead">' + esc(data.note || '') + '</p><div class="recall-list">'
          + items.map(function (it) {
            var badge = it.match && it.match.strength === 'strong'
              ? '<span class="recall-badge recall-badge--strong">Listed model</span>'
              : '<span class="recall-badge">Possible match — check the official record</span>';
            return '<article class="recall-card">' + badge
              + '<h3><a href="' + esc(it.url) + '">' + esc(it.productName || it.title) + '</a></h3>'
              + '<p>' + esc(it.match && it.match.label || '') + '</p></article>';
          }).join('') + '</div>';
      })
      .catch(function () {
        results.removeAttribute('aria-busy');
        results.innerHTML = '<p>Could not search notices right now. Use the GOV.UK product safety site, or try again.</p>';
      });
  });

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(function () {});
  }
})();
