#!/usr/bin/env bash
# Phase 4 (#34): the S4R stand-in, SparesSite-sbx. Run as ac-operator-sbx with EXECUTE=1.
#   1. Create the stack directly with CloudFormation (no AC toolkit), as S4R deploys its own stack.
#   2. Record the AWS-generated API, pool and client IDs as sandbox children.
#   3. Confirm an unchanged template is a no-op.
#   4. Add the four inline policies by hand, outside the stack, as the production S4R role carries them.
source "$(dirname "$0")/../lib.sh"
require_operator

STACK=SparesSite-sbx
T=$SBX_ROOT/infra/sandbox/stand-in/sparessite-sbx.json
ROLE=SparesSite-sbx-ServerFunctionRole
guard_target AWS::IAM::Role $ROLE
guard_target AWS::IAM::Policy SparesSite-sbx-ServerPolicy
guard_target AWS::Lambda::Function spares4repairs-server-sbx
guard_target AWS::Logs::LogGroup /aws/lambda/spares4repairs-server-sbx
guard_target AWS::ApiGatewayV2::Api spares4repairs-sbx
guard_target AWS::Cognito::UserPool SparesSite-sbx-UserPool
guard_target AWS::Cognito::UserPoolClient SparesSite-sbx-AdminClient

if needs_create $STACK; then
  changeset $STACK create-1 CREATE "$T"
fi
[[ $EXECUTE == 1 ]] || exit 0

record_generated AWS::ApiGatewayV2::ApiId "$(stack_output $STACK ApiId)" spares4repairs-sbx
record_generated AWS::Cognito::UserPoolId "$(stack_output $STACK UserPoolId)" SparesSite-sbx-UserPool
record_generated AWS::Cognito::UserPoolClientId "$(stack_output $STACK UserPoolClientId)" SparesSite-sbx-AdminClient
expect_noop $STACK "$T"

for p in WhichpartLearningPut-sbx whichpart-knowledge-overlay-s3-sbx whichpart-media-overlay-s3-sbx t1-unmanaged-sbx; do
  guard_target AWS::IAM::RolePolicy "$ROLE/$p"
  aws iam put-role-policy --role-name $ROLE --policy-name "$p" \
    --policy-document "file://$SBX_ROOT/infra/sandbox/stand-in/policies/$p.json"
  log "hand-added: $ROLE/$p"
done
aws iam list-role-policies --role-name $ROLE --query 'PolicyNames' --output json > "$SBX_OUT/stand-in-policies.json"
log "inline policies on $ROLE: $(jq -c . "$SBX_OUT/stand-in-policies.json")"
