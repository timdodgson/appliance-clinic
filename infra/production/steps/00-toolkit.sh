#!/usr/bin/env bash
# Phase 5 entry (PLAN.md; ADR 0005): the dedicated toolkit ApplianceClinicToolkit, qualifier acclinic.
# Run as the IAM user with EXECUTE=1. Documents: docs/migration/phase-5/toolkit/ (rendered and tested by
# tools/migration, `npm run production:toolkit -- --check`).
#
#   1. Create the managed policies ac-cfn-execution (read-only on AC resources) and ac-deny-s4r, or confirm the
#      existing ones match the committed documents exactly.
#   2. Create the toolkit stack from the patched bootstrap template, as a checked change set of Add actions only.
#   3. Turn on termination protection; confirm the execution role carries exactly the two policies.
#   4. IAM simulator (read-only): S4R writes and AC writes are denied to the execution role; AC reads are allowed.
source "$(dirname "$0")/../lib.sh"
require_caller
D=$P5_ROOT/docs/migration/phase-5/toolkit
(cd "$P5_TOOLS" && npm run -s production:toolkit -- --check) >&2 || stop "toolkit documents are stale"
A=$P5_ACCOUNT

for p in ac-cfn-execution ac-deny-s4r; do
  arn=arn:aws:iam::$A:policy/$p
  if aws iam get-policy --policy-arn "$arn" >/dev/null 2>&1; then
    v=$(aws iam get-policy --policy-arn "$arn" --query Policy.DefaultVersionId --output text)
    diff <(aws iam get-policy-version --policy-arn "$arn" --version-id "$v" --query PolicyVersion.Document --output json | jq -S .) <(jq -S . "$D/$p.json") >&2 \
      || stop "$p differs from the committed document"
    log "policy matches: $p ($v)"
  elif [[ $EXECUTE == 1 ]]; then
    aws iam create-policy --policy-name "$p" --policy-document "file://$D/$p.json" \
      --description "Appliance Clinic Phase 5 (docs/migration/phase-5/toolkit/$p.json)" >/dev/null
    log "policy created: $p"
  else log "EXECUTE!=1: would create policy $p"; fi
done

S=ApplianceClinicToolkit
if ! stack_exists $S; then
  step=$P5_OUT/toolkit.step.json
  jq -n '{step: "phase-5-toolkit", description: "Create ApplianceClinicToolkit: Add actions only."}' > "$step"
  changeset $S create-1 CREATE "$D/bootstrap-acclinic.json" "$step"
  [[ $(jq -r '[.Changes[].ResourceChange.Action] | unique | join(",")' "$P5_OUT/$S.create-1.changeset.json") == Add ]] || stop "toolkit change set has actions other than Add"
fi
[[ $EXECUTE == 1 ]] || exit 0
aws cloudformation update-termination-protection --enable-termination-protection --stack-name $S >/dev/null
[[ $(aws cloudformation describe-stacks --stack-name $S --query 'Stacks[0].Parameters[?ParameterKey==`Qualifier`].ParameterValue' --output text) == acclinic ]] || stop "qualifier"

R=cdk-acclinic-cfn-exec-role-$A-$P5_REGION
diff <(aws iam list-attached-role-policies --role-name $R --query 'AttachedPolicies[].PolicyName' --output json | jq -S 'sort') \
     <(jq -n '["ac-cfn-execution","ac-deny-s4r"]') >&2 || stop "$R does not carry exactly the two policies"
[[ $(aws iam list-role-policies --role-name $R --query 'length(PolicyNames)') == 0 ]] || stop "$R has inline policies"
log "toolkit $S ready: termination protection on; $R carries exactly ac-cfn-execution and ac-deny-s4r"

sim() { # ACTION RESOURCE -> decision
  aws iam simulate-principal-policy --policy-source-arn "arn:aws:iam::$A:role/$R" --action-names "$1" --resource-arns "$2" \
    --context-entries ContextKeyName=aws:RequestedRegion,ContextKeyValues=$P5_REGION,ContextKeyType=string \
    --query 'EvaluationResults[0].EvalDecision' --output text
}
S4R_ROLE=arn:aws:iam::$A:role/SparesSite-dev-ServerFunctionRoleC337EDB9-7aUzUc2qUHib
for check in "iam:PutRolePolicy $S4R_ROLE explicitDeny" "iam:PassRole $S4R_ROLE explicitDeny" \
  "cloudformation:UpdateStack arn:aws:cloudformation:$P5_REGION:$A:stack/SparesSite-dev/* explicitDeny" \
  "apigateway:PATCH arn:aws:apigateway:$P5_REGION::/apis/65vnizdmk4 explicitDeny" \
  "lambda:UpdateFunctionConfiguration arn:aws:lambda:$P5_REGION:$A:function:spares4repairs-part-finder implicitDeny" \
  "lambda:GetFunction arn:aws:lambda:$P5_REGION:$A:function:spares4repairs-part-finder allowed" \
  "dynamodb:UpdateTable arn:aws:dynamodb:$P5_REGION:$A:table/whichpart-transcripts implicitDeny" \
  "dynamodb:DescribeTable arn:aws:dynamodb:$P5_REGION:$A:table/whichpart-transcripts allowed" \
  "s3:GetObject arn:aws:s3:::whichpart-learning-$A/any implicitDeny" \
  "secretsmanager:GetSecretValue arn:aws:secretsmanager:$P5_REGION:$A:secret:spares4repairs/diag-orchestrator/bearer-token-v1PtZH implicitDeny"; do
  set -- $check
  got=$(sim "$1" "$2"); [[ $got == "$3" ]] || stop "simulator: $1 on $2 is $got, expected $3"
  log "simulator: $1 on ${2##*:} -> $got"
done
