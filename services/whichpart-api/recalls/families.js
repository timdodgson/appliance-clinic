'use strict';

/**
 * ApplianceClinic appliance families used by the Recall Centre.
 * Must stay aligned with Help Hubs / transcript family labels.
 */

const FAMILIES = [
  { id: 'washing machine', slug: 'washing-machines', name: 'Washing machines', hub: '/washing-machines/' },
  { id: 'washer-dryer', slug: 'washer-dryers', name: 'Washer dryers', hub: '/washer-dryers/' },
  { id: 'tumble-dryer', slug: 'tumble-dryers', name: 'Tumble dryers', hub: '/tumble-dryers/' },
  { id: 'dishwasher', slug: 'dishwashers', name: 'Dishwashers', hub: '/dishwashers/' },
  { id: 'fridge-freezer', slug: 'fridge-freezers', name: 'Fridge-freezers', hub: '/fridge-freezers/' },
  { id: 'oven-cooker', slug: 'ovens-cookers', name: 'Ovens and cookers', hub: '/ovens-cookers/' },
  { id: 'hobs', slug: 'hobs', name: 'Hobs', hub: '/hobs/' },
  { id: 'microwave', slug: 'microwaves', name: 'Microwaves', hub: '/microwaves/' },
  { id: 'vacuum', slug: 'vacuum-cleaners', name: 'Vacuum cleaners', hub: '/vacuum-cleaners/' },
];

const BY_ID = Object.fromEntries(FAMILIES.map((f) => [f.id, f]));
const BY_SLUG = Object.fromEntries(FAMILIES.map((f) => [f.slug, f]));

function familyOf(idOrSlug) {
  if (!idOrSlug) return null;
  return BY_ID[idOrSlug] || BY_SLUG[idOrSlug] || null;
}

module.exports = { FAMILIES, BY_ID, BY_SLUG, familyOf };
