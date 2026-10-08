#!/usr/bin/env bash
# Phase 7 onwards: one reviewed CDK change to production (runbook: docs/migration/runbooks/phase-7-security.md). Run as
# the IAM user, from the repository root:
#
#   EXECUTE=1 bash infra/production/steps/change.sh infra/production/changes/<id>.json
#
# The spec names the stack, the kind (CREATE or UPDATE), every expected change (action, logical ID, type, physical ID,
# replacement, and the property details it may touch), the writes the execution role gets for this change only, and
# the writes CloudTrail may show. Without EXECUTE=1 everything up to and including the checked change set runs, and
# nothing is executed.
#
#   1. synthesize the stack from this checkout (AcRuntimeStack: from a fresh capture of live plus
#      infra/cdk/config/runtime-overrides.json)
#   2. UPDATE: the new template must equal the deployed one for every resource the spec does not name, with the same
#      parameters and outputs; CREATE: the stack must not exist and the template must hold exactly the spec's resources
#   3. a change set (execution role), checked in update mode and equal to the spec's expected changes; each change's
#      details must be within the properties the spec allows
#   4. ac-cfn-execution gets a version: the read-only base plus exactly the spec's grant; it goes back to the read-only
#      version straight after, whatever happens. A temporary stack policy allows Update:Replace only on the logical IDs
#      the spec names, and is restored straight after
#   5. execute; drift IN_SYNC; the same template is a no-op; termination protection and the stack policy are set
#   6. CloudTrail after delivery: infra/production/check-cloudtrail.sh change:<id>
source "$(dirname "$0")/../lib.sh"
require_caller
SPEC=$(cd "$(dirname "${1:?spec}")" && pwd)/$(basename "$1")
[[ -s $SPEC ]] || stop "no spec $1"
ID=$(jq -r .id "$SPEC"); STACK=$(jq -r .stack "$SPEC"); KIND=$(jq -r .kind "$SPEC")
check_stack_name "$STACK"
[[ $KIND == CREATE || $KIND == UPDATE ]] || stop "kind is CREATE or UPDATE"
W=$P5_ROOT/.migration-output/phase7/$ID
mkdir -p "$W"
RES=$W/results.txt; : > "$RES"
result() { log "$*"; echo "$*" >> "$RES"; }
umask 077
trap ': > "$W/params.json"' EXIT

# --- 1. Synthesize ----------------------------------------------------------------------------------------------
CTX=(-c step=5.10 -c declare='{"ecrRepositoryPolicy":true}')
if [[ $STACK == AcRuntimeStack ]]; then
  CAP=$P5_ROOT/.migration-output/phase5/live/runtime-production.json
  CODE=$P5_ROOT/.migration-output/phase5/live/code-locations.json
  mkdir -p "$(dirname "$CAP")"
  bash "$P5_ROOT/infra/production/capture-runtime.sh" production "$CAP"
  # Zip functions without a code override run the deployed artefact, byte for byte (as in the Phase 5 imports).
  B=cdk-acclinic-assets-$P5_ACCOUNT-$P5_REGION
  echo '{}' > "$CODE.tmp"
  for f in $(jq -r '.functions | to_entries[] | select(.value.configuration.PackageType == "Zip") | .key' "$CAP"); do
    sha=$(jq -r --arg f "$f" '.functions[$f].configuration.CodeSha256' "$CAP")
    key=phase5/$f-$(tr '/+' '_-' <<<"${sha%=}").zip
    aws s3api head-object --bucket "$B" --key "$key" >/dev/null 2>&1 || { [[ $(jq -r --arg f "$f" '.functions[$f].code // empty' "$P5_ROOT/infra/cdk/config/runtime-overrides.json") ]] || stop "$f: deployed artefact $key is not staged (run import.sh's staging first)"; }
    jq --arg f "$f" --arg b "$B" --arg k "$key" '. + {($f): {s3Bucket: $b, s3Key: $k}}' "$CODE.tmp" > "$CODE.tmp2" && mv "$CODE.tmp2" "$CODE.tmp"
  done
  mv "$CODE.tmp" "$CODE"
  CTX+=(-c "live=$CAP" -c "code=$CODE")
