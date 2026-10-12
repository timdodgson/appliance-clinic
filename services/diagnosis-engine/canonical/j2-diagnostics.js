'use strict';
/**
 * Journey 2 diagnostics — washing machine · motion · not spinning. PURE, deterministic.
 *
 * Design: services/whichpart-api/docs/diagnostics/wm-not-spinning-evidence.md
 *
 *   architectureOf(state, {modelParts, errorCodes}) -> {drive, motor, basis[]}       (typed machine capability)
 *   codeFaultFor(state, errorCodes)                 -> catalogue faultId for the displayed code | null
 *   evidenceFacts(state, ctx)                       -> [{name, value:'TRUE'}]        (projection, never persisted)
 *   diagnose(state, ctx)                            -> inferred
 *
 * Reads cs/1 ONLY (observations, checks, identity for architecture/code, resolution) plus the typed model
 * part list (catalogue titles for the CONFIRMED model). Never reads prose, requests[] or safety.
 * Scoring / ranking / commit: the shared evidence engine (same semantics as Journey 1).
 */

const engine = require('./evidence-engine.js');
const { SS, S, A, SA } = engine;

const FAMILY = {
  LB: 'load-imbalance', PG: 'programme-setting', SU: 'suspension-or-movement', PL: 'pressure-or-level',
  DL: 'door-lock', BT: 'drive-belt', MB: 'motor-brushes', MD: 'motor-drive', ME: 'mechanical-resistance', CT: 'control',
};
// Tie-break only (most common / cheapest first; research §3).
const PRIOR = ['LB', 'PG', 'DL', 'BT', 'MB', 'MD', 'ME', 'SU', 'PL', 'CT'];

// Evidence doc §6. Effect: SS +2 (strong), S +1, A -1, SA -3 (contradicts).
const SIGNALS = {
  LB: { emptySpinOk: SS, redistributes: S, vibration: S, codeImbalance: S, spinOnCommand: S, loadCorrected: SS,
    restoredAfterLoadFix: SS, failsAfterLoadFix: SA, emptySpinFails: SA, drumStill: SA, handResist: A, loadOk: A },
  PG: { programmeCorrected: SS, restoredAfterProgrammeFix: SS, failsAfterProgrammeFix: SA, programmeOk: SA,
    spinOnCommand: S, emptySpinOk: S, drumStill: SA, emptySpinFails: A, handResist: A, redistributes: A },
  SU: { vibration: S, loadOk: S, emptySpinOk: S, restoredAfterLoadFix: SA, drumStill: SA },
  PL: { drainsOk: S, emptySpinFails: S, codePressure: S, spinOnCommand: SA, emptySpinOk: SA, drumStill: SA, weakSpin: SA,
    jerky: A, intermittent: A, handResist: A },
  DL: { doorNoLock: SS, doorNoLockConfirmed: SS, codeDoorLock: S, drumStill: S, doorLocksOk: SA, drumTurnsWash: SA },
  BT: { drumStill: S, motorRuns: S, weakSpin: S, handTooFree: SS, beltOffComposite: SS, beltSeenFaulty: SS, beltSeenOk: SA,
    archDirect: SA, handNormal: A, handResist: A, motorSilent: A, emptySpinOk: SA, spinOnCommand: SA },
  MB: { drumStill: S, weakSpin: S, jerky: S, intermittent: S, motorSilent: S, emptySpinFails: S, codeMotor: S, archBrushed: S,
    brushesSeenWorn: SS, brushesSeenOk: SA, archBrushless: SA, motorRuns: A, handTooFree: A, handResist: A,
    emptySpinOk: SA, spinOnCommand: SA },
  MD: { drumStill: S, weakSpin: S, jerky: S, intermittent: S, motorSilent: S, emptySpinFails: S, codeMotor: S, handNormal: S,
    motorRuns: A, handTooFree: A, handResist: A, beltOffComposite: A, brushesSeenWorn: A, emptySpinOk: SA, spinOnCommand: SA },
  ME: { handResist: SS, grinding: S, drumStill: S, motorRuns: S, handNormal: SA, handTooFree: SA, emptySpinOk: A },
  CT: { codeControl: S, nothingDrives: S, handResist: A, emptySpinOk: SA, spinOnCommand: SA },
};
const families = Object.fromEntries(Object.entries(SIGNALS).map(([k, sig]) => [k, { name: FAMILY[k], signals: sig }]));

