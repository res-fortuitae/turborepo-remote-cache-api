import { MULTIPART_PART_BYTES, MAX_MULTIPART_PARTS, UploadedPart } from "@repo/api-spec";
import { Clock, Context, Effect, Layer, Redacted, Schema, Stream } from "effect";

export class MultipartError extends Schema.TaggedError<MultipartError>()("MultipartError", {
  status: Schema.Number,
  message: Schema.String,
}) {}
const invalid = (message: string) => new MultipartError({ status: 400, message });
const unavailable = () =>
  new MultipartError({ status: 503, message: "Multipart storage unavailable" });
export const UploadTicket = Schema.Struct({
  uploadId: Schema.String,
  key: Schema.String,
  orgId: Schema.String,
  projectId: Schema.String,
  credentialId: Schema.String,
  hash: Schema.String,
  size: Schema.Int,
  generation: Schema.Int,
  expiresAt: Schema.Number,
  session: Schema.String,
  provenance: Schema.Record(Schema.String, Schema.String),
});
export type UploadTicket = typeof UploadTicket.Type;
export interface MultipartOwner {
  orgId: string;
  projectId: string;
  credentialId: string;
  generation: number;
  maxBytes: number;
}
export class MultipartSecret extends Context.Service<MultipartSecret, Redacted.Redacted<string>>()(
  "@repo/artifacts/MultipartSecret",
) {}
export class MultipartBucket extends Context.Service<
  MultipartBucket,
  {
    create: (key: string, metadata: Record<string, string>) => Effect.Effect<string, unknown>;
    part: (
      ticket: UploadTicket,
      partNumber: number,
      body: Stream.Stream<Uint8Array, unknown>,
      size: number,
    ) => Effect.Effect<typeof UploadedPart.Type, unknown>;
    complete: (
      ticket: UploadTicket,
      parts: readonly (typeof UploadedPart.Type)[],
    ) => Effect.Effect<void, unknown>;
    abort: (ticket: UploadTicket) => Effect.Effect<void, unknown>;
    head: (
      key: string,
    ) => Effect.Effect<{ size: number; session?: string | undefined } | null, unknown>;
    remove: (key: string) => Effect.Effect<void, unknown>;
  }
>()("@repo/artifacts/MultipartBucket") {}

export class MultipartUploads extends Context.Service<
  MultipartUploads,
  {
    create: (
      owner: MultipartOwner,
      hash: string,
      size: number,
      metadata: Record<string, string>,
    ) => Effect.Effect<{ id: string; partSize: number; expiresAt: number }, MultipartError>;
    resolve: (
      id: string,
      owner: MultipartOwner,
      abort?: boolean,
    ) => Effect.Effect<UploadTicket, MultipartError>;
    part: (
      ticket: UploadTicket,
      number: number,
      body: Stream.Stream<Uint8Array, unknown>,
      size: number,
    ) => Effect.Effect<typeof UploadedPart.Type, MultipartError>;
    complete: (
      ticket: UploadTicket,
      parts: readonly (typeof UploadedPart.Type)[],
    ) => Effect.Effect<void, MultipartError>;
    abort: (ticket: UploadTicket) => Effect.Effect<void, MultipartError>;
    remove: (ticket: UploadTicket) => Effect.Effect<void, MultipartError>;
  }
>()("@repo/artifacts/MultipartUploads") {}

const encode = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
const decode = (text: string) =>
  Uint8Array.from(atob(text.replaceAll("-", "+").replaceAll("_", "/")), (c) => c.charCodeAt(0));

