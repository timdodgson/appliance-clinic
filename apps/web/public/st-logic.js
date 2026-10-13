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

  function credentialLabel(state) {
    if (state === 'configured') return 'Credential configured';
    if (state === 'missing') return 'Credential missing';
    return 'Credential not reported';
  }

  function confirmCopy() {
    return 'This changes the model used for new ApplianceClinic diagnoses. In-flight conversations keep their current providers. Continue?';
  }

  function inferenceCardHtml(stage) {
    var sync = (stage && stage.sync) || { status: 'unverifiable', label: 'Running value not currently verifiable' };
    var configured = (stage && stage.configured) || {};
    var running = (stage && stage.running) || { available: false };
    var runningLine = running.available
      ? esc(running.providerLabel) + ' — ' + esc(running.modelLabel)
      : 'Running value not currently verifiable';
    return (
      '<article class="st-card" data-stage="' + esc(stage && stage.id) + '">'
      + '<h3 class="st-card__title">' + esc(stage && stage.label) + '</h3>'
      + '<p class="st-card__purpose">' + esc(stage && stage.purpose) + '</p>'
      + '<dl class="st-dl">'
      + '<div><dt>Configured</dt><dd class="st-id">' + esc(configured.providerLabel) + ' — ' + esc(configured.modelLabel) + '</dd></div>'
      + '<div><dt>Running</dt><dd class="st-id">' + runningLine + '</dd></div>'
      + '<div><dt>Source</dt><dd>' + esc(stage && stage.source) + '</dd></div>'
      + '<div><dt>Editable</dt><dd>' + esc((stage && stage.editableLabel) || (stage && stage.editable === false ? 'No' : 'Yes — here')) + '</dd></div>'
      + '<div><dt>Status</dt><dd><span class="st-sync ' + syncClass(sync.status) + '">' + esc(sync.label) + '</span></dd></div>'
      + '</dl>'
      + (configured.warning ? '<p class="st-warn" role="note">' + esc(configured.warning) + '</p>' : '')
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
      + '<div><dt>Diagnostic inference cache</dt><dd>' + esc(tech.diagnosticCacheTtlSeconds) + ' seconds</dd></div>'
      + '<div><dt>Media overlay cache</dt><dd>' + esc(tech.mediaOverlayCacheTtlSeconds) + ' seconds · managed in Media</dd></div>'
      + '<div><dt>Error-code overlay cache</dt><dd>' + esc(tech.errorCodeOverlayCacheTtlSeconds) + ' seconds · managed in Error Codes</dd></div>'
      + '<div><dt>Conversation window</dt><dd>' + esc(tech.conversationWindowTurns) + ' turns · shipped configuration</dd></div>'
      + '<div><dt>Configuration store</dt><dd>' + esc(tech.configurationStore) + '</dd></div>'
      + '<div><dt>Cold start</dt><dd>' + esc(tech.coldStart) + '</dd></div>'
      + '<div><dt>If the store is unavailable</dt><dd>' + esc(tech.lastGood) + '</dd></div>'
      + '</dl>';
  }

  function metaLine(inf) {
    inf = inf || {};
    var versionBit = ' · version ' + (inf.version || 1);
    if (inf.updatedAt) {
      var when;
      try { when = new Date(inf.updatedAt).toLocaleString('en-GB'); } catch (e) { when = inf.updatedAt; }
      return 'Last changed ' + when + (inf.updatedByEmail ? ' by ' + inf.updatedByEmail : '') + versionBit;
    }
    if (inf.store && inf.store.status === 'ok') {
      return 'Saved admin configuration is in use' + versionBit + '. No change history is stored yet.';
    }
    return 'Not changed yet — using the deployed default setup.';
  }

  function containsSecret(obj) {
    var seen = JSON.stringify(obj || {});
    return /"apiKey"|"apiToken"|"password"|"secretAccessKey"|"authorization"/i.test(seen)
      || /sk-[A-Za-z0-9]{10,}/.test(seen)
      || /AKIA[0-9A-Z]{16}/.test(seen);
  }

  function jevSectionHtml(jev) {
    jev = jev || {};
    var running = jev.running || { available: false };
    var runningLine = running.available
      ? esc(running.providerLabel || running.provider) + ' — ' + esc(running.modelLabel || running.model)
      : 'Running value not currently verifiable';
    var sync = jev.sync || { status: 'unverifiable', label: 'Running value not currently verifiable' };
    var gateway = jev.gatewayId ? esc(jev.gatewayId) : 'Not set';
    return (
      '<article class="st-card" data-stage="jev">'
      + '<h3 class="st-card__title">Jev UNDERSTAND</h3>'
      + '<dl class="st-dl">'
      + '<div><dt>Provider</dt><dd>' + esc(jev.providerLabel || 'TypeSafe Jev via Cloudflare') + '</dd></div>'
      + '<div><dt>Model</dt><dd class="st-id">' + esc(jev.model || 'typesafe/jev') + '</dd></div>'
      + '<div><dt>Cloudflare Account ID</dt><dd class="st-id">' + (jev.accountId ? esc(jev.accountId) : 'Not set') + '</dd></div>'
      + '<div><dt>API credential</dt><dd>' + esc(credentialLabel(jev.credentialConfigured ? 'configured' : 'missing')) + '</dd></div>'
      + '<div><dt>Gateway ID</dt><dd class="st-id">' + gateway + '</dd></div>'
      + '<div><dt>Running</dt><dd class="st-id">' + runningLine + '</dd></div>'
      + '<div><dt>Status</dt><dd><span class="st-sync ' + syncClass(sync.status) + '">' + esc(sync.label) + '</span></dd></div>'
      + '</dl>'
      + '</article>'
    );
  }

  // ---- impact, inventory, review, history -------------------------------------------------------
  var IMPACT_LABELS = {
    high: 'High impact — changes live diagnosis',
    production: 'Production behaviour — conditional',
    none: 'No runtime effect',
    readonly: 'Read only',
  };
  function impactChip(impact) {
    return '<span class="st-impact st-impact--' + esc(impact || 'none') + '">' + esc(IMPACT_LABELS[impact] || impact || '') + '</span>';
  }
  function inventoryHtml(items) {
    if (!items || !items.length) return '<p class="st-note">No settings were reported.</p>';
    return '<ul class="st-inv">' + items.map(function (s) {
      return '<li class="st-inv__row' + (s.deprecated ? ' is-deprecated' : '') + '" data-setting="' + esc(s.id) + '">'
        + '<div class="st-inv__head"><h3 class="st-inv__title">' + esc(s.label) + '</h3>'
        + impactChip(s.impact) + (s.deprecated ? ' <span class="st-impact st-impact--none">Deprecated</span>' : '') + '</div>'
        + '<dl class="st-inv__dl">'
        + '<div><dt>Current</dt><dd class="st-id">' + esc(s.currentLabel != null ? s.currentLabel : s.current) + (s.differsFromDefault ? ' <span class="st-differs">Differs from default</span>' : '') + '</dd></div>'
        + '<div><dt>Default</dt><dd class="st-id">' + esc(s.defaultLabel != null ? s.defaultLabel : s.default) + '</dd></div>'
        + '<div><dt>Takes effect</dt><dd>' + esc(s.effect) + '</dd></div>'
        + '<div><dt>Used by</dt><dd>' + esc(s.consumer) + '</dd></div>'
        + '<div><dt>Edit</dt><dd>' + esc(s.editable ? (s.reasonRequired ? 'Advanced → review and apply (reason required)' : 'Advanced → review and apply') : 'Not editable here') + '</dd></div>'
        + '</dl>'
        + '<p class="st-inv__impact">' + esc(s.impactText) + '</p>'
        + (s.warning ? '<p class="st-warn" role="note">' + esc(s.warning) + '</p>' : '')
        + '</li>';
    }).join('') + '</ul>';
  }
  function runtimeStatusHtml(rs) {
    rs = rs || {};
    var arch = rs.architecture === 'ac2' ? 'ac2 · LLM-led turn inside the guardrail kernel' : 'Not reported';
    return readOnlyRowHtml('Diagnosis architecture', arch, 'Fixed in code (ADR 0020)', rs.architectureNote || '');
  }
  // Client-side preview of what Apply will change (the server recomputes and is authoritative).
  function reviewChanges(inf, proposed) {
    inf = inf || {};
    var cur = {
      route: (inf.compose && inf.compose.configured && inf.compose.configured.route) || 'local',
      localModel: (inf.local && inf.local.model) || '',
      frontierModel: (inf.frontier && inf.frontier.model) || '',
    };
    var next = {
      route: proposed.routing && proposed.routing.compose || cur.route,
      localModel: proposed.local && proposed.local.model != null ? proposed.local.model : cur.localModel,
      frontierModel: proposed.frontier && proposed.frontier.model != null ? proposed.frontier.model : cur.frontierModel,
    };
    var lbl = function (r) { return r === 'frontier' ? 'OpenAI' : 'Private AI'; };
    var out = [];
    if (cur.route !== next.route) out.push({ field: 'routing.compose', label: 'COMPOSE provider', from: lbl(cur.route), to: lbl(next.route), live: true,
      impact: 'This changes live AI routing for customer requests: every new diagnosis reply will be written by ' + lbl(next.route) + (next.route === 'frontier' ? ', which sends customer conversations to OpenAI.' : '.') });
    if (cur.localModel !== next.localModel) out.push({ field: 'local.model', label: 'Private AI model id', from: cur.localModel || 'Not pinned', to: next.localModel || 'Not pinned', live: next.route === 'local',
      impact: next.route === 'local' ? 'COMPOSE uses Private AI, so this model id is sent with every live customer reply.' : 'Stored only; no live effect while COMPOSE uses OpenAI.' });
    if (cur.frontierModel !== next.frontierModel) out.push({ field: 'frontier.model', label: 'OpenAI model', from: cur.frontierModel || 'Not set', to: next.frontierModel || 'Not set', live: next.route === 'frontier',
      impact: next.route === 'frontier' ? 'COMPOSE uses OpenAI, so this model writes every live customer reply.' : 'Stored only; no live effect while COMPOSE uses Private AI (also used by batch frontier experiments).' });
    if (proposed.local && proposed.local.endpoint) out.push({ field: 'local.endpoint', label: 'Private AI endpoint override', from: inf.local && inf.local.endpointOverrideSet ? 'Custom address' : 'Deployed default', to: 'New custom address', live: true,
      impact: 'Points Private AI COMPOSE at a different server for live customer replies.' });
    return out;
  }
  function reviewHtml(changes, propagationNote) {
    if (!changes.length) return '<p>No changes to apply. Nothing will be written.</p>';
    var live = changes.some(function (c) { return c.live; });
    return '<ul class="st-review">' + changes.map(function (c) {
      return '<li><b>' + esc(c.label) + '</b>: <span class="st-id">' + esc(c.from) + '</span> \u2192 <span class="st-id">' + esc(c.to) + '</span>'
        + (c.live ? ' ' + impactChip('high') : '') + '<br><span class="st-review__impact">' + esc(c.impact) + '</span></li>';
    }).join('') + '</ul>'
      + '<p class="st-review__when"><b>Takes effect:</b> ' + esc(propagationNote || 'Within about 2 minutes on each running Part Finder instance.') + '</p>'
      + (live ? '<p class="st-review__live">' + esc(confirmCopy()) + '</p>' : '');
  }
  function batchOverrideHtml(bo) {
    bo = bo || {};
    var r = function (x) { return x ? (x.composeLabel || x.compose) + (x.model ? ' / ' + x.model : '') : '\u2014'; };
    var when = bo.appliedAt || bo.acquiredAt;
    try { when = when ? new Date(when).toLocaleString('en-GB') : '\u2014'; } catch (e) { /* keep */ }
    var conflict = bo.blocked || bo.state === 'restore_failed';
    return '<p class="st-override__title">' + esc(conflict ? 'Batch restore conflict — live AI routing needs a decision in Test → Batch' : 'Temporary batch override active') + '</p>'
      + '<p>' + esc('Batch run ' + bo.runId + ' (requested by ' + (bo.requestedBy || 'unknown') + ') owns live AI routing since ' + when + '.') + '</p>'
      + '<dl class="st-dl st-dl--compact"><div><dt>Temporary (live now)</dt><dd class="st-id">' + esc(r(bo.temporary && bo.temporary.routing)) + '</dd></div>'
      + '<div><dt>Base (pre-run, restored when the run ends)</dt><dd class="st-id">' + esc(r(bo.preRun && bo.preRun.routing)) + '</dd></div></dl>'
      + '<p>' + esc(conflict
        ? 'The run could not safely restore the pre-run configuration. Diagnostic-inference changes are blocked until an admin resolves it in Test → Batch.'
        : 'The diagnostic-inference values on this page are temporary batch state, not a permanent setting. Apply is blocked until the run ends and the exact pre-run configuration is restored and verified.') + '</p>';
  }
  function historyHtml(history, emptyText) {
    if (!history || !history.length) return '<p class="st-note">' + esc(emptyText || 'No changes have been recorded through Settings yet.') + '</p>';
    return '<ol class="st-hist">' + history.map(function (h) {
      var when;
      try { when = h.at ? new Date(h.at).toLocaleString('en-GB') : '\u2014'; } catch (e) { when = h.at; }
      var changes = (h.changes || []).map(function (c) {
        return '<li>' + esc(c.label || c.field) + ': <span class="st-id">' + esc(c.from === '' ? '(blank)' : String(c.from)) + '</span> \u2192 <span class="st-id">' + esc(c.to === '' ? '(blank)' : String(c.to)) + '</span></li>';
      });
      if (h.accountId) changes.push('<li>Cloudflare Account ID: <span class="st-id">' + esc(h.accountId.from || '(none)') + '</span> \u2192 <span class="st-id">' + esc(h.accountId.to || '(none)') + '</span></li>');
      if (h.gatewayId) changes.push('<li>Gateway ID: <span class="st-id">' + esc(h.gatewayId.from || '(none)') + '</span> \u2192 <span class="st-id">' + esc(h.gatewayId.to || '(none)') + '</span></li>');
      if (h.tokenReplaced) changes.push('<li>API token replaced (value never stored in history)</li>');
      var ev = h.event === 'batch-override-start' ? 'Batch run ' + h.runId + ' — temporary routing applied'
        : (h.event === 'batch-override-restore' ? 'Batch run ' + h.runId + ' — exact pre-run configuration restored' : null);
      if (h.replaced != null && !h.changes) changes.push('<li>' + (h.replaced ? 'Credential replaced' : 'Credential added') + ' (value never stored in history)</li>');
      return '<li class="st-hist__item' + (ev ? ' st-hist__item--batch' : '') + '"><p class="st-hist__meta"><b>' + esc(when) + '</b>' + (h.byEmail ? ' · ' + esc(h.byEmail) : '') + (h.requestedBy ? ' (requested by ' + esc(h.requestedBy) + ')' : '') + (h.version ? ' · v' + esc(String(h.version)) : '') + '</p>'
        + (ev ? '<p class="st-hist__event">' + esc(ev) + '</p>' : '')
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
    inventoryHtml: inventoryHtml,
    runtimeStatusHtml: runtimeStatusHtml,
    reviewChanges: reviewChanges,
    reviewHtml: reviewHtml,
    historyHtml: historyHtml,
    batchOverrideHtml: batchOverrideHtml,
    errorText: errorText,
    esc: esc,
    syncClass: syncClass,
    credentialLabel: credentialLabel,
    confirmCopy: confirmCopy,
    inferenceCardHtml: inferenceCardHtml,
    readOnlyRowHtml: readOnlyRowHtml,
    elsewhereHtml: elsewhereHtml,
    technicalHtml: technicalHtml,
    metaLine: metaLine,
    containsSecret: containsSecret,
    jevSectionHtml: jevSectionHtml,
  };
});
