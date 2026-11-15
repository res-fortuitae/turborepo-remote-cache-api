/* oxlint-disable t3code/no-manual-effect-runtime-in-tests -- R2 adapter boundary. */
import { expect, test } from "bun:test";
import type { R2Bucket } from "@cloudflare/workers-types";
import { Effect } from "effect";
import { invalidateUpload } from "../src/upload-cleanup.ts";

for (const race of [false, true]) {
  test(`cleanup conditionally invalidates its revision (concurrent overwrite: ${race})`, async () => {
    let etag = "a";
    let bytes = "A";
    const bucket = {
      head: async () => ({
        etag: "a",
        uploaded: new Date(0),
        customMetadata: { uploadSession: "a" },
      }),
      put: async (
        _key: string,
        _body: Uint8Array,
        options: { onlyIf: { etagMatches: string } },
      ) => {
        if (race) {
          etag = "b";
          bytes = "B";
        }
        if (etag !== options.onlyIf.etagMatches) return null;
        bytes = "";
        return {};
      },
    } as unknown as R2Bucket;
    expect(await Effect.runPromise(invalidateUpload(bucket, "o/p/aa", "a"))).toBe(!race);
    expect(bytes).toBe(race ? "B" : "");
  });
}

test("local R2 tombstone is hidden from reads and removes accounted usage", async () => {
  const { Miniflare } = await import("miniflare");
  const {
    ArtifactStore,
    ArtifactStoreLive,
    R2Bucket: BucketService,
  } = await import("@repo/artifacts");
  const { StorageAccounting, StorageAccountingLive } = await import("@repo/analytics");
  const { DatabaseTest } = await import("@repo/db/testing");
  const { Database, schema } = await import("@repo/db");
  const { Layer, Stream } = await import("effect");
  const mf = new Miniflare({
    modules: true,
    script: "export default {fetch(){return new Response('local')}}",
    r2Buckets: ["BUCKET"],
    host: "127.0.0.1",
    port: 0,
  });
  try {
    const raw = await mf.getR2Bucket("BUCKET");
    await raw.put("o/p/aa", "A", { customMetadata: { uploadSession: "a" } });
    await Effect.runPromise(
      Effect.gen(function* () {
        const db = yield* Database;
        const accounting = yield* StorageAccounting;
        yield* db.batch((q) => [
          q
            .insert(schema.organization)
            .values({ id: "o", slug: "o", name: "O", createdAt: new Date() }),
          q
            .insert(schema.project)
            .values({ id: "p", orgId: "o", slug: "p", name: "P", createdAt: 0 }),
        ]);
        yield* accounting.record({ orgId: "o", projectId: "p" }, "aa", 1);
        expect(yield* invalidateUpload(raw as unknown as R2Bucket, "o/p/aa", "a")).toBe(true);
        yield* accounting.record({ orgId: "o", projectId: "p" }, "aa", null);
        const store = yield* ArtifactStore;
        expect(yield* store.head("o/p", "aa")).toBeNull();
        expect(yield* store.get("o/p", "aa")).toBeNull();
        const rows = yield* db.query("test.usage", (q) => q.select().from(schema.artifactUsage));
        expect(rows.length).toBe(0);
        const usage = yield* db.query("test.projectUsage", (q) =>
          q.select().from(schema.projectUsage),
        );
        expect(usage[0]?.bytes).toBe(0);
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            StorageAccountingLive.pipe(Layer.provideMerge(DatabaseTest)),
            ArtifactStoreLive.pipe(
              Layer.provide(
                Layer.succeed(BucketService, {
                  head: (key) => Effect.tryPromise(() => raw.head(key)),
                  get: (key) =>
                    Effect.tryPromise(() => raw.get(key)).pipe(
                      Effect.map((object) => (object ? { ...object, body: Stream.empty } : null)),
                    ),
                  put: () => Effect.void,
                  delete: () => Effect.void,
                }),
              ),
            ),
          ),
        ),
      ),
    );
  } finally {
    await mf.dispose();
  }
});
