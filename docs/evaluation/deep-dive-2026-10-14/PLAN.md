# Plan: +25% on the independent 100 (2.74 → 3.40)

Date 2026-10-14. Baseline: release 21.16, overall **2.74** (general assistant 3.48, first rebuild 2.73). Target **3.40**,
a gain of **+0.66**, which is 89% of the gap to the general assistant: in practice, parity with it.

Every claim below cites its proof: a report in this folder (with the file:line, query or script and output behind it),
or an output file in [`outputs/`](outputs/) produced by a script in [`scripts/`](scripts/). Estimates are labelled as
estimates, with their method.

| Report | Covers |
|---|---|
| [pipeline.md](pipeline.md) | The full turn path, every limit and gate, with file:line and counts from the 21.16 run |
| [rag.md](rag.md) | The knowledge base, coverage, retrieval accuracy, and whether replies use it |
| [vs-general-assistant.md](vs-general-assistant.md) | All 86 lost pairwise cases read and classified; where the 0.74 is lost |
| [model-and-latency.md](model-and-latency.md) | Which model serves each step, measured latency, failures, what switching takes |
| [benchmark-noise-and-history.md](benchmark-noise-and-history.md) | How noisy the benchmark is, and every version's score |

## 1. What the evidence says

**1.1 The score is stuck because of reasoning quality, not missing knowledge.**
- The knowledge base covers the hidden fault in 93 of 94 in-scope cases, and the live run had the right note in the
  top 3 by some turn in 95.5% ([rag.md](rag.md), `outputs/out-coverage.txt`, `outputs/out-live.txt`).
- On the 84 cases where the right note was retrieved, AC scores 2.73 and the general assistant, with no retrieval,
  3.50 (`outputs/out-corr.txt`).
- When the turn-1 note already named the answer, AC's first reply named it 79.7% of the time; the general assistant
  95.9% (`outputs/out-usage.txt`).

**1.2 Only changes to who does the reasoning have ever moved the score.** Journeys → LLM reasoning +1.27; removing
the reasoning pass (ac3) −0.41; restoring it (21.11) +0.42. Every other release since 20.13 is within noise of 2.73,
and the dimensions the model controls are flat: diagnostic usefulness 2.76 → 2.79, question quality 2.42 → 2.41,
calibration 2.77 → 2.78 ([benchmark-noise-and-history.md](benchmark-noise-and-history.md), `outputs/ci_base.out`).

**1.3 The model has never been changed or tested against a stronger one on this benchmark.** Every Qwen step runs
`qwen3.6-35b-a3b-mtp` (35B total, about 3B active) on LM Studio, one request at a time; all 2,774 engine turns in 24 h
report it ([model-and-latency.md](model-and-latency.md) §1–2). The first rebuild's own failure analysis named a
stronger reasoning model as the first remedy; it was never tried (`llm-led-rebuild.md`, "What would be needed"). The
only Qwen-vs-GPT comparison (S3, 2026-09-04) was on the old journey benchmark, judged by the GPT model itself, and
showed no difference ([model-and-latency.md](model-and-latency.md) §6): it is not evidence either way for this
benchmark.

**1.4 There are also proven defects that cost points regardless of the model.** From [pipeline.md](pipeline.md) and
[vs-general-assistant.md](vs-general-assistant.md):

