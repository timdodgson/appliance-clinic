# As-built trace: hop tables and evidence (Phase 10)

Source: `timdodgson/appliance-clinic` at `origin/main` = `ec48371` (read-only; no AWS calls).
Everything below is derived from code. `docs/architecture/overview.md` was used only as a hint; disagreements are listed in §3 Q12.
Line numbers are for `ec48371`. "BFF" = `services/whichpart-api`, "orch" = `orchestration/`, "engine" = `services/part-finder`.
"Not determined" means the answer depends on deployed configuration or code that is not in the repository.

Abbreviations: cs/1 = canonical ConversationState schema; mc/1 = canonical message classification; NA = NextAction.

---

## 1. Hop table: AC customer turn

| # | Hop | Source (file:line) | Caller / auth | Request contract | Response contract | State | Deterministic logic | Model | Fallback / error behaviour | Telemetry / transcript | AC-only or S4R-sensitive |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | Browser → BFF customer chat route | `services/whichpart-api/index.js:226-232` (handler), `:571` (POST only), `:573-575` (JSON) | AC browser through CloudFront `/api*` to the Function URL. **No authentication on the chat route.** The only gates are the rate limit (`:617-620`, `rate-limiting.js:16-28`, `RATE_LIMIT_MODE=enforce` in `runtime-overrides.json`) and optional admin (`liveTest`, `:553-558`) or HMAC benchmark (`:566-580`) | `{messages[] (client-carried, user AND assistant turns), stateToken?, observability{sessionId, clientTurnId, event}?, feedback?, liveTest?, benchmark?}`. The route is chosen by method and body shape, not by path. Any POST that matches no admin path is a chat turn | WhichPart view (`:875-1004`): `{requestId, traceId, reply, advisory, safety, pendingRequest, safetyInformation, needsModel, extractedModel, media, diagnosis, components, suggestedChecks, parts, stateToken?}` | Reads the client transcript. Windowed to `MAX_MESSAGES=12` (`:174`, `:149-166`) | `conversationWindow`, `sanitiseConversation` (`:168-199`) | None | Bad JSON → 400. No messages → 400 | `log evt:whichpart-api` (`:709-756`) | AC-only |
| 1a | Feedback side channel | `index.js:590-600` | BFF → engine Function URL, **unauthenticated** | `{feedback}` | Always `200 {ok:true}`, even when the forward fails | Engine writes to the S3 learning log (`part-finder-lambda.js:150-153`) | — | None | Failure is logged and swallowed | — | Engine side is S4R-shared |
| 2 | Session / canonical prepare | `index.js:626`, `:787-806`. `conversation-state.js:74-83` (mode), `:237-303` (prepareTurn), `state-token.js` | In-process. Token is HMAC-signed; current and previous secrets come from Secrets Manager (`state-token.js:87-110`). Note: `CANONICAL_TOKEN_PREVIOUS_SECRET_ID` is the old `spares4repairs/dev/...` secret (`runtime-overrides.json`) | `body.stateToken` | ctx `{mode, block, token, csid, version, priorState, degraded, duplicate}` | **Reads** DynamoDB `whichpart-transcripts`: `STATE#csid` (ConsistentRead), `STATETURN#csid#v+1` (one-step recovery), `STATECLIENT#csid#ctid` (idempotency). Recovery **re-runs `merge()` in the BFF** (`:332-346`) and writes `STATE#` (`:279`) | Mode `off`/`shadow`/`control`. `control` with no valid allow-list key is demoted to `shadow` (`:77-80`). Invalid token → new csid, no block (`:248-254`). Duplicate clientTurnId → cached view (`index.js:630-641`) | None | Every failure sets `degraded` and the turn continues on the legacy path. Logged as `canonical-prepare` | `canonical-prepare` log | AC-only |
| 3 | BFF → orchestrator | `index.js:818-872` (payload `:829-841`; fetch `:849`); `orchestrator-retry.js:34-44` | Bearer `ORCHESTRATOR_TOKEN`. Timeout `ORCH_TIMEOUT_MS`, default 120 s (`config.js:20`). Retries 2× **on 429 only** | `{message (labelled "Customer:/Advisor asked:" transcript, or the joined user text), sessionId (observability.sessionId, else "wp-"+hash of the first user text, index.js:125-126, :767-770), includeEnrichment:true, latestMessage, turnIndex, conversation (sanitised; assistant text capped at 900 chars), image?, canonical? (cs/1 block)}`. **`pendingRequest` is NOT forwarded** (the orch reads `data.pendingRequest`, lambda_handler.py:117) | orch JSON (below), plus `_diagnosticTrace`, `_canonical` | — | `deriveContext` (`index.js:97-146`) is structural only | None | Throw / non-2xx / timeout → `fallbackView` ("Sorry — something went wrong…", `error:true`, `:651-660`, `:1044-1052`). Canonical state is not advanced | — | AC-only |
| 4 | Orchestrator handler | `orchestration/deploy/lambda_handler.py:87-163` | Bearer, compared with `hmac.compare_digest` (`:47-51`). `/health` is unauthenticated. Function URL auth `NONE` | Body as in hop 3 → `TurnInput` (`:121-134`). The `canonical` block is shape-checked only (`:37-44`). Also accepts `make, appliance, displayedCode, observed[], intent, pendingRequest, region, fuel, identitySource` (not sent by the BFF) | `resp.customer_view()` plus `_diagnosticTrace` (`:54-84`) plus `_canonical` (`:157-158`) | — | — | None | Any exception → **HTTP 200** `{outcome:SERVICE_UNAVAILABLE, message:"The diagnostic service hit an unexpected error…"}` (`:160-163`). The BFF renders this as a normal reply without `error:true` (see Q8) | `log.info` JSON line (`:137-147`) | AC-only |
| 5 | Orch `_load`: state and single legacy Jev UNDERSTAND | `orchestrator.py:310-602` | — | — | `ConversationState` with transient `_jev`, `_understand`, `_canonical` | **Owns `ConversationState` in `InMemoryStateStore`** (`services.py:77-85`), keyed by the client-supplied sessionId. It lives only as long as the warm container, is per-container, and is an unbounded dict. It holds latches: `safetyState` (monotonic high-water mark), `unsafeIntent` (latched true), `modelUnavailable`, `modelRequestedBefore`, `appliance`/`applianceState`, `symptomsText`, `observed`, typed evidence (`model.py:188-204`; `orchestrator.py:493-602`) | Family gate `routing.first_turn_family_decision` (`:419`, `routing.py:235-281`); make from the `routing.MAKES` regex (`:393`, `routing.py:31-81`); code recovery regexes `code_from_cue` and `slash_compound_code` (`:443-461`); cross-turn family precedence (`:493-501`); model-unavailable latch (`:565-590`); `_reconcile_typed_evidence` (`:604-659`) | Calls engine `mode:'understand'` (hop 6) | `RagUnavailable` → `jev={}`, `raw={}`, canonical degraded `understand_unavailable` (`:343-345`, `:277-292`). The turn then routes on empty typed state → usually `_flow_clarify` generic question (masked; see Q8) | — | AC-only |
| 6 | Orch → engine, understand | `services.py:517-556` | **Unauthenticated public Function URL** (`RAG_URL`). httpx, 90 s timeout, **no retry** | `{messages (build_rag_messages), seed:42, mode:'understand', established?, canonical? (cs/1 block)}` | NDJSON. The first `{type:'understand', understand, jev, canonical?}` line is used | — | — | — | Transport or HTTP error, or no understand line → `RagUnavailable` | — | Engine is S4R-shared |
| 7 | Engine understand mode | `part-finder-lambda.js:204-234`; `canonical-runtime.js:208-222`; `engine/understand.js:32-64`; `jev-understand.js:1142-1167`; `jev-mc1.js:19-45` | — | as hop 6 | `{type:'understand', understand: intent, jev: publicObservability, canonical: transport result}` | Canonical: **`merge(prior, mc/1)` runs HERE every turn** (`canonical-runtime.js:56-90`). Then journey routing in registry order (`:166-179`), diagnostics, policy, part gate and NA (`:139-159`). Under control the request is issued into state | Journey ownership functions, `controlRequested` gate = BFF allow-list AND engine kill switch `CANONICAL_Jx_CONTROL != '0'` (`:94-98`) | **Two Jev calls run in parallel when a cs/1 block is present**: legacy `diagnosis.jev.understand` (`evaluateJevWithRetries`, 3 attempts × 15 s) and `diagnosis.jev.mc1` (2 attempts; awaited with a 15 s grace under control, 3 s otherwise, `canonical-runtime.js:25-26`, `:216-217`). Provider: Cloudflare Workers AI model `typesafe/jev` (`jev-client.js:13`) | Legacy Jev failure → `degradedIntent()` emitted as a **normal** understand event with `metric.ok=true` (`:212-217`). mc/1 failure or timeout → transport `degraded: classification_degraded` (`canonical-runtime.js:219-220`); nothing is merged | `metric` log line: `jevInvoked`, `jevError`, `canonicalTransport` | Code is S4R-shared; reachable by S4R only if a caller sends `mode:'understand'` |
| 8 | Orch: scope, canonical gate, routing | `orchestrator.py:670-772`; `routing.py:196-233` | — | — | `OrchestratorResponse` | — | Scope refusal on Jev `requestClass` (`:686-695`). Canonical control when `_canonical.journey` has `control && applies && nextAction` and its key is in the registry (`:821-833`). Otherwise `routing.route` (`:720-733`) → `_flow_error_code` / `_flow_symptoms` / `_flow_combined` / `_flow_clarify` | None (`orchestrator.py:8`) | — | `debug.route` and so on | AC-only |
| 9a | Canonical path: orch → engine diagnose | `orchestrator.py:954-1006`; `services.py:558-653` | Unauthenticated, 90 s, no retry | `{messages, seed:42, understand: raw intent, established?, canonical: merged transport result}` | `done` mapped to a dict (`services.py:620-653`), including `canonicalControl` | — | `_flow_canonical` maps NA kind to an outcome: `safety_stop`, `ask_identity/model` (`modelRequired`, pending MODEL), conclude/recommend_part (`_CAUSE_LABEL`, `:837-952`). Then **`_unsafe_intent_warning` is still prepended** (`:707-709`). The comment at `:698-701` says no legacy override runs | — | `RagUnavailable` → `SERVICE_UNAVAILABLE` "I can't run the diagnosis right now…" (`:965-967`). **`debug["canonical"]` is still returned, so the BFF persists the merged, request-issued state** (see Q8) | `canonicalControl`, `canonicalRule` | AC-only |
| 9b | Engine diagnose, canonical control | `part-finder-lambda.js:359-371`; `canonical-runtime.js:225-315`; `canonical/compose-kit.js:196-282` | — | as 9a | NDJSON `delta` (full reply) + `done` (`canonical-runtime.js:303-313`) | Reads the transported state only | `controls()` checks shape only (`:225-228`). `word()`: a safety stop or decline uses fixed template copy (`:250`). Filters, tripwire, `checkReply` (question count, purchase, model-ask and component regexes, safety markers, `compose-kit.js:250-281`) | `diagnosis.canonical.compose` on the admin-selected COMPOSE provider (LM Studio or OpenAI from the `ai-config` secret, `engine/config.js:48-55`, `inference.js:332-357`). The concrete model is not determined from the repo | Provider exception → template plus violation `compose_failed` (`:267-268`). The BFF turns this into "AI service unavailable" (`index.js:668-678`). `checkReply` violations (`empty`, `extra-questions`…) → **template, presented as normal** | `diagnosticTrace` stage `canonical-control` | S4R-sensitive file (same handler); reachable from the public URL with a forged `canonical` (Q9) |
| 9c | Legacy path: orch flows | `orchestrator.py:1064-1356` (flows), `:1770-2009` (`_compose_symptoms_only`), `:1703-1768` (`_journey_stage`, `_compose_model_acquisition`) | MCP: bearer (`services.py:664-690`) | MCP `resolve-error-code` `{make, appliance, code, observed?, region?, includeEnrichment}` | — | Updates `st.inferred`, `st.safetyState`, `st.safetyReason`, `st.unsafeIntent` (`:1362-1378`) | Orchestrator **rewrites or replaces engine replies**: safety block (`:1408-1435`); normal-behaviour / recovery canned text if prose is under 40 chars (`:1779-1812`); `MODEL_REQUIRED_AFTER_CHECK` **replaces the engine reply** with a fixed model ask (`:1823-1826`, `:1743-1768`); ungrounded clarify (`:1827-1870`); grounded staging (`:1871-2009`); then the owner-safety note (`:750-753`), unsafe-intent warning (`:740-744`), `collapse_code_list` (`:758-759`), `_pending_for` (`:766`) | None | MCP unavailable → `SERVICE_UNAVAILABLE` copy (`:1071-1074`). Malformed MCP result → synthetic `INVALID_INPUT` (`services.py:710-717`) → "What's the model number…" clarify | — | AC-only |
| 9d | Engine diagnose, legacy pipeline (AC) | `part-finder-lambda.js:236-1642` | — | `{messages, seed, understand, established, canonical (trace only)}` | NDJSON `delta` + `done` (`:1617-1634`) | Re-derives "progress" from the message history (`engine/progression.js:165-187`) | See the S4R table (identical code). One difference: `understand` is injected, so Jev is not re-run (`:311-314`) | COMPOSE `diagnosis.compose.system/turn/intent-hints` (`engine/compose.js`) on the admin-selected provider | as S4R | `metric` log and S3 learning trace (`:1643`) | **S4R-sensitive** |
| 10 | Orch response shaping | `orchestrator.py:774-818` | — | — | `customer_view()` plus `understood{make, appliance, displayedCode}` | `self.store.put(st)` (`:817`) | — | — | — | `debug.state` goes into `_diagnosticTrace` | AC-only |
| 11 | BFF view mapping and persistence | `index.js:668-757`, `:875-1004` | — | — | View (hop 1) | **`canonicalFinish` → `finishTurn`** (`conversation-state.js:364-391`): validates `_canonical` (`:349-358`), writes the `STATETURN#` record, then a conditional `STATE#` write. **No merge here; the BFF stores the engine-merged state.** `recordClientTurn` (`:397-406`) | `composeProviderFailed` (`index.js:1035-1039`); `sanitizeReply` (`:1016-1024`); strips "Worth checking:" by regex (`:887`); `needsModel` regex over `clarification.needs` (`:931-935`); FIT invariant (`:893-911`); `pendingRequest` relayed to the browser (`:975-978`) but never sent back | None | Finish failures → `degraded`, logged; the customer still gets the reply | `canonical` block in the `whichpart-api` log (`:733-755`) | AC-only |
| 12 | Transcript persistence | `transcript-store.js:24-28`; `transcripts.js` (`pkOf` `SESSION#`, `:100`) | — | `obs`, messages, view, orch, `canonical-audit/1` | — | `whichpart-transcripts` `SESSION#<sessionId>` (TTL). Written **only when the client sent observability** (`transcript-store.js:25`) | — | — | `persistSafely` swallows errors. If DynamoDB store construction fails it **falls back to an in-memory store** (`:14-19`) | — | AC-only |
| 13 | Transcript review (scheduled) | EventBridge `{transcriptReview:true}` every 15 min → `index.js:233-250` → `admin/transcripts.js:15-22` → `transcript-review/run.js`, `judge.js:34-110`, `jev-review.js` | EventBridge invoke | — | review records | Reads and writes `whichpart-transcripts` | Eligibility (`transcript-review/eligibility.js`) | Provider from `TRANSCRIPT_REVIEW_PROVIDER` (deploy default `jev`, `deploy.sh:248`): `review.transcript.jev`; or `openai`/`lmstudio` with `review.transcript.llm` (`judge.js:42-61`). Live value not determined | Unparseable judge output → error per record (`judge.js:14-22`, `:77`) | `transcript-review-scheduled` log | AC-only |

