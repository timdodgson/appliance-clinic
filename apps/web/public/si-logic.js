'use strict';
/**
 * ApplianceClinic Safety Ingest — view helpers. No network. No secrets.
 */
(/** @param {any} root @param {() => any} factory */ function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.Si = api;
})(typeof window !== 'undefined' ? window : typeof global !== 'undefined' ? global : this, function () {
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function statusClass(code) {
    if (code === 'healthy') return 'si-status--ok';
    if (code === 'running') return 'si-status--run';
    if (code === 'attention') return 'si-status--warn';
    if (code === 'failed' || code === 'unavailable') return 'si-status--bad';
    return 'si-status--unknown';
  }

  function confirmCopy() {
    return 'This runs the same production ingest as the daily 06:00 UTC schedule. It updates ApplianceClinic’s published safety dataset if GOV.UK has new or changed notices. If the fetch fails, the last-good published dataset stays in place. Continue?';
  }

  function fmtWhen(iso) {
    if (!iso) return '—';
    try {
      return new Date(iso).toLocaleString('en-GB', {
        day: '2-digit', month: 'short', year: 'numeric',
        hour: '2-digit', minute: '2-digit', timeZone: 'UTC',
      }) + ' UTC';
    } catch (e) { return String(iso); }
  }

  function relativeAgo(iso, now) {
    if (!iso) return null;
    var t = new Date(iso).getTime();
    if (!Number.isFinite(t)) return null;
    var ms = (now || new Date()).getTime() - t;
    if (ms < 0) return 'just now';
    var mins = Math.round(ms / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return mins + ' minute' + (mins === 1 ? '' : 's') + ' ago';
    var hrs = Math.round(mins / 60);
    if (hrs < 48) return hrs + ' hour' + (hrs === 1 ? '' : 's') + ' ago';
    var days = Math.round(hrs / 24);
    return days + ' day' + (days === 1 ? '' : 's') + ' ago';
  }

  function duration(ms) {
    if (ms == null || !Number.isFinite(Number(ms))) return '—';
    var n = Math.max(0, Math.round(Number(ms) / 1000));
    if (n < 60) return n + 's';
    var m = Math.floor(n / 60);
    var s = n % 60;
    if (m < 60) return m + 'm ' + s + 's';
    return Math.floor(m / 60) + 'h ' + (m % 60) + 'm';
  }

  function countOrDash(n) {
    return n == null ? '—' : String(n);
  }

  function sourceHtml(src) {
    src = src || {};
    return '<dl class="si-dl">'
      + '<div><dt>Authority</dt><dd>' + esc(src.authority) + '</dd></div>'
      + '<div><dt>Via</dt><dd>' + esc(src.via) + '</dd></div>'
      + '<div><dt>Type</dt><dd>' + esc(src.type) + '</dd></div>'
      + '<div><dt>Search API</dt><dd class="si-wrap">' + esc(src.searchUrl) + '</dd></div>'
      + '<div><dt>Content API</dt><dd class="si-wrap">' + esc(src.contentUrl) + '</dd></div>'
      + '<div><dt>Categories</dt><dd class="si-wrap">' + esc((src.categories || []).join(', ')) + '</dd></div>'
      + '<div><dt>Licence</dt><dd>' + esc(src.licence) + '</dd></div>'
      + '</dl>';
  }

  function pipelineHtml(steps) {
    return '<ol class="si-pipe">' + (steps || []).map(function (s) {
      return '<li><span class="si-pipe__count">' + esc(countOrDash(s.count)) + '</span>'
        + '<span class="si-pipe__label">' + esc(s.label) + '</span>'
        + (s.note ? '<span class="si-pipe__note">' + esc(s.note) + '</span>' : '')
        + '</li>';
    }).join('') + '</ol>';
  }

  function rejectionHtml(rej, reconstructed) {
    if (reconstructed) {
      return '<p class="si-note">Filter reasons were not retained on that reconstructed run. New ingest runs record a deterministic breakdown.</p>';
    }
    if (!rej || !rej.items || !rej.items.length) {
      return '<p class="si-note">No filtered records were recorded on the latest run. A quiet daily window with no new OPSS candidates is expected.</p>';
    }
    return '<p class="si-note">' + esc(rej.total) + ' source records were not published this run.</p>'
      + '<ul class="si-rej">' + rej.items.map(function (it) {
        return '<li><span class="si-rej__count">' + esc(it.count) + '</span>'
          + '<span>' + esc(it.label) + '</span></li>';
      }).join('') + '</ul>';
  }

  function familyHtml(families) {
    var rows = (families || []).filter(function (f) { return f && f.count > 0; });
    if (!rows.length) return '<p class="si-note">No published notices in any ApplianceClinic family.</p>';
    return '<ul class="si-fam">' + rows.map(function (f) {
      return '<li><span>' + esc(f.name) + '</span><span>' + esc(f.count) + '</span></li>';
    }).join('') + '</ul>';
  }

  function historyHtml(runs) {
    if (!runs || !runs.length) return '<p class="si-note">No ingest history is stored yet.</p>';
    return '<div class="si-hist" role="table" aria-label="Ingest history">'
      + '<div class="si-hist__head" role="row">'
      + '<span role="columnheader">When</span><span role="columnheader">Trigger</span>'
      + '<span role="columnheader">Status</span><span role="columnheader">Fetched</span>'
      + '<span role="columnheader">Published</span><span role="columnheader">Duration</span>'
      + '</div>'
      + runs.map(function (r) {
        return '<div class="si-hist__row" role="row">'
          + '<span role="cell">' + esc(fmtWhen(r.completedAt || r.startedAt)) + '</span>'
          + '<span role="cell">' + esc(r.trigger || '—') + '</span>'
          + '<span role="cell">' + esc(r.status || '—') + (r.reconstructed ? ' · reconstructed' : '') + '</span>'
          + '<span role="cell">' + esc(countOrDash(r.fetched != null ? r.fetched : r.candidates)) + '</span>'
          + '<span role="cell">' + esc(countOrDash(r.livePublished != null ? r.livePublished : r.publishedThisRun)) + '</span>'
          + '<span role="cell">' + esc(duration(r.durationMs)) + '</span>'
          + '</div>';
      }).join('')
      + '</div>';
  }

  function matchingHtml(policy) {
    return '<ul class="si-match">' + (policy || []).map(function (line) {
      return '<li>' + esc(line) + '</li>';
    }).join('') + '</ul>';
  }

  function technicalHtml(tech) {
    tech = tech || {};
    return '<dl class="si-dl">'
      + '<div><dt>Store</dt><dd>' + esc(tech.store) + '</dd></div>'
      + '<div><dt>HTML publication</dt><dd>' + esc(tech.htmlPublication) + '</dd></div>'
      + '<div><dt>Lock TTL</dt><dd>' + esc(tech.lockTtlSeconds) + ' seconds</dd></div>'
      + '<div><dt>Daily window</dt><dd>Last ' + esc(tech.dailyWindowDays) + ' days of OPSS updates</dd></div>'
      + '<div><dt>Fetch concurrency</dt><dd>' + esc(tech.concurrency) + '</dd></div>'
      + '<div><dt>Publication safety</dt><dd>' + esc(tech.htmlPublicationAtomicity) + '</dd></div>'
      + '</dl>';
  }

  function containsSecret(obj) {
    var seen = JSON.stringify(obj || {});
    return /"apiKey"|"password"|"secretAccessKey"|"authorization"/i.test(seen)
      || /sk-[A-Za-z0-9]{10,}/.test(seen)
      || /AKIA[0-9A-Z]{16}/.test(seen)
      || /MCP_BEARER|ORCHESTRATOR_TOKEN/.test(seen);
  }

  function runBusyLabel(status) {
    if (status && status.code === 'running') return 'Ingest running';
    return 'Run ingest';
  }

  return {
    esc: esc,
    statusClass: statusClass,
    confirmCopy: confirmCopy,
    fmtWhen: fmtWhen,
    relativeAgo: relativeAgo,
    duration: duration,
    countOrDash: countOrDash,
    sourceHtml: sourceHtml,
    pipelineHtml: pipelineHtml,
    rejectionHtml: rejectionHtml,
    familyHtml: familyHtml,
    historyHtml: historyHtml,
    matchingHtml: matchingHtml,
    technicalHtml: technicalHtml,
    containsSecret: containsSecret,
    runBusyLabel: runBusyLabel,
  };
});
