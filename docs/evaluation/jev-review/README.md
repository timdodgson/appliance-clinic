# Jev-led review, case by case (2026-10-15)

Release 21.30, AI config `pipeline.mode = jev-led`, Qwen. For each test: every turn's customer message, the options
Jev was offered (situations and next steps), what Jev picked, the reply, and the case's hidden truth.
`<ID>.txt` is the readable review (made by `review.py` from `<ID>.json`, the raw conversation with its audit).

| Test | Jev's picks | What went wrong |
|---|---|---|
| WM-01 (Bosch E18, water in drum) | right cause, right checks; fixed in 3 messages | options duplicated (same cause in two wordings); unrelated fill/overheating steps offered; "floor got wet" pulled in leak notes |
| WM-02 ("w/m wont spinn", one bath mat) | right: normal out-of-balance from turn 2 | Qwen's question answers wrong (turn 5: "run the mat on its own" - the opposite of the fix); a note step out of context ("change that (switch the option off...)"); drain options kept after the drum was empty |
| WM-03 (Indesit drum never turns; truth: worn carbon brushes) | turn 1 wrong (water-level sensing); then the drive belt throughout | turn 1 notes retrieved on "fills ... drains" were fill faults; no carbon-brush check among the options; Jev ignored "no motor noise at all"; it offered and picked a spin-settings check after the customer said the drum never turns |
| WM-04 (Samsung 4C, dry drum; truth: blocked inlet mesh) | turn 1 "power-cycle/reset" though the code meant water supply; then tap, then inlet mesh; fixed | Qwen's answer in turn 2 was nonsense ("you have not specified what 'that' refers to") |
| WM-05 (Beko leak near socket; truth: torn seal + underwire) | safety handled first; wavered between door seal and filter cap (picked the cap after "water at the front, under the door"); seal found; part shown | a cause flip-flop the customer's words did not support |
| WM-06 (Bosch FD 9409, filter cleaned, pump hums) | drain pump; part flow; no catalogue match | moved to the part after one answer; never said FD 9409 is a production code, not a model |
| WM-07 (AEG Eco 40-60 takes 3:39; normal) | right: normal from turn 1 | next steps kept proposing 60 °C heating tests the customer did not need |
| WM-08 (power trips on washes; truth: element leakage) | safety stop on turn 1 (no Jev choice) | correct |
| WM-09 (LG OE, customer refuses to open the filter) | pump filter throughout | Jev kept choosing filter steps the customer refused; Qwen said "stop using it, call an LG engineer" in a drain case |
| WM-10 (rumble on spin; truth: worn bearings) | right: bearings by turn 2, drum play check | after the diagnosis was settled, picked an empty spin test; part not in catalogue |

## Patterns across tests 1-10

1. **Jev's cause pick is usually right** when the right cause is among the options (8 of 9 cases that reached a choice).
2. **Jev's next-step pick is the weak part**: steps the customer refused (WM-09), already contradicted (WM-03 settings), not needed once the
   cause is settled (WM-07, WM-10), or not matching the code meaning (WM-04).
3. **The options are noisy**: the same cause in two wordings, steps from unrelated notes, notes pulled in by stray words (WM-01 leak,
   WM-03 fill).
4. **Missing options**: the decisive check is sometimes not in any note (WM-03 carbon brushes).
5. **Qwen's answers to the customer's direct questions are often poor or wrong** (WM-02, WM-04, WM-09).
6. **Note text written for a sequence reads badly on its own** ("change that (switch the option off...)").

## Round 2 (release 21.31: one note, clean options, done/refused/pointless steps removed, settled findings end the diagnosis)

Reviews in `round2/`. Customer messages to the end, round 1 → round 2:

