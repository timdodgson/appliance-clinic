# Phase 0: freeze

**Classification:** process only. No AWS commands.

The baseline is only meaningful if nothing changes Appliance Clinic production while it is
captured and while each later production step runs. The freeze starts before the inventory and
stays in place until Phase 6 exit, except where a runbook lifts it for a specific step.

## Checklist

Record each item, with the date, on the Phase 0 freeze issue.

- [ ] **Batch runs stopped.** No benchmark or batch runner is started. They rewrite the live AI
      routing configuration.
- [ ] **Routing override idle.** The admin dashboard shows no active routing override lease. The
      inventory also captures `acq/routing/override.json`; confirm it shows no active lease.
- [ ] **Settings Apply frozen.** No AI configuration, provider key or routing changes through the admin.
- [ ] **Admin publishing frozen.** No Knowledge, Media, Error Code or Safety/Recall publish, rollback or archive.
- [ ] **Old-repo deploy scripts frozen.** Nobody runs any `deploy.sh` or `deploy-static.sh` from
      `spares4repairs`, from `main` or any branch. This includes AI coding agents with access to that repository.
- [ ] **Spares4Repairs deploys.** If S4R deploys continue during the migration, note when, so an
      S4R change is not mistaken for a migration side effect.

## Lifting the freeze

The freeze is lifted only after Phase 6 exit, by a comment on the freeze issue. Between steps,
anything that must change in production is raised as an issue first.
