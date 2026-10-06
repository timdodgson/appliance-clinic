# Repository governance

How changes reach `main`, and how work is organised. The migration-specific rules are in
[`docs/migration/PLAN.md`](../migration/PLAN.md).

## The `main` branch

`main` only changes through pull requests that pass the required check and have every review
conversation resolved. Nobody, including administrators, can push to it directly, force-push it or
delete it.

### Rules

| Rule | Setting |
|---|---|
| Restrict deletions | On |
| Block force pushes | On |
| Require a pull request before merging | On |
| Required approvals | 0 (see below) |
| Dismiss stale approvals when new commits are pushed | On |
| Require conversation resolution before merging | On |
| Require status checks to pass | On: `migration-tooling` from GitHub Actions |
| Require branches to be up to date before merging | On |
| Allowed merge method | Merge commit, which keeps the focused commits of each branch |
| Bypass list | Empty. The rules apply to administrators too |

**Approvals.** The repository has a single maintainer, and GitHub does not let an author approve
their own pull request, so requiring an approval would block every merge. Requiring a pull request,
the passing check and resolved conversations still keeps every change reviewable and recorded. Raise
the count to 1 when a second reviewer joins.

**Plan requirement.** Rulesets and branch protection on a private repository need a paid GitHub plan
(Pro, Team or Enterprise). On GitHub Free they apply only to public repositories.

### Applying the rules

**Option A: import the ruleset (preferred).**
1. *Settings → Rules → Rulesets → New ruleset → Import a ruleset*.
2. Choose [`.github/rulesets/protect-main.json`](../../.github/rulesets/protect-main.json).
3. Check that the imported values match the table above, then *Create*.

**Option B: classic branch protection.** *Settings → Branches → Add branch protection rule*, with
branch name pattern `main`:

- Require a pull request before merging
  - Required approvals: 0
  - Dismiss stale pull request approvals when new commits are pushed
- Require status checks to pass before merging
  - Require branches to be up to date before merging
  - Status check: `migration-tooling`
- Require conversation resolution before merging
- Do not allow bypassing the above settings
- Allow force pushes: off
- Allow deletions: off

Then, under *Settings → General → Pull Requests*, allow merge commits only.

**Check name.** The `migration-tooling` check appears in the status check search only after it has
run once. It runs on every pull request.

### Verifying the rules

- `git push origin main` from a local commit is rejected.
- A pull request shows *Merging is blocked* until `migration-tooling` passes and every conversation is resolved.
- `git push --force origin main` is rejected.

## Milestones

One milestone per migration phase. Every migration issue and pull request belongs to one.

| Milestone | Description |
|---|---|
| Phase 0 — Inventory and baseline | Freeze, read-only inventory, ownership proof, S4R denylist, backups, behavioural baseline, repository governance |
| Phase 1 — Admin hotfix | AC-side default-deny admin allowlist on `whichpart-api` |
| Phase 2 — Runtime-identical extraction | Import the production code into this repository unchanged |
| Phase 3 — Reproducible build and CI | Workspaces, lockfiles, CI, known-failure baseline, build equivalence |
| Phase 4 — Sandbox rehearsal | Rehearse every import type in a separate AWS account |
| Phase 5 — Production CDK import | Import AC resources into CDK in small, gated groups |
| Phase 6 — Prove CDK ownership | Configuration comparison and one harmless CDK change |
| Phase 7 — Security hardening | AC Cognito, secrets namespace, endpoint protection, least privilege |
| Phase 8 — Architecture cleanup | Retire the legacy pipeline, split large files, TypeScript, documentation |
| Phase 9 — Public portfolio release | Clean, squashed public repository |

## Labels

| Label | Use |
|---|---|
| `migration` | Any migration work |
| `phase-0` … `phase-9` | The phase an issue belongs to |
| `read-only`, `safe-ac-change`, `potentially-impacts-s4r` | The classification of a production step |
| `governance` | Repository process and settings |

## Branches, commits and pull requests

- **Branches** are named by purpose: `migration/phase-N-<topic>`, `infra/<topic>`, `docs/<topic>`,
  `chore/<topic>`.
- **Commits** are small and focused. The subject line is imperative and says what changed. The body
  says why.
- **Pull requests** follow the [template](../../.github/pull_request_template.md): why, scope,
  architecture impact, tests performed, AWS impact, S4R impact, rollback and known limitations. Each
  one links its issue and milestone.
- **Architectural decisions** are recorded as [ADRs](../adr/README.md).
- **Generated output** is never committed. That includes inventory output, CDK output, benchmark
  results and local environment files; `.gitignore` covers them.
