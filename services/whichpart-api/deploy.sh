#!/usr/bin/env bash
# Deploy the Which Part boundary Lambda + Function URL via AWS CLI.
# Idempotent: creates the role/function/URL on first run, updates thereafter.
# Does NOT touch any Spares4Repairs resources.
set -euo pipefail

FUNCTION="${FUNCTION:-whichpart-api}"
REGION="${REGION:-eu-west-1}"
ROLE_NAME="${ROLE_NAME:-whichpart-api-role}"
ENGINE_URL="${ENGINE_URL:-https://3asx4cw2qs5ajsjkytdwffhhvy0ptnoz.lambda-url.eu-west-1.on.aws/}"
S4R_PRODUCT_BASE_URL="${S4R_PRODUCT_BASE_URL:-https://d1hrb3pgx61xww.cloudfront.net}"
# The customer diagnostic orchestrator (ONE diagnostic API the browser talks to). The boundary
# fans out to MCP/RAG server-side; the bearer never leaves the server.
ORCHESTRATOR_URL="${ORCHESTRATOR_URL:-https://ajpz33wv4yezh6g2ayv5ite3zu0ruviq.lambda-url.eu-west-1.on.aws/}"
ORCH_TOKEN_SECRET_ID="${ORCH_TOKEN_SECRET_ID:-spares4repairs/diag-orchestrator/bearer-token}"
# Cognito (customer UI header + admin console). Reuses the existing shared S4R user pool; the app
# client has no secret and allows ADMIN_USER_PASSWORD_AUTH. This is the boundary/BFF, not a
# diagnostic backend — diagnosis behaviour is unchanged.
COGNITO_USER_POOL_ID="${COGNITO_USER_POOL_ID:-eu-west-1_mUWucohuX}"
COGNITO_CLIENT_ID="${COGNITO_CLIENT_ID:-60phdcnl0eetdq4kcp327d0fkm}"
# MCP health (public GET) surfaced read-only on the admin dashboard.
MCP_HEALTH_URL="${MCP_HEALTH_URL:-https://657tahkrqxc72sxbt775wrbqnu0tasav.lambda-url.eu-west-1.on.aws/health}"
MCP_URL="${MCP_URL:-https://657tahkrqxc72sxbt775wrbqnu0tasav.lambda-url.eu-west-1.on.aws}"
MCP_TOKEN_SECRET_ID="${MCP_TOKEN_SECRET_ID:-spares4repairs/error-code-mcp/bearer-token}"
# LM Studio base URL — used ONLY by the admin console to display the loaded model
# name and check the local connection. Diagnosis uses the part-finder's own copy.
LM_STUDIO_URL="${LM_STUDIO_URL:-https://isolating-eldercare-hurdle.ngrok-free.dev}"

# Resolve the script's own directory ONCE (absolute) and run from it, so every
# relative path below is independent of the caller's working directory. Do not
# re-derive paths from "$0"/dirname after this point — that double-applies the
# relative prefix once the cwd has changed (the bug this hardening fixes).
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# Fetch the orchestrator bearer token from Secrets Manager (never committed/logged). Allow an
# explicit ORCHESTRATOR_TOKEN override for local/dev, otherwise read the secret.
if [ -z "${ORCHESTRATOR_TOKEN:-}" ]; then
  echo "Fetching orchestrator bearer token from Secrets Manager ($ORCH_TOKEN_SECRET_ID)..."
  ORCHESTRATOR_TOKEN="$(aws secretsmanager get-secret-value --secret-id "$ORCH_TOKEN_SECRET_ID" \
    --region "$REGION" --query SecretString --output text)"
fi
if [ -z "${ORCHESTRATOR_TOKEN:-}" ]; then
  echo "ERROR: orchestrator bearer token could not be resolved" >&2; exit 1
fi

if [ -z "${MCP_BEARER_TOKEN:-}" ]; then
  echo "Fetching Error Code MCP bearer token from Secrets Manager ($MCP_TOKEN_SECRET_ID)..."
  MCP_BEARER_TOKEN="$(aws secretsmanager get-secret-value --secret-id "$MCP_TOKEN_SECRET_ID" \
    --region "$REGION" --query SecretString --output text)"
fi
if [ -z "${MCP_BEARER_TOKEN:-}" ]; then
  echo "ERROR: Error Code MCP bearer token could not be resolved" >&2; exit 1
fi

