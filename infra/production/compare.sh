#!/usr/bin/env bash
# Phase 5: compare a step's before and after snapshots (snapshot.sh). READ-ONLY.
#
#   bash compare.sh before.json after.json
#
# They may differ only by aws:cloudformation:* tags. A resource with no tags at all (Tags absent, null) and one holding
# only CloudFormation's tags (an empty list once those are removed) are the same: the import adds those tags to an
# untagged resource, and that is all it may add. S3 reports an untagged bucket as the error NoSuchTagSet. Exits 1 and prints the difference otherwise.
set -euo pipefail
strip() { jq -S 'walk(if type == "object" then with_entries(select((.key | tostring | startswith("aws:cloudformation:")) | not)) else . end)
  | walk(if type == "array" then map(select((type == "object" and (.Key // "" | startswith("aws:cloudformation:"))) | not)) else . end)
  | walk(if type == "object" then with_entries(if (.key | test("^[Tt]ags$")) and (.value == null or .value == {} or .value == {TagSet: []}
      or (.value | type == "string" and test("NoSuchTagSet"))) then .value = [] else . end) else . end)' "$1"; }
if cmp -s <(strip "$1") <(strip "$2"); then exit 0; fi
diff <(strip "$1") <(strip "$2") >&2 || true
exit 1
