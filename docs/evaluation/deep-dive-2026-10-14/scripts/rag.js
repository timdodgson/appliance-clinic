'use strict';
// Read-only RAG measurement for Appliance Clinic (ac3 run independent-100-21.16).
// Usage: node rag.js [section]   sections: inventory coverage retrieval live corr usage all
const fs = require('fs');
const path = require('path');
const REPO = '/home/user/appliance-clinic';
const ENG = path.join(REPO, 'services/diagnosis-engine');
const K = require(path.join(ENG, 'ac2/knowledge.js'));
const E = require(path.join(ENG, 'ac2/errorcodes.js'));
const docs = require(path.join(ENG, 'knowledge/knowledge-docs.json')).docs;
const journeys = require(path.join(ENG, 'knowledge/journey-knowledge.json')).journeys;
const normal = require(path.join(ENG, 'knowledge/normal-operation.json')).entries;
const safety = require(path.join(ENG, 'knowledge/safety-information.json')).byKnowledgeId;
const cases = require(path.join(REPO, 'evaluation/independent-100/cases.json')).cases;
const gold = require('./gold.json');
const RUN = path.join(REPO, 'evaluation/rebuild/out/independent-100-21.16');
const GA = path.join(REPO, 'evaluation/independent-100/out');
const FAM = { hob: 'hobs' };
const fam = (c) => FAM[c.family] || c.family;
const inScope = cases.filter((c) => c.family !== 'out-of-scope');
const byKid = {};
for (const j of journeys) (byKid[j.knowledgeId] = byKid[j.knowledgeId] || []).push(j);
const docById = Object.fromEntries(docs.map((d) => [d.knowledgeId, d]));
const mean = (a) => (a.length ? +(a.reduce((x, y) => x + y, 0) / a.length).toFixed(2) : null);
const pct = (n, d) => `${n}/${d} (${d ? ((100 * n) / d).toFixed(1) : 0}%)`;
const re = (s) => new RegExp(s, 'i');
const sec = process.argv[2] || 'all';
const on = (s) => sec === 'all' || sec === s;
const load = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));

