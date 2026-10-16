# Brief for the review session (written 2026-10-16)

You are reviewing **Appliance Clinic** (applianceclinic.ai): a UK home-appliance diagnosis chat. Proof of concept, no
real customers; production deploys are authorised. Repo `timdodgson/appliance-clinic`, branch `r3/phase3`. The owner
builds this by working with AI and will show it when applying for a senior developer job.

## Owner's rules (non-negotiable)
1. Deep review, not a skim. Read the code; follow every path. Don't rely on READMEs or on earlier sessions' claims.
2. Facts only. Every finding cites a file:line, a command output or a test result. If you can't prove it, say so.
3. Change only what you are certain needs changing, and prove it: the same tests before and after. Going backwards is
   a total failure.
4. Short, plain answers. No walls of text, no tables of jargon. Capitals from the owner mean they are angry.
5. Never print, echo or commit secrets or keys.
6. First deliver the findings (short list: problem, evidence, proposed action, how sure). Change nothing until the
   owner says go. Then do the approved changes without more back-and-forth.

## What to review
1. **Dead code**, the whole repo (`services/diagnosis-engine`, `services/whichpart-api`, `apps/web`, `error-codes`,
   `tools`, `build`, `infra`, `evaluation`, `prompts`, `docs`). The 2026-10-16 refactor removed a whole pipeline, so
   look for leftovers, for example (check each, don't assume): Jev (`jev-client.js`, Jev secret loading in
   `admin-config.js`, Jev in admin settings / transcript review), `ac2/errorcodes.js` (a second copy of the error-code
   data), `knowledge.js partMatchers`, BFF `index.js` view code for fields the engine no longer sends
   (`suggestedChecks`, `componentMention`, diagnosis label, "Worth checking" strip), retired prompts, old benchmark
   harnesses (`evaluation/rebuild`, `independent-100`, acq-*, gold-v2), admin UI showing old labels/stages.
2. **Docs vs the live architecture**: README(s), `docs/architecture/*`, ADRs, `prompts/README.md`, runbooks.
   Note: `docs/evaluation/code-audit-2026-10-16/CODE-WALKTHROUGH.md` describes the OLD pipeline (before 23.1).
3. **Security and prompt injection**: what is tested today and what is not. Customer messages trying to override
   instructions or extract the system prompt; injection through tool results (catalogue part titles, error-code text)
   and photos; secrets in logs; rate limits (21.37); Cloudflare Turnstile bot check (21.38-21.40, enforce);
   state token; admin auth; CSP/CORS; cost abuse. The scripted test set has **no** injection or security cases yet.
   The old fixed scope/attack replies were removed in 23.1; out-of-scope and attacks are now handled by the prompt only.
4. **Honest portfolio view**: would this repo and site impress for a senior dev role? What helps, what hurts.

## The system now (live)
- Browser `apps/web/public/app.js` → `services/whichpart-api/index.js` (rate limits, Turnstile, state token,
  `ac2-turn.js`) → engine `services/diagnosis-engine/handler.js` → `ac2/runtime.js` → `ac2/turn.js`:
  gas/fire stop → hazard word lists → fault notes + pictures (`knowledge.js`, `media.js`) → **`ac2/advisor.js`**
  (Opus 5.5 with tools: `lookup_error_code`, `find_parts`, `send_reply`; raw HTTPS in `inference.js`
  `AnthropicProvider.converse`, `fallbacks: "default"`) → fixed safety checks (`safety.js gateReply`, unsafe
  reassurance, unverified part numbers/prices, isolation line) → response.
- Parts come from the external Spares4Repairs API `65vnizdmk4…/api/parts-for-model` (`engine/parts-client.js`).
- Error codes from the error-code service (`ac2/mcp.js`, Lambda `applianceclinic-error-code-mcp`).
- Changes: 23.1 (advisor refactor), 23.2 (built-in appliances), 21.37 (cost limits), 21.38-21.40 (Turnstile).

## Facts already established (read these files)
- `docs/evaluation/code-audit-2026-10-16/FACTS.md` and `REPORT.md`: why the old pipeline failed.
- `evaluation/scripted/tests.json`, `run.cjs`, `SIDE-BY-SIDE.md`: 22 scripted pass/fail chats. New system 22/22,
  old 2/22 (same messages). Small set; patterns hand-written; 4 test patterns were corrected after reading replies
  (WATER flag, "replac", "good work", "don't pull it out").
- The old 100-case judge scores are not reliable (FACTS.md point 11).
- Not yet proven live: customer **photos** reaching Opus end to end.

## How to work here
- AWS: credentials are in environment variables; the AWS CLI is not installed in a fresh container (install it into
  a venv in your scratchpad). Region eu-west-1, account 800960611664.
- This sandbox's network blocks the error-code service URL; `evaluation/scripted/run.cjs` reaches it through the
  Lambda API instead.
- Tests: `npm run -s test:runtime` (all must pass; tests are registered in `docs/migration/runtime-changes.json`);
  web: `cd apps/web && npm ci && npm run check`; scripted chats:
  `node evaluation/scripted/run.cjs --out evaluation/scripted/out/<name> --budget 4` (about $1 a full run).
- After changing runtime files: update `docs/migration/runtime-changes.json` and run
  `node tools/migration/bin/runtime-changes.mjs --write`; prompt changes need a new version in `prompts/registry.json`
  (fingerprint via `prompts/fingerprint.mjs`).
- Release: `python3 build/scripts/package_zips.py` → upload the zip to `s3://cdk-acclinic-assets-800960611664-eu-west-1/phase8/`
  → set the s3Key in `infra/cdk/config/runtime-overrides.json` → spec in `infra/production/changes/` (copy 23.2 or
  21.40) → `bash infra/production/steps/change.sh <spec>` (dry run) → `EXECUTE=1 …` → update
  `build/reference/*.zip.json`. Web: `cd apps/web && EXECUTE=1 node scripts/deploy.mjs`.
- Commit and push to `r3/phase3`.
