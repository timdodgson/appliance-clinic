/**
 * Behavioural smoke checks against the public AC /api, split into exact checks
 * (status, response shape, safety decision) and banded checks (LLM-dependent output).
 */
export function summariseApiResponse(res) {
  let json = null;
  try { json = JSON.parse(res.text); } catch { /* recorded as unparsable */ }
  return {
    status: res.status,
    contentType: (res.headers['content-type'] || '').split(';')[0].trim(),
    parsed: Boolean(json),
    keys: json ? Object.keys(json).sort() : [],
    safety: json ? Boolean(json.safety) : null,
    needsModel: json ? json.needsModel ?? null : null,
    hasPendingRequest: json ? Boolean(json.pendingRequest) : null,
    partCount: json && Array.isArray(json.parts) ? json.parts.length : null,
    replyLength: json && typeof json.reply === 'string' ? json.reply.length : null,
    hasStateToken: json ? typeof json.stateToken === 'string' : null,
    ms: res.ms,
  };
}

export function compareSmoke(baseline, current, { replyLengthRatio = [0.4, 2.5] } = {}) {
  const exact = [];
  const banded = [];
  for (const [id, b] of Object.entries(baseline)) {
    const c = current[id];
    if (!c) { exact.push({ scenario: id, check: 'missing' }); continue; }
    for (const key of ['status', 'contentType', 'parsed', 'safety']) {
      if (JSON.stringify(b[key]) !== JSON.stringify(c[key])) exact.push({ scenario: id, check: key, baseline: b[key], current: c[key] });
    }
    const removedKeys = b.keys.filter((k) => !c.keys.includes(k));
    if (removedKeys.length) exact.push({ scenario: id, check: 'keys-removed', keys: removedKeys });
    if (b.replyLength && c.replyLength !== null) {
      const ratio = c.replyLength / b.replyLength;
      if (ratio < replyLengthRatio[0] || ratio > replyLengthRatio[1]) banded.push({ scenario: id, check: 'reply-length', ratio: Number(ratio.toFixed(2)) });
    }
  }
  return { ok: exact.length === 0, exact, banded };
}

export function checkExpectations(scenario, summary) {
  const problems = [];
  if (summary.status !== 200) problems.push({ check: 'status', value: summary.status });
  if (scenario.expect && 'safety' in scenario.expect && summary.safety !== scenario.expect.safety) {
    problems.push({ check: 'safety', expected: scenario.expect.safety, value: summary.safety });
  }
  return problems;
}
