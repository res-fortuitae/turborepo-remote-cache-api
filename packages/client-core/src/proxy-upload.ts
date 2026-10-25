import {
  MULTIPART_PART_BYTES,
  MAX_MULTIPART_PARTS,
  MultipartCreated,
  UploadedPart,
} from "@repo/api-spec";
import { Effect, Schema } from "effect";
import { ClientAuthError } from "./config.ts";

const failed = () =>
  new ClientAuthError({
    reason: "unreachable",
    message: "Streaming multipart upload failed. Check server capabilities and project limits.",
  });

export type UploadSend = (
  path: string,
  method: string,
  body: RequestInit["body"],
  headers: Headers,
  signal: AbortSignal,
) => Effect.Effect<Response, ClientAuthError>;

const decodeCreated = Schema.decodeUnknownEffect(MultipartCreated);
const decodePart = Schema.decodeUnknownEffect(UploadedPart);

const control = (response: Response) =>
  Effect.tryPromise({
    try: async () => {
      const reader = response.body?.getReader();

      if (!reader) throw new Error("empty control response");
      let text = "";
      let size = 0;
      const decoder = new TextDecoder();

      try {
        for (;;) {
          const next = await reader.read();

          if (next.done) break;
          size += next.value.length;

          if (size > 65_536) throw new Error("oversized control response");
          text += decoder.decode(next.value, { stream: true });
        }
      } finally {
        await reader.cancel();
      }

      return JSON.parse(text + decoder.decode());
    },
    catch: failed,
  });

/** One replayable 64 MiB part in memory, never the whole artifact. Each send reauthenticates. */
export const uploadStream = (
  request: Request,
  size: number,
  send: UploadSend,
  onRetry: () => void = () => undefined,
) =>
  Effect.gen(function* () {
    if (
      !request.body ||
      !Number.isSafeInteger(size) ||
      size > MULTIPART_PART_BYTES * MAX_MULTIPART_PARTS
    )
      return yield* failed();
    const hash = new URL(request.url).pathname.split("/").at(-1)!;
    const metadata = new Headers();

    for (const [key, value] of request.headers)
      if (
        [
          "x-artifact-tag",
          "x-artifact-duration",
          "x-artifact-sha",
          "x-artifact-dirty-hash",
        ].includes(key)
      )
        metadata.set(key, value);
    metadata.set("content-type", "application/json");
    const created = yield* send(
      "/v8/x/uploads",
      "POST",
      JSON.stringify({ hash, size }),
      metadata,
      request.signal,
    );

    if (!created.ok) {
      yield* Effect.promise(async () => {
        await request.body?.cancel();
      });

      return created;
    }

    const upload = yield* control(created).pipe(
      Effect.flatMap(decodeCreated),
      Effect.mapError(failed),
    );

    if (upload.partSize !== MULTIPART_PART_BYTES || upload.id.length > 4096) return yield* failed();
    const path = `/v8/x/uploads/${encodeURIComponent(upload.id)}`;
    const reader = request.body.getReader();
    let completed = false;

    const run = Effect.gen(function* () {
      const parts: (typeof UploadedPart.Type)[] = [];
      let pending: Uint8Array | undefined;
      let offset = 0;

      for (let start = 0, number = 1; start < size; start += upload.partSize, number++) {
        const data = new Uint8Array(Math.min(upload.partSize, size - start));
        let filled = 0;

        while (filled < data.length) {
          if (pending === undefined || offset === pending.length) {
            const next = yield* Effect.tryPromise({ try: () => reader.read(), catch: failed });

            if (next.done) return yield* failed();
            pending = next.value;
            offset = 0;
          }

          const chunk = pending;

          if (chunk === undefined) return yield* failed();
          const count = Math.min(chunk.length - offset, data.length - filled);
          data.set(chunk.subarray(offset, offset + count), filled);
          offset += count;
          filled += count;
        }

        let response: Response | undefined;

        for (let attempt = 0; attempt < 3; attempt++) {
          response = yield* send(
            `${path}/parts/${number}`,
            "PUT",
            data.buffer,
            new Headers({ "content-length": String(data.length) }),
            request.signal,
          );

          if (response.ok || ![429, 502, 503, 504].includes(response.status) || attempt === 2)
            break;
          yield* Effect.promise(async () => {
            await response!.body?.cancel();
          });
          onRetry();
          yield* Effect.sleep(`${100 * (attempt + 1)} millis`);
        }

        if (!response?.ok) return response ?? new Response(null, { status: 502 });
        const part = yield* control(response).pipe(
          Effect.flatMap(decodePart),
          Effect.mapError(failed),
        );

        if (part.partNumber !== number) return yield* failed();
        parts.push(part);
      }

      if (pending !== undefined && offset < pending.length) return yield* failed();

      if (!(yield* Effect.tryPromise({ try: () => reader.read(), catch: failed })).done)
        return yield* failed();
      const response = yield* send(
        `${path}/complete`,
        "POST",
        JSON.stringify({ parts }),
        new Headers({ "content-type": "application/json" }),
        request.signal,
      );
      completed = response.ok;

      return response;
    });

    return yield* run.pipe(
      Effect.ensuring(
        Effect.gen(function* () {
          yield* Effect.promise(async () => {
            await reader.cancel();
          });

          if (!completed)
            yield* send(
              `${path}/abort`,
              "POST",
              undefined,
              new Headers(),
              AbortSignal.timeout(5000),
            ).pipe(
              Effect.flatMap((response) =>
                Effect.promise(async () => {
                  await response.body?.cancel();
                }),
              ),
              Effect.catch(() => Effect.void),
            );
        }),
      ),
    );
  });
