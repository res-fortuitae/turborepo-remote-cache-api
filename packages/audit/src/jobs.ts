import * as Effect from "effect/Effect";
import { AuditLog, OUTBOX_BATCH_SIZE } from "./audit-log.ts";
import { AuditIntegrity } from "./integrity.ts";

/** Batches one drain run may export; the next run continues where it stopped. */
export const MAX_DRAIN_BATCHES = 10;

/** Every minute: export the outbox in order until it is empty or the run's budget is spent. */
export const drainOutboxJob = Effect.gen(function* () {
  const audit = yield* AuditLog;
  let exported = 0;

  for (let batch = 0; batch < MAX_DRAIN_BATCHES; batch++) {
    const count = yield* audit.drainOutbox(OUTBOX_BATCH_SIZE);
    exported += count;

    if (count < OUTBOX_BATCH_SIZE) break;
  }

  return exported;
}).pipe(Effect.withSpan("AuditJobs.drainOutbox"));

/**
 * Daily: checkpoint every chain, verify, then prune. A mismatch is logged as
 * an error (the critical alert) and recorded as an audit event.
 */
export const dailyAuditJob = Effect.gen(function* () {
  const audit = yield* AuditLog;
  const integrity = yield* AuditIntegrity;

  yield* integrity.writeCheckpoints;
  const report = yield* integrity.verifyAndRecord;

  if (report.mismatches.length > 0)
    yield* Effect.logError("Audit integrity check failed", { mismatches: report.mismatches });

  const pruned = yield* audit.prune();

  return { report, pruned };
}).pipe(Effect.withSpan("AuditJobs.daily"));
