'use strict';
/**
 * Journey 3 diagnostics — washing machine · water · leaking. PURE, deterministic.
 * Design: services/whichpart-api/docs/diagnostics/wm-leaking-evidence.md
 *
 *   evidenceFacts(state, ctx) -> [{name, value:'TRUE'}]   (projection of WHERE / WHEN / HOW MUCH / behaviour / checks)
 *   diagnose(state, ctx)      -> inferred
 * Reads cs/1 only (+ the displayed-code faultId via the shared J2 helper). No prose, no requests[], no safety.
 */
const engine = require('./evidence-engine.js');
const { codeFaultFor } = require('./j2-diagnostics.js');
const { SS, S, A, SA } = engine;

const FAMILY = {
  DS: 'door-seal', DR: 'dispenser', OS: 'oversudsing', IC: 'inlet-connection', IV: 'inlet-valve-or-fill',
  DC: 'drain-connection', FS: 'filter-seal', HB: 'household-backflow', PB: 'pump-body', SH: 'internal-hose', TB: 'tub-or-major-internal',
};
// Tie-break only: accessible, common, free-fix families first; internal / engineer families last.
const PRIOR = ['DS', 'DR', 'OS', 'FS', 'IC', 'DC', 'HB', 'IV', 'PB', 'SH', 'TB'];

const SIGNALS = {
  DS: { atDoor: S, onWash: S, sealTorn: SS, sealObjectRemoved: SS, restoredAfterSealFix: SS, failsAfterSealFix: SA, sealOk: SA,
    atRear: A, atDrawer: A, atFilter: A, whenOff: SA, backflow: A },
  DR: { atDrawer: S, drawerOverflow: SS, onFill: S, drawerCleaned: SS, drawerCracked: SS, restoredAfterDrawerFix: SS, failsAfterDrawerFix: SA,
    drawerOk: A, atDoor: S, atRear: A, whenOff: SA, backflow: A }, // drawer water can track down the front (research §1)
  OS: { foam: SS, atDoor: S, atDrawer: S, drawerOverflow: S, onWash: S, doseCorrected: SS, restoredAfterDoseFix: SS, failsAfterDoseFix: SA,
    doseOk: SA, whenOff: SA, atRear: A },
  FS: { atFilter: S, recentFilter: S, onDrain: S, filterReseated: SS, filterCapDamaged: SS, restoredAfterFilterFix: SS, failsAfterFilterFix: SA,
    filterSealOk: SA, atRear: A, atDrawer: A, whenOff: SA },
  IC: { atRear: S, onFill: S, whenOff: SS, recentInstall: S, inletTightened: SS, inletHoseDamaged: SS, restoredAfterInletFix: SS,
    failsAfterInletFix: SA, inletOk: SA, atDoor: A, atDrawer: A, atFilter: A, onDrain: A, backflow: A, drawerOverflow: A },
  DC: { atRear: S, onDrain: S, recentInstall: S, drainConnRefitted: SS, drainHoseDamaged: SS, restoredAfterDrainFix: SS, failsAfterDrainFix: SA,
    drainConnOk: SA, onFill: A, whenOff: SA, atDoor: A, atDrawer: A, backflow: A },
  HB: { backflow: SS, onDrain: S, atRear: S, drainConnOk: S, onFill: SA, whenOff: SA, sealTorn: A, drawerOverflow: A },
  // A drawer that still overflows once clean points at the fill side (inlet valve / dispenser hose) — catalogue leak-dispenser.
  IV: { onFill: S, whenOff: S, inletOk: S, underneath: S, drawerOverflow: S, atDoor: A, onDrain: A, sealTorn: A },
  PB: { underneath: S, atFilter: S, onDrain: S, filterSealOk: S, drainConnOk: S, codeLeak: S, whenOff: SA, onFill: A, atDoor: A, atDrawer: A,
    recentFilter: A, filterReseated: A },
  SH: { underneath: S, onWash: S, onDrain: S, major: S, sealOk: S, filterSealOk: S, drainConnOk: S, codeLeak: S, whenOff: SA,
    atDoor: A, atDrawer: A, atRear: A, recentFilter: A },
  TB: { major: S, underneath: S, onWash: S, sealOk: S, filterSealOk: S, drainConnOk: S, inletOk: S, codeLeak: S, whenOff: SA, atDrawer: A, atRear: A, minor: A },
};
const families = Object.fromEntries(Object.entries(SIGNALS).map(([k, sig]) => [k, { name: FAMILY[k], signals: sig }]));

