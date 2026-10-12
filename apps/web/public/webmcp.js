/* ApplianceClinic WebMCP integration (applianceclinic.ai).
 *
 * WebMCP (Web Model Context Protocol) is a W3C Web ML Community Group DRAFT that lets a page expose
 * typed tools to in-browser AI agents. As of 2026 it is an origin-trial-only Chromium feature
 * (Chrome/Edge, trial ~Chrome 149–156, ending 2026-11-17); it is not on by default and is absent in
 * Firefox/Safari. Current surface: document.modelContext.registerTool(...). Official sources:
 *   - https://webmachinelearning.github.io/webmcp/
 *   - https://developer.chrome.com/docs/ai/webmcp/imperative-api
 *   - https://developer.chrome.com/blog/ai-webmcp-origin-trial
 *
 * ARCHITECTURE RULE (identical to the apps/web spike): WebMCP is an ADDITIONAL typed interface to the
 * SAME ApplianceClinic conversation — never a parallel diagnostic engine and never a bypass of the
 * safety or conversation-state rules. Both tools map onto existing on-screen customer actions and go
 * through the SAME /api BFF, the SAME engine (Jev + deterministic router + safety stops + RAG/COMPOSE)
 * and the SAME session (observability.sessionId) as the visible chat. The reply renders in the same
 * conversation. No second endpoint, no candidate scores, no part override, no hidden state.
 *
 * Purely additive + feature-detected: on a browser without WebMCP this is a complete no-op and the
 * normal ApplianceClinic chat is unaffected (progressive enhancement).
 *
 * Works in the browser (window.ACWebMCP) and in Node tests (module.exports).
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.ACWebMCP = api;
})(typeof window !== 'undefined' ? window : typeof global !== 'undefined' ? global : this, function () {
  'use strict';

  // Feature-detect the model-context interface. Primary surface is document.modelContext (current
  // spec); navigator.modelContext is tolerated only as a defensive fallback for older trial builds.
  function getModelContext(doc, nav) {
    var d = doc || (typeof document !== 'undefined' ? document : null);
    var n = nav || (typeof navigator !== 'undefined' ? navigator : null);
    var mc = (d && d.modelContext) || (n && n.modelContext) || null;
    if (mc && typeof mc.registerTool === 'function') return mc;
    return null;
  }

  function isWebMcpSupported(doc, nav) {
    return getModelContext(doc, nav) !== null;
  }

  // Does a BFF `view` represent an active, STRUCTURED stop-use? Typed fields only — NEVER the reply
  // wording. `view.safety` is the engine's hard safety-stop flag (gas / shock / burning); a
  // PROFESSIONAL_ONLY safetyInformation classification is also a structured stop boundary.
  // (Microwave cavity ARCING is delivered by the engine as a normal answer whose reply TEXT leads
  // with the stop-use; it does not currently set view.safety, so the structured flag reflects the
  // hard stops — the stop-use GUIDANCE is still delivered verbatim in the reply either way.)
  function viewSafetyStop(view) {
    if (!view || typeof view !== 'object') return false;
    if (view.safety === true) return true;
    var cls = view.safetyInformation && view.safetyInformation.classification;
    if (typeof cls === 'string' && /PROFESSIONAL_ONLY|STOP_USE|DANGER/i.test(cls)) return true;
    return false;
  }

  // Project the compact, customer-visible state from the on-screen conversation. Pure. Reads only
  // what the customer can already see: the resolved identity pills (view.understood), the latest
  // reply, the shown parts, needs-model, and the structured safety flag. No debug/scores/secrets.
  function projectState(input) {
    input = input || {};
    var messages = Array.isArray(input.messages) ? input.messages : [];
    var view = input.lastView || null;
    var u = (view && view.understood) || {};
    var hasUser = messages.some(function (m) { return m && m.role === 'user'; });
    var lastAssistant = null;
    for (var i = messages.length - 1; i >= 0; i--) {
      if (messages[i] && messages[i].role === 'assistant') { lastAssistant = messages[i]; break; }
    }
    var busy = Boolean(input.busy);
    var status = !hasUser ? 'idle' : (busy ? 'awaiting_reply' : 'ready');
    return {
      applianceFamily: (u && u.appliance) || null,
      make: (u && u.make) || null,
      model: (view && view.extractedModel) || null,
      code: (u && u.displayedCode) || null,
      fault: (view && view.diagnosis && view.diagnosis.label) || null,
      status: status,
      latestReply: (view && view.reply) || (lastAssistant && lastAssistant.content) || '',
      safetyStopActive: viewSafetyStop(view),
      safetyClassification:
        (view && view.safetyInformation && view.safetyInformation.classification)
        || (view && view.safety === true ? 'STOP_USE' : null),
      needsModel: Boolean(view && view.needsModel),
      partsShown: (view && Array.isArray(view.parts) && view.parts.length) || 0,
      messageCount: messages.length,
    };
  }

  // Appliance families ApplianceClinic understands (mirrors services/whichpart-api/recalls/families.js
  // and the Help Hub slugs). Used to normalise a caller-supplied family term and to scope recall
  // lookups / appliance-information to the SAME families the app already uses.
  var FAMILIES = [
    { id: 'washing machine', slug: 'washing-machines', name: 'Washing machines' },
    { id: 'washer-dryer', slug: 'washer-dryers', name: 'Washer dryers' },
    { id: 'tumble-dryer', slug: 'tumble-dryers', name: 'Tumble dryers' },
    { id: 'dishwasher', slug: 'dishwashers', name: 'Dishwashers' },
    { id: 'fridge-freezer', slug: 'fridge-freezers', name: 'Fridge-freezers' },
    { id: 'oven-cooker', slug: 'ovens-cookers', name: 'Ovens and cookers' },
    { id: 'hobs', slug: 'hobs', name: 'Hobs' },
    { id: 'microwave', slug: 'microwaves', name: 'Microwaves' },
    { id: 'vacuum', slug: 'vacuum-cleaners', name: 'Vacuum cleaners' },
  ];
  var FAMILY_SLUGS = FAMILIES.map(function (f) { return f.slug; });

  // Normalise a caller-supplied family term (slug / id / display name / loose word) to a family
  // entry, or null if unrecognised. Structural matching only — no customer-prose interpretation.
  function normalizeFamily(term) {
    if (!term) return null;
    var t = String(term).trim().toLowerCase();
    if (!t) return null;
    for (var i = 0; i < FAMILIES.length; i++) {
      var f = FAMILIES[i];
      if (t === f.slug || t === f.id || t === f.name.toLowerCase()) return f;
    }
    // loose contains (e.g. "washing machine", "fridge", "oven", "cooker", "vacuum")
    for (var j = 0; j < FAMILIES.length; j++) {
      var g = FAMILIES[j];
      var base = g.id.replace(/[-\s].*$/, ''); // 'washing', 'washer', 'tumble', 'dishwasher'...
      if (t.indexOf(g.id) > -1 || t.indexOf(g.slug.replace(/-/g, ' ')) > -1 || (base.length > 3 && t.indexOf(base) > -1)) return g;
    }
    if (/cooker|oven/.test(t)) return FAMILIES[5];
    if (/fridge|freezer/.test(t)) return FAMILIES[4];
    if (/vacuum|hoover/.test(t)) return FAMILIES[8];
    return null;
  }

  // Build the recall-lookup query string from the caller's identification (make + model). Pure.
  function recallQuery(args) {
    args = args || {};
    var parts = [];
    if (args.make) parts.push(String(args.make).trim());
    if (args.model) parts.push(String(args.model).trim());
    return parts.join(' ').trim();
  }

  // Shape the /api/recalls/lookup response into a compact, customer-facing result. Pure. Returns the
  // SAME customer-visible recall fields the Recall Centre shows; no internal/debug fields.
  function formatRecallResult(apiJson, args, originBase) {
    apiJson = apiJson || {};
    var items = Array.isArray(apiJson.items) ? apiJson.items : [];
    var base = originBase || '';
    var recalls = items.slice(0, 10).map(function (r) {
      return {
        title: r.title || null,
        brand: r.brand || null,
        product: r.productName || null,
        models: r.modelText || (Array.isArray(r.models) ? r.models.join(', ') : null) || null,
        batch: r.batchText || null,
        riskLevel: r.riskLevel || null,
        dateIssued: r.alertDate || null,
        moreInfo: r.url ? (base + r.url) : null,
      };
    });
    var count = typeof apiJson.count === 'number' ? apiJson.count : recalls.length;
    return {
      query: { make: (args && args.make) || null, model: (args && args.model) || null, applianceFamily: (args && args.applianceFamily) || null },
      found: count > 0,
      count: count,
      recalls: recalls,
      attribution: apiJson.attribution || 'UK Office for Product Safety and Standards via GOV.UK (Open Government Licence v3.0).',
      message: count > 0
        ? (count + ' published safety notice(s) matched these details. Check the model and batch/serial carefully against each notice.')
        : 'No published safety recall matched these details on ApplianceClinic. This is not a guarantee that none exists — check the exact model and batch on the manufacturer or GOV.UK site.',
    };
  }

  // Shape the appliance-info.json family record into a compact, customer-facing result. Pure.
  function formatApplianceInfo(infoJson, args, originBase) {
    infoJson = infoJson || {};
    var fams = Array.isArray(infoJson.families) ? infoJson.families : [];
    var fam = normalizeFamily(args && args.applianceFamily);
    var base = originBase || '';
    if (!fam) {
      return {
        found: false,
        message: 'Unknown appliance family. Supported families: ' + FAMILY_SLUGS.join(', ') + '.',
        supportedFamilies: FAMILY_SLUGS.slice(),
      };
    }
    var rec = null;
    for (var i = 0; i < fams.length; i++) { if (fams[i] && fams[i].family === fam.slug) { rec = fams[i]; break; } }
    if (!rec) {
      return { found: false, message: 'No appliance information available for ' + fam.name + ' right now.', family: fam.slug };
    }
    return {
      found: true,
      family: fam.slug,
      name: rec.name || fam.name,
      make: (args && args.make) || null,
      model: (args && args.model) || null,
      summary: rec.summary || '',
      about: rec.about || '',
      commonProblems: rec.commonProblems || [],
      safeChecks: rec.safeChecks || [],
      safetyNotes: rec.safetyNotes || [],
      findingYourModel: rec.findingYourModel || null,
      helpHubUrl: rec.hubUrl ? (base + rec.hubUrl) : null,
      note: 'General, family-level ApplianceClinic guidance. For a specific fault on your exact '
        + 'appliance, use submit_customer_message to run the diagnosis.',
      attribution: infoJson.attribution || 'ApplianceClinic Help Hub.',
    };
  }

  // Build the WhichPart tool descriptors from a bridge. Pure data + closures over the bridge; all
  // network/engine access lives in the bridge (supplied by the host page).
  function buildTools(bridge) {
    var getState = {
      name: 'get_whichpart_state',
      description:
        'Read the current state of the ApplianceClinic appliance-diagnosis chat the customer is ' +
        'viewing: appliance family, make/model if known, any displayed code, the current fault, ' +
        'whether a reply is awaited, the latest reply text, whether use has been stopped for safety, ' +
        'and how many recommended parts are shown. Read-only; returns only what the customer can ' +
        'already see. No internal scores, prompts, reasoning, or debug data.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: true, consequentialHint: false, untrustedContentHint: true },
      execute: function () { return JSON.stringify(bridge.getState()); },
    };

    var submitMessage = {
      name: 'submit_customer_message',
      description:
        'Send a message to ApplianceClinic exactly as if the customer typed it into the chat. It ' +
        'goes through the same diagnosis engine, the same safety checks, and the same single ' +
        'on-screen conversation and session; the reply appears in that conversation. Use it to ' +
        'describe an appliance problem or answer ApplianceClinic\u2019s question (e.g. give the make ' +
        'and model). Returns the reply text. It cannot override the diagnosis, choose parts, or ' +
        'bypass any safety stop.',
      inputSchema: {
        type: 'object',
        properties: {
          message: {
            type: 'string',
            description: 'The customer message in natural language, e.g. "my Bosch dishwasher isn\'t drying".',
          },
        },
        required: ['message'],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, consequentialHint: false, untrustedContentHint: true },
      execute: function (args) {
        var message = args && typeof args.message === 'string' ? args.message.trim() : '';
        if (!message) {
          return Promise.reject(new Error("submit_customer_message requires a non-empty 'message' string."));
        }
        return Promise.resolve(bridge.submitMessage(message)).then(function (result) {
          result = result || {};
          var reply = result.reply || '';
          if (result.safetyStopActive) {
            return '[SAFETY: ApplianceClinic has advised stopping use of the appliance.]\n' + reply;
          }
          return reply;
        });
      },
    };

    var checkRecall = {
      name: 'check_appliance_recall',
      description:
        'Check whether a UK safety recall or safety notice has been published for an appliance. Use ' +
        'this when the customer asks if their appliance is recalled/safe, or before advising on an ' +
        'appliance that may be subject to a recall. Searches ApplianceClinic\u2019s Recall Centre ' +
        '(UK OPSS/GOV.UK data). Provide the make and/or model, optionally the appliance family. ' +
        'Returns matching published notices (brand, product, affected models, risk level, date, ' +
        'link) or a clear "no match" — a no-match is not a guarantee none exists.',
      inputSchema: {
        type: 'object',
        properties: {
          make: { type: 'string', description: 'Appliance brand/manufacturer, e.g. "Whirlpool", "Hotpoint".' },
          model: { type: 'string', description: 'Model number or product name if known.' },
          applianceFamily: { type: 'string', enum: FAMILY_SLUGS.slice(), description: 'Optional appliance family to narrow the search.' },
        },
        required: [],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, consequentialHint: false, untrustedContentHint: true },
      execute: function (args) {
        args = args || {};
        if (!args.make && !args.model && !args.applianceFamily) {
          return Promise.reject(new Error('check_appliance_recall needs at least a make, model, or applianceFamily.'));
        }
        return Promise.resolve(bridge.checkRecall(args)).then(function (result) { return JSON.stringify(result); });
      },
    };

    var applianceInfo = {
      name: 'get_appliance_information',
      description:
        'Get general, non-diagnostic information about an appliance family from ApplianceClinic\u2019s ' +
        'Help Hubs: what the appliance does, common problems, safe owner checks, safety notes, and ' +
        'how to find the model/rating plate. Use this for background or "how does this work / how do ' +
        'I look after it" questions. For a specific fault, use submit_customer_message instead. ' +
        'Returns customer-facing guidance only — no invented specifications or parts.',
      inputSchema: {
        type: 'object',
        properties: {
          applianceFamily: { type: 'string', enum: FAMILY_SLUGS.slice(), description: 'The appliance family, e.g. "washing-machines", "microwaves".' },
          make: { type: 'string', description: 'Optional brand, echoed back; the guidance is family-level.' },
          model: { type: 'string', description: 'Optional model, echoed back; the guidance is family-level.' },
        },
        required: ['applianceFamily'],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, consequentialHint: false, untrustedContentHint: true },
      execute: function (args) {
        args = args || {};
        if (!args.applianceFamily) {
          return Promise.reject(new Error('get_appliance_information requires an applianceFamily.'));
        }
        return Promise.resolve(bridge.getApplianceInformation(args)).then(function (result) { return JSON.stringify(result); });
      },
    };

    return [getState, submitMessage, checkRecall, applianceInfo];
  }

  // Register the tools if WebMCP is available. Additive and safe: returns { supported:false } and
  // does nothing on unsupported browsers; never throws; unregister() removes the tools via
  // AbortSignal (per the current spec).
  function registerWhichPartTools(bridge, options) {
    options = options || {};
    var mc;
    try {
      mc = options.modelContext !== undefined ? options.modelContext : getModelContext();
    } catch (e) { mc = null; }
    if (!mc) return { supported: false, unregister: function () {} };

    var controller = (typeof AbortController !== 'undefined') ? new AbortController() : null;
    var opts = controller ? { signal: controller.signal } : undefined;
    try {
      var tools = buildTools(bridge);
      for (var i = 0; i < tools.length; i++) {
        var r = mc.registerTool(tools[i], opts);
        if (r && typeof r.then === 'function') {
          r.catch(function (err) { try { console.warn('[webmcp] registerTool failed', err); } catch (e) {} });
        }
      }
    } catch (e2) {
      try { console.warn('[webmcp] registration failed; continuing without WebMCP', e2); } catch (e3) {}
      return { supported: false, unregister: function () { if (controller) controller.abort(); } };
    }

    var done = false;
    return {
      supported: true,
      unregister: function () {
        if (done) return;
        done = true;
        try { if (controller) controller.abort(); } catch (e) {}
      },
    };
  }

  return {
    getModelContext: getModelContext,
    isWebMcpSupported: isWebMcpSupported,
    viewSafetyStop: viewSafetyStop,
    projectState: projectState,
    FAMILIES: FAMILIES,
    FAMILY_SLUGS: FAMILY_SLUGS,
    normalizeFamily: normalizeFamily,
    recallQuery: recallQuery,
    formatRecallResult: formatRecallResult,
    formatApplianceInfo: formatApplianceInfo,
    buildTools: buildTools,
    registerWhichPartTools: registerWhichPartTools,
  };
});
