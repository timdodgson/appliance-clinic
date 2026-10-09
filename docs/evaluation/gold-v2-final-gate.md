# GOLD v2: final gate (Phase 8 exit)

The Phase 8 GOLD gate is **49/49 PASS in two consecutive full runs** of the authoritative suite on the same product.

| | |
|---|---|
| Suite | **GOLD-v2.2**, 49 scenarios, `services/whichpart-api/benchmark/gold-v2/scenarios.v2_2.json` |
| Judge | Jev, prompt **`gold-v2-rubric-v2`** |
| Pass rule | mean ≥ 2.5/4, safety ≥ 3/4, no critical failure, at least half the journey expectations met (unchanged since GOLD-v2.0) |
| Runner | [`tools/gold-v2/run-live.mjs`](../../tools/gold-v2/run-live.mjs): production, signed benchmark path of `POST /api`, concurrency 2 |
| Product | repository `b0d29e5566725fdb5ac1315c0ae7a2e136a01fcd` |

Suite history:
- [GOLD-v2.1](gold-v2-1-changes.md) is GOLD-v2.0 after the value audit: 49 scenarios and rubric v2.
- GOLD-v2.2 corrects G2-WD-04 to washer-dryer facts. The scenario count, judge and pass rule are unchanged.

No scenario, expectation or pass threshold changed during this gate. Every failure below was fixed in the product.

## Final production state

| Unit | Version |
|---|---|
| `spares4repairs-part-finder` (diagnosis Lambda) | CodeSha256 `D7hk7l4EpckgDeU9vj2QAgk6Y6KXGZthwch8sy8T2mY=` (8.13d) |
| `whichpart-api` | CodeSha256 `vwq9/xCE2TK4N+1n5REQ1EOxwym9wK2DnU4M38MHRdg=` (8.11) |
| `spares4repairs-diag-orchestrator` | image `sha256:42543ac4754d4396e701f1456452ebc298f4af265153c050e58282779ed199eb`, arm64 manifest, ECR tag `phase8-robust-084824d` (8.13b) |
| `spares4repairs-error-code-mcp` | code unchanged; Environment only (bearer rotation 8.10c) |
| Prompts | `diagnosis.canonical.compose` v3, `diagnosis.jev.mc1` v8 |

Every release is listed with its checks and CloudTrail result in [gold-v2-remediation-releases.md](gold-v2-remediation-releases.md).

## Runs

| Run | Product | Generated (UTC) | Result | Mean | Failed |
|---|---|---|---|---|---|
| Final run 1 | `0856deb` | 2026-10-09 18:19 | 47/49 | 3.36 | G2-WM-08, G2-DW-05 |
| Final run 2 | `084824d` | 2026-10-09 19:23 | 48/49 | 3.40 | G2-OC-05 |
| **Final run 3** | **`b0d29e5`** | **2026-10-09 20:15** | **49/49** | **3.47** | none |
| **Final run 4** | **`b0d29e5`** | **2026-10-09 20:19** | **49/49** | **3.43** | none |

Runs 3 and 4 are the gate:
- consecutive, on the same product;
- no runner or judge errors, and no critical failure.

The results are kept under `.migration-output/gold-v2/final-run{1..4}/` (`results.json`, `report.md`). They are not in git because they hold full transcripts.

## What failed, and the fix

| Run | Scenario | Cause (product) | Fix |
|---|---|---|---|
| 1 | G2-WM-08 | A grinding noise while draining was ignored. The engine re-asked whether the pump hums, and a prompt instruction leaked into the reply ("you may mention it once") | 8.11:<br>• a noise while draining means the pump is running (merge D4)<br>• the filter stays the next step while it is not done (j1 R7b), and its copy links the noise to the pump or filter<br>• COMPOSE rejects replies that echo prompt scaffolding |
| 1 | G2-DW-05 | A vague second answer got the same open question again. The owner-safety note was added to a describe-the-problem question. A symptom answer was counted as a completed check, which triggered the model ask | 8.12a/b:<br>• a still-vague second turn gets one concrete question about the last use<br>• no safety note when no physical step is asked<br>• a symptom report is not a completed check |
| 1 | G2-WM-08 (follow-up) | The derived pump-running fact was presented as something the customer said | 8.12c: COMPOSE lists only reported evidence |
| 2 | G2-OC-05 | Convoluted check questions. The conclusion did not explain that a working grill does not clear the fan-oven element | 8.13a: one plain question per check, and an evidence reason in the conclusion |

Runs 1 and 2 also showed misses that repeated across runs in scenarios that still passed narrowly. They were fixed rather than accepted:

| Scenario | Repeated miss | Fix |
|---|---|---|
| G2-TD-01, G2-WD-01 | The free fluff-filter check was not offered first | 8.13a: drying journeys lead with it |
| G2-WM-04 | An empty-spin test was asked after a spin-only failure with a silent motor | 8.13a: that test is skipped; a drum-by-hand report counts as done |
| G2-HOB-04 | "it's gas" (identity) was counted as a completed check, which triggered the model ask. "the hobs" read badly | 8.13b: identity, correction and hazard answers are not checks. 8.13a: natural family words |
| G2-DW-03 | "filter looked a bit clogged" was re-offered as "no problem if you haven't had a chance yet" | 8.13c/d: a hedged finding keeps `found_unspecified` (mc/1 v8 and the validator) and is re-offered as "clear it" |

Targeted reruns after each release:

| Release | Targeted result |
|---|---|
| 8.11 | WM-08 3/3 |
| 8.12b | DW-05 3/3, WM-08 3/3 |
| 8.13a/b | 10/10 across the changed journeys |
| 8.13d | DW-03 3/3 |

## History: the 28/50 run

The first live GOLD v2 run was GOLD-v2.0, 50 scenarios, 28/50, recorded in PR #68.
- It was a **diagnostic run**. It triggered the [value audit](gold-v2-value-audit.md) and this remediation.
- It is **not a baseline** and was never accepted as one.
- PR #68 was closed unmerged.
