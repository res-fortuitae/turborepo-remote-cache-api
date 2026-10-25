import { PurgeFilter } from "@repo/api-spec";
export { PurgeFilter } from "@repo/api-spec";
import { Clock, Context, Effect, Layer, Schema } from "effect";
import { ArtifactPurger } from "./purge.ts";

export const PurgeObject = Schema.Struct({
  key: Schema.String,
  etag: Schema.String,
  size: Schema.Number,
  uploaded: Schema.Number,
  metadata: Schema.Record(Schema.String, Schema.String),
});
export type PurgeObject = typeof PurgeObject.Type;
export const PurgeJob = Schema.Struct({
  id: Schema.String,
  orgId: Schema.String,
  projectId: Schema.String,
  actorId: Schema.String,
  filter: PurgeFilter,
  state: Schema.Literals(["scanning", "ready", "queued", "complete", "too_large"]),
  createdAt: Schema.Number,
  readyAt: Schema.optional(Schema.Number),
  cursor: Schema.optional(Schema.String),
  objects: Schema.Array(PurgeObject),
  count: Schema.Number,
  bytes: Schema.Number,
  removed: Schema.Number,
  removedBytes: Schema.Number,
  offset: Schema.Number,
});
export type PurgeJob = typeof PurgeJob.Type;
export class PurgeError extends Schema.TaggedError<PurgeError>()("PurgeError", {
  message: Schema.String,
}) {}
const failure = () => new PurgeError({ message: "Purge storage or audit unavailable" });

/** Host persistence atomically commits job checkpoints with audit events. */
export class PurgeJobs extends Context.Service<
  PurgeJobs,
  {
    get: (id: string) => Effect.Effect<PurgeJob | null, PurgeError>;
    save: (job: PurgeJob, action: string) => Effect.Effect<void, PurgeError>;
    pending: Effect.Effect<readonly string[], PurgeError>;
    claim: (id: string, now: number) => Effect.Effect<boolean, PurgeError>;
    release: (id: string) => Effect.Effect<void, PurgeError>;
  }
>()("@repo/artifacts/PurgeJobs") {}

export class PurgeInventory extends Context.Service<
  PurgeInventory,
  {
    list: (
      prefix: string,
      cursor?: string,
    ) => Effect.Effect<
      { objects: readonly PurgeObject[]; cursor?: string | undefined },
      PurgeError
    >;
    head: (key: string) => Effect.Effect<PurgeObject | null, PurgeError>;
    remove: (keys: readonly string[]) => Effect.Effect<void, PurgeError>;
  }
>()("@repo/artifacts/PurgeInventory") {}

export const matchesPurge = (object: PurgeObject, filter: PurgeFilter, cutoff: number) => {
  if (object.uploaded > cutoff) return false;
  if (filter.hash && object.key.split("/").at(-1) !== filter.hash) return false;
  if (filter.since && object.uploaded < Date.parse(filter.since)) return false;
  if (filter.until && object.uploaded > Date.parse(filter.until)) return false;
  return Object.entries(filter).every(
    ([key, value]) => ["hash", "since", "until"].includes(key) || object.metadata[key] === value,
  );
};

/** Public job summaries deliberately exclude the internal object manifest. */
export const purgeSummary = ({ objects: _objects, ...job }: PurgeJob) => job;

export class IncidentPurge extends Context.Service<
  IncidentPurge,
  {
    preview: (
      orgId: string,
      projectId: string,
      actorId: string,
      filter: PurgeFilter,
    ) => Effect.Effect<PurgeJob, PurgeError>;
    get: (orgId: string, projectId: string, id: string) => Effect.Effect<PurgeJob, PurgeError>;
    confirm: (
      orgId: string,
      projectId: string,
      id: string,
      actorId: string,
    ) => Effect.Effect<PurgeJob, PurgeError>;
    tick: Effect.Effect<void, PurgeError>;
  }
>()("@repo/artifacts/IncidentPurge") {}

