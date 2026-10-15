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
