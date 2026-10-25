import type { R2Bucket } from "@cloudflare/workers-types";
import { Effect, Stream } from "effect";
import { ApiError } from "./api.ts";

/** Turbo v1 sends chunked bodies. Hold one 5 MiB R2 part, never a whole artifact. */
export const uploadChunked = <E>(
  raw: R2Bucket,
  key: string,
  body: Stream.Stream<Uint8Array, E>,
  options: {
    maxBytes: number;
    customMetadata: Record<string, string>;
    httpMetadata: { contentType: string };
  },
) =>
  Effect.tryPromise({
    try: async () => {
      const upload = await raw.createMultipartUpload(key, options);
      const reader = Stream.toReadableStream(body).getReader();
      const parts: { partNumber: number; etag: string }[] = [];
      const buffer = new Uint8Array(5 * 1024 * 1024);
      let used = 0;
      let total = 0;
      let complete = false;
      try {
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) break;
          total += chunk.value.byteLength;
          if (total > options.maxBytes)
            throw new ApiError({
              status: 413,
              code: "payload_too_large",
              message: `Artifact exceeds direct upload limit (${options.maxBytes} bytes); use tcache exec`,
            });
          for (let offset = 0; offset < chunk.value.byteLength;) {
            const count = Math.min(buffer.length - used, chunk.value.byteLength - offset);
            buffer.set(chunk.value.subarray(offset, offset + count), used);
            used += count;
            offset += count;
            if (used === buffer.length) {
              parts.push(await upload.uploadPart(parts.length + 1, buffer));
              used = 0;
            }
          }
        }
        if (used) parts.push(await upload.uploadPart(parts.length + 1, buffer.subarray(0, used)));
        if (parts.length) await upload.complete(parts);
        else {
          await upload.abort();
          await raw.put(key, new Uint8Array(), options);
        }
        complete = true;
      } finally {
        await reader.cancel().catch(() => undefined);
        reader.releaseLock();
        if (!complete) await upload.abort();
      }
    },
    catch: (error) =>
      error instanceof ApiError
        ? error
        : new ApiError({ status: 500, code: "internal_error", message: "Storage error" }),
  });
