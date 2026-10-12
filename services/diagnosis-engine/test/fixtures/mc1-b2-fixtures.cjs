'use strict';
/**
 * Batch-2 washing-machine mc/1 fixtures (not filling, overfilling, door, vibration, noisy, not heating) — same format
 * as mc1-j3-fixtures.cjs. `live.accept` lists harmless extra leaves the live classifier may add.
 */
const WM = ['washing-machine', 'stated'];
const ctxOf = (journey, extra = {}) => ({ appliance: WM, journey, ...extra });
const opener = (journey, faultDomain, observations = {}, more = {}) => ({ scope: 'appliance', appliance: WM, intent: 'report_fault', faultDomain, journey, observations, ...more });

const NF = [
  { id: 'nf-opener-no-water', message: "My washing machine won't fill, no water is coming in at all", expect: opener('not-filling', 'water', { waterEntering: false }) },
  { id: 'nf-opener-slow', message: 'My washing machine fills really slowly, the water just trickles in', expect: opener('not-filling', 'water', { fillsSlowly: true }) },
  { id: 'nf-opener-supply-on', message: "My washing machine isn't taking any water and the water is definitely on, the kitchen tap is fine", expect: opener('not-filling', 'water', { waterEntering: false, supplyOk: true }) },
  { id: 'nf-opener-one-programme', message: 'My washing machine fills on the cotton wash but not on the quick wash', expect: opener('not-filling', 'water', {}, { symptomScope: 'one_programme' }),
    live: { accept: { observations: [{ waterEntering: true }] } } },
  { id: 'nf-pending-supply-low', message: 'all the taps are weak today actually', ctx: ctxOf('not-filling', { pending: { slot: 'OBSERVATION', target: 'supplyOk' } }),
    expect: { scope: 'appliance', observations: { supplyOk: false }, toPending: 'answered' } },
  { id: 'nf-pending-hose-kinked', message: 'the hose was squashed behind the machine, I have straightened it', ctx: ctxOf('not-filling', { pending: { slot: 'CHECK', target: 'inlet-hose-tap' } }),
    expect: { scope: 'appliance', checks: { 'inlet-hose-tap': ['done', 'found_and_cleared'] }, toPending: 'answered' } },
  { id: 'nf-pending-mesh-blocked', message: 'the little filter was full of grit, cleaned it', ctx: ctxOf('not-filling', { pending: { slot: 'CHECK', target: 'inlet-filter' } }),
    expect: { scope: 'appliance', checks: { 'inlet-filter': ['done', 'found_and_cleared'] }, toPending: 'answered' } },
  { id: 'nf-pending-retest-fills', message: 'yes it fills normally now', ctx: ctxOf('not-filling', { checks: { 'inlet-filter': ['done', 'found_and_cleared'] }, pending: { slot: 'CHECK', target: 'retest' } }),
    expect: { scope: 'appliance', observations: { faultPersists: false }, checks: { retest: ['done', null] }, toPending: 'answered' },
    live: { accept: { observations: [{ faultPersists: false, waterEntering: true }, { waterEntering: true }], outcome: ['resolved'] } } },
];
const OF = [
  { id: 'of-opener-keeps-filling', message: 'My washing machine keeps filling with water and won\'t stop', expect: opener('overfilling', 'water') },
  { id: 'of-opener-when-off', message: 'My washing machine fills with water even when it is switched off', expect: opener('overfilling', 'water', { fillsWhenOff: true }) },
  { id: 'of-opener-level-high', message: 'The water level in my washing machine is way too high, it is above the door glass', expect: opener('overfilling', 'water', { waterLevelHigh: true }) },
  // J3 regression found in the batch-2 J3 live sanity run: a drawer overflowing onto the floor is a leak
  { id: 'of-live-drawer-overflow-is-leaking', message: 'Water is overflowing out of the detergent drawer on my washing machine',
    expect: opener('leaking', 'water', { leakAtDrawer: true, drawerOverflowing: true }) },
  { id: 'of-pending-off-stops', message: 'no, it stops as soon as I turn it off', ctx: ctxOf('overfilling', { pending: { slot: 'OBSERVATION', target: 'fillsWhenOff' } }),
    expect: { scope: 'appliance', observations: { fillsWhenOff: false }, toPending: 'answered' } },
  { id: 'of-pending-dirty', message: "it's grey and smells like the drain", ctx: ctxOf('overfilling', { observations: { fillsWhenOff: true }, pending: { slot: 'OBSERVATION', target: 'waterIsDirty' } }),
    expect: { scope: 'appliance', observations: { waterIsDirty: true }, toPending: 'answered' } },
  { id: 'of-pending-level-normal', message: "the level looks normal, it just keeps taking water", ctx: ctxOf('overfilling', { pending: { slot: 'OBSERVATION', target: 'waterLevelHigh' } }),
    expect: { scope: 'appliance', observations: { waterLevelHigh: false }, toPending: 'answered' } },
  { id: 'of-pending-hose-low', message: 'the drain hose was pushed right down the standpipe, I have pulled it up and hooked it higher', ctx: ctxOf('overfilling', { pending: { slot: 'CHECK', target: 'drain-hose-height' } }),
    expect: { scope: 'appliance', checks: { 'drain-hose-height': ['done', 'found_and_cleared'] }, toPending: 'answered' } },
];
const DR = [
  { id: 'dr-opener-wont-open', message: "My washing machine door won't open after the wash", expect: opener('door-problem', 'door', { doorOpens: false }) },
  { id: 'dr-opener-no-lock', message: "My washing machine door won't lock so the programme won't start", expect: opener('door-problem', 'door', { doorLocks: false }) },
  { id: 'dr-opener-handle', message: 'The door handle on my washing machine has snapped off', expect: opener('door-problem', 'door', { handleBroken: true }) },
  { id: 'dr-opener-wont-close', message: "My washing machine door won't close, it just springs back open", expect: opener('door-problem', 'door', { doorCloses: false }) },
  { id: 'dr-opener-clicking', message: 'My washing machine door lock keeps clicking on and off and it never starts', expect: opener('door-problem', 'door', { lockClicking: true }),
    live: { accept: { observations: [{ lockClicking: true, doorLocks: false }, { doorLocks: false }] } } },
  // live round-1 regressions
  { id: 'dr-live-says-door-open', message: 'My washing machine says door open but the door is shut', expect: opener('door-problem', 'door', { doorLocks: false }),
    live: { accept: { observations: [{ doorLocks: false, doorStartProblem: true }] } } },
  { id: 'dr-pending-no-water', message: "no, the drum's empty", ctx: ctxOf('door-problem', { observations: { doorOpens: false }, pending: { slot: 'OBSERVATION', target: 'waterRemaining' } }),
    expect: { scope: 'appliance', observations: { waterRemaining: false }, toPending: 'answered' } },
  { id: 'dr-pending-opened', message: 'yes it opened after about five minutes', ctx: ctxOf('door-problem', { observations: { doorOpens: false }, pending: { slot: 'CHECK', target: 'door-release-wait' } }),
    expect: { scope: 'appliance', observations: { doorOpens: true }, checks: { 'door-release-wait': ['done', null] }, toPending: 'answered' },
    live: { accept: { outcome: ['resolved'] } } },
  { id: 'dr-pending-child-lock', message: 'the key symbol was on, I held the buttons and it went off', ctx: ctxOf('door-problem', { pending: { slot: 'CHECK', target: 'child-lock' } }),
    expect: { scope: 'appliance', checks: { 'child-lock': ['done', 'found_and_cleared'] }, toPending: 'answered' } },
];
const VB = [
  { id: 'vb-opener-violent', message: 'My washing machine shakes violently and walks across the floor on the spin', expect: opener('vibration', 'motion', { excessiveVibration: true }),
    live: { accept: { observations: [{ excessiveVibration: true, noiseOnSpin: true }] } } },
  { id: 'vb-opener-new', message: 'My new washing machine bounces around like mad when it spins', expect: opener('vibration', 'motion', { excessiveVibration: true, recentInstallation: true }) },
  { id: 'vb-opener-towels', message: 'My washing machine only shakes badly when I wash towels', expect: opener('vibration', 'motion', { excessiveVibration: true, loadDependent: true }) },
  // live round-1 regressions
  { id: 'vb-live-not-new', message: "My washing machine shakes violently on the spin, it's not new and hasn't been moved", expect: opener('vibration', 'motion', { excessiveVibration: true, recentInstallation: false }),
    live: { accept: { observations: [{ excessiveVibration: true, recentInstallation: false, noiseOnSpin: true }] } } },
  { id: 'vb-live-damper-reported', message: 'My washing machine shakes badly on the spin and an engineer said a shock absorber is broken',
    expect: { ...opener('vibration', 'motion', { excessiveVibration: true }), checks: { 'shock-absorbers': ['done', 'fault_seen'] } } },
  { id: 'vb-live-empty-smooth-not-resolved', message: "It's smooth when it's empty", ctx: ctxOf('vibration', { pending: { slot: 'CHECK', target: 'empty-vibration-test' } }),
    expect: { scope: 'appliance', observations: { shakesWhenEmpty: false }, checks: { 'empty-vibration-test': ['done', null] }, toPending: 'answered' },
    live: { accept: { observations: [{ shakesWhenEmpty: false, spinsEmpty: true }] } } },
  { id: 'vb-pending-bolts', message: 'yes the bolts were still in the back, I have taken them out', ctx: ctxOf('vibration', { pending: { slot: 'CHECK', target: 'transit-bolts' } }),
    expect: { scope: 'appliance', checks: { 'transit-bolts': ['done', 'found_and_cleared'] }, toPending: 'answered' } },
  { id: 'vb-pending-level', message: 'it rocked on one corner, I have screwed the foot down and locked it', ctx: ctxOf('vibration', { pending: { slot: 'CHECK', target: 'levelling' } }),
    expect: { scope: 'appliance', checks: { levelling: ['done', 'found_and_cleared'] }, toPending: 'answered' } },
  { id: 'vb-pending-empty-shakes', message: 'it still shakes like crazy even with nothing in it', ctx: ctxOf('vibration', { pending: { slot: 'CHECK', target: 'empty-vibration-test' } }),
    expect: { scope: 'appliance', observations: { shakesWhenEmpty: true }, checks: { 'empty-vibration-test': ['done', null] }, toPending: 'answered' },
    live: { accept: { observations: [{ shakesWhenEmpty: true, excessiveVibration: true }] } } },
  { id: 'vb-pending-drum-loose', message: 'the drum clunks and drops quite a bit when I push it', ctx: ctxOf('vibration', { pending: { slot: 'CHECK', target: 'drum-play' } }),
    expect: { scope: 'appliance', observations: { drumPlay: true }, checks: { 'drum-play': ['done', null] }, toPending: 'answered' } },
];
const NS = [
  { id: 'ns-opener-grinding-spin', message: 'My washing machine makes a loud grinding rumble when it spins', expect: opener('noisy', 'noise', { grindingNoise: true, noiseOnSpin: true }) },
  { id: 'ns-opener-drain-rattle', message: 'My washing machine rattles when it drains', expect: opener('noisy', 'noise', { rattlingNoise: true, noiseOnDrain: true }) },
  { id: 'ns-opener-scraping', message: 'There is a metallic scraping noise from my washing machine when the drum turns', expect: opener('noisy', 'noise', { scrapingNoise: true }),
    live: { accept: { observations: [{ scrapingNoise: true, noiseOnWash: true }] } } },
  { id: 'ns-opener-squeal', message: 'My washing machine squeals on the spin', expect: opener('noisy', 'noise', { squealNoise: true, noiseOnSpin: true }) },
  // live round-1 regression
  { id: 'ns-live-drum-clunk-not-noise', message: 'The drum is loose, it clunks when I push it', ctx: ctxOf('noisy', { observations: { grindingNoise: true, noiseOnSpin: true }, pending: { slot: 'CHECK', target: 'drum-play' } }),
    expect: { scope: 'appliance', observations: { drumPlay: true }, checks: { 'drum-play': ['done', null] }, toPending: 'answered' } },
  { id: 'ns-pending-timing-fill', message: 'only while it fills', ctx: ctxOf('noisy', { pending: { slot: 'OBSERVATION', target: 'noiseTiming' } }),
    expect: { scope: 'appliance', observations: { noiseOnFill: true }, toPending: 'answered' } },
  { id: 'ns-pending-type-knock', message: 'a loud banging', ctx: ctxOf('noisy', { pending: { slot: 'OBSERVATION', target: 'noiseType' } }),
    expect: { scope: 'appliance', observations: { knockingNoise: true }, toPending: 'answered' } },
  { id: 'ns-pending-coin', message: 'found a coin stuck in the filter and took it out', ctx: ctxOf('noisy', { observations: { noiseOnDrain: true }, pending: { slot: 'CHECK', target: 'drain-filter' } }),
    expect: { scope: 'appliance', checks: { 'drain-filter': ['done', 'found_and_cleared'] }, toPending: 'answered' } },
  { id: 'ns-pending-bra-wire-stuck', message: "I can see a bra wire sticking through a drum hole but I can't get it out", ctx: ctxOf('noisy', { pending: { slot: 'CHECK', target: 'drum-foreign-object' } }),
    expect: { scope: 'appliance', checks: { 'drum-foreign-object': ['done', 'found_not_cleared'] }, toPending: 'answered' } },
];
const HT = [
  { id: 'ht-opener-cold', message: 'My washing machine washes cold, the water never gets warm', expect: opener('no-heat', 'heat', { noHeat: true }) },
  { id: 'ht-opener-hot-prog', message: 'My washing machine is not heating, even on a 60 degree cotton wash the clothes come out cold', expect: opener('no-heat', 'heat', { noHeat: true, hotProgrammeUsed: true }) },
  { id: 'ht-opener-long', message: "My washing machine doesn't heat up and the cycle takes forever", expect: opener('no-heat', 'heat', { noHeat: true, longCycle: true }) },
  { id: 'ht-opener-trips', message: 'My washing machine trips the electrics when it starts heating', expect: { scope: 'appliance', appliance: WM, intent: 'report_fault', hazard: 'supply_trip' },
    live: { accept: { journey: ['no-heat', 'trips-electrics'], faultDomain: ['heat', 'power'] } } },
  { id: 'ht-pending-eco', message: 'I always use the eco 40 setting', ctx: ctxOf('no-heat', { observations: { noHeat: true }, pending: { slot: 'OBSERVATION', target: 'hotProgrammeUsed' } }),
    expect: { scope: 'appliance', observations: { hotProgrammeUsed: false }, toPending: 'answered' } },
  { id: 'ht-pending-test-warm', message: 'the clothes were warm when I took them out', ctx: ctxOf('no-heat', { observations: { noHeat: true }, pending: { slot: 'CHECK', target: 'hot-wash-test' } }),
    expect: { scope: 'appliance', observations: { noHeat: false }, checks: { 'hot-wash-test': ['done', null] }, toPending: 'answered' },
    live: { accept: { observations: [{ noHeat: false, heatPresent: true }, { heatPresent: true }] } } },
  { id: 'ht-pending-test-cold', message: 'still stone cold', ctx: ctxOf('no-heat', { observations: { noHeat: true }, pending: { slot: 'CHECK', target: 'hot-wash-test' } }),
    expect: { scope: 'appliance', observations: { noHeat: true }, checks: { 'hot-wash-test': ['done', null] }, toPending: 'answered' } },
];
const tag = (g, xs) => xs.map((x) => ({ group: g, ...x }));
const B2 = [...tag('b2-not-filling', NF), ...tag('b2-overfilling', OF), ...tag('b2-door', DR), ...tag('b2-vibration', VB), ...tag('b2-noisy', NS), ...tag('b2-not-heating', HT)];
module.exports = { B2 };
