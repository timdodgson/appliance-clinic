'use strict';
/**
 * Journey 7 policy — washing machine · excessive vibration. PURE, deterministic (shared step policy). Rules V1–V22.
 * Order: recently installed? → transit bolts → load → levelling / floor → empty spin test → drum play (machine off).
 * Generic vibration never reaches a suspension part (only a shock absorber actually seen broken is decisive).
 */
const kit = require('./policy-kit.js');

const P = kit.makeStepPolicy({
  JOURNEY: 'wm-excessive-vibration', P: 'V', journeys: ['vibration'], codeFaults: [], drainOwned: false,
  CHECKS: ['transit-bolts', 'load-check', 'levelling', 'empty-vibration-test', 'drum-play', 'shock-absorbers'],
  OBS_TARGETS: { recentInstallation: ['recentInstallation'] },
  outcomeObs: { 'empty-vibration-test': 'shakesWhenEmpty', 'drum-play': 'drumPlay' },
  REQUIRES: {
    'transit-bolts': ['isolate_mains', 'machine_heavy_may_hold_water'],
    'load-check': ['pause_wait_door_unlock'],
    levelling: ['isolate_mains', 'machine_heavy_may_hold_water'],
    'empty-vibration-test': ['stop_if_violent_shaking', 'stand_clear_while_spinning'],
    'drum-play': ['isolate_mains', 'wait_drum_stopped_door_unlocked'],
    retest: ['stop_if_violent_shaking'],
  },
  FIX_CHECKS: ['transit-bolts', 'levelling', 'load-check'],
  steps: [
    { n: 10, target: 'recentInstallation', reason: 'new-or-moved-machine-first', when: (h) => !h.has('boltsOut') && !h.has('boltsRemoved') },
    { n: 11, target: 'transit-bolts', reason: 'transit-bolts-after-install', when: (h) => h.has('recentInstall') },
    { n: 12, target: 'load-check', reason: 'load-before-machine', when: (h) => !h.has('emptyShakes') },
    { n: 13, target: 'levelling', reason: 'level-and-floor-before-suspension', when: () => true },
    { n: 14, target: 'empty-vibration-test', reason: 'empty-spin-separates-load', when: (h) => !h.has('emptyShakes') && !h.has('emptySmooth') && !h.has('loadIssue') },
    { n: 15, target: 'drum-play', reason: 'drum-play-separates-suspension', when: (h) => h.has('emptyShakes') || h.has('loadNormal') },
  ],
  PART_FAMILIES: new Set(['SU']),
  HANDOFF: { TR: 'install', LV: 'install', LD: 'none', SU: 'engineer', BR: 'engineer' },
});
module.exports = P;
