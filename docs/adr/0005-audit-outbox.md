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

## Hashes

Each event's `hash` is SHA-256 over its canonical JSON (keys sorted) without `hash`.
The stored payload is that same canonical JSON. `prevHash` is null until the hash
chain ([STV-482](https://linear.app/stvyas-workspace/issue/STV-482)) sequences events.

## Not yet wired

The Worker provides `AuditSinkUnconfigured`, so events accumulate in the outbox. The
Pipelines sink and the drain/prune cron arrive with
[STV-459](https://linear.app/stvyas-workspace/issue/STV-459).
