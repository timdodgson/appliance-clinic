#!/usr/bin/env bash
# Phase 5: after a step's import, every write the acclinic execution role made must be one the manifest expects
# (docs/migration/phase-5-import-writes.json). READ-ONLY. CloudTrail delivers events 5 to 15 minutes late: this script
# waits until at least 15 minutes after the import ended, then checks.
#
#   bash check-cloudtrail.sh <step>
set -euo pipefail
STEP=${1:?step}
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
W=$ROOT/.migration-output/phase5/$STEP
[[ -s $W/window.json ]] || { echo "no import window for $STEP" >&2; exit 1; }
end=$(jq -r .end "$W/window.json")
wait=$(( $(date -u -d "$end" +%s) + 900 - $(date -u +%s) ))
(( wait > 0 )) && { echo "waiting ${wait}s for CloudTrail delivery" >&2; sleep "$wait"; }
start=$(date -u -d "$(jq -r .start "$W/window.json") -60 sec" +%FT%TZ)
stop=$(date -u -d "$end +120 sec" +%FT%TZ)
bash "$ROOT/infra/sandbox/probe/cloudtrail.sh" "$(jq -r .role "$W/window.json")" "$start" "$stop" > "$W/cloudtrail.json"
types=$(jq -r '.types | join(",")' "$W/window.json")
echo "$STEP writes: $(jq -c '[.[] | "\(.action) \(.resource)"]' "$W/cloudtrail.json")" >&2
(cd "$ROOT/tools/migration" && node bin/import-writes.mjs check-writes --events "$W/cloudtrail.json" --types "$types") | tee "$W/cloudtrail.check.json"
