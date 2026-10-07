'use strict';

/**
 * ApplianceClinic admin Dashboard summary.
 *
 * Conversation-time semantics: metrics are for sessions whose lastActivityAt
 * falls in the selected window. Review timestamps are not used for grouping.
 * Counts are exact tallies of stored LLM classifications — not regex scoring.
 */

const schema = require('./schema');

const PERIODS = {
  today: { key: 'today', label: 'Today', days: 1 },
  '7d': { key: '7d', label: 'Last 7 days', days: 7 },
  '30d': { key: '30d', label: 'Last 30 days', days: 30 },
};

const AREA_LABELS = {
  understanding: 'Understanding',
  clarification: 'Clarification',
  diagnostic_reasoning: 'Diagnostic reasoning',
  knowledge: 'Knowledge',
  parts: 'Parts',
  media: 'Media',
  safety: 'Safety',
  conversation_flow: 'Conversation flow',
  identification: 'Identification',
  other: 'Other',
};

function startOfUtcDay(d) {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

function periodWindow(period, now) {
  const t = now || new Date();
  const key = PERIODS[period] ? period : '7d';
  const meta = PERIODS[key];
  let from;
  if (key === 'today') from = startOfUtcDay(t);
  else from = new Date(t.getTime() - meta.days * 86400000);
  return {
    key: key,
    label: meta.label,
    days: meta.days,
    from: from.toISOString(),
    to: t.toISOString(),
    basis: 'conversation',
    field: 'lastActivityAt',
    note: 'Counts are for conversations that happened in this period, not when they were reviewed.',
  };
}

function conversationTime(rec) {
  return String((rec && (rec.lastActivityAt || rec.createdAt)) || '');
}

function inPeriod(rec, window) {
  const t = conversationTime(rec);
  if (!t) return false;
  if (window.from && t < window.from) return false;
  if (window.to && t > window.to) return false;
  return true;
}

function assessmentOf(rec) {
  if (!rec || !rec.review || rec.review.status !== 'reviewed') return null;
  return rec.review.assessment || null;
}

function attentionReasons(assessment) {
  const a = assessment;
  if (!a) return [];
  const reasons = [];
  if (a.reviewPriority === 'important') reasons.push('important');
  if (a.reviewPriority === 'worth_reviewing') reasons.push('worth_reviewing');
  if (a.overallAssessment === 'poor') reasons.push('poor');
  if (a.safetyHandling === 'concern') reasons.push('safety_concern');
  if (a.looping === 'significant') reasons.push('significant_looping');
  if (a.stateProgression === 'poor') reasons.push('poor_progression');
  return reasons;
}

function needsAttention(rec) {
  return attentionReasons(assessmentOf(rec)).length > 0;
}

function emptyEnumCounts(values) {
  const o = {};
  for (const v of values) o[v] = 0;
  return o;
}

function bump(map, key) {
  if (!key) return;
  map[key] = (map[key] || 0) + 1;
}

function summarize(records, opts) {
  const now = (opts && opts.now) || new Date();
  const window = (opts && opts.window) || periodWindow((opts && opts.period) || '7d', now);
  const rows = (Array.isArray(records) ? records : []).filter((r) => inPeriod(r, window));
  const overall = emptyEnumCounts(schema.OVERALL);
  const outcome = emptyEnumCounts(schema.OUTCOME);
  const productAreas = {};
  let reviewed = 0;
  let attentionConversations = 0;
  let important = 0;
  let worthReviewing = 0;
  let poor = 0;
  let safetyConcern = 0;
  let significantLooping = 0;
  let poorProgression = 0;
  const stateProgression = emptyEnumCounts(schema.STATE_PROGRESSION);
  for (const rec of rows) {
    const a = assessmentOf(rec);
    if (a) {
      reviewed += 1;
      bump(overall, a.overallAssessment);
      bump(outcome, a.outcome);
      if (a.stateProgression) bump(stateProgression, a.stateProgression);
      for (const area of a.suggestedProductAreas || []) bump(productAreas, area);
      const reasons = attentionReasons(a);
      if (reasons.length) {
        attentionConversations += 1;
        if (reasons.indexOf('important') !== -1) important += 1;
        if (reasons.indexOf('worth_reviewing') !== -1) worthReviewing += 1;
        if (reasons.indexOf('poor') !== -1) poor += 1;
        if (reasons.indexOf('safety_concern') !== -1) safetyConcern += 1;
        if (reasons.indexOf('significant_looping') !== -1) significantLooping += 1;
        if (reasons.indexOf('poor_progression') !== -1) poorProgression += 1;
      }
    }
  }
  const areaList = Object.keys(productAreas)
    .sort((a, b) => productAreas[b] - productAreas[a] || a.localeCompare(b))
    .map((area) => ({
      area: area,
      label: AREA_LABELS[area] || area,
      count: productAreas[area],
    }));
  return {
    period: window,
    sessions: rows.length,
    reviewed: reviewed,
    overall: overall,
    outcome: outcome,
    stateProgression: stateProgression,
    attention: {
      conversations: attentionConversations,
      important: important,
      worthReviewing: worthReviewing,
      poor: poor,
      safetyConcern: safetyConcern,
      significantLooping: significantLooping,
      poorProgression: poorProgression,
    },
    productAreas: areaList,
    sampleNote: 'Exact counts of conversations in this period. Not statistical significance.',
  };
}

function compactHealth(services) {
  const s = services || {};
  const parts = [];
  parts.push({
    id: 'api',
    name: 'API',
    ok: !!(s.whichpartApi && s.whichpartApi.ok),
    detail: (s.whichpartApi && s.whichpartApi.error) || null,
  });
  parts.push({
    id: 'diagnostics',
    name: 'Diagnostics',
    ok: !!(s.orchestrator && s.orchestrator.ok),
    detail: (s.orchestrator && (s.orchestrator.error || (!s.orchestrator.ok && s.orchestrator.status))) || null,
  });
  const ragOk = !!(s.rag && s.rag.ok);
  parts.push({
    id: 'rag',
    name: 'RAG',
    ok: ragOk,
    detail: (s.rag && (s.rag.error || s.rag.state || null)) || null,
  });
  if (s.mcp) {
    parts.push({
      id: 'error_codes',
      name: 'Error codes',
      ok: !!s.mcp.ok,
      detail: s.mcp.error || (!s.mcp.ok && s.mcp.status) || null,
    });
  }
  const failed = parts.filter((p) => !p.ok);
  return {
    ok: failed.length === 0,
    label: failed.length === 0 ? 'Healthy' : (failed.length === 1 ? 'Problem' : 'Problems'),
    parts: parts,
    failed: failed,
    summaryLine: parts.map((p) => p.name).join(' · '),
  };
}

async function fromStore(store, opts) {
  const now = (opts && opts.now) || new Date();
  const window = periodWindow((opts && opts.period) || '7d', now);
  let records = [];
  if (typeof store.listRecordsSince === 'function') {
    records = await store.listRecordsSince(window.from, 400);
  } else if (typeof store.listRecentRecords === 'function') {
    records = await store.listRecentRecords(200, now);
  }
  return summarize(records, { window: window, now: now });
}

module.exports = {
  PERIODS,
  AREA_LABELS,
  periodWindow,
  conversationTime,
  inPeriod,
  assessmentOf,
  attentionReasons,
  needsAttention,
  summarize,
  compactHealth,
  fromStore,
};
