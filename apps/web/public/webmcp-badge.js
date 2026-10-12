/* ApplianceClinic WebMCP status badge — a small, unobtrusive live inspector.
 *
 * This is a UI CONVENIENCE only. The authoritative WebMCP interface remains document.modelContext.
 * The badge shows whether WebMCP is enabled and lists the tools the BROWSER actually sees, read
 * live from document.modelContext.getTools() (never hard-coded) and refreshed on the `toolchange`
 * event. On a browser without WebMCP it renders nothing (progressive enhancement) and the normal
 * ApplianceClinic UI is unaffected.
 *
 * Isolated: this module owns ONLY status display. Registration lives in webmcp.js + app.js.
 */
(function () {
  'use strict';

  function mc() {
    try {
      var W = window.ACWebMCP;
      if (W && typeof W.getModelContext === 'function') return W.getModelContext();
      var d = (typeof document !== 'undefined' ? document : null);
      var c = d && d.modelContext;
      return (c && typeof c.registerTool === 'function') ? c : null;
    } catch (e) { return null; }
  }

  function injectStyles() {
    if (document.getElementById('wm-badge-style')) return;
    var css =
      // Inline in the header cluster (top-right, near the nav / Log in). Subtle pill that matches the
      // topbar ghost controls — not a floating debug widget.
      '.wm-badge{position:relative;display:inline-flex;align-items:center;' +
      'font:600 13px/1.3 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;}' +
      '.wm-badge__pill{display:inline-flex;align-items:center;gap:7px;min-height:36px;padding:6px 12px;border-radius:999px;' +
      'background:#fff;color:#2a3b2e;border:1px solid #cdd8ce;cursor:pointer;white-space:nowrap;}' +
      '.wm-badge__pill:hover{background:#eef3ee;border-color:#b7c6b9;}' +
      '.wm-badge__dot{width:8px;height:8px;border-radius:50%;background:#1db954;box-shadow:0 0 0 3px rgba(29,185,84,.2);flex:0 0 auto;}' +
      '.wm-badge__label{font-weight:600;}' +
      '.wm-badge__sep{opacity:.5;}' +
      '.wm-badge__count{opacity:.7;font-weight:600;}' +
      // Fixed fallback for any page without a header slot (keeps it top-right, not a bottom widget).
      '.wm-badge--fixed{position:fixed;top:12px;right:12px;z-index:60;}' +
      '.wm-badge__panel{position:absolute;top:calc(100% + 8px);right:0;width:min(320px,86vw);max-height:60vh;overflow:auto;z-index:70;' +
      'background:#fff;color:#1f2937;border:1px solid #e5e7eb;border-radius:12px;box-shadow:0 12px 34px rgba(0,0,0,.18);padding:12px;display:none;' +
      'font-weight:400;}' +
      '.wm-badge--open .wm-badge__panel{display:block;}' +
      '.wm-badge__h{font-weight:700;font-size:12.5px;margin:0 0 2px;}' +
      '.wm-badge__sub{color:#6b7280;font-size:11px;margin:0 0 10px;}' +
      '.wm-tool{padding:8px 0;border-top:1px solid #f1f3f5;}' +
      '.wm-tool:first-of-type{border-top:0;}' +
      '.wm-tool__name{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;color:#111418;font-weight:600;}' +
      '.wm-tool__tag{display:inline-block;margin-left:6px;font-size:9.5px;font-weight:700;letter-spacing:.03em;text-transform:uppercase;' +
      'padding:1px 6px;border-radius:999px;vertical-align:middle;}' +
      '.wm-tool__tag--read{background:#e7f6ec;color:#0f7a37;}' +
      '.wm-tool__tag--action{background:#fff3e0;color:#b45309;}' +
      '.wm-tool__desc{color:#4b5563;font-size:11.5px;margin-top:3px;}' +
      // Mobile: stay unobtrusive next to the burger — show the dot + count only, hide the word label.
      '@media (max-width:720px){.wm-badge__label,.wm-badge__sep{display:none;}.wm-badge__pill{padding:6px 10px;min-height:34px;}}';
    var s = document.createElement('style');
    s.id = 'wm-badge-style';
    s.textContent = css;
    document.head.appendChild(s);
  }

  function parseAnnotations(tool) {
    var a = tool && tool.annotations;
    return a && typeof a === 'object' ? a : {};
  }

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function Badge() {
    this.root = el('div', 'wm-badge');
    this.root.setAttribute('aria-live', 'polite');
    this.pill = el('button', 'wm-badge__pill');
    this.pill.type = 'button';
    this.pill.setAttribute('aria-haspopup', 'true');
    this.pill.setAttribute('aria-expanded', 'false');
    this.pill.setAttribute('aria-label', 'WebMCP status');
    this.dot = el('span', 'wm-badge__dot');
    this.label = el('span', 'wm-badge__label', 'WebMCP');
    this.sep = el('span', 'wm-badge__sep', '\u00B7');
    this.count = el('span', 'wm-badge__count', '');
    this.pill.appendChild(this.dot);
    this.pill.appendChild(this.label);
    this.pill.appendChild(this.sep);
    this.pill.appendChild(this.count);
    this.panel = el('div', 'wm-badge__panel');
    this.panel.setAttribute('role', 'dialog');
    this.root.appendChild(this.pill);
    this.root.appendChild(this.panel);
    var self = this;
    this.pill.addEventListener('click', function (e) { e.stopPropagation(); self.toggle(); });
    document.addEventListener('click', function (e) {
      if (self.root.classList.contains('wm-badge--open') && !self.root.contains(e.target)) self.close();
    });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') self.close(); });
  }
  Badge.prototype.mount = function () {
    if (this.root.parentNode) return;
    var slot = document.getElementById('wmBadgeSlot');
    if (slot) {
      slot.appendChild(this.root);
    } else {
      // No header slot on this page — fall back to a fixed top-right pill (never a bottom widget).
      this.root.classList.add('wm-badge--fixed');
      document.body.appendChild(this.root);
    }
  };
  Badge.prototype.toggle = function () {
    var open = this.root.classList.toggle('wm-badge--open');
    this.pill.setAttribute('aria-expanded', open ? 'true' : 'false');
  };
  Badge.prototype.close = function () {
    this.root.classList.remove('wm-badge--open');
    this.pill.setAttribute('aria-expanded', 'false');
  };
  Badge.prototype.render = function (tools) {
    tools = tools || [];
    this.count.textContent = tools.length + (tools.length === 1 ? ' tool' : ' tools');
    this.panel.innerHTML = '';
    this.panel.appendChild(el('p', 'wm-badge__h', 'WebMCP enabled'));
    this.panel.appendChild(el('p', 'wm-badge__sub', tools.length + ' tool' + (tools.length === 1 ? '' : 's') + ' available to in-browser agents'));
    tools.forEach(function (t) {
      var row = el('div', 'wm-tool');
      var nameWrap = el('div');
      nameWrap.appendChild(el('span', 'wm-tool__name', t.name || '(unnamed)'));
      var ann = parseAnnotations(t);
      var readOnly = ann.readOnlyHint === true;
      nameWrap.appendChild(el('span', 'wm-tool__tag ' + (readOnly ? 'wm-tool__tag--read' : 'wm-tool__tag--action'), readOnly ? 'read-only' : 'action'));
      row.appendChild(nameWrap);
      if (t.description) row.appendChild(el('div', 'wm-tool__desc', t.description));
      this.panel.appendChild(row);
    }, this);
  };

  function start() {
    var context = mc();
    if (!context || typeof context.getTools !== 'function') return; // unsupported -> render nothing
    injectStyles();
    var badge = new Badge();

    function refresh() {
      try {
        var p = context.getTools();
        Promise.resolve(p).then(function (tools) {
          badge.render(Array.isArray(tools) ? tools : []);
          badge.mount();
        }).catch(function () { /* ignore; keep last render */ });
      } catch (e) { /* never break the page */ }
    }

    // Subscribe to live changes so the badge always reflects what the browser sees.
    try {
      if (context.addEventListener) context.addEventListener('toolchange', refresh);
    } catch (e) { /* older build without events */ }

    // Tools register during app init (possibly just after this runs); poll briefly until present,
    // then rely on toolchange. Driven entirely by the real getTools() list — never hard-coded.
    var tries = 0;
    (function poll() {
      try {
        Promise.resolve(context.getTools()).then(function (tools) {
          tools = Array.isArray(tools) ? tools : [];
          if (tools.length > 0 || tries >= 20) { badge.render(tools); badge.mount(); return; }
          tries++; setTimeout(poll, 150);
        }).catch(function () { if (tries++ < 20) setTimeout(poll, 150); });
      } catch (e) { /* unsupported mid-flight */ }
    })();

    refresh();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();
