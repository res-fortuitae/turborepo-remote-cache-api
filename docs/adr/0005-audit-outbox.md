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

## Not yet wired

The Worker provides `AuditSinkUnconfigured`, so events accumulate in the outbox. The
Pipelines sink, the crons (drain each minute; prune, checkpoint and verify daily), the
checkpoint bucket binding and Iceberg verification arrive with
[STV-459](https://linear.app/stvyas-workspace/issue/STV-459). The dashboard's "verified
up to" status and the admin action that runs `verifyAndRecord` come with the audit UI.
