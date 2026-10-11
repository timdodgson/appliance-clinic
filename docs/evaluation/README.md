# Evaluation

How the quality of Appliance Clinic is measured, and the record of each round. The strategy is in
[ADR 0009](../adr/0009-evaluation-strategy.md).

## Current state

| Check | Status |
|---|---|
| **GOLD-v2.4** | 56 whole-conversation scenarios, rubric `gold-v2-rubric-v3`, Jev as the fixed judge. **56/56 in two consecutive runs on the final Phase 11 build** ([results](phase-11-results.md#gold), [per-run evidence](phase-11/gold-runs.json)) |
| Live transcript review | Six realistic journeys through the public site, reviewed by the production transcript judge and read by a person ([Phase 11](phase-11-results.md#transcript-review-live-final-build)) |
| Runtime suites, typecheck, build equivalence | Every pull request (CI) |
| `/part-finder` contract and smoke | Before and after every production release |

**Two independent views.**
- GOLD is a fixed benchmark: the same scenarios, the same judge and the same pass rule each time, so runs can be compared.
- Production transcript review reads real conversations, which can fail in ways no scenario anticipates.
- In Phase 10, GOLD-v2.2 passed 49/49 four times while real transcripts showed a prompt leak and a code mistaken for a model number. The suite was then audited against those failures and extended ([audit](phase-10-gold-audit.md)).
- Both views are kept. A GOLD pass is not taken as proof of conversation quality on its own.

**No score is bought.**
- Thresholds and the pass rule have not been lowered.
- A scenario is changed only when the [value audit](gold-v2-value-audit.md) shows it is a test or judge defect.
- Every failing run is traced to a cause before the next one starts.

## The record, newest first

| Round | Document | What it shows |
|---|---|---|
| Phase 11 | [phase-11-results.md](phase-11-results.md) | One conversation state, signed engine fields, the F15 fix; every GOLD run with the defect each failure exposed; live transcript review |
| | [phase-11-gold-audit.md](phase-11-gold-audit.md) | Why the suite grew by exactly one scenario (G2-MW-06) |
| | [phase-11-concurrency.md](phase-11-concurrency.md) | Account concurrency analysis and the recommended quota |
| Phase 10 | [phase-10-results.md](phase-10-results.md) | Root-cause fixes for the real-transcript findings; the GOLD-v2.3 gate |
| | [phase-10-transcript-findings.md](phase-10-transcript-findings.md) | F1–F15 from real conversations (privacy-safe) |
| | [phase-10-gold-audit.md](phase-10-gold-audit.md) | Would GOLD have caught them? Mostly not; what was added |
| | [gold-v2-3-final-gate.md](gold-v2-3-final-gate.md) | GOLD-v2.3: 55/55 twice (historical) |
| Phase 8 | [gold-v2-value-audit.md](gold-v2-value-audit.md) | The first full run (28/50) classified into test defects and real product defects |
| | [gold-v2-1-changes.md](gold-v2-1-changes.md), [gold-v2-remediation-releases.md](gold-v2-remediation-releases.md) | Rubric and scenario corrections; the product releases that followed |
| | [gold-v2-final-gate.md](gold-v2-final-gate.md) | GOLD-v2.2: 49/49 twice (historical) |

Documents below the current round are kept as they were written; their "current" or "latest" wording refers to their own phase.