| # | Defect | Proof |
|---|---|---|
| D1 | The check each reply gives is never recorded: checks are cut to 140 characters but `tokenOptions` drops anything over 40, and every owner check is ≥ 52. `checkGiven` is null in 302/302 turns, so the "result not reported" plan line never fires | `labels.js:55,150`; pipeline.md finding 1 |
| D2 | Hazards persist and are re-detected from every message, never cleared, even after the customer denies them ("There is no burning smell"). 41 forced-escalation turns; the 8 forced cases with no real stop in the ground truth average 2.12 vs 3.50 | `safety.js:118-128`, `turn.js:111,498`; `outputs/s_forced.out`, `s7_forced_summary.out` |
| D3 | The same canned safety card repeats in 11 of the 19 conversations where it appears; MW-08's second reply is only the 999 card | `outputs/s8_canned.out` |
| D4 | The claim check removed 149 claims in 110 of 302 turns (36%), including true ones (DW-12: "sink was replaced", which the customer said); removal is not logged as a gate | `verifier.js:139-143`, `turn.js:305-313`; pipeline.md finding 2 |
| D5 | Two-thirds of fault notes reach the reasoner with no causes and no owner checks; `clarifyingQuestion` (100 notes), component supports/against evidence (85 notes), `adviceBeforeReplacement` (73) are dropped; 154 of 581 discriminators dropped and 146 truncated | `knowledge.js:72-90`, `turn.js:147`; pipeline.md finding 5 |
| D6 | The plan caps depth: stage 1 allows "one or two safe checks, or the one question"; the prompt says "at most two" questions and "Usually 3–8 sentences". The general assistant's first reply offers a median of 11 checks to AC's 1 | `turn.js:188`, `reasoner.js:21,41`; `outputs/s4_structure.out` |
| D7 | Stage 2 asks for the model number "so we can find the right part" whether or not a part is implicated, and never ends; the part prompt appears in 19 of 63 no-part cases | `turn.js:102,193-195,511`; `outputs/s4_structure.out` |
| D8 | Retrieval: word overlap with no weighting, negations stripped, no typo tolerance; a resolved error code is never used to choose the note (DW-02 4C → "water supply", fill note never retrieved) | `knowledge.js:98-111`, `turn.js:122-145`; `outputs/out-demo.txt`, `out-live.txt` |
| D9 | Data bugs: hob part matching returns nothing (`hobs` vs `hob`); washer-dryer cannot reach the only odour note; the live error-code service does not resolve "EO3" (letter O) | rag.md finding 8 |
| D10 | No recall, brand or model knowledge: TD-01 (recalled Hotpoint dryer, score 1) and FF-05 missed the recall | rag.md finding 8; `outputs/s3_escalation.out` |
| D11 | Photos are dropped before the models: the BFF and handler pass the image, `runtime.js:44` ignores it | pipeline.md finding 9 |
| D12 | Out-of-scope declines give no pointer (OS-04, OS-06: −2 points each) | `outputs/s2_taxonomy.out` |
| D13 | About 75% of the reasoner's output tokens are JSON fields the turn never reads (`understanding`, `part`, `escalation`), at about 53 tokens/s on the shared server | `turn.js:444-448`; pipeline.md finding 4; model-and-latency.md §2 |

**1.5 Where the 0.74 is lost** (all 86 lost cases read and classified; [vs-general-assistant.md](vs-general-assistant.md),
`outputs/s2_taxonomy.out`). "Attributed" is an estimate: half of each case's gap to its main class, half shared across
its other classes; it sums to the full 80 points.

| Class | Cases | Attributed points (est.) | Addressed by |
|---|---|---|---|
| Thin reply (no why, next steps, repair-vs-replace) | 42 | 9.8 | D5, D6, model |
| Wrong or over-confident diagnosis | 28 | 8.4 | model, D5 |
| Missed the key simple check or question | 34 | 8.1 | D5, D6, model |
| Wrong product facts | 25 | 7.5 | model, D10 |
| Ignored what the customer said (refusals, questions) | 29 | 7.3 | D1, model |
| Safety miss (recall, unplug, unsafe step) | 21 | 7.2 | D10, model |
| Safety noise (irrelevant or repeated stop card) | 20 | 6.3 | D2, D3 |
| Premature or unnecessary escalation | 11 | 5.5 | D2 |
| Loops | 16 | 4.9 | D1 |
| Garbled or "AI service unavailable" | 14 | 3.4 | 21.17 (fixed after the run), D13 |
| Bare out-of-scope decline | 3 | 3.0 | D12 |
| Part prompt where no part is needed | 20 | 2.6 | D7 |
| Other (wrong escalation route, missing part path, detours, model/code) | — | 6.0 | D7, D9, D10 |

**1.6 What size of gain the benchmark can see.** Run-to-run noise is large: 40–47 cases change score between runs, and
a paired difference must be ≥ 0.17 to be told apart from noise (≈ 0.24 for 80% power)
([benchmark-noise-and-history.md](benchmark-noise-and-history.md), `outputs/noise.out`). Each phase below is judged
on that rule, never on a single headline.

## 2. What follows from it

- **The mechanical defects (D1–D3, D7, D12, D13) account for an estimated 20–25 points (+0.20 to +0.25)**: safety
  noise, unnecessary escalation, loops, part prompts, bare declines, service errors. That reaches about 2.95–3.0. It is
  worth doing, but it cannot reach 3.40 on its own (`outputs/s2_taxonomy.out`, section 6).
