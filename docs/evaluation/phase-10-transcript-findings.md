# Phase 10: real transcript findings

This is a review of real production conversations, traced layer by layer to the code that caused each bad reply. It is the evidence behind the Phase 10 fixes and the [GOLD audit](phase-10-gold-audit.md).

## Privacy

- Sessions are named `R00`–`R35`. Session keys, client ids and timestamps finer than the hour are not published.
- Customer text appears only as short generic appliance phrases ("noisy", "yes"). No customer in these sessions gave personal data.
- The raw records were read from DynamoDB into a private scratch area and never committed.

## Population

| Window | Sessions | Notes |
|---|---|---|
| 2026-09-30 to 2026-10-10 | 4,720 | Almost all are automated harness traffic: session ids carry a harness prefix (`j1-`, `b2*-`, `vp-`, `ty-` …) |
| Real browser sessions | 36 | Session ids with no harness prefix. These are the owner's manual tests and operator smoke checks. There is no third-party customer traffic in the window |
| Canonical era (since 2026-10-05) | 304 turns | 289 canonical-controlled, 15 legacy |

GOLD and benchmark traffic does not write customer transcripts, so it is not part of this population.

Sessions from 2026-10-01 and 2026-10-02 (`R01`–`R20`) ran a pre-canonical build. They are kept as evidence of the legacy path, which still answers any turn that no canonical journey owns.

## How each turn was traced

Each turn's transcript record holds:
- the customer and assistant text;
- the route and outcome;
- the canonical audit: path, journey, the mc/1 classification, the cs/1 state delta, the diagnostic leader, the policy rule, the NextAction, the COMPOSE mode and violations, and the part gate;
- the stage trace.

Where the record was not enough, the turn was traced further:
- **Jev decisions and probabilities:** from the diagnosis-engine CloudWatch log line for the same request.
- **Current-code check:** the typed turns were replayed through the current canonical pipeline (`services/part-finder/canonical/*`) to decide whether the defect still exists on `main`.

## Findings

