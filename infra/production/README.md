# Production scripts

Owner tooling for the live AWS account. Every script checks the caller, account and region before acting (`lib.sh`, `require_caller`), and writes its raw output to the gitignored `.migration-output/`. **Do not run any of these casually.** Read [CONTRIBUTING.md](../../CONTRIBUTING.md#production-changes) first.

## In current use

| Script | Classification | Purpose |
|---|---|---|
| [`steps/change.sh`](steps/change.sh) | Executes only with `EXECUTE=1` | The one way to change production since Phase 7: a reviewed CDK change set from a spec in [`changes/`](changes/) |
| [`check-cloudtrail.sh`](check-cloudtrail.sh) | READ-ONLY | After a change: every write the execution role made must be one the spec expects |
| [`verify-ac-endpoints.sh`](verify-ac-endpoints.sh) | READ-ONLY | Contract checks for the orchestrator, the MCP and the `whichpart-api` URL settings |
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
