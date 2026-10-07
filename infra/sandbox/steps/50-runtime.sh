#!/usr/bin/env bash
# Phase 4 (#34), runtime imports (Phase 5 steps 5.5 to 5.10) into AcRuntimeStack-sbx. Run as ac-operator-sbx, EXECUTE=1.
#   1. Artefacts: the Phase 3 zips to the toolkit bucket; the deployed image digests to the -sbx repositories.
#   2. Create roles, inline policies, functions, URLs, permissions and DISABLED rules outside CloudFormation,
#      with the production configuration (Phase 0 inventory) and sandbox values for every production default.
#   3. Check each function's environment with the guard before anything can invoke it.
#   4. Import everything with one import-only change set, then confirm a no-op and clean drift.
#   5. 5.8: remove the diagnosis copy's URL from the stack with Retain, import it again: the host must not change.
#   6. 5.10: route the stand-in API's POST /ai/chat to the diagnosis copy, with an unmanaged apigateway-invoke
#      permission, as production does. Then endpoint checks that need no LLM, production data or S4R.
source "$(dirname "$0")/../lib.sh"
require_operator

STACK=AcRuntimeStack-sbx
CDK=$SBX_ROOT/infra/sandbox/cdk
RT=$SBX_OUT/runtime.json
A=$SBX_ACCOUNT R=$SBX_REGION
ASSETS=cdk-acsbx-assets-$A-$R
FNS=(whichpart-api-sbx spares4repairs-part-finder-sbx spares4repairs-diag-orchestrator-sbx spares4repairs-error-code-mcp-sbx)
ROLES=(whichpart-api-role-sbx diag-orchestrator-role-sbx error-code-mcp-role-sbx)
RULES=(whichpart-recall-ingest-daily-sbx whichpart-transcript-review-sbx)
STAND_IN_ROLE=SparesSite-sbx-ServerFunctionRole
POOL=$(stack_output SparesSite-sbx UserPoolId); CLIENT=$(stack_output SparesSite-sbx UserPoolClientId); API=$(stack_output SparesSite-sbx ApiId)
[[ -n $POOL && -n $CLIENT && -n $API ]] || stop "run 10-stand-in.sh first"

for f in "${FNS[@]}"; do guard_target AWS::Lambda::Function "$f"; done
for r in "${ROLES[@]}"; do guard_target AWS::IAM::Role "$r"; done
for r in "${RULES[@]}"; do guard_target AWS::Events::Rule "$r"; done
guard_target AWS::S3::Bucket $ASSETS

