# 0008. CloudFront initially unmanaged

- **Status:** Accepted
- **Date:** 2026-10-07

## Context

The applianceclinic.ai CloudFront distribution and its redirect function were created in the console,
then edited by a deploy script. A distribution configuration is large; an inaccurate import would
change the live site on the first update, and every update takes minutes to propagate. CloudFront
changes rarely and holds no data.

## Decision

Leave the distribution, its CloudFront function, the ACM certificate and DNS unmanaged during this
migration.

Because the monorepo's `deploy-static.sh` can no longer be used, this repository provides a
replacement site deployment that:

- builds the static site and uploads only to the existing AC site bucket
- never uses `--delete` or prunes files
- never modifies CloudFront configuration
- performs a cache invalidation only when that step has been separately reviewed and approved

## Consequences

- The highest-blast-radius import is avoided, at the cost of the distribution staying outside
  infrastructure-as-code for now.
- The inventory still captures the full distribution configuration, so drift can be detected and an
  import can be planned later as its own reviewed step.
- The custom error responses and redirect function stay as configured today.

## Alternatives considered

- **Import CloudFront last in the initial migration.** Deferred, not rejected. It can follow once
  data and runtime ownership are proven.
- **Use CDK `BucketDeployment` for the site.** Rejected: it prunes by default, and would delete
  deployed content, including the WebMCP origin-trial token, which exists only in the deployed
  `index.html`.
