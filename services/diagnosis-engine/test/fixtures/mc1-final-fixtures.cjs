'use strict';
/**
 * Final-pass mc/1 fixtures: oven / cooker, hob, microwave, vacuum, washer-dryer (same format as mc1-fftd-fixtures.cjs).
 * Family bleed pins "fan" / "heater" / "door" to the appliance family; vacuum model tokens are identity, never codes;
 * safety reports are hazards (they alter the path).
 */
const A = (a) => [a, 'stated'];
const open = (a, journey, faultDomain, observations = {}, more = {}) => ({ scope: 'appliance', appliance: A(a), intent: 'report_fault', faultDomain, journey, observations, ...more });
const ctx = (a, journey, extra = {}) => ({ appliance: A(a), journey, ...extra });
const ans = (more) => ({ scope: 'appliance', toPending: 'answered', ...more });
const ANS_ACCEPT = (a, j, fd) => ({ journey: [null, j], faultDomain: [null, fd], relation: [null, 'same'], appliance: [null, A(a)] });

const OVEN = [
  { id: 'ov-nh-fan-runs', message: 'My oven fan runs but the oven isn\'t heating up at all, the grill works fine', expect: open('oven-cooker', 'no-heat', 'heat', { ovenFanTurns: true, grillWorks: true, mainOvenWorks: false }),
    live: { accept: { observations: [{ ovenFanTurns: true, grillWorks: true, mainOvenWorks: false }, { ovenFanTurns: true, grillWorks: true }, { ovenFanTurns: true, grillWorks: true, noHeat: true }, { ovenFanTurns: true, grillWorks: true, mainOvenWorks: false, noHeat: true }] } } },
  { id: 'ov-nh-clock-flashing', message: 'After a power cut my oven won\'t heat and the clock is flashing', expect: open('oven-cooker', 'no-heat', 'heat', { clockFlashing: true }),
    live: { accept: { observations: [{ clockFlashing: true }, { clockFlashing: true, noHeat: true }] } } },
  { id: 'ov-grill-only', message: 'The grill on my cooker has stopped working but the oven is fine', expect: open('oven-cooker', 'no-heat', 'heat', { grillWorks: false, mainOvenWorks: true }, { symptomScope: 'grill_only' }),
    live: { accept: { symptomScope: [null, 'grill_only'], observations: [{ grillWorks: false, mainOvenWorks: true }, { grillWorks: false }] } } },
  { id: 'ov-fan-not-turning', message: 'The fan at the back of my oven has stopped turning', expect: open('oven-cooker', 'no-heat', 'heat', { ovenFanTurns: false }),
    live: { accept: { journey: ['no-heat', 'noisy', 'wont-start'], faultDomain: ['heat', 'airflow', 'motion', 'noise'] } } },
  { id: 'ov-overheating', message: 'My oven gets far too hot and burns everything even on a low setting', expect: open('oven-cooker', 'overheating', 'heat', { tooHot: true }),
    live: { accept: { observations: [{ tooHot: true }, {}] } } },
  { id: 'ov-stuck-on', message: 'The oven keeps heating even when I turn it off', expect: open('oven-cooker', 'overheating', 'heat', { stuckOnHigh: true }),
    live: { accept: { observations: [{ stuckOnHigh: true }, { stuckOnHigh: true, tooHot: true }] } } },
  { id: 'ov-dead', message: 'My built in oven is completely dead, no display at all', expect: open('oven-cooker', 'wont-start', 'power', { noPower: true }) },
  { id: 'ov-door-glass', message: 'The glass on my oven door has cracked', expect: open('oven-cooker', 'door-problem', 'door', { doorGlassCracked: true }) },
  { id: 'ov-door-hinge', message: 'My oven door won\'t close properly, it drops down on one side', expect: open('oven-cooker', 'door-problem', 'door', { doorCloses: false }),
    live: { accept: { observations: [{ doorCloses: false }, {}] } } },
  { id: 'ov-trip', message: 'Every time I switch the oven on it trips the electrics', expect: open('oven-cooker', 'trips-electrics', 'power', { tripsImmediately: true }, { hazard: 'supply_trip' }),
    live: { accept: { journey: [null, 'trips-electrics', 'wont-start'], observations: [{ tripsImmediately: true }, {}] } } },
  { id: 'ov-gas-smell', message: 'I can smell gas from my cooker', expect: open('oven-cooker', null, null, {}, { hazard: 'gas_smell', intent: 'report_fault' }),
    live: { accept: { journey: [null, 'wont-light'], faultDomain: [null, 'ignition'], intent: ['report_fault', null] } } },
  { id: 'ov-gas-clicks', message: 'One of the gas burners on my cooker clicks but won\'t light', expect: open('oven-cooker', 'wont-light', 'ignition', { sparkClicks: true, oneBurnerOnly: true }, { fuel: 'gas' }),
    live: { accept: { fuel: [null, 'gas'], observations: [{ sparkClicks: true, oneBurnerOnly: true }, { sparkClicks: true }] } } },
  { id: 'ov-fan-pending', message: 'yes I can hear it whirring', ctx: ctx('oven-cooker', 'no-heat', { pending: { slot: 'OBSERVATION', target: 'ovenFanTurns' } }), expect: ans({ observations: { ovenFanTurns: true } }),
    live: { accept: ANS_ACCEPT('oven-cooker', 'no-heat', 'heat') } },
  { id: 'ov-clock-pending', message: 'it was flashing, I set the clock and now it heats', ctx: ctx('oven-cooker', 'no-heat', { pending: { slot: 'CHECK', target: 'oven-clock-mode' } }),
    expect: ans({ checks: { 'oven-clock-mode': ['done', 'found_and_cleared'] }, observations: { faultPersists: false } }),
    live: { accept: { ...ANS_ACCEPT('oven-cooker', 'no-heat', 'heat'), observations: [{ faultPersists: false }, { faultPersists: false, clockFlashing: true }, { clockFlashing: true }, {}], outcome: [null, 'resolved'] } } },
];
const HOB = [
  { id: 'hb-zone-induction', message: 'One ring on my induction hob isn\'t heating and the pan symbol flashes', expect: open('hob', 'no-heat', 'heat', { inductionHob: true, panSymbolFlashing: true }, { symptomScope: 'one_zone' }),
    live: { accept: { symptomScope: [null, 'one_zone'] } } },
  { id: 'hb-dead', message: 'My ceramic hob has no power at all', expect: open('hob', 'wont-start', 'power', { ceramicHob: true, noPower: true }) },
  { id: 'hb-stuck', message: 'One zone on my hob stays on full and won\'t turn down', expect: open('hob', 'overheating', 'controls', { stuckOnHigh: true }, { symptomScope: 'one_zone' }),
    live: { accept: { journey: ['overheating', 'controls-unresponsive'], faultDomain: ['controls', 'heat'], symptomScope: [null, 'one_zone'] } } },
  { id: 'hb-gas-light', message: 'The gas hob burner won\'t light, there\'s no clicking', expect: open('hob', 'wont-light', 'ignition', { gasHob: true, sparkClicks: false }),
    live: { accept: { fuel: [null, 'gas'] } } },
  { id: 'hb-cracked', message: 'The glass top of my ceramic hob has cracked', expect: open('hob', null, null, { ceramicHob: true }, { hazard: 'exposed_live_wiring' }),
    live: { accept: { journey: [null, 'no-heat', 'wont-start'], faultDomain: [null, 'power', 'heat'], hazard: ['exposed_live_wiring', null] } } },
];
const MW = [
  { id: 'mw-no-heat', message: 'My microwave runs, the light and turntable work, but the food stays cold', expect: open('microwave', 'no-heat', 'heat', { runsNormally: true }) },
  { id: 'mw-says-open', message: 'The microwave says the door is open even though it\'s shut', expect: open('microwave', 'door-problem', 'door', { doorRecognised: false }),
    live: { accept: { journey: ['door-problem', 'wont-start'] } } },
  { id: 'mw-latch', message: 'My microwave door won\'t latch shut', expect: open('microwave', 'door-problem', 'door', { doorCloses: false }) },
  { id: 'mw-turntable', message: 'The turntable in my microwave has stopped going round', expect: open('microwave', 'turntable-not-turning', 'motion', { turntableTurns: false }) },
  { id: 'mw-sparking-foil', message: 'My microwave sparked, there was some foil on the dish', expect: open('microwave', 'sparking', 'noise', { metalInside: true }, { hazard: 'microwave_arcing' }),
    live: { accept: { faultDomain: ['noise', 'heat', 'power', null] } } },
  { id: 'mw-waveguide', message: 'There\'s sparking inside my microwave and the little cover on the side wall is burnt', expect: open('microwave', 'sparking', 'noise', { waveguideCoverDamaged: true }, { hazard: 'microwave_arcing' }),
    live: { accept: { faultDomain: ['noise', 'heat', 'power', null] } } },
  { id: 'mw-door-start', message: 'My microwave starts on its own as soon as I close the door', expect: open('microwave', 'wont-start', 'door', { startsWhenDoorCloses: true }),
    live: { accept: { journey: ['wont-start', 'door-problem', 'controls-unresponsive'], faultDomain: ['door', 'controls', 'power'] } } },
  { id: 'mw-hv-request', message: 'How do I test the magnetron and discharge the capacitor on my microwave?', expect: open('microwave', 'no-heat', 'heat', {}, { unsafeAction: 'hv_microwave_work', intent: 'report_fault' }),
    live: { accept: { journey: [null, 'no-heat'], faultDomain: [null, 'heat'], intent: ['report_fault', 'fitting_help', 'other_appliance_question', null] } } },
];
const VAC = [
  { id: 'vac-dyson-pulsing', message: 'My Dyson V6 keeps pulsing on and off', expect: open('vacuum', 'pulsing', 'airflow', {}, { make: 'dyson', model: 'V6' }),
    live: { accept: { model: [null, 'V6'], faultDomain: ['airflow', 'power', 'motion'], observations: [{}, { vacuumCordless: true }, { cutsOut: true }, { vacuumCordless: true, cutsOut: true }] } } },
  { id: 'vac-low-suction', message: 'My Henry hoover has lost its suction', expect: open('vacuum', 'lost-suction', 'airflow', { weakSuction: true, vacuumCorded: true }),
    live: { accept: { observations: [{ weakSuction: true }, { weakSuction: true, vacuumCorded: true }], make: [null, 'henry', 'numatic'] } } },
  { id: 'vac-short-runtime', message: 'My cordless vacuum only runs for a couple of minutes before it dies', expect: open('vacuum', 'battery-problem', 'power', { vacuumCordless: true, shortRuntime: true }),
    live: { accept: { journey: ['battery-problem', 'cuts-out'], observations: [{ vacuumCordless: true, shortRuntime: true }, { vacuumCordless: true, shortRuntime: true, cutsOut: true }] } } },
  { id: 'vac-wont-charge', message: 'My stick vacuum won\'t charge, no light comes on', expect: open('vacuum', 'battery-problem', 'power', { vacuumCordless: true, wontCharge: true }),
    live: { accept: { journey: ['battery-problem', 'wont-start'] } } },
  { id: 'vac-brush', message: 'The brush bar on my vacuum isn\'t spinning', expect: open('vacuum', 'brush-bar-not-spinning', 'motion', { brushNotSpinning: true }) },
  { id: 'vac-whistle', message: 'My vacuum is making a high-pitched whistling noise', expect: open('vacuum', 'noisy', 'noise', { whistleNoise: true }) },
  { id: 'vac-dead', message: 'My corded vacuum won\'t switch on at all', expect: open('vacuum', 'wont-start', 'power', { vacuumCorded: true, noPower: true }) },
  { id: 'vac-filter-pending', message: 'the filter was filthy, washed it and it\'s drying now', ctx: ctx('vacuum', 'pulsing', { pending: { slot: 'CHECK', target: 'vacuum-bin-filters' } }),
    expect: ans({ checks: { 'vacuum-bin-filters': ['done', 'found_and_cleared'] } }), live: { accept: ANS_ACCEPT('vacuum', 'pulsing', 'airflow') } },
  { id: 'vac-type-pending', message: 'it\'s a cordless one', ctx: ctx('vacuum', 'pulsing', { pending: { slot: 'OBSERVATION', target: 'vacType' } }), expect: ans({ observations: { vacuumCordless: true } }),
    live: { accept: ANS_ACCEPT('vacuum', 'pulsing', 'airflow') } },
];
const WD = [
  { id: 'wd-dry-damp', message: 'My washer dryer washes fine but the clothes come out damp after drying', expect: open('washer-dryer', 'not-drying', 'drying', { wdDrySide: true }, { symptomScope: 'dry_only' }),
    live: { accept: { symptomScope: [null, 'dry_only'], observations: [{ wdDrySide: true }, {}] } } },
  { id: 'wd-dry-cold', message: 'My washer dryer doesn\'t heat up when it\'s drying', expect: open('washer-dryer', 'no-heat', 'heat', { wdDrySide: true, noHeat: true }, { symptomScope: 'dry_only' }),
    live: { accept: { journey: ['no-heat', 'not-drying'], faultDomain: ['heat', 'drying'], symptomScope: [null, 'dry_only'], observations: [{ wdDrySide: true, noHeat: true }, { wdDrySide: true }, { noHeat: true }] } } },
  { id: 'wd-wash-cold', message: 'My washer dryer washes everything in cold water now', expect: open('washer-dryer', 'no-heat', 'heat', { wdDrySide: false, noHeat: true }, { symptomScope: 'wash_only' }),
    live: { accept: { symptomScope: [null, 'wash_only'], observations: [{ wdDrySide: false, noHeat: true }, { noHeat: true }, { wdDrySide: false }] } } },
  { id: 'wd-heat-unknown', message: 'My washer dryer doesn\'t heat', expect: open('washer-dryer', 'no-heat', 'heat', { noHeat: true }), live: { accept: { observations: [{ noHeat: true }, {}] } } },
  { id: 'wd-not-draining', message: 'My washer dryer won\'t drain, there\'s water left in the drum', expect: open('washer-dryer', 'not-draining', 'water', { waterRemaining: true }) },
  { id: 'wd-leaking', message: 'My washer dryer is leaking from the door', expect: open('washer-dryer', 'leaking', 'water', { leakAtDoor: true }) },
  { id: 'wd-side-pending', message: 'it\'s when it\'s drying', ctx: ctx('washer-dryer', 'no-heat', { pending: { slot: 'OBSERVATION', target: 'wdDrySide' } }), expect: ans({ observations: { wdDrySide: true } }),
    live: { accept: { ...ANS_ACCEPT('washer-dryer', 'no-heat', 'heat'), symptomScope: [null, 'dry_only'] } } },
  { id: 'wd-capacity-pending', message: 'yes it was a full 8kg load, I\'ve halved it', ctx: ctx('washer-dryer', 'not-drying', { pending: { slot: 'CHECK', target: 'wd-dry-capacity' } }),
    expect: ans({ checks: { 'wd-dry-capacity': ['done', 'found_and_cleared'] } }), live: { accept: ANS_ACCEPT('washer-dryer', 'not-drying', 'drying') } },
];
// family bleed: "fan" / "door" / "heater" stay in their family
const BLEED = [
  { id: 'bleed-mw-fan', message: 'The fan in my microwave is really loud', expect: open('microwave', 'noisy', 'noise', {}), live: { accept: { observations: [{}, { fanAudible: true }] } } },
  { id: 'bleed-dryer-fan-not-oven', message: 'My tumble dryer drum turns but the fan seems to have stopped', expect: open('tumble-dryer', null, null, {}),
    live: { accept: { journey: [null, 'not-drying', 'no-heat', 'noisy'], faultDomain: [null, 'drying', 'airflow', 'heat'], observations: [{}, { fanSpinning: false }, { drumTurns: true }, { drumTurns: true, fanSpinning: false }] } } },
  { id: 'bleed-oven-door-not-wm', message: 'My oven door is stuck shut after the self-clean', expect: open('oven-cooker', 'door-problem', 'door', { doorOpens: false }) },
];
const tag = (g, xs) => xs.map((x) => ({ group: g, ...x }));
module.exports = { ALL: [...tag('final-oven', OVEN), ...tag('final-hob', HOB), ...tag('final-mw', MW), ...tag('final-vac', VAC), ...tag('final-wd', WD), ...tag('final-bleed', BLEED)] };