| Test | R1 | R2 | Change |
|---|---|---|---|
| WM-01 | 3, fixed | 3, fixed | same; turn 2 recognised the finding ("settled") and went straight to the re-test |
| WM-02 | 5, fixed | **3**, fixed | better: normal out-of-balance by turn 2, no wrong advice to run the mat alone |
| WM-03 | 5, escalated | 3, escalated | turn 1 picked the drive belt (truth: brushes; still no brush check in the note); safety stop on the old smell |
| WM-04 | 4, fixed | **3**, fixed | better: supply → inlet mesh, no "power-cycle" pick |
| WM-05 | 7, part shown | **4, loop** | worse: the leak notes' cause lists are not causes ("leak location / cycle stage...", "check the door seal folds...") and, with no steps left, the fallback "tell me a bit more" repeated |
| WM-06 | 2, part path | **1, engineer** | worse: "needs an engineer" was allowed because the customer had cleaned the filter, and Jev chose it on the first reply |
| WM-07 | 4 | **6** | worse: Jev kept a 60 °C test in play; Qwen's answers argued for it |
| WM-08 | safety stop | safety stop | same |
| WM-09 | 5 | **7, stuck** | worse: the customer's refusal now removes the filter steps (good), but questions they had already answered were asked again and it ended on "tell me a bit more" |
| WM-10 | 5, part path | 5, part path | same outcome; turn 1 started at load imbalance |

What round 2 shows:
1. The filtering works for checks (WM-09 refused filter steps removed; WM-01, WM-02 and WM-04 shorter).
2. **"Already answered" is not caught for questions** (WM-09 turns 5-7).
3. **Some notes' cause lists are not causes** (leak-flood, leak-door): Jev has nothing proper to pick.
4. **The fallback "tell me a bit more" loops** when no step is left: it needs a real end (engineer, or a summary).
5. **"Needs an engineer" opens too early**: one reported check is not enough.
6. Qwen's answers to direct questions still pull the wrong way (WM-07, WM-02 turn 1).

## Round 3 (release 21.32), run twice: LLM = Qwen, and LLM = Claude Opus 5.5