---

## 2. Hop table: S4R direct turn

| # | Hop | Source | Auth | Request | Response | State | Deterministic logic | Model | Fallback | Telemetry | Sensitivity |
|---|---|---|---|---|---|---|---|---|---|---|---|
| S1 | S4R browser → engine Function URL | `part-finder-lambda.js:101-165` | **None.** Function URL auth `NONE`, CORS `*` (phase-0 findings). Body capped at 8 MB (`:135-138`, `engine/config.js:63`) | `{messages}`, plus any of `seed, mode, understand, canonical, established, feedback`, all accepted unauthenticated (Q9) | Pre-stream errors are JSON with a status. Otherwise NDJSON | `messages` sliced to 12 (`:163-165`) | — | — | 400/413 JSON | — | S4R contract |
| S2 | Retrieval | `:236-301`; `retrieval.js:518-535`, `:575` | — | — | docs | Static knowledge index plus admin overlay (`:131`) | Family from `resolveConversationIdentity` (regex cue tables `identity.js:27-104`, `:478`); `uniqueBrandCodeHit(guessMake, guessErrorCode)` regex (`:263-265`); `isAcousticOnlyQuery` (`:281`) | Embedding `EMBED_MODEL` (default nomic) at `EMBED_URL`/`LM_STUDIO_URL`, 4 s timeout | Embed failure → lexical. Retrieval error → no docs (`:286-288`) | `metric.retrieval` | S4R |
| S3 | UNDERSTAND (inline Jev) | `:309-317`; `engine/understand.js:32-64` | Jev credentials from the `ai-config`/`jev` secret | — | intent | `progress = conversationProgress(messages)` (`:295`) | `correctFollowUpIntent` (`:318`) | `diagnosis.jev.understand` (Cloudflare `typesafe/jev`), 3 attempts | Jev failure **throws** → 503 JSON "AI service unavailable" (`:1644-1670`). Not masked | `metric.jev` | S4R |
| S4 | Scope consequence | `:340-356` | — | — | `REFUSAL_TEXT` + `done` | — | `_requestClass` | — | — | `injectionBlocked` | S4R |
| S5 | Legacy decision chain | `:374-1240` | — | — | mutated `intent`, `fault` | — | identity lock (`:384-397`); code retention (`:398-405`); `resolveFault` (`:575`); evidence (`collectEvidence` `:581`, `commitFromEvidence` `:665`/`:692`); safety (`:709-769`); normal behaviour (`:783-815`); positive observations (`:817-819`); material ambiguity (`:834-871`); area discriminator (`:872-903`); declined discriminator (`:910-917`); progression chain `applyFollowUpNextAction` … `applyPartReadinessProgression` (`:919-950`); HV stops (`:951-978`); `_nextAction` (`:979-984`); `preferSingleVagueClarify` (`:985`); not-done handling (`:986-…`); presentation grain (`:1092-1100`) | — | — | metrics | S4R |
| S6 | Parts | `:1122-1238`; `engine/parts-client.js:23-110` | — | — | parts | — | `selectLinkedParts`/`partsStillInPlay` | — | 2 attempts each. Failure → `{parts:[]}` (masked as "no parts") | — | S4R |
| S7 | COMPOSE | `:1244-1268`; `engine/compose.js:1270-1303` | — | — | text | — | — | `diagnosis.compose.*` on the admin-selected provider; 2 attempts only if no delta arrived | Exception after the stream opened → `{type:'error'}` frame (`:1660-1662`). Empty output → deterministic question (`:1282-1286`) | — | S4R |
| S8 | Post-compose rewriting | `:1275-1406` | — | — | reply | — | tripwire → `REFUSAL_TEXT`; parts-fit language; electrical / HV strippers; `renderDeterministicTerminal` / `ensureCommittedConclusion` (`:1310-1333`); `stripInstructionEcho`; degenerate-ack / re-describe regexes (`:1340-1368`); `ensureOwnerCheckSafety` (`:1371`); `ensureAdviceThenIdentityAsk` (`:1372`); `_exclusiveClarify` overwrite (`:1373-1375`); identity clamp (`:1381-1395`); `ensureNonTerminalProgression` (`:1400`); `avoidVerbatimRepeat` (`:1406`) | — | Several of these replace model prose with canned text (Q8) | `metric.*` flags | S4R |
| S9 | Output | `:1407`, `:1617-1634` | — | — | One `delta` with the whole reply, then `done{traceId, parts, understood, safetyInformation, safetyStop, isolationAdvisory, unsafeIntent, normalBehaviour, media, componentMention, purchaseAppropriate, remoteActionClass, exclusiveClarify, diagnosticTrace}` | S3 learning trace (`:1643`) | — | — | — | `log(metric)` | S4R contract (pinned by `tools/migration`) |