# 1) Execution role (basic Lambda logging).
if ! aws iam get-role --role-name "$ROLE_NAME" >/dev/null 2>&1; then
  echo "Creating role $ROLE_NAME..."
  aws iam create-role --role-name "$ROLE_NAME" \
    --assume-role-policy-document '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"lambda.amazonaws.com"},"Action":"sts:AssumeRole"}]}' >/dev/null
  aws iam attach-role-policy --role-name "$ROLE_NAME" \
    --policy-arn arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole >/dev/null
  echo "Waiting for role propagation..."; sleep 12
fi
ROLE_ARN="$(aws iam get-role --role-name "$ROLE_NAME" --query 'Role.Arn' --output text)"

# 1b) Allow the boundary to sign users in against the shared Cognito pool (server-side auth).
# AdminInitiateAuth/AdminGetUser need IAM; GetUser/GlobalSignOut are access-token-authorised.
ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"
POOL_ARN="arn:aws:cognito-idp:${REGION}:${ACCOUNT_ID}:userpool/${COGNITO_USER_POOL_ID}"
aws iam put-role-policy --role-name "$ROLE_NAME" --policy-name whichpart-cognito-auth \
  --policy-document "{\"Version\":\"2012-10-17\",\"Statement\":[{\"Effect\":\"Allow\",\"Action\":[\"cognito-idp:AdminInitiateAuth\",\"cognito-idp:AdminGetUser\"],\"Resource\":\"${POOL_ARN}\"}]}" >/dev/null
echo "Ensured Cognito auth policy on $ROLE_NAME."

# 1c) Allow the admin control plane to manage ONLY the ApplianceClinic AI config
# secrets (routing/models + the write-only OpenAI credential). Least-privilege:
# scoped to spares4repairs/<stage>/applianceclinic-* — the same ids the RAG engine reads.
STAGE="${STAGE:-dev}"
SECRETS_ARN="arn:aws:secretsmanager:${REGION}:${ACCOUNT_ID}:secret:spares4repairs/${STAGE}/applianceclinic-*"
aws iam put-role-policy --role-name "$ROLE_NAME" --policy-name whichpart-ai-config-secrets \
  --policy-document "{\"Version\":\"2012-10-17\",\"Statement\":[{\"Effect\":\"Allow\",\"Action\":[\"secretsmanager:GetSecretValue\",\"secretsmanager:PutSecretValue\",\"secretsmanager:CreateSecret\",\"secretsmanager:UpdateSecret\"],\"Resource\":\"${SECRETS_ARN}\"}]}" >/dev/null
echo "Ensured AI-config secrets policy on $ROLE_NAME."

# 1d) ACQ-100 benchmark run store: read/write ONLY the acq/ prefix of the
# learning bucket + list the bucket (control plane: enqueue/read/cancel). The
# local worker uses the operator's own AWS creds; this grant is for the Lambda.
LEARNING_BUCKET="${LEARNING_BUCKET:-whichpart-learning-800960611664}"
aws iam put-role-policy --role-name "$ROLE_NAME" --policy-name whichpart-acq-benchmark-s3 \
  --policy-document "{\"Version\":\"2012-10-17\",\"Statement\":[{\"Effect\":\"Allow\",\"Action\":[\"s3:GetObject\",\"s3:PutObject\"],\"Resource\":\"arn:aws:s3:::${LEARNING_BUCKET}/acq/*\"},{\"Effect\":\"Allow\",\"Action\":[\"s3:ListBucket\"],\"Resource\":\"arn:aws:s3:::${LEARNING_BUCKET}\",\"Condition\":{\"StringLike\":{\"s3:prefix\":[\"acq/*\"]}}}]}" >/dev/null
echo "Ensured ACQ benchmark S3 policy on $ROLE_NAME."

# 1d2) Durable Media Management overlay (metadata + private binaries) and public /media/* publish.
aws iam put-role-policy --role-name "$ROLE_NAME" --policy-name whichpart-media-admin-s3 \
  --policy-document "{\"Version\":\"2012-10-17\",\"Statement\":[{\"Effect\":\"Allow\",\"Action\":[\"s3:GetObject\",\"s3:PutObject\"],\"Resource\":\"arn:aws:s3:::${LEARNING_BUCKET}/media-admin/*\"},{\"Effect\":\"Allow\",\"Action\":[\"s3:ListBucket\"],\"Resource\":\"arn:aws:s3:::${LEARNING_BUCKET}\",\"Condition\":{\"StringLike\":{\"s3:prefix\":[\"media-admin/*\"]}}},{\"Effect\":\"Allow\",\"Action\":[\"s3:PutObject\"],\"Resource\":\"arn:aws:s3:::${WHICHPART_WEB_BUCKET:-whichpart-web-800960611664}/media/*\"}]}" >/dev/null
