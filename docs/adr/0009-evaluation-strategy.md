# 0009. Evaluation strategy

- **Status:** Accepted
- **Date:** 2026-10-07

## Context

AC's replies are produced partly by a language model, so the same input does not produce identical
prose twice. The migration still has to show that moving code and infrastructure has not changed
behaviour, and later phases have to show that changes improve it.

## Decision

Validation is split into two kinds of check.

**Exact checks.** These must match:
- routing
- safety decisions
- the part gate
- error-code lookup
- API status codes and response shapes
- admin authorisation
- the S4R `/part-finder` contract

**Banded checks.** These must stay within agreed tolerances:
- evaluation scores (the GOLD and real-world sets)
- reply length and other LLM-dependent measures

Prose is never compared byte for byte.

Cost is managed by when each runs:

| When | What runs |
|---|---|
| Each import group | Configuration diff, drift, smoke tests |
| After the final import, the ownership proof deploy, and each code or security change | Full evaluation |
| Before and after any step touching the diagnosis Lambda | The `/part-finder` contract test |

Baseline traffic never stores transcripts, never calls admin or benchmark routes, and never uses the
batch runner, which rewrites production routing.

## Consequences

- Infrastructure steps can be validated cheaply and often.
- Behaviour regressions in deterministic layers are caught exactly. LLM drift is caught statistically.
- Bands have to be set from measured variation. The first baseline capture sets them.

## Alternatives considered

- **Byte-for-byte reply comparison.** Rejected: it fails on every run.
- **Full evaluation after every step.** Rejected: it costs too much for steps that cannot change
  runtime behaviour.
