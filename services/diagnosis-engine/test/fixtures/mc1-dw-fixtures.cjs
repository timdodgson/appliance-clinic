'use strict';
/**
 * Dishwasher batch-1 mc/1 fixtures (same format as mc1-b2-fixtures.cjs). `live.accept` lists harmless alternatives.
 * Shared dishwasher facts are exercised once (e.g. water in the base appears under leaking and not filling).
 */
const DWA = ['dishwasher', 'stated'];
const ctxOf = (journey, extra = {}) => ({ appliance: DWA, journey, ...extra });
const opener = (journey, faultDomain, observations = {}, more = {}) => ({ scope: 'appliance', appliance: DWA, intent: 'report_fault', faultDomain, journey, observations, ...more });

const DR = [
  { id: 'dw-dr-opener-water-left', message: "My dishwasher won't drain, there's dirty water left in the bottom", expect: opener('not-draining', 'water', { waterRemaining: true }) },
  { id: 'dw-dr-opener-hum', message: 'My dishwasher hums at the end but the water stays in the bottom', expect: opener('not-draining', 'water', { waterRemaining: true, pumpHumming: true }) },
  { id: 'dw-dr-opener-sink', message: 'When my dishwasher drains the kitchen sink fills up with dirty water', expect: opener('not-draining', 'water', { waterReturnsAfterDrain: true }),
    live: { accept: { journey: ['not-draining', 'leaking'] } } },
  { id: 'dw-dr-pending-filter', message: 'the filter was full of food and bits of glass, cleaned it', ctx: ctxOf('not-draining', { pending: { slot: 'CHECK', target: 'dishwasher-filter' } }),
    expect: { scope: 'appliance', checks: { 'dishwasher-filter': ['done', 'found_and_cleared'] }, toPending: 'answered' } },
  { id: 'dw-dr-pending-impeller-glass', message: 'there was a shard of glass under the pump cover, got it out', ctx: ctxOf('not-draining', { pending: { slot: 'CHECK', target: 'pump-impeller' } }),
    expect: { scope: 'appliance', checks: { 'pump-impeller': ['done', 'found_and_cleared'] }, toPending: 'answered' } },
  { id: 'dw-dr-pending-spigot', message: 'the blanking plug was still in the new sink waste, I cut it out', ctx: ctxOf('not-draining', { pending: { slot: 'CHECK', target: 'waste-spigot' } }),
    expect: { scope: 'appliance', checks: { 'waste-spigot': ['done', 'found_and_cleared'] }, toPending: 'answered' } },
];
const FL = [
  { id: 'dw-fl-opener-no-water', message: "My dishwasher starts but no water comes in", expect: opener('not-filling', 'water', { waterEntering: false }) },
  { id: 'dw-fl-opener-flood-pump', message: "My dishwasher won't fill and the pump just keeps running", expect: opener('not-filling', 'water', { waterEntering: false, pumpRunsContinuously: true }),
    live: { accept: { journey: ['not-filling', 'leaking'] } } },
  { id: 'dw-fl-pending-base-water', message: "yes there's water underneath inside the tray", ctx: ctxOf('not-filling', { pending: { slot: 'OBSERVATION', target: 'waterInBase' } }),
    expect: { scope: 'appliance', observations: { waterInBase: true }, toPending: 'answered' } },
  { id: 'dw-fl-pending-aquastop', message: 'the little window on the hose box at the tap is red', ctx: ctxOf('not-filling', { pending: { slot: 'CHECK', target: 'inlet-hose-tap' } }),
    expect: { scope: 'appliance', checks: { 'inlet-hose-tap': ['done', 'fault_seen'] }, toPending: 'answered' } },
  // live round-1 regressions (polarity of terse replies to a pending observation)
  { id: 'dw-fl-live-no-door-warning', message: "No it doesn't say the door is open", ctx: ctxOf('not-filling', { observations: { waterEntering: false }, pending: { slot: 'OBSERVATION', target: 'doorRecognised' } }),
    expect: { scope: 'appliance', observations: { doorRecognised: true }, toPending: 'answered' } },
  { id: 'dw-dr-live-pump-silent', message: "It's silent, there's no sound at all", ctx: ctxOf('not-draining', { observations: { waterRemaining: true, commandedDrain: false }, pending: { slot: 'OBSERVATION', target: 'pumpHumming' } }),
    expect: { scope: 'appliance', observations: { pumpHumming: false }, toPending: 'answered' } },
  { id: 'dw-fl-pending-door-open', message: 'yes it keeps saying the door is open', ctx: ctxOf('not-filling', { pending: { slot: 'OBSERVATION', target: 'doorRecognised' } }),
    expect: { scope: 'appliance', observations: { doorRecognised: false }, toPending: 'answered' },
    live: { accept: { observations: [{ doorRecognised: false, doorLocks: false }, { doorRecognised: false, doorLocks: false, doorStartProblem: true }] } } },
];
const LK = [
  { id: 'dw-lk-opener-door', message: 'My dishwasher is leaking from the bottom of the door during the wash', expect: opener('leaking', 'water', { leakAtDoor: true, leaksOnWash: true }) },
  { id: 'dw-lk-opener-foam', message: 'Foam is pouring out of my dishwasher door, I think I used washing up liquid', expect: opener('leaking', 'water', { leakAtDoor: true, excessiveFoam: true, wrongDetergent: true }),
    live: { accept: { observations: [{ leakAtDoor: true, excessiveFoam: true, wrongDetergent: true, majorLeak: true }] } } },
  { id: 'dw-lk-opener-under', message: "There's a puddle under my dishwasher", expect: opener('leaking', 'water', { leakUnderneath: true }),
    live: { accept: { observations: [{ leakUnderneath: true, majorLeak: false }] } } },
  // live round-1 regressions
  { id: 'dw-lk-live-floor-not-base', message: "There's water under my dishwasher", expect: opener('leaking', 'water', { leakUnderneath: true }),
    live: { accept: { observations: [{ leakUnderneath: true, majorLeak: false }] } } },
  { id: 'dw-lk-live-pouring', message: 'My dishwasher is pouring water all over the kitchen floor', expect: opener('leaking', 'water', { majorLeak: true }),
    live: { accept: { observations: [{ majorLeak: true, leakUnderneath: true }] } } },
  { id: 'dw-lk-live-foam-door', message: 'Foam is coming out of my dishwasher door', expect: opener('leaking', 'water', { leakAtDoor: true, excessiveFoam: true }),
    live: { accept: { observations: [{ excessiveFoam: true }] } } },
  { id: 'dw-lk-live-drain-split', message: 'The drain hose has a split in it', ctx: ctxOf('leaking', { observations: { leakAtRear: true, leaksOnDrain: true }, pending: { slot: 'CHECK', target: 'drain-connection' } }),
    expect: { scope: 'appliance', checks: { 'drain-connection': ['done', 'fault_seen'] }, toPending: 'answered' },
    live: { accept: { checks: [{ 'drain-connection': ['done', 'fault_seen'], 'drain-hose': ['done', 'fault_seen'] }] } } },
  { id: 'dw-lk-pending-loose', message: 'the hose at the tap was a bit loose, tightened it', ctx: ctxOf('leaking', { pending: { slot: 'CHECK', target: 'inlet-connection' } }),
    expect: { scope: 'appliance', checks: { 'inlet-connection': ['done', 'found_and_cleared'] }, toPending: 'answered' } },
  { id: 'dw-lk-pending-seal', message: 'the rubber seal is split along the bottom', ctx: ctxOf('leaking', { observations: { leakAtDoor: true }, pending: { slot: 'CHECK', target: 'door-seal' } }),
    expect: { scope: 'appliance', checks: { 'door-seal': ['done', 'fault_seen'] }, toPending: 'answered' } },
];
const CL = [
  { id: 'dw-cl-opener-top', message: "My dishwasher isn't cleaning the top rack properly", expect: opener('poor-results', 'results', { poorUpperRack: true }) },
  { id: 'dw-cl-opener-all', message: 'Everything comes out of my dishwasher still dirty with food stuck on', expect: opener('poor-results', 'results', { poorAllRacks: true }) },
  { id: 'dw-cl-opener-tablet', message: 'The tablet is still sitting in the dishwasher drawer at the end and the dishes are dirty', expect: opener('poor-results', 'results', { tabletUndissolved: true }),
    live: { accept: { observations: [{ tabletUndissolved: true, poorAllRacks: true }] } } },
  { id: 'dw-cl-pending-arm-stuck', message: 'top one was stuck', ctx: ctxOf('poor-results', { observations: { poorUpperRack: true }, pending: { slot: 'CHECK', target: 'spray-arms' } }),
    expect: { scope: 'appliance', checks: { 'spray-arms': ['done', 'found_and_cleared'] }, toPending: 'answered' },
    live: { accept: { checks: [{ 'spray-arms': ['done', 'found_not_cleared'] }, { 'spray-arms': ['done', 'fault_seen'] }, { 'spray-arms': ['done', null] }] } } },
  { id: 'dw-cl-live-clean-now', message: 'Clean now', ctx: ctxOf('poor-results', { observations: { poorLowerRack: true }, checks: { 'loading-clearance': ['done', 'found_and_cleared'] }, pending: { slot: 'CHECK', target: 'retest' } }),
    expect: { scope: 'appliance', observations: { faultPersists: false }, checks: { retest: ['done', null] }, toPending: 'answered' },
    // the outcome observation alone fills the retest request (merge M20 marks the check done)
    live: { accept: { outcome: ['resolved'], toPending: ['ignored'], checks: [{}] } } },
  { id: 'dw-cl-pending-loading', message: 'a big tray was stopping the bottom arm, moved it', ctx: ctxOf('poor-results', { pending: { slot: 'CHECK', target: 'loading-clearance' } }),
    expect: { scope: 'appliance', checks: { 'loading-clearance': ['done', 'found_and_cleared'] }, toPending: 'answered' } },
];
const HT = [
  { id: 'dw-ht-opener-wet', message: "My dishwasher doesn't dry, the dishes are still wet at the end", expect: opener('not-drying', 'drying', { dishesWet: true }) },
  { id: 'dw-ht-opener-plastics', message: 'The plastic tubs come out of my dishwasher soaking but the plates are dry', expect: opener('not-drying', 'drying', { onlyPlasticsWet: true }),
    live: { accept: { journey: ['not-drying', null], faultDomain: ['drying', null], intent: [null, 'is_it_normal'] } } },
  { id: 'dw-ht-opener-cold', message: 'My dishwasher water stays cold and the dishes come out cold', expect: opener('no-heat', 'heat', { noHeat: true }) },
  { id: 'dw-ht-live-cold-intensive', message: 'My dishwasher water stays cold even on the intensive programme', expect: opener('no-heat', 'heat', { noHeat: true, hotProgrammeUsed: true }) },
  { id: 'dw-ht-pending-everything-wet', message: 'no, the glasses and plates are wet too', ctx: ctxOf('not-drying', { pending: { slot: 'OBSERVATION', target: 'onlyPlasticsWet' } }),
    expect: { scope: 'appliance', observations: { onlyPlasticsWet: false }, toPending: 'answered' } },
  { id: 'dw-ht-pending-rinse-aid', message: 'the rinse aid was completely empty, filled it up', ctx: ctxOf('not-drying', { pending: { slot: 'CHECK', target: 'rinse-aid' } }),
    expect: { scope: 'appliance', checks: { 'rinse-aid': ['done', 'found_and_cleared'] }, toPending: 'answered' } },
];
const DS = [
  { id: 'dw-ds-opener-door-open', message: "My dishwasher won't start, it says the door is open but it's shut", expect: opener('door-problem', 'door', { doorRecognised: false }),
    live: { accept: { journey: ['door-problem', 'wont-start'], faultDomain: ['door', 'power'] } } },
  { id: 'dw-ds-opener-dead', message: 'My dishwasher is completely dead, no lights at all', expect: opener('wont-start', 'power', { noPower: true }) },
  { id: 'dw-ds-opener-push', message: 'My dishwasher only starts if I push the door hard', expect: opener('door-problem', 'door', { startsWhenPushed: true }),
    live: { accept: { journey: ['door-problem', 'wont-start'] } } },
  { id: 'dw-ds-live-buttons', message: "My dishwasher buttons don't do anything, the lights are on and there's no door warning", expect: opener('controls-unresponsive', 'controls', { noPower: false, doorRecognised: true }),
    live: { accept: { journey: ['controls-unresponsive', 'wont-start'], faultDomain: ['controls', 'power'] } } },
  { id: 'dw-ds-pending-clicks', message: 'it clicks shut but still says open', ctx: ctxOf('door-problem', { pending: { slot: 'CHECK', target: 'door-start-test' } }),
    expect: { scope: 'appliance', observations: { doorRecognised: false }, checks: { 'door-start-test': ['done', null] }, toPending: 'answered' } },
  { id: 'dw-ds-pending-lights', message: 'yes the display lights up fine', ctx: ctxOf('wont-start', { pending: { slot: 'OBSERVATION', target: 'noPower' } }),
    expect: { scope: 'appliance', observations: { noPower: false }, toPending: 'answered' } },
];
// family bleed: a washing-machine "pump" message keeps washing-machine semantics (no dishwasher-only check)
const BLEED = [
  { id: 'dw-bleed-wm-pump-filter', message: 'I cleaned the pump filter, it was full of fluff', ctx: { appliance: ['washing-machine', 'stated'], journey: 'not-draining', pending: { slot: 'CHECK', target: 'drain-filter' } },
    expect: { scope: 'appliance', checks: { 'drain-filter': ['done', 'found_and_cleared'] }, toPending: 'answered' } },
];
const tag = (g, xs) => xs.map((x) => ({ group: g, ...x }));
const DWF = [...tag('dw-not-draining', DR), ...tag('dw-not-filling', FL), ...tag('dw-leaking', LK), ...tag('dw-not-cleaning', CL), ...tag('dw-heating-drying', HT),
  ...tag('dw-door-start', DS), ...tag('dw-bleed', BLEED)];
module.exports = { DWF };
