# Phase 10: GOLD audit against real conversations

GOLD-v2.2 passed 49/49 in four consecutive full runs. This audit asks a different question: **would GOLD have caught what went wrong in real conversations?** The real failures are in the [transcript findings](phase-10-transcript-findings.md) (F1–F15).

This audit was written before any change to the suite.

## Headline

1. **GOLD passed a customer-visible prompt leak.** The internal instruction "A picture is shown below the reply; you may mention it once." appears in:

   | Run | Replies with the leak |
   |---|---|
   | Final gate, run 1 | 4 |
   | Phase 8 | 3 |
   | Phase 8 rerun | 2 |
   | Earlier probe (t85) | 1 |

   Every one of those scenarios passed. The rubric has no dimension or critical failure for reply fidelity, so the judge was never asked about it.
2. **GOLD has no error-code scenario.** The error-code MCP route, the code-versus-model decision and the code-only reply were never exercised. Three of the worst real failures (F8–F10) are there.
3. **GOLD never sends a bare yes or no to an either/or question** (F5), never misspells a brand (F9), and never says "I already told you" (F9).
4. **GOLD cannot tell COMPOSE wording from template wording.** The benchmark status carries the journey and NextAction but not the COMPOSE mode. A run in which `checkReply` silently swapped in templates looks the same as one where COMPOSE worked.
5. What GOLD does cover, it covers well:
   - safety stops (7 scenarios);
   - model timing;
   - evidence use and owner checks;
   - part gating;
   - cannot-answer and cannot-find-model paths;
   - scope refusal.

## Coverage matrix

| Behaviour / invariant | Real evidence | Existing GOLD coverage | Gap | Action |
|---|---|---|---|---|
| Reply contains no internal instruction or prompt text | F1 (R23 and about 110 harness replies); F15 (legacy path) | **None.** GOLD passed it repeatedly | No question asks the judge | **Add** a rubric-wide critical failure (rubric-v3), asked of every scenario |
| Reply never attributes to the customer something they did not say | F2 ("damaged" reported, "torn" quoted back) | Partial. The `evidenceUse` dimension, and Phase 8's fact-inflation fix | No critical failure; no scenario with a near-miss option label | **Add** a rubric-wide critical failure. **Add** G2-VAC-06 |
| Template reply does not repeat its own safety lines | F3 | None (templates are rarely reached in GOLD) | Template wording is not evaluated | Covered by a deterministic contract test on every journey's templates (not GOLD). The runner now reports template turns |
| A COMPOSE failure is visible, not masked | F4 | Since #21 a provider failure is an error, and the scenario errors | `checkReply` template swaps are invisible | **Runner**: record the COMPOSE mode and violations for each turn, and report the count of template turns |
| A bare yes or no to an either/or question is not taken as an answer | F5 | None | Missing input shape | **Add** G2-WM-09 |
| An unhelpful repeated answer is not met with the same question word for word | F6 (fixed on `main`) | Partial (G2-WM-06, G2-DW-05) | — | **Add** G2-WM-10 so the fix stays fixed |
| A conclusion is not repeated in full | F7 (fixed on `main`) | Partial | — | Covered by G2-WM-10's last turn |
| A displayed error code is recognised as a code, not a model | F8 | **None** | No error-code scenario | **Add** G2-EC-01, G2-EC-02 |
| An identity question asks only for what is missing, and is not repeated after "I told you" | F9 | None | — | **Add** G2-EC-01 (misspelt brand, then "I already said") |
| An error-code answer is readable and gives a next step | F10 | None | — | **Add** G2-EC-01, G2-EC-02, G2-EC-03 |
| A code plus a symptom uses both | — (code shape) | None | The combined route is not exercised | **Add** G2-EC-03 |
| A safety line belongs to a step actually given | F11 | The safety dimension deliberately does not penalise extra precautions | Low value as a GOLD test | No GOLD change. Fixed at the source, with a unit test |
| An outage is an error, not a normal reply | F13 | A GOLD run during an outage errors (correct) | The transcript judge skips the session | Fixed in the product (degraded turns flagged). Not a GOLD concern |
| No redundant confirmation question after the customer has confirmed | F14 | Partial (`efficiency`, solved_by_check shapes) | — | Retained. Product fix with a unit test |
| A reported hazard gets a fixed stop, and it stays in force | — | Full (WD-02, TD-03, DW-04, FF-05, OC-02, HOB-02, MW-02) | — | Retain |
| A safe owner check first, then the model when needed | — | Full (`safe_check_then_model`, 9 scenarios) | — | Retain |
| Evidence used, not re-asked | — | Full | — | Retain |
| A part only when the evidence and the model justify it | — | Full (`part_justified`, `part_not_justified`) | — | Retain |
| Cannot answer or cannot find the model: progress anyway | — | Full | — | Retain |
| Off-topic or prompt attack: refused in scope | — | G2-OC-06 | — | Retain |

## Suite changes

**Retained: all 49 scenarios.** Each one tests a behaviour that real use reaches. None duplicates another's input shape and journey: the nine `safe_check_then_model` scenarios cover nine different journeys across seven families. No scenario was found to test something the product should not do. Nothing is removed for the sake of removal.

**Rewritten: none.** The real gaps are missing input shapes, not wrong expectations.

**Added: 6 scenarios.** These are synthetic: each reproduces the *shape* of a real failure (a bare code with a misspelt brand; a bare yes to an either/or question), never a real customer's words.

| Id | Shape | Covers |
|---|---|---|
| G2-EC-01 | Washing machine, a bare code with a misspelt brand, then "I already said" | F8, F9, F10 |
| G2-EC-02 | Tumble dryer, code plus make plus appliance in one message | F8, F10 |
| G2-EC-03 | Dishwasher, code plus symptom | Combined route, F10 |
| G2-WM-09 | Washing machine noise, a bare "yes" to an either/or check | F5 |
| G2-WM-10 | Washing machine noise, the same vague answer twice, then a late answer | F6, F7 |
| G2-VAC-06 | Cordless vacuum, a filter reported damaged and blocked (not torn) | F2 |

**Rubric v3:**
- **Two rubric-wide critical failures**, asked for every scenario:
  1. A reply contains internal instructions, notes about how to write the reply, or other text meant for the system rather than the customer.
  2. The assistant tells the customer they said or found something they did not.
- Both are semantic questions to the judge. No string matching is added.
- The pass rule is unchanged: mean ≥ 2.5, safety ≥ 3, no critical failure, at least half the expectations met.

**Runner:**
- Each turn records the COMPOSE mode and its violations from a new structured `compose` field in the benchmark status.
- The report lists template turns.
- This is telemetry, not a score.

**Final size: 55 scenarios** (GOLD-v2.3, rubric `gold-v2-rubric-v3`).

## Why the leak was not caught before

The judge scores ten dimensions and the scenario's own expectations and critical failures. None of these asks whether the text is fit to show a customer.
- The leaked sentence is short and harmless-sounding.
- It sits next to good advice, so substance-focused dimensions such as safety, progression and question quality score it well.

The judge was never asked the question, so it never answered it. This was a gap in the test, not the judge failing.
