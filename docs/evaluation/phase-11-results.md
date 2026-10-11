# Phase 11 results

Phase 11 closed the debt Phase 10 exposed, without a broad rewrite. Issue: #96.

## What changed, by area

| Area | Result | Release |
|---|---|---|
| A. F15 legacy instruction leak (S4R path) | **Fixed live.** Reproduced exactly on the pre-fix engine: the leaked sentence reached the reply and the COMPOSE context. Root cause: deterministic rules wrote COMPOSE guidance into `nextBestCheck`, which is both COMPOSE context and customer fallback text (and S4R's `understood.nextBestCheck`). The guidance is now typed apart (`setNextCheck`); customer output reads only the customer part; a final structural check drops any sentence repeating that turn's guidance. Live S4R probe: guidance in `understood.nextBestCheck` 3/3 before, 0/6 turns after; contract, NDJSON, CORS and Function URL unchanged | 11.1 |
| B. ADR 0017 signed engine fields | **Implemented and enforced.** AC secret `applianceclinic/production/engine-signing`; the orchestrator signs every engine call and whichpart-api the feedback pass-through (HMAC-SHA256 over the exact body, 5-minute window, constant-time compare). Staged: log-only (11.2b–d), evidence, enforcement (11.7), log mode removed (11.8a). A forged unsigned request is answered as plain `{messages}` (verified live) | 11.2a–d, 11.7, 11.8a |
| C. ADR 0014 one conversation state | **Implemented.** The orchestrator's `InMemoryStateStore` is gone; every turn is seeded from the BFF's cs/1 block. Field map: [phase-11-state-ownership](../architecture/phase-11-state-ownership.md) | 11.4 (with 11.3) |
| D1. Repeated follow-up after a conclusion | **Fixed.** The policy counts the follow-ups already given from cs/1; the second is a distinct close with the way forward, the third invites anything new | 11.3a |
| D2. Code versus model near the threshold | **Fixed.** Live evidence: Jev read F06 as model at 0.57, the orchestrator held it, but mc/1 committed `model = F06` to cs/1, and the answer "still error" was recorded nowhere. Now one commit rule (`canonical/token-gate.js`, 0.70 / 0.55) holds a weak reading as `identity.unconfirmedToken` and commits it on the answer; mc/1 is offered near-miss brand spellings; the orchestrator reads make and token from cs/1, forwards the make, and an ambiguous code says what it can mean | 11.3a/b, 11.5, 11.9b |
| E. Runtime overrides | **Explicit and drift-checked.** Every live environment variable is declared (CANONICAL_MODE, the 63 journeys, review settings, LM_MAX_TOKENS, judge model, URLs, tables, buckets; a private tunnel URL by SHA-256 only). Recording was a verified no-op (11.6). `check-overrides-drift.mjs` runs after every runtime change and fails on any difference | 11.6 |
| F. Concurrency | Read-only analysis; **recommended account quota 100** ([phase-11-concurrency](phase-11-concurrency.md)) | owner action |
| Found in the GOLD run on 11.9 | A canonical reply put the decided question as a request and then asked it again (G2-DW-05 failed on it; G2-DW-03 and run 1 showed it too). The compose prompt asks it once (v8) and `checkReply` falls back to the fixed template when a non-question sentence restates the question (compared with the pack's own copy only) | 11.10 |
| Found in the GOLD runs on 11.10 | G2-VAC-03: a check the customer said they did was dropped when Jev could not settle which result (0.99 over the done results, none above 0.45), so the check was concluded as the cause and repeated; now recorded as done with no result. G2-DW-02: the category 'eco / quick programme' was acknowledged as two things the customer used. G2-VAC-06: the filter copy said 'torn' where the customer said 'damaged' | 11.11 |
| Found in the GOLD run on 11.11 | G2-DW-06: "I can't get to the model" while the water-in-base question was pending declined that question (never asked; once an early conclusion); now the question stays unsettled and is re-offered once ("no problem about the model number"). The supply category said "other taps run normally" for "the tap under the sink is on"; now "water supply on" | 11.12 |
| Found in the GOLD run on 11.12 | G2-DW-06: the re-offered question repeated the whole explanation of the turn before (scored as looping); the re-offer is now the frame and the question, and the frame says the missing model only limits part fit | 11.13 |
| Found in the final journeys | A volunteered "already cleaned" filter concluded "blocked filter" on turn 1 (a fix check done with no result now counts as a failed fix when the fault persists); an ambiguous code repeated itself (now gives the documented meanings) | 11.9a/b |

## State ownership, before and after

- **Before:** seven representations of conversation state on one turn (Phase 10 audit), including the orchestrator's per-container store with latches, keyed differently from cs/1, advancing on degraded turns.
- **After:** cs/1 (engine merges, BFF stores) is the only conversation state. The orchestrator writes nothing that survives a turn; two orchestrator instances given the same request decide identically (tested). The code-or-model decision has one owner (the merge), read by the orchestrator. Updated diagrams: [as-built, After Phase 11](../architecture/as-built.md#after-phase-11-releases-1111113); [target](../architecture/target.md) T6 and T7 done. ADR 0014 and ADR 0017 are Implemented.

## Pull requests

| PR | Change | Merge commit |
|---|---|---|
| #97 | 11.1 F15 legacy guidance | `51e624c` |
| #98 | 11.2 ADR 0017 signing, log-only stage | `783c3ae` |
| #99 | 11.3–11.5 one conversation state; code-or-model; follow-up | `8c22f5b` |
| #100 | 11.6–11.8 explicit overrides + drift check; ADR 0017 enforced; GOLD-v2.4 | `c7c6516` |
| #101 | 11.9 fixes from the post-release journeys | `8b5e8e6` |
| #102 | 11.10 the decided question asked once (found by the second final GOLD run) | `2718d54` |
| #103 | 11.11–11.13 GOLD final-gate fixes (unsettled check results; a model reply is not a refusal; faithful category copy) | `505828c` |
| this | Phase 11 documentation | — |

## Releases

Every release ran through `change.sh` (checked change set, temporary least-privilege grant, drift IN_SYNC, no-op confirmed, live code or image equal to the build reference; from 11.7 also the overrides drift check). Engine releases were treated as S4R-sensitive: `/part-finder` contract, ingress, smoke 4/4 and S4R health 3×200 before and after each. No S4R-owned resource was touched.

| Release | Function(s) | CloudTrail |
|---|---|---|
| 11.1 | part-finder | ok |
| 11.2a | AcDataStack secret | ok |
| 11.2b | part-finder (log-only verifier) | ok |
| 11.2c | orchestrator image (signer) | ok |
| 11.2d | whichpart-api (feedback signer) | ok |
| 11.3a | part-finder (token gate, candidates, follow-up) | ok |
| 11.3b | whichpart-api (cs/1 merge copy) | ok |
| 11.4 | orchestrator image (ADR 0014) | ok |
| 11.5 | orchestrator image (forward make) | ok |
| 11.6 | record-only (no-op) | n/a |
| 11.7 | part-finder environment (enforce) | ok |
| 11.8a | part-finder (enforcement unconditional) | ok |
| 11.8b | whichpart-api (GOLD-v2.4 stamp) | ok |
| 11.9a | part-finder (volunteered fix check) | ok |
| 11.9b | orchestrator image (ambiguous code) | ok |
| 11.10 | part-finder (COMPOSE asks the decided question once) | ok |
| 11.11 | part-finder (mc/1 unsettled check result; category copy) | ok |
| 11.12 | part-finder (a model reply is not a refusal; supply copy) | ok |
| 11.12b | whichpart-api (its copy of merge / requests for the recovery replay) | ok |
| 11.13 | part-finder (re-offer after a model reply: frame and question only) | ok |

11.2b–d were split per function: the read-only base plus a three-function grant exceeds the 6,144-character managed-policy limit, and the guard stopped the combined change before anything was sent.

## Regression and contract tests added

| Suite | Count | Covers |
|---|---|---|
| `services/part-finder/test/f15-legacy-guidance-leak.test.mjs` | 8 | F15 (real shape), every guidance-bearing rule, stale guidance, understand-authored checks |
| `services/part-finder/test/engine-auth.test.mjs` | 12 | valid / tampered / wrong-key / stale / malformed; unsigned dropped; fails closed; S4R `{messages}` untouched; Python signer vector |
| `orchestration/tests/test_engine_signing.py` | 8 | orchestrator signs the exact bytes, re-signs on retry |
| `services/part-finder/test/phase11-code-or-model.test.mjs` | 9 | obvious code, obvious model, ambiguous token, the answer, correction, pre-Phase-11 state, misspelt brand |
| `services/part-finder/test/phase11-follow-up.test.mjs` | 8 | D1 follow-ups; volunteered "already cleaned" |
| `orchestration/tests/test_one_conversation_state.py` | 27 | volunteered facts, not sure, corrections, code-vs-model, misspelt brand + code, identity progression, failed turn, two instances, ambiguous code |
| `services/part-finder/test/canonical-dw4-not-cleaning.test.mjs` | +1 | the decided question restated as a request falls back to the template |
| `services/part-finder/test/canonical-vac-family.test.mjs` | +3 | an unsettled check result is recorded as done; an answer that does not say it was done is not; the journey moves on |
| `services/part-finder/test/phase10-transcript-regressions.test.mjs` | tightened | a damaged filter is never described as torn |
| `services/part-finder/test/canonical-dw2-not-filling.test.mjs` | +3 | a model reply re-offers the pending question instead of declining it; a direct cannot-answer still settles; the supply category says only that the supply is on |
| `tools/migration/test/overrides-drift.test.js` | 6 | drift kinds, no values in findings, staged code hash, routing lease |

Runtime suite: 182/197 (the 15 known failures). Tooling 788/788. Typecheck and lint clean.

## Transcript review (live, final build)

Six realistic journeys through the public AC path on the final build, ended so the production transcript judge reviews them. Both the judge and the conversations were read.

| Journey | Shape | Judge | Our reading |
|---|---|---|---|
| not-sure | "not sure" answers mid-journey | good / useful_outcome | Accepts "not sure", moves to the next owner check, no repeat |
| straightforward | clear symptom to an owner check and conclusion | good / useful_outcome | Direct and short |
| code-then-symptom | displayed code, then the symptom | good / insufficient_evidence | Code acknowledged, symptom used; ends before a conclusion by design |
| conclusion-follow-up | conclusion, then "ok" / "thanks" / "anything else?" | good / useful_outcome | Each follow-up different (D1); no conclusion repeated |
| volunteered-fact | model and an already-cleaned filter volunteered up front | good / useful_outcome | Volunteered facts kept; the already-done check is not asked again (11.9a) |
| code-or-model | "F06 Horpoint washing machine" | insufficient_evidence / partial_outcome | One clarification (code or model?); the answer is committed as the code with the make Hotpoint; the two documented meanings are given and a repeat says what would settle it. The judge's rating reflects a three-turn journey with no conclusion; it raised no concerns. Minor: both F06 meanings are door-lock faults and the reply lists them verbatim rather than saying they agree |

The journeys ran on the 11.9 build. 11.10 (COMPOSE question guard), 11.11 (unsettled check results, category copy) 11.12 / 11.12b (a model reply is not a refusal) and 11.13 (re-offer copy) change canonical modules only; the two GOLD runs below exercise them on all 56 scenarios.

## GOLD

Suite audit: [phase-11-gold-audit](phase-11-gold-audit.md). **GOLD-v2.4, 56 scenarios** (GOLD-v2.3 plus G2-MW-06 for the D1 shape; nothing removed or rewritten; rubric v3 and pass rule unchanged).

Every GOLD run in Phase 11, in order (per-run evidence: [phase-11/gold-runs.json](phase-11/gold-runs.json)). A failure was never re-run away: each one was read, traced to a product defect, fixed at its layer with a regression test, released, and the pair restarted on the new build.

| Run | Build | Result | Failure found and fixed |
|---|---|---|---|
| 1 | 11.8b | 56/56 | — |
| 2 | 11.9 | 56/56 | — |
| 3 | 11.9 | 55/56 | G2-DW-05: the decided question put as a request, then asked again → 11.10 |
| 4 | 11.10 | 55/56 | G2-VAC-06: "torn" in the filter copy → 11.11 (and G2-VAC-03, read alongside: a check the customer did was dropped → 11.11) |
| 5 | 11.10 | 55/56 | G2-DW-02: "eco / quick" category restated as two things → 11.11 |
| 6 | 11.11 | 55/56 | G2-DW-06: a model reply declined the pending question; supply copy "other taps" → 11.12 (second run stopped) |
| 7 | 11.12 | 56/56 | — |
| 8 | 11.12 | 55/56 | G2-DW-06: the re-offer repeated the explanation (looping) → 11.13 |
| **9** | **11.13 / 11.12b** | **56/56** | 0 critical; mean score 3.46, minimum 2.7 |
| **10** | **11.13 / 11.12b** | **56/56** | 0 critical; mean score 3.44, minimum 2.7 |

**Final: GOLD-v2.4 56/56 PASS twice in a row on the final build (`e666714`).** The conversations behind the late fixes were read in run 10 as well: G2-DW-06 re-offers the question once, short, with the honest model limit; G2-VAC-03 moves on after the customer's check and treats the burning smell as stop-use.

## Final production state

| Check | Result |
|---|---|
| part-finder code | `H+9o5M9h7tMne1yBTKILhattn8KDpwDXTT90BN3qiwI=` (11.13) |
| whichpart-api code | `IUTJtrmSvJpeov8Xa7HwnfRnYFsCaqPJa/XGiGsvVwc=` (11.12b) |
| orchestrator image | `sha256:af9c87d325c4…` (11.9b) |
| error-code MCP image | unchanged in Phase 11 |
| `/part-finder` contract, ingress, smoke | ok, ok, 4/4 equal to the pre-Phase-5 baseline |
| S4R health | 3×200 (page, page, catalogue search) |
| AC endpoints / AC auth / service bearers | 8/8 / 13/13 / 5/5 PASS |
| Drift | AcAuthStack, AcRuntimeStack, AcDataStack, ApplianceClinicToolkit all IN_SYNC |
| Runtime overrides | `check-overrides-drift`: ok, 0 findings; routing lease released |
| CloudTrail | every Phase 11 release ok (11.6 was a no-op) |

## Concurrency

The account pool is 10 and saturated: S4R's server alone fills it (2,017 throttles in 30 days), AC was throttled 59 times. **Recommended account quota: 100 concurrent executions.** No reserved concurrency was configured. Details and the exact request: [phase-11-concurrency](phase-11-concurrency.md).

## Remaining debt

| Item | Note |
|---|---|
| Account Lambda concurrency 10 | **The only owner action:** request 100 (command in the concurrency doc) |
| A second model ask after a code that stays ambiguous | Seen in the code-typo journey (turn 4); a model ask after an earlier unanswered one. Not a regression |
| Vacuum not-running with an uncertain charge (G2-VAC-05) | Passes at 2.7: after "not sure" the blockage check is offered again inside the conclusion. No defect found at the understanding or policy layer; a wording improvement for a later phase |
| Vacuum type asked when the model implies it (G2-VAC-03) | "Vax ONEPWR" is cordless, yet the belt question asks corded / cordless / robot; the model token is not used to infer the type |
| Owner precaution on a model-only ask (legacy engine) | A water-spill precaution prepended to a reply that only asks for the model on a door-lock code |
| Engine signing key in Lambda environments | The same pattern as the service bearers (dynamic references); a runtime secret fetch would avoid exposing it to `lambda:GetFunctionConfiguration` |
| Enrichment cause fragments in the data (T10), one safety-copy source (T9), code-to-journey bridge (T8) | Planned in the target architecture |
