# Phase 12 results

Phase 12 was a small architecture-correctness phase. It fixed two seams where the orchestrator kept its own copy of a
fact the engine owns, and nothing else. Issue: #107.

## Outcome

| Seam | Before | After |
|---|---|---|
| Customer-facing label of a canonical cause | Two vocabularies: the engine's cause keys and the orchestrator's `_CAUSE_LABEL` table (about 240 labels). The table had drifted. Five causes the engine can conclude had no label, so the raw key became `diagnosis.label`: `water-container-full`, `condenser-water-path`, `drain-hose-or-standpipe`, `normal-operating-hum` and `likely-causes` | **The engine owns it.** `canonical/cause-summary.js` holds the reviewed labels (the old table verbatim, plus the five). The journey summary's NextAction carries `conclusion.summary`. The orchestrator passes it through; an unlabelled cause gets no label, never its key. `_CAUSE_LABEL` is deleted |
| Code-or-model decision for an identifier token | Implemented twice: `routing.token_meaning_decision` in Python and `canonical/token-gate.js` in the engine, with mirrored thresholds (0.70 / 0.55) | **The engine owns it.** `token-gate.js` is the only implementation. Understand mode sends `understand.tokenDecision` (`commit` or `uncertain`, a reason, and the token when it is uncertain); the orchestrator routes on it. `token_meaning_decision` is deleted; Python has no token thresholds |

No regular expressions or free-text heuristics were added, and no decision moved into model reasoning.

Two more kinds of defect turned up along the way, and both were fixed at the root:
- **The live check** found an incorrect token commit inside the second seam (12.2c/d, below).
- **The final GOLD gate** found three canonical COMPOSE wording defects outside the seams (12.3, 12.4, below). They
  were fixed because the gate is N/N twice, and each was a real customer-visible defect, not judge noise.

## Found by the live check

The first live code-or-model journey after 12.2 ("F06" with a misspelt brand) asked a generic symptom question instead
of "is F06 a code or the model number?", then repeated its turn-2 answer word for word on turn 3.

**Root cause.**
- Probed five times, Jev's reading of the token alternated between two outcomes:
  - a weak `model` reading (0.54–0.59), which the rule held correctly;
  - `uncertain`: Jev's own uncertain option, or a model pick below its 0.45 confidence floor.
- On `uncertain` the intent carried no model value, so the orchestrator had nothing to ask about.
- Meanwhile mc/1 typed F06 as the model, and cs/1 committed it.

The Python rule behaved the same way, so this was not a regression. It was an incorrect token commit inside the seam
Phase 12 had just given one owner.

**Fix (12.2c/d).**
- The cs/1 gate holds a new token that mc/1 typed as the model when Jev could not place it, just as it holds a weak model reading.
- Unchanged: a token already being answered, and a token already settled (the committed model or an active displayed code).
- `tokenDecision` reports the case as `uncertain` (`meaning_uncertain`) and names the token, and the orchestrator asks about it.
- After the fix, three of three live journeys asked the code-or-model question.

## Found by the final GOLD gate (outside the two seams)

| Scenario | Defect | Fix | Release |
|---|---|---|---|
| G2-DW-06 (failed 2 of 4 runs; also Phase 11 runs 6 and 8) | After "I can't get to the model", the reply opened "Thanks for letting me know about the model number". The prompt had asked COMPOSE to acknowledge the message *and* given it the fixed model re-offer frame | When the re-offer frame is the model frame, it is the acknowledgement: the prompt asks for no second one | 12.3 |
| G2-OC-03 (2 of 5 runs, judged looping) | After "not sure" to the settings check, the conclusion pasted that check's whole explanation again | The rule 11.13 set for a re-offered question: an owner check already asked is referred to ("the check I described earlier comes first"); one never explained is still given in full | 12.4 |
| G2-TD-06 (1 of 5 runs) | The heater conclusion said "With the programme right…" while the programme check was still outstanding | The premise is removed from the fixed copy | 12.4 |

Prompt registry: `diagnosis.canonical.compose` v10 (12.3) and v11 (12.4). Live replays after each release showed
the defect gone.

## Contract and type changes

All changes are additive. S4R never sends `mode` and never reaches either field.

| Field | Producer | Consumer | Type |
|---|---|---|---|
| `canonical.journey.nextAction.conclusion.summary` | engine (`canonical-runtime.js` via `cause-summary.js`) | orchestrator `_flow_canonical` → `diagnosis.label` | `CanonicalConclusion.summary` (`types/canonical.d.ts`) |
| `understand.tokenDecision` `{meaning, decision, reason, token?}` | engine understand mode (`token-gate.js`) | orchestrator `_load` | `TokenDecision`, `UnderstandFrame` (`types/part-finder.d.ts`) |