// ---------------------------------------------------------------- 1. inventory
if (on('inventory')) {
  console.log('== 1. INVENTORY ==');
  const per = {};
  for (const d of docs) per[d.applianceFamily] = (per[d.applianceFamily] || 0) + 1;
  console.log('knowledge-docs notes:', docs.length, 'distinct faultIds:', new Set(docs.map((d) => d.faultId)).size, 'distinct knowledgeIds:', new Set(docs.map((d) => d.knowledgeId)).size);
  console.log('per appliance:', JSON.stringify(per));
  const jPer = {};
  for (const j of journeys) jPer[j.appliance] = (jPer[j.appliance] || 0) + 1;
  console.log('journey-knowledge entries:', journeys.length, JSON.stringify(jPer), 'docs with >=1 journey:', docs.filter((d) => byKid[d.knowledgeId]).length);
  const nPer = {};
  for (const n of normal) for (const a of n.appliance) nPer[a] = (nPer[a] || 0) + 1;
  console.log('normal-operation entries:', normal.length, JSON.stringify(nPer));
  console.log('safety-information entries:', Object.keys(safety).length);
  const fields = {};
  for (const d of docs) for (const k of Object.keys(d)) fields[k] = (fields[k] || 0) + 1;
  console.log('doc fields (count of notes having it):', JSON.stringify(fields));
  const sz = docs.map((d) => JSON.stringify(d).length);
  const txt = docs.map((d) => (d.text || '').length);
  const cd = docs.map((d) => JSON.stringify(compact(d)).length);
  console.log('avg JSON size/doc chars:', mean(sz), 'min', Math.min(...sz), 'max', Math.max(...sz));
  console.log('avg doc.text chars:', mean(txt), '| avg compactDoc (what retrieve returns) chars:', mean(cd), '| what the reasoner receives (turn.js enrich drops beforeReplacingAPart):', mean(docs.map((d) => { const c = compact(d); delete c.beforeReplacingAPart; delete c.knowledgeId; return JSON.stringify(c).length; })));
  const cnt = (f) => docs.filter(f).length;
  const arr = (k) => mean(docs.map((d) => (d[k] || []).length));
  console.log('avg list lengths: symptoms', arr('symptoms'), 'likelyComponents', arr('likelyComponents'), 'discriminators', arr('discriminators'), 'components', arr('components'), 'commonConfusion', arr('commonConfusion'), 'adviceBeforeReplacement', arr('adviceBeforeReplacement'), 'checks(doc)', arr('checks'));
  console.log('notes with empty likelyComponents:', cnt((d) => !d.likelyComponents.length), docs.filter((d) => !d.likelyComponents.length).map((d) => d.knowledgeId).join(','));
  console.log('notes with make != null:', cnt((d) => d.make), '| platform != null:', cnt((d) => d.platform));
  const full = (d) => JSON.stringify(d) + JSON.stringify(byKid[d.knowledgeId] || []);
  const feat = {
    'if-then discriminators ("If ..." in discriminators)': (d) => (d.discriminators || []).some((x) => /\bif\b/i.test(x)),
    'ordered stepwise checks in a journey (>=2 ask_check)': (d) => (byKid[d.knowledgeId] || []).some((j) => j.checks.filter((c) => c.kind === 'ask_check').length >= 2),
    'components with supports/against evidence': (d) => (d.components || []).some((c) => (c.supports || []).length && (c.against || []).length),
    'brand name mentioned anywhere': (d) => /\b(bosch|siemens|neff|samsung|lg|hotpoint|indesit|beko|whirlpool|aeg|zanussi|electrolux|candy|hoover|miele|dyson|shark|haier|smeg)\b/i.test(full(d)),
    'error code string mentioned (e.g. E18, F05, 4C)': (d) => /\b([EF]:?\d{2,3}|\d[A-Z]{1,2}|[A-Z]{1,2}\d{1,2})\b/.test(d.text || ''),
    'part number pattern (e.g. 00144978, 481010...)': (d) => /\b\d{6,}\b|\bpart (no|number)\b/i.test(full(d)),
    'recall / safety notice mentioned': (d) => /\brecall|safety notice|product safety\b/i.test(full(d)),
    'model number pattern (e.g. WAN28281GB)': (d) => /\b[A-Z]{2,4}\d{3,}[A-Z0-9]*\b/.test(full(d)),
  };
  for (const [k, f] of Object.entries(feat)) console.log(`  ${k}: ${cnt(f)}/${docs.length}`);
  console.log('examples with brand mention:', docs.filter(feat['brand name mentioned anywhere']).slice(0, 8).map((d) => d.knowledgeId).join(', '));
  const ex = docs.find((d) => d.knowledgeId === 'washing-machine:drain-pump');
  console.log('example compactDoc (washing-machine:drain-pump):\n' + JSON.stringify(compact(ex), null, 1).slice(0, 1800));
}

function compact(d) {
  const checks = [];
  const js = byKid[d.knowledgeId] || [];
  for (const j of js) for (const c of j.checks) { if (c.kind !== 'ask_check') continue; if (checks.length < 6) checks.push([c.say, c.ask].filter(Boolean).join(' ').slice(0, 320)); }
  const causes = {};
  for (const j of js) Object.assign(causes, j.causes);
  return { knowledgeId: d.knowledgeId, appliance: d.applianceFamily, fault: d.label, likelyComponents: d.likelyComponents, causes: Object.values(causes).slice(0, 8),
    discriminators: (d.discriminators || []).slice(0, 4).map((x) => x.slice(0, 260)), commonConfusion: (d.commonConfusion || []).slice(0, 3).map((c) => `${c.name}: ${c.note}`.slice(0, 260)),
    ownerSafeChecks: checks, beforeReplacingAPart: (d.adviceBeforeReplacement || []).slice(0, 4).map((x) => x.slice(0, 200)) };
}

