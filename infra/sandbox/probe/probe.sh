#!/usr/bin/env bash
# Phase 5 import-semantics probe (#46): what does CloudFormation write when it imports a resource?
# Run as ac-operator-sbx:
#
#   PROBE_WRITES=ecr:SetRepositoryPolicy PROBE_DECLARE='{"ecrRepositoryPolicy":true}' bash probe.sh 5.1 <label>
#
#   1. Create the step's sandbox resources outside CloudFormation, shaped as production is live (untagged, dummy secret
#      values, synthetic data), if they do not exist.
#   2. Give the probe execution role ac-import-probe-sbx read-only access to sandbox resources plus exactly
#      PROBE_WRITES (bounded by ac-cfn-execution-sbx).
#   3. Import with the PRODUCTION template shape for the step (infra/cdk, profile sandbox), checked in sandbox mode,
#      into a stack with no stack tags, as production is.
#   4. Record the outcome, every failure event, before and after snapshots of the resources, and drift.
# The writes CloudFormation made or attempted are then read from CloudTrail (cloudtrail.sh, as the IAM user).
# Results: .migration-output/probe/<step>.<label>.json
SBX_NO_STACK_TAGS=1
# One probe at a time: the probe role's policy and the probe's files are shared (two concurrent runs once overwrote
# each other's role policy and token parameters, and their results were discarded).
exec 9>"${TMPDIR:-/tmp}/ac-import-probe.lock"
flock -n 9 || { echo "another probe holds the lock" >&2; exit 1; }
SBX_EXEC_ROLE=arn:aws:iam::800960611664:role/ac-import-probe-sbx
source "$(dirname "$0")/../lib.sh"
require_operator
STEP=${1:?step}; LABEL=${2:?label}
P=$SBX_ROOT/.migration-output/probe; mkdir -p "$P"
A=$SBX_ACCOUNT R=$SBX_REGION
WRITES=${PROBE_WRITES:-}
DECLARE=${PROBE_DECLARE:-'{}'}
OUT=$P/$STEP.$LABEL

# --- Sandbox resources, shaped as production is live ------------------------------------------------------------
ECR_POLICY=$(jq -c --arg a "$A" '{Version: "2008-10-17", Statement: [{Sid: "LambdaECRImageRetrievalPolicy", Effect: "Allow",
  Principal: {Service: "lambda.amazonaws.com"}, Action: ["ecr:BatchGetImage","ecr:GetDownloadUrlForLayer","ecr:SetRepositoryPolicy","ecr:DeleteRepositoryPolicy","ecr:GetRepositoryPolicy"],
  Condition: {StringLike: {"aws:sourceArn": ("arn:aws:lambda:eu-west-1:" + $a + ":function:*-sbx")}}}]}' <<<'{}')
