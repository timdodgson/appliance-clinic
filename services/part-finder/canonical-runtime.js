'use strict';
/**
 * Canonical runtime — the part-finder side of a canonical turn (the ONLY place the Lambda touches canonical code).
 *
 *   understand mode   classify the latest message (mc/1, message-only Jev)  →  cs/1 merge (prior + mc/1)
 *                     →  journey routing (registry order; each family's ownership function makes ONE journey apply)
 *                     →  diagnostics → policy → part gate → NextAction (+ the request it issues, under control)
 *                     returned to the orchestrator as the transport result `canonical` (the BFF persists it)
 *   diagnose mode     when the transported journey has CONTROL: COMPOSE words the NextAction (wording only) and the
 *                     `done` payload is built from it; otherwise the legacy diagnose path runs unchanged
 *
 * Gates: the BFF block (mode=control + the allow-listed keys) AND the journey's kill switch env (registry `killEnv`)
 * must both allow a journey; anything else is trace-only (no request issued) and the legacy path answers.
 * Never throws to the caller: every failure is a degraded transport (legacy answers, nothing is persisted).
 *
 * The Lambda injects its I/O and legacy-COMPOSE helpers (createCanonicalRuntime(deps)); the canonical/ modules stay
 * pure. No layer downstream of mc/1 reads customer prose.
 */
const REGISTRY = require('./canonical/journey-registry.js');

const CSID_RE = /^cs_[A-Za-z0-9_-]{32}$/;
const PART_LOOKUP_MS = 6000;
// The message-only classification is awaited after the legacy UNDERSTAND finishes: longer under control (it decides
// the turn), short otherwise (trace only).
const CLASSIFIER_GRACE_MS = 3000;
const CLASSIFIER_CONTROL_GRACE_MS = 15000;
// Safety-stop NextAction target → the done.safetyStop category the orchestrator maps to a safety class.
const SAFETY_STOP_REASON = { gas_escape: 'gas', gas_smell: 'gas', electric_shock: 'shock', electrical_water: 'electrical',
  supply_trip: 'electrical', sparks_at_supply: 'electrical', burning: 'burning', smoke: 'burning',
  microwave_arcing: 'electrical', 'mw-arcing': 'electrical', 'oven-trip': 'electrical', exposed_live_wiring: 'electrical' };

/** Journey packs keyed by journey key (registry metadata + require paths). Routing order = registry order. */
const PACKS = Object.freeze(Object.fromEntries(REGISTRY.JOURNEYS.map((j) => [j.key, Object.freeze({
  ...j, pipeline: `./canonical/${j.module}`, compose: `./canonical/${j.compose}` })])));
const ROUTING_ORDER = REGISTRY.KEYS;

const err160 = (e) => String((e && e.message) || e).slice(0, 160);

// ---- transport ------------------------------------------------------------------------------------------------
/** The BFF's prior-state block (sent on understand). */
function isTransportBlock(b) {
  return Boolean(b && typeof b === 'object' && b.schema === 'cs/1'
    && (b.mode === 'shadow' || b.mode === 'control') && !('priorVersion' in b));
}
/** The merged result (returned by understand, forwarded to diagnose). */
function isTransportResult(t) {
  return Boolean(t && typeof t === 'object' && t.schema === 'cs/1' && !t.degraded
    && Number.isInteger(t.priorVersion) && Number.isInteger(t.version)
    && t.state && typeof t.state === 'object' && t.state.schemaVersion === 'cs/1');
}

/**
 * merge(prior, mc/1, {turn: version + 1}) once, in understand mode. `classification` is the mc/1 object, or null
 * when the classifier degraded — then nothing is merged and the version does not advance.
 */
