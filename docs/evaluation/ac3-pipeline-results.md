# ac3 pipeline: independent evaluation (releases 21.5 to 21.16)

[ADR 0021](../adr/0021-understand-label-enrich-decide-reply.md) replaced the first rebuild's single reasoning pass and
claim verifier ([ADR 0020](../adr/0020-llm-led-diagnosis-with-deterministic-guardrails.md), "ac2") with a pipeline of
small jobs: Qwen understands, Jev labels, tools enrich, code decides the plan, Qwen replies ("ac3"). This page is the
evaluation of that pipeline on the same frozen 100 cases, at four releases: the baseline (21.5), an interim release
(21.7), the last release before the reasoning step was restored (21.9), and 21.11, which restored the first rebuild's
reasoning step and claim check inside the pipeline.

## Method

The [first rebuild's method](llm-led-rebuild.md#method), unchanged: same cases, same customer simulator, same judges,
prompts, rubric and critical-failure definitions, same harness (`evaluation/rebuild/`).

| | |
|---|---|
| **System** | **Live pipeline (ac3)** on live production through the service-authenticated benchmark path, reasoning with the production model (Qwen 3.6 35B-A3B on LM Studio) and Jev |
| **Cases** | `evaluation/independent-100/cases.json` (sha256 `f212047f…`, unchanged since its freeze) |
| **Customer** | `claude-sonnet-5-5`, answering only from each case's fact bank, up to 8 customer messages |
| **Judges** | Primary `claude-fable-5-1`; second `claude-sonnet-5-5` on every transcript with a critical flag, every disagreement and a 10% sample. Transcripts masked; pairwise order seeded |
| **Baselines** | First rebuild (ac2), journeys (old AC) and the general assistant: their frozen runs and judgements, unchanged (checked equal after this analysis) |
| **Development** | The independent 100 was used as development evidence between releases, by failure class only. It is not a held-out result |

### What is kept from each run

| Release | Live code | Run | What survives |
|---|---|---|---|
| **21.5** (baseline) | Advice memory | 2026-10-13, all 100 | Headline only: **overall 2.32**, and the failure classes behind it (commit `47c8415`, ADR 0021). The conversations and judgements were not committed and are lost |
| **21.7** (interim) | Facts and check results in the record, calibrated replies | 2026-10-13, all 100 | Headline only: **overall 2.48**, **14 blocking loops** (commit `b68d7a5`, ADR 0021). Conversations and judgements lost |
| **21.9** | No copied replies or repeated questions | **Re-run** 2026-10-13 15:19–16:20 UTC, all 100 | Everything: `evaluation/rebuild/out/independent-100/conversations/ac3/`, `judge/{primary,second,pairwise-ac3-*}/`, `results-independent-100.json` |
| **21.11** | The first rebuild's reasoning step and claim check restored in the pipeline | 2026-10-13 16:24–17:37 UTC, all 100 | Everything: `evaluation/rebuild/out/independent-100-21.11/` (the ac2 baseline is linked, not copied), `results-independent-100-21.11.json` |
| **21.15** | 21.14 (regeneration only within a 26 s budget) and fixes for 21.11's judged failures | 2026-10-13 19:58–21:10 UTC, all 100 | `out/independent-100-21.15/`, `results-independent-100-21.15.json` |
| **21.16** | Fixes for 21.15's judged failures | 2026-10-13 21:42–22:53 UTC, all 100 | `out/independent-100-21.16/`, `results-independent-100-21.16.json` |

The original 21.9 run's files were lost with the session that made them, so 21.9 was run again on the same live code
(engine `CodeSha256 AkhERavL…`, verified against `build/reference/applianceclinic-diagnosis-engine.zip.json` before the
run). A re-run is a new sample: the models are not deterministic, so it will not match the lost run case for case.

Harness notes for the re-run: two conversations (TD-08, MW-07) stopped when the customer simulator returned malformed
JSON and were run again from the start; one second-judge reply (VC-10) was malformed and judged again. No AC error
stopped the run (2 explicit engine errors in 348 turns).

## Verdict

**21.16 is the safest and most reliable Appliance Clinic so far, level with the first rebuild on usefulness, and still
well behind the general assistant.** Two rounds of fixes for what the judges flagged (21.15, 21.16) cut conversations
with a critical failure from 25 to 16 (confirmed by the second judge: 18 to 14), harmful outcomes from 1 to 0, unsafe
DIY from 2 to 1 and confident unsupported conclusions from 18 to 8; it wins or ties 52% against the first rebuild. Overall
usefulness moves within run-to-run noise (2.79, 2.68, 2.74: most cases score the same, and the rest move both ways).
The general assistant still wins 86–14.

| | 21.9 | 21.11 | 21.15 | **21.16** | First rebuild (ac2) | General assistant |
|---|---|---|---|---|---|---|
| Overall usefulness (0–4) | 2.37 | 2.79 | 2.68 | **2.74** | 2.73 | 3.48 |
| Resolved or usefully escalated / declined | 72% | 79% | 78% | **83%** | 84% | 91% |
| Conversations with any critical failure | 36 | 25 | 17 | **16** | 24 | 6 |
| …confirmed by the second judge | 26 | 18 | 15 | **14** | 18 | 4 |
| Outcome judged harmful | 1 | 1 | 1 | **0** | 1 | 1 |
| Unsafe DIY (critical) | 5 | 2 | 3 | **1** | 2 | 3 |
| Confident unsupported conclusion (critical) | 12 | 18 | 9 | **8** | 17 | 2 |
| Invented customer evidence | 11% | 4% | 1% | **5%** | 4% | 0% |
| Blocking loops (critical) | 15 | 5 | 3 | **4** | 5 | 0 |
| Pairwise vs general assistant (win–loss) | 10–90 | 12–88 | 16–84 | **14–86** | 17–83 | |
| Pairwise vs first rebuild (win–tie–loss) | 29–4–67 | 44–5–51 | 37–9–54 | **46–6–48** | | |
| Median / 90th percentile turn | 7.5 / 10.3 s | 17.2 / 22.6 s | 16.9 s / – | **18.1 / 22.5 s** | 11.5 / 16.4 s | 16.1 / 21.9 s |

### 21.11

**21.11 was the best Appliance Clinic result at the time, and still not ready.** Restoring the reasoning step and the claim
check lifted the pipeline from 2.37 to **2.79**, past the first rebuild's 2.73, with invented customer evidence back
down from 11% to 4%, looping from 31% to 11% and blocking loops from 15 to 5. Head to head it is level with the first
rebuild (44–5–51) and far behind the general assistant (12–88). It is slower: median turn 17.2 s, 90th percentile
22.6 s.

| | 21.5 | 21.7 | 21.9 (re-run) | **21.11** | First rebuild (ac2) |
|---|---|---|---|---|---|
| Overall usefulness (0–4) | 2.32 | 2.48 | 2.37 | **2.79** | 2.73 |
| Invented customer evidence | | | 11% | **4%** | 4% |
| Looping | | | 31% | **11%** | 11% |
| Blocking loops (critical) | | 14 | 15 | **5** | 5 |
| Unsafe DIY (critical) | | | 5 | **2** | 2 |
| Pairwise vs general assistant (win–loss) | | | 10–90 | **12–88** | 17–83 |
| Median turn latency | | | 7.5 s | **17.2 s** | 11.5 s |

The counts that equal ac2's are coincidences of the totals, not shared judgements: the 21.11 judgements are its own
(none of the 100 judge rationales matches ac2's, and the per-case scores differ).

### Before 21.11

**21.5–21.9 were below the first rebuild, and not ready.** Across the three releases the pipeline moved 2.32 → 2.48 → 2.37: it never
reached the first rebuild's 2.73, and it loses to it head to head (29–4–67). It still clearly beats the journey
architecture (75–1–24) and stays far behind the general assistant (10–90). It is faster (median turn 7.5 s against
11.5 s), but invents more customer evidence (11% against 4%) and loops far more (31% against 11%; 15 blocking loops
against 5).

| | 21.5 | 21.7 | 21.9 (re-run) | First rebuild (ac2) |
|---|---|---|---|---|
| Overall usefulness (0–4) | 2.32 | 2.48 | **2.37** | 2.73 |
| Blocking loops (critical) | | 14 | **15** | 5 |

21.8 and 21.9 targeted the loops 21.7 showed, and the re-run does not show them reduced. The difference between 2.48 and
2.37 is within what one re-run can move, so the honest reading is that 21.7–21.9 sit at about the same level.

## Results (21.9)

Tables generated by `node evaluation/rebuild/report.mjs` from `evaluation/rebuild/results-independent-100.json`.

| | Live pipeline (ac3) | First rebuild (ac2) | Journeys (old AC) | General assistant |
|---|---|---|---|---|
| Conversations judged | 100 | 100 | 100 | 100 |
| Overall usefulness (0–4) | 2.37 | 2.73 | 1.46 | 3.48 |
| Resolved or usefully escalated / declined | 72% | 84% | 43% | 91% |
| Conversations with any critical failure | 36 | 24 | 42 | 6 |
| …confirmed by the second judge | 26 | 18 | 37 | 4 |
| Unsafe DIY instruction (critical) | 5 | 2 | 1 | 3 |
| Outcome judged harmful | 1 | 1 | 4 | 1 |
| Invented customer evidence | 11% | 4% | 19% | 0% |
| Looping | 31% | 11% | 38% | 1% |
| Recommended a part | 12% | 22% | 2% | 31% |
| Unnecessary part | 3% | 5% | 0% | 1% |
| Median turn latency | 7.5 s | 11.5 s | 2.8 s | 16.1 s |
| 90th percentile turn latency | 10.3 s | 16.4 s | 3.9 s | 21.9 s |

| Dimension (0–4) | Live pipeline (ac3) | First rebuild (ac2) | Journeys (old AC) | General assistant |
|---|---|---|---|---|
| safety | 3.15 | 3.28 | 3.02 | 3.50 |
| fidelity | 2.63 | 3.22 | 1.66 | 3.82 |
| noFabrication | 3.43 | 3.73 | 3.18 | 3.93 |
| diagnosticUsefulness | 2.44 | 2.76 | 1.36 | 3.60 |
| questionQuality | 2.06 | 2.42 | 1.38 | 3.09 |
| calibration | 2.54 | 2.77 | 1.91 | 3.30 |
| noRepetition | 2.81 | 3.41 | 2.60 | 3.85 |
| escalation | 2.71 | 3.04 | 2.10 | 3.59 |
| partQuality | 3.44 | 3.59 | 3.72 | 3.63 |
| languageUnderstanding | 2.90 | 3.19 | 1.97 | 3.80 |
| overall | 2.37 | 2.73 | 1.46 | 3.48 |

| Pairwise (blind) | first | tie | second | n | first win or tie |
|---|---|---|---|---|---|
| Live pipeline (ac3) vs General assistant | 10 | 0 | 90 | 100 | 10% |
| Live pipeline (ac3) vs First rebuild (ac2) | 29 | 4 | 67 | 100 | 33% |
| Live pipeline (ac3) vs Journeys (old AC) | 75 | 1 | 24 | 100 | 76% |
| First rebuild (ac2) vs General assistant | 17 | 0 | 83 | 100 | 17% |
| Journeys (old AC) vs General assistant | 6 | 0 | 94 | 100 | 6% |
| First rebuild (ac2) vs Journeys (old AC) | 83 | 0 | 17 | 100 | 83% |

| Critical failure (conversations) | Live pipeline (ac3) | First rebuild (ac2) | Journeys (old AC) | General assistant |
|---|---|---|---|---|
| unsafeDiy | 5 | 2 | 1 | 3 |
| missingSafetyStop | 1 | 2 | 2 | 1 |
| inventedEvidence | 11 | 4 | 19 | 0 |
| confidentUnsupported | 12 | 17 | 11 | 2 |
| unjustifiedPart | 3 | 5 | 0 | 1 |
| compatibilityWithoutEvidence | 0 | 1 | 0 | 0 |
| blockingLoop | 15 | 5 | 26 | 0 |

Pipeline audit: 348 turns, 2 explicit errors, about 2 model calls per turn; final-check gates: certainty softened 27,
unsafe request 8, step precaution 8, copied earlier reply rewritten 5, prohibited advice 5, unsafe reassurance 4,
unverified identifier 4; part gate: none 321, no catalogue part 10, verified 4. Evaluation cost of the re-run: judges
$97.88, simulator $7.29.

## What the judges found

**Invented customer evidence (11 conversations)** is almost always the same sentence shape: the reply opens by crediting
the customer with a check or result they never reported. "Since you've already confirmed the drain and seals are fine"
(FF-01: the customer asked where the drain was); "Since you have already checked the water supply and cleaned the
condenser" (WD-03: the customer only said they could try); "Since the error persists despite cleaning the sump area"
(TD-09). The record was right in these cases; the reply model wrote past it. The pipeline has no check on claims about
the customer, which the first rebuild's claim verifier was built to catch.

**Blocking loops (15)** come in three forms:
- asking again for something already answered or unanswerable: the model number (DW-08, HB-07, TD-11), the appliance's
  age (MW-06), a programme the customer said they could not identify (WM-09), a fan symbol (OC-10);
- the same check given turn after turn (TD-10: the same lint-filter instruction in five replies; WM-11);
- the same fixed safety card repeated after the customer has answered it (MW-08, OC-06, WD-07).

**Unsafe DIY (5)** includes two step orders that put the customer at risk around water (DW-03, WM-05: "switch it off at
the wall" where the socket is in the wet area), testing a cable with the vacuum switched on (VC-09), checking terminals
at a spur (DW-10), and running a recall-affected dryer to test it (TD-01).

## Results (21.11)

The reasoner (ADR 0020) reasons over the ac3 record and the plan and writes the reply; the claim verifier removes
customer-specific claims the record does not support, with one regeneration ([ADR 0021 amendment](../adr/0021-understand-label-enrich-decide-reply.md#amendment-change-2111-2026-10-13)).
Tables generated by `node evaluation/rebuild/report.mjs independent-100-21.11`.

| | Live pipeline (ac3, 21.11) | First rebuild (ac2) | Journeys (old AC) | General assistant |
|---|---|---|---|---|
| Conversations judged | 100 | 100 | 100 | 100 |
| Overall usefulness (0–4) | 2.79 | 2.73 | 1.46 | 3.48 |
| Resolved or usefully escalated / declined | 79% | 84% | 43% | 91% |
| Conversations with any critical failure | 25 | 24 | 42 | 6 |
| …confirmed by the second judge | 18 | 18 | 37 | 4 |
| Unsafe DIY instruction (critical) | 2 | 2 | 1 | 3 |
| Outcome judged harmful | 1 | 1 | 4 | 1 |
| Invented customer evidence | 4% | 4% | 19% | 0% |
| Looping | 11% | 11% | 38% | 1% |
| Recommended a part | 20% | 22% | 2% | 31% |
| Unnecessary part | 6% | 5% | 0% | 1% |
| Median turn latency | 17.2 s | 11.5 s | 2.8 s | 16.1 s |
| 90th percentile turn latency | 22.6 s | 16.4 s | 3.9 s | 21.9 s |

| Dimension (0–4) | Live pipeline (ac3, 21.11) | First rebuild (ac2) | Journeys (old AC) | General assistant |
|---|---|---|---|---|
| safety | 3.37 | 3.28 | 3.02 | 3.50 |
| fidelity | 3.10 | 3.22 | 1.66 | 3.82 |
| noFabrication | 3.65 | 3.73 | 3.18 | 3.93 |
| diagnosticUsefulness | 2.74 | 2.76 | 1.36 | 3.60 |
| questionQuality | 2.45 | 2.42 | 1.38 | 3.09 |
| calibration | 2.63 | 2.77 | 1.91 | 3.30 |
| noRepetition | 3.44 | 3.41 | 2.60 | 3.85 |
| escalation | 3.03 | 3.04 | 2.10 | 3.59 |
| partQuality | 3.39 | 3.59 | 3.72 | 3.63 |
| languageUnderstanding | 3.21 | 3.19 | 1.97 | 3.80 |
| overall | 2.79 | 2.73 | 1.46 | 3.48 |

| Pairwise (blind) | first | tie | second | n | first win or tie |
|---|---|---|---|---|---|
| Live pipeline (ac3, 21.11) vs General assistant | 12 | 0 | 88 | 100 | 12% |
| Live pipeline (ac3, 21.11) vs First rebuild (ac2) | 44 | 5 | 51 | 100 | 49% |
| Live pipeline (ac3, 21.11) vs Journeys (old AC) | 77 | 1 | 22 | 100 | 78% |

| Critical failure (conversations) | Live pipeline (ac3, 21.11) | First rebuild (ac2) | Journeys (old AC) | General assistant |
|---|---|---|---|---|
| unsafeDiy | 2 | 2 | 1 | 3 |
| missingSafetyStop | 1 | 2 | 2 | 1 |
| inventedEvidence | 4 | 4 | 19 | 0 |
| confidentUnsupported | 18 | 17 | 11 | 2 |
| unjustifiedPart | 6 | 5 | 0 | 1 |
| compatibilityWithoutEvidence | 1 | 1 | 0 | 0 |
| blockingLoop | 5 | 5 | 26 | 0 |

**The claim check runs on live.** The benchmark audit cannot show it: whichpart-api's transcript audit still fixes
`claimsChecked`, `claimsRejected` and `regenerated` at their ac3 values, a follow-up. The engine's own logs over the
run's period show 300 turns, 369 claims checked, 5 regenerations and a mean claim-check time of 2.3 s, with rejections
of the kind 21.9 failed on (for example "…confirm your automatic defrost system has stopped working", which no check had
shown). Pipeline audit: 295 turns, 3 explicit errors; final-check gates: certainty softened 46, step precaution 12,
unverified identifier 7, unsafe request 6, prohibited advice 4, unsafe reassurance 2. Evaluation cost: judges $96.85,
simulator $6.61.

Harness notes: two conversations (FF-01, FF-11) stopped on malformed simulator JSON and were run again from the start.
The error-code service was moved to a new function (changes 22.1a–22.2) after the run, so 21.11 was evaluated against
the unrepaired error-code catalogue, as 21.9 was.

## Changes 21.14–21.17

| Change | What | Why (judged evidence) |
|---|---|---|
| 21.14 | The one regeneration runs only when another reasoning pass and claim check fit within 26 s; otherwise the claim check's clean-up stands | Every turn over whichpart-api's 28 s wait after 21.11 was a regeneration turn |
| 21.15 | Water near the plug: isolate at the consumer unit, never the plug; the safety gate's warning test must govern the advice itself. No buying or ordering a part before the fault is narrowed; no "there is no recall"; more certainty softened | 21.11: WM-05, DW-03 (unplug near water), VC-10, WM-06 (buy a part before any check), TD-01 (no recall claimed for a recalled dryer), 18 confident unsupported conclusions |
| 21.16 | Replacing a component before a check confirms it becomes checking it; no advice to remove a glass hob top, casing or motor housing; no switching off at the machine near water; more certainty softened | 21.15: TD-09, TD-10, WM-11 (replace before confirmed), HB-07, VC-05 (dismantling), WM-05 |
| 21.17 | whichpart-api waits up to 45 s for the engine (CloudFront allows 120 s) | After 21.14 no regeneration ran long, but a slow single reasoning pass (17–19 s) still took 4 of 470 turns past 28 s |

All are final-check or plan changes in code (ADR 0021 steps 7 and 9); none adds a fixed reply.

## What follows

- **Latency.** The reasoner and the claim extractor add about 10 s a turn (median 18.1 s against 7.5 s for 21.9); the reasoning pass alone is 7–19 s on the production model.
- **Wrong diagnoses** are now the main loss: the reasoner settles on a plausible but wrong cause (MW-04: a cracked plate
  instead of the coupler) and the remaining critical classes are small (8 confident unsupported, 6 unjustified part).
- **The gap to the general assistant** (12–88) is unchanged in kind: it asks fewer, better-chosen questions and explains
  more. Nothing here closes it.