setup_ecr() { # NAME: MUTABLE, scan on push, AES256, no lifecycle, no tags, and the repository policy Lambda writes
  aws ecr describe-repositories --repository-names "$1" >/dev/null 2>&1 && return 0
  guard_target AWS::ECR::Repository "$1"
  aws ecr create-repository --repository-name "$1" --image-tag-mutability MUTABLE --image-scanning-configuration scanOnPush=true \
    --encryption-configuration encryptionType=AES256 >/dev/null
  aws ecr set-repository-policy --repository-name "$1" --policy-text "$ECR_POLICY" >/dev/null
  log "created repository $1 (with the Lambda repository policy)"
}
setup_secret() { # NAME [DESCRIPTION]: dummy value, never printed; default KMS key, no rotation, no tags
  aws secretsmanager describe-secret --secret-id "$1" >/dev/null 2>&1 && return 0
  guard_target AWS::SecretsManager::Secret "$1"
  aws secretsmanager create-secret --name "$1" ${2:+--description "$2"} --secret-string "dummy-$(openssl rand -hex 16)" >/dev/null
  log "created secret $1 (dummy value)"
}
setup_table() { # NAME SORTKEY TTL(yes|no): on-demand, key pk, GSI gsi_activity ALL, PITR on, no tags, no stream
  aws dynamodb describe-table --table-name "$1" >/dev/null 2>&1 && return 0
  guard_target AWS::DynamoDB::Table "$1"
  aws dynamodb create-table --table-name "$1" --billing-mode PAY_PER_REQUEST --key-schema AttributeName=pk,KeyType=HASH \
    --attribute-definitions AttributeName=pk,AttributeType=S AttributeName=gsiPk,AttributeType=S AttributeName="$2",AttributeType=S \
    --global-secondary-indexes "IndexName=gsi_activity,KeySchema=[{AttributeName=gsiPk,KeyType=HASH},{AttributeName=$2,KeyType=RANGE}],Projection={ProjectionType=ALL}" >/dev/null
  aws dynamodb wait table-exists --table-name "$1"
  [[ $3 == yes ]] && aws dynamodb update-time-to-live --table-name "$1" --time-to-live-specification Enabled=true,AttributeName=expiresAt >/dev/null
  aws dynamodb update-continuous-backups --table-name "$1" --point-in-time-recovery-specification PointInTimeRecoveryEnabled=true >/dev/null
  log "created table $1"
}
setup_bucket() { # NAME [POLICY-JSON]: owner enforced, public access blocked, AES256 (the defaults), no versioning or tags
  aws s3api head-bucket --bucket "$1" 2>/dev/null && return 0
  guard_target AWS::S3::Bucket "$1"
  aws s3api create-bucket --bucket "$1" --create-bucket-configuration LocationConstraint=$R >/dev/null
  aws s3api put-public-access-block --bucket "$1" --public-access-block-configuration BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true
  [[ -n ${2:-} ]] && aws s3api put-bucket-policy --bucket "$1" --policy "$2"
  log "created bucket $1"
}
WEB=whichpart-web-sbx-$A LEARN=whichpart-learning-sbx-$A
WEB_POLICY=$(jq -c --arg b "$WEB" --arg a "$A" '{Version: "2012-10-17", Statement: [{Sid: "AllowCloudFrontOAC", Effect: "Allow", Principal: {Service: "cloudfront.amazonaws.com"},
  Action: "s3:GetObject", Resource: ("arn:aws:s3:::" + $b + "/*"), Condition: {StringEquals: {"AWS:SourceArn": ("arn:aws:cloudfront::" + $a + ":distribution/ESBXPLACEHOLDER")}}}]}' <<<'{}')

