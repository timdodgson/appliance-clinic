# Phase 10 results

Phase 10 asked two questions:
1. Does the system really work the way the documents say?
2. Is the customer experience actually good?

It answered them from code, production evidence and real conversations, not from the existing docs or the GOLD pass count. Issue: #83.

## What was produced

| Item | Where |
|---|---|
| As-built architecture: diagram, hop tables, review answers | [as-built.md](../architecture/as-built.md); line-level evidence in [as-built-trace.md](../architecture/as-built-trace.md) |
| Target architecture and migration plan | [target.md](../architecture/target.md) |
| Decisions | ADRs [0014](../adr/0014-cs1-is-the-only-conversation-state.md) (one state), [0015](../adr/0015-one-owner-per-decision.md) (one owner per decision), [0016](../adr/0016-degraded-turns-are-errors.md) (degraded turns are errors), [0017](../adr/0017-authenticate-orchestrator-only-engine-fields.md) (authenticate the orchestrator-only engine fields) |
| Real transcript findings (privacy-safe) | [phase-10-transcript-findings.md](phase-10-transcript-findings.md) |
| GOLD audit against reality | [phase-10-gold-audit.md](phase-10-gold-audit.md) |
| Overview corrections | 11 statements in [overview.md](../architecture/overview.md) |

## Root causes fixed

| Finding | Root layer | Fix | Release |
|---|---|---|---|
| F1: COMPOSE could repeat the prompt's own instructions to the customer | COMPOSE contract | `checkReply` rejects a reply that repeats any sentence of the prompt's rules, or a section label. This replaces 8.13's hand-listed phrases | 10.1 |
| F2: a recorded category quoted back as the customer's words ("torn") | COMPOSE evidence framing | The prompt frames evidence as recorded categories; the copy is category-truthful ("damaged (torn or broken)") | 10.1 |
| GOLD v2.3: `LATEST` restated as the customer's words ("the door still won't lock after the fix", "the lights are on", "the condenser issue") | COMPOSE prompt | `LATEST` is labelled as recorded categories. The acknowledgement instruction appears only with `LATEST`, with no example phrase. Dryer types read as types | 10.4, 10.6, 10.8 |
| F3: a template said its safety lines twice | COMPOSE template | A requirement the step's own copy already carries is not repeated. This uses the same marker as `checkReply` | 10.1 |
| F4: a COMPOSE failure left no reason in the record | Observability | The error class (HTTP status or timeout) is recorded in the trace and the metric | 10.1 |
| F5: a bare "yes" to an either/or question counted as an answer | UNDERSTAND and merge | mc/1 counts it as partial. merge turns "answered with no fact" into partial; the step is re-offered once, with its own framing | 10.1, 10.4 |
| F8: a bare code read by Jev as a weak model guess and committed | Orchestrator identity | The family commit rule now applies to the token. A weak reading leads to "Is F06 a code showing on the display, or is it the model number?", and the answer keeps the token as the code | 10.2, 10.7 |
| F9: identity loop ("brand and type", asked twice) | Orchestrator clarify | The clarify asks only for what is missing. A repeated question becomes an explanation with a way on | 10.2 |
| F10: catalogue fragments printed ("Possible causes include stuck / not confirmed"), then a dead end | Orchestrator code reply and data | Fragments are no longer printed, and the reply gives a next step. A symptom given after a code now reaches diagnosis | 10.2, 10.5 |
| F11: an owner precaution on a code answer | Orchestrator | No precaution where no physical step is given | 10.2 |
| F13 / ADR 0016: outages recorded as healthy turns; state advanced on a failed diagnose | BFF and orchestrator | SERVICE_UNAVAILABLE is `error:true`. A failed canonical diagnose marks the result degraded, so it is not persisted | 10.2, 10.3 |
| F14: "is it working normally now?" just after "it works now" | Policy | No CONFIRM question straight after a "works normally again" report | 10.6 |
| A post-release journey turn throttled (shared account concurrency) | Orchestrator → engine transport | One short retry on HTTP 429 only | 10.7 |
| GOLD v2.3: a code answer repeated after a symptom; E24 ignored on a canonical journey; a vacuum conclusion asserting a fact the customer had not given | Orchestrator routing; COMPOSE content; conclusion copy | Code then symptom routes to diagnosis; a first-seen displayed code is acknowledged; the copy is neutral | 10.4, 10.5 |
| GOLD gate: category copy that said more than the customer did ("blocked", "showing power"); a follow-up with nothing to do next | Category copy; follow-up copy | Category labels are strictly literal ("not completely dead"); the follow-up ends with a way on, or an engineer if the owner cannot check | 10.9, 10.10 |
| GOLD gate: "coils are dusty" with no answer on whether they were cleaned was read as not answered | mc/1 option description | A found-but-not-sorted option for the coil check | 10.11 |
| GOLD gate: the describe question asked word for word twice after a vague answer | Orchestrator clarify | A repeated describe question is asked a second, more concrete way | 10.12 |

