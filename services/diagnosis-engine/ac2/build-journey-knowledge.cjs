'use strict';
// One-off transformation: the 63 executable journeys -> journey-knowledge.json (reusable knowledge, no control flow).
// Run from services/diagnosis-engine before the journey modules are deleted. Kept for provenance.
const fs = require('fs');
const path = require('path');
const J = require('../canonical/journeys.json').journeys;
const out = { version: '1.0.0', source: 'services/diagnosis-engine/canonical (63 journeys, retired as controllers)', journeys: [] };
const reSrc = (r) => (r ? { source: r.source, flags: r.flags } : null);
for (const j of J) {
  const p = require(`../canonical/${j.module}`);
  const c = j.compose ? require(`../canonical/${j.compose}`) : {};
  const tasks = [];
  for (const [k, v] of Object.entries(c.TASK || {})) {
    if (!v || typeof v !== 'object') continue;
    const [kind, target] = k.split(':');
    const say = typeof v.say === 'string' ? v.say : null;
    const ask = typeof v.ask === 'string' ? v.ask : null;
    if (say || ask) tasks.push({ kind, target, say, ask });
  }
  const partMatch = {};
  for (const [comp, m] of Object.entries(c.PART_MATCH || p.PART_MATCH || {})) partMatch[comp] = { re: reSrc(m.re), not: reSrc(m.not) };
  const conclusion = {};
  for (const [k, v] of Object.entries(c.CONCLUSION || {})) if (typeof v === 'string') conclusion[k] = v;
  out.journeys.push({
    key: j.key, appliance: j.family, fault: j.fault, knowledgeId: j.knowledgeId,
    causes: c.FAMILY_LABEL || {}, components: c.COMPONENT_LABEL || {},
    checks: tasks, partMatch, conclusionNotes: conclusion,
  });
}
fs.writeFileSync(path.join(__dirname, '../knowledge/journey-knowledge.json'), JSON.stringify(out, null, 1) + '\n');
console.log('journeys', out.journeys.length, 'checks', out.journeys.reduce((n, x) => n + x.checks.length, 0), 'partMatch', out.journeys.reduce((n, x) => n + Object.keys(x.partMatch).length, 0));
