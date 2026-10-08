#!/usr/bin/env bash
# One Phase 5 import step (runbook: docs/migration/runbooks/phase-5-import.md). Run as the IAM user:
#
#   EXECUTE=1 bash infra/production/steps/import.sh <step>      e.g. 5.1
#
# Import semantics (docs/migration/phase-5-import-semantics.md): after an import, CloudFormation runs each resource's
# update handler with the execution role. So:
#   1. the template carries the live configuration exactly (data: infra/cdk; runtime: a fresh capture of live)
#   2. a snapshot of the step's resources is taken
#   3. ac-cfn-execution gets a version holding the read-only base plus exactly the manifest's writes on exactly this
#      step's resources (docs/migration/phase-5-import-writes.json); it goes back to the read-only version right after
#   4. a checked IMPORT change set (import mode, exact expected changes) is executed
#   5. drift straight after: every resource IN_SYNC; the same template is a no-op; the stack policy is set
#   6. the after snapshot may differ from the before snapshot only by aws:cloudformation:* tags
#   7. CloudTrail (after delivery): every write by the execution role is one the manifest expects (check-cloudtrail.sh)
# Step 5.10 (the diagnosis Lambda, POTENTIALLY IMPACTS S4R) runs only with its sign-off, APPROVE_5_10=spares4repairs-part-finder:
# its step policy must add exactly the approved statement, and the S4R role and API 65vnizdmk4 (s4r-boundary.sh) must be
# exactly the same after the import as before.
source "$(dirname "$0")/../lib.sh"
require_caller
STEP=${1:?step}
APPROVED_5_10='[{"Sid":"Step510Writes1","Effect":"Allow","Action":["lambda:TagResource"],"Resource":["arn:aws:lambda:eu-west-1:800960611664:function:spares4repairs-part-finder"]}]'
[[ $STEP == 5.10 && ${APPROVE_5_10:-} != spares4repairs-part-finder ]] && stop "5.10 (diagnosis Lambda) runs only with its sign-off: APPROVE_5_10=spares4repairs-part-finder"
SF=$P5_ROOT/infra/production/steps/$STEP.json
[[ -s $SF ]] || stop "no step file $SF"
STACK=$(jq -r .stack "$SF")
check_stack_name "$STACK"
W=$P5_OUT/$STEP
mkdir -p "$W"
RES=$W/results.txt
: > "$RES"
result() { log "$*"; echo "$*" >> "$RES"; }
RUNTIME=0; [[ $STACK == AcRuntimeStack ]] && RUNTIME=1
CAP=$P5_OUT/live/runtime-production.json
CODE=$P5_OUT/live/code-locations.json
umask 077

# --- Live inputs -------------------------------------------------------------------------------------------------
if [[ $RUNTIME == 1 ]]; then
  mkdir -p "$P5_OUT/live"
  bash "$P5_ROOT/infra/production/capture-runtime.sh" production "$CAP"
  # Zip functions: the deployed artefact, byte for byte (its SHA-256 must equal the live CodeSha256), in the toolkit bucket.
  B=cdk-acclinic-assets-$P5_ACCOUNT-$P5_REGION
  echo '{}' > "$CODE.tmp"
  for f in $(jq -r '.functions | to_entries[] | select(.value.configuration.PackageType == "Zip") | .key' "$CAP"); do
    sha=$(jq -r --arg f "$f" '.functions[$f].configuration.CodeSha256' "$CAP")
    key=phase5/$f-$(tr '/+' '_-' <<<"${sha%=}").zip
    if ! aws s3api head-object --bucket "$B" --key "$key" >/dev/null 2>&1; then
      url=$(aws lambda get-function --function-name "$f" --query Code.Location --output text)
      curl -sSf -o "$W/$f.zip" "$url"
      [[ $(openssl dgst -sha256 -binary "$W/$f.zip" | base64) == "$sha" ]] || stop "$f: downloaded artefact does not match CodeSha256"
      [[ $EXECUTE == 1 ]] && aws s3 cp --quiet "$W/$f.zip" "s3://$B/$key"
      : > "$W/$f.zip"
    fi
    jq --arg f "$f" --arg b "$B" --arg k "$key" '. + {($f): {s3Bucket: $b, s3Key: $k}}' "$CODE.tmp" > "$CODE.tmp2" && mv "$CODE.tmp2" "$CODE.tmp"
  done
  mv "$CODE.tmp" "$CODE"
