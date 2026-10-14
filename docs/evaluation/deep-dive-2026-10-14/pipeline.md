# Appliance Clinic: one customer chat turn, end to end, and where the design limits answer quality

Repo `/home/user/appliance-clinic`, branch `r3/regen-time-budget`. All paths below are relative to the repo root. Measured
numbers come from `evaluation/rebuild/out/independent-100-21.16/conversations/ac3/*.json` (100 conversations, 302 turns).
The aggregation script is `scratchpad/stats.py` (run as `python3 -I stats.py .` inside the run directory). Its output is
quoted where it is used.

---

## 0. Request path at a glance

| # | Step | File:line | Model / params | What it sees |
|---|---|---|---|---|
| A | Browser builds the payload | `apps/web/public/chat-session.js:18,53-73,203-219` | none | `MAX_API_MESSAGES = 12`: the opening customer message + the last 11. The photo goes only on the latest turn; earlier photos become `'[Sent a photo] '` |
| B | BFF window + rate limit | `services/whichpart-api/index.js:93-110,490`, `config.js:17` (`MAX_MESSAGES = 12`) | none | Same 12-message window again |
| C | BFF turn: load record, recall lookup, call engine | `services/whichpart-api/ac2-turn.js:79-110`; recall `index.js:531-547` | engine timeout `AC2_ENGINE_TIMEOUT_MS` 45 000 ms (`ac2-turn.js:12`) | The record (`AC2STATE#`, ≤96 KB, `ac2-state.js:19,52`) plus the messages. Recall lookup uses only string content and at most 6 tokens (`index.js:532-533`) |
| D | Engine handler | `services/diagnosis-engine/handler.js:57-65` | none | `messages.slice(-MAX_MESSAGES)` with a default of 12 (`engine/config.js:40`). `image` is passed (`handler.js:65`) but **`ac2.turn` ignores it** (`ac2/runtime.js:44` destructures only `{messages,state,tools}`) |
| E | Runtime wiring | `ac2/runtime.js:44-64` | Qwen = admin `compose` provider (`engine/config.js:27-34`, `inference.js:350-373`). Jev timeout 12 s, 2 attempts (`runtime.js:18,52`) | The same Qwen model serves understand, reasoner and claim extractor. In the run it was `lmstudio / qwen3.6-35b-a3b-mtp` (meta.ac2.provider) |
| 1 | Gas/fire early stop | `ac2/turn.js:336-346` | none | Word-list over **all** customer messages (`safety.js:118-128`) |
| 2 | Understand (Qwen) | `ac2/understand.js:60-72`, called `turn.js:349` | `maxTokens 400, temperature 0, timeout 30 s, json_schema` (`understand.js:65`) | **Only the latest customer message + the previous assistant message** (`understand.js:61`). Output caps: codes 4, checks 4, facts 4, symptom 160 chars (`understand.js:50-55`) |
| 3 | Label (Jev) | `ac2/labels.js:64-111,184-189`, `turn.js:352-357` | `typesafe/jev`, choice threshold 0.45, noul threshold 0.65 (`labels.js:17-18`) | Latest message, previous assistant message, Qwen reading, `Rec.known` (`labels.js:109`). Token options dropped if >40 chars, max 32 (`labels.js:50-61`) |
| 3b | applyLabels → record, stage | `turn.js:84-104` | none | Symptom is set **once**, from the first message that gives one (`turn.js:92`). Stage 2 starts on any confirmed check + `still_faulty`/`helped_then_returned` (`turn.js:102`) and never returns to 1 |
| 6a | Hazards | `turn.js:110-119,361-370` | none | Jev label + word-list over the whole conversation. Hazards persist forever (`turn.js:111` add-only) |
| — | Scope | `turn.js:372-383` | none | Fixed copy |
| 4 | Enrich | `turn.js:122-149`, `knowledge.js:69-125`, `mcp.js:7-58`, `models.js:47-58` | MCP timeout 8 s (`mcp.js:7`) | Retrieval text = record symptom + **last 3 customer texts** (`turn.js:124`). Top 3 docs (`knowledge.js:98`), 3 normal notes (`knowledge.js:114`). Code lookups for the last 3 codes (`turn.js:136`) |
| — | Parts (stage 2) | `turn.js:391-403`, `parts.js:26-37` | none | Only when `rec.narrowed && model` and no blocking hazard |
| 7 | Decide (plan) | `turn.js:152-206` | none | See section 1 |
| 8 | Reason (Qwen) | `ac2/reasoner.js:133-169` | `maxTokens 1800, temperature 0.3, timeout 60 s, json_schema strict`. Retry at `temperature 0.2`, no response_format (`reasoner.js:133,147,155`) | The SYSTEM prompt (6 856 chars) + one JSON user message: every message in the window, ledger, tools, knowledge, normal notes, safety, plan (`reasoner.js:134-145`) |
| 8b | Claim check (Qwen extractor + deterministic) | `turn.js:285-302`, `verifier.js:158-218` | `maxTokens 700, temperature 0, timeout 30 s, json_schema` (`turn.js:288`) | Draft sentences, evidence facts, all customer texts in the window |
| 8c | Regenerate once | `turn.js:304-313,433-443` | Same reasoner call + `correctionFromSystem` | Only if `needsRegeneration` **and** it fits the 26 s budget (`turn.js:48,434`) |
| 9 | Final check gates | `turn.js:447-477`, `safety.js:153-170` | none | See section 5 |
| 10 | Media + reply label (Jev) | `turn.js:479-496`, `labels.js:147-174` | Jev | Reply text, ≤8 media (`runtime.js:28`), checks as options (broken, see F2) |
| 11 | Response, record and audit to the BFF | `turn.js:498-518`, `ac2-turn.js:104-109` | none | Diagnosis card only from Jev `narrowed` (`turn.js:508`). `modelRequired` panel when stage 2 has no model (`turn.js:511`) |