echo "Ensured Media Management S3 policy on $ROLE_NAME."

# 1d3) Knowledge management (drafts / immutable versions / published overlay) — knowledge-admin/ only.
# DeleteObject is used solely to remove a version file whose publish was rolled back before going live.
aws iam put-role-policy --role-name "$ROLE_NAME" --policy-name whichpart-knowledge-admin-s3 \
  --policy-document "{\"Version\":\"2012-10-17\",\"Statement\":[{\"Effect\":\"Allow\",\"Action\":[\"s3:GetObject\",\"s3:PutObject\",\"s3:DeleteObject\"],\"Resource\":\"arn:aws:s3:::${LEARNING_BUCKET}/knowledge-admin/*\"},{\"Effect\":\"Allow\",\"Action\":[\"s3:ListBucket\"],\"Resource\":\"arn:aws:s3:::${LEARNING_BUCKET}\",\"Condition\":{\"StringLike\":{\"s3:prefix\":[\"knowledge-admin\",\"knowledge-admin/*\"]}}}]}" >/dev/null
echo "Ensured Knowledge management S3 policy on $ROLE_NAME."

# 1e) Anonymous production transcripts (TTL-limited). Least-privilege: this table only.
TRANSCRIPT_TABLE="${TRANSCRIPT_TABLE:-whichpart-transcripts}"
TRANSCRIPT_RETENTION_DAYS="${TRANSCRIPT_RETENTION_DAYS:-90}"
TRANSCRIPT_INACTIVE_MINUTES="${TRANSCRIPT_INACTIVE_MINUTES:-120}"
if ! aws dynamodb describe-table --table-name "$TRANSCRIPT_TABLE" --region "$REGION" >/dev/null 2>&1; then
  echo "Creating DynamoDB table $TRANSCRIPT_TABLE..."
  aws dynamodb create-table --table-name "$TRANSCRIPT_TABLE" --region "$REGION" \
    --billing-mode PAY_PER_REQUEST \
    --attribute-definitions \
      AttributeName=pk,AttributeType=S \
      AttributeName=gsiPk,AttributeType=S \
      AttributeName=lastActivityAt,AttributeType=S \
    --key-schema AttributeName=pk,KeyType=HASH \
    --global-secondary-indexes "IndexName=gsi_activity,KeySchema=[{AttributeName=gsiPk,KeyType=HASH},{AttributeName=lastActivityAt,KeyType=RANGE}],Projection={ProjectionType=ALL}"
  aws dynamodb wait table-exists --table-name "$TRANSCRIPT_TABLE" --region "$REGION"
fi
aws dynamodb update-time-to-live --table-name "$TRANSCRIPT_TABLE" --region "$REGION" \
  --time-to-live-specification Enabled=true,AttributeName=expiresAt >/dev/null 2>&1 || true
TABLE_ARN="arn:aws:dynamodb:${REGION}:${ACCOUNT_ID}:table/${TRANSCRIPT_TABLE}"
INDEX_ARN="${TABLE_ARN}/index/gsi_activity"
aws iam put-role-policy --role-name "$ROLE_NAME" --policy-name whichpart-transcripts-dynamodb \
  --policy-document "{\"Version\":\"2012-10-17\",\"Statement\":[{\"Effect\":\"Allow\",\"Action\":[\"dynamodb:GetItem\",\"dynamodb:PutItem\",\"dynamodb:Query\"],\"Resource\":[\"${TABLE_ARN}\",\"${INDEX_ARN}\"]}]}" >/dev/null
echo "Ensured transcript table $TRANSCRIPT_TABLE and IAM policy."

