#!/usr/bin/env bash
# Deploy Error-Code MCP V1 as a container-image Lambda + Function URL (deployment-test env).
# Reuses the repo's Lambda + Function URL microservice convention (cf. services/*/deploy.sh) and
# ECR convention (cf. scripts/setup-fargate-generator.sh). Idempotent.
#
# The image runs the banked MCP Streamable HTTP server (uvicorn ASGI) via the AWS Lambda Web
# Adapter. Bearer token is stored in Secrets Manager and injected as a Lambda env var at deploy
# time (never baked into the image, never committed).
#
# Usage:
#   ./deploy.sh --local     # stage + build + run container locally on :8080 (no AWS)
#   ./deploy.sh             # stage + build (arm64) + push to ECR + create/update Lambda + Function URL
set -euo pipefail

REGION="${REGION:-eu-west-1}"
FUNCTION="${FUNCTION:-spares4repairs-error-code-mcp}"
ECR_REPO="${ECR_REPO:-spares4repairs-error-code-mcp}"
ROLE_NAME="${ROLE_NAME:-error-code-mcp-role}"
SECRET_NAME="${SECRET_NAME:-spares4repairs/error-code-mcp/bearer-token}"
LEARNING_BUCKET="${LEARNING_BUCKET:-whichpart-learning-800960611664}"
ARCH="${ARCH:-arm64}"
PLATFORM="linux/${ARCH}"
TAG="${TAG:-v1}"

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"     # error-codes/mcp/deploy
MCP_DIR="$(dirname "$HERE")"                              # error-codes/mcp
EC_DIR="$(dirname "$MCP_DIR")"                            # error-codes

# ---------- stage a minimal build context (only banked artifacts + code) ----------
stage_context() {
  local S; S="$(mktemp -d "${TMPDIR:-/tmp}/ec-mcp-ctx.XXXXXX")"
  mkdir -p "$S/runtime-model/compiler" "$S/runtime-model/generated" \
           "$S/enrichment" "$S/tools" "$S/identifier-map" "$S/mcp/schemas" "$S/mcp/deploy"
  cp "$EC_DIR/runtime-model/compiler/resolve.py"        "$S/runtime-model/compiler/"
  cp -R "$EC_DIR/runtime-model/generated/runtime"       "$S/runtime-model/generated/runtime"
  cp -R "$EC_DIR/enrichment/generated"                  "$S/enrichment/generated"
  cp "$EC_DIR/tools/resolve-identifier.py"              "$S/tools/"
  cp -R "$EC_DIR/identifier-map"                        "$S/identifier-map.tmp" && rm -rf "$S/identifier-map" && mv "$S/identifier-map.tmp" "$S/identifier-map"
  cp "$MCP_DIR/tools.py" "$MCP_DIR/mcp_http_server.py" "$MCP_DIR/catalogue_effective.py" "$MCP_DIR/catalogue_store.py" "$MCP_DIR/catalogue_api.py" "$MCP_DIR/catalogue_workflow.py" "$S/mcp/"
  cp -R "$MCP_DIR/schemas/." "$S/mcp/schemas/"
  cp "$HERE/asgi.py" "$HERE/integrity.py"               "$S/mcp/deploy/"
  cp "$HERE/requirements.txt"                           "$S/mcp/deploy/"
  cp "$HERE/Dockerfile"                                 "$S/mcp/deploy/Dockerfile"
  printf '%s' "$S"
}

build_image() {
  local ctx; ctx="$(stage_context)"
  echo "Staged build context: $ctx" >&2
  # Classic `docker build` on this host has BuildKit off and rejects --provenance.
  # Buildx with provenance/sbom disabled produces a single-platform image Lambda will accept.
  DOCKER_BUILDKIT=1 docker buildx build --platform "$PLATFORM" --provenance=false --sbom=false --load \
    -f "$ctx/mcp/deploy/Dockerfile" -t "$ECR_REPO:$TAG" "$ctx" >&2
  rm -rf "$ctx"
  echo "$ECR_REPO:$TAG"
}

if [[ "${1:-}" == "--build" ]]; then
  build_image
  exit 0
fi

if [[ "${1:-}" == "--local" ]]; then
  IMG="$(build_image)"
  echo "Running $IMG locally on :8080 (Ctrl-C to stop)"
  docker run --rm -e MCP_BEARER_TOKEN="${MCP_BEARER_TOKEN:-local-test-token}" -p 8080:8080 "$IMG"
  exit 0
fi

ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"
ECR_URI="$ACCOUNT_ID.dkr.ecr.$REGION.amazonaws.com/$ECR_REPO"
echo "Account $ACCOUNT_ID | region $REGION | function $FUNCTION | arch $ARCH"

# 1) ECR repo
aws ecr describe-repositories --repository-names "$ECR_REPO" --region "$REGION" >/dev/null 2>&1 \
  || aws ecr create-repository --repository-name "$ECR_REPO" --region "$REGION" \
       --image-scanning-configuration scanOnPush=true >/dev/null

