#!/usr/bin/env bash
# Phase 6: prove CDK ownership with one inert tag on one AC-only imported resource (PLAN.md Phase 6;
# docs/migration/phase-6-proof-writes.json), then remove it with a second reviewed update. Run as the IAM user:
#
#   EXECUTE=1 bash infra/production/steps/phase-6-proof.sh add|remove
#
#   1. synthesize AcDataStack from this checkout (the tag present for add, absent for remove) and require that it
#      differs from the deployed template by exactly that one tag on the one resource, nothing else
#   2. snapshot the resource
#   3. ac-cfn-execution gets a version: the read-only base plus the proof's writes on the one resource; it goes back
#      to the read-only version straight after the update, whatever happens
#   4. an UPDATE change set, checked in update mode and equal to exactly one Modify of the resource (no replacement),
#      whose only detail is the Tags property; executed only if all of that holds
#   5. drift IN_SYNC, the same template a no-op
#   6. the after snapshot: add = the before snapshot plus exactly the tag; remove = the snapshot taken before the add
#   7. CloudTrail after delivery: check-cloudtrail.sh phase6-<mode> (the proof manifest's variant)
source "$(dirname "$0")/../lib.sh"
require_caller
MODE=${1:?add|remove}
[[ $MODE == add || $MODE == remove ]] || stop "mode is add or remove"
PROOF=$P5_ROOT/docs/migration/phase-6-proof-writes.json
STACK=$(jq -r .resource.stack "$PROOF"); LID=$(jq -r .resource.logicalId "$PROOF"); PID=$(jq -r .resource.physicalId "$PROOF")
TAG=$(jq -c .tag "$PROOF")
check_stack_name "$STACK"
P6=$P5_ROOT/.migration-output/phase6
W=$P6/$MODE
mkdir -p "$W"
RES=$W/results.txt; : > "$RES"
result() { log "$*"; echo "$*" >> "$RES"; }
umask 077

# --- 1. The template: the deployed one, plus or minus exactly the tag ------------------------------------------
(cd "$P5_ROOT/infra/cdk" && env -u AWS_ACCESS_KEY_ID -u AWS_SECRET_ACCESS_KEY -u AWS_SESSION_TOKEN AWS_EC2_METADATA_DISABLED=true CDK_DISABLE_VERSION_CHECK=1 \
  npx cdk synth --quiet --no-notices -c step=5.4 -c declare='{"ecrRepositoryPolicy":true}' >/dev/null 2>&1) || stop "cdk synth failed"
T=$W/template.json
cp "$P5_ROOT/infra/cdk/cdk.out/$STACK.template.json" "$T"
aws cloudformation get-template --stack-name "$STACK" --template-stage Original --query TemplateBody --output json > "$W/deployed.json"
without() { jq -S --arg l "$LID" 'del(.Resources[$l].Properties.Tags)' "$1"; }
cmp -s <(without "$W/deployed.json") <(without "$T") || { diff <(without "$W/deployed.json") <(without "$T") >&2 || true; stop "the template differs from the deployed one beyond the proof tag"; }
want_new=$([[ $MODE == add ]] && echo "[$TAG]" || echo null); want_old=$([[ $MODE == add ]] && echo null || echo "[$TAG]")
[[ $(jq -c --arg l "$LID" '.Resources[$l].Properties.Tags' "$T") == "$want_new" ]] || stop "the new template's tags on $LID are not $want_new"
[[ $(jq -c --arg l "$LID" '.Resources[$l].Properties.Tags' "$W/deployed.json") == "$want_old" ]] || stop "the deployed template's tags on $LID are not $want_old"
result "phase6 $MODE template: equal to the deployed AcDataStack template except $LID Tags: $want_old -> $want_new"

# --- 2. Snapshot ----------------------------------------------------------------------------------------------
STEP_SNAP=$W/snapshot-step.json
jq -n --argjson e "$(jq -c '.import[] | select(.LogicalResourceId == "'"$LID"'")' "$P5_ROOT/infra/production/steps/5.1.json")" '{stack: "AcDataStack", import: [$e]}' > "$STEP_SNAP"
bash "$P5_ROOT/infra/production/snapshot.sh" "$STEP_SNAP" > "$W/before.json"

# --- 3. The proof's writes, and nothing else ------------------------------------------------------------------
POL=arn:aws:iam::$P5_ACCOUNT:policy/ac-cfn-execution
BASE_DOC=$P5_ROOT/docs/migration/phase-5/toolkit/ac-cfn-execution.json
(cd "$P5_TOOLS" && npm run -s production:toolkit -- --check >/dev/null) || stop "toolkit documents are stale"
(cd "$P5_TOOLS" && node bin/import-writes.mjs proof-policy --manifest "$PROOF") > "$W/proof-policy.json"
version_of() {
  for v in $(aws iam list-policy-versions --policy-arn "$POL" --query 'Versions[].VersionId' --output text); do
    cmp -s <(aws iam get-policy-version --policy-arn "$POL" --version-id "$v" --query PolicyVersion.Document --output json | jq -S .) <(jq -S . "$1") && { echo "$v"; return; }
  done
}
make_version() {
  local v; v=$(version_of "$1"); [[ -n $v ]] && { echo "$v"; return; }
  if [[ $(aws iam list-policy-versions --policy-arn "$POL" --query 'length(Versions)') -ge 5 ]]; then
    aws iam delete-policy-version --policy-arn "$POL" --version-id \
      "$(aws iam list-policy-versions --policy-arn "$POL" --query 'Versions[?!IsDefaultVersion] | sort_by(@, &CreateDate)[0].VersionId' --output text)"
  fi
  aws iam create-policy-version --policy-arn "$POL" --policy-document "file://$1" --query PolicyVersion.VersionId --output text
}
set_default() { aws iam set-default-policy-version --policy-arn "$POL" --version-id "$1"; sleep 15; }

