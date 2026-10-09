#!/usr/bin/env bash
# Phase 7 (B): the diagnosis Lambda on its execution role, end to end. Run as the IAM user, from the repository root:
#
#   bash infra/production/verify-diagnosis-role.sh <out-dir> <expected role name>
#
# Checks: the function's Role and LastUpdateStatus; then one /part-finder contract call (a real turn: secret reads,
# overlays, a learning-trace write) and, in the diagnosis log group from that moment, the absence of AccessDenied,
# "learning-trace write failed" and "overlay load failed", and a part-finder turn with ok:true; a new learning object
# after that moment. It never prints a log message or an object, only counts and timestamps.
# EXPECT_COLD_START=0 skips the cold-start check (a warm function, as in a self-test).
# CloudTrail (GetSecretValue by the function, with the role as issuer) is checked separately after delivery:
#   bash infra/production/verify-diagnosis-role.sh <out-dir> <role> cloudtrail <since ISO>
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
source "$ROOT/infra/production/lib.sh"
require_caller
O=${1:?out dir}; ROLE=${2:?role name}; mkdir -p "$O"
F=spares4repairs-part-finder; BUCKET=whichpart-learning-800960611664
fail=0
check() { if [[ $2 == "$3" ]]; then echo "PASS $1 ($2)"; else echo "FAIL $1 (got $2, want $3)"; fail=1; fi; }

if [[ ${3:-} == cloudtrail ]]; then
  since=${4:?since}
  aws cloudtrail lookup-events --region eu-west-1 --lookup-attributes AttributeKey=EventName,AttributeValue=GetSecretValue --start-time "$since" \
    --query 'Events[].CloudTrailEvent' --output json | jq -r '.[] | fromjson | select(.userIdentity.principalId // "" | endswith(":'"$F"'"))
      | [(.userIdentity.sessionContext.sessionIssuer.userName // "?"), (.requestParameters.secretId // "?" | if test("^arn:") then sub(".*secret:"; "") | sub("-[A-Za-z0-9]{6}$"; "") else . end), (.errorCode // "ok")] | @tsv' \
    | sort | uniq -c > "$O/cloudtrail-secrets.txt"
  cat "$O/cloudtrail-secrets.txt"
  check "every secret read by the function since $since was issued by $ROLE, without error" \
    "$(awk -v r="$ROLE" '$2 != r || $4 != "ok" {bad++} END {print (NR > 0 && bad == 0) ? "yes" : (NR == 0 ? "none" : "no")}' "$O/cloudtrail-secrets.txt")" yes
  exit $fail
fi

cfg=$(aws lambda get-function-configuration --function-name "$F" --output json)
check "Role" "$(jq -r '.Role | sub(".*/"; "")' <<<"$cfg")" "$ROLE"
check "LastUpdateStatus" "$(jq -r .LastUpdateStatus <<<"$cfg")" Successful
t0=$(date +%s)
(cd "$ROOT/tools/migration" && NODE_USE_ENV_PROXY=1 npm run -s baseline -- contract verify --live --recorded "$ROOT/.migration-output/phase5/baseline/part-finder-contract.json" 2>/dev/null) > "$O/contract.json" || true
check "/part-finder contract" "$(jq -r .ok "$O/contract.json")" true
sleep 20
q() { local id; id=$(aws logs start-query --log-group-name "/aws/lambda/$F" --start-time $((t0 - 5)) --end-time $(( $(date +%s) + 5 )) --query-string "$1" --query queryId --output text)
  for _ in $(seq 1 30); do [[ $(aws logs get-query-results --query-id "$id" --query status --output text) == Complete ]] && break; sleep 2; done
  aws logs get-query-results --query-id "$id" --output json | jq -r '[.results[0][]? | select(.field == "n") | .value][0] // "0"'; }
check "AccessDenied in the diagnosis logs" "$(q 'filter @message like /AccessDenied|not authorized to perform/ | stats count(*) as n')" 0
check "learning-trace write failures" "$(q 'filter @message like /learning-trace write failed/ | stats count(*) as n')" 0
check "overlay load failures" "$(q 'filter @message like /overlay load failed/ | stats count(*) as n')" 0
check "diagnosis turns logged" "$(q 'filter evt = "part-finder" | stats count(*) as n' | awk '{print ($1 >= 1) ? "yes" : "no"}')" yes
check "turns with ok:false" "$(q 'filter evt = "part-finder" and ok = 0 | stats count(*) as n')" 0
[[ ${EXPECT_COLD_START:-1} == 1 ]] && check "a cold start on a new execution environment" "$(q 'filter @type = "REPORT" and ispresent(@initDuration) | stats count(*) as n' | awk '{print ($1 >= 1) ? "yes" : "no"}')" yes
newest=$(aws s3api list-objects-v2 --bucket "$BUCKET" --prefix "learning/dt=$(date -u +%F)/" --query 'max_by(Contents, &LastModified).LastModified' --output text 2>/dev/null || echo None)
check "a learning-trace object written after the call" "$( [[ $newest != None ]] && (( $(date -d "$newest" +%s) >= t0 - 5 )) && echo yes || echo no)" yes
exit $fail
