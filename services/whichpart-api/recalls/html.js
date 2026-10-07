'use strict';

/**
 * Server-rendered Recall Centre HTML. Authoritative claims are labelled as OPSS/GOV.UK.
 * ApplianceClinic does not issue recalls.
 */

const { FAMILIES, familyOf } = require('./families');

const CANON = 'https://applianceclinic.ai';
const CSS_V = '33';
const OGL = 'Contains public sector information licensed under the Open Government Licence v3.0.';
const OGL_URL = 'https://www.nationalarchives.gov.uk/doc/open-government-licence/version/3/';

// Curated gas-hob cluster. The cluster is generated from the live recall data
// (structured family + a gas signal) — never from a hand-maintained model list.
const GAS_HOB_SLUG = 'gas-hobs';
const GAS_HOB_CLUSTER_MIN = 3; // only worth a curated overview above a real cluster

function isGasHob(rec) {
  if (!rec || rec.family !== 'hobs') return false;
  if (rec.sourceCategory === 'gas-appliances-and-components') return true;
  const t = [rec.productName, rec.title, rec.productType, rec.modelText].join(' ');
  return /\bgas\b/i.test(t);
}

function gasHobRecords(records) {
  return (records || []).filter(isGasHob)
    .sort((a, b) => String(b.alertDate || '').localeCompare(String(a.alertDate || '')));
}

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function typeLabel(t) {
  if (t === 'recall') return 'Product recall';
  if (t === 'safety_report') return 'Product safety report';
  if (t === 'safety_alert') return 'Product safety alert';
  return 'Safety notice';
}

function riskLabel(r) {
  if (!r || r === 'not-provided') return 'Not provided by OPSS';
  return r.charAt(0).toUpperCase() + r.slice(1);
}

function fmtDate(d) {
  if (!d) return '';
  const m = String(d).match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return esc(d);
  const months = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  return Number(m[3]) + ' ' + months[Number(m[2]) - 1] + ' ' + m[1];
}

function shell(opts) {
  const url = opts.canonical;
  const robots = opts.robots || 'index,follow';
  const ld = opts.jsonLd ? '<script type="application/ld+json">\n' + JSON.stringify(opts.jsonLd).replace(/</g, '\\u003c') + '\n  </script>' : '';
  return `<!doctype html>
<html lang="en-GB">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
  <title>${esc(opts.title)}</title>
  <meta name="description" content="${esc(opts.description)}" />
  <meta name="robots" content="${esc(robots)}" />
  <meta name="theme-color" content="#ffffff" />
  <link rel="canonical" href="${esc(url)}" />
  <link rel="icon" type="image/svg+xml" href="/assets/applianceclinic-mark.svg?v=3" />
  <link rel="apple-touch-icon" href="/assets/applianceclinic-icon-180.png?v=1" />
  <link rel="manifest" href="/site.webmanifest?v=4" />
  <meta property="og:type" content="website" />
  <meta property="og:locale" content="en_GB" />
  <meta property="og:url" content="${esc(url)}" />
  <meta property="og:site_name" content="ApplianceClinic" />
  <meta property="og:title" content="${esc(opts.title)}" />
  <meta property="og:description" content="${esc(opts.description)}" />
  <meta property="og:image" content="${CANON}/assets/applianceclinic-og.png?v=1" />
  ${ld}
  <link rel="stylesheet" href="/styles.css?v=${CSS_V}" />
</head>
<body class="ac hub recall">
  <a class="skip-link" href="#hub-main">Skip to content</a>
  <header class="topbar">
    <div class="topbar__inner">
      <a class="topbar__brand" href="/" aria-label="ApplianceClinic home">
        <img class="topbar__logo-img" src="/assets/applianceclinic-logo.svg?v=3" alt="ApplianceClinic" width="200" height="32" decoding="async" />
      </a>
      <div class="topbar__cluster">
        <a class="btn btn--ghost topbar__newchat" href="/#ask">Diagnose</a>
        <nav class="topbar__nav" aria-label="Main">
          <a class="topbar__link" href="/#appliances">Appliance help</a>
          <a class="topbar__link" href="/recalls/" aria-current="page">Safety &amp; recalls</a>
        </nav>
      </div>
    </div>
  </header>
  <div class="app-banner app-banner--offline" id="recallOffline" hidden role="status">
    <p class="app-banner__text">You’re offline. Safety notices on this page may be out of date — check GOV.UK when you are back online. The date we last checked the official record is shown on each notice.</p>
  </div>
  <main class="wrap hub-wrap" id="hub-main">
    ${opts.body}
  </main>
  <script src="/recalls/recalls.js?v=1"></script>
</body>
</html>
`;
}