# 1f) UK OPSS recall store + S3 publish of /recalls/ HTML (not diagnosis).
RECALL_TABLE="${RECALL_TABLE:-whichpart-recalls}"
WHICHPART_WEB_BUCKET="${WHICHPART_WEB_BUCKET:-whichpart-web-800960611664}"
if ! aws dynamodb describe-table --table-name "$RECALL_TABLE" --region "$REGION" >/dev/null 2>&1; then
  echo "Creating DynamoDB table $RECALL_TABLE..."
  aws dynamodb create-table --table-name "$RECALL_TABLE" --region "$REGION" \
    --billing-mode PAY_PER_REQUEST \
    --attribute-definitions \
      AttributeName=pk,AttributeType=S \
      AttributeName=gsiPk,AttributeType=S \
      AttributeName=gsiSk,AttributeType=S \
    --key-schema AttributeName=pk,KeyType=HASH \
    --global-secondary-indexes "IndexName=gsi_activity,KeySchema=[{AttributeName=gsiPk,KeyType=HASH},{AttributeName=gsiSk,KeyType=RANGE}],Projection={ProjectionType=ALL}"
  aws dynamodb wait table-exists --table-name "$RECALL_TABLE" --region "$REGION"
fi
RECALL_TABLE_ARN="arn:aws:dynamodb:${REGION}:${ACCOUNT_ID}:table/${RECALL_TABLE}"
RECALL_INDEX_ARN="${RECALL_TABLE_ARN}/index/gsi_activity"
aws iam put-role-policy --role-name "$ROLE_NAME" --policy-name whichpart-recalls-dynamodb \
  --policy-document "{\"Version\":\"2012-10-17\",\"Statement\":[{\"Effect\":\"Allow\",\"Action\":[\"dynamodb:GetItem\",\"dynamodb:PutItem\",\"dynamodb:DeleteItem\",\"dynamodb:Query\"],\"Resource\":[\"${RECALL_TABLE_ARN}\",\"${RECALL_INDEX_ARN}\"]}]}" >/dev/null
aws iam put-role-policy --role-name "$ROLE_NAME" --policy-name whichpart-recalls-s3 \
  --policy-document "{\"Version\":\"2012-10-17\",\"Statement\":[{\"Effect\":\"Allow\",\"Action\":[\"s3:PutObject\"],\"Resource\":[\"arn:aws:s3:::${WHICHPART_WEB_BUCKET}/recalls/*\",\"arn:aws:s3:::${WHICHPART_WEB_BUCKET}/sitemap-recalls.xml\"]}]}" >/dev/null
echo "Ensured recall table $RECALL_TABLE, DynamoDB IAM, and S3 publish policy."

# Daily ingest via EventBridge (06:00 UTC). Invokes the same Lambda with source=aws.events.
RULE_NAME="${RECALL_INGEST_RULE:-whichpart-recall-ingest-daily}"
aws events put-rule --name "$RULE_NAME" --schedule-expression "cron(0 6 * * ? *)" --state ENABLED --region "$REGION" >/dev/null
FN_ARN="$(aws lambda get-function --function-name "$FUNCTION" --region "$REGION" --query Configuration.FunctionArn --output text 2>/dev/null || true)"
if [ -n "$FN_ARN" ] && [ "$FN_ARN" != "None" ]; then
  aws lambda add-permission --function-name "$FUNCTION" --statement-id RecallIngestDaily \
    --action lambda:InvokeFunction --principal events.amazonaws.com \
    --source-arn "arn:aws:events:${REGION}:${ACCOUNT_ID}:rule/${RULE_NAME}" \
    --region "$REGION" >/dev/null 2>&1 || true
  aws events put-targets --rule "$RULE_NAME" --region "$REGION" \
    --targets "Id=whichpart-api,Arn=${FN_ARN}" >/dev/null
  echo "Ensured EventBridge rule $RULE_NAME -> $FUNCTION"
fi

# Semantic transcript review (ended/inactive only). Separate invocation so customer
# diagnosis never waits on the judge. Input constant avoids colliding with recall ingest.
REVIEW_RULE_NAME="${TRANSCRIPT_REVIEW_RULE:-whichpart-transcript-review}"
aws events put-rule --name "$REVIEW_RULE_NAME" --schedule-expression "rate(15 minutes)" --state ENABLED --region "$REGION" >/dev/null
if [ -n "$FN_ARN" ] && [ "$FN_ARN" != "None" ]; then
  aws lambda add-permission --function-name "$FUNCTION" --statement-id TranscriptReviewPeriodic \
    --action lambda:InvokeFunction --principal events.amazonaws.com \
    --source-arn "arn:aws:events:${REGION}:${ACCOUNT_ID}:rule/${REVIEW_RULE_NAME}" \
    --region "$REGION" >/dev/null 2>&1 || true
  python3 - "$REVIEW_RULE_NAME" "$FN_ARN" "$REGION" <<'PY'
