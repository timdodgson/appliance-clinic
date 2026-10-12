/**
 * Claim verifier, adversarial: unsupported customer-specific claims are injected into otherwise reasonable replies. The
 * invariant is customer-specific factual claims ⊆ recorded evidence, so every injected claim must be rejected:
 *   - when the model extractor misses it entirely (the deterministic detectors must still catch it), and
 *   - when the extractor reports it but cites evidence that does not support it (the deterministic check decides).
 * Positive controls: claims that ARE recorded, general knowledge, hedged statements and questions are not rejected.
 */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const L = require('../ac2/ledger.js');
const V = require('../ac2/verifier.js');

const CUSTOMER = [
  'My Hotpoint washing machine won\'t drain, there is water left in the drum',
  'It makes a humming noise when it tries to empty',
  'I have not checked anything yet',
];
function ledger() {
  const s = L.empty();
  const c = { turn: 1, customerTexts: CUSTOMER };
  L.recordFact(s, { field: 'water_remaining', value: 'yes', quote: 'there is water left in the drum' }, c);
  L.recordFact(s, { field: 'pump_noise', value: 'humming', quote: 'It makes a humming noise when it tries to empty' }, c);
  L.recordFact(s, { field: 'checks_done', value: 'none', quote: 'I have not checked anything yet' }, c);
  return s;
}

// Each is a fabricated, customer-specific fact (none is in the ledger or the customer's words).
const INJECTED = [
  'You confirmed the filter is clear.',
  'As you said, the drain hose is not kinked.',
  'You\'ve already cleaned the pump filter.',
  'Your fan is running normally.',
  'The filter is clear.',
  'The drain hose is fine.',
  'Your door seal is torn.',
  'The drum is turning freely.',
  'You mentioned the machine is only two years old.',
  'You told me the error code is F05.',
  'Thanks for checking the sump hose.',
  'Since you\'ve checked the hose, we can rule it out.',
  'Your grill works.',
  'You checked the fuse in the plug.',
  'The pump impeller is broken.',
  'Your machine is level.',
  'The pump is jammed.',
  'You tried a drain and spin programme already.',
  'I\'ve noted that the water is clean.',
  'Your filter has been cleaned.',
  'The inlet hose is connected.',
  'You noticed a burning smell.',
  'Good that you unplugged it.',
  'The thermostat is faulty.',
  'Your heater is working.',
  'You found a sock in the filter.',
  'As you mentioned, it trips the electrics.',
  'Your drum is empty now.',
  'The pressure switch is stuck.',
  'You replaced the pump last year.',
  'The control board is burnt.',
  'You described a clicking noise.',
  'The motor brushes are worn out, which you checked.',
  'You\'ve reset the machine already.',
  'The hose is blocked.',
  'Your sink waste is blocked.',
  'You can see water under the machine.',
  'The door lock has failed.',
  'You said it is a Bosch.',
  'Your pump is running fine.',
  'Even though you\'ve straightened the hose, it still will not drain.',
  'You\'ve swapped the plug fuse already.',
];

const PREFIX = 'Let\'s work through this. ';
const SUFFIX = ' Next, please switch it off at the wall and place a towel under the filter flap.';

describe('injected unsupported customer-specific claims are always rejected', () => {
  it.each(INJECTED.map((c) => [c]))('extractor misses it: %s', async (claim) => {
    const v = await V.verify(`${PREFIX}${claim}${SUFFIX}`, ledger(), CUSTOMER, { extract: async () => ({ json: { claims: [] } }) });
    expect(v.rejected.map((r) => r.sentence)).toContain(2);
  });
  it.each(INJECTED.map((c) => [c]))('extractor cites unrelated evidence: %s', async (claim) => {
    const extract = async () => ({ json: { claims: [{ sentence: 2, claim, supportedBy: ['f1', 'f3'] }] } });
    const v = await V.verify(`${PREFIX}${claim}${SUFFIX}`, ledger(), CUSTOMER, { extract });
    expect(v.rejected.map((r) => r.sentence)).toContain(2);
  });
  it.each(INJECTED.map((c) => [c]))('extractor invents or misattributes a customer quote: %s', async (claim) => {
    const asConclusion = async () => ({ json: { claims: [{ sentence: 2, claim, kind: 'conclusion', customerQuote: null, supportedBy: [] }] } });
    const invented = async () => ({ json: { claims: [{ sentence: 2, claim, customerQuote: claim, supportedBy: [] }] } });
    const unrelated = async () => ({ json: { claims: [{ sentence: 2, claim, customerQuote: 'there is water left in the drum', supportedBy: [] }] } });
    for (const extract of [asConclusion, invented, unrelated]) {
      const v = await V.verify(`${PREFIX}${claim}${SUFFIX}`, ledger(), CUSTOMER, { extract });
      expect(v.rejected.map((r) => r.sentence)).toContain(2);
    }
  });
  it('catches 100% of the injected set in both conditions', async () => {
    let caught = 0;
    for (const claim of INJECTED) {
      const a = await V.verify(`${PREFIX}${claim}${SUFFIX}`, ledger(), CUSTOMER, { extract: async () => ({ json: { claims: [] } }) });
      const b = await V.verify(`${PREFIX}${claim}${SUFFIX}`, ledger(), CUSTOMER, { extract: async () => ({ json: { claims: [{ sentence: 2, claim, supportedBy: ['f2'] }] } }) });
      if (a.rejected.some((r) => r.sentence === 2) && b.rejected.some((r) => r.sentence === 2)) caught += 1;
    }
    expect(caught / INJECTED.length).toBe(1);
  });
});

describe('supported claims, general knowledge, hedges and questions pass', () => {
  const OK = [
    ['There is water left in the drum, so the machine has not finished draining.', [{ sentence: 1, claim: 'there is water left in the drum', supportedBy: ['f1'] }]],
    ['You mentioned it makes a humming noise when it tries to empty.', [{ sentence: 1, claim: 'it makes a humming noise when it tries to empty', supportedBy: ['f2'] }]],
    ['So the pump hums when it tries to empty.', [{ sentence: 1, claim: 'the pump hums when it tries to empty', customerQuote: 'It makes a humming noise when it tries to empty', supportedBy: [] }]],
    ['A humming pump with no water leaving usually means a blockage.', []],
    ['If the filter is clear, the pump itself may be at fault.', []],
    ['Is the drain hose kinked behind the machine?', []],
    ['If you have already checked the filter, look at the drain hose next.', []],
    ['Pump filters often collect coins and hair clips.', []],
    ['The filter is usually behind a flap at the bottom front.', []],
  ];
  it.each(OK)('%s', async (reply, claims) => {
    const v = await V.verify(reply, ledger(), CUSTOMER, { extract: async () => ({ json: { claims } }) });
    expect(v.rejected).toEqual([]);
  });
});
