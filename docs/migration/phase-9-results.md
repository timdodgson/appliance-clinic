# Phase 9 results

Phase 9 makes the public repository portfolio-ready: clear documentation and a clean tree, with the migration history
kept intact. It is not an architecture phase.

The one production change was a reviewed CDK change set:
- tool: [`change.sh`](../../infra/production/steps/change.sh)
- spec: [`9.1-legacy-bearer-secrets.json`](../../infra/production/changes/9.1-legacy-bearer-secrets.json)
- run as the IAM user in account `800960611664`, eu-west-1.

## 9.1: legacy bearer secrets removed (2026-10-10)

The secrets `spares4repairs/diag-orchestrator/bearer-token` and `spares4repairs/error-code-mcp/bearer-token` were superseded in 7.10c. That change moved every consumer onto `applianceclinic/production/{orchestrator,mcp}-bearer`; 8.10 then rotated those again.

**Proof before removal**

| Check | Result |
|---|---|
| Lambda environments | none of the 6 functions in the account and region references either secret |
| CDK and runtime code | no reader. The only references were the four retired pre-CDK `deploy.sh` scripts (defaults only, never run since Phase 5). They now refuse to run and default to the AC names |
| Current configuration | the bearer references in `runtime-overrides.json` name only the AC secrets, version-pinned |
| CloudTrail, 30 days of `GetSecretValue` | the owner IAM user only (operator tooling). No service principal, and no read after 2026-10-05 except migration checks |
| Old values | refused (401) by the orchestrator and the MCP, in every combination |

**The change**

1. **Template removal (9.1).** AcDataStack removed the two resources.
   - Their `DeletionPolicy` is Retain, so CloudFormation made no Secrets Manager call.
   - `change.sh` gained approved removals. The stack policy allows `Update:Delete` for that execution only, scoped to the removed resource type.
   - CloudFormation validates a stack policy against the *new* template, so a policy naming the removed logical IDs fails validation. The first attempt failed that way before anything executed.
   - Drift IN_SYNC; no-op confirmed.
2. **Deletion.** With no stack managing them, both secrets were scheduled for deletion with the 7-day recovery window (`DeletionDate` 2026-10-17). They are restorable until then.
   - The read-only base execution policy and its toolkit document no longer name them.
   - The production denylist keeps them, marked `retired`, so the sandbox tooling still refuses them.

No other secret changed; the unrelated `spares4repairs/*` secrets are untouched.

**After the change**

| Check | Result |
|---|---|
| whichpart-api → orchestrator | customer smoke equal to the baseline, 4×200 |
| whichpart-api → MCP | admin error-code catalogue 200, within AC auth 13/13 |
| orchestrator → MCP | error-code turn RESOLVED; MCP `POST /mcp` 200 |
| Bearers | old 401, current accepted (orchestrator and MCP) |
| AC endpoints | 8/8 |
| Diagnosis role | 9/9 |
| `/part-finder` contract | ok |
| S4R health | 3×200 |
| GOLD-v2.2 full run | 49/49 (a third consecutive 49/49 after Phase 8) |
| Drift | AcDataStack IN_SYNC |
| CloudTrail (`check-cloudtrail.sh change:9.1-legacy-bearer-secrets`) | ok, no failures. The change made no writes; the deletion in step 2 was the operator's `DeleteSecret` with the recovery window |