---

## 3. Answers

### Q1. Who owns conversation state? Where is cs/1 merged? How many representations?

**cs/1 is merged in two places, and both use the same `canonical/merge.js`:**
- **Engine, every turn**, in understand mode: `canonical-runtime.js:56-90` (`transportMerge`) calls `merge(prior, mc1, {turn})` at `:81`. The policy-issued request is then written into state by the journey `decide(... control:true)` (`:155`).
- **BFF, only on one-step recovery** of a missed state write: `conversation-state.js:332-346` (`recoverOneStep`) replays `merge` and `requests.issueRequest` from the `STATETURN#` record. The BFF loads the engine's modules from `../part-finder/canonical/*` or a copied `./canonical/*` (`:35-46`).
- The BFF otherwise **only validates and stores** the engine's merged state (`finishTurn`, `:364-391`). The orchestrator transports it opaquely (`orchestrator.py:277-292`, `lambda_handler.py:37-44`).
- So durable cs/1 storage is BFF-owned, but cs/1 *content* is engine-owned. The orchestrator is a pass-through that can still mark it degraded.

**State representations that exist at the same time on an AC turn:**
1. **cs/1** (BFF DynamoDB `STATE#`/`STATETURN#`/`STATECLIENT#`; `conversation-state.js:5-9`). Durable, versioned, signed-token bound.
2. **Orchestrator `ConversationState`** (`model.py:188-204`), in `InMemoryStateStore` (`services.py:77-85`, `lambda_handler.py:29`). Keyed by the browser's `observability.sessionId`, or `"wp-"+hash(first user text)` (`index.js:125-126`). **Not durable**: it is lost on a cold start, not shared across concurrent containers, and grows without bound. It carries latches that change replies: `safetyState` (monotonic), `unsafeIntent` (latched true, `orchestrator.py:1370-1371`), `modelUnavailable`/`modelRequestedBefore` (`:565-590`), established family (`:493-501`), `symptomsText` (`:531-538`), typed evidence (`:604-659`).
3. **Client-carried transcript** (`body.messages`, user and assistant turns, up to 12). Assistant text is client-supplied and unverified. It is forwarded as `conversation` (`index.js:836`) and fed to Jev, to mc/1 (`priorAssistantMessage`, `canonical-runtime.js:190`) and to engine progression.
4. **Engine "progress"** recomputed from message history each request (`engine/progression.js:165-187`). It drives `isFollowUp`, `priorAdvisorText`, `discriminatorAlreadyAsked` (`engine/evidence.js:274`), `checksNotDoneTurnCount` (`progression.js:1180-1190`), `avoidVerbatimRepeat` (`:949-972`) and `latestTurnReportsRecovery` (`:1116-1123`).
5. **Jev legacy intent**, rebuilt each turn over the whole thread, then forwarded as `understand` (`orchestrator.py:346`). The orchestrator writes the reconciled evidence back into it.
6. **Pending request**: the orchestrator emits `pendingRequest` (`orchestrator.py:766`, `:1554-1595`) and the BFF relays it to the browser (`index.js:975-978`). The BFF **never sends it back** (`index.js:829-841`), so `_pendingIn` is always None on the AC path. The `_asked_model_last_turn` / `modelRequestedBefore` branch (`orchestrator.py:565-586`) is dead in production. cs/1 has its own pending requests (`canonical/requests.js`).
7. **Transcript record** (`SESSION#`, `transcripts.js:100`). The comment at `transcripts.js:361` says it is observability only and never read back into runtime.

