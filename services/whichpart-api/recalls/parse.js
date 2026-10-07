'use strict';

/**
 * Extract structured SOURCE FACT from a GOV.UK Content API specialist document.
 * Does not invent fields. Does not keep the full HTML body.
 */

const crypto = require('crypto');

const GOVUK_ORIGIN = 'https://www.gov.uk';
const ALLOWED_CONTENT_PREFIX = '/product-safety-alerts-reports-recalls/';

function clip(s, n) {
  if (s == null) return '';
  const t = String(s).replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n) : t;
}

function stripTags(html) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

function hash(s) {
  return crypto.createHash('sha256').update(String(s || ''), 'utf8').digest('hex');
}

function cellText(html) {
  return stripTags(html);
}

function parseProductTable(body) {
  const out = { productType: '', fields: {} };
  const thead = body.match(/<th scope="col">Type<\/th>\s*<th scope="col">([\s\S]*?)<\/th>/i);
  if (thead) out.productType = cellText(thead[1]);
  const re = /<tr>\s*<td>([\s\S]*?)<\/td>\s*<td>([\s\S]*?)<\/td>\s*<\/tr>/gi;
  let m;
  while ((m = re.exec(body))) {
    const key = cellText(m[1]).toLowerCase();
    const val = cellText(m[2]);
    if (!key || !val) continue;
    out.fields[key] = val;
  }
  return out;
}

function paragraphAfter(label, body) {
  const re = new RegExp('<p>\\s*' + label + '\\s*:\\s*([\\s\\S]*?)<\\/p>', 'i');
  const m = body.match(re);
  return m ? stripTags(m[1]) : '';
}

function sectionText(id, body) {
  const re = new RegExp('<h2 id="' + id + '">[\\s\\S]*?<\\/h2>([\\s\\S]*?)(?=<h2[\\s>]|$)', 'i');
  const m = body.match(re);
  return m ? stripTags(m[1]) : '';
}

function psdFromTitle(title) {
  const m = String(title || '').match(/\((\d{4}-\d{4}[a-z]?)\)\s*$/i);
  return m ? m[1] : '';
}

function slugFromPath(basePath) {
  const p = String(basePath || '');
  const parts = p.split('/').filter(Boolean);
  return parts[parts.length - 1] || '';
}

function alertTypeOf(raw) {
  const v = String(raw || '').toLowerCase();
  if (v === 'product-recall' || v === 'product recall') return 'recall';
  if (v === 'product-safety-report' || v === 'product safety report') return 'safety_report';
  if (v === 'product-safety-alert' || v === 'product safety alert') return 'safety_alert';
  return null;
}

function modelsFrom(fields) {
  const raw = fields.model || fields.models || fields['model number'] || '';
  const out = [];
  function add(s) {
    const t = String(s || '').trim();
    if (t && out.indexOf(t) === -1) out.push(t);
  }
  if (raw) raw.split(/[,;/]|\band\b/i).forEach(add);
  Object.keys(fields).forEach((k) => {
    if (!/^\d{4}-\d{4}[a-z]?$/i.test(k)) return;
    add(fields[k]);
  });
  return out.slice(0, 40);
}

