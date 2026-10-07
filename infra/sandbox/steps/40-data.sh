#!/usr/bin/env bash
# Phase 4 (#34), data imports (Phase 5 steps 5.1 to 5.4) into AcDataStack-sbx. Run as ac-operator-sbx with EXECUTE=1.
#   1. Create each -sbx resource outside CloudFormation with the production configuration (Phase 0 inventory),
#      and seed synthetic data only.
#   2. Import them all with one import-only change set (CDK L1 template, acsbx execution role).
#   3. Confirm an unchanged template is a no-op, and that drift detection is clean.
source "$(dirname "$0")/../lib.sh"
require_operator

STACK=AcDataStack-sbx
CDK=$SBX_ROOT/infra/sandbox/cdk
T=$CDK/cdk.out/$STACK.template.json
A=$SBX_ACCOUNT
TBL_T=whichpart-transcripts-sbx TBL_R=whichpart-recalls-sbx
WEB=whichpart-web-sbx-$A LEARN=whichpart-learning-sbx-$A BACKUP=applianceclinic-migration-backup-sbx-$A
REPOS=(spares4repairs-diag-orchestrator-sbx spares4repairs-error-code-mcp-sbx)
SECRETS=(ai-config openai jev canonical-state-token benchmark-service diag-orchestrator/bearer-token error-code-mcp/bearer-token)

(cd "$CDK" && env -u AWS_ACCESS_KEY_ID -u AWS_SECRET_ACCESS_KEY -u AWS_SESSION_TOKEN AWS_EC2_METADATA_DISABLED=true \
  CDK_DISABLE_VERSION_CHECK=1 npx cdk synth --quiet --no-notices >/dev/null 2>&1) || stop "cdk synth failed"
guard document --file "$T"

for r in "${REPOS[@]}"; do guard_target AWS::ECR::Repository "$r"; done
for s in "${SECRETS[@]}"; do guard_target AWS::SecretsManager::Secret "applianceclinic-sbx/$s"; done
for t in $TBL_T $TBL_R; do guard_target AWS::DynamoDB::Table $t; done
for b in $WEB $LEARN $BACKUP; do guard_target AWS::S3::Bucket $b; done
guard_target AWS::S3::BucketPolicy $WEB