| # | Session | Symptom | Customer experience problem | Root layer | Root cause | Severity | GOLD would catch? |
|---|---|---|---|---|---|---|---|
| F1 | R23, plus about 110 harness replies from 2026-10-03 to 2026-10-05 and 4 GOLD replies in the final-gate run 1 | The reply contains "A picture is shown below the reply; you may mention it once." | The customer reads an internal instruction meant for the model | COMPOSE prompt contract (`canonical/compose-kit.js` `prompt`) | The media note was written as an instruction inside the content block, and the model sometimes copied it verbatim. Release 8.13 reworded the line ("never copy this line"), and final-gate runs 2–4 show no leak. **Still open:** the only defence is the prompt's wording. `checkReply` has no check that a reply does not echo the prompt's own instructions | High | **No.** GOLD passed it: 4 replies in final-gate run 1, 3 in the Phase 8 run, 2 in the Phase 8 rerun. The rubric has no reply-fidelity dimension or critical failure |
| F2 | R23 | The customer said the filter was "damaged and blocked"; the reply says "the torn filter" | The customer is told they said something they did not say | UNDERSTAND → COMPOSE evidence line | The check answer maps onto the `fault_seen` option, whose label says "torn". COMPOSE receives the option label as the customer's own report | Medium | Partly. The Phase 8 `fact-inflation` fix covers inferred facts but not option labels. No GOLD scenario has a damaged-but-not-torn answer |
| F3 | R25 | The template reply says to switch off and unplug, and to dry the filter for 24 hours, twice each | Repetitive, careless-looking reply | COMPOSE template (`compose-kit.js` `template`) | The template appends every required safety line even when the step's own text already carries it. `checkReply` tests the markers before prepending; `template` does not | Low | No. Template replies appear in GOLD only when COMPOSE fails |
| F4 | R25, R26 (every turn) | `compose.mode = fixed_fallback`, `compose_failed` | The customer got fixed copy with no indication anything was wrong | COMPOSE provider (external) | The COMPOSE endpoint returned 400: the provider account was suspended. **Fixed** before this phase: #21 turns a provider failure into an explicit "AI service unavailable" error. **Still open:** the canonical COMPOSE `catch` discards the error, so the transcript cannot say why | Medium (now observability only) | Yes, since #21: a provider failure is an error in GOLD |
| F5 | R26 turn 5 | An either/or check ("smooth and quiet, or rough?") answered "yes" | The bot treated the question as answered with no result and concluded on a 0-margin, uncommitted leader | UNDERSTAND (mc/1 question) and merge | The `answered` option in `TO_PENDING_OPTIONS` gives "yes" and "no" as examples. Jev follows them for an either/or question. `recordOutcome` then records `answered` even though no check result was recorded. The partial-answer path (one re-offer) never runs | High | No. No GOLD scenario answers an either/or question with a bare yes or no |
| F6 | R26 turns 3–4 | "noisy" given twice to "what does it sound like?" | The same question is re-offered word for word, starting "Next, …" | Policy (old build) | The build of 2026-10-07 re-offered after `ignored`. **Fixed on `main`** (667dbf4): ignored requests are not re-asked, and a repeated conclusion becomes a short follow-up. Replaying the turns on `main` confirms it | — (fixed) | Partly (G2-WM-06 cannot_answer) |
| F7 | R26 turn 6 | The full conclusion is repeated after "no clear" | Repetition | Policy (old build) | As F6. **Fixed on `main`**: the replay gives the short follow-up | — (fixed) | Partly |
| F8 | R29, R30 turn 1 | "F01 Hotpoint tumble dryer" and "F06 Hotpoint washing machine" (the second with a typo in the make) get a generic "tell me more" question | The code the customer gave is ignored | UNDERSTAND (Jev) plus orchestrator identity merge | Jev typed the bare token as a **model** (`candidateTokenMeaning` model 0.72 / 0.60, uncertain 0.18 / 0.27, error_code 0.02 / 0.08). The orchestrator commits any Jev model, whatever its confidence, and cs/1 records `model F06, modelConfirmed true`. With no code, routing goes to `CLARIFY` | High | **No.** GOLD has no error-code scenario at all |
| F9 | R30 turns 2–3 | Asked for "the brand and type" although the type was known. Asked again, word for word, after "I have told you above" | A loop that ignores what the customer said | Orchestrator `_flow_clarify` | The question is one fixed string asking for both fields, whatever `needs` holds. Nothing changes when the same identity question was asked last turn and nothing new arrived. The make is missed because "Horpoint" is not in the brand list | High | No |
| F10 | R30 turn 4 | "F06 … means: Door lock / interlock fault (door stuck / not confirmed). Possible causes include stuck / not confirmed." | Garbled text and a dead end: no next step | Error-code data plus orchestrator code-only composer | `diagnosticHints.likelyCauses` in the generated enrichment is mostly fragments. Of 87 records with causes, 53 are one- or two-word fragments ("off", "short circuit", "stuck / not confirmed"), and others are truncated mid-word. The composer prints them verbatim and asks nothing next | High | No (no error-code scenario) |
| F11 | R29, R30 | A precaution about clearing the lint filter, or towels for spilled water, opens a "tell me more" question, and also opens the error-code answer | A safety line for a step that was never given | Orchestrator `_owner_safety_note` | The note was added to describe-the-problem clarifies. That is **fixed on `main`** (8.12): such turns carry no note. **Still open:** an error-code answer counts as a diagnostic answer, so it gets the note even though it gives no physical step | Low | No. The rubric's safety dimension rightly does not penalise it |
| F12 | R24, R29, R30 | The canonical audit shows journey `wm-not-draining` (`applies: false`) on turns with no journey, including a tumble-dryer turn | Misleading diagnostics; no customer impact | Engine canonical routing (audit field) | When no journey applies, the audit reports the first registry key instead of none | Low (telemetry) | n/a |
| F13 | R21, R22 (2026-10-03) | Every turn: "I can't run the symptom diagnosis right now." | Total outage for the session | Engine availability (Phase 7 role move window) | The orchestrator returned `SERVICE_UNAVAILABLE` on every turn. The BFF shows it as a normal reply (no `error:true`), and the transcript judge never reviewed those sessions (`review: none`) | High (historical); medium (masking still open) | No. GOLD runs are not scheduled; a run during an outage fails as an error, which is correct |
| F14 | R35 turn 3 | The customer says the dishwasher drained properly; the reply concludes, then asks "Is it draining normally now?" | A redundant question | Policy (`A7` conclude with a CONFIRM pending) | After `faultPersists false` from a retest, the policy still issues the resolution confirmation | Low | Partly (G2-WM-03 / G2-TD-04 solved_by_check score it as a minor efficiency issue) |
| F15 | R13, R19 (legacy path, 2026-10-01/02) | "Do not confirm the pump or a jammed impeller; the accessible filter being clear does not prove that." | Internal instruction shown to the customer | Legacy engine progression (`engine/progression.js` `nextBestCheck`) | Instruction text written for the model is placed in a field that can reach the reply. **S4R-sensitive**: the same pipeline serves `/part-finder`. On AC it is reached only on legacy turns | Medium | No |

## Root layers, summarised

| Layer | Findings |
|---|---|
| UNDERSTAND (Jev / mc/1 questions) | F5 (yes/no as "answered"), F8 (code typed as a model, without enough confidence to commit) |
| State merge | F5 (answered with no fact), F8 (a weak model guess committed as confirmed) |
| Policy / NextAction | F14; F6–F7 fixed on `main` |
| Orchestrator legacy flows | F9, F10, F11 |
| COMPOSE contract and template | F1, F2, F3 |
| Data (error-code enrichment) | F10 |
| Observability / masking | F4 (silent catch), F12, F13 |
| Legacy engine (S4R-sensitive) | F15 |

## What the transcript judge missed

The scheduled transcript review rated R23 **good** with the prompt leak in it, R29 **good** with the error code ignored, and gave R21–R22 (total outage) **no review**. It is not a sufficient quality signal on its own. The [GOLD audit](phase-10-gold-audit.md) proposes judge changes for both.