Fixed on `main` before this phase and confirmed by replay: F6 and F7 (re-offer after ignored; repeated conclusion).

## Pull requests

| PR | Change | Merge commit |
|---|---|---|
| #84 | Audit: as-built and target architecture, ADRs, transcript findings, GOLD audit | `f19d895` |
| #85 | 10.1 canonical fidelity | `d4e907c` |
| #86 | 10.2 orchestrator identity and code replies | `05333f2` |
| #87 | 10.3 degraded turns are errors; GOLD-v2.3 and rubric v3 | `2985b53` |
| #88 | 10.4 wording fidelity (GOLD v2.3 findings) | `2355b7c` |
| #89 | 10.5 code then symptom | `75110a6` |
| #90 | 10.6 wording from the post-release journeys | `8a0e1fa` |
| #91 | 10.7 code-or-model carry-over; engine-throttle retry | `15fa857` |
| #92 | 10.8 dryer-type categories; G2-DW-01 rewritten | `3cf1a51` |
| #93 | 10.9–10.11 gate findings: literal categories, follow-up copy, dusty coils | `0e0a0fc` |
| #94 | 10.12 describe question not repeated | `d2b4c23` |

## Releases

Each release went through `change.sh`:
- a checked change set;
- a temporary least-privilege grant;
- drift IN_SYNC and a confirmed no-op;
- live code hash or image digest equal to the build reference;
- CloudTrail audit.

Every release was also followed by the S4R health check (3×200), the `/part-finder` contract, the ingress check and the four-journey smoke test.

| Release | Function(s) | CloudTrail |
|---|---|---|
| 10.1 | part-finder, whichpart-api (its copied `requests.js`) | ok |
| 10.2 | orchestrator image | ok |
| 10.3 | whichpart-api | ok |
| 10.4 | part-finder | ok |
| 10.5 | orchestrator image | ok |
| 10.6 | part-finder | ok |
| 10.7 | orchestrator image | ok |
| 10.8 | part-finder | ok |
| 10.9 | part-finder | ok |
| 10.10 | part-finder | ok |
| 10.11 | part-finder | ok |
| 10.12 | orchestrator image | ok |

S4R safety:
- No S4R resource was touched.
- The changed engine modules are canonical-only: S4R requests run the legacy pipeline, which does not execute them.
- The `/part-finder` contract and S4R health were green before and after every release.

## Regression tests added

| Suite | Count | Covers |
|---|---|---|
| `services/part-finder/test/phase10-transcript-regressions.test.mjs` | 23 | F1–F5; the GOLD v2.3 wording findings; the post-release journeys |
| `orchestration/tests/test_phase10_identity.py` | 28 checks | F8–F11, ADR 0016 persistence, code then symptom, code-or-model carry-over, 429 retry, describe-question repeat |
| `services/whichpart-api/test/degraded-turns.test.mjs` | 4 | ADR 0016 in the BFF, COMPOSE telemetry |
| `services/whichpart-api/test/gold-v2.test.mjs` | updated | v2.3 set, rubric-wide criticals, template telemetry |

Runtime suite: 175/190 (the 15 known failures, unchanged). Typecheck clean.

## GOLD

**Suite.** GOLD-v2.3: 55 scenarios, rubric `gold-v2-rubric-v3`.

