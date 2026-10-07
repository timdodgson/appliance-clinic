#!/usr/bin/env bash
# Phase 4 controls (#34, runbook section 5, Controls). Run as ac-operator-sbx after 40-data.sh and 50-runtime.sh.
#
#   1. No CDK::Metadata in either AC stack.
#   2. Termination protection: deleting a protected stack is refused.
#   3. Stack policies deny Update:Replace and Update:Delete on data resources, Function URLs, permissions and the
#      diagnosis copy. A change set that removes a URL, and one that replaces a table, are refused at execution.
#   4. Rollback with Retain: an update that fails on purpose rolls back, and no resource is deleted or replaced.
#   5. Deny-S4R execution role: an AC stack that tries to add a policy to the stand-in S4R role fails with
#      AccessDenied, and the role is unchanged.
# Every deliberate failure goes through the same checked change sets (EXPECT_FAIL=1). Results: controls-results.txt.
source "$(dirname "$0")/../lib.sh"
require_operator
DATA=AcDataStack-sbx
RT=AcRuntimeStack-sbx
A=$SBX_ACCOUNT
RES=$SBX_OUT/controls-results.txt
: > "$RES"
result() { log "$*"; echo "$*" >> "$RES"; }
deployed() { aws cloudformation get-template --stack-name "$1" --query TemplateBody --output json > "$SBX_OUT/$1.deployed.json"; echo "$SBX_OUT/$1.deployed.json"; }
variant() { # STACK NAME [JQ-ARGS...] JQ-FILTER: the deployed template, changed by the filter
  local src; src=$(deployed "$1")
  jq "${@:3}" "$src" > "$SBX_OUT/$1.$2.template.json"; echo "$SBX_OUT/$1.$2.template.json"
}
# Logical ID, physical ID and status. A rollback can rewrite a physical ID from ARN to name (Phase 4 finding 20:
# EventBridge rules), so an ARN is compared by the resource name inside it.
resources() { aws cloudformation list-stack-resources --stack-name "$1" --query 'StackResourceSummaries[].[LogicalResourceId,PhysicalResourceId,ResourceStatus]' --output text \
  | awk -F'\t' -v OFS='\t' '$2 ~ /^arn:aws:events:/ { sub(/^.*:rule\//, "", $2) } { print }' | sort; }

# --- 1. No CDK::Metadata ---------------------------------------------------------------------------------------
for s in $DATA $RT; do
  n=$(jq '[.Resources[] | select(.Type == "AWS::CDK::Metadata")] | length' "$(deployed $s)")
  [[ $n == 0 ]] || stop "$s carries CDK::Metadata"
done
result "1 no CDK::Metadata in $DATA or $RT (analytics reporting off)"

# --- 2. Termination protection ---------------------------------------------------------------------------------
for s in $DATA $RT ApplianceClinicSandboxToolkit; do
  [[ $(aws cloudformation describe-stacks --stack-name $s --query 'Stacks[0].EnableTerminationProtection' --output text) == True ]] \
    || stop "$s has no termination protection"
done
guard_target AWS::CloudFormation::Stack $RT
# Safe to attempt only because protection is confirmed on above, and every resource is Retain besides.
if out=$(aws cloudformation delete-stack --stack-name $RT 2>&1); then stop "delete-stack $RT was accepted"; fi
[[ $out == *"TerminationProtection is enabled"* ]] || stop "delete-stack $RT failed for another reason: $out"
[[ $(aws cloudformation describe-stacks --stack-name $RT --query 'Stacks[0].StackStatus' --output text) == *_COMPLETE ]] || stop "$RT status changed"
result "2 termination protection on for $DATA, $RT and the toolkit; delete-stack $RT refused (\"TerminationProtection is enabled\")"

# --- 3. Stack policies -----------------------------------------------------------------------------------------
cat > "$SBX_OUT/$DATA.stack-policy.json" <<'JSON'
{"Statement": [
  {"Effect": "Allow", "Principal": "*", "Action": "Update:*", "Resource": "*"},
  {"Effect": "Deny", "Principal": "*", "Action": ["Update:Replace", "Update:Delete"], "Resource": "*",
   "Condition": {"StringEquals": {"ResourceType": ["AWS::DynamoDB::Table", "AWS::S3::Bucket", "AWS::S3::BucketPolicy", "AWS::SecretsManager::Secret", "AWS::ECR::Repository"]}}}
]}
JSON
cat > "$SBX_OUT/$RT.stack-policy.json" <<'JSON'
{"Statement": [
  {"Effect": "Allow", "Principal": "*", "Action": "Update:*", "Resource": "*"},
  {"Effect": "Deny", "Principal": "*", "Action": ["Update:Replace", "Update:Delete"], "Resource": "*",
   "Condition": {"StringEquals": {"ResourceType": ["AWS::Lambda::Url", "AWS::Lambda::Permission"]}}},
  {"Effect": "Deny", "Principal": "*", "Action": ["Update:Replace", "Update:Delete"], "Resource": "LogicalResourceId/spares4repairspartfindersbx"}
]}
JSON
for s in $DATA $RT; do
  aws cloudformation set-stack-policy --stack-name $s --stack-policy-body "file://$SBX_OUT/$s.stack-policy.json"
  aws cloudformation get-stack-policy --stack-name $s --query StackPolicyBody --output text | jq -e '.Statement | length >= 2' >/dev/null || stop "stack policy not set on $s"