const DECISIVE_PART = {
  DS: { sealTorn: 'door-seal' }, IC: { inletHoseDamaged: 'inlet-hose' }, DC: { drainHoseDamaged: 'drain-hose' },
  FS: { filterCapDamaged: 'pump-filter' }, DR: { drawerCracked: 'detergent-drawer' },
};
// Owner fixes whose retest can show "likely fixed" (no part).
const FIX_CHECK = { DS: ['door-seal', 'Seal'], DR: ['detergent-drawer', 'Drawer'], OS: ['detergent-dose', 'Dose'], FS: ['filter-seal', 'Filter'],
  IC: ['inlet-connection', 'Inlet'], DC: ['drain-connection', 'Drain'] };

const FACT_LABEL = {
  atDoor: 'water at the door / front', atDrawer: 'water from the detergent drawer', atRear: 'water at the back / hose connections',
  underneath: 'puddle underneath, source unseen', atFilter: 'water at the pump filter flap', onFill: 'leaks while filling', onWash: 'leaks during the wash',
  onDrain: 'leaks while draining / spinning', whenOff: 'leaks even when the machine is off', major: 'large amount of water', minor: 'small drip / small puddle',
  drawerOverflow: 'drawer overflowing', foam: 'excess foam', backflow: 'household waste backs up when it drains', recentFilter: 'pump filter recently opened',
  recentInstall: 'recently installed / moved / plumbing work', sealTorn: 'door seal torn / perished', sealObjectRemoved: 'item trapped in the door seal (removed)',
  sealOk: 'door seal intact', drawerCleaned: 'drawer blocked / built up (cleaned)', drawerCracked: 'drawer cracked', drawerOk: 'drawer clean',
  doseCorrected: 'too much / wrong detergent (changed)', doseOk: 'normal low-foam detergent dose', filterReseated: 'filter cap loose / not seated (refitted)',
  filterCapDamaged: 'filter cap or seal damaged', filterSealOk: 'filter cap tight and dry', inletTightened: 'fill-hose connection loose (tightened)',
  inletHoseDamaged: 'fill hose split / washer perished', inletOk: 'fill-hose connections tight and dry', drainConnRefitted: 'drain hose connection loose (refitted)',
  drainHoseDamaged: 'drain hose split', drainConnOk: 'drain hose and standpipe sound', codeLeak: 'flood / leak error code',
};

const obsF = (s, k) => (s.evidence && s.evidence.observations && s.evidence.observations[k]) || null;
const ov = (s, k) => { const f = obsF(s, k); return f && f.value != null ? f.value : null; };
const ot = (s, k) => { const f = obsF(s, k); if (!f || f.value == null) return null; return Number.isInteger(f.lastTurn) ? Math.max(f.lastTurn, f.turn) : f.turn; };
const ck = (s, c) => (s.evidence && s.evidence.checks && s.evidence.checks[c]) || null;
const cres = (s, c) => { const k = ck(s, c); return k && k.status === 'done' ? k.result : null; };
const FOUND = new Set(['found_and_cleared', 'found_not_cleared']);
function fixTurn(s, c) { const k = ck(s, c); return k && k.status === 'done' && FOUND.has(k.result) ? k.turn : null; }

function evidenceFacts(state, ctx = {}) {
  const s = state; const t = new Set();
  const on = (n, c) => { if (c) t.add(n); };
  on('atDoor', ov(s, 'leakAtDoor') === true); on('atDrawer', ov(s, 'leakAtDrawer') === true); on('atRear', ov(s, 'leakAtRear') === true);
  on('underneath', ov(s, 'leakUnderneath') === true); on('atFilter', ov(s, 'leakAtFilter') === true);
  on('onFill', ov(s, 'leaksOnFill') === true); on('onWash', ov(s, 'leaksOnWash') === true); on('onDrain', ov(s, 'leaksOnDrain') === true);
  on('whenOff', ov(s, 'leaksWhenOff') === true);
  on('major', ov(s, 'majorLeak') === true); on('minor', ov(s, 'majorLeak') === false);
  on('drawerOverflow', ov(s, 'drawerOverflowing') === true); on('foam', ov(s, 'excessiveFoam') === true);
  on('backflow', ov(s, 'waterReturnsAfterDrain') === true);
  on('recentFilter', ov(s, 'recentFilterAccess') === true); on('recentInstall', ov(s, 'recentInstallation') === true);
  const seal = cres(s, 'door-seal');
  on('sealTorn', seal === 'fault_seen'); on('sealObjectRemoved', FOUND.has(seal)); on('sealOk', seal === 'clear');
  const drawer = cres(s, 'detergent-drawer');
  on('drawerCleaned', FOUND.has(drawer)); on('drawerCracked', drawer === 'fault_seen'); on('drawerOk', drawer === 'clear');
  const dose = cres(s, 'detergent-dose');
  on('doseCorrected', FOUND.has(dose)); on('doseOk', dose === 'clear');
  const filt = cres(s, 'filter-seal');
  on('filterReseated', FOUND.has(filt)); on('filterCapDamaged', filt === 'fault_seen'); on('filterSealOk', filt === 'clear');
  const inlet = cres(s, 'inlet-connection');
  on('inletTightened', FOUND.has(inlet)); on('inletHoseDamaged', inlet === 'fault_seen'); on('inletOk', inlet === 'clear');
  const drain = cres(s, 'drain-connection');
  on('drainConnRefitted', FOUND.has(drain)); on('drainHoseDamaged', drain === 'fault_seen'); on('drainConnOk', drain === 'clear');
  // Retest after an owner fix: leakRecurs at or after the fix turn.
  const rec = ov(s, 'leakRecurs'); const recT = ot(s, 'leakRecurs');
  for (const [, [c, n]] of Object.entries(FIX_CHECK)) {
    const ft = fixTurn(s, c);
    if (ft == null) continue;
    on(`restoredAfter${n}Fix`, (rec === false && recT >= ft) || s.resolution === 'resolved');
    on(`failsAfter${n}Fix`, rec === true && recT >= ft);
  }
  if (ctx.codeFault === 'leak-flood') t.add('codeLeak');
  return [...t].map((name) => ({ name, value: 'TRUE' }));
}

