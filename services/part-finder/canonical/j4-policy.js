'use strict';
/**
 * Journey 4 policy — washing machine · not filling. PURE, deterministic (shared step policy, policy-kit).
 * Design: docs/diagnostics/wm-batch-2-evidence.md §1. Rules F1–F22.
 * Order: supply → door lock (no water at all) → tap / fill hose → inlet mesh → retest; household supply → plumbing.
 * The inlet valve is never recommended merely because no water enters (only "some programmes fill" is decisive).
 */
const kit = require('./policy-kit.js');

const P = kit.makeStepPolicy({
  JOURNEY: 'wm-not-filling', P: 'F', journeys: ['not-filling'], codeFaults: ['inlet-valve', 'flow-meter'], drainOwned: false,
  CHECKS: ['inlet-hose-tap', 'inlet-filter', 'door-closed-latched'],
  OBS_TARGETS: { fillState: ['waterEntering', 'fillsSlowly'], supplyOk: ['supplyOk'], doorLocks: ['doorLocks'] },
  outcomeObs: { 'door-closed-latched': 'doorLocks' },
  REQUIRES: {
    'inlet-hose-tap': ['tap_hose_from_outside'],
    'inlet-filter': ['isolate_mains', 'water_off_at_tap', 'contain_water', 'mesh_rinse_only'],
    'door-closed-latched': ['do_not_force_door', 'never_bypass_interlock'],
    retest: [],
  },
  FIX_CHECKS: ['inlet-hose-tap', 'inlet-filter'],
  early(h) {
    if (h.has('supplyBad')) return { target: 'household-supply', reason: 'household-supply-off-or-low', rule: 'F5', handoff: 'plumbing' };
    return null;
  },
  steps: [
    { n: 10, target: 'fillState', reason: 'none-vs-slow-decides-path', when: (h) => !h.has('noWater') && !h.has('slow') && !h.has('oneProgramme') },
    { n: 11, target: 'supplyOk', reason: 'household-supply-first', when: (h) => !h.has('oneProgramme') },
    { n: 12, target: 'doorLocks', reason: 'no-fill-until-door-locks', when: (h) => h.has('noWater') && !h.has('slow') && !h.has('oneProgramme') },
    { n: 13, target: 'door-closed-latched', reason: 'door-not-locking-close-firmly', when: (h) => h.has('doorNoLock') },
    { n: 14, target: 'inlet-hose-tap', reason: 'tap-and-hose-before-machine', when: (h) => !h.has('oneProgramme') && !h.has('doorNoLockChecked') },
    { n: 15, target: 'inlet-filter', reason: 'inlet-mesh-before-valve', when: (h) => !h.has('oneProgramme') && !h.has('doorNoLockChecked') && !h.has('fillHoseDamaged') },
  ],
  PART_FAMILIES: new Set(['TH', 'DI', 'IV']),
  HANDOFF: { SU: 'plumbing', TH: 'plumbing', MF: 'none', DI: 'engineer', IV: 'engineer', PC: 'engineer' },
});
module.exports = P;
