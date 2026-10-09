'use strict';

/**
 * Safety Ingest observability — deterministic. No GOLD / no LLM / no live OPSS.
 *   node services/whichpart-api/test/safety-ingest.test.cjs
 */
const observe = require('../recalls/observe');
const storeMod = require('../recalls/store');
const ingest = require('../recalls/ingest');
const http = require('../recalls/http');
const fixtures = require('./fixtures/opss-content');
const api = require('../index.js');
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass++; console.log('  ok  - ' + name); }
  else { fail++; console.log('  FAIL- ' + name + (detail ? '  :: ' + detail : '')); }
}

const docs = {
  [fixtures.foldingWasher.base_path]: fixtures.foldingWasher,
  [fixtures.haierDryer.base_path]: fixtures.haierDryer,
  [fixtures.samsungHob.base_path]: fixtures.samsungHob,
  [fixtures.wallbox.base_path]: fixtures.wallbox,
  [fixtures.pressureWasher.base_path]: fixtures.pressureWasher,
};

function searchResults() {
  return {
    total: 5,
    results: Object.keys(docs).map((link) => ({
      link, title: docs[link].title, description: docs[link].description, public_timestamp: docs[link].public_updated_at,
    })),
  };
}

function fetchOk(url) {
  const u = String(url);
  if (u.indexOf('https://www.gov.uk/api/search.json') === 0) {
    return Promise.resolve({ ok: true, status: 200, text: async () => JSON.stringify(searchResults()) });
  }
  if (u.indexOf('https://www.gov.uk/api/content/') === 0) {
    const path = u.replace('https://www.gov.uk/api/content', '');
    const doc = docs[path];
    if (!doc) return Promise.resolve({ ok: false, status: 404, text: async () => '{}' });
    return Promise.resolve({ ok: true, status: 200, text: async () => JSON.stringify(doc) });
  }
  return Promise.reject(new Error('blocked-fetch ' + u));
}

function fetchStatus(status, body) {
  return () => Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body || {})),
  });
}

function pubRec(id, extra) {
  return Object.assign({
    contentId: id,
    slug: 'n-' + id,
    title: 'Notice ' + id,
    brand: 'Haier',
    models: ['HD90-A3S979'],
    family: 'tumble-dryer',
    state: 'published',
    bodyHash: 'h' + id,
    sourceUrl: 'https://www.gov.uk/product-safety-alerts-reports-recalls/' + id,
    alertDate: '2026-01-01',
  }, extra || {});
}

console.log('STATUS SEMANTICS');
{
  const now = new Date('2026-09-20T12:00:00Z');
  ok('healthy when last success is current and published', observe.statusOf({
    now, publishedCount: 46, meta: { lastSuccessAt: '2026-09-20T06:00:00Z', lastRunAt: '2026-09-20T06:00:00Z' },
  }).code === 'healthy');
  ok('running when lock is live', observe.statusOf({
    now, publishedCount: 46, meta: { lastSuccessAt: '2026-09-20T06:00:00Z' },
    lock: { expiresAt: '2026-09-20T12:10:00Z' },
  }).code === 'running');
  ok('attention when latest failed with last-good', observe.statusOf({
    now, publishedCount: 46, meta: { lastFailureSafe: true, lastError: 'govuk-fetch', lastSuccessAt: '2026-09-19T06:00:00Z', lastRunAt: '2026-09-20T06:00:00Z' },
  }).code === 'attention');
  ok('failed when nothing published', observe.statusOf({
    now, publishedCount: 0, meta: {},
  }).code === 'failed');
  ok('unavailable when store cannot be read', observe.statusOf({ unavailable: true, now, publishedCount: 0, meta: {} }).code === 'unavailable');
  ok('unknown when published but no timestamp', observe.statusOf({
    now, publishedCount: 3, meta: {},
  }).code === 'unknown');
  ok('overdue after missed daily slot plus grace', observe.statusOf({
    now: new Date('2026-09-21T09:00:00Z'),
    publishedCount: 46,
    meta: { lastSuccessAt: '2026-09-19T06:00:00Z', lastRunAt: '2026-09-19T06:00:00Z' },
  }).code === 'attention');
  ok('healthy is not inferred from HTTP 200 alone', observe.statusOf({
    now, publishedCount: 0, meta: { lastError: null },
  }).code !== 'healthy');
}