fi

synth_step() { # STEP OUT
  (cd "$P5_ROOT/infra/cdk" && env -u AWS_ACCESS_KEY_ID -u AWS_SECRET_ACCESS_KEY -u AWS_SESSION_TOKEN AWS_EC2_METADATA_DISABLED=true CDK_DISABLE_VERSION_CHECK=1 \
    npx cdk synth --quiet --no-notices -c step="$1" -c declare='{"ecrRepositoryPolicy":true}' \
    $( [[ $RUNTIME == 1 ]] && echo "-c live=$CAP -c code=$CODE" ) >/dev/null 2>&1) || stop "cdk synth failed for step $1"
  cp "$P5_ROOT/infra/cdk/cdk.out/$STACK.template.json" "$2"
}
params_for() { # TEMPLATE: NoEcho token parameters from the live capture (mode 0600, deleted at exit)
  unset P5_PARAMS
  [[ $(jq '[.Parameters // {} | keys[] | select(. != "BootstrapVersion")] | length' "$1") == 0 ]] && return 0
  node "$P5_ROOT/infra/production/token-params.mjs" "$1" "$CAP" production "$W/params.json"
  P5_PARAMS=file://$W/params.json
}
# The parameters file holds bearer tokens: it is emptied (not left behind) whatever happens.
trap ': > "$W/params.json"' EXIT

if ! stack_exists "$STACK"; then
  synth_step shell "$W/shell.template.json"
  create_shell "$STACK" "$W/shell.template.json"
  [[ $EXECUTE == 1 ]] && result "shell: $STACK created (StackShell only, execution role, termination protection)"
fi

T=$W/template.json
synth_step "$STEP" "$T"
if [[ $STEP == 5.10 ]]; then
  # The S4R stack name is acknowledged only as part of the S4R role name: exactly one occurrence, the function's Role.
  [[ $(jq -c '[paths(type == "string" and contains("SparesSite-dev")) as $p | {p: $p, v: getpath($p)}]' "$T") == \
     '[{"p":["Resources","spares4repairspartfinder","Properties","Role"],"v":"arn:aws:iam::'$P5_ACCOUNT':role/SparesSite-dev-ServerFunctionRoleC337EDB9-7aUzUc2qUHib"}]' ]] \
    || stop "5.10: SparesSite-dev occurs in the template other than as the function's S4R role"
fi
params_for "$T"
jq '.import' "$SF" > "$W/import.json"
bash "$P5_ROOT/infra/production/snapshot.sh" "$SF" > "$W/before.json"
[[ $STEP == 5.10 ]] && bash "$P5_ROOT/infra/production/s4r-boundary.sh" > "$W/boundary-before.json"

# --- The step's writes, and nothing else --------------------------------------------------------------------------
POL=arn:aws:iam::$P5_ACCOUNT:policy/ac-cfn-execution
(cd "$P5_TOOLS" && npm run -s production:toolkit -- --check >/dev/null) || stop "toolkit documents are stale"
(cd "$P5_TOOLS" && node bin/import-writes.mjs step-policy --step "$SF") > "$W/step-policy.json"
if [[ $STEP == 5.10 ]]; then
  cmp -s <(jq -S '[.Statement[] | select(.Sid | startswith("Step"))]' "$W/step-policy.json") <(jq -S . <<<"$APPROVED_5_10") \
    || stop "5.10: the step policy's writes are not exactly the approved statement"
