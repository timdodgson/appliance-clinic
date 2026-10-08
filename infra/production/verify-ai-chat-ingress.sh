#!/usr/bin/env bash
# Phase 7 (C1): is POST /ai/chat (S4R HTTP API 65vnizdmk4) still an ingress to the diagnosis Lambda?
# Run as the IAM user, from the repository root:
#
#   bash infra/production/verify-ai-chat-ingress.sh <out-dir> open|retired
#
# Sends the recorded ingress probe once (tools/migration `baseline ingress verify`: the caller-visible result must
# still match the recorded 500 / JSON / message shape), then reads the diagnosis Lambda's log group for an
# API-Gateway-originated turn after the probe. HTTP API payload 2.0 requests carry a short request id ending in "=";
# Function URL requests carry a UUID. Also reads whether the Lambda permission `apigateway-invoke` exists.
#   open:    the permission exists and the probe reaches the Lambda (one "…=" turn)
#   retired: the permission is absent and the probe does not reach the Lambda (no "…=" turn)
# The API itself is only called, never read for configuration or changed here (s4r-boundary.sh covers it).
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
source "$ROOT/infra/production/lib.sh"
require_caller
O=${1:?out dir}; EXPECT=${2:?open|retired}; mkdir -p "$O"
fail=0
check() { if [[ $2 == "$3" ]]; then echo "PASS $1 ($2)"; else echo "FAIL $1 (got $2, want $3)"; fail=1; fi; }

perm=$(aws lambda get-policy --function-name spares4repairs-part-finder --query Policy --output text | jq -r '[.Statement[] | select(.Sid == "apigateway-invoke")] | length')
start=$(( $(date +%s) * 1000 ))
(cd "$ROOT/tools/migration" && NODE_USE_ENV_PROXY=1 npm run -s baseline -- ingress verify --live --recorded "$ROOT/.migration-output/phase5/baseline/ai-chat-ingress.json" 2>/dev/null) > "$O/ingress.json" || true
check "/ai/chat caller-visible result equals the recorded one" "$(jq -r .ok "$O/ingress.json")" true

# Log delivery takes a little while; wait up to 3 minutes for a turn, or for the window to be clearly past.
turns=0
for _ in $(seq 1 12); do
  sleep 15
  q=$(aws logs start-query --log-group-name /aws/lambda/spares4repairs-part-finder --start-time $((start / 1000 - 5)) --end-time $(( $(date +%s) + 5 )) \
    --query-string 'filter evt = "part-finder" and requestId like /=$/ | stats count(*) as n' --query queryId --output text)
  for _ in $(seq 1 30); do s=$(aws logs get-query-results --query-id "$q" --query status --output text); [[ $s == Complete ]] && break; sleep 2; done
  turns=$(aws logs get-query-results --query-id "$q" --output json | jq -r '[.results[0][]? | select(.field == "n") | .value][0] // "0"')
  [[ $EXPECT == open && $turns != 0 ]] && break
done
if [[ $EXPECT == open ]]; then
  check "permission apigateway-invoke present" "$perm" 1
  check "the probe reached the diagnosis Lambda (API Gateway turns)" "$([[ $turns -ge 1 ]] && echo yes || echo no)" yes
else
  check "permission apigateway-invoke absent" "$perm" 0
  check "the probe did not reach the diagnosis Lambda (API Gateway turns)" "$turns" 0
fi
exit $fail
