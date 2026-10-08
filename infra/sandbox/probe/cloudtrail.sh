#!/usr/bin/env bash
# Phase 5 import-semantics evidence: every non-read API call a CloudFormation execution role made in a window.
# READ-ONLY (cloudtrail:LookupEvents). Run as the IAM user; CloudTrail delivers events 5 to 15 minutes late.
#
#   bash cloudtrail.sh <role-name> <start ISO> <end ISO> > writes.json
#
# Output: [{time, action, resource, errorCode, request}], oldest first. `action` is service:Operation, with the API
# version suffix Lambda appends (UpdateFunctionConfiguration20150331v2) removed.
set -euo pipefail
ROLE=${1:?role}; START=${2:?start}; END=${3:?end}
export AWS_REGION=${AWS_REGION:-eu-west-1}
# Page through every event: a CloudFormation session makes many reads, so the writes are rarely on the first page.
# Pages are kept in memory (no temporary file).
events='[]'; token=
while :; do
  page=$(aws cloudtrail lookup-events --start-time "$START" --end-time "$END" --no-paginate --max-results 50 \
    --lookup-attributes AttributeKey=Username,AttributeValue=AWSCloudFormation ${token:+--next-token "$token"} --output json)
  events=$(jq -c --argjson acc "$events" '$acc + [.Events[].CloudTrailEvent | fromjson | select(.readOnly == false)]' <<<"$page")
  token=$(jq -r '.NextToken // empty' <<<"$page")
  [[ -n $token ]] || break
  sleep 0.6   # LookupEvents allows 2 calls a second
done
jq --arg role "$ROLE" '[.[] | select(.userIdentity.sessionContext.sessionIssuer.userName == $role)
    | {time: .eventTime,
       action: ((.eventSource | split(".")[0]) + ":" + (.eventName | sub("[0-9]{8}(v[0-9]+)?$"; ""))),
       resource: ((.requestParameters // {}) | (.resourceARN // .repositoryName // .functionName // .tableName // .bucketName // .secretId // .roleName // .name // .resourceArn // .resource // .FunctionName // .TableName // .ResourceArn // null)),
       errorCode: (.errorCode // null),
       request: (.requestParameters // {} | del(.policyText?, .policyDocument?, .policy?, .environment?, .Environment?) | keys)}]
  | unique_by([.time, .action, .resource]) | sort_by(.time)' <<<"$events"
