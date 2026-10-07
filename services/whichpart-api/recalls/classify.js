'use strict';

/**
 * Conservative relevance classification.
 *
 * SOURCE FACT (OPSS category, title, product type, product name) stays separate
 * from APPLIANCECLINIC classification. Uncertain records are not published.
 *
 * Do not treat “electrical” as an ApplianceClinic appliance.
 */

const { FAMILIES } = require('./families');

const SOURCE_CATEGORIES = [
  'electrical-appliances-equipment',
  'gas-appliances-and-components',
];

const TYPE_SUBTYPE = [
  { family: 'washer-dryer', re: /\b(combination clothes washer|washer[-\s]?dryers?|washer[-\s]?driers?)\b/i },
  { family: 'washing machine', re: /\b(clothes washers?|washing machines?)\b/i },
  { family: 'tumble-dryer', re: /\b(tumble[-\s]?dryers?|tumble[-\s]?driers?|clothes dryers?)\b/i },
  { family: 'dishwasher', re: /\bdishwashers?\b/i },
  { family: 'fridge-freezer', re: /\b(refrigerating appliances?|fridge[-\s]?freezers?|refrigerators?|freezers?|fridges?)\b/i },
  { family: 'hobs', re: /\b(hobs?|cooktops?|cooking hobs?|induction cookers?)\b/i },
  { family: 'microwave', re: /\bmicrowave(s|\s+ovens?)?\b/i },
  { family: 'vacuum', re: /\bvacuum cleaners?\b|\bwet and dry vacuum/i },
  { family: 'oven-cooker', re: /\b(ovens?|range cookers?|electric cookers?|gas cookers?|freestanding cookers?|gas range cookers?)\b/i },
];

const NAME_FAMILY = [
  { family: 'washer-dryer', re: /\bwasher[-\s]?dryers?\b|\bwasher[-\s]?driers?\b/i },
  { family: 'tumble-dryer', re: /\b(tumble[-\s]?dryers?|tumble[-\s]?driers?|heat pump tumble dryer|condenser dryer|clothes dryer)\b/i },
  { family: 'washing machine', re: /\bwashing machines?\b|\bclothes washer\b/i },
  { family: 'dishwasher', re: /\bdishwashers?\b/i },
  { family: 'fridge-freezer', re: /\bfridge[-\s]?freezers?\b|\brefrigerators?\b|\bchest freezers?\b|\bfridge\b|\bfreezer\b/i },
  { family: 'hobs', re: /\b(gas |electric |induction |ceramic )?hobs?\b|\bcooktops?\b/i },
  { family: 'microwave', re: /\bmicrowaves?\b|\bmicrowave oven\b/i },
  { family: 'vacuum', re: /\bvacuum cleaners?\b|\bcorded vacuum\b|\bstick vacuum\b|\bcylinder vacuum\b/i },
  { family: 'oven-cooker', re: /\b(freestanding |range )?gas cookers?\b|\belectric cookers?\b|\bovens?\b(?!\s*glove)/i },
];

const EXCLUDE = /\b(pressure washer|washer gun|pressure washer gun|ev charger|charging point|charging pile|electric vehicle|laptop|tablet|phone|webcam|speaker|hair ?dryer|shoe dryer|boot dryer|hand dryer|hand wash dryer|tower fan|table fan|desk fan|fan heater|heater fan|toaster oven|breakfast maker|air fryer|multi-cookers?|multi function fryer|fryers?|pressure cookers?|slow cookers?|rice cookers?|rice robots?|steamers?|infrared cooker|camping stove|gas stove|gas cylinder|boiler|water heater|oil condensing|treadmill|scooter|e-?bike|electric bike|battery chargers?|chargers?|gas hoses?|cooker hoses?|hoses?)\b/i;

function hits(list, text) {
  const out = [];
  const seen = Object.create(null);
  for (const row of list) {
    if (row.re.test(text) && !seen[row.family]) {
      seen[row.family] = true;
      out.push(row.family);
    }
  }
  return out;
}

function resolveOverlap(ids) {
  let next = ids.slice();
  if (next.indexOf('washer-dryer') !== -1) {
    next = next.filter((id) => id !== 'washing machine' && id !== 'tumble-dryer');
  }
  if (next.indexOf('hobs') !== -1) {
    next = next.filter((id) => id !== 'oven-cooker');
  }
  return next;
}

function classify(input) {
  const title = String((input && input.title) || '');
  const productName = String((input && input.productName) || '');
  const productType = String((input && input.productType) || '');
  const description = String((input && input.description) || '');
  const sourceCategory = String((input && input.sourceCategory) || '');

  const blob = [title, productName, productType, description].join(' \n ');
  if (EXCLUDE.test(blob)) {
    return {
      family: null,
      publish: false,
      state: 'excluded',
      confidence: 'exclude',
      reason: 'excluded-non-appliance',
      sourceCategory: sourceCategory || null,
    };
  }

  const typeHits = resolveOverlap(hits(TYPE_SUBTYPE, productType));
  const nameHits = resolveOverlap(hits(NAME_FAMILY, productName + ' ' + title));

  let family = null;
  let confidence = 'none';
  let reason = 'no-family-match';

  if (typeHits.length === 1) {
    family = typeHits[0];
    confidence = 'type';
    reason = 'opss-product-type';
  } else if (typeHits.length > 1) {
    return {
      family: null,
      publish: false,
      state: 'review',
      confidence: 'ambiguous',
      reason: 'ambiguous-product-type:' + typeHits.join(','),
      sourceCategory: sourceCategory || null,
    };
  } else if (nameHits.length === 1) {
    family = nameHits[0];
    confidence = 'name';
    reason = 'product-name-or-title';
  } else if (nameHits.length > 1) {
    return {
      family: null,
      publish: false,
      state: 'review',
      confidence: 'ambiguous',
      reason: 'ambiguous-name:' + nameHits.join(','),
      sourceCategory: sourceCategory || null,
    };
  }

  if (!family) {
    return {
      family: null,
      publish: false,
      state: 'excluded',
      confidence: 'none',
      reason,
      sourceCategory: sourceCategory || null,
    };
  }

  return {
    family,
    publish: true,
    state: 'published',
    confidence,
    reason,
    sourceCategory: sourceCategory || null,
    familyMeta: FAMILIES.find((f) => f.id === family) || null,
  };
}

module.exports = {
  classify,
  SOURCE_CATEGORIES,
  EXCLUDE,
};
