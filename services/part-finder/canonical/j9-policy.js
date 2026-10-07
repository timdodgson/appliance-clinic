'use strict';
/**
 * Journey 9 policy — washing machine · not heating. PURE, deterministic (shared step policy). Rules H1–H22.
 * Safety first (a trip / burning during heating is a sticky-kit stop). Then: which programme? (eco / quick / cold is
 * normal) → a supervised 60°C cottons test if it wasn't a hot programme → long cycle? → conclusion. The heater is a
 * part only with a heater-specific code + model; NTC / control → engineer. No live electrical testing, ever.
 */
const kit = require('./policy-kit.js');

const P = kit.makeStepPolicy({
  JOURNEY: 'wm-not-heating', P: 'H', journeys: ['no-heat'], codeFaults: ['heater', 'temperature-sensor'], drainOwned: false,
  CHECKS: ['hot-wash-test', 'programme-setting'],
  OBS_TARGETS: { hotProgrammeUsed: ['hotProgrammeUsed'], longCycle: ['longCycle'] },
  outcomeObs: { 'hot-wash-test': 'noHeat' },
  REQUIRES: {
    'hot-wash-test': ['stop_if_trips_or_burning', 'hot_glass_wait_unlock'],
    retest: ['stop_if_trips_or_burning'],
  },
  FIX_CHECKS: ['programme-setting'],
  steps: [
    { n: 10, target: 'hotProgrammeUsed', reason: 'programme-decides-expected-heat', when: (h) => !h.has('coldOnHot') && !h.has('warmOnHotTest') },
    { n: 11, target: 'hot-wash-test', reason: 'supervised-60c-test', when: (h) => !h.has('coldOnHot') && !h.has('warmOnHotTest') },
    { n: 12, target: 'longCycle', reason: 'long-cycle-supports-heating-fault', when: (h) => h.has('coldOnHot') },
  ],
  PART_FAMILIES: new Set(['HE']),
  HANDOFF: { NB: 'none', PG: 'none', HE: 'engineer', TS: 'engineer', PL: 'engineer', CT: 'engineer' },
});
module.exports = P;
