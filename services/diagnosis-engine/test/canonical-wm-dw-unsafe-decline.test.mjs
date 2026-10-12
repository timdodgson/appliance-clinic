/**
 * ADR 0018 canonical coverage: the washing-machine and dishwasher journeys decline an unsafe request (bypass an interlock,
 * test live, open it while powered, keep resetting a trip) with the fixed copy and no part, as every other family does;
 * the next turn carries on with the journey. Replayed through the REAL merge + journey pipeline and COMPOSE templates.
 */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const H = require('./helpers/b2-journey.cjs');
const L = require('../handler.js')._internal;
const ck = require('../canonical/compose-kit.js');
const { C } = H;

const PACK = (k) => L.CANONICAL_JOURNEY_PACKS[k];
const J = (k) => require(PACK(k).pipeline.replace('./canonical/', '../canonical/'));
const JC = (k) => require(PACK(k).compose.replace('./canonical/', '../canonical/'));
const WM = { 'wm-not-draining': 'not-draining', 'wm-not-spinning': 'not-spinning', 'wm-leaking': 'leaking', 'wm-not-filling': 'not-filling',
  'wm-overfilling': 'overfilling', 'wm-door': 'door-problem', 'wm-excessive-vibration': 'vibration', 'wm-noisy': 'noisy', 'wm-not-heating': 'no-heat' };
const DW = { 'dw-not-draining': 'not-draining', 'dw-not-filling': 'not-filling', 'dw-leaking': 'leaking', 'dw-not-cleaning': 'poor-results',
  'dw-not-heating-drying': 'no-heat', 'dw-door-not-starting': 'door-problem' };
const opener = (k) => (WM[k] ? H.opener(WM[k], null) : H.dwOpener(DW[k], null));
const unsafe = (action) => C({ safety: { unsafeAction: action } });

describe('every washing-machine and dishwasher journey declines an unsafe request', () => {
  for (const k of [...Object.keys(WM), ...Object.keys(DW)]) {
    it(`${k}: bypassing the door lock -> the fixed decline, no part; the next turn carries on`, () => {
      const r = H.play(J(k), [opener(k), unsafe('bypass_safety_device'), C({})]);
      const declined = r.actions[1];
      expect(declined.action).toMatchObject({ kind: 'conclude', target: 'unsafe-request-declined',
        conclusion: { unsafeAction: 'bypass_safety_device', noPart: true, handoff: 'engineer' } });
      const t = JC(k).template(JC(k).brief(declined.state, declined.action, null, {}));
      expect(t).toContain(ck.UNSAFE_DECLINE.bypass_safety_device);
      expect(H.composeProblems(JC(k), null, [declined])).toEqual([]);
      expect(r.last.target).not.toBe('unsafe-request-declined');       // only on the turn it was asked
    });
  }
  it('live testing and opening it while powered are declined too', () => {
    for (const a of ['live_electrical_test', 'open_while_powered', 'repeated_reset_after_trip']) {
      const r = H.play(J('wm-not-draining'), [opener('wm-not-draining'), unsafe(a)]);
      expect(r.last).toMatchObject({ target: 'unsafe-request-declined', conclusion: { unsafeAction: a } });
    }
  });
});
