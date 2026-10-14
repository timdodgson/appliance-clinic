# Due diligence: Appliance Clinic model / provider layer

Repo `/home/user/appliance-clinic` at `cabcad4` (2026-10-13 23:45 UTC, "Change 21.17 live"). AWS account 800960611664, read-only calls only.
Window for logs: last 24 h = 2026-10-13T00:03Z to 2026-10-14T00:03Z. No repo file edited, no LLM called, no secret value printed
(the tunnel URL is shown only as a SHA-256 prefix; the OpenAI and Jev secrets were only `describe-secret`d).

---

## 1. Which model serves which step in production

### Code path

| Step (turn.js) | Model | Call site | Settings |
|---|---|---|---|
| 2 Understand | **Qwen** (`deps.qwen`) | `services/diagnosis-engine/ac2/turn.js:349` -> `ac2/understand.js:60-65` | maxTokens 400, temperature 0, timeout 30 s, strict `json_schema` |
| 3 Label | **Jev** | `turn.js:352` -> `ac2/labels.js:178` | `jev.evaluate`, 12 s timeout, 2 attempts (`ac2/runtime.js:18,52`) |
| 4 Enrich | no LLM (MCP error codes, recalls, parts) | `turn.js:386-388` | |
| 8 Reason (reasoner) | **Qwen** | `turn.js:421-426` -> `ac2/reasoner.js:133,147` | maxTokens 1800, temperature 0.3, timeout 60 s, strict `json_schema`; one retry without the schema at temp 0.2 if invalid (`reasoner.js:152-157`) |
| 8b Verify (claim extractor) | **Qwen** | `turn.js:286-295` | maxTokens 700, temperature 0, timeout 30 s, `EXTRACT_FORMAT` json_schema; HTTP != 200 throws -> turn fails |
| 8c Regenerate | **Qwen** (reasoner again, with objections) | `turn.js:433-443` | only if it fits `REGENERATION_BUDGET_MS = 26000` (`turn.js:48`) |
| 10 Reply label / media | **Jev** | `turn.js:487-488` -> `labels.js:195` | as Label |
| eval-only `qwen-plain` control | Qwen | `ac2/runtime.js:70-89` | generic prompt, maxTokens 1500, temp 0.4 |

How `deps.qwen` is chosen (`ac2/runtime.js:47`): `qwen = (await getProviders()).compose`.
`engine/config.js:27-34` -> `loadAdminInference()` (`admin-config.js:66-105`, 60 s cache) -> `resolveProvidersFromAdminConfig()` (`inference.js:350-373`).
**Only `routing.compose` is read** (`inference.js:338-339, 370-372`); Understand, Reason, Verify and Regenerate all use that one provider.
The admin UI's `routing.understand` (`services/whichpart-api/ai-config.js:46,77,104`) is validated and stored but **has no effect on the engine**.