import json, subprocess, sys
rule, arn, region = sys.argv[1], sys.argv[2], sys.argv[3]
payload = {
    "Rule": rule,
    "Targets": [{"Id": "whichpart-api-review", "Arn": arn, "Input": json.dumps({"transcriptReview": True})}],
}
open("/tmp/transcript-review-targets.json", "w").write(json.dumps(payload))
subprocess.check_call([
    "aws", "events", "put-targets", "--region", region,
    "--cli-input-json", "file:///tmp/transcript-review-targets.json",
])
PY
  echo "Ensured EventBridge rule $REVIEW_RULE_NAME -> $FUNCTION (transcriptReview)"
fi

# 2) Package.
# Read-only Knowledge inspector: ship the canonical docs + safety/media join
# plus slim RAG index metadata (identifiers/version only — never embeddings).
SRC_KNOWLEDGE="$(cd "$SCRIPT_DIR/../part-finder/knowledge" && pwd)"
rm -rf knowledge-inspect
mkdir -p knowledge-inspect
cp "$SRC_KNOWLEDGE/knowledge-docs.json" knowledge-inspect/
cp "$SRC_KNOWLEDGE/safety-information.json" knowledge-inspect/
cp "$SRC_KNOWLEDGE/media-information.json" knowledge-inspect/
python3 - "$SRC_KNOWLEDGE" <<'PY'
import json, os, sys
src = os.path.join(sys.argv[1], "knowledge-index.json")
out = os.path.join("knowledge-inspect", "index-meta.json")
idx = json.load(open(src))
meta = {
    "version": idx.get("version"),
    "embedModel": idx.get("embedModel"),
    "dims": idx.get("dims"),
    "builtAt": idx.get("builtAt"),
    "count": idx.get("count") or len(idx.get("docs") or []),
    "knowledgeIds": [d.get("knowledgeId") for d in (idx.get("docs") or []) if d.get("knowledgeId")],
}
json.dump(meta, open(out, "w"))
print("Wrote", out, "ids", len(meta["knowledgeIds"]))
PY

cp "$SCRIPT_DIR/../part-finder/media-effective.js" ./media-effective.js
# Admin Media "where is this used" + delete guard: structured canonical-journey media ids must be current.
node "$SCRIPT_DIR/scripts/build-media-canonical-refs.cjs" --check || { echo "Run: node services/whichpart-api/scripts/build-media-canonical-refs.cjs"; exit 1; }
# Canonical state: the BFF replays one missed turn with the SAME pure merge part-finder runs, and validates
# the control allow-list against the shared journey registry, so ship part-finder's pure canonical core
# (no handler, no I/O) as ./canonical/.
CANON_CORE="cs1.js merge.js requests.js journey-registry.js journeys.json"   # keep in step with the zip list below
mkdir -p ./canonical
for f in $CANON_CORE; do cp "$SCRIPT_DIR/../part-finder/canonical/$f" ./canonical/; done
rm -f /tmp/whichpart-api.zip
zip -qr /tmp/whichpart-api.zip index.js ai-config.js settings-admin.js config-readback.js benchmark-auth.js fit-evidence.js package.json \
  transcripts.js ddb.js conversation-state.js canonical-audit.js state-token.js live-test.js canonical/cs1.js canonical/merge.js canonical/requests.js canonical/journey-registry.js canonical/journeys.json media-catalogue.json media-canonical-refs.json knowledge-inspect.js knowledge-admin.js knowledge-inspect media-inspect.js media-admin.js media-effective.js diagnostics-inspect.js error-codes-admin.js \
  transcript-review \
  recalls \
  benchmark/acq-scoring.js benchmark/term-match.js benchmark/acq-corpus.js benchmark/acq-simulator.js \
  benchmark/acq-grade.js benchmark/acq-judge.js benchmark/acq-store.js benchmark/acq-library.js benchmark/acq-reviews.js benchmark/routing-override.js benchmark/acq-100.v1.json \
  benchmark/gold-v2/version.js
rm -f ./media-effective.js
for f in $CANON_CORE; do rm -f "./canonical/$f"; done; rmdir ./canonical 2>/dev/null || true

