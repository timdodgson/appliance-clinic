#!/usr/bin/env bash
# Capture the live configuration of the AC runtime resources (Phase 5 steps 5.5 to 5.10). READ-ONLY.
#
#   bash capture-runtime.sh production|sandbox <out.json>
#
# The output is the single source of the runtime stack's template (infra/cdk/lib/runtime-stack.js), so the template
# carries the live configuration by construction. It holds environment values, including bearer tokens, so it is
# written with mode 0600 under .migration-output/ and never committed; the template turns each token into a NoEcho
# parameter whose value is taken from this file at change-set time.
set -euo pipefail
PROFILE=${1:?production|sandbox}; OUT=${2:?out}
export AWS_REGION=eu-west-1 AWS_DEFAULT_REGION=eu-west-1
A=800960611664
if [[ $PROFILE == sandbox ]]; then S=-sbx; else S=; fi
ROLES=(whichpart-api-role$S diag-orchestrator-role$S error-code-mcp-role$S)
# Phase 7 (B): the diagnosis Lambda's own role, created by AcRuntimeStack (change 7.15a); skipped until it exists.
[[ $PROFILE == production ]] && ROLES+=(ac-diagnosis-role)
FUNCTIONS=(spares4repairs-error-code-mcp$S spares4repairs-diag-orchestrator$S whichpart-api$S spares4repairs-part-finder$S)
RULES=(whichpart-recall-ingest-daily$S whichpart-transcript-review$S)
umask 077

roles='{}'
for r in "${ROLES[@]}"; do
  aws iam get-role --role-name "$r" >/dev/null 2>&1 || continue
  inline='{}'
  for p in $(aws iam list-role-policies --role-name "$r" --query 'PolicyNames[]' --output text); do
    inline=$(jq --arg p "$p" --argjson d "$(aws iam get-role-policy --role-name "$r" --policy-name "$p" --query PolicyDocument --output json)" '. + {($p): $d}' <<<"$inline")
  done
  roles=$(jq --arg r "$r" --argjson role "$(aws iam get-role --role-name "$r" --query 'Role.{trust: AssumeRolePolicyDocument, path: Path, maxSessionDuration: MaxSessionDuration, description: Description, boundary: PermissionsBoundary.PermissionsBoundaryArn, tags: Tags}' --output json)" \
    --argjson managed "$(aws iam list-attached-role-policies --role-name "$r" --query 'AttachedPolicies[].PolicyArn' --output json)" --argjson inline "$inline" \
    '. + {($r): ($role + {managed: $managed, inline: $inline})}' <<<"$roles")
done

functions='{}'
for f in "${FUNCTIONS[@]}"; do
  aws lambda get-function --function-name "$f" >/dev/null 2>&1 || continue
  fn=$(aws lambda get-function --function-name "$f" --output json)
  url=$(aws lambda get-function-url-config --function-name "$f" --output json 2>/dev/null | jq '{FunctionUrl, AuthType, InvokeMode, Cors}' || echo null)
  pol=$(aws lambda get-policy --function-name "$f" --query Policy --output text 2>/dev/null | jq '.Statement' || echo '[]')
  conc=$(aws lambda get-function-concurrency --function-name "$f" --query ReservedConcurrentExecutions --output json)
  eic=$(aws lambda get-function-event-invoke-config --function-name "$f" --output json 2>/dev/null || echo null)
  rec=$(aws lambda get-function-recursion-config --function-name "$f" --query RecursiveLoop --output text 2>/dev/null || echo null)
  functions=$(jq --arg f "$f" --argjson fn "$fn" --argjson url "$url" --argjson pol "$pol" --argjson conc "$conc" --argjson eic "$eic" --arg rec "$rec" '. + {($f): {
      configuration: ($fn.Configuration | del(.LastModified, .RevisionId, .State, .StateReason, .StateReasonCode, .LastUpdateStatus, .LastUpdateStatusReason, .LastUpdateStatusReasonCode, .Version, .FunctionArn, .MasterArn, .SigningJobArn, .SigningProfileVersionArn)),
      code: {imageUri: $fn.Code.ImageUri, resolvedImageUri: $fn.Code.ResolvedImageUri, repositoryType: $fn.Code.RepositoryType},
      tags: ($fn.Tags // {}), url: $url, statements: $pol, reservedConcurrency: $conc, eventInvokeConfig: $eic, recursiveLoop: $rec}}' <<<"$functions")
done

rules='{}'
for r in "${RULES[@]}"; do
  aws events describe-rule --name "$r" >/dev/null 2>&1 || continue
  rules=$(jq --arg r "$r" --argjson d "$(aws events describe-rule --name "$r" --output json)" \
    --argjson t "$(aws events list-targets-by-rule --rule "$r" --query Targets --output json)" \
    --argjson tags "$(aws events list-tags-for-resource --resource-arn "arn:aws:events:eu-west-1:$A:rule/$r" --query Tags --output json)" \
    '. + {($r): (($d | {name: .Name, scheduleExpression: .ScheduleExpression, state: .State, description: .Description, eventBusName: .EventBusName, roleArn: .RoleArn}) + {targets: $t, tags: $tags})}' <<<"$rules")
done

jq -n --arg profile "$PROFILE" --arg at "$(date -u +%FT%TZ)" --argjson roles "$roles" --argjson functions "$functions" --argjson rules "$rules" \
  '{profile: $profile, capturedAt: $at, roles: $roles, functions: $functions, rules: $rules}' > "$OUT"
chmod 600 "$OUT"
echo "captured $(jq '.roles | length' "$OUT") roles, $(jq '.functions | length' "$OUT") functions, $(jq '.rules | length' "$OUT") rules into $OUT" >&2
