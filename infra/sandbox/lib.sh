# Phase 4 sandbox step library (#34). Source it from a step script; run steps as ac-operator-sbx.
#
# Every mutation goes through one of these functions, so each one is guarded the same way:
#   require_operator           the caller is ac-operator-sbx in 800960611664 / eu-west-1, else STOP
#   guard_target TYPE ID [P]   the target is allowlisted under its exact type and on no denylist, else STOP
#   changeset STACK NAME KIND TEMPLATE [IMPORT_FILE]
#                              create a change set, describe it, run check:changeset --mode sandbox, and
#                              execute it only on PASS (and only when EXECUTE=1). KIND: CREATE, UPDATE, IMPORT.
#   expect_noop STACK TEMPLATE an update that must change nothing: CloudFormation reports no changes
# SBX_PARAMS, when set, is passed as --parameters (for example "ParameterKey=StandInRevision,ParameterValue=2").
#
# AC stacks are deployed with the acsbx execution role. SparesSite-sbx, the S4R stand-in, is deployed
# with the operator's own credentials, as S4R deploys its stack without the AC toolkit.
set -euo pipefail

SBX_ACCOUNT=800960611664
SBX_REGION=eu-west-1
export AWS_REGION=$SBX_REGION AWS_DEFAULT_REGION=$SBX_REGION
SBX_ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
SBX_TOOLS=$SBX_ROOT/tools/migration
SBX_OUT=${SBX_OUT:-$SBX_ROOT/.migration-output/sandbox}
# The import-semantics probe (probe/) uses its own execution role and, like production, no stack tags.
SBX_EXEC_ROLE=${SBX_EXEC_ROLE:-arn:aws:iam::$SBX_ACCOUNT:role/cdk-acsbx-cfn-exec-role-$SBX_ACCOUNT-$SBX_REGION}
if [[ ${SBX_NO_STACK_TAGS:-0} == 1 ]]; then SBX_TAGS=(); else SBX_TAGS=(Key=ac:sandbox,Value=phase-4); fi
EXECUTE=${EXECUTE:-0}
mkdir -p "$SBX_OUT"

# A step can outlive the operator's one-hour session. When the wrapper that assumed ac-operator-sbx names a cache
# file and a refresher (SBX_OPERATOR_CREDS, SBX_OPERATOR_REFRESH), every aws call and guard check first renews a
# session older than 40 minutes and re-exports it. Credential values are never printed.
operator_session() {
  [[ -n ${SBX_OPERATOR_REFRESH:-} && -n ${SBX_OPERATOR_CREDS:-} ]] || return 0
  if (( $(date +%s) - $(stat -c %Y "$SBX_OPERATOR_CREDS") > 2400 )); then "$SBX_OPERATOR_REFRESH"; fi
  read -r AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN < "$SBX_OPERATOR_CREDS"
  export AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN
}
aws() { operator_session; command aws "$@"; }

log() { printf '%s %s\n' "$(date -u +%H:%M:%S)" "$*" >&2; }
stop() { log "STOP: $*"; exit 1; }

guard() { operator_session; (cd "$SBX_TOOLS" && npm run -s sandbox:guard -- "$@") > "$SBX_OUT/guard.json" || { cat "$SBX_OUT/guard.json" >&2; stop "sandbox:guard $*"; }; }
require_operator() { guard caller; log "caller: ac-operator-sbx"; }
guard_target() { guard target --type "$1" --id "$2" ${3:+--parent "$3"}; log "target ok: $1 $2"; }

