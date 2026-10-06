/**
 * The S4R /part-finder contract: the parts of the diagnosis Lambda's behaviour that the
 * Spares4Repairs page depends on. Captured structurally (shapes, not prose) so it can be
 * verified before and after any change that touches the diagnosis Lambda.
 */
const CORS_HEADERS = ['access-control-allow-origin', 'access-control-allow-methods', 'access-control-allow-headers', 'access-control-allow-credentials', 'access-control-expose-headers', 'access-control-max-age'];

const pick = (headers, names) => Object.fromEntries(names.filter((n) => headers[n] !== undefined).map((n) => [n, headers[n]]));
const sortedKeys = (o) => (o && typeof o === 'object' ? Object.keys(o).sort() : []);

/** Summarise an NDJSON stream body the way the S4R page reads it. */
export function summariseNdjson(text) {
  const events = [];
  let unparsable = 0;
  for (const line of String(text).split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try { events.push(JSON.parse(trimmed)); } catch { unparsable += 1; }
  }
  const types = events.map((e) => e.type);
  const done = events.find((e) => e.type === 'done') || null;
  return {
    eventTypes: [...new Set(types)].sort(),
    deltaCount: types.filter((t) => t === 'delta').length,
    hasDone: Boolean(done),
    lastEventType: types[types.length - 1] || null,
    unparsableLines: unparsable,
    doneFields: sortedKeys(done),
    partFields: done && Array.isArray(done.parts) && done.parts[0] ? sortedKeys(done.parts[0]) : [],
    understoodFields: done && done.understood ? sortedKeys(done.understood) : [],
    error: (events.find((e) => e.type === 'error') || {}).error || null,
  };
}

export function contractFrom({ preflight, post }) {
  return {
    preflight: { status: preflight.status, cors: pick(preflight.headers, CORS_HEADERS) },
    post: {
      status: post.status,
      contentType: (post.headers['content-type'] || '').split(';')[0].trim(),
      cors: pick(post.headers, CORS_HEADERS),
      stream: summariseNdjson(post.text),
    },
  };
}

/**
 * Verify a fresh capture against the recorded contract. Fails on anything the S4R page relies
 * on: status, content type, CORS for the S4R origin, NDJSON framing and the fields it reads.
 */
export function verifyContract(recorded, current, { requiredDoneFields = [], requiredPartFields = [], requiredUnderstoodFields = [] } = {}) {
  const problems = [];
  const eq = (label, a, b) => { if (JSON.stringify(a) !== JSON.stringify(b)) problems.push({ check: label, recorded: a, current: b }); };
  eq('preflight.status', recorded.preflight.status, current.preflight.status);
  eq('preflight.cors', recorded.preflight.cors, current.preflight.cors);
  eq('post.status', recorded.post.status, current.post.status);
  eq('post.contentType', recorded.post.contentType, current.post.contentType);
  eq('post.cors', recorded.post.cors, current.post.cors);
  const s = current.post.stream;
  if (!s.hasDone) problems.push({ check: 'stream.done', current: false });
  if (s.unparsableLines) problems.push({ check: 'stream.ndjson', unparsableLines: s.unparsableLines });
  if (!s.eventTypes.includes('delta')) problems.push({ check: 'stream.delta', current: s.eventTypes });
  for (const f of requiredDoneFields) {
    if (recorded.post.stream.doneFields.includes(f) && !s.doneFields.includes(f)) problems.push({ check: 'done.field', field: f });
  }
  for (const f of requiredPartFields) {
    if (recorded.post.stream.partFields.includes(f) && s.partFields.length && !s.partFields.includes(f)) problems.push({ check: 'part.field', field: f });
  }
  for (const f of requiredUnderstoodFields) {
    if (recorded.post.stream.understoodFields.includes(f) && s.understoodFields.length && !s.understoodFields.includes(f)) problems.push({ check: 'understood.field', field: f });
  }
  return { ok: problems.length === 0, problems };
}