// Decisive facts that may justify a part (component level), per part-eligible family.
const DECISIVE_PART = {
  BT: { beltSeenFaulty: 'drive-belt', beltOffComposite: 'drive-belt' },
  MB: { brushesSeenWorn: 'carbon-brushes' },
  DL: { doorNoLockConfirmed: 'door-lock' },
};
const RESTORED_FOR = { LB: 'restoredAfterLoadFix', PG: 'restoredAfterProgrammeFix' };

const FACT_LABEL = {
  drainsOk: 'drains fully', drumTurnsWash: 'drum turns during the wash', drumStill: 'drum does not turn at all',
  weakSpin: 'spins only slowly', intermittent: 'spins only sometimes', jerky: 'jerks / pulses instead of speeding up',
  motorRuns: 'motor heard running', motorSilent: 'no motor sound', emptySpinOk: 'spins properly when empty / with a lighter load',
  emptySpinFails: 'will not spin even when empty', spinOnCommand: 'spins on a spin-only programme', spinCommandFails: 'will not spin on a spin-only programme',
  redistributes: 'keeps trying to balance the load', vibration: 'bangs / shakes violently', doorNoLock: 'door does not lock',
  doorNoLockConfirmed: 'door does not lock after closing it firmly', doorLocksOk: 'door locks normally', handNormal: 'drum turns normally by hand',
  handResist: 'drum stiff, rough or seized by hand', handTooFree: 'drum unusually free by hand', grinding: 'grinding / rumbling noise',
  beltSeenFaulty: 'drive belt seen broken / off', beltSeenOk: 'drive belt seen intact', brushesSeenWorn: 'carbon brushes seen worn',
  brushesSeenOk: 'carbon brushes seen fine', loadCorrected: 'load problem found and corrected', loadOk: 'normal mixed load',
  programmeCorrected: 'spin setting / programme corrected', programmeOk: 'programme and spin setting are normal',
  restoredAfterLoadFix: 'spins after correcting the load', failsAfterLoadFix: 'still will not spin after correcting the load',
  restoredAfterProgrammeFix: 'spins after correcting the setting', failsAfterProgrammeFix: 'still will not spin after correcting the setting',
  beltOffComposite: 'motor runs, drum still and unusually free by hand', nothingDrives: 'nothing drives the drum, mechanics fine',
  archDirect: 'direct-drive machine (no belt)', archBrushless: 'brushless / inverter motor (no carbon brushes)',
  archBrushed: 'brushed motor', codeImbalance: 'imbalance error code', codeDoorLock: 'door-lock error code',
  codeMotor: 'motor / speed-sensing error code', codeControl: 'control-board error code', codePressure: 'pressure / level error code',
};

// ---- typed machine architecture -----------------------------------------------------------------------
// Make-level platform facts mirror faults-catalogue.json `platforms` (lg: Direct Drive brushless, "there are NO
// carbon brushes"; samsung: Digital Inverter motors, "not carbon brushes"). Model-level evidence is the
// catalogue part list for the CONFIRMED model, and what the customer reports having seen.
const MAKE_PLATFORM = {
  lg: { drive: 'direct', motor: 'brushless' },
  samsung: { drive: null, motor: 'brushless' },
};
const normCode = (s) => String(s || '').replace(/[^A-Za-z0-9]/g, '').toUpperCase();
function brandFamily(make, errorCodes) {
  if (!make || !errorCodes) return null;
  const m = String(make).toLowerCase().trim();
  for (const [fam, def] of Object.entries(errorCodes)) {
    if (def && Array.isArray(def.appliesTo) && def.appliesTo.some((x) => String(x).toLowerCase() === m)) return fam;
  }
  return null;
}
const BELT_TITLE = /\b(poly[- ]?v(ee)?|drive)\b[^|]*\bbelt\b|\bbelt\b/i;
const NOT_WM_BELT = /tumble\s*dryer|agitator/i;
const BRUSH_TITLE = /carbon\s+(motor\s+)?brush|motor\s+brush/i;
const BRUSHLESS_TITLE = /\binverter\b|\bbldc\b|brushless/i;
const DIRECT_TITLE = /\brotor\b|\bstator\b|direct\s*drive/i;

