# Phase 7: security hardening

**Classification:** the SAFE AC CHANGE actions of [PLAN.md, Phase 7](../PLAN.md#phase-7-security-hardening). The
POTENTIALLY IMPACTS S4R actions are prepared, not executed (see [phase-7-results.md](../phase-7-results.md), packages).

Results: [phase-7-results.md](../phase-7-results.md).

## How every production change is made

Every change is a reviewed CDK change set, applied by
[`infra/production/steps/change.sh`](../../../infra/production/steps/change.sh) from a committed spec in
[`infra/production/changes/`](../../../infra/production/changes/). Run as the IAM user, from the repository root.

1. **The change.**
   - **Runtime (`AcRuntimeStack`):** an edit of
     [`infra/cdk/config/runtime-overrides.json`](../../../infra/cdk/config/runtime-overrides.json). The template is the
     live capture with these overrides applied (`applyOverrides` in `infra/cdk/lib/runtime-stack.js`). An override is the
     desired state, so it holds after deployment.
   - **Code:** built from this repository (`build/scripts/package_zips.py`), compared with the production reference
     (`build/scripts/compare_zip.py`: only the intended files may differ), and staged in the AC assets bucket under
     `phase7/<function>-<CodeSha256>.zip`.
   - **Other stacks:** their CDK code (`AcAuthStack`: `infra/cdk/lib/auth-stack.js`).
2. **The spec** names, for the change:
   - every expected change: action, logical ID, type, physical ID, replacement, and the property details it may touch
   - the writes the execution role gets for this change only
   - the writes CloudTrail may show, the resources they may land on, and resources they must never touch
3. **Dry run.** `bash infra/production/steps/change.sh <spec>`. The script:
   - synthesizes the stack
   - requires the template to equal the deployed one for every resource the spec does not name
   - creates the change set, checks it in update mode, and requires it to equal the spec and stay within the allowed
     details

   Nothing is executed.
4. **Before.** S4R health, the smoke baseline, the `/part-finder` contract and the `/ai/chat` ingress
   (`tools/migration`: `npm run baseline -- …`, with `NODE_USE_ENV_PROXY=1` behind a proxy).
5. **Execute.** `EXECUTE=1 bash infra/production/steps/change.sh <spec>`.
   - `ac-cfn-execution` holds the read-only base plus the spec's grant during the execution only.
   - A spec that names a replacement (`"replacement": "True"`) gets a temporary stack policy for the execution only:
     `Update:Modify` everywhere, `Update:Replace` and `Update:Delete` on those logical IDs only. The checker accepts
     only replacements the spec names.
   - Lambda permissions changed this way carry `UpdateReplacePolicy: Delete` with a recorded reason, so the replaced
     statement is removed. Their logical IDs stay stable across the replacement.
   - Afterwards the script requires drift `IN_SYNC` and the same template to be a no-op, and sets termination
     protection and the stack policy.
6. **CloudTrail.** `bash infra/production/check-cloudtrail.sh change:<id>` waits for delivery, then requires:
   - every write is one the spec expects
   - every write lands on the spec's resources
   - no write names a forbidden resource
7. **After.** The checks of step 4 again, plus the change's own verification (for example
   [`verify-ac-auth.sh`](../../../infra/production/verify-ac-auth.sh)). For code, update
   `build/reference/<unit>.zip.json` to the deployed artefact.
8. **Record.**
   - the change's evidence in phase-7-results.md
   - [`runtime-changes.json`](../runtime-changes.json) for runtime files (`node tools/migration/bin/runtime-changes.mjs --write`)
   - the PR, merged with the expected head SHA

## Stop conditions

Stop, change nothing more, and report on the Phase 7 issue if:
- a change set holds anything the spec does not name, a replacement it does not name, or a detail outside the allowed ones
- drift is not `IN_SYNC` after a change, or the same template is not a no-op
- CloudTrail shows a write the spec does not expect, a write outside its resources, or any write on an S4R resource
- S4R health, the `/part-finder` contract or the `/ai/chat` ingress changes
- a change would touch the diagnosis Lambda's URL, permissions, concurrency, role or request/response shape, the S4R
  role or its policies, API `65vnizdmk4`, the S4R Cognito pool or client, `SparesSite-dev`, `CDKToolkit`, S4R CloudFront,
  Route 53 or ACM

## AC authentication (ADR 0006)

- **Sign-in.** Users sign in through `whichpart-api` (`/api/auth/login`) against the AC pool `applianceclinic`
  (`AcAuthStack`). Admin authority is membership of the pool's `admin` group. Only tokens issued by the AC pool for the AC
  app client count as a session (`services/whichpart-api/ac-auth.js`).
