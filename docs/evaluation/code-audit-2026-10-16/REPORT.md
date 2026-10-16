# What every step of the live turn actually does (audit, 2026-10-16)

Trigger: live chat "Dyson V6 Pulising" → "filter is blocked" → "the filter is actually damaged". Expected: "almost
always a blockage or dirty filter" + the help image; then the filter part. Got: a long four-check list with a missing
wash step, no image on the first reply, and no part.

Method: every file on the customer path was read (whichpart-api `index.js`, `ac2-turn.js`; engine `handler.js`,
`ac2/runtime.js`, `turn.js`, `understand.js`, `labels.js`, `record.js`, `knowledge.js`, `reasoner.js`, `verifier.js`,
`safety.js`, `parts.js`, `models.js`, `mcp.js`, `reply.js`, `util.js`, `inference.js` Anthropic provider,
`engine/parts-client.js`). Every number below comes from (a) the live logs of the Dyson chat, (b) the per-turn audit
saved for all 308 turns of the 100-case Opus run (`evaluation/rebuild/out/rag-vs-plain/conversations/ours-opus`),
or (c) running the shipped code / live parts catalogue directly. Commands are in the session log.

## The flow, step by step, with what it is proven to do

| # | Step (file) | What it does | Evidence | Verdict |
|---|---|---|---|---|
| 1 | Photo hand-off (`handler.js:65` → `runtime.js:44`) | handler passes `image`; `turn()` only takes `{messages,state,tools}` | code; `turn.js` never reads `input.image`; Anthropic provider drops image parts (`inference.js:299`) | **Broken**: customer photos are never used |
| 2 | Understand (`understand.js`, LLM call 1) | reads only the latest message; ≤4 facts, ≤4 checks | median 2.6 s/turn | Feeds the record; see 6 |
| 3 | Jev labels (`labels.js`) | appliance, symptom area, hazard, check outcome, `narrowed` component | checkOutcome empty in 212/308 turns; `narrowed` set in 25 turns, VC-02 wrongly "battery" (truth: filter) | **Harms**: drives stage, parts and a wrong heading |
| 4 | Stage / narrowing (`turn.js:105-108`) | stage 2 only if Jev labels a failed check or a narrowed part | Dyson: stage stayed 1 after "filter is damaged" | **Blocks** the part step |
| 5 | Knowledge retrieval (`knowledge.js`) | BM25 over 171 notes, top 3 | "dyson v6 pulsing" → only `vacuum:cuts-out` (charger, boost mode, battery, filter, blockage, brush bar…; 8 checks; no component evidence) | Mixed: pushes a broad list; no "pulsing = airflow" note |
| 6 | Plan (`turn.js decide`, line 233) | stage 1: "give the safe checks… usually two to four"; "Do not tell them to buy… a part yet" | | **Harms**: multi-check replies by design |
| 7 | Reasoner (`reasoner.js`, LLM call 2) | Opus writes the reply; style: "the checks as a short numbered list… be as long as that needs" | 279 of 308 replies over 150 words; median 14.5 s | **Harms** (prompt) — a short-reply prompt exists in `reply.js` but is **unused** (only the ablation imports it) |
| 8 | Claim check (`verifier.js`, LLM call 3) | deletes sentences "about the customer" not in the record | deleted sentences in **159/308 turns** (253 sentences); **regenerated 0 times**; random sample of 40: ~31 wrongly deleted (e.g. "Customer only uses tablets" when the customer wrote "I only use tablets"; washing instructions; the E:15 meaning). Dyson turn 1 and 2: deleted "rinse … until the water runs clear" (`STATE` regex reads "the water runs" as a claim). Median 5.1 s | **Harms**: removes true and key content |
| 9 | Prohibited-advice gate (`safety.js gateReply`) | removes unsafe sentences | fired 11 turns; also `replace(/\s{2,}/g,' ')` on **every** reply removes paragraph breaks | Safety value plausible; **formatting bug every turn** |
| 10 | Certainty rewrite (`turn.js calibrate`) | "almost certainly" → "probably" etc. | 80 turns | Unproven; weakens clear answers |
| 11 | Part/recall sentence filter (`removeUnconfirmedAdvice`) | drops "buy/replace" sentences unless narrowed | 9 turns | Blocks "replace the filter" style advice |
| 12 | Part numbers/prices filter | drops unverified ids/prices | 3 turns | Low impact |
| 13 | Step precaution prefix | "Switch it off and unplug it… first." | 15 turns (Dyson turn 1 opened with it) | OK, small |
| 14 | Parts (`turn.js:449`, `parts.js`, catalogue) | needs stage 2 + narrowed + model + catalogue match | **1 of 308 turns showed a part** (38 cases needed one). Catalogue has V6 filters (£15 HEPA, £18–19 pre-filter); `matchParts(…, "clean or replace the pre-motor and post-motor (HEPA) filters")` returns none (plural "filters" ≠ matcher "filter"). Of 11 narrowed cases, 7 models are missing from the catalogue; "V8 ANIMAL" used instead of SV10 | **Broken** (gate, matcher, model id) + catalogue gaps |
| 15 | Media (`labels.js labelReply`, media join) | Jev picks a picture matching the reply's check | 21 items cover 17 of 171 notes; shown in 17/308 turns; Dyson turn 1: none | Thin data; multi-check replies rarely "match" |
| 16 | Heading (`turn.js:604`) | "Likely cause: <narrowed>" shown every turn once set | 30 turns; VC-02 showed "battery — flat or failed" while the fault was the filter | **Harms** when Jev is wrong |
| 17 | BFF `sanitizeReply` (`index.js:725`) | strips markdown bold/bullets | | Neutral |
| 18 | Error-code lookup (`mcp.js`) | resolves codes via the service | resolved in 13 cases; junk tokens sent ("RED LIGHT FLASHI") | Useful, untested against Opus alone |
| 19 | Hazard detection + fixed safety wording (`safety.js`) | word lists + Jev; fixed copy | 6 safety-stop outcomes, 4 unsafe-request | Keep (deterministic backstop) |

Experiments still wired but off in live: `compose.js`, `evidence.js`, `jevChooses` (≈450 lines). Dead: `reply.js`
REPLY_SYSTEM; "Worth checking" strip and `suggestedChecks: []` in the BFF.

Latency: median 22.9 s per turn, max 40.6 s against a 45 s timeout; three LLM calls and two Jev calls per turn.

## Why the tests and the scores missed this

- The judge scores 11 dimensions **0–4** as an overall impression (`evaluation/rebuild/judge.mjs:37`,
  `evaluation/independent-100/lib/rubric.mjs`). It is given each case's `expected` block but never asked to check
  its items one by one. No dimension covers length, layout or one-step-at-a-time.
- It saw the faults and did not mark them down: VC-02 rationale names the stale "battery" heading; overall 3/4, the
  same as every other system on that case.
- Scores bunch: Opus pipeline 85 of 100 cases at 3 or 4. The gaps between systems (3.16–3.47) are within that noise.
- The case set has 38 part cases but no "customer says the part is broken, give me the part" ending for the Dyson
  path; VC-02 is tagged no-part.
- The simulated customer reads walls of text and does every check; a real customer does not.

## What is proven, and what is not

Proven: steps 1, 3, 4, 6, 7, 8, 9 (formatting), 14 and 16 make answers worse or block parts, with the evidence above.
Not proven either way: the value of steps 5, 10–13, 15, 18 and 19 against Opus alone. That needs a test that checks
specific expected content (pass/fail per case), not an overall score.
