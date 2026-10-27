# Analytics contracts

`CacheEventRecord` and `ArtifactOperationRecord` are version-1 Effect schemas,
re-exported from `@repo/api-spec` for the Worker, jobs and dashboard. Turbo's
untrusted event payload is a separate contract. Decode enriched records before
sending them; only approved fields survive decoding.

The server assigns a ULID `event_id` once before delivery. Retries preserve it;
rollups deduplicate by it. `id` remains the same value for compatibility with the
original Basin stream. `operation` retains the uppercase operation while `op`
provides the lowercase contract. Keep these columns when evolving Iceberg tables;
add columns rather than renaming or removing them. `day` is the UTC date of `ts`.

Records contain organization, project, credential and repository IDs, never user
names or emails. Missing enrichment is null, not an invented identity. Repository
refs and client CI labels must be bounded and sanitized by the emitter. Credentials
and claims must never be spread into records. `sample_rate` is the probability of
selection in (0, 1]; consumers weight sampled totals by its inverse. Distinct
sessions are estimates when sampling is enabled.

Cache durations and byte counts are nonnegative integers. Artifact latency is a
finite nonnegative number and status is an HTTP status. Query operations have an
empty hash and zero bytes; bypassed edge caching uses `BYPASS`. DELETE is retained
for maintenance and storage accounting.

# Delivery and accounting

The Worker selects Basin emitters on eligible Paid/default-jurisdiction deployments
with provisioned streams. Other deployments retain D1 lite counters or disabled
analytics. Both cache-event batches and server operations run under `waitUntil`;
stream failures increment Effect metrics and are logged without failing cache traffic.
There is no durable analytics outbox: failed sends can lose telemetry. Audit delivery
retains its separate durable guarantees.

Configure `analyticsSampleRates: { "organization-id": 0.1 }` in deployment config
to sample that organization's events. The default is 1. Sampling applies only to
Basin telemetry; upload provenance, storage accounting and activity flags remain
unsampled. Client CI labels are untrusted hints; signed provider/repository/ref
context comes from the resolved credential. No live KV request counters are used.

`project.first_hit_at` records the first observed successful remote download;
`last_seen_at` records activity. KV throttles these D1 writes to roughly hourly.
`project_usage` is maintained with atomic D1 batches and an object-size ledger,
so repeats/overwrites do not count as new storage. PUT observation reads the stored
size, including chunked and multipart uploads. Maintenance and incident deletion
subtract ledger sizes. R2 and D1 cannot share a transaction: concurrent writes,
background failures and native R2 expiry can temporarily skew totals; nightly
inventory reconciliation repairs drift. These values are accounting estimates,
not an admission-control quota implementation.

# Rollups and reconciliation