export const MultipartUploadsLive = Layer.effect(
  MultipartUploads,
  Effect.gen(function* () {
    const bucket = yield* MultipartBucket;
    const secret = yield* MultipartSecret;
    const key = yield* Effect.tryPromise(() =>
      crypto.subtle.importKey(
        "raw",
        new TextEncoder().encode(`artifact-upload-v1:${Redacted.value(secret)}`),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign", "verify"],
      ),
    ).pipe(Effect.mapError(unavailable));
    return {
      create: Effect.fn("Multipart.create")(function* (owner, hash, size, metadata) {
        if (!/^[a-fA-F0-9]{1,256}$/.test(hash) || !Number.isSafeInteger(size) || size < 1)
          return yield* invalid("Invalid artifact hash or size");
        if (size > Math.min(owner.maxBytes, MULTIPART_PART_BYTES * MAX_MULTIPART_PARTS))
          return yield* new MultipartError({
            status: 413,
            message: "Artifact exceeds project multipart limit",
          });
        if (new TextEncoder().encode(JSON.stringify(metadata)).byteLength > 6000)
          return yield* invalid("Artifact metadata is too large");
        const session = crypto.randomUUID();
        const objectKey = `${owner.orgId}/${owner.projectId}/${hash}`;
        const uploadId = yield* bucket
          .create(objectKey, { ...metadata, uploadSession: session })
          .pipe(Effect.mapError(unavailable));
        const expiresAt = (yield* Clock.currentTimeMillis) + 86_400_000;
        const ticket: UploadTicket = {
          uploadId,
          key: objectKey,
          orgId: owner.orgId,
          projectId: owner.projectId,
          credentialId: owner.credentialId,
          hash,
          size,
          generation: owner.generation,
          expiresAt,
          session,
          provenance: Object.fromEntries(
            Object.entries(metadata).filter(([key]) =>
              [
                "tag",
                "uploadedAt",
                "credentialType",
                "credentialId",
                "userId",
                "provider",
                "repositoryId",
                "ref",
                "jobWorkflowRef",
                "commitSha",
                "runId",
              ].includes(key),
            ),
          ),
        };
        const payload = encode(new TextEncoder().encode(JSON.stringify(ticket)));
        const signature = yield* Effect.tryPromise(() =>
          crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload)),
        ).pipe(Effect.mapError(unavailable));
        return {
          id: `${payload}.${encode(new Uint8Array(signature))}`,
          partSize: MULTIPART_PART_BYTES,
          expiresAt,
        };
      }),
      resolve: Effect.fn("Multipart.resolve")(function* (id, owner, abort = false) {
        if (id.length > 8192) return yield* invalid("Invalid upload handle");
        const parsed = yield* Effect.tryPromise(async () => {
          const [payload, signature, extra] = id.split(".");
          if (
            !payload ||
            !signature ||
            extra !== undefined ||
            !(await crypto.subtle.verify(
              "HMAC",
              key,
              decode(signature),
              new TextEncoder().encode(payload),
            ))
          )
            throw new Error("invalid");
          return new TextDecoder().decode(decode(payload));
        }).pipe(Effect.mapError(() => invalid("Invalid upload handle")));
        const ticket = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(UploadTicket))(
          parsed,
        ).pipe(Effect.mapError(() => invalid("Invalid upload handle")));
        if (
          ticket.orgId !== owner.orgId ||
          ticket.projectId !== owner.projectId ||
          ticket.credentialId !== owner.credentialId ||
          ticket.key !== `${owner.orgId}/${owner.projectId}/${ticket.hash}`
        )
          return yield* new MultipartError({
            status: 403,
            message: "Upload handle does not belong to this credential and project",
          });
        if (!abort && ticket.expiresAt <= (yield* Clock.currentTimeMillis))
          return yield* new MultipartError({ status: 410, message: "Upload handle expired" });
        if (!abort && ticket.size > owner.maxBytes)
          return yield* new MultipartError({
            status: 413,
            message: "Artifact exceeds current project limit",
          });
        if (!abort && ticket.generation !== owner.generation)
          return yield* new MultipartError({
            status: 409,
            message: "Project was purged; abort and restart the upload",
          });
        return ticket;
      }),
      part: Effect.fn("Multipart.part")(function* (ticket, number, body, size) {
        const count = Math.ceil(ticket.size / MULTIPART_PART_BYTES);
        if (!Number.isInteger(number) || number < 1 || number > count)
          return yield* invalid("Invalid part number");
        const expected = Math.min(
          MULTIPART_PART_BYTES,
          ticket.size - (number - 1) * MULTIPART_PART_BYTES,
        );
        if (!Number.isSafeInteger(size) || size !== expected)
          return yield* invalid(`Part must contain exactly ${expected} bytes`);
        return yield* bucket.part(ticket, number, body, size).pipe(Effect.mapError(unavailable));
      }),
      complete: Effect.fn("Multipart.complete")(function* (ticket, parts) {
        const count = Math.ceil(ticket.size / MULTIPART_PART_BYTES);
        if (
          parts.length !== count ||
          parts.some((part, index) => part.partNumber !== index + 1 || !part.etag)
        )
          return yield* invalid("Provide every part exactly once in ascending order");
        const object = yield* bucket.head(ticket.key).pipe(Effect.mapError(unavailable));
        if (object?.session === ticket.session && object.size === ticket.size) return;
        yield* bucket.complete(ticket, parts).pipe(Effect.mapError(unavailable));
        const completed = yield* bucket.head(ticket.key).pipe(Effect.mapError(unavailable));
        if (completed?.session !== ticket.session || completed.size !== ticket.size)
          return yield* unavailable();
      }),
      abort: (ticket) => bucket.abort(ticket).pipe(Effect.mapError(unavailable)),
      remove: (ticket) =>
        bucket.head(ticket.key).pipe(
          Effect.flatMap((current) =>
            current?.session === ticket.session ? bucket.remove(ticket.key) : Effect.void,
          ),
          Effect.mapError(unavailable),
        ),
    } satisfies typeof MultipartUploads.Service;
  }),
);