# changeset STACK NAME KIND TEMPLATE [IMPORT_FILE]
changeset() {
  local stack=$1 name=$2 kind=$3 template=$4 import=${5:-} role=() describe
  guard_target AWS::CloudFormation::Stack "$stack"
  [[ $stack == SparesSite-sbx ]] || role=(--role-arn "$SBX_EXEC_ROLE")
  # A dry run (EXECUTE=0) leaves its change set behind: replace it.
  aws cloudformation delete-change-set --stack-name "$stack" --change-set-name "$name" 2>/dev/null && sleep 3 || true
  aws cloudformation create-change-set --stack-name "$stack" --change-set-name "$name" --change-set-type "$kind" \
    --template-body "file://$template" --capabilities CAPABILITY_NAMED_IAM ${SBX_TAGS[@]:+--tags "${SBX_TAGS[@]}"} "${role[@]}" \
    ${SBX_PARAMS:+--parameters $SBX_PARAMS} ${import:+--resources-to-import "file://$import"} --query Id --output text >/dev/null
  if ! aws cloudformation wait change-set-create-complete --stack-name "$stack" --change-set-name "$name" 2>/dev/null; then
    aws cloudformation describe-change-set --stack-name "$stack" --change-set-name "$name" --query '[Status,StatusReason]' --output text >&2
    stop "change set $stack/$name did not reach CREATE_COMPLETE"
  fi
  describe=$SBX_OUT/$stack.$name.changeset.json
  aws cloudformation describe-change-set --stack-name "$stack" --change-set-name "$name" > "$describe"
  jq -r '.Changes[].ResourceChange | "  \(.Action) \(.LogicalResourceId) \(.ResourceType) \(.PhysicalResourceId // "") \(.Replacement // "")"' "$describe" >&2
  if ! (cd "$SBX_TOOLS" && npm run -s check:changeset -- --changeset "$describe" --mode sandbox \
        --step "$SBX_ROOT/infra/sandbox/step.json" --template "$template" ${SBX_GENERATED:+--generated "$SBX_GENERATED"}) > "$describe.check"; then
    head -n -2 "$describe.check" | jq -c '.failures' >&2
    aws cloudformation delete-change-set --stack-name "$stack" --change-set-name "$name"
    stop "check:changeset FAILED for $stack/$name (change set deleted)"
  fi
  log "check:changeset PASS: $stack/$name ($(jq '.Changes | length' "$describe") changes)"
  if [[ $EXECUTE != 1 ]]; then log "EXECUTE!=1: not executing $stack/$name"; return 0; fi
  local started; started=$(date -u +%Y-%m-%dT%H:%M:%S)
  aws cloudformation execute-change-set --stack-name "$stack" --change-set-name "$name"
  if [[ ${EXPECT_FAIL:-0} == 1 ]]; then # a deliberate failure: the update must roll back, and its reasons are kept
    aws cloudformation wait stack-update-complete --stack-name "$stack" 2>/dev/null && stop "$stack/$name was expected to fail, and succeeded"
    aws cloudformation wait stack-rollback-complete --stack-name "$stack" 2>/dev/null || true
    local status; status=$(aws cloudformation describe-stacks --stack-name "$stack" --query 'Stacks[0].StackStatus' --output text)
    [[ $status == UPDATE_ROLLBACK_COMPLETE ]] || stop "$stack/$name: expected UPDATE_ROLLBACK_COMPLETE, got $status"
    aws cloudformation describe-stack-events --stack-name "$stack" --max-items 100 \
      --query "StackEvents[?Timestamp >= '$started' && (contains(ResourceStatus, 'FAILED') || ResourceStatus == 'UPDATE_ROLLBACK_IN_PROGRESS')].[LogicalResourceId,ResourceStatus,ResourceStatusReason]" \
      --output text > "$SBX_OUT/$stack.$name.failure.txt"
    log "failed as expected: $stack/$name -> $status"
    return 0
  fi
  case $kind in
    CREATE) aws cloudformation wait stack-create-complete --stack-name "$stack" ;;
    IMPORT) aws cloudformation wait stack-import-complete --stack-name "$stack" ;;
    UPDATE) aws cloudformation wait stack-update-complete --stack-name "$stack" ;;
  esac || { aws cloudformation describe-stack-events --stack-name "$stack" --max-items 15 \
      --query 'StackEvents[].[LogicalResourceId,ResourceStatus,ResourceStatusReason]' --output text >&2; stop "$stack/$name failed"; }
  log "executed: $stack/$name -> $(aws cloudformation describe-stacks --stack-name "$stack" --query 'Stacks[0].StackStatus' --output text)"
}

# create_shell STACK TEMPLATE: create a new stack holding only its StackShell handle, with the execution role and
# tags, so resources can then be imported (an import cannot create a stack with a role or tags).
create_shell() {
  local shell=$SBX_OUT/$1.shell.json
  jq '{AWSTemplateFormatVersion, Description, Parameters, Rules, Resources: {StackShell: .Resources.StackShell}} | with_entries(select(.value != null))' "$2" > "$shell"
  changeset "$1" shell CREATE "$shell"
}