function crumbs(items) {
  return '<nav class="hub-crumbs" aria-label="Breadcrumb">'
    + items.map(function (it, i) {
      if (!it.href || i === items.length - 1) return '<span>' + esc(it.name) + '</span>';
      return '<a href="' + esc(it.href) + '">' + esc(it.name) + '</a><span aria-hidden="true"> / </span>';
    }).join('')
    + '</nav>';
}

function noticeCard(rec) {
  const fam = familyOf(rec.family);
  return '<article class="recall-card">'
    + '<p class="recall-card__meta">' + esc(typeLabel(rec.sourceType)) + ' · ' + esc(riskLabel(rec.riskLevel)) + ' · ' + esc(fmtDate(rec.alertDate)) + '</p>'
    + '<h3><a href="/recalls/' + esc(rec.slug) + '/">' + esc(rec.productName || rec.title) + '</a></h3>'
    + '<p>' + esc([rec.brand, fam && fam.name].filter(Boolean).join(' · ')) + '</p>'
    + '</article>';
}

function indexPage(records, generatedAt) {
  const recent = (records || []).slice(0, 12);
  const counts = {};
  FAMILIES.forEach((f) => { counts[f.id] = 0; });
  (records || []).forEach((r) => { if (r.family) counts[r.family] = (counts[r.family] || 0) + 1; });
  const famNav = FAMILIES.map((f) => {
    const n = counts[f.id] || 0;
    if (!n) return '';
    return '<li><a href="/recalls/' + f.slug + '/">' + esc(f.name) + ' <span>' + n + '</span></a></li>';
  }).filter(Boolean).join('');

  const body = crumbs([{ name: 'Home', href: '/' }, { name: 'Safety recalls' }])
    + '<header class="hub-hero">'
    + '<p class="hub-kicker">UK appliance safety</p>'
    + '<h1>Appliance Safety &amp; Recall Centre</h1>'
    + '<p class="hub-intro">Check whether the UK Office for Product Safety and Standards has published a recall, safety report or safety alert that may affect your household appliance — and what the official notice says you should do.</p>'
    + '<p class="recall-source">ApplianceClinic does not issue recalls. Every notice here is taken from <a href="https://www.gov.uk/product-safety-alerts-reports-recalls" rel="noopener noreferrer">GOV.UK Product Safety Alerts, Reports and Recalls</a> (OPSS) and links back to that record.</p>'
    + '</header>'
    + '<section class="hub-section" id="how">'
    + '<h2>What these notices mean</h2>'
    + '<div class="hub-grid hub-grid--2">'
    + '<article class="hub-card"><h3>Product recall</h3><p>A specific product sold in the UK may need a free repair, replacement or refund. The manufacturer or a retailer usually handles the action.</p></article>'
    + '<article class="hub-card"><h3>Product safety report</h3><p>A product found in the UK where another corrective measure is underway — for example a modification programme, a warning, or goods stopped at the border.</p></article>'
    + '<article class="hub-card"><h3>Product safety alert</h3><p>A wider warning about a category or sector where OPSS is asking businesses, authorities or consumers to take immediate steps.</p></article>'
    + '<article class="hub-card"><h3>Check the official record</h3><p>Model, serial, batch and date-range details matter. We will not tell you your appliance is recalled from a similar-looking name. Follow the GOV.UK instructions.</p></article>'
    + '</div></section>'
    + '<section class="hub-section" id="search">'
    + '<h2>Find a notice</h2>'
    + '<form class="recall-search" id="recallSearch" method="get" action="/recalls/" role="search">'
    + '<label class="recall-search__label" for="recallQ">Manufacturer or model</label>'
    + '<div class="recall-search__row">'
    + '<input id="recallQ" name="q" type="search" maxlength="80" placeholder="e.g. Bosch washing machine or WAN28281GB" autocomplete="off" />'
    + '<button class="btn btn--primary" type="submit">Search</button>'
    + '</div>'
    + '<p class="hub-lead">Search runs on this page. It does not create a public URL for every query.</p>'
    + '</form>'
    + '<div id="recallResults" hidden role="status" aria-live="polite"></div>'
    + '</section>'
    + '<section class="hub-section" id="families">'
    + '<h2>Browse by appliance</h2>'
    + '<ul class="recall-fams">' + (famNav || '<li>No relevant notices are published yet.</li>') + '</ul>'
    + '</section>'
    + '<section class="hub-section" id="recent">'
    + '<h2>Recent appliance notices</h2>'
    + '<p class="hub-lead">Last refreshed from GOV.UK ' + esc(fmtDate((generatedAt || '').slice(0, 10)) || generatedAt || '') + '. This is not a complete list of every UK product recall — only household appliances ApplianceClinic covers.</p>'
    + '<div class="recall-list">' + (recent.map(noticeCard).join('') || '<p>No relevant notices yet.</p>') + '</div>'
    + '</section>'
    + '<footer class="site-footer"><nav class="site-footer__nav" aria-label="On this page">'
    + '<a href="/#ask">Start diagnosis</a><a href="/">Home</a><a href="https://www.gov.uk/product-safety-alerts-reports-recalls">OPSS on GOV.UK</a>'
    + '</nav><p class="site-footer__line">' + esc(OGL) + ' <a href="' + OGL_URL + '">Licence</a>.</p></footer>';

  return shell({
    title: 'UK appliance safety recalls and notices | ApplianceClinic',
    description: 'Check UK washing machine, tumble dryer, cooker, fridge and vacuum safety recalls and OPSS notices. Official GOV.UK source, explained in plain English.',
    canonical: CANON + '/recalls/',
    jsonLd: {
      '@context': 'https://schema.org',
      '@graph': [
        { '@type': 'CollectionPage', '@id': CANON + '/recalls/#webpage', url: CANON + '/recalls/', name: 'UK appliance safety recalls and notices', inLanguage: 'en-GB', isPartOf: { '@id': CANON + '/#website' } },
        { '@type': 'BreadcrumbList', itemListElement: [
          { '@type': 'ListItem', position: 1, name: 'Home', item: CANON + '/' },
          { '@type': 'ListItem', position: 2, name: 'Safety recalls', item: CANON + '/recalls/' },
        ] },
      ],
    },
    body,
  });
}