// ---------------------------------------------------------------- 2. coverage
function strictFields(d) {
  const js = byKid[d.knowledgeId] || [];
  return [...d.likelyComponents, ...(d.components || []).flatMap((c) => [c.name, c.partName]), ...js.flatMap((j) => [...Object.values(j.causes || {}), ...Object.values(j.components || {})]), d.label].filter(Boolean).join(' | ');
}
const shown = (d) => JSON.stringify(compact(d)); // what retrieve() actually hands over
if (on('coverage')) {
  console.log('\n== 2. COVERAGE (94 in-scope cases) ==');
  let det = 0, detShown = 0, man = { full: 0, partial: 0, none: 0 }, goldTermInGold = 0, goldHasKb = 0, normalCovered = 0;
  const rows = [];
  for (const c of inScope) {
    const g = gold[c.id]; const r = re(g.terms); const f = fam(c);
    const famDocs = docs.filter((d) => d.applianceFamily === f);
    const strict = famDocs.filter((d) => r.test(strictFields(d))).map((d) => d.knowledgeId);
    const inShown = famDocs.filter((d) => r.test(shown(d))).map((d) => d.knowledgeId);
    const famNormal = normal.filter((n) => n.appliance.includes(f) && r.test(n.normal)).map((n) => n.id);
    if (strict.length || famNormal.length) det++;
    if (inShown.length || famNormal.length) detShown++;
    man[g.q]++;
    if (g.kb.length) goldHasKb++;
    if ((g.normal || []).length) normalCovered++;
    const gTerm = g.kb.filter((k) => r.test(shown(docById[k])));
    if (gTerm.length || (g.normal || []).some((id) => r.test(normal.find((n) => n.id === id).normal))) goldTermInGold++;
    rows.push([c.id, g.q, strict.length ? 'Y' : '-', famNormal.length ? 'Y' : '-', g.kb.join(',') || '(none)', (g.normal || []).join(',')]);
  }
  console.log('Deterministic D1: hiddenTruth term regex (gold.json terms) found in a same-family note\'s likelyComponents/components/journey causes/label, OR in a same-family normal-operation note:', pct(det, inScope.length));
  console.log('Deterministic D2: same regex found anywhere in the compactDoc that retrieve() returns (or normal note):', pct(detShown, inScope.length));
  console.log('Deterministic D3: same regex found in one of the MANUAL gold notes (compactDoc) or gold normal note:', pct(goldTermInGold, inScope.length));
  console.log('Manual: full', man.full, 'partial', man.partial, 'none', man.none, '=> full coverage', pct(man.full, inScope.length), '; full+partial', pct(man.full + man.partial, inScope.length));
  console.log('Cases with a gold fault note:', goldHasKb, '| with a gold normal-operation note:', normalCovered);
  console.log('id | manualQ | D1-fault-note | D1-normal | gold notes | gold normal');
  for (const r of rows) if (r[1] !== 'full' || (r[2] === '-' && r[3] === '-')) console.log('  ' + r.join(' | '));
}

// ---------------------------------------------------------------- 3. retrieval (offline, live code)
const hit = (ids, g) => ids.some((i) => g.kb.includes(i));
function rank(ids, g) { const i = ids.findIndex((x) => g.kb.includes(x)); return i < 0 ? '-' : i + 1; }
if (on('retrieval')) {
  console.log('\n== 3. RETRIEVAL (live retrieve() on case text; gold-kb cases only) ==');
  const evalSet = inScope.filter((c) => gold[c.id].kb.length);
  const variants = {
    'A opener, appliance given': (c) => K.retrieve({ appliance: fam(c), text: c.opener }),
    'B opener, no appliance (applianceHints)': (c) => K.retrieve({ text: c.opener }),
    'C opener+symptom+codes+sounds+whatDoesNotWork, appliance given': (c) => K.retrieve({ appliance: fam(c), text: [c.opener, c.factBank.symptom, c.factBank.displayOrCodes, c.factBank.soundsAndSmells, c.factBank.whatDoesNotWork].join(' ') }),
  };
  for (const [name, fn] of Object.entries(variants)) {
    let h1 = 0, h3 = 0, empty = 0; const miss = [];
    for (const c of evalSet) { const r = fn(c); const ids = r.map((x) => x.knowledgeId); if (!ids.length) empty++; if (ids[0] && gold[c.id].kb.includes(ids[0])) h1++; if (hit(ids, gold[c.id])) h3++; else miss.push(`${c.id}[${ids.join(',') || 'none'}]`); }
    console.log(`${name}: top1 ${pct(h1, evalSet.length)}  top3 ${pct(h3, evalSet.length)}  empty ${empty}`);
    if (name.startsWith('A')) console.log('  misses A:\n   ' + miss.join('\n   '));
  }
  // normal notes
  const nSet = inScope.filter((c) => (gold[c.id].normal || []).length);
  let nh = 0; const nm = [];
  for (const c of nSet) { const r = K.normalNotes({ appliance: fam(c), text: c.opener }).map((x) => x.id); if (r.some((i) => gold[c.id].normal.includes(i))) nh++; else nm.push(`${c.id}[${r.join(',') || 'none'}]`); }
  console.log(`normalNotes() on opener (appliance given): ${pct(nh, nSet.length)}; misses: ${nm.join(' ')}`);
  // why: scoring transparency for the misses
  console.log('Score detail for misses (variant A): query terms matching the gold note vs the winners');
  for (const c of evalSet) {
    const ids = K.retrieve({ appliance: fam(c), text: c.opener }).map((x) => x.knowledgeId);
    if (hit(ids, gold[c.id])) continue;
    const q = termsOf(c.opener);
    const gm = gold[c.id].kb.map((k) => `${k}:${[...q].filter((t) => idxTerms(docById[k]).has(t)).join('/') || '0'}`);
    console.log(`  ${c.id} opener="${c.opener.slice(0, 90)}" gold-overlap=${gm.join(' ')}`);
  }
}
function termsOf(text) { const ws = K.words(text); const s = new Set(); ws.forEach((w, i) => { s.add(w); if (i + 1 < ws.length) s.add(`${w} ${ws[i + 1]}`); }); return s; }
function idxTerms(d) { return termsOf([d.label, ...(d.symptoms || []), d.faultId.replace(/-/g, ' ')].join(' ')); }

