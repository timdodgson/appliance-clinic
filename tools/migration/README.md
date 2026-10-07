# Migration tooling

Phase 0 tooling for the Appliance Clinic migration: inventory, ownership checks, the S4R
denylist, artefact and configuration comparison, the behavioural baseline, the change-set safety
checker and the explicit backup tool. See [`docs/migration/PLAN.md`](../../docs/migration/PLAN.md)
and the [runbooks](../../docs/migration/runbooks/README.md).

## Safety properties

- **Read-only by construction.** Inventory clients carry a middleware guard that rejects any AWS
  command that is not `Get*`, `List*`, `Describe*`, `Lookup*`, `BatchGet*` or `Head*` before it is
  signed or sent. Reading secret values needs an explicit flag.
- **No secret values on disk.** Secret-like environment variables, secret values and opaque tokens
  are stored as SHA-256 digests only.
- **No customer data.** DynamoDB tables are described, never read.
- **Mutation is separate.** Only `bin/backup.mjs` and `bin/admin-hotfix.mjs` change AWS. Each prints a plan unless given both
  `--execute` and a matching `--confirm-account`, and only their named commands can run.
- **Baseline traffic is bounded.** Baseline requests never carry `observability`, never reach admin
  or benchmark routes, only reach configured hosts, and are capped per run.
- **Output stays local.** Everything is written to the gitignored `.migration-output/`.

## Commands

Run from this directory after `npm ci`.

| Command | AWS | Classification | Purpose |
|---|---|---|---|
| `npm run inventory -- [--download-code] [--hash-secret-values] [--cloudtrail] [--expect-account <id>]` | Reads | READ-ONLY | Capture every AC resource, ownership flags and dependencies |
| `npm run denylist -- --inventory <dir>` | None | READ-ONLY | Generate `docs/migration/s4r-denylist.json` |
| `npm run compare:source -- --artifact <zip> --source <dir>` | None | READ-ONLY | Is production running this source? |
| `npm run compare:build -- <a> <b> [--allow-diff p1,p2]` | None | READ-ONLY | File-for-file artefact equivalence |
| `npm run compare:config -- <baseline-dir> <current-dir>` | None | READ-ONLY | Configuration drift between two inventories |
| `npm run check:changeset -- --changeset <json> --mode import\|update --step <json>` | None | READ-ONLY | Gate before executing a change set |
| `npm run baseline -- <s4r-health\|contract capture\|contract verify\|ingress capture\|ingress verify\|smoke> --live` | HTTP only | SAFE AC CHANGE / READ-ONLY | Behavioural baseline, the S4R `/part-finder` contract, and the separate `/ai/chat` ingress check |
| `npm run traffic -- [--api <id>] [--route "POST /ai/chat"] [--days 30]` | Reads | READ-ONLY | Whether an HTTP API route is actually used (CloudWatch) |
| `npm run backup -- --inventory <dir> --backup-bucket <name> [--enable-pitr] [--execute --confirm-account <id>]` | Writes | SAFE AC CHANGE | Phase 0 backups |
| `npm run token:sub` | None | READ-ONLY | Read your Cognito `sub` from your own access token |
| `npm run hotfix:patch -- --in <deployed.zip> --out <patched.zip>` | None | READ-ONLY | Phase 1: patch the admin check in a copy of the deployed artefact |
| `npm run hotfix:admin -- apply\|rollback ... [--execute --confirm-account <id>]` | Writes | SAFE AC CHANGE | Phase 1: apply or roll back the hotfix on `whichpart-api` only |

## Development

```bash
npm ci
npm run lint
npm test
```

The tests run offline. AWS calls are short-circuited after the guard runs, and HTTP is faked.

## Status

- The change-set checker is a skeleton. Its rules are tested against fixtures and are finalised
  against real change sets in the Phase 4 sandbox rehearsal.
- The smoke scenarios and banding thresholds are first versions, to be refined after the first
  baseline capture.