| Change | Detail |
|---|---|
| Retained | All 49 v2.2 scenarios |
| Added | Six real-failure shapes |
| Rewritten | 1: G2-DW-01. The old expectation contradicted the deliberate owner-checks-first policy and passed or failed by judge variance |
| Removed | None |
| Rubric | Two rubric-wide critical failures: instructions in a reply; telling the customer they said something they did not |
| Pass rule | Unchanged |

**Runs.**

| Run | Build | Result |
|---|---|---|
| Diagnostic (before any v2.3 fix) | 10.3 | 48/55. The new fidelity question and scenarios found 7 real defects that v2.2 had passed |
| Gate attempt | 10.5 | 52/55. Stopped and fixed |
| Gate attempt | 10.8 | 52/55. Fixed in 10.9 |
| Gate attempt | 10.9 | 53/55. Fixed in 10.10 |
| Gate attempt | 10.10 | 54/55 twice, a different scenario each time. Fixed in 10.11 and 10.12 |
| **Final run 1** | 10.12 | **55/55**, mean 3.41 |
| **Final run 2** | 10.12 | **55/55**, mean 3.39 |

Every failed attempt was a real defect, fixed at its root layer and then re-run as a full suite. Details: [gold-v2-3-final-gate.md](gold-v2-3-final-gate.md).

## Post-release transcript judge

Five realistic journeys were run on the released build through the public path, ended, and scored by the production transcript reviewer (Jev, every 15 minutes). No transcript patching; the judge is the same one that scores real sessions.

| Journey | Overall | Outcome |
|---|---|---|
| Dishwasher not draining | good | useful |
| Vacuum filter | good | useful |
| Dryer with a code | good | partial |
| Code with a misspelt brand | mixed | partial; flagged for review |
| Vague noise | mixed | useful; flagged for review (repeated follow-up) |

The two mixed results are the two open debt items below (code-versus-model reading; repeated follow-ups). Earlier journey batches were not scored: the harness never ended them. It now sends a separate end event.

## Final production state

| Check | Result |
|---|---|
| part-finder code hash | `b6mBKN7oe+dlobU+llOy5Okz1e6fVK4e/1+a8c216PA=` (10.11) |
| whichpart-api code hash | `mSkHPkTmegW6nCINGtXOeGZSNzggpb7R5hk+NQSs/l8=` (10.3) |
| orchestrator image | `sha256:fe1d0f3e1ef98679e96f25dd84571f5f3d0cf613d1c4c67e3257eeafc06362cb` (10.12) |
| error-code MCP | unchanged |
| S4R health | 3×200, three times |
| `/part-finder` contract | ok |
| Ingress | ok |
| Smoke | 4/4 equal, no problems |
| AC endpoints / bearers / auth | 8/8, 5/5, 13/13 |
| Drift | AcAuthStack, AcDataStack, AcRuntimeStack, ApplianceClinicToolkit: IN_SYNC |
| CloudTrail | 10.1–10.12 ok, no failures |

## Remaining debt (honest)

| Item | Why it is still open | Plan |
|---|---|---|
| Orchestrator in-memory state with latches | Retiring it means moving each latch into cs/1 with a test | ADR 0014, target step T7 |
| Orchestrator-only engine fields unauthenticated | Needs a new secret and both Lambdas, gated on S4R evidence | ADR 0017, target step T6 |
| Legacy engine instruction leak (F15) | The text is in the legacy pipeline that S4R uses; changing it changes S4R wording | Needs an S4R-aware release; owner decision |
| Error-code enrichment causes are fragments in the data | They are no longer printed. The data still needs regenerating | Target step T10 |
| Repeated follow-up after a conclusion (third and later turns get the same short follow-up) | A small policy gap: no count of follow-ups | Next phase |
| Jev's code-versus-model reading near the threshold is nondeterministic | The uncertainty gate helps, but a reading just above the threshold still commits | Bridge codes into canonical journeys (target T8) |
| Live `CANONICAL_MODE` and allow-list not in `runtime-overrides.json` | A configuration change through the change process | Target step |
| Account Lambda concurrency limit (10) shared with S4R | Raising it is an owner-only quota request | Owner action |
