'use strict';

/**
 * Recall Centre — deterministic tests. No GOLD / no LLM.
 *   node services/whichpart-api/test/recalls.test.cjs
 */
const classify = require('../recalls/classify');
const parse = require('../recalls/parse');
const match = require('../recalls/match');
const storeMod = require('../recalls/store');
const ingest = require('../recalls/ingest');
const html = require('../recalls/html');
const govuk = require('../recalls/govuk');
const fixtures = require('./fixtures/opss-content');
const api = require('../index.js');

let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass++; console.log('  ok  - ' + name); }
  else { fail++; console.log('  FAIL- ' + name + (detail ? '  :: ' + detail : '')); }
}

function parsed(name) { return parse.parseContentDocument(fixtures[name]); }

console.log('PARSE');
{
  const w = parsed('foldingWasher');
  ok('washing machine type extracted', /Clothes Washers/i.test(w.productType));
  ok('PSD from title', w.psdNumber === '2601-0327');
  ok('source type is safety_report', w.sourceType === 'safety_report');
  ok('source URL is GOV.UK', w.sourceUrl.indexOf('https://www.gov.uk/product-safety-alerts-reports-recalls/') === 0);
  ok('does not store full HTML body', !w.body && w.bodyHash && w.bodyHash.length === 64);
  ok('attachments only from assets.publishing.service.gov.uk', w.attachments.every((a) => /assets\.publishing\.service\.gov.uk/.test(a.url)));
  const d = parsed('haierDryer');
  ok('models split', d.models.indexOf('HD90-A3S979') !== -1 && d.models.indexOf('HD80-A3S979') !== -1);
  ok('manufacturer https URL extracted', /haier\.com/.test(d.manufacturerUrl || ''));
  ok('batch text retained', /Serials/.test(d.batchText || ''));
  const h = parsed('hobPsdRows');
  ok('PSD-number table rows become models', h.models.indexOf('NA64H3030AS') !== -1 && h.models.indexOf('NA64H3000AK') !== -1);
  ok('brand inferred from product name when Brand column missing', h.brand === 'ExampleBrand');
}

console.log('CLASSIFY');
{
  ok('clothes washers → washing machine', classify.classify({ title: 'Folding Washing Machine', productType: 'Electrical appliances and equipment – Clothes Washers', productName: 'Folding Washing Machine' }).family === 'washing machine');
  ok('tumble dryers type → tumble-dryer', classify.classify({ title: 'Haier Heat Pump Tumble Dryer', productType: 'Electrical appliances and equipment – Tumble Dryers', productName: 'Haier Heat Pump Tumble Dryer' }).family === 'tumble-dryer');
  ok('cooking hobs → hobs', classify.classify({ title: 'Samsung Gas Hobs', productType: 'Gas appliances and components – Cooking Hobs', productName: 'Samsung Gas Hobs' }).publish === true);
  ok('EV charger excluded', classify.classify({ title: 'Wallbox Pulsar Max UK Electric Vehicle Charging Point', productType: 'Electrical appliances and equipment – Electric Vehicle Charging Point', productName: 'Wallbox Pulsar Max' }).state === 'excluded');
  ok('pressure washer excluded', classify.classify({ title: 'FAI TOP High Pressure Washer Gun', productName: 'High Pressure Washer Gun', productType: 'Pressure Washers' }).state === 'excluded');
  ok('generic electrical is not an appliance', classify.classify({ title: 'USB charger', productType: 'Electrical appliances and equipment', productName: 'USB charger' }).publish === false);
  ok('Hoover brand does not become a vacuum', classify.classify({ title: 'Hoover Heat Pump Tumble Dryer', productName: 'Hoover Heat Pump Tumble Dryer', productType: 'Electrical appliances and equipment – Tumble Dryers' }).family === 'tumble-dryer');
  ok('shoe dryer not a washing machine despite OPSS washer/dryer type', classify.classify({ title: 'Electric Shoe / Boot Dryer', productName: 'Electric Shoe / Boot Dryer', productType: 'Electrical appliances and equipment - Combination Clothes Washer/Dryers' }).state === 'excluded');
  ok('rice cooker not an oven', classify.classify({ title: 'Rice Robot', productName: 'Rice Robot', productType: 'Electrical appliances and equipment – Rice Cookers/Steamers' }).state === 'excluded');
  ok('vacuum battery charger excluded', classify.classify({ title: 'Battery Charger for vacuum cleaner', productName: 'Battery Charger QD-261078', productType: 'Electrical appliances and equipment – Battery Charger' }).state === 'excluded');
  ok('gas cooker hose excluded', classify.classify({ title: 'SALVUS micropoint gas cooker hoses', productName: 'SALVUS micropoint gas cooker hoses', productType: 'Gas appliances and components – Gas Hose' }).state === 'excluded');
  ok('range cooker with grill still an oven-cooker', classify.classify({ title: 'Belling Gas Range Cookers with Gas Grill', productName: 'Belling Gas Range Cookers', productType: 'Gas Appliances - Gas Range Cookers with Gas Grills' }).family === 'oven-cooker');
  ok('unpublished page is noindex', /noindex/.test(html.unpublishedPage({ slug: 'shoe-dryer', sourceUrl: 'https://www.gov.uk/product-safety-alerts-reports-recalls/shoe-dryer' })));
}

