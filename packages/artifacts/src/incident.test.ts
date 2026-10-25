/* oxlint-disable t3code/no-manual-effect-runtime-in-tests -- Service integration at the Bun test boundary. */
import { expect, test } from "bun:test";
import { Effect, Layer } from "effect";
import {
  IncidentPurge,
  IncidentPurgeLive,
  PurgeInventory,
  PurgeJobs,
  type PurgeJob,
  type PurgeObject,
} from "./incident.ts";
import { ArtifactPurger } from "./purge.ts";

const fixture = (
  task: (
    purge: typeof IncidentPurge.Service,
    objects: Map<string, PurgeObject>,
    events: string[],
    jobs: Map<string, PurgeJob>,
  ) => Effect.Effect<void, unknown>,
) => {
  const jobs = new Map<string, PurgeJob>();
  const objects = new Map<string, PurgeObject>();
  const events: string[] = [];
  const claimed = new Set<string>();
  const layer = IncidentPurgeLive.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(PurgeJobs, {
          get: (id) => Effect.succeed(jobs.get(id) ?? null),
          save: (job, event) =>
            Effect.sync(() => {
              jobs.set(job.id, job);
              events.push(event);
            }),
          claim: (id) =>
            Effect.sync(() => {
              if (claimed.has(id)) return false;
              claimed.add(id);
              return true;
            }),
          release: (id) =>
            Effect.sync(() => {
              claimed.delete(id);
            }),
          pending: Effect.sync(() =>
            [...jobs.values()]
              .filter((j) => ["scanning", "queued"].includes(j.state))
              .map((j) => j.id),
          ),
        }),
        Layer.succeed(PurgeInventory, {
          list: (prefix) =>
            Effect.succeed({
              objects: [...objects.values()].filter((o) => o.key.startsWith(prefix)),
            }),
          head: (key) => Effect.sync(() => objects.get(key) ?? null),
          remove: (keys) =>
            Effect.sync(() => {
              events.push("delete");
              for (const key of keys) objects.delete(key);
            }),
        }),
        Layer.succeed(ArtifactPurger, {
          remove: () => Effect.void,
          invalidate: () =>
            Effect.sync(() => {
              events.push("invalidate");
              return 1;
            }),
        }),
      ),
    ),
  );
  return Effect.runPromise(
    Effect.flatMap(IncidentPurge, (purge) => task(purge, objects, events, jobs)).pipe(
      Effect.provide(layer),
    ),
  );
};
const object = (key: string, runId = "bad"): PurgeObject => ({
  key,
  etag: key,
  size: 10,
  uploaded: Date.now() - 10_000,
  metadata: { runId, ref: "refs/heads/main" },
});

test("dry run selects intersections in one tenant; confirmation and checkpoints delete in bounded batches", () =>
  fixture((purge, objects, events) =>
    Effect.gen(function* () {
      for (let i = 0; i < 205; i++) objects.set(`org/project/${i}`, object(`org/project/${i}`));
      objects.set("org/other/ff", object("org/other/ff"));
      objects.set("org/project/good", object("org/project/good", "good"));
      const job = yield* purge.preview("org", "project", "admin", {
        runId: "bad",
        ref: "refs/heads/main",
      });
      expect((yield* Effect.result(purge.confirm("org", "project", job.id, "admin")))._tag).toBe(
        "Failure",
      );
      yield* purge.tick;
      const preview = yield* purge.get("org", "project", job.id);
      expect(preview).toMatchObject({ state: "ready", count: 205, bytes: 2050 });
      expect(objects.size).toBe(207);
      expect((yield* Effect.result(purge.get("evil", "project", job.id)))._tag).toBe("Failure");
      yield* purge.confirm("org", "project", job.id, "admin");
      yield* purge.tick;
      expect((yield* purge.get("org", "project", job.id)).offset).toBe(100);
      yield* purge.tick;
      yield* purge.tick;
      expect(yield* purge.get("org", "project", job.id)).toMatchObject({
        state: "complete",
        removed: 205,
        removedBytes: 2050,
      });
      expect(objects.size).toBe(2);
      expect(events.filter((e) => e === "invalidate")).toHaveLength(3);
      expect(events.indexOf("confirmed")).toBeLessThan(events.indexOf("delete"));
      expect(events.at(-1)).toBe("completed");
    }),
  ));

test("preview excludes new writes; confirmation skips overwritten objects and rejects expired or oversized previews", () =>
  fixture((purge, objects, _events, jobs) =>
    Effect.gen(function* () {
      objects.set("o/p/aa", object("o/p/aa"));
      objects.set("o/p/bb", { ...object("o/p/bb"), uploaded: Date.now() + 10000 });
      const job = yield* purge.preview("o", "p", "a", { runId: "bad" });
      yield* purge.tick;
      expect((yield* purge.get("o", "p", job.id)).count).toBe(1);
      objects.set("o/p/aa", { ...object("o/p/aa"), etag: "replacement" });
      yield* purge.confirm("o", "p", job.id, "a");
      yield* purge.tick;
      expect(objects.size).toBe(2);
      expect((yield* purge.get("o", "p", job.id)).removed).toBe(0);
      const expired = {
        ...(yield* purge.get("o", "p", job.id)),
        state: "ready" as const,
        readyAt: 1,
      };
      jobs.set(job.id, expired);
      expect((yield* Effect.result(purge.confirm("o", "p", job.id, "a")))._tag).toBe("Failure");
      for (let i = 0; i < 1001; i++) objects.set(`o/q/${i}`, object(`o/q/${i}`));
      const large = yield* purge.preview("o", "q", "a", { runId: "bad" });
      yield* purge.tick;
      expect((yield* purge.get("o", "q", large.id)).state).toBe("too_large");
      expect((yield* Effect.result(purge.preview("o", "p", "a", {})))._tag).toBe("Failure");
      expect((yield* Effect.result(purge.preview("o", "p", "a", { since: "invalid" })))._tag).toBe(
        "Failure",
      );
    }),
  ));