Measured latency (21.16): `reasonMs` p50 11 866 / p90 14 896 / max 19 642; `totalMs` p50 17 553 / p90 21 922 / max
27 355 (stats.py). ADR 0021 still claims "About 4–8 s per turn" (`docs/adr/0021-...md`, Consequences).

---

## 1. Instructions that limit reply length, the number of checks or questions, or push escalation

### Reasoner SYSTEM prompt (`services/diagnosis-engine/ac2/reasoner.js`)
| Line | Instruction | Effect |
|---|---|---|
| 19 | "plan … Follow it; where it conflicts with your own next step, **the plan wins**." | Every plan rule below overrides the model's own judgement |
| 21 | "the **single most useful next step** … ask **at most two** closely related questions" | Caps questions and checks per reply |
| 24 | "Once it is settled, say what to do next and don't keep asking." | |
| 25 | "If the fault needs an engineer (sealed system, gas, mains wiring, internal microwave work, **a part that needs dismantling beyond basic owner checks**), say so plainly." | Broad escalation trigger |
| 27 | "Never give part numbers, and never describe how a specific model is built" | Limits explanation depth on the customer's model |
| 29 | Recall: "tell the customer plainly to stop using it" | |
| 39 | "Do not repeat long safety warnings … a short reminder is fine." | |
| 41 | "**Usually 3–8 sentences**; a short numbered list is fine … give a fallback ('if that doesn't fix it…') **and when to call an engineer**." | Hard length guidance, plus an engineer mention in every reply. Measured: 100 of 302 replies mention an engineer or electrician; sentences per reply p10/p50/p90/max = 3/5/8/14 |

### Plan (`decide()`, `services/diagnosis-engine/ac2/turn.js`)
| Line | Rule | Effect |
|---|---|---|
| 157 | `They asked: "<q>" - answer that first.` | Fires on non-questions: "pls help" ×5, "help" ×1, "whats going on", "what do i do" (21.16 plan counts) |
| 159-160 | Fixed: "one short tip … ask if there is anything else" then **`return plan`** | Skips every later line, hazard lines included. `rec.outcome='fixed'` is sticky: nothing resets it (`turn.js:100,494-496`), so "it came back" still gets the fixed plan |
| 163-164 | No appliance: "ask which appliance … **Keep it short**." then `return` | No diagnosis at all until the appliance is labelled, even when brand, code and symptom are known |
| 168-170 | Hazard in `MUST_BE_CHECKED` (`turn.js:51`: burning, battery, electric_shock, microwave_arcing, **electrical_water**, supply_trip): "It must not be used again until a qualified engineer has checked it: say that plainly … never … imply … they might not need an engineer." Other hazards: "recommend {who}" | Forces escalation for the rest of the conversation (hazards never clear) |
| 177 | nothingNew: "if an engineer is needed, explain how to arrange one" | |
| 183 | "Keep to it: never describe a symptom, result or state they have not told you." | The symptom is frozen at its first value (`turn.js:92`) |
| 188 | Stage 1: "give **the one or two safe checks, or the one question** … **Do not ask for the model number in this reply.** Do not tell them to buy, order or replace a part yet." | Caps stage-1 replies at 1–2 checks **or** 1 question. Fired in 139 plans |
| 189 | Unresolved code: "never guess a meaning" | |
| 195 | Stage 2, no model: "ask for the … **model number so we can find the right part**" | Fires whenever stage 2 has no model, **regardless of whether any part is implicated** (`rec.narrowed` is not checked). 41 plans. 57 of 302 replies mention "model number" |
| 197 | Stage 2, model unreachable: "give the next check or say what the likely part is" | 13 plans |
| 199 | Verified part: "Mention when an engineer is the better choice." | |
| 201 | No catalogue part: "suggest the manufacturer's spares **or an engineer**" | 7 plans: the run had 1 verified part and 7 `no_catalogue_part` |
| 203 | Stage 2 default: "Give the next check …; **do not tell them to buy, order or replace it**." | 68 plans |

