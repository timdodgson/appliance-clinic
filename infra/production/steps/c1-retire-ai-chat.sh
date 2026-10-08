#!/usr/bin/env bash
# Phase 7, C1 (owner-approved, POTENTIALLY IMPACTS S4R): remove ONLY the diagnosis Lambda's resource-policy statement
# `apigateway-invoke`, so the S4R HTTP API route POST /ai/chat (65vnizdmk4) can no longer invoke it.
# docs/migration/phase-7-package-ai-chat.md, option C1. Run as the IAM user, from the repository root:
#
#   bash infra/production/steps/c1-retire-ai-chat.sh            dry run: checks and prints the plan
#   EXECUTE=1 bash infra/production/steps/c1-retire-ai-chat.sh  removes the statement
#
# The statement is not managed by AcRuntimeStack (runtime-stack.js NEVER_MANAGED_SIDS), so this is a direct, reviewed
# call, not a change set. Nothing on the S4R API, its route, integration or stage is touched. The statement is saved
# first, and the rollback is one add-permission call with exactly the saved fields (printed below). The removal uses
# the policy's RevisionId, so it fails rather than act on a policy that changed since it was read.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/../../.." && pwd)
source "$ROOT/infra/production/lib.sh"
require_caller
F=spares4repairs-part-finder
O=$ROOT/.migration-output/phase7/c1-retire-ai-chat; mkdir -p "$O"
EXPECTED='{"Sid":"apigateway-invoke","Effect":"Allow","Principal":{"Service":"apigateway.amazonaws.com"},"Action":"lambda:InvokeFunction","Resource":"arn:aws:lambda:eu-west-1:800960611664:function:spares4repairs-part-finder","Condition":{"ArnLike":{"AWS:SourceArn":"arn:aws:execute-api:eu-west-1:800960611664:65vnizdmk4/*"}}}'

aws lambda get-policy --function-name "$F" --output json > "$O/policy-before.json"
REV=$(jq -r .RevisionId "$O/policy-before.json")
jq -S '.Policy | fromjson | .Statement[] | select(.Sid == "apigateway-invoke")' "$O/policy-before.json" > "$O/statement.json"
[[ -s $O/statement.json ]] || stop "apigateway-invoke is not present (already removed?)"
cmp -s "$O/statement.json" <(jq -S . <<<"$EXPECTED") || { diff <(jq -S . <<<"$EXPECTED") "$O/statement.json" >&2 || true; stop "apigateway-invoke differs from the reviewed statement"; }
OTHERS=$(jq -c '[.Policy | fromjson | .Statement[] | select(.Sid != "apigateway-invoke") | .Sid] | sort' "$O/policy-before.json")
log "C1: apigateway-invoke matches the reviewed statement; policy revision $REV; other statements $OTHERS (unchanged)"
ROLLBACK="aws lambda add-permission --region eu-west-1 --function-name $F --statement-id apigateway-invoke --action lambda:InvokeFunction --principal apigateway.amazonaws.com --source-arn 'arn:aws:execute-api:eu-west-1:800960611664:65vnizdmk4/*'"
echo "$ROLLBACK" > "$O/rollback.txt"
log "C1 rollback (one call): $ROLLBACK"
[[ ${EXECUTE:-0} == 1 ]] || { log "EXECUTE!=1: not removing"; exit 0; }

date -u +%FT%TZ > "$O/executed-at.txt"
aws lambda remove-permission --function-name "$F" --statement-id apigateway-invoke --revision-id "$REV"
aws lambda get-policy --function-name "$F" --output json > "$O/policy-after.json"
[[ $(jq -r '[.Policy | fromjson | .Statement[] | select(.Sid == "apigateway-invoke")] | length' "$O/policy-after.json") == 0 ]] || stop "apigateway-invoke still present"
[[ $(jq -c '[.Policy | fromjson | .Statement[] | .Sid] | sort' "$O/policy-after.json") == "$OTHERS" ]] || stop "other statements changed"
cmp -s <(jq -S '.Policy | fromjson | .Statement | map(select(.Sid != "apigateway-invoke"))' "$O/policy-before.json") \
       <(jq -S '.Policy | fromjson | .Statement' "$O/policy-after.json") || stop "other statements changed"
log "C1: apigateway-invoke removed; every other statement identical"