console.log('MATCH');
{
  const rec = { brand: 'Haier', models: ['HD90-A3S979'], modelText: 'HD90-A3S979, HD80-A3S979', productName: 'Haier Heat Pump Tumble Dryer', title: 'Haier Heat Pump Tumble Dryer', family: 'tumble-dryer', familyName: 'Tumble dryers', searchBlob: 'haier hd90-a3s979 tumble dryer' };
  ok('exact model is strong', match.matchQuery(rec, 'HD90-A3S979').strength === 'strong');
  ok('hyphen/case normalisation still strong', match.matchQuery(rec, 'hd90 a3s979').strength === 'strong');
  ok('brand-only is possible', match.matchQuery(rec, 'Haier tumble dryer').strength === 'possible');
  ok('family+brand query is possible when brand is in the title', match.matchQuery({ brand: 'Samsung', models: ['NA64H3030AS'], family: 'hobs', familyName: 'Hobs', productName: 'Samsung Gas Hobs', title: 'Samsung Gas Hobs', searchBlob: 'samsung gas hobs na64h3030as' }, 'Samsung hob').strength === 'possible');
  ok('unknown model is not strong', match.matchQuery(rec, 'WAN28281GB').strength !== 'strong');
  ok('possible disclaimer refuses confirmation', /not a confirmation/i.test(match.publicMatchDisclaimer('possible')));
}

