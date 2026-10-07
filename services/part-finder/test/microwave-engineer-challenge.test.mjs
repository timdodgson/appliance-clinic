/**
 * MICROWAVE ENGINEER CHALLENGE SUITE (deterministic, offline, permanent).
 *
 * Tests ENGINEERING SEMANTICS of the microwave knowledge — the priors, suspect ordering, evidence
 * that flips the ranking, guarded LLM-confusions, safe-first checks, HV safety boundaries and
 * replacement discipline — NOT LLM prose. Operates on the canonical source (faults-catalogue.json +
 * overrides.json) and the built docs, so it protects the engineering behaviour permanently and any
 * knowledge regression (or an unsafe edit) flips it RED. Deployed reply quality is verified
 * separately by the production E2E.
 *
 * Run: node services/part-finder/test/microwave-engineer-challenge.test.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const K = join(HERE, '..', 'knowledge');
const CAT = JSON.parse(readFileSync(join(HERE, '..', 'faults-catalogue.json'), 'utf8'));
// Overrides path is override-able (MW_OVERRIDES) so the mutation harness can point the SAME suite at
// a mutated copy without touching the real source. Defaults to the canonical source.
const OV = JSON.parse(readFileSync(process.env.MW_OVERRIDES || join(K, 'overrides.json'), 'utf8'));
const MW = CAT.faults.microwave || {};

let pass = 0, fail = 0; const fails = [];
const ok = (n, c) => { if (c) { pass++; } else { fail++; fails.push(n); console.log('  FAIL-', n); } };

const doc = (id) => OV.docs[`microwave:${id}`] || {};
const comps = (id) => (doc(id).components || []).map((c) => (typeof c === 'string' ? c : c.name));
const compsLc = (id) => comps(id).map((s) => String(s).toLowerCase());
const firstComp = (id) => compsLc(id)[0] || '';
const idxOf = (id, sub) => compsLc(id).findIndex((c) => c.includes(sub));
const discr = (id) => (doc(id).discriminators || []).join(' \n ').toLowerCase();
const conf = (id) => JSON.stringify(doc(id).commonConfusion || []).toLowerCase();
const advice = (id) => (doc(id).adviceBeforeReplacement || []).join(' \n ').toLowerCase();
const safety = (id) => String(doc(id).safety || '').toLowerCase();
const secondary = (id) => String(doc(id).secondaryQuestion || '').toLowerCase();
const clarify = (id) => String(doc(id).clarifyingQuestion || '').toLowerCase();
const synonyms = (id) => [...(MW[id]?.synonyms || []), ...(doc(id).symptoms || [])].join(' ').toLowerCase();
const before = (id, a, b) => { const x = idxOf(id, a), y = idxOf(id, b); return x !== -1 && y !== -1 && x < y; };

const NODES = ['not-heating', 'door', 'turntable', 'sparking-arcing', 'main-pcb', 'lighting', 'low-voltage', 'cutting-out', 'noisy', 'grill-not-heating'];

// ---- 0. structural: every node reviewed, has components + a discriminator ------------------
ok('all 10 microwave nodes present', NODES.every((n) => MW[n]));
for (const n of NODES) {
  ok(`${n}: has components`, comps(n).length >= 1);
  ok(`${n}: has a discriminator or is trivially proportionate`, discr(n).length > 0 || n === 'lighting');
}

// ---- 1. HV SAFETY BOUNDARY (hard) — HV-relevant nodes must forbid opening/HV testing --------
for (const n of ['not-heating', 'low-voltage', 'sparking-arcing', 'cutting-out']) {
  const t = `${safety(n)} \n ${advice(n)}`;
  ok(`${n}: forbids opening casing / touching HV (safety boundary present)`,
    /(do not|don't|never|no)\b[^.]*\b(open|casing|cover|hv|capacitor|discharge|probe|test)/.test(t) || /stored charge|lethal|do not open/.test(t));
  // must NOT contain a positive instruction telling the customer to discharge/test HV
  ok(`${n}: no positive 'discharge/test the capacitor' instruction`,
    !/(please |you should |first,? )?(discharge|test|probe) the (hv |high voltage )?(capacitor|magnetron|diode|transformer)/.test(t.replace(/do not[^.]*/g, '').replace(/don't[^.]*/g, '').replace(/never[^.]*/g, '')));
}

