# Production scripts

Owner tooling for the live AWS account. Every script checks the caller, account and region before acting (`lib.sh`, `require_caller`), and writes its raw output to the gitignored `.migration-output/`. **Do not run any of these casually.** Read [CONTRIBUTING.md](../../CONTRIBUTING.md#production-changes) first.

## In current use

| Script | Classification | Purpose |
|---|---|---|
| [`steps/change.sh`](steps/change.sh) | Executes only with `EXECUTE=1` | The one way to change production since Phase 7: a reviewed CDK change set from a spec in [`changes/`](changes/) |
| [`check-cloudtrail.sh`](check-cloudtrail.sh) | READ-ONLY | After a change: every write the execution role made must be one the spec expects |
| [`verify-ac-endpoints.sh`](verify-ac-endpoints.sh) | READ-ONLY | Contract checks for the MCP and the `whichpart-api` URL settings |
| [`verify-ac-auth.sh`](verify-ac-auth.sh) | SAFE AC CHANGE: creates two temporary users in the AC pool and deletes them at exit | AC sign-in and admin authority, end to end |
| [`capture-runtime.sh`](capture-runtime.sh), [`token-params.mjs`](token-params.mjs) | READ-ONLY | Inputs `change.sh` synthesises `AcRuntimeStack` from |

Each change spec in [`changes/`](changes/) is the reviewed record of one production change: what it may change, the temporary grant and the writes CloudTrail may show. The results are in the phase results documents under [`docs/migration/`](../../docs/migration/PLAN.md).

## Historical (kept as the record of how a step was done)

| Script | Phase | What it did |
|---|---|---|
| [`steps/00-toolkit.sh`](steps/00-toolkit.sh) | 5 | Created the dedicated CDK toolkit `ApplianceClinicToolkit` |
| [`steps/import.sh`](steps/import.sh), `steps/5.*.json`, [`snapshot.sh`](snapshot.sh), [`compare.sh`](compare.sh), [`make-runtime-steps.mjs`](make-runtime-steps.mjs) | 5 | The production CDK import, step by step. `steps/5.10.json` is still read by `change.sh` for the acknowledged S4R references (the S4R Shop product link) |
| [`steps/phase-6-proof.sh`](steps/phase-6-proof.sh), [`phase-6-checks.sh`](phase-6-checks.sh) | 6 | The CDK ownership proof |
| [`s4r-boundary.sh`](s4r-boundary.sh) | 5, 6 | Read-only snapshot of the S4R role and API 65vnizdmk4, the before/after proof that AC changed nothing there |
| [`steps/d-copy-secrets.sh`](steps/d-copy-secrets.sh) | 7 | Copied secret values server-side into the AC namespace |

AC runs no S4R gate (ADR 0019): the former shared engine `spares4repairs-part-finder` was released from AC in change 15.3, and its `/part-finder` contract, `/ai/chat` ingress, S4R health and smoke-baseline checks were removed. The only S4R dependency is outbound: the S4R Parts Catalogue API and S4R Shop product links.

## Operational risks

Known risks in production, each waiting on an owner decision. Background: [project story, still open](../../docs/portfolio/project-story.md#still-open).

**How to check.** The four engine alarms are `applianceclinic-diagnosis-engine-FailedTurns` (5 or more failed turns in 5 minutes), `-RefusedRequests` (any unsigned or wrongly signed request), `-Errors` and `-Throttles`. Failed turns are in the log group `/aws/lambda/applianceclinic-diagnosis-engine`; in Logs Insights:

```
fields @timestamp, requestId, errorCode, error
| filter @message like '"evt":"diagnosis-engine"' and @message like '"ok":false'
| sort @timestamp desc
```

This is the same match as the `FailedTurns` metric filter. An advisor failure carries the provider error's category (`CONFIG`, `TIMEOUT`, `NETWORK`) and HTTP status in `error`.

| Risk | What it looks like | Immediate action | Permanent fix (owner approval) |
|---|---|---|---|
| **Account Lambda concurrency quota is 10**, shared with another site | HTTP 429 from the engine; `-Throttles` in ALARM. The orchestrator retries a 429 once, so a short throttle costs nothing: on 2026-10-12 in the 08:20–08:25 UTC period, during GOLD, one throttle was absorbed and no turn failed. A longer one gives failed turns | Confirm the 429s line up with load (GOLD, or the other site); pause GOLD or any test traffic | An account-level quota increase (100 recommended; [analysis](../../docs/evaluation/phase-11-concurrency.md)) |
| **The engine alarms notify nobody** | An alarm sits in ALARM and nobody is told | Check the four alarms by hand after every release and every GOLD run | An AC-owned SNS topic, set as each alarm's action, with a subscription; the recipient is the owner's decision |
| **The advisor's provider fails, with no alert** (credential rejected, quota or spend limit, outage) | HTTP 401, 429 or 5xx from the Anthropic API. Every turn gets the explicit "temporarily unavailable" error (`503 reasoner_unavailable` from the engine); `-FailedTurns` goes to ALARM. The same shape took production down on 2026-10-11 when the previous provider's credit ran out ([finding](../../docs/evaluation/phase-13-results.md#operational-finding-jev-credit-exhaustion-took-production-down)) | Check the credential and spend in Admin → Settings (the connection check is read-only); replace the key or raise the limit, then run one Live Test | Alerting on the provider error rate and on spend |
| **Evaluation and production share one model credential** | A scripted run spends the same budget production uses (about $1 a full run) | Run the scripted chats only after a release that changes the advisor | A separate key or budget for evaluation |
| **The old shared engine runs in AC's account** on `ac-diagnosis-role` and AC secrets, for its external consumer | Its load counts against the concurrency quota; changing that role or those secrets would affect it | None: leave it unchanged ([ADR 0019](../../docs/adr/0019-dedicated-canonical-diagnosis-engine.md)) | Moving it is its consumer's change, not AC's |
