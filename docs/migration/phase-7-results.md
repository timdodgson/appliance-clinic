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
| CloudTrail | CT_73 |
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

## For the owner

- **Set your admin password.** Use the temporary password Cognito emailed you, on
  `https://applianceclinic-admin.auth.eu-west-1.amazoncognito.com/login?client_id=2hgmm8m02n78agi46kae4p2eja&response_type=code&scope=openid+email&redirect_uri=https%3A%2F%2Fapplianceclinic.ai%2F`.
  Then sign in on the AC site as before.
- **Lambda concurrency quota.** Request a Service Quotas increase of "Concurrent executions" (currently 10). Reserved
  concurrency for AC functions, and isolation from S4R, depend on it.