function familyPage(family, records, generatedAt) {
  const fam = familyOf(family);
  const list = (records || []).filter((r) => r.family === fam.id);
  const url = CANON + '/recalls/' + fam.slug + '/';
  const body = crumbs([{ name: 'Home', href: '/' }, { name: 'Safety recalls', href: '/recalls/' }, { name: fam.name }])
    + '<header class="hub-hero">'
    + '<p class="hub-kicker">UK appliance safety</p>'
    + '<h1>' + esc(fam.name) + ' safety notices</h1>'
    + '<p class="hub-intro">Official UK OPSS recalls, safety reports and alerts that ApplianceClinic has classified as ' + esc(fam.name.toLowerCase()) + '. Always confirm the model on GOV.UK.</p>'
    + '<div class="hub-cta-row"><a class="btn btn--ghost" href="' + esc(fam.hub) + '">' + esc(fam.name) + ' help hub</a><a class="btn btn--primary" href="/#ask">Diagnose a fault</a></div>'
    + '</header>'
    + '<section class="hub-section"><h2>Notices</h2>'
    + '<p class="hub-lead">Updated ' + esc(fmtDate((generatedAt || '').slice(0, 10))) + '.</p>'
    + '<div class="recall-list">' + (list.map(noticeCard).join('') || '<p>No current notices in this family.</p>') + '</div></section>'
    + '<footer class="site-footer"><p class="site-footer__line">' + esc(OGL) + '</p></footer>';
  return shell({
    title: fam.name + ' safety recalls and notices | ApplianceClinic',
    description: 'UK ' + fam.name.toLowerCase() + ' recalls and OPSS safety notices, with official GOV.UK links and what owners are asked to do.',
    canonical: url,
    jsonLd: {
      '@context': 'https://schema.org',
      '@graph': [
        { '@type': 'CollectionPage', url: url, name: fam.name + ' safety notices', inLanguage: 'en-GB' },
        { '@type': 'BreadcrumbList', itemListElement: [
          { '@type': 'ListItem', position: 1, name: 'Home', item: CANON + '/' },
          { '@type': 'ListItem', position: 2, name: 'Safety recalls', item: CANON + '/recalls/' },
          { '@type': 'ListItem', position: 3, name: fam.name, item: url },
        ] },
      ],
    },
    body,
  });
}