// ---------------------------------------------------------------- live data loader
function live(c) {
  const conv = load(path.join(RUN, 'conversations/ac3', `${c.id}.json`));
  const turns = conv.meta.map((m) => (m && m.ac2) || null);
  const kids = turns.map((a) => (a && a.tags && a.tags.enrichment ? a.tags.enrichment.knowledgeIds : null));
  const codes = turns.map((a) => (a && a.tags && a.tags.enrichment ? a.tags.enrichment.codes : []));
  const replies = conv.transcript.filter((t) => t.role === 'assistant').map((t) => t.text);
  const judge = load(path.join(RUN, 'judge/primary', `${c.id}.ac3.json`));
  return { conv, turns, kids, codes, replies, judge };
}
function gaOf(c) {
  const conv = load(path.join(GA, 'conversations/ga', `${c.id}.json`));
  const judge = load(path.join(GA, 'judge/primary', `${c.id}.ga.json`));
  return { replies: conv.transcript.filter((t) => t.role === 'assistant').map((t) => t.text), judge };
}

// ---------------------------------------------------------------- 3b. live retrieval
if (on('live')) {
  console.log('\n== 3b. LIVE RETRIEVAL in run 21.16 (meta[].ac2.tags.enrichment.knowledgeIds) ==');
  const evalSet = inScope.filter((c) => gold[c.id].kb.length);
  let t1 = 0, any = 0, last = 0, noneEver = 0, turnsAll = 0, turnsHit = 0, repro = 0, reproN = 0;
  const miss = [];
  for (const c of evalSet) {
    const L = live(c); const g = gold[c.id];
    const first = L.kids[0] || [];
    if (hit(first, g)) t1++;
    const everIds = [...new Set(L.kids.flat().filter(Boolean))];
    if (!everIds.length) noneEver++;
    if (L.kids.some((k) => k && hit(k, g))) any++; else miss.push(`${c.id} appliance=${(L.turns[0] && L.turns[0].tags && L.turns[0].tags.labels && L.turns[0].tags.labels.appliance.value) || '?'} got=[${everIds.join(',') || 'none'}]`);
    const lastK = [...L.kids].reverse().find((k) => k) || [];
    if (hit(lastK, g)) last++;
    for (const k of L.kids) { if (!k) continue; turnsAll++; if (hit(k, g)) turnsHit++; }
    // reproduce turn 1 offline: symptom = reading.symptom, text = opener
    const a = L.turns[0];
    if (a && a.tags && a.tags.reading && a.tags.labels) {
      const app = a.tags.labels.appliance.value; const sym = a.tags.reading.symptom;
      if (app && L.kids[0] && L.kids[0].length) { reproN++; const r = K.retrieve({ appliance: app, text: [sym, c.opener].filter(Boolean).join(' ') }).map((x) => x.knowledgeId); if (JSON.stringify(r) === JSON.stringify(L.kids[0])) repro++; }
    }
  }
  console.log(`gold note in top-3 at turn 1: ${pct(t1, evalSet.length)}`);
  console.log(`gold note in top-3 at ANY turn: ${pct(any, evalSet.length)}`);
  console.log(`gold note in top-3 at the LAST turn with knowledge: ${pct(last, evalSet.length)}`);
  console.log(`per-turn: ${pct(turnsHit, turnsAll)} turns carry the gold note; cases with no knowledge ever: ${noneEver}`);
  console.log(`offline reproduction of turn-1 ids (retrieve({appliance, text: reading.symptom + opener})): ${pct(repro, reproN)}`);
  console.log('live misses (never retrieved gold):\n  ' + miss.join('\n  '));
}

