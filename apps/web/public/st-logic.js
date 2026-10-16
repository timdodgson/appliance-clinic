'use strict';
/**
 * ApplianceClinic Settings — view helpers. No network. No secrets.
 */
(/** @param {any} root @param {() => any} factory */ function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.St = api;
})(typeof window !== 'undefined' ? window : typeof global !== 'undefined' ? global : this, function () {
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function syncClass(status) {
    if (status === 'in_sync') return 'st-sync--ok';
    if (status === 'mismatch') return 'st-sync--warn';
    return 'st-sync--unknown';
  }

  function credentialLabel(configured) {
    return configured ? 'Credential configured' : 'Credential missing';
  }

  function confirmCopy() {
    return 'This changes the model that writes every new ApplianceClinic diagnosis reply. In-flight conversations keep the model they already loaded. Continue?';
  }

  /** The advisor card: configured vs running, the credential, and the sync status. Never a key. */
  function advisorCardHtml(adv) {
    adv = adv || {};
    var configured = adv.configured || {};
    var running = adv.running || { available: false };
    var sync = adv.sync || { status: 'unverifiable', label: 'Running value not currently verifiable' };
    var cred = adv.credential || {};
    var runningLine = running.available
      ? esc(running.providerLabel || running.provider) + ' — ' + esc(running.modelLabel || running.model)
      : esc(running.reason || 'Running value not currently verifiable');
    return (
      '<article class="st-card" data-stage="advisor">'
      + '<h3 class="st-card__title">Advisor</h3>'
      + '<p class="st-card__purpose">Writes every customer reply (Claude, with the error-code and parts tools) inside the deterministic guardrail kernel.</p>'
      + '<dl class="st-dl">'
      + '<div><dt>Configured</dt><dd class="st-id">' + esc(configured.providerLabel) + ' — ' + esc(configured.modelLabel || configured.model || 'Model not set') + '</dd></div>'
      + '<div><dt>Running</dt><dd class="st-id">' + runningLine + '</dd></div>'
      + '<div><dt>Credential</dt><dd>' + esc(credentialLabel(cred.configured != null ? cred.configured : configured.credentialConfigured)) + '</dd></div>'
      + '<div><dt>Source</dt><dd>' + esc(adv.source || 'Admin runtime configuration') + '</dd></div>'
      + '<div><dt>Status</dt><dd><span class="st-sync ' + syncClass(sync.status) + '">' + esc(sync.label) + '</span></dd></div>'
      + '</dl>'
      + (!configured.model ? '<p class="st-warn" role="note">No model is set: the advisor cannot answer until one is saved.</p>' : '')
      + '</article>'
    );
  }

  function readOnlyRowHtml(title, value, source, extra) {
    extra = extra || '';
    return (
      '<div class="st-row">'
      + '<div class="st-row__copy"><h3 class="st-row__title">' + esc(title) + '</h3>'
      + '<p class="st-id">' + esc(value) + '</p>'
      + (extra ? '<p class="st-row__note">' + esc(extra) + '</p>' : '')
      + '</div>'
      + '<p class="st-row__meta">Read only · ' + esc(source) + '</p>'
      + '</div>'
    );
  }

  function elsewhereHtml(items) {
    return (items || []).map(function (item) {
      return '<li><a href="' + esc(item.href) + '">' + esc(item.title) + '</a> — ' + esc(item.note) + '</li>';
    }).join('');
  }

  function technicalHtml(tech) {
    tech = tech || {};
    return '<dl class="st-dl">'
      + '<div><dt>Advisor configuration cache</dt><dd>' + esc(tech.diagnosticCacheTtlSeconds) + ' seconds</dd></div>'
      + '<div><dt>Media overlay cache</dt><dd>' + esc(tech.mediaOverlayCacheTtlSeconds) + ' seconds · managed in Media</dd></div>'
      + '<div><dt>Error-code overlay cache</dt><dd>' + esc(tech.errorCodeOverlayCacheTtlSeconds) + ' seconds · managed in Error Codes</dd></div>'
      + '<div><dt>Conversation window</dt><dd>' + esc(tech.conversationWindowTurns) + ' turns · shipped configuration</dd></div>'
      + '<div><dt>Configuration store</dt><dd>' + esc(tech.configurationStore) + '</dd></div>'
      + '<div><dt>Cold start</dt><dd>' + esc(tech.coldStart) + '</dd></div>'
      + '<div><dt>If the store is unavailable</dt><dd>' + esc(tech.lastGood) + '</dd></div>'
      + '</dl>';
  }

  function metaLine(adv) {
    adv = adv || {};
    var versionBit = ' · version ' + (adv.version || 1);
    if (adv.updatedAt) {
      var when;
      try { when = new Date(adv.updatedAt).toLocaleString('en-GB'); } catch (e) { when = adv.updatedAt; }
      return 'Last changed ' + when + (adv.updatedByEmail ? ' by ' + adv.updatedByEmail : '') + versionBit;
    }
    if (adv.store && adv.store.status === 'ok') {
      return 'Saved admin configuration is in use' + versionBit + '. No change history is stored yet.';
    }
    return 'No saved configuration yet.';
  }

  function containsSecret(obj) {
    var seen = JSON.stringify(obj || {});
    return /"apiKey"|"anthropicApiKey"|"apiToken"|"password"|"secretAccessKey"|"authorization"/i.test(seen)
      || /sk-[A-Za-z0-9_-]{10,}/.test(seen)
      || /AKIA[0-9A-Z]{16}/.test(seen);
  }

  function impactChip(impact) {
    var labels = { high: 'High impact — changes live diagnosis', none: 'No runtime effect', readonly: 'Read only' };
    return '<span class="st-impact st-impact--' + esc(impact || 'none') + '">' + esc(labels[impact] || impact || '') + '</span>';
  }
  function runtimeStatusHtml(rs) {
    rs = rs || {};
    var arch = rs.architecture === 'ac2' ? 'ac2 · the advisor inside the deterministic guardrail kernel' : 'Not reported';
    return readOnlyRowHtml('Diagnosis architecture', arch, 'Fixed in code (ADR 0023)', rs.architectureNote || '');
  }
  // Client-side preview of what Apply will change (the server recomputes and is authoritative).
  function reviewChanges(adv, proposed) {
    adv = adv || {};
    var cur = (adv.configured && adv.configured.model) || '';
    var next = proposed && proposed.model != null ? String(proposed.model).trim() : cur;
    if (cur === next) return [];
    return [{ field: 'model', label: 'Advisor model', from: cur || 'Not set', to: next || 'Not set', live: true,
      impact: 'This model writes every new live customer reply. The credential stays as stored.' }];
  }
  function reviewHtml(changes, propagationNote) {
    if (!changes.length) return '<p>No changes to apply. Nothing will be written.</p>';
    return '<ul class="st-review">' + changes.map(function (c) {
      return '<li><b>' + esc(c.label) + '</b>: <span class="st-id">' + esc(c.from) + '</span> → <span class="st-id">' + esc(c.to) + '</span>'
        + (c.live ? ' ' + impactChip('high') : '') + '<br><span class="st-review__impact">' + esc(c.impact) + '</span></li>';
    }).join('') + '</ul>'
      + '<p class="st-review__when"><b>Takes effect:</b> ' + esc(propagationNote || 'Within about 2 minutes on each running diagnosis engine instance.') + '</p>'
      + '<p class="st-review__live">' + esc(confirmCopy()) + '</p>';
  }
  function historyHtml(history, emptyText) {
    if (!history || !history.length) return '<p class="st-note">' + esc(emptyText || 'No changes have been recorded through Settings yet.') + '</p>';
    return '<ol class="st-hist">' + history.map(function (h) {
      var when;
      try { when = h.at ? new Date(h.at).toLocaleString('en-GB') : '—'; } catch (e) { when = h.at; }
      var changes = (h.changes || []).map(function (c) {
        return '<li>' + esc(c.label || c.field) + ': <span class="st-id">' + esc(c.from === '' || c.from == null ? '(blank)' : String(c.from)) + '</span> → <span class="st-id">' + esc(c.to === '' || c.to == null ? '(blank)' : String(c.to)) + '</span></li>';
      });
      if (h.replaced != null && !h.changes) changes.push('<li>' + (h.replaced ? 'Credential replaced' : 'Credential added') + ' (value never stored in history)</li>');
      return '<li class="st-hist__item"><p class="st-hist__meta"><b>' + esc(when) + '</b>' + (h.byEmail ? ' · ' + esc(h.byEmail) : '') + (h.version ? ' · v' + esc(String(h.version)) : '') + '</p>'
        + (changes.length ? '<ul class="st-hist__changes">' + changes.join('') + '</ul>' : '')
        + (h.note ? '<p class="st-hist__note">Reason: ' + esc(h.note) + '</p>' : '')
        + '</li>';
    }).join('') + '</ol>';
  }
  function errorText(res, fallback) {
    var b = (res && res.body) || {};
    if (res && res.status === 409) return b.error || 'Settings changed since you opened this page. Reload to review the current values.';
    var msg = b.error || fallback || 'Not applied.';
    if (b.details && b.details.length) msg += ' (' + b.details.join(' ') + ')';
    return msg;
  }

  return {
    impactChip: impactChip,
    runtimeStatusHtml: runtimeStatusHtml,
    reviewChanges: reviewChanges,
    reviewHtml: reviewHtml,
    historyHtml: historyHtml,
    errorText: errorText,
    esc: esc,
    syncClass: syncClass,
    credentialLabel: credentialLabel,
    confirmCopy: confirmCopy,
    advisorCardHtml: advisorCardHtml,
    readOnlyRowHtml: readOnlyRowHtml,
    elsewhereHtml: elsewhereHtml,
    technicalHtml: technicalHtml,
    metaLine: metaLine,
    containsSecret: containsSecret,
  };
});
