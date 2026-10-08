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
CHECK=()
# Phase 6 proof updates (phase6-add, phase6-remove): their own directory and the proof manifest's variant.
# Phase 7 changes (change:<id>): their own directory, and a manifest built from the spec's writes.
if [[ $STEP == change:* ]]; then
  ID=${STEP#change:}
  W=$ROOT/.migration-output/phase7/$ID
  SPEC=$ROOT/infra/production/changes/$ID.json
  jq '.writes as $w | {variants: {change: {types: ([$w.types[] | {key: ., value: {expectedWrites: $w.expected,
       forbiddenWrites: ($w.forbidden // []), cloudTrailActions: ($w.cloudTrailActions // {})}}] | from_entries)}}}' "$SPEC" > "$W/writes-manifest.json"
  CHECK=(--manifest "$W/writes-manifest.json" --variant change)
elif [[ $STEP == phase6-* ]]; then
  W=$ROOT/.migration-output/phase6/${STEP#phase6-}
  CHECK=(--manifest "$ROOT/docs/migration/phase-6-proof-writes.json" --variant "${STEP#phase6-}")
fi
[[ -s $W/window.json ]] || { echo "no import window for $STEP" >&2; exit 1; }
end=$(jq -r .end "$W/window.json")
wait=$(( $(date -u -d "$end" +%s) + 900 - $(date -u +%s) ))
(( wait > 0 )) && { echo "waiting ${wait}s for CloudTrail delivery" >&2; sleep "$wait"; }
start=$(date -u -d "$(jq -r .start "$W/window.json") -60 sec" +%FT%TZ)
stop=$(date -u -d "$end +120 sec" +%FT%TZ)
bash "$ROOT/infra/sandbox/probe/cloudtrail.sh" "$(jq -r .role "$W/window.json")" "$start" "$stop" > "$W/cloudtrail.json"
types=$(jq -r '.types | join(",")' "$W/window.json")
echo "$STEP writes: $(jq -c '[.[] | "\(.action) \(.resource)"]' "$W/cloudtrail.json")" >&2
if [[ $STEP == change:* ]]; then
  # Every write must land on one of the spec's resources.
  outside=$(jq -c --slurpfile s "$SPEC" '[.[] | select(.resource as $r | [$s[0].writes.resources[] | . as $p | ($r // "") | contains($p)] | any | not) | "\(.action) \(.resource)"]' "$W/cloudtrail.json")
  echo "writes outside the spec's resources: $outside" >&2
  [[ $outside == '[]' ]] || { echo '{"ok": false, "failures": [{"rule": "write-outside-resources"}]}'; exit 1; }
  # And none may name a forbidden resource (the S4R pool, the S4R role, ...), however broad the allowed patterns are.
  hit=$(jq -c --slurpfile s "$SPEC" '[.[] | select(.resource as $r | [($s[0].writes.forbiddenResources // [])[] | . as $p | ($r // "") | contains($p)] | any) | "\(.action) \(.resource)"]' "$W/cloudtrail.json")
  [[ $hit == '[]' ]] || { echo "writes on forbidden resources: $hit" >&2; echo '{"ok": false, "failures": [{"rule": "write-on-forbidden-resource"}]}'; exit 1; }
fi
(cd "$ROOT/tools/migration" && node bin/import-writes.mjs check-writes --events "$W/cloudtrail.json" --types "$types" "${CHECK[@]}") | tee "$W/cloudtrail.check.json"
