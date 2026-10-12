# Evaluation

How the quality of Appliance Clinic is measured, and the record of each round. The strategy is in
[ADR 0009](../adr/0009-evaluation-strategy.md).

## Current state

| Check | Status |
|---|---|
| **GOLD-v2.4** | 56 whole-conversation scenarios, rubric `gold-v2-rubric-v3`, Jev as the fixed judge. **56/56 in two consecutive runs on the Phase 15 build**, `main` at `10ab5ff` ([results](phase-15-results.md#gold)); Phases 11 to 13 met the same gate. GOLD shares Jev credit with production: runs are rationed and spaced ([finding](phase-13-results.md#operational-finding-jev-credit-exhaustion-took-production-down)) |
| Live transcript review | Realistic journeys through the public site, reviewed by the production transcript judge and read by a person ([Phase 12](phase-12-results.md#transcript-review-live-final-build), [Phase 11](phase-11-results.md#transcript-review-live-final-build)) |
| Runtime suites, typecheck, build equivalence | Every pull request (CI). Every runtime test must pass: no accepted-failure list since [Phase 13](phase-13-results.md). At Phase 15: 163 runtime test files all pass, typecheck and lint clean, migration tooling 724/724 ([tests](phase-15-results.md#tests)) |
| Live AC journeys and production checks | Before and after every production release. The S4R contract and smoke checks are retired from the AC change process ([ADR 0019](../adr/0019-dedicated-canonical-diagnosis-engine.md)) |

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
| Independent benchmark | [independent-100-case-benchmark.md](independent-100-case-benchmark.md) | 100 independently sourced cases, AC live vs a general-purpose assistant, shared customer simulator, blind judges: **general AI advantage** (94–6 pairwise; overall 3.48 vs 1.46; AC critical failures 42 vs 6) |
| Evidence premises | [evidence-premise-audit.md](evidence-premise-audit.md) | Conclusion copy may state only evidence cs/1 records: the live oven defect, the evidence gate, the audit of all 303 fixed conclusion texts, why GOLD missed it, and the GOLD pair on release 17.2 (56/56 twice) |
| Phase 15 | [phase-15-results.md](phase-15-results.md) | ADR 0019: the dedicated canonical diagnosis engine, the legacy code deleted, cutover evidence, the GOLD pair (56/56 twice) and the final production checks |
| Phase 13 | [phase-13-results.md](phase-13-results.md) | ADR 0018: no AC legacy fallback, explicit errors and `UNSUPPORTED`; the four S4R defects; OV5; every former failing test and its disposition; every GOLD run |
| Phase 12 | [phase-12-results.md](phase-12-results.md) | The engine owns the cause label and the token decision; the unplaced-token commit; three COMPOSE defects found by the final gate; every GOLD run |
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
