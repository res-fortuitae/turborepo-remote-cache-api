import { PurgeJobs, PurgeJob, PurgeError } from "@repo/artifacts";
import { Database, schema } from "@repo/db";
import { AuditLog } from "@repo/audit";
import { and, eq, inArray, lt } from "drizzle-orm";
import { Effect, Layer, Schema } from "effect";

const table = schema.artifactPurgeJob;
const unavailable = () => new PurgeError({ message: "Purge storage or audit unavailable" });
export const PurgeJobsLive = Layer.effect(
  PurgeJobs,
  Effect.gen(function* () {
    const db = yield* Database;
    const audit = yield* AuditLog;
    return {
      get: (id) =>
        db
          .query("PurgeJobs.get", (q) => q.select().from(table).where(eq(table.id, id)).get())
          .pipe(
            Effect.flatMap((row) =>
              row
                ? Schema.decodeUnknownEffect(Schema.fromJsonString(PurgeJob))(row.data)
                : Effect.succeed(null),
            ),
            Effect.mapError(unavailable),
          ),
      save: (job, action) =>
        audit
          .commit(
            {
              scope: "org",
              orgId: job.orgId,
              projectId: job.projectId,
              actor: { type: "user", id: job.actorId, display: job.actorId },
              action: `artifact.purge.${action}`,
              target: { type: "purge", id: job.id },
              outcome: "allow",
              ip: "",
              userAgent: "",
              requestId: job.id,
              metadata: {
                filter: { ...job.filter },
                count: job.count,
                bytes: job.bytes,
                removed: job.removed,
                removedBytes: job.removedBytes,
                state: job.state,
                offset: job.offset,
              },
            },
            (q) => [
              q
                .insert(table)
                .values({
                  id: job.id,
                  projectId: job.projectId,
                  state: job.state,
                  data: JSON.stringify(job),
                })
                .onConflictDoUpdate({
                  target: table.id,
                  set: { state: job.state, data: JSON.stringify(job) },
                }),
            ],
          )
          .pipe(Effect.asVoid, Effect.mapError(unavailable)),
      pending: db
        .query("PurgeJobs.pending", (q) =>
          q
            .select({ id: table.id })
            .from(table)
            .where(inArray(table.state, ["scanning", "queued"]))
            .limit(10),
        )
        .pipe(
          Effect.map((rows) => rows.map((r) => r.id)),
          Effect.mapError(unavailable),
        ),
      claim: (id, now) =>
        db
          .query("PurgeJobs.claim", (q) =>
            q
              .update(table)
              .set({ leaseUntil: now + 120_000 })
              .where(and(eq(table.id, id), lt(table.leaseUntil, now)))
              .returning({ id: table.id }),
          )
          .pipe(
            Effect.map((rows) => rows.length === 1),
            Effect.mapError(unavailable),
          ),
      release: (id) =>
        db
          .query("PurgeJobs.release", (q) =>
            q.update(table).set({ leaseUntil: 0 }).where(eq(table.id, id)),
          )
          .pipe(Effect.asVoid, Effect.mapError(unavailable)),
    } satisfies typeof PurgeJobs.Service;
  }),
);