done
result "3 stack policies set on $DATA and $RT"

before=$(resources $RT)
t=$(variant $RT sp-url-delete 'del(.Resources.spares4repairspartfindersbxUrl)')
EXPECT_FAIL=1 EXECUTE=1 changeset $RT sp-url-delete UPDATE "$t"
grep -q "stack policy" "$SBX_OUT/$RT.sp-url-delete.failure.txt" || stop "url delete failed, but not by the stack policy: $(cat "$SBX_OUT/$RT.sp-url-delete.failure.txt")"
[[ $(resources $RT | cut -f1,2) == "$(cut -f1,2 <<<"$before")" ]] || stop "$RT resources changed"
result "3 removing the diagnosis copy's URL is refused by the stack policy; the stack rolled back with every resource in place"

before=$(resources $DATA)
t=$(variant $DATA sp-table-replace '.Resources.whichpartrecallssbx.Properties.TableName = "whichpart-recalls-sbx-restored-pitr"')
EXPECT_FAIL=1 EXECUTE=1 changeset $DATA sp-table-replace UPDATE "$t"
jq -e '.Changes[] | select(.ResourceChange.LogicalResourceId == "whichpartrecallssbx") | .ResourceChange.Replacement == "True"' \
  "$SBX_OUT/$DATA.sp-table-replace.changeset.json" >/dev/null || stop "the table rename was not a replacement"
grep -q "stack policy" "$SBX_OUT/$DATA.sp-table-replace.failure.txt" || stop "table replace failed, but not by the stack policy"
if aws dynamodb describe-table --table-name whichpart-recalls-sbx-restored-pitr >/dev/null 2>&1; then stop "the replacement table was created"; fi
[[ $(resources $DATA | cut -f1,2) == "$(cut -f1,2 <<<"$before")" ]] || stop "$DATA resources changed"
result "3 replacing whichpart-recalls-sbx (a rename) is refused by the stack policy; no replacement table was created"

# --- 4. Rollback with Retain -----------------------------------------------------------------------------------
before=$(resources $RT)
mem=$(aws lambda get-function-configuration --function-name whichpart-api-sbx --query MemorySize --output text)
sched=$(aws events describe-rule --name whichpart-recall-ingest-daily-sbx --query '[ScheduleExpression,State]' --output text)
t=$(variant $RT fail-on-purpose '.Resources.whichpartapisbx.Properties.MemorySize = 640
  | .Resources.whichpartrecallingestdailysbx.Properties.ScheduleExpression = "cron(not a schedule)"')
EXPECT_FAIL=1 EXECUTE=1 changeset $RT fail-on-purpose UPDATE "$t"
[[ $(aws lambda get-function-configuration --function-name whichpart-api-sbx --query MemorySize --output text) == "$mem" ]] || stop "memory not rolled back"
[[ $(aws events describe-rule --name whichpart-recall-ingest-daily-sbx --query '[ScheduleExpression,State]' --output text) == "$sched" ]] || stop "rule changed"
[[ $(resources $RT | cut -f1,2) == "$(cut -f1,2 <<<"$before")" ]] || stop "$RT resources changed in the rollback"
result "4 a deliberately failed update (invalid schedule) rolled back: memory back to $mem, rule unchanged and DISABLED, no resource deleted or replaced"
result "4   failure: $(cut -f1,3 "$SBX_OUT/$RT.fail-on-purpose.failure.txt" | head -1 | cut -c1-160)"

# --- 5. Deny-S4R execution role --------------------------------------------------------------------------------
ROLE=SparesSite-sbx-ServerFunctionRole
sum_role() { for p in $(aws iam list-role-policies --role-name $ROLE --query PolicyNames --output text); do
  printf '%s %s\n' "$p" "$(aws iam get-role-policy --role-name $ROLE --policy-name "$p" --query PolicyDocument --output json | jq -cS . | sha256sum | cut -c1-16)"; done; }
r0=$(sum_role)
t=$(variant $RT deny-s4r --arg a "$A" '.Resources.DenyProbe = {Type: "AWS::IAM::RolePolicy", DeletionPolicy: "Retain", UpdateReplacePolicy: "Retain",
  Properties: {RoleName: "SparesSite-sbx-ServerFunctionRole", PolicyName: "deny-probe-sbx",
    PolicyDocument: {Version: "2012-10-17", Statement: [{Effect: "Allow", Action: "s3:GetObject", Resource: ("arn:aws:s3:::whichpart-learning-sbx-" + $a + "/probe/*")}]}}}')
EXPECT_FAIL=1 EXECUTE=1 changeset $RT deny-s4r UPDATE "$t"
grep -qiE "not authorized|AccessDenied" "$SBX_OUT/$RT.deny-s4r.failure.txt" || stop "deny-s4r failed, but not with AccessDenied: $(cat "$SBX_OUT/$RT.deny-s4r.failure.txt")"
[[ $(sum_role) == "$r0" ]] || stop "the stand-in role's inline policies changed"
result "5 an AC stack adding deny-probe-sbx to $ROLE failed with AccessDenied (explicit deny in ac-cfn-execution-sbx v4); the role's policies are unchanged"

# --- 6. Everything back as it was -----------------------------------------------------------------------------
expect_noop $RT "$(deployed $RT)"
for s in $DATA $RT; do d=$(drift $s); [[ $d == *IN_SYNC* ]] || stop "drift on $s after the controls: $d"; result "6 drift on $s: $d"; done
cat "$RES" >&2