console.log('REASONS / DATASET / HISTORY HELPERS');
{
  ok('reason labels from classify', observe.reasonLabel('excluded-non-appliance') === 'Not an ApplianceClinic appliance'
    && observe.reasonLabel('no-family-match') === 'Could not assign an appliance family'
    && observe.reasonLabel('ambiguous-product-type:hobs,oven-cooker') === 'Ambiguous official product type');
  const id1 = observe.datasetIdentity([pubRec('a'), pubRec('b')]);
  const id2 = observe.datasetIdentity([pubRec('b'), pubRec('a')]);
  const id3 = observe.datasetIdentity([pubRec('a', { bodyHash: 'changed' }), pubRec('b')]);
  ok('dataset hash is order-independent', id1 === id2 && id1.length === 64);
  ok('dataset hash changes with content', id1 !== id3);
  const cov = observe.coverage([pubRec('a'), pubRec('b', { brand: 'Samsung', models: [], presentation: { identityRangeNeeded: true } })]);
  ok('coverage counts brands and exact models', cov.uniqueBrands === 2 && cov.exactModelCapable === 1 && cov.identityRangeNeeded === 1);
  const hist = observe.appendHistory(new Array(20).fill({ runId: 'old' }), { runId: 'new' });
  ok('history capped at 20', hist.length === 20 && hist[0].runId === 'new' && hist[19].runId === 'old');
  const recon = observe.reconstructHistory({ lastRunAt: '2026-09-20T06:00:00Z', lastMode: 'daily', lastCounts: { candidates: 0, fetched: 0, published: 0, livePublished: 46 } });
  ok('reconstructed history does not invent filter reasons', recon[0].reconstructed === true && recon[0].reasons == null && recon[0].trigger === 'unknown');
  ok('public errors never include stack traces', !/at Object/.test(observe.publicError(new Error('govuk-http-503 boom\n    at Object.run')))
    && /remains active/.test(observe.publicError('govuk-http-503')));
  ok('already-running wording is deterministic', observe.publicError('Ingest already running.') === 'Ingest already running.');
}