# --- Runtime resources (5.5 to 5.10), from the sandbox plan (plan-runtime.mjs: production's shape, sandbox values) ----
PLAN=$SBX_ROOT/.migration-output/probe/runtime-plan.json
plan() { jq -c "$1" "$PLAN"; }
setup_roles() {
  for r in $(jq -r '.roles | keys[]' "$PLAN"); do
    aws iam get-role --role-name "$r" >/dev/null 2>&1 && continue
    guard_target AWS::IAM::Role "$r"
    aws iam create-role --role-name "$r" --assume-role-policy-document "$(plan ".roles[\"$r\"].trust")" \
      --permissions-boundary "arn:aws:iam::$A:policy/ac-cfn-execution-sbx" >/dev/null
    for m in $(jq -r ".roles[\"$r\"].managed[]" "$PLAN"); do aws iam attach-role-policy --role-name "$r" --policy-arn "$m"; done
    log "created role $r"
  done
}
setup_inline() {
  for r in $(jq -r '.roles | keys[]' "$PLAN"); do
    for p in $(jq -r ".roles[\"$r\"].inline | keys[]" "$PLAN"); do
      aws iam get-role-policy --role-name "$r" --policy-name "$p" >/dev/null 2>&1 && continue
      guard_target AWS::IAM::RolePolicy "$r/$p"
      plan ".roles[\"$r\"].inline[\"$p\"]" > "$P/doc.json"; guard document --file "$P/doc.json"
      aws iam put-role-policy --role-name "$r" --policy-name "$p" --policy-document "file://$P/doc.json"
      log "put inline policy $r/$p"
    done
  done
}
CODE=$P/runtime-code.json
jq -n --arg b "$LEARN" '{"whichpart-api-sbx": {s3Bucket: $b, s3Key: "probe-code/whichpart-api-sbx.zip"}, "spares4repairs-part-finder-sbx": {s3Bucket: $b, s3Key: "probe-code/spares4repairs-part-finder-sbx.zip"}}' > "$CODE"
ZIPS=${PROBE_ZIPS:-$SBX_ROOT/.migration-output/sandbox/zips}   # the Phase 3 zips (build/scripts/package_zips.py)
setup_function() { # NAME: as production is shaped, with the sandbox plan's values and dummy tokens
  local f=$1 fp; fp=$(plan ".functions[\"$f\"]")
  aws lambda get-function --function-name "$f" >/dev/null 2>&1 && return 0
  guard_target AWS::Lambda::Function "$f"
  jq '.environment | with_entries(if .value == "@DUMMY@" then .value = "redacted" else . end)' <<<"$fp" > "$P/env.json"
  guard env --function "$f" --file "$P/env.json"
  local envjson; envjson=$(jq -c --arg d "dummy-$(openssl rand -hex 16)" '{Variables: (.environment | with_entries(if .value == "@DUMMY@" then .value = $d else . end))}' <<<"$fp")
  local common=(--function-name "$f" --role "$(jq -r .role <<<"$fp")" --architectures $(jq -r '.architectures[]' <<<"$fp") \
    --memory-size "$(jq -r .memorySize <<<"$fp")" --timeout "$(jq -r .timeout <<<"$fp")" --environment "$envjson")
  if [[ $(jq -r .packageType <<<"$fp") == Zip ]]; then
    local base=${f%-sbx}
    aws s3 cp --quiet "$ZIPS/$base.zip" "s3://$LEARN/probe-code/$f.zip"
    aws lambda create-function "${common[@]}" --runtime "$(jq -r .runtime <<<"$fp")" --handler "$(jq -r .handler <<<"$fp")" \
      --code "S3Bucket=$LEARN,S3Key=probe-code/$f.zip" >/dev/null
  else
    local repo=$f d=${f%-sbx}; d=${d#spares4repairs-}; [[ $d == diag-orchestrator ]] && d=orchestrator
    aws ecr describe-images --repository-name "$repo" --image-ids imageTag=v1 >/dev/null 2>&1 || \
      (cd "$SBX_TOOLS" && NODE_USE_ENV_PROXY=1 node bin/sandbox-image-copy.mjs push --dir "$SBX_OUT/images/$d" --repo "$repo" --tag v1 >/dev/null 2>&1) || stop "image push $repo"
    aws lambda create-function "${common[@]}" --package-type Image --code "ImageUri=$(jq -r .imageUri <<<"$fp")" >/dev/null
  fi
  aws lambda wait function-active-v2 --function-name "$f"
  log "created function $f"
}
setup_url_and_permissions() { # NAME
  local f=$1 fp; fp=$(plan ".functions[\"$f\"]")
  if [[ $(jq -r '.url' <<<"$fp") != null ]] && ! aws lambda get-function-url-config --function-name "$f" >/dev/null 2>&1; then
    aws lambda create-function-url-config --function-name "$f" --auth-type "$(jq -r .url.AuthType <<<"$fp")" --invoke-mode "$(jq -r .url.InvokeMode <<<"$fp")" \
      $( [[ $(jq -r .url.Cors <<<"$fp") != null ]] && echo --cors "$(jq -c .url.Cors <<<"$fp")" ) >/dev/null
    record_generated AWS::Lambda::Url "$(aws lambda get-function-url-config --function-name "$f" --query FunctionUrl --output text | sed -E 's#https://([^/]+)/#\1#')" "$f"
  fi
  local existing; existing=$(aws lambda get-policy --function-name "$f" --query Policy --output text 2>/dev/null | jq -r '[.Statement[].Sid] | join(" ")' || true)
  jq -c '.statements[]' <<<"$fp" | while read -r st; do
    local sid; sid=$(jq -r .Sid <<<"$st")
    [[ " $existing " == *" $sid "* ]] && continue
    local principal; principal=$(jq -r 'if .Principal == "*" then "*" else .Principal.Service end' <<<"$st")
    aws lambda add-permission --function-name "$f" --statement-id "$sid" --action "$(jq -r .Action <<<"$st")" --principal "$principal" \
      $(jq -r 'if .Condition.StringEquals["lambda:FunctionUrlAuthType"] then "--function-url-auth-type " + .Condition.StringEquals["lambda:FunctionUrlAuthType"] else "" end' <<<"$st") \
      $(jq -r 'if .Condition.ArnLike["AWS:SourceArn"] then "--source-arn " + .Condition.ArnLike["AWS:SourceArn"] else "" end' <<<"$st") >/dev/null
    log "permission $f/$sid"
  done
}
setup_rules() {
  for r in $(jq -r '.rules | keys[]' "$PLAN"); do
    aws events describe-rule --name "$r" >/dev/null 2>&1 && continue
    guard_target AWS::Events::Rule "$r"
    aws events put-rule --name "$r" --schedule-expression "$(jq -r ".rules[\"$r\"].scheduleExpression" "$PLAN")" --state DISABLED >/dev/null
    aws events put-targets --rule "$r" --targets "$(plan ".rules[\"$r\"].targets")" >/dev/null
    log "created rule $r (DISABLED)"
  done
}
setup_5_5() { setup_roles; }
setup_5_6() { setup_inline; }
setup_5_7a() { setup_function spares4repairs-error-code-mcp-sbx; }
setup_5_7b() { setup_function spares4repairs-diag-orchestrator-sbx; }
setup_5_7c() { setup_function whichpart-api-sbx; }
setup_5_8() { for f in spares4repairs-error-code-mcp-sbx spares4repairs-diag-orchestrator-sbx whichpart-api-sbx; do setup_url_and_permissions "$f"; done; }
setup_5_9() { setup_rules; }
setup_5_10() { setup_function spares4repairs-part-finder-sbx; setup_url_and_permissions spares4repairs-part-finder-sbx; }
CAP=$P/runtime-sandbox.json
capture() { bash "$SBX_ROOT/infra/production/capture-runtime.sh" sandbox "$CAP" 2>/dev/null; }
runtime_step() { [[ $STEP =~ ^5\.(5|6|7a|7b|7c|8|9|10)$ ]]; }
for s in 5_5 5_6 5_7a 5_7b 5_7c 5_8 5_9 5_10; do
  eval "snapshot_$s() { capture; jq 'del(.capturedAt) | .functions |= map_values(.configuration.Environment.Variables |= with_entries(if (.key | test(\"TOKEN\$\")) then .value = \"redacted\" else . end))' \"\$CAP\"; }"
done

setup() {
  case $STEP in
    5.1) setup_ecr spares4repairs-error-code-mcp-sbx ;;
    5.2) setup_ecr spares4repairs-diag-orchestrator-sbx
         for s in ai-config openai jev diag-orchestrator/bearer-token error-code-mcp/bearer-token; do setup_secret "applianceclinic-sbx/$s"; done
         setup_secret applianceclinic-sbx/canonical-state-token 'ApplianceClinic Stage C canonical state token HMAC signing secret {current, previous}'
         setup_secret applianceclinic-sbx/benchmark-service 'ApplianceClinic benchmark/test runner service auth (HMAC key for x-benchmark-signature). Read by whichpart-api-sbx and the local batch runners.' ;;
    5.3a) setup_table whichpart-recalls-sbx gsiSk no ;;
    5.3b) setup_table whichpart-transcripts-sbx lastActivityAt yes ;;
    5.4) setup_bucket "$WEB" "$WEB_POLICY"; setup_bucket "$LEARN" ;;
    *) [[ $(type -t "setup_${STEP//./_}") == function ]] && "setup_${STEP//./_}" || stop "no setup for $STEP" ;;
  esac
}