fi
(cd "$P5_ROOT/infra/cdk" && env -u AWS_ACCESS_KEY_ID -u AWS_SECRET_ACCESS_KEY -u AWS_SESSION_TOKEN AWS_EC2_METADATA_DISABLED=true CDK_DISABLE_VERSION_CHECK=1 \
  npx cdk synth --quiet --no-notices "${CTX[@]}" >/dev/null 2>&1) || stop "cdk synth failed"
T=$W/template.json
cp "$P5_ROOT/infra/cdk/cdk.out/$STACK.template.json" "$T"
unset P5_PARAMS
if [[ $(jq '[.Parameters // {} | keys[] | select(. != "BootstrapVersion")] | length' "$T") != 0 ]]; then
  node "$P5_ROOT/infra/production/token-params.mjs" "$T" "$CAP" production "$W/params.json"
  P5_PARAMS=file://$W/params.json
fi

# --- 2. The template: exactly the spec's resources change ------------------------------------------------------
NAMED=$(jq -c '[.expectedChanges[].logicalId]' "$SPEC")
if [[ $KIND == UPDATE ]]; then
  stack_exists "$STACK" || stop "$STACK does not exist"
  aws cloudformation get-template --stack-name "$STACK" --template-stage Original --query TemplateBody --output json > "$W/deployed.json"
  rest() { jq -S --argjson n "$NAMED" '.Resources |= with_entries(select(.key as $k | $n | index($k) | not))' "$1"; }
  cmp -s <(rest "$W/deployed.json") <(rest "$T") || { diff <(rest "$W/deployed.json") <(rest "$T") >&2 || true; stop "the template changes resources the spec does not name"; }
  result "change $ID template: equal to the deployed $STACK template for every resource but $(jq -r 'join(", ")' <<<"$NAMED")"
else
  stack_exists "$STACK" && stop "$STACK already exists"
  [[ "$(jq -c '[.Resources | keys[]] | sort' "$T")" == "$(jq -c 'sort' <<<"$NAMED")" ]] || stop "the template's resources are not exactly the spec's"
  result "change $ID template: a new $STACK holding exactly $(jq -r 'join(", ")' <<<"$NAMED")"
fi

# --- 3. The change set ----------------------------------------------------------------------------------------
SF=$W/step.json
# AcRuntimeStack's template still holds the S4R references every earlier step acknowledged (the diagnosis Lambda's
# S4R role, ...): they carry over from the last import step unless the spec lists its own.
ACK=$(jq -c '.acknowledgedReferences // empty' "$SPEC")
[[ -z $ACK && $STACK == AcRuntimeStack ]] && ACK=$(jq -c .acknowledgedReferences "$P5_ROOT/infra/production/steps/5.10.json")
jq --argjson ack "${ACK:-[]}" '{step: .id, stack, allowedPhysicalIds: [.expectedChanges[] | .physicalId | select(. != null)], acknowledgedReferences: $ack,
     expectedChanges: [.expectedChanges[] | {action, logicalId, type, physicalId, replacement}]}' "$SPEC" > "$SF"