synth() { # writes the template for the current runtime.json
  (cd "$CDK" && env -u AWS_ACCESS_KEY_ID -u AWS_SECRET_ACCESS_KEY -u AWS_SESSION_TOKEN AWS_EC2_METADATA_DISABLED=true \
    CDK_DISABLE_VERSION_CHECK=1 npx cdk synth --quiet --no-notices -c runtime="$RT" >/dev/null 2>&1) || stop "cdk synth failed"
  T=$CDK/cdk.out/$STACK.template.json
  guard document --file "$T"
}
fn_url() { aws lambda get-function-url-config --function-name "$1" --query FunctionUrl --output text 2>/dev/null || true; }
host() { local u; u=$(fn_url "$1"); u=${u#https://}; echo "${u%/}"; }
[[ $EXECUTE == 1 ]] || { log "EXECUTE!=1: stopping before any mutation"; exit 0; }

# --- 1. Artefacts ---------------------------------------------------------------------------------------
ZIPS=$SBX_OUT/zips
mkdir -p "$ZIPS"
python3 "$SBX_ROOT/build/scripts/package_zips.py" --out-dir "$ZIPS" >/dev/null
declare -A ZIPKEY
for z in whichpart-api spares4repairs-part-finder; do
  sha=$(openssl dgst -sha256 -binary "$ZIPS/$z.zip" | base64)
  key=phase3/$z-$(openssl dgst -sha256 "$ZIPS/$z.zip" | awk '{print substr($2,1,16)}').zip
  aws s3 cp --quiet "$ZIPS/$z.zip" "s3://$ASSETS/$key"
  ZIPKEY[$z-sbx]=$key
  echo "$sha" > "$SBX_OUT/$z.codesha256"
  log "artefact: $z.zip CodeSha256 $sha -> s3://$ASSETS/$key"
done
declare -A DIGEST=(
  [spares4repairs-diag-orchestrator-sbx]=sha256:d681e5556cd10867a53013e4b52c28887726b24c401071725df3ecbb45df8e07
  [spares4repairs-error-code-mcp-sbx]=sha256:dc715181fe9773f4cb97cbbb18897b2998b488ef6b76a66376ea6bb1750c8c2d
)
for f in spares4repairs-diag-orchestrator-sbx spares4repairs-error-code-mcp-sbx; do
  if ! aws ecr describe-images --repository-name "$f" --image-ids imageDigest="${DIGEST[$f]}" >/dev/null 2>&1; then
    d=${f%-sbx}; d=${d#spares4repairs-}; [[ $d == diag-orchestrator ]] && d=orchestrator
    [[ -d $SBX_OUT/images/$d ]] || stop "pull $d first (sandbox-image-copy.mjs pull, as the IAM user)"
    (cd "$SBX_TOOLS" && NODE_USE_ENV_PROXY=1 node bin/sandbox-image-copy.mjs push --dir "$SBX_OUT/images/$d" --repo "$f" 2>/dev/null)
  fi
  log "image: $f @ ${DIGEST[$f]}"
done

# --- 2. The checked environment (every production default overridden; see runbook section 4) --------------
ENV_URLS=placeholder   # the environment the functions were created with; "real" once section 6 applies the URLs
env_for() { # FUNCTION: environment JSON. Function URL hosts are example.invalid until section 6.
  local u_orch='' u_engine='' u_mcp=''
  if [[ $ENV_URLS == real ]]; then
    u_orch=$(fn_url spares4repairs-diag-orchestrator-sbx); u_engine=$(fn_url spares4repairs-part-finder-sbx); u_mcp=$(fn_url spares4repairs-error-code-mcp-sbx)
  fi
  u_orch=${u_orch:-https://example.invalid/}; u_engine=${u_engine:-https://example.invalid/}; u_mcp=${u_mcp:-https://example.invalid/}
  local tok_mcp='{{resolve:secretsmanager:applianceclinic-sbx/error-code-mcp/bearer-token}}'
  local tok_orch='{{resolve:secretsmanager:applianceclinic-sbx/diag-orchestrator/bearer-token}}'
  case $1 in
    whichpart-api-sbx) jq -n --arg o "$u_orch" --arg e "$u_engine" --arg m "$u_mcp" --arg pool "$POOL" --arg client "$CLIENT" --arg tm "$tok_mcp" --arg to "$tok_orch" '{
      STAGE: "sbx", ORCHESTRATOR_URL: $o, ENGINE_URL: $e, MCP_URL: $m, MCP_HEALTH_URL: $m,
      LEARNING_BUCKET: "whichpart-learning-sbx-800960611664", WHICHPART_WEB_BUCKET: "whichpart-web-sbx-800960611664",
      RECALL_TABLE: "whichpart-recalls-sbx", TRANSCRIPT_TABLE: "whichpart-transcripts-sbx",
      S4R_PRODUCT_BASE_URL: "https://example.invalid", COGNITO_USER_POOL_ID: $pool, COGNITO_CLIENT_ID: $client,
      CANONICAL_TOKEN_SECRET_ID: "applianceclinic-sbx/canonical-state-token", BENCHMARK_SERVICE_SECRET_ID: "applianceclinic-sbx/benchmark-service",
      OPENAI_BASE_URL: "https://example.invalid", LM_STUDIO_URL: "https://example.invalid",
      CANONICAL_MODE: "off", TRANSCRIPT_REVIEW_ENABLED: "false", MCP_BEARER_TOKEN: $tm, ORCHESTRATOR_TOKEN: $to }' ;;
    spares4repairs-part-finder-sbx) jq -n --arg api "https://$API.execute-api.eu-west-1.amazonaws.com" --arg m "$u_mcp" '{
      STAGE: "sbx", SEARCH_API: ($api + "/api/search"), PARTS_FOR_MODEL_API: ($api + "/api/parts-for-model"),
      LEARNING_BUCKET: "whichpart-learning-sbx-800960611664", MCP_URL: $m,
      LM_STUDIO_URL: "https://example.invalid", EMBED_URL: "https://example.invalid", OPENAI_BASE_URL: "https://example.invalid" }' ;;
    spares4repairs-diag-orchestrator-sbx) jq -n --arg m "$u_mcp" --arg e "$u_engine" --arg tm "$tok_mcp" --arg to "$tok_orch" '{
      STAGE: "sbx", MCP_URL: $m, RAG_URL: $e, MCP_BEARER_TOKEN: $tm, ORCH_BEARER_TOKEN: $to }' ;;
    spares4repairs-error-code-mcp-sbx) jq -n --arg tm "$tok_mcp" '{ STAGE: "sbx", LEARNING_BUCKET: "whichpart-learning-sbx-800960611664", MCP_BEARER_TOKEN: $tm }' ;;
  esac
}
check_env() { # FUNCTION: the guard's environment check, on the dynamic references' names (no secret value is read)
  env_for "$1" > "$SBX_OUT/$1.env.json"
  guard env --function "$1" --file "$SBX_OUT/$1.env.json"
  log "environment ok: $1"
}
write_runtime() { # INCLUDE-JSON-ARRAY [OMIT-URLS-JSON-ARRAY]
  jq -n --arg pool "$POOL" --argjson include "$1" --argjson omit "${2:-[]}" \
    --arg wz "${ZIPKEY[whichpart-api-sbx]}" --arg pz "${ZIPKEY[spares4repairs-part-finder-sbx]}" \
    --arg od "${DIGEST[spares4repairs-diag-orchestrator-sbx]}" --arg ed "${DIGEST[spares4repairs-error-code-mcp-sbx]}" \
    --slurpfile e1 <(env_for whichpart-api-sbx) --slurpfile e2 <(env_for spares4repairs-part-finder-sbx) \
    --slurpfile e3 <(env_for spares4repairs-diag-orchestrator-sbx) --slurpfile e4 <(env_for spares4repairs-error-code-mcp-sbx) '{
      poolId: $pool, include: $include, omitUrls: $omit,
      zips: {"whichpart-api-sbx": $wz, "spares4repairs-part-finder-sbx": $pz},
      images: {"spares4repairs-diag-orchestrator-sbx": $od, "spares4repairs-error-code-mcp-sbx": $ed},
      environment: {"whichpart-api-sbx": $e1[0], "spares4repairs-part-finder-sbx": $e2[0], "spares4repairs-diag-orchestrator-sbx": $e3[0], "spares4repairs-error-code-mcp-sbx": $e4[0]} }' > "$RT"
}
ALL='["roles","policies","functions","urls","permissions","rules"]'