### Q2. Who owns diagnostic progression / NextAction? Every decision layer

| Layer | Where | What it decides or overrides |
|---|---|---|
| Canonical policy | `canonical/*-policy.js`, `policy-kit.js:108-330` (`makeStepPolicy`) | Typed NA: safety_stop, ask_*, conclude, recommend_part, exit_journey. Authoritative only under control |
| Canonical compose check | `compose-kit.js:250-281` | Replaces COMPOSE text with the template on violation; prepends missing safety copy |
| Canonical respond | `canonical-runtime.js:248-270` | Template on exception or tripwire |
| Engine legacy chain (pre-COMPOSE) | `part-finder-lambda.js:817-1060` | `constrainByPositiveObservations`, `materialAmbiguity` gate (ungrounds the fault, `:834-871`), area discriminator, `progressAfterDeclinedDiscriminator`, `applyFollowUpNextAction`, `applyDisplayedIndicationIdentity`, `captureQuestionedCause`, `demotePrematurePartRequest`, `preferAccessibleFirstAction`, `preferFamilyBeforeSpecificDiagnosis`, `preferConditionDiscriminator`, `preferNotRepeatIntervention`, `preferRelatedFunctionDiscriminator`, `preferArchitectureDependentAdvice`, `preferAdviceThenIdentity`, `demoteUnconfirmedTheoryFinding`, `applyPartReadinessProgression`, HV overrides, `_nextAction` derivation, `identificationIsNextAction`, `preferSingleVagueClarify`, checks-not-done handling, `computePresentationGrain` |
| Engine post-COMPOSE | `:1275-1406` | `renderDeterministicTerminal` (replaces the reply), `ensureCommittedConclusion`, degenerate-ack / re-describe replacement, `ensureAdviceThenIdentityAsk` (appends a model ask), `_exclusiveClarify` overwrite, `constrainReplyToIdentity`, `ensureNonTerminalProgression`, `avoidVerbatimRepeat` (replaces the reply with a fixed "nothing new without the model number" close) |
| Orchestrator, legacy turns | `orchestrator.py` | `_flow_clarify` own questions (`:1315-1355`); `_code_intake_clarify` (`:1299-1313`); `_journey_stage` → `_compose_model_acquisition` **replaces** the engine reply with a fixed model ask (`:1823-1826`, `:1750-1753`); normal / recovery canned text (`:1779-1812`); ungrounded "From what you've described…" lead (`:1856-1865`); grounded staging text (`:1885-1999`); MCP code-only templates (`:1628-1701`); unresolved-code reconciliation (`:1100-1131`); owner safety note (`:750-753`); unsafe-intent warning (`:740-744`); `collapse_code_list` (`:758-759`); `_pending_for` (`:1554-1595`) |
| Orchestrator, canonical turns | `:702-710`, `:954-1006` | Maps NA to outcome. Still prepends the unsafe-intent warning from the latched `st.unsafeIntent` (`:707-709`) |
| BFF | `index.js:875-1004` | Strips "Worth checking:" (`:887`); suppresses parts on `componentMention none/discuss` (`:893-894`); derives `needsModel` by regex (`:931-935`); swaps in "AI service unavailable" on `compose_failed` (`:668-678`) |

