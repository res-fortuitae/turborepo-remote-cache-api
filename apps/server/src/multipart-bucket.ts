import type * as Runtime from "@cloudflare/workers-types";
import type { MultipartBucket } from "@repo/artifacts";
import { Effect, Stream } from "effect";

declare const FixedLengthStream: typeof Runtime.FixedLengthStream;

/** Runtime-only adapter. FixedLengthStream enforces the declared size without buffering. */
export const makeMultipartBucket = (raw: Runtime.R2Bucket): typeof MultipartBucket.Service => ({
  create: (key, metadata) =>
    Effect.tryPromise(() =>
      raw.createMultipartUpload(key, {
        customMetadata: metadata,
        httpMetadata: { contentType: "application/octet-stream" },
      }),
    ).pipe(Effect.map((upload) => upload.uploadId)),
  part: (ticket, partNumber, body, size) =>
    Effect.tryPromise(async () => {
      const fixed = new FixedLengthStream(size);
      const writer = fixed.writable.getWriter();
      const controller = new AbortController();
      try {
        const [part] = await Promise.all([
          raw
            .resumeMultipartUpload(ticket.key, ticket.uploadId)
            .uploadPart(partNumber, fixed.readable),
          Stream.toReadableStream(body).pipeTo(
            new WritableStream<Uint8Array>({
              write: (chunk) => writer.write(chunk),
              close: () => writer.close(),
              abort: (reason) => writer.abort(reason),
            }),
            { signal: controller.signal },
          ),
        ]);
        return part;
      } finally {
        controller.abort();
      }
    }),
  complete: (ticket, parts) =>
    Effect.tryPromise(() =>
      raw.resumeMultipartUpload(ticket.key, ticket.uploadId).complete([...parts]),
    ).pipe(Effect.asVoid),
  abort: (ticket) =>
    Effect.tryPromise(() => raw.resumeMultipartUpload(ticket.key, ticket.uploadId).abort()),
  head: (key) =>
    Effect.tryPromise(() => raw.head(key)).pipe(
      Effect.map((o) => (o ? { size: o.size, session: o.customMetadata?.uploadSession } : null)),
    ),
  remove: (key) => Effect.tryPromise(() => raw.delete(key)),
});
