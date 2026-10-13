'use strict';
/**
 * Part matching against the external parts catalogue. The turn (turn.js) shows a part only in stage 2, when Jev
 * judges the fault narrowed to one component, the customer's model is known and the catalogue lists a matching part
 * for that model. Price and availability come only from the catalogue; nothing here invents them.
 */
const K = require('./knowledge.js');

const GENERIC = new Set(['part', 'parts', 'assembly', 'kit', 'unit', 'genuine', 'replacement', 'spare', 'for', 'and', 'the', 'with']);
function words(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter((w) => w.length > 2 && !GENERIC.has(w));
}

/** The journey part-matcher that best fits the proposed component, if any. */
function matcherFor(appliance, component) {
  const cw = new Set(words(component));
  let best = null;
  for (const m of K.partMatchers(appliance)) {
    const mw = words(`${m.component.replace(/-/g, ' ')} ${m.label}`);
    const n = mw.filter((w) => cw.has(w)).length;
    if (n && (!best || n > best.n)) best = { n, m };
  }
  return best ? best.m : null;
}

function matchParts(parts, appliance, component) {
  const m = matcherFor(appliance, component);
  if (m) {
    const hits = parts.filter((p) => p && p.title && m.re.test(p.title) && !(m.not && m.not.test(p.title)));
    if (hits.length) return { parts: hits.slice(0, 3), matcher: m.component };
  }
  // No journey matcher: every distinctive word of the component must appear in the title.
  const cw = words(component);
  if (!cw.length) return { parts: [], matcher: null };
  const hits = parts.filter((p) => p && p.title && cw.every((w) => p.title.toLowerCase().includes(w)));
  return { parts: hits.slice(0, 3), matcher: m ? m.component : 'words' };
}

module.exports = { matchParts, matcherFor };