**Duplicated or conflicting decision points:**
- **"Ask for the model" is decided in at least five places**: canonical `ask_identity` (policy); engine `identificationIsNextAction`/`preferAdviceThenIdentity`/`ensureAdviceThenIdentityAsk` (`progression.js:53-59`, `:421-…`); engine `avoidVerbatimRepeat` (`:949-972`); orchestrator `_journey_stage`/`_compose_model_acquisition` (`:1703-1768`) and Stage-1 grounded text (`:1965-1981`); BFF `needsModel` (`index.js:931-935`).
- **The model-unavailable latch is duplicated** in Python (`orchestrator.py:565-590`) and forwarded so the "Node identification gate" also stops. The Python half partly depends on `pendingRequest`, which never arrives (Q1.6).
- **Recovery / closure** is decided by the engine (`latestTurnReportsRecovery` regex, `functionRecovered` fact, `renderDeterministicTerminal`) and again by the orchestrator (`latestTurnEstablishes=='recovery'`, `:1799-1812`).
- **Vague-opener clarify** exists in the engine (`preferSingleVagueClarify`, `_exclusiveClarify`) and in the orchestrator `_flow_clarify` ("What is the main thing the {fam} is doing wrong?", `:1347`). The comment calls it "the same one part-finder asks".
- **Scope refusal** is applied in the orchestrator (`:686-695`) and in the engine (`:340-356`) from the same Jev field.

### Q3. Who owns safety? Every implementation

1. **Engine legacy** `engine/safety.js`: `classifySafetyStop`/`detectSafetyStop` regex (`:139-275`); `detectUnsafeIntent` regex (`:416-440`); `isMicrowaveHvProcedureRequest` (`:442`); `proposedPhysicalAccess` (`:129`); strippers (`:279`, `:299`, `:385`); `OWNER_SAFETY_NOTE` + `ensureOwnerCheckSafety` (`:339-383`). Jev `_safetyClassification` is gated by **regex corroboration** for gas and supply-trip (`part-finder-lambda.js:728-768`).
2. **Engine COMPOSE prompt** rules (`engine/compose.js:56`, gas text `:198`, burning `:213`).
3. **Canonical** `policy-kit.js:87-106` (`effectiveSafety`, sticky hazards), `:296-321` (safety_stop, continuable hazards, unsafe-action decline); fixed `SAFETY_COPY` and `REQUIREMENT` copy with regex presence markers in `compose-kit.js:11-95`, enforced by `checkReply` (`:273-278`); `SAFETY_STOP_REASON` mapping (`canonical-runtime.js:28-30`).
4. **Orchestrator** `rag_safety_from_done` (`services.py:23-45`); `_apply_rag_safety` monotonic latch (`orchestrator.py:1362-1378`); `_safety_block` with its own copies of gas/burning/shock/electrical text (`:1384-1435`); `UNSAFE_INTENT_MSG` (`:1437-1442`); `OWNER_SAFETY_NOTE` + `_ISOLATION_CUE_RE` (`:1451-1466`, `:1468-1518`); `_with_safety_prefix` (`:34-43`); MCP safety class (`:1025`).
5. **BFF**: suppresses parts, media and safetyInformation on a stop (`index.js:878`, `:945-947`).

**Duplicates:**
- The owner safety note exists three times: `safety.js:339-353` (JS, no trailing period), `orchestrator.py:1451-1461` (Python, "verbatim-consistent" by comment only), and different wording in `compose-kit.js` `REQUIREMENT` (e.g. `vac_power_off` `:74`).
- The isolation-cue regex exists twice: `safety.js:378` and `orchestrator.py:1463-1466`.
- The gas emergency copy exists four times: `orchestrator.py:1384-1390`, `compose.js:198`, `compose-kit.js:76`/`:83`, and `recalls/html.js:259`.
- The latched orchestrator `safetyState`/`unsafeIntent` can override later turns regardless of what the engine or canonical decide. This is per container, so it is non-deterministic across containers.

### Q4. Identity and model resolution: every implementation

- **Family**:
  - Jev legacy `applianceFamily` (`jev-understand.js:28`)
  - Jev mc/1 identity, then cs/1 merge identity facts M1–M5 (`merge.js:36-…`)
  - orchestrator first-turn gate (`routing.py:235-281`) and cross-turn precedence (`orchestrator.py:405-501`)
  - engine `resolveConversationIdentity`/`resolveEstablishedFamily`/`lockApplianceType`/`constrainIntentToFamily`/`constrainReplyToIdentity`. These use **regex cue tables** (`identity.js:27-104`, `:478-606`); `engine/understand.js:49` uses them to seed Jev's "established" family when the orchestrator sends none
  - catalogue `applianceKey`/`uniqueBrandCodeHit` (`engine/catalogue.js`)
  - canonical journey ownership functions (`*-family.js`)
- **Make**: `routing.MAKES` regex set (`routing.py:31-36`, `:76-80`); engine `guessMake`/`BRAND_LIST` (`engine/error-codes.js:10-27`, used at `part-finder-lambda.js:377-387`); Jev `make`; mc/1 identity. These are **different brand lists**.
- **Model**:
  - Jev `model`/`_tokenMeaning`
  - orchestrator `observed[]` MODEL observations (`:516-523`), `_rag_symptoms` "The model number is X." injection (`:1176-1180`)
  - engine `looksLikeModelToken`/`extractModelTokenFromText` (`identity.js:299-330`), `modelAlreadyKnown`
  - image extraction (`done.understood.model`), mapped by the orchestrator to `IMAGE_EXTRACTED_UNCONFIRMED` (`:1917-1939`)
  - canonical `identity.model.confirmed`
  - BFF `extractedModel`/FIT invariant (`index.js:893-930`)
- **Error code**: Jev; orchestrator `code_from_cue`/`slash_compound_code`/`displayed_codes_in` regexes (`routing.py:91-170`); engine `guessErrorCode`/`upgradeErrorCodeFromText`/`retainCustomerErrorCode` (`engine/error-codes.js`); MCP.