# --- Snapshots: the full configuration of the step's resources, never secret values or data ---------------------
snapshot() {
  case $STEP in
    5.1|5.2) for r in $(jq -r '.import[] | select(.ResourceType == "AWS::ECR::Repository") | .ResourceIdentifier.RepositoryName' "$SF"); do
        jq -n --arg r "$r" --argjson d "$(aws ecr describe-repositories --repository-names "$r" --query 'repositories[0]' --output json)" \
          --arg p "$(aws ecr get-repository-policy --repository-name "$r" --query policyText --output text 2>/dev/null || echo NONE)" \
          --arg l "$(aws ecr get-lifecycle-policy --repository-name "$r" --query lifecyclePolicyText --output text 2>/dev/null || echo NONE)" \
          --argjson t "$(aws ecr list-tags-for-resource --resource-arn "arn:aws:ecr:$R:$A:repository/$r" --output json)" \
          '{repository: $r, describe: $d, policy: (if $p == "NONE" then null else ($p | fromjson) end), lifecycle: $l, tags: $t.tags}'; done
      for s in $(jq -r '.import[] | select(.ResourceType == "AWS::SecretsManager::Secret") | .ResourceIdentifier.Id' "$SF"); do
        aws secretsmanager describe-secret --secret-id "$s" --output json | jq '{secret: .Name, ARN, Description, KmsKeyId, RotationEnabled, Tags, VersionIdsToStages: (.VersionIdsToStages | keys | length)}'; done ;;
    5.3a|5.3b) for t in $(jq -r '.import[].ResourceIdentifier.TableName' "$SF"); do
        jq -n --arg t "$t" --argjson d "$(aws dynamodb describe-table --table-name "$t" --query 'Table' --output json | jq 'del(.ItemCount, .TableSizeBytes, .GlobalSecondaryIndexes[]?.ItemCount, .GlobalSecondaryIndexes[]?.IndexSizeBytes)')" \
          --argjson ttl "$(aws dynamodb describe-time-to-live --table-name "$t" --output json)" \
          --argjson pitr "$(aws dynamodb describe-continuous-backups --table-name "$t" --query 'ContinuousBackupsDescription.PointInTimeRecoveryDescription.{s:PointInTimeRecoveryStatus,d:RecoveryPeriodInDays}' --output json)" \
          --argjson tags "$(aws dynamodb list-tags-of-resource --resource-arn "arn:aws:dynamodb:$R:$A:table/$t" --output json)" \
          '{table: $t, describe: $d, ttl: $ttl, pitr: $pitr, tags: $tags.Tags}'; done ;;
    5.4) for b in $(jq -r '.import[] | select(.ResourceType == "AWS::S3::Bucket") | .ResourceIdentifier.BucketName' "$SF"); do
        jq -n --arg b "$b" \
          --arg enc "$(aws s3api get-bucket-encryption --bucket "$b" --output json 2>&1)" --arg pab "$(aws s3api get-public-access-block --bucket "$b" --output json 2>&1)" \
          --arg own "$(aws s3api get-bucket-ownership-controls --bucket "$b" --output json 2>&1)" --arg ver "$(aws s3api get-bucket-versioning --bucket "$b" --output json 2>&1)" \
          --arg lc "$(aws s3api get-bucket-lifecycle-configuration --bucket "$b" --output json 2>&1)" --arg cors "$(aws s3api get-bucket-cors --bucket "$b" --output json 2>&1)" \
          --arg pol "$(aws s3api get-bucket-policy --bucket "$b" --query Policy --output text 2>&1)" --arg tags "$(aws s3api get-bucket-tagging --bucket "$b" --output json 2>&1)" \
          --arg web "$(aws s3api get-bucket-website --bucket "$b" --output json 2>&1)" --arg log "$(aws s3api get-bucket-logging --bucket "$b" --output json 2>&1)" \
          --arg ntf "$(aws s3api get-bucket-notification-configuration --bucket "$b" --output json 2>&1)" --arg acc "$(aws s3api get-bucket-accelerate-configuration --bucket "$b" --output json 2>&1)" \
          '{bucket: $b, encryption: $enc, publicAccessBlock: $pab, ownership: $own, versioning: $ver, lifecycle: $lc, cors: $cors, policy: $pol, tags: $tags, website: $web, logging: $log, notifications: $ntf, accelerate: $acc} | map_values(gsub("Request ID: [^)]*"; ""))'; done ;;
    *) [[ $(type -t "snapshot_${STEP//./_}") == function ]] && "snapshot_${STEP//./_}" || stop "no snapshot for $STEP" ;;
  esac | jq -s 'map(del(.describe.createdAt?, .describe.CreationDateTime?))'
}

