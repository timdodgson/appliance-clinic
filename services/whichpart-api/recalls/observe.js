'use strict';

/**
 * Safety Ingest admin view-model. Does not fetch GOV.UK. Does not change
 * matching or eligibility. Explains the real ingest pipeline from stored meta
 * and the published DynamoDB dataset.
 */

const crypto = require('crypto');
const { FAMILIES, familyOf } = require('./families');
const { SOURCE_CATEGORIES } = require('./classify');
const govuk = require('./govuk');

const HISTORY_CAP = 20;
const LOCK_TTL_MS = 14 * 60 * 1000;
const SCHEDULE_HOUR_UTC = 6;
const OVERDUE_GRACE_MS = 2 * 60 * 60 * 1000;
const MATCHING_POLICY = [
  'Exact model identifiers can produce a strong match.',
  'Brand and family can produce a possible match. That is not confirmation a specific appliance is recalled.',
  'Fuzzy resemblance never creates a recalled-product claim.',
  'Diagnosis does not call the Recall Centre.',
];

const REASON_LABELS = {
  'excluded-non-appliance': 'Not an ApplianceClinic appliance',
  'no-family-match': 'Could not assign an appliance family',
  'unparsed': 'Source record could not be parsed',
  'fetch-failed': 'Could not fetch the source record',
  'invalid-source': 'Source record failed validation (previous live version kept)',
  'mass-unlisting-held': 'Unlisting held by the safety limit (still live)',
  'write-failed': 'Could not store the record (previous version kept)',
};

function reasonLabel(reason) {
  const r = String(reason || '');
  if (REASON_LABELS[r]) return REASON_LABELS[r];
  if (r.indexOf('ambiguous-product-type') === 0) return 'Ambiguous official product type';
  if (r.indexOf('ambiguous-name') === 0) return 'Ambiguous product name or title';
  return r || 'Unclassified filter';
}

function iso(d) { return (d || new Date()).toISOString(); }

function newRunId(now) {
  const t = (now || new Date()).toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
  return 'si-' + t + '-' + Math.random().toString(36).slice(2, 8);
}

function previousDailyUtc(now) {
  const n = now || new Date();
  let slot = Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate(), SCHEDULE_HOUR_UTC, 0, 0);
  if (n.getTime() < slot) slot -= 24 * 60 * 60 * 1000;
  return new Date(slot);
}

function nextDailyUtc(now) {
  const n = now || new Date();
  let slot = Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate(), SCHEDULE_HOUR_UTC, 0, 0);
  if (n.getTime() >= slot) slot += 24 * 60 * 60 * 1000;
  return new Date(slot).toISOString();
}

function datasetIdentity(records) {
  const rows = (records || [])
    .map((r) => String(r.contentId || '') + '|' + String(r.bodyHash || '') + '|' + String(r.state || ''))
    .sort();
  return crypto.createHash('sha256').update(rows.join('\n'), 'utf8').digest('hex');
}

function coverage(records) {
  const brands = Object.create(null);
  let exactModel = 0;
  let identityRange = 0;
  (records || []).forEach((r) => {
    if (r.brand) brands[String(r.brand)] = true;
    if (r.models && r.models.length) exactModel += 1;
    if (r.presentation && r.presentation.identityRangeNeeded) identityRange += 1;
  });
  return {
    uniqueBrands: Object.keys(brands).length,
    exactModelCapable: exactModel,
    identityRangeNeeded: identityRange,
  };
}

function lockActive(lock, now) {
  if (!lock || !lock.expiresAt) return false;
  return new Date(lock.expiresAt).getTime() > (now || new Date()).getTime();
}

function reconstructHistory(meta) {
  if (!meta || !meta.lastRunAt) return [];
  const counts = meta.lastCounts || {};
  return [{
    runId: 'recorded-' + String(meta.lastRunAt).replace(/[^0-9]/g, '').slice(0, 14),
    trigger: 'unknown',
    startedAt: meta.lastRunAt,
    completedAt: meta.lastRunAt,
    status: meta.lastError || meta.lastFailureSafe ? 'failed' : 'succeeded',
    source: 'UK OPSS via GOV.UK',
    mode: meta.lastMode || null,
    candidates: counts.candidates,
    fetched: counts.fetched,
    publishedThisRun: counts.published,
    livePublished: counts.livePublished,
    excluded: counts.excluded,
    review: counts.review,
    failed: counts.failed,
    reconstructed: true,
    note: 'Reconstructed from the last stored ingest summary. Filter reasons were not retained on that run.',
  }];
}

