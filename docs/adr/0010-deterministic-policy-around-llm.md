# 0010. Deterministic policy around the language model

- **Status:** Accepted (records the existing architecture)
- **Date:** 2026-10-07

## Context

AC gives safety-relevant advice about household appliances, including gas and electrical hazards. A
language model is good at understanding what a customer means and at wording a reply. It is not
reliable as the authority for what to do next, whether something is safe, or which part fits.

## Decision

The language model is confined to two jobs: **classifying** each customer message, and **wording** a
decision that has already been made. Everything between those two steps is deterministic, typed and
tested.

1. **Classify.** The model produces a typed classification of the latest message only (`mc/1`). It
   never answers policy questions. That boundary is enforced by tests.
2. **Merge.** A pure function merges the classification into the conversation state (`cs/1`). The
   same inputs always produce the same output, and it never issues requests.
3. **Diagnose.** Journey diagnostics score typed evidence against cause families, with explicit
   commit rules. They never choose an action.
4. **Decide.** Policy maps state and diagnostics to exactly one next action. Safety precedence is
   applied first, and hazards are sticky. Policy does no catalogue matching.
5. **Gate parts.** A part is recommended only with a committed component-level conclusion, a
   confirmed model and a typed catalogue match.
6. **Compose.** The model words the chosen action. Its output is checked: question count, no
   invented parts or model requests, and required safety copy present. On failure it falls back to
   a deterministic template. Safety stops always use fixed copy.

Conversation state is owned by the server, persisted with conditional writes and an immutable
per-turn record, and carried by the browser only as an opaque signed token.

## Consequences

- Safety and part recommendations are testable without a model. Contract suites cover them.
- A model or provider change can affect wording and classification quality, but not the decision
  logic.
- Adding an appliance journey means writing typed diagnostics, policy and compose packs, not prompt
  engineering. That is more work up front and more predictable afterwards.
- The legacy pipeline still answers turns no canonical journey owns, and is the fallback when the
  canonical path degrades. Retiring it is Phase 8 work, bounded by
  [0003](0003-s4r-compatibility-boundary.md).

## Alternatives considered

- **A single LLM agent deciding and wording everything.** Rejected: unpredictable safety behaviour,
  and nothing to test except prose.
- **A fully rule-based chatbot.** Rejected: it understands free-text descriptions of faults poorly.
