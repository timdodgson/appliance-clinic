/**
 * GOLD G2-WD-04 (critical: invented detail). mc/1 types "the container is full", "it is overflowing" and "the tank-full
 * warning is on" as one observation (tankWarning). The fixed fact copy COMPOSE is given must therefore say only what all
 * of those share, that the container is full, and never assert a warning the customer may not have mentioned.
 */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
globalThis.awslambda = globalThis.awslambda || { streamifyResponse: (f) => f, HttpResponseStream: { from: (s) => s } };
const H = require('./helpers/b2-journey.cjs');
const L = require('../part-finder-lambda.js')._internal;
const { C, O } = H;
const PACK = (k) => L.CANONICAL_JOURNEY_PACKS[k];
const J = (k) => require(PACK(k).pipeline.replace('./canonical/', '../canonical/'));
const JC = (k) => require(PACK(k).compose.replace('./canonical/', '../canonical/'));

const WD = { appliance: { value: 'washer-dryer', basis: 'stated' }, make: { value: 'hoover', basis: 'stated' } };
const TD = { appliance: { value: 'tumble-dryer', basis: 'stated' } };

function texts(k, turns) {
  const r = H.play(J(k), turns);
  return r.actions.map(({ state, action }) => { const b = JC(k).brief(state, action, null, {}); return JSON.stringify(b) + JC(k).template(b); }).join('\n');
}

describe('a full container is never reported as a warning', () => {
  it('washer-dryer leak on the dry side, then "the water tank seems full"', () => {
    const t = texts('wd-not-drying', [C({ identity: WD, intent: 'report_fault', problem: { journey: 'leaking' }, observations: [O('wdDrySide')] }), C({ observations: [O('tankWarning')] })]);
    expect(t).toMatch(/water container full/);
    expect(t).not.toMatch(/warning/i);
  });
  it('tumble dryer: the container fact label says full, not warning', () => {
    const t = texts('td-water-container-drain', [C({ identity: TD, intent: 'report_fault', problem: { journey: 'cuts-out' }, observations: [O('dryerCondenser'), O('tankWarning')] })]);
    expect(t).not.toMatch(/container (\/ tank )?warning on/i);
  });
});