export const IncidentPurgeLive = Layer.effect(
  IncidentPurge,
  Effect.gen(function* () {
    const jobs = yield* PurgeJobs;
    const inventory = yield* PurgeInventory;
    const purger = yield* ArtifactPurger;
    const get = Effect.fn("IncidentPurge.get")(function* (
      orgId: string,
      projectId: string,
      id: string,
    ) {
      const job = yield* jobs.get(id);
      if (!job || job.orgId !== orgId || job.projectId !== projectId)
        return yield* new PurgeError({ message: "Purge job not found" });
      return job;
    });
    const step = Effect.fn("IncidentPurge.step")(function* (id: string) {
      const now = yield* Clock.currentTimeMillis;
      if (!(yield* jobs.claim(id, now))) return;
      yield* Effect.gen(function* () {
        const job = yield* jobs.get(id);
        if (!job) return;
        if (job.state === "scanning") {
          const prefix = `${job.orgId}/${job.projectId}/`;
          const page = yield* inventory.list(prefix, job.cursor);
          const selected = page.objects.filter(
            (object) =>
              object.key.startsWith(prefix) && matchesPurge(object, job.filter, job.createdAt),
          );
          const objects = [...job.objects, ...selected];
          // Bound D1 row size and preview memory. Narrow the filter for larger incidents.
          const tooLarge = objects.length > 1000 || JSON.stringify(objects).length > 700_000;
          yield* jobs.save(
            {
              ...job,
              objects: tooLarge ? [] : objects,
              state: tooLarge ? "too_large" : page.cursor ? "scanning" : "ready",
              readyAt: !page.cursor && !tooLarge ? now : undefined,
              cursor: page.cursor,
              count: job.count + selected.length,
              bytes: job.bytes + selected.reduce((n, o) => n + o.size, 0),
            },
            "preview",
          );
        } else if (job.state === "queued") {
          const batch = job.objects.slice(job.offset, job.offset + 100);
          const current = yield* Effect.forEach(batch, (object) => inventory.head(object.key), {
            concurrency: 8,
          });
          const selected = batch.filter(
            (object, i) =>
              current[i] === null ||
              (current[i]?.etag === object.etag && current[i]?.uploaded === object.uploaded),
          );
          // Persist an intent before R2 mutation; failed checkpoints can safely be retried.
          yield* jobs.save(job, "batch_started");
          yield* inventory.remove(selected.map((object) => object.key));
          // Every batch invalidates, including retries after partial R2 deletion.
          yield* purger.invalidate(job.projectId).pipe(Effect.mapError(failure));
          const offset = job.offset + batch.length;
          yield* jobs.save(
            {
              ...job,
              offset,
              removed: job.removed + selected.length,
              removedBytes: job.removedBytes + selected.reduce((n, o) => n + o.size, 0),
              state: offset >= job.objects.length ? "complete" : "queued",
            },
            offset >= job.objects.length ? "completed" : "batch_completed",
          );
        }
      }).pipe(Effect.ensuring(jobs.release(id).pipe(Effect.orDie)));
    });
    return {
      get,
      preview: Effect.fn("IncidentPurge.preview")(function* (orgId, projectId, actorId, input) {
        const filter = yield* Schema.decodeUnknownEffect(PurgeFilter)(input).pipe(
          Effect.mapError(() => new PurgeError({ message: "Invalid purge filter" })),
        );
        if (
          !Object.keys(filter).length ||
          [filter.since, filter.until].some(
            (t) => t !== undefined && !Number.isFinite(Date.parse(t)),
          ) ||
          (filter.since && filter.until && Date.parse(filter.since) > Date.parse(filter.until))
        )
          return yield* new PurgeError({
            message: "Provide a nonempty filter with a valid time range",
          });
        const job: PurgeJob = {
          id: crypto.randomUUID(),
          orgId,
          projectId,
          actorId,
          filter,
          state: "scanning",
          createdAt: yield* Clock.currentTimeMillis,
          objects: [],
          count: 0,
          bytes: 0,
          removed: 0,
          removedBytes: 0,
          offset: 0,
        };
        yield* jobs.save(job, "requested");
        return job;
      }),
      confirm: Effect.fn("IncidentPurge.confirm")(function* (orgId, projectId, id, actorId) {
        const now = yield* Clock.currentTimeMillis;
        if (!(yield* jobs.claim(id, now)))
          return yield* new PurgeError({ message: "Purge job busy; retry" });
        return yield* Effect.gen(function* () {
          const job = yield* get(orgId, projectId, id);
          if (job.state !== "ready" || now - (job.readyAt ?? job.createdAt) > 900_000)
            return yield* new PurgeError({
              message: "A ready preview less than 15 minutes old is required",
            });
          const confirmed = { ...job, state: "queued" as const, actorId };
          yield* jobs.save(confirmed, "confirmed");
          return confirmed;
        }).pipe(Effect.ensuring(jobs.release(id).pipe(Effect.orDie)));
      }),
      tick: Effect.gen(function* () {
        for (const id of yield* jobs.pending) yield* step(id);
      }),
    } satisfies typeof IncidentPurge.Service;
  }),
);
