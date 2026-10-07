'use strict';

/**
 * DynamoDB store for normalised recall records + ingest meta.
 * Public list never returns review/excluded rows.
 */

const ddb = require('../ddb');
const { familyOf } = require('./families');
const { matchQuery, publicMatchDisclaimer } = require('./match');

const DEFAULT_TABLE = process.env.RECALL_TABLE || 'whichpart-recalls';
const GSI = process.env.RECALL_GSI || 'gsi_activity';
const META_PK = 'META#INGEST';
const LOCK_PK = 'LOCK#INGEST';

function table() { return process.env.RECALL_TABLE || DEFAULT_TABLE; }

function pkOf(id) { return 'RECORD#' + id; }

function searchBlob(rec) {
  return [
    rec.title, rec.productName, rec.brand, rec.modelText, rec.psdNumber,
    (rec.models || []).join(' '), rec.family, rec.slug,
  ].join(' ').toLowerCase().slice(0, 4000);
}

function gsiPk(rec) {
  return rec.state === 'published' ? 'PUB' : 'HOLD';
}

function gsiSk(rec) {
  return String(rec.alertDate || rec.publicUpdatedAt || '0000-00-00') + '#' + rec.slug;
}

// Physical revision of the stored row, for conditional writes. Kept out of the JSON body (_rev is
// attached on read and stripped on write). Rows written before this existed have no `rev` (= 0).
function stripInternal(rec) {
  const out = Object.assign({}, rec);
  delete out._rev;
  return out;
}
function preconditionError() {
  const e = new Error('recall record changed concurrently');
  e.code = 'precondition';
  return e;
}

function toItem(rec, rev) {
  const blob = searchBlob(rec);
  return ddb.compact({
    rev: rev ? ddb.S(String(rev)) : undefined,
    pk: ddb.S(pkOf(rec.contentId)),
    gsiPk: ddb.S(gsiPk(rec)),
    gsiSk: ddb.S(gsiSk(rec)),
    contentId: ddb.S(rec.contentId),
    slug: ddb.S(rec.slug),
    json: ddb.S(JSON.stringify(stripInternal(rec))),
    searchBlob: ddb.S(blob),
    family: rec.family ? ddb.S(rec.family) : undefined,
    state: ddb.S(rec.state),
    alertDate: rec.alertDate ? ddb.S(rec.alertDate) : undefined,
    lastCheckedAt: ddb.S(rec.lastCheckedAt),
    bodyHash: ddb.S(rec.bodyHash),
  });
}

function fromItem(item) {
  const raw = ddb.unmarshall(item);
  if (!raw.json) return null;
  try {
    const rec = JSON.parse(raw.json);
    Object.defineProperty(rec, '_rev', { value: Number(raw.rev || 0), enumerable: false, writable: true });
    return rec;
  } catch { return null; }
}

function emptyMeta() {
  return {
    lastRunAt: null,
    lastSuccessAt: null,
    lastError: null,
    lastMode: null,
    lastCounts: null,
    lastFailureSafe: false,
    history: [],
  };
}

