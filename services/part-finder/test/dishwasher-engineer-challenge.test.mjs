/**
 * DISHWASHER ENGINEER CHALLENGE SUITE (deterministic, offline, permanent).
 *
 * Tests ENGINEERING SEMANTICS across ALL dishwasher nodes, the way an experienced dishwasher
 * engineer reasons about the cycle stages (SUPPLY -> FILL -> LEVEL -> CIRCULATION -> HEAT -> WASH ->
 * DRAIN -> RINSE -> DRY) plus LEAK/FLOOD, DOOR, CONTROL and SENSING. It protects the high-value
 * traps the customer symptom hides:
 *   - not-draining is CHECK-FIRST (filter/sump/hose/waste) — drain pump is LAST, never automatic
 *   - normal residual sump water / blocked waste / backflow are NOT a failed drain pump
 *   - no-fill is CHECK-FIRST (supply/tap/hose/filter) and can be ANTI-FLOOD, not the inlet valve
 *   - flood protection ("switch is doing its job — find the leak") outranks pump/valve/PCB
 *   - drainage vs wash circulation are distinguished by NOISE STAGE (drain vs wash)
 *   - poor wash leads with the FILTER, not the circulation pump; white film is maintenance
 *   - not-heating needs genuine COLD (hot-but-wet = drying); flow-through architecture is respected
 *   - poor drying / plastics-wet / rinse-aid are conditions, not an automatic heater
 *   - front leak is not automatically a door seal (split spray arm / foam / alignment)
 *   - detergent left = a WASH problem when the flap opened, not the dispenser
 *   - salt / hardness / water chemistry are settings/maintenance, not a softener part
 *   - intermittent / multi-error / door-position faults => DOOR LOOM before the PCB (PCB is last)
 *   - error code = a detected SYSTEM/CONDITION (an existing node), never an automatic component
 *   - absolute electrical safety: no live testing / insulation testing / RCD bypass / live loom work
 *
 * Operates on CANONICAL source (faults-catalogue.json + overrides.json). Any regression or unsafe
 * edit flips this RED. Deployed reply quality is verified separately by the production E2E.
 *
 * Env override for mutation harnesses: DWE_OVERRIDES=/path/to/mutated-overrides.json
 * Run: node services/part-finder/test/dishwasher-engineer-challenge.test.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const K = join(HERE, '..', 'knowledge');
const CAT = JSON.parse(readFileSync(join(HERE, '..', 'faults-catalogue.json'), 'utf8'));
const OV = JSON.parse(readFileSync(process.env.DWE_OVERRIDES || join(K, 'overrides.json'), 'utf8'));
const DW = CAT.faults['dishwasher'] || {};
const NODES = Object.keys(DW);

let pass = 0, fail = 0; const fails = [];
const ok = (n, c) => { if (c) pass++; else { fail++; fails.push(n); console.log('  FAIL-', n); } };

const doc = (id) => OV.docs[`dishwasher:${id}`] || {};
const comps = (id) => {
  const d = doc(id);
  if (Array.isArray(d.components) && d.components.length) return d.components;
  return (d.likelyComponents || []).map((s) => ({ name: String(s), type: 'check' }));
};
const names = (id) => comps(id).map((c) => (typeof c === 'string' ? c : c.name).toLowerCase());
const first = (id) => names(id)[0] || '';
const firstType = (id) => { const c = comps(id)[0]; return c && typeof c === 'object' ? String(c.type || '').toLowerCase() : ''; };
const idx = (id, sub) => names(id).findIndex((c) => c.includes(sub));
const before = (id, a, b) => { const x = idx(id, a), y = idx(id, b); return x !== -1 && y !== -1 && x < y; };
const last = (id, sub) => { const arr = names(id); return arr.length > 0 && arr[arr.length - 1].includes(sub); };
const discr = (id) => (doc(id).discriminators || []).join(' \n ').toLowerCase();
const conf = (id) => JSON.stringify(doc(id).commonConfusion || []).toLowerCase();
const advice = (id) => (doc(id).adviceBeforeReplacement || []).join(' \n ').toLowerCase();
const clarify = (id) => String(doc(id).clarifyingQuestion || '').toLowerCase();
const secondary = (id) => String(doc(id).secondaryQuestion || '').toLowerCase();
const safety = (id) => String(doc(id).safety || '').toLowerCase();
const blob = (id) => `${discr(id)} \n ${conf(id)} \n ${advice(id)} \n ${clarify(id)} \n ${secondary(id)}`;
// Full node text incl per-component supports/against — used where the evidence lives in FOR/AGAINST.
const nodeText = (id) => JSON.stringify(doc(id)).toLowerCase();

// ---- 0. COVERAGE: every dishwasher node reviewed + has ordered suspects -----------------------
ok('dishwasher family present (25 nodes)', NODES.length >= 25);
for (const n of NODES) ok(`${n}: override present + >=1 ordered suspect`, Boolean(OV.docs[`dishwasher:${n}`]) && names(n).length >= 1);

// symptom-entry nodes must LEAD WITH A CHECK (never auto-jump to a part)
const CHECK_FIRST = ['not-draining', 'fill', 'leak-flood', 'poor-clean-results', 'circulation-pump',
  'spray-arm', 'heating', 'poor-drying', 'detergent-dispenser', 'door', 'odour', 'conductivity-sensor',
  'water-matrix', 'pressure-switch', 'flow-meter', 'drain-pump', 'temperature-sensor', 'turbidity-sensor'];
for (const n of CHECK_FIRST) ok(`${n}: leads with a CHECK, not an automatic part`, firstType(n) === 'check');

// ---- 1. SAFETY (hard) — no unsafe live-electrical instruction anywhere ------------------------
const UNSAFE = /(insulation.?test|megger|live.{0,14}test|test.{0,14}\blive\b|bypass.{0,10}(interlock|protection|rcd|earth)|probe.{0,10}(live|mains)|continuity.{0,10}live)/;
const NEGATED = /\b(no|not|never|don't|do not|avoid|without|qualified|engineer|specialist|leave|isn't|professional|stop use|don’t)\b/;
for (const n of NODES) {
  const t = `${advice(n)} \n ${discr(n)} \n ${safety(n)} \n ${conf(n)}`;
  const unsafeInstruction = t.split(/[.\n;:]/).some((c) => UNSAFE.test(c) && !NEGATED.test(c));
  ok(`${n}: no unsafe live-electrical instruction`, !unsafeInstruction);
}
// tripping-electrics MUST carry the structured STOP_USE safety card (parity with WM/WD/TD/oven)
ok('tripping-electrics: STOP_USE safety card present', doc('tripping-electrics').safetyInformation?.classification === 'STOP_USE');
ok('tripping-electrics: card names burning/scorching + stop-and-unplug', /burning|scorch/.test(JSON.stringify(doc('tripping-electrics').safetyInformation || {}).toLowerCase()) && /unplug|stop using|isolate/.test(JSON.stringify(doc('tripping-electrics').safetyInformation || {}).toLowerCase()));
ok('tripping-electrics: no live insulation test / RCD bypass / powered loom work', /insulation-?test|bypass the earth|bypass the rcd|manipulate the loom while powered|expose live/.test(discr('tripping-electrics') + safety('tripping-electrics')));
ok('odour: BURNING/electrical smell routes to stop-use/electrical (not a cleaning odour)', /burning|electrical/.test(discr('odour') + conf('odour')) && /stop use|electrical\/safety|electrical|safety/.test(discr('odour') + conf('odour')));

// ---- 2. DRAINAGE — not-draining is CHECK-FIRST, drain pump LAST -------------------------------
ok('not-draining: FILTER leads', /filter/.test(first('not-draining')));
ok('not-draining: filter/sump/hose/waste BEFORE the drain pump', before('not-draining', 'filter', 'pump'));
ok('not-draining: drain pump is NOT the first suspect', !/drain pump/.test(first('not-draining')));
ok('not-draining: waste/spigot/standpipe (external plumbing) considered', /waste|spigot|standpipe/.test(discr('not-draining') + JSON.stringify(names('not-draining'))));
ok('not-draining: new-install blanking plug trap', /blanking plug|spigot/.test(discr('not-draining') + advice('not-draining')));
ok('not-draining: non-return valve / backflow path exists', idx('not-draining', 'non-return') !== -1 || /siphon|back/.test(discr('not-draining') + JSON.stringify(names('not-draining'))));
ok('not-draining: pump HUMS = jam (clear it), SILENT = dead pump', /hums?/.test(discr('not-draining') + conf('not-draining')) && /silent/.test(discr('not-draining') + JSON.stringify(names('not-draining'))));
ok('drain-pump: blockage/filter cleared BEFORE condemning the pump', /filter|sump|impeller|blockage/.test(first('drain-pump')));
ok('drain-pump: intermittent pump => wiring/door loom before the pump', /loom|wiring|connector/.test(discr('drain-pump') + conf('drain-pump')));

// ---- 3. FILL — CHECK-FIRST, and can be ANTI-FLOOD not the inlet valve -------------------------
ok('fill: supply/tap/hose/inlet-filter leads', /supply|tap|hose|filter/.test(first('fill')));
ok('fill: inlet valve is NOT the first suspect', !/inlet valve/.test(first('fill')));
ok('fill: anti-flood state can block fill (find the leak, not the valve)', /anti-flood|flood/.test(discr('fill') + conf('fill') + JSON.stringify(names('fill'))));
ok('fill: inlet valve can fail PARTIALLY (trickle), not just open/closed', /partial|trickle/.test(discr('fill') + JSON.stringify(names('fill')).toLowerCase()));
ok('fill: valve good-but-unpowered => door loom/wiring, not the valve/PCB', /loom|wiring|powered/.test(discr('fill') + conf('fill')));
ok('overfill: float + passing inlet valve (base water), not auto-PCB', /float/.test(discr('overfill') + JSON.stringify(names('overfill'))) && /inlet valve|passing/.test(discr('overfill') + JSON.stringify(names('overfill'))));

// ---- 4. FLOOD PROTECTION — the flood switch is doing its job ----------------------------------
ok('leak-flood: diagnosed by WHERE the water appears', /where/.test(discr('leak-flood') + clarify('leak-flood')));
ok('leak-flood: anti-flood triggered = water in base, switch NOT the fault (find the leak)', /doing its job|find the leak|not the fault/.test(discr('leak-flood') + conf('leak-flood')));
ok('leak-flood: continuous drain pump + empty tub = anti-flood lockout', /drain pump runs? continuously|keeps? running|continuous/.test(discr('leak-flood') + conf('leak-flood') + JSON.stringify(doc('leak-flood').symptoms || []).toLowerCase()));
ok('leak-flood: "emptied the base tray" is NOT a repair', /empt/.test(conf('leak-flood') + discr('leak-flood')) && /not a repair|not.*fixed|refills/.test(conf('leak-flood') + discr('leak-flood')));
ok('leak-flood: flood/float switch itself is the LAST suspect (base proven dry)', last('leak-flood', 'flood') || last('leak-flood', 'float') || /only if the base is proven dry|switch is doing its job/.test(discr('leak-flood') + JSON.stringify(names('leak-flood'))));
ok('leak-flood: front/door leak is NOT automatically a door seal (split arm/alignment)', /door leak = door seal|split.*spray arm|misaligned|spray arm firing/.test(conf('leak-flood') + discr('leak-flood')));

// ---- 5. CIRCULATION vs DRAINAGE — distinct pumps, told apart by STAGE -------------------------
ok('circulation-pump: spray arms/jets + underfill cleared FIRST', /spray|arm|jet/.test(first('circulation-pump')));
ok('circulation-pump: pump only when arms clear AND tub fills correctly', /fills? (to )?(the )?(correct|normal|right) level/.test(discr('circulation-pump') + conf('circulation-pump')));
ok('circulation-pump: NOISE stage — hum WASHING=circulation, hum DRAINING=drain', /washing.*circulation|circulation.*washing/.test(discr('circulation-pump') + conf('circulation-pump')) && /drain/.test(discr('circulation-pump') + conf('circulation-pump')));
ok('CONFLATION GUARD: not-draining(drain) and circulation-pump(wash) are separate systems', idx('not-draining', 'drain') !== -1 && /circulation/.test(first('circulation-pump') + discr('circulation-pump')) && first('not-draining') !== first('circulation-pump'));
ok('diverter-valve: only-one-arm-runs => diverter BEFORE the circulation pump', /one spray arm|only upper|only lower|one arm/.test(discr('diverter-valve') + JSON.stringify(names('diverter-valve'))) && /diverter/.test(first('diverter-valve')));

// ---- 6. WASH PERFORMANCE — filter leads, circulation pump is last/rare ------------------------
ok('poor-clean-results: FILTER leads (most common)', /filter/.test(first('poor-clean-results')));
ok('poor-clean-results: circulation/wash pump is a LATE suspect, not the lead', idx('poor-clean-results', 'circulation') > 0);
ok('poor-clean-results: white chalky film = maintenance/settings, not a failed part', /white.*film|chalky/.test(discr('poor-clean-results') + conf('poor-clean-results')) && /rinse.?aid|salt|hard.?water|descale|maintenance|settings/.test(discr('poor-clean-results') + conf('poor-clean-results')));
ok('poor-clean-results: undissolved tablet (flap opened) = WASH problem, not dispenser', /tablet.*dispenser|tablet not dissolved/.test(conf('poor-clean-results')) && /wash|spray|underfill|temperature/.test(conf('poor-clean-results')));
ok('spray-arm: ONE arm vs ALL spray weak (all weak => upstream, not both arms failed)', /one arm|all spray|both arms/.test(discr('spray-arm') + conf('spray-arm')));
ok('spray-arm: split/cracked arm can fire at the door and mimic a seal', /split|crack/.test(discr('spray-arm') + conf('spray-arm')) && /door|seal/.test(discr('spray-arm') + conf('spray-arm')));
ok('water-matrix: architecture-first (confirm the machine has a side matrix)', /architecture|has (a )?(side )?matrix|identify the model|confirm the machine/.test(first('water-matrix') + discr('water-matrix')));
ok('water-matrix: UNDERFILL vs CIRCULATION — underfill starves the arms (not the pump)', /underfill/.test(discr('water-matrix') + conf('water-matrix')) && /circulation/.test(discr('water-matrix') + conf('water-matrix')));

// ---- 7. HEATING — genuine cold first; architecture-aware; NOT auto-heater ---------------------
ok('heating: confirm the WHOLE WASH is COLD first (hot-but-wet = drying)', /cold/.test(first('heating')) && /hot.*wet|wet.*hot|poor-drying/.test(discr('heating') + conf('heating')));
ok('heating: flow-through heater integrated in the circ pump (no standalone element) respected', /flow-through|integrated|no separate element|no exposed element/.test(discr('heating') + conf('heating')));
ok('heating: PCB is down-ranked / last', /pcb/.test(discr('heating') + conf('heating')) && (last('heating', 'pcb') || /pcb.*last|down-rank the pcb/.test(discr('heating') + conf('heating'))));
ok('temperature-sensor: heat-symptom gate (wet-but-hot => poor-drying), PCB last', /hot|drying/.test(nodeText('temperature-sensor')) && (last('temperature-sensor', 'pcb') || /pcb/.test(discr('temperature-sensor'))));

// ---- 8. DRYING — conditions, not an automatic heater -----------------------------------------
ok('poor-drying: rinse aid leads (biggest drying lever)', /rinse.?aid/.test(first('poor-drying')));
ok('poor-drying: HOT-but-WET = drying; only COLD-everywhere = heating', /hot/.test(discr('poor-drying') + conf('poor-drying')) && /cold/.test(discr('poor-drying') + conf('poor-drying')));
ok('poor-drying: plastics naturally hold water (not a fault)', /plastic/.test(discr('poor-drying') + advice('poor-drying') + JSON.stringify(names('poor-drying'))));
ok('poor-drying: does NOT auto-blame the heater', /does not prove a heater|not the heater|not a heater fault|do not push a heater|do not push the heater/.test(discr('poor-drying') + conf('poor-drying')));
ok('poor-drying: passive/condensation/auto-door drying acknowledged', /condensation|passive|auto-?door/.test(discr('poor-drying') + advice('poor-drying') + JSON.stringify(names('poor-drying'))));

// ---- 9. DETERGENT / SOFTENER / WATER CHEMISTRY — settings before parts ------------------------
ok('detergent-dispenser: split by whether the flap OPENED', /flap.*open|did.*open/.test(first('detergent-dispenser') + discr('detergent-dispenser')));
ok('detergent-dispenser: flap opened + tablet remains = WASH problem, not dispenser', /flap opened/.test(discr('detergent-dispenser') + conf('detergent-dispenser')) && /wash|spray|underfill|temperature/.test(discr('detergent-dispenser') + conf('detergent-dispenser')));
ok('detergent-dispenser: loading (plate blocking flap) checked before the mechanism', /plate|pan|loading|blocking/.test(discr('detergent-dispenser') + JSON.stringify(names('detergent-dispenser'))));
ok('conductivity-sensor: salt / hardness setting FIRST (settings/maintenance)', /salt/.test(first('conductivity-sensor')));
ok('conductivity-sensor: softener unit is the LAST resort (only if salt+setting+regen correct)', last('conductivity-sensor', 'softener') || /all.*correct.*softener|only a genuinely faulty softener/.test(discr('conductivity-sensor') + JSON.stringify(names('conductivity-sensor'))));
ok('conductivity-sensor: salt PREVENTS scale, does not clear existing restriction', /prevent/.test(discr('conductivity-sensor') + conf('conductivity-sensor')) && /not.*(dissolve|clear)|existing/.test(discr('conductivity-sensor') + conf('conductivity-sensor')));

// ---- 10. DOOR / CONTROL — loom before PCB, PCB last ------------------------------------------
ok('door: separates MECHANICAL (won\'t close) from ELECTRICAL (won\'t start)', /mechanical/.test(discr('door')) && /electrical/.test(discr('door')));
ok('door: drops-open = hinge/balance, not the latch', /drops? open|slams/.test(discr('door') + conf('door')) && /hinge/.test(discr('door') + conf('door')));
ok('door: latches-but-won\'t-start => switch/loom before the PCB', /loom|switch/.test(discr('door') + conf('door')) && /pcb/.test(discr('door') + conf('door') + JSON.stringify(names('door')).toLowerCase()));
ok('door-loom: intermittent/multi-error/unpowered => LOOM before PCB', /intermittent|multi|several|unrelated/.test(discr('door-loom')) && /loom before|before.*pcb|before condemning the pcb/.test(discr('door-loom') + conf('door-loom')));
ok('door-loom: does NOT tell the customer to work the loom while powered', /not.*(test|manipulate).*powered|power off|qualified/.test(discr('door-loom')));
ok('main-pcb: PCB is LAST (loom/supply/door/component wiring first)', /pcb is last|last/.test(discr('main-pcb')) || last('main-pcb', 'pcb') || last('main-pcb', 'board'));
ok('main-pcb: several errors => loom before the board', /loom|wiring/.test(first('main-pcb') + discr('main-pcb') + conf('main-pcb')));
ok('comms: power-cycle/loom before the UI/control board', /power-?cycle|reset|loom/.test(first('comms') + discr('comms')));

// ---- 11. SENSING — clean the sensing PATH before condemning the sensor ------------------------
ok('pressure-switch: scaled sensing PATH (chamber/hose) checked before the switch', /chamber|hose|air path|path/.test(first('pressure-switch')) && /sensing path|sensor.*fine|clean it first/.test(discr('pressure-switch') + conf('pressure-switch')));
ok('flow-meter: supply/inlet/fill path before the meter', /supply|inlet|fill/.test(first('flow-meter')));
ok('turbidity-sensor: dirty lens/debris cleaned before the sensor', /lens|debris|clean/.test(first('turbidity-sensor')));
ok('low-voltage: property supply/socket/fuse before internal parts', /supply|socket|fuse|plug/.test(first('low-voltage')));

// ---- 12. ERROR CODE = a detected SYSTEM/CONDITION (an existing node), not a component ----------
const dwCodeMaps = Object.entries(CAT.errorCodes).flatMap(([, plat]) => plat.dishwasher ? Object.entries(plat.dishwasher) : []);
ok('dishwasher error codes exist across brands', dwCodeMaps.length >= 40);
ok('every dishwasher error code resolves to an EXISTING dishwasher node (system/condition)', dwCodeMaps.every(([, node]) => NODES.includes(node)));
// a DRAIN error must land on the check-first drain journey, not jump straight to a bare component
const drainCodes = dwCodeMaps.filter(([, node]) => node === 'not-draining' || node === 'drain-pump');
ok('representative DRAIN error codes map to not-draining/drain-pump nodes (check-first interpretation)', drainCodes.length >= 3);
const fillCodes = dwCodeMaps.filter(([, node]) => node === 'fill');
ok('representative FILL error codes map to the fill node (supply/anti-flood first)', fillCodes.length >= 2);
const heatCodes = dwCodeMaps.filter(([, node]) => node === 'heating');
ok('representative HEATING error codes map to the heating node (genuine-cold first)', heatCodes.length >= 2);
const floodCodes = dwCodeMaps.filter(([, node]) => node === 'leak-flood');
ok('representative FLOOD/LEAK error codes map to the leak-flood node (find the leak)', floodCodes.length >= 2);

// ---- 13. BRAND NEUTRALITY — architecture reference is allowed, prevalence claims are not -------
for (const n of NODES) {
  const t = discr(n) + conf(n);
  // "common fault on <brand>" style prevalence is disallowed; naming an architecture (Bosch side matrix) is fine
  const overclaim = /common (fault|problem|failure) (on|with) (bosch|siemens|neff|beko|hotpoint|indesit|whirlpool|candy|hoover|aeg|electrolux|miele|samsung|lg)\b/.test(t);
  ok(`${n}: no unsupported brand-prevalence claim`, !overclaim);
}

// ---- 14. PAIRED / NEAR-NEIGHBOUR CASES -------------------------------------------------------
const PAIRS = [
  ['small water below filter vs tub full of water', () => /filter/.test(first('not-draining')) && /standing water|water left/.test(JSON.stringify(doc('not-draining').symptoms || []).toLowerCase())],
  ['wont-drain vs drains-then-water-returns(backflow)', () => before('not-draining', 'filter', 'pump') && (idx('not-draining', 'non-return') !== -1 || /waste|spigot|siphon/.test(discr('not-draining')))],
  ['wont-fill(no pump) vs wont-fill(drain pump runs = anti-flood)', () => /supply|tap/.test(first('fill')) && /anti-flood|flood/.test(discr('fill') + conf('fill'))],
  ['fills-but-no-wash(circulation) vs washes-but-wont-drain(drain)', () => /spray|arm/.test(first('circulation-pump')) && /filter/.test(first('not-draining'))],
  ['spray-arm blocked-by-dish vs no-spray-pressure(circulation)', () => /block|catch|jet/.test(first('spray-arm')) && idx('circulation-pump', 'circulation') !== -1],
  ['no-heat(cold everywhere) vs poor-drying-only(hot-but-wet)', () => /cold/.test(first('heating')) && /rinse.?aid/.test(first('poor-drying'))],
  ['plastics-wet(normal) vs everything-cold-and-wet(heating)', () => /plastic/.test(discr('poor-drying') + advice('poor-drying') + JSON.stringify(names('poor-drying'))) && /cold/.test(discr('poor-drying') + conf('poor-drying'))],
  ['dispenser blocked-by-dish vs dispenser-never-releases', () => /plate|pan|loading|block/.test(discr('detergent-dispenser') + JSON.stringify(names('detergent-dispenser'))) && idx('detergent-dispenser', 'mechanism') !== -1],
  ['front-leak+foam/split-arm vs front-leak+damaged-seal', () => /split|spray arm|foam|align/.test(discr('leak-flood') + conf('leak-flood')) && idx('leak-flood', 'door seal') !== -1],
  ['grinding during WASH(circulation) vs grinding during DRAIN(drain)', () => /washing/.test(discr('circulation-pump')) && /drain/.test(discr('circulation-pump'))],
  ['white-film(maintenance) vs genuine-poor-wash(filter/heat)', () => /chalky|white/.test(discr('poor-clean-results') + conf('poor-clean-results')) && /filter/.test(first('poor-clean-results'))],
  ['drain-error+blocked-waste vs drain-error+pump-inactive', () => /waste|spigot|blockage/.test(discr('not-draining')) && /silent|dead/.test(discr('not-draining') + JSON.stringify(names('not-draining')))],
  ['trips-immediately(mains filter) vs trips-on-heat(heater)', () => /power-?on|immediate|instant|switch/.test(discr('tripping-electrics')) && /heating/.test(discr('tripping-electrics'))],
  ['salt-light(settings) vs genuine-softener-fault(part)', () => /salt/.test(first('conductivity-sensor')) && (last('conductivity-sensor', 'softener') || /softener/.test(discr('conductivity-sensor')))],
  ['long-eco-cycle(normal) vs stuck-waiting-for-heat', () => /cold/.test(first('heating')) && /abnormally long|run.*long|longer/.test(discr('heating') + JSON.stringify(doc('heating').symptoms || []).toLowerCase() + secondary('heating'))],
];
for (const [name, fn] of PAIRS) ok(`PAIR: ${name}`, fn());

console.log(`\ndishwasher engineer challenge: ${pass} passed, ${fail} failed  (nodes=${NODES.length}, paired cases=${PAIRS.length})`);
if (fail) { console.log('FAILURES:', fails.join(' | ')); process.exit(1); }
process.exit(0);