function transportMerge(classification, block) {
  const sessionId = block && typeof block.sessionId === 'string' ? block.sessionId : null;
  const priorVersion = block && Number.isInteger(block.version) ? block.version : null;
  const mode = block && block.mode === 'control' ? 'control' : 'shadow';
  const envelope = (degraded, extra = {}) => ({
    schema: 'cs/1', mode, sessionId, priorVersion, version: priorVersion,
    state: null, classification: null, rulesFired: [], requestOutcome: null, degraded, ...extra,
  });
  try {
    if (!sessionId || !CSID_RE.test(sessionId) || priorVersion == null || priorVersion < 0) return envelope('prior_state_invalid');
    if (!classification || typeof classification !== 'object') return envelope('classification_degraded');
    // eslint-disable-next-line global-require
    const cs1 = require('./canonical/cs1.js');
    // eslint-disable-next-line global-require
    const { merge } = require('./canonical/merge.js');
    let prior;
    if (priorVersion === 0 && block.state == null) prior = cs1.emptyState(sessionId);
    else {
      const s = block.state;
      if (!s || typeof s !== 'object' || s.schemaVersion !== cs1.SCHEMA_VERSION || s.version !== priorVersion || s.sessionId !== sessionId) {
        return envelope('prior_state_invalid');
      }
      prior = JSON.parse(JSON.stringify(s));
    }
    const mc1 = JSON.parse(JSON.stringify(classification));
    const { state, trace } = merge(prior, mc1, { turn: priorVersion + 1 });
    return {
      schema: cs1.SCHEMA_VERSION, mode, sessionId, priorVersion, version: state.version,
      state, classification: mc1, rulesFired: trace.rules, requestOutcome: trace.requestOutcome || null, degraded: null,
      ...(typeof block.clientTurnId === 'string' ? { clientTurnId: block.clientTurnId } : {}),
    };
  } catch (e) {
    return envelope('merge_failed', { error: err160(e) });
  }
}

// ---- gates ----------------------------------------------------------------------------------------------------
/** Control for `key`: the BFF block is control AND allow-lists the key AND the journey's kill switch is not '0'. */
function controlRequested(block, key, env = process.env) {
  const pack = PACKS[key];
  return Boolean(pack && block && block.mode === 'control' && block.control && Array.isArray(block.control.journeys)
    && block.control.journeys.includes(key) && env[pack.killEnv] !== '0');
}
const anyControlRequested = (block, env = process.env) => ROUTING_ORDER.some((k) => controlRequested(block, k, env));
/** The message-only classifier kill switch: CANONICAL_MC1_QUESTIONS=0 → no classification → every turn legacy. */
const classifierEnabled = (env = process.env) => String(env.CANONICAL_MC1_QUESTIONS == null ? '1' : env.CANONICAL_MC1_QUESTIONS) !== '0';

/** Compact classifier observability (no classification body). */
function classifierSummary(meta) {
  const m = meta || { degraded: true };
  return {
    source: m.source || 'mc1-questions', degraded: Boolean(m.degraded), reason: m.reason || null,
    recallGap: m.recallGap || null, questionCount: m.questionCount || 0, jevMs: m.jev ? m.jev.latencyMs : (m.jevMs || null),
  };
}

const compactPartLookup = (pl) => (pl ? { available: pl.available, component: pl.component, reason: pl.reason || null,
  parts: (pl.parts || []).map((p) => ({ partNo: p.partNo || null, title: p.title || null, partId: p.partId || null,
    price: p.price == null ? null : p.price, link: p.link || null, image: p.image || null })) } : null);
const journeyOf = (canonical) => (canonical && canonical.journey) || null;

/**
 * createCanonicalRuntime(deps)
 *   errorCodes()            the catalogue error-code tables
 *   getPartsForModel(model) the confirmed model's catalogue part list
 *   matchesComponent(title, term)   catalogue alias matcher (Journey 1's typed part terms)
 *   conversationProgress, loadAdminInference   latest message / prior advisor text, Jev credentials
 *   compose: { getProvider, lm: {temperature, repeatPenalty, timeoutMs}, filters: [fn], constrainReplacementLanguage, outputTripwire }
 *   media:   { ensureMediaOverlay, getEffectiveMediaJoin, selectMedia, previouslyShownMedia }
 *   COMPONENT_MENTION
 */
