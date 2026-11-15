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
    return yield* Effect.acquireUseRelease(
      quotas.reserve(
        { orgId: credential.orgId, projectId: credential.projectId },
        hash,
        bytes ?? Math.min(scope.maxUploadBytes, maximumBytes),
      ),
      (reservation) =>
        Effect.gen(function* () {
          const response = yield* upload;
          const stored = yield* storage.head(`${scope.prefix}/${hash}`);
          if (!stored) {
            return yield* new ApiError({
              status: 503,
              code: "quota_storage",
              message: "Upload accounting unavailable",
            });
          }
          const finished = yield* quotas.finish(reservation, stored.size).pipe(Effect.result);
          if (finished._tag === "Failure") {
            yield* storage.remove(`${scope.prefix}/${hash}`);
            return yield* Effect.fail(finished.failure);
          }
          return response;
        }),
      (reservation) => quotas.release(reservation),
    );
  }).pipe(
    Effect.mapError((error) =>
      error instanceof ApiError
        ? error
        : new ApiError({
            status: error._tag === "QuotaExceeded" ? 403 : error._tag === "QuotaBusy" ? 429 : 503,
            code:
              error._tag === "QuotaExceeded"
                ? "over_limit"
                : error._tag === "QuotaBusy"
                  ? "upload_busy"
                  : "quota_unavailable",
            retryAfter: error._tag === "QuotaBusy" ? 1 : undefined,
            message: "Upload quota exceeded or unavailable",
          }),
    ),
  );
