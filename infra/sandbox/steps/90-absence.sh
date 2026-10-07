#!/usr/bin/env bash
# Phase 4 absence check (#34, runbook section 5, Destroy and recreate, step 4). READ-ONLY.
#
# Confirms that no allowlisted name exists. With KEEP_CONTROLS=1 (after 80-destroy.sh, before the final teardown),
# the approval point A controls must still exist and everything else must be gone. Run as ac-operator-sbx while it
# exists, or as the IAM user after the final teardown. Only a not-found answer counts as absent; any other error
# (AccessDenied, throttling) is a STOP, never "absent".
set -euo pipefail
SBX_ROOT=$(cd "$(dirname "$0")/../../.." && pwd)
AL=$SBX_ROOT/docs/migration/sandbox-allowlist.json
export AWS_REGION=eu-west-1 AWS_DEFAULT_REGION=eu-west-1
A=800960611664
KEEP_CONTROLS=${KEEP_CONTROLS:-0}
CONTROLS=" ac-operator-sbx ac-operator-policy-sbx ac-cfn-execution-sbx ac-deny-production-sbx ac-budget-sbx ApplianceClinicSandboxToolkit \
  cdk-acsbx-cfn-exec-role-$A-eu-west-1 cdk-acsbx-deploy-role-$A-eu-west-1 cdk-acsbx-file-publishing-role-$A-eu-west-1 \
  cdk-acsbx-image-publishing-role-$A-eu-west-1 cdk-acsbx-lookup-role-$A-eu-west-1 cdk-acsbx-assets-$A-eu-west-1 \
  cdk-acsbx-container-assets-$A-eu-west-1 /cdk-bootstrap/acsbx/version \
  cdk-acsbx-file-publishing-role-default-policy-$A-eu-west-1 cdk-acsbx-image-publishing-role-default-policy-$A-eu-west-1 "
present=() absent=0 kept=0

# probe CMD...: 0 if found, 1 if the service answered not-found, STOP otherwise.
probe() {
  local out
  if out=$("$@" 2>&1); then return 0; fi
  if grep -qiE 'NotFound|NoSuchEntity|NoSuchBucket|Not Found|\(404\)|does not exist|ResourceNotFound|RepositoryNotFound|ParameterNotFound' <<<"$out"; then return 1; fi
  echo "STOP: could not tell whether it exists: $* -> $out" >&2; exit 1
}
exists() { # TYPE NAME
  local type=$1 n=$2
  case $type in
    AWS::Lambda::Function) probe aws lambda get-function --function-name "$n" ;;
    AWS::Logs::LogGroup) [[ -n $(aws logs describe-log-groups --log-group-name-prefix "$n" --query "logGroups[?logGroupName=='$n'].logGroupName" --output text) ]] ;;
    AWS::IAM::Role|AWS::IAM::Role\(toolkit\)) probe aws iam get-role --role-name "$n" ;;
    AWS::IAM::RolePolicy) probe aws iam get-role-policy --role-name "${n%%/*}" --policy-name "${n#*/}" ;;
    AWS::IAM::Policy|AWS::IAM::Policy\(toolkit\)) # inline policies: on any role of the allowlist that still exists
      local r; for r in $(jq -r '.names["AWS::IAM::Role"][], .names["AWS::IAM::Role(toolkit)"][]' "$AL"); do
        aws iam get-role-policy --role-name "$r" --policy-name "$n" >/dev/null 2>&1 && return 0; done; return 1 ;;
    AWS::IAM::ManagedPolicy) probe aws iam get-policy --policy-arn "arn:aws:iam::$A:policy/$n" ;;
    AWS::DynamoDB::Table) probe aws dynamodb describe-table --table-name "$n" ;;
    AWS::S3::Bucket) probe aws s3api head-bucket --bucket "$n" ;;
    AWS::S3::BucketPolicy|AWS::S3::BucketPolicy\(toolkit\)) probe aws s3api head-bucket --bucket "$n" ;;   # goes with its bucket
    AWS::ECR::Repository) probe aws ecr describe-repositories --repository-names "$n" ;;
    AWS::SecretsManager::Secret) probe aws secretsmanager describe-secret --secret-id "$n" ;;
    AWS::Events::Rule) probe aws events describe-rule --name "$n" ;;
    AWS::ApiGatewayV2::Api) [[ -n $(aws apigatewayv2 get-apis --query "Items[?Name=='$n'].ApiId" --output text) ]] ;;
    AWS::Cognito::UserPool) [[ -n $(aws cognito-idp list-user-pools --max-results 60 --query "UserPools[?Name=='$n'].Id" --output text) ]] ;;
    AWS::Cognito::UserPoolClient) [[ -n $(aws cognito-idp list-user-pools --max-results 60 --query "UserPools[?Name=='SparesSite-sbx-UserPool'].Id" --output text) ]] ;;  # goes with its pool
    AWS::CloudFormation::Stack) probe aws cloudformation describe-stacks --stack-name "$n" ;;
    AWS::SSM::Parameter) probe aws ssm get-parameter --name "$n" ;;
    AWS::Budgets::Budget) probe aws budgets describe-budget --region us-east-1 --account-id "$A" --budget-name "$n" ;;
    AWS::CloudFront::Distribution\(placeholder\)) return 1 ;;   # never created: the sandbox only references it
    *) echo "STOP: no absence probe for $type" >&2; exit 1 ;;
  esac
}

while IFS=$'\t' read -r type n; do
  if [[ $KEEP_CONTROLS == 1 && $CONTROLS == *" $n "* ]]; then
    exists "$type" "$n" || { echo "STOP: control $n is missing" >&2; exit 1; }
    kept=$((kept + 1)); continue
  fi
  if exists "$type" "$n"; then present+=("$type $n"); else absent=$((absent + 1)); fi
done < <(jq -r '.names | to_entries[] | .key as $t | .value[] | [$t, .] | @tsv' "$AL")

total=$(jq '[.names[] | length] | add' "$AL")
(( absent + kept + ${#present[@]} == total && total > 0 )) || { echo "STOP: checked $((absent + kept + ${#present[@]})) of $total names" >&2; exit 1; }
if ((${#present[@]})); then printf 'still present: %s\n' "${present[@]}" >&2; exit 1; fi
echo "absent: $absent allowlisted names$( ((KEEP_CONTROLS)) && echo "; approval point A controls present as expected: $kept")"