- **Adding an admin.**

  ```
  aws cognito-idp admin-create-user --user-pool-id <pool> --username <email> --user-attributes Name=email,Value=<email> Name=email_verified,Value=true --desired-delivery-mediums EMAIL
  aws cognito-idp admin-add-user-to-group --user-pool-id <pool> --username <email> --group-name admin
  ```

  Cognito emails a temporary password. The new admin sets their own password on the AC sign-in page:
  `https://applianceclinic-admin.auth.eu-west-1.amazoncognito.com/login?client_id=<client>&response_type=code&scope=openid+email&redirect_uri=https%3A%2F%2Fapplianceclinic.ai%2F`.
  The same page offers "Forgot your password?". No password ever passes through an operator.
- **Removing an admin.** `admin-remove-user-from-group`, then `admin-user-global-sign-out`.
- **Verification.** `bash infra/production/verify-ac-auth.sh` uses two temporary users with random passwords held in
  memory, and deletes them at exit.

## AC-only endpoints

- **Authentication.** The orchestrator and the error-code MCP require their bearer on everything except `GET /health`.
  `/health` is deliberately open and returns no secret.
- **Exposure.** Function URLs have no CORS (server-to-server only). The public `InvokeFunction` statement is limited to
  Function URL invocations (`InvokedViaFunctionUrl`).
- **Checks.** `bash infra/production/verify-ac-endpoints.sh <out-dir>`, and `verify-ac-auth.sh` (includes a read through
  the MCP URL).

## Secrets

- **The AC namespace** is `applianceclinic/production/` (`AcDataStack`). New secrets are created with
  `GenerateSecretString`, so no value is ever handled by an operator.
- **Canonical session tokens** are signed with `applianceclinic/production/canonical-state-token`. Moving the signing
  secret again:
  1. Create the new secret.
  2. Grant `GetSecretValue` on it.
  3. Set `CANONICAL_TOKEN_SECRET_ID` to the new secret and `CANONICAL_TOKEN_PREVIOUS_SECRET_ID` to the old one.
  4. Keep the old secret readable for 30 days, the token lifetime.
- **Service bearers** are read through `{{resolve:secretsmanager:applianceclinic/production/<name>:SecretString:token}}`.
  To rotate one:
  1. Put a new value (`aws secretsmanager put-secret-value` with a generated value, never typed or printed).
  2. Re-deploy every consumer in one change. The reference does not change, so pin the reference to the new
     `VersionId`, or make another change to the environment, to force the update.
  3. Expect a mismatch window of seconds.

## Roles the stack creates (finding from 7.15a)

An inline policy names its role by a literal `RoleName`, so CloudFormation sees no ordering between a new role and its
policies. It created them in parallel, the policies failed ("role cannot be found"), and the change rolled back with
nothing created. The generator therefore gives every policy of a role declared in `runtime-overrides.json` `roles` an
explicit `DependsOn` on that role (`stackCreated`, `infra/cdk/lib/overrides.js` and `runtime-stack.js`). Imported roles
already exist and keep their template unchanged. `tools/migration/test/runtime-overrides.test.js` covers the flag.
Check the dry-run template for `DependsOn` on each new role's policies before executing.

## The diagnosis Lambda (owner-approved S4R-sensitive changes)

- **Role.** It runs on `ac-diagnosis-role` (`AcRuntimeStack`).
  - `bash infra/production/verify-diagnosis-role.sh <dir> ac-diagnosis-role` checks it end to end.
  - `… cloudtrail <since>` checks the session issuer of its secret reads.
- **Rolling back the role.** The owner's IAM user runs
  `aws lambda update-function-configuration --function-name spares4repairs-part-finder --role <S4R role ARN>`.
  CloudFormation cannot pass the S4R role (`ac-deny-s4r`).
- **`/ai/chat`** is retired (C1). Re-opening it is one `add-permission` call (recorded by `c1-retire-ai-chat.sh`).
  `verify-ai-chat-ingress.sh <dir> retired` proves it is closed.
- **AI-config, OpenAI and Jev** live in `applianceclinic/production/`.
  - Both consumers take the ids from `AI_CONFIG_SECRET_ID`, `OPENAI_SECRET_ID` and `JEV_SECRET_ID`.
  - Settings writes them. Rotating a provider credential means saving the new one in Settings.
  - `d-copy-secrets.sh` is the one-off copy used for the move. It refuses to overwrite a secret that already has more
    than its placeholder version.
- **Execution policy size.** The read-only base plus a change's grant must stay under 6,144 characters. `change.sh`
  refuses an oversized grant before anything runs.
