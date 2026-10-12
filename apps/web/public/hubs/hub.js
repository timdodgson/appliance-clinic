/* ApplianceClinic Help Hub — diagnosis handoff.
 * Stores a one-shot intent in sessionStorage (never in the URL, never in Cache Storage).
 * The homepage chat consumes it. Does not call /api.
 */
(function () {
  'use strict';
  var KEY = 'ac.hub.intent.v1';

  function isOffline() { return typeof navigator !== 'undefined' && navigator.onLine === false; }

  var note = document.getElementById('hubOffline');
  function syncOffline() {
    if (note) note.hidden = !isOffline();
  }
  window.addEventListener('offline', syncOffline);
  window.addEventListener('online', syncOffline);
  syncOffline();

  function stash(draft) {
    try {
      sessionStorage.setItem(KEY, JSON.stringify({
        v: 1,
        draft: draft,
        from: location.pathname,
        createdAt: new Date().toISOString()
      }));
    } catch (e) { /* private mode */ }
    window.location.href = '/#ask';
  }

  document.addEventListener('click', function (e) {
    var el = /** @type {Element} */ (e.target);
    var btn = el && el.closest ? el.closest('[data-diagnose]') : null;
    if (!btn) return;
    e.preventDefault();
    var draft = btn.getAttribute('data-diagnose') || '';
    if (!draft) {
      window.location.href = '/#ask';
      return;
    }
    stash(draft);
  });

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(function () {});
  }
})();