# --- The probe role: read-only, plus exactly PROBE_WRITES --------------------------------------------------------
probe_role() {
  local role=ac-import-probe-sbx
  guard_target AWS::IAM::Role "$role"
  if ! aws iam get-role --role-name "$role" >/dev/null 2>&1; then
    aws iam create-role --role-name "$role" --permissions-boundary "arn:aws:iam::$A:policy/ac-cfn-execution-sbx" \
      --assume-role-policy-document '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"cloudformation.amazonaws.com"},"Action":"sts:AssumeRole"}]}' \
      --description "Phase 5 import-semantics probe (#46): read-only plus the writes under test" >/dev/null
  fi
  (cd "$SBX_TOOLS" && node bin/import-writes.mjs probe-policy --writes "$WRITES") > "$OUT.policy.json"
  guard document --file "$OUT.policy.json"
  guard_target AWS::IAM::RolePolicy "$role/probe"
  aws iam put-role-policy --role-name "$role" --policy-name probe --policy-document "file://$OUT.policy.json"
  log "probe role: read-only + [${WRITES:-no writes}]"
  sleep 15   # IAM propagation
}

# --- Run ---------------------------------------------------------------------------------------------------------
SF=$OUT.step.json
(cd "$SBX_TOOLS" && node bin/import-writes.mjs sandbox-step --step "$SBX_ROOT/infra/production/steps/$STEP.json") > "$SF.tmp"
# Secret ARNs end in a random suffix: use the sandbox secret's own ARN.
setup
for arn in $(jq -r '.import[] | select(.ResourceType == "AWS::SecretsManager::Secret") | .ResourceIdentifier.Id' "$SF.tmp"); do
  name=$(sed -E 's/^.*:secret:(.*)-[A-Za-z0-9]{6}$/\1/' <<<"$arn")
  real=$(aws secretsmanager describe-secret --secret-id "$name" --query ARN --output text)
  sed -i "s|$arn|$real|g" "$SF.tmp"
