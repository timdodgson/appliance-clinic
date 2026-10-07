# Phase 5: production CDK import

**Classification:** steps 5.1 to 5.9 are SAFE AC CHANGE; step 5.10 (the diagnosis Lambda) is POTENTIALLY IMPACTS S4R.
Every import transfers CloudFormation ownership only: no resource is created, changed, replaced or deleted.

Plan: [PLAN.md, Phase 5](../PLAN.md#phase-5-production-cdk-import). Rehearsal: [Phase 4 results](../phase-4-results.md).
Ownership: [ownership.md](../ownership.md). Results: [phase-5-results.md](../phase-5-results.md).

## Prerequisites

- The pre-production gates of PLAN.md (*Before any production AWS action*), checked the same day:
  - the S4R denylist regenerated (`npm run denylist`), unchanged or reviewed
  - the freeze (#2) in place, the routing override lease `released`
  - backups less than 24 hours old: PITR on both tables (continuous) and the Phase 0 on-demand backups and S3 copies
  - S4R health, the `/part-finder` contract (with the CORS preflight from `https://spares4repairs.co.uk`), the
    `/ai/chat` ingress and the smoke baseline captured within the last hour (`npm run baseline -- …`, see
    [phase-0-baseline.md](phase-0-baseline.md))
- A pre-Phase-5 inventory (`npm run inventory`), kept as the comparison point for every step.
- Run as the IAM user, with credentials from the environment. Every resource operation goes through CloudFormation
  with the `acclinic` execution role.

## The toolkit (Phase 5 entry)

[`infra/production/steps/00-toolkit.sh`](../../../infra/production/steps/00-toolkit.sh) creates
`ApplianceClinicToolkit` (qualifier `acclinic`) from the documents in [`phase-5/toolkit/`](../phase-5/toolkit/):

| Document | What it is |
|---|---|
| `ac-cfn-execution.json` | The execution role's only allow. **Read-only**, on the AC production resources of the import set. Imports and drift detection only read, so no CloudFormation operation in Phase 5 can change a production resource: one that tried would be refused and roll back. No `GetSecretValue`, and no S3 object reads. Write access is a separate, reviewed change before Phase 6 |
| `ac-deny-s4r.json` | Explicit denies: every S4R identifier on the generated denylist (exact names, never a prefix an AC resource shares: AC secrets and functions also start with `spares4repairs`), the `SparesSite-*` stacks, `CDKToolkit`, API `65vnizdmk4`, the S4R pool and role, services AC never uses, other regions. Attached to the execution role and every toolkit role |
| `bootstrap-acclinic.json` | The stock CDK v32 bootstrap template, patched as in Phase 4: qualifier fixed, the two policies as the execution policies, the deploy role's CloudFormation rights limited to `AcDataStack`, `AcRuntimeStack` and the toolkit, Retain everywhere. Not `cdk bootstrap`, whose stock deploy role may change any stack |

The script checks the documents are current, creates the policies (or confirms the live ones match), creates the stack as
a change set of Add actions only, turns on termination protection, and asks the IAM simulator that the execution role is
denied S4R writes and AC writes and allowed AC reads.

## Each import step

[`infra/production/lib.sh`](../../../infra/production/lib.sh); one script and one step file per step under
[`infra/production/steps/`](../../../infra/production/steps/).

1. **Read live.** Describe every resource of the step. The template is written from the live configuration, field by
   field, never from documentation (Phase 4 finding 16).
2. **Prove ownership.** Every resource is `AC` or `AC (S4R-consumed)` in ownership.md, on no S4R denylist entry, and
   in no CloudFormation stack.
3. **Shell.** If the stack does not exist, create it holding only its `StackShell` handle, with the execution role
   and termination protection, and no stack tags (Phase 4 finding 14).
4. **Change set.** An IMPORT change set with the template and the resources to import.
5. **Check.** `check:changeset --mode import` with the step file: every action `Import`, every physical ID on the
   step's list, no S4R identifier except the step's acknowledged references (each with its reason), Retain everywhere,
   no literal secret. Then the actions are compared with the step file's `expectedChanges` exactly.
6. **Execute** only when both pass, and wait for `IMPORT_COMPLETE`.
7. **Drift.** Immediately. Every imported resource must be `IN_SYNC`. Anything else stops the step until the template
   is changed to match live; nothing live is changed to match the template.
8. **No-op.** An update with the same template must report no changes.
9. **Stack policy.** Deny `Update:Replace` and `Update:Delete` on every resource.
10. **Compare.** A fresh inventory against the pre-Phase-5 inventory: only CloudFormation ownership metadata may
    differ. Smoke tests, S4R health, and for the diagnosis Lambda the `/part-finder` contract and `/ai/chat` ingress.
11. **Record** the evidence on the step's issue and in phase-5-results.md; open the PR.

## Stop conditions

Stop the step, change nothing more, and report on its issue if:
- a change set holds anything but Import actions, a replacement, or a physical ID that is not the planned one
- drift is not `IN_SYNC` straight after an import, or CloudFormation proposes changing a live property
- a resource turns out to be S4R-owned or shared, or a stack name conflicts with S4R or the default toolkit
- a Function URL host, a CodeSha256 or image digest, the diagnosis role or its policies, or API `65vnizdmk4` would change
- production or S4R health changes
- a secret value would have to be read or exposed
