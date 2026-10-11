# Phase 13 results: no AC legacy fallback, zero accepted failures

Phase 13 implemented [ADR 0018](../adr/0018-no-ac-legacy-fallback.md):
- The legacy pipeline serves only S4R's plain unsigned `{messages}` request.
- Every Appliance Clinic (AC) turn is one of: canonical, an explicit non-diagnostic outcome, or an explicit error.
- The runtime suite no longer has an accepted-failure list.

Tracking issue: #113.

## Why the accepted-failure list existed, and why it is gone

Phase 3 recorded 15 runtime test files that failed on the imported code (`build/test/known-failures.json`), so CI could
fail on new failures without blocking on history. By Phase 12 the list had become a place where real defects waited.
Two things went wrong:

- **Proposed fixes extended legacy.** Fixing some failures meant adding AC behaviour to the legacy pipeline, for example
  oven B3/B4.
- **The legacy pipeline was a hidden fallback.** An audit showed it silently answered any AC turn the canonical path
  could not.

Every former failure is now a product fix, a test rewritten to the current contract, or a removal. The list and its
runner logic are deleted. `run-tests.mjs` fails on any failure, and files deliberately removed are recorded under
`removed` in `docs/migration/runtime-changes.json` with a reason.

## Former failures and their dispositions

| Test file | Disposition |
|---|---|
| `architectural-integrity` | **Product fix:** gas part request is competent-person (S2, S2b, S2c). **Rewritten:** E6, S3. **Removed:** E2, E4, E5, P3 (they asserted a `replacementGrain` field that was never built) |
| `oven-diagnostic-reasoning` | **Product fix:** tripping is competent-person on every turn, with no part offer (G1–G4, G11, G12). **Rewritten:** G8. **Removed:** G9 (it contradicts canonical OV7; G10 holds the filter) and B3/B4 (canonical oven journey OH10; the OV5 clock fix is below) |
| `normal-behaviour` | **Product fix:** dishwasher wet plastics |
| `fit-evidence` | **Product fix:** stocked parts no longer lead the COMPOSE prompt. **Rewritten** to the real prompt wording |
| `engineering-finding`, `answer-quality-contract` (A6, D1), `diagnosis-vs-part-fit` | **Rewritten** to the current COMPOSE contract (the string assertions named text no prompt contains) |
| `media-neutrality` | **Rewritten** as behaviour, by running the handler. Since 13.5 it runs as S4R does (unsigned `{messages}`, in-process Jev stand-in) |
| dishwasher, fridge-freezer, hobs and washer-dryer engineer challenges | **Rewritten:** advice-only nodes are exempt from the suspect-override rule, as in the oven test |
| `washing-machine-engineer-challenge` | **Rewritten:** node counts are invariants, and leak-* nodes are check-first |
| `vacuum-engineer-challenge` | **Rewritten:** the motor case is proved on the shipped knowledge discriminators and the real COMPOSE prompt |
| `orchestration/tests/test_clarification_intent.py` | **Rewritten** to the ADR 0018 routing (the code-only clarify flow, `UNSUPPORTED` progression, the authoritative `_INTENT_PENDING` map). **Removed:** K3–K5 (`_cue_appliance` no longer exists) and the checks of deleted legacy composition |

### Tests that existed only to keep AC on legacy (ADR 0018 test policy)

| Test | Disposition |
|---|---|
| `test_journey_policy_v2.py`, `test_progression_policy.py` | **Removed.** They tested only the deleted legacy staging policy |
| `test_orchestration.py`, `test_response_ownership.py`, `test_jev_authoritative_routing.py`, `test_canonical_control.py`, `test_canonical_passthrough.py`, `test_one_conversation_state.py`, `test_describe_turns.py` | **Rewritten:** each expectation of a legacy diagnosis became the ADR 0018 outcome; the legacy composition unit tests were removed with the code |
| `cs1_bff.py` (test harness) | **Fixed.** Jev hazard keys were wrong, so hazards never reached cs/1 in tests; "gas oven" was read as a gas smell; the cs/1 schema version was wrong |

## AC legacy reachability