console.log('INGEST IDEMPOTENCY + REVISION + FETCH FAIL');
(async function () {
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
      results: Object.keys(docs).map((link) => ({ link, title: docs[link].title, description: docs[link].description, public_timestamp: docs[link].public_updated_at })),
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
  const puts = [];
  const store = storeMod.createMemoryStore();
  const first = await ingest.run({ store, fetch: fetchOk, putObject: async (o) => { puts.push(o.key); }, now: new Date('2026-09-18T12:00:00Z'), mode: 'backfill' });
  ok('ingest ok', first.ok);
  ok('published only relevant families', first.counts.livePublished === 3, JSON.stringify(first.counts));
  ok('EV and pressure washer not published', first.counts.families['washing machine'] === 1 && first.counts.families['tumble-dryer'] === 1 && first.counts.families.hobs === 1);
  const second = await ingest.run({ store, fetch: fetchOk, putObject: async (o) => { puts.push(o.key); }, now: new Date('2026-09-18T13:00:00Z'), mode: 'backfill' });
  ok('second ingest creates no extra published rows', (await store.listPublished()).length === 3);
  ok('second ingest reports no new changes', second.counts.changed === 0 && second.counts.created === 0);
  const dryer = await store.get(fixtures.haierDryer.content_id);
  ok('stop-use taken from official wording', dryer.presentation.stopUseIndicatedBySource === true);
  ok('serial/batch uncertainty flagged', dryer.presentation.identityRangeNeeded === true);

  const expanded = JSON.parse(JSON.stringify(fixtures.haierDryer));
  expanded.details.body = expanded.details.body.replace('HD80-A3S979', 'HD80-A3S979, HD100-NEW');
  docs[fixtures.haierDryer.base_path] = expanded;
  const third = await ingest.run({ store, fetch: fetchOk, skipPublish: true, now: new Date('2026-09-19T12:00:00Z'), mode: 'backfill' });
  const dryer2 = await store.get(fixtures.haierDryer.content_id);
  ok('changed source creates a revision', third.counts.changed === 1 && dryer2.revisions.length === 1);
  ok('current models reflect the new source', dryer2.models.indexOf('HD100-NEW') !== -1);

  const failStore = storeMod.createMemoryStore([dryer2]);
  const fetchFail = () => Promise.reject(new Error('network'));
  const failed = await ingest.run({ store: failStore, fetch: fetchFail, skipPublish: true, now: new Date('2026-09-20T12:00:00Z') });
  ok('failed source fetch does not delete existing', failed.failedFetch === true && (await failStore.listPublished()).length === 1);
  ok('failed fetch is recorded on meta', (await failStore.getMeta()).lastFailureSafe === true);

  console.log('HTML / ATTRIBUTION / SITEMAP');
  const page = html.recordPage(dryer2);
  ok('record page cites OPSS', /According to the UK Office for Product Safety and Standards/.test(page));
  ok('record page does not claim ApplianceClinic issued it', /did not issue this notice/.test(page));
  ok('canonical record URL', /rel="canonical" href="https:\/\/applianceclinic.ai\/recalls\/haier-heat-pump-tumble-dryer-corrective-action-programme\/"/.test(page));
  ok('GOV.UK link present', page.indexOf(dryer2.sourceUrl) !== -1);
  ok('OGL attribution', /Open Government Licence v3.0/.test(page));
  ok('does not copy a giant GOV.UK dump', page.indexOf('<h2 id="hazard">') === -1);
  const sm = html.sitemapRecallsXml([dryer2], '2026-09-18');
  ok('recall sitemap includes family + record, not search URLs',
    sm.indexOf('/recalls/' + dryer2.slug + '/') !== -1
    && sm.indexOf('<loc>https://applianceclinic.ai/recalls/tumble-dryers/</loc>') !== -1
    && sm.indexOf('?q=') === -1);
  ok('recall sitemap is recall-only (no core home/hub URLs — those are in sitemap-core.xml)',
    sm.indexOf('<loc>https://applianceclinic.ai/</loc>') === -1
    && sm.indexOf('<loc>https://applianceclinic.ai/washing-machines/</loc>') === -1
    && sm.indexOf('<loc>https://applianceclinic.ai/recalls/</loc>') === -1);
  const smEmpty = html.sitemapRecallsXml([], '2026-09-18');
  ok('empty recall sitemap is a valid urlset with no URLs (no fabricated recall URLs)',
    /<urlset xmlns="http:\/\/www\.sitemaps\.org\/schemas\/sitemap\/0\.9">/.test(smEmpty)
    && /<\/urlset>/.test(smEmpty) && smEmpty.indexOf('<loc>') === -1);
  const hub = html.indexPage([dryer2], '2026-09-18T12:00:00Z');
  ok('hub explains recall vs report vs alert', /Product recall/.test(hub) && /Product safety report/.test(hub) && /Product safety alert/.test(hub));
  ok('search form does not advertise indexable result pages', /does not create a public URL for every query/.test(hub));
  const famEmpty = html.familyPage('tumble-dryer', [], '2026-09-18T00:00:00Z');
  ok('empty family page is not a thin manufacturer mill', /Tumble dryers safety notices/.test(famEmpty) && /GOV\.UK/.test(famEmpty));
  ok('family page has no query-string mill', !/q=bosch/.test(famEmpty));
  const pubOnly = await ingest.run({ store, fetch: fetchOk, putObject: async (o) => { puts.push(o.key); }, now: new Date('2026-09-18T14:00:00Z'), mode: 'publish' });
  ok('publish-only mode does not create records', pubOnly.ok && pubOnly.counts.mode === 'publish');
  ok('ingest writes the recall child sitemap only, never the index/core',
    puts.indexOf('sitemap-recalls.xml') !== -1
    && puts.indexOf('sitemap.xml') === -1
    && puts.indexOf('sitemap-core.xml') === -1);

  console.log('SSRF / SOURCE URLS');
  let threw = false;
  try { await govuk.getContent('/etc/passwd'); } catch (e) { threw = true; }
  ok('content path outside OPSS prefix is rejected', threw);
  threw = false;
  try { await govuk.getContent('/product-safety-alerts-reports-recalls/../../secret'); } catch (e) { threw = true; }
  ok('path traversal rejected', threw);

  console.log('PUBLIC / ADMIN API BOUNDARY');
  const mem = storeMod.createMemoryStore();
  await ingest.run({ store: mem, fetch: fetchOk, skipPublish: true, now: new Date('2026-09-18T12:00:00Z') });
  api.setRecallStore(mem);
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
  const list = JSON.parse((await invoke('GET', '/api/recalls')).body);
  ok('public list only published rows', list.total === 3 && list.items.every((i) => i.sourceUrl.indexOf('https://www.gov.uk/') === 0));
  ok('public list has no classification internals', list.items.every((i) => i.classification == null && i.bodyHash == null));
  const one = await invoke('GET', '/api/recalls/record', { qs: { id: dryer2.slug } });
  ok('public record by slug', one.statusCode === 200 && JSON.parse(one.body).brand === 'Haier');
  const missing = await invoke('GET', '/api/recalls/record', { qs: { id: 'no-such-recall' } });
  ok('unknown record is 404', missing.statusCode === 404);
  const lookup = JSON.parse((await invoke('GET', '/api/recalls/lookup', { qs: { q: 'HD90-A3S979' } })).body);
  ok('lookup strong-match for exact model', lookup.items[0].match.strength === 'strong');
  const unauth = await invoke('GET', '/api/admin/recalls/status');
  ok('admin status unauthenticated is 401', unauth.statusCode === 401);
  const unauthIngest = await invoke('POST', '/api/admin/recalls/ingest', { body: '{}' });
  ok('admin ingest unauthenticated is 401', unauthIngest.statusCode === 401);
  const unauthSi = await invoke('GET', '/api/admin/safety-ingest');
  ok('safety-ingest unauthenticated is 401', unauthSi.statusCode === 401);
  const unauthSiRun = await invoke('POST', '/api/admin/safety-ingest/run', { body: '{}' });
  ok('safety-ingest run unauthenticated is 401', unauthSiRun.statusCode === 401);
  const shortQ = await invoke('GET', '/api/recalls/lookup', { qs: { q: 'x' } });
  ok('lookup requires at least 2 characters', shortQ.statusCode === 400);
  const stillDiag = await invoke('POST', '/api');
  ok('diagnosis contract unchanged: no messages → 400', stillDiag.statusCode === 400);

  console.log('GAS HOB CLUSTER + TWO-WAY HUB LINKING');
  {
    const gh = (slug, brand, name, date) => ({
      contentId: slug, slug, family: 'hobs', sourceCategory: 'gas-appliances-and-components',
      sourceType: 'safety_report', riskLevel: 'serious', alertDate: date, brand,
      productName: name, title: name, productType: 'Gas appliances and components – Cooking Hobs',
      modelText: '', models: [], sourceUrl: 'https://www.gov.uk/product-safety-alerts-reports-recalls/' + slug,
      presentation: { hazard: 'Gas leak at an elbow joint.', whatToDo: 'Contact the manufacturer.', stopUseIndicatedBySource: true, identityRangeNeeded: false },
      lastCheckedAt: '2026-09-18',
    });
    const gasHobs = [
      gh('product-safety-report-samsung-gas-hobs', 'Samsung', 'Samsung Gas Hobs', '2023-09-28'),
      gh('product-safety-report-swan-gas-hobs', 'Swan', 'Swan Gas Hobs', '2023-09-07'),
      gh('product-safety-report-caple-gas-hobs', 'Caple', 'Caple Gas Hobs', '2023-07-06'),
    ];
    const inductionHob = { contentId: 'ind', slug: 'roronron-induction-cooker', family: 'hobs', sourceCategory: 'electrical-appliances-equipment', sourceType: 'safety_report', riskLevel: 'high', alertDate: '2023-01-27', brand: 'Roronron', productName: 'Roronron Induction Cooker RR-915', title: 'Roronron Induction Cooker RR-915', productType: 'Electrical appliances and equipment', modelText: 'RR-915', sourceUrl: 'https://www.gov.uk/product-safety-alerts-reports-recalls/roronron-induction-cooker', presentation: {} };
    const dryer = { contentId: 'd', slug: 'haier-dryer', family: 'tumble-dryer', sourceType: 'recall', riskLevel: 'high', alertDate: '2025-08-01', brand: 'Haier', productName: 'Haier Heat Pump Tumble Dryer', title: 'Haier Heat Pump Tumble Dryer', productType: 'Electrical appliances and equipment – Tumble Dryers', sourceUrl: 'https://www.gov.uk/product-safety-alerts-reports-recalls/haier-dryer', presentation: {} };
    const all = gasHobs.concat([inductionHob, dryer]);

    // Gas detection reads structured family + a reliable gas signal, not a model list.
    ok('isGasHob matches gas hobs only', gasHobs.every(html.isGasHob) && !html.isGasHob(inductionHob) && !html.isGasHob(dryer));
    ok('gasHobRecords filters to the three gas hobs', html.gasHobRecords(all).length === 3);

    const cluster = html.gasHobClusterPage(all, '2026-09-18T00:00:00Z');
    ok('cluster H1 + unique title + self-canonical + index,follow',
      /<h1>Gas hob recalls and safety notices<\/h1>/.test(cluster)
      && /<title>Gas hob recalls and safety notices in the UK \| ApplianceClinic<\/title>/.test(cluster)
      && /rel="canonical" href="https:\/\/applianceclinic.ai\/recalls\/gas-hobs\/"/.test(cluster)
      && /name="robots" content="index,follow"/.test(cluster));
    ok('cluster scope summary is generated from the data (count + year)',
      /classified 3 gas hob safety notices/.test(cluster) && /2023/.test(cluster));
    ok('cluster links to every gas hob detail notice',
      gasHobs.every((r) => cluster.indexOf('/recalls/' + r.slug + '/') !== -1));
    ok('cluster excludes the induction hob and the tumble dryer',
      cluster.indexOf('/recalls/roronron-induction-cooker/') === -1 && cluster.indexOf('/recalls/haier-dryer/') === -1);
    ok('cluster links to the hobs hub and the recall centre',
      /href="\/hobs\/"/.test(cluster) && /href="\/recalls\/"/.test(cluster));
    ok('cluster uses neutral per-notice action wording, not one universal instruction',
      /Follow the action stated on the individual recall notice/.test(cluster) && /not identical/.test(cluster));
    ok('cluster carries OPSS/GOV.UK + OGL attribution',
      /gov\.uk\/product-safety-alerts-reports-recalls/.test(cluster) && /Open Government Licence v3.0/.test(cluster));
    ok('cluster schema is CollectionPage + BreadcrumbList, no FAQ/rating',
      /"@type":"CollectionPage"/.test(cluster) && /"BreadcrumbList"/.test(cluster)
      && !/FAQPage/.test(cluster) && !/AggregateRating/.test(cluster));

    // Sitemap: cluster listed exactly once when >= threshold, absent below it.
    const sm = html.sitemapRecallsXml(all, '2026-09-18');
    ok('recall sitemap lists the cluster exactly once', (sm.match(/\/recalls\/gas-hobs\//g) || []).length === 1);
    ok('recall sitemap still lists per-record notices (no duplication of recall facts)',
      sm.indexOf('/recalls/product-safety-report-samsung-gas-hobs/') !== -1);
    const smLow = html.sitemapRecallsXml([gasHobs[0], dryer], '2026-09-18');
    ok('recall sitemap omits the cluster below the threshold', smLow.indexOf('/recalls/gas-hobs/') === -1);

    // Recall detail -> correct family hub, with the "does not override" context.
    const samsungPage = html.recordPage(gasHobs[0]);
    ok('gas hob detail links to the hobs hub (structured family), not a wrong family',
      samsungPage.indexOf('href="/hobs/"') !== -1
      && samsungPage.indexOf('href="/tumble-dryers/"') === -1
      && samsungPage.indexOf('href="/vacuum-cleaners/"') === -1);
    ok('gas hob detail states ApplianceClinic help does not override the notice',
      /does not override|does <strong>not<\/strong> override/i.test(samsungPage));
    ok('gas hob detail still cites OPSS and keeps the official GOV.UK record link',
      /According to the UK Office for Product Safety/.test(samsungPage) && samsungPage.indexOf(gasHobs[0].sourceUrl) !== -1);
    const dryerPage = html.recordPage(dryer);
    ok('tumble dryer detail links to the tumble-dryers hub, not the hobs hub',
      dryerPage.indexOf('href="/tumble-dryers/"') !== -1 && dryerPage.indexOf('href="/hobs/"') === -1);

    // Family recall page -> matching hub only (restrained).
    const hobsFam = html.familyPage('hobs', gasHobs, '2026-09-18T00:00:00Z');
    ok('hobs family recall page links to the hobs hub', hobsFam.indexOf('href="/hobs/"') !== -1);
    const dryerFam = html.familyPage('tumble-dryer', [dryer], '2026-09-18T00:00:00Z');
    ok('tumble family recall page links to its own hub, not hobs',
      dryerFam.indexOf('href="/tumble-dryers/"') !== -1 && dryerFam.indexOf('href="/hobs/"') === -1);
  }

  console.log('\nrecalls tests: ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
