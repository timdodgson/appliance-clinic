#!/usr/bin/env bash
#
# Deploys the Part Finder Lambda (spares4repairs-part-finder).
# Code-only update — does not touch env vars or function config.
#
# Usage:
#   ./deploy.sh                 # deploy to default function/region
#   FUNCTION=... REGION=... ./deploy.sh
#
set -euo pipefail

FUNCTION="${FUNCTION:-spares4repairs-part-finder}"
REGION="${REGION:-eu-west-1}"
LEARNING_BUCKET="${LEARNING_BUCKET:-whichpart-learning-800960611664}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STAGE="$(mktemp -d /tmp/part-finder-stage.XXXXXX)"
ZIP="${STAGE}.zip"

# Handler is part-finder-lambda.handler — keep the filename at the zip root.
# Bundle alongside it (all loaded via require):
#   faults-catalogue.json        — faults + error-code tables
#   retrieval.js                 — RAG knowledge retrieval
#   security.js                  — deterministic injection guard + output tripwire
#   knowledge/knowledge-index.json — precomputed, versioned knowledge index
#   inference.js                 — LLM provider boundary (COMPOSE)
#   admin-config.js              — runtime loader for admin-managed AI routing/config + Jev credentials
#   jev-client.js                — TypeSafe Jev / Cloudflare AI Gateway client
#   jev-understand.js            — UNDERSTAND decision contract + adapter
cp "$HERE/part-finder-lambda.js" "$HERE/inference.js" "$HERE/admin-config.js" "$HERE/jev-client.js" "$HERE/jev-understand.js" "$HERE/faults-catalogue.json" "$HERE/retrieval.js" "$HERE/security.js" "$HERE/identity.js" "$HERE/media-effective.js" "$HERE/health.js" "$STAGE/"
mkdir -p "$STAGE/knowledge"
#   knowledge-index.json     — precomputed retrieval index (retrieval only)
#   safety-information.json  — customer-visible safety info, keyed by knowledgeId (node-identity
#                              lookup; deliberately NOT part of the retrieval index)
#   media-information.json   — customer instructional media, keyed by knowledgeId (node-identity
#                              lookup; deliberately NOT part of the retrieval index)
#   normal-behaviour.json    — first-class NORMAL/EXPECTED behaviour knowledge (features, indicators,
#                              symbols, operating conditions), matched by identity/cue; deliberately
#                              NOT part of the retrieval index
cp "$HERE/knowledge/knowledge-index.json" "$HERE/knowledge/safety-information.json" "$HERE/knowledge/media-information.json" "$HERE/knowledge/normal-behaviour.json" "$STAGE/knowledge/"
# Canonical runtime (canonical-runtime.js = the Lambda's only entry into canonical code) + jev-mc1.js (the mc/1
# classifier Jev call) + canonical/ — every pure canonical module (mc/1 vocabulary + question set, cs/1 merge and
# requests, evidence engine, policy / COMPOSE kits, family ownership + journey modules) and journeys.json, the journey
# registry. The whole directory ships: a new journey module never needs a deploy-script edit.
cp "$HERE/canonical-runtime.js" "$HERE/jev-mc1.js" "$STAGE/"
mkdir -p "$STAGE/canonical"
cp "$HERE"/canonical/*.js "$HERE/canonical/journeys.json" "$STAGE/canonical/"

( cd "$STAGE" && zip -r -q "$ZIP" . )

ROLE_ARN="$(aws lambda get-function-configuration --function-name "$FUNCTION" --region "$REGION" --query Role --output text)"
ROLE_NAME="${ROLE_ARN##*/}"
aws iam put-role-policy --role-name "$ROLE_NAME" --policy-name whichpart-media-overlay-s3 \
  --policy-document "{\"Version\":\"2012-10-17\",\"Statement\":[{\"Effect\":\"Allow\",\"Action\":[\"s3:GetObject\"],\"Resource\":\"arn:aws:s3:::${LEARNING_BUCKET}/media-admin/*\"},{\"Effect\":\"Allow\",\"Action\":[\"s3:ListBucket\"],\"Resource\":\"arn:aws:s3:::${LEARNING_BUCKET}\",\"Condition\":{\"StringLike\":{\"s3:prefix\":[\"media-admin\",\"media-admin/*\"]}}}]}" >/dev/null
echo "Ensured media overlay read policy on $ROLE_NAME."
# Published Admin knowledge overlay (read-only). ListBucket on the prefix so a missing overlay reads as
# NoSuchKey (baseline in use) rather than AccessDenied (reported as unavailable).
aws iam put-role-policy --role-name "$ROLE_NAME" --policy-name whichpart-knowledge-overlay-s3 \
  --policy-document "{\"Version\":\"2012-10-17\",\"Statement\":[{\"Effect\":\"Allow\",\"Action\":[\"s3:GetObject\"],\"Resource\":\"arn:aws:s3:::${LEARNING_BUCKET}/knowledge-admin/published.json\"},{\"Effect\":\"Allow\",\"Action\":[\"s3:ListBucket\"],\"Resource\":\"arn:aws:s3:::${LEARNING_BUCKET}\",\"Condition\":{\"StringLike\":{\"s3:prefix\":[\"knowledge-admin\",\"knowledge-admin/*\"]}}}]}" >/dev/null
echo "Ensured knowledge overlay read policy on $ROLE_NAME."

aws lambda update-function-code \
  --function-name "$FUNCTION" \
  --zip-file "fileb://$ZIP" \
  --region "$REGION"

rm -rf "$ZIP" "$STAGE"
echo "Deployed $FUNCTION to $REGION (with knowledge index)"
