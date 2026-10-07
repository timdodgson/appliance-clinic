# Phase 0 findings and production baseline

What the read-only Phase 0 inventory (#3) found in production, and how it changes the plan. The raw
inventory stays local in `.migration-output/` and is never committed. This page records the
conclusions.

- **Inventory run:** 2026-10-07, account `800960611664`, eu-west-1 (CloudFormation also checked in
  us-east-1). No area errors.
- **Verification:**
  - Both zip functions' downloaded code matches their deployed CodeSha256.
  - The WebMCP token was captured.
  - Both container functions' deployed image digests were recorded.

## Production baseline

| Area | Baseline |
|---|---|
| Lambda functions | Four: `spares4repairs-part-finder` (diagnosis), `whichpart-api`, `spares4repairs-diag-orchestrator`, `spares4repairs-error-code-mcp`. All serve `$LATEST`, with no aliases, no published versions, no VPC and no reserved concurrency |
| Function URLs | All auth `NONE`, unqualified. The diagnosis URL uses `RESPONSE_STREAM` (CORS `*`, POST, `content-type`, max-age 86400); the others use `BUFFERED` |
| Canonical engine | Live in **control** mode on `whichpart-api` (`CANONICAL_MODE=control`), with **64 journeys** in `CANONICAL_CONTROL_JOURNEYS` across washing machines, dishwashers, fridge-freezers, tumble dryers, ovens, cookers, hobs, microwaves, vacuums and washer-dryers |
| DynamoDB | `whichpart-transcripts` about 29,500 items (TTL on); `whichpart-recalls` about 1,050 items. **PITR off on both**, no on-demand backups, on-demand billing |
| S3 | Web bucket: 172 objects, OAC-only policy. Learning bucket: about 36,200 objects, no policy. Neither has versioning or lifecycle rules |
| Routing override | **Inactive**: lease `released`, last restore verified 2026-10-05 |
| WebMCP token | **Captured** from the deployed `index.html` (for `https://applianceclinic.ai:443`, subdomains, expires 2027-03-30) |
| ECR | Both repositories have mutable tags, scan on push and no lifecycle policy. The deployed `v1` digests are recorded |
| EventBridge | Daily recall ingest and 15-minute transcript review, both enabled, both targeting `whichpart-api` |
| CloudFront | `E1QD02IAJZPJLM` serves `applianceclinic.ai`, `www.applianceclinic.ai`, `whichpart.co.uk` and `www.whichpart.co.uk`. Origins: the web bucket (OAC) and `whichpart-api` for `/api*`. Redirect function `whichpart-www-redirect`, used by no other distribution |
| CloudFormation | `SparesSite-dev` (UPDATE_COMPLETE, 55 resources) and the default `CDKToolkit` (CREATE_COMPLETE). No AC candidate resource is in either |

## Differences from the plan

### 1. The diagnosis Lambda runs under the S4R server role

**Finding.** `spares4repairs-part-finder` runs under `SparesSite-dev-ServerFunctionRole…`. That role:
- is managed by the `SparesSite-dev` stack
- is shared with the S4R server Lambda `spares4repairs-server-dev`
- carries three AC permissions added by hand: `WhichpartLearningPut`, `whichpart-knowledge-overlay-s3`
  and `whichpart-media-overlay-s3`

The plan assumed a separate, console-created role.

**Effect.**
- The role is S4R-owned and is never imported or changed.
- The diagnosis function is imported referencing it unchanged.
- Moving to a dedicated AC role is a Phase 7, POTENTIALLY IMPACTS S4R change.

See [ADR 0011](../adr/0011-diagnosis-lambda-keeps-the-s4r-execution-role.md) and `PLAN.md`, step 5.10.

### 2. API Gateway permission on the diagnosis Lambda

**Finding.** The diagnosis Lambda's resource policy contains `apigateway-invoke`, which lets API
`65vnizdmk4`, the S4R catalogue API, invoke it. No AC deploy script creates this statement.

**Status: unresolved, S4R-sensitive.** The inventory now checks this read-only (`apigateway-permissions`):
- whether any integration in the API's current configuration targets the function
- whether any integration in each deployed stage does (via `GetExport`)

It concludes `invokes`, `configured-not-deployed`, `no-integration-found` or `api-not-found`.

Until that check has run and been reviewed:
- The permission is a possible second S4R consumer of the diagnosis Lambda.
- It is not imported, changed or removed.
- It stays an ownership STOP flag.

Removing it later is POTENTIALLY IMPACTS S4R, and only if the check shows it is stale.

### 3. The CloudFront distribution also serves `whichpart.co.uk`

**Finding.** Besides `applianceclinic.ai` and `www.applianceclinic.ai`, the distribution has the
aliases `whichpart.co.uk` and `www.whichpart.co.uk`.

**Effect.** None for now. CloudFront stays unmanaged in the initial migration
([ADR 0008](../adr/0008-cloudfront-initially-unmanaged.md)), and its aliases, certificate and DNS are
not changed. The replacement site deployment uploads to the bucket only, so it does not affect them.

### 4. Policy placement differs from `ownership.md`

**Finding.**
- Two of the eleven inline policies the plan expected on AC roles, `whichpart-knowledge-overlay-s3`
  and `whichpart-media-overlay-s3`, are on the S4R role. A third, `WhichpartLearningPut`, is there too.
- `whichpart-api-role` carries 8 inline policies and `error-code-mcp-role` carries 1.

**Effect.** Recorded in `ownership.md`. Step 5.6 imports only the policies on AC roles.

### Matches the plan

- **Lambdas:** no VPC, no aliases, everything on `$LATEST`.
- **Function URLs:** all auth `NONE`, as the scripts create them.
- **Tables and buckets:**
  - PITR is off on both tables. Phase 0 backups enable it, and CDK must then declare it.
  - Neither bucket has lifecycle rules or versioning.
  - The web bucket policy is OAC-only.
- **Rules and functions:** the EventBridge targets match the scripts, and the CloudFront function is
  not shared.

## Known risks recorded

- **S4R deployments and the diagnosis Lambda.** A deployment of `SparesSite-dev` updates the shared
  role. If CloudFormation removes inline policies it does not manage, the diagnosis Lambda loses
  access to the learning bucket. That would affect both Appliance Clinic and the S4R `/part-finder`
  page. Sandbox experiment T1 answers whether this happens. The risk existed before this migration.
- **Shared write access.** Because the role is shared, the S4R server Lambda also has the three AC
  permissions, including writing to the AC learning bucket.

## Inventory tooling corrections

The first run surfaced three reporting issues:
- **Function URL `AuthType` was redacted.** The name matched the secret-name rule. Fixed: Function URL
  configuration is recorded as returned.
- **CloudTrail lookup covered eu-west-1 only.** IAM and CloudFront record their events in us-east-1,
  so role and distribution creation events were missing. Fixed: both regions are searched, with a
  truncation flag per event name.
- **Stack status appeared as `null`.** This was a misread of the output, not a tooling fault. A test
  now pins status capture.
