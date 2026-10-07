#!/usr/bin/env bash
# One Phase 5 import step (runbook: docs/migration/runbooks/phase-5-import.md). Run as the IAM user:
#
#   EXECUTE=1 bash infra/production/steps/import.sh <step>      e.g. 5.1
#
# The step file infra/production/steps/<step>.json names the stack, the resources to import, the physical IDs allowed,
# the acknowledged S4R references and the exact changes expected. The template is the CDK app synthesized for the step.
#   1. shell: create the stack holding only StackShell if it does not exist (execution role, termination protection)
#   2. import: a checked IMPORT change set; executed only if import-mode checking passes and the changes are exactly
#      the expected ones
#   3. drift straight after: every resource IN_SYNC, else STOP
#   4. the same template is a no-op; the stack policy denies Update:Replace and Update:Delete
source "$(dirname "$0")/../lib.sh"
require_caller
STEP=${1:?step}
SF=$P5_ROOT/infra/production/steps/$STEP.json
[[ -s $SF ]] || stop "no step file $SF"
STACK=$(jq -r .stack "$SF")
check_stack_name "$STACK"
RES=$P5_OUT/$STEP.results.txt
: > "$RES"
result() { log "$*"; echo "$*" >> "$RES"; }

if ! stack_exists "$STACK"; then
  synth shell
  cp "$P5_ROOT/infra/cdk/cdk.out/$STACK.template.json" "$P5_OUT/$STACK.shell.template.json"
  create_shell "$STACK" "$P5_OUT/$STACK.shell.template.json"
  [[ $EXECUTE == 1 ]] && result "shell: $STACK created (StackShell only, execution role, termination protection)"
fi

synth "$STEP"
T=$P5_OUT/$STACK.$STEP.template.json
cp "$P5_ROOT/infra/cdk/cdk.out/$STACK.template.json" "$T"
jq '.import' "$SF" > "$P5_OUT/$STEP.import.json"
changeset "$STACK" "import-${STEP//./-}" IMPORT "$T" "$SF" "$P5_OUT/$STEP.import.json"
[[ $EXECUTE == 1 ]] || exit 0
result "$STEP import: $(jq -r '[.Changes[].ResourceChange | "\(.Action) \(.ResourceType) \(.PhysicalResourceId)"] | join("; ")' "$P5_OUT/$STACK.import-${STEP//./-}.changeset.json") -> IMPORT_COMPLETE"

d=$(drift "$STACK")
result "$STEP drift: $d; $(awk '{print $1"="$3}' "$P5_OUT/$STACK.drift.txt" | paste -sd' ')"
[[ $d == *IN_SYNC* ]] || stop "drift after the $STEP import is not IN_SYNC: change the template to match live"
expect_noop "$STACK" "$T"
result "$STEP no-op: the same template contains no changes"
protect "$STACK"
result "$STEP stack policy: Update:Replace and Update:Delete denied on every resource of $STACK"