done
mv "$SF.tmp" "$SF"
STACK=$(jq -r .stack "$SF")
probe_role

CDKDIR=$SBX_ROOT/infra/cdk
synth_sbx() { (cd "$CDKDIR" && env -u AWS_ACCESS_KEY_ID -u AWS_SECRET_ACCESS_KEY -u AWS_SESSION_TOKEN AWS_EC2_METADATA_DISABLED=true CDK_DISABLE_VERSION_CHECK=1 \
  npx cdk synth --quiet --no-notices -c profile=sandbox -c step="$1" -c declare="$DECLARE" ${LIVECTX:+-c live="$CAP" -c code="$CODE"} >/dev/null 2>&1) || stop "synth $1"; cp "$CDKDIR/cdk.out/$STACK.template.json" "$2"; }
# Runtime templates come from a capture of the sandbox's live configuration, taken after setup.
runtime_step && { LIVECTX=1; capture; }
params_for() { # TEMPLATE: the NoEcho token parameters of a runtime template, from the capture (mode 0600)
  unset SBX_PARAMS
  [[ $(jq '[.Parameters // {} | keys[] | select(. != "BootstrapVersion")] | length' "$1") == 0 ]] && return 0
  node "$SBX_ROOT/infra/production/token-params.mjs" "$1" "$CAP" sandbox "$P/params.json"
  SBX_PARAMS=file://$P/params.json
}
# Re-probing a step: first take its resources out of the stack with Retain, so no resource handler runs. To go back to
# the empty shell, the stack is deleted (every resource is Retain) and the shell recreated below; otherwise the stack is
# updated to the previous step's template.
if [[ $(jq -r '.import[0].LogicalResourceId' "$SF" | xargs -I{} sh -c 'aws cloudformation describe-stack-resource --stack-name '"$STACK"' --logical-resource-id {} >/dev/null 2>&1 && echo in') == in ]]; then
  prev=$(cd "$CDKDIR" && node -e "const {STEPS}=require('./lib/common'); const i=STEPS.indexOf(process.argv[1]); const p=STEPS[i-1]; console.log(['5.4','5.3b','5.3a','5.2','5.1'].includes(process.argv[1]) || p !== '5.4' ? p : 'shell')" "$STEP")
  if [[ $prev == shell ]]; then
    guard_target AWS::CloudFormation::Stack "$STACK"
    aws cloudformation update-termination-protection --no-enable-termination-protection --stack-name "$STACK" >/dev/null
    aws cloudformation delete-stack --stack-name "$STACK"
    aws cloudformation wait stack-delete-complete --stack-name "$STACK" || stop "delete $STACK"
    log "reset: $STACK deleted (every resource retained)"
  else
    synth_sbx "$prev" "$OUT.reset.json"
    params_for "$OUT.reset.json"
    EXECUTE=1 changeset "$STACK" "reset-${STEP//./-}" UPDATE "$OUT.reset.json"
    log "reset: $STEP resources removed from $STACK with Retain"
  fi
