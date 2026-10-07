'use strict';

/**
 * Conservative public matching. Never asserts “your appliance is recalled”
 * from a fuzzy resemblance. No LLM.
 */

function normToken(s) {
  return String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function tokensFrom(s) {
  return String(s || '')
    .split(/[\s,;/|]+/)
    .map(normToken)
    .filter((t) => t.length >= 3);
}

function brandNorm(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function matchQuery(rec, q) {
  const raw = String(q || '').trim();
  if (raw.length < 2) {
    return { strength: 'none', label: null };
  }
  const qBrand = brandNorm(raw);
  const qToks = tokensFrom(raw);
  const recBrand = brandNorm(rec.brand || '');
  const modelHay = (rec.models || []).concat([rec.modelText]).filter(Boolean);
  const modelNorms = modelHay.map(normToken).filter(Boolean);

  let strong = false;
  for (const tok of qToks) {
    if (tok.length < 4) continue;
    if (modelNorms.some((m) => m === tok || (tok.length >= 5 && m.indexOf(tok) !== -1))) {
      strong = true;
      break;
    }
  }

  const brandHit = recBrand && (qBrand === recBrand || qBrand.indexOf(recBrand) !== -1 || recBrand.indexOf(qBrand) !== -1);

  if (strong) {
    return {
      strength: 'strong',
      label: 'This model appears in the affected product information.',
    };
  }
  if (brandHit && rec.family) {
    return {
      strength: 'possible',
      label: 'There are safety notices affecting some ' + (rec.brand || '') + ' ' + (rec.familyName || 'appliances') + '. Check your exact model.',
    };
  }
  const blob = String(rec.searchBlob || '').toLowerCase();
  if (blob.indexOf(raw.toLowerCase()) !== -1) {
    return {
      strength: 'possible',
      label: 'This notice mentions similar wording. Check the official affected product information.',
    };
  }
  return { strength: 'none', label: null };
}

function publicMatchDisclaimer(strength, rec) {
  if (strength === 'strong' && rec && rec.identityRangeNeeded) {
    return 'The official notice also uses serial, batch or date-range information. Matching the model is not enough on its own — check those details on GOV.UK.';
  }
  if (strength === 'possible') {
    return 'This is not a confirmation that your appliance is recalled.';
  }
  return null;
}

module.exports = { matchQuery, publicMatchDisclaimer, normToken, brandNorm };
