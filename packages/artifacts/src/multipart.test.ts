/* oxlint-disable t3code/no-manual-effect-runtime-in-tests -- Bun executes the upload service at this test boundary. */
import { test, expect } from "bun:test";
import { Effect, Layer, Redacted } from "effect";
import * as TestClock from "effect/testing/TestClock";
import {
  MultipartUploads,
  MultipartUploadsLive,
  MultipartBucket,
  MultipartSecret,
} from "./multipart.ts";

test("expired tickets fail closed but permit authenticated cleanup", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const uploads = yield* MultipartUploads;
      const owner = {
        orgId: "o",
        projectId: "p",
        credentialId: "c",
        generation: 0,
        maxBytes: 1_000_000,
      };
      const created = yield* uploads.create(owner, "abc", 1, {});
      yield* TestClock.adjust(86_400_001);
      const result = yield* Effect.result(uploads.resolve(created.id, owner));
      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure") expect(result.failure.status).toBe(410);
      const ticket = yield* uploads.resolve(
        created.id,
        { ...owner, generation: 1, maxBytes: 0 },
        true,
      );
      yield* uploads.abort(ticket);
    }).pipe(
      Effect.provide(
        MultipartUploadsLive.pipe(
          Layer.provide(
            Layer.mergeAll(
              Layer.succeed(MultipartSecret, Redacted.make("test-secret")),
              Layer.succeed(MultipartBucket, {
                create: () => Effect.succeed("id"),
                part: () => Effect.succeed({ partNumber: 1, etag: "etag" }),
                complete: () => Effect.void,
                abort: () => Effect.void,
                head: () => Effect.succeed(null),
                remove: () => Effect.void,
              }),
            ),
          ),
          Layer.provideMerge(TestClock.layer()),
        ),
      ),
    ),
  ));