function gasHobClusterPage(records, generatedAt) {
  const list = gasHobRecords(records);
  const url = CANON + '/recalls/' + GAS_HOB_SLUG + '/';
  const years = list.map((r) => String(r.alertDate || '').slice(0, 4)).filter(Boolean).sort();
  const spanLabel = years.length
    ? (years[0] === years[years.length - 1] ? years[0] : years[0] + ' to ' + years[years.length - 1])
    : '';
  const count = list.length;
  const scope = count
    ? 'ApplianceClinic has classified ' + count + ' gas hob safety ' + (count === 1 ? 'notice' : 'notices')
      + ' from the official OPSS record' + (spanLabel ? ', published ' + esc(spanLabel) : '') + '.'
    : 'There are no gas hob notices in the current set.';

  const body = crumbs([{ name: 'Home', href: '/' }, { name: 'Safety recalls', href: '/recalls/' }, { name: 'Gas hobs' }])
    + '<header class="hub-hero">'
    + '<p class="hub-kicker">UK appliance safety</p>'
    + '<h1>Gas hob recalls and safety notices</h1>'
    + '<p class="hub-intro">Several UK gas hob safety notices share a common theme — a gas leak at the supply elbow joint behind the hob. The UK Office for Product Safety and Standards (OPSS) has published separate notices for a number of brands. This page gathers the gas hob notices ApplianceClinic has classified from the official record, so you can find the one that matches your hob.</p>'
    + '<p class="recall-source">ApplianceClinic does not issue recalls. ' + scope + ' Every notice links back to its official <a href="https://www.gov.uk/product-safety-alerts-reports-recalls" rel="noopener noreferrer">GOV.UK</a> record.</p>'
    + '<div class="hub-cta-row"><a class="btn btn--ghost" href="/hobs/">Hob help and diagnosis</a><a class="btn btn--ghost" href="/recalls/">All appliance recalls</a></div>'
    + '</header>'
    + '<section class="hub-section" id="action"><h2>What to do</h2>'
    + '<p class="hub-lead">These notices are not identical. Follow the action stated on the individual recall notice for your model — do not assume one instruction covers them all. Matching a similar brand name is not enough; check the model and any serial or batch detail on GOV.UK.</p>'
    + '<article class="hub-card hub-card--stop"><h3>If you ever smell gas</h3><p>Do not turn any switch on or off. Ventilate the room, turn off the gas at the meter if it is safe to do so, and call the free Gas Emergency Services line on 0800 111 999. This general advice is not specific to any one notice below.</p></article>'
    + '</section>'
    + '<section class="hub-section" id="notices"><h2>Gas hob notices</h2>'
    + '<p class="hub-lead">Updated ' + esc(fmtDate((generatedAt || '').slice(0, 10))) + ' from GOV.UK. Each links to the full official record.</p>'
    + '<div class="recall-list">' + (list.map(noticeCard).join('') || '<p>No current gas hob notices.</p>') + '</div></section>'
    + '<section class="hub-section" id="hub"><h2>Gas hob help</h2>'
    + '<p class="hub-lead">A recall is about a specific safety fault. For everyday gas hob problems — ignition, zones not lighting, and safe checks — see the Hobs Help Hub. ApplianceClinic help does not override an active recall.</p>'
    + '<a class="btn btn--primary" href="/hobs/">Hobs Help Hub</a></section>'
    + '<footer class="site-footer"><nav class="site-footer__nav" aria-label="On this page">'
    + '<a href="/recalls/">Recall Centre</a><a href="/hobs/">Hobs help</a><a href="https://www.gov.uk/product-safety-alerts-reports-recalls">OPSS on GOV.UK</a>'
    + '</nav><p class="site-footer__line">' + esc(OGL) + ' <a href="' + OGL_URL + '">Licence</a>.</p></footer>';

  return shell({
    title: 'Gas hob recalls and safety notices in the UK | ApplianceClinic',
    description: 'Current UK gas hob safety notices from OPSS, including the gas-supply elbow-joint corrective-action programme. Find the notice for your brand and read the official GOV.UK record.',
    canonical: url,
    jsonLd: {
      '@context': 'https://schema.org',
      '@graph': [
        {
          '@type': 'CollectionPage',
          '@id': url + '#webpage',
          url: url,
          name: 'Gas hob recalls and safety notices',
          inLanguage: 'en-GB',
          isPartOf: { '@id': CANON + '/#website' },
          about: { '@type': 'Thing', name: 'Gas hobs' },
        },
        { '@type': 'BreadcrumbList', itemListElement: [
          { '@type': 'ListItem', position: 1, name: 'Home', item: CANON + '/' },
          { '@type': 'ListItem', position: 2, name: 'Safety recalls', item: CANON + '/recalls/' },
          { '@type': 'ListItem', position: 3, name: 'Gas hobs', item: url },
        ] },
      ],
    },
    body,
  });
}