fi
if needs_create "$STACK"; then
  synth_sbx shell "$P/$STACK.shell.json"
  EXECUTE=1 changeset "$STACK" shell CREATE "$P/$STACK.shell.json"
fi
T=$OUT.template.json
synth_sbx "$STEP" "$T"
params_for "$T"
jq '.import' "$SF" > "$OUT.import.json"
snapshot > "$OUT.before.json"
EXECUTE=0 changeset "$STACK" "probe-${STEP//./-}" IMPORT "$T" "$OUT.import.json"
[[ $(jq -r '[.Changes[].ResourceChange.Action] | unique | join(",")' "$SBX_OUT/$STACK.probe-${STEP//./-}.changeset.json") == Import ]] || stop "not import-only"
start=$(date -u +%Y-%m-%dT%H:%M:%SZ)
aws cloudformation execute-change-set --stack-name "$STACK" --change-set-name "probe-${STEP//./-}"
for _ in $(seq 1 180); do
  status=$(aws cloudformation describe-stacks --stack-name "$STACK" --query 'Stacks[0].StackStatus' --output text)
  [[ $status == *IN_PROGRESS ]] || break; sleep 5
done
end=$(date -u +%Y-%m-%dT%H:%M:%SZ)
aws cloudformation describe-stack-events --stack-name "$STACK" --max-items 200 --output json \
  | jq --arg s "$start" '[.StackEvents[] | select(.Timestamp >= $s) | {t: .Timestamp, id: .LogicalResourceId, status: .ResourceStatus, reason: .ResourceStatusReason}] | reverse' > "$OUT.events.json"
snapshot > "$OUT.after.json"
same=$(cmp -s <(jq -S . "$OUT.before.json") <(jq -S . "$OUT.after.json") && echo true || echo false)
dr=none
if [[ $status == IMPORT_COMPLETE ]]; then dr=$(drift "$STACK" | tr '\t' ' '); cp "$SBX_OUT/$STACK.drift.txt" "$OUT.drift.txt"; fi
jq -n --arg step "$STEP" --arg label "$LABEL" --arg writes "$WRITES" --argjson declare "$DECLARE" --arg status "$status" --arg start "$start" --arg end "$end" \
  --arg same "$same" --arg drift "$dr" --arg before "$(jq -S -c . "$OUT.before.json" | sha256sum | cut -c1-16)" --arg after "$(jq -S -c . "$OUT.after.json" | sha256sum | cut -c1-16)" \
  --slurpfile ev "$OUT.events.json" \
  '{step: $step, label: $label, writesGranted: ($writes | split(",") | map(select(. != ""))), declare: $declare, status: $status, window: [$start, $end],
    unchanged: ($same == "true"), beforeDigest: $before, afterDigest: $after, drift: $drift,
    failures: [$ev[0][] | select(.status | test("FAILED")) | {id, reason}]}' > "$OUT.json"
cat "$OUT.json" >&2
