'use strict';

/**
 * Public and admin HTTP for the Recall Centre.
 * Public responses expose only published records.
 */

const { familyOf, FAMILIES } = require('./families');
const storeMod = require('./store');
const ingest = require('./ingest');
const { matchQuery } = require('./match');
const observe = require('./observe');

function query(event) {
  return (event && event.queryStringParameters) || {};
}

function cap(s, n) {
  return String(s || '').slice(0, n);
}

function filterRows(rows, qs) {
  const family = qs.family ? cap(qs.family, 40) : '';
  const fam = familyOf(family);
  const q = cap(qs.q, 80).trim();
  let out = rows;
  if (fam) out = out.filter((r) => r.family === fam.id);
  if (q.length >= 2) {
    out = out.map((r) => {
      const m = matchQuery({
        brand: r.brand,
        models: r.models,
        modelText: r.modelText,
        productName: r.productName,
        title: r.title,
        family: r.family,
        familyName: (familyOf(r.family) || {}).name,
        searchBlob: storeMod.searchBlob(r),
      }, q);
      return { rec: r, match: m };
    }).filter((x) => x.match.strength === 'strong' || x.match.strength === 'possible')
      .sort((a, b) => (a.match.strength === 'strong' ? 0 : 1) - (b.match.strength === 'strong' ? 0 : 1))
      .map((x) => x.rec);
  }
  return out;
}

function createHandlers(getStore, runIngest) {
  async function publicList(event) {
    const qs = query(event);
    const rows = await getStore().listPublished();
    const filtered = filterRows(rows, qs);
    const page = storeMod.paginate(filtered, qs);
    return {
      generatedAt: new Date().toISOString(),
      attribution: 'UK Office for Product Safety and Standards via GOV.UK. Contains public sector information licensed under the Open Government Licence v3.0.',
      total: page.total,
      nextCursor: page.nextCursor,
      items: page.items.map((r) => storeMod.publicRecord(r, qs.q)),
      families: FAMILIES.map((f) => ({
        id: f.id,
        slug: f.slug,
        name: f.name,
        count: rows.filter((r) => r.family === f.id).length,
      })),
    };
  }

  async function publicGet(event) {
    const qs = query(event);
    const id = cap(qs.id || qs.slug, 120);
    if (!id) return { status: 400, body: { error: 'id required' } };
    let rec = null;
    if (/^[0-9a-f-]{36}$/i.test(id)) rec = await getStore().get(id);
    if (!rec) rec = await getStore().getBySlug(id);
    if (!rec || rec.state !== 'published') return { status: 404, body: { error: 'not found' } };
    return { status: 200, body: storeMod.publicRecord(rec, qs.q) };
  }

  async function publicLookup(event) {
    const qs = query(event);
    const q = cap(qs.q, 80).trim();
    const family = cap(qs.family, 40);
    if (q.length < 2) return { status: 400, body: { error: 'q required' } };
    const rows = filterRows(await getStore().listPublished(), { q, family });
    return {
      status: 200,
      body: {
        q,
        total: rows.length,
        items: rows.slice(0, 25).map((r) => storeMod.publicRecord(r, q)),
        note: 'A possible match is not confirmation that a specific appliance is recalled. Check the official GOV.UK record, including serial or batch details where given.',
      },
    };
  }

  async function adminStatus() {
    return observe.buildView({ store: getStore() });
  }

  async function adminHistory() {
    const view = await observe.buildView({ store: getStore() });
    return { history: view.history || [], latestRun: view.latestRun || null };
  }

  async function adminRunGet(event) {
    const qs = query(event);
    const id = cap(qs.id, 80);
    if (!id) return { status: 400, body: { error: 'id required' } };
    const view = await observe.buildView({ store: getStore() });
    const run = (view.history || []).find((r) => r.runId === id);
    if (!run) return { status: 404, body: { error: 'not found' } };
    return { status: 200, body: run };
  }

  // Manual ingest from Admin. The trigger is always 'manual' and the actor is the authenticated session —
  // a client can no longer label its run 'scheduled' or skip the public-page refresh.
  async function adminIngest(event, actor) {
    let body = {};
    try { body = JSON.parse(event.body || '{}'); } catch { body = {}; }
    const requested = body.mode;
    const mode = requested === 'backfill' ? 'backfill' : (requested === 'publish' ? 'publish' : 'daily');
    const result = await (runIngest || ingest.run)({
      store: getStore(),
      mode,
      trigger: 'manual',
      actor: actor || null,
    });
    if (result && result.running) {
      const view = await observe.buildView({ store: getStore() });
      return Object.assign({ ok: false, status: 409 }, result, { view });
    }
    const view = await observe.buildView({ store: getStore() });
    return Object.assign({}, result, { view });
  }

  return { publicList, publicGet, publicLookup, adminStatus, adminHistory, adminRunGet, adminIngest };
}

module.exports = { createHandlers, filterRows };