function recordPage(rec) {
  const fam = familyOf(rec.family);
  const url = CANON + '/recalls/' + rec.slug + '/';
  const p = rec.presentation || {};
  const models = (rec.models && rec.models.length)
    ? '<ul class="hub-tips">' + rec.models.map((m) => '<li>' + esc(m) + '</li>').join('') + '</ul>'
    : (rec.modelText ? '<p>' + esc(rec.modelText) + '</p>' : '<p>The official record does not list a simple model list. Check GOV.UK.</p>');
  const stop = p.stopUseIndicatedBySource
    ? '<article class="hub-card hub-card--stop"><h3>The official notice indicates you may need to stop using it</h3><p>That instruction comes from OPSS / the manufacturer action — not from ApplianceClinic. Follow the GOV.UK record.</p></article>'
    : '';
  const range = p.identityRangeNeeded
    ? '<p>Applicability may depend on serial, batch or date-range information. Matching a similar model name is not enough.</p>'
    : '';
  const mfr = rec.manufacturerUrl
    ? '<p><a class="btn btn--ghost" href="' + esc(rec.manufacturerUrl) + '" rel="noopener noreferrer nofollow" target="_blank">Manufacturer information (as linked from OPSS)</a></p>'
    : '';

  const body = crumbs([
    { name: 'Home', href: '/' },
    { name: 'Safety recalls', href: '/recalls/' },
    fam ? { name: fam.name, href: '/recalls/' + fam.slug + '/' } : null,
    { name: rec.productName || 'Notice' },
  ].filter(Boolean))
    + '<header class="hub-hero">'
    + '<p class="hub-kicker">' + esc(typeLabel(rec.sourceType)) + ' · OPSS' + (rec.psdNumber ? ' ' + esc(rec.psdNumber) : '') + '</p>'
    + '<h1>' + esc(rec.productName || rec.title) + '</h1>'
    + '<p class="hub-intro">According to the UK Office for Product Safety and Standards. ApplianceClinic did not issue this notice.</p>'
    + '<p class="recall-card__meta">Published ' + esc(fmtDate(rec.alertDate)) + ' · Risk ' + esc(riskLabel(rec.riskLevel)) + (fam ? ' · ' + esc(fam.name) : '') + (rec.brand ? ' · ' + esc(rec.brand) : '') + '</p>'
    + '</header>'
    + '<section class="hub-section" id="authoritative"><h2>According to OPSS</h2>'
    + '<div class="hub-grid hub-grid--2">'
    + '<article class="hub-card"><h3>The product</h3><p>' + esc(rec.productName || rec.title) + (rec.brand ? ' (' + esc(rec.brand) + ')' : '') + '</p></article>'
    + '<article class="hub-card"><h3>The risk</h3><p>' + esc(p.hazard || rec.hazard || 'See the official record for the hazard description.') + '</p></article>'
    + '<article class="hub-card"><h3>What you should do</h3><p>' + esc(p.whatToDo || rec.correctiveAction || 'Follow the official GOV.UK instructions.') + '</p></article>'
    + stop
    + '</div>'
    + '<h3>Affected models / identifiers</h3>' + models + range
    + (rec.batchText ? '<p>Batch information: ' + esc(rec.batchText) + '</p>' : '')
    + (rec.serialText ? '<p>Serial information: ' + esc(rec.serialText) + '</p>' : '')
    + '<div class="hub-cta-row">'
    + '<a class="btn btn--primary" href="' + esc(rec.sourceUrl) + '" rel="noopener noreferrer" target="_blank">Read the official GOV.UK record</a>'
    + (fam ? '<a class="btn btn--ghost" href="' + esc(fam.hub) + '">' + esc(fam.name) + ' help</a>' : '')
    + '</div>' + mfr
    + '<p class="hub-lead">Last checked with GOV.UK on ' + esc(fmtDate((rec.lastCheckedAt || '').slice(0, 10))) + '. If you are reading a saved copy, treat this date as the freshness of the information.</p>'
    + '<p class="hub-lead">' + esc(OGL) + ' We summarise the official summary fields rather than copying the full GOV.UK page.</p>'
    + '</section>'
    + (fam
      ? '<section class="hub-section" id="hub"><h2>Get help with your ' + esc(fam.name.toLowerCase().replace(/s$/, '')) + '</h2>'
        + '<p class="hub-lead">This safety notice is the authoritative word from OPSS / GOV.UK. The ApplianceClinic ' + esc(fam.name) + ' Help Hub is general help — common problems, safe checks and diagnosis — and does <strong>not</strong> override an active recall or corrective-action programme. If the action above applies to your model, follow that first.</p>'
        + '<div class="hub-cta-row">'
        + '<a class="btn btn--primary" href="' + esc(fam.hub) + '">See ' + esc(fam.name.toLowerCase()) + ' problems, safe checks and diagnosis help</a>'
        + '<a class="btn btn--ghost" href="/#ask">Diagnose a different fault</a>'
        + '</div></section>'
      : '<section class="hub-section"><h2>Need help with a fault that is not a recall?</h2>'
        + '<p class="hub-lead">A recall is not the same as a breakdown. If your appliance is misbehaving and is not listed here, start a diagnosis. ApplianceClinic help does not override an active recall notice.</p>'
        + '<a class="btn btn--primary" href="/#ask">Describe the problem</a></section>')
    + '<footer class="site-footer"><p class="site-footer__line">Independent UK diagnosis help. Not a manufacturer and not a recall authority.</p></footer>';

  return shell({
    title: (rec.productName || rec.title) + ' — UK safety notice | ApplianceClinic',
    description: 'OPSS ' + typeLabel(rec.sourceType).toLowerCase() + ' for ' + (rec.brand ? rec.brand + ' ' : '') + (rec.productName || 'this appliance') + '. Official GOV.UK source and what owners are asked to do.',
    canonical: url,
    jsonLd: {
      '@context': 'https://schema.org',
      '@graph': [
        {
          '@type': 'WebPage',
          url: url,
          name: rec.productName || rec.title,
          datePublished: rec.alertDate || undefined,
          dateModified: (rec.lastChangedAt || rec.lastCheckedAt || '').slice(0, 10) || undefined,
          inLanguage: 'en-GB',
          isBasedOn: rec.sourceUrl,
        },
        { '@type': 'BreadcrumbList', itemListElement: [
          { '@type': 'ListItem', position: 1, name: 'Home', item: CANON + '/' },
          { '@type': 'ListItem', position: 2, name: 'Safety recalls', item: CANON + '/recalls/' },
          fam ? { '@type': 'ListItem', position: 3, name: fam.name, item: CANON + '/recalls/' + fam.slug + '/' } : null,
          { '@type': 'ListItem', position: fam ? 4 : 3, name: rec.productName || rec.title, item: url },
        ].filter(Boolean) },
      ],
    },
    body,
  });
}