- **The remaining ~45 points sit in reasoning quality** (thin replies, wrong diagnoses, missed checks, wrong facts,
  ignoring the customer). The evidence (1.1–1.3) says these are bounded by the reasoning model, and better knowledge
  only helps if the model uses it. This is a hypothesis until tested; Phase 2 tests it directly.

## 3. The plan

Each phase ends with a paired run on the independent 100 (same cases, same simulator and judges), compared with 21.16
case by case; the gain counts only if it clears 0.17. Phases 2 and 3 are decision gates.

### Phase 1: fix the proven defects (code only; about 2 days; expected +0.20 to +0.25, estimate)

1. **D1** Record the check each reply gives: summarise it to ≤ 40 characters before it becomes a Jev token option, or
   match on an id instead of text. Test: `checkGiven` non-null whenever the reply gives a check.
2. **D2, D3** Hazards: re-evaluate each turn; clear a hazard when the customer's latest message denies it (Jev already
   labels negation; the word list needs the same); show each card once per conversation; force escalation only for
   hazards whose policy requires it and only while active.
3. **D7** Ask for the model number only when a part is implicated (narrowed, or the knowledge note's outcome is a part);
   no part panel otherwise.
4. **D12** Out-of-scope declines carry the pointer for that appliance class (the pointer table exists in `turn.js`).
5. **D13** Reasoner output: drop the unused JSON fields (`understanding`, `part`, `escalation`). Expected effect: about
   75% fewer output tokens (estimate from pipeline.md finding 4), so turns get faster and a regeneration fits within the
   26 s budget more often (today 57 of 289 turns, pipeline.md finding 3).
6. **D4** Claim check: log every removal as a gate; accept a claim when the customer's own words cover it (the DW-12
   class), measured on the 149 rejections of the 21.16 run before release.
7. Release, then the paired run. **Gate:** ≥ +0.17 paired, critical failures not above 16.

### Phase 2: test the reasoning model (about 1 day plus one run; decides the rest of the plan)

The model has never been tested here, and the evidence points at it. Run the same pipeline (after Phase 1) with only
the reasoning model changed:

1. Make the reasoner and claim-extractor schemas strict-compatible (`additionalProperties: false` on every object,
   `reasoner.js:72-106`, `verifier.js:43`) so a hosted model can serve them. Today an OpenAI-compatible provider would
   probably fail every turn (model-and-latency.md §1).
2. Route `compose` to a stronger model through the existing config (`routing.compose = frontier`; the provider and key
   are already in the AI config, disabled). This is a config switch, reversible in 60 s.
3. Run the 21.10 control ("the reply model alone") once on both models, to measure what the pipeline adds on top of the
   model. It is built and staged but has never been run.
4. Paired run of the 100. **Gate:** if the stronger model gains ≥ 0.40 paired, the plan continues on it; if not, the
   gap is not the model, and Phase 3 becomes the main lever.

### Phase 3: give the reasoner what the knowledge base already has (about 2–3 days; expected gain unknown until measured)

1. **D5** Pass every note's causes, owner checks, `clarifyingQuestion`, component supports/against evidence,
   `adviceBeforeReplacement` and full discriminators; drop the 260-character truncation.
2. **D8** Retrieval: weight rare terms (TF-IDF or BM25 over the existing index), keep negations, use the resolved error
   code's components to choose the note. Test: the top-3 hit rate on the openers (`scripts/rag.js`, today 83.0%).
3. **D9** Fix `hobs`/`hob`, washer-dryer odour, the letter-O codes.
4. **D6** Plan: let stage 1 give the checks that separate the likely causes (not "one or two"), with the reason for each
   and what each result means; replace "Usually 3–8 sentences" with a structure: cause, checks, what each result means,
   when an engineer is needed.

### Phase 4: knowledge the general assistant has and AC lacks (ongoing)

1. **D10** Recall data: the UK product recall list (GOV.UK PSD and manufacturer programmes) by brand and model into the
   recall store the turn already consults.
2. Brand/model facts that the lost cases needed: vented vs condenser dryers, switched spur fuses, freezer alarm
   behaviour (vs-general-assistant.md finding 7).
3. **D11** Pass photos to a vision-capable reasoner if Phase 2 chooses one.

### Phase 5: confirm on the held-out set

No ac3 release has ever been run on the 31-case held-out set (benchmark-noise-and-history.md). The final candidate is
run there before any claim of +25%, because the independent 100 has been used as development evidence throughout.

