import {
  MULTIPART_PART_BYTES,
  MAX_MULTIPART_PARTS,
  MultipartCreated,
  UploadedPart,
} from "@repo/api-spec";
import { Schema } from "effect";

export interface ArtifactUploadOptions {
  readonly server: string;
  readonly token: () => string | Promise<string>;
  readonly hash: string;
  /** A replayable, sliceable file/Blob. Proxies should spool to disk, not buffer the artifact. */
  readonly artifact: Blob;
  readonly headers?: Readonly<Record<string, string>>;
  readonly signal?: AbortSignal;
  readonly fetch?: (url: URL, init: RequestInit) => Promise<Response>;
}
const allowedHeaders = new Set([
  "x-artifact-duration",
  "x-artifact-tag",
  "x-artifact-sha",
  "x-artifact-dirty-hash",
]);
const pause = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const cleanup = () => signal?.removeEventListener("abort", abort);
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    const abort = () => {
      clearTimeout(timer);
      cleanup();
      reject(new Error("Upload cancelled"));
    };
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });
  });

/** Large-upload transport shared by local proxies. Four replayable parts at most are in flight. */
export async function uploadArtifact(options: ArtifactUploadOptions): Promise<void> {
  const server = new URL(options.server);
  if (
    server.protocol !== "https:" &&
    !["localhost", "127.0.0.1", "[::1]"].includes(server.hostname)
  )
    throw new Error("Upload server must use HTTPS");
  if (!/^[a-fA-F0-9]{1,256}$/.test(options.hash)) throw new Error("Invalid artifact hash");
  if (options.artifact.size > MULTIPART_PART_BYTES * MAX_MULTIPART_PARTS)
    throw new Error("Artifact exceeds multipart part count limit");
  const fetcher = options.fetch ?? fetch;
  const metadata = Object.fromEntries(
    Object.entries(options.headers ?? {})
      .filter(([key]) => allowedHeaders.has(key.toLowerCase()))
      .map(([key, value]) => [key.toLowerCase(), value]),
  );
  const send = async (
    path: string,
    method: string,
    body?: RequestInit["body"],
    headers: Record<string, string> = {},
    signal = options.signal,
  ) => {
    const response = await fetcher(new URL(path, server), {
      method,
      headers: { ...headers, authorization: `Bearer ${await options.token()}` },
      ...(body === undefined ? {} : { body }),
      ...(signal ? { signal } : {}),
      redirect: "error",
    });
    return response;
  };
  if (options.artifact.size < MULTIPART_PART_BYTES) {
    const response = await send(`/v8/artifacts/${options.hash}`, "PUT", options.artifact, {
      ...metadata,
      "content-length": String(options.artifact.size),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`Artifact upload failed (${response.status})`);
    }
    await response.body?.cancel();
    return;
  }
  let id: string | undefined;
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  if (options.signal?.aborted) controller.abort();
  options.signal?.addEventListener("abort", onAbort, { once: true });
  const pending = new Set<Promise<void>>();
  try {
    const created = await send(
      "/v8/x/uploads",
      "POST",
      JSON.stringify({ hash: options.hash, size: options.artifact.size }),
      { ...metadata, "content-type": "application/json" },
      controller.signal,
    );
    if (!created.ok) {
      await created.body?.cancel();
      throw new Error(`Multipart creation failed (${created.status})`);
    }
    const upload = Schema.decodeUnknownSync(MultipartCreated)(await created.json());
    id = upload.id;
    if (upload.partSize !== MULTIPART_PART_BYTES)
      throw new Error("Unsupported multipart part size");
    const parts: (typeof UploadedPart.Type)[] = [];
    const path = `/v8/x/uploads/${encodeURIComponent(id)}`;
    const count = Math.ceil(options.artifact.size / upload.partSize);
    const uploadPart = async (number: number) => {
      const start = (number - 1) * upload.partSize;
      const body = options.artifact.slice(
        start,
        Math.min(start + upload.partSize, options.artifact.size),
      );
      for (let attempt = 0; ; attempt++) {
        try {
          const response = await send(
            `${path}/parts/${number}`,
            "PUT",
            body,
            { "content-length": String(body.size) },
            controller.signal,
          );
          if (response.ok) {
            const part = Schema.decodeUnknownSync(UploadedPart)(await response.json());
            if (part.partNumber !== number) throw new Error("Multipart part number mismatch");
            parts[number - 1] = part;
            return;
          }
          await response.body?.cancel();
          if (attempt >= 2 || (response.status !== 429 && response.status < 500))
            throw new Error(`Part upload failed (${response.status})`);
          const retryAfter = Number(response.headers.get("retry-after"));
          await pause(
            Number.isFinite(retryAfter) && retryAfter > 0
              ? Math.min(retryAfter * 1000, 60_000)
              : 200 * 2 ** attempt,
            controller.signal,
          );
        } catch (error) {
          if (
            controller.signal.aborted ||
            attempt >= 2 ||
            (error instanceof Error && error.message.startsWith("Part upload failed"))
          )
            throw error;
          await pause(200 * 2 ** attempt, controller.signal);
        }
      }
    };
    for (let number = 1; number <= count; number++) {
      const task = uploadPart(number);
      pending.add(task);
      // Attach both rejection handlers immediately; Promise.race propagates the original failure.
      void task.then(
        () => pending.delete(task),
        () => {},
      );
      if (pending.size >= 4) await Promise.race(pending);
    }
    await Promise.all(pending);
    for (let attempt = 0; ; attempt++) {
      let complete: Response;
      try {
        complete = await send(
          `${path}/complete`,
          "POST",
          JSON.stringify({ parts }),
          { "content-type": "application/json" },
          controller.signal,
        );
      } catch (error) {
        if (controller.signal.aborted || attempt >= 2) throw error;
        await pause(200 * 2 ** attempt, controller.signal);
        continue;
      }
      if (complete.ok) {
        await complete.body?.cancel();
        return;
      }
      await complete.body?.cancel();
      if (attempt >= 2 || (complete.status !== 429 && complete.status < 500))
        throw new Error(`Multipart completion failed (${complete.status})`);
      const retryAfter = Number(complete.headers.get("retry-after"));
      await pause(
        Number.isFinite(retryAfter) && retryAfter > 0
          ? Math.min(retryAfter * 1000, 60_000)
          : 200 * 2 ** attempt,
        controller.signal,
      );
    }
  } catch (error) {
    controller.abort();
    await Promise.allSettled(pending);
    if (id) {
      try {
        const response = await send(
          `/v8/x/uploads/${encodeURIComponent(id)}/abort`,
          "POST",
          undefined,
          {},
          AbortSignal.timeout(10_000),
        );
        await response.body?.cancel();
      } catch {
        /* The bucket's one-day lifecycle is the final cleanup fallback. */
      }
    }
    throw error;
  } finally {
    options.signal?.removeEventListener("abort", onAbort);
  }
}
