/**
 * F15 (docs/evaluation/phase-10-transcript-findings.md): on the legacy pipeline — the one S4R's /part-finder
 * uses — a washing machine left water standing, the customer reported the accessible filter clear, and the
 * reply ended with guidance written for the model ("Do not confirm the pump or a jammed impeller; …").
 * Synthetic typed turns reproduce the shape; no customer text is copied.
 *
 * Root cause: a deterministic progression rule wrote COMPOSE guidance into nextBestCheck, a field that is
 * both COMPOSE context and customer fallback text. The fix types the two audiences apart.
 */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
globalThis.awslambda = globalThis.awslambda || { streamifyResponse: (f) => f, HttpResponseStream: { from: (s) => s } };
const L = require('../part-finder-lambda.js')._internal;
const { setNextCheck, customerCheckText, nextCheckGuide, stripGuidanceEcho } = require('../engine/conversation.js');

const messages = [
  { role: 'user', content: 'washing machine finished with water left in the drum' },
  { role: 'assistant', content: 'Check the accessible pump filter or trap. Open it slowly with towels ready.' },
  { role: 'user', content: 'done that, the filter is clear and the impeller turns freely' },
];
const drainState = () => ({
  applianceType: 'washing-machine', make: 'Hotpoint', onTopic: true,
  facts: [{ name: 'waterRemaining', value: 'TRUE' }, { name: 'filterChecked', value: 'TRUE' }],
  checksReported: ['filter clear'],
});

describe('F15: guidance written for the model never reaches the customer (legacy / S4R path)', () => {
  const progress = L.conversationProgress(messages);
  const intent = drainState();
  L.preferAccessibleFirstAction(intent, messages[2].content, progress);
  const guide = nextCheckGuide(intent);

  it('reproduces the F15 decision: the next action is the drain-hose check, with guidance attached', () => {
    expect(intent._nextAction).toBe('check');
    expect(customerCheckText(intent)).toMatch(/drain hose/i);
    expect(guide).toBeTruthy();
  });

  it('the engine keeps the combined text for its own decisions (unchanged behaviour)', () => {
    expect(intent.nextBestCheck.startsWith(customerCheckText(intent))).toBe(true);
    expect(intent.nextBestCheck.endsWith(guide)).toBe(true);
  });

  it('a reply with no next step gets only the customer-facing check appended', () => {
    const out = L.ensureNonTerminalProgression('Thanks for checking that.', intent, {});
    expect(out).toContain(customerCheckText(intent));
    expect(out).not.toContain(guide);
  });

  it('COMPOSE context carries the check and the guidance as separate, labelled lines', () => {
    const ctx = L.formatTrustedCustomerEvidence(intent);   // the trusted state block COMPOSE writes from
    expect(ctx).toContain(`Next useful check: ${customerCheckText(intent)}.`);
    expect(ctx).not.toContain(`Next useful check: ${intent.nextBestCheck}`);
    expect(ctx).toMatch(/Constraint for this reply \(internal[^)]*\): /);
  });

  it('a reply that copies the guidance (the F15 shape) has those sentences removed, the advice kept', () => {
    const leaked = `Thanks for confirming the filter is clear. ${customerCheckText(intent)} ${guide}`;
    const out = stripGuidanceEcho(leaked, intent);
    expect(out).toContain(customerCheckText(intent));
    for (const piece of guide.split(/(?<=[.;])\s+/)) expect(out).not.toContain(piece.replace(/[.;]$/, ''));
  });

  it('applies to every guidance-bearing rule, not one phrase: a guidance-only action exposes no customer text', () => {
    const t = {};
    setNextCheck(t, null, 'Some instruction for the model only.');
    expect(customerCheckText(t)).toBeNull();
    expect(L.customerFacingNextCheck(t)).toBeNull();
    expect(stripGuidanceEcho('Here is advice. Some instruction for the model only.', t)).toBe('Here is advice.');
  });

  it('once another step replaces nextBestCheck, the old guidance no longer applies', () => {
    const t = {};
    setNextCheck(t, 'Check the hose.', 'Do not mention the pump.');
    t.nextBestCheck = 'Is the drum turning?';
    expect(nextCheckGuide(t)).toBeNull();
    expect(customerCheckText(t)).toBe('Is the drum turning?');
  });

  it('an understand-authored nextBestCheck (no guidance) is passed through unchanged', () => {
    const t = { nextBestCheck: 'Does the drum turn by hand?' };
    expect(customerCheckText(t)).toBe('Does the drum turn by hand?');
    expect(stripGuidanceEcho('Does the drum turn by hand?', t)).toBe('Does the drum turn by hand?');
  });
});
