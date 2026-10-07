'use strict';

/**
 * Daily/backfill ingestion. Failures must not delete existing records.
 * Idempotent: unchanged source hash updates lastCheckedAt only.
 */

const { classify } = require('./classify');
const { parseContentDocument, consumerActionHints } = require('./parse');
const { familyOf, FAMILIES } = require('./families');
const govuk = require('./govuk');
const storeMod = require('./store');
const html = require('./html');
const s3 = require('./s3');
const observe = require('./observe');
const lifecycle = require('./lifecycle');

const WEB_BUCKET = process.env.WHICHPART_WEB_BUCKET || 'whichpart-web-800960611664';
const CONCURRENCY = Number(process.env.RECALL_FETCH_CONCURRENCY || 6);
// A single run may not silently remove more than this many currently-listed notices; beyond it the
// removals are held (live rows untouched) and the run reports attention. Protects against a source
// format change or parser fault turning the whole Recall Centre off.
const MAX_UNLIST_ABS = Number(process.env.RECALL_MAX_UNLIST || 3);
const MAX_UNLIST_FRACTION = 0.1;

function iso(d) { return (d || new Date()).toISOString(); }

function daysAgo(n, now) {
  const d = new Date(now || Date.now());
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

function buildRecord(source, classification, nowIso, prev) {
  const hints = consumerActionHints(source);
  const fam = familyOf(classification.family);
  return {
    contentId: source.contentId,
    slug: source.slug,
    title: source.title,
    description: source.description,
    sourceType: source.sourceType,
    sourceTypeRaw: source.sourceTypeRaw,
    sourceCategory: source.sourceCategory,
    riskLevel: source.riskLevel,
    measureTypes: source.measureTypes,
    alertDate: source.alertDate,
    firstPublishedAt: source.firstPublishedAt,
    publicUpdatedAt: source.publicUpdatedAt,
    psdNumber: source.psdNumber,
    productType: source.productType,
    productName: source.productName,
    brand: source.brand,
    models: source.models,
    modelText: source.modelText,
    batchText: source.batchText,
    serialText: source.serialText,
    identifiers: source.identifiers,
    countryOfOrigin: source.countryOfOrigin,
    productDescription: source.productDescription,
    hazard: source.hazard,
    correctiveAction: source.correctiveAction,
    manufacturerUrl: source.manufacturerUrl,
    attachments: source.attachments,
    changeHistory: source.changeHistory,
    withdrawn: source.withdrawn,
    bodyHash: source.bodyHash,
    sourceUrl: source.sourceUrl,
    basePath: source.basePath,
    family: classification.family,
    classification: {
      state: classification.publish ? 'published' : classification.state,
      family: classification.family || null,
      confidence: classification.confidence,
      reason: classification.reason,
      sourceCategory: classification.sourceCategory,
    },
    state: classification.publish ? 'published' : classification.state,
    presentation: {
      hazard: source.hazard,
      whatToDo: source.correctiveAction,
      stopUseIndicatedBySource: hints.stopUseIndicatedBySource,
      identityRangeNeeded: hints.identityRangeNeeded,
      familyName: fam ? fam.name : null,
    },
    firstSeenAt: (prev && prev.firstSeenAt) || nowIso,
    lastCheckedAt: nowIso,
    lastChangedAt: (prev && prev.lastChangedAt) || nowIso,
    revisions: (prev && prev.revisions) || [],
    sourceRevisions: (prev && prev.sourceRevisions) || [],
    // ApplianceClinic's Admin listing decision survives every source refresh (source and decision are separate).
    admin: (prev && prev.admin) || undefined,
  };
}

async function processIndexItem(item, ctx) {
  const doc = await govuk.getContent(item.basePath, ctx.fetch);
  const source = parseContentDocument(doc);
  if (!source || !source.contentId) return { skipped: true, reason: 'unparsed' };
  const classification = classify({
    title: source.title,
    productName: source.productName,
    productType: source.productType,
    description: source.description,
    sourceCategory: source.sourceCategory || item.sourceCategory,
  });
  const prev = await ctx.store.get(source.contentId);
  const drafted = buildRecord(source, classification, ctx.nowIso, prev);
  const invalid = lifecycle.validateRecord(drafted);
  if (invalid.length && prev && !(prev.validation && prev.validation.ok === false)) {
    // A refresh of a known-good notice failed validation (e.g. source format change): keep the live row.
    return { skipped: true, reason: 'invalid-source', invalid, contentId: source.contentId, keptPrevious: true };
  }
  drafted.validation = invalid.length ? { ok: false, fields: invalid, at: ctx.nowIso } : undefined;
  const applied = storeMod.applyRevision(prev, drafted, ctx.nowIso);
  lifecycle.applyEffective(applied.record);
  const unlist = !!(prev && prev.state === 'published' && applied.record.state !== 'published');
  return {
    contentId: source.contentId,
    slug: source.slug,
    family: applied.record.family,
    state: applied.record.state,
    reason: invalid.length ? 'invalid-source' : classification.reason,
    changed: applied.changed,
    isNew: !prev,
    pending: { record: applied.record, expectedRev: prev ? (prev._rev || 0) : 0, prev },
    unpublish: unlist ? { slug: applied.record.slug, sourceUrl: applied.record.sourceUrl, title: applied.record.title } : null,
  };
}

/**
 * Conditional write of one ingested record. If an Admin decision landed between our read and write,
 * re-read and re-apply the same source onto the fresh row once (the Admin decision is preserved).
 */
async function writeIngested(store, pending, nowIso) {
  try {
    await store.put(pending.record, { expectedRev: pending.expectedRev });
    return { ok: true };
  } catch (e) {
    if (!e || e.code !== 'precondition') throw e;
    const fresh = await store.get(pending.record.contentId);
    const rec = Object.assign({}, pending.record, {
      admin: (fresh && fresh.admin) || pending.record.admin,
      firstSeenAt: (fresh && fresh.firstSeenAt) || pending.record.firstSeenAt,
    });
    lifecycle.applyEffective(rec);
    await store.put(rec, { expectedRev: fresh ? (fresh._rev || 0) : 0 });
    return { ok: true, retried: true };
  }
}

async function publishSite(store, nowIso, put, unpublish) {
  const records = await store.listPublished();
  const putFn = put || ((opts) => s3.putObject(opts));
  const bucket = WEB_BUCKET;
  const writes = [
    { key: 'recalls/index.html', body: html.indexPage(records, nowIso) },
    // Recall child sitemap only. The /sitemap.xml index and sitemap-core.xml are
    // owned by the static deploy; the ingest never writes them.
    { key: 'sitemap-recalls.xml', body: html.sitemapRecallsXml(records, nowIso.slice(0, 10)), contentType: 'application/xml; charset=utf-8', cacheControl: 'max-age=300' },
  ];
  FAMILIES.forEach((f) => {
    writes.push({ key: 'recalls/' + f.slug + '/index.html', body: html.familyPage(f.id, records, nowIso) });
  });
  // Curated gas-hob cluster — published only when the live data genuinely supports
  // it (generated from records, never a hand-maintained model list). Owned here, by
  // the recall ingest, like every other /recalls/ page and sitemap-recalls.xml.
  if (html.gasHobRecords(records).length >= html.GAS_HOB_CLUSTER_MIN) {
    writes.push({ key: 'recalls/' + html.GAS_HOB_SLUG + '/index.html', body: html.gasHobClusterPage(records, nowIso) });
  }
  const familySlugs = Object.create(null);
  FAMILIES.forEach((f) => { familySlugs[f.slug] = true; });
  records.forEach((r) => {
    if (!r.slug || familySlugs[r.slug]) return;
    writes.push({ key: 'recalls/' + r.slug + '/index.html', body: html.recordPage(r) });
  });
  (unpublish || []).forEach((r) => {
    if (!r || !r.slug || familySlugs[r.slug]) return;
    writes.push({ key: 'recalls/' + r.slug + '/index.html', body: html.unpublishedPage(r) });
  });
  let published = 0;
  for (const w of writes) {
    await putFn({
      bucket,
      key: w.key,
      body: w.body,
      contentType: w.contentType || 'text/html; charset=utf-8',
      cacheControl: w.cacheControl || 'max-age=60, must-revalidate',
    });
    published += 1;
  }
  return { pages: published, records: records.length };
}

async function run(opts) {
  const now = (opts && opts.now) || new Date();
  const nowIso = iso(now);
  const mode = (opts && opts.mode) === 'daily' ? 'daily'
    : (opts && opts.mode) === 'publish' ? 'publish' : 'backfill';
  const store = opts.store;
  const from = mode === 'daily' ? daysAgo(4, now) : null;
  const trigger = (opts && opts.trigger) === 'scheduled' ? 'scheduled' : 'manual';
  const runId = (opts && opts.runId) || observe.newRunId(now);
  const startedAt = nowIso;
  let locked = false;

  if (typeof store.tryLock === 'function' && !opts.skipLock) {
    const expiresAt = new Date(now.getTime() + observe.LOCK_TTL_MS).toISOString();
    const got = await store.tryLock({ runId, trigger, startedAt, expiresAt }, now);
    if (!got.ok) {
      return {
        ok: false,
        running: true,
        status: 409,
        error: 'Ingest already running.',
        runId: got.lock && got.lock.runId,
      };
    }
    locked = true;
  }

  try {
    return await runLocked(Object.assign({}, opts, {
      now, nowIso, mode, store, from, trigger, runId, startedAt,
    }));
  } finally {
    if (locked && typeof store.releaseLock === 'function') {
      try { await store.releaseLock(runId); } catch { /* lock expires */ }
    }
  }
}

async function finishMeta(store, patch, entry) {
  const prev = await store.getMeta();
  const history = observe.appendHistory(prev.history && prev.history.length ? prev.history : [], entry);
  try {
    await store.putMeta(Object.assign({}, prev, patch, { history }));
    return { historyWritten: true };
  } catch (e) {
    return { historyWritten: false, error: String(e && e.message || e).slice(0, 180) };
  }
}

async function runLocked(opts) {
  const { now, nowIso, mode, store, from, trigger, runId, startedAt } = opts;

  if (mode === 'publish') {
    let site = null;
    try { site = await publishSite(store, nowIso, opts.putObject); }
    catch (e) { site = { error: String(e && e.message || e).slice(0, 180) }; }
    const published = await store.listPublished();
    const counts = { mode, livePublished: published.length, pages: site && site.pages };
    const completedAt = iso(new Date());
    const entry = {
      runId, trigger, startedAt, completedAt,
      status: site && site.error ? 'failed' : 'succeeded',
      source: 'UK OPSS via GOV.UK',
      mode,
      livePublished: published.length,
      datasetId: observe.datasetIdentity(published),
      actor: opts.actor || null,
      error: site && site.error ? observe.publicError(site.error) : null,
    };
    const hist = await finishMeta(store, {
      lastRunAt: nowIso,
      lastMode: mode,
      lastError: site && site.error ? site.error : null,
      lastSuccessAt: (site && site.error) ? (await store.getMeta()).lastSuccessAt : nowIso,
      site,
      lastCounts: counts,
      lastFailureSafe: false,
      datasetId: entry.datasetId,
    }, entry);
    return {
      ok: !(site && site.error),
      counts, site, runId,
      historyWritten: hist.historyWritten,
      error: hist.historyWritten ? (site && site.error ? observe.publicError(site.error) : null)
        : 'Ingest finished but history could not be saved. The existing published dataset remains active.',
    };
  }
  const counts = {
    mode,
    candidates: 0,
    fetched: 0,
    published: 0,
    review: 0,
    excluded: 0,
    skipped: 0,
    changed: 0,
    created: 0,
    failed: 0,
    families: {},
    sourceTypes: {},
    years: {},
    reasons: {},
  };
  FAMILIES.forEach((f) => { counts.families[f.id] = 0; });

  function tallyReason(reason) {
    const key = reason || 'unclassified';
    counts.reasons[key] = (counts.reasons[key] || 0) + 1;
  }

  let index;
  try {
    index = await govuk.listIndex({ from, fetch: opts.fetch, categories: opts.categories });
  } catch (e) {
    const err = String(e && e.message || e);
    const published = await store.listPublished();
    const entry = {
      runId, trigger, startedAt, completedAt: iso(new Date()),
      status: 'failed',
      source: 'UK OPSS via GOV.UK',
      mode,
      candidates: 0,
      fetched: 0,
      publishedThisRun: 0,
      livePublished: published.length,
      error: observe.publicError(err),
      preservedExisting: true,
    };
    const hist = await finishMeta(store, {
      lastRunAt: nowIso,
      lastMode: mode,
      lastError: err.slice(0, 240),
      lastFailureSafe: true,
    }, entry);
    return {
      ok: false,
      failedFetch: true,
      preservedExisting: true,
      error: observe.publicError(err),
      counts,
      runId,
      historyWritten: hist.historyWritten,
    };
  }

  counts.candidates = index.length;
  const ctx = { store, fetch: opts.fetch, nowIso };
  const unpublished = [];
  const results = await govuk.mapPool(index, CONCURRENCY, async (item) => {
    try {
      return await processIndexItem(item, ctx);
    } catch (e) {
      return { failed: true, reason: 'fetch-failed', error: String(e && e.message || e).slice(0, 180), basePath: item.basePath };
    }
  });

  // Mass-unlisting guard: compute before ANY write so a bad run cannot empty the live dataset.
  const livePrior = (await store.listPublished()).length;
  const unlists = results.filter((r) => r && r.unpublish);
  const unlistLimit = Math.max(MAX_UNLIST_ABS, Math.floor(livePrior * MAX_UNLIST_FRACTION));
  const holdUnlists = unlists.length > unlistLimit;
  counts.heldUnlistings = holdUnlists ? unlists.length : 0;
  for (const r of results) {
    if (!r || !r.pending) continue;
    if (holdUnlists && r.unpublish) { r.skipped = true; r.reason = 'mass-unlisting-held'; r.unpublish = null; continue; }
    try {
      await writeIngested(store, r.pending, nowIso);
    } catch (e) {
      r.failed = true; r.reason = 'write-failed'; r.unpublish = null;
    }
  }

  for (const r of results) {
    if (!r) continue;
    if (r.skipped) {
      counts.skipped += 1;
      tallyReason(r.reason || 'unparsed');
      continue;
    }
    if (r.failed) {
      counts.failed += 1;
      tallyReason(r.reason || 'fetch-failed');
      continue;
    }
    counts.fetched += 1;
    if (r.isNew) counts.created += 1;
    if (r.changed) counts.changed += 1;
    if (r.state === 'published') {
      counts.published += 1;
      if (r.family) counts.families[r.family] = (counts.families[r.family] || 0) + 1;
    } else if (r.state === 'review') {
      counts.review += 1;
      tallyReason(r.reason);
    } else {
      counts.excluded += 1;
      tallyReason(r.reason);
    }
    if (r.unpublish) unpublished.push(r.unpublish);
  }

  const published = await store.listPublished();
  published.forEach((rec) => {
    const st = rec.sourceType || 'unknown';
    counts.sourceTypes[st] = (counts.sourceTypes[st] || 0) + 1;
    const y = String(rec.alertDate || '').slice(0, 4);
    if (y) counts.years[y] = (counts.years[y] || 0) + 1;
  });
  counts.livePublished = published.length;
  const datasetId = observe.datasetIdentity(published);

  let site = null;
  if (!opts.skipPublish) {
    try { site = await publishSite(store, nowIso, opts.putObject, unpublished); }
    catch (e) {
      site = { error: String(e && e.message || e).slice(0, 180) };
    }
  }

  const completedAt = iso(new Date());
  const failed = !!(site && site.error);
  const entry = {
    runId,
    trigger,
    startedAt,
    completedAt,
    durationMs: new Date(completedAt).getTime() - new Date(startedAt).getTime(),
    status: failed ? 'failed' : 'succeeded',
    source: 'UK OPSS via GOV.UK',
    mode,
    candidates: counts.candidates,
    fetched: counts.fetched,
    publishedThisRun: counts.published,
    livePublished: counts.livePublished,
    excluded: counts.excluded,
    review: counts.review,
    failed: counts.failed,
    skipped: counts.skipped,
    created: counts.created,
    changed: counts.changed,
    reasons: counts.reasons,
    heldUnlistings: counts.heldUnlistings || 0,
    actor: opts.actor || null,
    datasetId,
    error: failed ? observe.publicError(site.error) : null,
    note: counts.heldUnlistings
      ? counts.heldUnlistings + ' notices would have stopped being listed in one run; that is above the safety limit, so they were left live. Check the source before re-running.'
      : null,
  };

  const hist = await finishMeta(store, {
    lastRunAt: nowIso,
    lastSuccessAt: failed ? (await store.getMeta()).lastSuccessAt : nowIso,
    lastError: failed ? site.error : null,
    lastMode: mode,
    lastCounts: counts,
    lastFailureSafe: !!counts.heldUnlistings,
    site,
    datasetId,
  }, entry);

  return {
    ok: !failed,
    counts,
    site,
    runId,
    datasetId,
    historyWritten: hist.historyWritten,
    error: hist.historyWritten
      ? (failed ? observe.publicError(site.error) : null)
      : 'Ingest finished but history could not be saved. The existing published dataset remains active.',
  };
}

module.exports = { run, publishSite, buildRecord, daysAgo, writeIngested, MAX_UNLIST_ABS };
