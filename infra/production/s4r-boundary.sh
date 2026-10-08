#!/usr/bin/env bash
# Phase 5 step 5.10: the S4R resources around the diagnosis Lambda, for the before/after comparison. READ-ONLY.
#
#   bash s4r-boundary.sh > boundary.json
#
# The S4R execution role (trust, attached and inline policies with their documents) and API 65vnizdmk4 (the API, its
# routes, integrations and stages). Neither is imported or managed; both must be exactly the same after the import.
# Timestamps that move without a change (stage LastUpdatedDate) are left out.
set -euo pipefail
export AWS_REGION=eu-west-1 AWS_DEFAULT_REGION=eu-west-1
ROLE=SparesSite-dev-ServerFunctionRoleC337EDB9-7aUzUc2qUHib
API=65vnizdmk4

inline='{}'
for p in $(aws iam list-role-policies --role-name "$ROLE" --query 'PolicyNames[]' --output text); do
  inline=$(jq --arg p "$p" --argjson d "$(aws iam get-role-policy --role-name "$ROLE" --policy-name "$p" --query PolicyDocument --output json)" '. + {($p): $d}' <<<"$inline")
done
managed='{}'
for arn in $(aws iam list-attached-role-policies --role-name "$ROLE" --query 'AttachedPolicies[].PolicyArn' --output text); do
  v=$(aws iam get-policy --policy-arn "$arn" --query Policy.DefaultVersionId --output text)
  managed=$(jq --arg a "$arn" --arg v "$v" --argjson d "$(aws iam get-policy-version --policy-arn "$arn" --version-id "$v" --query PolicyVersion.Document --output json)" \
    '. + {($a): {defaultVersion: $v, document: $d}}' <<<"$managed")
done
role=$(aws iam get-role --role-name "$ROLE" --query 'Role.{arn: Arn, trust: AssumeRolePolicyDocument, path: Path, maxSessionDuration: MaxSessionDuration, boundary: PermissionsBoundary.PermissionsBoundaryArn, tags: Tags}' --output json)

api=$(aws apigatewayv2 get-api --api-id "$API" --output json | jq 'del(.CreatedDate)')
routes=$(aws apigatewayv2 get-routes --api-id "$API" --query 'Items' --output json | jq 'sort_by(.RouteKey)')
integrations=$(aws apigatewayv2 get-integrations --api-id "$API" --query 'Items' --output json | jq 'sort_by(.IntegrationId)')
stages=$(aws apigatewayv2 get-stages --api-id "$API" --query 'Items' --output json | jq 'map(del(.CreatedDate, .LastUpdatedDate)) | sort_by(.StageName)')

jq -n --argjson role "$role" --argjson inline "$inline" --argjson managed "$managed" --argjson api "$api" --argjson routes "$routes" \
  --argjson integrations "$integrations" --argjson stages "$stages" \
  '{s4rRole: ($role + {inline: $inline, managed: $managed}), api: $api, routes: $routes, integrations: $integrations, stages: $stages}'
