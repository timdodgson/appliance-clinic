'use strict';

/**
 * ApplianceClinic admin Dashboard — conversation-time production summary,
 * unique needs-attention, compact health, and period windows.
 *
 *   node services/whichpart-api/test/dashboard.test.cjs
 */

const dash = require('../transcript-review/dashboard');
const tx = require('../transcripts');
const api = require('../index.js');

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  ok  - ' + name); }
  else { fail++; console.log('  FAIL- ' + name + (detail ? '  :: ' + detail : '')); }
}

const NOW = new Date('2026-09-19T12:00:00.000Z');

function reviewed(assessment) {
  return {
    status: 'reviewed',
    reviewedAt: '2026-09-19T11:00:00.000Z',
    assessment: Object.assign({
      overallAssessment: 'good',
      outcome: 'useful_outcome',
      reviewPriority: 'normal',
      looping: 'none',
      safetyHandling: 'not_applicable',
      suggestedProductAreas: [],
    }, assessment || {}),
  };
}

function rec(id, lastActivityAt, review, extra) {
  extra = extra || {};
  return Object.assign({
    sessionId: id,
    createdAt: lastActivityAt,
    lastActivityAt: lastActivityAt,
    status: 'ended',
    review: review || { status: 'none', assessment: null, reviewedAt: null },
  }, extra);
}

function invoke(method, rawPath, opts) {
  opts = opts || {};
  return api.handler({
    rawPath,
    requestContext: { http: { method: method, path: rawPath }, requestId: 't' },
    headers: opts.headers || {},
    cookies: opts.cookies || [],
    body: opts.body || '',
    queryStringParameters: opts.qs || {},
  });
}

