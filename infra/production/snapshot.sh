#!/usr/bin/env bash
# The full live configuration of a Phase 5 step's resources, for the before/after comparison. READ-ONLY.
#
#   bash snapshot.sh <step.json> > snapshot.json
#
# Data steps: every resource of the step file. Runtime steps: the whole runtime capture (all roles, functions and rules,
# so a change anywhere shows). Never secret values or data: secrets give metadata and their version count only, and
# bearer tokens in Lambda environments are replaced by "redacted". Volatile fields (counts, sizes, timestamps,
# LastModified, RevisionId) are left out.
set -euo pipefail
SF=${1:?step.json}
export AWS_REGION=eu-west-1 AWS_DEFAULT_REGION=eu-west-1
A=800960611664 R=eu-west-1
ROOT=$(cd "$(dirname "$0")/../.." && pwd)

if [[ $(jq -r .stack "$SF") == AcRuntimeStack ]]; then
  t=$ROOT/.migration-output/phase5/live/snapshot-capture.json   # mode 0600, overwritten each time
  mkdir -p "$(dirname "$t")"
  bash "$ROOT/infra/production/capture-runtime.sh" production "$t" 2>/dev/null
  jq 'del(.capturedAt) | .functions |= map_values(.configuration.Environment.Variables |= (if . then with_entries(if (.key | test("TOKEN$")) then .value = "redacted" else . end) else . end))' "$t"
  exit 0
fi

jq -c '.import[]' "$SF" | while read -r e; do
  type=$(jq -r .ResourceType <<<"$e")
  case $type in
    AWS::ECR::Repository)
      r=$(jq -r .ResourceIdentifier.RepositoryName <<<"$e")
      jq -n --arg r "$r" --argjson d "$(aws ecr describe-repositories --repository-names "$r" --query 'repositories[0]' --output json)" \
        --arg p "$(aws ecr get-repository-policy --repository-name "$r" --query policyText --output text 2>/dev/null || echo NONE)" \
        --arg l "$(aws ecr get-lifecycle-policy --repository-name "$r" --query lifecyclePolicyText --output text 2>/dev/null || echo NONE)" \
        --argjson t "$(aws ecr list-tags-for-resource --resource-arn "arn:aws:ecr:$R:$A:repository/$r" --query tags --output json)" \
        '{type: "ecr", name: $r, describe: $d, policyText: $p, lifecycle: $l, tags: $t}' ;;
    AWS::SecretsManager::Secret)
      aws secretsmanager describe-secret --secret-id "$(jq -r .ResourceIdentifier.Id <<<"$e")" --output json \
        | jq '{type: "secret", name: .Name, ARN, Description, KmsKeyId, RotationEnabled, RotationRules, ReplicationStatus, Tags, versions: (.VersionIdsToStages | to_entries | map({key, value}) )}' ;;
    AWS::DynamoDB::Table)
      tn=$(jq -r .ResourceIdentifier.TableName <<<"$e")
      jq -n --arg t "$tn" --argjson d "$(aws dynamodb describe-table --table-name "$tn" --query Table --output json | jq 'del(.ItemCount, .TableSizeBytes, .GlobalSecondaryIndexes[]?.ItemCount, .GlobalSecondaryIndexes[]?.IndexSizeBytes)')" \
        --argjson ttl "$(aws dynamodb describe-time-to-live --table-name "$tn" --output json)" \
        --argjson pitr "$(aws dynamodb describe-continuous-backups --table-name "$tn" --query 'ContinuousBackupsDescription.PointInTimeRecoveryDescription.{s:PointInTimeRecoveryStatus,d:RecoveryPeriodInDays}' --output json)" \
        --argjson tags "$(aws dynamodb list-tags-of-resource --resource-arn "arn:aws:dynamodb:$R:$A:table/$tn" --query Tags --output json)" \
        '{type: "table", name: $t, describe: $d, ttl: $ttl, pitr: $pitr, tags: $tags}' ;;
    AWS::S3::Bucket|AWS::S3::BucketPolicy)
      b=$(jq -r '.ResourceIdentifier.BucketName // .ResourceIdentifier.Bucket' <<<"$e")
      q() { aws s3api "$1" --bucket "$b" --output json 2>&1 | sed -E 's/Request ID: [^)]*//'; }
      jq -n --arg type "$type" --arg b "$b" --arg enc "$(q get-bucket-encryption)" --arg pab "$(q get-public-access-block)" --arg own "$(q get-bucket-ownership-controls)" \
        --arg ver "$(q get-bucket-versioning)" --arg lc "$(q get-bucket-lifecycle-configuration)" --arg cors "$(q get-bucket-cors)" \
        --arg pol "$(aws s3api get-bucket-policy --bucket "$b" --query Policy --output text 2>&1 | sed -E 's/Request ID: [^)]*//')" \
        --arg tags "$(q get-bucket-tagging)" --arg web "$(q get-bucket-website)" --arg log "$(q get-bucket-logging)" --arg ntf "$(q get-bucket-notification-configuration)" \
        '{type: $type, name: $b, encryption: $enc, publicAccessBlock: $pab, ownership: $own, versioning: $ver, lifecycle: $lc, cors: $cors, policy: $pol, tags: (try ($tags | fromjson) catch $tags), website: $web, logging: $log, notifications: $ntf}' ;;
    *) echo "no snapshot for $type" >&2; exit 1 ;;
  esac
done | jq -s 'sort_by(.type, .name) | map(del(.describe.createdAt?, .describe.CreationDateTime?))'