# expect_noop STACK TEMPLATE: an update with an unchanged template must produce no change set.
expect_noop() {
  local stack=$1 template=$2 name role=() status
  name=noop-$(date -u +%H%M%S)
  [[ $stack == SparesSite-sbx ]] || role=(--role-arn "$SBX_EXEC_ROLE")
  aws cloudformation create-change-set --stack-name "$stack" --change-set-name "$name" --change-set-type UPDATE \
    --template-body "file://$template" --capabilities CAPABILITY_NAMED_IAM ${SBX_TAGS[@]:+--tags "${SBX_TAGS[@]}"} "${role[@]}" \
    ${SBX_PARAMS:+--parameters $SBX_PARAMS} >/dev/null
  aws cloudformation wait change-set-create-complete --stack-name "$stack" --change-set-name "$name" 2>/dev/null || true
  status=$(aws cloudformation describe-change-set --stack-name "$stack" --change-set-name "$name" --query '[Status,StatusReason]' --output text)
  aws cloudformation delete-change-set --stack-name "$stack" --change-set-name "$name"
  [[ $status == FAILED*"didn't contain changes"* || $status == FAILED*"No updates"* ]] || stop "no-op update of $stack is not a no-op: $status"
  log "no-op confirmed: $stack"
}

# stack_status STACK: the stack's status, or NONE. A CREATE change set leaves an empty stack in
# REVIEW_IN_PROGRESS until it is executed; such a stack still needs CREATE.
stack_status() { aws cloudformation describe-stacks --stack-name "$1" --query 'Stacks[0].StackStatus' --output text 2>/dev/null || echo NONE; }
needs_create() { case $(stack_status "$1") in NONE|REVIEW_IN_PROGRESS) return 0 ;; *) return 1 ;; esac; }

# drift STACK: run drift detection and print every resource that is not IN_SYNC. Fails on any API error.
drift() {
  local id s
  id=$(aws cloudformation detect-stack-drift --stack-name "$1" --query StackDriftDetectionId --output text)
  for _ in $(seq 1 60); do
    s=$(aws cloudformation describe-stack-drift-detection-status --stack-drift-detection-id "$id" \
      --query '[DetectionStatus,StackDriftStatus]' --output text) || stop "drift status for $1"
    [[ $s == DETECTION_IN_PROGRESS* ]] || break
    sleep 5
  done
  [[ $s == DETECTION_IN_PROGRESS* ]] && stop "drift detection for $1 did not finish"
  aws cloudformation describe-stack-resource-drifts --stack-name "$1" \
    --query 'StackResourceDrifts[].[LogicalResourceId,StackResourceDriftStatus]' --output text > "$SBX_OUT/$1.drift.txt"
  echo "$s"
}
in_stack() { aws cloudformation describe-stack-resource --stack-name "$1" --logical-resource-id "$2" >/dev/null 2>&1; }

stack_resource() { aws cloudformation describe-stack-resource --stack-name "$1" --logical-resource-id "$2" --query 'StackResourceDetail.PhysicalResourceId' --output text; }
stack_output() { aws cloudformation describe-stacks --stack-name "$1" --query "Stacks[0].Outputs[?OutputKey=='$2'].OutputValue" --output text; }

# record_generated TYPE ID PARENT: an AWS-generated sandbox identifier, accepted by the guard as a child of PARENT.
SBX_GENERATED=$SBX_ROOT/.migration-output/sandbox-generated.json   # the guard reads this path by default
[[ -s $SBX_GENERATED ]] || echo '[]' > "$SBX_GENERATED"
record_generated() {
  jq --arg t "$1" --arg i "$2" --arg p "$3" 'map(select(.id != $i)) + [{type: $t, id: $i, parent: $p}]' "$SBX_GENERATED" > "$SBX_GENERATED.tmp"
  mv "$SBX_GENERATED.tmp" "$SBX_GENERATED"
  guard target --type "$1" --id "$2" --parent "$3" --generated "$SBX_GENERATED"
  log "generated: $1 $2 (parent $3)"
}