function architectureOf(state, { modelParts = null, errorCodes = null } = {}) {
  const basis = [];
  let drive = null; let motor = null;
  const make = state.identity && state.identity.make && state.identity.make.value;
  const fam = brandFamily(make, errorCodes) || (make ? String(make).toLowerCase().trim() : null);
  const plat = fam && MAKE_PLATFORM[fam];
  if (plat) {
    if (plat.drive) { drive = plat.drive; basis.push(`make-platform:${fam}:drive=${plat.drive}`); }
    if (plat.motor) { motor = plat.motor; basis.push(`make-platform:${fam}:motor=${plat.motor}`); }
  }
  const titles = Array.isArray(modelParts) ? modelParts.map((p) => String((p && p.title) || p || '')) : [];
  const anyTitle = (re, not) => titles.some((t) => re.test(t) && !(not && not.test(t)));
  if (anyTitle(BRUSHLESS_TITLE)) { motor = 'brushless'; basis.push('model-parts:inverter/brushless'); }
  if (anyTitle(DIRECT_TITLE)) { drive = 'direct'; basis.push('model-parts:rotor/stator'); }
  if (anyTitle(BELT_TITLE, NOT_WM_BELT) && drive !== 'direct') { drive = 'belt'; basis.push('model-parts:belt'); }
  if (anyTitle(BRUSH_TITLE) && motor !== 'brushless') { motor = 'brushed'; basis.push('model-parts:carbon-brushes'); }
  // What the customer (or their engineer) actually saw inside the machine.
  const chk = (c) => state.evidence && state.evidence.checks && state.evidence.checks[c];
  if (chk('drive-belt') && chk('drive-belt').status === 'done' && drive !== 'direct') { drive = 'belt'; basis.push('customer-saw:belt'); }
  if (chk('carbon-brushes') && chk('carbon-brushes').status === 'done') {
    if (motor === 'brushless') basis.push('conflict:brushes-reported-on-brushless-platform');
    else { motor = 'brushed'; basis.push('customer-saw:carbon-brushes'); }
  }
  return { drive: drive || 'unknown', motor: motor || 'unknown', basis };
}

// ---- displayed code -> catalogue faultId (support only) -----------------------------------------------------
function codeFaultFor(state, errorCodes, appliance = 'washing-machine') {
  if (!state || !errorCodes) return null;
  const codes = ((state.identity && state.identity.displayedCodes) || []).filter((f) => f && f.status === 'active' && f.value);
  if (!codes.length) return null;
  const code = normCode(codes[codes.length - 1].value);
  const fam = brandFamily(state.identity.make && state.identity.make.value, errorCodes);
  if (!fam) return null; // codes are brand-specific; without a make a code is not mapped (support only anyway)
  const table = errorCodes[fam] && errorCodes[fam][appliance];
  if (!table) return null;
  const k = Object.keys(table).find((x) => x && !x.startsWith('_') && normCode(x) === code);
  const v = k ? table[k] : null;
  return typeof v === 'string' ? v : (v && typeof v === 'object' ? v.faultId || null : null);
}
const CODE_AREA = {
  'unbalanced-load': 'codeImbalance', 'excessive-vibration': 'codeImbalance', 'door-lock': 'codeDoorLock',
  tacho: 'codeMotor', 'hall-sensor': 'codeMotor', 'motor-triac': 'codeMotor', 'motor-current': 'codeMotor', 'motor-drum': 'codeMotor',
  'main-pcb': 'codeControl', comms: 'codeControl', 'pressure-switch': 'codePressure',
  'not-draining': 'codeDrain', 'drain-pump': 'codeDrain',
};

