/**
 * Diagnosis Lambda ingress checks other than the S4R /part-finder contract.
 *
 * The diagnosis Lambda is also reachable through the S4R HTTP API (route POST /ai/chat,
 * unauthenticated). That route is recorded and verified separately, so the /part-finder
 * contract stays exactly what the S4R page relies on.
 */
import { summariseNdjson } from './contract.js';

export function summariseIngress(res) {
  const contentType = (res.headers['content-type'] || '').split(';')[0].trim();
  let framing = 'other';
  let json = null;
  try { json = JSON.parse(res.text); framing = 'json'; } catch {
    if (summariseNdjson(res.text).eventTypes.length) framing = 'ndjson';
  }
  return {
    status: res.status,
    contentType,
    framing,
    jsonKeys: json && typeof json === 'object' && !Array.isArray(json) ? Object.keys(json).sort() : [],
    stream: framing === 'ndjson' ? summariseNdjson(res.text) : null,
  };
}

/** Structural comparison: status, content type, framing, and no fields lost. */
export function verifyIngress(recorded, current) {
  const problems = [];
  for (const key of ['status', 'contentType', 'framing']) {
    if (recorded[key] !== current[key]) problems.push({ check: key, recorded: recorded[key], current: current[key] });
  }
  const lost = recorded.jsonKeys.filter((k) => !current.jsonKeys.includes(k));
  if (lost.length) problems.push({ check: 'json-keys-removed', keys: lost });
  if (recorded.stream && current.stream) {
    const lostDone = recorded.stream.doneFields.filter((k) => !current.stream.doneFields.includes(k));
    if (lostDone.length) problems.push({ check: 'done-fields-removed', keys: lostDone });
    if (!current.stream.hasDone) problems.push({ check: 'stream.done', current: false });
  }
  return { ok: problems.length === 0, problems };
}