ACQ_JUDGE_MODEL="${ACQ_JUDGE_MODEL:-gpt-5.6-terra}"
# Production transcript review uses the live local diagnostic model by default
# (same LM Studio endpoint already on this Lambda). OpenAI remains selectable
# via TRANSCRIPT_REVIEW_PROVIDER/MODEL when a working frontier credential exists.
# Production transcript semantic review runs on Jev (TypeSafe Jev via Cloudflare) — the single
# semantic authority used across WhichPart. Credentials come from the applianceclinic-jev secret
# (same one UNDERSTAND uses); the Lambda role already has secretsmanager access to applianceclinic-*.
TRANSCRIPT_REVIEW_PROVIDER="${TRANSCRIPT_REVIEW_PROVIDER:-jev}"
TRANSCRIPT_REVIEW_MODEL="${TRANSCRIPT_REVIEW_MODEL:-}"
TRANSCRIPT_REVIEW_ENABLED="${TRANSCRIPT_REVIEW_ENABLED:-1}"
TRANSCRIPT_REVIEW_MAX_PER_RUN="${TRANSCRIPT_REVIEW_MAX_PER_RUN:-3}"
# Canonical state: OFF unless explicitly enabled (CANONICAL_MODE=shadow|control). `control` without a valid
# CANONICAL_CONTROL_JOURNEYS key is demoted to shadow in code. The signing secret is NOT provisioned by this script;
# with no secret canonical disables itself (no_signing_secret). Covered by the existing applianceclinic-* secrets policy.
CANONICAL_MODE="${CANONICAL_MODE:-off}"
# Canonical control gate: only these registry keys (services/part-finder/canonical/journeys.json) may be owned by
# canonical control (ignored unless CANONICAL_MODE=control). Unknown keys are ignored and logged (evt canonical-config).
# Separate journeys with '+' (e.g. wm-not-draining+wm-not-spinning): the Lambda env shorthand cannot carry commas.
# Rollback: redeploy with CANONICAL_MODE=shadow (or update the function env) — immediate, config only.
CANONICAL_CONTROL_JOURNEYS="${CANONICAL_CONTROL_JOURNEYS:-}"
CANONICAL_TOKEN_SECRET_ID="${CANONICAL_TOKEN_SECRET_ID:-spares4repairs/${STAGE}/applianceclinic-canonical-state-token}"
ENV="Variables={CANONICAL_MODE=$CANONICAL_MODE,CANONICAL_CONTROL_JOURNEYS=$CANONICAL_CONTROL_JOURNEYS,CANONICAL_TOKEN_SECRET_ID=$CANONICAL_TOKEN_SECRET_ID,ENGINE_URL=$ENGINE_URL,S4R_PRODUCT_BASE_URL=$S4R_PRODUCT_BASE_URL,ORCHESTRATOR_URL=$ORCHESTRATOR_URL,ORCHESTRATOR_TOKEN=$ORCHESTRATOR_TOKEN,COGNITO_USER_POOL_ID=$COGNITO_USER_POOL_ID,COGNITO_CLIENT_ID=$COGNITO_CLIENT_ID,MCP_HEALTH_URL=$MCP_HEALTH_URL,MCP_URL=$MCP_URL,MCP_BEARER_TOKEN=$MCP_BEARER_TOKEN,LM_STUDIO_URL=$LM_STUDIO_URL,LEARNING_BUCKET=$LEARNING_BUCKET,ACQ_JUDGE_MODEL=$ACQ_JUDGE_MODEL,TRANSCRIPT_TABLE=$TRANSCRIPT_TABLE,TRANSCRIPT_RETENTION_DAYS=$TRANSCRIPT_RETENTION_DAYS,TRANSCRIPT_INACTIVE_MINUTES=$TRANSCRIPT_INACTIVE_MINUTES,RECALL_TABLE=$RECALL_TABLE,WHICHPART_WEB_BUCKET=$WHICHPART_WEB_BUCKET,TRANSCRIPT_REVIEW_PROVIDER=$TRANSCRIPT_REVIEW_PROVIDER,TRANSCRIPT_REVIEW_MODEL=$TRANSCRIPT_REVIEW_MODEL,TRANSCRIPT_REVIEW_ENABLED=$TRANSCRIPT_REVIEW_ENABLED,TRANSCRIPT_REVIEW_MAX_PER_RUN=$TRANSCRIPT_REVIEW_MAX_PER_RUN}"