const CODES = { 'WM-01': 'E18', 'WM-04': '4C', 'WM-09': 'OE', 'WD-04': 'dE', 'WD-06': 'E03', 'DW-01': 'E24', 'DW-02': '4C', 'DW-04': 'E15', 'DW-07': 'E09', 'FF-07': '22E', 'MW-03': 'H98', 'OC-04': 'E011', 'HB-02': 'U', 'HB-06': 'Er03', 'VC-03': null, 'VC-06': '5' };
// ---------------------------------------------------------------- 4. correlation
if (on('corr')) {
  console.log('\n== 4. CORRELATION with judge overall (ac3 run 21.16, primary judge) ==');
  const grp = {};
  const add = (k, v) => (grp[k] = grp[k] || []).push(v);
  const rows = [];
  for (const c of inScope) {
    const L = live(c); const g = gold[c.id]; const o = L.judge.scores.overall; const ga = gaOf(c).judge.scores.overall;
    const anyHit = g.kb.length ? L.kids.some((k) => k && hit(k, g)) : null;
    add('all in-scope', o); add('GA all in-scope', ga);
    if (anyHit === true) { add('gold note retrieved (any turn)', o); add('  GA same cases', ga); }
    if (anyHit === false) { add('gold note NOT retrieved', o); add('  GA same cases ', ga); }
    if (!g.kb.length) add('no gold fault note (normal/none)', o);
    add(`coverage=${g.q}`, o);
    rows.push({ id: c.id, o, ga, anyHit });
  }
  for (const [k, v] of Object.entries(grp)) console.log(`  ${k.padEnd(36)} n=${String(v.length).padStart(3)} mean overall=${mean(v)}  (<=2: ${v.filter((x) => x <= 2).length})`);
  // error code cases
  console.log('\nError-code cases (tag error-code):');
  const ec = inScope.filter((c) => c.tags.includes('error-code'));
  const res = [], unres = [];
  for (const c of ec) {
    const L = live(c); const o = L.judge.scores.overall;
    const all = L.codes.flat().filter(Boolean);
    const st = [...new Set(all.map((x) => `${x.code}:${x.status}`))];
    const resolved = all.some((x) => x.status === 'RESOLVED');
    (resolved ? res : unres).push(o);
    const f = c.factBank; const code = CODES[c.id];
    const off = code ? E.lookup({ code, brand: f.make, appliance: fam(c) }) : null;
    const offTxt = off ? `${off.status}${off.candidates && off.candidates[0] ? ` faultId=${off.candidates[0].faultId} "${String(off.candidates[0].meaning).slice(0, 60)}"` : ''}` : 'n/a';
    const goldHit = L.kids.some((k) => k && hit(k, gold[c.id]));
    console.log(`  ${c.id} ${f.make} code=${code || '-'} live=[${st.join(', ') || 'none extracted'}] goldNoteRetrieved=${goldHit} offlineLookup=${offTxt} | overall ac3=${o} ga=${gaOf(c).judge.scores.overall}`);
  }
  console.log(`  RESOLVED at some turn: n=${res.length} mean=${mean(res)} | not resolved/no code: n=${unres.length} mean=${mean(unres)}`);
}

