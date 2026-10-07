#!/usr/bin/env bash
# Phase 4 (#34), IAM experiments T2 to T7 on AcIamExperiments-sbx. Run as ac-operator-sbx with EXECUTE=1.
# Resumable: each stage runs only if the stack is not already past it. Results go to $SBX_OUT/iam-results.txt.
source "$(dirname "$0")/../lib.sh"
require_operator

STACK=AcIamExperiments-sbx
I=$SBX_ROOT/infra/sandbox/iam
RES=$SBX_OUT/iam-results.txt
touch "$RES"
result() { log "$*"; echo "$*" >> "$RES"; }
policies() { aws iam list-role-policies --role-name "$1" --query 'PolicyNames' --output text | tr '\t' ' '; }
attached() { aws iam list-attached-role-policies --role-name "$1" --query 'AttachedPolicies[].PolicyName' --output text | tr '\t' ' '; }
role_exists() { aws iam get-role --role-name "$1" >/dev/null 2>&1; }
put() { # ROLE POLICY DOC-TAG
  guard_target AWS::IAM::RolePolicy "$1/$2"
  node -e "import('$I/experiments.mjs').then(m => process.stdout.write(JSON.stringify(m.doc('$3'))))" > "$SBX_OUT/doc.json"
  aws iam put-role-policy --role-name "$1" --policy-name "$2" --policy-document "file://$SBX_OUT/doc.json"
}

for n in 2 3 4 5 6 7; do guard_target AWS::IAM::Role iam-t$n-role-sbx; done

# --- T2: Role.Policies and an undeclared inline policy -------------------------------------------------
if needs_create $STACK; then changeset $STACK stage-1 CREATE "$I/stage-1.json"; fi
[[ $EXECUTE == 1 ]] || exit 0
if ! aws iam get-role-policy --role-name iam-t2-role-sbx --policy-name iam-t2-policy-sbx --query PolicyDocument --output json | grep -q '/v2/'; then
  put iam-t2-role-sbx iam-t2-unmanaged-sbx t2-unmanaged
  result "T2 before update: inline [$(policies iam-t2-role-sbx)]"
  changeset $STACK stage-2 UPDATE "$I/stage-2.json"
  after=$(policies iam-t2-role-sbx)
  if [[ $after == *iam-t2-unmanaged-sbx* ]]; then result "T2 RESULT: undeclared inline policy SURVIVED a Role.Policies update: [$after]"
  else result "T2 RESULT: undeclared inline policy REMOVED by a Role.Policies update: [$after]"; fi
fi

# --- T3 to T7: roles created outside CloudFormation, then imported --------------------------------------
if ! in_stack $STACK T3Role; then
  for n in 3 4 5 6 7; do
    r=iam-t$n-role-sbx
    if ! role_exists $r; then
      node -e "import('$I/experiments.mjs').then(m => process.stdout.write(JSON.stringify(m.roleProps($n).AssumeRolePolicyDocument)))" > "$SBX_OUT/trust.json"
      aws iam create-role --role-name $r --description "Phase 4 IAM experiment T$n" --assume-role-policy-document "file://$SBX_OUT/trust.json" \
        --permissions-boundary arn:aws:iam::$SBX_ACCOUNT:policy/ac-cfn-execution-sbx --tags "${SBX_TAGS[@]}" >/dev/null
      log "created outside CloudFormation: $r"
    fi
    [[ $n != 7 ]] && put $r iam-t$n-policy-sbx t$n && put $r iam-t$n-unmanaged-sbx t$n-unmanaged
    if [[ $n == 3 || $n == 7 ]]; then
      aws iam attach-role-policy --role-name $r --policy-arn arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole
    fi
  done
  sleep 10   # IAM eventual consistency before the import reads the roles
  changeset $STACK stage-3 IMPORT "$I/stage-3.json" "$I/import-3.json"
  actions=$(jq -r '[.Changes[].ResourceChange.Action] | unique | join(",")' "$SBX_OUT/$STACK.stage-3.changeset.json")
  result "T3-T7 import: change-set actions [$actions] ($(jq '.Changes | length' "$SBX_OUT/$STACK.stage-3.changeset.json") changes)"
  [[ $actions == Import ]] || stop "the import change set contains actions other than Import"
fi

# --- T4: drift after import ---------------------------------------------------------------------------
if in_stack $STACK T6Role; then
  s=$(drift $STACK)
  result "T4 drift after import: stack $s; $(tr '\t\n' ': ' < "$SBX_OUT/$STACK.drift.txt")"
  grep -q '^T4Policy	IN_SYNC' "$SBX_OUT/$STACK.drift.txt" && grep -q '^T4Role	IN_SYNC' "$SBX_OUT/$STACK.drift.txt" \
    && result "T4 RESULT: PASS: RolePolicy imported with Import actions only, document unchanged, drift IN_SYNC" \
    || result "T4 RESULT: FAIL: imported RolePolicy or role not IN_SYNC"
  grep -q '^T2Role	MODIFIED' "$SBX_OUT/$STACK.drift.txt" \
    && result "T2 NOTE: drift detection reports the undeclared inline policy on a Role.Policies role as MODIFIED"

  # --- T3, T5, T6, T7: one update -----------------------------------------------------------------------
  before3="$(policies iam-t3-role-sbx) | $(attached iam-t3-role-sbx)"
  changeset $STACK stage-4 UPDATE "$I/stage-4.json"
  after3="$(policies iam-t3-role-sbx) | $(attached iam-t3-role-sbx)"
  [[ $before3 == "$after3" ]] && result "T3 RESULT: PASS: updating an imported role without Policies left [$after3] unchanged" \
    || result "T3 RESULT: FAIL: [$before3] became [$after3]"
  p5=$(policies iam-t5-role-sbx)
  [[ $p5 == *iam-t5-policy-sbx* ]] && result "T5 RESULT: PASS: RolePolicy removed from the stack with Retain stays on the role: [$p5]" \
    || result "T5 RESULT: FAIL: iam-t5-policy-sbx gone: [$p5]"
  if role_exists iam-t6-role-sbx; then result "T6 RESULT: PASS: role removed from the stack with Retain stays, with [$(policies iam-t6-role-sbx)]"
  else result "T6 RESULT: FAIL: iam-t6-role-sbx was deleted"; fi
  a7=$(attached iam-t7-role-sbx)
  if [[ $a7 == *AWSLambdaBasicExecutionRole* ]]; then result "T7 RESULT: removing ManagedPolicyArns from the template left AWSLambdaBasicExecutionRole attached"
  else result "T7 RESULT: removing ManagedPolicyArns from the template DETACHED AWSLambdaBasicExecutionRole. Rule: always declare it"; fi
fi
cat "$RES" >&2
