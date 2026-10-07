'use strict';
/**
 * Journey 5 policy — washing machine · overfilling. PURE, deterministic (shared step policy). Rules O1–O22.
 * Containment first: the turn the overfill (or a large leak) is first reported → water off at the tap, power off only
 * if dry (O1 `uncontrolled-fill`). Then: does water still enter with the machine OFF? (ask; else a one-minute
 * supervised power-off test, tap off straight after) → clean/dirty → level high vs normal → drain-hose installation.
 * Never asks the customer to leave an uncontrolled fill running.
 */
const kit = require('./policy-kit.js');

function containment(s) {
  const p = (s.problems || []).filter((x) => x.status === 'active' && x.journey && x.journey.value === 'overfilling').pop();
  const ml = s.evidence && s.evidence.observations && s.evidence.observations.majorLeak;
  const firstReportNow = Boolean(p && p.journey.turn === s.version);
  const majorNow = Boolean(ml && ml.value === true && ml.turn === s.version);
  if (!firstReportNow && !majorNow) return null;
  // The fixed copy ends by asking the next discriminator, so the stop also issues that typed request (anchors the reply).
  // Fixed copy variant by what is already known: ask off-vs-running, ask clean-vs-dirty, or no question.
  const o = (k) => { const f = s.evidence && s.evidence.observations && s.evidence.observations[k]; return f && f.value != null ? f.value : null; };
  const req = ['water_off_at_tap', 'power_off_only_if_dry', 'keep_clear_of_socket_if_water_near'];
  const base = { reason: 'water-entering-uncontrolled', requires: req };
  if (o('fillsWhenOff') == null) return { ...base, target: 'uncontrolled-fill', pending: { slot: 'OBSERVATION', target: 'fillsWhenOff', purpose: 'DIAGNOSIS' } };
  if (o('fillsWhenOff') === true && o('waterIsDirty') == null) return { ...base, target: 'uncontrolled-fill-off', pending: { slot: 'OBSERVATION', target: 'waterIsDirty', purpose: 'DIAGNOSIS' } };
  return { ...base, target: 'uncontrolled-fill-known', pending: null };
}

const P = kit.makeStepPolicy({
  JOURNEY: 'wm-overfilling', P: 'O', journeys: ['overfilling'], codeFaults: [], drainOwned: false,
  CHECKS: ['power-off-fill-test', 'drain-hose-height'],
  OBS_TARGETS: { fillsWhenOff: ['fillsWhenOff'], waterIsDirty: ['waterIsDirty'], waterLevelHigh: ['waterLevelHigh'] },
  outcomeObs: { 'power-off-fill-test': 'fillsWhenOff' },
  REQUIRES: {
    'power-off-fill-test': ['power_off_only_if_dry', 'watch_briefly_only', 'water_off_after_test'],
    'drain-hose-height': ['isolate_mains', 'water_off_at_tap', 'machine_heavy_may_hold_water'],
    retest: ['stay_nearby_tap_ready'],
  },
  FIX_CHECKS: ['drain-hose-height'],
  containment,
  steps: [
    { n: 10, target: 'fillsWhenOff', reason: 'off-vs-running-split', when: (h) => !h.has('whenOff') && !h.has('stopsWhenOff') },
    { n: 11, target: 'power-off-fill-test', reason: 'supervised-off-test', when: (h) => !h.has('whenOff') && !h.has('stopsWhenOff') },
    { n: 12, target: 'waterIsDirty', reason: 'clean-valve-vs-dirty-waste', when: (h) => h.has('whenOff') },
    { n: 13, target: 'waterLevelHigh', reason: 'high-level-vs-siphon', when: (h) => !h.has('whenOff') && !h.has('foam') },
    { n: 14, target: 'drain-hose-height', reason: 'siphon-or-back-siphon-install', when: (h) => h.has('levelNormal') || h.has('dirty') },
  ],
  PART_FAMILIES: new Set(['IV']),
  HANDOFF: { IV: 'engineer', SI: 'install', WB: 'plumbing', FL: 'none', LS: 'engineer' },
});
module.exports = P;