function inferBrand(fields, productName, title) {
  if (fields.brand) return clip(fields.brand, 80);
  const name = String(productName || title || '').replace(/^product (recall|safety report|safety alert):\s*/i, '');
  const m = name.match(/^([A-Z][A-Za-z0-9&']+)(?:\s|$)/);
  if (!m) return null;
  if (/^(Folding|Mini|Electric|Gas|Unbranded|Product|Important|Integrated|Cordless|Heat|The|A|An|UK|Black|White)$/i.test(m[1])) return null;
  return clip(m[1], 80);
}

function identifiersFrom(fields) {
  const keys = ['additional identifier', 'additional identifiers', 'barcode', 'sku', 'item number', 'batch number', 'serial'];
  const out = [];
  for (const k of keys) {
    if (fields[k]) out.push({ kind: k, value: clip(fields[k], 240) });
  }
  return out;
}

function extractOfficialLinks(body) {
  const urls = [];
  function add(raw) {
    let href;
    try { href = new URL(raw); } catch { return; }
    if (href.protocol !== 'https:') return;
    const host = href.hostname.toLowerCase();
    if (host === 'www.gov.uk' || host === 'gov.uk') return;
    if (host === 'assets.publishing.service.gov.uk') return;
    if (host.endsWith('.gov.uk')) return;
    urls.push(href.toString().replace(/[).,;]+$/, '').slice(0, 400));
  }
  const hrefRe = /href="(https:\/\/[^"]+)"/gi;
  let m;
  while ((m = hrefRe.exec(body))) add(m[1]);
  const bareRe = /https:\/\/[^\s<"']+/gi;
  while ((m = bareRe.exec(stripTags(body)))) add(m[0]);
  return Array.from(new Set(urls)).slice(0, 5);
}

function parseContentDocument(doc) {
  if (!doc || typeof doc !== 'object') return null;
  const basePath = String(doc.base_path || '');
  if (!basePath.startsWith(ALLOWED_CONTENT_PREFIX)) return null;
  const details = doc.details || {};
  const metadata = details.metadata || {};
  const body = String(details.body || '');
  const table = parseProductTable(body);
  const fields = table.fields;
  const title = clip(doc.title, 240);
  const productName = clip(paragraphAfter('Product', body) || fields['product description'] && title, 200)
    || clip(title.replace(/^product (recall|safety report|safety alert):\s*/i, '').replace(/\s*\(\d{4}-\d{4}[a-z]?\)\s*$/i, ''), 200);

  const withdrawn = doc.withdrawn_notice && (doc.withdrawn_notice.explanation || doc.withdrawn_notice.withdrawn_at)
    ? {
      at: doc.withdrawn_notice.withdrawn_at || null,
      explanation: clip(stripTags(doc.withdrawn_notice.explanation || ''), 400),
    }
    : null;

  const changeHistory = Array.isArray(details.change_history)
    ? details.change_history.slice(0, 12).map((h) => ({
      at: h.public_timestamp || null,
      note: clip(h.note, 240),
    }))
    : [];

  const manufacturerUrl = extractOfficialLinks(body)[0] || null;

  return {
    contentId: String(doc.content_id || ''),
    basePath,
    sourceUrl: GOVUK_ORIGIN + basePath,
    slug: slugFromPath(basePath),
    title,
    description: clip(doc.description, 400),
    sourceType: alertTypeOf(metadata.product_alert_type),
    sourceTypeRaw: metadata.product_alert_type || null,
    sourceCategory: metadata.product_category || null,
    riskLevel: metadata.product_risk_level || null,
    measureTypes: Array.isArray(metadata.product_measure_type) ? metadata.product_measure_type.slice(0, 8) : [],
    alertDate: metadata.product_recall_alert_date || (doc.first_published_at || '').slice(0, 10) || null,
    firstPublishedAt: doc.first_published_at || null,
    publicUpdatedAt: doc.public_updated_at || null,
    updatedAt: doc.updated_at || null,
    psdNumber: psdFromTitle(title) || clip(paragraphAfter('PSD notification number', body), 20),
    productType: clip(table.productType, 200),
    productName: clip(productName, 200),
    brand: inferBrand(fields, productName, title),
    models: modelsFrom(fields),
    modelText: clip(fields.model || fields.models || '', 400) || null,
    batchText: clip(fields['batch number'] || fields.batch || '', 400) || null,
    serialText: clip(fields.serial || fields['serial number'] || '', 400) || null,
    identifiers: identifiersFrom(fields),
    countryOfOrigin: clip(fields['country of origin'], 80) || null,
    productDescription: clip(fields['product description'], 500) || null,
    hazard: clip(paragraphAfter('Hazard', body) || sectionText('hazard', body), 700),
    correctiveAction: clip(paragraphAfter('Corrective action', body) || sectionText('corrective-action', body), 700),
    manufacturerUrl,
    attachments: Array.isArray(details.attachments)
      ? details.attachments.slice(0, 6).map((a) => ({
        title: clip(a.title, 160),
        url: clip(a.url, 400),
        contentType: clip(a.content_type, 80),
      })).filter((a) => a.url && /^https:\/\/assets\.publishing\.service\.gov\.uk\//.test(a.url))
      : [],
    changeHistory,
    withdrawn,
    bodyHash: hash(body),
    schemaName: doc.schema_name || null,
    documentType: doc.document_type || null,
  };
}

function consumerActionHints(source) {
  const text = ((source && source.correctiveAction) || '') + ' ' + ((source && source.hazard) || '');
  const stop = /\b(stop using|do not use|unplug|switch off|isolate|do not operate|take (the )?product out of use)\b/i.test(text);
  const rangeNeeded = !!(source && (source.batchText || source.serialText || /\b(serial|batch|date code|from serial)\b/i.test(source.modelText || '')));
  return { stopUseIndicatedBySource: stop, identityRangeNeeded: rangeNeeded };
}

module.exports = {
  parseContentDocument,
  consumerActionHints,
  stripTags,
  hash,
  clip,
  GOVUK_ORIGIN,
  ALLOWED_CONTENT_PREFIX,
};
