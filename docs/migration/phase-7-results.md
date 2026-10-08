# Phase 7 results

What Phase 7 (PLAN.md; [runbook](runbooks/phase-7-security.md); issue #54) did. Every step ran as the IAM user in
account `800960611664`, eu-west-1. Every production change was a reviewed CDK change set
([`change.sh`](../../infra/production/steps/change.sh), spec in
[`infra/production/changes/`](../../infra/production/changes/)), applied with the `acclinic` execution role holding a
temporary, resource-scoped grant. Raw outputs stay in `.migration-output/phase7/`.

## Findings that bound the scope

- **The account's Lambda concurrency limit is 10, shared by S4R and AC.** Reserved concurrency cannot be set: AWS keeps
  a minimum of unreserved concurrency, and the account is already at it. Load on any AC function can throttle the S4R
  server Lambda, and the reverse. The fix is a Service Quotas increase, an account-level request for the owner (see
  *For the owner*).
- **The OpenAI, Jev and ai-config secrets** are read by the diagnosis Lambda through the S4R role's
  `spares4repairs/dev/*` grant.
  - Moving them to an AC namespace needs the diagnosis-role move first, which is POTENTIALLY IMPACTS S4R.
  - Rotating the OpenAI key and the Jev token needs new credentials from the providers. This work does not invent them.
  - Both are packaged below. HMAC and bearer values are AC-only and are rotated here.
- **The web front-end source is not in this repository.** `index.html` is deployed from the monorepo, frozen since
  Phase 0. A content security policy on the site needs the site deploy path from ADR 0008. CSP and security headers are
  applied where this repository generates the responses: the API and the recall pages.
- **All four Function URLs carry `PublicInvoke`:** `lambda:InvokeFunction` for `*` with no condition. Lambda requires
  that permission alongside `InvokeFunctionUrl` for public URLs. Without the `lambda:InvokedViaFunctionUrl` condition,
  though, any AWS principal can invoke the function directly with an arbitrary event, bypassing the URL.
  - On the three AC-only functions it is hardened here.
  - On the diagnosis Lambda it is POTENTIALLY IMPACTS S4R and packaged.
- **Customer sign-in on the AC site** (`/auth/login`) gates nothing for customers: sessions are checked only on admin
  routes. Moving sign-in to the AC pool therefore changes admin access only. A shop customer who signed in on the AC
  site saw only their name in the header.

## 7.1: `AcAuthStack` (2026-10-08, 15:45Z)

| Item | Result |
|---|---|
| Change set | 4 Add: user pool, app client, `admin` group, prefix domain. No other action. Update-mode check passed |
| Grant | Cognito create and describe actions on user pools in the account (`CreateUserPool` takes no resource). `ac-deny-s4r` explicitly denies everything on the S4R pool. No delete and no user action |
| CloudTrail | `CreateUserPool` (`applianceclinic`), `CreateUserPoolClient`, `CreateUserPoolDomain`, `CreateGroup` on `eu-west-1_r4fXXEdxC`. Nothing on the S4R pool |
| Stack | `CREATE_COMPLETE`, termination protection, stack policy. Drift `IN_SYNC` (client, group, domain; CloudFormation reports no drift result for the pool resource). No-op confirmed |
| Read-only base | Drift detection runs with the execution role, so the read-only base gained the Cognito configuration reads on the AC pool, and nothing on users (`ac-cfn-execution` v14) |

Pool `applianceclinic` (`eu-west-1_r4fXXEdxC`, Lite tier):
- email is the username, and only administrators create users
- password policy: 14 characters with all classes; temporary passwords last 3 days
- email recovery, MFA off, deletion protection on

Client `applianceclinic-web` (`2hgmm8m02n78agi46kae4p2eja`):
- no secret
- flows: `ADMIN_USER_PASSWORD_AUTH`, `USER_SRP_AUTH`, refresh
- tokens: 60-minute access and ID tokens, 1-day refresh, revocation on
- the code flow is enabled for the managed sign-in pages only

Domain: `applianceclinic-admin.auth.eu-west-1.amazoncognito.com`, ACTIVE.

## 7.2: `whichpart-api` sign-in on the AC pool (16:00Z)

**Code.** [`ac-auth.js`](../../services/whichpart-api/ac-auth.js), wired into `index.js`:
- **Sessions.** A token is a session only if it was issued by the AC pool, for the AC client, as an access token
  (issuer, `token_use`, `client_id`). Cognito `GetUser` accepts a valid token from any pool in the region, so without
  this check a token from another pool could carry an `admin` group.
- **Admin authority** is membership of the AC pool's `admin` group; `AC_ADMIN_SUBS` is gone.
- **Old cookies.** A cookie from any other pool, such as the S4R pool before the cut-over, is signed out.
- **First sign-in.** An invited user who has not set a password yet gets `403 password_change_required`.

The code has 10 tests ([`ac-auth.test.mjs`](../../services/whichpart-api/test/ac-auth.test.mjs)) and passes the full
whichpart-api suite.

**Artefact.**
- Built from this repository: 69 files.
- Against the Phase 1 production reference, only `index.js` differs and `ac-auth.js` is added.
- Staged at `phase7/whichpart-api-piTEBGd8hUIng6SpYTqXVWRj8qhR0q-xaaLDI66BAW0.zip`. Live CodeSha256 equals it after the
  update.
- `build/reference/whichpart-api.zip.json` now records it.

| Item | Result |
|---|---|
| Template | Equal to the deployed one for every resource but `whichpartapi`. The S4R app client ID no longer appears in the template |
| Change set | 1 Modify `whichpartapi`, Replacement False, details `Properties.Code` and `Properties.Environment` only |
| Environment | `COGNITO_USER_POOL_ID` and `COGNITO_CLIENT_ID` set to the AC pool and client; `AC_ADMIN_GROUP=admin`; `AC_ADMIN_SUBS` removed |
| CloudTrail | `lambda:UpdateFunctionConfiguration` and `lambda:UpdateFunctionCode` on `whichpart-api` only |
| Stack | `UPDATE_COMPLETE`, drift `IN_SYNC`, no-op confirmed |

**Admin recreated.** The one AC admin, the user on the old `AC_ADMIN_SUBS` allowlist:
- Their email was looked up read-only in the S4R pool, never printed or stored.
- They were created in the AC pool by invitation and added to `admin`.
- Cognito emailed them a temporary password. They set their own on the AC sign-in page.
- Status: `FORCE_CHANGE_PASSWORD` until they do.

## 7.3: `whichpart-cognito-auth` points at the AC pool (16:11Z)

| Item | Result |
|---|---|
| Change set | 1 Modify `whichpartapirolewhichpartcognitoauth` (`AWS::IAM::RolePolicy`), Replacement False, `PolicyDocument` only. Flagged as an IAM change, as intended |
| Policy | Before: `AdminInitiateAuth` and `AdminGetUser` on the S4R pool. After: `AdminInitiateAuth` on the AC pool only. `AdminGetUser` is never called |
| CloudTrail | `iam:PutRolePolicy` on `whichpart-api-role` only (read from us-east-1, see below) |
| Stack | `UPDATE_COMPLETE`, drift `IN_SYNC`, no-op confirmed. The S4R pool ID no longer appears anywhere in `AcRuntimeStack` |

Between 7.2 and 7.3, sign-in against the AC pool returned 500 (`AccessDeniedException`), because the role could still
only sign in against the S4R pool. That lasted 11 minutes, while no AC user had a password yet.

**Verification after 7.3** ([`verify-ac-auth.sh`](../../infra/production/verify-ac-auth.sh), through
`https://applianceclinic.ai/api`, with two temporary AC users that were deleted afterwards). All checks pass:
- no cookie: `/admin/health` is 401
- a cookie claiming the S4R pool with an `admin` group: `/auth/me` is signed out, `/admin/health` is 401
- the temporary admin signs in (`isAdmin: true`), reaches `/admin/health` (200) and signs out
- a temporary user without the group signs in (`isAdmin: false`) and gets 401 on `/admin/health`
- a wrong password is 401

After 7.2 and 7.3:
- S4R health 3 × 200
- customer `/api` smoke equal to the pre-Phase-5 baseline
- the `/part-finder` contract and `/ai/chat` ingress pass
- CloudTrail shows **no** write event on the S4R pool since Phase 7 started

## 7.4 to 7.7: rate limiting on `whichpart-api`

**Design** ([`rate-limit.js`](../../services/whichpart-api/rate-limit.js), 19 tests in
[`rate-limit.test.mjs`](../../services/whichpart-api/test/rate-limit.test.mjs)):
- Fixed windows counted in the AC table `applianceclinic-rate-limits`: one atomic `UpdateItem` per dimension, and a TTL
  on `expiresAt`. Keys are SHA-256 hashes: no address or email is stored.
- **Fails open.** If the table cannot be reached, the request proceeds and the error is logged. The limiter never takes
  the site down.
- **Sign-in** (`/auth/login`, counted after input validation):
  - 5 per email and 60 overall per 15 minutes are enforced
  - 10 per IP is advisory
- **Customer turns** (`POST /`, counted after message validation):
  - 40 per conversation, 600 per network source and 1200 overall per 10 minutes are enforced
  - 60 per IP is advisory
  - Benchmark and live-test turns are not counted: they have their own authentication.
- **Refusal:** `429 {error: "Too many requests. Please wait a moment and try again.", code: "rate_limited"}`, with
  `Retry-After` set to the end of the window.
- **Admin routes** sit behind AC sign-in. Their only brute-force surface is sign-in itself, which is limited per email.
- **Behaviour is never inferred from text.** Only counts are used.

**Per-IP limits are advisory, from a probe (7.5b).** The function receives the viewer's own `X-Forwarded-For` unchanged
through the AC CloudFront distribution. With no header from the viewer, it receives one CloudFront-set entry. Any address
in that header can be forged, so a per-IP limit there could lock out a stranger or be dodged. Per-IP counts are logged
and never refuse. The enforced keys are the ones a client cannot choose: email, conversation, network source and overall.

| Change | What | Change set | CloudTrail |
|---|---|---|---|
| 7.4 | `RateLimitTable` in `AcDataStack`: on-demand, TTL, deletion protection, Retain | 1 Add | `CreateTable` and `UpdateTimeToLive` on the new table only |
| 7.5 | Code, observe mode, `RATE_LIMIT_MODE`, `RATE_LIMIT_TABLE`, inline policy `whichpart-rate-limits-dynamodb` (`UpdateItem` on the table only) | Modify `whichpartapi` (code, environment), Add one `AWS::IAM::RolePolicy` | `PutRolePolicy`, `UpdateFunctionConfiguration`, `UpdateFunctionCode`, AC resources only |
| 7.5b | Client address: right-most `X-Forwarded-For` entry | Code only | `UpdateFunctionCode` only |
| 7.5c | Enforced keys moved off the client address (above) | Code only | `UpdateFunctionCode` only |
| 7.7 | `RATE_LIMIT_MODE=enforce` | Environment only | `UpdateFunctionConfiguration` on `whichpart-api` only |

Every change: drift `IN_SYNC`, no-op confirmed, S4R health 3 × 200, smoke equal to the baseline, `/part-finder` contract
and `/ai/chat` ingress ok.

**Before enforcing:**
- In observe mode, no request exceeded any limit.
- Customer traffic is about 23 to 37 turns a day, at most 6 in any 10 minutes this week.
- The busiest 10 minutes of the last 10 days were 434 turns, a batch run on 2026-10-04. That is under every enforced limit.

**After 7.7, live:**
- Six failed sign-ins for one made-up address return 401 five times, then `429 rate_limited`.
- `verify-ac-auth.sh` passes, and the smoke is unchanged.

**Rollback:** the same change with `RATE_LIMIT_MODE=observe` (environment only).

## 7.6: a failed COMPOSE is an explicit failure (#21)

**Before.** When the provider of a required canonical COMPOSE failed, the canonical runtime replied with the
deterministic template and recorded the structured violation `compose_failed`. `whichpart-api` returned that reply as a
normal turn and advanced the canonical state. The customer saw a healthy-looking answer, and the state moved past a
question the model never worded.

**After** (`whichpart-api` only, [`index.js`](../../services/whichpart-api/index.js) `composeProviderFailed`). When the
`canonical-control` stage reports `compose_failed`:
- The response is the documented public failure: `"AI service unavailable. Please try again in a moment."`, `error: true`,
  `errorCode: "ai_unavailable"`, HTTP 200, the same shape as the existing orchestrator-unavailable path.
- The canonical state is not advanced. The customer's retry runs against the same state.
- The turn is logged as `ok: false, composeFailed: true` and audited in the transcript as `compose_failed`.
- Output-contract fallbacks (tripwire, reply check) and the fixed safety-stop copy keep their template replies by
  design: they are not provider failures.
- Detection reads the structured field only. The same words in a reply never trigger it.

**Scope.**
- The diagnosis Lambda, `/part-finder` and `/ai/chat` are untouched, so the S4R-facing contract is unchanged.
- An S4R-side compose failure still returns the template, as before. Changing that would be POTENTIALLY IMPACTS S4R.

**Tests.** 4 semantic tests ([`compose-failure.test.mjs`](../../services/whichpart-api/test/compose-failure.test.mjs)),
with the real handler and a mocked orchestrator:
- detection
- the failure view, with state version 1 kept and the retry reaching 2
- fallbacks unchanged
- no inference from text

**Deployment.**

| Item | Result |
|---|---|
| Change set | 1 Modify `whichpartapi`, `Properties.Code` only |
| Artefact | 70 files; only `index.js` differs from 7.5c. Live CodeSha256 `qaCMUgHW…` equals the staged zip |
| CloudTrail | `lambda:UpdateFunctionCode` on `whichpart-api` only |
| Stack | Drift `IN_SYNC`, no-op confirmed |

**Evaluation.**
- **Normal turns are unchanged.**
  - The smoke equals the pre-Phase-5 baseline (4 × 200, same safety, parts and state-token shape).
  - The `/part-finder` contract and the `/ai/chat` ingress pass.
  - The semantic tests prove that only the structured provider failure changes the response.
- **LLM-as-judge.**
  - **In production:** the transcript-review judge (Jev, every 15 minutes, over ended customer sessions) has 264
    reviews in the 10 days before 7.6: 187 good, 29 mixed, 1 poor, 47 insufficient evidence. That is the baseline to
    compare against as post-7.6 sessions are reviewed.
  - **GOLD v2** (the active scenario suite, judged by Jev) cannot be run from this repository:
    - its live transport `benchmark/gold-v2/run-baseline.mjs` was never imported, because it does not exist in the
      production source
    - its judge needs the owner's Jev credentials, which this work does not take out of Secrets Manager
  - It is packaged for the owner (*For the owner*).
  - A GOLD v2 run on a healthy system would not take the changed path in any case. The change only acts when the COMPOSE
    provider fails.

## 7.8 and 7.9: AC-only endpoints

**Authentication was already in place.** Both AC-only endpoints refuse anything without their bearer before doing any
work, and the bearer is compared in constant time. `verify-ac-endpoints.sh` proves this before and after every change:
- the orchestrator `POST /diagnose` without a bearer, or with a wrong one, is 401
- the MCP `POST /mcp` without a bearer, or with a wrong one, is 401

The only callers are server side: `whichpart-api` calls the orchestrator and the MCP, and the orchestrator calls the
MCP.

**`/health` stays unauthenticated, deliberately.** Status checks use it, and it returns only:
- the orchestrator: status, version, and whether its downstreams are configured
- the MCP: status, version, dataset counts and 12-character hash prefixes

Neither returns a token, secret, path or customer data, and the check script asserts that. The orchestrator also
answers any method on `/health`, which is harmless; fixing it needs an image rebuild, so it is left as is.

**What changed** (`AcRuntimeStack`, Function URL settings and resource policies of the three AC functions only):

| Change | What | Change set | Result |
|---|---|---|---|
| 7.8 | Function URL CORS removed from the orchestrator and MCP (it was `AllowOrigins *`). No browser can hold their bearer, so no browser caller exists | 2 Modify `AWS::Lambda::Url`, `Properties.Cors` only | Both URLs: auth `NONE` (unchanged), CORS none |
| 7.9a | `PublicInvoke` (`lambda:InvokeFunction` for `*`) on the orchestrator and MCP gains `lambda:InvokedViaFunctionUrl = true` | 2 Modify `AWS::Lambda::Permission`, Replacement True, `InvokedViaFunctionUrl` (and the replace policy, below) | One public `InvokeFunction` statement each, URL-only. The old statements are gone |
| 7.9b | The same for `whichpart-api`. Its EventBridge statements are separate and unchanged | 1 Modify `AWS::Lambda::Permission`, Replacement True | URL-only |

**CloudTrail:**
- 7.8: `UpdateFunctionUrlConfig` on the orchestrator and MCP only
- 7.9a: `AddPermission` and `RemovePermission` on the orchestrator and MCP only
- 7.9b: `AddPermission` and `RemovePermission` on `whichpart-api` only

None of the three wrote outside its spec's resources. After 7.9b, the 15-minute EventBridge schedule still invokes
`whichpart-api` (18:40Z run logged).

**Before 7.9,** any AWS principal could invoke these functions directly, with any event, bypassing the URL and its
headers. Now the public statement admits only invocations made through the Function URL.

**How a permission is replaced safely** (tooling, this PR):
- **Logical IDs stay stable.** A permission is changed by replacement. CloudFormation creates the new statement under a
  generated id (`<stack>-<logicalId>-<suffix>`) before it removes the old one. The generator maps that id back to the
  imported one, so logical IDs do not move after the change.
- **Replace policy.** These permissions carry `UpdateReplacePolicy: Delete`, so the replaced statement does not remain.
  The change-set checker accepts that only on a deletion-retained Lambda permission with a recorded reason
  (`ac:updateReplacePolicyReason`).
- **Replacement must be named.** The checker accepts a replacement only when the spec names it (`approvedReplacements`).
- **Temporary stack policy.** During the execution it allows `Update:Modify` everywhere and `Update:Replace` and
  `Update:Delete` on the named logical IDs only.
  - The first two attempts at 7.9a used a `Deny` with `NotResource`. CloudFormation refused the update and rolled it
    back, with nothing changed. The policy is now allow-only.
  - After each attempt, the base stack policy and execution policy v17 were restored, and every check was rerun unchanged.

**Verification after each change:**
- `verify-ac-endpoints.sh` passes
- `verify-ac-auth.sh` passes, including a new check: the admin lists error codes, a read through the MCP Function URL
  with its bearer
- the customer smoke (`whichpart-api` → orchestrator URL) is equal to the baseline
- S4R health is 3 × 200, and the `/part-finder` contract and `/ai/chat` ingress pass
- drift is `IN_SYNC` and the no-op is confirmed

**The diagnosis Lambda's `PublicInvoke`** has the same exposure. It is POTENTIALLY IMPACTS S4R, so it is listed under
*Changes that need the owner's approval*, not made.

**Reserved concurrency: not possible.** The account's concurrency limit is 10. AWS keeps at least 10 unreserved, so no
function can reserve any. A Service Quotas increase (owner) comes first; then reserve, for example, 2 for `whichpart-api`
and 1 each for the orchestrator and MCP, leaving the rest unreserved for the S4R server.

## 7.11: batch runs default to staging, and production needs explicit intent

**The risk.** A batch run sends its turns to an AC API. When its COMPOSE differs from live, it also rewrites the live
AI-config secret for the run's duration (`routing-override.js`). That secret is `spares4repairs/dev/applianceclinic-ai-config`,
and the **diagnosis Lambda reads it too**, so a batch run could silently change S4R `/part-finder` routing:
- No run named a target environment.
- No run recorded any intent.
- The owner ran batches as recently as 2026-10-05; the last routing lease was released that day.

**The change** ([`benchmark/target.js`](../../services/whichpart-api/benchmark/target.js), 13 tests):
- **Default target: staging.** No staging environment is configured (`BENCHMARK_STAGING_URL` is unset), so a run
  without a target is refused with `409 STAGING_NOT_CONFIGURED`, and the message says how to declare production intent.
- **`target: "production"`** needs `confirmProduction: true`. A run whose COMPOSE would change live routing also needs
  `confirmProductionRouting: true`. The response lists the fields it would change.
- **Recorded intent.** The intent (who, when, routing or not) is recorded on the run. `routing-override.js` `begin()`
  refuses to rewrite live routing for any run that does not carry recorded routing intent, and writes nothing.
- **Scope.** All three enqueue routes (`build-run`, `rerun`, and the legacy ACQ-100 `run`) go through the gate. A source
  guard test enforces that.
- **Retired suites.** No retired or legacy suite is re-enabled. ACQ-100 stays labelled legacy and non-authoritative, and
  it is not used for any evaluation here.

**Limits:**
- **The batch worker is not in this repository.** It runs on the owner's machine, and CloudTrail shows it writing the
  AI-config secret with the owner's IAM user (38 writes in 90 days). The API gate stops runs from being queued without
  intent. The `begin()` guard binds the worker only if it runs this repository's `routing-override.js`. The owner should
  update the worker to this code, or give it a role that cannot write the live secret.
- **A real staging environment** (a second AC stack, with its own AI-config secret not read by the diagnosis Lambda) is
  new infrastructure. It is outside Phase 7. Until it exists, every batch run is an explicit production run.

**Deployment.**

| Item | Result |
|---|---|
| Change set | 1 Modify `whichpartapi`, `Properties.Code` only |
| Artefact | Against 7.6: `index.js`, `benchmark/acq-store.js` and `benchmark/routing-override.js` differ; `benchmark/target.js` is added |
| Live check (`verify-ac-auth.sh`, temporary admin) | Enqueue without a target: 409 `STAGING_NOT_CONFIGURED`. Production without confirmation: 400. The run count stayed 46 and the routing lease was untouched |
| CloudTrail | `lambda:UpdateFunctionCode` on `whichpart-api` only |
| Stack | Drift `IN_SYNC`, no-op confirmed |

## 7.12: CORS allowlist and security headers on `whichpart-api`

**Before.** Every response carried `access-control-allow-origin: *` and no security headers.

**After** ([`http-headers.js`](../../services/whichpart-api/http-headers.js), 7 tests):
- **CORS.** It is sent only to the four AC origins, echoed with `vary: origin`: `https://applianceclinic.ai`,
  `https://www.applianceclinic.ai`, `https://whichpart.co.uk` and `https://www.whichpart.co.uk`. Any other origin gets no
  CORS headers.
- **Security headers on every HTTP response:**
  - HSTS (1 year, including subdomains)
  - `x-content-type-options: nosniff`
  - `x-frame-options: DENY`
  - `referrer-policy: strict-origin-when-cross-origin`
  - a CSP that allows nothing to load (`default-src 'none'; frame-ancestors 'none'; base-uri 'none'`), since every
    response is JSON
- **Scheduled events are untouched.**

**Why this is safe.**
- The site calls `/api` same-origin through the AC CloudFront distribution.
- That behaviour forwards all viewer headers (managed policy `AllViewerExceptHostHeader`) and does not cache
  (`CachingDisabled`).
- The site's page CSP needs the site deploy path (ADR 0008). The front-end source is not in this repository.

**Live, before and after:**

| Request to `https://applianceclinic.ai/api/auth/me` | Before | After |
|---|---|---|
| Same-origin (no `Origin`) | `*` | No CORS; security headers |
| `Origin: https://applianceclinic.ai` | `*` | `https://applianceclinic.ai`; security headers |
| `Origin: https://evil.example` | `*` | No CORS; security headers |
| `OPTIONS`, `Origin: https://whichpart.co.uk` | 204, `*` | 204, `https://whichpart.co.uk` |

**Further checks:**
- **Real browser (Chromium)**, on the live site: the page loads, `/api/auth/me` returns 200, a chat turn `POST /api`
  returns 200, and there are no console errors.
- `verify-ac-auth.sh` passes all 12 checks. S4R health is 3 × 200. The contract, ingress and smoke are unchanged.
- The deployed CodeSha256 (`tzzTt…`) equals `build/reference/whichpart-api.zip.json`.
- CloudTrail: `lambda:UpdateFunctionCode` on `whichpart-api` only.

## 7.10: AC secret namespace and rotations

**The namespace (7.10a, `AcDataStack`).** Three new secrets under `applianceclinic/production/`:
- `canonical-state-token` (`{current}`)
- `orchestrator-bearer` (`{token}`)
- `mcp-bearer` (`{token}`)

Secrets Manager generated every value at creation (`GenerateSecretString`). No value was ever in a template, git, a log
or this operator's session. They carry Retain and the `ac:owner` tag. CloudTrail: `CreateSecret` on the three names only.

**HMAC signing secret: rotated with no session lost (7.10b).**
- **Code.** [`state-token.js`](../../services/whichpart-api/state-token.js) gains
  `CANONICAL_TOKEN_PREVIOUS_SECRET_ID`. That names the secret the signing secret moved from: its values verify and never
  sign. 5 new tests.
- **7.10b1** first gave `whichpart-api-role` `GetSecretValue` on the new secret only (`whichpart-ac-secrets`). The new
  code therefore never ran without its permission: a denied read would have disabled canonical control for a minute.
- **7.10b2** switched the code and environment:
  - `CANONICAL_TOKEN_SECRET_ID` is the new secret
  - `CANONICAL_TOKEN_PREVIOUS_SECRET_ID` is `spares4repairs/dev/applianceclinic-canonical-state-token`
- **Live:** a conversation started before 7.10b2 continued after it in the same canonical session (`csid` unchanged).
  New conversations start and continue. Canonical mode is `control`, with state written and nothing degraded.
- **Rollback:** swap the two variables. The code accepts either as previous, so no session breaks either way.

**Bearer tokens: rotated onto the namespace (7.10c).**
- Every consumer now reads them through `{{resolve:secretsmanager:applianceclinic/production/<name>:SecretString:token}}`:
  - from `orchestrator-bearer`: the orchestrator's `ORCH_BEARER_TOKEN` and `whichpart-api`'s `ORCHESTRATOR_TOKEN`
  - from `mcp-bearer`: `MCP_BEARER_TOKEN` on the MCP, the orchestrator and `whichpart-api`
- The values are new, so the old ones stop working. The NoEcho token parameters are gone from the template.
- **The execution role** now resolves exactly these two secrets (`ResolveAcBearerReferences`, read-only base v33). It
  could already read the same values in the functions' configuration (`lambda:Get*`), so nothing new is exposed.
- **Cut-over:** CloudFormation updated the three functions within the same minute (19:28:43Z), at low traffic. Then:
  - whichpart-api → orchestrator: the smoke turns were processed
  - whichpart-api → MCP: the admin catalogue read returns 200
  - orchestrator → MCP: an error-code turn returned `ERROR_CODE`, `mcpStatus: RESOLVED`, and `POST /mcp` 200
  - the only 401s afterwards were this script's own no-bearer and wrong-bearer probes
- **Callers.** No caller outside AWS holds the old bearers. The MCP's access log for the last 14 days shows only AWS
  (Lambda) sources, plus scanners refused at 401. Orchestrator calls match `whichpart-api` turns within 0.5%.
- **Rollback.** It restores consistency, not the old values (they were never read). Point every consumer at one pair:
  revert the overrides, and the generator carries the current live values as before.
- Drift `IN_SYNC` with the dynamic references, and the no-op is confirmed.

**Old secrets.** No S4R-owned secret was altered or deleted. These AC-owned ones remain in place, no longer read, and
can be retired by the owner later:
- `spares4repairs/diag-orchestrator/bearer-token`
- `spares4repairs/error-code-mcp/bearer-token`
- the old canonical secret, still read as the previous one until the last 30-day token expires

**Packaged, not done: the OpenAI key, the Jev token and the AI-config document.**
- Their secrets (`spares4repairs/dev/applianceclinic-*`) are also read by the **diagnosis Lambda** through the S4R role's
  `spares4repairs/dev/*` grant. Moving them changes what that Lambda reads, which is POTENTIALLY IMPACTS S4R.
- **Rotating** the OpenAI key and Jev token needs new credentials from the providers, issued by the owner. No value is
  invented here.
- **Sequence after owner sign-off:**
  1. Do the diagnosis-role move ([package](phase-7-package-diagnosis-role.md)).
  2. Create `applianceclinic/production/{openai,jev,ai-config}`.
  3. The owner sets the new provider values in Settings.
  4. Point both consumers at the new names, with the old names as fallback for one release.
  5. Revoke the old provider credentials.
- **`applianceclinic-benchmark-service`:** the external batch worker signs with it, so rotating it needs the owner's
  worker updated at the same time. Same sequence.

## 7.13: least-privilege IAM for the AC roles

From runtime evidence: the code, CloudTrail for 90 days, and IAM simulation of the proposed and the real policies.

| Change | Before | After | Evidence |
|---|---|---|---|
| 7.13a + 7.13b, logs | `AWSLambdaBasicExecutionRole` on all three roles: `CreateLogGroup`, `CreateLogStream` and `PutLogEvents` on every log group in the account | Inline `ac-function-logs`: the same three actions on the function's own log group only. The managed policy is detached (`ManagedPolicyArns: []`) | Each role is used by one function, and each function logs to `/aws/lambda/<function>`. The real roles allow their own group and deny the diagnosis Lambda's group, look-alike names and other regions. The policy was added before the detach, so logging never lacked a grant |
| 7.13c, secrets | `whichpart-ai-config-secrets`: `GetSecretValue`, `PutSecretValue`, `CreateSecret` and `UpdateSecret` on `spares4repairs/dev/applianceclinic-*` | `GetSecretValue` on the five secrets the code reads (exact ARNs); `PutSecretValue` on the three Settings writes (ai-config, openai, jev) | `CreateSecret` ran only when the secrets were first created; they are now imported with Retain. `UpdateSecret` was never used. Simulation: the needed reads and writes are allowed; `CreateSecret`, `UpdateSecret`, writes to the HMAC secret and every S4R secret are denied |

**Every change:**
- drift `IN_SYNC` and no-op confirmed
- `verify-ac-auth.sh` passes 13 checks. New: the admin reads Settings, which needs the AI-config, OpenAI and Jev reads.
- canonical sessions continue, and the smoke, S4R health, contract and ingress are unchanged

**CloudTrail for 7.10 and 7.13:**
- 7.10b1, 7.13a and 7.13c: `iam:PutRolePolicy` on the AC roles only
- 7.10b2: `lambda:UpdateFunctionConfiguration` and `UpdateFunctionCode` on `whichpart-api` only
- 7.10c: `lambda:UpdateFunctionConfiguration` on the three AC functions only
- 7.13b: the managed-policy detach on the three AC roles only

None wrote outside its spec's resources.

**Not changed, on purpose:**
- **The S3 and DynamoDB inline policies** are already scoped to exact prefixes and tables, with the actions the code uses.
- **`diag-orchestrator-role`** now has only its log policy.
- **The S4R role, and the three AC policies on it,** are untouched. Their scope belongs to the diagnosis-role package.

## Jev outage during 7.6 (external, 17:13 to 17:21Z)

The after-checks of 7.6 found the `/part-finder` contract and the `/ai/chat` ingress returning 503.

**Cause:** an external outage.
- The diagnosis Lambda's logs show Jev, its semantic model, answering HTTP 503 from 17:13:14 to 17:21:01Z. Jev is
  reached through an external tunnel (`LM_STUDIO_URL`), outside AWS.
- No Lambda was throttled.
- 7.6 changed only `whichpart-api` code, at 17:11:59, and touched nothing on that path.

**During the outage:**
- Customer turns on the AC site returned 200, degraded and slow (about 38 s).
- S4R pages returned 200.

**After Jev recovered,** the contract and ingress checks passed again, unchanged, before and after 7.7.

**For the owner:** Jev is a single external dependency of both products.

## CloudTrail reads global services in us-east-1 too

The first 7.3 check found no write, yet the policy had changed. IAM is a global service, and CloudTrail records its events
in us-east-1, while the checks read only eu-west-1. [`cloudtrail.sh`](../../infra/sandbox/probe/cloudtrail.sh) now
reads both regions.

Every earlier check was run again with the fix: Phase 5 steps 5.1 to 5.10, the two Phase 6 updates, and 7.1 and 7.2.
Every result is unchanged. In particular, the IAM imports 5.5 (roles) and 5.6 (inline policies) made no IAM write.

## Final verification (2026-10-08, 20:05Z)

| Check | Result |
|---|---|
| **AC auth** (`verify-ac-auth.sh`) | 13/13 PASS, including: no cookie → 401; S4R-pool cookie with an `admin` group → signed out and 401; AC admin → 200; AC non-admin → 401; wrong password → 401; Settings read; read through the MCP Function URL; batch-run refusals |
| **AC-only endpoints** (`verify-ac-endpoints.sh`) | 8/8 PASS: `/health` open with no secret in it; no bearer or a wrong one → 401 on the orchestrator and the MCP. URLs: auth `NONE`, CORS only on `whichpart-api` (in code, AC origins). `PublicInvoke` limited to Function URL invocations on all three AC functions |
| **Customer `/api`** | Smoke equal to the pre-Phase-5 baseline (4 × 200). Real Chromium on the live site: page loads, `/api/auth/me` 200, chat `POST /api` 200, no console errors. Header matrix as in 7.12 |
| **Rate limiting** | Enforced. Since then the only refusals are this verification's own (2, sign-in). No customer was refused |
| **#21** | No `composeFailed` turn since 7.6. The transcript-review judge (Jev) has rated the post-7.6 session it has reviewed so far `good` |
| **Canonical sessions** | Tokens signed with the old and the new secret both continue (live probe after 7.10b2 and 7.13c) |
| **Logs after the managed-policy detach** | Each AC function created a new log stream after 7.13b and wrote to it |
| **Drift** | `AcDataStack`, `AcRuntimeStack` and `AcAuthStack`: `IN_SYNC` |
| **Code** | `whichpart-api` live CodeSha256 equals `build/reference/whichpart-api.zip.json` |
| **S4R role and API `65vnizdmk4`** | Identical to the Phase 5 final state (`s4r-boundary.sh`) |
| **Diagnosis Lambda** | Configuration, code, URL, resource policy and role identical to the Phase 5 final state |
| **S4R Cognito pool and client** | Last modified 2026-07-20 / 2026-07-21: unchanged |
| **`SparesSite-dev`, `CDKToolkit`** | Last updated 2026-07-21 / created 2026-07-20: unchanged |
| **S4R health, `/part-finder`, `/ai/chat`** | 3 × 200, contract ok, ingress ok (after every change, and at the end) |
| **Secret and PII scan** | gitleaks over all 40 Phase 7 commits: no leaks. The only emails are `example.test`/`example.invalid` placeholders; the only addresses are RFC 5737 documentation ranges and test fixtures |
| **Owner** | The AC admin is still `FORCE_CHANGE_PASSWORD`: set your password (below) |

## Changes that need the owner's approval

**Not executed.** Every item is POTENTIALLY IMPACTS S4R or needs the owner's own credentials.

| # | Change | Why it needs approval | Prepared in |
|---|---|---|---|
| A1 | Diagnosis Lambda `PublicInvoke`: add `lambda:InvokedViaFunctionUrl` (as 7.9 did for the AC functions) | Its resource policy serves `/part-finder` | 7.9 tooling (one override line); run with the `/part-finder` contract before and after |
| A2 | Reserved concurrency for the diagnosis Lambda and the AC functions | Needs the account quota raised first. Reserving on the diagnosis Lambda changes S4R behaviour under load | *Reserved concurrency* above |
| B | Move the diagnosis Lambda off the S4R role onto `ac-diagnosis-role`. **7.Da** creates the role and is safe on its own. **7.Db** switches the function's `Role` | Changes the S4R-facing Lambda's permissions. Rollback must be the owner's own `update-function-configuration`, because `ac-deny-s4r` stops CloudFormation passing the S4R role | [Diagnosis-role package](phase-7-package-diagnosis-role.md) |
| C1 | Remove the diagnosis Lambda's `apigateway-invoke` permission, which closes unauthenticated `POST /ai/chat` | S4R API path. In its whole history it has had no real use, only this migration's probes | [`/ai/chat` package](phase-7-package-ai-chat.md) |
| C2 | Delete the route `POST /ai/chat` and its integration on API `65vnizdmk4` | Edits the S4R API | Same package (proposal for the S4R owner) |
| D | Move the OpenAI, Jev and AI-config secrets to `applianceclinic/production/`, and rotate the provider credentials | The diagnosis Lambda reads them (after B, from the AC role). New provider keys come from the owner | 7.10, *Packaged, not done* |

## For the owner

- **Set your admin password.** Use the temporary password Cognito emailed you, on
  `https://applianceclinic-admin.auth.eu-west-1.amazoncognito.com/login?client_id=2hgmm8m02n78agi46kae4p2eja&response_type=code&scope=openid+email&redirect_uri=https%3A%2F%2Fapplianceclinic.ai%2F`.
  Then sign in on the AC site as before.
- **GOLD v2 evaluation of #21.**
  - Run the GOLD v2 suite with your judge credentials, from the worker machine that holds them, against the AC site.
  - Then compare it with your last GOLD v2 run.
  - The runner and judge are in `services/whichpart-api/benchmark/gold-v2/`. The live transport `run-baseline.mjs`
    lives outside this repository.
- **Batch worker.**
  - Update the external batch worker to this repository's `routing-override.js`.
  - Send `target`, `confirmProduction` and `confirmProductionRouting` when you mean production.
  - Better still, give the worker its own role, without write access to the live AI-config secret. Today it uses your
    IAM user.
- **Retire the unused AC secrets** when convenient: `spares4repairs/diag-orchestrator/bearer-token` and
  `spares4repairs/error-code-mcp/bearer-token`. The old canonical secret can follow after 2026-11-08, when the last
  token it signed has expired.
- **Lambda concurrency quota.** Request a Service Quotas increase of "Concurrent executions" (currently 10). Reserved
  concurrency for AC functions, and isolation from S4R, depend on it.