Mapping: `local` -> `LMStudioProvider` (endpoint = `local.endpoint` or the Lambda's `LM_STUDIO_URL`, `inference.js:366-367`);
`frontier` -> `OpenAIProvider` with `frontier.model` and the key from the OpenAI secret (`inference.js:357-364`; key only fetched when compose = frontier, `admin-config.js:83-94`). No silent fallback (`inference.js:19-21, 343-344`).

### Jev

`services/diagnosis-engine/jev-client.js`:
- `JEV_MODEL = 'typesafe/jev'` hard-coded (`:13`); endpoint `https://api.cloudflare.com/client/v4/accounts/<accountId>/ai/run` (`:15, :103`) with optional `cf-aig-gateway-id` (AI Gateway) (`:108`).
- Payload `{ model: 'typesafe/jev', input: { state, questions } }` (`:109-112`); returns typed `answers` (+ usage) (`:150-155`). It is a typed-question classifier ("fixed labels with a confidence", `ac2/labels.js:3-10`), not a chat model.
- Retries: non-auth failures retried with 400 ms x i backoff (`:158-174`); the engine uses 2 attempts, 12 s timeout (`runtime.js:18,52`).
- README: "**Jev** (`typesafe/jev`, through Cloudflare AI Gateway) | Labels (step 3), media and reply tags (step 10), scheduled transcript review" (`README.md:89-90`; label shown at `ai-config.js:27` "TypeSafe Jev via Cloudflare").
- No size/architecture of Jev is stated anywhere in the repo. Swapping Jev for another model = code change (constant model id, Cloudflare-specific wire format).

### Production configuration (AWS, read-only)

```
$ aws lambda get-function-configuration --function-name applianceclinic-diagnosis-engine --query '{runtime,timeout,mem,lastMod,codeSha,envKeys}'
runtime nodejs22.x, timeout 300, mem 256, lastMod 2026-10-13T23:42:19Z, codeSha e3LKUVNO...
envKeys: MCP_URL OPENAI_SECRET_ID AC_BEARER_VERSIONS LEARNING_BUCKET JEV_SECRET_ID AI_CONFIG_SECRET_ID LM_STUDIO_URL MCP_BEARER_TOKEN ENGINE_SIGNING_TOKEN
(no COMPOSE_PROVIDER / LLM_PROVIDER / COMPOSE_MODEL / OPENAI_BASE_URL env vars)

$ ... --query 'Environment.Variables.[AI_CONFIG_SECRET_ID,JEV_SECRET_ID,OPENAI_SECRET_ID]'
applianceclinic/production/ai-config   applianceclinic/production/jev   applianceclinic/production/openai

LM_STUDIO_URL: scheme https | sha256 0be0a90889270013 | localhost? False      (a public tunnel hostname; value not printed)
```

Structure of `applianceclinic/production/ai-config` (non-secret operational config; printed field by field):

```
top-level keys: ['frontier', 'history', 'lastFrontierTest', 'local', 'routing', 'updatedAt', 'updatedByEmail', 'version']
local:    {'enabled': True, 'endpoint_set': False, 'model': 'qwen3.6-35b-a3b-mtp'}     -> endpoint = Lambda LM_STUDIO_URL
frontier: {'enabled': False, 'provider': 'openai', 'model': 'gpt-5.6-terra'}
routing:  {'understand': 'local', 'compose': 'local'}
lastFrontierTest: {'ok': True, 'at': '2026-09-04T05:15:26.848Z', 'model': 'gpt-5.6-terra'}
updatedAt: 2026-10-05T21:20:25.090Z  version: 9  history entries: 8
history: 4 x (batch-override-start / batch-override-restore) on 2026-10-05, each "routing.compose local -> frontier" then back
```

`describe-secret` only: `applianceclinic/production/openai` last changed 2026-10-08T23:34Z, last accessed 2026-10-12; `.../jev` last changed 2026-10-08T23:34Z, last accessed 2026-10-13.

Logs confirm the live provider on every turn in the window:

```
$ insights.sh /aws/lambda/applianceclinic-diagnosis-engine 24 'filter evt="diagnosis-engine" | stats count(*) as n, sum(ok) as okN by ac2.control, ac2.provider.name, ac2.provider.model'
{"ac2.provider.name":"lmstudio","ac2.provider.model":"qwen3.6-35b-a3b-mtp","n":"2774","okN":"2774"}
```

### Possible providers and what switching takes

- `KNOWN_PROVIDERS = ['lmstudio', 'openai']` (`inference.js:281`). Both are the same OpenAI-compatible Chat Completions client (`inference.js:137-244`), differing in parameter dialect: `local` sends `temperature`, `max_tokens`, `repeat_penalty`; `openai` sends only `max_completion_tokens` (temperature omitted) (`inference.js:161-179`).
- **Another OpenAI-compatible local server / model** (vLLM, llama.cpp server, Ollama-compat, another LM Studio model): config only, by setting `local.endpoint` / `local.model` in the admin config, or the Lambda `LM_STUDIO_URL`. Takes effect within the 60 s cache (`admin-config.js:22`, `engine/config.js:19`).
- **OpenAI**: config only in principle: `routing.compose='frontier'`, `frontier.enabled=true`, `frontier.model`, key present in `applianceclinic/production/openai` (activation validated at `ai-config.js:101-117`). This exact flip was done 4 times on 2026-10-05 by the batch runner.
- **Another OpenAI-compatible hosted API** (OpenRouter, Together, Azure-style compat): `OPENAI_BASE_URL` env override on the engine Lambda (`inference.js:364`) + frontier config; a Lambda configuration change, not code.
- **Anthropic / Bedrock native, or Jev replacement**: code change (new provider class + add to `KNOWN_PROVIDERS`; Jev model id is a constant).
- **Caveats that make a frontier switch not purely "config" for the current code (inferred from code, not tested; no LLM calls made):**
  1. OpenAI strict structured outputs require `additionalProperties: false` on every object. `ac2/understand.js:26,36` has it; the reasoner `SCHEMA` (`reasoner.js:72-106`) and the extractor `EXTRACT_FORMAT` (`verifier.js:43`) do not (`grep -c additionalProperties` -> reasoner 0, verifier 0, understand 2). Expected effect: reasoner gets a 400, falls back to its no-schema retry (double call); the claim extractor throws on non-200 (`turn.js:289`) -> every turn fails "claim extractor unavailable". Needs a schema fix in code.
  2. The OpenAI dialect drops `temperature` (`inference.js:163-167`): Understand and the extractor lose temperature 0.
  3. For reasoning models `max_completion_tokens` includes reasoning tokens; caps of 400 (understand) / 700 (extractor) / 1800 (reasoner) may truncate.
  4. `routing.understand` is ignored, so Understand cannot be split from the reasoner without code.

---

## 2. Model characteristics

| Fact | Source |
|---|---|
| Model id in production: `qwen3.6-35b-a3b-mtp` | ai-config secret `local.model`; every log line `ac2.provider.model` |
| "Qwen 3.6 (35B-A3B) on LM Studio, over a private tunnel" | `README.md:89`; also `README.md:43` diagram "Qwen 3.6 / LM Studio" |
| 35B total, ~3B active (MoE "A3B"); "-mtp" suffix (multi-token prediction variant per the id) | README:89 states 35B-A3B; "mtp" appears only in the model id, never explained in docs |
| "fixed by the owner", "a much smaller model than the general assistant" | `docs/evaluation/llm-led-rebuild.md:175` |
| Served by LM Studio over a private tunnel; "serves one request at a time"; single point of failure (tunnel drop 2026-10-12 20:25-21:19 UTC) | `README.md:165` |
| "LMStudioProvider (default, local, concurrency=1 for validation)" | `inference.js:14` |
| Tunnel was ngrok; account suspended (`ERR_NGROK_6008`) on 2026-10-07; config had drifted to `gpt-5.6-terra` and was corrected to `qwen3.6-35b-a3b-mtp` | `docs/migration/phase-0-findings.md:148-154` |
| LM Studio streams with no usage frame; non-stream returns usage | `inference.js:257` |
| Context window | **Not stated anywhere in the repo** (grep for n_ctx / context length / 32768 / 65536 / 131072 / 262144 finds nothing). The LM Studio load context is set on the owner's machine. Measured use: reasoner prompt p50 3,866, p90 4,816, max 6,117 tokens (section 3). History is capped at 12 messages (`engine/config.js:40`) |
| Measured decode speed (reasoner, first-pass turns) | 53 tok/s p50 (p10 45, p90 72) = completionTokens / reasonMs (section 3; includes prefill and queueing, so a lower bound) |

---

## 3. Measured latency per step (last 24 h)

Two engine versions were live in the window (both `schema ac3-audit/1`):
- 02:16-16:20 UTC: ac3 "reply" pipeline (21.9 and earlier): `timings.replyMs` (one Qwen reply call), no reasoner/verifier. 1,766 turns.
- 16:25-23:44 UTC: **current pipeline** (21.11+, the reasoning step and claim check restored): `timings.reasonMs`, `verifyMs`, `regenerateMs`. 918 turns.
- 90 turns stopped before reasoning (out of scope 43, gas stop 11, attack 1, others in the earlier version).

```
$ insights.sh $G 24 'filter evt="diagnosis-engine" | fields ispresent(ac2.timings.reasonMs) as hasReason, ispresent(ac2.timings.replyMs) as hasReply | stats count(*) as n, min(@timestamp) as first, max(@timestamp) as last by hasReason, hasReply'
{"hasReason":"1","hasReply":"0","n":"918","first":"2026-10-13 16:25:24.135","last":"2026-10-13 23:44:52.339"}
{"hasReason":"0","hasReply":"0","n":"90","first":"2026-10-13 02:16:46.330","last":"2026-10-13 22:49:08.701"}
{"hasReason":"0","hasReply":"1","n":"1766","first":"2026-10-13 02:16:22.988","last":"2026-10-13 16:20:18.542"}
```

**Traffic is almost entirely benchmark:** whichpart-api logged 2,762 AC2 turns, 2,760 with `benchmark.auth` (independent-100 runs 21.11, 21.15, 21.16 at concurrency 2) and 2 others (14:03 UTC). With a one-request-at-a-time server, the step times below include queueing behind the other conversation.

### Current pipeline (918 turns, 16:25-23:44 UTC)

Query per field `f` (G=/aws/lambda/applianceclinic-diagnosis-engine):
```
filter evt="diagnosis-engine" and ispresent(ac2.timings.reasonMs) and ispresent(ac2.timings.<f>)
| stats count(*) as n, pct(ac2.timings.<f>,50) as p50, pct(ac2.timings.<f>,90) as p90, pct(ac2.timings.<f>,99) as p99, max(ac2.timings.<f>) as max
```

| Step | Model | n | p50 ms | p90 ms | p99 ms | max ms |
|---|---|---|---|---|---|---|
| understand | Qwen | 918 | 2,076 | 3,405 | 4,754 | 5,341 |
| label | Jev | 918 | 319 | 410 | 1,079 | 12,742 |
| enrich | tools | 918 | 0 | 355 | 3,886 | 5,963 |
| **reason** | Qwen | 918 | **11,400** | **14,797** | 17,928 | 19,642 |
| verify (claim extractor, both passes summed) | Qwen | 918 | 2,287 | 4,568 | 7,013 | 8,446 |
| regenerate | Qwen | 7 | 8,969 | 11,060 | 11,060 | 11,060 |
| replyLabel | Jev | 918 | 313 | 398 | 1,114 | 3,942 |
| **total** | | 918 | **16,935** | **21,961** | 27,664 | 35,149 |

Raw output:
```
understandMs {"n":"918","p50":"2075.9653","p90":"3404.7752","p99":"4754.1221","max":"5341"}
labelMs      {"n":"918","p50":"318.9767","p90":"409.9325","p99":"1078.6967","max":"12742"}
enrichMs     {"n":"918","p50":"0","p90":"355","p99":"3886","max":"5963"}
reasonMs     {"n":"918","p50":"11399.5609","p90":"14797.2954","p99":"17927.7266","max":"19642"}
verifyMs     {"n":"918","p50":"2287.3131","p90":"4567.8016","p99":"7013.3654","max":"8446"}
regenerateMs {"n":"7","p50":"8969","p90":"11060","p99":"11060","max":"11060"}
replyLabelMs {"n":"918","p50":"312.9763","p90":"397.8231","p99":"1113.7554","max":"3942"}
totalMs      {"n":"918","p50":"16934.9065","p90":"21960.5366","p99":"27663.9917","max":"35149"}
```
(Insights `pct` is approximate.) Qwen is ~92% of the median turn: understand 2.1 + reason 11.4 + verify 2.3 = 15.8 of 16.9 s; Jev ~0.6 s.

Reasoner tokens (`ac2.usage` = the first reasoning pass's usage, summed over its no-schema retry if any, `reasoner.js:150,156`; `turn.js:427` sets it before any regeneration, so a regeneration's tokens are not included; understand/extractor tokens are not logged):
```
filter evt="diagnosis-engine" and ispresent(ac2.timings.reasonMs)
| stats count(*) as n, pct(ac2.usage.completionTokens,50) as out_p50, pct(ac2.usage.completionTokens,90) as out_p90, max(ac2.usage.completionTokens) as out_max,
        pct(ac2.usage.promptTokens,50) as in_p50, pct(ac2.usage.promptTokens,90) as in_p90, max(ac2.usage.promptTokens) as in_max, avg(ac2.usage.completionTokens) as out_avg
{"n":"918","out_p50":"612.6487","out_p90":"768.6827","out_max":"1036","in_p50":"3865.5945","in_p90":"4816.2978","in_max":"6117","out_avg":"621.6427"}

filter ... and isblank(ac2.timings.regenerateMs) | fields ac2.usage.completionTokens*1000/ac2.timings.reasonMs as tps | stats pct(tps,10), pct(tps,50), pct(tps,90)
{"p10":"44.7057","p50":"52.8267","p90":"72.3749"}

stats count(*) as turns, sum(ac2.regenerated) as regenerated          -> {"turns":"918","regenerated":"7"}
filter @message like /regeneration-skipped/ | stats count(*)           -> 18 (skipped for the 26 s budget)
```

### Previous pipeline in the same window (1,766 turns, 02:16-16:20 UTC), for comparison
```
understandMs {"n":"1766","p50":"1906.8806","p90":"3473.5216","max":"6668"}
labelMs      {"n":"1766","p50":"327.7019","p90":"412.8106","max":"3875"}
enrichMs     {"n":"1766","p50":"1","p90":"334.9876","max":"4353"}
replyMs      {"n":"1766","p50":"3762.6706","p90":"5835.2062","max":"9633"}
replyLabelMs {"n":"1766","p50":"305.8635","p90":"385.6858","max":"1357"}
totalMs      {"n":"1766","p50":"6799.3918","p90":"9390.2486","max":"18101"}
reply usage: out_p50 106, out_p90 136, out_max 431, in_p50 2,508
```
The restored reasoner (structured JSON, ~610 output tokens) is what moved the median turn from 6.8 s to 16.9 s.

As seen by whichpart-api (all AC2 turns, both versions): `engineMs` p50 8,238, p90 19,112, max 27,716.

Lambda REPORT (engine): 2,774 invocations, max duration 35,152 ms, p90 19,131 ms, max memory 142 MB, 0 timeouts, 0 errors.

---

## 4. Failures and timeouts (last 24 h)

### Engine: zero explicit failures
```
filter evt="diagnosis-engine" | stats count(*) as n by ok, error, providerStatus   -> {"ok":"1","n":"2774"}
filter ispresent(error) | stats count(*) by evt, error                            -> []
filter @message like /\tERROR\t/ or /Task timed out/ or /Runtime\.\w+/ or /[parts-catalogue]|[media]|feedback write failed/ -> []
REPORT: timeouts 0, errors 0
CloudWatch AWS/Lambda (24 h sums): engine Invocations 2774, Errors 0, Throttles 2; whichpart-api Invocations 2880, Errors 0, Throttles 0
engine ConcurrentExecutions 1-min max over 24 h: 2
```
No `provider_unavailable:*` (Qwen/LM Studio or Jev) and no `engine_unavailable` were logged (`handler.js:72-79` would log `error`).

### whichpart-api: 14 failed AC2 turns of 2,776 (0.5%)
```
$ insights.sh /aws/lambda/whichpart-api 24 'filter evt="whichpart-api" and (ispresent(ac2.error) or route="AC2") | stats count(*) as n by ok, ac2.error, route'
{"route":"AC2","n":"2762"}
{"ok":"0","ac2.error":"engine_unreachable","n":"9"}
{"ok":"0","ac2.error":"engine_http_429","n":"2"}
{"ok":"0","ac2.error":"state_save_conflict","n":"3"}
```
- **engine_unreachable x 9** (16:28, 16:32, 17:36, 19:29, 20:07, 21:05, 22:46, 22:50, 22:50 UTC), each at `ms` 28,016-28,231: the BFF's own **28 s client timeout**, not a provider error. Each has a matching engine turn that completed `ok:true` with `totalMs` 28,155-35,149 (exactly 9 engine turns > 28 s):
  ```
  filter evt="diagnosis-engine" and totalMs > 28000 | fields @timestamp, totalMs, understand, label, enrich, reason, verify, regenerate, replyLabel
  16:28:39 28155  u1320 l338   e1    r13588 v1389 rg11060 rl303
  16:32:08 35149  u2369 l311   e0    r15940 v6114 rg9533  rl286
  17:36:35 30737  u1682 l335   e1    r11024 v8446 rg8658  rl418
  19:29:13 30245  u1533 l832   e4784 r7877  v5352 rg7397  rl473
  20:07:21 29754  u5248 l309   e1    r16446 v7293         rl409
  21:05:59 29022  u2839 l1229  e1    r19373 v5183         rl395
  22:46:36 29211  u2454 l12742 e0    r11374 v2273         rl365   <- Jev label hit its 12 s timeout + retry
  22:50:21 28710  u3483 l279   e1    r17893 v6662         rl300
  22:50:59 29442  u3632 l310   e461  r18387 v6208         rl308
  ```
  Causes: 4 regenerations before 21.14's 26 s budget, then slow single reasoner passes (16-19 s) and one slow Jev call. The customer saw "AI service unavailable" while the engine had an answer. Fixed by change **21.17** (`infra/production/changes/21.17-engine-wait-45s.json`; `services/whichpart-api/ac2-turn.js:12` now `AC2_ENGINE_TIMEOUT_MS || 45000`; deployed 2026-10-13T23:42Z, both Lambdas' `LastModified`). The change spec says the old value was 28 s and counts "4 of 470 turns past 28 s".