# 3) Create or update the function.
if aws lambda get-function --function-name "$FUNCTION" --region "$REGION" >/dev/null 2>&1; then
  echo "Updating $FUNCTION code..."
  aws lambda update-function-code --function-name "$FUNCTION" \
    --zip-file fileb:///tmp/whichpart-api.zip --region "$REGION" >/dev/null
  aws lambda wait function-updated --function-name "$FUNCTION" --region "$REGION"
  aws lambda update-function-configuration --function-name "$FUNCTION" \
    --environment "$ENV" --timeout 900 --memory-size 512 --region "$REGION" >/dev/null
  aws lambda wait function-updated --function-name "$FUNCTION" --region "$REGION"
else
  echo "Creating $FUNCTION..."
  aws lambda create-function --function-name "$FUNCTION" \
    --runtime nodejs20.x --handler index.handler --role "$ROLE_ARN" \
    --zip-file fileb:///tmp/whichpart-api.zip --timeout 900 --memory-size 512 \
    --environment "$ENV" --region "$REGION" >/dev/null
  aws lambda wait function-active --function-name "$FUNCTION" --region "$REGION"
fi

# 4) Function URL (public). CORS is owned entirely by the handler (it sets the CORS headers and
# answers OPTIONS preflight itself). We deliberately do NOT set the Function URL CORS config:
# having both AWS and the handler emit Access-Control-Allow-Origin produces duplicate headers,
# which browsers reject ("Failed to fetch"). In prod the UI is same-origin via CloudFront /api.
if ! aws lambda get-function-url-config --function-name "$FUNCTION" --region "$REGION" >/dev/null 2>&1; then
  echo "Creating Function URL..."
  aws lambda create-function-url-config --function-name "$FUNCTION" --auth-type NONE \
    --region "$REGION" >/dev/null
  aws lambda add-permission --function-name "$FUNCTION" --statement-id FunctionURLAllowPublicAccess \
    --action lambda:InvokeFunctionUrl --principal '*' --function-url-auth-type NONE \
    --region "$REGION" >/dev/null || true
  # This account also requires public lambda:InvokeFunction for the URL to
  # resolve (mirrors the existing engine function's policy).
  aws lambda add-permission --function-name "$FUNCTION" --statement-id PublicInvoke \
    --action lambda:InvokeFunction --principal '*' --region "$REGION" >/dev/null || true
fi

# Ensure no Function URL CORS config lingers (idempotent — handler owns CORS; avoids duplicate
# Access-Control-Allow-Origin headers on existing deployments).
aws lambda update-function-url-config --function-name "$FUNCTION" --cors '{}' \
  --region "$REGION" >/dev/null 2>&1 || true

URL="$(aws lambda get-function-url-config --function-name "$FUNCTION" --region "$REGION" --query FunctionUrl --output text)"
FN_ARN="$(aws lambda get-function --function-name "$FUNCTION" --region "$REGION" --query Configuration.FunctionArn --output text)"
aws lambda add-permission --function-name "$FUNCTION" --statement-id RecallIngestDaily \
  --action lambda:InvokeFunction --principal events.amazonaws.com \
  --source-arn "arn:aws:events:${REGION}:${ACCOUNT_ID}:rule/${RULE_NAME}" \
  --region "$REGION" >/dev/null 2>&1 || true
aws events put-targets --rule "$RULE_NAME" --region "$REGION" \
  --targets "Id=whichpart-api,Arn=${FN_ARN}" >/dev/null
aws lambda add-permission --function-name "$FUNCTION" --statement-id TranscriptReviewPeriodic \
  --action lambda:InvokeFunction --principal events.amazonaws.com \
  --source-arn "arn:aws:events:${REGION}:${ACCOUNT_ID}:rule/${REVIEW_RULE_NAME}" \
  --region "$REGION" >/dev/null 2>&1 || true
python3 - "$REVIEW_RULE_NAME" "$FN_ARN" "$REGION" <<'PY'
import json, subprocess, sys
rule, arn, region = sys.argv[1], sys.argv[2], sys.argv[3]
payload = {
    "Rule": rule,
    "Targets": [{"Id": "whichpart-api-review", "Arn": arn, "Input": json.dumps({"transcriptReview": True})}],
}
open("/tmp/transcript-review-targets.json", "w").write(json.dumps(payload))
subprocess.check_call([
    "aws", "events", "put-targets", "--region", region,
    "--cli-input-json", "file:///tmp/transcript-review-targets.json",
])
PY
echo "Deployed $FUNCTION -> $URL"