// Recall child sitemap: ONLY the dynamically-published recall URLs (family pages
// that have at least one live notice, plus each individual notice). The stable
// core URLs (homepage, Help Hubs, /recalls/ landing) live in the static-owned
// sitemap-core.xml and are referenced together via the /sitemap.xml index, so the
// recall ingest and the static deploy never write the same URLs. With no published
// records this is a valid, empty urlset — we never fabricate recall URLs.
function sitemapRecallsXml(records, extraLastmod) {
  const urls = [];
  const famSeen = {};
  // Curated gas-hob cluster: listed once, only when the real data supports it.
  if (gasHobRecords(records).length >= GAS_HOB_CLUSTER_MIN) {
    urls.push({ loc: CANON + '/recalls/' + GAS_HOB_SLUG + '/', lastmod: extraLastmod, changefreq: 'weekly' });
  }
  (records || []).forEach((r) => {
    if (r.family && familyOf(r.family) && !famSeen[r.family]) {
      famSeen[r.family] = true;
      urls.push({ loc: CANON + '/recalls/' + familyOf(r.family).slug + '/', lastmod: extraLastmod, changefreq: 'weekly' });
    }
    urls.push({
      loc: CANON + '/recalls/' + r.slug + '/',
      lastmod: (r.lastChangedAt || r.lastCheckedAt || r.alertDate || extraLastmod || '').slice(0, 10),
      changefreq: 'weekly',
    });
  });
  const body = urls.map((u) => {
    return '  <url>\n    <loc>' + u.loc + '</loc>\n'
      + (u.lastmod ? '    <lastmod>' + u.lastmod + '</lastmod>\n' : '')
      + (u.changefreq ? '    <changefreq>' + u.changefreq + '</changefreq>\n' : '')
      + '  </url>';
  }).join('\n');
  return '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n'
    + (body ? body + '\n' : '') + '</urlset>\n';
}