| | Before | After |
|---|---|---|
| Canonical degradations → legacy answer | Every case: missing block, `understand_unavailable`, `understand_no_canonical`, `session_mismatch`, classifier failure/timeout, invalid prior state, merge failure, degraded Jev, diagnose signature drop, gate mismatch | None. Each is `SERVICE_UNAVAILABLE` with nothing persisted (13.3 BFF, 13.4 orchestrator) |
| Signed AC diagnose runs on the legacy pipeline (production logs) | 206 in the 7 days before 13.4 (against 2,657 canonical) | 0 since 13.4. Since 13.5 the engine refuses them (`409 canonical_not_controlled`) |
| Unsigned request carrying internal fields | Stripped and served as a plain diagnosis | Refused (`401 engine_signature_required`). Production showed no such traffic in 30 days except audit probes |
| Orchestrator legacy flows | Symptom, combined and code reconciliation flows, plus the journey-stage policy | Deleted (`orchestrator.py`: 2,319 → about 1,440 lines) |

## Turn classes

| Class | Outcome |
|---|---|
| Hazard with no journey (gas, burning, shock) | **Canonical safety stop** from cs/1, with fixed copy |
| Unsafe request | **Fixed decline**. The washing-machine and dishwasher journeys now decline too (13.5), like every other family |
| Code turns | **Error-code MCP only.** No reconciliation with another diagnosis. An incomplete lookup asks for the model and never prints "means: None" |
| Code then symptom | **Canonical:** the described journey replaces the `error-code-only` placeholder (merge M4b, 13.5b/13.5c). If no journey owns it, `UNSUPPORTED`, never the same code meaning again (13.4b) |
| Vague opener, identity only, code without make | **Intake** |
| Typed problem no journey owns | **Explicit `UNSUPPORTED`**: "I can't diagnose that problem with your … here yet", with the safety line, no cause and no part |
| Appliance outside the typed families | Repeated appliance clarify, held by the repeat guard. **Known limit** |

## OV5 (oven dead / no power)

- A flashing clock or AUTO counts as a working display, so the journey asks the clock/manual check, not "no power", and
  does not repeat the display question (13.2).
- Proved by canonical tests and live: "completely dead, just the clock flashing" asks the clock check.

## The four approved S4R defects (legacy, S4R only)

| Defect | Before → after (live, unsigned `{messages}`) |
|---|---|
| Gas part request | CAUTION with purchase grain → COMPETENT_PERSON (Gas Safe engineer), no purchase |
| Oven tripping follow-up | A model ask to sell an element → COMPETENT_PERSON, no parts, no part offer |
| Dishwasher wet plastics | Not classed normal → the normal-behaviour answer |
| Legacy COMPOSE stocked parts | "Lead with" stocked parts → the evidence order stands (`diagnosis.compose.system` v2) |

Each fix passed the `/part-finder` contract, ingress, smoke 4/4, S4R health 3×200, stack drift and CloudTrail checks.

## Releases

| Release | Unit | What |
|---|---|---|
| 13.1, 13.1b | part-finder | The four S4R defects |
| 13.2 | part-finder | OV5 clock counts as power |
| 13.3 | whichpart-api | Canonical control turns are canonical or an explicit error; a bad token starts a fresh canonical session |
| 13.4 | orchestrator | No AC legacy fallback; explicit non-journey outcomes |
| 13.5 | part-finder | Engine refuses unsigned internal fields (401) and uncontrolled AC diagnose calls (409); WM/DW unsafe decline |
| 13.5b, 13.5c | part-finder, whichpart-api | Merge M4b (code then symptom) |
| 13.4b | orchestrator | Code then unowned symptom → `UNSUPPORTED` |
| 13.6 | part-finder | Container-full fact copy never asserts a warning (GOLD G2-WD-04) |

Every release had: contract, ingress and smoke 4/4 before and after; S4R 3×200; stack drift IN_SYNC; overrides equal
to `runtime-overrides.json`. CloudTrail is clean for every release (13.1 to 13.6).

## Validation