if needs_create $STACK || ! in_stack $STACK whichpartapisbx; then
  # --- 3. Create outside CloudFormation, from the synthesized template's own properties -------------------
  write_runtime "$ALL"; synth
  for r in "${ROLES[@]}"; do
    aws iam get-role --role-name "$r" >/dev/null 2>&1 || aws iam create-role --role-name "$r" --permissions-boundary arn:aws:iam::$A:policy/ac-cfn-execution-sbx \
      --assume-role-policy-document "$(jq -c --arg r "$r" '.Resources[] | select(.Type=="AWS::IAM::Role" and .Properties.RoleName==$r) | .Properties.AssumeRolePolicyDocument' "$T")" \
      --tags "${SBX_TAGS[@]}" >/dev/null
    aws iam attach-role-policy --role-name "$r" --policy-arn arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole
  done
  jq -c '.Resources[] | select(.Type=="AWS::IAM::RolePolicy") | .Properties' "$T" | while read -r p; do
    role=$(jq -r .RoleName <<<"$p"); name=$(jq -r .PolicyName <<<"$p")
    guard_target AWS::IAM::RolePolicy "$role/$name"
    aws iam put-role-policy --role-name "$role" --policy-name "$name" --policy-document "$(jq -c .PolicyDocument <<<"$p")"
  done
  sleep 10   # IAM eventual consistency before Lambda can assume the new roles
  for f in "${FNS[@]}"; do
    check_env "$f"
    if ! aws lambda get-function --function-name "$f" >/dev/null 2>&1; then
      props=$(jq -c --arg f "$f" '.Resources[] | select(.Type=="AWS::Lambda::Function" and .Properties.FunctionName==$f) | .Properties' "$T")
      # Production holds the bearer tokens as literal values; the template declares them as dynamic references.
      # So the function is created with the (dummy, sandbox) values themselves, read here and never written out.
      envjson=$(jq -c '{Variables: .}' "$SBX_OUT/$f.env.json")
      for ref in $(grep -o '{{resolve:secretsmanager:[^}]*}}' <<<"$envjson" | sort -u); do
        name=${ref#\{\{resolve:secretsmanager:}; name=${name%\}\}}
        [[ $name == applianceclinic-sbx/* ]] || stop "dynamic reference to a non-sandbox secret: $name"
        val=$(aws secretsmanager get-secret-value --secret-id "$name" --query SecretString --output text)
        envjson=$(jq -c --arg r "$ref" --arg v "$val" '.Variables |= with_entries(if .value == $r then .value = $v else . end)' <<<"$envjson")
      done
      if [[ $(jq -r .PackageType <<<"$props") == Image ]]; then
        aws lambda create-function --function-name "$f" --package-type Image --code ImageUri="$(jq -r .Code.ImageUri <<<"$props")" \
          --role "$(jq -r .Role <<<"$props")" --architectures "$(jq -r '.Architectures[0]' <<<"$props")" --memory-size "$(jq -r .MemorySize <<<"$props")" \
          --timeout "$(jq -r .Timeout <<<"$props")" --environment "$envjson" --tags ac:sandbox=phase-4 >/dev/null
      else
        aws lambda create-function --function-name "$f" --runtime nodejs20.x --handler "$(jq -r .Handler <<<"$props")" \
          --code S3Bucket=$ASSETS,S3Key="$(jq -r .Code.S3Key <<<"$props")" --role "$(jq -r .Role <<<"$props")" \
          --architectures "$(jq -r '.Architectures[0]' <<<"$props")" --memory-size "$(jq -r .MemorySize <<<"$props")" \
          --timeout "$(jq -r .Timeout <<<"$props")" --environment "$envjson" --tags ac:sandbox=phase-4 >/dev/null
      fi
      aws lambda wait function-active-v2 --function-name "$f"
      log "created outside CloudFormation: $f"
    fi
  done
  jq -c '.Resources[] | select(.Type=="AWS::Lambda::Url") | .Properties' "$T" | while read -r u; do
    f=$(jq -r '.TargetFunctionArn | split(":") | last' <<<"$u")
    cors=(); [[ $(jq -r '.Cors // empty' <<<"$u") ]] && cors=(--cors "$(jq -c .Cors <<<"$u")")
    [[ -n $(fn_url "$f") ]] || aws lambda create-function-url-config --function-name "$f" --auth-type NONE \
      --invoke-mode "$(jq -r .InvokeMode <<<"$u")" "${cors[@]}" >/dev/null
    record_generated AWS::Lambda::Url "$(host "$f")" "$f"
  done
  jq -c '.Resources | to_entries[] | select(.value.Type=="AWS::Lambda::Permission") | {id: .key, p: .value.Properties}' "$T" | while read -r e; do
    f=$(jq -r .p.FunctionName <<<"$e"); sid=$(jq -r .id <<<"$e" | sed "s/^$(sed 's/[^A-Za-z0-9]//g' <<<"$f")//")
    args=(--function-name "$f" --statement-id "$sid" --action "$(jq -r .p.Action <<<"$e")" --principal "$(jq -r .p.Principal <<<"$e")")
    [[ $(jq -r '.p.FunctionUrlAuthType // empty' <<<"$e") ]] && args+=(--function-url-auth-type NONE)
    [[ $(jq -r '.p.SourceArn // empty' <<<"$e") ]] && args+=(--source-arn "$(jq -r .p.SourceArn <<<"$e")")
    aws lambda add-permission "${args[@]}" >/dev/null 2>&1 || true
  done
  for r in "${RULES[@]}"; do
    props=$(jq -c --arg r "$r" '.Resources[] | select(.Type=="AWS::Events::Rule" and .Properties.Name==$r) | .Properties' "$T")
    aws events put-rule --name "$r" --schedule-expression "$(jq -r .ScheduleExpression <<<"$props")" --state DISABLED --tags Key=ac:sandbox,Value=phase-4 >/dev/null
    aws events put-targets --rule "$r" --targets "$(jq -c '[.Targets[] | {Id, Arn} + (if .Input then {Input} else {} end)]' <<<"$props")" >/dev/null
  done
  log "created the runtime resources outside CloudFormation"

  # --- 4. Import everything -------------------------------------------------------------------------------
  write_runtime "$ALL"; synth
  jq -c '[.Resources | to_entries[] | select(.value.Type != "AWS::CloudFormation::WaitConditionHandle") | .key as $k | .value as $v | {
      ResourceType: $v.Type, LogicalResourceId: $k, ResourceIdentifier: (
        if $v.Type == "AWS::IAM::Role" then {RoleName: $v.Properties.RoleName}
        elif $v.Type == "AWS::IAM::RolePolicy" then {RoleName: $v.Properties.RoleName, PolicyName: $v.Properties.PolicyName}
        elif $v.Type == "AWS::Lambda::Function" then {FunctionName: $v.Properties.FunctionName}
        elif $v.Type == "AWS::Lambda::Url" then {FunctionArn: $v.Properties.TargetFunctionArn}
        elif $v.Type == "AWS::Lambda::Permission" then {FunctionName: $v.Properties.FunctionName, Id: ($k | sub("^[A-Za-z0-9]*?sbx"; ""))}
        elif $v.Type == "AWS::Events::Rule" then {Arn: ("arn:aws:events:eu-west-1:800960611664:rule/" + $v.Properties.Name)}
        else error("no identifier for " + $v.Type) end) }]' "$T" > "$SBX_OUT/runtime-import.json"
  needs_create $STACK && create_shell $STACK "$T"
  changeset $STACK import-1 IMPORT "$T" "$SBX_OUT/runtime-import.json"
  actions=$(jq -r '[.Changes[].ResourceChange.Action] | unique | join(",")' "$SBX_OUT/$STACK.import-1.changeset.json")
  [[ $actions == Import ]] || stop "runtime import change set has actions [$actions]"
  aws cloudformation update-termination-protection --enable-termination-protection --stack-name $STACK >/dev/null
fi

# --- 5. After import: artefacts unchanged, no-op, drift ----------------------------------------------------
RES=$SBX_OUT/runtime-results.txt
: > "$RES"
result() { log "$*"; echo "$*" >> "$RES"; }
for z in whichpart-api spares4repairs-part-finder; do
  live=$(aws lambda get-function --function-name $z-sbx --query Configuration.CodeSha256 --output text)
  [[ $live == "$(cat "$SBX_OUT/$z.codesha256")" ]] && result "5.7 zip: $z-sbx CodeSha256 $live equals the Phase 3 artefact after import" \
    || stop "$z-sbx CodeSha256 $live differs from the artefact"
done
for f in spares4repairs-diag-orchestrator-sbx spares4repairs-error-code-mcp-sbx; do
  live=$(aws lambda get-function --function-name $f --query Code.ResolvedImageUri --output text)
  [[ $live == *"@${DIGEST[$f]}" ]] && result "5.7 image: $f runs ${DIGEST[$f]} (the production digest) after import" || stop "$f image is $live"
done
# On a rerun after section 6, the live environment already carries the real URLs.
[[ $(aws lambda get-function-configuration --function-name whichpart-api-sbx --query Environment.Variables.MCP_URL --output text) == https://example.invalid/ ]] || ENV_URLS=real
write_runtime "$ALL"; synth
# Phase 4 finding: an import accepts a template whose properties differ from the live resource, and only drift
# shows it. If the deployed template does not match live, first make the template match live (never the reverse).
deployed=$(aws cloudformation get-template --stack-name $STACK --query TemplateBody --output json | jq -r '.Resources.whichpartapisbx.Properties.Environment.Variables.MCP_URL')
if [[ $deployed != "$(jq -r '.Resources.whichpartapisbx.Properties.Environment.Variables.MCP_URL' "$T")" ]]; then
  changeset $STACK reconcile UPDATE "$T"
  result "reconcile: the stack template brought back to the live environment before any other change"
fi
expect_noop $STACK "$T" && result "no-op update after import confirmed"
s=$(drift $STACK); result "drift after import: $s"
{ grep -v IN_SYNC "$SBX_OUT/$STACK.drift.txt" || true; } | while read -r l; do result "  not in sync: $l"; done

[[ $s == *IN_SYNC* ]] || stop "drift after import: an import template must carry the live configuration exactly"

# --- 6. Environment with the real sandbox URLs, checked before any invocation -------------------------------
ENV_URLS=real
for f in "${FNS[@]}"; do check_env "$f"; done
write_runtime "$ALL"; synth
if [[ $(aws lambda get-function-configuration --function-name whichpart-api-sbx --query Environment.Variables.MCP_URL --output text) == https://example.invalid/ ]]; then
  changeset $STACK env-1 UPDATE "$T"
  result "6 env-1: real sandbox URLs applied by a stack update"
fi
expect_noop $STACK "$T"
s=$(drift $STACK); [[ $s == *IN_SYNC* ]] || stop "drift after env-1: $s"
result "drift after env-1: $s"
for f in "${FNS[@]}"; do
  aws lambda get-function-configuration --function-name "$f" --query Environment.Variables --output json \
    | jq 'with_entries(if (.key | test("TOKEN$")) then .value = "redacted" else . end)' > "$SBX_OUT/$f.live-env.json"
  guard env --function "$f" --file "$SBX_OUT/$f.live-env.json"
done
result "environment: every production default overridden on all four functions (guard env PASS on the live configuration)"
for z in whichpart-api spares4repairs-part-finder; do
  live=$(aws lambda get-function --function-name $z-sbx --query Configuration.CodeSha256 --output text)
  [[ $live == "$(cat "$SBX_OUT/$z.codesha256")" ]] && result "5.7 zip: $z-sbx CodeSha256 unchanged after a configuration update" || stop "$z-sbx CodeSha256 changed"
done

# --- 7. 5.8: remove the diagnosis copy's URL with Retain, then import it again -----------------------------
PF=spares4repairs-part-finder-sbx
h0=$(host $PF)
write_runtime "$ALL" "[\"$PF\"]"; synth
changeset $STACK url-remove UPDATE "$T"
h1=$(host $PF)
[[ -n $h1 && $h1 == "$h0" ]] && result "5.8 URL removed from the stack with Retain: still exists, host unchanged ($h1)" || stop "URL lost or changed: [$h0] -> [$h1]"
write_runtime "$ALL"; synth
jq -n --arg f "arn:aws:lambda:$R:$A:function:$PF" '[{ResourceType: "AWS::Lambda::Url", LogicalResourceId: "spares4repairspartfindersbxUrl", ResourceIdentifier: {FunctionArn: $f}}]' > "$SBX_OUT/url-import.json"
changeset $STACK url-reimport IMPORT "$T" "$SBX_OUT/url-import.json"
h2=$(host $PF)
[[ $h2 == "$h0" ]] && result "5.8 URL imported again: host unchanged ($h2)" || stop "URL host changed on re-import: [$h0] -> [$h2]"
expect_noop $STACK "$T"

# --- 8. 5.10: the stand-in API routes POST /ai/chat to the diagnosis copy, as production does --------------
in_stack SparesSite-sbx AiChatRoute || \
  SBX_PARAMS="ParameterKey=StandInRevision,ParameterValue=2 ParameterKey=RoleRevision,ParameterValue=2 ParameterKey=DiagnosisCopy,ParameterValue=true" \
  changeset SparesSite-sbx ai-chat UPDATE "$SBX_ROOT/infra/sandbox/stand-in/sparessite-sbx.json"
aws lambda add-permission --function-name $PF --statement-id apigateway-invoke --action lambda:InvokeFunction \
  --principal apigateway.amazonaws.com --source-arn "arn:aws:execute-api:$R:$A:$API/*" >/dev/null 2>&1 || true
result "5.10 stand-in API POST /ai/chat -> $PF; apigateway-invoke added outside the stack (unmanaged, as in production)"
expect_noop $STACK "$T" && result "5.10 the unmanaged apigateway-invoke permission does not disturb AcRuntimeStack-sbx (no-op)"

# --- 9. Endpoint checks: no LLM, no production data, no S4R -------------------------------------------------
# This environment's network policy refuses *.lambda-url.on.aws, so each function is invoked through the Lambda
# API with the event its Function URL would send (payload 2.0). The stand-in API is reached over HTTPS.
invoke() { # FUNCTION METHOD PATH: "<statusCode>" of the function's response
  local ev out
  ev=$(jq -cn --arg m "$2" --arg p "$3" '{version: "2.0", routeKey: "$default", rawPath: $p, rawQueryString: "", headers: {origin: "https://example.invalid"},
    requestContext: {http: {method: $m, path: $p, sourceIp: "192.0.2.1"}, stage: "$default"}, isBase64Encoded: false}')
  out=$(mktemp)
  aws lambda invoke --function-name "$1" --cli-binary-format raw-in-base64-out --payload "$ev" "$out" >/dev/null
  # A RESPONSE_STREAM function returns a JSON prelude, then its body.
  head -c 4096 "$out" | tr -d '\000' | jq -r '.statusCode // "no statusCode"' 2>/dev/null | head -1 || echo unparsed
  rm -f "$out"
}
code() { curl -s -o /dev/null -m 30 -w '%{http_code}' "$@"; }
result "endpoint: whichpart-api-sbx GET /api/auth/me (no token) -> $(invoke whichpart-api-sbx GET /api/auth/me)"
result "endpoint: whichpart-api-sbx GET /api/admin/settings (no token) -> $(invoke whichpart-api-sbx GET /api/admin/settings)"
result "endpoint: error-code-mcp-sbx GET /health -> $(invoke spares4repairs-error-code-mcp-sbx GET /health)"
result "endpoint: diag-orchestrator-sbx GET /health -> $(invoke spares4repairs-diag-orchestrator-sbx GET /health)"
result "endpoint: POST stand-in /ai/chat {} -> $(code -X POST -H 'content-type: application/json' -d '{}' "https://$API.execute-api.$R.amazonaws.com/ai/chat") (production's baseline is also 500: phase-0-findings.md)"
sleep 20
for f in "${FNS[@]}"; do
  n=$(aws logs filter-log-events --log-group-name "/aws/lambda/$f" --filter-pattern '"spares4repairs/"' --output json | jq '[.events[]] | length')   # one JSON document across pages
  [[ ${n:-0} == 0 ]] || stop "$f logged a reference to a spares4repairs/ secret ($n events)"
done
result "logs: no function logged an attempt to read a spares4repairs/ secret"
cat "$RES" >&2
