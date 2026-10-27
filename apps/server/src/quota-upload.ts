import { Quotas } from "@repo/artifacts";
import { Effect } from "effect";
import type * as Request from "effect/http/HttpServerRequest";
import type * as Response from "effect/http/HttpServerResponse";
import { ApiError, type ArtifactScope } from "./api.ts";

export const admitQuotaUpload = <R>(
  scope: ArtifactScope,
  hash: string,
  bytes: number | undefined,
  maximumBytes: number,
  upload: Effect.Effect<Response.HttpServerResponse, ApiError, R | Request.HttpServerRequest>,
  storage: {
    readonly head: (key: string) => Effect.Effect<{ readonly size: number } | null, ApiError, R>;
    readonly remove: (key: string) => Effect.Effect<void, ApiError, R>;
  },
) =>
  Effect.gen(function* () {
    const credential = scope.credential;
    if (!credential || credential.credentialType === "legacy") return yield* upload;
    const quotas = yield* Quotas;
    const reservation = yield* quotas.reserve(
      { orgId: credential.orgId, projectId: credential.projectId },
      hash,
      bytes ?? Math.min(scope.maxUploadBytes, maximumBytes),
    );
    const result = yield* upload.pipe(Effect.result);
    if (result._tag === "Failure") {
      yield* quotas.release(reservation);
      return yield* Effect.fail(result.failure);
    }
    const stored = yield* storage.head(`${scope.prefix}/${hash}`);
    if (!stored) {
      yield* quotas.release(reservation);
      return yield* new ApiError({
        status: 503,
        code: "quota_storage",
        message: "Upload accounting unavailable",
      });
    }
    const finished = yield* quotas.finish(reservation, stored.size).pipe(Effect.result);
    if (finished._tag === "Failure") {
      yield* storage.remove(`${scope.prefix}/${hash}`);
      yield* quotas.release(reservation);
      return yield* Effect.fail(finished.failure);
    }
    return result.success;
  }).pipe(
    Effect.mapError((error) =>
      error instanceof ApiError
        ? error
        : new ApiError({
            status: error._tag === "QuotaExceeded" ? 403 : 503,
            code: error._tag === "QuotaExceeded" ? "over_limit" : "quota_unavailable",
            message: "Upload quota exceeded or unavailable",
          }),
    ),
  );
