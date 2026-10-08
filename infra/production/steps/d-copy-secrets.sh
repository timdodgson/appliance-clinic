#!/usr/bin/env bash
# Phase 7, D: give the new AC secrets applianceclinic/production/{ai-config,openai,jev} the CURRENT values of
# spares4repairs/dev/applianceclinic-{ai-config,openai,jev}. No provider credential is created or rotated here.
# Run as the IAM user, from the repository root:
#
#   bash infra/production/steps/d-copy-secrets.sh            dry run: checks only
#   EXECUTE=1 bash infra/production/steps/d-copy-secrets.sh  copies
#
# Each value goes from one Secrets Manager call to the next through a pipe in this process: it is never printed,
# written to a file, logged or compared. `set -x` is never enabled. Only version ids and timestamps are recorded.
# A new secret is written only while it still holds its 7.17a placeholder version (one version, AWSCURRENT), so a
# re-run cannot overwrite a value Settings has since saved.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/../../.." && pwd)
source "$ROOT/infra/production/lib.sh"
require_caller
set +x
O=$ROOT/.migration-output/phase7/d-copy-secrets; mkdir -p "$O"
: > "$O/copied.txt"
for n in ai-config openai jev; do
  src=spares4repairs/dev/applianceclinic-$n; dst=applianceclinic/production/$n
  aws secretsmanager describe-secret --secret-id "$dst" >/dev/null || stop "$dst does not exist (run 7.17a first)"
  versions=$(aws secretsmanager list-secret-version-ids --secret-id "$dst" --query 'length(Versions)' --output text)
  [[ $versions == 1 ]] || stop "$dst already has $versions versions: not overwriting"
  srcv=$(aws secretsmanager describe-secret --secret-id "$src" --query 'join(`,`, keys(VersionIdsToStages))' --output text)
  log "D: $src (versions $srcv) -> $dst (placeholder only)"
  [[ ${EXECUTE:-0} == 1 ]] || continue
  newv=$(aws secretsmanager get-secret-value --secret-id "$src" --version-stage AWSCURRENT --output json \
    | jq -j '.SecretString' \
    | aws secretsmanager put-secret-value --secret-id "$dst" --secret-string file:///dev/stdin --query VersionId --output text)
  echo "$dst $newv $(date -u +%FT%TZ) from $src" >> "$O/copied.txt"
  log "D: $dst new version $newv"
done
[[ ${EXECUTE:-0} == 1 ]] || log "EXECUTE!=1: nothing copied"
