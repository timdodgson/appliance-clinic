#!/usr/bin/env bash
# Phase 7: contract checks for the AC-only endpoints (diag orchestrator, error-code MCP, whichpart-api URL settings).
# Run as the IAM user, from the repository root, before and after a change:
#
#   bash infra/production/verify-ac-endpoints.sh <out-dir>
#
# Handler checks invoke each function with a Function-URL-shaped event (lambda invoke; direct Function URLs are not
# reachable from every operator network). Only side-effect-free paths are called: GET /health and requests without a
# valid bearer, which must be refused before any work. No token is read, sent or printed: the "wrong bearer" is a
# random value generated here. The authenticated path is covered by the customer smoke (whichpart-api -> orchestrator
# -> MCP). Configuration checks read each URL's auth type and CORS, and each resource-policy statement.
# The diagnosis Lambda is never invoked by this script.
set -euo pipefail
source "$(dirname "$0")/lib.sh"
require_caller
O=${1:?out dir}; mkdir -p "$O"; umask 077
WRONG="Bearer $(openssl rand -hex 24)"
fail=0
check() { if [[ $2 == "$3" ]]; then echo "PASS $1 ($2)"; else echo "FAIL $1 (got $2, want $3)"; fail=1; fi; }

invoke() { # FUNCTION METHOD PATH [AUTH]
  local ev
  ev=$(jq -cn --arg m "$2" --arg p "$3" --arg a "${4:-}" '{version:"2.0", routeKey:"$default", rawPath:$p, rawQueryString:"",
    headers: ({"content-type":"application/json", host:"verify.invalid", accept:"application/json, text/event-stream"} + (if $a == "" then {} else {authorization:$a} end)),
    requestContext:{http:{method:$m, path:$p, protocol:"HTTP/1.1", sourceIp:"203.0.113.1", userAgent:"phase7-verify"}, requestId:"phase7-verify", stage:"$default", domainName:"verify.invalid", timeEpoch:0},
    body: (if $m == "POST" then "{\"message\":\"verify\"}" else null end), isBase64Encoded:false}')
  aws lambda invoke --function-name "$1" --cli-binary-format raw-in-base64-out --payload "$ev" "$O/out.json" >/dev/null
  jq -r '.statusCode // "none"' "$O/out.json"
}

ORCH=spares4repairs-diag-orchestrator; MCP=spares4repairs-error-code-mcp
check "orchestrator GET /health is open" "$(invoke $ORCH GET /health)" 200
jq -e '.body | fromjson | .status == "ok" and (tostring | test("(?i)token|secret|bearer") | not)' "$O/out.json" >/dev/null && echo "PASS orchestrator /health names no token or secret" || { echo "FAIL orchestrator /health payload"; fail=1; }
check "orchestrator POST /diagnose without a bearer" "$(invoke $ORCH POST /diagnose)" 401
check "orchestrator POST /diagnose with a wrong bearer" "$(invoke $ORCH POST /diagnose "$WRONG")" 401
check "MCP GET /health is open" "$(invoke $MCP GET /health)" 200
jq -e '.body | (tostring | test("(?i)bearer_token|secret") | not)' "$O/out.json" >/dev/null && echo "PASS MCP /health names no token or secret" || { echo "FAIL MCP /health payload"; fail=1; }
check "MCP POST /mcp without a bearer" "$(invoke $MCP POST /mcp)" 401
check "MCP POST /mcp with a wrong bearer" "$(invoke $MCP POST /mcp "$WRONG")" 401
: > "$O/out.json"

for f in $ORCH $MCP whichpart-api; do
  aws lambda get-function-url-config --function-name "$f" --query '{auth:AuthType, cors:Cors}' --output json > "$O/$f.url.json"
  echo "INFO $f URL: auth $(jq -r .auth "$O/$f.url.json"), CORS $(jq -c .cors "$O/$f.url.json")"
  aws lambda get-policy --function-name "$f" --query Policy --output text | jq -c '[.Statement[] | {Sid, Action, Principal, Condition}]' > "$O/$f.policy.json"
  echo "INFO $f PublicInvoke: $(jq -c '[.[] | select(.Action == "lambda:InvokeFunction" and .Principal == "*") | .Condition]' "$O/$f.policy.json")"
done
exit $fail