Reviews in `round3-qwen/` and `round3-opus/` (each turn now shows every step: what the LLM understood, Jev's labels,
the notes found, each step's done/refused/pointless verdict, Jev's picks, the LLM's answer, the reply).

| Test | R2 (Qwen) | R3 Qwen | R3 Opus |
|---|---|---|---|
| WM-01 | 3, fixed | 3, fixed | 3, fixed |
| WM-02 | 3, fixed | 4, **engineer** | 4, **engineer** |
| WM-03 | 3, safety stop | 4, safety stop | 4, safety stop |
| WM-04 | 3, fixed | 4, fixed | **3, fixed** |
| WM-05 | 4, loop | 7, engineer | 7, **seal found** |
| WM-06 | 1, engineer | 1, engineer | 1, engineer |
| WM-07 | 6 | 4 | 5, stuck |
| WM-08 | safety stop | safety stop | safety stop |
| WM-09 | 7, stuck | 5, engineer | 6, engineer |
| WM-10 | 5, part path | **8, turn limit** | 5, part path |

What round 3 shows:
1. **The LLM's answers to direct questions matter, and Opus is much better at them.** Qwen ignored the customer's
   question at the fuse box three times (WM-05) and looped "it depends on an empty spin" for five turns (WM-10). Opus
   answered each plainly and the conversations ended where they should (seal found; part path).
2. **Bug: a normal-behaviour case is not closed.** In WM-02 Jev settled on "normal out-of-balance" (settled = true),
   but the code only ends on a settled *cause*, so it kept giving checks and then the engineer line, on both models.
3. **Bug: "needs an engineer" still on the first reply** in WM-06 (the gate counts the customer's reported checks;
   "cleaned the filter" plus another reported item reached two).
4. **The note switches mid-conversation** on stray words (WM-04 turn 3: "refitted the hose" → a leak note; WM-05
   between flood, door and drain leak notes).
5. **A re-test offered when nothing was cleared** (WM-09: "Now that the blockage is cleared" after a squashed hose
   that did not fix it).
6. Knowledge gaps unchanged: WM-03 (no carbon-brush check), WM-07 (the 60 °C test keeps being offered).

## Round 4 (release 21.33, Claude Opus 5.5 for the LLM parts)

Reviews in `round4-opus/`. Customer messages to the end, round 3 → round 4 (both Opus):

| Test | R3 Opus | R4 Opus | |
|---|---|---|---|
| WM-01 | 3, fixed | 3, fixed | same |
| WM-02 | 4, engineer | **2, normal, closed** | fixed by the settled-normal close |
| WM-03 | 4, safety stop | 5, safety stop | same (no carbon-brush check in the notes) |
| WM-04 | 3, fixed | 3, fixed | same |
| WM-05 | 7, seal found | **7, loop** | worse: the note now stays on the triage note (leak-flood), whose steps do not fit a door leak; ended on "tell me a bit more" |
| WM-06 | 1, engineer | 1, engineer | still: stage 2 (filter cleaned, still faulty) opens the engineer option on its own |
| WM-07 | 5, stuck | **4, concluded** | better: normal Eco cycle explained; one "fill level" step still offered |
| WM-08 | safety stop | safety stop | same |
| WM-09 | 6, engineer | 5, engineer | the customer refuses the filter; engineer is a fair end |
| WM-10 | 5, part path | 5, part path | same |

Left: (1) stage 2 alone must not open "needs an engineer"; (2) a triage note (leak-flood) must hand over to the
specific note once the customer says where the water comes from - the "stay on the note" fix holds it too tightly;
(3) the knowledge gaps (carbon brushes; heating checks offered for a normal Eco cycle).

## Round 5 (release 21.34, Opus)

Reviews in `round5-opus/`.

| Test | R4 | R5 | |
|---|---|---|---|
| WM-01 | 3, fixed | 3, fixed | same |
| WM-02 | 2, normal closed | 3, normal closed | same |
| WM-03 | 5, safety stop | 3, safety stop | same (no brush check) |
| WM-04 | 3, fixed | 3, fixed | same |
| WM-05 | 7, loop | 3, engineer | the door-leak note now takes over (fixed), but it has **no steps at all**: turn 2 asked "tell me a bit more", turn 3 ended on the engineer line before the seal was ever checked |
| WM-06 | 1, engineer | 6+, part stage | no early engineer (fixed); now stuck at the model number: FD 9409 is a production code and the rest of the label is rubbed off, so it keeps asking |
| WM-07 | 4 | 4 | same |
| WM-08 | safety stop | safety stop | same |
| WM-09 | 5, engineer | 5, engineer | same |
| WM-10 | 5, part path | 4, part path | same |

Left: (1) a note with no steps must borrow the steps of the related notes (here the other leak notes); (2) when the
customer cannot read the model number, the part stage must move on (say where else to find it, or name the part
type and the engineer) instead of asking again.

## Round 6 (release 21.35, Opus)

Reviews in `round6-opus/`.

| Test | R5 | R6 | |
|---|---|---|---|
| WM-01 | 3, fixed | 3, fixed | same |
| WM-02 | 3, normal | 4, normal | same |
| WM-03 | 3, safety stop | 3, safety stop | same (no brush check) |
| WM-04 | 3, fixed | 3, fixed | same |
| WM-05 | 3, engineer | **5, seal found, part shown** | fixed: the door-leak note borrowed the leak checks; seal split found; part for WTK72041W shown |
| WM-06 | stuck at model | **2, drain pump named** | fixed: no repeated model question; names the likely part and why the exact one needs the full model |
| WM-07 | 4 | **7** | worse: Jev chose "normal Eco cycle" in all 7 turns but never marked it settled, so heater-note steps kept coming |
| WM-08 | safety stop | safety stop | same |
| WM-09 | 5, engineer | 5, engineer | same (customer refuses the filter) |
| WM-10 | 4, part path | 5, part path | same |

8 of 10 now end correctly (fixed, normal closed, part shown or a correct safety stop / engineer); WM-03 is a
knowledge gap; WM-07 needs: the same "normal" choice two turns running counts as settled.
