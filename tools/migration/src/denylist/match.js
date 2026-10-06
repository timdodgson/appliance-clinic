/**
 * Denylist matching. Exact matching for identifiers, plus a substring scan of whole documents
 * (change sets, templates) so an S4R identifier hidden inside a property value is still found.
 */
const MIN_SCAN_LENGTH = 6; // shorter values would match by accident

export function matchesEntry(entry, value) {
  if (typeof value !== 'string' || !value) return false;
  switch (entry.kind) {
    case 'arnPrefix':
      return value.startsWith(entry.value);
    case 'stack':
    case 'arn':
    case 'physicalId':
      return value === entry.value || value.endsWith(`/${entry.value}`) || value.endsWith(`:${entry.value}`);
    default:
      return false;
  }
}

export function findExactHits(entries, value) {
  return entries.filter((e) => matchesEntry(e, value));
}

export function scanDocument(entries, document) {
  const text = typeof document === 'string' ? document : JSON.stringify(document);
  const hits = [];
  for (const e of entries) {
    if (e.value.length < MIN_SCAN_LENGTH) continue;
    if (text.includes(e.value)) hits.push(e);
  }
  return hits;
}
