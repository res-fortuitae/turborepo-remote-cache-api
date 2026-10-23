---
status: accepted
---

# Audit log: transactional outbox in D1

**An admin change and its audit event commit in the same D1 batch; a cron exports
committed events to the audit stream.** This decision implements
[STV-457](https://linear.app/stvyas-workspace/issue/STV-457).

## Write paths

- **Admin mutations.** `AuditLog.record(input)` builds the event (ULID `id`, `ts`,
  `schemaVersion`, `hash`) and returns `{ event, statement }`. The caller adds
  `statement(db)` to the `Database.batch` that makes the change. D1 batches are
  atomic, so a change can't commit without its audit row and a failed change leaves
  none. Because of this there is no pending state and no reconciler.
- **High-volume denials.** `AuditLog.recordStandalone(input)` sends the event straight
  to `AuditSink` with no D1 row. Callers run it under `waitUntil`. Per-minute denial
  counters for alerting are left to the issue that adds alerting.

## Outbox

`audit_event.exported_at` is null until export. `drainOutbox(limit)` reads the oldest
unexported rows by `(ts, id)`, sends them to `AuditSink`, and only then marks them
exported, so a failed send is retried. Delivery is at least once; consumers remove
duplicates by `id`. `prune()` deletes exported rows older than 90 days; unexported
rows are never pruned.

There is no update or delete API for events.

## Hash chain

There is one chain per org (`org:<id>`) and one for instance events (`instance`). Each
row stores its `chain` and `sequence`, and `(chain, sequence)` is unique.
`record` reads the chain head and sets `prevHash` to the head's hash and `sequence` to
the head's plus one. `hash = SHA-256(prevHash || canonicalJson(event without hash))`,
where the canonical JSON sorts keys. The stored payload is that canonical JSON.

Two writers that read the same head both try to insert the same sequence; the unique
index fails the second batch, so the chain can't fork. `AuditLog.commit(input, change)`
runs the batch and re-records up to five times when the head has moved. If the head
didn't move, the change itself failed, and that error is returned. This is the "D1
conditional insert" option in [ADR 0002](./0002-storage-consistency-rules.md). A
per-chain Durable Object sequencer is only needed if contention grows.
`recordStandalone` events have no row, so they aren't chained.

`prune` never deletes a chain's head, so the next event still links to it.

## Checkpoints and verifier

`AuditIntegrity.writeCheckpoints` writes `{scope, lastId, lastHash, count, date}` for
every chain head to `checkpoints/{date}/{scope}.json`. `count` is the head's
sequence. The store is create-only, and the `AuditCheckpoints` R2 bucket (in
`@repo/infra`) has a lock rule on `checkpoints/` for 400 days. That bucket is separate
from the audit Iceberg catalog, whose compaction rewrites files.

`verify` walks each chain in D1 in sequence order. It recomputes every hash and checks
the payload against its row, the `prevHash` links and that sequences have no gaps. It
then compares the chain with every checkpoint. Any checkpointed event that is still in
D1 must have the checkpoint's id and hash, and a checkpoint beyond the current head
means events were truncated. The first row left after pruning is trusted to link;
older ranges are checked against Iceberg once it exists. `verifyAndRecord` commits an
`audit.integrity.failed` event to the instance chain when anything mismatches.

## Export to Basin (STV-459)

`@repo/infra` declares the `AuditStream` (schema: api-spec `AuditEvent`), a dedicated
`AuditCatalog` bucket and Basin Catalog (compaction at 128 MB, snapshot expiration after
7 days), the `audit.audit_log` Iceberg sink and a passthrough pipeline. The pipeline only
validates: records that don't match the stream schema are dropped. These resources exist
only when `BASIN_CATALOG_TOKEN` is set at deploy time and no jurisdiction is configured.
Basin Catalog doesn't support restricted jurisdictions (see `docs/data-residency.md`).
The deploy step writes the same decision to the Worker's `AUDIT_STREAM_ENABLED`.

The Worker binds the stream through `makeAuditSink` and runs two crons:

- `* * * * *`: `drainOutboxJob` exports up to 10 batches of 100 rows. It does nothing
  when the stream is disabled, so events stay in D1.
- `17 3 * * *`: `dailyAuditJob` writes checkpoints to the `AuditCheckpoints` bucket, runs
  `verifyAndRecord` (a mismatch is logged as an error and recorded), then prunes. Pruning
  only removes rows that were exported, so without Basin nothing is pruned.

**Retention.** The Iceberg table is kept forever by default. Basin SQL is read-only, so
deleting old partitions needs an Iceberg writer (PyIceberg or Spark) run by an operator
outside Workers. That job is optional and not part of this repo.

**Partitioning.** The issue asked for partitioning by `day`, but the Pipelines catalog
sink doesn't expose an Iceberg partition spec, so the table uses Cloudflare's default
layout. Queries filter on `ts`.

**Limits.** This uses one stream, one sink and one pipeline of the account's 20 each.

## Not yet built

- Per-minute D1 counters of standalone denials, for alerting.
- Iceberg range verification for events older than the D1 window.
- The dashboard's "verified up to" status, the admin action that runs
  `verifyAndRecord`, and the CLI verifier.
