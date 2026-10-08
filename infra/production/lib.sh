# Phase 5 production step library. Source it from a step script. A person runs every step (PLAN.md, Boundaries).
#
#   require_caller                the account is 800960611664, the region eu-west-1, and the caller is the IAM user
#   changeset STACK NAME KIND TEMPLATE STEP [IMPORT_FILE]
#                                 create a change set, describe it, check it (import mode for IMPORT, update mode
#                                 otherwise) against the step file, and execute it only when the check passes, the
#                                 actions are exactly what the step file expects, and EXECUTE=1
#   create_shell STACK TEMPLATE   a new stack holding only its StackShell handle, with the acclinic execution role and
#                                 termination protection (an import cannot set a role; Phase 4 finding 14). No tags:
#                                 a stack tag could later be written to an imported resource
#   drift STACK                   detect drift; prints the stack status and writes per-resource results
#   protect STACK                 stack policy: deny Update:Replace and Update:Delete on every resource
#
# Step files (infra/production/steps/*.json): {step, stack, allowedPhysicalIds, s4rConsumedPhysicalIds,
# acknowledgedReferences, expectedChanges: [{action, logicalId, type, physicalId}]}.
set -euo pipefail

P5_ACCOUNT=800960611664
P5_REGION=eu-west-1
export AWS_REGION=$P5_REGION AWS_DEFAULT_REGION=$P5_REGION
P5_ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
P5_TOOLS=$P5_ROOT/tools/migration
P5_OUT=${P5_OUT:-$P5_ROOT/.migration-output/phase5}
P5_EXEC_ROLE=arn:aws:iam::$P5_ACCOUNT:role/cdk-acclinic-cfn-exec-role-$P5_ACCOUNT-$P5_REGION
EXECUTE=${EXECUTE:-0}
mkdir -p "$P5_OUT"

log() { printf '%s %s\n' "$(date -u +%H:%M:%S)" "$*" >&2; }
stop() { log "STOP: $*"; exit 1; }

require_caller() {
  local id; id=$(aws sts get-caller-identity --query '[Account,Arn]' --output text)
  [[ $id == "$P5_ACCOUNT"$'\t'arn:aws:iam::$P5_ACCOUNT:user/* ]] || stop "caller is not the IAM user in $P5_ACCOUNT"
  [[ $(aws configure get region 2>/dev/null || echo "$AWS_REGION") == "$P5_REGION" || $AWS_REGION == "$P5_REGION" ]] || stop "region"
  log "caller: $(cut -f2 <<<"$id" | sed 's|.*/||') in $P5_ACCOUNT/$P5_REGION"
}

# Every stack Phase 5 touches: never SparesSite-*, CDKToolkit or a sandbox name.
check_stack_name() { [[ $1 =~ ^(AcDataStack|AcRuntimeStack|ApplianceClinicToolkit)$ ]] || stop "stack $1 is not a Phase 5 stack"; }

# changeset STACK NAME KIND TEMPLATE STEP [IMPORT_FILE]
changeset() {
  local stack=$1 name=$2 kind=$3 template=$4 step=$5 import=${6:-} role=() describe mode
  check_stack_name "$stack"
  [[ $stack == ApplianceClinicToolkit ]] || role=(--role-arn "$P5_EXEC_ROLE")
  aws cloudformation delete-change-set --stack-name "$stack" --change-set-name "$name" 2>/dev/null && sleep 3 || true
  aws cloudformation create-change-set --stack-name "$stack" --change-set-name "$name" --change-set-type "$kind" \
    --template-body "file://$template" --capabilities CAPABILITY_NAMED_IAM "${role[@]}" \
    ${P5_PARAMS:+--parameters $P5_PARAMS} ${import:+--resources-to-import "file://$import"} --query Id --output text >/dev/null
  if ! aws cloudformation wait change-set-create-complete --stack-name "$stack" --change-set-name "$name" 2>/dev/null; then
    aws cloudformation describe-change-set --stack-name "$stack" --change-set-name "$name" --query '[Status,StatusReason]' --output text >&2
    stop "change set $stack/$name did not reach CREATE_COMPLETE"
  fi
  describe=$P5_OUT/$stack.$name.changeset.json
  aws cloudformation describe-change-set --stack-name "$stack" --change-set-name "$name" > "$describe"
  jq -r '.Changes[].ResourceChange | "  \(.Action) \(.LogicalResourceId) \(.ResourceType) \(.PhysicalResourceId // "") \(.Replacement // "")"' "$describe" >&2
  mode=update; [[ $kind == IMPORT ]] && mode=import
  if ! (cd "$P5_TOOLS" && npm run -s check:changeset -- --changeset "$describe" --mode $mode --step "$step" --template "$template") > "$describe.check"; then
    head -n -2 "$describe.check" | jq -c '.failures' >&2
    aws cloudformation delete-change-set --stack-name "$stack" --change-set-name "$name"
    stop "check:changeset ($mode) FAILED for $stack/$name (change set deleted)"
  fi
  # The actions must be exactly the step's: same logical IDs, types, actions and physical IDs, nothing else.
  if [[ $(jq -c 'has("expectedChanges")' "$step") == true ]]; then
    diff <(jq -S '[.Changes[].ResourceChange | {action: .Action, logicalId: .LogicalResourceId, type: .ResourceType, physicalId: (.PhysicalResourceId // null), replacement: (.Replacement // null)}] | sort_by(.logicalId)' "$describe") \
         <(jq -S '[.expectedChanges[] | {action, logicalId, type, physicalId: (.physicalId // null), replacement: (.replacement // null)}] | sort_by(.logicalId)' "$step") >&2 \
      || { aws cloudformation delete-change-set --stack-name "$stack" --change-set-name "$name"; stop "$stack/$name differs from the step's expected changes (change set deleted)"; }
  fi
  log "check:changeset ($mode) PASS and changes as expected: $stack/$name ($(jq '.Changes | length' "$describe") changes)"
  if [[ $EXECUTE != 1 ]]; then log "EXECUTE!=1: not executing $stack/$name"; return 0; fi
  aws cloudformation execute-change-set --stack-name "$stack" --change-set-name "$name"
  case $kind in
    CREATE) aws cloudformation wait stack-create-complete --stack-name "$stack" ;;
    IMPORT) aws cloudformation wait stack-import-complete --stack-name "$stack" ;;
    UPDATE) aws cloudformation wait stack-update-complete --stack-name "$stack" ;;
  esac || { aws cloudformation describe-stack-events --stack-name "$stack" --max-items 20 \
      --query 'StackEvents[].[LogicalResourceId,ResourceStatus,ResourceStatusReason]' --output text >&2; stop "$stack/$name failed"; }
  log "executed: $stack/$name -> $(aws cloudformation describe-stacks --stack-name "$stack" --query 'Stacks[0].StackStatus' --output text)"
}