function unpublishedPage(rec) {
  const url = CANON + '/recalls/' + rec.slug + '/';
  const body = crumbs([{ name: 'Home', href: '/' }, { name: 'Safety recalls', href: '/recalls/' }, { name: 'Not listed' }])
    + '<header class="hub-hero"><h1>This notice is not listed as an ApplianceClinic appliance</h1>'
    + '<p class="hub-intro">We only publish UK OPSS notices that we can confidently map to washing machines, washer dryers, tumble dryers, dishwashers, fridge-freezers, ovens and cookers, hobs, microwaves or vacuum cleaners.</p>'
    + (rec.sourceUrl ? '<p><a class="btn btn--primary" href="' + esc(rec.sourceUrl) + '" rel="noopener noreferrer">Official GOV.UK record</a></p>' : '')
    + '<p><a href="/recalls/">Back to the Recall Centre</a></p></header>';
  return shell({
    title: 'Notice not listed | ApplianceClinic',
    description: 'This OPSS notice is not listed in the ApplianceClinic appliance recall set.',
    canonical: url,
    robots: 'noindex,nofollow',
    body,
  });
}

module.exports = {
  indexPage, familyPage, recordPage, unpublishedPage, sitemapRecallsXml,
  gasHobClusterPage, isGasHob, gasHobRecords,
  esc, CANON, CSS_V, GAS_HOB_SLUG, GAS_HOB_CLUSTER_MIN,
};
