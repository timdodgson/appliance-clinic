#!/usr/bin/env bash
# Phase 6 checks (PLAN.md Phase 6, actions 1 and 4), run before the proof change, after it and after its removal.
# READ-ONLY, apart from the drift detections it starts. Run as the IAM user, from the repository root:
#
#   bash infra/production/phase-6-checks.sh <label>        e.g. before, after-add, after-remove
#
# Writes .migration-output/phase6/<label>/ and prints one line per check:
#   - inventory, and its configuration comparison with the Phase 5 final inventory
#   - S4R denylist regenerated from the inventory, against the committed one
#   - drift of AcDataStack and AcRuntimeStack
#   - the S4R boundary (S4R role, API 65vnizdmk4) and the runtime capture (all AC functions, the diagnosis Lambda
#     included), against the Phase 5 final state
#   - SparesSite-dev and CDKToolkit last-update times
#   - S4R health, the /part-finder contract, the /ai/chat ingress and the smoke baseline
set -euo pipefail
LABEL=${1:?label}
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
source "$ROOT/infra/production/lib.sh"
require_caller
P5=$ROOT/.migration-output/phase5
O=$ROOT/.migration-output/phase6/$LABEL
mkdir -p "$O"
umask 077
line() { echo "$*" | tee -a "$O/summary.txt"; }
: > "$O/summary.txt"
export NODE_USE_ENV_PROXY=1

(cd "$P5_TOOLS" && npm run -s inventory -- --expect-account "$P5_ACCOUNT" --out "$O/inventory" > "$O/inventory.log" 2>&1) || stop "inventory failed"
(cd "$P5_TOOLS" && npm run -s compare:config -- "$P5/inventory-final" "$O/inventory" > "$O/compare-vs-phase5-final.txt" 2>&1) || true
line "inventory vs Phase 5 final: $(tail -1 "$O/compare-vs-phase5-final.txt")"
(cd "$P5_TOOLS" && npm run -s denylist -- --inventory "$O/inventory" --write "$O/s4r-denylist.json" > "$O/denylist.log" 2>&1) || stop "denylist failed"
if cmp -s <(jq -S .entries "$ROOT/docs/migration/s4r-denylist.json") <(jq -S .entries "$O/s4r-denylist.json"); then
  line "S4R denylist: $(jq '.entries | length' "$O/s4r-denylist.json") entries, identical to the committed denylist"
else line "S4R denylist: DIFFERS from the committed denylist"; fi

for st in AcDataStack AcRuntimeStack; do
  d=$(P5_OUT=$O drift "$st")
  line "$st drift: $(tr '\t' ' ' <<<"$d"); not IN_SYNC: $(grep -vc IN_SYNC "$O/$st.drift.txt" || true)"
done

bash "$ROOT/infra/production/s4r-boundary.sh" > "$O/boundary.json"
if cmp -s <(jq -S . "$P5/5.10/boundary-after.json") <(jq -S . "$O/boundary.json"); then
  line "S4R role and API 65vnizdmk4: identical to the Phase 5 final state"
else line "S4R role and API 65vnizdmk4: DIFFER from the Phase 5 final state"; fi
bash "$ROOT/infra/production/capture-runtime.sh" production "$O/runtime.json" 2>/dev/null
redact() { jq -S 'del(.capturedAt) | .functions |= map_values(.configuration.Environment.Variables |= (if . then with_entries(if (.key | test("TOKEN$")) then .value = "redacted" else . end) else . end))' "$1"; }
if cmp -s <(jq -S . "$P5/5.10/after.json") <(redact "$O/runtime.json"); then
  line "runtime (all AC functions, the diagnosis Lambda included): identical to the Phase 5 final state"
else line "runtime: DIFFERS from the Phase 5 final state"; fi
redact "$O/runtime.json" > "$O/runtime.redacted.json"; : > "$O/runtime.json"
for s in SparesSite-dev CDKToolkit; do
  line "$s: $(aws cloudformation describe-stacks --stack-name "$s" --query 'Stacks[0].[StackStatus,LastUpdatedTime]' --output text | tr '\t' ' ')"
done

B=$P5/baseline
(cd "$P5_TOOLS" && npm run -s baseline -- s4r-health --live 2>/dev/null) > "$O/s4r-health.json" || true
line "S4R health: $(jq -c '[.checks[] | "\(.check) \(.status)"]' "$O/s4r-health.json")"
(cd "$P5_TOOLS" && npm run -s baseline -- contract verify --live --recorded "$B/part-finder-contract.json" 2>/dev/null) > "$O/contract.json" || true
line "/part-finder contract: ok=$(jq .ok "$O/contract.json")"
(cd "$P5_TOOLS" && npm run -s baseline -- ingress verify --live --recorded "$B/ai-chat-ingress.json" 2>/dev/null) > "$O/ingress.json" || true
line "/ai/chat ingress: ok=$(jq .ok "$O/ingress.json")"
(cd "$P5_TOOLS" && npm run -s baseline -- smoke --live --out "$O/smoke.json" >/dev/null 2>&1) || true
if cmp -s <(jq -S '.summaries | map_values({status, safety, partCount, hasStateToken})' "$B/smoke-pre.json") \
          <(jq -S '.summaries | map_values({status, safety, partCount, hasStateToken})' "$O/smoke.json"); then
  line "smoke: equal to the pre-Phase-5 baseline ($(jq -c '[.summaries[] | .status]' "$O/smoke.json")); expectation problems: $(jq -c .expectationProblems "$O/smoke.json")"
else line "smoke: DIFFERS from the baseline"; fi