if needs_create $STACK; then
  [[ $EXECUTE == 1 ]] || { log "EXECUTE!=1: would create the data resources and import them"; exit 0; }

  # --- ECR: production configuration ---
  for r in "${REPOS[@]}"; do
    aws ecr describe-repositories --repository-names "$r" >/dev/null 2>&1 || aws ecr create-repository --repository-name "$r" \
      --image-tag-mutability MUTABLE --image-scanning-configuration scanOnPush=true \
      --encryption-configuration encryptionType=AES256 --tags Key=ac:sandbox,Value=phase-4 >/dev/null
  done

  # --- Secrets: dummy values only, never written anywhere ---
  for s in "${SECRETS[@]}"; do
    aws secretsmanager describe-secret --secret-id "applianceclinic-sbx/$s" >/dev/null 2>&1 || aws secretsmanager create-secret \
      --name "applianceclinic-sbx/$s" --secret-string "sandbox-dummy-$(openssl rand -hex 12)" --tags Key=ac:sandbox,Value=phase-4 >/dev/null
  done

  # --- DynamoDB: both production shapes ---
  make_table() { # NAME SORT
    aws dynamodb describe-table --table-name "$1" >/dev/null 2>&1 && return 0
    aws dynamodb create-table --table-name "$1" --billing-mode PAY_PER_REQUEST \
      --attribute-definitions AttributeName=pk,AttributeType=S AttributeName=gsiPk,AttributeType=S AttributeName="$2",AttributeType=S \
      --key-schema AttributeName=pk,KeyType=HASH \
      --global-secondary-indexes "IndexName=gsi_activity,KeySchema=[{AttributeName=gsiPk,KeyType=HASH},{AttributeName=$2,KeyType=RANGE}],Projection={ProjectionType=ALL}" \
      --table-class STANDARD --no-deletion-protection-enabled --tags Key=ac:sandbox,Value=phase-4 >/dev/null
    aws dynamodb wait table-exists --table-name "$1"
  }
  make_table $TBL_T lastActivityAt
  make_table $TBL_R gsiSk
  aws dynamodb update-time-to-live --table-name $TBL_T --time-to-live-specification Enabled=true,AttributeName=expiresAt >/dev/null || true
  for t in $TBL_T $TBL_R; do
    aws dynamodb update-continuous-backups --table-name $t --point-in-time-recovery-specification PointInTimeRecoveryEnabled=true >/dev/null
  done
  node "$SBX_ROOT/infra/sandbox/synthetic-data.mjs" seed-tables "$SBX_OUT/seed" && for f in "$SBX_OUT"/seed/*.json; do
    aws dynamodb batch-write-item --request-items "file://$f" --query 'length(UnprocessedItems)' --output text >/dev/null
  done

  # --- S3: production configuration, synthetic objects ---
  for b in $WEB $LEARN $BACKUP; do
    aws s3api head-bucket --bucket $b 2>/dev/null || aws s3api create-bucket --bucket $b --create-bucket-configuration LocationConstraint=$SBX_REGION >/dev/null
    aws s3api put-bucket-ownership-controls --bucket $b --ownership-controls 'Rules=[{ObjectOwnership=BucketOwnerEnforced}]'
    aws s3api put-public-access-block --bucket $b --public-access-block-configuration BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true
    aws s3api put-bucket-encryption --bucket $b --server-side-encryption-configuration '{"Rules":[{"ApplyServerSideEncryptionByDefault":{"SSEAlgorithm":"AES256"},"BucketKeyEnabled":false}]}'
    aws s3api put-bucket-tagging --bucket $b --tagging 'TagSet=[{Key=ac:sandbox,Value=phase-4}]'
  done
  jq '.Resources.WebBucketPolicy.Properties.PolicyDocument' "$T" > "$SBX_OUT/web-policy.json"
  guard document --file "$SBX_OUT/web-policy.json"
  aws s3api put-bucket-policy --bucket $WEB --policy "file://$SBX_OUT/web-policy.json"
  node "$SBX_ROOT/infra/sandbox/synthetic-data.mjs" seed-objects "$SBX_OUT/objects"
  aws s3 cp --recursive --quiet "$SBX_OUT/objects/web" "s3://$WEB/"
  aws s3 cp --recursive --quiet "$SBX_OUT/objects/learning" "s3://$LEARN/"
  log "created and seeded the data resources"
  sleep 5

  # --- Import: every resource, Import actions only ---
  jq -n --argjson secrets "$(for s in "${SECRETS[@]}"; do aws secretsmanager describe-secret --secret-id "applianceclinic-sbx/$s" --query '{n:Name,a:ARN}' --output json; done | jq -s .)" \
    --slurpfile t "$T" '
    def lid(name): $t[0].Resources | to_entries[] | select(.value.Properties | (.RepositoryName // .Name // .TableName // .BucketName) == name) | .key;
    [ ($t[0].Resources | to_entries[] | select(.value.Type == "AWS::ECR::Repository") | {ResourceType: .value.Type, LogicalResourceId: .key, ResourceIdentifier: {RepositoryName: .value.Properties.RepositoryName}}),
      ($secrets[] as $s | {ResourceType: "AWS::SecretsManager::Secret", LogicalResourceId: lid($s.n), ResourceIdentifier: {Id: $s.a}}),
      ($t[0].Resources | to_entries[] | select(.value.Type == "AWS::DynamoDB::Table") | {ResourceType: .value.Type, LogicalResourceId: .key, ResourceIdentifier: {TableName: .value.Properties.TableName}}),
      ($t[0].Resources | to_entries[] | select(.value.Type == "AWS::S3::Bucket") | {ResourceType: .value.Type, LogicalResourceId: .key, ResourceIdentifier: {BucketName: .value.Properties.BucketName}}),
      ($t[0].Resources | to_entries[] | select(.value.Type == "AWS::S3::BucketPolicy") | {ResourceType: .value.Type, LogicalResourceId: .key, ResourceIdentifier: {Bucket: .value.Properties.Bucket}}) ]' > "$SBX_OUT/data-import.json"
  log "importing $(jq length "$SBX_OUT/data-import.json") resources"
  create_shell $STACK "$T"
  changeset $STACK import-1 IMPORT "$T" "$SBX_OUT/data-import.json"
  actions=$(jq -r '[.Changes[].ResourceChange.Action] | unique | join(",")' "$SBX_OUT/$STACK.import-1.changeset.json")
  [[ $actions == Import ]] || stop "data import change set has actions [$actions]"
  aws cloudformation update-termination-protection --enable-termination-protection --stack-name $STACK >/dev/null
fi
[[ $EXECUTE == 1 ]] || exit 0

expect_noop $STACK "$T"
s=$(drift $STACK)
log "data drift: $s"
grep -v IN_SYNC "$SBX_OUT/$STACK.drift.txt" >&2 || log "every data resource IN_SYNC"
