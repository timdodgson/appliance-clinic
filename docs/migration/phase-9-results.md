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

## 9.2: documentation for an outside reader (PR #79)

| Item | Change |
|---|---|
| `README.md` | Rewritten. Covers what the service is, why it is built this way (a deterministic vs probabilistic table), Jev, retrieval, safety, evaluation, AWS/CDK, the migration in brief, verified local commands and a documentation map |
| [Architecture overview](../architecture/overview.md) | Stays the one current-state document. Gains a diagram (AC customer path, frozen S4R `/part-finder` path, model boundaries) and a table of where models are and are not used. Stale facts corrected: the site source lives outside this repository; the legacy secrets are deleted; the GOLD row points to the final gate |
| [Project story](../portfolio/project-story.md) | New: phase-by-phase decisions, trade-offs and evidence, and what is still open |
| [`SECURITY.md`](../../SECURITY.md), [`CONTRIBUTING.md`](../../CONTRIBUTING.md) | New. Only existing mechanisms are named: no invented contact address |
| Developer experience | `npm run setup:python`, `test:tooling`, `lint` and `build:zips`. CI creates its Python environments with the same script. With them the runtime suite runs fully green locally (172/187, the 15 known failures, exit 0) |

Historical documents were not rewritten. The Phase 8 findings stay the record of that review; results documents keep the facts as they were at the time.

## 9.3: repository hygiene (PRs #79 and #80)

| Check | Result |
|---|---|
| gitleaks 8.21.2, default rules, current tree | 638 findings before triage, all false positives: content-hash keys in generated error-code enrichment data; the Python base image's public GPG key fingerprint; three deliberately fake test-only secrets. Allowlisted with reasons in [`.gitleaks.toml`](../../.gitleaks.toml); after that, **no leaks** |
| gitleaks over the full history (every commit with changes, all refs) | **No leaks** with the same configuration |
| Exact-value scan of every bearer value (current, retired, legacy) | Absent from every git object, all 76 issues and PRs with comments, GOLD results and release logs (Phase 8 close) |
| PII patterns (emails, UK phone numbers and postcodes, card numbers) over all added lines in history | Only example or test emails. Every phone-like match is a fragment of a SHA-256 hash. No postcodes or card numbers. Commit metadata carries the owner's own address, which is normal for git |
| Customer data | None tracked. Captured production output lives only in the gitignored `.migration-output/`. The GOLD scenarios are synthetic |
| Media | No media binaries tracked. The knowledge base references third-party how-to videos by link, with attribution |
| Temporary or handover files | None tracked; nothing removed. Every file under `infra/production/` and `docs/migration/` is evidence or tooling still in use |
| Links | 62 Markdown files: 0 broken relative links or anchors (one broken anchor fixed) |
| Indexes | Runbook index completed (Phases 6 to 8). `PLAN.md` links each phase's record. `infra/production/README.md` separates current tools from historical steps. The tooling README is current |

## Owner decisions and settings (not blocking)

| Item | State | Recommendation |
|---|---|---|
| **Licence** | No licence file. The README says so | The owner chooses one, or keeps all rights reserved. Not chosen here |
| Private vulnerability reporting | Off | Enable it (*Settings → Code security → Private vulnerability reporting*). `SECURITY.md` already points to it when offered |
| Main-branch ruleset | Not applied; `main` unprotected (enforced by process) | Import [`.github/rulesets/protect-main.json`](../../.github/rulesets/protect-main.json), which now requires all five CI checks |
| Repository description | Empty | `Production AI-assisted appliance diagnosis on AWS Lambda: deterministic policy around LLMs, AWS CDK, GOLD evaluation, and the full record of its migration out of a monorepo.` |
| Topics | None | `aws-lambda`, `aws-cdk`, `cloudformation`, `llm`, `ai-safety`, `llm-evaluation`, `model-context-protocol`, `python`, `nodejs`, `typescript` |
| Commit email | Commits use the owner's personal address | Optional: GitHub's noreply address for future commits. History is not rewritten |

## Final verification (2026-10-10, 10:25Z)

| Check | Result |
|---|---|
| Drift | AcAuthStack, AcDataStack, AcRuntimeStack, ApplianceClinicToolkit: IN_SYNC, 0 drifted resources |
| S4R role and API `65vnizdmk4` | Identical to the 7.15a capture |
| S4R Cognito, SparesSite-dev, CDKToolkit | Unchanged (last modified July 2026) |
| `/part-finder` contract | ok |
| S4R health | 3×200 |
| Customer smoke | Equal to the baseline, 4×200 |
| AC endpoints | 8/8 |
| AC auth | 13/13 |
| Bearers | 5/5 (old refused, current accepted) |
| CI | Green on every Phase 9 PR (runtime-tests, typecheck, lambda-zips, images, migration-tooling) |

## Portfolio review

**Hiring manager: understand the project in 5 minutes?** Yes. The README answers what, why, how it's checked and where to look, in one page, with a diagram.

**Principal engineer: architecture in 15 minutes?** Yes. The overview diagram separates the AC path, the frozen S4R path and the model boundaries. The model table shows every decision step is code. ADR 0010 gives the reasoning, and the project story gives the trade-offs.

**Senior backend or cloud engineer: production discipline?** Yes, with evidence rather than claims:
- every production change is a spec plus a checked change set with a temporary grant, then drift, no-op and CloudTrail checks, with the results recorded;
- builds are reproducible against deployed references;
- the S4R contract is checked before and after each release.

**Testing and evaluation quality.** A runtime suite against a recorded baseline, strict contract types, and a semantic benchmark with a documented audit of its own validity. The tests were never weakened to pass.

**Security awareness.**
- dedicated auth and secrets;
- least-privilege IAM;
- tokens rotated after exposure, with a documented subtlety;
- dead secrets removed;
- public `SECURITY.md`;
- clean scans.

**AI engineering beyond prompts.** Typed classification, a deterministic merge, diagnostics and policy, checked composition with template fallback, and a versioned prompt registry. Product fixes were made in the deterministic layer.

**Embarrassing or unsafe?** Nothing found. The open items are stated plainly in the project story:
- unauthenticated orchestrator-only fields on the engine URL;
- the site still published from the monorepo;
- the orchestrator's size.

Non-secret identifiers (account ID, resource names) appear in the migration record by design ([governance](../repository/governance.md#public-repository)).

## Exit criteria

| Criterion | Status |
|---|---|
| Dead AC legacy secrets removed safely | **Done** (9.1). Permanent deletion on 2026-10-17 |
| README strong | **Done** |
| Current architecture clear | **Done** |
| Portfolio story | **Done** |
| `SECURITY.md` appropriate | **Done** |
| `CONTRIBUTING.md` practical | **Done** |
| Secret and PII scan clean | **Done**: tree and full history |
| Public history checked | **Done** |
| Broken and stale docs fixed | **Done** |
| CI green | **Done** |
| Production healthy, S4R unchanged | **Done** |
| Licence | **Owner decision**, recorded above |