# A stack in REVIEW_IN_PROGRESS is only the placeholder of a deleted CREATE change set (Phase 4 finding 10).
stack_exists() { local s; s=$(aws cloudformation describe-stacks --stack-name "$1" --query 'Stacks[0].StackStatus' --output text 2>/dev/null) && [[ $s != REVIEW_IN_PROGRESS ]]; }

create_shell() { # STACK TEMPLATE: the stack's CDK template synthesized for step "shell" (StackShell only)
  local stack=$1 t=$2 step=$P5_OUT/$1.shell.step.json
  check_stack_name "$stack"
  stack_exists "$stack" && { log "shell exists: $stack"; return 0; }
  [[ $(jq -c '[.Resources | to_entries[] | .value.Type] | unique' "$t") == '["AWS::CloudFormation::WaitConditionHandle"]' ]] || stop "$t is not a shell"
  jq -n --arg s "$stack" '{step: ("shell " + $s), expectedChanges: [{action: "Add", logicalId: "StackShell", type: "AWS::CloudFormation::WaitConditionHandle"}]}' > "$step"
  changeset "$stack" shell CREATE "$t" "$step"
  [[ $EXECUTE == 1 ]] || return 0
  aws cloudformation update-termination-protection --enable-termination-protection --stack-name "$stack" >/dev/null
  log "shell created: $stack (execution role $P5_EXEC_ROLE, termination protection on)"
}

drift() {
  local id s
  id=$(aws cloudformation detect-stack-drift --stack-name "$1" --query StackDriftDetectionId --output text)
  for _ in $(seq 1 60); do
    s=$(aws cloudformation describe-stack-drift-detection-status --stack-drift-detection-id "$id" --query '[DetectionStatus,StackDriftStatus]' --output text)
    [[ $s == DETECTION_IN_PROGRESS* ]] || break
    sleep 5
  done
  aws cloudformation describe-stack-resource-drifts --stack-name "$1" \
    --query 'StackResourceDrifts[].[LogicalResourceId,ResourceType,StackResourceDriftStatus]' --output text > "$P5_OUT/$1.drift.txt"
  echo "$s"
}

protect() {
  check_stack_name "$1"
  aws cloudformation set-stack-policy --stack-name "$1" --stack-policy-body '{"Statement":[{"Effect":"Allow","Principal":"*","Action":"Update:*","Resource":"*"},{"Effect":"Deny","Principal":"*","Action":["Update:Replace","Update:Delete"],"Resource":"*"}]}'
  log "stack policy: Update:Replace and Update:Delete denied on every resource of $1"
}

# expect_noop STACK TEMPLATE: an update with the same template must contain no changes.
expect_noop() {
  local name=noop-$(date +%s) out
  out=$(aws cloudformation create-change-set --stack-name "$1" --change-set-name "$name" --change-set-type UPDATE \
    --template-body "file://$2" --capabilities CAPABILITY_NAMED_IAM --role-arn "$P5_EXEC_ROLE" ${P5_PARAMS:+--parameters $P5_PARAMS} --query Id --output text)
  aws cloudformation wait change-set-create-complete --stack-name "$1" --change-set-name "$name" 2>/dev/null || true
  local why; why=$(aws cloudformation describe-change-set --stack-name "$1" --change-set-name "$name" --query StatusReason --output text)
  aws cloudformation delete-change-set --stack-name "$1" --change-set-name "$name"
  [[ $why == *"didn't contain changes"* ]] || stop "$1: the same template is not a no-op ($why)"
  log "no-op confirmed: $1"
}

# synth STEP: synthesize every stack for the step, offline and without credentials.
synth() {
  (cd "$P5_ROOT/infra/cdk" && env -u AWS_ACCESS_KEY_ID -u AWS_SECRET_ACCESS_KEY -u AWS_SESSION_TOKEN AWS_EC2_METADATA_DISABLED=true \
    CDK_DISABLE_VERSION_CHECK=1 npx cdk synth --quiet --no-notices -c step="$1" >/dev/null 2>&1) || stop "cdk synth failed for step $1"
}