function createCanonicalRuntime(deps) {
  /** The confirmed model's catalogue part list (typed; bounded wait). */
  async function modelParts(model, lookupFn = deps.getPartsForModel) {
    let timer;
    try {
      const timeout = new Promise((resolve) => { timer = setTimeout(() => resolve({ parts: [], timedOut: true }), PART_LOOKUP_MS); });
      const r = await Promise.race([lookupFn(model), timeout]);
      return { parts: (r && Array.isArray(r.parts) ? r.parts : []).filter((p) => p && p.title), timedOut: Boolean(r && r.timedOut) };
    } catch (e) { return { parts: [], failed: true }; } finally { clearTimeout(timer); }
  }

  /** One journey: prepare → (model parts) → decide; control only when requested and not exiting. Never throws. */
  async function runJourney(transport, block, key, opts = {}) {
    const pack = PACKS[key];
    // eslint-disable-next-line global-require, import/no-dynamic-require
    const J = require(pack.pipeline);
    const requested = controlRequested(block, key, opts.env);
    const prepOpts = { errorCodes: deps.errorCodes(), matchComponent: deps.matchesComponent };
    let prep = J.prepare(transport.state, prepOpts);
    if (!prep.entry.applies) return { applies: false, journey: { key, schema: pack.schema, applies: false, control: false, controlRequested: requested, entry: prep.entry } };
    const need = J.modelNeed(transport.state);
    let parts = null;
    if (need) {
      parts = (await modelParts(need.model, opts.lookupFn)).parts;
      prep = J.prepare(transport.state, { ...prepOpts, modelParts: parts });
    }
    const preview = J.decide(transport.state, prep, { partLookup: prep.partLookup, control: false });
    const control = requested && preview.nextAction.kind !== 'exit_journey';
    const out = control ? J.decide(transport.state, prep, { partLookup: prep.partLookup, control: true, turn: transport.state.version }) : preview;
    const summary = J.summary(prep, out, { key, control, controlRequested: requested,
      partLookup: compactPartLookup(prep.partLookup), modelParts: parts ? parts.length : null, media: J.mediaFor(out.nextAction) });
    return { applies: true, state: out.state, issuedRequest: out.issuedRequest || null, journey: summary };
  }

  /**
   * Route the merged state: the first journey (registry order) whose entry applies owns the turn. Returns the
   * transport with `journey` (the deciding journey's summary, or the first journey's non-applying view) and, under
   * control, the request issued into the state. Never throws.
   */
  async function runJourneys(transport, block, opts = {}) {
    if (!transport || transport.degraded || !transport.state) return transport;
    let first = null;
    for (const key of ROUTING_ORDER) {
      try {
        const j = await runJourney(transport, block, key, opts);
        if (j.applies) return { ...transport, state: j.state, issuedRequest: j.issuedRequest, journey: j.journey };
        first = first || j.journey;
      } catch (e) {
        return { ...transport, journey: { key, applies: false, control: false, error: err160(e) } };
      }
    }
    return { ...transport, journey: first };
  }

  /** Start the message-only mc/1 classification (separate Jev evaluation). Never rejects. */
  function classify(messages, block, requestId) {
    return (async () => {
      try {
        // eslint-disable-next-line global-require
        const { classifyLatestMessage } = require('./jev-mc1.js');
        const progress = deps.conversationProgress(messages);
        const admin = await deps.loadAdminInference();
        return await classifyLatestMessage({
          latestMessage: progress.latestUserText, priorAssistantMessage: progress.priorAdvisorText || null,
          state: block && block.state ? block.state : null, credentials: admin && admin.jev, messageId: requestId,
        });
      } catch (e) {
        return { classification: null, meta: { source: 'mc1-questions', degraded: true, reason: 'classify_failed', error: err160(e) } };
      }
    })();
  }
  function awaitClassification(pending, graceMs) {
    let timer;
    const timeout = new Promise((resolve) => { timer = setTimeout(() => resolve({ classification: null, meta: { source: 'mc1-questions', degraded: true, reason: 'timeout' } }), graceMs); });
    return Promise.race([pending, timeout]).finally(() => clearTimeout(timer));
  }

  /**
   * Understand mode, step 1 (before the legacy UNDERSTAND): start classifying when the BFF sent a block.
   * Step 2 (after): await it, merge, route. Returns the transport result or null (no block this turn).
   */
  function beginUnderstand(body, messages, requestId) {
    const block = body && body.canonical;
    if (!isTransportBlock(block)) return null;
    return { block, pending: classifierEnabled() ? classify(messages, block, requestId) : null };
  }
  async function finishUnderstand(started) {
    if (!started) return null;
    const { block, pending } = started;
    const result = pending
      ? await awaitClassification(pending, anyControlRequested(block) ? CLASSIFIER_CONTROL_GRACE_MS : CLASSIFIER_GRACE_MS)
      : { classification: null, meta: { source: 'mc1-questions', degraded: true, reason: 'classifier_disabled' } };
    const degraded = Boolean(!result || !result.classification || (result.meta && result.meta.degraded));
    const t = await runJourneys(transportMerge(degraded ? null : result.classification, block), block);
    return { ...t, classifier: classifierSummary(result && result.meta) };
  }

  /** Diagnose mode: does canonical control own this turn? */
  function controls(canonical) {
    const j = isTransportResult(canonical) ? journeyOf(canonical) : null;
    return Boolean(j && j.control && j.nextAction && j.applies && PACKS[j.key]);
  }

  async function mediaFor(j, pack, a, state, messages, ensureOverlay = true) {
    if (!j.media || a.kind === 'safety_stop') return [];
    const id = state.identity || {};
    const M = deps.media;
    try {
      if (ensureOverlay !== false) await M.ensureMediaOverlay();
      const pool = ((M.getEffectiveMediaJoin().byKnowledgeId || {})[j.media.knowledgeId || pack.knowledgeId] || []).filter((m) => j.media.ids.includes(m.id));
      const code = ((id.displayedCodes || []).filter((f) => f.status === 'active').pop() || {}).value || null;
      return M.selectMedia(pool, { make: id.make && id.make.value ? id.make.value : null, model: id.model && id.model.value && id.model.confirmed ? id.model.value : null,
        errorCode: code, concepts: j.media.concepts, alreadyShown: M.previouslyShownMedia(messages) })
        .map((m) => (m.type === 'VIDEO'
          ? { id: m.id || null, type: 'VIDEO', title: m.title, caption: m.caption || m.description || '', provider: m.provider || null, videoId: m.videoId || null,
            embedUrl: m.embedUrl || null, sourcePageUrl: m.sourcePageUrl || null, attribution: m.attribution || null, intent: 'SAFE_CHECK' }
          : { id: m.id || null, type: m.type, title: m.title, description: m.description, url: m.asset, alt: m.alt, intent: 'SAFE_CHECK' }));
    } catch (e) { return []; }
  }

  function composeErrorClass(e) {
    const m = String((e && e.message) || e || '');
    const status = (m.match(/\bstatus (\d{3})\b/) || [])[1];
    if (status) return `http_${status}`;
    if (/abort|timeout|timed out/i.test(m)) return 'timeout';
    if (e && e.name && e.name !== 'Error') return String(e.name).slice(0, 40);
    return 'error';
  }

  /** Word the NextAction (COMPOSE, wording only; fixed copy for safety stops / declines). Never throws. */
  async function word(JC, a, b, seed, provider) {
    const C = deps.compose;
    if (a.kind === 'safety_stop' || a.target === 'unsafe-request-declined') return { reply: JC.template(b), source: 'template', violations: [], composeMs: null };
    const violations = [];
    try {
      const p = provider || await C.getProvider();
      let text = '';
      const tc = Date.now();
      await p.infer({ messages: JC.prompt(b), temperature: Math.min(C.lm.temperature, 0.3), maxTokens: 400,
        repeatPenalty: C.lm.repeatPenalty, stream: true, timeoutMs: C.lm.timeoutMs, ...(seed !== undefined ? { seed } : {}) },
      { onDelta: (d) => { if (d) text += d; } });
      const composeMs = Date.now() - tc;
      for (const f of C.filters) text = f(text);
      if (a.kind !== 'recommend_part') text = C.constrainReplacementLanguage(text, []);
      const tripped = C.outputTripwire(text);
      if (tripped) return { reply: JC.template(b), source: 'template', violations: [`tripwire:${tripped}`], composeMs };
      const chk = JC.checkReply(text, a, b);
      violations.push(...chk.violations);
      return { reply: chk.reply, source: chk.ok ? 'compose' : 'template', violations, composeMs };
    } catch (e) {
      // The reason is recorded (class and status only, never the provider's body), so a template turn is explainable.
      const composeError = composeErrorClass(e);
      console.warn(JSON.stringify({ evt: 'canonical-compose-failed', error: composeError }));
      return { reply: JC.template(b), source: 'template', violations: ['compose_failed'], composeMs: null, composeError };
    }
  }

  /** Diagnose-mode response for a controlled turn: `{reply, done, metric}`. */
  async function respond({ canonical, messages, requestId, seed }, opts = {}) {
    const j = journeyOf(canonical);
    const pack = PACKS[j.key];
    // eslint-disable-next-line global-require, import/no-dynamic-require
    const JC = require(pack.compose);
    const a = j.nextAction;
    const state = canonical.state;
    const id = state.identity || {};
    const t0 = Date.now();
    const media = await mediaFor(j, pack, a, state, messages, opts.ensureMedia);
    const partLookup = j.partLookup || null;
    const parts = a.kind === 'recommend_part' && partLookup && partLookup.available ? partLookup.parts.slice(0, 3) : [];
    const b = JC.brief(state, a, null, { partLookup, media });
    const w = await word(JC, a, b, seed, opts.provider);
    const mention = a.kind === 'recommend_part' ? deps.COMPONENT_MENTION.PURCHASE : deps.COMPONENT_MENTION.NONE;
    const c = a.conclusion || null;
    const understood = {
      onTopic: true, grounded: true, applianceType: (id.appliance && id.appliance.value) || pack.family, faultId: pack.faultId, fault: pack.fault,
      make: id.make && id.make.value ? id.make.value : null, model: id.model && id.model.value && id.model.confirmed ? id.model.value : null,
      confidence: c && c.confidence === 'likely' ? 0.85 : 0.6,
      candidateComponents: a.kind === 'recommend_part' && c && c.component ? [JC.COMPONENT_LABEL[c.component] || c.component] : [],
      componentMention: mention,
    };
    const stage = {
      id: 'canonical-control', label: `Canonical journey control ${j.key} (NextAction -> COMPOSE wording only)`, evidence: 'DERIVED',
      summary: `${a.rule} ${a.kind} ${a.target || ''} (${w.source})`.trim(),
      detail: { nextAction: a, diagnostics: j.diagnostics, partGate: j.partGate, issuedRequest: j.issuedRequest || null,
        compose: { source: w.source, violations: w.violations, latencyMs: w.composeMs, outputChars: w.reply.length, totalMs: Date.now() - t0, ...(w.composeError ? { error: w.composeError } : {}) },
        media: media.map((m) => m.id), parts: parts.map((p) => p.partNo || null) },
    };
    return {
      reply: w.reply,
      done: {
        type: 'done', traceId: requestId, parts, understood, safetyInformation: null,
        safetyStop: a.kind === 'safety_stop' ? (SAFETY_STOP_REASON[a.target] || 'electrical') : null, isolationAdvisory: false,
        unsafeIntent: false, normalBehaviour: false, media, componentMention: mention, purchaseAppropriate: a.kind === 'recommend_part',
        remoteActionClass: null,
        canonicalControl: { journey: j.key, nextAction: a, compose: { source: w.source, violations: w.violations }, control: true },
        diagnosticTrace: { schemaVersion: '1.0', capturedAt: new Date().toISOString(), stages: [stage] },
      },
      metric: { journey: j.key, rule: a.rule, kind: a.kind, target: a.target, source: w.source, violations: w.violations, composeMs: w.composeMs, ...(w.composeError ? { composeError: w.composeError } : {}) },
    };
  }

  return { modelParts, runJourney, runJourneys, classify, awaitClassification, beginUnderstand, finishUnderstand, controls, respond };
}

