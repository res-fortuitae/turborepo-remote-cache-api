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