// ---- projection ----------------------------------------------------------------------------------------------
const obsF = (s, k) => (s.evidence && s.evidence.observations && s.evidence.observations[k]) || null;
const ov = (s, k) => { const f = obsF(s, k); return f && f.value != null ? f.value : null; };
const ot = (s, k) => { const f = obsF(s, k); if (!f || f.value == null) return null; return Number.isInteger(f.lastTurn) ? Math.max(f.lastTurn, f.turn) : f.turn; };
const ck = (s, c) => (s.evidence && s.evidence.checks && s.evidence.checks[c]) || null;
const cres = (s, c) => { const k = ck(s, c); return k && k.status === 'done' ? k.result : null; };
// A load / programme problem the owner FOUND is owner-correctable by definition (spread the load, switch the option
// off), whether or not they said they already changed it: found_not_cleared counts as found.
const FOUND = new Set(['found_and_cleared', 'found_not_cleared']);
const fixTurn = (s, c) => { const k = ck(s, c); return k && k.status === 'done' && FOUND.has(k.result) ? k.turn : null; };

function evidenceFacts(state, ctx = {}) {
  const s = state; const t = new Set();
  const on = (n, c) => { if (c) t.add(n); };
  const arch = ctx.architecture || { drive: 'unknown', motor: 'unknown' };
  on('drainsOk', ov(s, 'waterRemaining') === false || ov(s, 'drainsNormally') === true || ov(s, 'commandedDrain') === true);
  const moving = ['spinsSlowly', 'intermittentSpin', 'jerkyAcceleration', 'repeatedRedistribution', 'excessiveVibration']
    .some((k) => ov(s, k) === true) || ov(s, 'spinsEmpty') === true || ov(s, 'commandedSpin') === true
    || ov(s, 'loadDependent') === true; // fails only with certain loads: the drum clearly turns
  on('drumTurnsWash', ov(s, 'drumTurns') === true || (ov(s, 'drumTurns') == null && moving));
  on('drumStill', ov(s, 'drumTurns') === false);
  on('weakSpin', ov(s, 'spinsSlowly') === true);
  on('intermittent', ov(s, 'intermittentSpin') === true);
  on('jerky', ov(s, 'jerkyAcceleration') === true);
  on('motorRuns', ov(s, 'motorAudible') === true);
  on('motorSilent', ov(s, 'motorAudible') === false);
  on('emptySpinOk', ov(s, 'spinsEmpty') === true || ov(s, 'loadDependent') === true);
  on('emptySpinFails', ov(s, 'spinsEmpty') === false);
  on('redistributes', ov(s, 'repeatedRedistribution') === true);
  on('vibration', ov(s, 'excessiveVibration') === true);
  on('doorNoLock', ov(s, 'doorLocks') === false);
  on('doorLocksOk', ov(s, 'doorLocks') === true);
  const door = ck(s, 'door-closed-latched');
  on('doorNoLockConfirmed', ov(s, 'doorLocks') === false && Boolean(door && door.status === 'done'));
  const hand = cres(s, 'drum-by-hand');
  on('handTooFree', ov(s, 'drumUnusuallyFree') === true);
  on('handResist', hand === 'fault_seen' || hand === 'found_not_cleared' || ov(s, 'drumTurnsByHand') === false);
  on('handNormal', !t.has('handResist') && !t.has('handTooFree') && (hand === 'clear' || ov(s, 'drumTurnsByHand') === true));
  on('grinding', ov(s, 'grindingNoise') === true);
  on('beltSeenFaulty', ['fault_seen', 'found_not_cleared'].includes(cres(s, 'drive-belt')));
  on('beltSeenOk', cres(s, 'drive-belt') === 'clear');
  on('brushesSeenWorn', cres(s, 'carbon-brushes') === 'fault_seen');
  on('brushesSeenOk', cres(s, 'carbon-brushes') === 'clear');
  on('loadOk', cres(s, 'load-check') === 'clear');
  on('loadCorrected', FOUND.has(cres(s, 'load-check')));
  on('programmeOk', cres(s, 'programme-setting') === 'clear');
  on('programmeCorrected', FOUND.has(cres(s, 'programme-setting')));
  const spin = ov(s, 'commandedSpin'); const spinT = ot(s, 'commandedSpin');
  const fixes = { Load: fixTurn(s, 'load-check'), Programme: fixTurn(s, 'programme-setting') };
  const fixTurns = Object.values(fixes).filter((x) => x != null);
  on('spinOnCommand', spin === true && !fixTurns.some((x) => x <= spinT));
  on('spinCommandFails', spin === false);
  for (const [n, ft] of Object.entries(fixes)) {
    if (ft == null) continue;
    on(`restoredAfter${n}Fix`, (spin === true && spinT >= ft) || s.resolution === 'resolved');
    on(`failsAfter${n}Fix`, spin === false && spinT >= ft);
  }
  on('beltOffComposite', t.has('drumStill') && t.has('motorRuns') && t.has('handTooFree'));
  on('nothingDrives', t.has('drumStill') && t.has('motorSilent') && t.has('handNormal'));
  on('archDirect', arch.drive === 'direct');
  on('archBrushless', arch.motor === 'brushless');
  on('archBrushed', arch.motor === 'brushed');
  const area = CODE_AREA[ctx.codeFault] || null;
  if (area && area !== 'codeDrain') t.add(area);
  return [...t].map((name) => ({ name, value: 'TRUE' }));
}