The rollout was producer first in each case. The engine shipped the field while the deployed orchestrator ignored it;
the orchestrator release that reads it followed.

## Pull requests

| PR | Change | Merge commit |
|---|---|---|
| #108 | Seam 1: the engine owns the cause label; `_CAUSE_LABEL` deleted (12.1a/b) | `b8ef2e2` |
| #109 | Seam 2: the engine owns the token decision; the Python rule deleted (12.2a/b) | `011cbef` |
| #110 | A token Jev could not place is held and named (12.2c/d) | `33b9b2c` |
| #111 | COMPOSE fixes found by the final GOLD gate (12.3, 12.4) | `9fd9772` |
| this | Phase 12 documentation | — |

## Releases

Every release ran through `change.sh`:
- a checked change set;
- a temporary least-privilege grant;
- drift IN_SYNC and no-op confirmed;
- the overrides drift check;
- live code or image equal to the build reference.

Engine releases were treated as S4R-sensitive. The `/part-finder` contract, ingress, smoke 4/4 and S4R health 3×200
were checked before and after each. No S4R-owned resource was touched.

| Release | Function | Artefact | CloudTrail |
|---|---|---|---|
| 12.1a | part-finder | `YbsM6JOC3OB8BG1f5G6B5zKlaTRaf8ZhNsCoXeUmnVg=` | ok |
| 12.1b | orchestrator | `sha256:e8bb59c0…` | ok |
| 12.2a | part-finder | `Kpnj3xVKZ2qadWrnmroEmdisp6AefedLmfGgBwPdBDw=` | ok |
| 12.2b | orchestrator | `sha256:76639a84…` | ok |
| 12.2c | part-finder | `A68hL41xsBDU4pGtjQjX7LjSE+es9kNOCWNvikprmHI=` | ok |
| 12.2d | orchestrator | `sha256:f2851e20…` | ok |
| 12.3 | part-finder | `l+K8zs3IGTX1ZKtiA8wVa8fqZEXFpCr1Ie8o1nwPBoo=` | ok |
| 12.4 | part-finder | `mLevorsxw9iSOMt+gJi9UWF55VvwjHvhmixiAk7d9U4=` | ok |

whichpart-api was not changed.

## Regression tests

| Test | What it pins |
|---|---|
| `services/part-finder/test/phase12-cause-summary.test.mjs` | Every concludable cause has a label. This covers every pack's cause families and every cause the policy code names. A label is text, never a key; an unknown cause gets null. The four drifted causes and `likely-causes` are labelled through real journeys; an existing label is unchanged |
| `services/part-finder/test/phase12-token-decision.test.mjs` | The rule cases. The thresholds exist only in the engine. The handler's understand frame carries the decision for weak, strong and code readings. An unplaced token is held on first mention; the answer turn still commits it as the code; a settled model stays settled |
| `orchestration/tests/test_phase10_identity.py` | The orchestrator routes on the engine's decision, not on the probabilities. A missing decision commits. An engine-held token without a model value is asked about by name. `routing` has no token rule |
| `orchestration/tests/test_canonical_control.py` | The label is passed through; an absent summary gives no label and never a raw key; `_CAUSE_LABEL` is gone |
| `canonical-dw2-not-filling.test.mjs`, `canonical-progression-remediation.test.mjs` | The model frame is the only acknowledgement on that turn, and every other answer is still acknowledged. An owner check already asked is referred to; one never explained is given in full. The replayed TD-06 path concludes without claiming the programme is right |
| `orchestration/tests/engine_token.py` | Offline orchestrator tests get their token decision from `token-gate.js` through Node, so a test cannot drift from the engine |

Runtime suite: 185/200 (the 15 known failures, unchanged). Typecheck ok. Tooling: 792/792. Orchestrator suites green
(`test_clarification_intent.py` fails identically on unmodified code; it is pre-existing and not in CI).

## Transcript review (live, final build)

Journeys through the public site, reviewed by the production transcript judge and read in full.