(async function main() {
  console.log('HEALTH AGGREGATE');
  {
    const healthy = dash.compactHealth({
      whichpartApi: { ok: true, service: 'whichpart-api' },
      orchestrator: { ok: true, status: 'ok', version: 'x', diagnosticRag: 'ok' },
      rag: { ok: true, state: 'ok', reportedBy: 'orchestrator' },
      mcp: { ok: true, status: 'ok', datasetV1Hash: 'deadbeef', enrichmentV1Hash: 'cafebabe', mappingCount: 12, version: 'v1' },
    });
    check('healthy aggregate is ok', healthy.ok === true && healthy.label === 'Healthy' && healthy.failed.length === 0);
    check('healthy names API · Diagnostics · RAG · Error codes',
      healthy.summaryLine === 'API · Diagnostics · RAG · Error codes');
    check('healthy compact payload has four parts', healthy.parts.length === 4 && healthy.parts.every((p) => p.ok));
    const blob = JSON.stringify(healthy);
    check('compact health does not leak dataset hashes', !/deadbeef|cafebabe|datasetV1Hash|enrichment/.test(blob));
    check('compact health does not expose gsi or mapping counts', !/mappingCount|gsi_activity/.test(blob));
  }
  {
    const degraded = dash.compactHealth({
      whichpartApi: { ok: true },
      orchestrator: { ok: false, error: 'connect timeout', status: 'unreachable' },
      rag: { ok: false, state: 'unknown' },
      mcp: { ok: true, status: 'ok' },
    });
    check('degraded aggregate is not ok', degraded.ok === false && degraded.label === 'Problems');
    check('degraded lists Diagnostics and RAG',
      degraded.failed.map((p) => p.id).join(',') === 'diagnostics,rag');
    check('healthy Error codes is not in failed', degraded.failed.every((p) => p.id !== 'error_codes' && p.id !== 'api'));
    check('failed Diagnostics carries existing detail',
      /timeout|unreachable/.test(String(degraded.failed[0].detail)));
    const single = dash.compactHealth({
      whichpartApi: { ok: true },
      orchestrator: { ok: true, status: 'ok' },
      rag: { ok: true, state: 'ok' },
      mcp: { ok: false, error: 'http 503', status: 'down' },
    });
    check('single failure is labelled Problem and names Error codes',
      single.ok === false && single.label === 'Problem' && single.failed.length === 1 && single.failed[0].id === 'error_codes');
  }

  console.log('PERIOD WINDOWS');
  {
    const today = dash.periodWindow('today', NOW);
    const week = dash.periodWindow('7d', NOW);
    const month = dash.periodWindow('30d', NOW);
    const fallback = dash.periodWindow('nope', NOW);
    check('today starts at UTC midnight', today.from === '2026-09-19T00:00:00.000Z' && today.to === NOW.toISOString());
    check('7d is 7 * 86400000 before now', week.from === new Date(NOW.getTime() - 7 * 86400000).toISOString());
    check('30d is 30 days before now', month.from === new Date(NOW.getTime() - 30 * 86400000).toISOString());
    check('unknown period falls back to 7d', fallback.key === '7d');
    check('windows are conversation-time', today.basis === 'conversation' && today.field === 'lastActivityAt');
  }

  const todayRec = rec('s-today-good0001', '2026-09-19T09:00:00.000Z', reviewed({
    overallAssessment: 'good', outcome: 'useful_outcome',
  }));
  const todayPoor = rec('s-today-poor0001', '2026-09-19T10:00:00.000Z', reviewed({
    overallAssessment: 'poor',
    outcome: 'no_useful_outcome',
    reviewPriority: 'important',
    safetyHandling: 'concern',
    looping: 'significant',
    suggestedProductAreas: ['safety', 'conversation_flow'],
  }));
  const todayUnreviewed = rec('s-today-open0001', '2026-09-19T11:00:00.000Z', { status: 'none', assessment: null });
  const weekMixed = rec('s-week-mixed0001', '2026-09-15T08:00:00.000Z', reviewed({
    overallAssessment: 'mixed',
    outcome: 'partial_outcome',
    reviewPriority: 'worth_reviewing',
    suggestedProductAreas: ['diagnostic_reasoning'],
  }));
  const oldReviewedToday = rec('s-old-reviewed01', '2026-08-01T08:00:00.000Z', {
    status: 'reviewed',
    reviewedAt: '2026-09-19T11:30:00.000Z',
    assessment: {
      overallAssessment: 'poor',
      outcome: 'abandoned',
      reviewPriority: 'important',
      looping: 'none',
      safetyHandling: 'not_applicable',
      suggestedProductAreas: ['media'],
    },
  });
  const monthAbandoned = rec('s-month-aban0001', '2026-08-25T08:00:00.000Z', reviewed({
    overallAssessment: 'mixed',
    outcome: 'abandoned',
    suggestedProductAreas: ['media'],
  }));

  const all = [todayRec, todayPoor, todayUnreviewed, weekMixed, oldReviewedToday, monthAbandoned];

  console.log('TODAY / 7 DAYS / 30 DAYS + CONVERSATION-TIME');
  {
    const t = dash.summarize(all, { period: 'today', now: NOW });
    check('today sessions are conversation-time', t.sessions === 3);
    check('today reviewed excludes unreviewed', t.reviewed === 2);
    check('today good/mixed/poor', t.overall.good === 1 && t.overall.mixed === 0 && t.overall.poor === 1);
    check('today does not include last-month conversation reviewed today', t.overall.poor === 1 && t.outcome.abandoned === 0);
    check('today useful / no useful', t.outcome.useful_outcome === 1 && t.outcome.no_useful_outcome === 1);

    const w = dash.summarize(all, { period: '7d', now: NOW });
    check('7d includes today + mid-week', w.sessions === 4 && w.reviewed === 3);
    check('7d mixed from 15 Sep', w.overall.mixed === 1 && w.outcome.partial_outcome === 1);
    check('7d still excludes August conversation', w.sessions === 4);

    const m = dash.summarize(all, { period: '30d', now: NOW });
    check('30d includes 25 Aug abandoned', m.sessions === 5 && m.outcome.abandoned === 1);
    check('30d still excludes 1 Aug (outside 30 days)', m.sessions === 5);
    check('review-time of 1 Aug conversation does not pull it into today or 30d',
      dash.summarize([oldReviewedToday], { period: 'today', now: NOW }).sessions === 0
      && dash.summarize([oldReviewedToday], { period: '30d', now: NOW }).sessions === 0);
  }

  console.log('NEEDS ATTENTION — UNIQUE CONVERSATIONS');
  {
    const t = dash.summarize(all, { period: 'today', now: NOW });
    check('one flagged conversation is not five incidents', t.attention.conversations === 1);
    check('poor / safety / looping / important are attributes of that conversation',
      t.attention.poor === 1 && t.attention.safetyConcern === 1
      && t.attention.significantLooping === 1 && t.attention.important === 1
      && t.attention.worthReviewing === 0);
    check('unreviewed today is not attention', t.attention.conversations === 1);

    const w = dash.summarize(all, { period: '7d', now: NOW });
    check('7d attention is two conversations (poor+flags and worth reviewing)', w.attention.conversations === 2);
    check('7d worth reviewing is the mixed conversation', w.attention.worthReviewing === 1 && w.attention.important === 1);

    const empty = dash.summarize([todayRec, todayUnreviewed], { period: 'today', now: NOW });
    check('empty attention when nothing is flagged', empty.attention.conversations === 0);
  }

  console.log('RECURRING AREAS');
  {
    const t = dash.summarize(all, { period: 'today', now: NOW });
    check('today areas are stored classifications only',
      t.productAreas.map((a) => a.area).sort().join(',') === 'conversation_flow,safety');
    check('area labels are human', t.productAreas.some((a) => a.label === 'Conversation flow' && a.count === 1));
    const w = dash.summarize(all, { period: '7d', now: NOW });
    check('7d adds diagnostic reasoning', w.productAreas.some((a) => a.area === 'diagnostic_reasoning' && a.count === 1));
    const none = dash.summarize([todayRec], { period: 'today', now: NOW });
    check('no areas when none stored', none.productAreas.length === 0);
  }

  console.log('EMPTY STATES + FILTER SEMANTICS');
  {
    const empty = dash.summarize([], { period: 'today', now: NOW });
    check('empty sessions today', empty.sessions === 0 && empty.reviewed === 0);
    check('empty overall stays zero not undefined', empty.overall.good === 0 && empty.outcome.useful_outcome === 0);
  }

  console.log('STORE FILTERS + DASHBOARD FROM STORE');
  {
    const store = tx.createMemoryStore();
    for (const r of all) await store.put(r);
    const listed = await store.list({ attention: '1', from: '2026-09-19T00:00:00.000Z', to: '2026-09-19T23:59:59.999Z', limit: 50 }, NOW);
    check('attention filter returns the one flagged conversation',
      listed.items.length === 1 && listed.items[0].sessionId === 's-today-poor0001');
    const looping = await store.list({ looping: 'significant', limit: 50 }, NOW);
    check('looping=significant filter', looping.items.length === 1);
    const safety = await store.list({ safetyHandling: 'concern', limit: 50 }, NOW);
    check('safetyHandling=concern filter', safety.items.length === 1);
    const area = await store.list({ productArea: 'conversation_flow', limit: 50 }, NOW);
    check('product area filter still works', area.items.length === 1);
    const overallPoor = await store.list({ overall: 'poor', limit: 50 }, NOW);
    check('overall=poor includes old reviewed-today conversation when unscoped',
      overallPoor.items.some((r) => r.sessionId === 's-old-reviewed01'));
    const summary = await dash.fromStore(store, { period: 'today', now: NOW });
    check('fromStore today matches summarize', summary.sessions === 3 && summary.attention.conversations === 1);
  }

  console.log('ADMIN AUTH + EXISTING APIS');
  {
    const dashUnauth = await invoke('GET', '/api/admin/dashboard', { qs: { period: '7d' } });
    check('unauthenticated dashboard -> 401', dashUnauth.statusCode === 401);
    const healthUnauth = await invoke('GET', '/api/admin/health');
    check('unauthenticated health still 401', healthUnauth.statusCode === 401);
    const quality = await invoke('GET', '/api/admin/transcripts/quality');
    check('unauthenticated quality still 401', quality.statusCode === 401);
    const list = await invoke('GET', '/api/admin/transcripts');
    check('unauthenticated transcript list still 401', list.statusCode === 401);
    const diag = await invoke('POST', '/api', { body: JSON.stringify({}) });
    check('customer diagnosis contract unchanged', diag.statusCode === 400 && /messages array required/.test(diag.body));
  }

  console.log('\ndashboard tests: ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
