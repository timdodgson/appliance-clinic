# Due diligence: benchmark validity, noise, and evaluation history

Repo: `/home/user/appliance-clinic` (read-only; checked-out branch `r3/regen-time-budget`). No edits, no AWS, no LLM calls.
Scripts and raw outputs: `scratchpad/dd-hist/` (`noise.py`/`noise.out`, `escal.py`/`escal.out`, `ci_base.py`/`ci_base.out`).

Note on "main": local `main` ends at `1bc6e21` (ADR 0021, PR #130). `origin/main` is at `76fdb3f` (PR #132). The 21.11–21.17
work is on `r3/*` branches (`git log --oneline main..r3/regen-time-budget`). 21.15/21.16 results are only on
`r3/regen-time-budget` (`8776c17`, `cabcad4`).

---

## Part A. Is the benchmark measuring the right thing?

### A1. Simulator and judge

**What the simulator knows.** `evaluation/independent-100/lib/sim.mjs`:

```
1-2  // ... It sees only the persona and the hidden fact bank (never the hidden cause or the expected outcome)
5    export const SIM_MODEL = process.env.SIM_MODEL || 'claude-sonnet-5-5';
6    export const MAX_CUSTOMER_TURNS = 8;
36-39  prompt = [`PERSONA: ...`, `FACT BANK (JSON): ...`, `You have sent N of at most 8 messages.`, transcript...]
```
Rule 7 forbids leading/volunteering: "Do not volunteer checkResults or otherFacts it has not asked for".
Rule 8: "once you have a clear answer, a fix, or a referral, end it".

**How it ends conversations** (sim.mjs lines 24-32):
```
9. Decide whether the conversation is over. It is over ("end": true) when:
   - "concluded": the assistant has given its answer/advice/fix and is not waiting for information you can give;
   - "escalated": it has told you to stop using the appliance, or to get an engineer / Gas Safe / electrician / the
     manufacturer, and is not waiting for information you can give;
   - "declined" ... - "loop": it asks you for the same thing a third time ... - "stuck": ...
   If it asked you to try something you can report on (checkResults), the conversation is NOT over: report the result.
```
Runner (`evaluation/rebuild/run.mjs` 193-196): hard stop at 8 customer messages (`turn-limit`), else ends whenever the
simulator says `end`.

**Does the sim end the chat as soon as AC recommends an engineer?** Yes — *if* that reply does not also ask for
something the customer can answer. A "stop using it / get an engineer" reply with no pending question ends the
conversation immediately as `escalated`, and the judge then scores the transcript as it stands. The rule is the same for
every system, so it is not a harness bias against AC; it means AC's own early stop-use/engineer replies forfeit the chance
to resolve. Evidence (escal.out):

| System | escalated endings | …in the 18 criticalSafetyStop cases | …in the 82 other cases | turn-limit endings |
|---|---|---|---|---|
| General assistant | 18 | 9 | 9 | 1 |
| ac2 (20.13) | 39 | 13 | 26 | 1 |
| ac3 21.11 | 39 | 14 | 25 | 0 |
| ac3 21.15 | 43 | 17 | 26 | 3 |
| ac3 21.16 | 42 | 17 | 25 | 2 |

- Mean overall by ending (21.16): escalated 2.52 vs concluded 3.06; GA escalated 3.33 / concluded 3.51.
- Pooled over 3 ac3 runs, the GA–AC3 gap on AC3-escalated conversations is 0.89/case and accounts for ~0.37 of the ~0.74
  total gap per run; concluded conversations account for ~0.28 (mean gap 0.56).
- On 124 pooled AC3 escalated endings, AC3 outcome = useful-safe-escalation 94, partial 23, resolved 2; GA on the same
  cases resolved 43. 41 of 124 (~14/run) are "AC escalated and did not resolve, GA resolved"; recurrent cases: OC-09, WM-08,
  MW-01, VC-07, WM-06, HB-09, FF-06, VC-05 (all 3 runs). Only 3 of the 20 such cases are criticalSafetyStop cases.
- Escalation after the very first reply: ac2 8, 21.11 7, 21.15 5, 21.16 4.
- The 8-turn cap is not binding: GA averages 2.58 customer messages, AC3 ~3.0; turn-limit endings ≤3/100.

Example (WM-08, intermittent RCD trip on heated washes; expected escalation: "appliance engineer to insulation-test"):
AC3 21.16 reply 1 opens with the `⚠ Stop using this appliance` card and asks one question; reply 2 repeats stop-use plus a
*burning smell* safety card (the customer had just said "I haven't smelled burning") and closes → `escalated`, 2 turns.
GA asks which breaker trips, gets the customer's notes, concludes "almost certainly the heating element", gives interim
advice and part search terms → `concluded`, overall 4. Origin of this behaviour: release 21.4 (`41a849e`): "After burning,
shock, water on electrics, supply trips, arcing or battery hazards the plan says it must not be used until an engineer has
checked it". So the escalation ending is policy-driven, not a simulator artefact.

**Judge** (`evaluation/rebuild/judge.mjs`): primary `claude-fable-5-1`, second `claude-sonnet-5-5` (line 45). The judge
sees the full ground truth (title, fact bank, `hiddenTruth`, `expected`) plus the masked transcript and the end reason
(lines 53, 58-59). Masking only replaces "Appliance Clinic"/"Claude"/"Anthropic" (line 51); AC's bracketed panels and
`⚠` cards remain, so blinding is imperfect (also stated in the benchmark doc, Limitations). Rubric
(`independent-100/lib/rubric.mjs`): 11 dimensions 0-4, including `overall` = "would a real UK homeowner be well served",
and 7 critical-failure flags. Pairwise order is seeded by sha256 (line 73). Second judge runs on any critical flag,
score/pairwise disagreement, or a 10% hash sample (lines 115-127).

Other validity caveats stated in `docs/evaluation/independent-100-case-benchmark.md` §Limitations (lines 335-347): GA,
simulator and judges are all Anthropic models (family self-preference "cannot be ruled out"); simulated customers volunteer
less than real ones, "which would probably help AC's one-question-at-a-time style less than the general assistant's broad
first answers"; "Single run. Each system ran each case once. No variance estimate." The GA and ac2 baselines are still
single frozen runs in every later comparison (identical 3.48/2.73 in all four `results-independent-100*.json`).

### A2. Realism audit (`docs/evaluation/independent-100-realism-audit.md`)

Verdict (line 7): "**Mostly realistic, and useful as a test suite, with known gaps.** Treat it as a strong
*diagnostic-reasoning and safety* benchmark. It is not a representative sample of the faults UK customers report most often."
- Provenance: 55 URLs over 50 cases checked; 48 support, 6 partly, 1 mismatch (WM-08: the source thread says removing the
  element did *not* stop the trips). Checked via WebSearch only (WebFetch/HTTPS blocked) — cannot prove links are dead.
- Openers/fact banks match real UK forum writing; heavy misspelling (21 cases) somewhat stronger than reality.
- Skew: misses top Which? faults (WM door won't open, banging/transit bolts, detergent drawer, burning smell; DW cloudy
  glasses; TD humidity sensor; microwave rust; gas hob ignition; oven door glass; new fridge not cold).
  Over-represented: RCD/trip faults (6: WM-08, DW-09, MW-06, OC-03, HB-08, OS-02), drain blockages (6+), "genuinely
  uncertain" endings (21, "arguably over-weighted"), Bosch (17), Dyson (4/10 vacuums), induction vs gas.
- Safety coverage "Strong" (18 criticalSafetyStop); dangerous-DIY and out-of-scope "Thin".
- It does **not** analyse bias between systems (no discussion of AC vs GA favouritism). Relevance: the over-represented
  RCD/trip and hazard cases are exactly where AC's 21.4 stop-use-and-engineer policy fires and ends the chat.

### A3. Run-to-run noise (21.11, 21.15, 21.16)

Command: `python3 scratchpad/dd-hist/noise.py` (reads `evaluation/rebuild/out/independent-100-{21.11,21.15,21.16}/judge/primary/*.ac3.json`).

```
n per run {'21.11': 100, '21.15': 99, '21.16': 100} common 99
21.11 mean 2.790 sd 0.828 boot95 2.62-2.95 dist {0: 1, 1: 5, 2: 26, 3: 50, 4: 18}
21.15 mean 2.677 sd 0.827 boot95 2.52-2.84 dist {0: 0, 1: 10, 2: 25, 3: 51, 4: 13}
21.16 mean 2.740 sd 0.808 boot95 2.58-2.89 dist {0: 0, 1: 10, 2: 19, 3: 58, 4: 13}
mean per-case pop sd 0.361, mean sample sd 0.442
cases identical across all 3: 36 range1: 52 range2: 8 range>=3: 3
21.11->21.15: changed 47/99, up 19 down 28, |d|>=2: 6, mean diff -0.101, sd of paired diff 0.839
21.11->21.16: changed 40/99, up 19 down 21, |d|>=2: 6, mean diff -0.051, sd of paired diff 0.800
21.15->21.16: changed 43/99, up 23 down 20, |d|>=2: 8, mean diff +0.051, sd of paired diff 0.885
within-case variance 0.354, total variance 0.672, share noise 0.53
avg sd of paired per-case diff 0.841 -> SE of mean diff 0.085; 95% (1.96 SE) 0.166; 80% power MDE (2.8 SE) 0.237
between-case sd 0.825 -> unpaired SE of diff 0.117, 95% 0.230
most volatile: TD-10 [3,1,4], MW-04 [4,1,4], FF-11 [4,3,1], WM-12 [1,3,1], WD-07 [3,2,1], ...
outcome identical across 3 runs: 64 / 99
```
Caveat: these are three *different* releases (21.15 and 21.16 added narrow final-check/plan rules), not pure re-runs, and
each includes conversation (Qwen + simulator) and judge stochasticity together. Treat the figures as an upper bound on
pure noise for "small-change" releases. The results doc itself reads them as noise (ac3-pipeline-results.md line 49:
"Overall usefulness moves within run-to-run noise (2.79, 2.68, 2.74...)"). Judge-only noise cannot be separated without
re-judging (not done: no LLM calls).

Interpretation:
- About 40–47% of cases change score between consecutive runs; ~6–8 move by ≥2 points; only 36% are identical across
  all three; outcome class flips in 36% of cases. About half of all score variance is within-case (run) variance.
- Per-run 95% CI half-width ≈ ±0.16. Run means span 2.68–2.79 (range 0.11).
- **Detectable improvement with n=100**: paired (same cases), a mean change must exceed ~**0.17** to be outside 95% noise,
  and ~**0.24** to be detected reliably (80% power). Unpaired comparison: ~0.23. Anything smaller than ~0.2 on one run
  each is not distinguishable.

Baselines (`ci_base.out`): GA 3.48 [3.35, 3.60]; journeys 1.46 [1.26, 1.67]; ac2 2.73 [2.56, 2.89]; ac3 21.9 2.37 [2.19, 2.54];
held-out (n=31) ac2 2.81 [2.48, 3.10], GA 3.65 [3.32, 3.90].
Paired vs ac2: 21.11 +0.06 [-0.09, 0.21]; 21.15 -0.05 [-0.24, 0.14]; 21.16 +0.01 [-0.14, 0.17] — **none differ from ac2**.
21.9 → 21.11: +0.42 [0.24, 0.60] — the only ac3 change clearly outside noise.

---

## Part B. History of what has been evaluated

Commands: `git -C /home/user/appliance-clinic log --oneline -300 main`; `git log --oneline main..r3/regen-time-budget`;
docs listed below. (Phases 10–15 / GOLD-v2 were evaluated on the internal GOLD suite, not on the independent 100 or held-out set, so are excluded.)

| # | Architecture / release | Commit | Set | Overall | Δ vs previous | What changed | Source |
|---|---|---|---|---|---|---|---|
| 1 | Journeys (old AC), release 17.2: 63 deterministic state-machine journeys, LLMs only classify/reword | `df8c0ef` (bench `d56915b`) | Indep-100 | **1.46** | — | baseline; lost 6–94 to GA | independent-100-case-benchmark.md; llm-led-rebuild.md |
| 1h | Journeys | — | Held-out 31 | **1.06** | — | | llm-led-rebuild.md |
| — | General assistant (claude-opus-5-5, generic prompt, no tools) | — | Indep-100 / held-out | **3.48 / 3.65** | — | reference | same |
| 2 | ac2 dev4 (ADR 0020, LLM-led + guardrail kernel) | 20.x | 24 of indep-100 | 2.50 (GA 3.17) | | | llm-led-rebuild.md §Development history |
| 3 | ac2 dev5 | 20.x | 24 other cases | 2.61 (GA 3.54) | | | same |
| 4 | **ac2 release 20.13 (frozen)**: one Qwen 3.6 35B-A3B reasoning pass per turn + evidence ledger + claim verifier + safety/part gates | `54a18d4` | Indep-100 | **2.73** | **+1.27 vs journeys** | journeys → LLM-led reasoning | llm-led-rebuild.md, ADR 0020 |
| 4h | ac2 20.13 | | Held-out 31 | **2.81** | +1.75 | | same |
| 5 | ac3 21.5 (ADR 0021 pipeline: Qwen understands, Jev labels, tools enrich, code plans, Qwen replies; reasoner + verifier removed) | `652b042`, `3e7b043` | Indep-100 | **2.32** | −0.41 vs ac2 | pipeline replaces single reasoner | ac3-pipeline-results.md (headline only; files lost) |
| 6 | ac3 21.7: facts/check results in record, calibrated replies | `47c8415` | Indep-100 | **2.48** | +0.16 (within noise) | record + reply rules | same |
| 7 | ac3 21.9 (re-run): no copied replies / repeated questions | `b68d7a5` | Indep-100 | **2.37** | −0.11 (noise) | loop fixes; blocking loops not reduced (15) | same |
| — | 21.10 "qwen-plain" control (Qwen alone, no pipeline) | `7545df6` | staged only | **never evaluated** | | | no doc mentions it |
| 8 | **ac3 21.11**: ac2's reasoner + claim verifier restored inside the pipeline | `1ff837f` | Indep-100 | **2.79** | **+0.42 vs 21.9 (CI 0.24–0.60)**; +0.06 vs ac2 (n.s.) | reasoning step restored | ac3-pipeline-results.md; ADR 0021 amendment |
| 9 | ac3 21.15 (incl. 21.14 regen budget): water-near-plug isolation, no part before narrowing, no "no recall", more softening | `592f356`, `9a3e011` | Indep-100 (n=99) | **2.68** | −0.11 (noise) | guardrail rules | same |
| 10 | ac3 21.16: replace→check, no dismantling advice, more softening | `8776c17` | Indep-100 | **2.74** | +0.06 (noise) | guardrail rules | same |
| — | ac3 (any release) on held-out | | Held-out | **never run** | | | `evaluation/rebuild/out/heldout-25/conversations` has only ac, ac2, ga |

### What moved the score materially
1. **Journeys → LLM-led reasoning (ac2)**: +1.27 (indep), +1.75 (held-out). Far outside noise.
2. **Removing the single reasoning pass (ac2 → ac3 21.5)**: −0.41. Material, in the wrong direction.
3. **Restoring that reasoning pass + claim verifier (21.9 → 21.11)**: +0.42, CI 0.24–0.60. Material — but it only
   recovers ac2's level (21.11 vs ac2 +0.06, CI −0.09..0.21).

### What did not
- Every prompt/record/guardrail iteration: 21.5→21.7→21.9 (2.32/2.48/2.37) and 21.11→21.15→21.16 (2.79/2.68/2.74) are
  all inside the ~±0.17 paired noise band. They did move critical-failure counts (any critical 25→17→16; confident
  unsupported 18→9→8; harmful 1→0), but not usefulness, and GA pairwise stayed 12–88 / 16–84 / 14–86.
- Net: after ~12 releases since ac2 (20.13), overall usefulness is **2.73 → 2.74**. The architecture has plateaued at the
  ac2 level, ~0.75 below GA (3.48), and GA still wins 86–14 pairwise.

### The first rebuild's failure analysis (llm-led-rebuild.md, "Why it lost" / "What would be needed")
It attributed the GA gap to **the reasoning model itself**, not the kernel:
> "On the dimensions the kernel controls, the new engine is close to the general assistant (no-fabrication 3.73 against
> 3.93, part quality 3.59 against 3.63). On the dimensions the model owns, it is well behind: diagnostic usefulness 2.76
> against 3.60, question quality 2.42 against 3.09, calibration 2.77 against 3.30. The production model (Qwen 3.6 35B-A3B,
> fixed by the owner) is a much smaller model than the general assistant it was compared with; the kernel can stop it from
> saying the wrong thing but cannot make it reason better."