| Journey | What it checks | Result | Judge |
|---|---|---|---|
| Microwave steady hum, heats fine | A previously unlabelled cause | Reassurance, no part; label **"Normal running hum"** | good |
| Washer-dryer leaks only when drying | Previously unlabelled causes | Drain filter, then drain hose; label **"Drain hose or standpipe"**. The first-round run concluded **"Full water container"** (judge: good) | mixed (see below) |
| "F06" with a misspelt brand (3 runs, after 12.2d) | Ambiguous token | "Is F06 a code showing on the display, or is it the model number?" in 3 of 3. Then the door-lock meaning, or both documented meanings and a request for the model number. No loop | good; mixed; mixed |
| Dishwasher not cleaning, filter full | Straightforward | Filter check, retest, recovered; label **"Dirty filter"** | good |
| The first-round "F06" run (before 12.2c/d) | — | A generic symptom question, then turn 2 repeated word for word: the defect fixed by 12.2c/d | mixed |
| OC-03 and TD-06 replayed (after 12.4) | Gate fixes | The earlier check is referred to, not repeated; no claim that the programme is right | good; good |
| DW-06 replayed twice (after 12.3) | Gate fix | Turn 3 opens with the fixed frame; no "thanks for … the model number" | not concluded (stops at a pending question) |

Nothing reached the customer as a raw cause key, and no token was committed wrongly.

Observations outside the two seams, recorded and not changed:
- In the washer-dryer run, the customer answered the drain-hose question with "full water container warning". The
  journey concluded on the drain hose and treated the container statement as context. The first-round run of the same
  journey concluded "Full water container".
- After the ambiguous-code answer, "what does it mean?" was answered with a request for the model number, prefaced by
  the drain safety line and "thanks for confirming". The judge rated those two runs mixed. This is the Phase 11
  ambiguous-code path, unchanged, and already recorded as debt ("a second model ask can follow an ambiguous code").

## GOLD

GOLD-v2.4, 56 scenarios, rubric `gold-v2-rubric-v3`; the suite is unchanged
([run records](phase-12/gold-runs.json)).

| Build | Run | Result | Failed |
|---|---|---|---|
| `1001446` (12.2a/b) | 1 | 54/56 | G2-DW-06 ("said something they did not"), G2-OC-03 (looping): see "Found by the final GOLD gate" |
| `1001446` | 2 | 56/56 | — |
| `8f121af` (12.2c/d) | 3 | 56/56 | — |
| `8f121af` | 4 | 55/56 | G2-DW-06 again, the same turn-3 acknowledgement: root-caused, fixed in 12.3 |
| `c36a931` (12.3) | 5 | 54/56 | G2-OC-03 again and G2-TD-06: root-caused, fixed in 12.4. DW-06 passed |
| `c36a931` | 6 | 56/56 | — |
| **`185910a` (final, 12.4)** | **7** | **56/56** | — |
| **`185910a`** | **8** | **56/56** | — |

**The final gate is 56/56 in two consecutive runs on the final build** (mean score 3.432 and 3.448; the Phase 11
final pair was 3.457 and 3.436). No run was repeated to get a pass: every failing run was traced to a product defect, fixed, and
followed by a new pair on the new build.

**Suite audit: no scenario added.**
- The ambiguous-token shape is already in the suite as G2-EC-01 ("F05" with a misspelt brand); it passed in all four runs.
- The judge reads replies, not `diagnosis.label`, so a GOLD scenario cannot see a raw label key. The label seam is pinned
  more strongly by the deterministic completeness test over every concludable cause.
- Jev's run-to-run split between weak and uncertain readings is pinned by deterministic gate tests, not by a stochastic
  benchmark.

## Final production state

| Check | Result |
|---|---|
| Drift: AcAuthStack, AcRuntimeStack, AcDataStack, ApplianceClinicToolkit | IN_SYNC |
| Overrides drift (`check-overrides-drift.mjs`) | ok, no findings |
| `/part-finder` contract, ingress, smoke | ok, ok, 4/4 |
| S4R health | 3×200 |
| AC endpoints / auth / service bearers | 8/8, 13/13, 5/5 |

## Other remaining debt seen in Phase 12

Recorded, not changed (outside the phase):
- "The tap under the sink is on" was recorded as the supply being on in only 2 of 4 GOLD runs. Otherwise the reply moved on without acknowledging it (mc/1 recall).
- The fridge "too cold" conclusion opens "With the settings normal…". It has the same shape as the TD-06 premise, but no run showed it while the settings check was outstanding.
- A washer-dryer answer of "full water container warning" to the drain-hose question concluded on the drain hose (judge: mixed).
- After an ambiguous code, "what does it mean?" can get a second model request (Phase 11 debt, unchanged).

## Remaining orchestrator debt

Items 3 to 8 of the [orchestrator review](../architecture/orchestrator-review.md#debt-for-the-next-orchestrator-release)
are unchanged and were deliberately not bundled:
- undeclared request-local attributes (a `TurnContext`);
- dead code;
- repeated call boilerplate;
- the model-identifier tuple written out seven times;
- safety copy mirrored from the engine (target T9);
- splitting `_load` into named steps.
