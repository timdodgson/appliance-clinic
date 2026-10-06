# 0001. Record architecture decisions

- **Status:** Accepted
- **Date:** 2026-10-07

## Context

Appliance Clinic is being extracted from a shared monorepo, and its AWS resources are moving under
dedicated infrastructure-as-code. Many choices in that work, such as how to import resources
without replacing them and where the boundary with Spares4Repairs sits, are not obvious from the
code alone. Their reasoning needs to be recorded where future contributors will look.

## Decision

Record significant architectural decisions as architecture decision records in `docs/adr/`, using
the template and process in [`README.md`](README.md).

## Consequences

- Each significant decision gets a short, reviewable record linked from the pull request that
  implements it.
- Records are append-only, so the history of a decision stays visible.

## Alternatives considered

- **Decisions only in pull request descriptions.** Rejected: they are hard to find later and are
  not versioned with the code.