- **Runtime:** ALL PASS (204 of 204). Tooling 796/796. Typecheck clean.
- **GOLD-v2.4:**
  - run 1: 55/56. It found the code-then-symptom regression (G2-EC-02), fixed in 13.5b/13.4b.
  - runs 2 and 3: 56/56 and 56/56, no critical failures, on 13.5b + 13.4b.
  - two runs on the complete build were lost to the Jev outage (judge and product calls failed with 429/402; see the
    operational finding). They are not counted as product results.
  - after recovery, the pair on `819fc67` scored 55/56 and 56/56; the failure was fixed in 13.6. The pair on 13.6 scored
    **56/56 twice** ([below](#gold-on-the-final-build)).
- **Live AC journeys reviewed:**
  - gas → stop; burning → stop; vague → intake;
  - code → canonical; code + symptom → canonical;
  - WM drain → resolved; WM bypass and DW live-test requests → declined, and the journey resumes;
  - F01 then "stops a few minutes in" → cut-out journey; E15 then a grinding noise → `UNSUPPORTED`;
  - forged state token → fresh session.
- **Production checks (after 13.6):**
  - `/part-finder` contract, ingress, smoke 4/4 and S4R 3×200;
  - AC endpoints 8/8, auth 13/13, bearer 5/5;
  - stack drift on 4 stacks IN_SYNC; overrides drift none.

### GOLD on the final build

After service recovery (below), a pair ran on the exact deployed build, `main` at `819fc67` with overrides equal to
production, 20 minutes apart:

| Run | Result | Note |
|---|---|---|
| Final 1 | 55/56, one critical failure | G2-WD-04: the reply called a "tank seems full" report a "container warning". Root cause: the washer-dryer and tumble-dryer fact copy rendered the shared mc/1 observation `tankWarning` (full, overflowing or warning on) as "warning on". Fixed in PR #119, release 13.6 |
| Final 2 | 56/56, no critical failure | |

The pair was **not** 56/56 twice, so the gate was not met on `819fc67`. A fresh pair ran on the 13.6 build:

| Run | Build | Result |
|---|---|---|
| Gate 1 | 13.6, `main` at `ebdae2f` | **56/56**, no critical failure |
| Gate 2 | 13.6, `main` at `ebdae2f` (20 minutes later) | **56/56**, no critical failure |

**The gate is met: 56/56 in two consecutive runs on the exact deployed build.** These were the only runs made after the
outage, besides the pair on `819fc67`. No exploratory GOLD was run.

## Operational finding: Jev credit exhaustion took production down

**What happened.**
- After the code-then-symptom fix, two more GOLD runs were started on the complete build.
- Jev first rate-limited (HTTP 429), then refused every call with HTTP 402 (payment required): the account's credit was
  used up.
- **Window:** the first failing call was at 20:51 UTC and the last 402 at 21:47 UTC (2026-10-11), when test traffic was
  stopped. Service returned at 22:37 UTC once the account was topped up; 402s had already stopped.
- **Impact:**
  - S4R `/part-finder` returned 503, and the contract check failed.
  - Every AC turn got the explicit "I can't run the diagnosis right now" error (ADR 0016/0018: no guessed answer, no
    state written).
  - 560 signed AC calls failed in the window, plus S4R requests.

**Cause.** The evaluation traffic used up the credit:
- seven full GOLD runs in one evening, each of 56 multi-turn conversations judged by Jev;
- live journeys;
- runs repeated back to back.

GOLD, the transcript judge, AC and S4R all share one Jev account and credential, so evaluation load used up the credit
production depends on. Nothing alerted on it. The outage was found by the next GOLD run.

**Recovery checks (22:37 UTC):**
- one provider call through the S4R path → 200;
- `/part-finder` contract OK; ingress OK; smoke 4/4; S4R 3×200;
- one AC diagnosis → normal canonical reply;
- no Jev errors since.

**What changed in practice.**
- No exploratory GOLD. Only the two owed runs were made, spaced 20 minutes apart.
- The follow-up debt is recorded in the [project story](../portfolio/project-story.md#still-open):
  - quota and credit monitoring and alerting on Jev (402/429 rate, remaining credit);
  - separating evaluation traffic (GOLD runs and the judge) from production credit, with a separate key or account, or a
    budget cap for evaluation.