## 4. What is not claimed

- That Phase 1 alone reaches 3.40: the estimate says about 2.95–3.0.
- That a stronger model will close the gap: it is the best-supported hypothesis, and Phase 2 is the test.
- That the knowledge base is the bottleneck: 1.1 shows it is not, today; Phase 3 makes it usable by the model.
- Cost and latency of a hosted model, and whether customers would accept them: measured in Phase 2, not assumed.

## 5. Corrections to the reports

Each claim used above was checked against the code before this plan was written. One report claim did not hold and is
not used: pipeline.md finding 3 says the regeneration budget at `turn.js:434` counts the reasoning time twice. It does
not: `elapsed` is time spent so far, and `r.ms + verifyMs` estimates the cost of the next pass; their sum is the
expected finish time. Its measurement (a regeneration fits in 57 of 289 turns) stands and reflects real latency.

## 6. Phase 1 result (2026-10-14)

| Release | What | Overall | Paired vs 21.16 (95% CI) | Confirmed critical | Unsafe DIY | Blocking loops | Median turn |
|---|---|---|---|---|---|---|---|
| 21.16 | baseline | 2.74 | | 14 | 1 | 4 | 18.1 s |
| **21.18** | Phase 1: D1–D4, D7, D12, D13 | **2.79** | +0.05 (−0.10 to +0.21) | **11** | 1 | **2** | **13.6 s** |
| 21.19 | 21.18 + owner checks under hazards | 2.70 | −0.04 (−0.21 to +0.13); −0.09 vs 21.18 | 13 | 3 | 6 | 13.0 s |

- **Phase 1 did not clear its gate** (+0.17 paired). It made AC safer and faster (fewest confirmed critical failures
  so far, unjustified parts 6 → 3, median turn −4.5 s from D13) but not more useful. The estimate of +0.20 to +0.25 for
  the mechanical defects did not hold.
- **Why the escalation estimate failed:** forced escalations were unchanged (20 → 21 conversations). D2 clears denied
  hazards, but in this run every forced escalation came from a hazard the customer really reported, so nothing was
  denied (`out/independent-100-21.18/conversations/ac3`, meta escalation.forced).