# 2) bearer secret (create once; never printed). Rotate with: aws secretsmanager put-secret-value ...
if ! aws secretsmanager describe-secret --secret-id "$SECRET_NAME" --region "$REGION" >/dev/null 2>&1; then
  TOKEN="$(python3 -c 'import secrets;print(secrets.token_hex(32))')"
  aws secretsmanager create-secret --name "$SECRET_NAME" --secret-string "$TOKEN" --region "$REGION" >/dev/null
  echo "Created bearer secret $SECRET_NAME (value not shown)"
fi
BEARER="$(aws secretsmanager get-secret-value --secret-id "$SECRET_NAME" --region "$REGION" --query SecretString --output text)"

# 3) build + push image
IMG="$(build_image)"
aws ecr get-login-password --region "$REGION" | docker login --username AWS --password-stdin "$ECR_URI" >/dev/null
docker tag "$IMG" "$ECR_URI:$TAG"
docker push "$ECR_URI:$TAG" >/dev/null
DIGEST="$(aws ecr describe-images --repository-name "$ECR_REPO" --image-ids imageTag="$TAG" --region "$REGION" --query 'imageDetails[0].imageDigest' --output text)"
echo "Pushed $ECR_URI:$TAG @ $DIGEST"

# 4) execution role (logs + overlay S3 read/write)
if ! aws iam get-role --role-name "$ROLE_NAME" >/dev/null 2>&1; then
  aws iam create-role --role-name "$ROLE_NAME" \
    --assume-role-policy-document '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"lambda.amazonaws.com"},"Action":"sts:AssumeRole"}]}' >/dev/null
  aws iam attach-role-policy --role-name "$ROLE_NAME" \
    --policy-arn arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole >/dev/null
  echo "Waiting for role propagation..."; sleep 12
fi
aws iam put-role-policy --role-name "$ROLE_NAME" --policy-name error-code-admin-overlay-s3 \
  --policy-document "{\"Version\":\"2012-10-17\",\"Statement\":[{\"Effect\":\"Allow\",\"Action\":[\"s3:GetObject\",\"s3:PutObject\"],\"Resource\":\"arn:aws:s3:::${LEARNING_BUCKET}/error-code-admin/*\"},{\"Effect\":\"Allow\",\"Action\":[\"s3:ListBucket\"],\"Resource\":\"arn:aws:s3:::${LEARNING_BUCKET}\",\"Condition\":{\"StringLike\":{\"s3:prefix\":[\"error-code-admin\",\"error-code-admin/*\"]}}}]}" >/dev/null
echo "Ensured error-code overlay S3 policy on $ROLE_NAME."
ROLE_ARN="$(aws iam get-role --role-name "$ROLE_NAME" --query 'Role.Arn' --output text)"

# 5) create / update function (from image). Bearer injected as env from Secrets Manager value.
ENVJSON="Variables={MCP_BEARER_TOKEN=$BEARER,LEARNING_BUCKET=$LEARNING_BUCKET}"
if aws lambda get-function --function-name "$FUNCTION" --region "$REGION" >/dev/null 2>&1; then
  aws lambda update-function-code --function-name "$FUNCTION" --image-uri "$ECR_URI:$TAG" --region "$REGION" >/dev/null
  aws lambda wait function-updated --function-name "$FUNCTION" --region "$REGION"
  aws lambda update-function-configuration --function-name "$FUNCTION" \
    --timeout 30 --memory-size 512 --environment "$ENVJSON" --region "$REGION" >/dev/null
  aws lambda wait function-updated --function-name "$FUNCTION" --region "$REGION"
else
  aws lambda create-function --function-name "$FUNCTION" \
    --package-type Image --code ImageUri="$ECR_URI:$TAG" \
    --role "$ROLE_ARN" --architectures "$ARCH" \
    --timeout 30 --memory-size 512 --environment "$ENVJSON" --region "$REGION" >/dev/null
  aws lambda wait function-active --function-name "$FUNCTION" --region "$REGION"
fi

# 6) Function URL (BUFFERED — MCP runs in json_response mode, single JSON body per request).
if ! aws lambda get-function-url-config --function-name "$FUNCTION" --region "$REGION" >/dev/null 2>&1; then
  aws lambda create-function-url-config --function-name "$FUNCTION" --auth-type NONE \
    --invoke-mode BUFFERED \
    --cors '{"AllowOrigins":["*"],"AllowMethods":["POST","GET"],"AllowHeaders":["content-type","authorization","mcp-session-id","mcp-protocol-version","accept"],"MaxAge":300}' \
    --region "$REGION" >/dev/null
  aws lambda add-permission --function-name "$FUNCTION" --statement-id FunctionURLAllowPublicAccess \
    --action lambda:InvokeFunctionUrl --principal '*' --function-url-auth-type NONE --region "$REGION" >/dev/null || true
  aws lambda add-permission --function-name "$FUNCTION" --statement-id PublicInvoke \
    --action lambda:InvokeFunction --principal '*' --region "$REGION" >/dev/null || true
fi
URL="$(aws lambda get-function-url-config --function-name "$FUNCTION" --region "$REGION" --query FunctionUrl --output text)"
echo "Deployed $FUNCTION -> $URL"
echo "MCP endpoint: ${URL}mcp   health: ${URL}health"