function eligible(key, has) {
  const any = (...f) => f.some(has);
  if (key === 'DS') return any('atDoor', 'sealTorn', 'sealObjectRemoved', 'sealOk');
  if (key === 'DR') return any('atDrawer', 'drawerOverflow', 'drawerCleaned', 'drawerCracked', 'drawerOk', 'atDoor');
  if (key === 'OS') return any('foam', 'doseCorrected', 'doseOk', 'drawerOverflow');
  if (key === 'FS') return any('atFilter', 'recentFilter', 'filterReseated', 'filterCapDamaged', 'filterSealOk') || (has('underneath') && has('onDrain'));
  if (key === 'IC') return any('atRear', 'onFill', 'whenOff', 'recentInstall', 'inletTightened', 'inletHoseDamaged', 'inletOk');
  if (key === 'DC') return any('atRear', 'onDrain', 'recentInstall', 'drainConnRefitted', 'drainHoseDamaged', 'drainConnOk');
  if (key === 'HB') return has('backflow');
  if (key === 'IV') return any('onFill', 'whenOff', 'drawerOverflow');
  if (key === 'PB') return any('underneath', 'atFilter');
  if (key === 'SH') return has('underneath');
  if (key === 'TB') return has('underneath') && (has('major') || [has('sealOk'), has('filterSealOk'), has('drainConnOk'), has('inletOk')].filter(Boolean).length >= 2);
  return true;
}

function diagnose(state, ctx = {}) {
  const codeFault = ctx.codeFault !== undefined ? ctx.codeFault : codeFaultFor(state, ctx.errorCodes || null);
  const facts = evidenceFacts(state, { ...ctx, codeFault });
  const r = engine.rankFamilies({ families, prior: PRIOR, facts, eligible, labels: FACT_LABEL });
  const { has } = r;
  let leader = null;
  if (r.top) {
    const map = DECISIVE_PART[r.top.key];
    const decisive = map ? Object.keys(map).find((f) => has(f)) || null : null;
    const level = r.committed && decisive ? 'component' : 'cause_family';
    leader = { family: r.top.family, key: r.top.key, committed: r.committed, level, margin: r.margin,
      component: level === 'component' ? map[decisive] : null, decisive };
  }
  const restored = leader && FIX_CHECK[leader.key] ? `restoredAfter${FIX_CHECK[leader.key][1]}Fix` : null;
  const likelyResolved = Boolean(leader && leader.committed && restored && has(restored));
  const reasons = [];
  let component = null;
  if (!leader) reasons.push('no-leader');
  else {
    if (!leader.committed) reasons.push('leader-not-committed');
    if (!DECISIVE_PART[leader.key]) reasons.push('leader-not-part-eligible');
    else if (!leader.decisive) reasons.push('no-decisive-fact');
    else component = DECISIVE_PART[leader.key][leader.decisive];
    if (has('backflow')) reasons.push('household-backflow-evidence');
    if (r.second && r.margin < engine.COMMIT_MARGIN) reasons.push('alternative-within-margin');
  }
  const sufficient = reasons.length === 0;
  return {
    schema: 'j3-diag/1', facts: [...r.trueSet].sort(), codeFault: codeFault || null,
    rank: r.rank.map(({ key, ...x }) => x), contradicted: r.contradicted.map(({ key, ...x }) => x),
    leader, likelyResolved, partEvidence: { sufficient, component: sufficient ? component : null, reasons },
    noViableCause: r.rank.length === 0,
  };
}

module.exports = { FAMILY, PRIOR, SIGNALS, FACT_LABEL, DECISIVE_PART, FIX_CHECK, evidenceFacts, diagnose };
