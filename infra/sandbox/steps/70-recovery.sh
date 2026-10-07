#!/usr/bin/env bash
# Phase 4 recovery rehearsal (#34, runbook section 5, Recovery rehearsal). Run as ac-operator-sbx after 40-data.sh.
# Synthetic data only: the -sbx tables and buckets hold generated records. No production backup is read or restored.
#
#   1. DynamoDB on-demand backup of each table, restored into <table>-restored-backup.
#   2. DynamoDB PITR: note a point, change items, restore that point into <table>-restored-pitr.
#   3. S3: copy each bucket into the backup bucket (<source-bucket>/<timestamp>/, the Phase 0 layout), overwrite and
#      delete some originals, restore from the copy.
#   4. Put the sources back as seeded, delete the restored tables and the backups.
# Each step is timed. Results: recovery-results.txt, read into docs/migration/runbooks/phase-4-recovery.md.
source "$(dirname "$0")/../lib.sh"
require_operator
export LC_ALL=C   # one sort order for sort and comm
TABLES=(whichpart-transcripts-sbx whichpart-recalls-sbx)
A=$SBX_ACCOUNT
BACKUP=applianceclinic-migration-backup-sbx-$A
BUCKETS=(whichpart-web-sbx-$A whichpart-learning-sbx-$A)
W=$SBX_OUT/recovery
mkdir -p "$W"
RES=$SBX_OUT/recovery-results.txt
: > "$RES"
result() { log "$*"; echo "$*" >> "$RES"; }
items() { aws dynamodb scan --table-name "$1" --output json | jq -c '.Items[]' | jq -cS . | sort; }   # every item, canonical
active() { # TABLE: wait until the table and all its GSIs are ACTIVE
  aws dynamodb wait table-exists --table-name "$1"
  for _ in $(seq 1 120); do
    [[ $(aws dynamodb describe-table --table-name "$1" --query '[Table.TableStatus, Table.GlobalSecondaryIndexes[].IndexStatus][]' --output text | tr '\t' '\n' | sort -u) == ACTIVE ]] && return 0
    sleep 10
  done
  stop "$1 did not become ACTIVE"
}
shape() { # TABLE: GSI, TTL and PITR as restored
  local gsi ttl pitr
  gsi=$(aws dynamodb describe-table --table-name "$1" --query 'Table.GlobalSecondaryIndexes[].[IndexName, join(`,`, KeySchema[].AttributeName)]' --output text | tr '\t' ' ')
  ttl=$(aws dynamodb describe-time-to-live --table-name "$1" --query 'TimeToLiveDescription.TimeToLiveStatus' --output text)
  pitr=$(aws dynamodb describe-continuous-backups --table-name "$1" --query 'ContinuousBackupsDescription.PointInTimeRecoveryDescription.PointInTimeRecoveryStatus' --output text)
  echo "GSI [$gsi], TTL $ttl, PITR $pitr"
}
drop_table() { # TABLE: a restored table, deleted once any restore into it has finished
  guard_target AWS::DynamoDB::Table "$1"
  aws dynamodb describe-table --table-name "$1" >/dev/null 2>&1 || return 0
  aws dynamodb wait table-exists --table-name "$1"
  aws dynamodb delete-table --table-name "$1" >/dev/null
  aws dynamodb wait table-not-exists --table-name "$1"
}
reset_source() { # TABLE: back to exactly the seeded items, so an interrupted run can simply be run again
  for i in 1 2 3 4 5; do aws dynamodb delete-item --table-name "$1" --key "{\"pk\":{\"S\":\"sbx-after-point-$i\"}}"; done
  for f in "$SBX_OUT"/seed/"$1"-*.json; do aws dynamodb batch-write-item --request-items "file://$f" >/dev/null; done
}