### Other forced escalation, outside the prompt
- `turn.js:498`: `escalation = hazard ? {…, forced:true} : …`. Any persisting hazard, recall included, forces escalation on
  **every** later turn. Measured: 41 of 302 turns forced. 20 of 23 hazard conversations ended `escalated`, against 22 of 77
  without a hazard.
- `safety.js:118-128`: `detectHazards` rescans every customer message each turn, so one hazard word early in the chat
  stays active.

---

## 2. Knowledge: what exists vs what reaches the reasoner

Two compaction passes run: `compactDoc` (`knowledge.js:69-92`), then `compactKnowledge` (`turn.js:147`).

Inventory (command: node over `knowledge/*.json`):
`docs 171`, keys `knowledgeId, version, applianceFamily, faultId, make, platform, label, outcome, componentFamilies,
likelyComponents, symptoms, discriminators, alternatives, clarifyingQuestion, checks, provenance, components,
commonConfusion, secondaryQuestion, adviceBeforeReplacement, text, mediaInformation(16), safetyInformation(11)`;
`journeys 63` covering **56 distinct knowledgeIds**; journey check kinds `ask_check 255, ask_observation 127, ask_identity 112`.

What the reasoner receives per doc (`turn.js:147`): `fault (=label), likelyCauses, components (=likelyComponents),
ownerSafeChecks, discriminators, commonConfusion`. At most 3 docs (`knowledge.js:98`).

### Dropped fields
| Field | Where dropped | How much content is lost |
|---|---|---|
| `knowledgeId` | `turn.js:147` (kept by compactDoc, dropped here) | The SYSTEM still asks for `assessment.knowledgeIds` "you relied on" (`reasoner.js:59`), but the model never sees an id |
| `beforeReplacingAPart` (`adviceBeforeReplacement`) | `turn.js:147` (compactDoc builds it at `knowledge.js:90`) | Non-empty in 73 docs, 214 items |
| `clarifyingQuestion` | never read | Non-empty in **100** docs: the engineer-written best discriminating question |
| `secondaryQuestion` | never read | 43 docs |
| `components` (`name/type/partName/supports/against`) | never read | 85 docs, 428 entries, with `supports` (421) and `against` (374) evidence lists |
| `alternatives`, `symptoms`, `componentFamilies`, `outcome`, `text` (avg 2 629 chars, max 12 313) | never read | |
| Journey `ask_observation` (127) and `ask_identity` (112) checks | `knowledge.js:74` (`if (c.kind !== 'ask_check') continue`) | 239 of 494 journey steps |
| Journey `conclusionNotes` | never read | 63 journeys |

### Truncations
- `causes` and `ownerSafeChecks` come **only from journeys** (`knowledge.js:72-80`). 115 of 171 docs have no journey
  ("docs with >=1 journey: 56 of 171"), so for those docs the reasoner gets `likelyCauses: []` and
  `ownerSafeChecks: []`. 55 of the 115 have a `components` list with supports and against that could stand in, and
  it is dropped.
- `ownerSafeChecks` ≤6, each ≤320 chars (`knowledge.js:75-76`). `causes` ≤8 (`knowledge.js:86`).
- `discriminators` `.slice(0,4)`, each trimmed to 260 chars (`knowledge.js:87`): 154 of 581 discriminators dropped; 146 of
  the 427 shown are cut mid-text.
