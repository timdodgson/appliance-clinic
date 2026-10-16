# Evaluation

How the quality of Appliance Clinic is measured, and the record of each round. The strategy is in
[ADR 0009](../adr/0009-evaluation-strategy.md).

## Current state

| Check | Status |
|---|---|
| **Scripted chats** | 22 fixed customer messages (`evaluation/scripted/tests.json`) sent through the live services by `evaluation/scripted/run.cjs`, each reply checked against hand-written pass/fail expectations and read side by side ([side by side](../../evaluation/scripted/SIDE-BY-SIDE.md)). Change 23.2: **22/22**; the previous pipeline: 2/22 on the same messages. Small set, no prompt-injection cases yet |
| Runtime suites, typecheck, build equivalence | Every pull request (CI). Every runtime test must pass: no accepted-failure list since [Phase 13](phase-13-results.md). The GOLD guardrail regression keeps GOLD's scenarios as deterministic inputs: the kernel contains an adversarial advisor |
| Live test | Admin → Test runs a conversation through the production services and shows the per-turn audit; the same path as a customer, never a customer transcript |

**Why the judged benchmarks stopped.** The independent-100 judge scored eleven dimensions 0–4 as an overall
impression. The 2026-10-16 code audit ([report](code-audit-2026-10-16/REPORT.md), [facts](code-audit-2026-10-16/FACTS.md))
showed it had not marked down a stale heading, deleted true sentences, lost paragraph breaks or a missing part; the
scores of three systems sat within its noise. The harness (`evaluation/rebuild/`, `evaluation/independent-100/`
runner, judge and simulator) and its recorded outputs were deleted in change 23.4; the frozen case sets and the result
files stay as the record. The documents below that cite the harness describe runs made before it was deleted.

**No score is bought.**
- A scripted expectation is changed only when reading the reply shows the pattern itself is wrong, and that change is
  recorded.
- Every failing run is traced to a cause before the next one starts.

## The record, newest first

| Round | Document | What it shows |
|---|---|---|
| Code audit | [code-audit-2026-10-16/REPORT.md](code-audit-2026-10-16/REPORT.md), [FACTS.md](code-audit-2026-10-16/FACTS.md), [CODE-WALKTHROUGH.md](code-audit-2026-10-16/CODE-WALKTHROUGH.md) | Every step of the ADR 0021 pipeline read against live logs and 308 saved turn audits: what each step was proven to do; the decision to replace it ([ADR 0023](../adr/0023-one-advisor-model-with-tools-inside-the-guardrail-kernel.md)) |
| ac3 pipeline | [ac3-pipeline-results.md](ac3-pipeline-results.md) | ADR 0021's pipeline on the same 100 cases from 21.5 to 21.16. 21.5–21.9 below the first rebuild (2.32 → 2.48 → 2.37 vs 2.73); 21.11 restored the first rebuild's reasoning step and claim check (2.79). **21.16: the safest so far, level with the first rebuild, not ready** (2.74; critical failures 16 vs ac2 24, harmful 0; 46–6–48 vs ac2; 14–86 vs general AI; median turn 18.1 s) |
| LLM-led rebuild | [llm-led-rebuild.md](llm-led-rebuild.md) | The replacement architecture (ADR 0020) on the same 100 cases plus a 31-case held-out set, blind-judged against old AC and the general assistant: **improved but not ready** (83–17 vs old AC; 17–83 vs general AI; overall 2.73 vs 1.46 vs 3.48; held-out 2.81 vs 1.06 vs 3.65). Not cut over |
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
