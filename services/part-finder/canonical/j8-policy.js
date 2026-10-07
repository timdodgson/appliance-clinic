'use strict';
/**
 * Journey 8 policy — washing machine · noisy. PURE, deterministic (shared step policy). Rules N1–N22.
 * WHEN → TYPE → the matching safe owner check: drain noise → pump filter → impeller (Journey 1 checks);
 * scrape / rattle / click in the drum → foreign object; knock / bang on spin → installed / transit bolts / load;
 * grind / rumble → drum by hand → drum play. Retained water → Journey 1 (drainOwned).
 */
const kit = require('./policy-kit.js');

const TIMING = ['onFill', 'onWash', 'onDrain', 'onSpin', 'always'];
const TYPES = ['grind', 'hum', 'scrape', 'knock', 'rattle', 'squeal', 'click'];
const P = kit.makeStepPolicy({
  JOURNEY: 'wm-noisy', P: 'N', journeys: ['noisy'], codeFaults: [], drainOwned: true,
  CHECKS: ['drain-filter', 'pump-impeller', 'drum-foreign-object', 'transit-bolts', 'load-check', 'drum-by-hand', 'drum-play', 'drive-belt'],
  OBS_TARGETS: {
    noiseTiming: ['noiseOnFill', 'noiseOnWash', 'noiseOnDrain', 'noiseOnSpin', 'noiseThroughout'],
    noiseType: ['grindingNoise', 'humNoise', 'scrapingNoise', 'knockingNoise', 'rattlingNoise', 'squealNoise', 'clickingNoise'],
    recentInstallation: ['recentInstallation'],
  },
  outcomeObs: { 'drum-play': 'drumPlay' },
  REQUIRES: {
    'drain-filter': ['isolate_mains', 'let_hot_water_cool', 'contain_water', 'open_slowly', 'do_not_force'],
    'pump-impeller': ['isolate_mains', 'filter_already_removed', 'no_tools_beyond_housing', 'no_panel_removal'],
    'drum-foreign-object': ['isolate_mains', 'wait_drum_stopped_door_unlocked', 'torch_and_fingers_only'],
    'transit-bolts': ['isolate_mains', 'machine_heavy_may_hold_water'],
    'load-check': ['pause_wait_door_unlock'],
    'drum-by-hand': ['isolate_mains', 'wait_drum_stopped_door_unlocked', 'turn_by_hand_only', 'no_panel_removal'],
    'drum-play': ['isolate_mains', 'wait_drum_stopped_door_unlocked'],
    retest: [],
  },
  FIX_CHECKS: ['drain-filter', 'pump-impeller', 'drum-foreign-object', 'load-check', 'transit-bolts'],
  // an object they could NOT remove is not an owner fix (no retest; engineer)
  fixResults: { 'drum-foreign-object': ['found_and_cleared'], 'pump-impeller': ['found_and_cleared'] },
  steps: [
    { n: 10, target: 'noiseTiming', reason: 'when-decides-area', when: (h) => !TIMING.some(h.has) },
    { n: 11, target: 'noiseType', reason: 'type-decides-cause', when: (h) => !TYPES.some(h.has) },
    { n: 12, target: 'drain-filter', reason: 'drain-noise-pump-filter-first', when: (h) => h.has('onDrain') && !h.has('fillHum') },
    { n: 13, target: 'pump-impeller', reason: 'impeller-after-filter', when: (h) => h.has('onDrain') && h.has('filterClear') },
    { n: 14, target: 'drum-foreign-object', reason: 'object-in-drum', when: (h) => (h.has('scrape') || h.has('rattle') || (h.has('click') && !h.has('onFill')) || h.has('onWash')) && !h.has('onDrain') },
    { n: 15, target: 'recentInstallation', reason: 'new-or-moved-machine', when: (h) => h.has('knock') },
    { n: 16, target: 'transit-bolts', reason: 'transit-bolts-bang', when: (h) => h.has('knock') && h.has('recentInstall') },
    { n: 17, target: 'load-check', reason: 'load-knock-on-spin', when: (h) => h.has('knock') || h.has('loadIssue') },
    { n: 18, target: 'drum-by-hand', reason: 'hand-rotation-separates-bearing', when: (h) => (h.has('grind') || h.has('always') || (h.has('onSpin') && !h.has('knock'))) && !h.has('onDrain') && !h.has('objectStuck') },
    { n: 19, target: 'drum-play', reason: 'drum-play-separates-support', when: (h) => (h.has('grind') || h.has('knock')) && !h.has('onDrain') && !h.has('objectStuck') },
  ],
  PART_FAMILIES: new Set(['PW', 'BT']),
  HANDOFF: { NO: 'none', PO: 'none', FO: 'engineer', SL: 'none', PW: 'engineer', BT: 'engineer', BE: 'engineer' },
  partExtra: (s, d, comp) => (comp === 'drive-belt' && d.architecture && d.architecture.drive === 'direct' ? ['K7-architecture-impossible'] : []),
});
module.exports = P;