- `commonConfusion` `.slice(0,3)`, each 260 chars (`knowledge.js:88`): 34 of 144 shown are cut.
- Normal notes: top 3 with fields `id, normal, warningSigns` (`knowledge.js:124`).
- Retrieval is bag-of-words over label, symptoms and faultId (`knowledge.js:33,98-110`), using the frozen symptom + last
  3 customer texts (`turn.js:124`). Example from DW-01 turn 1, "not draining", retrieved
  `["dishwasher:not-draining","dishwasher:leak-flood","dishwasher:fill"]`.
- Error codes (`mcp.js:38-58`): RESOLVED keeps meaning, confidence, components, likelyCauses, checks and stopUse. Other
  statuses keep only ≤3 `possibleMeanings`. A missing make returns `NEEDS_CONTEXT` without a call (`mcp.js:9`). Run:
  `RESOLVED 29, NOT_FOUND 17, AMBIGUOUS 7, NEEDS_CONTEXT 3`. The in-process `errorcodes.js lookup()` is not used on
  this path: `turn.js` uses only `candidateTokens` and `brands` (`turn.js:69,71-73`).

---

## 3. Conversation windows
| Consumer | What it sees | Proof |
|---|---|---|
| Browser → BFF | ≤12 messages (opening customer message + last 11) | `chat-session.js:18,53-73,204` |
| BFF | Re-windowed to 12 | `index.js:93-110,490`; `config.js:17` |
| Engine | `slice(-12)` | `handler.js:59`; `engine/config.js:40` |
| **Understand (Qwen)** | **1 customer message + 1 assistant message** | `understand.js:61`; `turn.js:349` |
| Jev labels | Latest + previous assistant + reading + `known` | `labels.js:109` |
| **Reasoner** | **All ≤12 window messages** (no further slicing) + record | `reasoner.js:121-123,136` |
| Claim extractor | All customer texts in the window | `turn.js:330,429`; `verifier.js:164-167` |
| Retrieval | Symptom + last 3 customer texts | `turn.js:124` |
| Record memory | checks ≤12, facts ≤16, asked ≤10, advice ≤8 | `record.js:60,68,75,86` |

At turn n the request holds 2n−1 messages, so the window starts dropping middle messages at customer turn 7. In 21.16,
5 conversations reached 7 or more turns (`customerTurns hist {..., 7: 3, 8: 2}`).
`reply.js:39` (`slice(-16)`, 2 000 chars per message) is not on the live reasoner path; see 6.

---

## 4. Reasoner maxTokens vs actual use
- `maxTokens = 1800` (`reasoner.js:133`). Measured `completionTokens` (n=289): min 330, p50 626, p90 754, p99 897,
  **max 982**; turns ≥1000 tokens: **0**. maxTokens never binds.
- `promptTokens` p50 3 898, max 5 848. They grow per turn: turn 1 averages 3 399, turn 7 averages 5 288.
- The reply is a small share of the output. Assistant reply chars p50 595 / mean 613, about 150 tokens at ~4 chars per
  token (an estimate). The other ~75% of completion tokens is the `understanding / assessment / next / part /
  escalation` JSON (`reasoner.js:43-66`). Of that JSON, `turn.js` reads only `reply`, `assessment` (audit only,
  `turn.js:444-445`) and `next.question` (a fallback only, `turn.js:448`). **`understanding`, `part` and `escalation` are
  never read** (grep `proposal\.` in turn.js shows lines 444, 445 and 448 only).
- Normalise caps: reply 2 400 chars, candidates 5, newFacts 12 (`reasoner.js:194,201,209`).
- Reply length is therefore set by the prompt ("Usually 3–8 sentences", `reasoner.js:41`) and the plan, not by tokens.

---

## 5. Deterministic post-processing that removes or rewrites content, and 21.16 firing counts

Counts from `meta[].ac2.safety.gates` and `claimsRejected` (stats.py). Format: events / turns / conversations.