### Q5. Evidence scoring

`canonical/evidence-engine.js:16-44` (`scoreNodeEvidence`, `factConflict`, `COMMIT_MIN=2`, `COMMIT_MARGIN=2`) is a line-for-line copy of `engine/evidence.js:347-388` (same weights, same thresholds). The canonical file header says so ("equivalence-tested", `:4`). The overlap is total for scoring. Canonical adds `rankFamilies`/`diagnoseSpec` (`:51-164`). Legacy adds `commitFromEvidence`, `materialAmbiguity` and regex-based fact derivation (`REPLACED_RE` `:93`, `_DECLINED_ANSWER_RE` `:491`, `_NEGATED_CLAIM_RE` `:493`). The two inputs differ: canonical reads typed cs/1 observations; legacy reads Jev facts plus regex-derived facts from customer text.

### Q6. Canonical vs legacy for AC

- **`CANONICAL_CONTROL_JOURNEYS` is not in `infra/cdk/config/runtime-overrides.json`, and neither is `CANONICAL_MODE`.** That file holds only deltas over a live capture (`runtime-overrides.json` "description"; `infra/cdk/lib/runtime-stack.js:5`), and the capture is not in the repo. **The live value cannot be determined from code.**
  - `docs/migration/phase-0-findings.md:24` says `control` with "64 journeys".
  - The registry has **63** keys (`canonical/journeys.json`): washing-machine 9, dishwasher 6, fridge-freezer 7, tumble-dryer 7, oven-cooker 8, hob 4, microwave 6, vacuum 6, washer-dryer 10.
  - So at least one live token would be an unknown key, ignored and logged once (`index.js:790-793`). This is not determined.
  - `deploy.sh:255-260` defaults to `off` with an empty list. The per-journey engine kill switches `CANONICAL_Jx_CONTROL` and `CANONICAL_MC1_QUESTIONS` are not in the overrides either.
- **A turn is canonical** only when all of the following hold (`orchestrator.py:821-833`; `canonical-runtime.js:94-98`, `:154`):
  - mode is `control`
  - the BFF built a block (valid token or none, store readable, not a duplicate)
  - mc/1 classified within the grace window
  - merge succeeded
  - the first applying journey in registry order is allow-listed and not killed
  - its NA is not `exit_journey`
  - the orchestrator's registry copy contains the key
