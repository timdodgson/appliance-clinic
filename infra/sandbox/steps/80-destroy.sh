#!/usr/bin/env bash
# Phase 4 destroy (#34, runbook section 5, Destroy and recreate, step 1). Run as ac-operator-sbx.
#
# Deletes the rehearsal stacks, then every retained resource, by allowlisted name only: each deletion is preceded by
# sandbox:guard target. The approval point A controls (ac-operator-sbx, its policies, ac-budget-sbx and
# ApplianceClinicSandboxToolkit) stay; the final teardown removes them as the IAM user (approval-a/README.md,
# Cleanup and rollback). Idempotent: anything already gone is skipped.
source "$(dirname "$0")/../lib.sh"
require_operator
A=$SBX_ACCOUNT
gone() { log "deleted: $*"; }
exists_stack() { aws cloudformation describe-stacks --stack-name "$1" >/dev/null 2>&1; }

# --- 1. Stacks: termination protection off, then delete. Every resource is Retain, so all of them stay ---------
for s in AcRuntimeStack-sbx AcDataStack-sbx AcIamExperiments-sbx SparesSite-sbx; do
  exists_stack "$s" || continue
  guard_target AWS::CloudFormation::Stack "$s"
  aws cloudformation update-termination-protection --no-enable-termination-protection --stack-name "$s" >/dev/null
  aws cloudformation delete-stack --stack-name "$s"
  aws cloudformation wait stack-delete-complete --stack-name "$s" || stop "delete of $s did not complete"
  n=$(aws cloudformation list-stack-resources --stack-name "$(aws cloudformation list-stacks --stack-status-filter DELETE_COMPLETE \
      --query "StackSummaries[?StackName=='$s'] | [0].StackId" --output text)" --query 'length(StackResourceSummaries[?ResourceStatus!=`DELETE_SKIPPED`])' --output text 2>/dev/null || echo "?")
  gone "stack $s (resources deleted rather than retained: $n, the StackShell handle in a shell-created stack)"
done

# --- 2. Functions and their log groups (URLs and permissions go with the function) ----------------------------
for f in whichpart-api-sbx spares4repairs-part-finder-sbx spares4repairs-diag-orchestrator-sbx spares4repairs-error-code-mcp-sbx spares4repairs-server-sbx; do
  if aws lambda get-function --function-name "$f" >/dev/null 2>&1; then guard_target AWS::Lambda::Function "$f"; aws lambda delete-function --function-name "$f"; gone "function $f"; fi
  lg=/aws/lambda/$f
  if [[ -n $(aws logs describe-log-groups --log-group-name-prefix "$lg" --query "logGroups[?logGroupName=='$lg'].logGroupName" --output text) ]]; then
    guard_target AWS::Logs::LogGroup "$lg"; aws logs delete-log-group --log-group-name "$lg"; gone "log group $lg"
  fi
done

# --- 3. Rules (targets first) ---------------------------------------------------------------------------------
for r in whichpart-recall-ingest-daily-sbx whichpart-transcript-review-sbx; do
  aws events describe-rule --name "$r" >/dev/null 2>&1 || continue
  guard_target AWS::Events::Rule "$r"
  ids=$(aws events list-targets-by-rule --rule "$r" --query 'Targets[].Id' --output text)
  [[ -z $ids ]] || aws events remove-targets --rule "$r" --ids $ids >/dev/null
  aws events delete-rule --name "$r"; gone "rule $r"
done

# --- 4. Roles: inline policies, the managed attachment, then the role (never ac-operator-sbx) ----------------
for r in $(jq -r '.names["AWS::IAM::Role"][] | select(. != "ac-operator-sbx")' "$SBX_ROOT/docs/migration/sandbox-allowlist.json"); do
  aws iam get-role --role-name "$r" >/dev/null 2>&1 || continue
  guard_target AWS::IAM::Role "$r"
  for p in $(aws iam list-role-policies --role-name "$r" --query 'PolicyNames[]' --output text); do aws iam delete-role-policy --role-name "$r" --policy-name "$p"; done
  for p in $(aws iam list-attached-role-policies --role-name "$r" --query 'AttachedPolicies[].PolicyArn' --output text); do aws iam detach-role-policy --role-name "$r" --policy-arn "$p"; done
  aws iam delete-role --role-name "$r"; gone "role $r"
done

# --- 5. Data: tables, buckets, repositories, secrets ----------------------------------------------------------
for t in $(jq -r '.names["AWS::DynamoDB::Table"][]' "$SBX_ROOT/docs/migration/sandbox-allowlist.json"); do
  aws dynamodb describe-table --table-name "$t" >/dev/null 2>&1 || continue
  guard_target AWS::DynamoDB::Table "$t"; aws dynamodb delete-table --table-name "$t" >/dev/null; aws dynamodb wait table-not-exists --table-name "$t"; gone "table $t"
done
for b in whichpart-web-sbx-$A whichpart-learning-sbx-$A applianceclinic-migration-backup-sbx-$A; do
  aws s3api head-bucket --bucket "$b" 2>/dev/null || continue
  guard_target AWS::S3::Bucket "$b"
  [[ $(aws s3api get-bucket-versioning --bucket "$b" --query Status --output text) == None ]] || stop "$b is versioned: delete its versions by hand"
  aws s3 rb "s3://$b" --force >/dev/null; gone "bucket $b"
done
for r in spares4repairs-diag-orchestrator-sbx spares4repairs-error-code-mcp-sbx; do
  aws ecr describe-repositories --repository-names "$r" >/dev/null 2>&1 || continue
  guard_target AWS::ECR::Repository "$r"; aws ecr delete-repository --repository-name "$r" --force >/dev/null; gone "repository $r"
done
for s in $(jq -r '.names["AWS::SecretsManager::Secret"][]' "$SBX_ROOT/docs/migration/sandbox-allowlist.json"); do
  aws secretsmanager describe-secret --secret-id "$s" >/dev/null 2>&1 || continue
  guard_target AWS::SecretsManager::Secret "$s"
  # Without recovery, so a recreate can use the name at once. The values were dummies.
  aws secretsmanager delete-secret --secret-id "$s" --force-delete-without-recovery >/dev/null; gone "secret $s"
done

# --- 6. Stand-in API and user pools: found by allowlisted name and the sandbox tag, recorded, then deleted -----
for id in $(aws apigatewayv2 get-apis --query "Items[?Name=='spares4repairs-sbx' && Tags.\"ac:sandbox\"=='phase-4'].ApiId" --output text); do
  record_generated AWS::ApiGatewayV2::ApiId "$id" spares4repairs-sbx
  aws apigatewayv2 delete-api --api-id "$id"; gone "API spares4repairs-sbx ($id)"
done
for id in $(aws cognito-idp list-user-pools --max-results 60 --query "UserPools[?Name=='SparesSite-sbx-UserPool'].Id" --output text); do
  [[ $(aws cognito-idp describe-user-pool --user-pool-id "$id" --query 'UserPool.UserPoolTags."ac:sandbox"' --output text) == phase-4 ]] || stop "pool $id has no sandbox tag"
  record_generated AWS::Cognito::UserPoolId "$id" SparesSite-sbx-UserPool
  aws cognito-idp delete-user-pool --user-pool-id "$id"; gone "user pool SparesSite-sbx-UserPool ($id)"
done

# Generated IDs of deleted resources are never valid again; a recreate records its own.
echo '[]' > "$SBX_GENERATED"
log "destroy complete: only the approval point A controls remain"