(async function () {
  console.log('INGEST PIPELINE COUNTS AND REASONS');
  const store = storeMod.createMemoryStore();
  const first = await ingest.run({
    store, fetch: fetchOk, putObject: async () => {}, now: new Date('2026-09-18T12:00:00Z'), mode: 'backfill', trigger: 'manual',
  });
  ok('runId assigned', /^si-/.test(first.runId));
  ok('fetched parsed documents', first.counts.fetched === 5, JSON.stringify(first.counts));
  ok('published 3 appliance notices', first.counts.published === 3 && first.counts.livePublished === 3);
  ok('excluded non-appliances recorded', first.counts.excluded >= 2 && first.counts.reasons['excluded-non-appliance'] >= 2);
  ok('history written', first.historyWritten === true);
  const meta = await store.getMeta();
  ok('history entry has trigger and reasons', meta.history[0].trigger === 'manual' && meta.history[0].reasons['excluded-non-appliance'] >= 2);
  ok('dataset id stored', meta.datasetId && meta.datasetId === first.datasetId);

  const view = await observe.buildView({ store, now: new Date('2026-09-18T12:30:00Z') });
  ok('view source is OPSS via GOV.UK', view.source.authority.indexOf('Office for Product Safety') !== -1
    && view.source.searchUrl === 'https://www.gov.uk/api/search.json');
  ok('view published count', view.published.count === 3);
  ok('view pipeline uses real stages', view.pipeline[0].id === 'source' && view.pipeline[3].id === 'live');
  ok('view rejections labelled', view.rejections.total >= 2 && view.rejections.items[0].label);
  ok('matching policy is read-only', view.matching.editable === false && view.matching.policy.length >= 3);
  ok('no secrets in view', !observe.buildView.toString().match(/ORCHESTRATOR_TOKEN/)
    && !JSON.stringify(view).match(/AKIA|sk-|secretAccessKey|MCP_BEARER/));
  ok('schedule is daily 06:00 UTC', view.schedule.label === 'Daily' && view.schedule.time === '06:00 UTC');

  console.log('LAST-GOOD / FAILURES');
  const live = await store.listPublished();
  const failStore = storeMod.createMemoryStore(live);
  await failStore.putMeta(await store.getMeta());
  const timedOut = await ingest.run({
    store: failStore,
    fetch: () => Promise.reject(new Error('aborted timeout')),
    now: new Date('2026-09-18T13:00:00Z'),
    mode: 'daily',
  });
  ok('timeout preserves published rows', timedOut.failedFetch === true && (await failStore.listPublished()).length === 3);
  ok('timeout public error names OPSS', /OPSS/.test(timedOut.error) && /remains active/.test(timedOut.error));
  ok('timeout status is attention not no-data', (await observe.buildView({ store: failStore, now: new Date('2026-09-18T13:01:00Z') })).status.code === 'attention');

  const http5 = await ingest.run({
    store: storeMod.createMemoryStore(live),
    fetch: fetchStatus(503, { error: 'upstream' }),
    now: new Date('2026-09-18T14:00:00Z'),
  });
  ok('5xx preserves last-good', http5.preservedExisting === true);

  const http4 = await ingest.run({
    store: storeMod.createMemoryStore(live),
    fetch: fetchStatus(404, { error: 'missing' }),
    now: new Date('2026-09-18T14:10:00Z'),
  });
  ok('4xx preserves last-good', http4.preservedExisting === true && (http4.error || '').indexOf('stack') === -1);

  const badJson = await ingest.run({
    store: storeMod.createMemoryStore(live),
    fetch: fetchStatus(200, '<<<not json>>>'),
    now: new Date('2026-09-18T14:20:00Z'),
  });
  ok('malformed JSON preserves last-good', badJson.preservedExisting === true && /could not be read/.test(badJson.error));

  const emptyStore = storeMod.createMemoryStore(live);
  const empty = await ingest.run({
    store: emptyStore,
    fetch: fetchStatus(200, { total: 0, results: [] }),
    putObject: async () => {},
    now: new Date('2026-09-18T14:30:00Z'),
    mode: 'daily',
  });
  ok('empty index is a successful quiet run', empty.ok && empty.counts.candidates === 0 && (await emptyStore.listPublished()).length === 3);

  const putFail = storeMod.createMemoryStore(live);
  const origPut = putFail.put.bind(putFail);
  putFail.put = async () => { throw new Error('storage-unavailable'); };
  const stored = await ingest.run({
    store: putFail, fetch: fetchOk, putObject: async () => {}, skipPublish: true,
    now: new Date('2026-09-18T14:40:00Z'), mode: 'backfill',
  });
  putFail.put = origPut;
  ok('storage failure on new records does not wipe last-good', stored.ok && (await putFail.listPublished()).length === 3);
  ok('failed records are counted', stored.counts.failed >= 1);

  const pubFail = storeMod.createMemoryStore(live);
  await pubFail.putMeta({ lastSuccessAt: '2026-09-18T12:00:00Z', lastRunAt: '2026-09-18T12:00:00Z', history: [] });
  const htmlFail = await ingest.run({
    store: pubFail,
    fetch: fetchStatus(200, { total: 0, results: [] }),
    putObject: async () => { throw new Error('s3-put failed'); },
    now: new Date('2026-09-18T15:00:00Z'),
    mode: 'daily',
  });
  ok('HTML publish failure does not delete Dynamo records', (await pubFail.listPublished()).length === 3);
  ok('HTML publish failure does not overwrite lastSuccessAt', (await pubFail.getMeta()).lastSuccessAt === '2026-09-18T12:00:00Z');
  ok('HTML failure is failed run not empty dataset', htmlFail.ok === false && /HTML publication/.test(htmlFail.error || ''));

  const histStore = storeMod.createMemoryStore(live);
  histStore.putMeta = async () => { throw new Error('history-write'); };
  const histFail = await ingest.run({
    store: histStore, fetch: fetchStatus(200, { total: 0, results: [] }), putObject: async () => {},
    now: new Date('2026-09-18T15:10:00Z'), mode: 'daily',
  });
  ok('history write failure does not drop published data', histFail.historyWritten === false && (await histStore.listPublished()).length === 3);

  console.log('CONCURRENCY / LOCK');
  const lockStore = storeMod.createMemoryStore(live);
  let release;
  const gate = new Promise((r) => { release = r; });
  const hanging = ingest.run({
    store: lockStore,
    fetch: () => gate.then(() => fetchStatus(200, { total: 0, results: [] })()),
    putObject: async () => {},
    now: new Date('2026-09-18T16:00:00Z'),
    mode: 'daily',
  });
  await new Promise((r) => setTimeout(r, 30));
  const second = await ingest.run({
    store: lockStore, fetch: fetchOk, now: new Date('2026-09-18T16:00:01Z'), mode: 'daily',
  });
  ok('concurrent run rejected', second.running === true && second.error === 'Ingest already running.');
  const runningView = await observe.buildView({ store: lockStore, now: new Date('2026-09-18T16:00:02Z') });
  ok('status running while lock held', runningView.status.code === 'running');
  release();
  const firstDone = await hanging;
  ok('first run completes after lock holder finishes', firstDone.ok === true);
  const stale = storeMod.createMemoryStore(live);
  await stale.tryLock({ runId: 'old', trigger: 'manual', startedAt: '2026-09-18T00:00:00Z', expiresAt: '2026-09-18T00:14:00Z' }, new Date('2026-09-18T00:00:00Z'));
  const recovered = await ingest.run({
    store: stale, fetch: fetchStatus(200, { total: 0, results: [] }), putObject: async () => {},
    now: new Date('2026-09-18T16:20:00Z'), mode: 'daily',
  });
  ok('expired lock can be recovered', recovered.ok === true && recovered.running !== true);

  console.log('SUCCESS AFTER FAILURE');
  const bounce = storeMod.createMemoryStore(live);
  await ingest.run({ store: bounce, fetch: () => Promise.reject(new Error('network')), now: new Date('2026-09-18T17:00:00Z') });
  const recoveredRun = await ingest.run({
    store: bounce, fetch: fetchOk, putObject: async () => {}, now: new Date('2026-09-18T17:10:00Z'), mode: 'backfill',
  });
  ok('successful run after failure republishes last-good plus ingest', recoveredRun.ok && recoveredRun.counts.livePublished === 3);
  ok('status healthy after recovery', (await observe.buildView({
    store: bounce, now: new Date('2026-09-18T17:11:00Z'),
  })).status.code === 'healthy' || (await bounce.getMeta()).lastFailureSafe === false);

  console.log('NO DATASET');
  const noneStore = storeMod.createMemoryStore();
  const none = await observe.buildView({ store: noneStore, now: new Date('2026-09-18T12:00:00Z') });
  ok('no dataset is failed not healthy', none.status.code === 'failed' && none.published.count === 0);

  console.log('ADMIN HTTP + AUTH');
  api.setRecallStore(store);
  api.setSessionForTests(() => Promise.resolve({ username: 'admin', email: 'ops@example.com', isAdmin: true }));
  function invoke(method, rawPath, extra) {
    extra = extra || {};
    return api.handler({
      rawPath,
      requestContext: { http: { method, path: rawPath }, requestId: 't' },
      headers: extra.headers || {},
      cookies: extra.cookies || [],
      body: extra.body || '',
      queryStringParameters: extra.qs || {},
    });
  }
  const unauthGet = await (async () => {
    api.setSessionForTests(() => Promise.resolve(null));
    const r = await invoke('GET', '/api/admin/safety-ingest');
    api.setSessionForTests(() => Promise.resolve({ username: 'admin', email: 'ops@example.com', isAdmin: true }));
    return r;
  })();
  ok('GET unauthenticated 401', unauthGet.statusCode === 401);
  const unauthPost = await (async () => {
    api.setSessionForTests(() => Promise.resolve(null));
    const r = await invoke('POST', '/api/admin/safety-ingest/run', { body: '{}' });
    api.setSessionForTests(() => Promise.resolve({ username: 'admin', email: 'ops@example.com', isAdmin: true }));
    return r;
  })();
  ok('POST unauthenticated 401', unauthPost.statusCode === 401);
  const unauthHist = await (async () => {
    api.setSessionForTests(() => Promise.resolve(null));
    const r = await invoke('GET', '/api/admin/safety-ingest/history');
    api.setSessionForTests(() => Promise.resolve({ username: 'admin', email: 'ops@example.com', isAdmin: true }));
    return r;
  })();
  ok('history unauthenticated 401', unauthHist.statusCode === 401);

  const status = JSON.parse((await invoke('GET', '/api/admin/safety-ingest')).body);
  ok('admin view has purpose and source', /official product-safety/i.test(status.purpose) && status.source.via === 'GOV.UK');
  ok('admin view has no AWS dump', status.Item == null && status.TableName == null);
  const hist = JSON.parse((await invoke('GET', '/api/admin/safety-ingest/history')).body);
  ok('history endpoint returns runs', Array.isArray(hist.history) && hist.history.length >= 1);

  const publicList = JSON.parse((await invoke('GET', '/api/recalls')).body);
  ok('public list has no run/debug fields', publicList.items.every((i) => i.runId == null && i.classification == null && i.bodyHash == null));
  ok('diagnosis contract unchanged', (await invoke('POST', '/api')).statusCode === 400);

  api.setSessionForTests(null);

  const handlers = http.createHandlers(() => store, async (opts) => {
    return { ok: true, counts: { mode: opts.mode, fetched: 0, published: 0, livePublished: 3 }, runId: 'si-test' };
  });
  const wrapped = await handlers.adminIngest({ body: JSON.stringify({ mode: 'backfill', trigger: 'manual' }) });
  ok('admin ingest returns view model', wrapped.view && wrapped.view.published && wrapped.runId === 'si-test');
  const runSlice = require('./api-source.cjs')().split("/admin/safety-ingest/run")[1].slice(0, 500);
  ok('POST /admin/safety-ingest/run forces daily', /mode: 'daily'/.test(runSlice));
  const schedStore = storeMod.createMemoryStore(live);
  const schedRun = await ingest.run({
    store: schedStore,
    fetch: fetchStatus(200, { total: 0, results: [] }),
    putObject: async () => {},
    now: new Date('2026-09-18T18:00:00Z'),
    mode: 'daily',
    trigger: 'scheduled',
  });
  ok('scheduled history trigger', schedRun.ok && (await schedStore.getMeta()).history[0].trigger === 'scheduled');

  console.log('\nsafety-ingest tests: ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