- **A journey that is not allow-listed** still runs merge, diagnostics and policy in preview (trace-only, no request issued; `canonical-runtime.js:153-155`), and **its merged state is persisted**. The legacy path answers.
- **Degradation** (token invalid, read failure, classifier timeout or degraded, merge failure, session mismatch, journey error) silently falls back to the legacy orchestrator and engine path. It is surfaced in logs only: `canonical-prepare`/`canonical-finish` events, orch `canonicalDegraded`, the transcript `canonical-audit/1`, and the admin trace. It is **masked from the customer and from the response contract**.
  - The only degradation that is surfaced is `compose_failed` (#21, `index.js:668-678`).
  - A diagnose-transport failure on a controlled turn is answered with SERVICE_UNAVAILABLE copy, **while the canonical state still advances** (`orchestrator.py:676`, `:965-967`; `lambda_handler.py:157-158`; `conversation-state.js:364-391`).

### Q7. Retry layers

| Layer | Where | Policy |
|---|---|---|
| BFF → orch | `orchestrator-retry.js:34-44` | 429 only; 2 retries; 400 ms base; ≤3 s; inside the 120 s abort |
| Orch → engine (understand, diagnose) | `services.py:537`, `:578` | **None**; 90 s timeout each, run sequentially |
| Orch → MCP | `services.py:672-690` | None |
| Engine → Jev (legacy understand) | `jev-client.js:158-174` via `jev-understand.js:1153` | 3 attempts × 15 s (`JEV_TIMEOUT_MS`), backoff 400·i ms; no retry on AUTH/CONFIG/MALFORMED |
| Engine → Jev (mc/1) | `jev-mc1.js:20`, `:29-32` | 2 attempts; outer grace 15 s / 3 s |
| Engine → COMPOSE (legacy) | `engine/compose.js:1283-1303` | 2 attempts if no delta arrived; `LM_TIMEOUT_MS` default **240 s** (`engine/config.js:26`) |
| Engine → COMPOSE (canonical) | `canonical-runtime.js:248-270` | None; template on error |
| Engine → parts API | `engine/parts-client.js:23-44`, `:46-77`, `:69-…` | 2 attempts (10 s / 5 s) |
| Engine → embeddings | `retrieval.js:518-535` | None; 4 s |
| Inference providers | `inference.js` | None |
| Engine diagnose without `understand` | `part-finder-lambda.js:315-317` | When orch understand failed but symptoms were retained, diagnose is called without `understand`, so the engine **runs Jev again inline**: an implicit second attempt |

The timeouts are not aligned: engine COMPOSE allows 240 s, the orch client 90 s, the orchestrator Lambda 120 s (`orchestration/deploy/deploy.sh:78`), and the BFF 120 s. Two sequential 90 s orch→engine calls can exceed the orch Lambda timeout. Jev retries are nested under orch calls that have no retry, so this is not duplicated retrying of the same call, but the latency budgets stack.

### Q8. Fallbacks that produce a normal-looking customer reply

1. Orch → engine understand failure (`orchestrator.py:343`), or engine Jev failure in understand mode returning `degradedIntent` as success (`part-finder-lambda.js:212-217`) → empty typed decisions → `_flow_clarify` generic question (`orchestrator.py:1340-1347`). It reads as a normal clarify.
2. Orch top-level exception → HTTP 200 SERVICE_UNAVAILABLE text (`lambda_handler.py:160-163`). `_flow_*` RagUnavailable/McpUnavailable → SERVICE_UNAVAILABLE text (`:965-967`, `:1071-1074`, `:1225-1226`). The BFF renders all of these as an ordinary `reply` without `error:true` (`index.js:875-1004`), and the transcript records a normal turn.
3. **Canonical controlled turn + diagnose failure → state advanced although the customer never saw the question** (Q6).
4. Canonical `checkReply` violations, or `empty`/tripwire → deterministic template, `source:'template'` (`compose-kit.js:253`, `:271`; `canonical-runtime.js:263`). The customer sees normal copy.
5. Legacy COMPOSE empty → `customerFacingNextCheck`/clarifyingQuestion or "Sorry, I didn't quite catch that…" (`part-finder-lambda.js:1282-1286`, `:1401-1405`).
6. Legacy degenerate-ack / re-describe → replaced by `primaryFinding` + next check (`:1340-1368`).
7. `avoidVerbatimRepeat` → fixed model-close copy (`progression.js:949-972`).
8. `renderDeterministicTerminal` overrides COMPOSE (`:1326-1327`).
9. Tripwire → `REFUSAL_TEXT` (`:1275-1279`). Reads as a scope refusal on a real question.
10. Orchestrator normal-behaviour / recovery: canned copy when prose is under 40 chars (`orchestrator.py:1781-1784`, `:1801-1803`). Ungrounded: `clarifyingQuestion` or "Could you describe the problem…" (`:1834`).
11. Malformed MCP result → synthetic INVALID_INPUT → model-ask clarify (`services.py:710-717`, `orchestrator.py:1639-1657`).
12. Parts API failure → no parts, presented as Stage-3 "can't confirm a part" (`parts-client.js:38-44`; `orchestrator.py:1994-1999`).
13. Embedding failure → lexical retrieval; retrieval exception → no docs (`part-finder-lambda.js:286-288`).
14. Transcript store construction failure → in-memory store; turns are silently lost (`transcript-store.js:14-19`).
15. Feedback forward failure → `200 {ok:true}` (`index.js:590-600`).
16. Orchestrator in-memory state miss (cold start or a different container) → established facts and latches silently reset (`services.py:77-85`).
17. Non-stream provider non-200 → empty text, by design "degrades gracefully" (`inference.js:224-240`). COMPOSE uses streaming, so this applies only to non-stream calls.

### Q9. Public engine URL: steering fields (all unauthenticated)

| Field | Effect | Where |
|---|---|---|
| `mode:'understand'` | Runs only Jev, and mc/1 when `canonical` is also sent. Returns typed classification: a classification oracle and a cost amplifier | `part-finder-lambda.js:204-234` |
| `understand` | Replaces Jev entirely. `reviveInjectedIntent` copies every `_`-prefixed key verbatim (`engine/understand.js:190-202`): `_requestClass` (bypasses scope refusal), `_safetyClassification` (suppresses or forces safety stops; a gas stop is still regex-corroborated), `_tokenMeaning`, `_applianceFamilyProvenance`, `_cannotAnswer`, `_jevEvidence`… | `:242-243`, `:277-278`, `:311-314` |
| `canonical` (block, understand mode) | Triggers the mc/1 Jev call and canonical routing | `canonical-runtime.js:208-222` |
| `canonical` (result, diagnose mode) | `controls()` is shape-only (`:225-228`). A forged result with `journey.control/applies/nextAction` makes the engine word an arbitrary NA, and **`partLookup.parts` from the request becomes `done.parts`** (titles, prices, links; `canonical-runtime.js:283-284`, `:306`) | `part-finder-lambda.js:359-371` |
| `established` | Sets the prior family for identity and Jev | `:248-251`, `engine/understand.js:44-55` |
| `seed` | Fixes sampling | `:162` |
| `feedback` | Writes to the S3 learning corpus | `:150-153` |

The effects reach only the caller's own response, but every request is written to the S3 learning trace (`:1643`) and the metrics. The overview lists only `understand`, `canonical` and `seed` (`overview.md:120`).

### Q10. Regex / string matching used as behaviour (most significant)

On customer text:
- `safety.js:152-275` (`classifySafetyStop`, which gates Jev gas and supply-trip stops, `part-finder-lambda.js:733-768`)
- `safety.js:416-440` (`detectUnsafeIntent`, which sets `unsafeIntent`; the orchestrator latches it for the session)
- `safety.js:129` (`proposedPhysicalAccess` → `isolationAdvisory`)
- `identity.js:27-104` family cue tables
- `engine/error-codes.js:19-27` (`guessMake`)
- `routing.py:31-36`, `:76-80` (`MAKES`)
- `routing.py:133-170` (code cue / slash code)
- `progression.js:1116-1123`, `:1174-1190` (recovery, checks-not-done)
- `engine/evidence.js:93`, `:491-495` (replaced parts, declined answers, negation)
- `part-finder-lambda.js:1324-1325` (cordless / corded)
- `isAcousticOnlyQuery`, `hasFailureSymptom`, `matchNormalBehaviour` (`safety.js:462-626`)

On model or own prose:
- `part-finder-lambda.js:1342`, `:1350` (bare-ack and re-describe loop)
- `progression.js:56` (model already asked?), `:66-75` (`stripInstructionEcho`), `:949-972` (`avoidVerbatimRepeat` substring)
- `compose-kit.js:11-95` (safety markers), `:254-270` (`?` count, `PURCHASE_RE`, `MODEL_ASK_RE`, component words)
- `orchestrator.py:1463-1466`, `:1509-1518` (isolation cue and tail match before prepending the note)
- `routing.py:181-194` (`collapse_code_list`)
- `index.js:887` ("Worth checking:"), `:931-935` (`needsModel`), `:1016-1024`
- `orchestrator.py:1537-1538` (`_MODEL_NEED_RE` over needs)
- `outputTripwire` (`security.js`)

### Q11. Cross-component coupling (Python ↔ JS)

- `OWNER_SAFETY_NOTE` (`orchestrator.py:1451` ↔ `safety.js:339`) and the isolation-cue regex (`:1463` ↔ `safety.js:378`)
- Gas, burning, shock and unsafe-intent copy (`orchestrator.py:1384-1442` ↔ `compose.js:198-213`, `compose-kit.js:76-95`)
- `SCOPE_REFUSAL_TEXT` (`orchestrator.py:104-108`) "mirrors" `REFUSAL_TEXT` (`security.js`)
- `_CAUSE_LABEL` (~200 cause keys → labels, `orchestrator.py:837-952`) duplicates the canonical packs' cause vocabulary and labels (`JC.COMPONENT_LABEL` etc.)
- The journey registry is read by Python from a copied file (`orchestrator.py:111-128`), with a silent "control disabled" fallback when the file is missing
- `_MODEL_NEED_RE` (`orchestrator.py:1537`) ↔ BFF `modelNeedRe` (`index.js:931`)
- `_FAMILY` / `_DIAGNOSTIC_AREAS` taxonomy (`orchestrator.py:46-96`) vs engine faultIds
- Safety category strings `gas/shock/burning/electrical` (`services.py:32-33` ↔ `canonical-runtime.js:28-30` ↔ `safety.js`)
- Brand lists `routing.MAKES` vs `BRAND_LIST`
- Family keys in `journey-registry.js:14` vs `jev-understand.js:28`
- `USER_INTENTS` in `jev-understand.js:13` and `engine/intent-vocabulary.js:10`
- The BFF `require`s the engine's `canonical/*` (`conversation-state.js:35-46`)

### Q12. Where `docs/architecture/overview.md` is wrong or incomplete

1. `:12`, `:23`: implies the BFF persists state it merged. Merge actually runs in the engine every turn; the BFF only re-merges on recovery.
2. `:19`, `:43`, `:55`: "orchestrator, no LLM … turn control". True for models, but the orchestrator also **writes customer prose** (model asks, clarifies, staging text, safety copy) and replaces engine replies. That is not stated.
3. `:39`, `:81-83`: does not say there are **two Jev calls per canonical turn** (legacy and mc/1 in parallel). Code comments claim "one Jev call per turn" (`orchestrator.py:322-329`). phase-8-findings §2 does note this.
4. Omits the orchestrator's **in-memory, per-container `ConversationState`** and its latches entirely.
5. `:78`: "browser holds only an opaque signed session token". The browser carries the full conversation (including assistant text) and `observability.sessionId`, which keys orchestrator state.
6. `:110`: rollback lists only `CANONICAL_MODE`. It omits the engine kill switches `CANONICAL_Jx_CONTROL` and `CANONICAL_MC1_QUESTIONS`.
7. `:104`, `:131`: implies the allow-list lives in `runtime-overrides.json`. It does not; neither `CANONICAL_MODE` nor `CANONICAL_CONTROL_JOURNEYS` is in the repo.
8. `:116`: the token is not authentication of the chat route. The route is unauthenticated (rate-limited only).
9. `:120`: lists `understand`, `canonical`, `seed`. It omits `mode`, `established`, `feedback`, and that a forged `canonical` can inject `done.parts`.
10. `:128`: "old `spares4repairs/dev/applianceclinic-*` secrets remain unread". `CANONICAL_TOKEN_PREVIOUS_SECRET_ID=spares4repairs/dev/applianceclinic-canonical-state-token` is set and IAM grants read on it (`runtime-overrides.json`), and `state-token.js:102-110` reads it.
11. `:44`: "template on failure". Since #21 a canonical provider failure becomes the "AI service unavailable" error in the BFF. Other `checkReply` failures remain silent templates.
12. `:47`: transcript review is "Jev". It is configurable (`TRANSCRIPT_REVIEW_PROVIDER`: jev/openai/lmstudio; `judge.js:42-61`).
13. Missing:
    - the BFF→engine feedback side channel (`index.js:590-600`)
    - the orchestrator → MCP malformed-result coercion
    - `pendingRequest` not being returned by the BFF
    - SERVICE_UNAVAILABLE replies not being flagged as errors
    - timeout misalignment
    - that `canonical-architecture.md`, cited by code, is absent (phase-8-findings §5)
14. `:159`: "Behaviour is never scored by regular expressions" is correct for evaluation, but behaviour is still *produced* by regex in many places (Q10). Code comments repeatedly claim "no prose parsing" where regexes run.

---

## 4. Refactor candidates (ranked by chat-quality impact, then risk)

| Rank | Candidate | Impact on chat quality | Risk | S4R-sensitive? |
|---|---|---|---|---|
| 1 | **Do not persist canonical state when diagnose failed on a controlled turn**. Gate `_canonical` return on a successful `_flow_canonical`, or have the BFF skip `finishTurn` on `SERVICE_UNAVAILABLE` (`orchestrator.py:965-967`, `lambda_handler.py:157-158`, `index.js:680`) | High: prevents the policy believing a request was issued that the customer never saw | Low | No (BFF/orch only) |
| 2 | **Forward `pendingRequest`** from the browser through the BFF, or derive it from cs/1. Otherwise delete the dead latch branch (`index.js:829-841`; `orchestrator.py:565-586`) | High: model re-ask loops in legacy turns | Low–medium | No |
| 3 | **Make orchestrator state durable, or remove its latches.** `InMemoryStateStore` causes per-container non-determinism (safety high-water mark, `unsafeIntent` latch, family, model latch). Move what is needed into cs/1, or into a DynamoDB item keyed by csid | High: inconsistent replies across containers; sticky warnings | Medium | No |
| 4 | **Surface degradation honestly**: flag SERVICE_UNAVAILABLE and understand-failure clarifies as `error:true` (or a typed `degraded`) in the view and transcript (`index.js:875-1004`; `orchestrator.py:343`; `part-finder-lambda.js:212-217`) | High for observability; medium for the customer | Low | Engine understand-mode change touches the shared handler (understand mode is not used by S4R) |
| 5 | **One owner for "ask for the model"**. Under canonical it is policy. In legacy, choose either the engine progression or the orchestrator `_journey_stage`, not both (and not post-hoc `avoidVerbatimRepeat`) | High: duplicate or contradictory model asks; engine prose discarded | Medium–high | Yes if engine-side rules change |
| 6 | **Authenticate orchestrator-only engine fields** (`understand`, `canonical`, `mode`, `established`, `seed`) with a header or HMAC, or route the orchestrator through a separate entry | Medium (integrity, learning-corpus poisoning, part-card injection) | Medium: S4R must keep sending `{messages}` | **Yes** (shared handler; contract pinned) |
| 7 | **Single safety copy source** (owner note, gas, unsafe-intent, isolation cue) in a shared JSON consumed by Python and JS; remove the orchestrator prepends on canonical turns | Medium: duplicated or doubled precautions | Low–medium | Yes if the engine copy changes |
| 8 | **Align timeouts and retries** (240 s COMPOSE vs 90 s client vs 120 s Lambda; Jev 3×15 s inside understand) | Medium: tail-latency failures | Low | Yes (engine config) |
| 9 | **Replace `_CAUSE_LABEL` and other Python vocabularies** with values emitted by the engine (`done.canonicalControl` could carry the label) | Low–medium: label drift | Low | No |
| 10 | **Collapse duplicate evidence scoring** (`evidence-engine.js` ↔ `engine/evidence.js`) into one module | Low (already equivalence-tested) | Low | Yes (legacy imports) |
| 11 | **Retire the second Jev call** on canonical turns once mc/1 covers routing needs (the orchestrator still routes on legacy Jev) | Medium: latency, cost, two semantic authorities | High | Legacy Jev is S4R's understand: keep it for S4R |
| 12 | **Reduce regex behaviour on model prose** (degenerate-ack, re-describe, verbatim-repeat, isolation-cue tail) by moving the decisions pre-COMPOSE as typed state | Medium | High (behavioural churn) | **Yes** |
| 13 | **Put the canonical allow-list and kill switches under review in `runtime-overrides.json`** (and reconcile 64 vs 63) | Low for chat; high for change control | Low | No |
| 14 | **Don't silently fall back to an in-memory transcript store**; fail loudly at init | Low for chat; high for review coverage | Low | No |
