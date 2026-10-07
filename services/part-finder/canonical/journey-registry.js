'use strict';
/**
 * Canonical journey registry (PURE). `journeys.json` is the ONE list of canonical journey keys and their
 * metadata; every service derives from it:
 *   part-finder  journey packs (module, COMPOSE pack, kill switch, catalogue fault) + routing order
 *   BFF          the control allow-list (CANONICAL_CONTROL_JOURNEYS is validated against it)
 *   orchestrator key -> likely area (faultId)
 * Loading validates the table and THROWS on a broken registry, so a bad edit fails tests / cold start instead of
 * silently mis-routing. Order is routing order: the first journey whose entry applies owns the turn (each family's
 * ownership function makes exactly one apply).
 */
const REGISTRY = require('./journeys.json');

const FAMILIES = ['washing-machine', 'dishwasher', 'fridge-freezer', 'tumble-dryer', 'oven-cooker', 'hob', 'microwave', 'vacuum', 'washer-dryer'];
const FIELDS = ['key', 'family', 'module', 'compose', 'killEnv', 'knowledgeId', 'faultId', 'fault', 'schema'];
const KEY_RE = /^[a-z][a-z0-9-]+$/;
const KILL_RE = /^CANONICAL_[A-Z0-9]+_CONTROL$/;
const FILE_RE = /^[a-z0-9-]+\.js$/;

/** Validate a registry table; returns a list of problems (empty = valid). */
function validate(journeys) {
  const problems = [];
  if (!Array.isArray(journeys) || !journeys.length) return ['registry has no journeys'];
  const seen = { key: new Set(), killEnv: new Set(), schema: new Set() };
  journeys.forEach((j, i) => {
    const at = `journeys[${i}]${j && j.key ? ` (${j.key})` : ''}`;
    for (const f of FIELDS) if (!j || typeof j[f] !== 'string' || !j[f]) problems.push(`${at}: missing ${f}`);
    if (!j) return;
    if (j.key && !KEY_RE.test(j.key)) problems.push(`${at}: bad key`);
    if (j.killEnv && !KILL_RE.test(j.killEnv)) problems.push(`${at}: bad killEnv`);
    if (j.family && !FAMILIES.includes(j.family)) problems.push(`${at}: unknown family ${j.family}`);
    for (const f of ['module', 'compose']) if (j[f] && !FILE_RE.test(j[f])) problems.push(`${at}: bad ${f}`);
    if (j.knowledgeId && j.family && !j.knowledgeId.endsWith(`:${j.faultId}`)) problems.push(`${at}: knowledgeId / faultId mismatch`);
    for (const f of ['key', 'killEnv', 'schema']) {
      if (j[f] && seen[f].has(j[f])) problems.push(`${at}: duplicate ${f} ${j[f]}`);
      if (j[f]) seen[f].add(j[f]);
    }
  });
  return problems;
}

const problems = validate(REGISTRY.journeys);
if (problems.length) throw new Error(`canonical journey registry invalid: ${problems.join('; ')}`);

const JOURNEYS = Object.freeze(REGISTRY.journeys.map((j) => Object.freeze({ ...j })));
const KEYS = Object.freeze(JOURNEYS.map((j) => j.key));
const BY_KEY = Object.freeze(Object.fromEntries(JOURNEYS.map((j) => [j.key, j])));

/**
 * Parse an allow-list string (CANONICAL_CONTROL_JOURNEYS; '+', ',', ';' or whitespace separated).
 * Unknown keys are never enabled — they are returned separately so the caller can log them.
 */
function parseAllowList(raw) {
  const tokens = String(raw || '').split(/[,+;\s]+/).map((x) => x.trim()).filter(Boolean);
  const journeys = [...new Set(tokens.filter((t) => BY_KEY[t]))];
  const unknown = [...new Set(tokens.filter((t) => !BY_KEY[t]))];
  return { journeys, unknown };
}

module.exports = { JOURNEYS, KEYS, BY_KEY, FAMILIES, validate, parseAllowList };