- **engine_http_429 x 2** (15:24, 15:48, 38-44 ms): Lambda throttles (engine Throttles = 2; account concurrency quota 10, `README.md:160`).
- **state_save_conflict x 3** (02:16 UTC): conversation-state write conflicts, not model related.
- No Jev HTTP/auth/credit error, no LM Studio HTTP error, no tunnel outage in the window. (The previous day's tunnel drop 2026-10-12 20:25-21:19 UTC is outside it, `README.md:165`.)

---

## 5. The general assistant in the benchmark (`evaluation/independent-100/lib/ga.mjs`)

- Model: `GA_MODEL = process.env.GA_MODEL || 'claude-opus-5-5'` (`ga.mjs:6`).
- System prompt, verbatim (`ga.mjs:7`): `You are Claude, a helpful AI assistant made by Anthropic. The current date is Monday 12 October 2026.`
- Input: only the customer's messages, one per call; first call `--session-id <uuid>`, then `--resume` (`ga.mjs:10-17`, `llm.mjs:16`), so it sees the full conversation history held by the CLI session. Text only (run.mjs sends `message` strings; no images).
- Transport (`lib/llm.mjs:14-27`): Claude Code CLI `claude -p --system-prompt <GA_SYSTEM> --tools '' --strict-mcp-config --setting-sources '' --model <model> --output-format json`, cwd an empty sandbox `/tmp/ga-sandbox`, 300 s timeout. So: **no tools, no MCP servers, no web, no CLAUDE.md/settings, no appliance instructions or knowledge**. Temperature, max tokens and thinking are not set: CLI defaults.
- Up to 8 customer messages (`lib/sim.mjs:6`), concurrency 4 for GA vs 2 for AC (`run.mjs:22`).
- Doc: `docs/evaluation/independent-100-case-benchmark.md:20` (same description); cost $13.93 for the GA's 100 conversations (`:115`).
- The engine's evaluation-only `qwen-plain` control uses the same style of prompt for Qwen: `'You are a helpful AI assistant. The current date is Monday 12 October 2026.'` (`ac2/runtime.js:70`, changes 21.10 / 21.12). In the 24 h window `ac2.control` was never set (no qwen-plain turn), and no repo result for it exists (`grep -rl qwen-plain` finds only code, tests and the two change specs).

---

## 6. Earlier model/provider comparisons

### In the repo docs
- Every current evaluation compares **AC on Qwen** against **Claude Opus 5.5 (general assistant)**; it is not a same-pipeline model swap. Latest (`docs/evaluation/ac3-pipeline-results.md:49-63`): 21.16 overall 2.74 vs GA 3.48; pairwise 14-86; median/p90 turn 18.1/22.5 s vs GA 16.1/21.9 s.
- `docs/evaluation/llm-led-rebuild.md:172-176` attributes the gap to the reasoner: usefulness 2.76 vs 3.60, question quality 2.42 vs 3.09, calibration 2.77 vs 3.30, while kernel-owned dimensions are close (no-fabrication 3.73 vs 3.93); "The production model (Qwen 3.6 35B-A3B, fixed by the owner) is a much smaller model ... the kernel can stop it from saying the wrong thing but cannot make it reason better." Same doc: ~2.1 model calls and 3,700 prompt / 600 completion tokens per turn (`:156-157`).
- `docs/evaluation/independent-100-case-benchmark.md:338`: AC's own providers (Jev, LM Studio, OpenAI) were deliberately not used for GA/simulator/judges; no non-Anthropic provider was available to the evaluator.
- `docs/migration/phase-7-package-diagnosis-role.md:99-100`: the OpenAI secret was read only on 2026-10-05 (batch runs routed to frontier). `docs/migration/phase-7-results.md:281-308`: batch runs rewrite live routing.
- **No doc in this repo reports a Qwen vs GPT (or any model vs model) result for AC.** grep of docs/evaluation and docs/adr for `gpt|openai|frontier|model comparison` finds only the drift note, the judge-model default (`docs/architecture/configuration.md:63`) and the GA disclaimer.

### Outside the docs: the ACQ batch-runner records in S3 (read-only)
`aws s3 cp s3://whichpart-learning-800960611664/acq/runs/ <scratchpad>/acq-runs/ --recursive` (46 run records). These are the old (pre-rebuild, journey-era) ACQ-100-V1 benchmark: 121 scripted journeys, scorer `acq-scoring-v1`, **judge `gpt-5.6-terra`**, concurrency 1 per run.

**2026-09-04: the only full model comparison (2 x 2 routing, 121 journeys each):**

| Label (UNDERSTAND / COMPOSE) | Quality | Correctness | Hard violations | Correct outcome | Per-turn latency median / p90 |
|---|---|---|---|---|---|
| LOCAL / LOCAL (Qwen / Qwen) | 63.8 | 68.4 | 1 | 62.8% | 11.9 / 16.2 s |
| FRONTIER / LOCAL (GPT / Qwen) | 65.2 | 70.0 | 1 | 66.1% | 7.9 / 10.5 s |
| LOCAL / FRONTIER (Qwen / GPT) | 65.2 | 69.5 | 0 | 66.1% | 10.4 / 14.5 s |
| FRONTIER / FRONTIER (GPT / GPT) | 64.1 | 67.3 | 1 | 63.6% | 5.7 / 8.1 s |

Dimensions, e.g. reasoning discrimination 49.0 / 51.6 / 53.5 / 53.0, question quality 41.3 / 41.0 / 38.3 / 38.6, customer answer quality 50.3 / 51.9 / 54.5 / 53.4, safety 99.2 / 99.2 / 100 / 99.2. Token usage and cost were "NOT AVAILABLE".
What it showed: on that architecture GPT-5.6-terra made at most +1.4 quality points of difference (within noise), and was faster mainly because it did not queue on the one-at-a-time LM Studio (three runs started together at 09:16:43-44, so the LOCAL legs shared the single local server). Caveats: different (journey/template) architecture where the LLM had a small role, same-family judge as the frontier model, single run each, never written up in the repo.

Other runs: 2026-09-04 to 09-08 are 36 LOCAL/LOCAL validation runs (quality 41.9-89.7 on subsets); 2026-10-05 has four FRONTIER_EXPERIMENT runs (1-2 journeys each, "routing-override live proof", "transport JSON live proof", "runner fidelity live proof") that tested the batch runner's routing override, not model quality (one RESTORE_FAILED, then restored by admin per the ai-config history).
