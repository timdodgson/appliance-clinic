# GOLD v2.3: final gate (Phase 10 exit)

The Phase 10 GOLD gate is **55/55 PASS in two consecutive full runs** of GOLD-v2.3 against the same production build.

| | |
|---|---|
| Suite | **GOLD-v2.3**, 55 scenarios, `services/whichpart-api/benchmark/gold-v2/scenarios.v2_3.json` |
| Judge | Jev, prompt **`gold-v2-rubric-v3`**. This is rubric v2 plus two critical failures asked of every scenario: a reply contains internal instructions; the assistant tells the customer they said something they did not |
| Pass rule | mean ≥ 2.5/4, safety ≥ 3/4, no critical failure, at least half the journey expectations met (unchanged) |
| Runner | [`tools/gold-v2/run-live.mjs`](../../tools/gold-v2/run-live.mjs): production, signed benchmark path, concurrency 2. Template turns are reported per run |
| Product | release 10.12 (repository `d2b4c23`) |

Why the suite changed is set out in the [GOLD audit](phase-10-gold-audit.md):
- six scenarios added from real failure shapes;
- one rewritten (G2-DW-01; the reason is in the scenario's `judgeNotes`);
- none removed.

## Runs

| Run | Build | Result | Mean | Failed |
|---|---|---|---|---|
| Diagnostic | 10.3 | 48/55 | 3.37 | G2-WM-07, G2-DW-06, G2-HOB-03, G2-VAC-05, G2-EC-02, G2-EC-03, G2-WM-10 |
| Gate attempt | 10.5 | 52/55 | n/a | G2-TD-02, G2-DW-01, G2-HOB-03 |
| Gate attempt | 10.8 | 52/55 | 3.39 | G2-MW-04, G2-VAC-05, G2-EC-03 |
| Gate attempt | 10.9 | 53/55 | 3.45 | G2-DW-01, G2-HOB-03 |
| Gate attempt | 10.10 | 54/55, then 54/55 | 3.38 / 3.39 | G2-FF-03; G2-DW-05 |
| **Final run 1** | **10.12** | **55/55** | **3.41** | none |
| **Final run 2** | **10.12** | **55/55** | **3.39** | none |

## What the failures were

Every failure was investigated before anything was changed. Each one was treated as a product defect and fixed at its root layer, with one exception: G2-DW-01's expectation was rewritten instead. The details are in [phase-10-results.md](phase-10-results.md).

- **Reply fidelity (most of them).** COMPOSE restated recorded categories as the customer's words. Examples:
  - "the condenser issue" for a water tank;
  - "the lights are on" for a padlock symbol;
  - "blocked" for "cleaned".
- **Conversation flow:**
  - a code answer repeated after a symptom;
  - a describe question repeated word for word;
  - a volunteered finding (dusty coils) not used;
  - a follow-up that asked a customer who can't check to "let me know what you find".

## Telemetry from the final runs

Template replacements on the final build: 8 turns in run 1 and 5 in run 2. They were:
- `invented-part-or-purchase` on part-recommendation wording;
- `extra-questions`;
- one `tripwire:code`.

All are the deterministic template doing its job.

The two earlier causes are gone:
- `prompt-echo` false positives;
- provider failures (`compose_failed`).

**Mean dimension scores (run 1, out of 4):**

| Dimension | Score |
|---|---|
| Safety | 4.00 |
| Owner suitability | 4.00 |
| Part recommendation | 3.93 |
| Identification timing | 3.82 |
| Understanding | 3.71 |
| Outcome quality | 3.31 |
| Evidence use | 3.00 |
| Efficiency | 2.93 |
| Progression | 2.89 |
| Question quality | 2.56 |

Question quality and progression are the weakest dimensions, and the next place to look.