// ---------------------------------------------------------------- 5. usage
const STOPW = new Set('the a an and or to of in on at for with is are it this that be your you if can check could then there have has not no do does was were what any from by as so or its it\'s will would should also please let know me tell my machine appliance'.split(' '));
const cw = (s) => new Set(String(s).toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter((w) => w.length > 3 && !STOPW.has(w)));
if (on('usage')) {
  console.log('\n== 5. USAGE ==');
  let acAny = 0, gaAny = 0, acFinal = 0, gaFinal = 0, acFirst = 0, gaFirst = 0; const n = inScope.length;
  const diff = [];
  for (const c of inScope) {
    const r = re(gold[c.id].terms); const L = live(c); const G = gaOf(c);
    const a = L.replies.some((x) => r.test(x)), b = G.replies.some((x) => r.test(x));
    acAny += a; gaAny += b; acFinal += r.test(L.replies[L.replies.length - 1] || ''); gaFinal += r.test(G.replies[G.replies.length - 1] || '');
    acFirst += r.test(L.replies[0] || ''); gaFirst += r.test(G.replies[0] || '');
    if (a !== b) diff.push(`${c.id}:${a ? 'AC' : 'GA'}`);
  }
  console.log(`hiddenTruth term mentioned in ANY reply: AC3 ${pct(acAny, n)} vs GA ${pct(gaAny, n)}`);
  console.log(`  ... in FIRST reply: AC3 ${pct(acFirst, n)} vs GA ${pct(gaFirst, n)}`);
  console.log(`  ... in FINAL reply: AC3 ${pct(acFinal, n)} vs GA ${pct(gaFinal, n)}`);
  console.log(`  only one system mentions it: ${diff.join(' ')}`);
  // split by whether gold note was retrieved
  const s = { hit: [0, 0, 0], miss: [0, 0, 0] };
  for (const c of inScope) { const g = gold[c.id]; if (!g.kb.length) continue; const L = live(c); const G = gaOf(c); const r = re(g.terms); const k = L.kids.some((x) => x && hit(x, g)) ? 'hit' : 'miss'; s[k][0]++; s[k][1] += L.replies.some((x) => r.test(x)); s[k][2] += G.replies.some((x) => r.test(x)); }
  console.log(`  gold retrieved: n=${s.hit[0]} AC3 mentions ${s.hit[1]} GA ${s.hit[2]} | gold not retrieved: n=${s.miss[0]} AC3 ${s.miss[1]} GA ${s.miss[2]}`);

  // per-turn overlap with the retrieved notes (AC3 reply at turn t vs GA reply at turn t as control)
  let turns = 0, acComp = 0, gaComp = 0, acTop = 0, gaTop = 0; const acOv = [], gaOv = [], acChk = [], gaChk = [];
  for (const c of inScope) {
    const L = live(c); const G = gaOf(c);
    L.turns.forEach((a, t) => {
      const ids = L.kids[t]; if (!ids || !ids.length) return; const ra = L.replies[t]; const rg = G.replies[t]; if (!ra || !rg) return;
      turns++;
      const notes = ids.map((i) => docById[i]).filter(Boolean);
      const comps = [...new Set(notes.flatMap((d) => d.likelyComponents.map((x) => x.split(/[\/(,—\[]/)[0].trim().toLowerCase()).filter((x) => x.length > 3)))];
      const m = (txt) => comps.some((p) => txt.toLowerCase().includes(p));
      acComp += m(ra); gaComp += m(rg);
      const top = (docById[ids[0]].likelyComponents || []).map((x) => x.split(/[\/(,—\[]/)[0].trim().toLowerCase()).filter((x) => x.length > 3);
      acTop += top.some((p) => ra.toLowerCase().includes(p)); gaTop += top.some((p) => rg.toLowerCase().includes(p));
      const noteWords = cw(notes.map((d) => JSON.stringify(compact(d))).join(' '));
      const ov = (txt) => { const w = cw(txt); let k = 0; for (const x of w) if (noteWords.has(x)) k++; return w.size ? k / w.size : 0; };
      acOv.push(ov(ra)); gaOv.push(ov(rg));
      const chkWords = cw(notes.flatMap((d) => compact(d).ownerSafeChecks).join(' '));
      if (chkWords.size) { const cov = (txt) => { const w = cw(txt); let k = 0; for (const x of chkWords) if (w.has(x)) k++; return k / chkWords.size; }; acChk.push(cov(ra)); gaChk.push(cov(rg)); }
    });
  }
  console.log(`\nTurns with retrieved notes (paired with GA reply at same turn index): ${turns}`);
  console.log(`  reply names >=1 likelyComponent of the 3 retrieved notes: AC3 ${pct(acComp, turns)} vs GA ${pct(gaComp, turns)}`);
  console.log(`  reply names >=1 likelyComponent of the TOP note: AC3 ${pct(acTop, turns)} vs GA ${pct(gaTop, turns)}`);
  console.log(`  share of reply content-words that occur in the notes: AC3 ${mean(acOv)} vs GA ${mean(gaOv)}`);
  console.log(`  share of note ownerSafeChecks content-words that appear in reply (n=${acChk.length} turns with checks): AC3 ${mean(acChk)} vs GA ${mean(gaChk)}`);
  const lenA = [], lenG = [];
  for (const c of inScope) { lenA.push(...live(c).replies.map((x) => x.length)); lenG.push(...gaOf(c).replies.map((x) => x.length)); }
  console.log(`  (reply length chars: AC3 mean ${mean(lenA)} vs GA mean ${mean(lenG)} - GA longer replies inflate its recall-style measures)`);
}

// ---------------------------------------------------------------- 5b. handed-but-unused + failure modes
if (on('unused')) {
  console.log('\n== 5b. KNOWLEDGE HANDED BUT NOT USED (turn 1) ==');
  let handed = 0, used = 0, gaUsed = 0; const lost = [];
  for (const c of inScope) {
    const g = gold[c.id]; if (!g.kb.length) continue; const r = re(g.terms); const L = live(c); const G = gaOf(c);
    const k0 = L.kids[0] || []; const gk = k0.filter((k) => g.kb.includes(k));
    if (!gk.length) continue;
    // the gold note returned at turn 1 itself contains the hiddenTruth term (as handed to the reasoner)
    if (!gk.some((k) => r.test(JSON.stringify(compact(docById[k]))))) continue;
    handed++; const u = r.test(L.replies[0] || ''); used += u; gaUsed += r.test(G.replies[0] || '');
    if (!u) lost.push(`${c.id} (o=${L.judge.scores.overall}) reply1="${(L.replies[0] || '').slice(0, 110).replace(/\n/g, ' ')}"`);
  }
  console.log(`turn-1: gold note retrieved AND it contains the hiddenTruth term: ${handed} cases; AC3 first reply names it ${pct(used, handed)}; GA first reply ${pct(gaUsed, handed)}`);
  console.log('lost:\n  ' + lost.join('\n  '));
  console.log('\n== 4b. CRITICAL FLAGS (primary judge, 94 in-scope) ==');
  const fl = {}, gfl = {};
  for (const c of inScope) {
    for (const [k, v] of Object.entries(live(c).judge.critical || {})) if (v.flag) fl[k] = (fl[k] || 0) + 1;
    for (const [k, v] of Object.entries(gaOf(c).judge.critical || {})) if (v.flag) gfl[k] = (gfl[k] || 0) + 1;
  }
  console.log('AC3', JSON.stringify(fl)); console.log('GA ', JSON.stringify(gfl));
  const dims = Object.keys(live(inScope[0]).judge.scores);
  console.log('mean sub-scores AC3 vs GA:');
  for (const d of dims) console.log(`  ${d.padEnd(22)} ${mean(inScope.map((c) => live(c).judge.scores[d]))} vs ${mean(inScope.map((c) => gaOf(c).judge.scores[d]))}`);
  console.log('\nlow (<=2) AC3 cases WITH gold note retrieved - judge rationale head:');
  for (const c of inScope) { const g = gold[c.id]; const L = live(c); if (L.judge.scores.overall > 2 || !g.kb.length || !L.kids.some((k) => k && hit(k, g))) continue;
    const f = Object.entries(L.judge.critical || {}).filter(([, v]) => v.flag).map(([k]) => k).join(',');
    console.log(`  ${c.id} o=${L.judge.scores.overall} ga=${gaOf(c).judge.scores.overall} flags=[${f}] ${L.judge.rationale.slice(0, 230).replace(/\n/g, ' ')}`); }
}