fi
BASE_DOC=$P5_ROOT/docs/migration/phase-5/toolkit/ac-cfn-execution.json
version_of() { # DOCUMENT: the version ID holding exactly this document, if any
  for v in $(aws iam list-policy-versions --policy-arn "$POL" --query 'Versions[].VersionId' --output text); do
    cmp -s <(aws iam get-policy-version --policy-arn "$POL" --version-id "$v" --query PolicyVersion.Document --output json | jq -S .) <(jq -S . "$1") && { echo "$v"; return; }
  done
}
make_version() { # DOCUMENT: create it as a version (dropping the oldest non-default one at the limit of five); print its ID
  local v; v=$(version_of "$1"); [[ -n $v ]] && { echo "$v"; return; }
  if [[ $(aws iam list-policy-versions --policy-arn "$POL" --query 'length(Versions)') -ge 5 ]]; then
    aws iam delete-policy-version --policy-arn "$POL" --version-id \
      "$(aws iam list-policy-versions --policy-arn "$POL" --query 'Versions[?!IsDefaultVersion] | sort_by(@, &CreateDate)[0].VersionId' --output text)"
  fi
  aws iam create-policy-version --policy-arn "$POL" --policy-document "file://$1" --query PolicyVersion.VersionId --output text
}
set_default() { aws iam set-default-policy-version --policy-arn "$POL" --version-id "$1"; sleep 15; }   # IAM propagation

if [[ $EXECUTE == 1 ]]; then
  BASE_V=$(make_version "$BASE_DOC")
  STEP_V=$BASE_V
  if ! cmp -s <(jq -S . "$BASE_DOC") <(jq -S . "$W/step-policy.json"); then STEP_V=$(make_version "$W/step-policy.json"); fi
  set_default "$STEP_V"
  # Whatever happens next, the execution role goes back to read-only.
  trap ': > "$W/params.json"; aws iam set-default-policy-version --policy-arn "$POL" --version-id "$BASE_V"' EXIT
  result "$STEP execution policy: $STEP_V = read-only + $(jq -c '[.Statement[] | select(.Sid | startswith("Step")) | .Action[]]' "$W/step-policy.json") on this step's resources"
fi

start=$(date -u +%FT%TZ)
changeset "$STACK" "import-${STEP//./-}" IMPORT "$T" "$SF" "$W/import.json"
[[ $EXECUTE == 1 ]] || exit 0
end=$(date -u +%FT%TZ)
set_default "$BASE_V"
result "$STEP execution policy back to read-only ($BASE_V)"
jq -n --arg s "$start" --arg e "$end" --arg role "cdk-acclinic-cfn-exec-role-$P5_ACCOUNT-$P5_REGION" --argjson types "$(jq '[.import[].ResourceType] | unique' "$SF")" \
  '{start: $s, end: $e, role: $role, types: $types}' > "$W/window.json"
result "$STEP import: $(jq -r '[.Changes[].ResourceChange | "\(.Action) \(.ResourceType) \(.PhysicalResourceId)"] | join("; ")' "$P5_OUT/$STACK.import-${STEP//./-}.changeset.json") -> IMPORT_COMPLETE"

d=$(drift "$STACK")
result "$STEP drift: $d; $(awk '{print $1"="$3}' "$P5_OUT/$STACK.drift.txt" | paste -sd' ')"
[[ $d == *IN_SYNC* ]] || stop "drift after the $STEP import is not IN_SYNC: change the template to match live"
expect_noop "$STACK" "$T"
result "$STEP no-op: the same template contains no changes"
protect "$STACK"
result "$STEP stack policy: Update:Replace and Update:Delete denied on every resource of $STACK"

bash "$P5_ROOT/infra/production/snapshot.sh" "$SF" > "$W/after.json"
if bash "$P5_ROOT/infra/production/compare.sh" "$W/before.json" "$W/after.json"; then
  result "$STEP before/after: identical apart from aws:cloudformation:* tags"
else
  stop "$STEP: the resources changed beyond CloudFormation's tags"
fi
if [[ $STEP == 5.10 ]]; then
  bash "$P5_ROOT/infra/production/s4r-boundary.sh" > "$W/boundary-after.json"
  if cmp -s <(jq -S . "$W/boundary-before.json") <(jq -S . "$W/boundary-after.json"); then
    result "$STEP S4R boundary: the S4R role (trust, inline and managed policies) and API 65vnizdmk4 (routes, integrations, stages) identical"
  else
    diff <(jq -S . "$W/boundary-before.json") <(jq -S . "$W/boundary-after.json") >&2 || true
    stop "$STEP: the S4R role or API 65vnizdmk4 changed"
  fi
fi
result "$STEP CloudTrail: check after delivery with infra/production/check-cloudtrail.sh $STEP"
