'use strict';
/**
 * Fridge / freezer and tumble dryer mc/1 fixtures (same format as mc1-dw-fixtures.cjs). `live.accept` lists harmless
 * alternatives (observation accept values are full sets). Family-bleed fixtures pin fridge fan ≠ dryer fan, dryer belt ≠
 * washing-machine belt, compressor language only for refrigeration, condensate / container only for dryers.
 */
const FFA = ['fridge-freezer', 'stated'];
const TDA = ['tumble-dryer', 'stated'];
const ffCtx = (journey, extra = {}) => ({ appliance: FFA, journey, ...extra });
const tdCtx = (journey, extra = {}) => ({ appliance: TDA, journey, ...extra });
const ffOpen = (journey, faultDomain, observations = {}, more = {}) => ({ scope: 'appliance', appliance: FFA, intent: 'report_fault', faultDomain, journey, observations, ...more });
const tdOpen = (journey, faultDomain, observations = {}, more = {}) => ({ scope: 'appliance', appliance: TDA, intent: 'report_fault', faultDomain, journey, observations, ...more });

const FF = [
  { id: 'ff-nc-opener-fridge-only', message: 'My fridge is warm but the freezer is still frozen solid', expect: ffOpen('not-cooling', 'cooling', {}, { symptomScope: 'fridge_only' }) },
  { id: 'ff-nc-opener-both', message: 'Both the fridge and the freezer on my fridge freezer are warm', expect: ffOpen('not-cooling', 'cooling', { bothCompartmentsWarm: true }) },
  { id: 'ff-nc-opener-door-left', message: 'My fridge freezer is not cold, the door was left open overnight', expect: ffOpen('not-cooling', 'cooling', { doorLeftOpen: true }) },
  { id: 'ff-nc-pending-compartment', message: 'just the fridge, the freezer is fine', ctx: ffCtx('not-cooling', { pending: { slot: 'OBSERVATION', target: 'ffCompartment' } }),
    expect: { scope: 'appliance', symptomScope: 'fridge_only', toPending: 'answered' },
    live: { accept: { observations: [{}], journey: [null, 'not-cooling'], faultDomain: [null, 'cooling'], relation: [null, 'same'], appliance: [null, ['fridge-freezer', 'stated']] } } },
  { id: 'ff-nc-pending-settings', message: 'it was on the warmest setting, turned it down', ctx: ffCtx('not-cooling', { pending: { slot: 'CHECK', target: 'temp-setting' } }),
    expect: { scope: 'appliance', checks: { 'temp-setting': ['done', 'found_and_cleared'] }, toPending: 'answered' } },
  { id: 'ff-nc-pending-coils', message: 'the coil at the back was thick with dust, hoovered it off', ctx: ffCtx('not-cooling', { pending: { slot: 'CHECK', target: 'condenser-coil-clear' } }),
    expect: { scope: 'appliance', checks: { 'condenser-coil-clear': ['done', 'found_and_cleared'] }, toPending: 'answered' }, live: { accept: { toPending: ['partial'] } } },
  { id: 'ff-nc-pending-fan-silent', message: 'no I cannot hear any fan at all', ctx: ffCtx('not-cooling', { pending: { slot: 'OBSERVATION', target: 'fanAudible' } }),
    expect: { scope: 'appliance', observations: { fanAudible: false }, toPending: 'answered' } },
  { id: 'ff-nc-pending-compressor-runs', message: "yes it's humming away at the back", ctx: ffCtx('not-cooling', { pending: { slot: 'OBSERVATION', target: 'ffCompressorState' } }),
    expect: { scope: 'appliance', observations: { compressorRuns: true }, toPending: 'answered' },
    live: { accept: { observations: [{ compressorRuns: true, humNoise: true }, { compressorRuns: true, motorAudible: true, humNoise: true, noiseThroughout: true, noiseFromInside: false }, { compressorRuns: true, motorAudible: true }, { compressorRuns: true, motorAudible: true, humNoise: true }] } } },
  { id: 'ff-tc-opener', message: 'Everything in my fridge is freezing, even the lettuce', expect: ffOpen('over-cooling', 'cooling') },
  { id: 'ff-ns-opener-gurgle', message: 'My fridge freezer makes a gurgling noise every so often', expect: ffOpen('noisy', 'noise', { gurglingNoise: true }) },
  { id: 'ff-ns-opener-fan', message: 'My freezer makes a squealing noise inside that stops when I open the door', expect: ffOpen('noisy', 'noise', { squealNoise: true, noiseFromInside: true, noiseStopsWhenDoorOpen: true }),
    live: { accept: { observations: [{ squealNoise: true, noiseStopsWhenDoorOpen: true }, { squealNoise: true, fanAudible: true, noiseStopsWhenDoorOpen: true, noiseFromInside: true }] } } },
  { id: 'ff-ns-pending-back', message: "it's coming from the back at the bottom", ctx: ffCtx('noisy', { pending: { slot: 'OBSERVATION', target: 'noiseFromInside' } }),
    expect: { scope: 'appliance', observations: { noiseFromInside: false }, toPending: 'answered' } },
  { id: 'ff-lk-opener-inside', message: 'There is water pooling under the salad drawers inside my fridge', expect: ffOpen('leaking', 'water', { waterInsideFridge: true }), live: { accept: { observations: [{ waterInsideFridge: true, waterRemaining: true }] } } },
  { id: 'ff-lk-opener-under', message: "There's a puddle on the floor under my fridge freezer", expect: ffOpen('leaking', 'water', { leakUnderneath: true }),
    live: { accept: { observations: [{ leakUnderneath: true, majorLeak: false }] } } },
  { id: 'ff-lk-pending-drain', message: 'the little hole at the back was blocked, flushed it with warm water', ctx: ffCtx('leaking', { pending: { slot: 'CHECK', target: 'defrost-drain' } }),
    expect: { scope: 'appliance', checks: { 'defrost-drain': ['done', 'found_and_cleared'] }, toPending: 'answered' } },
  { id: 'ff-ic-opener-back-wall', message: 'My freezer keeps getting thick ice on the back wall', expect: ffOpen('ice-build-up', 'cooling', { heavyIce: true, frostOnBackWall: true }),
    live: { accept: { observations: [{ frostOnBackWall: true }, { heavyIce: true, frostOnBackWall: true, iceReturns: true }] } } },
  { id: 'ff-ic-pending-returns', message: "it's come back again already, only defrosted it last week", ctx: ffCtx('ice-build-up', { checks: { defrost: ['done', 'found_and_cleared'] }, pending: { slot: 'CHECK', target: 'retest' } }),
    expect: { scope: 'appliance', observations: { iceReturns: true, faultPersists: true }, checks: { retest: ['done', null] }, toPending: 'answered' },
    live: { accept: { observations: [{ faultPersists: true }, { iceReturns: true }], checks: [{}], journey: [null, 'ice-build-up'], faultDomain: [null, 'cooling'], relation: [null, 'same'], outcome: [null, 'temporary', 'unresolved'] } } },
  { id: 'ff-dr-opener-seal', message: "My fridge door doesn't seal properly, the rubber has come away at the corner", expect: ffOpen('door-problem', 'door', { doorNotSeating: true }) },
  { id: 'ff-dr-pending-hinge', message: 'the top hinge has snapped and the door has dropped', ctx: ffCtx('door-problem', { pending: { slot: 'CHECK', target: 'ff-door-fit' } }),
    expect: { scope: 'appliance', checks: { 'ff-door-fit': ['done', 'fault_seen'] }, toPending: 'answered' }, live: { accept: { journey: [null, 'door-problem'], faultDomain: [null, 'door'], relation: [null, 'same'] } } },
  { id: 'ff-dd-opener-dead', message: 'My fridge freezer is completely dead, no light inside', expect: ffOpen('wont-start', 'power', { noPower: true }) },
  { id: 'ff-dd-opener-click', message: 'My fridge freezer is warm and it just clicks every few minutes but never starts', expect: ffOpen('not-cooling', 'cooling', { clicksNoStart: true }),
    live: { accept: { journey: ['not-cooling', 'wont-start'], faultDomain: ['cooling', 'power'], observations: [{ clicksNoStart: true, clickingNoise: true }] } } },
];
const TD = [
  { id: 'td-nh-opener-cold', message: 'My tumble dryer runs but there is no heat at all, just cold air', expect: tdOpen('no-heat', 'heat', { noHeat: true }) },
  { id: 'td-nd-opener-hot-damp', message: 'My tumble dryer gets hot but the clothes are still damp', expect: tdOpen('not-drying', 'drying', { heatPresent: true }) },
  { id: 'td-nd-opener-heat-pump', message: 'My heat pump tumble dryer is taking ages and the clothes are still wet', expect: tdOpen('not-drying', 'drying', { dryerHeatPump: true, longCycle: true }),
    live: { accept: { observations: [{ dryerHeatPump: true }] } } },
  { id: 'td-nd-pending-type', message: "it's a condenser one with the water tank", ctx: tdCtx('not-drying', { pending: { slot: 'OBSERVATION', target: 'dryerType' } }),
    expect: { scope: 'appliance', observations: { dryerCondenser: true }, toPending: 'answered' } },
  { id: 'td-nd-pending-filter', message: 'the fluff filter was packed solid, cleaned it', ctx: tdCtx('not-drying', { pending: { slot: 'CHECK', target: 'lint-filter' } }),
    expect: { scope: 'appliance', checks: { 'lint-filter': ['done', 'found_and_cleared'] }, toPending: 'answered' } },
  { id: 'td-nd-pending-sensor', message: 'the two metal strips were all greasy, wiped them clean', ctx: tdCtx('not-drying', { pending: { slot: 'CHECK', target: 'sensor-bars' } }),
    expect: { scope: 'appliance', checks: { 'sensor-bars': ['done', 'found_and_cleared'] }, toPending: 'answered' } },
  { id: 'td-dt-opener', message: "My tumble dryer drum won't turn but I can hear the motor", expect: tdOpen('drum-not-turning', 'motion', { motorAudible: true }), live: { accept: { observations: [{ motorAudible: true, drumTurns: false }] } } },
  { id: 'td-dt-pending-free', message: 'it spins round really easily, no resistance at all', ctx: tdCtx('drum-not-turning', { pending: { slot: 'CHECK', target: 'drum-by-hand' } }),
    expect: { scope: 'appliance', observations: { drumUnusuallyFree: true }, checks: { 'drum-by-hand': ['done', 'clear'] }, toPending: 'answered' },
    live: { accept: { observations: [{ drumUnusuallyFree: true, drumTurnsByHand: true }], checks: [{ 'drum-by-hand': ['done', null] }] } } },
  { id: 'td-dt-belt-snapped', message: 'the belt on my tumble dryer has snapped', ctx: tdCtx('drum-not-turning'),
    expect: { scope: 'appliance', checks: { 'drive-belt': ['done', 'fault_seen'] } },
    live: { accept: { journey: [null, 'drum-not-turning'], faultDomain: [null, 'motion'], relation: [null, 'same'], appliance: [null, ['tumble-dryer', 'stated']], intent: [null, 'report_fault'] } } },
  { id: 'td-ns-opener-squeal', message: 'My tumble dryer squeals when it is turning', expect: tdOpen('noisy', 'noise', { squealNoise: true }), live: { accept: { observations: [{ squealNoise: true, drumTurns: true }, { squealNoise: true, drumTurns: true, noiseOnSpin: true }, { squealNoise: true, noiseThroughout: true }] } } },
  { id: 'td-st-opener-restarts', message: 'My tumble dryer stops half way through but starts again once it has cooled down', expect: tdOpen('cuts-out', 'power', { restartsAfterCooling: true }),
    live: { accept: { journey: ['cuts-out', 'cycle-not-completing'], faultDomain: ['power', 'drying', 'heat'], observations: [{ restartsAfterCooling: true, cutsOut: true }, { restartsAfterCooling: true, cutsOut: true, overheatsThenCuts: true }, { restartsAfterCooling: true, cutsOut: true, overheatsThenCuts: true, longCycle: true }, { restartsAfterCooling: true, cutsOut: true, overheatsThenCuts: true, longCycle: true, intermittentSpin: true }] } } },
  { id: 'td-wc-opener-tank-warning', message: 'My tumble dryer keeps stopping with the empty water container light on', expect: tdOpen('cuts-out', 'power', { tankWarning: true }),
    live: { accept: { journey: ['cuts-out', 'cycle-not-completing', 'leaking'], faultDomain: ['power', 'water', 'drying'], observations: [{ tankWarning: true, cutsOut: true }, { tankWarning: true, cutsOut: true, dryerCondenser: true }, { tankWarning: true, dryerCondenser: true }] } } },
  { id: 'td-wc-opener-empty', message: 'The water container on my tumble dryer stays empty and there is water on the floor', expect: tdOpen('leaking', 'water', { tankStaysEmpty: true, leakUnderneath: true }),
    live: { accept: { observations: [{ tankStaysEmpty: true }, { tankStaysEmpty: true, leakUnderneath: true, majorLeak: false }, { tankStaysEmpty: true, dryerCondenser: true }, { tankStaysEmpty: true, dryerCondenser: true, leakUnderneath: true }] } } },
  { id: 'td-wc-pending-vented', message: "it's a vented one, the hose goes out through the wall", ctx: tdCtx('leaking', { pending: { slot: 'OBSERVATION', target: 'dryerType' } }),
    expect: { scope: 'appliance', observations: { dryerVented: true }, toPending: 'answered' } },
  { id: 'td-dg-opener-door', message: "My tumble dryer won't start, it says the door is open", expect: tdOpen('door-problem', 'door', { doorRecognised: false }),
    live: { accept: { journey: ['door-problem', 'wont-start'], faultDomain: ['door', 'power'], observations: [{ doorRecognised: false, doorLocks: false }, { doorRecognised: false, doorLocks: false, noPower: false }] } } },
  { id: 'td-dg-pending-catch', message: 'the catch on the door is snapped off', ctx: tdCtx('door-problem', { pending: { slot: 'CHECK', target: 'door-catch' } }),
    expect: { scope: 'appliance', checks: { 'door-catch': ['done', 'fault_seen'] }, toPending: 'answered' }, live: { accept: { faultDomain: [null, 'door'], relation: [null, 'same'], observations: [{}, { doorStartProblem: true }] } } },
];
// retest replies (the shared outcome observation; terse "works now" replies)
const RETEST = [
  { id: 'fftd-retest-td-starts-now', message: 'It starts now', ctx: tdCtx('door-problem', { checks: { 'child-lock': ['done', 'found_and_cleared'] }, pending: { slot: 'CHECK', target: 'retest' } }),
    expect: { scope: 'appliance', observations: { faultPersists: false }, checks: { retest: ['done', null] }, toPending: 'answered' },
    live: { accept: { outcome: [null, 'resolved'], checks: [{}] } } },
  { id: 'fftd-retest-td-ran-through', message: 'It ran all the way through', ctx: tdCtx('cuts-out', { checks: { 'water-container': ['done', 'found_and_cleared'] }, pending: { slot: 'CHECK', target: 'retest' } }),
    expect: { scope: 'appliance', observations: { faultPersists: false }, checks: { retest: ['done', null] }, toPending: 'answered' },
    live: { accept: { outcome: [null, 'resolved'], checks: [{}] } } },
  { id: 'fftd-retest-td-heating-again', message: "It's heating again", ctx: tdCtx('no-heat', { observations: { noHeat: true }, checks: { 'lint-filter': ['done', 'found_and_cleared'] }, pending: { slot: 'CHECK', target: 'retest' } }),
    expect: { scope: 'appliance', observations: { faultPersists: false }, checks: { retest: ['done', null] }, toPending: 'answered' },
    live: { accept: { outcome: [null, 'resolved'], checks: [{}], observations: [{ faultPersists: false, heatPresent: true }] } } },
  { id: 'fftd-retest-ff-cold-again', message: "Yes it's cold again", ctx: ffCtx('not-cooling', { checks: { 'temp-setting': ['done', 'found_and_cleared'] }, pending: { slot: 'CHECK', target: 'retest' } }),
    expect: { scope: 'appliance', observations: { faultPersists: false }, checks: { retest: ['done', null] }, toPending: 'answered' },
    live: { accept: { outcome: [null, 'resolved'], checks: [{}] } } },
  { id: 'fftd-retest-ff-fine-now', message: 'Fine now', ctx: ffCtx('over-cooling', { checks: { 'vents-clear': ['done', 'found_and_cleared'] }, pending: { slot: 'CHECK', target: 'retest' } }),
    expect: { scope: 'appliance', observations: { faultPersists: false }, checks: { retest: ['done', null] }, toPending: 'answered' },
    live: { accept: { outcome: [null, 'resolved'], checks: [{}] } } },
];
// hazard WITH a fault: the fault's journey is typed (the hazard is recorded too)
const HAZ = [
  { id: 'fftd-hazard-noise-burning', message: "My fridge is buzzing and now there's a burning smell", expect: ffOpen('noisy', 'noise', { humNoise: true }, { hazard: 'burning' }),
    live: { accept: { faultDomain: ['noise', null] } } },
  { id: 'fftd-hazard-dryer-squeal-burning', message: "My dryer is squealing and there's a burning smell", expect: tdOpen('noisy', 'noise', { squealNoise: true }, { hazard: 'burning' }),
    live: { accept: { faultDomain: ['noise', null] } } },
];
// family bleed
const BLEED = [
  { id: 'fftd-bleed-dryer-fan', message: 'the fan inside my tumble dryer is making a noise', ctx: tdCtx('noisy'),
    expect: { scope: 'appliance' }, live: { accept: { appliance: [null, ['tumble-dryer', 'stated']], intent: [null, 'report_fault'], journey: [null, 'noisy'], faultDomain: [null, 'noise'], relation: [null, 'same'], observations: [{}, { humNoise: true }, { grindingNoise: true }, { rattlingNoise: true }] } } },
  { id: 'fftd-bleed-hp-compressor', message: 'my heat pump dryer hums from the compressor', ctx: tdCtx('noisy'),
    expect: { scope: 'appliance', observations: { dryerHeatPump: true, humNoise: true } }, live: { accept: { journey: [null, 'noisy'], faultDomain: [null, 'noise'], relation: [null, 'same'], appliance: [null, ['tumble-dryer', 'stated']], theories: [[], ['compressor']] } } },
  { id: 'fftd-bleed-wm-belt', message: 'the belt has come off', ctx: { appliance: ['washing-machine', 'stated'], journey: 'not-spinning' },
    expect: { scope: 'appliance', checks: { 'drive-belt': ['done', 'fault_seen'] } }, live: { accept: { relation: [null, 'same'], intent: [null, 'report_fault'], journey: [null, 'not-spinning'], faultDomain: [null, 'motion'] } } },
];
const tag = (g, xs) => xs.map((x) => ({ group: g, ...x }));
const FFF = tag('fridge-freezer', FF);
const TDF = tag('tumble-dryer', TD);
module.exports = { FFF, TDF, BLEEDF: tag('fftd-bleed', BLEED), ALL: [...FFF, ...TDF, ...tag('fftd-retest', RETEST), ...tag('fftd-hazard', HAZ), ...tag('fftd-bleed', BLEED)] };