/** One bounded log projection of the understand-mode transport (no state body, no classification body). */
function transportMetric(t) {
  const j = t && t.journey;
  const d = j && j.diagnostics;
  return {
    schema: 'cs/1', mode: (t && t.mode) || null, degraded: (t && t.degraded) || null,
    priorVersion: t ? t.priorVersion : null, version: t ? t.version : null,
    rules: t && Array.isArray(t.rulesFired) ? t.rulesFired : [],
    stateBytes: t && t.state ? Buffer.byteLength(JSON.stringify(t.state), 'utf8') : 0,
    journey: j ? { key: j.key || null, applies: Boolean(j.applies), control: Boolean(j.control),
      rule: j.nextAction ? j.nextAction.rule : null, kind: j.nextAction ? j.nextAction.kind : null, target: j.nextAction ? j.nextAction.target : null,
      leader: d && d.leader ? { family: d.leader.family, level: d.leader.level, committed: d.leader.committed } : null,
      partGate: j.partGate ? { eligible: Boolean(j.partGate.eligible), failed: j.partGate.failed || [] } : null,
      issued: Boolean(t.issuedRequest), error: j.error || null } : null,
    classifier: t && t.classifier ? t.classifier : null,
  };
}

module.exports = { createCanonicalRuntime, PACKS, ROUTING_ORDER, SAFETY_STOP_REASON, isTransportBlock, isTransportResult, transportMerge,
  controlRequested, anyControlRequested, classifierEnabled, classifierSummary, transportMetric, journeyOf };
