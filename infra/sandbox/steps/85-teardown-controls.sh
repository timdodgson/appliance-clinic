#!/usr/bin/env bash
# Phase 4 final teardown of the approval point A controls (#34; approval-a/README.md, Cleanup and rollback).
# Run as the IAM user that ran approval point A, after 80-destroy.sh: the controls deny the operator any change to
# themselves. Every deletion is preceded by sandbox:guard target, by allowlisted name only. Idempotent.
set -euo pipefail
SBX_ROOT=$(cd "$(dirname "$0")/../../.." && pwd)
export AWS_REGION=eu-west-1 AWS_DEFAULT_REGION=eu-west-1
A=800960611664
R=eu-west-1
log() { printf '%s %s\n' "$(date -u +%H:%M:%S)" "$*" >&2; }
stop() { log "STOP: $*"; exit 1; }
target() { (cd "$SBX_ROOT/tools/migration" && npm run -s sandbox:guard -- target --type "$1" --id "$2") >/dev/null || stop "guard refused $1 $2"; }

[[ $(aws sts get-caller-identity --query Account --output text) == "$A" ]] || stop "wrong account"
[[ $(aws sts get-caller-identity --query Arn --output text) == arn:aws:iam::$A:user/* ]] || stop "run as the IAM user"
aws cloudformation describe-stacks --stack-name AcRuntimeStack-sbx >/dev/null 2>&1 && stop "run 80-destroy.sh first"

S=ApplianceClinicSandboxToolkit
if aws cloudformation describe-stacks --stack-name $S >/dev/null 2>&1; then
  target AWS::CloudFormation::Stack $S
  aws cloudformation update-termination-protection --no-enable-termination-protection --stack-name $S >/dev/null
  aws cloudformation delete-stack --stack-name $S        # Retain: its resources stay, and are deleted below
  aws cloudformation wait stack-delete-complete --stack-name $S
  log "deleted: stack $S"
fi

B=cdk-acsbx-assets-$A-$R
if aws s3api head-bucket --bucket "$B" 2>/dev/null; then
  target AWS::S3::Bucket "$B"
  # The CDK asset bucket is versioned: every version and delete marker goes before the bucket.
  while :; do
    batch=$(aws s3api list-object-versions --bucket "$B" --max-items 500 --output json \
      | jq -c '{Objects: ([.Versions[]?, .DeleteMarkers[]?] | map({Key, VersionId})), Quiet: true}')
    [[ $(jq '.Objects | length' <<<"$batch") == 0 ]] && break
    aws s3api delete-objects --bucket "$B" --delete "$batch" >/dev/null
  done
  aws s3api delete-bucket --bucket "$B"; log "deleted: bucket $B"
fi

E=cdk-acsbx-container-assets-$A-$R
if aws ecr describe-repositories --repository-names "$E" >/dev/null 2>&1; then
  target AWS::ECR::Repository "$E"; aws ecr delete-repository --repository-name "$E" --force >/dev/null; log "deleted: repository $E"
fi

P=/cdk-bootstrap/acsbx/version
if aws ssm get-parameter --name $P >/dev/null 2>&1; then target AWS::SSM::Parameter $P; aws ssm delete-parameter --name $P; log "deleted: parameter $P"; fi

for r in file-publishing image-publishing lookup deploy cfn-exec; do
  role=cdk-acsbx-$r-role-$A-$R
  aws iam get-role --role-name "$role" >/dev/null 2>&1 || continue
  target AWS::IAM::Role "$role"
  for p in $(aws iam list-attached-role-policies --role-name "$role" --query 'AttachedPolicies[].PolicyArn' --output text); do aws iam detach-role-policy --role-name "$role" --policy-arn "$p"; done
  for p in $(aws iam list-role-policies --role-name "$role" --query 'PolicyNames[]' --output text); do aws iam delete-role-policy --role-name "$role" --policy-name "$p"; done
  aws iam delete-role --role-name "$role"; log "deleted: role $role"
done

if aws budgets describe-budget --region us-east-1 --account-id $A --budget-name ac-budget-sbx >/dev/null 2>&1; then
  target AWS::Budgets::Budget ac-budget-sbx
  aws budgets delete-budget --region us-east-1 --account-id $A --budget-name ac-budget-sbx; log "deleted: budget ac-budget-sbx"
fi

if aws iam get-role --role-name ac-operator-sbx >/dev/null 2>&1; then
  target AWS::IAM::Role ac-operator-sbx
  for p in $(aws iam list-attached-role-policies --role-name ac-operator-sbx --query 'AttachedPolicies[].PolicyArn' --output text); do aws iam detach-role-policy --role-name ac-operator-sbx --policy-arn "$p"; done
  aws iam delete-role --role-name ac-operator-sbx; log "deleted: role ac-operator-sbx"
fi

for p in ac-operator-policy-sbx ac-cfn-execution-sbx ac-deny-production-sbx; do
  arn=arn:aws:iam::$A:policy/$p
  aws iam get-policy --policy-arn "$arn" >/dev/null 2>&1 || continue
  target AWS::IAM::ManagedPolicy "$p"
  # A managed policy is deleted only once nothing uses it and its non-default versions are gone.
  [[ $(aws iam get-policy --policy-arn "$arn" --query Policy.AttachmentCount --output text) == 0 ]] || stop "$p is still attached"
  for v in $(aws iam list-policy-versions --policy-arn "$arn" --query 'Versions[?!IsDefaultVersion].VersionId' --output text); do aws iam delete-policy-version --policy-arn "$arn" --version-id "$v"; done
  aws iam delete-policy --policy-arn "$arn"; log "deleted: policy $p"
done
log "teardown complete: run 90-absence.sh"