function createMemoryStore(seed) {
  const records = new Map();
  const revs = new Map();
  let meta = emptyMeta();
  let lock = null;
  if (Array.isArray(seed)) seed.forEach((r) => records.set(r.contentId, JSON.parse(JSON.stringify(stripInternal(r)))));
  const out = (r) => {
    if (!r) return null;
    const c = JSON.parse(JSON.stringify(r));
    Object.defineProperty(c, '_rev', { value: revs.get(r.contentId) || 0, enumerable: false, writable: true });
    return c;
  };

  return {
    kind: 'memory',
    records,
    async get(id) { return out(records.get(id)); },
    async getBySlug(slug) {
      for (const r of records.values()) if (r.slug === slug) return out(r);
      return null;
    },
    /** opts.expectedRev (number) → conditional on the stored revision; omitted → unconditional (legacy). */
    async put(rec, opts) {
      const cur = revs.get(rec.contentId) || 0;
      if (opts && opts.expectedRev !== undefined && Number(opts.expectedRev) !== cur) throw preconditionError();
      records.set(rec.contentId, JSON.parse(JSON.stringify(stripInternal(rec))));
      revs.set(rec.contentId, cur + 1);
      return { rev: cur + 1 };
    },
    async listPublished() {
      return Array.from(records.values())
        .filter((r) => r.state === 'published')
        .sort((a, b) => String(b.alertDate).localeCompare(String(a.alertDate)))
        .map(out);
    },
    async listAll() {
      return Array.from(records.values())
        .sort((a, b) => String(b.alertDate).localeCompare(String(a.alertDate)))
        .map(out);
    },
    async getMeta() { return JSON.parse(JSON.stringify(meta)); },
    async putMeta(next) { meta = Object.assign(emptyMeta(), next); },
    async getLock() { return lock ? JSON.parse(JSON.stringify(lock)) : null; },
    async tryLock(info, now) {
      const t = (now || new Date()).getTime();
      if (lock && new Date(lock.expiresAt).getTime() > t) return { ok: false, lock: JSON.parse(JSON.stringify(lock)) };
      lock = {
        runId: info.runId,
        trigger: info.trigger,
        startedAt: info.startedAt,
        expiresAt: info.expiresAt,
      };
      return { ok: true };
    },
    async releaseLock(runId) {
      if (lock && lock.runId === runId) lock = null;
    },
  };
}

