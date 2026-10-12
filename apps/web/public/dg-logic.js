/*
 * Diagnostics inspector — presentation helpers (no DOM, no diagnosis).
 * Read-only admin visibility. Not used by customer diagnosis.
 */
(/** @param {any} root @param {() => any} factory */ function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.DgLogic = api;
})(typeof window !== 'undefined' ? window : typeof global !== 'undefined' ? global : this, function () {
  'use strict';

  var LABELS = {
    healthy: 'Healthy',
    degraded: 'Degraded',
    unavailable: 'Unavailable',
    unknown: 'Unknown',
  };

  function healthLabel(status) {
    return LABELS[status] || LABELS.unknown;
  }

  function healthClass(status) {
    if (status === 'healthy') return 'dg-pill dg-pill--ok';
    if (status === 'degraded') return 'dg-pill dg-pill--warn';
    if (status === 'unavailable') return 'dg-pill dg-pill--bad';
    return 'dg-pill dg-pill--unknown';
  }

  function latencyText(ms) {
    if (ms == null || ms === '') return null;
    var n = Number(ms);
    if (!Number.isFinite(n)) return null;
    return Math.round(n) + ' ms';
  }

  function missingText(label) {
    return label || 'Version not exposed by runtime';
  }

  function formatWhen(iso) {
    if (!iso) return 'Last probe unavailable';
    try {
      var d = new Date(iso);
      if (isNaN(d.getTime())) return 'Last probe unavailable';
      return d.toLocaleString('en-GB', {
        day: '2-digit', month: 'short', year: 'numeric',
        hour: '2-digit', minute: '2-digit', second: '2-digit',
      });
    } catch (e) { return 'Last probe unavailable'; }
  }

  function overlayLabel(media) {
    if (!media || !media.overlay) return 'Overlay not currently present';
    if (media.overlayUnavailable) return 'Overlay store could not be read';
    return media.overlay.present ? 'active' : 'none';
  }

  function hasMutationControls(html) {
    return /\b(Restart|Repair|Rebuild|Re-index|Flush|Reset|Redeploy|Clear cache)\b/.test(String(html || ''))
      && /<button\b/i.test(String(html || ''));
  }

  return {
    LABELS: LABELS,
    healthLabel: healthLabel,
    healthClass: healthClass,
    latencyText: latencyText,
    missingText: missingText,
    formatWhen: formatWhen,
    overlayLabel: overlayLabel,
    hasMutationControls: hasMutationControls,
  };
});
