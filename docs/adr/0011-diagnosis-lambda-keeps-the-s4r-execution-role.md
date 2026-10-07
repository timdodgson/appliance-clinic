# 0011. The diagnosis Lambda keeps the S4R execution role during the migration

- **Status:** Accepted
- **Date:** 2026-10-07

## Context

The Phase 0 inventory showed that the diagnosis Lambda, `spares4repairs-part-finder`, does not have
its own execution role. It runs under `SparesSite-dev-ServerFunctionRole…`, which is:

- the execution role of the Spares4Repairs server Lambda, `spares4repairs-server-dev`
- created and managed by the S4R `SparesSite-dev` CloudFormation stack

Three Appliance Clinic permissions were added to that role by hand, outside the S4R stack:
`WhichpartLearningPut`, `whichpart-knowledge-overlay-s3` and `whichpart-media-overlay-s3`.

The plan assumed a separate, console-created role that could be imported with the function (step
5.10). Under [0003](0003-s4r-compatibility-boundary.md), a resource that S4R owns or shares is never
imported or changed by this work.

## Decision

- **The role stays S4R's.** It is never imported into, modified by or managed by AC CDK, and the
  denylist generated from the S4R stack covers it.
- **The import references it unchanged.** When the diagnosis Lambda is imported (step 5.10), the
  function references the existing role ARN, declared as an acknowledged S4R reference in the
  change-set checker's step file.
- **The hand-added AC permissions stay as they are.** They are recorded in `ownership.md`, but not
  imported, changed or removed by this work.
- **Moving off the role is a later, separate change.** A dedicated AC execution role for the
  diagnosis Lambda is a Phase 7 change, classified POTENTIALLY IMPACTS S4R. It needs the
  `/part-finder` contract test before and after, and explicit sign-off. Removing the AC permissions
  from the S4R role afterwards is an S4R change, proposed separately.

## Consequences

- AC CDK can own the diagnosis function without touching anything S4R manages.
- **The diagnosis Lambda's permissions depend on an S4R-managed role.** A Spares4Repairs deployment of
  `SparesSite-dev` could change that role. Whether a CloudFormation update removes inline policies it
  does not manage is exactly what sandbox experiment T1 tests. Until it is answered, S4R deployments
  are a risk to the diagnosis Lambda, which also serves the S4R `/part-finder` page. That risk existed
  before this migration; it is now recorded.
- **The S4R server Lambda can also use those three AC permissions,** for example writing to the AC
  learning bucket. That stays as it is until the role move.

## Alternatives considered

- **Import the role.** Rejected: it belongs to the S4R stack, and a resource can belong to only one stack.
- **Move to a dedicated AC role during the import.** Rejected: it changes behaviour during an
  ownership step, on an S4R-consumed function. It belongs in Phase 7, with its own gate.