- **21.19 tried the next step** (the plan asks for the owner checks the cases' safety boundaries allow under a hazard).
  It was worse on the measures that matter (unsafe DIY 1 → 3, blocking loops 2 → 6, −0.09 vs 21.18) and was rolled
  back in 21.20 (byte-identical to 21.18).
- **What this confirms:** with four more releases, usefulness stays at 2.70–2.79, the same band as every release since
  20.13. Changing the plan and the checks around the model moves safety and speed, not usefulness. Phase 2 (a stronger
  reasoning model) is the test the evidence points to.

## 7. Phase 2 result (2026-10-14): the reasoning model is the lever

The same pipeline (21.21: 21.18 plus strict output schemas), with only the AI config's `routing.compose` switched from
`local` (Qwen 3.6 35B-A3B) to `frontier` (`gpt-5.6-terra`); understand stays on Qwen, labels on Jev. Data:
`evaluation/rebuild/out/independent-100-21.21-frontier/`, `results-independent-100-21.21-frontier.json`.

| | 21.18 (Qwen) | **21.21 frontier** | First rebuild (ac2) | General assistant |
|---|---|---|---|---|
| Overall usefulness | 2.79 | **3.24** | 2.73 | 3.48 |
| Paired vs 21.18 (95% CI) | | **+0.45 (+0.32 to +0.58)**; 40 cases up, 2 down | | |
| Resolved or usefully escalated / declined | 81% | **92%** | 84% | 91% |
| Conversations with any critical failure | 16 | **2** | 24 | 6 |
| Invented customer evidence | 2% | **0%** | 4% | 0% |
| Looping | 11% | **4%** | 11% | 1% |
| Unnecessary part | 3% | **0%** | 5% | 1% |
| Calibration (0–4) | 2.76 | **3.56** | 2.77 | 3.30 |
| Diagnostic usefulness | 2.83 | **3.28** | 2.76 | 3.60 |
| Question quality | 2.39 | **2.95** | 2.42 | 3.09 |
| Pairwise vs general assistant (win–tie–loss) | 16–0–84 | **34–1–65** | 17–0–83 | |
| Paired vs general assistant (95% CI) | | −0.24 (−0.42 to −0.06) | | |
| Median / 90th percentile turn | 13.6 / 17.7 s | 13.2 / 18.2 s | 11.5 / 16.4 s | 16.1 / 21.9 s |

- **Gate: passed** (+0.45 paired, gate +0.40). Overall 2.74 → 3.24 is **+18%**; the +25% target (3.40) is not yet
  reached. AC on the stronger model now beats the general assistant on safety (2 critical failures to 6), calibration,
  invented evidence, unnecessary parts and resolution rate, and still trails it on usefulness by 0.24.
- **This confirms the deep dive's main finding** (1.1–1.3): the pipeline, knowledge and guardrails were never the
  limit; the reasoning model was.
- **Live is back on Qwen.** The OpenAI key used for the test was supplied for this test only. Running the stronger model
  in production is a decision for the owner: a permanent key in the admin settings and the per-turn cost.
- **Next**, per the plan: Phase 3 (pass the full knowledge notes, better retrieval) and Phase 4 (recall and brand data)
  on the stronger model, then Phase 5 (held-out confirmation) before any +25% claim.


## 8. Phase 3 result (2026-10-14): knowledge and retrieval add little on top of the stronger model

Release 21.22 (D5 whole notes, D8 BM25 and error-code-led note choice, D9 washer-dryer and letter-O fixes, D6 plan
and reply structure), compose on `gpt-5.6-terra` as in §7. Data: `evaluation/rebuild/out/independent-100-21.22-frontier/`,
`results-independent-100-21.22-frontier.json`. All 100 scored (the last 4 after the primary judge's usage limit reset;
the first write-up used 96: 3.29, +0.06).

| | 21.21 frontier | **21.22 frontier** |
|---|---|---|
| Overall | 3.24 | **3.32** |
| Paired vs 21.21 (95% CI) | | +0.08 (−0.05 to +0.21); 20 up, 13 down |
| Paired vs general assistant | −0.24 | −0.16 (−0.35 to +0.03) |
| Pairwise vs general assistant (win–tie–loss) | 34–1–65 | **40–0–60** |
| Critical failures (confirmed) | 2 (2) | 2 (2) |
| Looping | 4% | 6% |
| Median turn | 13.1 s | 15.7 s |

- **Gate: not cleared.** +0.08 over 21.21 is within noise (needs ≥ 0.17). Overall 3.32 is +21% on 2.74; the +25%
  target (3.40) is not reached. The gap to the general assistant is no longer significant (CI crosses 0).
- **Retrieval improved as measured offline** (`scripts/rag.js retrieval`, openers, appliance given): top-1 55.7% → 69.3%,
  top-3 83.0% → 86.4%; DW-02 4C now chooses the fill note and WD-06 EO3 resolves as E03 on live. This did not move the
  score, consistent with §1.1: the right note was already reached in 95.5% of cases by some turn.
- **Cost:** larger notes add about 3 s to the median turn (13.1 → 16.0 s, level with the general assistant's 16.1 s).
- **Correction to D9:** hob part matching stays empty. The `hob`/`hobs` name mismatch is real and fixed, but the four
  hob journeys hold no part rules, so there were never any matchers to find.
- **Where the remaining gap was** (first 96, 21.21 → 21.22): language understanding 3.43 → 3.40 (general assistant 3.80),
  question quality 2.94 → 2.91 (3.09), fidelity 3.67 → 3.61 (3.82). The understand step (reading the customer's
  message) still runs on Qwen; it is the one model step not yet tested on the stronger model, and the next lever.

## 9. A repeat run of 21.22, and the model-alone controls (2026-10-14)

**Correction (verified in code):** the engine sends every model step (understand, reasoner, claim extractor) to the one
`routing.compose` provider (`inference.js` `resolveProvidersFromAdminConfig` reads only `compose`; `understand.js:65`
uses the same provider). `routing.understand` is a legacy setting the engine never reads. So the understand step was
already on the stronger model in §7 and §8 (§7's "understand stays on Qwen" is wrong), and the run below is **a
repeat of the same 21.22 configuration**, not a different one. Its 3.39 against §8's 3.32 is run-to-run noise.

Release 21.22 unchanged (the `routing.understand` switch had no effect, above). Data: `out/independent-100-21.22-frontier-understand/`,
`results-independent-100-21.22-frontier-understand.json`.

| | 21.21 frontier | 21.22 frontier | **21.22 frontier, repeat run** | General assistant |
|---|---|---|---|---|
| Overall | 3.24 | 3.32 | **3.39** | 3.48 |
| Paired vs 21.22 (95% CI) | | | +0.07 (−0.05 to +0.19) | |
| Paired vs 21.21 (95% CI) | | +0.08 (−0.05 to +0.21) | **+0.15 (+0.01 to +0.29)** | |
| Paired vs 21.18, all Qwen (95% CI) | +0.45 | | **+0.60 (+0.45 to +0.75)**; 54 up, 6 down | |
| Paired vs general assistant (95% CI) | −0.24 | −0.16 (−0.35 to +0.03) | **−0.09 (−0.25 to +0.08)** | |
| Critical failures (confirmed) | 2 (2) | 2 (2) | **1 (1)** | 6 (4) |
| Question quality / language understanding | 2.95 / 3.43 | 2.93 / 3.42 | 3.06 / 3.45 | 3.09 / 3.80 |
| Median turn | 13.1 s | 15.7 s | 16.5 s | 16.1 s |

- **Overall 3.39 is +23.7% on the 2.74 baseline**: 0.01 short of the 3.40 target, and level with the general assistant
  within noise (−0.09, CI crosses 0), with fewer critical failures (1 to 6). Neither Phase 3 nor the understand switch
  clears the 0.17 gate alone; together, on top of 21.21, they are +0.15 with a CI just above 0.
- **Not yet claimed:** the +25% target. 3.39 is one run on the development set; Phase 5 (held-out set) is required first
  (§3).
- **Model-alone controls** (the chat to the model with a generic assistant prompt, nothing else; change 21.10's
  control, runner flag `--control qwen-plain`): all 100 conversations are run for `gpt-5.6-terra` alone
  (`out/independent-100-plain-gpt/`) and Qwen alone (`out/independent-100-plain-qwen/`), **not yet scored**: the judge's
  usage credits ran out. Example, WM-02 "w/m wont spinn pls help": Qwen alone answered about a Windows mouse.
- **Live:** set to this configuration (understand and compose on the stronger model) while the temporary key lasts.

## 10. Does RAG and Jev add anything on top of a strong model? (2026-10-14)

Same 100 cases, same simulated customers, **one judge for every system: Claude Sonnet 5.5** (the primary judge, Fable,
was out of credits). "Plain" is the model alone with a generic assistant prompt and the chat, nothing else (change
21.10's control, runner `--control qwen-plain`). Data: `evaluation/rebuild/out/rag-vs-plain/`.

| System | Model | RAG, Jev, plan, checks | Overall (0–4) | Conversations with a critical failure |
|---|---|---|---|---|
| ours-gpt | gpt-5.6-terra | yes | 3.16 | **2** |
| plain-gpt | gpt-5.6-terra | no | 3.14 | 7 |
| ours-qwen | Qwen 3.6 35B-A3B | yes | 2.70 | **19** |
| plain-qwen | Qwen 3.6 35B-A3B | no | 2.40 | 46 |
| general assistant | Claude Opus 5.5 (Claude Code) | no | 3.26 | 15 |

| Paired difference (same cases) | Mean (95% CI) | Cases up / down |
|---|---|---|
| ours-gpt − plain-gpt | **+0.02 (−0.14 to +0.19)** | 15 / 18 |
| ours-qwen − plain-qwen | **+0.34 (+0.16 to +0.53)** | 38 / 12 |
| ours-gpt − general assistant | −0.10 (−0.27 to +0.07) | 18 / 25 |

Blind head-to-head (Sonnet): plain-gpt 54, ours-gpt 46; ours-qwen 68, plain-qwen 32. 93–98 of 100 scored per system
(the judge returned unparseable output on the rest after three tries).

- **On GPT, the pipeline adds no usefulness** (+0.02, CI ±0.17) **but cuts critical failures from 7 to 2**.
- **On Qwen, the pipeline adds +0.34 usefulness and cuts critical failures from 46 to 19.**

**Claude Opus 5.5** (release 21.23, Anthropic provider; same judge, all 100 scored):

| System | Overall | Critical failures | Safety | Question quality | Calibration | Diagnostic usefulness |
|---|---|---|---|---|---|---|
| ours-opus (pipeline) | 3.24 | **5** | 3.51 | 2.80 | 2.92 | 3.33 |
| plain-opus (alone) | 3.24 | 16 | 3.18 | 2.49 | 2.66 | 3.45 |

- Paired ours-opus − plain-opus: **+0.00 (−0.16 to +0.16)**, 22 up, 22 down.
- Blind head-to-head (Sonnet): **ours-opus 64, plain-opus 36** (two-sided binomial p ≈ 0.007).
- plain-opus matches the general assistant (Opus in Claude Code), +0.00, as it should: same model alone.
- Pipeline turns on Opus: median about 25 s (alone: about 10 s); 1 service error in 100 conversations.

**Conclusion across all three models.** The pipeline never lowers the usefulness score, and it cuts critical failures
on every model: Qwen 46 → 19, GPT 7 → 2, Opus 16 → 5. Its usefulness gain shrinks as the model gets stronger: +0.34
on Qwen, +0.02 on GPT, +0.00 on Opus. On Opus the blind head-to-head prefers the pipeline 64 to 36: safer, better
questions and better calibrated, slightly less diagnostic detail. Costs: slower turns and more to maintain.

## 11. Experiment: Jev chooses the cause and the next check (2026-10-15)

Release 21.24, Qwen for every model step, the AI config switch `pipeline.jevChooses` on against off, same release,
same 100 cases, Sonnet judge, all 100 scored per arm (run one conversation at a time: at three, the local Qwen server
timed out). Data: `out/independent-100-21.24-qwen-choose/`, `out/independent-100-21.24-qwen/`,
`out/rag-vs-plain/judge/`.

| | Jev chooses | Off |
|---|---|---|
| Overall | 2.59 | 2.65 |
| Paired difference | −0.06 (−0.21 to +0.09); 18 up, 24 down | |
| Critical failures | 21 | 24 |
| Named the part when one was needed | **15 / 38** | 8 / 38 |
| Blind head-to-head | 53 | 40 (7 ties) |

- **No measurable gain in usefulness or safety**: every difference is inside the noise.
- **It does reach the part twice as often** (15 against 8 of the 38 cases that need one), without naming a part
  where none is needed.
- Not adopted on its own: the score does not move. The parts result is worth keeping in view for the parts problem.

## 12. Experiment: Jev-led (Qwen reads, Jev chooses, code writes) (2026-10-15)

Releases 21.25–21.27, AI config `pipeline.mode = jev-led`, Qwen for understanding and for a direct customer question
only. Same 100 cases, Sonnet judge (98 scored). Data: `out/independent-100-21.27-jev-led/`.

| | Jev-led | Qwen pipeline (same release family, 21.24 off) | Opus pipeline |
|---|---|---|---|
| Overall | **1.89** | 2.65 | 3.24 |
| Paired vs Qwen pipeline | −0.77 (−0.94 to −0.59); 5 up, 60 down | | |
| Critical failures | 50 | 24 | 5 |
| Resolved | 15 | 36 | 46 |
| Blind head-to-head vs Qwen pipeline | 15 (79 lost, 6 ties) | | |
| Median turn | 3.9 s | ~15 s | ~25 s |

Every dimension fell (diagnostic usefulness 2.66 → 1.96, question quality 2.01 → 1.29, fidelity 2.77 → 2.08). It is the
fastest design tested and the worst since the journey system (1.46). Not adopted; live is back to the Qwen pipeline.

## 13. Experiment: evidence mode (Jev reads evidence item by item, code scores) (2026-10-15)

Releases 21.28–21.29, `pipeline.mode = jev-evidence`, Qwen. 46 of 100 conversations went through evidence mode (the
matched note had scorable evidence); the rest kept the Qwen pipeline. Sonnet judge, 99 scored.
Data: `out/independent-100-21.29-jev-evidence/`.

| Paired vs the Qwen pipeline | Mean (95% CI) | Up / down |
|---|---|---|
| All 99 | −0.37 (−0.57 to −0.19) | 11 / 36 |
| The 46 evidence-mode conversations | **−0.89 (−1.17 to −0.61)** | 3 / 30 |
| The 53 others (same path as the baseline) | +0.08 (−0.11 to +0.28) | 8 / 6 |

Overall 2.28 (Qwen pipeline 2.65), critical failures 38 (24). The 53 conversations on the unchanged path match the
baseline, so the loss is the evidence path itself. Where 13 conversations lost 2+ points, the judge cites: engineer
too early (10), wrong or irrelevant cause (8), repeated or already-answered steps (7). Not adopted; live is back to the
Qwen pipeline.
