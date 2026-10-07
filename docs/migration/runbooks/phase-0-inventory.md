# Phase 0: inventory and ownership proof

**Classification:** READ-ONLY. Every AWS call goes through the tooling's read-only guard.

## Prerequisites

- The [freeze](phase-0-freeze.md) is in place.
- Node.js 20 or later, and `npm ci` run in `tools/migration`.
- AWS profile `ac-readonly` (see [conventions](README.md#aws-profiles)). For the optional secret
  digests, `ac-readonly-secrets`.
- A local clone of `spares4repairs`, used read-only.

## 1. Export the source to compare against (no AWS)

`git archive` reads the repository and writes nothing into it.

```bash
mkdir -p .migration-output/source-13b7a50
git -C <path-to-spares4repairs-clone> archive 13b7a50 | tar -x -C .migration-output/source-13b7a50
```

## 2. Run the inventory

```bash
cd tools/migration
AWS_PROFILE=ac-readonly npm run inventory -- --expect-account <account-id> --download-code --cloudtrail
```

Optional, with `AWS_PROFILE=ac-readonly-secrets`: add `--hash-secret-values` to record a SHA-256
digest, length and JSON key names for each AC secret, including the AI config. Values are never
written. The digests let later steps prove that a value did not change and that no template
contains a literal secret.

**Expected:** a directory `.migration-output/inventory-<timestamp>/` with one JSON file per area,
the deployed zips under `artifacts/`, and the deployed `index.html` and routing override file under
`captured-objects/`. The command prints any area errors and every ownership STOP flag.

**Verify:**
- `errors.json` is empty. An `AccessDenied` means the profile is missing a read permission. Fix the
  profile; do not widen it beyond read access.
- In `lambda-functions.json`, every zip function has `code.downloaded.matchesDeployed: true`.
- In `s3-buckets.json`, the web bucket's `capturedObjects["index.html"].originTrialTokens` holds
  the WebMCP token.
- In `ecr-repositories.json`, each container function's deployed digest appears under `deployedBy`.

## 3. Compare deployed code with the source

For each zip function:

```bash
npm run compare:source -- \
  --artifact ../../.migration-output/inventory-<ts>/artifacts/whichpart-api.zip \
  --source ../../.migration-output/source-13b7a50 \
  --out ../../.migration-output/inventory-<ts>/compare-whichpart-api.json
```

**Expected:** `equivalent: true`. Any file listed as "not in source" means production is not
running `13b7a50` for that file. Record it on the issue; Phase 2 must extract what production
actually runs.

## 4. Generate the S4R denylist

```bash
npm run denylist -- --inventory ../../.migration-output/inventory-<ts>
```

This rewrites `docs/migration/s4r-denylist.json`. Review the diff, then commit it in a pull request.

## 5. Record ownership evidence

For each resource in [`ownership.md`](../ownership.md), fill in the class and evidence from the
inventory:

- `ownership-flags.json`: any `stop` flag makes the resource `S4R` until a person resolves it.
- `lambda-all-functions.json`: confirm which functions use each execution role. A role shared with
  any non-AC function is `S4R`.
- `cloudformation-stacks.json`: a resource managed by any existing stack is `S4R`.
- `cloudtrail-creation-events.json`: creation evidence for resources created in the last 90 days.
  Events are looked up in eu-west-1 and us-east-1 (IAM and CloudFront record events there). Check
  `coverage` for any event name marked `truncated`.
- `apigateway-permissions.json`: for every API Gateway invoke permission on an AC function, whether
  the API actually integrates the function (`invokes`, `configured-not-deployed`,
  `no-integration-found` or `api-not-found`). Until a permission has been reviewed, it stays an
  ownership STOP flag and is treated as S4R-sensitive.

Record the conclusions in [`phase-0-findings.md`](../phase-0-findings.md).
- `external-dependencies.json`: record the outbound hosts in the dependency section.

Commit the updated `ownership.md` in a pull request for review.

## 6. Optional: CloudFormation IaC generator scan

The IaC generator (CloudFormation console, *IaC generator*) scans the account and can produce
templates for existing resources. A scan creates a scan record in CloudFormation but changes no
resources. Use it as a cross-check for resources the deploy scripts do not show, such as the
diagnosis Lambda's console-created role. Do not create a stack or template from it.