for T in "${TABLES[@]}"; do
  reset_source "$T"
  items "$T" > "$W/$T.items"
  n=$(wc -l < "$W/$T.items"); [[ $n == 100 ]] || stop "$T holds $n items after the reset, not the 100 seeded: run 40-data.sh"
  result "$T: $n synthetic items; source $(shape "$T")"

  # --- 1. On-demand backup and restore ---
  R=$T-restored-backup
  guard_target AWS::DynamoDB::Table "$R"
  drop_table "$R"
  s=$SECONDS
  arn=$(aws dynamodb create-backup --table-name "$T" --backup-name "$T-phase4-$(date -u +%Y%m%d%H%M%S)" --query BackupDetails.BackupArn --output text)
  until [[ $(aws dynamodb describe-backup --backup-arn "$arn" --query BackupDescription.BackupDetails.BackupStatus --output text) == AVAILABLE ]]; do sleep 5; done
  b=$((SECONDS - s))
  aws dynamodb restore-table-from-backup --target-table-name "$R" --backup-arn "$arn" >/dev/null
  active "$R"
  r=$((SECONDS - s - b))
  aws dynamodb tag-resource --resource-arn "arn:aws:dynamodb:$SBX_REGION:$A:table/$R" --tags Key=ac:sandbox,Value=phase-4
  items "$R" > "$W/$R.items"
  cmp -s "$W/$T.items" "$W/$R.items" || stop "$R differs from $T"
  result "1 backup $T: AVAILABLE in ${b}s; restored $R ACTIVE (with GSI) in ${r}s; all $n items identical; restored $(shape "$R")"
  echo "$arn" >> "$W/backups.txt"

  # --- 2. Point-in-time restore ---
  R=$T-restored-pitr
  guard_target AWS::DynamoDB::Table "$R"
  drop_table "$R"
  sleep 2; point=$(date -u +%s); sleep 2
  pk=$(jq -r -s '.[:10][] | .pk.S' "$W/$T.items")
  for k in $(sed -n 1,5p <<<"$pk"); do aws dynamodb delete-item --table-name "$T" --key "{\"pk\":{\"S\":\"$k\"}}"; done
  for k in $(sed -n 6,10p <<<"$pk"); do aws dynamodb update-item --table-name "$T" --key "{\"pk\":{\"S\":\"$k\"}}" --update-expression 'SET changedAfterPoint = :t' --expression-attribute-values '{":t":{"BOOL":true}}'; done
  for i in 1 2 3 4 5; do aws dynamodb put-item --table-name "$T" --item "{\"pk\":{\"S\":\"sbx-after-point-$i\"},\"gsiPk\":{\"S\":\"after\"},\"synthetic\":{\"BOOL\":true}}"; done
  cmp -s "$W/$T.items" <(items "$T") && stop "the changes to $T did not apply"
  until (( $(aws dynamodb describe-continuous-backups --table-name "$T" --query 'ContinuousBackupsDescription.PointInTimeRecoveryDescription.LatestRestorableDateTime' --output text | xargs -I{} date -u -d {} +%s) > point )); do sleep 15; done
  s=$SECONDS
  aws dynamodb restore-table-to-point-in-time --source-table-name "$T" --target-table-name "$R" --restore-date-time "$point" >/dev/null
  active "$R"
  r=$((SECONDS - s))
  aws dynamodb tag-resource --resource-arn "arn:aws:dynamodb:$SBX_REGION:$A:table/$R" --tags Key=ac:sandbox,Value=phase-4
  items "$R" > "$W/$R.items"
  cmp -s "$W/$T.items" "$W/$R.items" || stop "$R does not match $T at the chosen point"
  result "2 PITR $T: after 5 deletes, 5 updates and 5 inserts, the point $(date -u -d @"$point" +%H:%M:%SZ) restored into $R, ACTIVE in ${r}s; all $n items as they were at that point; restored $(shape "$R")"

  # --- 4a. Put the source back as seeded ---
  reset_source "$T"
  cmp -s "$W/$T.items" <(items "$T") || stop "$T was not put back as seeded"
  result "4 $T put back as seeded (identical to before the rehearsal)"
done

# --- 3. S3 backup copy and restore ---
sums() { # BUCKET [PREFIX]: "<key> <sha256>" for every object
  local d; d=$(mktemp -d)
  aws s3 cp --recursive --quiet "s3://$1/${2:-}" "$d"
  (cd "$d" && find . -type f | sed 's|^\./||' | sort | while read -r k; do printf '%s %s\n' "$k" "$(sha256sum "$k" | cut -c1-64)"; done)
  rm -rf "$d"
}
guard_target AWS::S3::Bucket "$BACKUP"
for B in "${BUCKETS[@]}"; do
  guard_target AWS::S3::Bucket "$B"
  sums "$B" > "$W/$B.sums"
  n=$(wc -l < "$W/$B.sums"); [[ $n -gt 0 ]] || stop "$B is empty"
  ts=$(date -u +%Y%m%dT%H%M%SZ)
  s=$SECONDS
  aws s3 cp --recursive --quiet "s3://$B/" "s3://$BACKUP/$B/$ts/"
  c=$((SECONDS - s))
  cmp -s "$W/$B.sums" <(sums "$BACKUP" "$B/$ts/") || stop "the backup copy of $B differs"
  # Damage: overwrite three objects (different size) and delete three others.
  mapfile -t keys < <(cut -d' ' -f1 "$W/$B.sums")
  for k in "${keys[@]:0:3}"; do printf 'overwritten during the Phase 4 recovery rehearsal\n' | aws s3 cp --quiet - "s3://$B/$k"; done
  for k in "${keys[@]:3:3}"; do aws s3 rm --quiet "s3://$B/$k"; done
  cmp -s "$W/$B.sums" <(sums "$B") && stop "the damage to $B did not apply"
  s=$SECONDS
  aws s3 cp --recursive --quiet "s3://$BACKUP/$B/$ts/" "s3://$B/"
  # Anything in the bucket that is not in the copy would be removed here; the rehearsal adds nothing.
  extra=$(comm -13 <(cut -d' ' -f1 "$W/$B.sums") <(aws s3 ls --recursive "s3://$B/" | awk '{print $4}' | sort))
  [[ -z $extra ]] || stop "objects not in the backup copy: $extra"
  r=$((SECONDS - s))
  cmp -s "$W/$B.sums" <(sums "$B") || stop "$B was not restored exactly"
  result "3 S3 $B: $n objects copied to s3://$BACKUP/$B/$ts/ in ${c}s; after 3 overwrites and 3 deletes, restored in ${r}s; count and SHA-256 of every object equal"
done

# --- 4b. Clean up: the restored tables and the on-demand backups ---
for T in "${TABLES[@]}"; do drop_table "$T-restored-backup"; drop_table "$T-restored-pitr"; done
while read -r arn; do aws dynamodb delete-backup --backup-arn "$arn" >/dev/null; done < "$W/backups.txt"
rm -f "$W/backups.txt"
result "4 restored tables and on-demand backups deleted; the backup bucket keeps its copies until the sandbox is destroyed"
cat "$RES" >&2
