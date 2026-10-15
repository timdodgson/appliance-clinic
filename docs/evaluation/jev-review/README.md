# Jev-led review, case by case (2026-10-15)

Release 21.30, AI config `pipeline.mode = jev-led`, Qwen. For each test: every turn's customer message, the options
Jev was offered (situations and next steps), what Jev picked, the reply, and the case's hidden truth.
`<ID>.txt` is the readable review (made by `review.py` from `<ID>.json`, the raw conversation with its audit).

| Test | Jev's picks | What went wrong |
|---|---|---|
| WM-01 (Bosch E18, water in drum) | right cause, right checks; fixed in 3 messages | options duplicated (same cause in two wordings); unrelated fill/overheating steps offered; "floor got wet" pulled in leak notes |
| WM-02 ("w/m wont spinn", one bath mat) | right: normal out-of-balance from turn 2 | Qwen's question answers wrong (turn 5: "run the mat on its own" - the opposite of the fix); a note step out of context ("change that (switch the option off...)"); drain options kept after the drum was empty |
| WM-03 (Indesit drum never turns; truth: worn carbon brushes) | turn 1 wrong (water-level sensing); then the drive belt throughout | turn 1 notes retrieved on "fills ... drains" were fill faults; no carbon-brush check among the options; Jev ignored "no motor noise at all"; it offered and picked a spin-settings check after the customer said the drum never turns |