function createDynamoStore(opts) {
  const name = (opts && opts.table) || table();
  const dynamo = (opts && opts.dynamodb) || ((action, payload) => ddb.dynamodb(action, payload));

  async function get(id) {
    const res = await dynamo('GetItem', { TableName: name, Key: { pk: ddb.S(pkOf(id)) } });
    return fromItem(res.Item);
  }
  async function getBySlug(slug) {
    const published = await listPublished();
    for (const rec of published) if (rec.slug === slug) return rec;
    const hold = await queryAll({
      TableName: name,
      IndexName: GSI,
      KeyConditionExpression: 'gsiPk = :pk',
      ExpressionAttributeValues: { ':pk': ddb.S('HOLD') },
    });
    for (const rec of hold) if (rec.slug === slug) return rec;
    return null;
  }
  async function queryAll(params) {
    const out = [];
    let ExclusiveStartKey;
    do {
      const res = await dynamo('Query', Object.assign({}, params, ExclusiveStartKey ? { ExclusiveStartKey } : {}));
      for (const it of res.Items || []) {
        const rec = fromItem(it);
        if (rec) out.push(rec);
      }
      ExclusiveStartKey = res.LastEvaluatedKey;
    } while (ExclusiveStartKey);
    return out;
  }
  async function put(rec, opts) {
    const conditional = opts && opts.expectedRev !== undefined;
    const expected = conditional ? Number(opts.expectedRev) : Number(rec._rev || 0);
    const params = { TableName: name, Item: toItem(rec, expected + 1) };
    if (conditional) {
      if (expected === 0) params.ConditionExpression = 'attribute_not_exists(rev)';
      else {
        params.ConditionExpression = 'rev = :rev';
        params.ExpressionAttributeValues = { ':rev': ddb.S(String(expected)) };
      }
    }
    try {
      await dynamo('PutItem', params);
    } catch (e) {
      const msg = String((e && e.message) || e) + (e && e.body ? JSON.stringify(e.body) : '');
      if (/ConditionalCheckFailed/i.test(msg)) throw preconditionError();
      throw e;
    }
    return { rev: expected + 1 };
  }
  async function listAll() {
    const pub = await listPublished();
    const hold = await queryAll({
      TableName: name,
      IndexName: GSI,
      KeyConditionExpression: 'gsiPk = :pk',
      ExpressionAttributeValues: { ':pk': ddb.S('HOLD') },
    });
    return pub.concat(hold).sort((a, b) => String(b.alertDate || '').localeCompare(String(a.alertDate || '')));
  }
  async function listPublished(family) {
    const rows = await queryAll({
      TableName: name,
      IndexName: GSI,
      KeyConditionExpression: 'gsiPk = :pk',
      ExpressionAttributeValues: { ':pk': ddb.S('PUB') },
      ScanIndexForward: false,
    });
    const sorted = rows.sort((a, b) => String(b.alertDate || '').localeCompare(String(a.alertDate || '')));
    if (!family) return sorted;
    return sorted.filter((r) => r.family === family);
  }
  async function getMeta() {
    const res = await dynamo('GetItem', { TableName: name, Key: { pk: ddb.S(META_PK) } });
    const raw = ddb.unmarshall(res.Item);
    if (!raw.json) return emptyMeta();
    try { return JSON.parse(raw.json); } catch { return emptyMeta(); }
  }
  async function putMeta(next) {
    await dynamo('PutItem', {
      TableName: name,
      Item: ddb.compact({
        pk: ddb.S(META_PK),
        gsiPk: ddb.S('META'),
        gsiSk: ddb.S('INGEST'),
        json: ddb.S(JSON.stringify(next)),
      }),
    });
  }
  async function getLock() {
    const res = await dynamo('GetItem', { TableName: name, Key: { pk: ddb.S(LOCK_PK) } });
    const raw = ddb.unmarshall(res.Item);
    if (!raw.runId) return null;
    return {
      runId: raw.runId,
      trigger: raw.trigger || null,
      startedAt: raw.startedAt || null,
      expiresAt: raw.expiresAt || null,
    };
  }
  async function tryLock(info, now) {
    const nowIso = (now || new Date()).toISOString();
    try {
      await dynamo('PutItem', {
        TableName: name,
        Item: ddb.compact({
          pk: ddb.S(LOCK_PK),
          runId: ddb.S(info.runId),
          trigger: ddb.S(info.trigger || 'manual'),
          startedAt: ddb.S(info.startedAt),
          expiresAt: ddb.S(info.expiresAt),
        }),
        ConditionExpression: 'attribute_not_exists(pk) OR expiresAt < :now',
        ExpressionAttributeValues: { ':now': ddb.S(nowIso) },
      });
      return { ok: true };
    } catch (e) {
      const msg = String((e && e.message) || e);
      const body = e && e.body ? JSON.stringify(e.body) : '';
      if (/ConditionalCheckFailed/i.test(msg + body)) {
        return { ok: false, lock: await getLock() };
      }
      throw e;
    }
  }
  async function releaseLock(runId) {
    try {
      await dynamo('DeleteItem', {
        TableName: name,
        Key: { pk: ddb.S(LOCK_PK) },
        ConditionExpression: 'runId = :id',
        ExpressionAttributeValues: { ':id': ddb.S(runId) },
      });
    } catch (e) {
      const msg = String((e && e.message) || e);
      const body = e && e.body ? JSON.stringify(e.body) : '';
      if (/ConditionalCheckFailed/i.test(msg + body)) return;
      throw e;
    }
  }
  return { kind: 'dynamo', get, getBySlug, put, listPublished, listAll, getMeta, putMeta, getLock, tryLock, releaseLock };
}

function applyRevision(prev, next, nowIso) {
  const unchanged = prev && prev.bodyHash && prev.bodyHash === next.bodyHash;
  if (unchanged) {
    return {
      record: Object.assign({}, next, {
        firstSeenAt: prev.firstSeenAt,
        lastCheckedAt: nowIso,
        lastChangedAt: prev.lastChangedAt || prev.firstSeenAt,
        revisions: prev.revisions || [],
      }),
      changed: false,
    };
  }
  const revisions = ((prev && prev.revisions) || []).slice(-4);
  if (prev && prev.bodyHash) {
    revisions.push({
      at: nowIso,
      previousHash: prev.bodyHash,
      previousAlertDate: prev.alertDate || null,
      previousRiskLevel: prev.riskLevel || null,
      previousModels: prev.models || [],
    });
  }
  // Supersession: the previous OFFICIAL source content is kept verbatim (not just a hash) so an
  // updated notice never silently rewrites history: original → later source revision → current.
  const sourceRevisions = ((prev && prev.sourceRevisions) || []).slice();
  if (prev && prev.bodyHash) {
    const { sourceSnapshot, SOURCE_REVISION_CAP } = require('./lifecycle');
    sourceRevisions.push(Object.assign({ supersededAt: nowIso, firstSeenAt: prev.lastChangedAt || prev.firstSeenAt || null }, sourceSnapshot(prev)));
    while (sourceRevisions.length > SOURCE_REVISION_CAP) sourceRevisions.shift();
  }
  const record = Object.assign({}, next, {
    firstSeenAt: (prev && prev.firstSeenAt) || nowIso,
    lastCheckedAt: nowIso,
    lastChangedAt: nowIso,
    revisions,
    sourceRevisions,
  });
  return { record, changed: true };
}