function statusOf(opts) {
  const now = opts.now || new Date();
  const published = opts.publishedCount || 0;
  const meta = opts.meta || {};
  const lock = opts.lock;
  if (opts.unavailable) {
    return { code: 'unavailable', label: 'Unavailable', detail: 'The recall store could not be read.' };
  }
  if (lockActive(lock, now)) {
    return { code: 'running', label: 'Running', detail: 'An ingest is in progress. The last-good published dataset remains available until this run finishes.' };
  }
  if (published === 0) {
    return { code: 'failed', label: 'Failed', detail: 'No published safety dataset is available.' };
  }
  if (meta.lastFailureSafe || (meta.lastError && meta.lastSuccessAt !== meta.lastRunAt)) {
    return {
      code: 'attention',
      label: 'Attention required',
      detail: 'The latest ingest did not complete successfully. The last-good published dataset is still serving customers.',
    };
  }
  if (meta.lastError) {
    return {
      code: 'attention',
      label: 'Attention required',
      detail: 'The latest ingest reported a publication problem. Check the latest run. The DynamoDB published dataset is still the customer API source.',
    };
  }
  const lastOk = meta.lastSuccessAt || meta.lastRunAt;
  if (lastOk) {
    const prev = previousDailyUtc(now);
    if (new Date(lastOk).getTime() < prev.getTime() - OVERDUE_GRACE_MS) {
      return {
        code: 'attention',
        label: 'Attention required',
        detail: 'Last successful ingest is overdue relative to the daily 06:00 UTC schedule. The published dataset is still serving customers.',
      };
    }
  }
  if (lastOk) {
    return {
      code: 'healthy',
      label: 'Healthy',
      detail: 'The latest ingest succeeded and a published dataset is available.',
    };
  }
  return {
    code: 'unknown',
    label: 'Unknown',
    detail: 'A published dataset is available but no ingest timestamp is stored.',
  };
}

function pipelineFromCounts(counts) {
  counts = counts || {};
  return [
    { id: 'source', label: 'Source candidates', count: counts.candidates, note: 'GOV.UK search hits in the two OPSS categories this run considered.' },
    { id: 'fetched', label: 'Fetched and parsed', count: counts.fetched, note: 'Official content documents that parsed with a content id.' },
    { id: 'published-run', label: 'Accepted this run', count: counts.published, note: 'Records classified into an ApplianceClinic family and stored as published.' },
    { id: 'live', label: 'Currently published', count: counts.livePublished, note: 'Published notices customers can use now.' },
  ];
}

function rejectionList(reasons) {
  const entries = Object.keys(reasons || {}).map((k) => ({
    reason: k,
    label: reasonLabel(k),
    count: reasons[k],
  })).filter((r) => r.count > 0).sort((a, b) => b.count - a.count);
  return {
    total: entries.reduce((n, r) => n + r.count, 0),
    items: entries,
  };
}

function appendHistory(prev, entry) {
  const list = [entry].concat(Array.isArray(prev) ? prev : []);
  return list.slice(0, HISTORY_CAP);
}

