#!/usr/bin/env bash
# Phase 4 (#34), T1 (mandatory) and T1b. Run as ac-operator-sbx with EXECUTE=1 after 10-stand-in.sh.
#   T1   an unrelated update of SparesSite-sbx (the stub function's description) must leave the inline policies
#        that the stack does not manage on SparesSite-sbx-ServerFunctionRole unchanged.
#   T1b  the same when the update changes the role itself (its description). Recorded either way.
# Each inline policy is compared by name and by the SHA-256 of its document, before and after.
source "$(dirname "$0")/../lib.sh"
require_operator

STACK=SparesSite-sbx
ROLE=SparesSite-sbx-ServerFunctionRole
T=$SBX_ROOT/infra/sandbox/stand-in/sparessite-sbx.json
guard_target AWS::IAM::Role $ROLE

snapshot() {
  local p
  for p in $(aws iam list-role-policies --role-name $ROLE --query 'PolicyNames' --output text); do
    printf '%s %s\n' "$p" "$(aws iam get-role-policy --role-name $ROLE --policy-name "$p" --query PolicyDocument --output json | jq -cS . | sha256sum | cut -c1-16)"
  done | sort
  aws iam list-attached-role-policies --role-name $ROLE --query 'AttachedPolicies[].PolicyArn' --output text | tr '\t' '\n' | sort | sed 's/^/attached /'
}

run_test() { # NAME STANDIN_REVISION ROLE_REVISION EXPECTED_MODIFY
  local name=$1 before after
  before=$(snapshot)
  SBX_PARAMS="ParameterKey=StandInRevision,ParameterValue=$2 ParameterKey=RoleRevision,ParameterValue=$3" \
    changeset $STACK "$name" UPDATE "$T"
  [[ $EXECUTE == 1 ]] || return 0
  jq -r '[.Changes[].ResourceChange.LogicalResourceId] | join(",")' "$SBX_OUT/$STACK.$name.changeset.json" > "$SBX_OUT/$name.modified"
  after=$(snapshot)
  printf '%s\n' "$before" > "$SBX_OUT/$name.before"; printf '%s\n' "$after" > "$SBX_OUT/$name.after"
  if [[ $before == "$after" ]]; then
    log "$name PASS: modified [$(cat "$SBX_OUT/$name.modified")]; every inline policy and attachment unchanged"
  else
    diff "$SBX_OUT/$name.before" "$SBX_OUT/$name.after" >&2 || true
    log "$name FAIL: inline policies changed after modifying [$(cat "$SBX_OUT/$name.modified")]"
    [[ $name == t1 ]] && stop "T1 failed: this is a Phase 5 blocker"
  fi
}

run_test t1 2 1      # only the stub function changes
run_test t1b 2 2     # the role itself changes
