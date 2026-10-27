import { Quotas, MultipartUploads, uploadProvenance, type MultipartOwner } from "@repo/artifacts";
import { MultipartCreate, MultipartComplete } from "@repo/api-spec";
import type { ArtifactOperation } from "@repo/analytics";
import { Effect, Schema, Stream } from "effect";
import * as Request from "effect/http/HttpServerRequest";
import * as Response from "effect/http/HttpServerResponse";
import { ApiError, type ArtifactScope } from "./api.ts";

export const isMultipartPath = (path: string) =>
  path === "/v8/x/uploads" || path.startsWith("/v8/x/uploads/");
const route = /^\/v8\/x\/uploads(?:\/([A-Za-z0-9_.-]+)\/(?:(parts)\/(\d+)|(complete|abort)))?\/?$/;
const bad = (message: string) => new ApiError({ status: 400, code: "bad_request", message });
const readJson = Effect.gen(function* () {
  const request = yield* Request.HttpServerRequest;
  const decoder = new TextDecoder();
  let length = 0;
  const text = yield* Stream.runFoldEffect(
    request.stream,
    () => "",
    (text, chunk) => {
      length += chunk.byteLength;
      return length > 2_000_000
        ? Effect.fail(bad("Multipart manifest exceeds 2 MB"))
        : Effect.succeed(text + decoder.decode(chunk, { stream: true }));
    },
  ).pipe(Effect.mapError(() => bad("Invalid or oversized multipart body")));
  return yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Json))(
    text + decoder.decode(),
  ).pipe(Effect.mapError(() => bad("Invalid JSON body")));
});

export const multipartRoute = <R>(
  scope: ArtifactScope,
  recheck: Effect.Effect<ArtifactScope, ApiError, R>,
  emit: (scope: ArtifactScope, op: ArtifactOperation) => Effect.Effect<void, never, R>,
  invalidateLocal: (hash: string) => Effect.Effect<void, never, R>,
) =>
  Effect.gen(function* () {
    const request = yield* Request.HttpServerRequest;
    const credential = scope.credential;
    if (!credential || credential.credentialType === "legacy")
      return yield* new ApiError({
        status: 403,
        code: "forbidden",
        message: "Multipart requires a scoped cache credential",
      });
    const match = route.exec(new URL(request.url, "http://localhost").pathname);
    if (!match) return yield* bad("Invalid multipart route");
    const owner: MultipartOwner = {
      orgId: credential.orgId,
      projectId: credential.projectId,
      // A bound job keeps its key across JWT refreshes; bearer credentials remain token-bound.
      credentialId:
        credential.credentialType === "cacheJwt" && credential.principal.cnf
          ? `dpop:${credential.principal.cnf.jkt}`
          : credential.credentialId,
      generation: scope.cacheGeneration ?? 0,
      maxBytes: scope.maxUploadBytes,
    };
    const uploads = yield* MultipartUploads;
    const quotas = yield* Effect.serviceOption(Quotas);
    if (!match[1] && request.method === "POST") {
      const body = yield* Schema.decodeUnknownEffect(MultipartCreate)(yield* readJson).pipe(
        Effect.mapError(() => bad("Invalid multipart creation request")),
      );
      const headers = request.headers;
      const metadata = uploadProvenance(credential);
      if (headers["x-artifact-duration"] && !/^\d+$/.test(headers["x-artifact-duration"]))
        return yield* bad("Invalid x-artifact-duration");
      for (const [header, key] of [
        ["x-artifact-duration", "duration"],
        ["x-artifact-tag", "tag"],
        ["x-artifact-sha", "sha"],
        ["x-artifact-dirty-hash", "dirtyHash"],
      ] as const) {
        if (headers[header]) metadata[key] = headers[header];
      }
      const reservation =
        quotas._tag === "Some"
          ? yield* quotas.value.reserve(
              { orgId: owner.orgId, projectId: owner.projectId },
              body.hash,
              body.size,
              86400000,
            )
          : undefined;
      const created = yield* uploads
        .create({ ...owner, quotaReservation: reservation }, body.hash, body.size, metadata)
        .pipe(
          Effect.tapError(() =>
            reservation && quotas._tag === "Some" ? quotas.value.release(reservation) : Effect.void,
          ),
        );
      return yield* Response.json(created, { status: 201 });
    }
    if (match[1]) {
      const ticket = yield* uploads.resolve(match[1], owner, match[4] === "abort");
      if (
        scope.requireArtifactSigning &&
        match[4] !== "abort" &&
        !/^[A-Za-z0-9+/]{43}=$/.test(ticket.provenance.tag ?? "")
      )
        return yield* new ApiError({
          status: 403,
          code: "signature_required",
          message: "Artifact signature tag required",
        });
      if (quotas._tag === "Some" && !ticket.quotaReservation && match[4] !== "abort")
        return yield* new ApiError({
          status: 403,
          code: "quota_reservation_required",
          message: "Restart this upload to reserve quota capacity",
        });
      if (match[2] && match[3] && request.method === "PUT")
        return yield* Response.json(
          yield* uploads.part(
            ticket,
            Number(match[3]),
            request.stream,
            Number(request.headers["content-length"]),
          ),
        );
      if (match[4] === "abort" && request.method === "POST") {
        yield* uploads.abort(ticket);
        if (ticket.quotaReservation && quotas._tag === "Some")
          yield* quotas.value.release(ticket.quotaReservation);
        return Response.empty({ status: 204 });
      }
      if (match[4] === "complete" && request.method === "POST") {
        const body = yield* Schema.decodeUnknownEffect(MultipartComplete)(yield* readJson).pipe(
          Effect.mapError(() => bad("Invalid multipart completion manifest")),
        );
        yield* uploads.complete(ticket, body.parts);
        if (ticket.quotaReservation && quotas._tag === "Some")
          yield* quotas.value.finish(ticket.quotaReservation, ticket.size);
        yield* recheck.pipe(
          Effect.flatMap((current) =>
            current.cacheGeneration === scope.cacheGeneration
              ? Effect.void
              : Effect.fail(
                  new ApiError({
                    status: 409,
                    code: "purge_race",
                    message: "Project was purged during upload; retry",
                  }),
                ),
          ),
          Effect.catch((error) => uploads.remove(ticket).pipe(Effect.andThen(Effect.fail(error)))),
        );
        yield* invalidateLocal(ticket.hash);
        yield* emit(scope, {
          method: "PUT",
          hash: ticket.hash,
          status: 202,
          provenance: ticket.provenance,
        });
        return yield* Response.json({ hash: ticket.hash }, { status: 202 });
      }
    }
    return Response.empty({ status: 405 });
  }).pipe(
    Effect.catchTags({
      MultipartError: (e) =>
        Effect.fail(
          new ApiError({ status: e.status, code: "multipart_error", message: e.message }),
        ),
    }),
  );
