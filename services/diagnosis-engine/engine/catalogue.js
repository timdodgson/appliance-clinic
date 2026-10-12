'use strict';
/**
 * The faults and error-code catalogue (faults-catalogue.json: error codes, component aliases) and component matching for
 * the part gate, plus the component-mention vocabulary of a NextAction. Loaded at cold start; a missing catalogue leaves
 * no error codes or aliases rather than failing the request.
 */
let CATALOGUE = { faults: {}, errorCodes: {} };

try {
  // eslint-disable-next-line global-require
  CATALOGUE = require('../faults-catalogue.json');
} catch (e) {
  console.error('[catalogue] faults catalogue not loaded:', e.message);
}

// Component alias boundary: repair term -> the terms the parts catalogue uses (e.g. "circulation pump" -> "wash pump"),
// so the diagnostic taxonomy speaks repair language while part matching speaks product language. Lowercase.
const COMPONENT_ALIASES = (() => {
  const src = CATALOGUE.componentAliases || {};
  const out = {};
  for (const [k, v] of Object.entries(src)) {
    if (!Array.isArray(v)) continue;
    out[k.toLowerCase()] = v.map((s) => String(s).toLowerCase());
  }
  return out;
})();

/** A component plus any catalogue aliases for it (all lowercase, deduped). */
function componentTerms(component) {
  const c = (component || '').toLowerCase().trim();
  if (!c) return [];
  return [...new Set([c, ...(COMPONENT_ALIASES[c] || [])])];
}

/**
 * A part title matches a component if it (or any of the component's catalogue
 * aliases) is contained in the title, or all the term's key tokens are.
 */
function matchesComponent(title, component) {
  const t = String(title || '').toLowerCase();
  const c = String(component || '').toLowerCase().trim();
  if (!t || !c) return false;
  // A "battery charger" is not a battery pack. Substring "battery" must not promote
  // a charger as the battery component (and vice versa).
  if (c === 'battery' && /charger/.test(t)) return false;
  if (c === 'charger' && !/charger|adaptor|adapter|power supply/.test(t)) return false;
  for (const term of componentTerms(component)) {
    if (title.includes(term) || t.includes(term)) return true;
    const tokens = term.split(/\s+/).filter((w) => w.length >= 3);
    if (tokens.length > 0 && tokens.every((tok) => t.includes(tok))) return true;
  }
  return false;
}

/** How far a NextAction may name a component to the customer. */
const COMPONENT_MENTION = { NONE: 'none', DISCUSS: 'discuss', PURCHASE: 'purchase' };

module.exports = { CATALOGUE, matchesComponent, COMPONENT_MENTION };
