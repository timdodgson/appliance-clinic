#!/usr/bin/env bash
# Phase 7 (ADR 0006): verify AC sign-in and admin authority end to end, through https://applianceclinic.ai/api.
# Run as the IAM user, from the repository root:
#
#   bash infra/production/verify-ac-auth.sh
#
# Creates two temporary users in the AC pool (never the S4R pool): one in the admin group, one not. Their passwords
# are random, held in this process only, never printed or written. Both users are deleted at exit, whatever happens.
# Checks:
#   1. no cookie: an admin route is 401
#   2. a cookie claiming the S4R pool, with an "admin" group: /auth/me is signed out, an admin route is 401
#   3. the temporary admin signs in (isAdmin true) and reaches /admin/health (200)
#   4. the temporary non-admin signs in (isAdmin false) and gets 401 on /admin/health
#   5. the admin's batch-run enqueue without a target, or for production without confirmation, is refused (nothing
#      is queued; CHECK_BENCHMARK_TARGET=0 skips it)
#   6. the admin lists error codes: a read through the error-code MCP's Function URL (Phase 7: proves the URL path)
set -euo pipefail
source "$(dirname "$0")/lib.sh"
require_caller
AC_POOL=eu-west-1_r4fXXEdxC
API=${AC_API:-https://applianceclinic.ai/api}
TAG=$(openssl rand -hex 4)
ADMIN_USER="phase7-verify-admin-$TAG@example.invalid"
PLAIN_USER="phase7-verify-user-$TAG@example.invalid"
cleanup() {
  for u in "$ADMIN_USER" "$PLAIN_USER"; do aws cognito-idp admin-delete-user --user-pool-id "$AC_POOL" --username "$u" 2>/dev/null || true; done
  log "temporary users deleted"
}
trap cleanup EXIT
pw() { printf '%s' "$(openssl rand -base64 24 | tr -d '/+=')Aa1!"; }
make_user() { # USER PASSWORD [group]
  aws cognito-idp admin-create-user --user-pool-id "$AC_POOL" --username "$1" --message-action SUPPRESS \
    --user-attributes Name=email,Value="$1" Name=email_verified,Value=true >/dev/null
  aws cognito-idp admin-set-user-password --user-pool-id "$AC_POOL" --username "$1" --password "$2" --permanent
  [[ -n ${3:-} ]] && aws cognito-idp admin-add-user-to-group --user-pool-id "$AC_POOL" --username "$1" --group-name "$3"
  return 0
}
export ADMIN_PW PLAIN_PW
ADMIN_PW=$(pw); PLAIN_PW=$(pw)
make_user "$ADMIN_USER" "$ADMIN_PW" admin
make_user "$PLAIN_USER" "$PLAIN_PW"
log "temporary users created in $AC_POOL"

API=$API ADMIN_USER=$ADMIN_USER PLAIN_USER=$PLAIN_USER CHECK_BENCHMARK_TARGET=${CHECK_BENCHMARK_TARGET:-1} NODE_USE_ENV_PROXY=1 node --input-type=module <<'EOF'
const api = process.env.API;
const results = [];
const check = (name, ok, detail) => { results.push({ name, ok }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` (${detail})` : ''}`); };
const call = async (path, { method = 'GET', cookie, body } = {}) => {
  const r = await fetch(api + path, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: body && JSON.stringify(body) });
  const setCookies = r.headers.getSetCookie ? r.headers.getSetCookie() : [];
  let json = null; try { json = await r.json(); } catch { /* not JSON */ }
  return { status: r.status, json, setCookies };
};
const session = (setCookies) => setCookies.map((c) => c.split(';')[0]).filter((c) => c.startsWith('wp_session=')).join('; ');
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');

let r = await call('/admin/health');
check('no cookie: /admin/health is 401', r.status === 401, `status ${r.status}`);

const forged = `wp_session=${b64({ alg: 'RS256' })}.${b64({ iss: 'https://cognito-idp.eu-west-1.amazonaws.com/eu-west-1_mUWucohuX', token_use: 'access', client_id: '60phdcnl0eetdq4kcp327d0fkm', sub: 'x', 'cognito:groups': ['admin'] })}.sig`;
r = await call('/auth/me', { cookie: forged });
check('S4R-pool cookie: /auth/me is signed out', r.status === 200 && r.json && r.json.authenticated === false, `status ${r.status}`);
r = await call('/admin/health', { cookie: forged });
check('S4R-pool cookie with an admin group: /admin/health is 401', r.status === 401, `status ${r.status}`);

r = await call('/auth/login', { method: 'POST', body: { email: process.env.ADMIN_USER, password: process.env.ADMIN_PW } });
check('AC admin signs in', r.status === 200 && r.json && r.json.user && r.json.user.isAdmin === true, `status ${r.status}`);
const adminCookie = session(r.setCookies);
r = await call('/admin/health', { cookie: adminCookie });
check('AC admin reaches /admin/health', r.status === 200, `status ${r.status}`);
r = await call('/admin/ai-config', { cookie: adminCookie });
check('AC admin reads Settings (ai-config, OpenAI and Jev secrets readable by whichpart-api)', r.status === 200, `status ${r.status}`);
r = await call('/admin/error-codes', { cookie: adminCookie });
check('AC admin lists error codes (whichpart-api -> MCP Function URL, bearer)', r.status === 200, `status ${r.status}`);
if (process.env.CHECK_BENCHMARK_TARGET === '1') {
  r = await call('/admin/benchmark/run', { method: 'POST', cookie: adminCookie, body: {} });
  check('batch run without a target is refused (staging default, none configured)', r.status === 409 && r.json && r.json.error === 'STAGING_NOT_CONFIGURED', `status ${r.status}`);
  r = await call('/admin/benchmark/run', { method: 'POST', cookie: adminCookie, body: { target: 'production' } });
  check('production batch run without confirmProduction is refused', r.status === 400 && r.json && r.json.error === 'PRODUCTION_CONFIRMATION_REQUIRED', `status ${r.status}`);
}
r = await call('/auth/logout', { method: 'POST', cookie: adminCookie });
check('AC admin signs out', r.status === 200, `status ${r.status}`);

r = await call('/auth/login', { method: 'POST', body: { email: process.env.PLAIN_USER, password: process.env.PLAIN_PW } });
check('AC user without the admin group signs in, not admin', r.status === 200 && r.json && r.json.user && r.json.user.isAdmin === false, `status ${r.status}`);
r = await call('/admin/health', { cookie: session(r.setCookies) });
check('AC user without the admin group: /admin/health is 401', r.status === 401, `status ${r.status}`);

r = await call('/auth/login', { method: 'POST', body: { email: process.env.ADMIN_USER, password: 'wrong-password-Aa1!' } });
check('wrong password: 401', r.status === 401, `status ${r.status}`);
process.exitCode = results.every((x) => x.ok) ? 0 : 1;
EOF