CS=change-${ID//./-}
EXECUTE=0 changeset "$STACK" "$CS" "$KIND" "$T" "$SF"
D=$P5_OUT/$STACK.$CS.changeset.json
bad=$(jq -c --slurpfile s "$SPEC" '[.Changes[].ResourceChange | . as $c
  | ($s[0].expectedChanges[] | select(.logicalId == $c.LogicalResourceId) | .details // null) as $allowed
  | select($allowed != null) | .Details[] | .Target | "\(.Attribute).\(.Name // "")" | select(. as $d | $allowed | index($d) | not)] | unique' "$D")
[[ $bad == '[]' ]] || { aws cloudformation delete-change-set --stack-name "$STACK" --change-set-name "$CS" 2>/dev/null || true; stop "change details outside the spec: $bad (change set deleted)"; }
result "change $ID change set: $(jq -c '[.Changes[].ResourceChange | {Action, LogicalResourceId, PhysicalResourceId, Replacement, details: ([.Details[]?.Target | "\(.Attribute).\(.Name // "")"] | unique)}]' "$D")"
[[ $EXECUTE == 1 ]] || exit 0

# --- 4. The change's writes, and nothing else -----------------------------------------------------------------
POL=arn:aws:iam::$P5_ACCOUNT:policy/ac-cfn-execution
BASE_DOC=$P5_ROOT/docs/migration/phase-5/toolkit/ac-cfn-execution.json
(cd "$P5_TOOLS" && npm run -s production:toolkit -- --check >/dev/null) || stop "toolkit documents are stale"
jq --slurpfile s "$SPEC" '.Statement += [$s[0].grant | to_entries[] | {Sid: "Change\(.key)", Effect: "Allow", Action: .value.Action, Resource: .value.Resource}]' "$BASE_DOC" > "$W/change-policy.json"
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
BASE_V=$(make_version "$BASE_DOC"); CHANGE_V=$(make_version "$W/change-policy.json")
REPLACE=$(jq -c '[.expectedChanges[] | select(.replacement == "True") | .logicalId]' "$SPEC")
restore() {
  aws iam set-default-policy-version --policy-arn "$POL" --version-id "$BASE_V"
  [[ $KIND == UPDATE && $REPLACE != '[]' ]] && protect "$STACK" >/dev/null 2>&1
  return 0
}
trap 'restore; : > "$W/params.json"' EXIT
set_default "$CHANGE_V"
result "change $ID execution policy: $CHANGE_V = read-only + $(jq -c '.grant' "$SPEC")"
if [[ $KIND == UPDATE && $REPLACE != '[]' ]]; then
  # Update:Replace is allowed only on the named logical IDs, for this execution only; Delete stays denied.
  aws cloudformation set-stack-policy --stack-name "$STACK" --stack-policy-body "$(jq -nc --argjson r "$REPLACE" '{Statement: [
    {Effect: "Allow", Principal: "*", Action: "Update:*", Resource: "*"},
    {Effect: "Deny", Principal: "*", Action: ["Update:Replace", "Update:Delete"], NotResource: [$r[] | "LogicalResourceId/\(.)"]},
    {Effect: "Deny", Principal: "*", Action: "Update:Delete", Resource: "*"}]}')"
  result "change $ID stack policy: Update:Replace allowed for this execution on $REPLACE only"
fi

# --- 5. Execute -----------------------------------------------------------------------------------------------
start=$(date -u +%FT%TZ)
aws cloudformation execute-change-set --stack-name "$STACK" --change-set-name "$CS"
case $KIND in
  CREATE) aws cloudformation wait stack-create-complete --stack-name "$STACK" ;;
  UPDATE) aws cloudformation wait stack-update-complete --stack-name "$STACK" ;;
esac || { aws cloudformation describe-stack-events --stack-name "$STACK" --max-items 25 \
  --query 'StackEvents[].[LogicalResourceId,ResourceStatus,ResourceStatusReason]' --output text >&2; stop "$STACK/$CS failed"; }
end=$(date -u +%FT%TZ)
restore; trap ': > "$W/params.json"' EXIT
result "change $ID executed: $STACK -> $(aws cloudformation describe-stacks --stack-name "$STACK" --query 'Stacks[0].StackStatus' --output text); execution policy back to read-only ($BASE_V)"
aws cloudformation describe-stack-events --stack-name "$STACK" --max-items 60 --output json \
  | jq --arg s "$start" '[.StackEvents[] | select(.Timestamp >= $s) | {Timestamp, LogicalResourceId, ResourceStatus, ResourceStatusReason}]' > "$W/events.json"
jq -n --arg s "$start" --arg e "$end" --arg role "cdk-acclinic-cfn-exec-role-$P5_ACCOUNT-$P5_REGION" --slurpfile sp "$SPEC" \
  '{start: $s, end: $e, role: $role, types: $sp[0].writes.types}' > "$W/window.json"
if [[ $KIND == CREATE ]]; then
  aws cloudformation update-termination-protection --enable-termination-protection --stack-name "$STACK" >/dev/null
  result "change $ID: termination protection on"
fi
protect "$STACK"

d=$(drift "$STACK")
result "change $ID drift: $d; $(awk '{print $1"="$3}' "$P5_OUT/$STACK.drift.txt" | paste -sd' ')"
[[ $d == *IN_SYNC* ]] || stop "drift after change $ID is not IN_SYNC"
expect_noop "$STACK" "$T"
result "change $ID no-op: the same template contains no changes"
result "change $ID CloudTrail: check after delivery with infra/production/check-cloudtrail.sh change:$ID"
