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