// ---- 2. SPARKING/ARCING — the required deep audit (req 4,5,18) ------------------------------
{
  const id = 'sparking-arcing';
  // metal/foil (user cause, check) must precede the waveguide-cover PART, which must precede magnetron.
  ok('sparking: metal/foil precedes waveguide cover', before(id, 'metal', 'waveguide'));
  ok('sparking: waveguide cover precedes magnetron', before(id, 'waveguide', 'magnetron'));
  ok('sparking: magnetron is LAST', idxOf(id, 'magnetron') === compsLc(id).length - 1);
  // door-edge/perimeter handling exists (fills the gap) ...
  ok('sparking: a door-edge / perimeter suspect exists', idxOf(id, 'door edge') !== -1 || idxOf(id, 'perimeter') !== -1);
  // ... but a generic "door seal/gasket" must NOT be a leading (or any) cavity suspect
  ok('sparking: NO door seal/gasket component', !compsLc(id).some((c) => c.includes('door seal') || c.includes('gasket')));
  ok('sparking: first suspect is metal/foil (user cause), never a door seal', firstComp(id).includes('metal'));
  // location is the high-value discriminator; door-seal-leading is explicitly guarded
  ok('sparking: LOCATION discriminator present (side/roof vs floor vs door edge)',
    /location/.test(discr(id)) && /side|roof/.test(discr(id)) && /door edge|door frame/.test(discr(id)));
  ok('sparking: explicit guard against leading with door seal for cavity arcing',
    /door seal/.test(discr(id) + conf(id)) && /(no user-serviceable|not (a )?door seal|never lead)/.test(discr(id) + conf(id)));
  ok('sparking: "arcing = magnetron" confusion guarded', /arcing = magnetron|jump to the magnetron/.test(conf(id)));
  ok('sparking: STOP USE on violent/repeated arcing', /stop use/.test(discr(id) + safety(id)));
  ok('sparking: safe first action is remove metal + inspect cover (no HV testing)',
    /remove (any )?metal|microwave-safe/.test(advice(id)) && /waveguide|mica/.test(advice(id)));
  ok('sparking: secondary question probes the cover / location', /mica|cover|burnt|blackened|side/.test(secondary(id) + clarify(id)));
  // customer language for the waveguide cover (req 11)
  ok('sparking: customer language for the cover (cardboard/paper/little plate/burnt square)',
    /cardboard|paper bit|little plate|burnt square|sparking plate|side wall/.test(synonyms(id)));
}

// ---- 3. NOT-HEATING — architecture-aware, magnetron not blindly first (req 8) ---------------
{
  const id = 'not-heating';
  ok('not-heating: cookware/power check before any HV part', before(id, 'cookware', 'magnetron') || idxOf(id, 'cookware') === 0);
  ok('not-heating: magnetron is NOT the first suspect', firstComp(id).indexOf('magnetron') !== 0);
  ok('not-heating: architecture split present (inverter vs conventional)',
    compsLc(id).some((c) => c.includes('inverter')) && compsLc(id).some((c) => c.includes('diode') || c.includes('capacitor') || c.includes('transformer')));
  ok('not-heating: ARCHITECTURE discriminator', /architecture|inverter|conventional/.test(discr(id)));
  ok('not-heating: guards "no heat = inverter board" (only on inverter)', /inverter board|inverter/.test(conf(id)));
  ok('not-heating: HV diode DMM caveat present (no false condemn)', /dmm|multimeter|diode/.test(discr(id)));
}

// ---- 4. DOOR — mechanical vs electrical split; interlock not blindly first (req 8) ----------
{
  const id = 'door';
  ok('door: mechanical release/latch leads (not the electrical interlock)',
    /release|button|latch|linkage/.test(firstComp(id)));
  const interlockIdx = idxOf(id, 'interlock');
  ok('door: interlock microswitch is NOT the first suspect', interlockIdx !== 0);
  ok('door: symptom-split discriminator (won\'t open = mechanical; won\'t start = electrical)',
    /mechanical/.test(discr(id)) && /interlock|start/.test(discr(id)));
  ok('door: does not force-open advice + no interlock bypass', /do not force|not force|do not remove the .*casing|never bypass|interlock/.test(advice(id)));
}

// ---- 5. TURNTABLE — seating/roller before coupler/motor; smashed glass = accessory ----------
{
  const id = 'turntable';
  ok('turntable: seating/obstruction check first', /seat|obstruction/.test(firstComp(id)));
  ok('turntable: coupler distinguished from motor', idxOf(id, 'coupler') !== -1 && idxOf(id, 'motor') !== -1);
  ok('turntable: motor-hums-plate-still => coupler discriminator', /coupler/.test(discr(id)) && /motor/.test(discr(id)));
  ok('turntable: smashed glass = accessory guard (not a motor diagnosis)', /smashed|glass/.test(conf(id)));
  ok('turntable: does NOT jump to PCB', /pcb/.test(conf(id)));
}

// ---- 6. CUTTING-OUT — timing split, not "cuts out = overheating" -----------------------------
{
  const id = 'cutting-out';
  ok('cutting-out: timing discriminator (seconds vs minutes vs random)',
    /second/.test(discr(id)) && /minute/.test(discr(id)));
  ok('cutting-out: guards "cuts out = overheating"', /overheat/.test(conf(id)));
  ok('cutting-out: inverter seconds-shutdown fingerprint present', /inverter|3s|28|second/.test(discr(id)));
}