| Gate | Code | What it does | 21.16 |
|---|---|---|---|
| Claim check: sentence removal | `turn.js:285-302`, `verifier.js:196-218` (`neutralise`) | Removes every sentence with an unsupported claim. **Not logged as a gate** | **149 rejected claims in 110 of 302 turns** (detector 78, extractor 71); 434 checked |
| Regeneration | `turn.js:304-313,433-443` | Only if the removal empties the reply, loses its `?`, or cuts it below 40%, and it fits 26 s | **1** regenerated turn |
| regeneration-skipped | `turn.js:435-436` | Time budget | **10 / 10 / 10** |
| prohibited-advice | `safety.js:93-108,153-170` | Removes the sentence | touch-plug-near-water 4/4/3, hv-microwave 3/3/2, refrigerant 1, run-after-burning 1 |
| unsafe-reassurance | `turn.js:53,451-456` | Removes the sentence under a MUST_BE_CHECKED hazard | 4/4/4 |
| certainty | `turn.js:227-233` | Rewrites words ("confirms" becomes "suggests", and so on) | **68 / 68 / 48** |
| part-before-confirmed | `turn.js:253,262` | Removes buy/order sentences when not narrowed | 6/6/6 |
| replace-before-confirmed | `turn.js:255,264-269` | Rewrites "replace" to "check" | 9/9/9 |
| recall-denial | `turn.js:254,261` | Removes the sentence | 0 |
| unverified-identifier | `turn.js:209-220` | Removes sentences with a 6+ char alphanumeric token not in the customer's text | 6/4/3 |
| Empty-reply fallback | `turn.js:465` | Fixed "Could you tell me a little more…" | 0 replies |
| unsafe-request prefix | `turn.js:472-473` | Prepends fixed copy | 4/4/4 |
| step-precaution prefix | `turn.js:235-245,474-475` | Prepends an isolation sentence | 17/17/14 |
| Hazard copy prefix | `turn.js:467-471` | Prepends fixed copy once per hazard | (not a gate entry) |

Turns with any `safety.gates` entry: 112 of 302.

**Why regeneration almost never runs:** `fits = elapsed + r.ms + verifyMs <= 26000` (`turn.js:434`), and `elapsed`
already contains the first `r.ms`. Applying that formula to measured timings, a regeneration would fit in only **57 of 289**
turns. Most rejected-claim turns never hit `needsRegeneration` anyway, because removing one sentence leaves >40% of the
reply, so the removal stands silently.

**Removals that cut good content (false positives).** Command: python over `FF-04`, `FF-02`, `DW-06`, `DW-12`.
- FF-04 turn 4. Customer: "seal split about 5cm and flattened at the hinge side. whats the part to search for?"
  Rejected: "The split and flattening you described is letting warm air in…". `regeneration-skipped` (elapsed 17 657 ms).
  Sent reply is 2 sentences: "You need a replacement door seal (gasket). Search for …". The explanation was deleted.
- DW-12 turn 1. Customer: "Kitchen sink was replaced last month if that matters." Rejected: "Since you mentioned the
  sink was replaced recently, there are a few likely causes: …". The only sentence tying the fault to the new sink
  (drain hose or air-gap installation) was removed. Cause: the detector's majority-coverage rule
  (`verifier.js:139-143`, `n/c.size >= 0.5`) is applied to the whole long sentence.
- FF-02 turn 5. The customer said exactly that the water stopped after clearing the hole. Both sentences saying so were
  rejected.
- DW-06 turn 2. "now that you've removed the blockage" was rejected although the customer said "did the filter, its
  full of food".

---

## 6. Dead, duplicated or contradictory

### Dead
- **F2 (bug): the reply's check is never recorded.** `labelReply` builds check options with
  `tokenOptions(checks.map(c => c.slice(0,140)))` (`labels.js:150`), but `tokenOptions` skips any string longer than 40
  chars (`labels.js:55`). Every `ask_check` string is at least 52 chars ("ask_check strings: 255 min len 52 <=40: 0"),
  so the `check` question is never asked. Node proof for a retrieved dishwasher case:
  `reply-label questions: [ 'replyAction' ] plan.checks 0`. 21.16: `checkGiven` null in **302 of 302** turns. Consequences:
  `Rec.checksAwaitingResult` is always `[]` (`record.js:95-97`), so the plan line "They have not reported the result of"
  (`turn.js:176`) never fires (0 in the plan counts); `markChecksReported` is a no-op; and `adviceSummary` says only
  "turn N: gives check" (`record.js:103-105`), so the reasoner is never told *which* check it gave.
- Reasoner outputs `understanding` (incl. `newFacts`), `part` and `escalation` are never used (section 4). SYSTEM lines 34
  ("Record new customer facts … in understanding.newFacts") and 24 ("name the component in 'part' (the system checks
  the model and the parts catalogue)") describe behaviour that does not exist. The part gate uses Jev `narrowed`
  (`turn.js:103,395`), and escalation uses Jev `replyAction` or a hazard (`turn.js:498`).