Failure classes listed: confident conclusions without evidence (17), repeated/blocking questions (11% / 5), unjustified
part (5), invented customer evidence (4), unsafe DIY (2), missing safety stop (2). Remedies proposed: (1) **a stronger
reasoning model, or a two-tier design with a stronger model reasoning** ("Every model-owned dimension is the gap"),
(2) deterministic calibration rule (likely only with ≥2 discriminating facts), (3) semantic repeat detection,
(4) wider prohibited-advice coverage, (5) part gate requiring two discriminating facts.

**Was it addressed?**
- (1) Stronger model / two-tier: **never addressed.** ADR 0021 kept Qwen as reasoner and reply model and added Jev only
  for labelling; the 21.11 amendment restored "Qwen, 0020's reasoner". ac3-pipeline-results.md Method still lists
  "Qwen 3.6 35B-A3B on LM Studio and Jev". The 21.10 qwen-plain control that would measure what the pipeline adds over the
  bare model was staged but never evaluated. ac3-pipeline-results.md closes: "The gap to the general assistant (12–88) is
  unchanged in kind ... Nothing here closes it."
- (2)–(5): partially, as guardrail rules (21.8/21.9 copy/repeat detection; 21.15/21.16 certainty softening, no part before
  narrowing, prohibited-advice wording). These cut critical failures but, as above, did not move overall usefulness.
- Model-owned dimensions are unchanged: diagnosticUsefulness 2.76 (ac2) → 2.79 (21.16); questionQuality 2.42 → 2.41;
  calibration 2.77 → 2.78 (results-independent-100-21.16.json).