// ---- 7. NOISY — character routing, not "noisy = magnetron" ----------------------------------
{
  const id = 'noisy';
  ok('noisy: guards "noisy = magnetron" (only heavy buzz + no heat)', /noisy = magnetron|heavy .*buzz/.test(conf(id)));
  ok('noisy: routes by character (grinding/whirring/buzz/rattle)',
    /grinding|whirring|buzz|rattle/.test(discr(id)));
  ok('noisy: heavy-buzz raises HV only WITH no heat', /no heat/.test(discr(id) + conf(id)));
}

// ---- 8. MAIN-PCB — PCB down-ranked (keypad/display first, PCB last) --------------------------
{
  const id = 'main-pcb';
  ok('main-pcb: keypad/membrane precedes the main PCB', before(id, 'keypad', 'main control pcb') || before(id, 'keypad', 'main pcb'));
  ok('main-pcb: main control PCB is the LAST suspect', idxOf(id, 'main control pcb') === compsLc(id).length - 1 || idxOf(id, 'main pcb') === compsLc(id).length - 1);
  ok('main-pcb: guards "controls = main PCB"', /main pcb|control board|down-rank/.test(conf(id)));
  ok('main-pcb: completely-dead routes to low-voltage; beeps => door', /low-voltage|dead/.test(conf(id) + discr(id)));
}

// ---- 9. LOW-VOLTAGE — fuse is evidence, not a fix -------------------------------------------
{
  const id = 'low-voltage';
  ok('low-voltage: supply/socket checked first', /supply|socket|plug/.test(firstComp(id)));
  ok('low-voltage: guards "replace the fuse = fixed"', /fuse/.test(conf(id)) && /(symptom|evidence|blows again|why)/.test(conf(id)));
  ok('low-voltage: door monitor microswitch represented as a classic fuse-blow cause', /monitor|microswitch/.test(compsLc(id).join(' ')));
}

// ---- 10. LIGHTING — proportionate (lamp before PCB) -----------------------------------------
{
  const id = 'lighting';
  ok('lighting: lamp/bulb is the first suspect', /lamp|bulb/.test(firstComp(id)));
  ok('lighting: guards "no light = board fault"', /board|pcb/.test(conf(id)));
}

// ---- 11. GRILL — grill-only is STRONG AGAINST the magnetron ---------------------------------
{
  const id = 'grill-not-heating';
  ok('grill: grill element leads (not the magnetron)', /grill element|grill/.test(firstComp(id)));
  ok('grill: grill-only heating fault is AGAINST the magnetron', /magnetron/.test(conf(id) + discr(id)) && /grill/.test(discr(id)));
  ok('grill: neither-heats routes to shared supply/control', /neither|shared|supply|control/.test(discr(id)));
}

// ---- 12. PAIRED / NEAR-NEIGHBOUR (req 17) — one meaningful fact flips the ordering -----------
const PAIRS = [
  ['sparking side-wall cover vs door-edge', () => idxOf('sparking-arcing', 'waveguide') !== -1 && (idxOf('sparking-arcing', 'door edge') !== -1) && /side|roof/.test(discr('sparking-arcing')) && /door edge/.test(discr('sparking-arcing'))],
  ['sparking metal-present vs clean-cavity', () => firstComp('sparking-arcing').includes('metal') && /clean cavity|intact cover|no metal/.test(discr('sparking-arcing'))],
  ['runs-cold (not-heating) vs runs-then-stops (cutting-out)', () => /cut.?out|second/.test(discr('not-heating') + discr('cutting-out')) && (MW['not-heating'] && MW['cutting-out'])],
  ['no-heat seconds (inverter) vs minutes (thermal)', () => /second/.test(discr('cutting-out')) && /minute/.test(discr('cutting-out'))],
  ['door wont-open (mechanical) vs wont-start (electrical)', () => /mechanical/.test(discr('door')) && /interlock|start/.test(discr('door'))],
  ['turntable motor-silent (motor) vs motor-hums (coupler)', () => /coupler/.test(discr('turntable')) && /motor/.test(discr('turntable'))],
  ['grill-only cold vs both-cold', () => /grill/.test(discr('grill-not-heating')) && /neither|shared|supply/.test(discr('grill-not-heating'))],
  ['noisy heavy-buzz+no-heat (HV) vs grinding-base (turntable)', () => /buzz/.test(discr('noisy')) && /grinding|base/.test(discr('noisy'))],
];
for (const [name, fn] of PAIRS) ok(`PAIR: ${name}`, fn());

const PAIR_COUNT = PAIRS.length;
console.log(`\nmicrowave engineer challenge: ${pass} passed, ${fail} failed  (nodes=${NODES.length}, paired cases=${PAIR_COUNT})`);
if (fail) { console.log('FAILURES:', fails.join(' | ')); process.exit(1); }
process.exit(0);
