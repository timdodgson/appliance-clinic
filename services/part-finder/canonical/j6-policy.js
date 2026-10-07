'use strict';
/**
 * Journey 6 policy — washing machine · door. PURE, deterministic (shared step policy). Rules D1–D22.
 * Won't open: water in the drum? (yes → Journey 1 owns it: drainOwned) → wait / power-off release → child lock.
 * Won't lock / says door open / clicking: close firmly → catch / alignment. Won't close: catch / alignment.
 * Never: bypassing or forcing the interlock (fixed safety copy on every door step).
 */
const kit = require('./policy-kit.js');

const DOOR = ['wontOpen', 'noLock', 'wontClose', 'handleBroken', 'clicking'];
const P = kit.makeStepPolicy({
  JOURNEY: 'wm-door', P: 'D', journeys: ['door-problem'], codeFaults: ['door-lock'], drainOwned: true,
  CHECKS: ['door-release-wait', 'child-lock', 'door-closed-latched', 'door-catch'],
  OBS_TARGETS: { doorSymptom: ['doorOpens', 'doorLocks', 'doorCloses', 'handleBroken', 'lockClicking'], waterRemaining: ['waterRemaining'] },
  outcomeObs: { 'door-release-wait': 'doorOpens', 'door-closed-latched': 'doorLocks' },
  REQUIRES: {
    'door-release-wait': ['never_bypass_interlock', 'do_not_force_door'],
    'child-lock': [],
    'door-closed-latched': ['do_not_force_door', 'never_bypass_interlock'],
    'door-catch': ['isolate_mains', 'look_only_no_tools'],
    retest: [],
  },
  FIX_CHECKS: ['child-lock', 'door-catch'],
  early(h) {
    if (h.has('opensAfterWait') && !h.has('handleBroken') && !h.has('wontClose')) return { target: 'normal-release-delay', reason: 'lock-released-after-delay', rule: 'D5', handoff: 'none' };
    return null;
  },
  steps: [
    { n: 10, target: 'doorSymptom', reason: 'which-door-fault', when: (h) => !DOOR.some(h.has) },
    { n: 11, target: 'waterRemaining', reason: 'retained-water-keeps-door-locked', when: (h) => h.has('wontOpen') && !h.has('handleBroken') },
    { n: 12, target: 'door-release-wait', reason: 'normal-release-delay-first', when: (h) => h.has('wontOpen') && !h.has('handleBroken') },
    { n: 13, target: 'child-lock', reason: 'child-lock-holds-door', when: (h) => h.has('wontOpen') && !h.has('handleBroken') },
    { n: 14, target: 'door-closed-latched', reason: 'close-firmly-before-lock', when: (h) => h.has('noLock') || h.has('clicking') },
    { n: 15, target: 'door-catch', reason: 'catch-and-alignment', when: (h) => h.has('wontClose') || h.has('clicking') || h.has('noLockChecked') },
  ],
  PART_FAMILIES: new Set(['CH', 'DL']),
  HANDOFF: { DY: 'none', CL: 'none', CH: 'engineer', DL: 'engineer', PS: 'engineer' },
});
module.exports = P;