async function buildView(opts) {
  opts = opts || {};
  const now = opts.now || new Date();
  const store = opts.store;
  let meta;
  let rows;
  let lock = null;
  try {
    meta = await store.getMeta();
    rows = await store.listPublished();
    if (typeof store.getLock === 'function') lock = await store.getLock();
  } catch (e) {
    return {
      purpose: 'Official product-safety data used by ApplianceClinic.',
      status: statusOf({ unavailable: true, now, publishedCount: 0, meta: {}, lock: null }),
      error: 'Recall store unavailable',
    };
  }
  const history = (meta.history && meta.history.length) ? meta.history : reconstructHistory(meta);
  const latest = history[0] || null;
  const counts = (latest && !latest.reconstructed && meta.lastCounts) ? meta.lastCounts : (meta.lastCounts || {});
  const cov = coverage(rows);
  const identity = datasetIdentity(rows);
  const status = statusOf({ now, publishedCount: rows.length, meta, lock });
  return {
    purpose: 'Official product-safety data used by ApplianceClinic. This page operates the GOV.UK / OPSS ingest. It does not change diagnosis or recall matching.',
    status,
    source: {
      authority: 'UK Office for Product Safety and Standards',
      via: 'GOV.UK',
      type: 'Official government product-safety alerts, reports and recalls',
      searchUrl: govuk.SEARCH_URL,
      contentUrl: govuk.CONTENT_URL,
      categories: SOURCE_CATEGORIES.slice(),
      licence: 'Open Government Licence v3.0',
    },
    schedule: {
      label: 'Daily',
      time: '06:00 UTC',
      rule: 'whichpart-recall-ingest-daily',
      expression: 'cron(0 6 * * ? *)',
      nextExpectedAt: nextDailyUtc(now),
      note: 'The same Lambda handles the scheduled run and Run ingest.',
    },
    published: {
      count: rows.length,
      datasetId: identity,
      lastSuccessfulIngestAt: meta.lastSuccessAt || null,
      lastPublication: (meta.site && meta.site.records != null) ? meta.site : null,
      byFamily: FAMILIES.map((f) => ({
        id: f.id,
        slug: f.slug,
        name: f.name,
        count: rows.filter((r) => r.family === f.id).length,
      })),
      bySourceType: meta.lastCounts && meta.lastCounts.sourceTypes ? meta.lastCounts.sourceTypes : null,
      byYear: meta.lastCounts && meta.lastCounts.years ? meta.lastCounts.years : null,
      uniqueBrands: cov.uniqueBrands,
      exactModelCapable: cov.exactModelCapable,
      identityRangeNeeded: cov.identityRangeNeeded,
      publicHub: '/recalls/',
    },
    latestRun: latest,
    pipeline: pipelineFromCounts(Object.assign({}, counts, { livePublished: rows.length })),
    rejections: rejectionList((latest && latest.reasons) || {}),
    matching: {
      editable: false,
      policy: MATCHING_POLICY,
    },
    lastGood: {
      preservedOnFailedFetch: true,
      note: 'If GOV.UK cannot be fetched, existing published notices stay. A failed ingest does not empty the dataset.',
    },
    history,
    technical: {
      store: 'DynamoDB whichpart-recalls',
      htmlPublication: 'S3 pages under /recalls/ plus sitemap-recalls.xml (the recall child sitemap), written after records are stored.',
      lockTtlSeconds: LOCK_TTL_MS / 1000,
      dailyWindowDays: 4,
      concurrency: Number(process.env.RECALL_FETCH_CONCURRENCY || 6),
      htmlPublicationAtomicity: 'HTML pages are built as a complete set, then written. A mid-write S3 failure can leave some pages updated; the customer API reads DynamoDB, which is not wiped on failure.',
    },
  };
}

function publicError(err) {
  const s = String(err || '');
  if (/govuk-http-429/.test(s)) return 'OPSS rate-limited the request. The existing published dataset remains active.';
  if (/govuk-http-5/.test(s)) return 'OPSS returned a server error. The existing published dataset remains active.';
  if (/govuk-invalid-json/.test(s)) return 'OPSS returned a response that could not be read. The existing published dataset remains active.';
  if (/govuk-fetch|network|aborted|timeout/i.test(s)) return 'OPSS request failed or timed out. The existing published dataset remains active.';
  if (/s3-put/.test(s)) return 'Records were stored but HTML publication reported an error. The customer API still reads the stored published dataset.';
  if (/already running/i.test(s)) return 'Ingest already running.';
  return 'Ingest did not finish. The existing published dataset remains active.';
}

module.exports = {
  HISTORY_CAP,
  LOCK_TTL_MS,
  MATCHING_POLICY,
  reasonLabel,
  newRunId,
  previousDailyUtc,
  nextDailyUtc,
  datasetIdentity,
  coverage,
  lockActive,
  reconstructHistory,
  statusOf,
  pipelineFromCounts,
  rejectionList,
  appendHistory,
  buildView,
  publicError,
  familyOf,
};
