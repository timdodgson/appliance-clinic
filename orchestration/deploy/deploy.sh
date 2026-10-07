#!/usr/bin/env bash
# Deploy Customer Diagnostic Orchestrator V1 as a container-image Lambda + Function URL
# (isolated test endpoint). Reuses the repo's Lambda+Function-URL+ECR convention. Idempotent.
#
# The orchestrator calls the deployed Error-Code MCP (bearer) and the deployed Diagnostic RAG.
# Its own bearer + the MCP bearer are stored in Secrets Manager and injected as env at deploy time
# (never committed, never baked into the image, never returned to clients). No CDK.
set -euo pipefail

REGION="${REGION:-eu-west-1}"
FUNCTION="${FUNCTION:-spares4repairs-diag-orchestrator}"
ECR_REPO="${ECR_REPO:-spares4repairs-diag-orchestrator}"
ROLE_NAME="${ROLE_NAME:-diag-orchestrator-role}"
ORCH_SECRET="${ORCH_SECRET:-spares4repairs/diag-orchestrator/bearer-token}"
MCP_SECRET="${MCP_SECRET:-spares4repairs/error-code-mcp/bearer-token}"
MCP_URL="${MCP_URL:-https://657tahkrqxc72sxbt775wrbqnu0tasav.lambda-url.eu-west-1.on.aws/}"
RAG_URL="${RAG_URL:-https://3asx4cw2qs5ajsjkytdwffhhvy0ptnoz.lambda-url.eu-west-1.on.aws/}"
ARCH="${ARCH:-arm64}"; PLATFORM="linux/${ARCH}"; TAG="${TAG:-v1}"

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$HERE/../.." && pwd)"

build_image() {
  # Classic `docker build` on this host has BuildKit off and rejects --provenance.
  # Buildx with provenance/sbom disabled produces a single-platform image Lambda will accept.
  DOCKER_BUILDKIT=1 docker buildx build --platform "$PLATFORM" --provenance=false --sbom=false --load \
    -f "$REPO_ROOT/orchestration/deploy/Dockerfile" -t "$ECR_REPO:$TAG" "$REPO_ROOT" >&2
  echo "$ECR_REPO:$TAG"
}

if [[ "${1:-}" == "--build" ]]; then build_image; exit 0; fi

ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"
ECR_URI="$ACCOUNT_ID.dkr.ecr.$REGION.amazonaws.com/$ECR_REPO"
echo "Account $ACCOUNT_ID | region $REGION | function $FUNCTION | arch $ARCH"

# 1) ECR repo
aws ecr describe-repositories --repository-names "$ECR_REPO" --region "$REGION" >/dev/null 2>&1 \
  || aws ecr create-repository --repository-name "$ECR_REPO" --region "$REGION" --image-scanning-configuration scanOnPush=true >/dev/null

# 2) orchestrator bearer secret (create once; never printed)
if ! aws secretsmanager describe-secret --secret-id "$ORCH_SECRET" --region "$REGION" >/dev/null 2>&1; then
  TOKEN="$(python3 -c 'import secrets;print(secrets.token_hex(32))')"
  aws secretsmanager create-secret --name "$ORCH_SECRET" --secret-string "$TOKEN" --region "$REGION" >/dev/null
  echo "Created orchestrator bearer secret $ORCH_SECRET (value not shown)"
fi
ORCH_TOKEN="$(aws secretsmanager get-secret-value --secret-id "$ORCH_SECRET" --region "$REGION" --query SecretString --output text)"
MCP_TOKEN="$(aws secretsmanager get-secret-value --secret-id "$MCP_SECRET" --region "$REGION" --query SecretString --output text)"

# 3) build + push image
build_image
IMG="$ECR_REPO:$TAG"
aws ecr get-login-password --region "$REGION" | docker login --username AWS --password-stdin "$ECR_URI" >/dev/null
docker tag "$IMG" "$ECR_URI:$TAG"; docker push "$ECR_URI:$TAG" >/dev/null
echo "Pushed $ECR_URI:$TAG"

# 4) execution role (basic logging only; no data-plane perms — downstream reached over HTTPS)
if ! aws iam get-role --role-name "$ROLE_NAME" >/dev/null 2>&1; then
  aws iam create-role --role-name "$ROLE_NAME" \
    --assume-role-policy-document '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"lambda.amazonaws.com"},"Action":"sts:AssumeRole"}]}' >/dev/null
  aws iam attach-role-policy --role-name "$ROLE_NAME" --policy-arn arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole >/dev/null
  echo "Waiting for role propagation..."; sleep 12
fi
ROLE_ARN="$(aws iam get-role --role-name "$ROLE_NAME" --query 'Role.Arn' --output text)"

# 5) create / update function (env carries downstream URLs + bearers from Secrets Manager)
ENVJSON="Variables={MCP_URL=$MCP_URL,RAG_URL=$RAG_URL,MCP_BEARER_TOKEN=$MCP_TOKEN,ORCH_BEARER_TOKEN=$ORCH_TOKEN}"
if aws lambda get-function --function-name "$FUNCTION" --region "$REGION" >/dev/null 2>&1; then
  aws lambda update-function-code --function-name "$FUNCTION" --image-uri "$ECR_URI:$TAG" --region "$REGION" >/dev/null
  aws lambda wait function-updated --function-name "$FUNCTION" --region "$REGION"
  aws lambda update-function-configuration --function-name "$FUNCTION" \
    --timeout 120 --memory-size 512 --environment "$ENVJSON" --region "$REGION" >/dev/null
  aws lambda wait function-updated --function-name "$FUNCTION" --region "$REGION"
else
  aws lambda create-function --function-name "$FUNCTION" --package-type Image --code ImageUri="$ECR_URI:$TAG" \
    --role "$ROLE_ARN" --architectures "$ARCH" --timeout 120 --memory-size 512 --environment "$ENVJSON" --region "$REGION" >/dev/null
  aws lambda wait function-active --function-name "$FUNCTION" --region "$REGION"
fi

# 6) Function URL (BUFFERED; transport open, app-layer bearer enforced by the handler)
if ! aws lambda get-function-url-config --function-name "$FUNCTION" --region "$REGION" >/dev/null 2>&1; then
  aws lambda create-function-url-config --function-name "$FUNCTION" --auth-type NONE --invoke-mode BUFFERED \
    --cors '{"AllowOrigins":["*"],"AllowMethods":["POST","GET"],"AllowHeaders":["content-type","authorization"],"MaxAge":300}' --region "$REGION" >/dev/null
  aws lambda add-permission --function-name "$FUNCTION" --statement-id FunctionURLAllowPublicAccess \
    --action lambda:InvokeFunctionUrl --principal '*' --function-url-auth-type NONE --region "$REGION" >/dev/null || true
  aws lambda add-permission --function-name "$FUNCTION" --statement-id PublicInvoke \
    --action lambda:InvokeFunction --principal '*' --region "$REGION" >/dev/null || true
fi
URL="$(aws lambda get-function-url-config --function-name "$FUNCTION" --region "$REGION" --query FunctionUrl --output text)"
echo "Deployed $FUNCTION -> $URL"
echo "  health: ${URL}health   diagnose: POST ${URL}diagnose"