// Eligibility: a family is ranked only with its own evidence (no evidence-free leader).
function eligible(key, has) {
  if (key === 'PG') return has('programmeCorrected') || has('spinOnCommand') || has('emptySpinOk') || has('programmeOk');
  if (key === 'SU') return has('vibration');
  if (key === 'PL') return has('drainsOk') && (has('emptySpinFails') || has('codePressure'));
  if (key === 'DL') return has('doorNoLock') || has('codeDoorLock');
  if (key === 'ME') return has('handResist') || has('grinding');
  if (key === 'CT') return has('codeControl') || has('nothingDrives');
  return true;
}

function diagnose(state, ctx = {}) {
  const architecture = ctx.architecture || architectureOf(state, ctx);
  const facts = evidenceFacts(state, { ...ctx, architecture });
  const r = engine.rankFamilies({ families, prior: PRIOR, facts, eligible, labels: FACT_LABEL });
  const { has } = r;
  let leader = null;
  if (r.top) {
    const decisiveMap = DECISIVE_PART[r.top.key];
    const decisive = decisiveMap ? Object.keys(decisiveMap).find((f) => has(f)) || null : null;
    const level = r.committed && decisive ? 'component' : 'cause_family';
    leader = { family: r.top.family, key: r.top.key, committed: r.committed, level, margin: r.margin,
      component: level === 'component' ? decisiveMap[decisive] : null, decisive };
  }
  const likelyResolved = Boolean(leader && leader.committed && RESTORED_FOR[leader.key] && has(RESTORED_FOR[leader.key]));
  const reasons = [];
  let component = null;
  if (!leader) reasons.push('no-leader');
  else {
    if (!leader.committed) reasons.push('leader-not-committed');
    if (!DECISIVE_PART[leader.key]) reasons.push('leader-not-part-eligible');
    else if (!leader.decisive) reasons.push('no-decisive-fact');
    else component = DECISIVE_PART[leader.key][leader.decisive];
    // Spinning properly anywhere (empty, on command, after a fix) argues against a failed drive component.
    if (['emptySpinOk', 'spinOnCommand', 'restoredAfterLoadFix', 'restoredAfterProgrammeFix'].some(has) && ['BT', 'MB'].includes(leader.key)) reasons.push('spins-somewhere');
    if (r.second && r.margin < engine.COMMIT_MARGIN) reasons.push('alternative-within-margin');
  }
  if (has('codeMotor') && reasons.length) reasons.push('code-is-support-only');
  const sufficient = reasons.length === 0;
  return {
    schema: 'j2-diag/1',
    facts: [...r.trueSet].sort(),
    architecture,
    codeFault: ctx.codeFault || null,
    drainSuspected: ov(state, 'waterRemaining') === true || CODE_AREA[ctx.codeFault] === 'codeDrain',
    rank: r.rank.map(({ key, ...x }) => x),
    contradicted: r.contradicted.map(({ key, ...x }) => x),
    leader,
    likelyResolved,
    partEvidence: { sufficient, component: sufficient ? component : null, reasons },
    noViableCause: r.rank.length === 0,
  };
}

module.exports = { FAMILY, PRIOR, SIGNALS, FACT_LABEL, DECISIVE_PART, MAKE_PLATFORM, CODE_AREA,
  architectureOf, codeFaultFor, evidenceFacts, diagnose };
