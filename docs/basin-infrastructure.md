# Basin infrastructure

`@repo/infra` owns the audit and analytics catalogs, streams, sinks and pipelines.
The root composition enables analytics infrastructure only on Workers Paid, with
analytics requested, a catalog token, and the default jurisdiction. Development
exits before resolving cloud resources; analytics capabilities remain lite until
M7 supplies emitters and queries. Disabling a feature retains stateful resources
outside explicit preview stages.

The analytics catalog is separate from audit. `CacheEventsStream` and
`ArtifactOpsStream` validate the server-enriched contracts from `@repo/api-spec`.
Their fixed SQL projections discard invalid enums, negative metrics and empty
tenant identifiers, normalize CI providers, derive event `day` and remote-hit
status, and write `analytics.cache_events` and `analytics.artifact_ops`.
Sinks roll at 60 seconds or 64 MiB. Catalog compaction targets 128 MB;
snapshot expiration keeps at least ten snapshots and expires snapshots after
seven days. Snapshot expiration does not remove live event data.

Basin sinks create their tables and cannot target pre-created tables. They
[automatically partition by `DAY(__ingest_ts)`](https://developers.cloudflare.com/basin-sql/tutorials/end-to-end-pipeline/),
so event-day partitioning cannot be configured through the current sink API.
The derived event `day` remains available for filtering. Do not pre-create these
tables with `Basin.Table`: that prevents sink creation. The complete design uses
three streams, sinks and pipelines per stage (one audit, two analytics); account
quotas are shared across stages and other applications.

`BASIN_CATALOG_TOKEN` is a write credential supplied from the root deployment
environment directly to sink creation. Cloudflare does not echo it back or update
it in place. Follow the pinned Alchemy sink rotation procedure when rotating it.
`BASIN_SQL_TOKEN` is a separate read-only credential in the stage's Secrets Store;
limit it to the required catalog buckets. Never reuse the write credential for
Worker queries. Token creation and permission selection remain operator-owned;
the stack does not broaden account permissions or generate credentials.