function overview(rec) {
  const fam = familyOf(rec.family);
  return {
    id: rec.contentId,
    slug: rec.slug,
    title: rec.title,
    sourceType: rec.sourceType,
    family: rec.family,
    familySlug: fam ? fam.slug : null,
    familyName: fam ? fam.name : null,
    brand: rec.brand,
    productName: rec.productName,
    models: rec.models,
    alertDate: rec.alertDate,
    riskLevel: rec.riskLevel,
    sourceUrl: rec.sourceUrl,
    lastCheckedAt: rec.lastCheckedAt,
    identityRangeNeeded: !!(rec.presentation && rec.presentation.identityRangeNeeded),
    stopUseIndicatedBySource: !!(rec.presentation && rec.presentation.stopUseIndicatedBySource),
  };
}

function publicRecord(rec, q) {
  const fam = familyOf(rec.family);
  const match = q ? matchQuery({
    brand: rec.brand,
    models: rec.models,
    modelText: rec.modelText,
    productName: rec.productName,
    title: rec.title,
    family: rec.family,
    familyName: fam ? fam.name : '',
    searchBlob: searchBlob(rec),
    identityRangeNeeded: rec.presentation && rec.presentation.identityRangeNeeded,
  }, q) : { strength: null, label: null };
  return {
    id: rec.contentId,
    slug: rec.slug,
    url: '/recalls/' + rec.slug + '/',
    title: rec.title,
    sourceType: rec.sourceType,
    family: rec.family,
    familySlug: fam ? fam.slug : null,
    familyName: fam ? fam.name : null,
    hubPath: fam ? fam.hub : null,
    brand: rec.brand,
    productName: rec.productName,
    models: rec.models,
    modelText: rec.modelText,
    batchText: rec.batchText,
    serialText: rec.serialText,
    alertDate: rec.alertDate,
    riskLevel: rec.riskLevel,
    measureTypes: rec.measureTypes,
    hazard: rec.presentation ? rec.presentation.hazard : rec.hazard,
    whatToDo: rec.presentation ? rec.presentation.whatToDo : rec.correctiveAction,
    stopUseIndicatedBySource: !!(rec.presentation && rec.presentation.stopUseIndicatedBySource),
    identityRangeNeeded: !!(rec.presentation && rec.presentation.identityRangeNeeded),
    sourceUrl: rec.sourceUrl,
    sourceName: 'UK Office for Product Safety and Standards',
    manufacturerUrl: rec.manufacturerUrl,
    firstSeenAt: rec.firstSeenAt,
    lastCheckedAt: rec.lastCheckedAt,
    lastChangedAt: rec.lastChangedAt || null,
    withdrawn: rec.withdrawn || null,
    match: match.strength ? match : undefined,
    matchNote: publicMatchDisclaimer(match.strength, rec.presentation),
    attribution: 'Contains public sector information licensed under the Open Government Licence v3.0.',
  };
}

function paginate(rows, qs) {
  const limit = Math.min(50, Math.max(1, Number(qs && qs.limit) || 25));
  const cursor = qs && qs.cursor ? Number(qs.cursor) : 0;
  const start = Number.isFinite(cursor) && cursor > 0 ? cursor : 0;
  const slice = rows.slice(start, start + limit);
  const next = start + slice.length < rows.length ? String(start + slice.length) : null;
  return { items: slice, nextCursor: next, total: rows.length };
}

module.exports = {
  createMemoryStore,
  createDynamoStore,
  applyRevision,
  overview,
  publicRecord,
  paginate,
  searchBlob,
  emptyMeta,
  pkOf,
  META_PK,
  LOCK_PK,
};