# --- 4. The change set ----------------------------------------------------------------------------------------
SF=$W/step.json
jq -n --arg s "phase6-$MODE" --arg st "$STACK" --arg l "$LID" --arg p "$PID" \
  '{step: $s, stack: $st, allowedPhysicalIds: [$p], acknowledgedReferences: [],
    expectedChanges: [{action: "Modify", logicalId: $l, type: "AWS::ECR::Repository", physicalId: $p, replacement: "False"}]}' > "$SF"
CS=phase6-$MODE
if [[ $EXECUTE == 1 ]]; then
  BASE_V=$(make_version "$BASE_DOC"); PROOF_V=$(make_version "$W/proof-policy.json")
fi
# Created (and checked) with the read-only role; the proof version is the default only while it executes.
EXECUTE=0 changeset "$STACK" "$CS" UPDATE "$T" "$SF"
D=$P5_OUT/$STACK.$CS.changeset.json
jq -e '[.Changes[].ResourceChange.Details[] | {a: .Target.Attribute, n: (.Target.Name // null), rr: .Target.RequiresRecreation}] | unique
       | . == [{a: "Tags", n: null, rr: "Never"}] or . == [{a: "Properties", n: "Tags", rr: "Never"}]' "$D" >/dev/null \
  || { jq -c '.Changes[].ResourceChange.Details' "$D" >&2; aws cloudformation delete-change-set --stack-name "$STACK" --change-set-name "$CS"; stop "the change set's details are not exactly the Tags property (change set deleted)"; }
result "phase6 $MODE change set: $(jq -c '[.Changes[].ResourceChange | {Action, LogicalResourceId, PhysicalResourceId, Replacement, Scope, details: [.Details[].Target | {Attribute, Name, RequiresRecreation}]}]' "$D")"
[[ $EXECUTE == 1 ]] || exit 0

set_default "$PROOF_V"
trap 'aws iam set-default-policy-version --policy-arn "$POL" --version-id "$BASE_V"' EXIT
result "phase6 $MODE execution policy: $PROOF_V = read-only + $(jq -c '.Statement[] | select(.Sid == "Phase6ProofWrites") | {Action, Resource}' "$W/proof-policy.json")"
start=$(date -u +%FT%TZ)
aws cloudformation execute-change-set --stack-name "$STACK" --change-set-name "$CS"
aws cloudformation wait stack-update-complete --stack-name "$STACK" || { aws cloudformation describe-stack-events --stack-name "$STACK" --max-items 20 \
  --query 'StackEvents[].[LogicalResourceId,ResourceStatus,ResourceStatusReason]' --output text >&2; stop "$STACK/$CS failed"; }
end=$(date -u +%FT%TZ)
set_default "$BASE_V"
result "phase6 $MODE executed: $STACK -> $(aws cloudformation describe-stacks --stack-name "$STACK" --query 'Stacks[0].StackStatus' --output text); execution policy back to read-only ($BASE_V)"
aws cloudformation describe-stack-events --stack-name "$STACK" --max-items 30 --output json \
  | jq --arg s "$start" '[.StackEvents[] | select(.Timestamp >= $s) | {Timestamp, LogicalResourceId, ResourceStatus, ResourceStatusReason}]' > "$W/events.json"
jq -n --arg s "$start" --arg e "$end" --arg role "cdk-acclinic-cfn-exec-role-$P5_ACCOUNT-$P5_REGION" \
  '{start: $s, end: $e, role: $role, types: ["AWS::ECR::Repository"]}' > "$W/window.json"

# --- 5. Drift and no-op ---------------------------------------------------------------------------------------
d=$(drift "$STACK")
result "phase6 $MODE drift: $d; $(awk '{print $1"="$3}' "$P5_OUT/$STACK.drift.txt" | paste -sd' ')"
[[ $d == *IN_SYNC* ]] || stop "drift after phase6 $MODE is not IN_SYNC"
expect_noop "$STACK" "$T"
result "phase6 $MODE no-op: the same template contains no changes"

# --- 6. The resource: exactly the tag, nothing else -----------------------------------------------------------
bash "$P5_ROOT/infra/production/snapshot.sh" "$STEP_SNAP" > "$W/after.json"
strip() { jq -S 'map(.tags |= (map(select(.Key | startswith("aws:cloudformation:") | not)) | sort_by(.Key)))' "$1"; }
if [[ $MODE == add ]]; then
  expected=$(strip "$W/before.json" | jq -S --argjson t "$TAG" 'map(.tags = ((.tags + [$t]) | sort_by(.Key)))')
else
  expected=$(strip "$P6/add/before.json")
fi
if cmp -s <(echo "$expected" | jq -S .) <(strip "$W/after.json"); then
  result "phase6 $MODE resource: $([[ $MODE == add ]] && echo "the before snapshot plus exactly $TAG" || echo "identical to the snapshot before the add (the pre-Phase-6 state)")"
else
  diff <(echo "$expected" | jq -S .) <(strip "$W/after.json") >&2 || true
  stop "phase6 $MODE: the resource is not exactly as expected"
fi
result "phase6 $MODE CloudTrail: check after delivery with infra/production/check-cloudtrail.sh phase6-$MODE"