Basin mode requires Workers Paid, the default jurisdiction and both root secrets
`BASIN_CATALOG_TOKEN` and `BASIN_SQL_TOKEN`. Missing prerequisites select lite mode.
Use a SQL reader token with access to the analytics warehouse and the permissions
required by [Cloudflare's authentication guide](https://developers.cloudflare.com/basin-sql/query-data/#authentication).
The SQL adapter uses Effect HttpClient, a 30-second timeout, an 8 MiB streaming
response limit and redacted credentials. SQL text is internal to domain templates.

At minute 5 each hour, two global queries recompute the last three completed hours.
Queries prune by `day` and `ts`, deduplicate `event_id` with a window function, and
weight sampled totals by `1/sample_rate`. Raw unique sessions use `approx_distinct`;
aggregated hours/days sum those estimates, so sessions spanning buckets may be
counted more than once. They are not a daily distinct-user count. Hit and edge-hit
rates are derived from summed numerators/denominators, never averaged percentages.
Daily totals and top 20 provider/repository/ref dimensions are rebuilt in D1,
including affected days after every hourly run and the previous two days at 02:15 UTC.

Responses above 2,000 rows per source query or daily publication fail before
publication, preserving previous data. This bounds Worker/D1 work and prevents
silently truncated totals. High-cardinality installations must increase the budget
with corresponding runtime capacity or reduce telemetry dimensions before relying
on this job. Data arriving over three hours late requires an operator backfill;
no raw history is queried during dashboard views.

Every minute, inventory reconciles one project page (10 objects), retaining its
cursor in D1. An object ledger observation is idempotent. Only after the final page
are old unseen ledger entries removed and the total recomputed transactionally.
Completed projects are revisited after 24 hours. This small budget also works on
Free D1; large inventories can take multiple days. Storage is an eventually
reconciled estimate during concurrent R2 writes, not a point-in-time snapshot.

The SQL templates were checked against the current
[Basin SQL reference](https://developers.cloudflare.com/basin-sql/sql-reference/)
and [aggregate functions](https://developers.cloudflare.com/basin-sql/sql-reference/aggregate-functions/).

Validation includes SQLite-backed idempotence, late-data, failure-preservation and
paged-inventory tests. Both production SQL templates were also executed against
DuckDB fixtures with an `approx_distinct` alias to DuckDB's `approx_count_distinct`:
duplicate delivery, sample weighting, LOCAL exclusion and bandwidth checks passed.
This is a dialect smoke check, not a hosted Basin execution test.

# Analytics API

A fresh, non-impersonated session is required on every request. Org/project routes
use `analytics:read`; instance routes require auditor, admin or owner. Cache bearer
credentials do not grant dashboard analytics access. Authorization is rechecked
before consulting a drill-down cache.

- `GET /orgs/:id/analytics?from=...&to=...&granularity=hour|day`
- `GET /projects/:id/analytics?from=...&to=...&granularity=hour|day`
- `GET /instance/analytics?from=...&to=...&granularity=hour|day`
- `GET /projects/:id/analytics/drilldown?from=...&to=...&template=most-missed&limit=20`

Time-series ranges must use aligned UTC bucket boundaries and span at most 31 days.
Missing buckets are zero-filled. Totals combine counts before deriving hit rates.
`storageBytes` is the current reconciled estimate in totals and org/project
breakdowns; historical series now include hourly storage observations from ledger mutations and completed inventory reconciliation. Each bucket carries the last observation within the selected range; `storageObserved` is false until every project in scope has an observation. Unknown buckets must not be plotted as zero. Snapshots begin with this version and are estimates, not backfilled history. `uniqueSessions` retains the bucket-sum estimate described above. Results
are capped at 100 breakdowns, ordered by combined served bytes and current storage.
Instance breakdowns identify both orgs and projects with a `kind` field. Project
breakdowns also include the stored provider/repository/ref dimensions.

Page views read only D1. Lite counters fill buckets without published Basin data.
The read budget is 20,000 rows per input table; overly broad selections return 503
rather than partial totals. Daily Basin aggregates cover their available hours;
lite hours from before a mode transition are added without counting overlapping
published hours twice.

Drill-downs accept `most-missed`, `slowest-tasks`, `edge-cache`, or `ref-history`.
The last requires `ref`; all require a limit from 1–100 and at most 30 days. Tenant
filters come from the authorized project, never query parameters. Templates
prune dates, deduplicate delivery IDs, weight sampled counters and cap result rows.
The edge template returns edge-hit/miss counters. Ref history returns hourly
buckets. There is no raw-SQL endpoint. KV caches validated results for five minutes,
keyed by tenant, template and all parameters. KV failures bypass caching; warehouse
timeouts/errors return 503 with no partial result. Responses are `no-store` at the
HTTP boundary.

# Direct Iceberg access (instance administrators only)

Catalog credentials expose the whole analytics warehouse; they cannot enforce
this application's per-organization authorization. Never distribute them to org
admins or dashboard clients. Use a read-only credential and obtain the Catalog URI
and Warehouse name from the deployed AnalyticsCatalog bucket's catalog settings.
The root `BASIN_SQL_TOKEN` is shared with audit queries and must be scoped to both
catalog buckets when both integrations are enabled.

For DuckDB, follow the maintained
[Cloudflare DuckDB connection example](https://developers.cloudflare.com/basin-catalog/config-examples/duckdb/),
attach the warehouse using its Iceberg extension, then query named columns from
`<attached_catalog>.analytics.cache_events` or `.analytics.artifact_ops`, always
including `day` and `ts` filters. Keep credentials in a DuckDB secret, not SQL files
committed to the repository.

For PyIceberg, initialize `RestCatalog` with the Warehouse name, Catalog URI and a
read-only token supplied by your secret manager. Load `analytics.cache_events` or
`analytics.artifact_ops`, then use a bounded scan with selected fields and date
filters; see [Cloudflare's PyIceberg example](https://developers.cloudflare.com/basin-catalog/config-examples/pyiceberg/).
These are read-only investigation paths; don't mutate managed tables or schemas.