- `assessment.knowledgeIds` can never be correct because the ids are stripped (`turn.js:147`).
- `ac2/reply.js` `writeReply`, `briefing` and `REPLY_SYSTEM` are unused on the live path. Only `chatHistory` is used, by
  the evaluation ablation `plain` (`runtime.js:16,83`). REPLY_SYSTEM's "3 to 7 short sentences", "at most one or two
  checks" and "no lists of more than 3 steps" (`reply.js:17,23`) are therefore dead, but they still read like live rules.
- `image` is forwarded by the BFF (`index.js:552`, `ac2-turn.js:93`) and the handler (`handler.js:65`), and dropped by
  `runtime.turn` (`runtime.js:44`). The models see only "[photo attached]" (`util.js:6`, `reasoner.js:126`).
- `errorcodes.js` `lookup()` is unused on this path. `beforeReplacingAPart` is computed and then dropped.
- `inference.js:163-168`: on the `openai` param style, `temperature` is omitted, so the configured 0 / 0.3 / 0.2 values
  are ignored when the frontier route is used. The 21.16 run used lmstudio.

### Duplicated
- Understanding is done twice. `understand.js` (Qwen, 1 message) and the reasoner's `understanding` block (`reasoner.js:45-54`,
  full window) extract the same fields. The second is discarded but costs output tokens and latency on every turn.
- `textOf`, `stripThinking` and `parseJson` are copied in `reasoner.js:109-127` and `util.js:4-19`.
- Hazards are detected twice (`turn.js:361` and `turn.js:389`), by design.
- Window logic is repeated three times (`chat-session.js:53`, `index.js:93`, `handler.js:59`).

### Contradictory
| Plan / code | Reasoner SYSTEM | Conflict |
|---|---|---|
| Stage 1: "one or two safe checks, **or the one question**" (`turn.js:188`) | "ask at most **two** closely related questions" (`reasoner.js:21`) | The question cap differs (1 vs 2). The plan wins (`reasoner.js:19`) |
| Stage 1: "Do not ask for the model number" (`turn.js:188`); stage 2: ask for the model "so we can find the right part" even with nothing narrowed (`turn.js:193-195`) | "use the model number and any error code" (`reasoner.js:14`) | DW-06 turn 2: a stiff spray arm (a cleaning fix) got a model-number request plus a UI panel (`turn.js:511`) instead of the fix |
| Unresolved code: "never guess a meaning" (`turn.js:189`) | "if a code could mean different things, **say what it most likely means**" (`reasoner.js:26`) | Direct contradiction |
| "Do not tell them to buy, order or replace a part yet" (`turn.js:188,203`) and gates (`turn.js:253-269`) | "name the component in 'part'" (`reasoner.js:24`) and the opening "the likely faulty part" (`reasoner.js:14`) | `part` output is dead; the reply-level advice is cut |
| Hazard: "must not be used again until a qualified engineer has checked it" for **electrical_water** (`turn.js:51,168-169`) | "get the customer to the most useful outcome quickly (a fix they can safely do …)" (`reasoner.js:14`) | A leak near a plug forces an engineer for the whole chat |
| Fixed / no-appliance early `return` (`turn.js:160,164`) | Safety rules | The hazard plan line is skipped on those turns |
| ADR 0021 Consequences: "No claim verifier … About 4–8 s" | Amendment 21.11 restores the verifier; measured p50 17.5 s | Stale ADR text |
| ADR 0021 step 8: "the plan … attached to the latest customer message as a marked note" | Live code puts the plan as a JSON field (`reasoner.js:142`); `reply.js:36-41` is dead | Stale ADR text |

---

## 7. Other limits found on the way
- Symptom frozen at first mention (`turn.js:92`) while the plan forbids describing anything else (`turn.js:183`).
- Stage 2 is entered on the first reported check that did not fix it (`turn.js:102`) and is never left; the
  stage-2 plan has no "stage 1-style broad help" option.
- Jev threshold: a choice under 0.45 is treated as "not stated" (`labels.js:17,116`). In DW-01 the model token "24" was
  labelled as the model (0.79) for the code "E:24". The plan then said "never ask for it again: … model 24".
- Hazard prefix copy, the step-precaution prefix and the unsafe copy are prepended before the model's text
  (`turn.js:466-476`), which pushes the useful content down.
- Engine timeouts: the reasoner gets 60 s plus a retry of 60 s (`reasoner.js:133,155`), but the BFF waits only 45 s
  (`ac2-turn.js:12`), so a slow reasoner surfaces as `engine_unreachable` even when the engine would succeed.
