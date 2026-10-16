# One customer message, step by step (from the code only)

## Browser → API
1. `apps/web/public/app.js ask()`: sends the chat (last 12 messages, first message always kept), the state token, and
   on a new chat the Turnstile token.
2. `whichpart-api/index.js:498-515`: rate limits, bot check, then `ac2Respond`.
3. `ac2-turn.js handle()`: verifies the state token, loads the saved record from DynamoDB, looks up recalls by
   model-like words, sends `{messages, state, recalls, image}` to the engine (45 s limit).

## Engine (`diagnosis-engine`)
4. `handler.js`: checks the signature; calls `runtime.turn({messages, state, tools, image})`.
5. `ac2/runtime.js:44`: `turn({messages, state, tools})` — **`image` is not taken; photos are dropped here.**
   Loads the model (Opus), Jev, the error-code service, the parts catalogue and media.
6. `turn.js:388` gas/fire words in the latest message → fixed emergency text, stop.
7. `understand.js` (Opus call 1): reads **only the latest message + our previous reply**; returns appliance,
   brand, model, codes, symptom, question, up to 4 checks and 4 facts.
8. `labels.js labelMessage` (Jev call 1): labels scope, appliance, symptom area, hazard, unsafe request, answer to
   our last question, check outcome, model unreachable, model/code/make among candidate words, confirms each of the
   4 checks/facts, and — **only if a check is already recorded** (`labels.js:105`) — whether the fault is narrowed to
   one of the note's `likelyComponents` phrases.
9. `applyLabels` (`turn.js:89`): writes the record. **Stage 2 only if Jev says a check failed or narrowed**
   (`turn.js:107-108`); otherwise the chat stays in stage 1.
10. Hazards (`turn.js:115`): Jev label + word lists; a hazard stays active for the rest of the chat unless the
    customer later denies it.
11. Scope: unrelated or attack → fixed text, stop.
12. `enrich` (`turn.js:144`): error codes via the service; knowledge notes by keyword match (BM25, top 3,
    `knowledge.js retrieve`); normal-behaviour notes; model-series hints.
13. Parts (`turn.js:449`): **only if stage 2 AND narrowed AND a model AND no "blocking" hazard** (gas, fire,
    burning, battery, shock, arcing, trip). The narrowed phrase must match the catalogue via `parts.js`: word match
    without plurals, so "filters" ≠ "filter".
14. `decide` (`turn.js:187`): code writes the instructions. **Stage 1: "give the safe checks… usually two to four…
    Do not tell them to buy, order or replace a part yet."**
15. `reasoner.js` (Opus call 2): system prompt + everything as one JSON message. **Style: "the checks as a short
    numbered list… Be as long as that needs."** Reply cut at 2400 characters (`reasoner.js:168`).
16. Claim check (`verifier.js`, Opus call 3 + regex): every sentence that "attributes something to the customer"
    or matches the `STATE` pattern ("the water runs…") must be backed by the record's facts (only what steps 7–8
    stored). Unbacked → **the sentence is deleted**. A rewrite happens only if the reply lost its question, lost 60%
    of its length or became empty, and only within 26 s. Rebuild squashes whitespace (paragraph breaks lost).
17. `safety.js gateReply`: deletes sentences with banned advice; **squashes whitespace on every reply**.
18. Under a "must be checked" hazard: deletes reassurance sentences.
19. `calibrate`: swaps words ("definitely" → "most likely", "almost certainly" → "probably"…).
20. `removeUnconfirmedAdvice`: deletes "buy/order a part" sentences and turns "replace the X" into "check the X"
    unless narrowed.
21. `removeUnverifiedIdentifiers`: deletes sentences with part numbers or prices not said by the customer.
22. Prefix: hazard warnings, unsafe-request text, and "switch it off and unplug it first" when a physical step has
    no isolation step.
23. Media (`runtime.js mediaCandidates`, `media.js selectMedia`): only media mapped to the retrieved notes; then
    **Jev (call 2) must say the reply's check matches one**, else no image.
24. Jev's reply label is stored (what the reply did, which check) for the next turn's plan.
25. Response: reply, parts (if verified), heading `Likely cause: <narrowed>` (**kept for every later turn**), safety
    panel, media.

## Back to the browser
26. `whichpart-api` saves the record, builds the view: strips markdown, heading = `diagnosis.summary`, first sentence
    = bold lead (`app.js addBotTurn`), rest = body (line breaks shown).

## Not on the reply path / switched off
- `compose.js`, `evidence.js`, `jevChooses`: experiments, off.
- `reply.js` prompt (short, "3 to 7 sentences"): not used by live turns.
- `errorcodes.js`: a second, local copy of the error-code data (used to spot codes/brands).
- Not read line by line: login, admin pages, logging, health, transcript storage, recall ingest.
